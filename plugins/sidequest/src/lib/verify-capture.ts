'use strict';

import type { VerificationResult } from './kernel/verification.js';

const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const { createHash, randomUUID } = require('node:crypto') as typeof import('node:crypto');
const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
const { defaultVerificationTimeoutMilliseconds, runProcessVerification, shellCommand } = require('./ports/process.js') as typeof import('./ports/process.js');

type CaptureSlotFileSystem = Pick<typeof fs, 'existsSync' | 'mkdirSync' | 'readdirSync' | 'renameSync' | 'rmSync' | 'writeFileSync'>;

const captureSlotTimeoutMilliseconds = 30 * 60 * 1_000;
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

async function acquireCaptureSlot(project: string, timeoutMilliseconds = captureSlotTimeoutMilliseconds, fileSystem: CaptureSlotFileSystem = fs): Promise<CaptureSlotLease | CaptureSlotTimeout | CaptureSlotFailure> {
  const slotDirectory = captureSlotDirectory(project);
  const activeDirectory = path.join(slotDirectory, 'active');
  const startedAt = Date.now();
  const waiterPath = captureSlotWaiterPath(slotDirectory, fileSystem);
  const waiterName = path.basename(waiterPath);
  fileSystem.writeFileSync(waiterPath, '', { encoding: 'utf8', flag: 'wx' });
  let waitingAnnounced = false;
  let queuePosition = 1;
  let acquireContentionAttempts = 0;

  for (;;) {
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

function captureWorkingDirectory(target: CaptureTarget, cwd: string, project: CaptureProject | null): string {
  if (!project) return cwd;
  const store = require('./store.js') as VerificationCaptureStore;
  const ticket = store.getTicket(project.slug, target.ticket);
  return store.workingTreeDeliveryCandidate(project.slug, ticket) ? project.path : cwd;
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
  const captureCwd = target && !preflight ? captureWorkingDirectory(target, cwd, project) : cwd;
  const capture = preflight || (target && isFullSuiteCommand(command)
    ? await runFullSuiteCapture(command, project?.path || target.project, captureCwd, fileSystem)
    : await runVerifyCapture(command, captureCwd));
  const recorded = target ? recordCapture(target, capture, captureCwd, resolution) : null;
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

function recordCapture(target: CaptureTarget, capture: VerifyCapture, cwd: string, resolved?: CaptureProjectResolution | null) {
  const store = require('./store.js') as VerificationCaptureStore;
  const resolution = resolved || resolveCaptureProject(target);
  if (!resolution.ok) return { ok: false, reason: resolution.reason };
  const project = resolution.project;
  const ticket = store.getTicket(project.slug, target.ticket);
  const workingTreeCandidate = store.workingTreeDeliveryCandidate(project.slug, ticket);
  const candidate = workingTreeCandidate?.candidate || verifiedRevision(cwd);
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

module.exports = { runVerifyCapture, runCapturedVerification, shellCommand, captureTarget, captureProject, resolveCaptureProject, captureSlotDirectory, isFullSuiteCommand, fullSuiteCaptureTimeoutMilliseconds, recordCapture, verifiedRevision };

if (require.main === module) void main();
