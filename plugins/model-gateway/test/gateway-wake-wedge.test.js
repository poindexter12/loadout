'use strict';

// SQ-239: the post-sleep /healthz wedge. The shim stayed bound to its port while
// /healthz stopped answering. Three causes, each covered here:
//   1. the worker's /healthz spawnSync'd `claude-code-proxy codex auth status`
//      (Keychain-backed), blocking the worker's whole event loop per probe;
//   2. probes rode pooled keep-alive sockets that were dead or about to be retired;
//   3. the supervisor relayed /healthz to its worker with no deadline.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { gatewayTestEnvironment, spawnGatewayProcess, startGateway } = require('./support.js');
const { createWakeDetector, dropPooledSockets, fetchUrl } = require('../lib/process-supervision.js');
const { createAuthStatusCache, getCodexReadiness, isAuthedAsync } = require('../lib/request-worker.js');

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const POSIX = process.platform !== 'win32';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function timedRequest(port, method, pathname, { timeout = 20000 } = {}) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), ms: Date.now() - startedAt }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`${method} ${pathname} did not answer within ${timeout}ms`)));
    req.once('error', reject);
    req.end();
  });
}

test('wake detector fires once per suspend gap and never on an on-time tick', () => {
  let wall = 1_000_000;
  let mono = 50_000;
  const wakes = [];
  let scheduled = null;
  const detector = createWakeDetector({
    intervalMs: 5000,
    thresholdMs: 15000,
    wallNow: () => wall,
    monotonicNow: () => mono,
    schedule: (callback) => { scheduled = callback; return { unref() {} }; },
    cancel: () => { scheduled = null; },
    onWake: (event) => wakes.push(event),
  });
  assert.equal(typeof scheduled, 'function', 'the detector arms its interval');

  wall += 5000; mono += 5000;
  assert.equal(detector.check(), null, 'an on-time tick is not a wake');
  wall += 12000; mono += 12000;
  assert.equal(detector.check(), null, 'event-loop lag under the threshold is not a wake');

  // macOS sleep: the wall clock jumps, the monotonic clock does not.
  wall += 3_600_000; mono += 5000;
  assert.equal(detector.check(), 3_595_000);
  // SIGSTOP/SIGCONT: both clocks advance by the stop.
  wall += 65000; mono += 65000;
  assert.equal(detector.check(), 60000);
  assert.deepEqual(wakes, [{ gapMs: 3_595_000 }, { gapMs: 60000 }]);

  wall += 5000; mono += 5000;
  assert.equal(detector.check(), null, 'the tick after a wake is measured from the wake, not from before it');
  detector.stop();
  assert.equal(scheduled, null);
});

test('wake detector swallows an onWake failure so the interval keeps running', () => {
  let wall = 0;
  const detector = createWakeDetector({
    wallNow: () => wall,
    monotonicNow: () => 0,
    schedule: () => ({ unref() {} }),
    cancel: () => {},
    onWake: () => { throw new Error('boom'); },
  });
  wall += 60000;
  assert.equal(detector.check(), 55000);
});

test('dropPooledSockets destroys idle keep-alive sockets so the next request opens a fresh connection', async (t) => {
  let connections = 0;
  const server = http.createServer((req, res) => res.end('ok'));
  server.on('connection', () => { connections += 1; });
  const port = await listen(server);
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => { agent.destroy(); server.closeAllConnections?.(); server.close(); });
  const get = () => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, agent }, (res) => { res.resume(); res.once('end', resolve); }).once('error', reject);
  });

  await get();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(Object.values(agent.freeSockets).flat().length, 1, 'the first request left one pooled idle socket');
  await get();
  assert.equal(connections, 1, 'without a drop the agent reuses the pooled socket');

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dropPooledSockets([agent, null, {}]), 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(Object.values(agent.freeSockets).flat().length, 0);
  await get();
  assert.equal(connections, 2, 'after the drop the next request opens a fresh connection');
});

test('fetchUrl probes never ride a pooled keep-alive socket', async (t) => {
  let connections = 0;
  const server = http.createServer((req, res) => res.end('{"ok":true}'));
  server.on('connection', () => { connections += 1; });
  const port = await listen(server);
  t.after(() => { server.closeAllConnections?.(); server.close(); });

  for (let index = 0; index < 3; index += 1) {
    const response = await fetchUrl(`http://127.0.0.1:${port}/healthz`, { timeout: 2000 });
    assert.equal(response.status, 200);
  }
  assert.equal(connections, 3, 'each probe opened its own connection');
  assert.equal(Object.values(http.globalAgent.freeSockets).flat().length, 0, 'no probe socket was left in the global pool');
});

