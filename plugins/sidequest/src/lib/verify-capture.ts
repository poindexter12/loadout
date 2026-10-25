'use strict';

import type { VerificationResult } from './kernel/verification.js';

const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const { createHash, randomUUID } = require('node:crypto') as typeof import('node:crypto');
const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
const { defaultVerificationTimeoutMilliseconds, runProcessVerification, shellCommand } = require('./ports/process.js') as typeof import('./ports/process.js');
const { CAPTURE_WAIVER_MARKER, LOAD_ONLY_CAPTURE_STATUSES, captureFailureSignature } = require('./kernel/verification.js') as typeof import('./kernel/verification.js');

type CaptureSlotFileSystem = Pick<typeof fs, 'existsSync' | 'mkdirSync' | 'readdirSync' | 'readFileSync' | 'renameSync' | 'rmSync' | 'statSync' | 'writeFileSync'>;
type CaptureSlotProcessLiveness = Readonly<{ isAlive(pid: number, startedAt: number): boolean }>;
type CaptureSlotOwner = Readonly<{ pid: number; startedAt: number }>;

const captureSlotProcessLiveness: CaptureSlotProcessLiveness = Object.freeze({
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: unknown) {
      return (error as NodeJS.ErrnoException)?.code === 'EPERM';
    }
  },
});

const captureSlotTimeoutMilliseconds = 30 * 60 * 1_000;
// SQ-334: the slot is keyed per project (captureSlotDirectory hashes the registered project path,
// by design), so it never serialises captures across projects. Say so wherever the slot surfaces,
// or an operator reads "slot" as machine-wide and stops managing the cross-project case.
const captureSlotScopeNotice = 'The slot is per project: it serialises full-suite captures within this project only, and captures in other projects on this host are not serialised against it, so keep cross-project suites apart yourself.';
const captureSlotStaleMilliseconds = 30 * 60 * 1_000;
const captureSlotRetryMilliseconds = 50;
const captureSlotOperationRetryLimit = 20;
const captureSlotContentionErrorCodes = new Set(['EEXIST', 'EPERM', 'EBUSY', 'ENOTEMPTY']);
// Keep the outer capture deadline in lockstep with test-full's capacity model. The suite has
// its own phase deadline; the ordinary verification timeout is a setup allowance before it.
const minimumTestConcurrency = 2;
const maximumTestConcurrency = 8;
const baselineTestPhaseDurationMilliseconds = 480_000;
const testPhaseBudgetSafetyFactor = 1.5;
const maximumTestPhaseTimeoutMilliseconds = 2_400_000;
const minimumEffectiveTestWorkers = 0.5;
const phaseBudgetOverrideVariable = 'SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS';
// SQ-169: the override is widen-only, so without a ceiling one huge value let a hung run hold
// the project's capture slot (and the executor waiting on it) indefinitely. Two hours is four
// times the slowest full suite measured on a contended host (SQ-62: 29 minutes) and well above
// the 3_000_000ms the capacity model itself can reach, so it bounds a wedged run without
// constraining any real one.
const captureHardMaximumMilliseconds = 2 * 60 * 60 * 1_000;
// SQ-332: the Claude Code Bash tool's own ceilings, which an attached capture has to live inside.
// A foreground call stops at 600000ms; a longer call is moved to the background under a 1800000ms
// default (discarding the caller's foreground timeout), and a background call accepts at most
// 7200000ms. When the harness kills the wrapper first, nothing is recorded: no pass, no fail, no
// capture_budget_exceeded. The budget is never shrunk to fit those ceilings (that re-breaks what
// SQ-169 and SQ-225 fixed); instead the wrapper tells the caller the timeout it must pass, with a
// margin so the harness kill lands after the wrapper's own deadline and the verdict still records.
const harnessForegroundMaximumMilliseconds = 600_000;
const harnessBackgroundDefaultMilliseconds = 1_800_000;
const harnessBackgroundMaximumMilliseconds = 7_200_000;
const harnessTimeoutMarginMilliseconds = 600_000;

// SQ-169: every capture runs under one budget model. The run budget is the ordinary setup
// allowance plus a phase budget chosen by what the command is, derived from the capacity the
// host actually has (test-full's model, above), widened only by the override and bounded by
// the hard maximum. Before this, only `npm run test:full` got a phase budget, so a scoped
// `node --test` run that legitimately took 17 minutes on a loaded host (SQ-128) or a separate
// test tree (SQ-45) died at a fixed 600000ms however often it was retried.
type CaptureBudgetClass = 'full-suite' | 'test-suite' | 'command';
type CaptureBudget = Readonly<{
  budgetClass: CaptureBudgetClass;
  timeoutMilliseconds: number;
  setupAllowanceMilliseconds: number;
  measuredPhaseBudgetMilliseconds: number;
  phaseBudgetMilliseconds: number;
  hardMaximumMilliseconds: number;
  availableParallelism: number;
  loadAverage: number;
  effectiveTestWorkers: number;
  overrideVariable: string;
  overrideMilliseconds: number | null;
  clampedToHardMaximum: boolean;
  notice: string | null;
}>;
type CaptureBudgetResolver = (command: string) => CaptureBudget;

// The full suite by either spelling: the npm script (`npm run test:full`) or its direct entry
// point (`node scripts/test-full.mjs`). SQ-334: only the npm spelling matched, so two direct
// `node scripts/test-full.mjs` captures in one project took no slot and ran side by side. The
// direct form is matched with the same care as nodeTestRunnerPattern below: a `node` executable
// (bare, path-qualified, quoted, or .exe), any flags before the script, and a script path that
// may be relative, path-qualified or quoted (`node --import tsx plugins/sidequest/scripts/test-full.mjs`).
const npmFullSuitePattern = /(?:^|[\s&;|()])npm\s+run\s+test:full(?:\s|$)/;
const directFullSuitePattern = /(?:^|[\s&;|()])["']?(?:[^\s"'&;|()]*[\\/])?node(?:\.exe)?["']?\s(?:[^&;|()\n]*\s)?["']?(?:[^\s"'&;|()]*[\\/])?test-full\.mjs["']?(?=[\s&;|()]|$)/;

function isFullSuiteCommand(command: string): boolean {
  return npmFullSuitePattern.test(command) || directFullSuitePattern.test(command);
}

// The classifier errs toward the larger budget on purpose: a false positive (say, `echo node
// --test`) only allows more wall clock under the hard maximum, while a false negative is the
// unpassable 600000ms gate this model exists to remove.
// A node test-runner invocation: a `node` executable (bare, path-qualified, quoted, or .exe)
// whose own simple command carries the `--test` flag, whatever flags precede it
// (`node --import tsx --test test/hooks.test.ts`, `node --test scripts/release/test`).
const nodeTestRunnerPattern = /(?:^|[\s&;|()])["']?(?:[^\s"'&;|()]*[\\/])?node(?:\.exe)?["']?\s(?:[^&;|()\n]*\s)?--test(?=[\s&;|()]|$)/;
// An npm test script: `npm test`, `npm t`, `npm run test`, `npm run test:<name>` and the
// run-script spelling, allowing npm's own flags (`npm --prefix plugins/sidequest test`).
const npmTestScriptPattern = /(?:^|[\s&;|()])npm(?:\.cmd)?\s+(?:-[^\s&;|()]*(?:\s+[^-\s&;|()][^\s&;|()]*)?\s+)*(?:t|tst|test|run(?:-script)?\s+test(?::[^\s&;|()]+)?)(?=[\s&;|()]|$)/;

function isTestSuiteCommand(command: string): boolean {
  return nodeTestRunnerPattern.test(command) || npmTestScriptPattern.test(command);
}

function captureBudgetClass(command: string): CaptureBudgetClass {
  if (isFullSuiteCommand(command)) return 'full-suite';
  return isTestSuiteCommand(command) ? 'test-suite' : 'command';
}

function otherRunnableThreads(loadAverage: number): number {
  return typeof loadAverage === 'number' && Number.isFinite(loadAverage) && loadAverage > 0 ? loadAverage : 0;
}

// SQ-74: the one effective-worker model. The full-suite capture budget below, test-full's phase
// budget (scripts/test-full.mjs calculateEffectiveTestWorkers, same formula) and the in-test
// waits all read capacity through it, so both sides of a pinned gate degrade together under
// load the gate did not start. `testConcurrency` workers share `availableParallelism` cores with
// `loadAverage` other runnable threads; the result is the share of the machine they really get.
function effectiveTestWorkers(testConcurrency: number, availableParallelism: number, loadAverage: number): number {
  return Math.min(
    testConcurrency,
    Math.max(minimumEffectiveTestWorkers, (availableParallelism * testConcurrency) / (testConcurrency + otherRunnableThreads(loadAverage))),
  );
}

