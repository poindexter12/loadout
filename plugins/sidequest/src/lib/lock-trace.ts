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
// Both carry a `caller` (SQ-269). db.ts only knows a statement's own label — `writing transaction` for
// every one of the control-plane paths SQ-263 named — so a trace built on that label alone can say how
// long the board waited but not who held the lock, which is the one thing SQ-264 has to decide on. The
// caller is therefore resolved HERE, at the same single seam, from a bounded stack walk taken only when
// tracing is on: see resolveAttribution. Instrumenting the 17 call sites and their transitive callers
// was explicitly ruled out, and would have had to be redone every time a new board writer appeared.
//
// Three deliberate properties:
//
//  1. Off unless SIDEQUEST_LOCK_TRACE says otherwise. db.ts sits on the hot path of every hook in every
//     session across every registered project, so when the variable is unset every seam costs one
//     function call that reads a cached module variable and returns null. Nothing is resolved, nothing
//     is opened, nothing is written, no stack is captured, and this module requires nothing beyond
//     node:* at load.
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
// Reading the log back: `node plugins/sidequest/lib/lock-trace.js [<file>] [--json]` prints per-caller,
// per-operation and per-policy-label counts, p50/p95/max wait, max hold, and how many calls blocked.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

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
/**
 * How many stack frames the caller walk asks V8 for. The seam is only a handful of frames below the
 * board function that owns the write, but a hold taken through a sweep or a lock helper sits deeper, so
 * this is generous rather than tight: the walk is bounded, happens once per outermost retry frame, and
 * never happens at all with tracing off.
 */
const CALLER_CAPTURE_FRAME_LIMIT = 32;
/** How many frames a record keeps, innermost first. Enough to show the path, small enough for JSONL. */
const CALLER_CHAIN_LIMIT = 5;
/** Recorded when the stack walk found nothing usable, so an unattributed wait is visible, not silent. */
export const UNATTRIBUTED_CALLER = '(unattributed)';
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
  /**
   * The board function this wait is attributed to, e.g. `prepareDispatch` — the outermost frame of the
   * store layer on the stack, not the statement that happened to be executing. A nested wait reports
   * the same caller as the frame enclosing it, so attribution never shifts to an inner statement.
   */
  caller: string;
  /** Up to CALLER_CHAIN_LIMIT frames, innermost first, as `name (file:line)`: how `caller` was reached. */
  callerStack: string[];
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
  /** The caller of that owning frame, so a hold is attributed exactly as its own wait record is. */
  caller: string;
  callerStack: string[];
  /** Depth of that owning frame, so a hold lines up with its own wait record rather than its children. */
  depth: number;
  holdMs: number;
  outcome: 'commit' | 'rollback';
}

export type LockTraceRecord = LockWaitRecord | LockHoldRecord;

interface LockTraceConfig {
  readonly file: string;
}

/** Who a retry frame is attributed to, resolved once for the outermost frame and inherited inwards. */
interface LockTraceAttribution {
  readonly caller: string;
  readonly callerStack: readonly string[];
}

// `undefined` means "not resolved yet"; `null` means "resolved, and tracing is off".
let config: LockTraceConfig | null | undefined;
let broken = false;
let projectSlug: string | null | undefined;
let sinkFd: number | null = null;
let sinkFile: string | null = null;
let exitFlushInstalled = false;
// One entry per currently-open retryWhenSqliteBusy frame, outermost first. It is the nesting depth and
// the attribution carrier in one: `openFrames.length` is what `depth` was counted from before SQ-269,
// and the top entry is the caller an inner statement or a hold inherits instead of walking its own
// stack. Frames are strictly LIFO because retryWhenSqliteBusy releases in a `finally`.
const openFrames: LockTraceAttribution[] = [];
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

/* ------------------------------------------------------------------ *
 *  Caller attribution (SQ-269)
 * ------------------------------------------------------------------ */

