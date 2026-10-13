'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { gatewayTestEnvironment, spawnGatewayProcess, spawnGatewayProcessSync, startGateway } = require('./support.js');

const RUNTIME = path.join(__dirname, '..', 'lib', 'runtime.js');
const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const runtime = require(RUNTIME);

function cachePath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-discovery-cache-'));
  return path.join(directory, 'cache', 'gateway-models.json');
}

function shimModels() {
  return [
    { id: 'claude-gpt-6-astra', display_name: 'GPT-6 Astra (Codex)', type: 'model' },
    { id: 'anthropic-custom', display_name: 'Anthropic Custom', description: 'removed' },
    { id: 'gpt-6-astra', display_name: 'Filtered out' },
  ];
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function waitUntil(check, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

function runGatewayCommand(testContext, command, environment, isolatedOverrides) {
  return new Promise((resolve) => {
    const child = spawnGatewayProcess(testContext, process.execPath, [CLI, command], {
      cwd: environment.HOME,
      env: environment,
      isolatedOverrides,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function installProxyStub(home) {
  const proxyBinary = path.join(home, '.claude', 'model-gateway', 'bin', 'claude-code-proxy');
  fs.mkdirSync(path.dirname(proxyBinary), { recursive: true });
  try {
    fs.linkSync(process.execPath, proxyBinary);
  } catch {
    fs.copyFileSync(process.execPath, proxyBinary);
  }
  return proxyBinary;
}

// SQ-37: CODEX_GATEWAY_PORT is left at the environment default ('0') here so
// the shim binds without a pre-reserved number to race against. runtime.js's
// DEFAULT_BASE_URL is a static, require-time constant computed straight from
// the literal CODEX_GATEWAY_PORT string, never corrected to the real
// OS-assigned port, so ANTHROPIC_BASE_URL must be pinned to the SAME literal
// 'http://127.0.0.1:0' placeholder for effectiveBaseUrl() === DEFAULT_BASE_URL
// to hold inside that process -- otherwise syncGatewayDiscoveryCache() skips
// the write as "gateway-not-wired". Both sides being the same fixed string is
// what keeps this self-consistent without needing to know the real port in
// advance.
function discoveryEnvironment(testContext, baseUrl, proxyPort) {
  return gatewayTestEnvironment(testContext, {
    ANTHROPIC_BASE_URL: baseUrl,
    CODEX_GATEWAY_REQUEST_LOG: '0',
  }, {
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
  });
}

// SQ-37: once the shim above has reported the real port it bound (there is no
// gap for another process to steal the number, since this reads it back
// after the bind already happened rather than reserving it beforehand), a
// later command that must target that exact already-running shim needs the
// shared environment corrected to match: the literal port ensure/stop probe
// over HTTP, and the ANTHROPIC_BASE_URL placeholder so that process's own
// wiring stays self-consistent too. CODEX_GATEWAY_WORKER_PORT is dropped
// rather than left at the environment's '0' default: lib/commands.js and
// lib/process-supervision.js both compute
// `Number(CODEX_GATEWAY_WORKER_PORT || PUBLIC_SHIM_PORT)`, and the string
// '0' is truthy, so leaving it in place would freeze that health-probe port
// at 0 instead of falling back to the real supervisor port -- an existing
// env-fallback quirk, not something this test-only change fixes in lib/.
function pinDiscoveredShim(environment, shimPort) {
  environment.CODEX_GATEWAY_PORT = String(shimPort);
  environment.ANTHROPIC_BASE_URL = `http://127.0.0.1:${shimPort}`;
  delete environment.CODEX_GATEWAY_WORKER_PORT;
}

test('writes Claude Code discovery cache schema from the shim model list', () => {
  const file = cachePath();
  const result = runtime.syncGatewayDiscoveryCache({
    cachePath: file,
    models: shimModels(),
    now: () => 1786455666039,
  });

  assert.deepEqual(result, { state: 'wrote', cachePath: file, modelCount: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    baseUrl: runtime.DEFAULT_BASE_URL,
    fetchedAt: 1786455666039,
    models: [
      { id: 'claude-gpt-6-astra[1m]', display_name: 'GPT-6 Astra (Codex)' },
      { id: 'anthropic-custom', display_name: 'Anthropic Custom' },
    ],
  });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('does not rewrite an unchanged discovery cache', () => {
  const file = cachePath();
  runtime.syncGatewayDiscoveryCache({ cachePath: file, models: shimModels(), now: () => 100 });
  const before = fs.statSync(file).mtimeMs;

  const result = runtime.syncGatewayDiscoveryCache({ cachePath: file, models: shimModels(), now: () => 200 });

  assert.deepEqual(result, { state: 'unchanged', cachePath: file, modelCount: 2 });
  assert.equal(fs.statSync(file).mtimeMs, before);
});

test('leaves a foreign discovery cache alone when its model list is current', () => {
  const file = cachePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = JSON.stringify({
    baseUrl: 'http://other-gateway.example',
    fetchedAt: 1,
    models: [
      { id: 'claude-gpt-6-astra[1m]', display_name: 'GPT-6 Astra (Codex)' },
      { id: 'anthropic-custom', display_name: 'Anthropic Custom' },
    ],
  });
  fs.writeFileSync(file, original);

  const result = runtime.syncGatewayDiscoveryCache({ cachePath: file, models: shimModels() });

  assert.deepEqual(result, { state: 'unchanged', cachePath: file, modelCount: 2 });
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('does not touch the discovery cache in RC-compatibility mode', () => {
  const file = cachePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'keep-this-cache');

  const result = runtime.syncGatewayDiscoveryCache({
    baseUrl: runtime.COMPAT_BASE_URL,
    cachePath: file,
    models: shimModels(),
  });

  assert.deepEqual(result, { state: 'skipped', reason: 'rc-compatibility', cachePath: file, modelCount: 0 });
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep-this-cache');
});

test('uses CLAUDE_CONFIG_DIR for the discovery cache', (testContext) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-discovery-config-home-'));
  const configDirectory = path.join(home, 'custom-claude-config');
  testContext.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = spawnGatewayProcessSync(process.execPath, ['-e', [
    `const runtime = require(${JSON.stringify(RUNTIME)});`,
    "runtime.syncGatewayDiscoveryCache({ models: [{ id: 'claude-gpt-6-astra', display_name: 'GPT-6 Astra (Codex)' }] });",
  ].join('')], {
    encoding: 'utf8',
    env: { HOME: home, USERPROFILE: home },
    isolatedOverrides: {
      CLAUDE_CONFIG_DIR: configDirectory,
      CODEX_GATEWAY_PORT: '27321',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const cache = JSON.parse(fs.readFileSync(path.join(configDirectory, 'cache', 'gateway-models.json'), 'utf8'));
  assert.equal(cache.baseUrl, 'http://127.0.0.1:27321');
  assert.equal(typeof cache.fetchedAt, 'number');
  assert.deepEqual(cache.models, [{ id: 'claude-gpt-6-astra[1m]', display_name: 'GPT-6 Astra (Codex)' }]);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'cache', 'gateway-models.json')), false);
});

test('refreshModels writes the configured gateway discovery cache', async (testContext) => {
  const proxy = http.createServer((request, response) => {
    if (request.url !== '/v1/models') return response.end();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'gpt-6-astra' }] }));
  });
  const proxyPort = await listen(proxy);
  testContext.after(() => new Promise((resolve) => proxy.close(resolve)));
  const baseUrl = 'http://127.0.0.1:0';
  const environment = discoveryEnvironment(testContext, baseUrl, proxyPort);
  const cache = path.join(environment.CLAUDE_CONFIG_DIR, 'cache', 'gateway-models.json');
  // SQ-19 withholds the Grok rows unless Grok CLI auth is present, and the
  // fixture home has none. Seeding it keeps this test's subject (what
  // refreshModels writes into the cache) covering every backend instead of
  // silently narrowing to Codex. readGrokAuth wants a `https://auth.x.ai::`
  // entry with a non-empty `key`; less than that reads as auth-invalid.
  fs.mkdirSync(environment.CODEX_GATEWAY_GROK_HOME, { recursive: true });
  fs.writeFileSync(path.join(environment.CODEX_GATEWAY_GROK_HOME, 'auth.json'), JSON.stringify({
    'https://auth.x.ai::openid': { key: 'test-grok-key', expires_at: Date.now() + 3600000 },
  }));

  await startGateway(testContext, 'serve-shim', environment);
  testContext.after(() => assert.equal(
    fs.existsSync(environment.HOME),
    false,
    'fixture teardown removes the home after the supervisor and worker exit',
  ));

  await waitUntil(() => fs.existsSync(cache), 'refreshModels did not write the discovery cache');

  const discoveryCache = JSON.parse(fs.readFileSync(cache, 'utf8'));
  assert.equal(discoveryCache.baseUrl, baseUrl);
  assert.deepEqual(discoveryCache.models, [
    { id: 'claude-gpt-6-astra[1m]', display_name: 'GPT-6-astra (Codex)' },
    { id: 'claude-grok-4.5[1m]', display_name: 'Grok 4.5' },
  ]);
});

test('ensure writes the discovery cache before reporting missing ChatGPT auth', async (testContext) => {
  const proxy = http.createServer((request, response) => {
    if (request.url !== '/v1/models') return response.end();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'gpt-6-astra' }] }));
  });
  const proxyPort = await listen(proxy);
  testContext.after(() => new Promise((resolve) => proxy.close(resolve)));
  const baseUrl = 'http://127.0.0.1:0';
  const environment = discoveryEnvironment(testContext, baseUrl, proxyPort);
  const cache = path.join(environment.CLAUDE_CONFIG_DIR, 'cache', 'gateway-models.json');
  installProxyStub(environment.HOME);
  const shim = await startGateway(testContext, 'serve-shim', environment);

  await waitUntil(() => fs.existsSync(cache), 'initial refresh did not write the discovery cache');
  fs.rmSync(cache);

  pinDiscoveredShim(environment, shim.port);

  const result = await runGatewayCommand(testContext, 'ensure', environment);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /ChatGPT sign-in is required/);
  // SQ-23's regression guard, kept from the simulated-Windows test SQ-36
  // retired: the missing-auth precondition must be what surfaces, never the
  // ownership gate's "could not confirm the owner" refusal firing ahead of it.
  // See the note below this test for why that ordering was ever at risk.
  assert.doesNotMatch(result.stderr, /could not confirm the owner/);
  await waitUntil(() => fs.existsSync(cache), 'ensure did not write the discovery cache');
  assert.match(result.stdout, /discovery cache: (?:wrote \d+ models?|unchanged)/);

  const stopped = await runGatewayCommand(testContext, 'stop', environment);
  assert.equal(stopped.status, 0, stopped.stderr);
});

