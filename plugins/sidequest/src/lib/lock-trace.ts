// Opt-in measurement of SQLite write-lock contention on the machine-global board (US-4, SQ-262).
//
// The board database is one file for every project, and SQLite's write lock is file-granular: any
// project's writer blocks every other project's writers, including hooks with a 10s external deadline
// (see SqliteBusyPolicy in db.ts). Deciding whether that warrants splitting the file per project needs
// numbers, not intuition, so this module records two things and nothing else:
//
//   wait  - how long a board statement spent getting through retryWhenSqliteBusy, how many attempts it
//           took, and whether it ever saw SQLITE_BUSY/SQLITE_LOCKED.
//   hold  - how long this process held BEGIN IMMEDIATE inside txn(), from the moment that statement
//           returned to the moment COMMIT or ROLLBACK returned.
//
// Three deliberate properties:
//
//  1. Off unless SIDEQUEST_LOCK_TRACE says otherwise. db.ts sits on the hot path of every hook in every
//     session across every registered project, so when the variable is unset every seam costs one
//     function call that reads a cached module variable and returns null. Nothing is resolved, nothing
//     is opened, nothing is written, and this module requires nothing beyond node:* at load.
//  2. Records go to a JSONL file, never into sidequest.db. Writing a measurement through the very lock
//     being measured would both perturb and deadlock-prone the thing under test.
//  3. Records are buffered and flushed only once the outermost retry frame releases (or on process
//     exit, or when a spent lock budget makes the next moment uncertain). A synchronous append from
//     inside an open BEGIN IMMEDIATE would add this module's own file IO to the hold time it is
//     supposed to be measuring.
//
// Durations come from performance.now(), a monotonic clock. Date.now() is wall clock: an NTP step or a
// DST change during a 15s wait would report a negative or wildly inflated duration, and the busySleep
// Atomics.wait in db.ts blocks the thread synchronously across exactly that kind of window. The `at`
// field is wall clock on purpose, for a human reading the log, and is never used for a duration.
//
// Reading the log back: `node plugins/sidequest/lib/lock-trace.js [<file>] [--json]` prints per-operation
// and per-policy-label counts, p50/p95/max wait, max hold, and how many calls actually blocked.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { resolveSidequestHome } from './claude-home.js';

/**
 * The single gate. Unset or a falsey word turns tracing off. `1`/`true`/`on`/`yes` turns it on and
 * writes beside the board database. Any other value is taken as the destination file path, which is
 * how a test or a one-off session traces somewhere other than the shared board root.
 */
export const LOCK_TRACE_ENV = 'SIDEQUEST_LOCK_TRACE';
export const LOCK_TRACE_FILENAME = 'lock-trace.jsonl';

const OFF_VALUES = new Set(['', '0', 'false', 'off', 'no']);
const ON_VALUES = new Set(['1', 'true', 'on', 'yes']);
// A bound on how many records may sit unflushed. One transaction runs a bounded number of statements and
// the buffer drains whenever the outermost retry frame releases, so this only matters if a caller somehow
// never unwinds: correctness of the log beats keeping the hold measurement pristine in that case.
const PENDING_RECORD_LIMIT = 1_024;

export type LockWaitOutcome =
  /** The statement got through. It may still have waited; `blocked` and `waitMs` say whether it did. */
  | 'clear'
  /** The lock budget ran out. This is the event US-4 exists to count: a hook failing open, or a refusal. */
  | 'exhausted'
  /** The statement raised something that is not a lock error (a constraint violation, say). */
  | 'failed'
  /** Control left the retry frame without settling it. `attempts` is 0 because it is unknown. */
  | 'abandoned';

export interface LockWaitRecord {
  kind: 'wait';
  /** Wall clock, for reading the log. Never a duration. */
  at: string;
  pid: number;
  /** SqliteBusyPolicy.label: `server` for an ordinary writer, `hook` for a short external deadline. */
  policy: string;
  /** Board slug of this process's ambient project, or null when it could not be resolved. */
  project: string | null;
  /** The human-readable label retryWhenSqliteBusy was given, e.g. `writing tickets`. */
  operation: string;
  /** Enclosing retry frames already open when this one started; 0 is outermost. See `nested` below. */
  depth: number;
  waitMs: number;
  attempts: number;
  /** True when at least one attempt saw SQLITE_BUSY/SQLITE_LOCKED. */
  blocked: boolean;
  outcome: LockWaitOutcome;
}

