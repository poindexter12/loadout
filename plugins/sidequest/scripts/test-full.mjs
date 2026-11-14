import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { suiteEnvironment } from '../../../scripts/release/cut.mjs';

const require = createRequire(import.meta.url);
const { STARTER_GATEWAY_MODEL_SLUGS } = require('../lib/category-defaults.js');
const { runOwnedPhase } = require('./owned-process-tree.js');

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDirectory = path.join(pluginRoot, 'test');
// SQ-68: the capacity model lives in one place, ../lib/test-phase-capacity.js, because the capture
// wrapper that gates this suite has to derive its own outer deadline from the very phase budget
// computed here. The constants and the effective-worker formula used to be declared here AND in
// src/lib/verify-capture.ts, which is how the gate ended up able to be tighter than the phase it
// gates. These are re-exported because the suite's own tests and callers read them from this module.
const {
  calculateTestConcurrency,
  calculateEffectiveTestWorkers,
  calculateExpectedTestPhaseDurationMilliseconds,
  calculateTestPhaseTimeoutMilliseconds,
  resolvePhaseBudgetOverride,
  phaseBudgetOverrideVariable: sharedPhaseBudgetOverrideVariable,
} = require('../lib/test-phase-capacity.js');
export const phaseBudgetOverrideVariable = sharedPhaseBudgetOverrideVariable;

// SQ-208: the tests inside one file run in sequence, so each of these files is a serial chain
// no amount of concurrency shortens. v4.0.0's passing run measured them at 750, 713, 635, 595,
// 526 and 424 seconds of test time out of 5779 for the whole phase. `node --test` starts files
// in sorted order whatever order they are passed in, so four of the six started 150-510s into
// the phase and finished past an idle machine's 843s budget while most workers sat empty.
// Starting the longest chains first leaves the short files to fill in around them. Keep this
// list ordered longest first; a file missing from the directory is skipped, and the test suite
// fails if any name here stops matching a real file.
//
// SQ-382: SQ-137 split hooks, mcp, submission and integration-advance into topic shards, so the
// heaviest chains moved. Measured alone and in sequence on 2026-10-25 (seconds of test time): 76,
// 74, 69, 61, 59, 54, 53, 47 and 45 for the files below, then a drop to 30 and under for every
// other shard (hooks.test.ts 10, mcp.test.ts 17). Re-measure when a file is split or merged.
export const longRunningTestFiles = Object.freeze([
  'submission.test.ts',
  'integration-advance-manual.test.ts',
  'integration-advance-verify.test.ts',
  'worktree-isolation.test.ts',
  'dispatch-lifecycle.test.ts',
  'submission-integration.test.ts',
  'integration-advance-delivery.test.ts',
  'submission-review.test.ts',
  'submission-shared-tree.test.ts',
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

// The model itself is ../lib/test-phase-capacity.js. These re-exports exist because the suite's
// callers and tests have always read the capacity functions from this module; re-exporting keeps
// that surface while leaving exactly one definition behind it. Do not reimplement any of them here.
export {
  calculateTestConcurrency,
  calculateEffectiveTestWorkers,
  calculateExpectedTestPhaseDurationMilliseconds,
  calculateTestPhaseTimeoutMilliseconds,
  resolvePhaseBudgetOverride,
};

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
    // The shared parser returns the sentence; the `NOTICE: ` prefix is this suite's own console
    // convention, so it is applied here rather than baked into the model the capture wrapper shares.
    overrideNotice: override.notice === null ? null : `NOTICE: ${override.notice}`,
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

function suiteProcessIds(suiteTemporaryDirectory) {
  const probe = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'command='], {
    encoding: 'utf8',
    windowsHide: true,
    // A contended host is exactly when leaks happen; give ps room rather than fail the sweep.
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (probe.error || probe.status !== 0) {
    throw new Error(`Could not inspect processes before removing ${suiteTemporaryDirectory}: ${probe.error?.message ?? `ps exited ${probe.status}`}`);
  }
  // The root must end at a path boundary, so a sibling root sharing this one as a prefix is
  // never mistaken for ours.
  const ownedRoot = new RegExp(`${suiteTemporaryDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[/\\s]|$)`);
  return probe.stdout.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (match === null || Number(match[1]) === process.pid) return [];
    return ownedRoot.test(match[2]) ? [Number(match[1])] : [];
  });
}