// SQ-74: SQ-58's per-worker in-test deadline (`perTestWorkerMilliseconds * testWorkers`) scaled
// by the same capacity factor the capture budget uses. Before this the capture widened under a
// sibling suite that never took the capture slot while the waits inside it stayed fixed, so a
// starved suite failed as if it were broken. On an idle host with a core per worker the factor
// is 1 and the deadline is exactly SQ-58's; under load it widens by
// testWorkers / effectiveTestWorkers. A reading taken mid-suite also counts the suite's own
// workers, which can only widen a failure's deadline: a wait still returns the moment its
// condition holds.
function capacityScaledDeadlineMilliseconds(perTestWorkerMilliseconds: number, testWorkers: number, availableParallelism = os.availableParallelism(), loadAverage = os.loadavg()[0] || 0): number {
  const workers = Number.isFinite(testWorkers) && testWorkers > 0 ? testWorkers : 1;
  const capacityScale = workers / effectiveTestWorkers(workers, availableParallelism, loadAverage);
  return Math.round(perTestWorkerMilliseconds * workers * capacityScale);
}

function captureBudget(command: string, availableParallelism = os.availableParallelism(), loadAverage = os.loadavg()[0] || 0, rawOverride = process.env[phaseBudgetOverrideVariable]): CaptureBudget {
  const budgetClass = captureBudgetClass(command);
  const testConcurrency = Math.min(maximumTestConcurrency, Math.max(minimumTestConcurrency, availableParallelism));
  const effectiveWorkers = effectiveTestWorkers(testConcurrency, availableParallelism, loadAverage);
  const capacityPhaseBudgetMilliseconds = Math.min(
    maximumTestPhaseTimeoutMilliseconds,
    Math.round((baselineTestPhaseDurationMilliseconds * maximumTestConcurrency / effectiveWorkers) * testPhaseBudgetSafetyFactor),
  );
  // A command that is not a test runner keeps the ordinary setup allowance alone: it has no
  // suite phase to scale, and the override is its one lever.
  const measuredPhaseBudgetMilliseconds = budgetClass === 'command' ? 0 : capacityPhaseBudgetMilliseconds;
  const requestedText = typeof rawOverride === 'string' ? rawOverride.trim() : '';
  const requested = /^\d+$/.test(requestedText) ? Number(requestedText) : 0;
  const widened = requested > measuredPhaseBudgetMilliseconds;
  const phaseBudgetMilliseconds = widened ? requested : measuredPhaseBudgetMilliseconds;
  const uncappedMilliseconds = defaultVerificationTimeoutMilliseconds + phaseBudgetMilliseconds;
  const clampedToHardMaximum = uncappedMilliseconds > captureHardMaximumMilliseconds;
  const timeoutMilliseconds = clampedToHardMaximum ? captureHardMaximumMilliseconds : uncappedMilliseconds;
  let notice: string | null = null;
  if (requestedText && requested <= 0) {
    notice = `${phaseBudgetOverrideVariable}=${requestedText} is not a positive whole number of milliseconds, so the measured ${measuredPhaseBudgetMilliseconds}ms phase budget stands.`;
  } else if (requested > 0 && !widened) {
    notice = `${phaseBudgetOverrideVariable}=${requested} cannot shorten the measured ${measuredPhaseBudgetMilliseconds}ms phase budget, so the measured budget stands. The override only ever grants more wall clock.`;
  } else if (clampedToHardMaximum) {
    notice = `${phaseBudgetOverrideVariable}=${requested} asked for a ${uncappedMilliseconds}ms capture budget, above the ${captureHardMaximumMilliseconds}ms hard maximum, so the capture stops at ${captureHardMaximumMilliseconds}ms.`;
  } else if (widened) {
    notice = `${phaseBudgetOverrideVariable} raised the phase budget from a measured ${measuredPhaseBudgetMilliseconds}ms to ${requested}ms. Every test still has to pass inside it: this grants wall clock, it does not skip the gate.`;
  }
  return Object.freeze({
    budgetClass,
    timeoutMilliseconds,
    setupAllowanceMilliseconds: defaultVerificationTimeoutMilliseconds,
    measuredPhaseBudgetMilliseconds,
    phaseBudgetMilliseconds,
    hardMaximumMilliseconds: captureHardMaximumMilliseconds,
    availableParallelism,
    loadAverage: otherRunnableThreads(loadAverage),
    effectiveTestWorkers: effectiveWorkers,
    overrideVariable: phaseBudgetOverrideVariable,
    overrideMilliseconds: widened ? requested : null,
    clampedToHardMaximum,
    notice,
  });
}

function fullSuiteCaptureTimeoutMilliseconds(availableParallelism = os.availableParallelism(), loadAverage = os.loadavg()[0] || 0, rawOverride = process.env[phaseBudgetOverrideVariable]): number {
  return captureBudget('npm run test:full', availableParallelism, loadAverage, rawOverride).timeoutMilliseconds;
}

const captureBudgetClassDescriptions: Readonly<Record<CaptureBudgetClass, string>> = Object.freeze({
  'full-suite': 'the test:full suite, serialized per project; captures in other projects are not serialized against it',
  'test-suite': 'a node --test or npm test script run',
  command: 'not a recognized test runner, so it gets no capacity phase budget',
});

function formatLoad(value: number): string {
  return Number.isFinite(value) && value > 0 ? value.toFixed(2) : '0.00';
}

function describeCaptureBudget(budget: CaptureBudget): string {
  const phaseSource = budget.overrideMilliseconds !== null
    ? `widened by ${budget.overrideVariable} from a measured ${budget.measuredPhaseBudgetMilliseconds}ms`
    : budget.budgetClass === 'command' ? 'none for this class' : 'derived from host capacity';
  return `${budget.budgetClass} class (${captureBudgetClassDescriptions[budget.budgetClass]}): ${budget.setupAllowanceMilliseconds}ms setup allowance + ${budget.phaseBudgetMilliseconds}ms phase budget (${phaseSource}), capped at the ${budget.hardMaximumMilliseconds}ms hard maximum; derived at ${budget.availableParallelism} available cores and a 1-minute load average of ${formatLoad(budget.loadAverage)} (${budget.effectiveTestWorkers.toFixed(2)} effective test workers)`;
}

function captureBudgetLever(budget: CaptureBudget): string {
  if (budget.clampedToHardMaximum || budget.timeoutMilliseconds >= budget.hardMaximumMilliseconds) {
    return `The budget is already at the ${budget.hardMaximumMilliseconds}ms hard maximum, so no override can raise it: ask the orchestrator to re-pin a narrower verify command, or rerun once the host is quieter.`;
  }
  return `To give it more wall clock, rerun the same wrapper with ${budget.overrideVariable}=<milliseconds> above ${budget.phaseBudgetMilliseconds} in its environment. The override only widens the phase budget, never shortens it or skips a test, and the capture still stops at the ${budget.hardMaximumMilliseconds}ms hard maximum.`;
}

// SQ-332: the Bash timeout an attached capture needs: the budget plus a margin, never more than
// the harness accepts. Equal to the harness maximum means the margin did not fit.
function captureHarnessTimeoutMilliseconds(budget: CaptureBudget): number {
  return Math.min(harnessBackgroundMaximumMilliseconds, budget.timeoutMilliseconds + harnessTimeoutMarginMilliseconds);
}