export interface LockHoldRecord {
  kind: 'hold';
  at: string;
  pid: number;
  policy: string;
  project: string | null;
  /** The label of the retry frame that owns this BEGIN IMMEDIATE. */
  operation: string;
  /** Depth of that owning frame, so a hold lines up with its own wait record rather than its children. */
  depth: number;
  holdMs: number;
  outcome: 'commit' | 'rollback';
}

export type LockTraceRecord = LockWaitRecord | LockHoldRecord;

interface LockTraceConfig {
  readonly file: string;
}

// `undefined` means "not resolved yet"; `null` means "resolved, and tracing is off".
let config: LockTraceConfig | null | undefined;
let broken = false;
let projectSlug: string | null | undefined;
let sinkFd: number | null = null;
let sinkFile: string | null = null;
let exitFlushInstalled = false;
let waitDepth = 0;
const pending: string[] = [];

function resolveConfig(env: NodeJS.ProcessEnv): LockTraceConfig | null {
  const raw = String(env[LOCK_TRACE_ENV] ?? '').trim();
  const word = raw.toLowerCase();
  if (OFF_VALUES.has(word)) return null;
  if (ON_VALUES.has(word)) return { file: path.join(resolveSidequestHome(env), LOCK_TRACE_FILENAME) };
  return { file: path.resolve(raw) };
}

function lockTraceConfig(): LockTraceConfig | null {
  if (broken) return null;
  if (config === undefined) config = resolveConfig(process.env);
  return config;
}

/** The file tracing writes to, or null when the gate is off. */
export function lockTracePath(): string | null {
  return lockTraceConfig()?.file ?? null;
}

export function lockTraceEnabled(): boolean {
  return lockTraceConfig() !== null;
}

/** Where the report CLI looks when nothing names a file and the gate is off in this process. */
export function defaultLockTracePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveSidequestHome(env), LOCK_TRACE_FILENAME);
}

// The slug is the process's ambient project, resolved exactly as every other caller resolves it
// (CLAUDE_PROJECT_DIR or cwd, walked up to the owning repo root). retryWhenSqliteBusy is handed a
// statement, not a project, so this is process-level attribution: it is right for a hook or an MCP
// server, which serve one board, and it does not see a CLI invocation's `--project` override. That is
// enough for the question being asked, which is which project's processes starve which.
function traceProject(): string | null {
  if (projectSlug !== undefined) return projectSlug;
  projectSlug = null;
  try {
    const { createPaths } = require('./store/paths.js') as {
      createPaths(dependencies: { fs: typeof fs; os: typeof os; path: typeof path; crypto: typeof crypto }): {
        nearestRepoRoot(startDir?: string): string;
        slugify(absolutePath?: string): string;
      };
    };
    const paths = createPaths({ fs, os, path, crypto });
    projectSlug = paths.slugify(paths.nearestRepoRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd()));
  } catch (_) {
    projectSlug = null;
  }
  return projectSlug;
}

function closeSink(): void {
  if (sinkFd === null) return;
  try {
    fs.closeSync(sinkFd);
  } catch (_) {
    // The fd is being abandoned either way.
  }
  sinkFd = null;
  sinkFile = null;
}

// Tracing is a diagnostic. A sink it cannot write to must never take the board down with it, so the
// first failure turns tracing off for the rest of the process and says so once on stderr.
function breakTrace(what: string, error: unknown): void {
  broken = true;
  config = null;
  pending.length = 0;
  closeSink();
  const detail = error instanceof Error ? error.message : String(error);
  try {
    fs.writeSync(2, `sidequest: lock tracing turned itself off after failing to ${what}: ${detail}\n`);
  } catch (_) {
    // Diagnostics only.
  }
}

/**
 * Append every buffered record. Called when the outermost retry frame releases, when a lock budget is
 * spent, at process exit, and by the report CLI; safe to call at any time.
 */