// The seam is db.ts plus this module. Frames in either are plumbing, never an answer to "who held the
// lock", so the walk skips them by directory and basename rather than by a hardcoded path: under tsx a
// frame reads `src/lib/db.ts` and in the built plugin `lib/db.js`, and both have to be recognised.
// Neither file is ever bundled (scripts/build.mjs builds lib/ and bin/ with bundle:false, and no hook
// bundle contains retryWhenSqliteBusy), so a frame's filename really does identify its module.
const seamDirectory = __dirname;
const seamModules = new Set(['db', 'lock-trace']);
// The board's data-access API: store.ts and everything under store/. Every caller SQ-263 ranked lives
// there — prepareDispatch in store/dispatch.ts, releaseTicket in store.ts, mergeProject in
// store/projects.ts, and so on — while the layers above it (mcp-*.ts, bin/*.ts, the hooks) are
// transport. So "the outermost store-layer frame" is exactly the board operation that took the lock,
// and it is a boundary rule rather than a list of function names that would rot.
const storeFacadePrefix = path.join(seamDirectory, 'store.');
const storeDirectoryPrefix = path.join(seamDirectory, 'store') + path.sep;

interface CapturedCallSite {
  getFileName(): string | null | undefined;
  getFunctionName(): string | null | undefined;
  getMethodName(): string | null | undefined;
  getLineNumber(): number | null | undefined;
}

interface CallerFrame {
  readonly name: string | null;
  readonly file: string;
  readonly line: number;
  readonly store: boolean;
}

/**
 * The V8 structured-stack API, used instead of parsing a formatted stack string: no string is built, and
 * a frame's file and function come back as themselves rather than as something to regex. Both globals it
 * borrows are restored in the `finally`, and the borrow is synchronous, so no other formatter can
 * observe it. A host without the API leaves attribution unresolved instead of failing a board write.
 */
function captureCallSites(): readonly CapturedCallSite[] {
  const previousPrepare = Error.prepareStackTrace;
  const previousLimit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = CALLER_CAPTURE_FRAME_LIMIT;
    Error.prepareStackTrace = (_error, callSites) => callSites;
    const holder: { stack?: unknown } = {};
    // Everything from captureCallSites inwards is elided, so the walk starts at this module's own caller.
    Error.captureStackTrace(holder, captureCallSites);
    const captured: unknown = holder.stack;
    return Array.isArray(captured) ? (captured as CapturedCallSite[]) : [];
  } catch (_) {
    return [];
  } finally {
    Error.prepareStackTrace = previousPrepare;
    Error.stackTraceLimit = previousLimit;
  }
}

function frameFile(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith('file://')) return raw;
  try {
    return fileURLToPath(raw);
  } catch (_) {
    return null;
  }
}

function isPlumbingFrame(file: string): boolean {
  if (file.startsWith('node:') || file.includes(`${path.sep}node_modules${path.sep}`)) return true;
  if (path.dirname(file) !== seamDirectory) return false;
  return seamModules.has(path.basename(file).replace(/\.[cm]?[jt]s$/, ''));
}

// Relative to src/lib or lib, so a chain entry reads `store/dispatch.js` and not an absolute path that
// differs per checkout. A frame from outside that tree (a test file, a bin script) keeps its basename.
function frameLocation(file: string, line: number): string {
  const relative = path.relative(seamDirectory, file);
  const shown = !relative || relative.startsWith('..') ? path.basename(file) : relative;
  return `${shown}:${line}`;
}

/**
 * Walk the stack once and decide who this retry frame belongs to.
 *
 * `caller` is the OUTERMOST store-layer frame with a name, which is the board operation that owns the
 * write rather than whichever statement inside it reached db.ts. Falling back outwards: the outermost
 * named frame of any module (a caller that bypasses the store layer still gets a name), then the
 * innermost frame's location, then UNATTRIBUTED_CALLER. `callerStack` carries the innermost few frames
 * regardless, so a reader can always see whether the boundary rule picked the frame they expected.
 */