// SQ-332: agent-facing. Announced before the command starts, so a caller about to background the
// wrapper learns the timeout it must pass while it can still act on it, and a wrapper killed by
// the harness default leaves this line as the identifiable reason it recorded nothing.
function captureHarnessGuidance(budget: CaptureBudget, detached = false): string {
  if (detached) {
    return `verify-capture: running detached, so no Bash timeout can stop this capture; it records its own verdict within its ${budget.timeoutMilliseconds}ms budget.`;
  }
  const required = captureHarnessTimeoutMilliseconds(budget);
  const marginFits = budget.timeoutMilliseconds + harnessTimeoutMarginMilliseconds <= harnessBackgroundMaximumMilliseconds;
  const parts = [`verify-capture: Bash timeout: this capture may run up to ${budget.timeoutMilliseconds}ms. The Bash tool stops a foreground call at ${harnessForegroundMaximumMilliseconds}ms and moves a longer one to the background under its ${harnessBackgroundDefaultMilliseconds}ms default, discarding the timeout you set, and a wrapper killed there records no verdict at all.`];
  if (budget.timeoutMilliseconds >= harnessBackgroundDefaultMilliseconds) {
    parts.push(`This budget is at or above that ${harnessBackgroundDefaultMilliseconds}ms default, so a backgrounded call without an explicit timeout is killed before this capture can record pass, fail, or capture_budget_exceeded.`);
  }
  parts.push(marginFits
    ? `If you background this call, pass timeout=${required} (the budget plus a ${harnessTimeoutMarginMilliseconds}ms margin, under the ${harnessBackgroundMaximumMilliseconds}ms harness maximum), never the default; or rerun with --detach, which no Bash timeout can stop.`
    : `This budget leaves less than the ${harnessTimeoutMarginMilliseconds}ms margin under the ${harnessBackgroundMaximumMilliseconds}ms harness maximum, so no Bash timeout reliably outlives it: rerun with --detach, which no Bash timeout can stop.`);
  return parts.join(' ');
}

function captureBudgetTimeoutReason(budget: CaptureBudget, elapsedMilliseconds: number, loadAtDeadline: number, processReason: string): string {
  return `capture_budget_exceeded: the verify command ran ${elapsedMilliseconds}ms and was stopped at its ${budget.timeoutMilliseconds}ms capture budget. This is a budget verdict, not a test failure: the command had not finished, so whatever it would have reported is unknown. Budget: ${describeCaptureBudget(budget)}; the load average was ${formatLoad(loadAtDeadline)} at the deadline. ${captureBudgetLever(budget)} ${processReason}`.trim();
}

function appendCaptureBudgetEvidence(logPath: string | null | undefined, budget: CaptureBudget, elapsedMilliseconds: number): void {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, `\n[sidequest] Verification capture budget: ${budget.timeoutMilliseconds}ms, ${describeCaptureBudget(budget)}. Elapsed ${elapsedMilliseconds}ms.${budget.notice ? ` ${budget.notice}` : ''}\n`);
  } catch {
    // The wrapper output still carries the budget when the log cannot be appended.
  }
}

type VerifyCapture = VerificationResult & Readonly<{
  exitCode: number | null;
  reason?: string;
  waitedForSlotMs?: number;
  queuePosition?: number;
  budget?: CaptureBudget;
  elapsedMilliseconds?: number;
}>;
type CaptureRunOptions = Readonly<{
  // Test seam: resolve the budget a command runs under (defaults to the host-derived model).
  resolveBudget?: CaptureBudgetResolver;
  // Where the budget line goes before the command starts; the CLI prints it to stderr.
  announce?: (line: string) => void;
  // SQ-76: called once, immediately before the command spawns (inside the full-suite slot), so
  // the capture can snapshot the tree that actually starts the run rather than the tree it queued from.
  beforeRun?: () => void;
  // SQ-332: true in the --detach child, whose Bash call no harness timeout can reach.
  detached?: boolean;
}>;
type CaptureTarget =Readonly<{ project: string; ticket: string }>;
type CaptureRecordResult = Readonly<{
  ok: boolean;
  reason?: string;
  message?: string;
  pinnedCommand?: string;
  capture?: Readonly<{ id: string; ticket?: string; candidate: Readonly<{ source: string; value: string }> }>;
}>;
type VerificationCaptureStore = Readonly<{
  findProject(project: string): Readonly<{ ok: boolean; slug?: string; reason?: string; meta?: Readonly<{ path?: string }> }>;
  nearestRepoRoot(start: string): string;
  getTicket(slug: string, ticket: string): unknown;
  workingTreeDeliveryCandidate(slug: string, ticket: unknown): Readonly<{ candidate: Readonly<{ source: string; value: string }> }> | null;
  recordVerificationCapture(slug: string, ticket: string, capture: Readonly<Record<string, unknown>>): CaptureRecordResult;
}>;
type CaptureProject = Readonly<{ slug: string; path: string }>;
type CaptureProjectResolution =
  | Readonly<{ ok: true; project: CaptureProject }>
  | Readonly<{ ok: false; reason: string }>;
type CaptureSlotLease = Readonly<{
  waitedForSlotMs: number;
  queuePosition: number;
  release(): Promise<CaptureSlotFailure | null>;
}>;
type CaptureSlotTimeout = Readonly<{
  waitedForSlotMs: number;
  queuePosition: number;
  reason: string;
}>;
type CaptureSlotFailure = Readonly<{
  reason: string;
  errorCode: string;
}>;

function captureRequirement(command: string) {
  return Object.freeze({ kind: 'command' as const, command, evidenceContract: 'command output' });
}

async function runVerifyCapture(command: string, cwd = process.cwd(), timeoutMilliseconds?: number, environment?: NodeJS.ProcessEnv): Promise<VerifyCapture> {
  const result = runProcessVerification(captureRequirement(command), {
    cwd,
    ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
    ...(environment === undefined ? {} : { environment }),
  });
  return Object.freeze({
    ...result,
    exitCode: result.exitCode ?? null,
    ...(result.status === 'passed' ? {} : { reason: result.evidence }),
  });
}

// SQ-169: run a capture under its budget and make the verdict say so. A timeout used to read
// "Verification timed out after 600000ms", which an executor could not tell apart from a hung
// test and had no way to raise; now it names the elapsed time, the budget and how it was
// derived, the load, and the one lever that grants more time.
async function runBudgetedCapture(command: string, cwd: string, budget: CaptureBudget, environment?: NodeJS.ProcessEnv, announce?: (line: string) => void, detached = false): Promise<VerifyCapture> {
  if (announce) {
    announce(`verify-capture: capture budget ${budget.timeoutMilliseconds}ms, ${describeCaptureBudget(budget)}.`);
    if (budget.notice) announce(`verify-capture: ${budget.notice}`);
    announce(captureHarnessGuidance(budget, detached));
  }
  const startedAt = Date.now();
  const capture = await runVerifyCapture(command, cwd, budget.timeoutMilliseconds, environment);
  const elapsedMilliseconds = Math.max(0, Date.now() - startedAt);
  appendCaptureBudgetEvidence(capture.logPath, budget, elapsedMilliseconds);
  if (capture.status !== 'timeout') return Object.freeze({ ...capture, budget, elapsedMilliseconds });
  const reason = captureBudgetTimeoutReason(budget, elapsedMilliseconds, os.loadavg()[0] || 0, String(capture.reason || capture.evidence || ''));
  return Object.freeze({ ...capture, evidence: reason, reason, budget, elapsedMilliseconds });
}

function captureSlotDirectory(project: string): string {
  const projectKey = path.resolve(project).toLocaleLowerCase();
  const projectHash = createHash('sha256').update(projectKey).digest('hex');
  return path.join(os.tmpdir(), 'sidequest-verify-capture-slots', projectHash);
}

function captureSlotWaiterPath(slotDirectory: string, fileSystem: CaptureSlotFileSystem = fs): string {
  const waitingDirectory = path.join(slotDirectory, 'waiting');
  fileSystem.mkdirSync(waitingDirectory, { recursive: true });
  return path.join(waitingDirectory, `${Date.now().toString().padStart(15, '0')}-${process.pid}-${randomUUID()}.json`);
}

function queuedWaiters(slotDirectory: string, fileSystem: CaptureSlotFileSystem = fs): readonly string[] {
  try {
    return fileSystem.readdirSync(path.join(slotDirectory, 'waiting')).sort();
  } catch {
    return [];
  }
}

function captureSlotOwnerPath(slotPath: string): string {
  return path.join(slotPath, 'owner.json');
}

function captureSlotOwner(): CaptureSlotOwner {
  return Object.freeze({ pid: process.pid, startedAt: Math.round(Date.now() - process.uptime() * 1_000) });
}

function readCaptureSlotOwner(ownerPath: string, fileSystem: CaptureSlotFileSystem): CaptureSlotOwner | null {
  try {
    const parsed = JSON.parse(String(fileSystem.readFileSync(ownerPath, 'utf8')));
    return Number.isInteger(parsed?.pid) && parsed.pid > 0 && Number.isFinite(parsed?.startedAt)
      ? Object.freeze({ pid: parsed.pid, startedAt: parsed.startedAt })
      : null;
  } catch {
    return null;
  }
}

