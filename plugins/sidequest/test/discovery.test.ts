import './_temp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

type CatalogModel = Record<string, unknown>;
interface CatalogHeader {
  schemaVersion?: number;
  schema?: number;
  source?: string;
  updatedAt?: string;
  providers?: unknown;
  codexReadiness?: unknown;
}
interface ResolvedExec {
  agent: string;
  model: string;
  runsModel?: string;
}

process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-home-'));
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-empty-'));
process.env.SIDEQUEST_DISCOVERY_DIRS = empty;
const discovery = require('../lib/discovery.js') as {
  discoverExternalModels(): Array<{ slug: string; id: string; label: string; provider: string; source: string }>;
  providerReadiness(provider: string): { provider: string; ready: boolean; state: string; message: string } | null;
  configuredExternalModelProvider(slug: string): string | null;
};
const store = require('../lib/store.js') as {
  CLAUDE_RUNTIMES: readonly string[];
  VALID_EFFORTS: readonly string[];
  resolveExec(model: string, effort: string): ResolvedExec | null;
  classifyModelFilter(model: string): string;
};

function writeCatalog(models: CatalogModel[], catalog: CatalogHeader = {
  schemaVersion: 3,
  source: 'model-gateway',
  codexReadiness: { ready: true, state: 'ready', message: 'Codex is ready.' },
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-'));
  const dir = path.join(root, 'model-gateway');
  const catalogPath = path.join(dir, 'catalog.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(catalogPath, JSON.stringify({ updatedAt: new Date().toISOString(), ...catalog, models }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = root;
  return catalogPath;
}

test('missing and malformed catalogs fail soft', () => {
  assert.deepEqual(discovery.discoverExternalModels(), []);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-bad-'));
  fs.mkdirSync(path.join(root, 'model-gateway'));
  fs.writeFileSync(path.join(root, 'model-gateway', 'catalog.json'), '{bad');
  process.env.SIDEQUEST_DISCOVERY_DIRS = root;
  assert.deepEqual(discovery.discoverExternalModels(), []);
});

test('catalog cache re-reads a rewritten catalog', () => {
  const catalogPath = writeCatalog([{ slug: 'codex-gpt-first', id: 'claude-first', label: 'First model' }]);
  assert.deepEqual(discovery.discoverExternalModels(), [{
    slug: 'codex-gpt-first', id: 'claude-first', label: 'First model', provider: 'codex', source: 'model-gateway',
  }]);

  fs.writeFileSync(catalogPath, JSON.stringify({
    schemaVersion: 3,
    source: 'model-gateway',
    updatedAt: new Date().toISOString(),
    codexReadiness: { ready: true, state: 'ready', message: 'Codex is ready.' },
    models: [{ slug: 'codex-gpt-reloaded', id: 'claude-reloaded-model', label: 'Reloaded model' }],
  }));

  assert.deepEqual(discovery.discoverExternalModels(), [{
    slug: 'codex-gpt-reloaded', id: 'claude-reloaded-model', label: 'Reloaded model', provider: 'codex', source: 'model-gateway',
  }]);
});

test('stale, invalid, and future catalog timestamps suppress both models and readiness', () => {
  for (const updatedAt of [undefined, 'not-a-date', new Date(Date.now() - 5 * 60 * 1000 - 1).toISOString(), new Date(Date.now() + 60 * 1000).toISOString()]) {
    writeCatalog([{ slug: 'codex-gpt-test', id: 'claude-test', label: 'GPT Test' }], {
      schemaVersion: 3,
      updatedAt,
      codexReadiness: { ready: true, state: 'ready', message: 'Codex is ready.' },
    });
    assert.deepEqual(discovery.discoverExternalModels(), []);
    assert.equal(discovery.providerReadiness('codex'), null);
  }
});

test('discovery reads the gateway readiness contract independently of catalog models', () => {
  writeCatalog([], {
    schemaVersion: 3,
    codexReadiness: {
      ready: false,
      state: 'proxy-down',
      message: 'Codex dispatch refused: claude-code-proxy is not answering on /v1/models. Run `node "gateway" ensure`, then retry. No Anthropic fallback was used.',
    },
  });
  assert.deepEqual(discovery.providerReadiness('codex'), {
    provider: 'codex',
    ready: false,
    state: 'proxy-down',
    message: 'Codex dispatch refused: claude-code-proxy is not answering on /v1/models. Run `node "gateway" ensure`, then retry. No Anthropic fallback was used.',
  });
});

function readyCatalog(updatedAt = new Date().toISOString()) {
  return {
    schemaVersion: 4,
    updatedAt,
    providers: { codex: { ready: true, state: 'ready', message: 'Codex is ready.' } },
    models: [{ slug: 'codex-gpt-test', id: 'claude-test', label: 'GPT Test', provider: 'codex' }],
  };
}

function unreadyCatalog(updatedAt = new Date().toISOString()) {
  return {
    ...readyCatalog(updatedAt),
    providers: { codex: { ready: false, state: 'serving-version-mismatch', message: 'old session' } },
  };
}

// A refresh is a side effect on the catalog FILE, and the real gateway also reports what it did on stdout, so a
// fake that only prints the catalog would pass while the shipped code silently gave up on that report (SQ-2208).
function seedGatewayHome(t: { after(fn: () => void): void }, stored: unknown, refreshWrites: Record<string, unknown>, refreshDelayMs = 0) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-refresh-'));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousDiscoveryDirs = process.env.SIDEQUEST_DISCOVERY_DIRS;
  const previousClaudeHome = process.env.SIDEQUEST_CLAUDE_HOME;
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    process.env.HOME = previousHome;
    process.env.USERPROFILE = previousUserProfile;
    process.env.SIDEQUEST_DISCOVERY_DIRS = previousDiscoveryDirs;
    if (previousClaudeHome === undefined) delete process.env.SIDEQUEST_CLAUDE_HOME;
    else process.env.SIDEQUEST_CLAUDE_HOME = previousClaudeHome;
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    fs.rmSync(home, { recursive: true, force: true });
  });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.SIDEQUEST_DISCOVERY_DIRS;
  // SQ-27: discovery now honors SIDEQUEST_CLAUDE_HOME/CLAUDE_CONFIG_DIR above
  // the faked homedir, so pin the fixture tree or the live session tree leaks in.
  process.env.SIDEQUEST_CLAUDE_HOME = path.join(home, '.claude');
  delete process.env.CLAUDE_CONFIG_DIR;

  const catalogPath = path.join(home, '.claude', 'model-gateway', 'catalog.json');
  const installs = Object.entries(refreshWrites).map(([version, catalog]) => {
    const installPath = path.join(home, 'plugins', version);
    const command = path.join(installPath, 'bin', 'model-gateway.js');
    fs.mkdirSync(path.dirname(command), { recursive: true });
    fs.writeFileSync(command, [
      `if (${refreshDelayMs} > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${refreshDelayMs});`,
      `require('fs').writeFileSync(${JSON.stringify(catalogPath)}, ${JSON.stringify(JSON.stringify(catalog))});`,
      "process.stdout.write('catalog: preserved claude-grok-build from a subset write\\n');",
    ].join('\n'));
    return { installPath, version };
  });
  fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: { 'model-gateway@loadout': installs },
  }));
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  fs.writeFileSync(catalogPath, JSON.stringify(stored));
}

