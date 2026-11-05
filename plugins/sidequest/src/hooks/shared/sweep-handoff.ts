import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveSidequestHome } from '../../lib/claude-home.js';
import { isSubagent, stringField, type HookInput } from './input.js';
import { pluginRoot } from './paths.js';

// The sweep removes worktrees, backs up dirty ones and prunes branches: dozens of
// git subprocesses plus recursive directory deletes. Its cost is bimodal — a few
// hundred ms when there is nothing to collect, ten seconds or more when there is —
// so awaiting it unbounded is what pushes SessionStart past the harness timeout,
// and a timed-out hook has its whole stdout discarded.
const DEFAULT_DEADLINE_MS = 2500;

export const DEFERRAL_NOTICE =
  'sidequest: worktree sweep exceeded its SessionStart budget and is still running in the background.';

export type SweepProgress = Readonly<{
  planned: number;
  removed: number;
  keptByReason: Readonly<Record<string, number>>;
  // How much of the candidate list this sweep has classified, and how much exists.
  // Without them the budget notice could not distinguish "assessed everything,
  // nothing to collect" from "assessed nothing yet", and reported the second as the
  // first while 81 worktrees sat resident (SQ-267).
  considered: number;
  total: number;
}>;

const EMPTY_SWEEP_PROGRESS: SweepProgress = { planned: 0, removed: 0, keptByReason: {}, considered: 0, total: 0 };

export const HANDOFF_FAILED_NOTICE =
  'sidequest: worktree sweep could not run, so stale agent worktrees were not collected this session.';

