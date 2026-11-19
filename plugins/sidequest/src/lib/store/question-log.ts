// SQ-415 (US-8 Q1): the per-project question log. Executors' questions for the user and the
// user's answers live here, never as board records (US-8 D5). The board keeps only a ticket's
// park state and one short park/unpark comment; everything a question says lives in this log.
//
// Layout, under <SIDEQUEST_HOME>/projects/<slug>/questions/ (plan.md §2.1):
//   questions.jsonl                 the active segment, one JSON event per line
//   questions-<UTCstamp>.jsonl      archived segments, closed by rotation
//   index-questions-<UTCstamp>.json a one-time summary of each archived segment
//   fold.json                       the active segment's folded state (an index, not a source)
//   append.lock/                    the log's own mkdir lock
//   bodies/<aid>.txt                answer bodies too long to sit inline on their line
//
// Rules this module enforces (plan.md §2.2):
//   - Every append runs under append.lock/ (src/lib/mkdir-lock.ts): one open, one write of the
//     whole buffer, close. It is never the board lock, and nothing here imports the store, so
//     question traffic never queues behind board work such as assemble-wave.
//   - Readers take no lock. They ignore a trailing line with no newline (a write in progress or
//     a torn one), and skip and count lines that fail to parse or carry an unknown `v`.
//   - The next writer repairs a torn tail by terminating it with a newline before its own line,
//     so the fragment becomes one skipped, counted line instead of corrupting the next event.
//   - The first `answered` line per qid in file order wins. A later one replaces it only when it
//     names the winner in `supersedes`.
//   - fold.json caches {segment, inode, offset, open, recent}. A reader whose segment still has
//     the same inode, at least `offset` bytes and the same leading bytes parses only the new
//     bytes; anything else refolds from scratch.
//   - Rotation runs under the lock at 1 MiB or on the first append of a new UTC month. The new
//     segment opens with a `carried` line for every open or undelivered question, so the active
//     segment alone is always complete. An undelivered answer older than the retention window is
//     not carried: an answer nobody will ever collect must not ride every segment forever.
//   - Retention is 90 days: pruneQuestionLog deletes expired archived segments, their indexes
//     and bodies no retained line references. It is the primitive the SessionStart worker runs
//     (US-8 Q5); nothing here schedules it.
//   - List reads never open bodies/. Only readAnswerBody does.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveSidequestHome } from '../claude-home.js';
import { MKDIR_LOCK_WAIT_MS, withMkdirLock } from '../mkdir-lock.js';

export const QUESTION_LOG_VERSION = 1;
export const QUESTION_FOLD_VERSION = 1;
export const ACTIVE_SEGMENT = 'questions.jsonl';
// Written whole during rotation, then renamed onto ACTIVE_SEGMENT. Seen only after a crash.
export const NEXT_SEGMENT = 'questions.next.jsonl';
export const FOLD_FILE = 'fold.json';
export const APPEND_LOCK = 'append.lock';
export const BODIES_DIR = 'bodies';

export const MAX_LINE_BYTES = 4096;
export const MAX_QUESTION_BYTES = 1500;
export const MAX_HEADER_CHARS = 12; // AskUserQuestion's header limit.
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_OPTION_LABEL_CHARS = 60;
export const MAX_OPTION_DESCRIPTION_CHARS = 200;
export const MAX_INLINE_ANSWER_BYTES = 2048;
export const MAX_ANSWER_BYTES = 64 * 1024;
export const MAX_PREVIEW_CHARS = 200;
export const MAX_OPEN_PER_TICKET = 3;
export const MAX_SEGMENT_BYTES = 1024 * 1024;
export const RETENTION_DAYS = 90;
// Closed questions fold.json keeps beside the open ones. The dashboard keeps its own unbounded
// in-memory fold (advanceFold with recentLimit Infinity) and never reads this cap.
export const RECENT_LIMIT = 50;
const HEAD_BYTES = 256;
const DAY_MS = 24 * 60 * 60 * 1000;

export const QUESTION_EVENT_TYPES = ['asked', 'sent', 'delivered', 'answered', 'withdrawn', 'carried'] as const;
export const ANSWER_VIAS = ['user', 'user-prompt', 'dashboard', 'orchestrator'] as const;
export const WITHDRAW_REASONS = ['resolved', 'ticket-closed', 'oracle'] as const;
export const ASK_ORIGINS = ['runtime', 'filing'] as const;

export type QuestionEventType = typeof QUESTION_EVENT_TYPES[number];
export type AnswerVia = typeof ANSWER_VIAS[number];
export type WithdrawReason = typeof WITHDRAW_REASONS[number];
export type AskOrigin = typeof ASK_ORIGINS[number];
export type QuestionStateName = 'open' | 'answered' | 'declined' | 'withdrawn';

// Every refusal reason this module can return. The ask/answer tools (US-8 Q4) surface these.
export const QUESTION_LOG_REFUSALS = [
  'too_many_open',
  'options_out_of_range',
  'question_too_long',
  'question_empty',
  'answer_too_long',
  'answer_empty',
  'no_such_question',
  'already_answered',
  'question_log_busy',
] as const;
export type QuestionLogRefusalReason = typeof QUESTION_LOG_REFUSALS[number];