function captureSlotEntryIsStale(slotPath: string, fileSystem: CaptureSlotFileSystem): boolean {
  try {
    return Date.now() - fileSystem.statSync(slotPath).mtimeMs >= captureSlotStaleMilliseconds;
  } catch {
    return false;
  }
}

function reportCaptureSlotReap(kind: 'lease' | 'waiter', slotPath: string, owner: CaptureSlotOwner | null): void {
  const identity = owner ? `dead ${kind} for pid ${owner.pid}` : `stale ${kind}`;
  process.stdout.write(`verify-capture: reaped ${identity} at ${JSON.stringify(slotPath)}.\n`);
}

async function reapDeadCaptureSlots(slotDirectory: string, activeDirectory: string, fileSystem: CaptureSlotFileSystem, liveness: CaptureSlotProcessLiveness, protectedWaiterPath?: string): Promise<void> {
  const activeOwner = readCaptureSlotOwner(captureSlotOwnerPath(activeDirectory), fileSystem);
  if ((activeOwner && !liveness.isAlive(activeOwner.pid, activeOwner.startedAt)) || (!activeOwner && captureSlotEntryIsStale(activeDirectory, fileSystem))) {
    const failure = await releaseCaptureSlot(activeDirectory, fileSystem);
    if (!failure) reportCaptureSlotReap('lease', activeDirectory, activeOwner);
  }
  for (const waiterName of queuedWaiters(slotDirectory, fileSystem)) {
    const waiterPath = path.join(slotDirectory, 'waiting', waiterName);
    if (waiterPath === protectedWaiterPath) continue;
    const waiterOwner = readCaptureSlotOwner(waiterPath, fileSystem);
    if ((waiterOwner && !liveness.isAlive(waiterOwner.pid, waiterOwner.startedAt)) || (!waiterOwner && captureSlotEntryIsStale(waiterPath, fileSystem))) {
      try {
        fileSystem.rmSync(waiterPath, { force: true });
        reportCaptureSlotReap('waiter', waiterPath, waiterOwner);
      } catch {
        // A competing capture may have removed this waiter after the liveness check.
      }
    }
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function captureSlotErrorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code;
  return error instanceof Error ? error.name : String(error);
}

function captureSlotOperationFailure(operation: string, slotPath: string, attempts: number, error: unknown): CaptureSlotFailure {
  const errorCode = captureSlotErrorCode(error);
  return Object.freeze({
    reason: `Verification capture could not ${operation} slot path ${JSON.stringify(slotPath)} after ${attempts} retries; last errno ${errorCode}.`,
    errorCode,
  });
}

async function retryCaptureSlotOperation(operation: string, slotPath: string, execute: () => void): Promise<CaptureSlotFailure | null> {
  for (let attempts = 1; attempts <= captureSlotOperationRetryLimit; attempts += 1) {
    try {
      execute();
      return null;
    } catch (error: unknown) {
      const errorCode = captureSlotErrorCode(error);
      if (!captureSlotContentionErrorCodes.has(errorCode) || attempts === captureSlotOperationRetryLimit) {
        return captureSlotOperationFailure(operation, slotPath, attempts, error);
      }
      await wait(captureSlotRetryMilliseconds);
    }
  }
  throw new Error('Capture slot operation retry loop completed unexpectedly.');
}

async function releaseCaptureSlot(activeDirectory: string, fileSystem: CaptureSlotFileSystem): Promise<CaptureSlotFailure | null> {
  const tombstoneDirectory = `${activeDirectory}.released-${process.pid}-${randomUUID()}`;
  const renameFailure = await retryCaptureSlotOperation('rename', activeDirectory, () => fileSystem.renameSync(activeDirectory, tombstoneDirectory));
  if (renameFailure) {
    if (renameFailure.errorCode === 'ENOENT') return null;
    return renameFailure;
  }
  return retryCaptureSlotOperation('remove', tombstoneDirectory, () => fileSystem.rmSync(tombstoneDirectory, { recursive: true, force: true }));
}

async function acquireCaptureSlot(project: string, timeoutMilliseconds = captureSlotTimeoutMilliseconds, fileSystem: CaptureSlotFileSystem = fs, liveness: CaptureSlotProcessLiveness = captureSlotProcessLiveness): Promise<CaptureSlotLease | CaptureSlotTimeout | CaptureSlotFailure> {
  const slotDirectory = captureSlotDirectory(project);
  const activeDirectory = path.join(slotDirectory, 'active');
  const startedAt = Date.now();
  const waiterPath = captureSlotWaiterPath(slotDirectory, fileSystem);
  const waiterName = path.basename(waiterPath);
  const owner = captureSlotOwner();
  fileSystem.writeFileSync(waiterPath, JSON.stringify(owner), { encoding: 'utf8', flag: 'wx' });
  let waitingAnnounced = false;
  let queuePosition = 1;
  let acquireContentionAttempts = 0;

  for (;;) {
    await reapDeadCaptureSlots(slotDirectory, activeDirectory, fileSystem, liveness, waiterPath);
    const waiterIndex = queuedWaiters(slotDirectory, fileSystem).indexOf(waiterName);
    const active = fileSystem.existsSync(activeDirectory);
    queuePosition = Math.max(queuePosition, waiterIndex + (active ? 2 : 1));
    if (!active && waiterIndex === 0) {
      let acquired = false;
      try {
        fileSystem.mkdirSync(activeDirectory);
        acquired = true;
      } catch (error: unknown) {
        const errorCode = captureSlotErrorCode(error);
        if (!captureSlotContentionErrorCodes.has(errorCode)) {
          fileSystem.rmSync(waiterPath, { force: true });
          return captureSlotOperationFailure('create', activeDirectory, 1, error);
        }
        acquireContentionAttempts += 1;
        if (acquireContentionAttempts === captureSlotOperationRetryLimit) {
          fileSystem.rmSync(waiterPath, { force: true });
          return captureSlotOperationFailure('create', activeDirectory, acquireContentionAttempts, error);
        }
      }
      if (acquired) {
        try {
          fileSystem.writeFileSync(captureSlotOwnerPath(activeDirectory), JSON.stringify(owner), { encoding: 'utf8', flag: 'wx' });
        } catch (error: unknown) {
          fileSystem.rmSync(waiterPath, { force: true });
          const releaseFailure = await releaseCaptureSlot(activeDirectory, fileSystem);
          return releaseFailure || captureSlotOperationFailure('write owner for', activeDirectory, 1, error);
        }
        fileSystem.rmSync(waiterPath, { force: true });
        return Object.freeze({
          waitedForSlotMs: Date.now() - startedAt,
          queuePosition,
          release: () => releaseCaptureSlot(activeDirectory, fileSystem),
        });
      }
    }
    if (!waitingAnnounced) {
      const siblingCount = queuePosition - 1;
      process.stdout.write(`verify-capture: waiting for ${siblingCount} sibling capture${siblingCount === 1 ? '' : 's'} to finish (queue position ${queuePosition}). ${captureSlotScopeNotice}\n`);
      waitingAnnounced = true;
    }
    const waitedForSlotMs = Date.now() - startedAt;
    if (waitedForSlotMs >= timeoutMilliseconds) {
      fileSystem.rmSync(waiterPath, { force: true });
      return Object.freeze({
        waitedForSlotMs,
        queuePosition,
        reason: `Verification capture waited ${waitedForSlotMs}ms for this project's full-suite slot at queue position ${queuePosition}; sibling capture contention exceeded the ${timeoutMilliseconds}ms limit. ${captureSlotScopeNotice}`,
      });
    }
    await wait(captureSlotRetryMilliseconds);
  }
}

function captureSlotTimeout(command: string, slot: CaptureSlotTimeout): VerifyCapture {
  return Object.freeze({
    kind: 'command',
    status: 'timeout',
    evidence: slot.reason,
    command,
    logPath: null,
    exitCode: 2,
    outputTail: null,
    failureIdentities: Object.freeze(['timeout:capture-slot-contention']),
    reason: slot.reason,
    waitedForSlotMs: slot.waitedForSlotMs,
    queuePosition: slot.queuePosition,
  });
}

function captureSlotCouldNotRun(command: string, slot: CaptureSlotFailure): VerifyCapture {
  return Object.freeze({
    kind: 'command',
    status: 'could_not_run',
    evidence: slot.reason,
    command,
    logPath: null,
    exitCode: 2,
    outputTail: null,
    failureIdentities: Object.freeze(['could_not_run:capture-slot']),
    reason: slot.reason,
  });
}

async function runFullSuiteCapture(command: string, project: string, cwd: string, fileSystem: CaptureSlotFileSystem = fs, options: CaptureRunOptions = {}): Promise<VerifyCapture> {
  let slot: CaptureSlotLease | CaptureSlotTimeout | CaptureSlotFailure;
  try {
    slot = await acquireCaptureSlot(project, captureSlotTimeoutMilliseconds, fileSystem);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return captureSlotCouldNotRun(command, Object.freeze({
      reason: `Verification capture could not acquire this project's full-suite slot: ${reason}`,
      errorCode: captureSlotErrorCode(error),
    }));
  }
  if ('reason' in slot) {
    return 'waitedForSlotMs' in slot ? captureSlotTimeout(command, slot) : captureSlotCouldNotRun(command, slot);
  }
  let capture: VerifyCapture;
  let releaseFailure: CaptureSlotFailure | null = null;
  try {
    // The budget is derived once the slot is held, so it reflects the load the suite runs
    // under rather than the load while it queued.
    options.beforeRun?.();
    const budget = (options.resolveBudget || captureBudget)(command);
    capture = await runBudgetedCapture(command, cwd, budget, {
      ...process.env,
      SIDEQUEST_FULL_SUITE_SIBLING_CAPTURE_COUNT: String(slot.queuePosition - 1),
    }, options.announce, options.detached);
  } finally {
    releaseFailure = await slot.release();
  }
  if (releaseFailure) return captureSlotCouldNotRun(command, releaseFailure);
  return Object.freeze({
    ...capture,
    waitedForSlotMs: slot.waitedForSlotMs,
    queuePosition: slot.queuePosition,
  });
}

function captureTarget(args: readonly string[]): CaptureTarget | null {
  const projectIndex = args.indexOf('--project');
  const ticketIndex = args.indexOf('--ticket');
  const project = projectIndex >= 0 ? String(args[projectIndex + 1] || '').trim() : '';
  const ticket = ticketIndex >= 0 ? String(args[ticketIndex + 1] || '').trim() : '';
  return project && ticket ? Object.freeze({ project, ticket }) : null;
}

// The board a capture belongs to comes from the dispatched ticket's registered
// project, never from whatever checkout the executor happens to stand in. A
// re-dispatched executor that inherits a retired agent's worktree (SQ-70, issue
// #18) carries that worktree's path, not the project's: resolving it directly
// missed, and the bare `project_not_found` it returned pointed the investigation
// at project registration instead of at worktree reuse. Folding an unregistered
// argument to the repository root that owns it maps a linked worktree back onto
// the board that dispatched the ticket. It also keeps captureSlotDirectory
// hashing the REGISTERED project path, so a stale spelling can no longer strand
// full-suite captures in a private slot namespace and defeat their serialization.
function resolveCaptureProject(target: CaptureTarget): CaptureProjectResolution {
  const store = require('./store.js') as VerificationCaptureStore;
  const requested = String(target.project || '').trim();
  const candidates = [requested];
  let repositoryRoot = '';
  try {
    repositoryRoot = String(store.nearestRepoRoot(requested) || '').trim();
  } catch (_) {
    repositoryRoot = '';
  }
  if (repositoryRoot && repositoryRoot !== requested) candidates.push(repositoryRoot);
  const attempts: string[] = [];
  for (const candidate of candidates) {
    const found = store.findProject(candidate);
    if (found.ok && found.slug) {
      return Object.freeze({
        ok: true as const,
        project: Object.freeze({ slug: found.slug, path: String(found.meta?.path || '').trim() || path.resolve(candidate) }),
      });
    }
    attempts.push(`${JSON.stringify(candidate)} (${found.reason || 'not_found'})`);
  }
  return Object.freeze({
    ok: false as const,
    reason: `project_not_found: no registered board matched the --project argument for ${target.ticket}. Tried ${attempts.join(', then its repository root ')}. Verification capture resolves the board from the dispatched ticket's registered project path, not from the working directory, so a stale worktree path here means the dispatch named an unregistered project.`,
  });
}

function captureProject(target: CaptureTarget): CaptureProject | null {
  const resolution = resolveCaptureProject(target);
  return resolution.ok ? resolution.project : null;
}

type CaptureBinding =
  // `head` is set only for an isolated dispatch: the commit the capture is bound
  // to, observed before anything ran.
  | Readonly<{ ok: true; cwd: string; head?: string }>
  | Readonly<{ ok: false; status: 'could_not_run' | 'failed_check'; identity: string; reason: string }>;

type IsolatedDispatch = Readonly<{ isolated: false }> | Readonly<{ isolated: true; worktree: string }>;

// An isolated dispatch owns exactly one checkout: the linked worktree the board
// bound at dispatch (for a continuation, the retained worktree it resumes).
// Shared-tree and working-tree (artifact) dispatches keep the caller's checkout,
// which is the project checkout itself. Only a live dispatch binds: once it is
// terminal no executor holds it, and an orchestrator re-verifying a pending
// submission keeps choosing the checkout it runs from.
function dispatchedIsolatedWorktree(ticket: any): IsolatedDispatch {
  const dispatch = ticket?.dispatch;
  if (!dispatch || typeof dispatch !== 'object' || dispatch.terminalAt) return Object.freeze({ isolated: false as const });
  if (dispatch.sharedTree === true || dispatch.workingTreeDelivery === true) return Object.freeze({ isolated: false as const });
  const worktree = typeof dispatch.worktree === 'string' ? dispatch.worktree.trim() : '';
  // A dispatch that predates the sharedTree flag and carries no worktree is a
  // legacy record, not an isolated one.
  if (!worktree && dispatch.sharedTree !== false) return Object.freeze({ isolated: false as const });
  return Object.freeze({ isolated: true as const, worktree });
}

// null when git fails, so a caller can refuse instead of reading "" as a clean
// answer.
function gitOutput(cwd: string, args: readonly string[], raw = false): string | null {
  try {
    const output = String(execFileSync('git', [...args], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }));
    return raw ? output : output.trim();
  } catch (_) {
    return null;
  }
}

function canonicalPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch (_) {
    return path.resolve(value);
  }
}

function captureBindingRefusal(status: 'could_not_run' | 'failed_check', identity: string, reason: string): CaptureBinding {
  return Object.freeze({ ok: false as const, status, identity, reason });
}

// SQ-162: a capture used to run in whatever directory the wrapper was started
// from and record that checkout's HEAD. An isolated executor whose shell stood
// in the canonical checkout certified main instead of its candidate (SQ-81), and
// one that ran before committing certified its base commit while the candidate
// sat uncommitted in the tree (SQ-158). Either way the run spent up to its full
// deadline and submit then refused the capture as not matching the candidate.
// For an isolated dispatch the capture now runs in the dispatched worktree
// whatever directory the wrapper starts from, and it refuses before spawning
// anything when that worktree cannot be bound or its HEAD would not be the code
// that runs.
function captureBinding(target: CaptureTarget, cwd: string, project: CaptureProject | null): CaptureBinding {
  if (!project) return Object.freeze({ ok: true as const, cwd });
  const store = require('./store.js') as VerificationCaptureStore;
  const ticket = store.getTicket(project.slug, target.ticket);
  if (store.workingTreeDeliveryCandidate(project.slug, ticket)) return Object.freeze({ ok: true as const, cwd: project.path });
  const dispatch = dispatchedIsolatedWorktree(ticket);
  if (!dispatch.isolated) return Object.freeze({ ok: true as const, cwd });
  const worktree = dispatch.worktree;
  if (!worktree) {
    return captureBindingRefusal('could_not_run', 'could_not_run:verification-capture-worktree-unavailable', `capture_worktree_unavailable: ${target.ticket} holds an isolated dispatch, but no worktree is bound to it, so there is no candidate checkout to verify. Nothing was run, and the checkout the wrapper started from (${JSON.stringify(path.resolve(cwd))}) was not verified in its place. Release the claim and re-dispatch.`);
  }
  const toplevel = gitOutput(worktree, ['rev-parse', '--show-toplevel']);
  const head = (gitOutput(worktree, ['rev-parse', '--verify', 'HEAD^{commit}']) || '').toLowerCase();
  if (!toplevel || !head || canonicalPath(toplevel) !== canonicalPath(worktree)) {
    return captureBindingRefusal('could_not_run', 'could_not_run:verification-capture-worktree-unavailable', `capture_worktree_unavailable: ${target.ticket} was dispatched to the isolated worktree ${JSON.stringify(worktree)}, but git resolves no live worktree root with a HEAD commit there. The capture must run in and bind to that worktree, so nothing was run. Release the claim and re-dispatch rather than verifying another checkout.`);
  }
  const status = gitOutput(worktree, ['status', '--porcelain=v1', '--untracked-files=normal'], true);
  if (status === null) {
    return captureBindingRefusal('could_not_run', 'could_not_run:verification-capture-worktree-unavailable', `capture_worktree_unavailable: git status failed in ${target.ticket}'s worktree ${JSON.stringify(worktree)}, so the capture cannot confirm that HEAD ${head} is the code that would run. Nothing was run. Rerun the wrapper once git status succeeds there.`);
  }
  // Porcelain lines are `XY path`; the status column can start with a space, so
  // the output is split untrimmed.
  const dirty = status.split('\n').map((line) => line.slice(3).trim()).filter(Boolean);
  if (dirty.length) {
    const shown = dirty.slice(0, 10).join(', ') + (dirty.length > 10 ? `, and ${dirty.length - 10} more` : '');
    return captureBindingRefusal('failed_check', 'failed_check:verification-capture-uncommitted-candidate', `capture_candidate_uncommitted: ${target.ticket}'s worktree ${JSON.stringify(worktree)} has uncommitted changes, so the capture would run that code but bind to HEAD ${head}, a commit that does not contain it, and submit would refuse the capture. Nothing was run. Commit the declared scope with the board commit tool, restore or remove anything else, then rerun the wrapper. Uncommitted: ${shown}`);
  }
  return Object.freeze({ ok: true as const, cwd: toplevel, head });
}

