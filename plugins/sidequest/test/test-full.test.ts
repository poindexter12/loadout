import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const runnerModuleUrl = pathToFileURL(path.join(__dirname, '..', 'scripts', 'test-full.mjs')).href;

// SQ-62's measurement of this suite's functional phase, kept here because the budget model is
// calibrated to it and a future change to either number should have to argue with the other.
const measuredContendedPhaseDurationMilliseconds = 1742623;
const measuredContendedLoadAverage = 29.17;
const measuredContendedCores = 10;

type CapacityKey =
  | 'idleEightCore'
  | 'idleFourCore'
  | 'idleTwoCore'
  | 'idleTenCore'
  | 'idleSixteenCore'
  | 'tenCoreLoadTwo'
  | 'tenCoreLoadFive'
  | 'tenCoreLoadTwentySeven'
  | 'tenCoreAtMeasuredLoad'
  | 'windowsReportsNoLoad';

type BudgetHelpers = {
  concurrency: number[];
  defaultArityBudgets: number[];
  budgets: Record<CapacityKey, number>;
  expectations: Record<CapacityKey, number>;
  effectiveWorkers: Record<
    | 'idleTenCore'
    | 'idleFourCore'
    | 'tenCoreLoadFive'
    | 'tenCoreLoadTwentySeven'
    | 'absurdLoad'
    | 'negativeLoadIsIgnored'
    | 'nonFiniteLoadIsIgnored',
    number
  >;
  overrides: Record<
    'absent' | 'blank' | 'widens' | 'widensPastTheCap' | 'cannotShorten' | 'cannotZero' | 'cannotDisable',
    { timeoutMilliseconds: number; notice: string | null }
  >;
  timeoutError: string;
  contendedTimeoutError: string;
  warning: string;
  phaseFailures: Record<string, string | null>;
  gatewayCatalog: {
    schemaVersion: number;
    updatedAt: string;
    providers: { codex: { ready: boolean; state: string; message: string } };
    models: Array<{ slug: string; id: string; provider: string }>;
  };
};