test('discovery refreshes an unready Codex catalog through the newest installed gateway', (t) => {
  seedGatewayHome(t, unreadyCatalog(), { '0.48.6': unreadyCatalog(), '0.48.7': readyCatalog() });

  assert.deepEqual(discovery.providerReadiness('codex'), {
    provider: 'codex', ready: true, state: 'ready', message: 'Codex is ready.',
  });
});

test('discovery waits for a healthy gateway refresh that exceeds the old five-second timeout', (t) => {
  seedGatewayHome(t, unreadyCatalog(), { '0.48.7': readyCatalog() }, 5_100);

  assert.deepEqual(discovery.providerReadiness('codex'), {
    provider: 'codex', ready: true, state: 'ready', message: 'Codex is ready.',
  });
});

test('SQ-2208: models survive a catalog that aged out of the freshness window', (t) => {
  const agedOut = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  seedGatewayHome(t, readyCatalog(agedOut), { '0.48.7': readyCatalog() });

  assert.deepEqual(discovery.discoverExternalModels(), [{
    slug: 'codex-gpt-test', id: 'claude-test', label: 'GPT Test', provider: 'codex', source: 'model-gateway',
  }]);
  assert.equal(discovery.configuredExternalModelProvider('codex-gpt-test'), 'codex');
});

