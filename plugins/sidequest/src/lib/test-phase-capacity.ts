/**
 * The one capacity model behind the full suite's phase deadline and the capture wrapper's outer
 * deadline.
 *
 * SQ-68: these constants and the effective-worker formula existed twice, once in
 * `scripts/test-full.mjs` and once in `src/lib/verify-capture.ts`, under a comment asking the two
 * to stay "in lockstep". Copied constants are the one implementation that cannot hold that
 * invariant, and they had already drifted: the suite accepted `SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS=1e6`
 * and widened its phase while the wrapper's own `/^\d+$/` parser rejected the same string and kept
 * the narrower deadline, so the gate could be tighter than the thing it gates. Both consumers now
 * read this module and nothing else, including the override parser.
 *
 * Two distinct numbers come out of one model, and they are legitimately different:
 *   - the suite's internal phase budget — `calculateTestPhaseTimeoutMilliseconds`
 *   - the capture wrapper's outer deadline — `calculateCaptureDeadlineMilliseconds`, that same
 *     phase budget plus the ordinary setup allowance, so the wrapper always outlives the phase.
 */

const minimumTestConcurrency = 2;
export const maximumTestConcurrency = 8;
/**
 * The EXPECTED duration of eight effective workers, never a deadline.
 *
 * SQ-62 established the shape of this constant: phase duration times the workers the phase really
 * had is a work constant, so one number predicts the suite on any machine once its real capacity is
 * known. SQ-68 recalibrated the magnitude, because the suite the 480000ms figure was measured
 * against no longer exists. SQ-137 split hooks, mcp, submission and integration-advance into topic
 * shards and the suite grew to ~2019 tests, and the measurements on this 10-core host in 2026-11
 * are 1061608ms (SQ-255) and 1131971ms (SQ-65) of functional phase. At the 6.70 effective workers a
 * 1-minute load average of 3.94 leaves, the slower of those implies a work constant of
 * 1131971 * 6.70 / 8 = 948037ms at eight workers; this is that figure rounded up to a whole two
 * minutes per worker.
 *
 * Keeping 480000 is what failed assembled-wave gate wave-689a126004dfdf1a: at a LOW load of 3.94 it
 * computed an 859641ms phase budget and killed a suite with zero test failures that needed over
 * 1061608ms, and every passing full-suite run on this host since has had to pass
 * SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS by hand. A budget that a healthy suite cannot fit inside is
 * not a gate, it is a coin toss.
 */
export const baselineTestPhaseDurationMilliseconds = 960_000;
// A deadline has to exceed an expectation or it is a coin toss. The expectation predicted the
// measured low-load runs to within 2%, which is a good model and a terrible budget.
export const testPhaseBudgetSafetyFactor = 1.5;
/**
 * The ceiling exists to end a phase that is stuck rather than slow, and most tests here carry no
 * per-test timeout, so it is the only backstop.
 *
 * SQ-68 moved it from 2400000ms to 3600000ms. The slowest functional phase measured on this host is
 * 1907973ms, at a 1-minute load average of 55.72 on 10 cores, which the old ceiling cleared by only
 * 1.26x — inside the noise of the load band this shared machine runs at, so the ceiling itself was
 * truncating real runs and the override was doing the ceiling's job. 3600000ms clears that
 * measurement by 1.89x and still ends a wedged phase inside an hour. With the ordinary setup
 * allowance on top, the capture wrapper's own default deadline reaches 4200000ms, well under its
 * 7200000ms hard maximum. Anything beyond this is the override's job, loudly and on purpose.
 */
export const maximumTestPhaseTimeoutMilliseconds = 3_600_000;
// A machine cannot give a phase less than a sliver of a core for as long as it is running, and an
// unbounded scale would let one absurd load reading swallow the cap calculation.
export const minimumEffectiveTestWorkers = 0.5;
export const phaseBudgetOverrideVariable = 'SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS';

export type PhaseBudgetOverride = Readonly<{
  timeoutMilliseconds: number;
  requestedMilliseconds: number | null;
  widened: boolean;
  /**
   * One sentence, with no prefix. The suite prints it as `NOTICE: <notice>`; the capture wrapper
   * prints it as the budget's own notice. Keeping the prefix out of the model is what lets both
   * surfaces keep their established wording from one parser.
   */
  notice: string | null;
}>;

export function calculateTestConcurrency(availableParallelism: number): number {
  return Math.min(maximumTestConcurrency, Math.max(minimumTestConcurrency, availableParallelism));
}

/**
 * How much of the machine this phase's workers are actually going to get.
 *
 * `os.availableParallelism()` answers how many cores EXIST, never how many are free, so a budget
 * derived from it alone is only honest on an otherwise idle machine. Under fair scheduling, N phase
 * workers competing with L other runnable threads receive cores * N / (N + L) of the machine, and
 * that share — not the core count — is what a wall-clock budget has to be derived from. An idle
 * machine reports L = 0, where the share collapses back to the worker count, so this reduces exactly
 * to the core-count model it replaces everywhere that model was ever valid: an idle 8-core box, an
 * idle 4-core CI runner, and Windows, whose os.loadavg() is always [0, 0, 0].
 *
 * Known limit, recorded rather than silently tolerated: on the macOS host this board runs on, the
 * load average is mostly I/O wait from managed security agents rather than CPU contention, so L is
 * inflated by work no scheduler is taking cores for. That only ever widens a budget, which is the
 * safe direction, and it is why the measurements the baseline is calibrated from are taken at a low
 * load average rather than averaged across the band.
 */