export function flushLockTrace(): void {
  if (!pending.length) return;
  const active = lockTraceConfig();
  if (!active) {
    pending.length = 0;
    return;
  }
  const payload = Buffer.from(pending.join(''), 'utf8');
  pending.length = 0;
  try {
    if (sinkFd === null || sinkFile !== active.file) {
      closeSink();
      fs.mkdirSync(path.dirname(active.file), { recursive: true });
      // O_APPEND: every writer on the machine shares this file, and an append-mode write places itself
      // at the current end atomically, so whole records from different pids interleave but never split.
      sinkFd = fs.openSync(active.file, 'a');
      sinkFile = active.file;
    }
    let written = 0;
    while (written < payload.length) {
      written += fs.writeSync(sinkFd, payload, written, payload.length - written);
    }
  } catch (error) {
    breakTrace(`append to ${active.file}`, error);
  }
}

// Called before any clock is read, so the one-time costs of tracing (installing the exit flush, walking
// up to the repo root for the project slug) land outside every duration this module reports rather than
// inflating whichever statement happened to be measured first.
function activate(): void {
  traceProject();
  // The exit listener is a one-per-process concern, so resetLockTrace deliberately leaves it installed
  // rather than registering a second one on the next activation.
  if (exitFlushInstalled) return;
  exitFlushInstalled = true;
  process.once('exit', () => {
    try {
      flushLockTrace();
    } catch (_) {
      // The process is leaving regardless.
    }
  });
}

function emit(record: LockTraceRecord): void {
  pending.push(`${JSON.stringify(record)}\n`);
  if (pending.length >= PENDING_RECORD_LIMIT) flushLockTrace();
}

function round(milliseconds: number): number {
  return Math.round(milliseconds * 1_000) / 1_000;
}

export interface LockWaitProbe {
  /** Settles this frame with what actually happened. Only the first call records. */
  finish(outcome: LockWaitOutcome, attempts: number): void;
  /** Unwinds the frame from a `finally`, recording an `abandoned` wait if nothing settled it. */
  release(): void;
}

export interface LockHoldProbe {
  finish(outcome: 'commit' | 'rollback'): void;
}

/**
 * Start measuring one retryWhenSqliteBusy frame. Returns null when tracing is off, which is the whole
 * of the disabled-path cost: callers write `probe?.finish(...)`.
 */
export function beginLockWait(operation: string, policy: string): LockWaitProbe | null {
  if (!lockTraceConfig()) return null;
  activate();
  const depth = waitDepth;
  waitDepth += 1;
  const startedAt = performance.now();
  let finished = false;
  const finish = (outcome: LockWaitOutcome, attempts: number): void => {
    if (finished) return;
    finished = true;
    emit({
      kind: 'wait',
      at: new Date().toISOString(),
      pid: process.pid,
      policy,
      project: traceProject(),
      operation,
      depth,
      waitMs: round(performance.now() - startedAt),
      attempts,
      // A retry only ever follows a busy error, and only a busy error can exhaust the budget, so these
      // two facts are exactly "some attempt saw SQLITE_BUSY" without db.ts reporting it separately.
      blocked: attempts > 1 || outcome === 'exhausted',
      outcome,
    });
    // onExhausted lets a hook process.exit() immediately, so this record cannot wait for the unwind.
    if (outcome === 'exhausted') flushLockTrace();
  };
  return {
    finish,
    release(): void {
      finish('abandoned', 0);
      waitDepth = Math.max(0, waitDepth - 1);
      if (waitDepth === 0) flushLockTrace();
    },
  };
}

/**
 * Start measuring one held BEGIN IMMEDIATE. Call it immediately after that statement returns and finish
 * it immediately after COMMIT or ROLLBACK returns.
 */
export function beginLockHold(operation: string, policy: string): LockHoldProbe | null {
  if (!lockTraceConfig()) return null;
  activate();
  // The hold lives inside its owning retry frame, which has already counted itself.
  const depth = Math.max(0, waitDepth - 1);
  const startedAt = performance.now();
  let finished = false;
  return {
    finish(outcome: 'commit' | 'rollback'): void {
      if (finished) return;
      finished = true;
      emit({
        kind: 'hold',
        at: new Date().toISOString(),
        pid: process.pid,
        policy,
        project: traceProject(),
        operation,
        depth,
        holdMs: round(performance.now() - startedAt),
        outcome,
      });
    },
  };
}

