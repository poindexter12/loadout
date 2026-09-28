'use strict';

// SQ-175: two Claude accounts (config dirs) on one machine must not contend for
// one fixed shim/proxy port, and a port held by another install root must be
// reported as exactly that -- not as "a stale shim version" whose prescribed
// `ensure` can only refuse to stop the foreign process.
//
// Every module constant is fixed at require time, so each case loads the plugin
// in a child process with its own fixture HOME and CLAUDE_CONFIG_DIR. Nothing
// here binds a port, inspects the real process table, or signals any process.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const PLUGIN_ROOT = path.join(__dirname, '..');
const PORT_ENV = ['CODEX_GATEWAY_PORT', 'CODEX_GATEWAY_WORKER_PORT', 'CODEX_GATEWAY_PROXY_PORT', 'MODEL_GATEWAY_CLAUDE_HOME', 'ANTHROPIC_BASE_URL'];

function fixtureHome(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mg-account-ports-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function runIn({ home, configDir, env = {} }, body) {
  const childEnv = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of PORT_ENV) delete childEnv[key];
  if (configDir) childEnv.CLAUDE_CONFIG_DIR = configDir; else delete childEnv.CLAUDE_CONFIG_DIR;
  Object.assign(childEnv, env);
  const script = `
    const root = ${JSON.stringify(PLUGIN_ROOT)};
    const req = (rel) => require(require('node:path').join(root, rel));
    Promise.resolve((async () => { ${body} })()).then(
      (value) => { process.stdout.write(JSON.stringify(value)); },
      (error) => { process.stderr.write(String(error && error.stack || error)); process.exit(1); },
    );`;
  const result = spawnSync(process.execPath, ['-e', script], { env: childEnv, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, `child failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

const PORTS = `
  const r = req('lib/runtime.js');
  return { shim: r.PUBLIC_SHIM_PORT, worker: r.SHIM_PORT, proxy: r.PROXY_PORT, baseUrl: r.DEFAULT_BASE_URL };
`;

test('SQ-175: two account config dirs get distinct shim and proxy ports', (t) => {
  const home = fixtureHome(t);
  const work = path.join(home, '.iarx', 'claude');
  const personal = path.join(home, '.claude-poindexter');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(personal, { recursive: true });

  const a = runIn({ home, configDir: work }, PORTS);
  const b = runIn({ home, configDir: personal }, PORTS);

  assert.notEqual(a.shim, b.shim, 'two accounts must not share the public shim port');
  assert.notEqual(a.proxy, b.proxy, 'two accounts must not share the proxy port');
  assert.notEqual(a.baseUrl, b.baseUrl, 'each account wires ANTHROPIC_BASE_URL to its own shim');
  for (const ports of [a, b]) {
    assert.equal(ports.worker, ports.shim);
    assert.ok(new Set([ports.shim, ports.proxy, 18764, 18765, 18766]).size === 5
      || (ports.shim === 18764 && ports.proxy === 18765), `derived ports stay off the fixed gateway ports: ${JSON.stringify(ports)}`);
  }
  // Deterministic: the same tree always lands on the same pair.
  assert.deepEqual(runIn({ home, configDir: personal }, PORTS), b);
});

test('SQ-175: the default tree keeps 18764/18765, physically, so existing wiring is unchanged', (t) => {
  const home = fixtureHome(t);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  assert.deepEqual(runIn({ home }, PORTS), { shim: 18764, worker: 18764, proxy: 18765, baseUrl: 'http://127.0.0.1:18764' });
  assert.equal(runIn({ home, configDir: path.join(home, '.claude') }, PORTS).shim, 18764);

  // ~/.claude as a symlink into an account tree: that tree IS the default tree.
  const linkedHome = fixtureHome(t);
  const work = path.join(linkedHome, '.iarx', 'claude');
  fs.mkdirSync(work, { recursive: true });
  fs.symlinkSync(work, path.join(linkedHome, '.claude'));
  assert.equal(runIn({ home: linkedHome, configDir: work }, PORTS).shim, 18764);
  assert.equal(runIn({ home: linkedHome }, PORTS).shim, 18764);
});

test('SQ-175: explicit port env overrides still win', (t) => {
  const home = fixtureHome(t);
  const personal = path.join(home, '.claude-poindexter');
  fs.mkdirSync(personal, { recursive: true });
  const ports = runIn({ home, configDir: personal, env: { CODEX_GATEWAY_PORT: '19001', CODEX_GATEWAY_PROXY_PORT: '19002' } }, PORTS);
  assert.deepEqual(ports, { shim: 19001, worker: 19001, proxy: 19002, baseUrl: 'http://127.0.0.1:19001' });
});

test('SQ-175: pre-fix wiring to the shared legacy URL is still the gateway\'s own, so ensure can migrate it', (t) => {
  const home = fixtureHome(t);
  const personal = path.join(home, '.claude-poindexter');
  fs.mkdirSync(personal, { recursive: true });
  const legacy = 'http://127.0.0.1:18764';
  fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: legacy } }));
  const result = runIn({ home, configDir: personal }, `
    const pins = req('lib/pins.js');
    const wiring = req('lib/settings-wiring.js');
    return { ours: pins.ourBaseUrls(), wired: wiring.isWired(), mode: wiring.wiredMode(), target: pins.envBlockFor('default').ANTHROPIC_BASE_URL };
  `);
  assert.ok(result.ours.includes(legacy));
  assert.equal(result.wired, true);
  assert.equal(result.mode?.mode, 'default');
  assert.equal(result.mode?.scope, 'user');
  assert.notEqual(result.target, legacy, 'the rewrite target is this account\'s own port');
});

test('SQ-175: a shim held by a different install root is reported as foreign, not as a stale shim version', (t) => {
  const home = fixtureHome(t);
  const personal = path.join(home, '.claude-poindexter');
  fs.mkdirSync(personal, { recursive: true });
  const foreignRoot = path.join(home, '.iarx', 'claude', 'plugins', 'cache', 'loadout', 'model-gateway', '0.51.4');
  // The reported incident: an older foreign shim (no identity in /healthz) answers
  // this account's port; process inspection names its install root.
  const readiness = runIn({ home, configDir: personal }, `
    const { getCodexReadiness } = req('lib/commands.js');
    const supervision = req('lib/process-supervision.js');
    const foreign = { pid: 34373, installRoot: ${JSON.stringify(foreignRoot)} };
    const lookup = () => foreign;
    return getCodexReadiness({
      binaryPresent: true,
      probeProxyModels: async () => true,
      authStatus: () => true,
      shimHealth: { ok: true, supervisorVersion: '0.0.1', proxyRecovery: true },
      foreignOwner: (args) => supervision.foreignShimOwner({ ...args, lookup }),
    });
  `);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.state, 'foreign-shim-owner');
  // The pre-fix misdiagnosis: "model-gateway is serving a stale shim version. Run ... ensure".
  assert.doesNotMatch(readiness.message, /serving a stale shim version/);
  assert.match(readiness.message, /PID 34373/);
  assert.ok(readiness.message.includes(foreignRoot), 'the refusal names the foreign install root');
  assert.match(readiness.message, /CODEX_GATEWAY_PORT/, 'the refusal names the real remedy');
  assert.match(readiness.message, /cannot replace it/);
});

test('SQ-175: /healthz identity catches a foreign shim even when its version is newer', (t) => {
  const home = fixtureHome(t);
  const personal = path.join(home, '.claude-poindexter');
  const work = path.join(home, '.iarx', 'claude');
  fs.mkdirSync(personal, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  const result = runIn({ home, configDir: personal }, `
    const s = req('lib/process-supervision.js');
    const r = req('lib/runtime.js');
    let lookups = 0;
    const lookup = () => { lookups += 1; return null; };
    const foreign = s.foreignShimOwner({ health: { ok: true, stateDir: ${JSON.stringify(path.join(work, 'model-gateway'))}, supervisorPid: 4242, installRoot: '/x/0.99.0' }, servingVersionMatches: true, lookup });
    const own = s.foreignShimOwner({ health: { ok: true, stateDir: r.STATE }, servingVersionMatches: false, lookup });
    const currentLegacy = s.foreignShimOwner({ health: { ok: true }, servingVersionMatches: true, lookup });
    return { foreign, own, currentLegacy, lookups, refusal: s.foreignPortOwnerReason({ pid: 4242, installRoot: '/x/0.99.0' }, 18764) };
  `);
  assert.deepEqual(result.foreign, { pid: 4242, installRoot: '/x/0.99.0', stateDir: path.join(work, 'model-gateway') });
  assert.equal(result.own, null, 'this account\'s own shim is never foreign');
  assert.equal(result.currentLegacy, null, 'a current-version shim without identity costs no process lookup');
  assert.equal(result.lookups, 0);
  // The install-root refusal is unchanged in substance and now names the remedy.
  assert.match(result.refusal, /^refusing to stop PID 4242 on :18764; it belongs to a different install root \(\/x\/0\.99\.0\)/);
  assert.match(result.refusal, /CODEX_GATEWAY_PORT and CODEX_GATEWAY_PROXY_PORT/);
});
