'use strict';

import type { VerificationResult } from './kernel/verification.js';

const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const { createHash, randomUUID } = require('node:crypto') as typeof import('node:crypto');
const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
const { defaultVerificationTimeoutMilliseconds, runProcessVerification, shellCommand } = require('./ports/process.js') as typeof import('./ports/process.js');

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

function fullSuiteCaptureTimeoutMilliseconds(availableParallelism = os.availableParallelism(), loadAverage = os.loadavg()[0] || 0, rawOverride = process.env[phaseBudgetOverrideVariable]): number {
  const testConcurrency = Math.min(maximumTestConcurrency, Math.max(minimumTestConcurrency, availableParallelism));
  const otherRunnableThreads = typeof loadAverage === 'number' && Number.isFinite(loadAverage) && loadAverage > 0 ? loadAverage : 0;
  const effectiveTestWorkers = Math.min(
    testConcurrency,
    Math.max(minimumEffectiveTestWorkers, (availableParallelism * testConcurrency) / (testConcurrency + otherRunnableThreads)),
  );
  const measuredPhaseTimeoutMilliseconds = Math.min(
    maximumTestPhaseTimeoutMilliseconds,
    Math.round((baselineTestPhaseDurationMilliseconds * maximumTestConcurrency / effectiveTestWorkers) * testPhaseBudgetSafetyFactor),
  );
  const requested = typeof rawOverride === 'string' && /^\d+$/.test(rawOverride.trim()) ? Number(rawOverride.trim()) : 0;
  const phaseTimeoutMilliseconds = requested > measuredPhaseTimeoutMilliseconds ? requested : measuredPhaseTimeoutMilliseconds;
  return defaultVerificationTimeoutMilliseconds + phaseTimeoutMilliseconds;
}