/**
 * Flush, close the sink, and forget the resolved gate so the next call re-reads the environment. The
 * gate is cached because it sits on every board statement; a test that changes SIDEQUEST_LOCK_TRACE
 * calls this to make the change take effect.
 */
export function resetLockTrace(): void {
  flushLockTrace();
  closeSink();
  config = undefined;
  broken = false;
  projectSlug = undefined;
  waitDepth = 0;
}

/* ------------------------------------------------------------------ *
 *  Reporting
 * ------------------------------------------------------------------ */

export interface LockTraceGroupStats {
  key: string;
  waits: number;
  /** Waits recorded at depth > 0. Their elapsed time is already inside a parent's, so never sum waits. */
  nested: number;
  blocked: number;
  exhausted: number;
  failed: number;
  p50WaitMs: number;
  p95WaitMs: number;
  maxWaitMs: number;
  holds: number;
  maxHoldMs: number;
  rollbacks: number;
}

export interface LockTraceSummary {
  waits: number;
  holds: number;
  nested: number;
  blocked: number;
  exhausted: number;
  p50WaitMs: number;
  p95WaitMs: number;
  maxWaitMs: number;
  maxHoldMs: number;
  byOperation: LockTraceGroupStats[];
  byPolicy: LockTraceGroupStats[];
  pids: number[];
  projects: string[];
  firstAt: string | null;
  lastAt: string | null;
}

function isLockTraceRecord(value: unknown): value is LockTraceRecord {
  if (value === null || typeof value !== 'object') return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'wait' || kind === 'hold';
}

/** Parse a JSONL trace. Unparseable or foreign lines are counted, not thrown. */
export function readLockTraceRecords(file: string): { records: LockTraceRecord[]; skipped: number } {
  const records: LockTraceRecord[] = [];
  let skipped = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isLockTraceRecord(parsed)) records.push(parsed);
      else skipped += 1;
    } catch (_) {
      skipped += 1;
    }
  }
  return { records, skipped };
}

// Nearest-rank percentile: no interpolation, so every reported figure is a duration that was actually
// measured rather than an average of two that were not.
function percentile(sortedAscending: readonly number[], quantile: number): number {
  if (!sortedAscending.length) return 0;
  const rank = Math.min(sortedAscending.length - 1, Math.max(0, Math.ceil(quantile * sortedAscending.length) - 1));
  return sortedAscending[rank] ?? 0;
}

function groupStats(key: string, records: readonly LockTraceRecord[]): LockTraceGroupStats {
  const waits = records.filter((record): record is LockWaitRecord => record.kind === 'wait');
  const holds = records.filter((record): record is LockHoldRecord => record.kind === 'hold');
  const sortedWaits = waits.map((record) => record.waitMs).sort((left, right) => left - right);
  return {
    key,
    waits: waits.length,
    nested: waits.filter((record) => record.depth > 0).length,
    blocked: waits.filter((record) => record.blocked).length,
    exhausted: waits.filter((record) => record.outcome === 'exhausted').length,
    failed: waits.filter((record) => record.outcome === 'failed').length,
    p50WaitMs: percentile(sortedWaits, 0.5),
    p95WaitMs: percentile(sortedWaits, 0.95),
    maxWaitMs: sortedWaits.at(-1) ?? 0,
    holds: holds.length,
    maxHoldMs: holds.reduce((highest, record) => Math.max(highest, record.holdMs), 0),
    rollbacks: holds.filter((record) => record.outcome === 'rollback').length,
  };
}

function groupBy(records: readonly LockTraceRecord[], keyOf: (record: LockTraceRecord) => string): LockTraceGroupStats[] {
  const buckets = new Map<string, LockTraceRecord[]>();
  for (const record of records) {
    const key = keyOf(record);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(record);
    else buckets.set(key, [record]);
  }
  return [...buckets.entries()]
    .map(([key, bucket]) => groupStats(key, bucket))
    .sort((left, right) => right.blocked - left.blocked || right.maxWaitMs - left.maxWaitMs || left.key.localeCompare(right.key));
}