export function deadlineMs(): number {
  const raw = Number(process.env.SIDEQUEST_SWEEP_DEADLINE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DEADLINE_MS;
}

function stateDirectory(): string {
  const home = resolveSidequestHome();
  return path.join(home, 'sweep-reports');
}

export function reportFile(cwd: string): string {
  const key = crypto.createHash('sha1').update(path.resolve(cwd || '.')).digest('hex').slice(0, 16);
  return path.join(stateDirectory(), `${key}.json`);
}

function progressFile(cwd: string): string {
  return reportFile(cwd).replace(/\.json$/, '.progress.json');
}

function normalizedProgress(value: unknown): SweepProgress {
  if (!value || typeof value !== 'object') return EMPTY_SWEEP_PROGRESS;
  const record = value as { planned?: unknown; removed?: unknown; keptByReason?: unknown; considered?: unknown; total?: unknown };
  const count = (candidate: unknown) => Number.isFinite(Number(candidate)) && Number(candidate) >= 0 ? Math.floor(Number(candidate)) : 0;
  const keptByReason = Object.fromEntries(Object.entries(record.keptByReason || {})
    .map(([reason, amount]): [string, number] => [reason, count(amount)])
    .filter(([, amount]) => amount > 0));
  return {
    planned: count(record.planned),
    removed: count(record.removed),
    keptByReason,
    considered: count(record.considered),
    total: count(record.total),
  };
}

export function writeSweepProgress(cwd: string, progress: SweepProgress): void {
  try {
    fs.mkdirSync(stateDirectory(), { recursive: true });
    fs.writeFileSync(progressFile(cwd), JSON.stringify(normalizedProgress(progress)));
  } catch (_) {
    // A partial report must never block the detached cleanup worker.
  }
}

export function readSweepProgress(cwd: string): SweepProgress {
  try {
    return normalizedProgress(JSON.parse(fs.readFileSync(progressFile(cwd), 'utf8')));
  } catch (_) {
    return EMPTY_SWEEP_PROGRESS;
  }
}

function clearSweepProgress(cwd: string): void {
  try {
    fs.rmSync(progressFile(cwd), { force: true });
  } catch (_) {}
}

export function deferralNotice(cwd: string, progress: SweepProgress): string {
  const kept = Object.values(progress.keptByReason).reduce((total, count) => total + count, 0);
  const reasons = Object.entries(progress.keptByReason).map(([reason, count]) => `${reason} ${count}`).join(', ') || 'none';
  const command = `node "${pluginRoot()}/bin/sidequest.js" worktrees sweep --yes --project "${path.resolve(cwd || '.')}"`;
  // These are the counts at the moment the budget expired, not the sweep's
  // result: the detached child keeps collecting and reports on the next session
  // start. SQ-70's reporter read a deferred "planned 0, removed 0, skipped 0" as
  // proof that stale agent worktrees are never reaped, and spent the run chasing
  // that instead of the capture failure in front of them. The assessed count is
  // what makes that misreading avoidable: "assessed 0 of 81" says the zeros are a
  // starting position, where bare "planned 0" read as a verdict (SQ-267).
  return `${DEFERRAL_NOTICE} Progress at the ${deadlineMs()}ms budget, not a final result: assessed ${progress.considered} of ${progress.total} candidate worktrees, planned ${progress.planned}, removed ${progress.removed}, skipped ${kept} (${reasons}). The detached sweep keeps running and reports on the next session start. Finish it sooner with ${command}.`;
}

export function writeReport(cwd: string, notices: string[]): void {
  try {
    fs.mkdirSync(stateDirectory(), { recursive: true });
    fs.writeFileSync(reportFile(cwd), JSON.stringify({ notices, finishedAt: new Date().toISOString() }));
  } catch (_) {
    // A sweep report that cannot be persisted is not worth failing a session over.
  }
}

// Reads and clears whatever a previous background sweep left behind, so a deferred
// run reports on the next start instead of vanishing. null means no report was
// waiting, which is how a crashed sweep is told apart from a clean quiet one.
export function drainReport(cwd: string): string[] | null {
  const file = reportFile(cwd);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
  fs.rmSync(file, { force: true });
  clearSweepProgress(cwd);
  try {
    const parsed: unknown = JSON.parse(raw);
    const notices = (parsed as { notices?: unknown } | null)?.notices;
    return Array.isArray(notices) ? notices.map((notice) => String(notice)).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

function sweepCwd(data: HookInput): string {
  return stringField(data, 'cwd', 'project_dir', 'projectDir') || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

type WorkerOptions = Readonly<{ sessionId: string; env?: NodeJS.ProcessEnv }>;

function spawnSweepWorker(data: HookInput, cwd: string, options: WorkerOptions): ChildProcess {
  return spawn(process.execPath, [
    path.join(pluginRoot(), 'hooks', 'sweep-worktrees.js'),
    '--cwd', cwd,
    '--session', options.sessionId,
    // SQ-220: the child decides from these whether this start is a host restart, the only
    // start that may retire this session's unbound launches.
    '--source', stringField(data, 'source'),
    '--subagent', isSubagent(data) ? '1' : '0',
  ], { detached: true, stdio: 'ignore', windowsHide: true, ...(options.env ? { env: options.env } : {}) });
}

// Notices a finished background sweep left for the next session start, moved aside so a
// newer worker's report cannot overwrite them before anyone has read them (SQ-386).
function carriedFile(cwd: string): string {
  return reportFile(cwd).replace(/\.json$/, '.carried.json');
}

function readNotices(file: string): string[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const notices = (parsed as { notices?: unknown } | null)?.notices;
    return Array.isArray(notices) ? notices.map((notice) => String(notice)).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

export function drainCarried(cwd: string): string[] {
  const file = carriedFile(cwd);
  if (!fs.existsSync(file)) return [];
  const notices = readNotices(file);
  try {
    fs.rmSync(file, { force: true });
  } catch (_) {}
  return notices;
}

function carryPendingReport(cwd: string): void {
  const pending = drainReport(cwd);
  if (!pending || !pending.length) return;
  try {
    fs.mkdirSync(stateDirectory(), { recursive: true });
    fs.writeFileSync(carriedFile(cwd), JSON.stringify({ notices: [...readNotices(carriedFile(cwd)), ...pending] }));
  } catch (_) {
    // Losing a carried report is not worth failing session shutdown over.
  }
}

// A progress file with no report means a worker for this checkout is still running, and a
// second worker would race it over the same worktrees. The worker refreshes the file as it
// classifies candidates, so a progress file this old belongs to a worker that died.
function sweepInFlight(cwd: string): boolean {
  const staleAfterMs = 10 * 60 * 1000;
  let modified: number;
  try {
    modified = fs.statSync(progressFile(cwd)).mtimeMs;
  } catch (_) {
    return false;
  }
  return Date.now() - modified < staleAfterMs &&!fs.existsSync(reportFile(cwd));
}

// SQ-386: Claude Code gives SessionEnd a shutdown window far shorter than its declared
// timeout and cancels a hook still running when it closes. The inline sweep took seconds,
// so SessionEnd hands it to the same detached worker SessionStart uses and returns without
// waiting. The worker's report is drained by the next session start.
export function detachSweep(data: HookInput): string[] {
  const cwd = sweepCwd(data);
  if (sweepInFlight(cwd)) return [];
  carryPendingReport(cwd);
  writeSweepProgress(cwd, EMPTY_SWEEP_PROGRESS);
  // The ending session's id stays out of the worker: SessionEnd drops that session's
  // orphan-report state, and the next session start reports any orphan afresh.
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_SESSION_ID;
  try {
    const child = spawnSweepWorker(data, cwd, { sessionId: '', env });
    child.once('error', () => {});
    child.unref();
  } catch (_) {
    clearSweepProgress(cwd);
    return [HANDOFF_FAILED_NOTICE];
  }
  return [];
}

// Always runs the sweep in a detached child and waits only up to the deadline. The
// child owns the mutating work, so a slow sweep costs the session its deadline
// rather than its entire injected context.
export async function runSweep(data: HookInput): Promise<string[]> {
  const cwd = sweepCwd(data);
  const carried = [...drainCarried(cwd), ...(drainReport(cwd) || [])];
  const budget = deadlineMs();
  writeSweepProgress(cwd, EMPTY_SWEEP_PROGRESS);
  let child: ChildProcess;
  try {
    child = spawnSweepWorker(data, cwd, { sessionId: stringField(data, 'session_id', 'sessionId') });
  } catch (_) {
    clearSweepProgress(cwd);
    return [...carried, HANDOFF_FAILED_NOTICE];
  }

  const outcome = await new Promise<'exited' | 'deferred' | 'failed'>((resolve) => {
    if (budget === 0) return resolve('deferred');
    const timer = setTimeout(() => resolve('deferred'), budget);
    child.once('exit', () => { clearTimeout(timer); resolve('exited'); });
    child.once('error', () => { clearTimeout(timer); resolve('failed'); });
  });

  if (outcome === 'failed') {
    clearSweepProgress(cwd);
    return [...carried, HANDOFF_FAILED_NOTICE];
  }
  if (outcome === 'deferred') {
    child.unref();
    return [...carried, deferralNotice(cwd, readSweepProgress(cwd))];
  }
  const report = drainReport(cwd);
  return report === null ? [...carried, HANDOFF_FAILED_NOTICE] : [...carried, ...report];
}