test('discovery validates concrete catalog identity and drops routing hints', () => {
  writeCatalog([
    { slug: 'codex-gpt-test', id: 'claude-test', label: 'GPT Test', suggestedTier: 'ignored' },
    { slug: 'Bad Slug', id: 'bad' },
    { slug: 'missing-id' },
  ]);
  assert.deepEqual(discovery.discoverExternalModels(), [{
    slug: 'codex-gpt-test', id: 'claude-test', label: 'GPT Test', provider: 'codex', source: 'model-gateway',
  }]);
});

test('discovery accepts catalog v2 migration input', () => {
  writeCatalog([{ slug: 'codex-gpt-test', id: 'claude-test', label: 'GPT Test' }], {
    schema: 2,
    source: 'model-gateway',
    updatedAt: new Date().toISOString(),
    codexReadiness: { ready: true, state: 'ready', message: 'Codex is ready.' },
  });
  assert.deepEqual(discovery.discoverExternalModels(), [{
    slug: 'codex-gpt-test', id: 'claude-test', label: 'GPT Test', provider: 'codex', source: 'model-gateway',
  }]);
});

test('discovery reads schema-4 providers and model providers', () => {
  writeCatalog([{ slug: 'grok-test', id: 'claude-grok-test', label: 'Grok Test', provider: 'grok' }], {
    schemaVersion: 4,
    providers: {
      grok: { ready: false, state: 'credentials-missing', message: 'Sign in to Grok CLI, then retry.' },
      codex: { ready: true, state: 'ready', message: 'Codex is ready.' },
    },
  });
  assert.deepEqual(discovery.discoverExternalModels(), []);
  assert.deepEqual(discovery.providerReadiness('grok'), {
    provider: 'grok', ready: false, state: 'credentials-missing', message: 'Sign in to Grok CLI, then retry.',
  });
  assert.equal(discovery.providerReadiness('gemini'), null);
});

test('discovery ignores future catalog schemas', () => {
  writeCatalog([{ slug: 'codex-gpt-test', id: 'claude-test', label: 'GPT Test' }], { schemaVersion: 5 });
  assert.deepEqual(discovery.discoverExternalModels(), []);
});

test('Claude runtimes resolve to their stable executor at every stamped effort', () => {
  for (const model of store.CLAUDE_RUNTIMES) {
    for (const effort of store.VALID_EFFORTS) {
      const resolved = store.resolveExec(model, effort) as ResolvedExec;
      assert.equal(resolved.agent, `sidequest-exec-${effort}`);
      assert.equal(resolved.model, model);
    }
  }
});

test('concrete discovered route resolves while an absent route is unavailable', () => {
  writeCatalog([{ slug: 'codex-gpt-test', id: 'claude-test', label: 'GPT Test' }]);
  assert.equal(store.resolveExec('codex-gpt-test', 'high')!.runsModel, 'codex-gpt-test');
  assert.equal(store.resolveExec('missing-model', 'high'), null);
  assert.equal(store.classifyModelFilter('missing-model'), 'unknown');
});

