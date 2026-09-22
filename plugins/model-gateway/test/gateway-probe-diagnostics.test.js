'use strict';

// SQ-63: the /v1/models probe existed in three byte-identical private copies, each
// ending in `catch { return false; }`. That collapsed a 2s timeout, an ECONNREFUSED,
// a mid-body reset and a non-200 status into one indistinguishable `false`, which is
// why a probe with a measured ~50% false-negative rate ran for eleven days on this
// machine without anyone being able to name the cause. These tests pin the four
// discriminations that `catch` used to throw away, and pin that the guardian's log
// line now carries them.
//
// This file's env must be isolated BEFORE ../lib/commands.js is first required: its
// constants are computed once at module load from CLAUDE_CONFIG_DIR, and readiness
// still touches the real STATE directory. Node's test runner gives each test file its
// own process, so this never reaches a real ~/.claude (see the model-gateway test
// pollution incident in project memory).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-probe-diagnostics-'));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.CLAUDE_CONFIG_DIR = path.join(isolatedHome, '.claude');
process.env.CODEX_GATEWAY_PORT = '0';
process.env.CODEX_GATEWAY_WORKER_PORT = '0';
process.env.CODEX_GATEWAY_PROXY_PORT = '0';

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const test = require('node:test');
const {
  createProxyRecovery, describeFetchFailure, PROBE_TIMEOUT_MS, probeFailureReason, probeSucceeded, proxyModelsAnswering, proxyModelsProbe,
} = require('../lib/process-supervision.js');
const gateway = require('../lib/commands.js');

test.after(() => { fs.rmSync(isolatedHome, { recursive: true, force: true }); });

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// A port that is bound but whose listener never answers: the fixture keeps the port
// held for the whole test rather than freeing a number something else could claim.
async function silentListener(t) {
  const held = [];
  const server = net.createServer((socket) => held.push(socket));
  const port = await listen(server);
  t.after(() => new Promise((resolve) => {
    for (const socket of held) socket.destroy();
    server.close(resolve);
  }));
  return port;
}

async function closedPort(t) {
  const server = net.createServer(() => {});
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  t.after(() => {});
  return port;
}

test('the probe names a refused connection instead of reporting a bare false', async (t) => {
  const port = await closedPort(t);
  const result = await proxyModelsProbe(port);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'ECONNREFUSED', 'the error code is the discriminator the old catch discarded');
  assert.match(result.reason, /ECONNREFUSED/);
  assert.match(result.reason, /before any response headers/, 'a refused connection never reached the response');
  assert.equal(await proxyModelsAnswering(port), false, 'the boolean wrapper still answers false for the same failure');
});

test('the probe names a timeout, with the budget it ran out of', async (t) => {
  const port = await silentListener(t);
  const result = await proxyModelsProbe(port, undefined, { timeout: 120 });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'ETIMEDOUT', 'a timeout must be machine-distinguishable from a reset or a refusal');
  assert.match(result.reason, /no answer within 120ms/, 'the reason names the budget, so a marginal timeout is visible as one');
  assert.ok(result.elapsedMs >= 100, `the probe reports how long it waited (got ${result.elapsedMs}ms)`);
});

test('the probe names a non-200 answer rather than calling the proxy silent', async (t) => {
  const server = http.createServer((req, res) => { res.statusCode = 503; res.end('busy'); });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const result = await proxyModelsProbe(port);

  assert.equal(result.ok, false);
  assert.equal(result.status, 503, 'a proxy that answered is a different problem from one that did not');
  assert.equal(result.code, null);
  assert.match(result.reason, /answered HTTP 503/);
});

test('the probe distinguishes a failure after the response headers from one before them', async (t) => {
  // The headers have to actually reach the client before the socket dies, or this
  // fixture just reproduces the pre-response case the previous test already covers.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '64' });
    res.flushHeaders();
    res.write('{"data":', () => setTimeout(() => res.socket.destroy(), 20));
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const result = await proxyModelsProbe(port);

  assert.equal(result.ok, false);
  assert.match(
    result.reason,
    /reading the response body/,
    'a 200 whose body never arrived is a different root cause from a connection that was refused',
  );
});

test('a healthy proxy probes clean, with no reason to report', async (t) => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/v1/models');
    res.end(JSON.stringify({ data: [] }));
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const result = await proxyModelsProbe(port);

  assert.deepEqual(
    { ok: result.ok, status: result.status, code: result.code, reason: result.reason },
    { ok: true, status: 200, code: null, reason: null },
  );
  assert.equal(await proxyModelsAnswering(port), true);
});

test('the probe timeout is one shared number rather than three copies that happen to agree', () => {
  assert.equal(PROBE_TIMEOUT_MS, 2000);
});