// A test timeout can kill node:test before its fixture's cleanup hook runs. The suite root is
// the one trustworthy ownership marker left then: no surviving command is allowed to retain it.
// Rescan after each kill pass so a fixture that forked between the scan and the kill is reaped too.
export async function sweepSuiteProcesses(suiteTemporaryDirectory) {
  const survivors = new Set();
  for (let pass = 0; pass < 3; pass += 1) {
    const found = suiteProcessIds(suiteTemporaryDirectory);
    if (found.length === 0) break;
    for (const processId of found) {
      survivors.add(processId);
      try { process.kill(processId, 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return [...survivors];
}

// Sweep, remove the root, then report. A leak must never hide the suite's own failure, and a
// failing sweep must never keep the root from being removed.
export async function cleanupSuiteRoot(suiteTemporaryDirectory, suiteError = null) {
  let survivors = [];
  let sweepError = null;
  try {
    survivors = await sweepSuiteProcesses(suiteTemporaryDirectory);
  } catch (error) {
    sweepError = error;
  }
  await fs.rm(suiteTemporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  const problems = [];
  if (survivors.length > 0) {
    problems.push(`Reaped leaked full-suite fixture processes before removing ${suiteTemporaryDirectory}: ${survivors.join(', ')}.`);
  }
  if (sweepError) problems.push(sweepError.message);
  if (problems.length === 0) {
    if (suiteError) throw suiteError;
    return survivors;
  }
  if (suiteError) throw new Error(`${suiteError.message}\n${problems.join('\n')}`, { cause: suiteError });
  throw new Error(problems.join('\n'));
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

export function suiteDirectoryLayout(suiteTemporaryDirectory) {
  const homeDirectory = path.join(suiteTemporaryDirectory, 'home');
  const claudeDirectory = path.join(homeDirectory, '.claude');
  return {
    homeDirectory,
    claudeDirectory,
    sidequestDirectory: path.join(claudeDirectory, 'sidequest'),
    gatewayCatalogDirectory: path.join(suiteTemporaryDirectory, 'gateway-catalog'),
  };
}

// Exported so test-full.test.ts can check every SIDEQUEST_* name pinned here against the
// test-home preload's sandbox allowlist (SQ-389). The preload deletes every other inherited
// SIDEQUEST_* variable, so a pin added here and not added to that allowlist would be gone
// before the first test ran and the phase would quietly escape its own sandbox. `base` is a
// parameter so the test can build a deterministic environment.
export function suiteTestEnvironment(suiteTemporaryDirectory, base = process.env) {
  const layout = suiteDirectoryLayout(suiteTemporaryDirectory);
  return {
    ...suiteEnvironment(base),
    HOME: layout.homeDirectory,
    USERPROFILE: layout.homeDirectory,
    SIDEQUEST_HOME: layout.sidequestDirectory,
    SIDEQUEST_CLAUDE_HOME: layout.claudeDirectory,
    TMPDIR: suiteTemporaryDirectory,
    TMP: suiteTemporaryDirectory,
    TEMP: suiteTemporaryDirectory,
    SIDEQUEST_DISCOVERY_DIRS: layout.gatewayCatalogDirectory,
  };
}

async function main() {
  if (phaseCapacity.overrideNotice) console.error(phaseCapacity.overrideNotice);
  const suiteTemporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'sidequest-full-suite-'));
  const layout = suiteDirectoryLayout(suiteTemporaryDirectory);
  await fs.mkdir(layout.sidequestDirectory, { recursive: true });
  await fs.mkdir(path.join(layout.gatewayCatalogDirectory, 'model-gateway'), { recursive: true });
  await fs.writeFile(
    path.join(layout.gatewayCatalogDirectory, 'model-gateway', 'catalog.json'),
    JSON.stringify(fullSuiteGatewayCatalog()),
  );
  const phaseEnvironment = suiteTestEnvironment(suiteTemporaryDirectory);

  let suiteError = null;
  try {
    await runTests('functional', testFiles, phaseEnvironment);
  } catch (error) {
    suiteError = error;
  }
  await cleanupSuiteRoot(suiteTemporaryDirectory, suiteError);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === phaseRootFlag) await runPhaseRoot(process.argv[3], process.argv.slice(4));
  else await main();
}
