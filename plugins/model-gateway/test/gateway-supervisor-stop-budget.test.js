'use strict';

// SQ-252 (2026-09-30 19:24 PDT, load average 29): `update-loadout` 0.52.2 -> 0.52.3
// SIGTERMed the shim supervisor, the flat 3s stop wait expired before the teardown
// finished, and the updater reported `could not restart shim supervisor ... run node
// "..." stop, then ensure` plus `Completed with 1 failure(s)`. A second, identical run
// found :20216 already free, so the SIGTERM had worked all along: the kill was never
// the problem, the wait was. These tests pin the three parts of the fix -- an
// interactive budget wide enough for a loaded machine, SIGKILL escalation instead of
// giving up, and a refusal that says the stop is still in flight -- while keeping the
// quiet (SessionStart hook) stop inside the hook budget SQ-235 relies on.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const supervision = require('../lib/process-supervision.js');

const sourcePath = require.resolve('../lib/process-supervision.js');
const source = fs.readFileSync(sourcePath, 'utf8');

// No real signal, no real pid file, no real lifecycle write: every mutation surface is
// stubbed, and `ps` reports nothing unless a test says otherwise, so ownership checks
// refuse to signal anything on the machine running the suite.
function isolatedSupervision({ processes = '', kill = null } = {}) {
  const localRequire = createRequire(sourcePath);
  const forbidden = () => assert.fail('unexpected lifecycle mutation');
  const lifecycle = [];
  const signals = [];
  const context = {
    module: { exports: {} },
    Buffer,
    console: { ...console, log: () => {}, error: () => {} },
    setTimeout,
    clearTimeout,
    process: {
      platform: 'darwin',
      pid: 1,
      env: {},
      kill: (pid, signal) => {
        signals.push({ pid, signal });
        if (kill) kill(pid, signal);
      },
    },
    require: (id) => ({
      'node:child_process': {
        spawn: forbidden,
        spawnSync: (command) => (command === 'ps' ? { status: processes ? 0 : 1, stdout: processes } : forbidden()),
      },
      'node:fs': { ...fs, writeFileSync: forbidden, rmSync: forbidden, openSync: forbidden, readFileSync: () => { throw new Error('no pid files in this fixture'); } },
      'node:http': { get: forbidden, request: forbidden },
      './lifecycle-diagnostics.js': { recordGatewayLifecycle: (event, detail) => lifecycle.push({ event, detail }) },
      './runtime.js': { ...localRequire('./runtime.js'), WIN: false },
    })[id] || localRequire(id),
  };
  vm.runInNewContext(source, context, { filename: sourcePath });
  return { gateway: context.module.exports, lifecycle, signals };
}

const INCUMBENT_PID = 4242;
const incumbentOwner = async () => ({ state: 'same-install', pid: INCUMBENT_PID, installRoot: supervision.gatewayInstallRoot() });

// Models a supervisor whose teardown takes `teardownMs` from the signal: each wait is
// handed a budget and reports success only once the budget it was given, plus whatever
// earlier waits already spent, covers that teardown. `killReleasesAt` is what a SIGKILL
// shortens it to, so a teardown that never ends on its own can still end on escalation.
function teardown({ teardownMs, killReleasesAt = null }) {
  const budgets = [];
  const kills = [];
  let spent = 0;
  let remaining = teardownMs;
  const spend = (timeout) => {
    budgets.push(timeout);
    const used = Math.min(timeout, Math.max(0, remaining - spent));
    spent += used;
    return spent >= remaining;
  };
  return {
    budgets,
    kills,
    awaitProcessExit: async (_pid, timeout) => spend(timeout),
    awaitShimExit: async (timeout) => spend(timeout),
    hardKill: (pid, options) => {
      kills.push({ pid, options });
      if (killReleasesAt !== null) remaining = killReleasesAt;
      return true;
    },
  };
}

