import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { suiteEnvironment } from '../../../scripts/release/cut.mjs';

const require = createRequire(import.meta.url);
const { STARTER_GATEWAY_MODEL_SLUGS } = require('../lib/category-defaults.js');
const { runOwnedPhase } = require('./owned-process-tree.js');

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDirectory = path.join(pluginRoot, 'test');
const minimumTestConcurrency = 2;
const maximumTestConcurrency = 8;
// SQ-62 measured what this constant is. Multiplying a phase's duration by the workers it
// really had gives a work constant: 1742s * 2.15 = 3749 s*workers on a contended 10-core
// macOS box, 302.9s * 4 = 1212 s*workers on a 4-core ubuntu-latest runner. 480_000 * 8 is
// 3840 s*workers, which sits 1.02x above the macOS measurement and 3.17x above CI's. It was
// never a budget on this platform; it is the EXPECTED duration of eight effective workers,
// and using an expectation as a deadline is why the gate had no margin at all off CI.
const baselineTestPhaseDurationMilliseconds = 480_000;
// A deadline has to exceed an expectation or it is a coin toss. The expectation predicted
// the measured 29-minute run to within 2.4%, which is a good model and a terrible budget.
const testPhaseBudgetSafetyFactor = 1.5;
// The ceiling exists to end a phase that is stuck rather than slow, and most tests here
// carry no per-test timeout, so it is the only backstop. 2_400_000 keeps the model intact
// across the 22-38 load band this shared machine actually runs at (it begins truncating
// above load ~27 on 10 cores) while still ending a wedged phase inside 40 minutes. Anything
// beyond it is the override's job, loudly and on purpose.
const maximumTestPhaseTimeoutMilliseconds = 2_400_000;
// A machine cannot give a phase less than a sliver of a core for as long as it is running,
// and an unbounded scale would let one absurd load reading swallow the cap calculation.
const minimumEffectiveTestWorkers = 0.5;
export const phaseBudgetOverrideVariable = 'SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS';

// SQ-208: the tests inside one file run in sequence, so each of these files is a serial chain
// no amount of concurrency shortens. v4.0.0's passing run measured them at 750, 713, 635, 595,
// 526 and 424 seconds of test time out of 5779 for the whole phase. `node --test` starts files
// in sorted order whatever order they are passed in, so four of the six started 150-510s into
// the phase and finished past an idle machine's 843s budget while most workers sat empty.
// Starting the longest chains first leaves the short files to fill in around them. Keep this
// list ordered longest first; a file missing from the directory is skipped, and the test suite
// fails if any name here stops matching a real file.
export const longRunningTestFiles = Object.freeze([
  'hooks.test.ts',
  'mcp.test.ts',
  'dispatch-lifecycle.test.ts',
  'integration-advance.test.ts',
  'submission.test.ts',
  'worktree-isolation.test.ts',
]);

// The phase root is this script run with this flag, because only the programmatic runner keeps
// the order it is given.
export const phaseRootFlag = '--sidequest-phase-root';

export function isFunctionalTestFile(name) {
  return name.endsWith('.test.ts') && !name.endsWith('.perf.test.ts');
}

export function scheduleTestFiles(fileNames) {
  const suite = fileNames.filter(isFunctionalTestFile);
  const present = new Set(suite);
  const first = longRunningTestFiles.filter((name) => present.has(name));
  const scheduledFirst = new Set(first);
  return [...first, ...suite.filter((name) => !scheduledFirst.has(name)).sort()];
}

export function fullSuiteGatewayCatalog() {
  return {
    schemaVersion: 4,
    updatedAt: new Date().toISOString(),
    source: 'sidequest-full-suite',
    providers: {
      codex: {
        ready: true,
        state: 'ready',
        message: 'The full-suite fixture provides the Codex dispatch capability.',
      },
    },
    models: STARTER_GATEWAY_MODEL_SLUGS.map((slug) => ({
      slug,
      id: `claude-${slug}`,
      label: slug,
      provider: 'codex',
    })),
  };
}

export function calculateTestConcurrency(availableParallelism) {
  return Math.min(maximumTestConcurrency, Math.max(minimumTestConcurrency, availableParallelism));
}