function captureBindingFailure(command: string, binding: Extract<CaptureBinding, { ok: false }>): VerifyCapture {
  return Object.freeze({
    kind: 'command',
    status: binding.status,
    evidence: binding.reason,
    command,
    logPath: null,
    exitCode: 2,
    outputTail: null,
    failureIdentities: Object.freeze([binding.identity]),
    reason: binding.reason,
  });
}

// SQ-203 (#20): the preflight asks the recorder itself whether this command would be
// recorded, so the wrapper never runs a command the recorder then refuses after it passes,
// and never refuses one the recorder would accept. A ticket with no pinned command still
// runs, as before, and the recorder's verdict on it is printed by report().
function preflightCapture(command: string, target: CaptureTarget, project: CaptureProject | null): VerifyCapture | null {
  if (!project) return null;
  let checked: CaptureRecordResult;
  try {
    const store = require('./store.js') as VerificationCaptureStore;
    checked = store.recordVerificationCapture(project.slug, target.ticket, { command, preflight: true });
  } catch (_) {
    // The submission-time check remains authoritative when the wrapper cannot
    // read the pin, so an unavailable board never rejects a run.
    return null;
  }
  if (checked?.ok || checked?.reason !== 'verification_capture_command_mismatch' || !checked.pinnedCommand) return null;
  const reason = checked.message || checked.reason;
  return Object.freeze({
    kind: 'command',
    status: 'failed_check',
    evidence: reason,
    command,
    logPath: null,
    exitCode: 2,
    outputTail: null,
    failureIdentities: Object.freeze(['failed_check:verification-capture-command-mismatch']),
    reason,
  });
}

async function runCapturedVerification(command: string, target: CaptureTarget | null, cwd = process.cwd(), fileSystem: CaptureSlotFileSystem = fs, options: CaptureRunOptions = {}) {
  const resolution = target ? resolveCaptureProject(target) : null;
  const project = resolution?.ok ? resolution.project : null;
  const preflight = target ? preflightCapture(command, target, project) : null;
  const binding = target && !preflight ? captureBinding(target, cwd, project) : null;
  if (binding && !binding.ok) {
    // A refused binding ran nothing, so there is no checked revision to record.
    const capture = captureBindingFailure(command, binding);
    return Object.freeze({ capture, recorded: Object.freeze({ ok: false, reason: binding.reason.split(':')[0] || 'capture_binding_refused', message: binding.reason }) });
  }
  const captureCwd = binding?.ok ? binding.cwd : cwd;
  // SQ-76: the tree the command starts from, so the record binds to what ran. It is taken
  // immediately before the spawn; a run that never started is snapshotted when it is recorded.
  const started: { before: TreeSnapshot | null } = { before: null };
  const beforeRun = () => {
    options.beforeRun?.();
    if (target && !preflight) started.before = treeSnapshot(captureCwd, true);
  };
  // Only a ticket-bound full-suite capture takes the project's slot (keyed per project by
  // captureSlotDirectory, never per host: captures in other projects run beside it); every capture runs under the
  // budget model. SQ-74 ruled that an ad-hoc full-suite run (no --ticket, or `npm run test:full`
  // straight from a shell) does not contend for the slot: the slot serialises recorded captures,
  // a slot held by test-full itself would deadlock the capture that spawns it, and load from
  // scoped runs, other projects and non-Sidequest processes would still go unserialised. The
  // in-test waits instead scale with the measured load (capacityScaledDeadlineMilliseconds), which
  // covers foreign load whatever its source.
  const capture = preflight || (target && isFullSuiteCommand(command)
    ? await runFullSuiteCapture(command, project?.path || target.project, captureCwd, fileSystem, { ...options, beforeRun })
    : (beforeRun(), await runBudgetedCapture(command, captureCwd, (options.resolveBudget || captureBudget)(command), undefined, options.announce, options.detached)));
  const before = started.before || (target && !preflight ? treeSnapshot(captureCwd, true) : null);
  const recorded = target ? recordCapture(target, capture, captureCwd, resolution, binding?.ok ? binding.head : undefined, before) : null;
  return Object.freeze({ capture, recorded });
}

// SQ-76: HEAD is a commit pointer and says nothing about the working tree, so a
// capture bound to `git:<HEAD>` certified whatever the tree held when it ran: an
// uncommitted edit, or `git checkout <rev> -- <path>`, ran other code under
// HEAD's name. A capture now snapshots the tree before it runs and binds to what
// that snapshot shows. A clean tree binds to `git:<HEAD>` as before. A dirty tree
// binds to DIRTY_TREE_CANDIDATE_SOURCE, an identity of HEAD plus the exact
// modifications, which records the run (the sanctioned diagnostic path, e.g.
// "is base red?") but can never equal a submitted `git:<commit>` candidate, so
// it never satisfies the submit gate.
const DIRTY_TREE_CANDIDATE_SOURCE = 'git-dirty-tree';
type TreeSnapshot = Readonly<{
  head: string;
  status: readonly string[];
  tracked: readonly string[];
  // Set only on a snapshot taken with its identity, and only when the tree is dirty.
  dirtyCandidate?: Readonly<{ source: string; value: string }>;
}>;

function porcelainLines(output: string): string[] {
  // Porcelain lines are `XY path`; the status column can start with a space, so
  // the output is split untrimmed.
  return output.split('\n').filter((line) => line.trim());
}

// `withIdentity` hashes the modifications themselves; it is taken once, before
// the command runs, so the identity names the tree that started the run.
function treeSnapshot(cwd: string, withIdentity = false): TreeSnapshot | null {
  const head = (gitOutput(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']) || '').toLowerCase();
  if (!head) return null;
  const status = gitOutput(cwd, ['status', '--porcelain=v1', '--untracked-files=all'], true);
  if (status === null) return null;
  const lines = porcelainLines(status);
  const snapshot = { head, status: Object.freeze(lines), tracked: Object.freeze(lines.filter((line) => !line.startsWith('??'))) };
  return Object.freeze(withIdentity && lines.length ? { ...snapshot, dirtyCandidate: dirtyTreeCandidate(cwd, snapshot) } : snapshot);
}

function dirtyTreeCandidate(cwd: string, snapshot: Readonly<{ head: string; status: readonly string[] }>) {
  const hash = createHash('sha256').update(snapshot.head).update('\0').update(snapshot.status.join('\n')).update('\0');
  hash.update(gitOutput(cwd, ['diff', '--binary', 'HEAD'], true) || '');
  for (const line of snapshot.status) {
    if (!line.startsWith('??')) continue;
    const file = line.slice(3);
    try {
      hash.update('\0').update(file).update('\0').update(fs.readFileSync(path.join(cwd, file)));
    } catch (_) {
      hash.update('\0').update(file).update('\0unreadable');
    }
  }
  return Object.freeze({ source: DIRTY_TREE_CANDIDATE_SOURCE, value: `${snapshot.head}+${hash.digest('hex')}` });
}

function describeDirtyPaths(lines: readonly string[]): string {
  const paths = lines.map((line) => line.slice(3).trim()).filter(Boolean);
  return paths.slice(0, 10).join(', ') + (paths.length > 10 ? `, and ${paths.length - 10} more` : '');
}

function verifiedRevision(cwd: string) {
  try {
    const value = String(execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      // git's own "fatal: not a git repository" on a dead worktree used to land
      // on the wrapper's stderr, competing with the reason the caller is given.
      stdio: ['ignore', 'pipe', 'ignore'],
    })).trim().toLowerCase();
    return value ? Object.freeze({ source: 'git', value }) : null;
  } catch (_) {
    return null;
  }
}

