// US-8 Q6 (SQ-420): shared surfacing for open user questions. Every reader here folds the question
// log (src/lib/store/question-log.ts) and never takes the board lock (plan §2.9). Suppression is per
// session per qid, in hook-state/, like the reconciliation signature: a question surfaces once per
// session, and PostCompact clears the session's suppression so each open question is asked once more.
//
// Routing is by `asked.ownerSession` (the session that prepared the dispatch). A question whose owner
// session has ended (SessionEnd writes a marker) or that no session has surfaced for ORPHAN_AFTER_MS
// is an orphan, and any session in the project may surface it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveSidequestHome } from '../../lib/claude-home.js';
import { runtimeModule } from './paths.js';

type QuestionLog = typeof import('../../lib/store/question-log.js');
export type QuestionState = import('../../lib/store/question-log.js').QuestionState;

export const ORPHAN_AFTER_MS = 10 * 60 * 1000;
const MARKER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface ProjectStore {
  nearestRepoRoot: (start: string) => string;
  findProject: (start: string) => { ok: boolean; slug?: string };
}

export function questionLog(): QuestionLog {
  return require(runtimeModule('store/question-log')) as QuestionLog;
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stateDir(...parts: string[]): string {
  return path.join(resolveSidequestHome(), 'hook-state', ...parts);
}

function suppressionFile(sessionId: string): string {
  return stateDir(`question-surfaced-${hash(sessionId)}.json`);
}

function seenFile(qid: string): string {
  return stateDir('question-seen', qid);
}

function sessionEndedFile(sessionId: string): string {
  return stateDir('question-session-ended', hash(sessionId));
}

function writeAtomic(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, contents);
  fs.renameSync(temp, file);
}

function mtimeMs(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch (_) {
    return null;
  }
}

// The project slug for a hook payload's cwd, the same lookup the reconciliation reminder uses. A read of
// the project registry, never the board lock.
export function projectSlugFor(start: string, store: ProjectStore): string | null {
  try {
    let project = store.findProject(store.nearestRepoRoot(start));
    if (!project.ok || !project.slug) project = store.findProject(start);
    return project.ok && project.slug ? project.slug : null;
  } catch (_) {
    return null;
  }
}

export function surfacedQids(sessionId: string): Set<string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(suppressionFile(sessionId), 'utf8')) as { qids?: unknown };
    return new Set(Array.isArray(parsed.qids) ? parsed.qids.filter((qid): qid is string => typeof qid === 'string') : []);
  } catch (_) {
    return new Set();
  }
}

// Records that this session surfaced these qids, and stamps each qid's project-wide "seen" marker so
// the orphan clock restarts.
export function markSurfaced(sessionId: string, qids: string[]): void {
  if (!sessionId || !qids.length) return;
  const ql = questionLog();
  try {
    const merged = surfacedQids(sessionId);
    for (const qid of qids) merged.add(qid);
    writeAtomic(suppressionFile(sessionId), JSON.stringify({ qids: [...merged] }));
  } catch (_) {}
  for (const qid of qids) {
    if (!ql.isQuestionId(qid)) continue;
    try {
      writeAtomic(seenFile(qid), new Date().toISOString());
    } catch (_) {}
  }
}

export function clearSuppression(sessionId: string): void {
  if (!sessionId) return;
  try {
    fs.rmSync(suppressionFile(sessionId), { force: true });
  } catch (_) {}
}

export function markSessionEnded(sessionId: string): void {
  if (!sessionId) return;
  try {
    writeAtomic(sessionEndedFile(sessionId), new Date().toISOString());
  } catch (_) {}
  clearSuppression(sessionId);
}

function blockOnceFile(agentKey: string): string {
  return stateDir('question-block-once', hash(agentKey));
}

// SubagentStop block-once: true when this agent has been blocked for at least one question.
export function blockedOnce(agentKey: string): boolean {
  return Boolean(agentKey) && mtimeMs(blockOnceFile(agentKey)) !== null;
}

// Records the qids this agent is being blocked for. Returns true only when at least one qid is new, so
// a stop is blocked at most once per agent per question, and false when the marker cannot be written
// (an unrecordable block could repeat, so it is never issued).
export function markBlockOnce(agentKey: string, qids: string[]): boolean {
  if (!agentKey || !qids.length) return false;
  const file = blockOnceFile(agentKey);
  let prior: string[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { qids?: unknown };
    prior = Array.isArray(parsed.qids) ? parsed.qids.filter((qid): qid is string => typeof qid === 'string') : [];
  } catch (_) {}
  const fresh = qids.filter((qid) => !prior.includes(qid));
  if (!fresh.length) return false;
  try {
    writeAtomic(file, JSON.stringify({ qids: [...prior, ...fresh] }));
    return true;
  } catch (_) {
    return false;
  }
}

// Drops seen, session-ended and block-once markers older than a week, so the directories stay bounded.
export function pruneQuestionMarkers(now = Date.now()): void {
  for (const dir of [stateDir('question-seen'), stateDir('question-session-ended'), stateDir('question-block-once')]) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch (_) {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      const at = mtimeMs(file);
      if (at !== null && now - at > MARKER_RETENTION_MS) {
        try {
          fs.rmSync(file, { force: true });
        } catch (_) {}
      }
    }
  }
}