/**
 * How much of the machine this phase's workers are actually going to get.
 *
 * `os.availableParallelism()` answers how many cores EXIST, never how many are free, so a
 * budget derived from it alone is only honest on an otherwise idle machine. Under fair
 * scheduling, N phase workers competing with L other runnable threads receive
 * cores * N / (N + L) of the machine, and that share — not the core count — is what a
 * wall-clock budget has to be derived from. An idle machine reports L = 0, where the share
 * collapses back to the worker count, so this reduces exactly to the core-count model it
 * replaces everywhere that model was ever valid: an idle 8-core box, an idle 4-core CI
 * runner, and Windows, whose os.loadavg() is always [0, 0, 0].
 */
export function calculateEffectiveTestWorkers(testConcurrency, availableParallelism, loadAverage) {
  const otherRunnableThreads = Number.isFinite(loadAverage) && loadAverage > 0 ? loadAverage : 0;
  const contendedCoreShare = (availableParallelism * testConcurrency) / (testConcurrency + otherRunnableThreads);
  return Math.min(testConcurrency, Math.max(minimumEffectiveTestWorkers, contendedCoreShare));
}

/**
 * The budget scales with the capacity the phase will really have, never with the core count
 * the machine happens to own.
 *
 * SQ-62: the previous form scaled by `maximumTestConcurrency / testConcurrency`, so wall
 * clock SHRANK as cores grew — every machine with 8 or more nominal cores landed on the
 * tightest budget in the curve, which is also the only branch no CI runner can reach (a
 * 4-core ubuntu-latest picks concurrency 4 and a 960000ms budget). A 10-core developer box
 * at load 27 therefore got 480000ms to do work that its ~2.3 effective workers cannot
 * finish, and got it BECAUSE it had more hardware. Keying the same 480000ms baseline off
 * effective workers leaves every validated configuration untouched and widens only where
 * the machine is measurably contended.
 */
export function calculateExpectedTestPhaseDurationMilliseconds(
  testConcurrency,
  availableParallelism = testConcurrency,
  loadAverage = 0,
) {
  const effectiveTestWorkers = calculateEffectiveTestWorkers(testConcurrency, availableParallelism, loadAverage);
  const capacityScale = maximumTestConcurrency / effectiveTestWorkers;
  // Rounded, not ceilinged: a fractional capacity scale makes the product land a float's
  // hair either side of a whole millisecond, and ceiling that turns 624000 into 624001 for
  // no reason anybody could read. Every whole-worker case is unaffected.
  return Math.round(baselineTestPhaseDurationMilliseconds * capacityScale);
}