// `boundRevision` is the HEAD an isolated dispatch's capture was bound to before
// it ran. The capture records that commit and nothing else: if HEAD moved while
// the command ran, the run is not recorded rather than certifying a commit that
// did not run.
//
// `before` is the tree the command started from (SQ-76). With it, a clean start
// binds to `git:<HEAD>` only if HEAD is unchanged and no tracked file differs
// from it once the command has finished, and a dirty start binds to the
// dirty-tree identity, which records the run without satisfying the gate.
// Untracked files that appear during the run are the run's own output and do
// not change the code that ran, so the after-check reads tracked files only.
function recordCapture(target: CaptureTarget, capture: VerifyCapture, cwd: string, resolved?: CaptureProjectResolution | null, boundRevision?: string, before?: TreeSnapshot | null) {
  const store = require('./store.js') as VerificationCaptureStore;
  const resolution = resolved || resolveCaptureProject(target);
  if (!resolution.ok) return { ok: false, reason: resolution.reason };
  const project = resolution.project;
  const ticket = store.getTicket(project.slug, target.ticket);
  const workingTreeCandidate = store.workingTreeDeliveryCandidate(project.slug, ticket);
  const bound = boundRevision || before?.head;
  if (!workingTreeCandidate && bound) {
    const after = treeSnapshot(cwd);
    if (after?.head !== bound) {
      return {
        ok: false,
        reason: `capture_candidate_moved: the capture for ${target.ticket} was bound to HEAD ${bound} in ${JSON.stringify(path.resolve(cwd))}, but HEAD there is ${after?.head || 'unresolvable'} now that the command has finished, so the run cannot be attributed to a single commit and was not recorded. Leave the worktree alone while the wrapper runs, then rerun it.`,
      };
    }
    if (before && !before.status.length && after.tracked.length) {
      return {
        ok: false,
        reason: `capture_candidate_dirtied: the capture for ${target.ticket} started from a clean tree at HEAD ${bound} in ${JSON.stringify(path.resolve(cwd))}, but tracked files there differ from HEAD now that the command has finished, so HEAD may not be the code that ran and the run was not recorded. Leave the worktree alone while the wrapper runs, restore the tree, then rerun it. Modified: ${describeDirtyPaths(after.tracked)}`,
      };
    }
  }
  const dirty = !workingTreeCandidate && before && before.status.length ? (before.dirtyCandidate || dirtyTreeCandidate(cwd, before)) : null;
  const candidate = workingTreeCandidate?.candidate || dirty || (bound ? Object.freeze({ source: 'git', value: bound }) : verifiedRevision(cwd));
  // A retired agent's worktree keeps its directory after its registration is
  // pruned, so git there resolves no HEAD. Name the checkout that failed rather
  // than the subsystem, so the next occurrence is read as worktree reuse.
  if (!candidate) {
    return {
      ok: false,
      reason: `verified_revision_unavailable: git resolved no HEAD commit in the verified checkout ${JSON.stringify(path.resolve(cwd))} for ${target.ticket} on board ${JSON.stringify(project.slug)}. That checkout is not a live Git worktree, which is what a retired agent's leftover worktree looks like once its registration is pruned; rerun the verify wrapper from the worktree this dispatch owns.`,
    };
  }
  return store.recordVerificationCapture(project.slug, target.ticket, {
    command: capture.command || '',
    status: capture.status,
    candidate,
    completedAt: new Date().toISOString(),
    worktree: cwd,
    logPath: capture.logPath,
    exitCode: capture.exitCode,
    shell: capture.shell,
    ...(capture.waitedForSlotMs === undefined ? {} : { waitedForSlotMs: capture.waitedForSlotMs }),
    ...(capture.queuePosition === undefined ? {} : { queuePosition: capture.queuePosition }),
  });
}

function report(capture: VerifyCapture, recorded?: CaptureRecordResult | null) {
  const reason = capture.reason ? ` reason=${JSON.stringify(capture.reason)}` : '';
  process.stdout.write(`verify=${capture.status} exit=${capture.exitCode ?? 2}${reason}\n`);
  process.stdout.write(`shell=${capture.shell || ''}\n`);
  process.stdout.write(`details=${capture.logPath || ''}\n`);
  if (capture.waitedForSlotMs !== undefined) {
    process.stdout.write(`capture-slot waitedForSlotMs=${capture.waitedForSlotMs} queuePosition=${capture.queuePosition || 1}\n`);
  }
  if (capture.budget) {
    const budget = capture.budget;
    process.stdout.write(`capture-budget class=${budget.budgetClass} budgetMs=${budget.timeoutMilliseconds} elapsedMs=${capture.elapsedMilliseconds ?? ''} setupMs=${budget.setupAllowanceMilliseconds} phaseMs=${budget.phaseBudgetMilliseconds} measuredPhaseMs=${budget.measuredPhaseBudgetMilliseconds} hardMaxMs=${budget.hardMaximumMilliseconds} cores=${budget.availableParallelism} load=${formatLoad(budget.loadAverage)} effectiveWorkers=${budget.effectiveTestWorkers.toFixed(2)} harnessTimeoutMs=${captureHarnessTimeoutMilliseconds(budget)}\n`);
  }
  if (recorded?.ok && recorded.capture) {
    process.stdout.write(`capture=${recorded.capture.id} candidate=${recorded.capture.candidate.source}:${recorded.capture.candidate.value}\n`);
    if (recorded.capture.candidate.source === DIRTY_TREE_CANDIDATE_SOURCE) {
      // SQ-76: agent-facing. A dirty-tree record is diagnostic evidence, never a gate pass.
      process.stdout.write(`capture-diagnostic: the tree had uncommitted changes when this command started, so this capture is bound to that dirty tree (${DIRTY_TREE_CANDIDATE_SOURCE}), not to any commit. It is recorded as evidence and can never satisfy the submit gate. To verify a candidate, commit it with the board commit tool, restore everything else, and rerun the wrapper on the clean tree.\n`);
    }
    if ((LOAD_ONLY_CAPTURE_STATUSES as readonly string[]).includes(capture.status)) {
      // SQ-179: agent-facing. Name the sanctioned exit so a load-only failure never ends in a hand ref edit.
      process.stdout.write(`capture-waiver: if this ${capture.status} came only from host load and reruns keep failing, do not hand-edit refs/sidequest; keep the claim, comment this capture's evidence, and ask the orchestrator to post "${CAPTURE_WAIVER_MARKER} capture=${recorded.capture.id} signature=${captureFailureSignature(capture)} authority=<who>; <reason and evidence>" on ${recorded.capture.ticket || 'the ticket'}, then resubmit this same candidate.\n`);
    }
  } else if (recorded) {
    process.stdout.write(`capture=unrecorded reason=${recorded.reason || 'unknown'}\n`);
    // SQ-203 (#20): the recorder's message names what differed; a bare reason left the
    // caller guessing. Skip it when the verify= line already carried the same text.
    if (recorded.message && recorded.message !== capture.reason) {
      process.stdout.write(`capture-detail=${JSON.stringify(recorded.message)}\n`);
    }
  }
}

// SQ-225: a capture's own budget (SQ-169) can legitimately run past the Bash tool's 600000ms
// ceiling: a full Rust suite under two concurrent executors took ~683s. Run attached, the
// harness kills the wrapper at that ceiling, the command dies with it, and nothing is recorded;
// backgrounded, its completion never wakes the executor. `--detach` starts the same wrapper as
// a detached child in its own process group and session, so killing the Bash call cannot reach
// it, and then waits for it in the foreground for a bounded time below the ceiling. A run that
// is still going prints `verify=running` with a `--resume` command, exits 75, and is waited on
// again by rerunning that command, so the capture keeps its own budget and still records itself.
const detachedRunsDirectoryName = 'sidequest-verify-capture-runs';
const detachedWaitDefaultMilliseconds = 540_000;
const detachedWaitMaximumMilliseconds = 570_000;
const detachedPollMilliseconds = 500;
const DETACHED_STILL_RUNNING_EXIT = 75;
type DetachedRun = Readonly<{ pid: number; startedAt: number; cwd: string }>;