test('an interactive stop whose supervisor exits after the old 3s budget still counts as stopped', async () => {
  const { gateway, lifecycle } = isolatedSupervision();
  const slow = teardown({ teardownMs: 4500 });
  const result = await gateway.stopRunningSupervisor({
    operation: 'setup',
    resolveOwner: incumbentOwner,
    report: () => {},
    awaitProcessExit: slow.awaitProcessExit,
    awaitShimExit: slow.awaitShimExit,
    hardKill: slow.hardKill,
  });

  assert.equal(result.ok, true, 'a SIGTERM that worked in 4.5s is a stop, not a failed restart');
  assert.equal(result.escalated, false, 'a teardown inside the budget is never escalated');
  assert.deepEqual(slow.kills, [], 'nothing is SIGKILLed while the graceful stop is still inside its budget');
  assert.equal(slow.budgets[0], 30000, 'the interactive budget is the worker drain budget it is waiting on');
  assert.equal(slow.budgets[0], gateway.supervisorStopWaitMs(false));
  assert.ok(slow.budgets[0] > 3000, 'the budget that reported SQ-252 as a failure is gone');
  assert.equal(lifecycle.filter((entry) => entry.event === 'setup-supervisor-stop-escalated').length, 0);
});

test('a stop that outlives its budget is escalated with SIGKILL and counted as stopped once the kill lands', async () => {
  const { gateway, lifecycle } = isolatedSupervision();
  const stuck = teardown({ teardownMs: Number.MAX_SAFE_INTEGER, killReleasesAt: 0 });
  const result = await gateway.stopRunningSupervisor({
    operation: 'setup',
    resolveOwner: incumbentOwner,
    report: () => {},
    awaitProcessExit: stuck.awaitProcessExit,
    awaitShimExit: stuck.awaitShimExit,
    hardKill: stuck.hardKill,
  });

  assert.equal(result.ok, true, 'a supervisor this run deliberately replaced is killed, not reported as unstoppable');
  assert.equal(result.escalated, true);
  assert.deepEqual(stuck.kills.map((kill) => kill.pid), [INCUMBENT_PID], 'exactly the incumbent supervisor is escalated');
  assert.equal(stuck.budgets[0], 30000, 'the graceful wait came first, at the interactive budget');
  assert.equal(stuck.budgets[1], 3000, 'the post-SIGKILL wait covers a kernel reap, not another drain');
  assert.equal(stuck.budgets[1], gateway.SUPERVISOR_STOP_ESCALATION_WAIT_MS);
  const escalation = lifecycle.find((entry) => entry.event === 'setup-supervisor-stop-escalated');
  assert.equal(escalation?.detail.signal, 'SIGKILL', 'the escalation is recorded for whoever reads the lifecycle log');
  assert.equal(escalation?.detail.child.pid, INCUMBENT_PID);
  assert.equal(escalation?.detail.pending, 'running');
});

