'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const gateway = require(path.join(__dirname, '..', 'bin', 'model-gateway.js'));

test('quiet ensure stops waiting inside its hook budget when the proxy never answers', async () => {
  let now = 0;
  const timeout = gateway.startupWaitMsFor(true);
  const result = await gateway.waitForStartupReadiness({
    timeout,
    proxyAnswers: async () => false,
    shimReady: async () => false,
    shimFailureExists: () => false,
    now: () => now,
    pause: async (milliseconds) => { now += milliseconds; },
  });

  assert.equal(timeout, 12000);
  // SQ-63 added probeReason so a startup timeout can say WHY /v1/models never
  // answered. A probe injected as a bare boolean has no reason to report, so it
  // stays null here — the exact shape is still asserted, not loosened.
  assert.deepEqual(result, { ok: false, timedOut: true, probeReason: null });
  assert.equal(now, timeout);
});

// SQ-235 (2026-09-29 21:03Z): ten SessionStart hooks started together, the ensure
// that won recovery had already spent ~18s waiting on the ensure lock, then began
// a 12s startup wait -- and Claude Code killed the hook at its 30s timeout with
// recovery half done. Every wait a quiet ensure makes is now cut to what is left.
test('quiet ensure bounds its lock and startup waits by what is left of the SessionStart hook timeout', () => {
  const hooks = JSON.parse(require('node:fs').readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
  const ensureHook = hooks.hooks.SessionStart.flatMap((entry) => entry.hooks).find((hook) => /ensure --quiet/.test(hook.command));
  assert.ok(gateway.HOOK_BUDGET_MS < ensureHook.timeout * 1000, 'the budget ends before Claude Code kills the hook');

  assert.equal(gateway.quietStartupWaitMsWithinHookBudget({ elapsedMs: 0 }), 12000, 'a fresh hook keeps the full quiet wait');
  assert.equal(gateway.quietStartupWaitMsWithinHookBudget({ elapsedMs: 20000 }), gateway.HOOK_BUDGET_MS - 20000);
  assert.equal(gateway.quietStartupWaitMsWithinHookBudget({ elapsedMs: 29000 }), 1000, 'an exhausted budget still takes one readiness look');

  // The 21:03Z holder: lock acquired ~18s in, recovery then needs probes, a stop and a wait.
  const lockWait = gateway.hookBudgetRemainingMs({ elapsedMs: 0 });
  const worstCaseAfterLock = 3 * 2000 + 3000 + gateway.quietStartupWaitMsWithinHookBudget({ elapsedMs: lockWait + 9000 });
  assert.ok(lockWait + worstCaseAfterLock < ensureHook.timeout * 1000, `lock ${lockWait}ms + recovery ${worstCaseAfterLock}ms must finish inside the hook timeout`);
});

test('a current wired shim lets login leave its listener alone', () => {
  const currentHealth = { proxyRecovery: true, supervisorVersion: gateway.PLUGIN_VERSION };

  assert.match(gateway.loginSuccessMessage({ wired: true, health: currentHealth }), /next request/);
  assert.doesNotMatch(gateway.loginSuccessMessage({ wired: true, health: currentHealth }), /setup/);
  assert.match(gateway.loginSuccessMessage({ wired: false, health: currentHealth }), /setup/);
});