export function summarizeLockTrace(records: readonly LockTraceRecord[]): LockTraceSummary {
  const overall = groupStats('all', records);
  const timestamps = records.map((record) => record.at).filter((at) => typeof at === 'string').sort();
  return {
    waits: overall.waits,
    holds: overall.holds,
    nested: overall.nested,
    blocked: overall.blocked,
    exhausted: overall.exhausted,
    p50WaitMs: overall.p50WaitMs,
    p95WaitMs: overall.p95WaitMs,
    maxWaitMs: overall.maxWaitMs,
    maxHoldMs: overall.maxHoldMs,
    byOperation: groupBy(records, (record) => record.operation),
    byPolicy: groupBy(records, (record) => record.policy),
    pids: [...new Set(records.map((record) => record.pid))].sort((left, right) => left - right),
    projects: [...new Set(records.map((record) => record.project ?? '(unresolved)'))].sort(),
    firstAt: timestamps[0] ?? null,
    lastAt: timestamps.at(-1) ?? null,
  };
}

function statsTable(title: string, rows: readonly LockTraceGroupStats[]): string {
  const header = ['waits', 'blocked', 'exhausted', 'p50ms', 'p95ms', 'maxms', 'holds', 'maxholdms', title];
  const body = rows.map((row) => [
    String(row.waits),
    String(row.blocked),
    String(row.exhausted),
    String(row.p50WaitMs),
    String(row.p95WaitMs),
    String(row.maxWaitMs),
    String(row.holds),
    String(row.maxHoldMs),
    row.key,
  ]);
  const widths = header.map((cell, column) => Math.max(cell.length, ...body.map((line) => (line[column] ?? '').length)));
  const render = (cells: readonly string[]): string => cells
    .map((cell, column) => (column === cells.length - 1 ? cell : cell.padStart(widths[column] ?? cell.length)))
    .join('  ')
    .trimEnd();
  return [render(header), ...body.map(render)].join('\n');
}

export function formatLockTraceReport(summary: LockTraceSummary, options: { file: string; skipped?: number }): string {
  const lines = [
    `lock trace: ${options.file}`,
    `window: ${summary.firstAt ?? '(none)'} .. ${summary.lastAt ?? '(none)'}`,
    `pids: ${summary.pids.length} | projects: ${summary.projects.join(', ') || '(none)'}`,
    '',
    `waits: ${summary.waits} (${summary.nested} nested inside another wait, so wait time is not additive)`,
    `blocked: ${summary.blocked} wait${summary.blocked === 1 ? '' : 's'} hit SQLITE_BUSY at least once`,
    `budget exhausted: ${summary.exhausted} (a hook failing open, or a refused write)`,
    `wait ms: p50 ${summary.p50WaitMs} | p95 ${summary.p95WaitMs} | max ${summary.maxWaitMs}`,
    `holds: ${summary.holds} | max hold ms ${summary.maxHoldMs}`,
  ];
  if (options.skipped) lines.push(`unparsed lines: ${options.skipped}`);
  lines.push('', statsTable('operation', summary.byOperation), '', statsTable('policy', summary.byPolicy));
  return `${lines.join('\n')}\n`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`Usage: node lock-trace.js [<trace.jsonl>] [--json]\n\nSummarises a Sidequest board lock trace. Collect one by running the board with\n${LOCK_TRACE_ENV}=1 (writes <board root>/${LOCK_TRACE_FILENAME}) or ${LOCK_TRACE_ENV}=/path/to/trace.jsonl.\n`);
    return;
  }
  const file = argv.find((argument) => !argument.startsWith('-')) || lockTracePath() || defaultLockTracePath();
  let parsed: { records: LockTraceRecord[]; skipped: number };
  try {
    parsed = readLockTraceRecords(file);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`No lock trace to read at ${file}: ${detail}\nCollect one by setting ${LOCK_TRACE_ENV}=1 (or to a file path) for the processes you want measured.\n`);
    process.exitCode = 2;
    return;
  }
  const summary = summarizeLockTrace(parsed.records);
  process.stdout.write(json
    ? `${JSON.stringify({ file, skipped: parsed.skipped, ...summary }, null, 2)}\n`
    : formatLockTraceReport(summary, { file, skipped: parsed.skipped }));
}

if (require.main === module) main();