function routedTo(question: QuestionState, sessionId: string, now: number): boolean {
  const owner = question.asked.ownerSession;
  if (!owner || owner === sessionId) return true;
  if (mtimeMs(sessionEndedFile(owner)) !== null) return true;
  const lastSeen = mtimeMs(seenFile(question.qid)) ?? Date.parse(question.asked.at);
  return Number.isFinite(lastSeen) && now - lastSeen >= ORPHAN_AFTER_MS;
}

// Open questions (state "open" only; answered-undelivered ones need no user) routed to this session.
export function routedOpenQuestions(slug: string, sessionId: string, now = Date.now()): QuestionState[] {
  const ql = questionLog();
  const dir = ql.questionLogDir(slug);
  if (!fs.existsSync(dir)) return [];
  return ql.openQuestions(dir).filter((question) => routedTo(question, sessionId, now));
}

// Routed open questions this session has not surfaced yet.
export function unsurfacedQuestions(slug: string, sessionId: string, now = Date.now()): QuestionState[] {
  const surfaced = surfacedQids(sessionId);
  return routedOpenQuestions(slug, sessionId, now).filter((question) => !surfaced.has(question.qid));
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function clipText(value: string, maxBytes: number): string {
  const flat = String(value || '').replace(/\s+/g, ' ').trim();
  if (byteLength(flat) <= maxBytes) return flat;
  let clipped = '';
  for (const character of flat) {
    if (byteLength(clipped + character) > Math.max(0, maxBytes - byteLength('…'))) break;
    clipped += character;
  }
  return `${clipped.trimEnd()}…`;
}

export function questionLabel(question: QuestionState): string {
  return `${question.ref} ${question.seq}`;
}

function answerCall(question: QuestionState): string {
  return `answer({ref:"${question.ref}",question:"${question.qid}",text:…})`;
}

// Fits `prefix + text + suffix` inside maxBytes by clipping only the question text.
function withClippedText(prefix: string, text: string, suffix: string, maxBytes: number): string {
  return `${prefix}${clipText(text, maxBytes - byteLength(prefix) - byteLength(suffix))}${suffix}`;
}

// Stop: one item per stop (plan §2.9). The question text is the only part that is clipped.
export function stopQuestionItem(question: QuestionState, more: number, maxBytes = 512): string {
  const prefix = `Sidequest: ${questionLabel(question)} needs the user: `;
  const suffix = `. Full text: pulse({ref:"${question.ref}"}). Ask with AskUserQuestion, then ${answerCall(question)}.`
    + (more > 0 ? ` ${more} more open.` : '');
  return withClippedText(prefix, question.asked.text, suffix, maxBytes);
}

// UserPromptSubmit: a relay of the newest unsurfaced question with as much text as fits in 1 KiB.
export function promptQuestionRelay(questions: QuestionState[], maxBytes = 1024): string {
  const [first, ...rest] = questions;
  if (!first) return '';
  const header = first.asked.header ? `${first.asked.header}: ` : '';
  const others = rest.length
    ? ` Also open: ${rest.slice(0, 4).map(questionLabel).join(', ')}${rest.length > 4 ? ` (+${rest.length - 4} more)` : ''}.`
    : '';
  const prefix = `Sidequest: ${questionLabel(first)} needs the user (qid ${first.qid}${first.asked.blocking ? ', blocking' : ''}). ${header}`;
  const suffix = `. Ask the user with AskUserQuestion, then ${answerCall(first)}; never answer it yourself.${others}`;
  return withClippedText(prefix, first.asked.text, suffix, maxBytes);
}

// SessionStart and PostCompact: one line naming every routed open question.
export function questionSummaryLine(questions: QuestionState[], maxBytes = 400): string {
  if (!questions.length) return '';
  const shown = questions.slice(0, 6).map(questionLabel).join(', ');
  const extra = questions.length > 6 ? ` (+${questions.length - 6} more)` : '';
  const line = `Sidequest: ${questions.length} open question${questions.length === 1 ? '' : 's'} need${questions.length === 1 ? 's' : ''} the user: ${shown}${extra}. Read each with pulse({ref}), ask with AskUserQuestion, then answer({ref,question,text}).`;
  return clipText(line, maxBytes);
}

export interface MessageMarker {
  kind: 'question' | 'answer';
  raw: string;
  qid: string | null;
  aid: string | null;
}

// The markers ask and answer put at the head of their returned SendMessage (src/lib/mcp-questions.ts):
// `[sidequest:question REF Qn qid=q_… blocking=y reply-to=NAME]` and `[sidequest:answer REF Qn qid=q_… aid=a_…]`.
// qid and aid are null when the field is missing or malformed, which the peer guard treats as unknown.
export function messageMarkers(message: unknown): MessageMarker[] {
  const text = typeof message === 'string' ? message : message == null ? '' : JSON.stringify(message);
  if (!text.includes('[sidequest:')) return [];
  const log = questionLog();
  const markers: MessageMarker[] = [];
  for (const match of text.matchAll(/\[sidequest:(question|answer)\b([^\]]*)\]/g)) {
    const fields = match[2] ?? '';
    const field = (name: string): string | null => {
      const found = new RegExp(`(?:^|\\s)${name}=(\\S+)`).exec(fields);
      return found?.[1] ?? null;
    };
    const qid = field('qid');
    const aid = field('aid');
    markers.push({
      kind: match[1] as 'question' | 'answer',
      raw: match[0],
      qid: qid && log.isQuestionId(qid) ? qid : null,
      aid: aid && log.isAnswerId(aid) ? aid : null,
    });
  }
  return markers;
}