function loadBudgetHelpers(): BudgetHelpers {
  const script = `
    import {
      calculateEffectiveTestWorkers,
      calculateExpectedTestPhaseDurationMilliseconds,
      calculateTestConcurrency,
      calculateTestPhaseTimeoutMilliseconds,
      describePhaseFailure,
      describeTestPhaseCapacity,
      formatTestPhaseTimeoutError,
      formatTestPhaseWarning,
      fullSuiteGatewayCatalog,
    } from ${JSON.stringify(runnerModuleUrl)};
    const fourCoreIdle = describeTestPhaseCapacity(4, 0, undefined);
    const tenCoreContended = describeTestPhaseCapacity(10, 27.42, undefined);
    const describe = (result) => describePhaseFailure('functional', result, fourCoreIdle, 0);
    const round = (value) => Number(value.toFixed(4));
    const override = (raw) => {
      const capacity = describeTestPhaseCapacity(8, 0, raw);
      return { timeoutMilliseconds: capacity.timeoutMilliseconds, notice: capacity.overrideNotice };
    };
    const cases = {
      idleEightCore: [8, 8, 0],
      idleFourCore: [4, 4, 0],
      idleTwoCore: [2, 2, 0],
      idleTenCore: [8, 10, 0],
      idleSixteenCore: [8, 16, 0],
      tenCoreLoadTwo: [8, 10, 2],
      tenCoreLoadFive: [8, 10, 5],
      tenCoreLoadTwentySeven: [8, 10, 27.42],
      tenCoreAtMeasuredLoad: [8, ${measuredContendedCores}, ${measuredContendedLoadAverage}],
      windowsReportsNoLoad: [8, 10, 0],
    };
    const budgets = {};
    const expectations = {};
    for (const [name, argv] of Object.entries(cases)) {
      budgets[name] = calculateTestPhaseTimeoutMilliseconds(...argv);
      expectations[name] = calculateExpectedTestPhaseDurationMilliseconds(...argv);
    }
    console.log(JSON.stringify({
      concurrency: [calculateTestConcurrency(1), calculateTestConcurrency(4), calculateTestConcurrency(12)],
      defaultArityBudgets: [calculateTestPhaseTimeoutMilliseconds(8), calculateTestPhaseTimeoutMilliseconds(4), calculateTestPhaseTimeoutMilliseconds(2)],
      budgets,
      expectations,
      effectiveWorkers: {
        idleTenCore: round(calculateEffectiveTestWorkers(8, 10, 0)),
        idleFourCore: round(calculateEffectiveTestWorkers(4, 4, 0)),
        tenCoreLoadFive: round(calculateEffectiveTestWorkers(8, 10, 5)),
        tenCoreLoadTwentySeven: round(calculateEffectiveTestWorkers(8, 10, 27.42)),
        absurdLoad: round(calculateEffectiveTestWorkers(8, 10, 100000)),
        negativeLoadIsIgnored: round(calculateEffectiveTestWorkers(8, 10, -3)),
        nonFiniteLoadIsIgnored: round(calculateEffectiveTestWorkers(8, 10, Number.NaN)),
      },
      overrides: {
        absent: override(undefined),
        blank: override('   '),
        widens: override('900000'),
        widensPastTheCap: override('5000000'),
        cannotShorten: override('1000'),
        cannotZero: override('0'),
        cannotDisable: override('off'),
      },
      timeoutError: formatTestPhaseTimeoutError('functional', fourCoreIdle),
      contendedTimeoutError: formatTestPhaseTimeoutError('functional', tenCoreContended),
      warning: formatTestPhaseWarning('functional', fourCoreIdle, 1000000),
      gatewayCatalog: fullSuiteGatewayCatalog(),
      phaseFailures: {
        timedOutWithStatusZero: describe({ timedOut: true, status: 0, signal: null, cleanupError: null }),
        timedOutAfterKill: describe({ timedOut: true, status: null, signal: 'SIGKILL', cleanupError: null }),
        cleanupFailed: describe({ timedOut: false, status: 0, signal: null, cleanupError: 'The owned process group 42 was still alive.' }),
        cleanupSignalFailed: describe({ timedOut: false, status: 0, signal: null, cleanupError: 'The phase owner could not send SIGTERM to its owned process group: EPERM.' }),
        rootExitedNonZero: describe({ timedOut: false, status: 3, signal: null, cleanupError: null }),
        rootDiedOnSignal: describe({ timedOut: false, status: null, signal: 'SIGSEGV', cleanupError: null }),
        passed: describe({ timedOut: false, status: 0, signal: null, cleanupError: null }),
      },
    }));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' })) as BudgetHelpers;
}

test('full-suite concurrency clamps to the runner range', () => {
  const helpers = loadBudgetHelpers();

  assert.deepEqual(helpers.concurrency, [2, 4, 8]);
  // Reading the budget helpers with the old single-argument arity still answers for an
  // otherwise idle machine, which is the only machine the core-count model ever described.
  assert.deepEqual(helpers.defaultArityBudgets, [720000, 1440000, 2400000]);
});

test('the 480000ms constant is an expected duration, and the deadline sits above it', () => {
  const { budgets, expectations } = loadBudgetHelpers();

  // SQ-62: duration times effective workers is a work constant — 1742s * 2.15 = 3749
  // s*workers measured locally, 302.9s * 4 = 1212 s*workers on CI. 480_000 * 8 is 3840
  // s*workers, i.e. 1.02x the local measurement. The old code used that as the deadline, so
  // off CI the gate had no margin whatsoever and three runs in a row died on it. The
  // expectation keeps the measured constant; the deadline is 1.5x it.
  assert.equal(expectations.idleEightCore, 480000);
  assert.equal(expectations.idleFourCore, 960000);
  assert.equal(budgets.idleEightCore, 720000);
  assert.equal(budgets.idleFourCore, 1440000);
  assert.ok(
    budgets.idleEightCore > expectations.idleEightCore,
    'a deadline equal to the expected duration is a coin toss, not a budget',
  );

  // An idle machine with more cores than the concurrency ceiling is still an 8-worker
  // machine, so it is held to the 8-worker expectation rather than handed wall clock for free.
  assert.equal(expectations.idleTenCore, 480000);
  assert.equal(expectations.idleSixteenCore, 480000);
  // Windows reports os.loadavg() as [0, 0, 0] and lands on exactly this branch.
  assert.equal(expectations.windowsReportsNoLoad, 480000);
  // Load a 10-core box absorbs without losing a worker changes nothing either.
  assert.equal(expectations.tenCoreLoadTwo, 480000);
});

test('a contended machine gets MORE wall clock, not the tightest budget in the curve', () => {
  const { budgets, expectations, effectiveWorkers } = loadBudgetHelpers();

  // The defect. `480_000 * (8 / concurrency)` shrank the allowance as cores grew, so a
  // 10-core box picked concurrency 8 and therefore the least wall clock in the whole curve,
  // however little of those cores was free — and it is the one branch no 4-core CI runner
  // can reach, so nothing had ever validated it. At load 27.42 those 8 workers hold about
  // 2.26 workers of real capacity.
  assert.equal(effectiveWorkers.tenCoreLoadTwentySeven, 2.2586);
  assert.equal(expectations.tenCoreLoadTwentySeven, 1700160);
  assert.equal(budgets.tenCoreLoadTwentySeven, 2400000);
  assert.ok(
    budgets.tenCoreLoadTwentySeven > budgets.idleTenCore,
    'a contended 10-core box must not be held to the budget an idle one gets',
  );

  // The widening is proportional to lost capacity rather than a step: load 5 on 10 cores
  // leaves 6.15 effective workers, which is 1.3x the expectation and 1.3x the deadline.
  assert.equal(effectiveWorkers.tenCoreLoadFive, 6.1538);
  assert.equal(expectations.tenCoreLoadFive, 624000);
  assert.equal(budgets.tenCoreLoadFive, 936000);

  // Idle machines still resolve to their worker count, which is what keeps this a
  // generalization of the old model rather than a blanket inflation of it.
  assert.equal(effectiveWorkers.idleTenCore, 8);
  assert.equal(effectiveWorkers.idleFourCore, 4);

  // A garbage or absurd load reading can neither divide by zero nor unbound the scale.
  assert.equal(effectiveWorkers.absurdLoad, 0.5);
  assert.equal(effectiveWorkers.negativeLoadIsIgnored, 8);
  assert.equal(effectiveWorkers.nonFiniteLoadIsIgnored, 8);
});

test('the measured 29-minute phase fits inside the budget its own machine would now get', () => {
  const { budgets, expectations } = loadBudgetHelpers();

  // The run SQ-62 measured: 1742623ms of functional phase at concurrency 8 on 10 cores with
  // a 1-minute load average of 29.17, 1618 tests, 0 cancelled. Under the old formula it got
  // 480000ms, which is where the ticket's three reproductions died. Two claims are asserted
  // here: the capacity model PREDICTS that duration (within 5%, and it measured 2.4%), and
  // the deadline derived from it CLEARS that duration by a real margin rather than a hair.
  const expected = expectations.tenCoreAtMeasuredLoad;
  const budget = budgets.tenCoreAtMeasuredLoad;

  assert.equal(expected, 1784160);
  assert.ok(
    Math.abs(expected - measuredContendedPhaseDurationMilliseconds) / measuredContendedPhaseDurationMilliseconds < 0.05,
    `the capacity model predicted ${expected}ms against a measured ${measuredContendedPhaseDurationMilliseconds}ms`,
  );
  assert.equal(budget, 2400000);
  assert.ok(
    budget > measuredContendedPhaseDurationMilliseconds * 1.25,
    `a ${budget}ms deadline must clear the measured ${measuredContendedPhaseDurationMilliseconds}ms by more than a rounding error`,
  );
});

test('the phase budget override only ever widens, and says so out loud', () => {
  const { overrides } = loadBudgetHelpers();

  assert.deepEqual(overrides.absent, { timeoutMilliseconds: 720000, notice: null });
  assert.deepEqual(overrides.blank, { timeoutMilliseconds: 720000, notice: null });
  assert.deepEqual(overrides.widens, {
    timeoutMilliseconds: 900000,
    notice: 'NOTICE: SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS raised the phase budget from a measured 720000ms to 900000ms. Every test still has to pass inside it: this grants wall clock, it does not skip the gate.',
  });
  // The model's own ceiling cannot be the last word, or a machine busier than the model
  // allows for still has no supported way to run the gate at all. That was the state SQ-62
  // found: no override existed, so the only options were an unpassable gate or a skipped one.
  assert.equal(overrides.widensPastTheCap.timeoutMilliseconds, 5000000);

  // An override that could shorten the deadline, zero it, or switch it off would be a way to
  // pass the gate without running it. Each is refused and the measured budget stands.
  assert.deepEqual(overrides.cannotShorten, {
    timeoutMilliseconds: 720000,
    notice: 'NOTICE: SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS=1000 cannot shorten the measured 720000ms phase budget, so the measured budget stands. The override only ever grants more wall clock.',
  });
  assert.deepEqual(overrides.cannotZero, {
    timeoutMilliseconds: 720000,
    notice: 'NOTICE: SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS=0 is not a positive whole number of milliseconds, so the measured 720000ms phase budget stands.',
  });
  assert.deepEqual(overrides.cannotDisable, {
    timeoutMilliseconds: 720000,
    notice: 'NOTICE: SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS=off is not a positive whole number of milliseconds, so the measured 720000ms phase budget stands.',
  });
});

test('full-suite catalog supplies the ready Codex capability and every default Codex route', () => {
  const { gatewayCatalog } = loadBudgetHelpers();

  assert.equal(Number.isFinite(Date.parse(gatewayCatalog.updatedAt)), true);
  assert.deepEqual(gatewayCatalog.providers.codex, {
    ready: true,
    state: 'ready',
    message: 'The full-suite fixture provides the Codex dispatch capability.',
  });
  assert.deepEqual(
    gatewayCatalog.models.map((model) => [model.slug, model.id, model.provider]),
    [
      ['codex-gpt-5-6-luna', 'claude-codex-gpt-5-6-luna', 'codex'],
      ['codex-gpt-5-6-sol', 'claude-codex-gpt-5-6-sol', 'codex'],
      ['codex-gpt-5-6-terra', 'claude-codex-gpt-5-6-terra', 'codex'],
    ],
  );
});

test('a timed-out phase fails the full gate whatever status its root reported', () => {
  const { phaseFailures, timeoutError } = loadBudgetHelpers();

  // SQ-2050 shipped `timedOut && status !== 0`, so a root whose SIGTERM handler exited 0
  // passed the gate after the deadline had already killed it mid-suite.
  assert.equal(phaseFailures.timedOutWithStatusZero, timeoutError);
  assert.equal(phaseFailures.timedOutAfterKill, timeoutError);
  assert.equal(phaseFailures.cleanupFailed, 'Sidequest functional tests could not be cleaned up: The owned process group 42 was still alive.');
  assert.equal(phaseFailures.cleanupSignalFailed, 'Sidequest functional tests could not be cleaned up: The phase owner could not send SIGTERM to its owned process group: EPERM.');
  assert.equal(phaseFailures.rootExitedNonZero, 'Sidequest functional tests exited 3.');
  assert.equal(phaseFailures.rootDiedOnSignal, 'Sidequest functional tests exited on signal SIGSEGV.');
  assert.equal(phaseFailures.passed, null);
});

test('full-suite budget keeps actionable timeout and warning copy', () => {
  const helpers = loadBudgetHelpers();

  assert.equal(
    helpers.timeoutError,
    'Sidequest functional tests exceeded their 1440000ms phase budget at concurrency 4 on 4 available cores, whose 1-minute load average of 0.00 left an effective 4.00 workers of capacity, after waiting behind 0 sibling full-suite captures. The runner was killed at the deadline, so every in-flight file reporting a still-pending promise resolution was cancelled, not failed. Set SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS above 1440000 to give this run more wall clock; it can only widen the budget, never shorten the deadline or skip a test.',
  );
  // The warning fires against the expected duration, not a fraction of the budget, so a
  // duration regression still surfaces on a machine whose budget the ceiling has truncated.
  assert.equal(
    helpers.warning,
    'WARNING: Sidequest functional tests completed in 1000000ms, over the 960000ms expected of their capacity though inside their 1440000ms budget, at concurrency 4 on 4 available cores, whose 1-minute load average of 0.00 left an effective 4.00 workers of capacity.',
  );
});

test('a contended timeout reports the load and the capacity it left, not just the core count', () => {
  const { contendedTimeoutError } = loadBudgetHelpers();

  // The old copy said "at concurrency 8 on 10 available cores" and stopped there, which
  // reads as a well-provisioned machine failing a generous budget. It was the opposite, and
  // readers on this board repeatedly drew the wrong conclusion from it — including reading
  // the deadline's cancellations as failing tests.
  assert.equal(
    contendedTimeoutError,
    'Sidequest functional tests exceeded their 2400000ms phase budget at concurrency 8 on 10 available cores, whose 1-minute load average of 27.42 left an effective 2.26 workers of capacity, after waiting behind 0 sibling full-suite captures. The runner was killed at the deadline, so every in-flight file reporting a still-pending promise resolution was cancelled, not failed. Set SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS above 2400000 to give this run more wall clock; it can only widen the budget, never shorten the deadline or skip a test.',
  );
});