export interface QuestionLogRefusal {
  ok: false;
  reason: QuestionLogRefusalReason;
  message: string;
  retryable?: boolean;
  [key: string]: unknown;
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface AskedRecord {
  at: string;
  session: string | null;
  origin: AskOrigin;
  ownerSession: string | null;
  agent: string | null;
  header: string | null;
  text: string;
  options: QuestionOption[] | null;
  multiSelect: boolean;
  blocking: boolean;
  default: string | null;
}

export interface AnswerRecord {
  aid: string;
  at: string;
  session: string | null;
  via: AnswerVia;
  declined: boolean;
  supersedes: string | null;
  // Inline answers carry text; long ones carry bodyRef, bytes, sha256 and preview instead.
  text?: string;
  bodyRef?: string;
  bytes?: number;
  sha256?: string;
  preview?: string;
}

export interface SentRecord {
  at: string;
  to: string | null;
  aid: string | null;
  session: string | null;
}

export interface DeliveredRecord {
  aid: string;
  at: string;
  session: string | null;
}

export interface WithdrawnRecord {
  reason: WithdrawReason;
  at: string;
  session: string | null;
}

export interface QuestionState {
  qid: string;
  ref: string;
  ticketId: string | null;
  seq: string;
  state: QuestionStateName;
  asked: AskedRecord;
  answered: AnswerRecord | null;
  // Earlier answers the current one replaced through `supersedes`, oldest first.
  superseded: AnswerRecord[];
  sent: SentRecord[];
  delivered: DeliveredRecord[];
  withdrawn: WithdrawnRecord | null;
  closedAt: string | null;
}

export interface QuestionFold {
  v: number;
  segment: string;
  inode: number | null;
  head: string;
  headBytes: number;
  offset: number;
  recentLimit: number | null; // null means unbounded
  month: string | null; // UTC YYYY-MM of the segment's first event, for monthly rotation
  firstAt: string | null;
  lastAt: string | null;
  lines: number;
  carriedLines: number;
  skipped: number; // lines that failed to parse, carried an unknown v, or named no known qid
  seqs: Record<string, number>; // per-ticket highest seq ever issued, cumulative across segments
  open: Record<string, QuestionState>; // every live question: open, or answered but undelivered
  recent: Record<string, QuestionState>; // the newest closed questions, at most recentLimit
}

export interface QuestionSummary {
  qid: string;
  ref: string;
  ticketId: string | null;
  seq: string;
  header: string | null;
  text: string;
  asker: string | null;
  state: QuestionStateName;
  blocking: boolean;
  askedAt: string;
  answeredAt: string | null;
  closedAt: string | null;
  via: AnswerVia | null;
  aid: string | null;
  declined: boolean;
}

export interface SegmentIndex {
  v: number;
  segment: string;
  closedAt: string | null;
  firstAt: string | null;
  lastAt: string | null;
  lines: number;
  skipped: number;
  seqs: Record<string, number>;
  questions: QuestionSummary[];
  bodies: string[];
}

export interface QuestionLogOptions {
  now?: Date | number;
  lockWaitMs?: number;
  maxSegmentBytes?: number;
  retentionDays?: number;
}

export interface FoldOptions {
  recentLimit?: number;
}

type Refusal = QuestionLogRefusal;

const QID_PATTERN = /^q_[0-9a-z]+_[0-9a-z]{6}$/;
const AID_PATTERN = /^a_[0-9a-z]+_[0-9a-z]{6}$/;
const SEQ_PATTERN = /^Q([1-9][0-9]*)$/;
const ARCHIVE_PATTERN = /^questions-(\d{8}T\d{9}Z)\.jsonl$/;

// ---------------------------------------------------------------------------------------------
// Paths and ids

export function questionLogDir(slug: string, home: string = resolveSidequestHome()): string {
  const name = String(slug || '');
  if (!name || name !== path.basename(name) || name === '.' || name === '..') {
    throw new TypeError(`questionLogDir: invalid project slug ${JSON.stringify(slug)}`);
  }
  return path.join(home, 'projects', name, 'questions');
}

function randomSuffix(): string {
  return crypto.randomInt(0, 36 ** 6).toString(36).padStart(6, '0');
}

export function newQuestionId(now: Date | number = Date.now()): string {
  return `q_${toMs(now).toString(36)}_${randomSuffix()}`;
}

export function newAnswerId(now: Date | number = Date.now()): string {
  return `a_${toMs(now).toString(36)}_${randomSuffix()}`;
}

export function isQuestionId(value: unknown): value is string {
  return typeof value === 'string' && QID_PATTERN.test(value);
}

export function isAnswerId(value: unknown): value is string {
  return typeof value === 'string' && AID_PATTERN.test(value);
}

export function seqNumber(seq: unknown): number {
  const match = typeof seq === 'string' ? SEQ_PATTERN.exec(seq) : null;
  return match ? Number(match[1]) : 0;
}

function toMs(now: Date | number): number {
  return now instanceof Date ? now.getTime() : Number(now);
}

function nowDate(options: QuestionLogOptions): Date {
  if (options.now instanceof Date) return new Date(options.now.getTime());
  if (typeof options.now === 'number') return new Date(options.now);
  return new Date();
}

function isoMonth(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function refKey(ref: string): string {
  return String(ref).trim().toUpperCase();
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function charLength(text: string): number {
  return Array.from(text).length;
}

function firstChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------------------------
// Refusals

function refusal(reason: QuestionLogRefusalReason, message: string, extra: Record<string, unknown> = {}): Refusal {
  return { ok: false, reason, message, ...extra };
}

function busyRefusal(waitMs: number): Refusal {
  return refusal(
    'question_log_busy',
    `The question log is busy: its append lock stayed held for ${waitMs} ms and nothing was written. Retry the same call.`,
    { retryable: true },
  );
}

function tooLong(reason: 'question_too_long' | 'answer_too_long', field: string, length: number, max: number, unit: 'bytes' | 'chars'): Refusal {
  return refusal(
    reason,
    `${field} is ${length} ${unit}; the limit is ${max}. Put long detail in a ticket comment and reference it.`,
    { field, length, max, unit },
  );
}

function openQids(fold: QuestionFold, ref: string): string[] {
  return ticketStates(fold, ref).filter((state) => state.state === 'open').map((state) => state.qid);
}

function noSuchQuestion(fold: QuestionFold, ref: string, qid: string | null): Refusal {
  const open = openQids(fold, ref);
  const listed = open.length ? open.join(', ') : 'none';
  const subject = qid ? `no open question ${qid}` : 'no open question';
  return refusal('no_such_question', `${ref} has ${subject}. Open questions: ${listed}.`, { open });
}

function answerQuote(answer: AnswerRecord): string {
  if (answer.declined && !answer.text && !answer.preview) return '(declined)';
  const text = answer.text ?? answer.preview ?? '';
  return firstChars(text, MAX_PREVIEW_CHARS);
}

// ---------------------------------------------------------------------------------------------
// Fold

function emptyFold(inode: number | null, recentLimit: number, seqs: Record<string, number>): QuestionFold {
  return {
    v: QUESTION_FOLD_VERSION,
    segment: ACTIVE_SEGMENT,
    inode,
    head: '',
    headBytes: 0,
    offset: 0,
    recentLimit: Number.isFinite(recentLimit) ? recentLimit : null,
    month: null,
    firstAt: null,
    lastAt: null,
    lines: 0,
    carriedLines: 0,
    skipped: 0,
    seqs: { ...seqs },
    open: {},
    recent: {},
  };
}

function normalizeRecentLimit(limit: number | undefined): number {
  if (limit === undefined) return RECENT_LIMIT;
  if (limit === Infinity) return Infinity;
  return Number.isInteger(limit) && limit >= 0 ? limit : RECENT_LIMIT;
}

function foldRecentLimit(fold: QuestionFold): number {
  return fold.recentLimit === null ? Infinity : fold.recentLimit;
}

function isLive(state: QuestionState): boolean {
  if (state.state === 'open') return true;
  if (state.state === 'withdrawn' || !state.answered) return false;
  const aid = state.answered.aid;
  return !state.delivered.some((delivery) => delivery.aid === aid);
}

function lookup(fold: QuestionFold, qid: string): QuestionState | null {
  return fold.open[qid] || fold.recent[qid] || null;
}

function place(fold: QuestionFold, state: QuestionState): void {
  delete fold.open[state.qid];
  delete fold.recent[state.qid];
  if (isLive(state)) fold.open[state.qid] = state;
  else fold.recent[state.qid] = state;
}

function bumpSeq(fold: QuestionFold, ref: string, seq: string): void {
  const key = refKey(ref);
  const number = seqNumber(seq);
  if (number > (fold.seqs[key] || 0)) fold.seqs[key] = number;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function normalizeOptions(value: unknown): QuestionOption[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  return value.map((option) => ({
    label: String(option?.label ?? ''),
    description: String(option?.description ?? ''),
  }));
}

function askedFromEvent(event: Record<string, any>): AskedRecord {
  return {
    at: event.at,
    session: stringOrNull(event.session),
    origin: event.origin === 'filing' ? 'filing' : 'runtime',
    ownerSession: stringOrNull(event.ownerSession),
    agent: stringOrNull(event.agent),
    header: stringOrNull(event.header),
    text: String(event.text),
    options: normalizeOptions(event.options),
    multiSelect: event.multiSelect === true,
    blocking: event.blocking !== false,
    default: stringOrNull(event.default),
  };
}

function answerFromEvent(event: Record<string, any>): AnswerRecord {
  const answer: AnswerRecord = {
    aid: event.aid,
    at: event.at,
    session: stringOrNull(event.session),
    via: (ANSWER_VIAS as readonly string[]).includes(event.via) ? event.via : 'user',
    declined: event.declined === true,
    supersedes: stringOrNull(event.supersedes),
  };
  if (typeof event.text === 'string') answer.text = event.text;
  if (typeof event.bodyRef === 'string') {
    answer.bodyRef = event.bodyRef;
    if (typeof event.bytes === 'number') answer.bytes = event.bytes;
    if (typeof event.sha256 === 'string') answer.sha256 = event.sha256;
    if (typeof event.preview === 'string') answer.preview = event.preview;
  }
  return answer;
}

function carriedState(event: Record<string, any>): QuestionState | null {
  const state = event.state;
  if (!state || typeof state !== 'object' || !state.asked || typeof state.asked.text !== 'string') return null;
  if (typeof state.seq !== 'string' || !SEQ_PATTERN.test(state.seq)) return null;
  const answered = state.answered && isAnswerId(state.answered.aid) ? answerFromEvent(state.answered) : null;
  const withdrawn = state.withdrawn && typeof state.withdrawn.reason === 'string'
    ? { reason: state.withdrawn.reason, at: String(state.withdrawn.at), session: stringOrNull(state.withdrawn.session) } as WithdrawnRecord
    : null;
  const stateName: QuestionStateName = withdrawn ? 'withdrawn' : answered ? (answered.declined ? 'declined' : 'answered') : 'open';
  return {
    qid: event.qid,
    ref: event.ref,
    ticketId: stringOrNull(event.ticketId),
    seq: state.seq,
    state: stateName,
    asked: askedFromEvent(state.asked),
    answered,
    superseded: Array.isArray(state.superseded) ? state.superseded.filter((answer: any) => isAnswerId(answer?.aid)).map(answerFromEvent) : [],
    sent: Array.isArray(state.sent) ? state.sent.map((sent: any) => ({ at: String(sent?.at), to: stringOrNull(sent?.to), aid: stringOrNull(sent?.aid), session: stringOrNull(sent?.session) })) : [],
    delivered: Array.isArray(state.delivered) ? state.delivered.filter((delivery: any) => isAnswerId(delivery?.aid)).map((delivery: any) => ({ aid: delivery.aid, at: String(delivery.at), session: stringOrNull(delivery.session) })) : [],
    withdrawn,
    closedAt: stateName === 'open' ? null : stringOrNull(state.closedAt) ?? (answered?.at || withdrawn?.at || null),
  };
}

type ApplyResult = 'applied' | 'skipped' | 'unknown';

function applyEvent(fold: QuestionFold, event: Record<string, any>, incremental: boolean): ApplyResult {
  switch (event.type as QuestionEventType) {
    case 'asked': {
      if (typeof event.text !== 'string' || typeof event.seq !== 'string' || !SEQ_PATTERN.test(event.seq)) return 'skipped';
      if (lookup(fold, event.qid)) return 'skipped';
      const state: QuestionState = {
        qid: event.qid,
        ref: event.ref,
        ticketId: stringOrNull(event.ticketId),
        seq: event.seq,
        state: 'open',
        asked: askedFromEvent(event),
        answered: null,
        superseded: [],
        sent: [],
        delivered: [],
        withdrawn: null,
        closedAt: null,
      };
      bumpSeq(fold, state.ref, state.seq);
      place(fold, state);
      return 'applied';
    }
    case 'carried': {
      const state = carriedState(event);
      if (!state) return 'skipped';
      fold.carriedLines += 1;
      bumpSeq(fold, state.ref, state.seq);
      if (!lookup(fold, state.qid)) place(fold, state);
      return 'applied';
    }
    default:
      break;
  }
  const state = lookup(fold, event.qid);
  if (!state) return incremental ? 'unknown' : 'skipped';
  switch (event.type as QuestionEventType) {
    case 'sent':
      state.sent.push({ at: event.at, to: stringOrNull(event.to), aid: isAnswerId(event.aid) ? event.aid : null, session: stringOrNull(event.session) });
      break;
    case 'delivered':
      if (!isAnswerId(event.aid)) return 'skipped';
      if (!state.delivered.some((delivery) => delivery.aid === event.aid)) {
        state.delivered.push({ aid: event.aid, at: event.at, session: stringOrNull(event.session) });
      }
      break;
    case 'answered': {
      if (!isAnswerId(event.aid)) return 'skipped';
      // First writer wins; a later answer replaces it only by naming the winner in supersedes.
      if (state.state === 'withdrawn') break;
      const answer = answerFromEvent(event);
      if (!state.answered) {
        state.answered = answer;
      } else if (answer.supersedes && answer.supersedes === state.answered.aid) {
        state.superseded.push(state.answered);
        state.answered = answer;
      } else {
        break;
      }
      state.state = answer.declined ? 'declined' : 'answered';
      state.closedAt = answer.at;
      break;
    }
    case 'withdrawn':
      if (state.state !== 'open') break;
      state.withdrawn = {
        reason: (WITHDRAW_REASONS as readonly string[]).includes(event.reason) ? event.reason : 'resolved',
        at: event.at,
        session: stringOrNull(event.session),
      };
      state.state = 'withdrawn';
      state.closedAt = event.at;
      break;
    default:
      return 'skipped';
  }
  place(fold, state);
  return 'applied';
}

function validEvent(event: unknown): event is Record<string, any> {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  const record = event as Record<string, unknown>;
  return record.v === QUESTION_LOG_VERSION
    && typeof record.type === 'string'
    && (QUESTION_EVENT_TYPES as readonly string[]).includes(record.type)
    && isQuestionId(record.qid)
    && typeof record.ref === 'string' && record.ref.length > 0
    && typeof record.at === 'string';
}

function readRange(fd: number, start: number, end: number): Buffer {
  const length = Math.max(0, end - start);
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = fs.readSync(fd, buffer, read, length - read, start + read);
    if (count === 0) break;
    read += count;
  }
  return read === length ? buffer : buffer.subarray(0, read);
}

function headDigest(fd: number, bytes: number): string {
  return bytes > 0 ? crypto.createHash('sha1').update(readRange(fd, 0, bytes)).digest('hex') : '';
}

// Applies the complete lines in [fold.offset, size) to fold. Returns null when an incremental
// pass meets a question its base does not hold (one evicted from `recent`), so the caller can
// refold from scratch; a from-scratch pass counts such a line as skipped instead.
function foldBytes(fd: number, size: number, fold: QuestionFold, incremental: boolean): QuestionFold | null {
  if (size <= fold.offset) return fold;
  const bytes = readRange(fd, fold.offset, size);
  let position = 0;
  while (position < bytes.length) {
    const newline = bytes.indexOf(0x0a, position);
    if (newline < 0) break; // A trailing line with no newline is in progress or torn: not yet.
    const line = bytes.subarray(position, newline);
    position = newline + 1;
    fold.lines += 1;
    let event: unknown;
    try {
      event = JSON.parse(line.toString('utf8'));
    } catch (_) {
      event = null;
    }
    if (!validEvent(event)) {
      fold.skipped += 1;
    } else {
      const result = applyEvent(fold, event, incremental);
      if (result === 'unknown') return null;
      if (result === 'skipped') {
        fold.skipped += 1;
      } else {
        if (!fold.month) fold.month = event.at.slice(0, 7);
        if (!fold.firstAt) fold.firstAt = event.at;
        fold.lastAt = event.at;
      }
    }
    fold.offset += line.length + 1;
  }
  return fold;
}

function trimRecent(fold: QuestionFold): void {
  const limit = foldRecentLimit(fold);
  const closed = Object.values(fold.recent);
  if (closed.length <= limit) return;
  closed.sort((left, right) => String(right.closedAt).localeCompare(String(left.closedAt)) || right.qid.localeCompare(left.qid));
  const kept = new Set(closed.slice(0, limit).map((state) => state.qid));
  for (const qid of Object.keys(fold.recent)) if (!kept.has(qid)) delete fold.recent[qid];
}

function reusableFold(prior: QuestionFold | null, inode: number, size: number, fd: number, recentLimit: number): boolean {
  if (!prior || prior.v !== QUESTION_FOLD_VERSION || prior.segment !== ACTIVE_SEGMENT) return false;
  if (foldRecentLimit(prior) !== recentLimit) return false;
  if (prior.inode !== inode || !Number.isInteger(prior.offset) || prior.offset < 0 || size < prior.offset) return false;
  if (!prior.open || !prior.recent || !prior.seqs) return false;
  return headDigest(fd, prior.headBytes) === prior.head;
}

function openActiveSegment(dir: string): number | null {
  // During rotation the active segment is briefly absent while questions.next.jsonl is
  // renamed onto it; after a crash there, the next segment is the one to read.
  for (const name of [ACTIVE_SEGMENT, NEXT_SEGMENT, ACTIVE_SEGMENT]) {
    try {
      return fs.openSync(path.join(dir, name), 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return null;
}

function foldOpenFile(fd: number, prior: QuestionFold | null, recentLimit: number, seed: () => Record<string, number>): QuestionFold {
  const stat = fs.fstatSync(fd);
  let fold: QuestionFold | null = null;
  if (prior && reusableFold(prior, stat.ino, stat.size, fd, recentLimit)) {
    fold = foldBytes(fd, stat.size, structuredClone(prior), true);
  }
  if (!fold) fold = foldBytes(fd, stat.size, emptyFold(stat.ino, recentLimit, seed()), false)!;
  trimRecent(fold);
  fold.headBytes = Math.min(fold.offset, HEAD_BYTES);
  fold.head = headDigest(fd, fold.headBytes);
  return fold;
}

// Folds the active segment forward from prior (or from scratch). A prior fold is reused only
// for the same segment inode, an unchanged head, a size at least its offset, and the same
// recentLimit; otherwise this refolds. It never writes; readQuestionLog persists fold.json.
export function advanceFold(dir: string, prior: QuestionFold | null, options: FoldOptions = {}): QuestionFold {
  const recentLimit = normalizeRecentLimit(options.recentLimit);
  const fd = openActiveSegment(dir);
  if (fd === null) return emptyFold(null, recentLimit, latestArchivedSeqs(dir));
  try {
    return foldOpenFile(fd, prior, recentLimit, () => latestArchivedSeqs(dir));
  } finally {
    fs.closeSync(fd);
  }
}

function foldSegmentFile(file: string, seqs: Record<string, number>): QuestionFold | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return foldOpenFile(fd, null, Infinity, () => seqs);
  } finally {
    fs.closeSync(fd);
  }
}

function loadFold(dir: string): QuestionFold | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, FOLD_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.v === QUESTION_FOLD_VERSION ? parsed as QuestionFold : null;
  } catch (_) {
    return null;
  }
}

function writeFileAtomic(file: string, content: string): void {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomSuffix()}.tmp`);
  try {
    fs.writeFileSync(temp, content);
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch (_) {}
    throw error;
  }
}

function saveFold(dir: string, fold: QuestionFold): void {
  try {
    writeFileAtomic(path.join(dir, FOLD_FILE), JSON.stringify(fold));
  } catch (_) {
    // fold.json is a cache. A reader that cannot write it just refolds next time.
  }
}

function sameFoldPosition(left: QuestionFold | null, right: QuestionFold): boolean {
  return Boolean(left && left.inode === right.inode && left.offset === right.offset && left.head === right.head
    && left.recentLimit === right.recentLimit);
}

// The reader entry point: loads fold.json, folds any new bytes, and saves fold.json when it
// moved. Takes no lock and never opens bodies/. A missing log reads as an empty fold.
export function readQuestionLog(dir: string): QuestionFold {
  const prior = loadFold(dir);
  const fold = advanceFold(dir, prior);
  if (fold.inode !== null && !sameFoldPosition(prior, fold)) saveFold(dir, fold);
  return fold;
}

function sortStates(states: QuestionState[]): QuestionState[] {
  return states.sort((left, right) => left.asked.at.localeCompare(right.asked.at) || left.qid.localeCompare(right.qid));
}

// Every question the fold holds (live and recent closed), oldest asked first.
export function foldQuestions(fold: QuestionFold): QuestionState[] {
  return sortStates([...Object.values(fold.open), ...Object.values(fold.recent)]);
}

function ticketStates(fold: QuestionFold, ref: string): QuestionState[] {
  const key = refKey(ref);
  return foldQuestions(fold).filter((state) => refKey(state.ref) === key);
}

export function openQuestions(dir: string, filter: { ref?: string } = {}): QuestionState[] {
  const fold = readQuestionLog(dir);
  const states = sortStates(Object.values(fold.open).filter((state) => state.state === 'open'));
  return filter.ref ? states.filter((state) => refKey(state.ref) === refKey(filter.ref!)) : states;
}

// A list-safe projection: question text, never answer text, preview or body reference.
export function summarizeQuestion(state: QuestionState): QuestionSummary {
  return {
    qid: state.qid,
    ref: state.ref,
    ticketId: state.ticketId,
    seq: state.seq,
    header: state.asked.header,
    text: state.asked.text,
    asker: state.asked.agent || (state.asked.origin === 'filing' ? 'filing' : null),
    state: state.state,
    blocking: state.asked.blocking,
    askedAt: state.asked.at,
    answeredAt: state.answered?.at ?? null,
    closedAt: state.closedAt,
    via: state.answered?.via ?? null,
    aid: state.answered?.aid ?? null,
    declined: state.answered?.declined ?? false,
  };
}

function bodiesOf(states: Iterable<QuestionState>): string[] {
  const aids = new Set<string>();
  for (const state of states) {
    for (const answer of [state.answered, ...state.superseded]) {
      if (answer?.bodyRef && isAnswerId(answer.aid)) aids.add(answer.aid);
    }
  }
  return [...aids].sort();
}

// ---------------------------------------------------------------------------------------------
// Archived segments and their indexes

export function listArchivedSegments(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => ARCHIVE_PATTERN.test(name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function indexFileName(segment: string): string {
  return `index-${segment.replace(/\.jsonl$/, '')}.json`;
}

function readIndexFile(dir: string, segment: string): SegmentIndex | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, indexFileName(segment)), 'utf8'));
    return parsed && parsed.v === QUESTION_FOLD_VERSION && parsed.segment === segment ? parsed as SegmentIndex : null;
  } catch (_) {
    return null;
  }
}

function buildSegmentIndex(dir: string, segment: string, seqs: Record<string, number>, closedAt: string | null): SegmentIndex | null {
  const fold = foldSegmentFile(path.join(dir, segment), seqs);
  if (!fold) return null;
  const states = foldQuestions(fold);
  const index: SegmentIndex = {
    v: QUESTION_FOLD_VERSION,
    segment,
    closedAt,
    firstAt: fold.firstAt,
    lastAt: fold.lastAt,
    lines: fold.lines,
    skipped: fold.skipped,
    seqs: fold.seqs,
    questions: states.map(summarizeQuestion),
    bodies: bodiesOf(states),
  };
  try {
    writeFileAtomic(path.join(dir, indexFileName(segment)), JSON.stringify(index));
  } catch (_) {}
  return index;
}

function archiveStampTime(segment: string): string | null {
  const match = ARCHIVE_PATTERN.exec(segment);
  if (!match) return null;
  const stamp = match[1]!;
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.${stamp.slice(15, 18)}Z`;
}

// The one-time summary of an archived segment, built and saved on first read when rotation
// did not leave one. Its seqs are cumulative, so the newest index seeds a fresh active fold.
export function readSegmentIndex(dir: string, segment: string): SegmentIndex | null {
  const existing = readIndexFile(dir, segment);
  if (existing) return existing;
  const segments = listArchivedSegments(dir);
  const position = segments.indexOf(segment);
  if (position < 0) return null;
  const previous = position > 0 ? readSegmentIndex(dir, segments[position - 1]!) : null;
  return buildSegmentIndex(dir, segment, previous?.seqs || {}, archiveStampTime(segment));
}

function latestArchivedSeqs(dir: string): Record<string, number> {
  const segments = listArchivedSegments(dir);
  const newest = segments[segments.length - 1];
  return newest ? readSegmentIndex(dir, newest)?.seqs || {} : {};
}

// The full record for one qid, from the active segment or, failing that, the newest archived
// segment holding it. Never reads bodies/.
export function findQuestion(dir: string, qid: string): QuestionState | null {
  if (!isQuestionId(qid)) return null;
  return locateState(dir, readQuestionLog(dir), qid)?.state ?? null;
}

function locateState(dir: string, fold: QuestionFold, qid: string): { state: QuestionState; active: boolean } | null {
  const folded = lookup(fold, qid);
  if (folded) return { state: folded, active: true };
  const full = advanceFold(dir, null, { recentLimit: Infinity });
  const inActive = lookup(full, qid);
  if (inActive) return { state: inActive, active: true };
  const segments = listArchivedSegments(dir);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    const summary = readSegmentIndex(dir, segment);
    if (summary && !summary.questions.some((question) => question.qid === qid)) continue;
    const archived = foldSegmentFile(path.join(dir, segment), {});
    const state = archived ? lookup(archived, qid) : null;
    if (state) return { state, active: false };
  }
  return null;
}

