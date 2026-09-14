'use strict';

// This file's own env must be isolated BEFORE ../lib/commands.js is first required:
// startAll() still touches the real STATE directory (mkdirs, reapGatewayOrphans,
// stopRunningSupervisor's internal ownership probe) even when its network probes
// are injected below, and those constants are computed once at module load from
// CLAUDE_CONFIG_DIR. Node's test runner gives each test file its own process, so
// setting this here is confined to this file and never touches a real ~/.claude on
// the machine running these tests (see the model-gateway test pollution incident in
// project memory — this is exactly the mistake that guards against).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-startup-patience-'));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.CLAUDE_CONFIG_DIR = path.join(isolatedHome, '.claude');
process.env.CODEX_GATEWAY_PORT = '0';
process.env.CODEX_GATEWAY_WORKER_PORT = '0';
process.env.CODEX_GATEWAY_PROXY_PORT = '0';

const assert = require('node:assert/strict');
const test = require('node:test');
const gateway = require('../lib/commands.js');

test.after(() => { fs.rmSync(isolatedHome, { recursive: true, force: true }); });

function healthyRecord() {
  return { proxyRecovery: true, supervisorVersion: gateway.PLUGIN_VERSION };
}

// SQ-23: commit e05f1947 gave the guardian recovery loop (createProxyRecovery)
// three-consecutive-failure patience before it restarts the proxy, but startAll()
// never got the same treatment — a single bad /healthz probe went straight to
// stopRunningSupervisor(), which is exactly how a supervisor healthy for 16 hours
// got SIGTERM'd. This asserts the fix: two transient failures below the threshold
// must never call beginRecovery (the gate in front of that SIGTERM).
test('startAll tolerates transient shim-health probe failures below the threshold and never begins recovery', async () => {
  let healthCalls = 0;
  const result = await gateway.startAll({
    resolveOwner: async () => ({ state: 'same-install', pid: 4242, installRoot: 'fixture-install' }),
    proxyExists: () => true,
    isPortBound: async () => true,
    probeShimHealth: async () => {
      healthCalls += 1;
      return healthCalls < 3 ? null : healthyRecord();
    },
    shimReady: async () => true,
    proxyAnswers: async () => true,
    lifecycleOperation: 'ensure',
  });

  assert.equal(healthCalls, 3, 'the health probe must be retried up to the patience threshold before being trusted');
  assert.equal(result.ok, true);
  assert.equal(
    result.recoveryAttempted,
    false,
    'two transient probe failures must never call beginRecovery, which gates stopRunningSupervisor (the SIGTERM path)',
  );
});

// The other half of the same patience: a probe that never recovers within the
// threshold must still be treated as genuinely down, so recovery is not disabled
// outright — only made patient.
test('startAll begins recovery once shim-health failures exceed the patience threshold', async () => {
  let healthCalls = 0;
  const result = await gateway.startAll({
    resolveOwner: async () => ({ state: 'same-install', pid: 4242, installRoot: 'fixture-install' }),
    proxyExists: () => true,
    isPortBound: async () => true,
    probeShimHealth: async () => { healthCalls += 1; return null; },
    shimReady: async () => true,
    proxyAnswers: async () => true,
    lifecycleOperation: 'ensure',
  });

  assert.equal(healthCalls, 3, 'exactly three consecutive failures earn a recovery attempt');
  assert.equal(result.recoveryAttempted, true);
});

// SQ-23: waitForStartupReadiness's own timeout ("failed") was previously the final
// word, even though the actual incident showed both racing `ensure` processes
// reporting "failed" while the gateway was, in fact, serving. A racer whose own
// wait window expired but which can observe the gateway now serving must report
// ready, not failed.
test('startAll reports ready when its own wait window times out but the gateway is confirmed serving', async () => {
  let proxyAnswerCalls = 0;
  const result = await gateway.startAll({
    resolveOwner: async () => ({ state: 'same-install', pid: 4242, installRoot: 'fixture-install' }),
    proxyExists: () => true,
    isPortBound: async () => false,
    probeShimHealth: async () => null,
    shimReady: async () => true,
    // False during the wait loop (forcing a timeout), true on the authoritative
    // recheck performed after the loop gives up.
    proxyAnswers: async () => { proxyAnswerCalls += 1; return proxyAnswerCalls > 1; },
    startupWaitMs: 10,
    lifecycleOperation: 'ensure',
  });

  assert.ok(proxyAnswerCalls > 1, 'the wait loop must have run at least once before timing out');
  assert.equal(result.ok, true, 'a racer whose own wait timed out but can now observe the gateway serving must report ready');
  assert.equal(result.recoveredAfterOwnTimeout, true);
});

// Symmetric control: when the authoritative recheck also finds nothing serving,
// startAll must still report the honest failure — the recheck only rescues a false
// negative, it never manufactures a false positive.
test('startAll still reports failure when the authoritative recheck also finds nothing serving', async () => {
  const result = await gateway.startAll({
    resolveOwner: async () => ({ state: 'same-install', pid: 4242, installRoot: 'fixture-install' }),
    proxyExists: () => true,
    isPortBound: async () => false,
    probeShimHealth: async () => null,
    shimReady: async () => true,
    proxyAnswers: async () => false,
    startupWaitMs: 10,
    lifecycleOperation: 'ensure',
  });

  assert.equal(result.ok, false);
  assert.equal(result.recoveredAfterOwnTimeout, undefined);
  assert.match(result.reason, /not healthy after/);
});