test('a supervisor that never exits still refuses, saying the stop is in flight rather than naming a command to run by hand', async () => {
  const { gateway } = isolatedSupervision();
  const stuck = teardown({ teardownMs: Number.MAX_SAFE_INTEGER });
  const result = await gateway.stopRunningSupervisor({
    operation: 'setup',
    resolveOwner: incumbentOwner,
    report: () => {},
    awaitProcessExit: stuck.awaitProcessExit,
    awaitShimExit: stuck.awaitShimExit,
    hardKill: stuck.hardKill,
  });

  assert.equal(result.ok, false, 'a genuinely stuck supervisor is still a refusal');
  assert.equal(result.pending, 'running');
  assert.equal(result.escalated, true, 'the refusal only comes after the escalation was attempted');
  assert.deepEqual(stuck.kills.map((kill) => kill.pid), [INCUMBENT_PID]);
  assert.match(result.reason, /still in flight rather than failed/);
  assert.match(result.reason, /SIGTERM and then SIGKILL/);
  assert.match(result.reason, /run ensure again/);
  assert.doesNotMatch(result.reason, /model-gateway\.js" stop/, 'never tell the user to run the stop the updater just ran');
});

test('a quiet stop keeps the hook-sized budget and leaves the drain to the recovery controller', async () => {
  const { gateway, lifecycle } = isolatedSupervision();
  const draining = teardown({ teardownMs: Number.MAX_SAFE_INTEGER });
  const result = await gateway.stopRunningSupervisor({
    quiet: true,
    operation: 'ensure',
    resolveOwner: incumbentOwner,
    awaitProcessExit: draining.awaitProcessExit,
    awaitShimExit: draining.awaitShimExit,
    hardKill: draining.hardKill,
  });

  // SQ-235: Claude Code kills the SessionStart hook at 30s and HOOK_RECOVERY_RESERVE_MS
  // budgets 3s for this wait, so a quiet stop hands an unconfirmed outcome to the
  // detached controller instead of spending the hook's budget or SIGKILLing a drain
  // that controller is deliberately waiting out.
  assert.equal(draining.budgets[0], 3000, 'the quiet stop still fits inside the hook budget');
  assert.equal(draining.budgets[0], gateway.supervisorStopWaitMs(true));
  assert.deepEqual(draining.kills, [], 'a handed-off stop never SIGKILLs the drain the controller is waiting on');
  assert.equal(lifecycle.filter((entry) => entry.event === 'ensure-supervisor-stop-escalated').length, 0);
  assert.equal(result.ok, false);
  assert.match(result.reason, /still in flight rather than failed/);
});

test('the port-release check gets a grace window, not a second full budget, once the exit is confirmed', async () => {
  const { gateway } = isolatedSupervision();
  const budgets = [];
  const result = await gateway.stopRunningSupervisor({
    operation: 'restart',
    resolveOwner: incumbentOwner,
    report: () => {},
    stopWaitMs: 50,
    // The exit is confirmed, but only after the shared budget is spent; the listener
    // closes with the process, so the port check still needs a moment to see it.
    awaitProcessExit: async (_pid, timeout) => {
      budgets.push(timeout);
      await new Promise((resolve) => setTimeout(resolve, 80));
      return true;
    },
    awaitShimExit: async (timeout) => {
      budgets.push(timeout);
      return true;
    },
    hardKill: () => assert.fail('a confirmed stop is never escalated'),
  });

  assert.equal(result.ok, true);
  assert.equal(budgets[0], 50);
  assert.equal(budgets[1], 500, 'an overspent budget still leaves the port check its grace window');
});

test('killPid escalates to SIGKILL only when asked, and still refuses a process this install does not own', async () => {
  const installRoot = supervision.gatewayInstallRoot();
  const command = `node ${path.join(installRoot, 'bin', 'model-gateway.js')} serve-shim`;
  const owned = isolatedSupervision({ processes: `  ${INCUMBENT_PID}     1 Wed Oct  1 10:00:00 2026 ${command}\n` });
  assert.equal(owned.gateway.killPid(INCUMBENT_PID), true);
  assert.equal(owned.gateway.killPid(INCUMBENT_PID, { signal: 'SIGKILL' }), true);
  assert.deepEqual(owned.signals, [
    { pid: INCUMBENT_PID, signal: 'SIGTERM' },
    { pid: INCUMBENT_PID, signal: 'SIGKILL' },
  ], 'the default stays SIGTERM; SIGKILL is sent only for an escalation');

  const foreign = isolatedSupervision({ processes: `  ${INCUMBENT_PID}     1 Wed Oct  1 10:00:00 2026 node /foreign/model-gateway/bin/model-gateway.js serve-shim\n` });
  assert.equal(foreign.gateway.killPid(INCUMBENT_PID, { signal: 'SIGKILL' }), false);
  assert.deepEqual(foreign.signals, [], 'escalation never widens what this install is allowed to signal');
});
