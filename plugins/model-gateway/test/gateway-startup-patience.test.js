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
    stopSupervisor: async () => ({ ok: true, pid: 4242 }),
    scheduleRecovery: () => { throw new Error('a confirmed stop needs no recovery controller'); },
    controllerActive: async () => false,
    lifecycleOperation: 'ensure',
  });

  assert.equal(healthCalls, 3, 'exactly three consecutive failures earn a recovery attempt');
  assert.equal(result.recoveryAttempted, true);
});

// SQ-235 (2026-09-29 22:32Z): ensure SIGTERMed a bound-but-slow supervisor, its
// 3s stop wait expired while the incumbent spent 3 minutes draining, ensure
// reported "failed" and nothing ever started a successor. :20216 went dark the
// moment the drain finished. An unconfirmed stop must hand the restart to a
// detached controller, not end the recovery.
function boundButUnresponsive(overrides = {}) {
  return {
    resolveOwner: async () => ({ state: 'same-install', pid: 4242, installRoot: 'fixture-install' }),
    proxyExists: () => true,
    isPortBound: async () => true,
    probeShimHealth: async () => null,
    shimReady: async () => { throw new Error('a handed-off recovery must not wait for readiness'); },
    launchSupervisor: () => { throw new Error('a successor cannot bind while the incumbent holds the port'); },
    controllerActive: async () => false,
    lifecycleOperation: 'ensure',
    quiet: true,
    ...overrides,
  };
}

test('startAll hands an unconfirmed incumbent stop to a detached recovery controller instead of failing', async () => {
  const scheduled = [];
  const result = await gateway.startAll(boundButUnresponsive({
    stopSupervisor: async () => ({ ok: false, reason: 'could not stop the shim supervisor on :20216 (PID 4242)' }),
    scheduleRecovery: (incumbentPid) => { scheduled.push(incumbentPid); },
  }));

  assert.deepEqual(scheduled, [4242], 'exactly one controller is scheduled, told which incumbent it waits on');
  assert.equal(result.handedOff, true);
  assert.equal(result.waitCutShort, true, 'the hook reports "still starting" and exits inside its budget');
  assert.deepEqual(result.started, ['recovery-controller']);
  assert.equal(result.recoveryAttempted, true);
});

test('a refused incumbent stop stays a failure rather than scheduling a controller that could never finish', async () => {
  let scheduled = 0;
  const outcome = await gateway.stopIncumbentForRecovery({
    quiet: true,
    operation: 'ensure',
    incumbentPid: 4242,
    // stopRunningSupervisor resolves the owner through the function it is handed and
    // sends no signal when that owner is refused, e.g. another account's gateway.
    stopSupervisor: async ({ resolveOwner }) => {
      await resolveOwner(20216);
      return { ok: false, reason: 'refused a foreign owner' };
    },
    resolveStopOwner: async () => ({ state: 'foreign-install', pid: 4242, installRoot: 'another-account' }),
    isPortBound: async () => true,
    scheduleRecovery: () => { scheduled += 1; },
  });

  assert.equal(scheduled, 0, 'nothing will ever release a port whose owner was never signalled');
  assert.equal(outcome.handedOff, undefined);
  assert.equal(outcome.stopped.ok, false);
});

test('a concurrent ensure defers to an active recovery controller instead of stopping or starting anything', async () => {
  let stops = 0;
  let scheduled = 0;
  const result = await gateway.startAll(boundButUnresponsive({
    controllerActive: async () => true,
    stopSupervisor: async () => { stops += 1; return { ok: true }; },
    scheduleRecovery: () => { scheduled += 1; },
  }));

  assert.equal(stops, 0, 'the incumbent already has a stop in flight owned by the controller');
  assert.equal(scheduled, 0, 'there is never a second controller');
  assert.equal(result.handedOff, true);
  assert.equal(result.waitCutShort, true);
  assert.equal(result.recoveryAttempted, false, 'a deferring ensure did not start a recovery of its own');
});

test('startAll launches a cold-start supervisor through the reparenting launcher', async () => {
  const launched = [];
  let readyChecks = 0;
  const result = await gateway.startAll({
    resolveOwner: async () => ({ state: 'unowned', pid: null }),
    proxyExists: () => true,
    isPortBound: async () => false,
    shimReady: async () => { readyChecks += 1; return readyChecks > 1; },
    proxyAnswers: async () => true,
    launchSupervisor: (...launchArgs) => { launched.push(launchArgs); return 5151; },
    startupWaitMs: () => 1000,
  });

  assert.equal(result.ok, true);
  assert.equal(launched.length, 1);
  assert.equal(launched[0][0], 'guardian');
  assert.equal(launched[0][2].at(-1), 'serve-shim');
});

function controllerHarness({ boundSequence, lockFreeAfter = 0, startResult = { ok: true, started: ['shim'] } }) {
  const calls = { starts: 0, claims: 0, releases: [], portChecks: 0 };
  let clock = 0;
  return {
    calls,
    options: {
      incumbentPid: 4242,
      isPortBound: async () => {
        const bound = boundSequence[Math.min(calls.portChecks, boundSequence.length - 1)];
        calls.portChecks += 1;
        return bound;
      },
      claimLock: () => { calls.claims += 1; return calls.claims > lockFreeAfter; },
      releaseLock: (outcome) => { calls.releases.push(outcome); },
      start: async (startOptions) => { calls.starts += 1; calls.startOptions = startOptions; return startResult; },
      now: () => clock,
      pause: async (milliseconds) => { clock += milliseconds; },
      timeoutMs: 5000,
      pollMs: 250,
      startupWaitMs: 42000,
    },
  };
}

test('the recovery controller waits for the incumbent to release, takes the ensure lock, and starts one successor', async () => {
  const { calls, options } = controllerHarness({ boundSequence: [true, true, true, false, false], lockFreeAfter: 2 });
  const result = await gateway.recoverShimAfterIncumbent(options);

  assert.equal(result.ok, true);
  assert.equal(calls.starts, 1, 'exactly one successor start');
  assert.equal(calls.claims, 3, 'it waits out a concurrent ensure holding the lock rather than racing it');
  assert.equal(calls.releases.length, 1, 'the lock it took is released');
  assert.equal(calls.startOptions.quiet, true);
  assert.equal(calls.startOptions.startupWaitMs, 42000, 'no hook budget applies to the detached controller');
});

test('the recovery controller starts nothing when a concurrent ensure already bound a successor', async () => {
  const { calls, options } = controllerHarness({ boundSequence: [true, false, true] });
  const result = await gateway.recoverShimAfterIncumbent(options);

  assert.equal(result.ok, true);
  assert.equal(calls.starts, 0, 'a second supervisor would race the first for the listener');
  assert.equal(calls.releases.length, 1);
});

test('the recovery controller leaves an incumbent that never releases alone after its deadline', async () => {
  const { calls, options } = controllerHarness({ boundSequence: [true] });
  const result = await gateway.recoverShimAfterIncumbent(options);

  assert.equal(result.ok, false);
  assert.equal(calls.starts, 0);
  assert.equal(calls.claims, 0, 'it never took the lock');
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