// Why the doesNotMatch assertion above exists. SQ-23 gated startAll()'s
// lifecycle mutations on confirming who owns the shim's public port. That
// confirmation can itself come back unconfirmable (process inspection times
// out or fails), and unpatched `ensure` called startAll() unconditionally, so
// the ownership refusal ("could not confirm the owner...") fired *before*
// ensure ever reached the missing-ChatGPT-auth precondition, masking the real,
// unrelated failure. The fix (lib/commands.js `ensure`) skips startAll()
// entirely when a direct, cheap health probe already shows the shim running on
// the current version -- nothing to start or restart, so there is nothing for
// the ownership gate to arbitrate.
//
// A Windows CI runner is where this was first seen, and SQ-36 retired the
// simulated-Windows child that used to reproduce it in a second test here.
// Nothing about the bug is Windows-specific -- the simulation's only purpose
// was to make discovery probes fail, by running them as netstat/PowerShell
// commands absent on this host, and any host whose process inspection
// overruns the probe budget reaches the same "unknown owner" state. So the
// guard moved onto the real-platform test above rather than being deleted
// with the simulation. Note it is a one-way guard: it proves the refusal does
// not pre-empt the auth error, and it is load-sensitive in the other
// direction, because a host slow enough to make ownership unconfirmable will
// fail this test on the status assertion first.