function optionValue(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || '').trim() : '';
}

function detachedWaitMilliseconds(args: readonly string[]): number {
  const requested = optionValue(args, '--wait-ms');
  if (!/^\d+$/.test(requested)) return detachedWaitDefaultMilliseconds;
  return Math.min(detachedWaitMaximumMilliseconds, Number(requested));
}

// The arguments the detached child runs with: everything the caller passed except the
// detach-only options, plus where the child writes its exit status.
function detachedChildArguments(args: readonly string[], exitFile: string): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--detach') continue;
    if (args[index] === '--wait-ms' || args[index] === '--exit-file') { index += 1; continue; }
    kept.push(String(args[index]));
  }
  return [...kept, '--exit-file', exitFile];
}

function writeExitFile(exitFile: string, exitCode: number): void {
  if (!exitFile) return;
  const temporary = `${exitFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ exitCode, completedAt: new Date().toISOString() }));
  fs.renameSync(temporary, exitFile);
}

function startDetachedCapture(args: readonly string[], cwd: string): Readonly<{ runDirectory: string; pid: number }> {
  const { spawn } = require('node:child_process') as typeof import('node:child_process');
  const root = path.join(os.tmpdir(), detachedRunsDirectoryName);
  fs.mkdirSync(root, { recursive: true });
  const runDirectory = fs.mkdtempSync(path.join(root, 'run-'));
  const output = fs.openSync(path.join(runDirectory, 'output.log'), 'a');
  try {
    const child = spawn(process.execPath, [...process.execArgv, __filename, ...detachedChildArguments(args, path.join(runDirectory, 'exit.json'))], {
      cwd,
      env: process.env,
      detached: true,
      stdio: ['ignore', output, output],
      windowsHide: true,
    });
    if (!child.pid) throw new Error('the detached capture did not start');
    const run: DetachedRun = { pid: child.pid, startedAt: Date.now(), cwd };
    fs.writeFileSync(path.join(runDirectory, 'run.json'), JSON.stringify(run));
    child.unref();
    return Object.freeze({ runDirectory, pid: child.pid });
  } finally {
    fs.closeSync(output);
  }
}

function readDetachedRun(runDirectory: string): DetachedRun | null {
  try {
    const run = JSON.parse(fs.readFileSync(path.join(runDirectory, 'run.json'), 'utf8'));
    return Number.isInteger(run?.pid) && run.pid > 0 ? run : null;
  } catch (_) {
    return null;
  }
}

function readDetachedExit(runDirectory: string): number | null {
  try {
    const exit = JSON.parse(fs.readFileSync(path.join(runDirectory, 'exit.json'), 'utf8'));
    return Number.isInteger(exit?.exitCode) ? exit.exitCode : null;
  } catch (_) {
    return null;
  }
}

function detachedOutput(runDirectory: string): string {
  try {
    return fs.readFileSync(path.join(runDirectory, 'output.log'), 'utf8');
  } catch (_) {
    return '';
  }
}

function resumeCommand(runDirectory: string): string {
  return `node ${JSON.stringify(__filename)} --resume ${JSON.stringify(runDirectory)}`;
}

// Wait for a detached run in the foreground for at most `waitMilliseconds`. Returns the exit
// code this invocation should end with: the capture's own once it has finished, 2 when its
// process is gone without an exit status, or 75 while it is still running.
async function awaitDetachedCapture(runDirectory: string, waitMilliseconds: number, write: (text: string) => void = (text) => process.stdout.write(text)): Promise<number> {
  const run = readDetachedRun(runDirectory);
  if (!run) {
    write(`verify=lost exit=2 reason=${JSON.stringify(`detached_run_unknown: ${runDirectory} holds no detached verify-capture run record, so there is nothing to wait for. Start the wrapper again with --detach.`)}\n`);
    return 2;
  }
  const deadline = Date.now() + waitMilliseconds;
  for (;;) {
    const exitCode = readDetachedExit(runDirectory);
    if (exitCode !== null) {
      write(detachedOutput(runDirectory));
      return exitCode;
    }
    if (!captureSlotProcessLiveness.isAlive(run.pid, run.startedAt)) {
      // The exit status is written before the process ends; read it once more before calling the run lost.
      const lateExit = readDetachedExit(runDirectory);
      if (lateExit !== null) {
        write(detachedOutput(runDirectory));
        return lateExit;
      }
      write(detachedOutput(runDirectory));
      write(`verify=lost exit=2 reason=${JSON.stringify(`detached_run_lost: the detached verify-capture process ${run.pid} ended without writing an exit status, so the capture did not complete and nothing new was recorded by it. Its output is above. Start the wrapper again with --detach.`)}\n`);
      return 2;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(detachedPollMilliseconds, Math.max(1, deadline - Date.now()))));
  }
  const elapsed = Math.max(0, Date.now() - run.startedAt);
  write(`verify=running exit=${DETACHED_STILL_RUNNING_EXIT} pid=${run.pid} elapsedMs=${elapsed} run=${runDirectory}\n`);
  write(`verify-resume: the capture is still running detached under its own budget, and the Bash ceiling cannot stop it. Do not start another one. Rerun this in the FOREGROUND with a 600000 ms timeout until it prints a final verify= line: ${resumeCommand(runDirectory)}\n`);
  return DETACHED_STILL_RUNNING_EXIT;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--resume') {
    const runDirectory = String(args[1] || '').trim();
    process.exitCode = runDirectory ? await awaitDetachedCapture(path.resolve(runDirectory), detachedWaitMilliseconds(args)) : 2;
    if (!runDirectory) process.stderr.write('Usage: node verify-capture.js --resume <run directory> [--wait-ms <milliseconds>]\n');
    return;
  }
  const encoded = args[0] === '--base64' ? args[1] : '';
  const command = encoded ? Buffer.from(encoded, 'base64').toString('utf8').trim() : '';
  if (!command) {
    process.stderr.write('Usage: node verify-capture.js --base64 <base64 verify command> [--project <path> --ticket <ref>] [--detach [--wait-ms <milliseconds>]]\n       node verify-capture.js --resume <run directory> [--wait-ms <milliseconds>]\n');
    process.exitCode = 2;
    return;
  }
  if (args.includes('--detach')) {
    const { runDirectory, pid } = startDetachedCapture(args, process.cwd());
    process.stderr.write(`verify-capture: detached run ${runDirectory} pid=${pid}; waiting up to ${detachedWaitMilliseconds(args)}ms in the foreground.\n`);
    process.exitCode = await awaitDetachedCapture(runDirectory, detachedWaitMilliseconds(args));
    return;
  }
  const exitFile = optionValue(args, '--exit-file');
  try {
    const target = captureTarget(args);
    const { capture, recorded } = await runCapturedVerification(command, target, process.cwd(), fs, {
      announce: (line) => process.stderr.write(`${line}\n`),
      detached: Boolean(exitFile),
    });
    report(capture, recorded);
    process.exitCode = capture.exitCode === 0 && (!target || recorded?.ok) ? 0 : 2;
  } catch (error: unknown) {
    process.stdout.write(`verify=error exit=2 reason=${JSON.stringify(String((error as Error)?.message || error))}\n`);
    process.exitCode = 2;
  }
  writeExitFile(exitFile, Number(process.exitCode));
}

module.exports = { awaitDetachedCapture, detachedChildArguments, DETACHED_STILL_RUNNING_EXIT, runVerifyCapture, runCapturedVerification, shellCommand, captureTarget, captureProject, resolveCaptureProject, captureSlotDirectory, acquireCaptureSlot, isFullSuiteCommand, isTestSuiteCommand, captureBudgetClass, captureBudget, captureHardMaximumMilliseconds, captureHarnessTimeoutMilliseconds, captureHarnessGuidance, runBudgetedCapture, fullSuiteCaptureTimeoutMilliseconds, effectiveTestWorkers, capacityScaledDeadlineMilliseconds, recordCapture, verifiedRevision };

if (require.main === module) void main();