// The answer body for aid, or null. The only function that opens bodies/.
export function readAnswerBody(dir: string, aid: string): string | null {
  if (!isAnswerId(aid)) return null;
  try {
    return fs.readFileSync(path.join(dir, BODIES_DIR, `${aid}.txt`), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Writers: everything below runs under append.lock/

interface LockedContext {
  dir: string;
  now: Date;
  fold: QuestionFold;
  maxSegmentBytes: number;
  retentionDays: number;
}

function recoverInterruptedRotation(dir: string): void {
  const next = path.join(dir, NEXT_SEGMENT);
  if (!fs.existsSync(next)) return;
  if (fs.existsSync(path.join(dir, ACTIVE_SEGMENT))) {
    // Rotation died before archiving the active segment; the next one is stale and is redone.
    fs.rmSync(next, { force: true });
  } else {
    // Rotation died between its two renames; finish it.
    fs.renameSync(next, path.join(dir, ACTIVE_SEGMENT));
  }
}

function underLock<T>(dir: string, options: QuestionLogOptions, fn: (context: LockedContext) => T): T | Refusal {
  const waitMs = options.lockWaitMs ?? MKDIR_LOCK_WAIT_MS;
  fs.mkdirSync(dir, { recursive: true });
  const result = withMkdirLock(path.join(dir, APPEND_LOCK), () => {
    recoverInterruptedRotation(dir);
    const context: LockedContext = {
      dir,
      now: nowDate(options),
      fold: advanceFold(dir, loadFold(dir)),
      maxSegmentBytes: options.maxSegmentBytes ?? MAX_SEGMENT_BYTES,
      retentionDays: options.retentionDays ?? RETENTION_DAYS,
    };
    const value = fn(context);
    if (context.fold.inode !== null) saveFold(dir, context.fold);
    return value;
  }, { waitMs });
  return result.acquired ? result.value : busyRefusal(waitMs);
}

function segmentSize(dir: string): number {
  try {
    return fs.statSync(path.join(dir, ACTIVE_SEGMENT)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

function archiveName(dir: string, now: Date): string {
  let time = now.getTime();
  while (true) {
    const stamp = new Date(time).toISOString().replace(/[-:.]/g, '');
    const name = `questions-${stamp}.jsonl`;
    if (!fs.existsSync(path.join(dir, name)) && !fs.existsSync(path.join(dir, indexFileName(name)))) return name;
    time += 1;
  }
}

function withinRetention(at: string | undefined, context: LockedContext): boolean {
  const time = Date.parse(String(at));
  return Number.isFinite(time) && context.now.getTime() - time <= context.retentionDays * DAY_MS;
}

function carriedLine(state: QuestionState, at: string): Record<string, unknown> {
  return { v: QUESTION_LOG_VERSION, type: 'carried', qid: state.qid, ref: state.ref, ticketId: state.ticketId, at, session: null, state };
}

function rotate(context: LockedContext): void {
  const { dir } = context;
  const at = context.now.toISOString();
  const carried = sortStates(Object.values(context.fold.open))
    .filter((state) => state.state === 'open' || withinRetention(state.answered?.at, context));
  fs.writeFileSync(path.join(dir, NEXT_SEGMENT), carried.map((state) => `${JSON.stringify(carriedLine(state, at))}\n`).join(''));
  const archived = archiveName(dir, context.now);
  fs.renameSync(path.join(dir, ACTIVE_SEGMENT), path.join(dir, archived));
  fs.renameSync(path.join(dir, NEXT_SEGMENT), path.join(dir, ACTIVE_SEGMENT));
  buildSegmentIndex(dir, archived, context.fold.seqs, at);
  context.fold = advanceFold(dir, null);
}

function maybeRotate(context: LockedContext, bytes: number): void {
  const size = segmentSize(context.dir);
  if (size === 0) return;
  const monthChanged = context.fold.month !== null && context.fold.month !== isoMonth(context.now);
  const full = size + bytes > context.maxSegmentBytes && context.fold.lines > context.fold.carriedLines;
  if (monthChanged || full) rotate(context);
}

function appendEvents(context: LockedContext, events: Record<string, unknown>[]): void {
  if (!events.length) return;
  const payload = events.map((event) => `${JSON.stringify(event)}\n`).join('');
  maybeRotate(context, byteLength(payload));
  const fd = fs.openSync(path.join(context.dir, ACTIVE_SEGMENT), 'a+');
  try {
    const size = fs.fstatSync(fd).size;
    let repair = '';
    if (size > 0) {
      const last = readRange(fd, size - 1, size);
      // A torn tail from a writer that died mid-write: end it here so it reads as one skipped
      // line and this event starts on its own.
      if (last[0] !== 0x0a) repair = '\n';
    }
    const buffer = Buffer.from(repair + payload, 'utf8');
    let written = 0;
    while (written < buffer.length) written += fs.writeSync(fd, buffer, written, buffer.length - written);
  } finally {
    fs.closeSync(fd);
  }
  context.fold = advanceFold(context.dir, context.fold);
}

function baseEvent(type: QuestionEventType, state: { qid: string; ref: string; ticketId: string | null }, context: LockedContext, session: string | null): Record<string, unknown> {
  return { v: QUESTION_LOG_VERSION, type, qid: state.qid, ref: state.ref, ticketId: state.ticketId, at: context.now.toISOString(), session };
}

function assertEnum<T extends string>(name: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new TypeError(`${name} must be one of ${allowed.join(', ')}; got ${JSON.stringify(value)}`);
  }
  return value as T;
}

function requireRef(ref: unknown): string {
  const value = typeof ref === 'string' ? ref.trim() : '';
  if (!value) throw new TypeError('ref is required');
  return value;
}

// ---------------------------------------------------------------------------------------------
// ask

export interface AskInput {
  ref: string;
  ticketId?: string | null;
  session?: string | null;
  origin?: AskOrigin;
  ownerSession?: string | null;
  agent?: string | null;
  header?: string | null;
  text: string;
  options?: Array<{ label: string; description?: string }> | null;
  multiSelect?: boolean;
  blocking?: boolean;
  default?: string | null;
}

export interface AskResult {
  ok: true;
  qid: string;
  seq: string;
  ref: string;
  ticketId: string | null;
  blocking: boolean;
  open: number;
  at: string;
}

function validateAsk(input: AskInput): Refusal | { header: string | null; text: string; options: QuestionOption[] | null } {
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) return refusal('question_empty', 'Give the question text.');
  if (byteLength(text) > MAX_QUESTION_BYTES) return tooLong('question_too_long', 'question', byteLength(text), MAX_QUESTION_BYTES, 'bytes');
  const header = typeof input.header === 'string' && input.header.trim() ? input.header.trim() : null;
  if (header && charLength(header) > MAX_HEADER_CHARS) return tooLong('question_too_long', 'header', charLength(header), MAX_HEADER_CHARS, 'chars');
  let options: QuestionOption[] | null = null;
  if (Array.isArray(input.options) && input.options.length) {
    if (input.options.length < MIN_OPTIONS || input.options.length > MAX_OPTIONS) {
      return refusal('options_out_of_range', `${MIN_OPTIONS} to ${MAX_OPTIONS} options (AskUserQuestion's limit); omit for free text.`, { length: input.options.length, min: MIN_OPTIONS, max: MAX_OPTIONS });
    }
    options = [];
    for (const [index, option] of input.options.entries()) {
      const label = typeof option?.label === 'string' ? option.label.trim() : '';
      const description = typeof option?.description === 'string' ? option.description.trim() : '';
      if (!label) return refusal('question_empty', `options[${index}].label is empty; every option needs a label.`, { field: `options[${index}].label` });
      if (charLength(label) > MAX_OPTION_LABEL_CHARS) return tooLong('question_too_long', `options[${index}].label`, charLength(label), MAX_OPTION_LABEL_CHARS, 'chars');
      if (charLength(description) > MAX_OPTION_DESCRIPTION_CHARS) return tooLong('question_too_long', `options[${index}].description`, charLength(description), MAX_OPTION_DESCRIPTION_CHARS, 'chars');
      options.push({ label, description });
    }
  }
  return { header, text, options };
}

// Records an `asked` event. seq is derived under the lock, and the per-ticket open cap is
// checked there too, so two concurrent asks can neither share a seq nor overshoot the cap.
// Board checks (claim held, self-answer) are the tool's, not this module's.
export function askQuestion(dir: string, input: AskInput, options: QuestionLogOptions = {}): AskResult | Refusal {
  const ref = requireRef(input.ref);
  const origin = assertEnum('origin', input.origin ?? 'runtime', ASK_ORIGINS);
  const validated = validateAsk(input);
  if ('ok' in validated) return validated;
  return underLock(dir, options, (context): AskResult | Refusal => {
    const open = openQids(context.fold, ref);
    if (open.length >= MAX_OPEN_PER_TICKET) {
      return refusal('too_many_open', `${ref} already has ${MAX_OPEN_PER_TICKET} open questions; withdraw or wait.`, { open });
    }
    const seq = `Q${(context.fold.seqs[refKey(ref)] || 0) + 1}`;
    const qid = newQuestionId(context.now);
    const ticketId = stringOrNull(input.ticketId);
    const blocking = input.blocking !== false;
    const event = {
      ...baseEvent('asked', { qid, ref, ticketId }, context, stringOrNull(input.session)),
      seq,
      origin,
      ownerSession: stringOrNull(input.ownerSession),
      agent: stringOrNull(input.agent),
      header: validated.header,
      text: validated.text,
      ...(validated.options ? { options: validated.options, multiSelect: input.multiSelect === true } : { multiSelect: false }),
      blocking,
      default: stringOrNull(input.default),
    };
    const lineBytes = byteLength(JSON.stringify(event)) + 1;
    if (lineBytes > MAX_LINE_BYTES) return tooLong('question_too_long', 'line', lineBytes, MAX_LINE_BYTES, 'bytes');
    appendEvents(context, [event]);
    return { ok: true, qid, seq, ref, ticketId, blocking, open: open.length + 1, at: context.now.toISOString() };
  });
}

// ---------------------------------------------------------------------------------------------
// answer

export interface AnswerInput {
  ref: string;
  question?: string | null; // a qid; defaults to the ticket's oldest open question
  text?: string | null;
  decline?: boolean;
  via?: AnswerVia;
  supersedes?: string | null;
  session?: string | null;
}

export interface AnswerResult {
  ok: true;
  qid: string;
  aid: string;
  seq: string;
  ref: string;
  ticketId: string | null;
  via: AnswerVia;
  declined: boolean;
  supersedes: string | null;
  inline: boolean;
  bodyRef: string | null;
  // True when this call matched the answer already recorded and wrote nothing.
  idempotent: boolean;
  openForTicket: string[];
  blockingOpen: number;
}

function sameAnswer(existing: AnswerRecord, text: string, declined: boolean): boolean {
  if (existing.declined !== declined) return false;
  if (typeof existing.text === 'string') return existing.text === text;
  if (existing.sha256) return existing.sha256 === sha256(text);
  return !text;
}

function answerResult(context: LockedContext, state: QuestionState, answer: AnswerRecord, idempotent: boolean): AnswerResult {
  const open = ticketStates(context.fold, state.ref).filter((candidate) => candidate.state === 'open');
  return {
    ok: true,
    qid: state.qid,
    aid: answer.aid,
    seq: state.seq,
    ref: state.ref,
    ticketId: state.ticketId,
    via: answer.via,
    declined: answer.declined,
    supersedes: answer.supersedes,
    inline: typeof answer.text === 'string' || !answer.bodyRef,
    bodyRef: answer.bodyRef ?? null,
    idempotent,
    openForTicket: open.map((candidate) => candidate.qid),
    blockingOpen: open.filter((candidate) => candidate.asked.blocking).length,
  };
}

function writeBody(dir: string, aid: string, text: string): string {
  const bodies = path.join(dir, BODIES_DIR);
  fs.mkdirSync(bodies, { recursive: true });
  writeFileAtomic(path.join(bodies, `${aid}.txt`), text);
  return `${BODIES_DIR}/${aid}.txt`;
}

// Records an `answered` event. The first writer wins under the lock: a second answer to an
// answered question is refused with the recorded answer quoted, unless it repeats that answer
// exactly (idempotent, nothing written) or names it in supersedes. A long answer's body is
// written to bodies/<aid>.txt by temp file and rename before its line is appended.
export function answerQuestion(dir: string, input: AnswerInput, options: QuestionLogOptions = {}): AnswerResult | Refusal {
  const ref = requireRef(input.ref);
  const via = assertEnum('via', input.via ?? 'user', ANSWER_VIAS);
  const declined = input.decline === true;
  const text = typeof input.text === 'string' ? input.text : '';
  if (!declined && !text.trim()) return refusal('answer_empty', 'Give the answer text, or pass decline:true.');
  const bytes = byteLength(text);
  if (bytes > MAX_ANSWER_BYTES) return tooLong('answer_too_long', 'answer', bytes, MAX_ANSWER_BYTES, 'bytes');
  const requested = typeof input.question === 'string' && input.question ? input.question : null;
  return underLock(dir, options, (context): AnswerResult | Refusal => {
    let located: { state: QuestionState; active: boolean } | null = null;
    if (requested) {
      located = isQuestionId(requested) ? locateState(dir, context.fold, requested) : null;
    } else {
      const oldest = ticketStates(context.fold, ref).find((state) => state.state === 'open');
      located = oldest ? { state: oldest, active: true } : null;
    }
    if (!located || refKey(located.state.ref) !== refKey(ref) || located.state.state === 'withdrawn') {
      return noSuchQuestion(context.fold, ref, requested);
    }
    const state = located.state;
    const supersedes = typeof input.supersedes === 'string' && input.supersedes ? input.supersedes : null;
    if (state.answered) {
      if (!supersedes || supersedes !== state.answered.aid) {
        if (sameAnswer(state.answered, text, declined)) return answerResult(context, state, state.answered, true);
        return refusal(
          'already_answered',
          `${state.ref} ${state.seq} is already answered (${state.answered.aid}): "${answerQuote(state.answered)}". Do not ask the user again; pass supersedes:${state.answered.aid} only if the user changed their mind.`,
          { qid: state.qid, aid: state.answered.aid, via: state.answered.via, declined: state.answered.declined },
        );
      }
    }
    const aid = newAnswerId(context.now);
    const event: Record<string, unknown> = {
      ...baseEvent('answered', state, context, stringOrNull(input.session)),
      aid,
      via,
      declined,
      ...(state.answered && supersedes ? { supersedes } : {}),
    };
    if (text) {
      const inlineBytes = byteLength(JSON.stringify({ ...event, text })) + 1;
      if (bytes <= MAX_INLINE_ANSWER_BYTES && inlineBytes <= MAX_LINE_BYTES) {
        event.text = text;
      } else {
        event.bodyRef = writeBody(dir, aid, text);
        event.bytes = bytes;
        event.sha256 = sha256(text);
        event.preview = firstChars(text, MAX_PREVIEW_CHARS);
      }
    }
    // A question found only in an archived segment is closed there; carry it into the active
    // segment first so the new answer folds onto its state instead of an unknown qid.
    const events = located.active ? [event] : [carriedLine(state, context.now.toISOString()), event];
    appendEvents(context, events);
    const folded = lookup(context.fold, state.qid) || state;
    return answerResult(context, folded, folded.answered || answerFromEvent(event), false);
  });
}

// ---------------------------------------------------------------------------------------------
// withdraw, sent, delivered

export interface WithdrawInput {
  ref: string;
  qid?: string | null; // omitted: every open question on the ticket
  reason: WithdrawReason;
  session?: string | null;
}

export function withdrawQuestion(dir: string, input: WithdrawInput, options: QuestionLogOptions = {}): { ok: true; withdrawn: string[] } | Refusal {
  const ref = requireRef(input.ref);
  const reason = assertEnum('reason', input.reason, WITHDRAW_REASONS);
  const requested = typeof input.qid === 'string' && input.qid ? input.qid : null;
  return underLock(dir, options, (context) => {
    const open = ticketStates(context.fold, ref).filter((state) => state.state === 'open');
    let targets = open;
    if (requested) {
      targets = open.filter((state) => state.qid === requested);
      if (!targets.length) return noSuchQuestion(context.fold, ref, requested);
    }
    appendEvents(context, targets.map((state) => ({ ...baseEvent('withdrawn', state, context, stringOrNull(input.session)), reason })));
    return { ok: true as const, withdrawn: targets.map((state) => state.qid) };
  });
}

function stateForAid(fold: QuestionFold, aid: string): QuestionState | null {
  return foldQuestions(fold).find((state) => state.answered?.aid === aid || state.superseded.some((answer) => answer.aid === aid)) || null;
}

export interface SentInput {
  qid?: string | null;
  aid?: string | null;
  to: string;
  session?: string | null;
}

// Stamps that a SendMessage carrying a question or answer marker went out (US-8 Q6's hook).
export function recordSent(dir: string, input: SentInput, options: QuestionLogOptions = {}): { ok: true; qid: string } | Refusal {
  const aid = isAnswerId(input.aid) ? input.aid : null;
  const qid = isQuestionId(input.qid) ? input.qid : null;
  return underLock(dir, options, (context) => {
    const state = qid ? lookup(context.fold, qid) : aid ? stateForAid(context.fold, aid) : null;
    if (!state) return refusal('no_such_question', `No live question matches ${qid || aid || 'that marker'}.`, { qid, aid });
    appendEvents(context, [{ ...baseEvent('sent', state, context, stringOrNull(input.session)), to: String(input.to ?? ''), ...(aid ? { aid } : {}) }]);
    return { ok: true as const, qid: state.qid };
  });
}

export interface DeliveredInput {
  aid: string;
  session?: string | null;
}

// Records that an answer reached its executor. Idempotent by aid: a second call writes nothing.
export function recordDelivered(dir: string, input: DeliveredInput, options: QuestionLogOptions = {}): { ok: true; qid: string; duplicate: boolean } | Refusal {
  const aid = isAnswerId(input.aid) ? input.aid : null;
  return underLock(dir, options, (context) => {
    const state = aid ? stateForAid(context.fold, aid) : null;
    if (!state || !aid) return refusal('no_such_question', `No recorded answer matches ${input.aid}.`, { aid: input.aid });
    if (state.delivered.some((delivery) => delivery.aid === aid)) return { ok: true as const, qid: state.qid, duplicate: true };
    appendEvents(context, [{ ...baseEvent('delivered', state, context, stringOrNull(input.session)), aid }]);
    return { ok: true as const, qid: state.qid, duplicate: false };
  });
}

// ---------------------------------------------------------------------------------------------
// Retention

export interface PruneResult {
  ok: true;
  removedSegments: string[];
  removedIndexes: string[];
  removedBodies: string[];
}

// Deletes archived segments whose newest event is older than the retention window, their
// indexes, orphaned indexes, and every body no retained line references. Runs under the
// append lock so no answer can land a body between the reference scan and the delete.
export function pruneQuestionLog(dir: string, options: QuestionLogOptions = {}): PruneResult | Refusal {
  if (!fs.existsSync(dir)) return { ok: true, removedSegments: [], removedIndexes: [], removedBodies: [] };
  return underLock(dir, options, (context): PruneResult => {
    const cutoff = context.now.getTime() - context.retentionDays * DAY_MS;
    const removedSegments: string[] = [];
    const removedIndexes: string[] = [];
    const removedBodies: string[] = [];
    const retained = new Set<string>();
    for (const segment of listArchivedSegments(dir)) {
      const index = readSegmentIndex(dir, segment);
      const newest = Date.parse(String(index?.lastAt || index?.closedAt || archiveStampTime(segment)));
      if (Number.isFinite(newest) && newest < cutoff) {
        fs.rmSync(path.join(dir, segment), { force: true });
        removedSegments.push(segment);
      } else {
        for (const aid of index?.bodies || []) retained.add(aid);
      }
    }
    const live = new Set(listArchivedSegments(dir).map(indexFileName));
    for (const name of fs.readdirSync(dir)) {
      if (/^index-questions-.*\.json$/.test(name) && !live.has(name)) {
        fs.rmSync(path.join(dir, name), { force: true });
        removedIndexes.push(name);
      }
    }
    const active = advanceFold(dir, null, { recentLimit: Infinity });
    for (const aid of bodiesOf(Object.values({ ...active.open, ...active.recent }))) retained.add(aid);
    const bodies = path.join(dir, BODIES_DIR);
    let names: string[] = [];
    try {
      names = fs.readdirSync(bodies);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const name of names) {
      const aid = name.endsWith('.txt') ? name.slice(0, -4) : null;
      if (aid && isAnswerId(aid) && retained.has(aid)) continue;
      fs.rmSync(path.join(bodies, name), { force: true });
      removedBodies.push(name);
    }
    return { ok: true, removedSegments, removedIndexes, removedBodies };
  });
}