export function calculateEffectiveTestWorkers(
  testConcurrency: number,
  availableParallelism: number,
  loadAverage: number,
): number {
  const otherRunnableThreads = Number.isFinite(loadAverage) && loadAverage > 0 ? loadAverage : 0;
  const contendedCoreShare = (availableParallelism * testConcurrency) / (testConcurrency + otherRunnableThreads);
  return Math.min(testConcurrency, Math.max(minimumEffectiveTestWorkers, contendedCoreShare));
}

/**
 * The budget scales with the capacity the phase will really have, never with the core count the
 * machine happens to own.
 *
 * SQ-62: the previous form scaled by `maximumTestConcurrency / testConcurrency`, so wall clock
 * SHRANK as cores grew — every machine with 8 or more nominal cores landed on the tightest budget in
 * the curve, which is also the only branch no CI runner can reach (a 4-core ubuntu-latest picks
 * concurrency 4). A 10-core developer box at load 27 therefore got the baseline to do work that its
 * ~2.3 effective workers cannot finish, and got it BECAUSE it had more hardware. Keying the baseline
 * off effective workers widens only where the machine is measurably contended.
 */
export function calculateExpectedTestPhaseDurationMilliseconds(
  testConcurrency: number,
  availableParallelism: number = testConcurrency,
  loadAverage = 0,
): number {
  const effectiveTestWorkers = calculateEffectiveTestWorkers(testConcurrency, availableParallelism, loadAverage);
  const capacityScale = maximumTestConcurrency / effectiveTestWorkers;
  // Rounded, not ceilinged: a fractional capacity scale makes the product land a float's hair either
  // side of a whole millisecond, and ceiling that turns 624000 into 624001 for no reason anybody
  // could read. Every whole-worker case is unaffected.
  return Math.round(baselineTestPhaseDurationMilliseconds * capacityScale);
}

/** The suite's internal phase deadline: the expectation plus its safety margin, under the ceiling. */
export function calculateTestPhaseTimeoutMilliseconds(
  testConcurrency: number,
  availableParallelism: number = testConcurrency,
  loadAverage = 0,
): number {
  const expectedDurationMilliseconds = calculateExpectedTestPhaseDurationMilliseconds(
    testConcurrency,
    availableParallelism,
    loadAverage,
  );
  return Math.min(
    maximumTestPhaseTimeoutMilliseconds,
    Math.round(expectedDurationMilliseconds * testPhaseBudgetSafetyFactor),
  );
}

/**
 * The capture wrapper's outer deadline: the suite's own phase budget plus the ordinary setup
 * allowance that runs before it (install, typecheck, build).
 *
 * This is the invariant SQ-68 exists to make structural. The wrapper is the gate and the phase is
 * what it gates, so for any positive setup allowance the wrapper's deadline strictly exceeds the
 * phase budget — the gate can never be the tighter of the two. Derive it from this function rather
 * than re-adding the parts, so a change to the phase budget moves the wrapper with it.
 */
export function calculateCaptureDeadlineMilliseconds(
  phaseBudgetMilliseconds: number,
  setupAllowanceMilliseconds: number,
): number {
  return phaseBudgetMilliseconds + setupAllowanceMilliseconds;
}

/**
 * The override is widen-only on purpose, and parsed here once for both consumers.
 *
 * A developer on a machine busier than the model's cap still needs a supported way to run the gate,
 * but a knob that could shorten the deadline or take it away would be a way to pass the gate without
 * running it. Raising the budget cannot hide a failing test; it only ever buys wall clock, and it
 * says so loudly.
 *
 * SQ-68: the wrapper used to parse this value with `/^\d+$/` while the suite used
 * `Number.isInteger(Number(text))`, so `1e6`, `+2500000` and `2500000.0` widened the phase the suite
 * enforces and left the wrapper's deadline at its measured value. The permissive form is kept,
 * because the spellings it accepts are unambiguous whole millisecond counts and the direction is
 * widen-only either way.
 */
export function resolvePhaseBudgetOverride(
  measuredTimeoutMilliseconds: number,
  rawOverride: string | undefined | null,
): PhaseBudgetOverride {
  const requestedText = typeof rawOverride === 'string' ? rawOverride.trim() : '';
  if (requestedText === '') {
    return Object.freeze({
      timeoutMilliseconds: measuredTimeoutMilliseconds,
      requestedMilliseconds: null,
      widened: false,
      notice: null,
    });
  }
  const requested = Number(requestedText);
  if (!Number.isInteger(requested) || requested <= 0) {
    return Object.freeze({
      timeoutMilliseconds: measuredTimeoutMilliseconds,
      requestedMilliseconds: null,
      widened: false,
      notice: `${phaseBudgetOverrideVariable}=${requestedText} is not a positive whole number of milliseconds, so the measured ${measuredTimeoutMilliseconds}ms phase budget stands.`,
    });
  }
  if (requested <= measuredTimeoutMilliseconds) {
    return Object.freeze({
      timeoutMilliseconds: measuredTimeoutMilliseconds,
      requestedMilliseconds: requested,
      widened: false,
      notice: `${phaseBudgetOverrideVariable}=${requested} cannot shorten the measured ${measuredTimeoutMilliseconds}ms phase budget, so the measured budget stands. The override only ever grants more wall clock.`,
    });
  }
  return Object.freeze({
    timeoutMilliseconds: requested,
    requestedMilliseconds: requested,
    widened: true,
    notice: `${phaseBudgetOverrideVariable} raised the phase budget from a measured ${measuredTimeoutMilliseconds}ms to ${requested}ms. Every test still has to pass inside it: this grants wall clock, it does not skip the gate.`,
  });
}