export function calculateTestPhaseTimeoutMilliseconds(
  testConcurrency,
  availableParallelism = testConcurrency,
  loadAverage = 0,
) {
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
 * The override is widen-only on purpose. A developer on a machine busier than the model's
 * cap still needs a supported way to run the gate, but a knob that could shorten the
 * deadline or take it away would be a way to pass the gate without running it. Raising the
 * budget cannot hide a failing test; it only ever buys wall clock, and it says so loudly.
 */
export function resolvePhaseBudgetOverride(measuredTimeoutMilliseconds, rawOverride) {
  const requestedText = typeof rawOverride === 'string' ? rawOverride.trim() : '';
  if (requestedText === '') return { timeoutMilliseconds: measuredTimeoutMilliseconds, notice: null };
  const requested = Number(requestedText);
  if (!Number.isInteger(requested) || requested <= 0) {
    return {
      timeoutMilliseconds: measuredTimeoutMilliseconds,
      notice: `NOTICE: ${phaseBudgetOverrideVariable}=${requestedText} is not a positive whole number of milliseconds, so the measured ${measuredTimeoutMilliseconds}ms phase budget stands.`,
    };
  }
  if (requested <= measuredTimeoutMilliseconds) {
    return {
      timeoutMilliseconds: measuredTimeoutMilliseconds,
      notice: `NOTICE: ${phaseBudgetOverrideVariable}=${requested} cannot shorten the measured ${measuredTimeoutMilliseconds}ms phase budget, so the measured budget stands. The override only ever grants more wall clock.`,
    };
  }
  return {
    timeoutMilliseconds: requested,
    notice: `NOTICE: ${phaseBudgetOverrideVariable} raised the phase budget from a measured ${measuredTimeoutMilliseconds}ms to ${requested}ms. Every test still has to pass inside it: this grants wall clock, it does not skip the gate.`,
  };
}

export function describeTestPhaseCapacity(availableParallelism, loadAverage, rawOverride) {
  const testConcurrency = calculateTestConcurrency(availableParallelism);
  const effectiveTestWorkers = calculateEffectiveTestWorkers(testConcurrency, availableParallelism, loadAverage);
  const expectedDurationMilliseconds = calculateExpectedTestPhaseDurationMilliseconds(
    testConcurrency,
    availableParallelism,
    loadAverage,
  );
  const measuredTimeoutMilliseconds = calculateTestPhaseTimeoutMilliseconds(
    testConcurrency,
    availableParallelism,
    loadAverage,
  );
  const override = resolvePhaseBudgetOverride(measuredTimeoutMilliseconds, rawOverride);
  return {
    availableParallelism,
    loadAverage: Number.isFinite(loadAverage) && loadAverage > 0 ? loadAverage : 0,
    testConcurrency,
    effectiveTestWorkers,
    expectedDurationMilliseconds,
    measuredTimeoutMilliseconds,
    timeoutMilliseconds: override.timeoutMilliseconds,
    overrideNotice: override.notice,
  };
}

function describeCapacityConditions(capacity) {
  return `at concurrency ${capacity.testConcurrency} on ${capacity.availableParallelism} available cores, whose 1-minute load average of ${capacity.loadAverage.toFixed(2)} left an effective ${capacity.effectiveTestWorkers.toFixed(2)} workers of capacity`;
}

export function formatTestPhaseTimeoutError(phase, capacity, siblingFullSuiteCaptures = 0) {
  // Naming the cancellations matters: at the deadline the runner is killed, so every file
  // still in flight reports a pending promise resolution. Reading those marks as failures
  // has repeatedly sent people chasing tests that were never broken.
  return `Sidequest ${phase} tests exceeded their ${capacity.timeoutMilliseconds}ms phase budget ${describeCapacityConditions(capacity)}, after waiting behind ${siblingFullSuiteCaptures} sibling full-suite capture${siblingFullSuiteCaptures === 1 ? '' : 's'}. The runner was killed at the deadline, so every in-flight file reporting a still-pending promise resolution was cancelled, not failed. Set ${phaseBudgetOverrideVariable} above ${capacity.timeoutMilliseconds} to give this run more wall clock; it can only widen the budget, never shorten the deadline or skip a test.`;
}

// Anchored to the expected duration rather than a fraction of the budget. A fraction of the
// budget moves with the budget, so on a contended machine it would only ever fire just short
// of failing, and above the ceiling it would stop tracking capacity altogether. Expectation
// is what a duration regression shows up against on every machine, contended or not.
export function formatTestPhaseWarning(phase, capacity, phaseDurationMilliseconds) {
  return `WARNING: Sidequest ${phase} tests completed in ${Math.round(phaseDurationMilliseconds)}ms, over the ${capacity.expectedDurationMilliseconds}ms expected of their capacity though inside their ${capacity.timeoutMilliseconds}ms budget, ${describeCapacityConditions(capacity)}.`;
}

function siblingFullSuiteCaptureCount() {
  const siblingCount = Number(process.env.SIDEQUEST_FULL_SUITE_SIBLING_CAPTURE_COUNT || '0');
  return Number.isInteger(siblingCount) && siblingCount > 0 ? siblingCount : 0;
}

const availableParallelism = os.availableParallelism();
// Sampled as the phase begins, which is the moment the budget has to be honest about, and
// before this phase's own workers exist to inflate the reading.
const phaseCapacity = describeTestPhaseCapacity(
  availableParallelism,
  os.loadavg()[0],
  process.env[phaseBudgetOverrideVariable],
);
const testConcurrency = phaseCapacity.testConcurrency;
const testPhaseTimeoutMilliseconds = phaseCapacity.timeoutMilliseconds;
const testPhaseWarningMilliseconds = phaseCapacity.expectedDurationMilliseconds;
const siblingFullSuiteCaptures = siblingFullSuiteCaptureCount();
// Benchmarks live behind `npm run test:perf`. Without the exclusion in
// isFunctionalTestFile the listing sweeps them back into the default suite,
// which is the 23 seconds SQ-1387 exists to remove.
const testFiles = scheduleTestFiles(await fs.readdir(testDirectory))
  .map((name) => path.join(testDirectory, name));

// A deadline is a failed phase whatever the root managed to report on its way out.
// Accepting a timeout that happened to carry status 0 is how a killed gate phase passed
// as green in SQ-2050: a root can handle SIGTERM and exit 0, and a phase the clock ended
// never finished its tests.
export function describePhaseFailure(phase, result, capacity, siblingCaptures = 0) {
  if (result.timedOut) return formatTestPhaseTimeoutError(phase, capacity, siblingCaptures);
  if (result.cleanupError) return `Sidequest ${phase} tests could not be cleaned up: ${result.cleanupError}`;
  if (result.status !== 0) {
    return `Sidequest ${phase} tests exited ${result.status ?? `on signal ${result.signal ?? 'unknown'}`}.`;
  }
  return null;
}

// The phase root. The preloads it was started with are inherited by every test file process
// run() spawns, exactly as `node --import ... --test` passed them on. The spec reporter is
// what that command printed here too, over pipes and on a terminal alike.
async function runPhaseRoot(concurrencyText, files) {
  // The root of a phase is never itself a test file. An inherited child marker makes run()
  // report upward to a parent that is not listening and start none of the files.
  delete process.env.NODE_TEST_CONTEXT;
  const { run } = await import('node:test');
  const { spec } = await import('node:test/reporters');
  const stream = run({ files, concurrency: Number(concurrencyText) });
  stream.on('test:fail', () => {
    process.exitCode = 1;
  });
  stream.compose(spec).pipe(process.stdout);
}

async function runTests(phase, files, environment) {
  const phaseStartTime = performance.now();
  const result = await runOwnedPhase({
    command: process.execPath,
    args: ['--import', 'tsx', '--import', './test/_sidequest-test-home.ts', fileURLToPath(import.meta.url), phaseRootFlag, String(testConcurrency), ...files],
    cwd: pluginRoot,
    env: environment,
    timeoutMilliseconds: testPhaseTimeoutMilliseconds,
  });
  const phaseDurationMilliseconds = performance.now() - phaseStartTime;
  if (result.error) throw result.error;
  const failure = describePhaseFailure(phase, result, phaseCapacity, siblingFullSuiteCaptures);
  if (failure) throw new Error(failure);
  // Warn, never throw: a passing run that is merely close to its budget must not
  // become a red build. Turning slowness into a failure is the false red SQ-1537
  // exists to remove.
  if (phaseDurationMilliseconds > testPhaseWarningMilliseconds) {
    console.error(formatTestPhaseWarning(phase, phaseCapacity, phaseDurationMilliseconds));
  }
}

async function main() {
  if (phaseCapacity.overrideNotice) console.error(phaseCapacity.overrideNotice);
  const suiteTemporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'sidequest-full-suite-'));
  const suiteHomeDirectory = path.join(suiteTemporaryDirectory, 'home');
  const suiteClaudeDirectory = path.join(suiteHomeDirectory, '.claude');
  const suiteSidequestDirectory = path.join(suiteClaudeDirectory, 'sidequest');
  const suiteGatewayCatalogDirectory = path.join(suiteTemporaryDirectory, 'gateway-catalog');
  await fs.mkdir(suiteSidequestDirectory, { recursive: true });
  await fs.mkdir(path.join(suiteGatewayCatalogDirectory, 'model-gateway'), { recursive: true });
  await fs.writeFile(
    path.join(suiteGatewayCatalogDirectory, 'model-gateway', 'catalog.json'),
    JSON.stringify(fullSuiteGatewayCatalog()),
  );
  const suiteTestEnvironment = {
    ...suiteEnvironment(),
    HOME: suiteHomeDirectory,
    USERPROFILE: suiteHomeDirectory,
    SIDEQUEST_HOME: suiteSidequestDirectory,
    SIDEQUEST_CLAUDE_HOME: suiteClaudeDirectory,
    TMPDIR: suiteTemporaryDirectory,
    TMP: suiteTemporaryDirectory,
    TEMP: suiteTemporaryDirectory,
    SIDEQUEST_DISCOVERY_DIRS: suiteGatewayCatalogDirectory,
  };

  try {
    await runTests('functional', testFiles, suiteTestEnvironment);
  } finally {
    await fs.rm(suiteTemporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === phaseRootFlag) await runPhaseRoot(process.argv[3], process.argv.slice(4));
  else await main();
}