test('auth status cache awaits only the first answer and serves the last one while a refresh runs', async () => {
  let clock = 0;
  const answers = [];
  let calls = 0;
  const cache = createAuthStatusCache({
    ttlMs: 1000,
    now: () => clock,
    check: () => { calls += 1; return new Promise((resolve, reject) => answers.push({ resolve, reject })); },
  });

  const first = cache.status();
  assert.equal(typeof first?.then, 'function', 'the first call has nothing cached and waits');
  await null;
  answers.shift().resolve(true);
  assert.equal(await first, true);

  assert.equal(cache.status(), true, 'a fresh answer is served synchronously');
  assert.equal(calls, 1);

  clock += 1000;
  assert.equal(cache.status(), true, 'an expired answer is still served while its refresh runs');
  await null;
  assert.equal(cache.status(), true);
  assert.equal(calls, 2, 'concurrent callers share one refresh');

  answers.shift().reject(new Error('spawn failed'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cache.status(), true, 'a failed refresh keeps the last answer instead of flipping to auth-missing');

  cache.invalidate();
  assert.equal(cache.status(), true);
  await null;
  assert.equal(calls, 3, 'invalidate() makes the next read start a refresh');
  answers.shift().resolve(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cache.status(), false, 'a completed refresh replaces the answer');
});

test('auth status cache reports signed-out when the very first check fails', async () => {
  const cache = createAuthStatusCache({ check: async () => { throw new Error('ENOENT'); } });
  assert.equal(await cache.status(), false);
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

test('isAuthedAsync reads auth status without blocking and bounds a hung check', async () => {
  const signedIn = fakeChild();
  const pendingSignedIn = isAuthedAsync({ spawnProcess: () => signedIn });
  signedIn.stdout.emit('data', 'Logged in, account: someone\n');
  signedIn.emit('close', 0);
  assert.equal(await pendingSignedIn, true);

  const signedOut = fakeChild();
  const pendingSignedOut = isAuthedAsync({ spawnProcess: () => signedOut });
  signedOut.stderr.emit('data', 'not logged in\n');
  signedOut.emit('close', 1);
  assert.equal(await pendingSignedOut, false);

  const hung = fakeChild();
  const startedAt = Date.now();
  assert.equal(await isAuthedAsync({ timeout: 50, spawnProcess: () => hung }), false);
  assert.equal(hung.killed, true, 'a hung check is killed at its timeout');
  assert.ok(Date.now() - startedAt < 2000);

  assert.equal(await isAuthedAsync({ spawnProcess: () => { throw new Error('EACCES'); } }), false);
});

test('getCodexReadiness awaits an asynchronous auth status', async () => {
  const readiness = await getCodexReadiness({
    binaryPresent: true,
    probeProxyModels: async () => true,
    authStatus: async () => true,
    shimHealth: { ok: true, version: '0.0.0' },
    foreignOwner: () => null,
  });
  assert.equal(readiness.checks.codexAuth, true);
  const signedOut = await getCodexReadiness({
    binaryPresent: true,
    probeProxyModels: async () => true,
    authStatus: async () => false,
    shimHealth: { ok: true, version: '0.0.0' },
    foreignOwner: () => null,
  });
  assert.equal(signedOut.checks.codexAuth, false);
});

test('a slow auth status check does not stall the worker event loop', { skip: !POSIX && 'needs a POSIX fake proxy binary' }, async (t) => {
  const environment = gatewayTestEnvironment(t);
  const home = environment.HOME;
  const binDir = path.join(home, '.claude', 'model-gateway', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const fakeProxy = path.join(binDir, 'claude-code-proxy');
  // Stands in for a Keychain read after a wake: slow, then signed in.
  fs.writeFileSync(fakeProxy, '#!/bin/sh\nsleep 3\necho "Logged in, account: test"\n', { mode: 0o755 });

  const child = spawnGatewayProcess(t, process.execPath, [CLI, 'serve-worker'], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => new Promise((done) => {
    if (child.exitCode != null) return done();
    child.once('exit', done);
    child.kill();
  }));
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`worker did not listen: ${output}`)), 5000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/listening on 127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
  });

  // The worker primes its auth answer at boot. While that 3s check runs, /healthz
  // waits for it, but nothing else may: before SQ-239 the check was a spawnSync
  // inside /healthz and every other request queued behind it.
  const health = timedRequest(port, 'GET', '/healthz');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const head = await timedRequest(port, 'HEAD', '/');
  assert.equal(head.status, 200);
  assert.ok(head.ms < 1000, `HEAD answered in ${head.ms}ms while auth status was still running`);

  const first = await health;
  assert.equal(first.status, 200);
  assert.equal(JSON.parse(first.body).ok, true);
  const second = await timedRequest(port, 'GET', '/healthz');
  assert.equal(second.status, 200);
  assert.ok(second.ms < 1000, `a /healthz after the first answer used the cached auth status (${second.ms}ms)`);
});

test('supervisor answers /healthz with 503 when its worker is stopped, and recovers on resume', { skip: !POSIX && 'uses SIGSTOP/SIGCONT', timeout: 30000 }, async (t) => {
  const environment = gatewayTestEnvironment(t);
  const home = environment.HOME;
  const proxy = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
  });
  const proxyPort = await listen(proxy);
  t.after(() => { proxy.closeAllConnections?.(); proxy.close(); });

  const { port: shimPort } = await startGateway(t, 'serve-shim', environment, {
    isolatedOverrides: { CODEX_GATEWAY_PROXY_PORT: String(proxyPort), CODEX_GATEWAY_REQUEST_LOG: '0' },
  });
  const workerPid = Number(fs.readFileSync(path.join(home, '.claude', 'model-gateway', 'shim.pid'), 'utf8'));
  assert.ok(workerPid > 0);

  // The SQ-239 repro: suspend the worker the way a sleep does, then probe.
  process.kill(workerPid, 'SIGSTOP');
  let resumed = false;
  const resume = () => { if (!resumed) { resumed = true; try { process.kill(workerPid, 'SIGCONT'); } catch {} } };
  t.after(resume);

  const wedged = await timedRequest(shimPort, 'GET', '/healthz', { timeout: 15000 });
  assert.equal(wedged.status, 503, 'the supervisor answers for a worker that cannot');
  assert.ok(wedged.ms < 9000, `/healthz answered in ${wedged.ms}ms instead of hanging`);

  resume();
  const deadline = Date.now() + 10000;
  let recovered = null;
  while (Date.now() < deadline) {
    const attempt = await timedRequest(shimPort, 'GET', '/healthz', { timeout: 7000 }).catch(() => null);
    if (attempt?.status === 200) { recovered = attempt; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(recovered, '/healthz answers 200 again once the worker resumes');
  assert.equal(JSON.parse(recovered.body).ok, true);
});