function resolveAttribution(): LockTraceAttribution {
  const frames: CallerFrame[] = [];
  for (const site of captureCallSites()) {
    const file = frameFile(site.getFileName());
    if (!file || isPlumbingFrame(file)) continue;
    frames.push({
      name: site.getFunctionName() || site.getMethodName() || null,
      file,
      line: site.getLineNumber() ?? 0,
      store: file.startsWith(storeDirectoryPrefix) || file.startsWith(storeFacadePrefix),
    });
  }
  let outermostNamedStore: CallerFrame | null = null;
  let outermostNamed: CallerFrame | null = null;
  for (const frame of frames) {
    if (!frame.name) continue;
    outermostNamed = frame;
    if (frame.store) outermostNamedStore = frame;
  }
  const chosen = outermostNamedStore ?? outermostNamed;
  const innermost = frames[0];
  // The chain is the innermost frames, but the chosen frame is usually outside that window, and a record
  // whose chain never shows the frame it named cannot be checked by eye. So reserve the last slot for it.
  const chain = frames.slice(0, CALLER_CHAIN_LIMIT);
  if (chosen && !chain.includes(chosen)) chain.splice(CALLER_CHAIN_LIMIT - 1, 1, chosen);
  return {
    caller: chosen?.name ?? (innermost ? frameLocation(innermost.file, innermost.line) : UNATTRIBUTED_CALLER),
    callerStack: chain.map((frame) => `${frame.name ?? '<anonymous>'} (${frameLocation(frame.file, frame.line)})`),
  };
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
  const depth = openFrames.length;
  // Only the outermost frame walks the stack. An inner statement inherits its enclosing frame's caller,
  // which is what keeps attribution on the outermost meaningful frame (SQ-269) instead of drifting to
  // whichever `putRow` happened to run inside the transaction — and means one walk per transaction, not
  // one per statement. The walk is deliberately taken BEFORE the clock below, like traceProject(), so
  // its cost lands outside the wait it is about to measure.
  const attribution = openFrames[depth - 1] ?? resolveAttribution();
  openFrames.push(attribution);
  const startedAt = performance.now();
  let finished = false;
  let released = false;
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
      caller: attribution.caller,
      callerStack: [...attribution.callerStack],
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
      // Guarded, because the frame stack is now what `depth` and inherited attribution are read from:
      // a double release would pop someone else's frame, not just undercount a counter.
      if (released) return;
      released = true;
      finish('abandoned', 0);
      openFrames.pop();
      if (openFrames.length === 0) flushLockTrace();
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
  // The hold lives inside its owning retry frame, which has already counted itself and already resolved
  // who it belongs to. Reusing that attribution keeps a hold and its wait reporting the same caller, and
  // avoids a second stack walk from inside the BEGIN IMMEDIATE this probe exists to measure. The
  // fallback walk only matters if tracing was switched on between the enclosing retry frame and here.
  const depth = Math.max(0, openFrames.length - 1);
  const attribution = openFrames[openFrames.length - 1] ?? resolveAttribution();
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
        caller: attribution.caller,
        callerStack: [...attribution.callerStack],
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
  openFrames.length = 0;
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
  /**
   * The breakdown US-4 reads first: which board function's waits and holds these were (SQ-269). Note
   * that a caller's `waits` counts the statements nested inside its transaction as well as the
   * transaction itself, which is why `nested` is reported beside it and wait times are never summed.
   */
  byCaller: LockTraceGroupStats[];
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
    // `|| UNATTRIBUTED_CALLER` rather than a plain read: a log collected before SQ-269 has no caller
    // field at all, and the report has to summarise it instead of grouping everything under `undefined`.
    byCaller: groupBy(records, (record) => record.caller || UNATTRIBUTED_CALLER),
    byOperation: groupBy(records, (record) => record.operation),
    byPolicy: groupBy(records, (record) => record.policy),
    pids: [...new Set(records.map((record) => record.pid))].sort((left, right) => left - right),
    projects: [...new Set(records.map((record) => record.project ?? '(unresolved)'))].sort(),
    firstAt: timestamps[0] ?? null,
    lastAt: timestamps.at(-1) ?? null,
  };
}

function statsTable(title: string, rows: readonly LockTraceGroupStats[]): string {
  // `nested` is printed because the caller table attributes a transaction's inner statements to the same
  // caller as the transaction: without it, one dispatch looks like forty waits.
  const header = ['waits', 'nested', 'blocked', 'exhausted', 'p50ms', 'p95ms', 'maxms', 'holds', 'maxholdms', title];
  const body = rows.map((row) => [
    String(row.waits),
    String(row.nested),
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
  // Caller first: "how long did the board wait" is answered by the lines above, "who held the lock" only
  // by this table, and the second question is the one a split-or-not decision turns on.
  lines.push('', statsTable('caller', summary.byCaller), '', statsTable('operation', summary.byOperation), '', statsTable('policy', summary.byPolicy));
  return `${lines.join('\n')}\n`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`Usage: node lock-trace.js [<trace.jsonl>] [--json]\n\nSummarises a Sidequest board lock trace, broken down by the board function that held\nthe lock, then by statement, then by lock policy. Collect one by running the board with\n${LOCK_TRACE_ENV}=1 (writes <board root>/${LOCK_TRACE_FILENAME}) or ${LOCK_TRACE_ENV}=/path/to/trace.jsonl.\n`);
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