type VerifyCapture = VerificationResult & Readonly<{
  exitCode: number | null;
  reason?: string;
  waitedForSlotMs?: number;
  queuePosition?: number;
}>;
type CaptureTarget = Readonly<{ project: string; ticket: string }>;
type CaptureRecordResult = Readonly<{
  ok: boolean;
  reason?: string;
  message?: string;
  capture?: Readonly<{ id: string; candidate: Readonly<{ source: string; value: string }> }>;
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

function isFullSuiteCommand(command: string): boolean {
  return /(?:^|[\s&;()])npm\s+run\s+test:full(?:\s|$)/.test(command);
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
      process.stdout.write(`verify-capture: waiting for ${siblingCount} sibling capture${siblingCount === 1 ? '' : 's'} to finish (queue position ${queuePosition}).\n`);
      waitingAnnounced = true;
    }
    const waitedForSlotMs = Date.now() - startedAt;
    if (waitedForSlotMs >= timeoutMilliseconds) {
      fileSystem.rmSync(waiterPath, { force: true });
      return Object.freeze({
        waitedForSlotMs,
        queuePosition,
        reason: `Verification capture waited ${waitedForSlotMs}ms for the per-host full-suite slot at queue position ${queuePosition}; sibling capture contention exceeded the ${timeoutMilliseconds}ms limit.`,
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

async function runFullSuiteCapture(command: string, project: string, cwd: string, fileSystem: CaptureSlotFileSystem = fs): Promise<VerifyCapture> {
  let slot: CaptureSlotLease | CaptureSlotTimeout | CaptureSlotFailure;
  try {
    slot = await acquireCaptureSlot(project, captureSlotTimeoutMilliseconds, fileSystem);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return captureSlotCouldNotRun(command, Object.freeze({
      reason: `Verification capture could not acquire its per-host full-suite slot: ${reason}`,
      errorCode: captureSlotErrorCode(error),
    }));
  }
  if ('reason' in slot) {
    return 'waitedForSlotMs' in slot ? captureSlotTimeout(command, slot) : captureSlotCouldNotRun(command, slot);
  }
  let capture: VerifyCapture;
  let releaseFailure: CaptureSlotFailure | null = null;
  try {
    capture = await runVerifyCapture(command, cwd, fullSuiteCaptureTimeoutMilliseconds(), {
      ...process.env,
      SIDEQUEST_FULL_SUITE_SIBLING_CAPTURE_COUNT: String(slot.queuePosition - 1),
    });
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

function pinnedCaptureCommand(target: CaptureTarget, project: CaptureProject | null): Readonly<{ ticket: unknown; command: string }> | null {
  if (!project) return null;
  try {
    const store = require('./store.js') as VerificationCaptureStore;
    const ticket: any = store.getTicket(project.slug, target.ticket);
    const requirement = ticket?.dispatch?.verificationRequirement
      || ticket?.dispatch?.lifecycleAttempt?.verificationRequirement
      || ticket?.lifecycleAttempt?.verificationRequirement;
    const command = typeof requirement?.command === 'string' ? requirement.command.trim() : '';
    return command ? Object.freeze({ ticket, command }) : null;
  } catch (_) {
    // The submission-time check remains authoritative when the wrapper cannot
    // read the dispatched pin, so an unavailable board never rejects a run.
    return null;
  }
}

function captureCommandMismatchMessage(ticket: any, pinnedCommand: string, capturedCommand: string): string {
  return `Verification capture for ${ticket.ref} must use its declared command pinned at dispatch. The command is matched verbatim and expected to run from the worktree root; preserve any \`cd ...\` segment in the pinned command rather than running it from a subdirectory.\nPinned command: ${JSON.stringify(pinnedCommand)}\nCaptured command: ${JSON.stringify(capturedCommand)}`;
}

function preflightCapture(command: string, target: CaptureTarget, project: CaptureProject | null): VerifyCapture | null {
  const pinned = pinnedCaptureCommand(target, project);
  if (!pinned || command.trim() === pinned.command) return null;
  const reason = captureCommandMismatchMessage(pinned.ticket, pinned.command, command);
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

async function runCapturedVerification(command: string, target: CaptureTarget | null, cwd = process.cwd(), fileSystem: CaptureSlotFileSystem = fs) {
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
  const capture = preflight || (target && isFullSuiteCommand(command)
    ? await runFullSuiteCapture(command, project?.path || target.project, captureCwd, fileSystem)
    : await runVerifyCapture(command, captureCwd));
  const recorded = target ? recordCapture(target, capture, captureCwd, resolution, binding?.ok ? binding.head : undefined) : null;
  return Object.freeze({ capture, recorded });
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
function recordCapture(target: CaptureTarget, capture: VerifyCapture, cwd: string, resolved?: CaptureProjectResolution | null, boundRevision?: string) {
  const store = require('./store.js') as VerificationCaptureStore;
  const resolution = resolved || resolveCaptureProject(target);
  if (!resolution.ok) return { ok: false, reason: resolution.reason };
  const project = resolution.project;
  const ticket = store.getTicket(project.slug, target.ticket);
  const workingTreeCandidate = store.workingTreeDeliveryCandidate(project.slug, ticket);
  if (!workingTreeCandidate && boundRevision) {
    const after = verifiedRevision(cwd);
    if (after?.value !== boundRevision) {
      return {
        ok: false,
        reason: `capture_candidate_moved: the capture for ${target.ticket} was bound to HEAD ${boundRevision} in ${JSON.stringify(path.resolve(cwd))}, but HEAD there is ${after?.value || 'unresolvable'} now that the command has finished, so the run cannot be attributed to a single commit and was not recorded. Leave the worktree alone while the wrapper runs, then rerun it.`,
      };
    }
  }
  const candidate = workingTreeCandidate?.candidate || (boundRevision ? Object.freeze({ source: 'git', value: boundRevision }) : verifiedRevision(cwd));
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
  if (recorded?.ok && recorded.capture) {
    process.stdout.write(`capture=${recorded.capture.id} candidate=${recorded.capture.candidate.source}:${recorded.capture.candidate.value}\n`);
  } else if (recorded) {
    process.stdout.write(`capture=unrecorded reason=${recorded.reason || 'unknown'}\n`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const encoded = args[0] === '--base64' ? args[1] : '';
  const command = encoded ? Buffer.from(encoded, 'base64').toString('utf8').trim() : '';
  if (!command) {
    process.stderr.write('Usage: node verify-capture.js --base64 <base64 verify command> [--project <path> --ticket <ref>]\n');
    process.exitCode = 2;
    return;
  }
  const target = captureTarget(args);
  const { capture, recorded } = await runCapturedVerification(command, target);
  report(capture, recorded);
  process.exitCode = capture.exitCode === 0 && (!target || recorded?.ok) ? 0 : 2;
}

module.exports = { runVerifyCapture, runCapturedVerification, shellCommand, captureTarget, captureProject, resolveCaptureProject, captureSlotDirectory, acquireCaptureSlot, isFullSuiteCommand, fullSuiteCaptureTimeoutMilliseconds, recordCapture, verifiedRevision };

if (require.main === module) void main();