// --------------------------------------------- ANTHROPIC_BASE_URL (SQ-298)
//
// The fixture server runs in its OWN process on purpose. discoverExternalModels
// is synchronous, so its /v1/models probe is a spawnSync, which blocks this
// process's event loop. An in-process http server could never accept the
// connection and every test here would sit until the probe's 3s timeout.
async function startModelServer(body: unknown): Promise<{ baseUrl: string; stop(): void }> {
  const script = "const http=require('node:http');const b=process.argv[1];"
    + "const s=http.createServer((req,res)=>{if(req.url==='/v1/models'){"
    + "res.writeHead(200,{'content-type':'application/json'});res.end(b);return;}"
    + "res.writeHead(404);res.end('{}');});"
    + "s.listen(0,'127.0.0.1',()=>{process.stdout.write('PORT '+s.address().port+'\\n');});";
  const child = spawn(process.execPath, ['-e', script, JSON.stringify(body)], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('fixture /v1/models server never reported a port')), 15000);
    child.stdout!.on('data', (chunk: Buffer) => {
      buf += String(chunk);
      const match = /PORT (\d+)/.exec(buf);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
  return { baseUrl: `http://127.0.0.1:${port}`, stop: () => { child.kill(); } };
}

// An empty gateway home keeps providerReadiness('codex') from trying to refresh
// a real locally-installed model-gateway, so these assertions describe the
// endpoint source and nothing else.
function withEndpoint(baseUrl: string, fn: () => void): void {
  const priorHome = process.env.SIDEQUEST_CLAUDE_HOME;
  process.env.SIDEQUEST_CLAUDE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-nogw-'));
  process.env.ANTHROPIC_BASE_URL = baseUrl;
  try {
    fn();
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
    if (priorHome === undefined) delete process.env.SIDEQUEST_CLAUDE_HOME;
    else process.env.SIDEQUEST_CLAUDE_HOME = priorHome;
  }
}

// The load-bearing test for SQ-298. Board routes pin slugs, so a slug derived
// here that differs from the one catalog.json publishes would silently repoint
// every persisted route. These three ids are the real published shapes of the
// three families, and the expected slugs are what model-gateway's own catalog
// slugFor() produces for them.
test('HTTP rows derive the slugs catalog.json publishes', async () => {
  process.env.SIDEQUEST_DISCOVERY_DIRS = empty;
  const server = await startModelServer({
    data: [
      { type: 'model', id: 'claude-gpt-5.6-terra[1m]', display_name: 'GPT-5.6 Terra (Codex)' },
      { type: 'model', id: 'claude-grok-4.5[1m]', display_name: 'Grok 4.5' },
      { type: 'model', id: 'claude-gemini-3-pro', display_name: 'Gemini 3 Pro' },
    ],
  });
  try {
    withEndpoint(server.baseUrl, () => {
      assert.deepEqual(
        discovery.discoverExternalModels().map((m) => [m.slug, m.id, m.label, m.provider, m.source]),
        [
          ['codex-gpt-5-6-terra', 'claude-gpt-5.6-terra[1m]', 'GPT-5.6 Terra (Codex)', 'codex', 'anthropic-base-url'],
          ['grok-4-5', 'claude-grok-4.5[1m]', 'Grok 4.5', 'grok', 'anthropic-base-url'],
          ['antigravity-gemini-3-pro', 'claude-gemini-3-pro', 'Gemini 3 Pro', 'antigravity', 'anthropic-base-url'],
        ],
      );
      assert.equal(discovery.configuredExternalModelProvider('grok-4-5'), 'grok');
    });
  } finally {
    server.stop();
  }
});

test('endpoint readiness names the source that answered', async () => {
  process.env.SIDEQUEST_DISCOVERY_DIRS = empty;
  const server = await startModelServer({
    data: [{ type: 'model', id: 'claude-gpt-5.6-luna[1m]', display_name: 'GPT-5.6 Luna' }],
  });
  try {
    withEndpoint(server.baseUrl, () => {
      const readiness = discovery.providerReadiness('codex');
      assert.equal(readiness?.ready, true);
      assert.equal(readiness?.state, 'endpoint');
      assert.match(readiness!.message, /served 1 codex model from GET \/v1\/models/);
      assert.ok(readiness!.message.includes(server.baseUrl));
      // A provider the endpoint did not serve stays unknown rather than
      // inheriting another provider's answer.
      assert.equal(discovery.providerReadiness('grok'), null);
    });
  } finally {
    server.stop();
  }
});

test('endpoint rows reject first-party Claude models and the virtual dispatch id', async () => {
  process.env.SIDEQUEST_DISCOVERY_DIRS = empty;
  const server = await startModelServer({
    data: [
      // Pointing ANTHROPIC_BASE_URL at the real API, or at model-gateway's
      // RC-compatibility mode, must not turn the Claude ladder into external routes.
      { type: 'model', id: 'claude-opus-4-5-20260514', display_name: 'Claude Opus 4.5' },
      { type: 'model', id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' },
      { type: 'model', id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
      // The legacy version-first id shape. The real API still lists these, so a
      // guard that only knew the family-first shape would register every one of
      // them as an external 'relay' model.
      { type: 'model', id: 'claude-3-5-sonnet-20241022', display_name: 'Claude 3.5 Sonnet' },
      { type: 'model', id: 'claude-3-opus-20240229', display_name: 'Claude 3 Opus' },
      // A routing sentinel, not a model anything may be routed to directly.
      { type: 'model', id: 'claude-codex-auto', display_name: 'Sidequest Dispatch (Codex)' },
      // Not a model row at all.
      { type: 'embedding', id: 'claude-gpt-embed', display_name: 'Embedder' },
      { type: 'model', id: '', display_name: 'Nameless' },
      { type: 'model', id: 'claude-gpt-5.6-terra[1m]', display_name: 'GPT-5.6 Terra (Codex)' },
    ],
  });
  try {
    withEndpoint(server.baseUrl, () => {
      assert.deepEqual(
        discovery.discoverExternalModels().map((m) => m.id),
        ['claude-gpt-5.6-terra[1m]'],
      );
    });
  } finally {
    server.stop();
  }
});

test('a relay id outside the known families lands in its own slug namespace', async () => {
  process.env.SIDEQUEST_DISCOVERY_DIRS = empty;
  const server = await startModelServer({
    data: [{ id: 'llama-4-maverick', display_name: 'Llama 4 Maverick' }],
  });
  try {
    withEndpoint(server.baseUrl, () => {
      assert.deepEqual(
        discovery.discoverExternalModels().map((m) => [m.slug, m.id, m.provider]),
        [['relay-llama-4-maverick', 'llama-4-maverick', 'relay']],
      );
    });
  } finally {
    server.stop();
  }
});

test('catalog naming wins for an id both sources publish', async () => {
  writeCatalog([{ slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra[1m]', label: 'Catalog label' }]);
  const server = await startModelServer({
    data: [
      { type: 'model', id: 'claude-gpt-5.6-terra[1m]', display_name: 'Endpoint label' },
      { type: 'model', id: 'claude-gpt-6-nova[1m]', display_name: 'GPT-6 Nova' },
    ],
  });
  try {
    process.env.ANTHROPIC_BASE_URL = server.baseUrl;
    // The shared id keeps the catalog's label, slug and source, so a persisted
    // route is untouched; only the genuinely new id is added by the endpoint.
    assert.deepEqual(
      discovery.discoverExternalModels().map((m) => [m.slug, m.label, m.source]),
      [
        ['codex-gpt-5-6-terra', 'Catalog label', 'model-gateway'],
        ['codex-gpt-6-nova', 'GPT-6 Nova', 'anthropic-base-url'],
      ],
    );
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
    server.stop();
  }
});

test('an unreachable endpoint fails soft', () => {
  process.env.SIDEQUEST_DISCOVERY_DIRS = empty;
  // Port 1 refuses immediately, so this exercises the failure path without
  // waiting out the probe budget.
  withEndpoint('http://127.0.0.1:1', () => {
    assert.deepEqual(discovery.discoverExternalModels(), []);
    assert.equal(discovery.providerReadiness('codex'), null);
  });
});

test('a malformed ANTHROPIC_BASE_URL is never probed', () => {
  process.env.SIDEQUEST_DISCOVERY_DIRS = empty;
  for (const bad of ['', '   ', 'not-a-url', 'ftp://example.com', 'api.anthropic.com']) {
    withEndpoint(bad, () => {
      assert.deepEqual(discovery.discoverExternalModels(), []);
    });
  }
});