// A reset on a socket that came out of the keep-alive pool is the one failure mode an
// external prober cannot reproduce, so the annotation has to survive into the reason
// text for it to ever be diagnosable from a log file.
test('the failure description reports a reused keep-alive socket', () => {
  const error = Object.assign(new Error('socket hang up'), {
    code: 'ECONNRESET', reusedSocket: true, elapsedMs: 4, phase: 'before any response headers',
  });

  assert.match(describeFetchFailure(error), /ECONNRESET/);
  assert.match(describeFetchFailure(error), /on a reused keep-alive socket/);
  assert.match(describeFetchFailure(error), /after 4ms/);
});

test('the guardian log line carries the probe reason alongside the counter operators already grep', async () => {
  const logs = [];
  const recovery = createProxyRecovery({
    proxyBinary: 'fake-proxy',
    probe: async () => ({ ok: false, reason: 'no answer within 2000ms before any response headers after 2001ms' }),
    listening: async () => true,
    binaryExists: () => true,
    now: () => 0,
    report: (message) => logs.push(message),
  });

  const first = await recovery.recover();

  assert.equal(first.state, 'probe-unconfirmed');
  assert.equal(first.probeReason, 'no answer within 2000ms before any response headers after 2001ms');
  assert.match(
    logs.join('\n'),
    /did not answer \(1 of 3 consecutive checks\) while :\d+ is still bound; leaving it running \[probe: no answer within 2000ms before any response headers after 2001ms\]/,
    'the existing prefix is preserved so log-counting greps keep working; the discriminator is appended',
  );
});

test('the guardian still accepts a boolean probe and logs no reason when it has none', async () => {
  const logs = [];
  let answering = false;
  const recovery = createProxyRecovery({
    proxyBinary: 'fake-proxy',
    probe: async () => answering,
    listening: async () => true,
    binaryExists: () => true,
    now: () => 0,
    report: (message) => logs.push(message),
  });

  assert.equal((await recovery.recover()).state, 'probe-unconfirmed');
  answering = true;
  assert.equal((await recovery.recover()).state, 'healthy');
  assert.match(logs.join('\n'), /did not answer \(1 of 3 consecutive checks\)/);
  assert.equal(logs.join('\n').includes('[probe:'), false, 'a boolean probe has no discriminator to report');
});

test('probeSucceeded and probeFailureReason read both the detail record and the legacy boolean', () => {
  assert.equal(probeSucceeded(true), true);
  assert.equal(probeSucceeded(false), false);
  assert.equal(probeSucceeded({ ok: true }), true);
  assert.equal(probeSucceeded({ ok: false, reason: 'ECONNREFUSED' }), false, 'a failure record must never read as truthy');
  assert.equal(probeFailureReason({ ok: false, reason: 'ECONNREFUSED' }), 'ECONNREFUSED');
  assert.equal(probeFailureReason(false), null);
});

test('readiness tells an operator why /v1/models did not answer, not just that it did not', async () => {
  const readiness = await gateway.getCodexReadiness({
    binaryPresent: true,
    probeProxyModels: async () => ({ ok: false, reason: 'ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:18765 before any response headers after 1ms' }),
    authStatus: () => true,
    shimHealth: { ok: true },
  });

  assert.equal(readiness.state, 'proxy-down');
  assert.equal(readiness.checks.proxyModels, false);
  assert.match(readiness.checks.proxyModelsReason, /ECONNREFUSED/);
  assert.match(
    readiness.message,
    /not answering on \/v1\/models \(ECONNREFUSED: connect ECONNREFUSED 127\.0\.0\.1:18765 before any response headers after 1ms\)/,
  );
});

test('readiness keeps working for a caller that injects a plain boolean probe', async () => {
  const down = await gateway.getCodexReadiness({
    binaryPresent: true, probeProxyModels: async () => false, authStatus: () => true, shimHealth: { ok: true },
  });
  assert.equal(down.state, 'proxy-down');
  assert.equal(down.checks.proxyModelsReason, null);
  assert.match(down.message, /not answering on \/v1\/models\. The running shim supervisor/, 'no reason means no parenthetical');

  const up = await gateway.getCodexReadiness({
    binaryPresent: true, probeProxyModels: async () => true, authStatus: () => true, shimHealth: { ok: true, supervisorVersion: gateway.PLUGIN_VERSION },
  });
  assert.equal(up.checks.proxyModels, true);
  assert.equal(up.checks.proxyModelsReason, null);
});

test('a startup timeout reports the last probe reason instead of an unexplained failure', async () => {
  const result = await gateway.waitForStartupReadiness({
    timeout: 5,
    proxyAnswers: async () => ({ ok: false, reason: 'no answer within 2000ms before any response headers after 2001ms' }),
    shimReady: async () => true,
    shimFailureExists: () => false,
    pause: async () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.match(result.probeReason, /no answer within 2000ms/);
});
