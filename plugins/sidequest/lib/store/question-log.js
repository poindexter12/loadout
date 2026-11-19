"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var question_log_exports = {};
__export(question_log_exports, {
  ACTIVE_SEGMENT: () => ACTIVE_SEGMENT,
  ANSWER_VIAS: () => ANSWER_VIAS,
  APPEND_LOCK: () => APPEND_LOCK,
  ASK_ORIGINS: () => ASK_ORIGINS,
  BODIES_DIR: () => BODIES_DIR,
  FOLD_FILE: () => FOLD_FILE,
  MAX_ANSWER_BYTES: () => MAX_ANSWER_BYTES,
  MAX_HEADER_CHARS: () => MAX_HEADER_CHARS,
  MAX_INLINE_ANSWER_BYTES: () => MAX_INLINE_ANSWER_BYTES,
  MAX_LINE_BYTES: () => MAX_LINE_BYTES,
  MAX_OPEN_PER_TICKET: () => MAX_OPEN_PER_TICKET,
  MAX_OPTIONS: () => MAX_OPTIONS,
  MAX_OPTION_DESCRIPTION_CHARS: () => MAX_OPTION_DESCRIPTION_CHARS,
  MAX_OPTION_LABEL_CHARS: () => MAX_OPTION_LABEL_CHARS,
  MAX_PREVIEW_CHARS: () => MAX_PREVIEW_CHARS,
  MAX_QUESTION_BYTES: () => MAX_QUESTION_BYTES,
  MAX_SEGMENT_BYTES: () => MAX_SEGMENT_BYTES,
  MIN_OPTIONS: () => MIN_OPTIONS,
  NEXT_SEGMENT: () => NEXT_SEGMENT,
  QUESTION_EVENT_TYPES: () => QUESTION_EVENT_TYPES,
  QUESTION_FOLD_VERSION: () => QUESTION_FOLD_VERSION,
  QUESTION_LOG_REFUSALS: () => QUESTION_LOG_REFUSALS,
  QUESTION_LOG_VERSION: () => QUESTION_LOG_VERSION,
  RECENT_LIMIT: () => RECENT_LIMIT,
  RETENTION_DAYS: () => RETENTION_DAYS,
  WITHDRAW_REASONS: () => WITHDRAW_REASONS,
  advanceFold: () => advanceFold,
  answerQuestion: () => answerQuestion,
  askQuestion: () => askQuestion,
  findQuestion: () => findQuestion,
  foldQuestions: () => foldQuestions,
  isAnswerId: () => isAnswerId,
  isQuestionId: () => isQuestionId,
  listArchivedSegments: () => listArchivedSegments,
  newAnswerId: () => newAnswerId,
  newQuestionId: () => newQuestionId,
  openQuestions: () => openQuestions,
  pruneQuestionLog: () => pruneQuestionLog,
  questionLogDir: () => questionLogDir,
  readAnswerBody: () => readAnswerBody,
  readQuestionLog: () => readQuestionLog,
  readSegmentIndex: () => readSegmentIndex,
  recordDelivered: () => recordDelivered,
  recordSent: () => recordSent,
  seqNumber: () => seqNumber,
  summarizeQuestion: () => summarizeQuestion,
  withdrawQuestion: () => withdrawQuestion
});
module.exports = __toCommonJS(question_log_exports);
var import_node_crypto = __toESM(require("node:crypto"));
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var import_claude_home = require("../claude-home.js");
var import_mkdir_lock = require("../mkdir-lock.js");
const QUESTION_LOG_VERSION = 1;
const QUESTION_FOLD_VERSION = 1;
const ACTIVE_SEGMENT = "questions.jsonl";
const NEXT_SEGMENT = "questions.next.jsonl";
const FOLD_FILE = "fold.json";
const APPEND_LOCK = "append.lock";
const BODIES_DIR = "bodies";
const MAX_LINE_BYTES = 4096;
const MAX_QUESTION_BYTES = 1500;
const MAX_HEADER_CHARS = 12;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_OPTION_LABEL_CHARS = 60;
const MAX_OPTION_DESCRIPTION_CHARS = 200;
const MAX_INLINE_ANSWER_BYTES = 2048;
const MAX_ANSWER_BYTES = 64 * 1024;
const MAX_PREVIEW_CHARS = 200;
const MAX_OPEN_PER_TICKET = 3;
const MAX_SEGMENT_BYTES = 1024 * 1024;
const RETENTION_DAYS = 90;
const RECENT_LIMIT = 50;
const HEAD_BYTES = 256;
const DAY_MS = 24 * 60 * 60 * 1e3;
const QUESTION_EVENT_TYPES = ["asked", "sent", "delivered", "answered", "withdrawn", "carried"];
const ANSWER_VIAS = ["user", "user-prompt", "dashboard", "orchestrator"];
const WITHDRAW_REASONS = ["resolved", "ticket-closed", "oracle"];
const ASK_ORIGINS = ["runtime", "filing"];
const QUESTION_LOG_REFUSALS = [
  "too_many_open",
  "options_out_of_range",
  "question_too_long",
  "question_empty",
  "answer_too_long",
  "answer_empty",
  "no_such_question",
  "already_answered",
  "question_log_busy"
];
const QID_PATTERN = /^q_[0-9a-z]+_[0-9a-z]{6}$/;
const AID_PATTERN = /^a_[0-9a-z]+_[0-9a-z]{6}$/;
const SEQ_PATTERN = /^Q([1-9][0-9]*)$/;
const ARCHIVE_PATTERN = /^questions-(\d{8}T\d{9}Z)\.jsonl$/;
function questionLogDir(slug, home = (0, import_claude_home.resolveSidequestHome)()) {
  const name = String(slug || "");
  if (!name || name !== import_node_path.default.basename(name) || name === "." || name === "..") {
    throw new TypeError(`questionLogDir: invalid project slug ${JSON.stringify(slug)}`);
  }
  return import_node_path.default.join(home, "projects", name, "questions");
}
function randomSuffix() {
  return import_node_crypto.default.randomInt(0, 36 ** 6).toString(36).padStart(6, "0");
}
function newQuestionId(now = Date.now()) {
  return `q_${toMs(now).toString(36)}_${randomSuffix()}`;
}
function newAnswerId(now = Date.now()) {
  return `a_${toMs(now).toString(36)}_${randomSuffix()}`;
}
function isQuestionId(value) {
  return typeof value === "string" && QID_PATTERN.test(value);
}
function isAnswerId(value) {
  return typeof value === "string" && AID_PATTERN.test(value);
}
function seqNumber(seq) {
  const match = typeof seq === "string" ? SEQ_PATTERN.exec(seq) : null;
  return match ? Number(match[1]) : 0;
}
function toMs(now) {
  return now instanceof Date ? now.getTime() : Number(now);
}
function nowDate(options) {
  if (options.now instanceof Date) return new Date(options.now.getTime());
  if (typeof options.now === "number") return new Date(options.now);
  return /* @__PURE__ */ new Date();
}
function isoMonth(date) {
  return date.toISOString().slice(0, 7);
}
function refKey(ref) {
  return String(ref).trim().toUpperCase();
}
function byteLength(text) {
  return Buffer.byteLength(text, "utf8");
}
function charLength(text) {
  return Array.from(text).length;
}
function firstChars(text, max) {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}
function sha256(text) {
  return import_node_crypto.default.createHash("sha256").update(text, "utf8").digest("hex");
}
function refusal(reason, message, extra = {}) {
  return { ok: false, reason, message, ...extra };
}
function busyRefusal(waitMs) {
  return refusal(
    "question_log_busy",
    `The question log is busy: its append lock stayed held for ${waitMs} ms and nothing was written. Retry the same call.`,
    { retryable: true }
  );
}
function tooLong(reason, field, length, max, unit) {
  return refusal(
    reason,
    `${field} is ${length} ${unit}; the limit is ${max}. Put long detail in a ticket comment and reference it.`,
    { field, length, max, unit }
  );
}
function openQids(fold, ref) {
  return ticketStates(fold, ref).filter((state) => state.state === "open").map((state) => state.qid);
}
function noSuchQuestion(fold, ref, qid) {
  const open = openQids(fold, ref);
  const listed = open.length ? open.join(", ") : "none";
  const subject = qid ? `no open question ${qid}` : "no open question";
  return refusal("no_such_question", `${ref} has ${subject}. Open questions: ${listed}.`, { open });
}
function answerQuote(answer) {
  if (answer.declined && !answer.text && !answer.preview) return "(declined)";
  const text = answer.text ?? answer.preview ?? "";
  return firstChars(text, MAX_PREVIEW_CHARS);
}
function emptyFold(inode, recentLimit, seqs) {
  return {
    v: QUESTION_FOLD_VERSION,
    segment: ACTIVE_SEGMENT,
    inode,
    head: "",
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
    recent: {}
  };
}
function normalizeRecentLimit(limit) {
  if (limit === void 0) return RECENT_LIMIT;
  if (limit === Infinity) return Infinity;
  return Number.isInteger(limit) && limit >= 0 ? limit : RECENT_LIMIT;
}
function foldRecentLimit(fold) {
  return fold.recentLimit === null ? Infinity : fold.recentLimit;
}
function isLive(state) {
  if (state.state === "open") return true;
  if (state.state === "withdrawn" || !state.answered) return false;
  const aid = state.answered.aid;
  return !state.delivered.some((delivery) => delivery.aid === aid);
}
function lookup(fold, qid) {
  return fold.open[qid] || fold.recent[qid] || null;
}
function place(fold, state) {
  delete fold.open[state.qid];
  delete fold.recent[state.qid];
  if (isLive(state)) fold.open[state.qid] = state;
  else fold.recent[state.qid] = state;
}
function bumpSeq(fold, ref, seq) {
  const key = refKey(ref);
  const number = seqNumber(seq);
  if (number > (fold.seqs[key] || 0)) fold.seqs[key] = number;
}
function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}
function normalizeOptions(value) {
  if (!Array.isArray(value) || !value.length) return null;
  return value.map((option) => ({
    label: String(option?.label ?? ""),
    description: String(option?.description ?? "")
  }));
}
function askedFromEvent(event) {
  return {
    at: event.at,
    session: stringOrNull(event.session),
    origin: event.origin === "filing" ? "filing" : "runtime",
    ownerSession: stringOrNull(event.ownerSession),
    agent: stringOrNull(event.agent),
    header: stringOrNull(event.header),
    text: String(event.text),
    options: normalizeOptions(event.options),
    multiSelect: event.multiSelect === true,
    blocking: event.blocking !== false,
    default: stringOrNull(event.default)
  };
}
function answerFromEvent(event) {
  const answer = {
    aid: event.aid,
    at: event.at,
    session: stringOrNull(event.session),
    via: ANSWER_VIAS.includes(event.via) ? event.via : "user",
    declined: event.declined === true,
    supersedes: stringOrNull(event.supersedes)
  };
  if (typeof event.text === "string") answer.text = event.text;
  if (typeof event.bodyRef === "string") {
    answer.bodyRef = event.bodyRef;
    if (typeof event.bytes === "number") answer.bytes = event.bytes;
    if (typeof event.sha256 === "string") answer.sha256 = event.sha256;
    if (typeof event.preview === "string") answer.preview = event.preview;
  }
  return answer;
}
function carriedState(event) {
  const state = event.state;
  if (!state || typeof state !== "object" || !state.asked || typeof state.asked.text !== "string") return null;
  if (typeof state.seq !== "string" || !SEQ_PATTERN.test(state.seq)) return null;
  const answered = state.answered && isAnswerId(state.answered.aid) ? answerFromEvent(state.answered) : null;
  const withdrawn = state.withdrawn && typeof state.withdrawn.reason === "string" ? { reason: state.withdrawn.reason, at: String(state.withdrawn.at), session: stringOrNull(state.withdrawn.session) } : null;
  const stateName = withdrawn ? "withdrawn" : answered ? answered.declined ? "declined" : "answered" : "open";
  return {
    qid: event.qid,
    ref: event.ref,
    ticketId: stringOrNull(event.ticketId),
    seq: state.seq,
    state: stateName,
    asked: askedFromEvent(state.asked),
    answered,
    superseded: Array.isArray(state.superseded) ? state.superseded.filter((answer) => isAnswerId(answer?.aid)).map(answerFromEvent) : [],
    sent: Array.isArray(state.sent) ? state.sent.map((sent) => ({ at: String(sent?.at), to: stringOrNull(sent?.to), aid: stringOrNull(sent?.aid), session: stringOrNull(sent?.session) })) : [],
    delivered: Array.isArray(state.delivered) ? state.delivered.filter((delivery) => isAnswerId(delivery?.aid)).map((delivery) => ({ aid: delivery.aid, at: String(delivery.at), session: stringOrNull(delivery.session) })) : [],
    withdrawn,
    closedAt: stateName === "open" ? null : stringOrNull(state.closedAt) ?? (answered?.at || withdrawn?.at || null)
  };
}
function applyEvent(fold, event, incremental) {
  switch (event.type) {
    case "asked": {
      if (typeof event.text !== "string" || typeof event.seq !== "string" || !SEQ_PATTERN.test(event.seq)) return "skipped";
      if (lookup(fold, event.qid)) return "skipped";
      const state2 = {
        qid: event.qid,
        ref: event.ref,
        ticketId: stringOrNull(event.ticketId),
        seq: event.seq,
        state: "open",
        asked: askedFromEvent(event),
        answered: null,
        superseded: [],
        sent: [],
        delivered: [],
        withdrawn: null,
        closedAt: null
      };
      bumpSeq(fold, state2.ref, state2.seq);
      place(fold, state2);
      return "applied";
    }
    case "carried": {
      const state2 = carriedState(event);
      if (!state2) return "skipped";
      fold.carriedLines += 1;
      bumpSeq(fold, state2.ref, state2.seq);
      if (!lookup(fold, state2.qid)) place(fold, state2);
      return "applied";
    }
    default:
      break;
  }
  const state = lookup(fold, event.qid);
  if (!state) return incremental ? "unknown" : "skipped";
  switch (event.type) {
    case "sent":
      state.sent.push({ at: event.at, to: stringOrNull(event.to), aid: isAnswerId(event.aid) ? event.aid : null, session: stringOrNull(event.session) });
      break;
    case "delivered":
      if (!isAnswerId(event.aid)) return "skipped";
      if (!state.delivered.some((delivery) => delivery.aid === event.aid)) {
        state.delivered.push({ aid: event.aid, at: event.at, session: stringOrNull(event.session) });
      }
      break;
    case "answered": {
      if (!isAnswerId(event.aid)) return "skipped";
      if (state.state === "withdrawn") break;
      const answer = answerFromEvent(event);
      if (!state.answered) {
        state.answered = answer;
      } else if (answer.supersedes && answer.supersedes === state.answered.aid) {
        state.superseded.push(state.answered);
        state.answered = answer;
      } else {
        break;
      }
      state.state = answer.declined ? "declined" : "answered";
      state.closedAt = answer.at;
      break;
    }
    case "withdrawn":
      if (state.state !== "open") break;
      state.withdrawn = {
        reason: WITHDRAW_REASONS.includes(event.reason) ? event.reason : "resolved",
        at: event.at,
        session: stringOrNull(event.session)
      };
      state.state = "withdrawn";
      state.closedAt = event.at;
      break;
    default:
      return "skipped";
  }
  place(fold, state);
  return "applied";
}
function validEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  const record = event;
  return record.v === QUESTION_LOG_VERSION && typeof record.type === "string" && QUESTION_EVENT_TYPES.includes(record.type) && isQuestionId(record.qid) && typeof record.ref === "string" && record.ref.length > 0 && typeof record.at === "string";
}
function readRange(fd, start, end) {
  const length = Math.max(0, end - start);
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = import_node_fs.default.readSync(fd, buffer, read, length - read, start + read);
    if (count === 0) break;
    read += count;
  }
  return read === length ? buffer : buffer.subarray(0, read);
}
function headDigest(fd, bytes) {
  return bytes > 0 ? import_node_crypto.default.createHash("sha1").update(readRange(fd, 0, bytes)).digest("hex") : "";
}
function foldBytes(fd, size, fold, incremental) {
  if (size <= fold.offset) return fold;
  const bytes = readRange(fd, fold.offset, size);
  let position = 0;
  while (position < bytes.length) {
    const newline = bytes.indexOf(10, position);
    if (newline < 0) break;
    const line = bytes.subarray(position, newline);
    position = newline + 1;
    fold.lines += 1;
    let event;
    try {
      event = JSON.parse(line.toString("utf8"));
    } catch (_) {
      event = null;
    }
    if (!validEvent(event)) {
      fold.skipped += 1;
    } else {
      const result = applyEvent(fold, event, incremental);
      if (result === "unknown") return null;
      if (result === "skipped") {
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
function trimRecent(fold) {
  const limit = foldRecentLimit(fold);
  const closed = Object.values(fold.recent);
  if (closed.length <= limit) return;
  closed.sort((left, right) => String(right.closedAt).localeCompare(String(left.closedAt)) || right.qid.localeCompare(left.qid));
  const kept = new Set(closed.slice(0, limit).map((state) => state.qid));
  for (const qid of Object.keys(fold.recent)) if (!kept.has(qid)) delete fold.recent[qid];
}
function reusableFold(prior, inode, size, fd, recentLimit) {
  if (!prior || prior.v !== QUESTION_FOLD_VERSION || prior.segment !== ACTIVE_SEGMENT) return false;
  if (foldRecentLimit(prior) !== recentLimit) return false;
  if (prior.inode !== inode || !Number.isInteger(prior.offset) || prior.offset < 0 || size < prior.offset) return false;
  if (!prior.open || !prior.recent || !prior.seqs) return false;
  return headDigest(fd, prior.headBytes) === prior.head;
}
function openActiveSegment(dir) {
  for (const name of [ACTIVE_SEGMENT, NEXT_SEGMENT, ACTIVE_SEGMENT]) {
    try {
      return import_node_fs.default.openSync(import_node_path.default.join(dir, name), "r");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return null;
}
function foldOpenFile(fd, prior, recentLimit, seed) {
  const stat = import_node_fs.default.fstatSync(fd);
  let fold = null;
  if (prior && reusableFold(prior, stat.ino, stat.size, fd, recentLimit)) {
    fold = foldBytes(fd, stat.size, structuredClone(prior), true);
  }
  if (!fold) fold = foldBytes(fd, stat.size, emptyFold(stat.ino, recentLimit, seed()), false);
  trimRecent(fold);
  fold.headBytes = Math.min(fold.offset, HEAD_BYTES);
  fold.head = headDigest(fd, fold.headBytes);
  return fold;
}
function advanceFold(dir, prior, options = {}) {
  const recentLimit = normalizeRecentLimit(options.recentLimit);
  const fd = openActiveSegment(dir);
  if (fd === null) return emptyFold(null, recentLimit, latestArchivedSeqs(dir));
  try {
    return foldOpenFile(fd, prior, recentLimit, () => latestArchivedSeqs(dir));
  } finally {
    import_node_fs.default.closeSync(fd);
  }
}
function foldSegmentFile(file, seqs) {
  let fd;
  try {
    fd = import_node_fs.default.openSync(file, "r");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    return foldOpenFile(fd, null, Infinity, () => seqs);
  } finally {
    import_node_fs.default.closeSync(fd);
  }
}
function loadFold(dir) {
  try {
    const parsed = JSON.parse(import_node_fs.default.readFileSync(import_node_path.default.join(dir, FOLD_FILE), "utf8"));
    return parsed && typeof parsed === "object" && parsed.v === QUESTION_FOLD_VERSION ? parsed : null;
  } catch (_) {
    return null;
  }
}
function writeFileAtomic(file, content) {
  const temp = import_node_path.default.join(import_node_path.default.dirname(file), `.${import_node_path.default.basename(file)}.${process.pid}.${randomSuffix()}.tmp`);
  try {
    import_node_fs.default.writeFileSync(temp, content);
    import_node_fs.default.renameSync(temp, file);
  } catch (error) {
    try {
      import_node_fs.default.rmSync(temp, { force: true });
    } catch (_) {
    }
    throw error;
  }
}
function saveFold(dir, fold) {
  try {
    writeFileAtomic(import_node_path.default.join(dir, FOLD_FILE), JSON.stringify(fold));
  } catch (_) {
  }
}
function sameFoldPosition(left, right) {
  return Boolean(left && left.inode === right.inode && left.offset === right.offset && left.head === right.head && left.recentLimit === right.recentLimit);
}
function readQuestionLog(dir) {
  const prior = loadFold(dir);
  const fold = advanceFold(dir, prior);
  if (fold.inode !== null && !sameFoldPosition(prior, fold)) saveFold(dir, fold);
  return fold;
}
function sortStates(states) {
  return states.sort((left, right) => left.asked.at.localeCompare(right.asked.at) || left.qid.localeCompare(right.qid));
}
function foldQuestions(fold) {
  return sortStates([...Object.values(fold.open), ...Object.values(fold.recent)]);
}
function ticketStates(fold, ref) {
  const key = refKey(ref);
  return foldQuestions(fold).filter((state) => refKey(state.ref) === key);
}
function openQuestions(dir, filter = {}) {
  const fold = readQuestionLog(dir);
  const states = sortStates(Object.values(fold.open).filter((state) => state.state === "open"));
  return filter.ref ? states.filter((state) => refKey(state.ref) === refKey(filter.ref)) : states;
}
function summarizeQuestion(state) {
  return {
    qid: state.qid,
    ref: state.ref,
    ticketId: state.ticketId,
    seq: state.seq,
    header: state.asked.header,
    text: state.asked.text,
    asker: state.asked.agent || (state.asked.origin === "filing" ? "filing" : null),
    state: state.state,
    blocking: state.asked.blocking,
    askedAt: state.asked.at,
    answeredAt: state.answered?.at ?? null,
    closedAt: state.closedAt,
    via: state.answered?.via ?? null,
    aid: state.answered?.aid ?? null,
    declined: state.answered?.declined ?? false
  };
}
function bodiesOf(states) {
  const aids = /* @__PURE__ */ new Set();
  for (const state of states) {
    for (const answer of [state.answered, ...state.superseded]) {
      if (answer?.bodyRef && isAnswerId(answer.aid)) aids.add(answer.aid);
    }
  }
  return [...aids].sort();
}
function listArchivedSegments(dir) {
  try {
    return import_node_fs.default.readdirSync(dir).filter((name) => ARCHIVE_PATTERN.test(name)).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
function indexFileName(segment) {
  return `index-${segment.replace(/\.jsonl$/, "")}.json`;
}
function readIndexFile(dir, segment) {
  try {
    const parsed = JSON.parse(import_node_fs.default.readFileSync(import_node_path.default.join(dir, indexFileName(segment)), "utf8"));
    return parsed && parsed.v === QUESTION_FOLD_VERSION && parsed.segment === segment ? parsed : null;
  } catch (_) {
    return null;
  }
}
function buildSegmentIndex(dir, segment, seqs, closedAt) {
  const fold = foldSegmentFile(import_node_path.default.join(dir, segment), seqs);
  if (!fold) return null;
  const states = foldQuestions(fold);
  const index = {
    v: QUESTION_FOLD_VERSION,
    segment,
    closedAt,
    firstAt: fold.firstAt,
    lastAt: fold.lastAt,
    lines: fold.lines,
    skipped: fold.skipped,
    seqs: fold.seqs,
    questions: states.map(summarizeQuestion),
    bodies: bodiesOf(states)
  };
  try {
    writeFileAtomic(import_node_path.default.join(dir, indexFileName(segment)), JSON.stringify(index));
  } catch (_) {
  }
  return index;
}
function archiveStampTime(segment) {
  const match = ARCHIVE_PATTERN.exec(segment);
  if (!match) return null;
  const stamp = match[1];
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.${stamp.slice(15, 18)}Z`;
}
function readSegmentIndex(dir, segment) {
  const existing = readIndexFile(dir, segment);
  if (existing) return existing;
  const segments = listArchivedSegments(dir);
  const position = segments.indexOf(segment);
  if (position < 0) return null;
  const previous = position > 0 ? readSegmentIndex(dir, segments[position - 1]) : null;
  return buildSegmentIndex(dir, segment, previous?.seqs || {}, archiveStampTime(segment));
}
function latestArchivedSeqs(dir) {
  const segments = listArchivedSegments(dir);
  const newest = segments[segments.length - 1];
  return newest ? readSegmentIndex(dir, newest)?.seqs || {} : {};
}
function findQuestion(dir, qid) {
  if (!isQuestionId(qid)) return null;
  return locateState(dir, readQuestionLog(dir), qid)?.state ?? null;
}
function locateState(dir, fold, qid) {
  const folded = lookup(fold, qid);
  if (folded) return { state: folded, active: true };
  const full = advanceFold(dir, null, { recentLimit: Infinity });
  const inActive = lookup(full, qid);
  if (inActive) return { state: inActive, active: true };
  const segments = listArchivedSegments(dir);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    const summary = readSegmentIndex(dir, segment);
    if (summary && !summary.questions.some((question) => question.qid === qid)) continue;
    const archived = foldSegmentFile(import_node_path.default.join(dir, segment), {});
    const state = archived ? lookup(archived, qid) : null;
    if (state) return { state, active: false };
  }
  return null;
}
function readAnswerBody(dir, aid) {
  if (!isAnswerId(aid)) return null;
  try {
    return import_node_fs.default.readFileSync(import_node_path.default.join(dir, BODIES_DIR, `${aid}.txt`), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function recoverInterruptedRotation(dir) {
  const next = import_node_path.default.join(dir, NEXT_SEGMENT);
  if (!import_node_fs.default.existsSync(next)) return;
  if (import_node_fs.default.existsSync(import_node_path.default.join(dir, ACTIVE_SEGMENT))) {
    import_node_fs.default.rmSync(next, { force: true });
  } else {
    import_node_fs.default.renameSync(next, import_node_path.default.join(dir, ACTIVE_SEGMENT));
  }
}
function underLock(dir, options, fn) {
  const waitMs = options.lockWaitMs ?? import_mkdir_lock.MKDIR_LOCK_WAIT_MS;
  import_node_fs.default.mkdirSync(dir, { recursive: true });
  const result = (0, import_mkdir_lock.withMkdirLock)(import_node_path.default.join(dir, APPEND_LOCK), () => {
    recoverInterruptedRotation(dir);
    const context = {
      dir,
      now: nowDate(options),
      fold: advanceFold(dir, loadFold(dir)),
      maxSegmentBytes: options.maxSegmentBytes ?? MAX_SEGMENT_BYTES,
      retentionDays: options.retentionDays ?? RETENTION_DAYS
    };
    const value = fn(context);
    if (context.fold.inode !== null) saveFold(dir, context.fold);
    return value;
  }, { waitMs });
  return result.acquired ? result.value : busyRefusal(waitMs);
}
function segmentSize(dir) {
  try {
    return import_node_fs.default.statSync(import_node_path.default.join(dir, ACTIVE_SEGMENT)).size;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}
function archiveName(dir, now) {
  let time = now.getTime();
  while (true) {
    const stamp = new Date(time).toISOString().replace(/[-:.]/g, "");
    const name = `questions-${stamp}.jsonl`;
    if (!import_node_fs.default.existsSync(import_node_path.default.join(dir, name)) && !import_node_fs.default.existsSync(import_node_path.default.join(dir, indexFileName(name)))) return name;
    time += 1;
  }
}
function withinRetention(at, context) {
  const time = Date.parse(String(at));
  return Number.isFinite(time) && context.now.getTime() - time <= context.retentionDays * DAY_MS;
}
function carriedLine(state, at) {
  return { v: QUESTION_LOG_VERSION, type: "carried", qid: state.qid, ref: state.ref, ticketId: state.ticketId, at, session: null, state };
}
function rotate(context) {
  const { dir } = context;
  const at = context.now.toISOString();
  const carried = sortStates(Object.values(context.fold.open)).filter((state) => state.state === "open" || withinRetention(state.answered?.at, context));
  import_node_fs.default.writeFileSync(import_node_path.default.join(dir, NEXT_SEGMENT), carried.map((state) => `${JSON.stringify(carriedLine(state, at))}
`).join(""));
  const archived = archiveName(dir, context.now);
  import_node_fs.default.renameSync(import_node_path.default.join(dir, ACTIVE_SEGMENT), import_node_path.default.join(dir, archived));
  import_node_fs.default.renameSync(import_node_path.default.join(dir, NEXT_SEGMENT), import_node_path.default.join(dir, ACTIVE_SEGMENT));
  buildSegmentIndex(dir, archived, context.fold.seqs, at);
  context.fold = advanceFold(dir, null);
}
function maybeRotate(context, bytes) {
  const size = segmentSize(context.dir);
  if (size === 0) return;
  const monthChanged = context.fold.month !== null && context.fold.month !== isoMonth(context.now);
  const full = size + bytes > context.maxSegmentBytes && context.fold.lines > context.fold.carriedLines;
  if (monthChanged || full) rotate(context);
}
function appendEvents(context, events) {
  if (!events.length) return;
  const payload = events.map((event) => `${JSON.stringify(event)}
`).join("");
  maybeRotate(context, byteLength(payload));
  const fd = import_node_fs.default.openSync(import_node_path.default.join(context.dir, ACTIVE_SEGMENT), "a+");
  try {
    const size = import_node_fs.default.fstatSync(fd).size;
    let repair = "";
    if (size > 0) {
      const last = readRange(fd, size - 1, size);
      if (last[0] !== 10) repair = "\n";
    }
    const buffer = Buffer.from(repair + payload, "utf8");
    let written = 0;
    while (written < buffer.length) written += import_node_fs.default.writeSync(fd, buffer, written, buffer.length - written);
  } finally {
    import_node_fs.default.closeSync(fd);
  }
  context.fold = advanceFold(context.dir, context.fold);
}
function baseEvent(type, state, context, session) {
  return { v: QUESTION_LOG_VERSION, type, qid: state.qid, ref: state.ref, ticketId: state.ticketId, at: context.now.toISOString(), session };
}
function assertEnum(name, value, allowed) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new TypeError(`${name} must be one of ${allowed.join(", ")}; got ${JSON.stringify(value)}`);
  }
  return value;
}
function requireRef(ref) {
  const value = typeof ref === "string" ? ref.trim() : "";
  if (!value) throw new TypeError("ref is required");
  return value;
}
function validateAsk(input) {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) return refusal("question_empty", "Give the question text.");
  if (byteLength(text) > MAX_QUESTION_BYTES) return tooLong("question_too_long", "question", byteLength(text), MAX_QUESTION_BYTES, "bytes");
  const header = typeof input.header === "string" && input.header.trim() ? input.header.trim() : null;
  if (header && charLength(header) > MAX_HEADER_CHARS) return tooLong("question_too_long", "header", charLength(header), MAX_HEADER_CHARS, "chars");
  let options = null;
  if (Array.isArray(input.options) && input.options.length) {
    if (input.options.length < MIN_OPTIONS || input.options.length > MAX_OPTIONS) {
      return refusal("options_out_of_range", `${MIN_OPTIONS} to ${MAX_OPTIONS} options (AskUserQuestion's limit); omit for free text.`, { length: input.options.length, min: MIN_OPTIONS, max: MAX_OPTIONS });
    }
    options = [];
    for (const [index, option] of input.options.entries()) {
      const label = typeof option?.label === "string" ? option.label.trim() : "";
      const description = typeof option?.description === "string" ? option.description.trim() : "";
      if (!label) return refusal("question_empty", `options[${index}].label is empty; every option needs a label.`, { field: `options[${index}].label` });
      if (charLength(label) > MAX_OPTION_LABEL_CHARS) return tooLong("question_too_long", `options[${index}].label`, charLength(label), MAX_OPTION_LABEL_CHARS, "chars");
      if (charLength(description) > MAX_OPTION_DESCRIPTION_CHARS) return tooLong("question_too_long", `options[${index}].description`, charLength(description), MAX_OPTION_DESCRIPTION_CHARS, "chars");
      options.push({ label, description });
    }
  }
  return { header, text, options };
}
function askQuestion(dir, input, options = {}) {
  const ref = requireRef(input.ref);
  const origin = assertEnum("origin", input.origin ?? "runtime", ASK_ORIGINS);
  const validated = validateAsk(input);
  if ("ok" in validated) return validated;
  return underLock(dir, options, (context) => {
    const open = openQids(context.fold, ref);
    if (open.length >= MAX_OPEN_PER_TICKET) {
      return refusal("too_many_open", `${ref} already has ${MAX_OPEN_PER_TICKET} open questions; withdraw or wait.`, { open });
    }
    const seq = `Q${(context.fold.seqs[refKey(ref)] || 0) + 1}`;
    const qid = newQuestionId(context.now);
    const ticketId = stringOrNull(input.ticketId);
    const blocking = input.blocking !== false;
    const event = {
      ...baseEvent("asked", { qid, ref, ticketId }, context, stringOrNull(input.session)),
      seq,
      origin,
      ownerSession: stringOrNull(input.ownerSession),
      agent: stringOrNull(input.agent),
      header: validated.header,
      text: validated.text,
      ...validated.options ? { options: validated.options, multiSelect: input.multiSelect === true } : { multiSelect: false },
      blocking,
      default: stringOrNull(input.default)
    };
    const lineBytes = byteLength(JSON.stringify(event)) + 1;
    if (lineBytes > MAX_LINE_BYTES) return tooLong("question_too_long", "line", lineBytes, MAX_LINE_BYTES, "bytes");
    appendEvents(context, [event]);
    return { ok: true, qid, seq, ref, ticketId, blocking, open: open.length + 1, at: context.now.toISOString() };
  });
}
function sameAnswer(existing, text, declined) {
  if (existing.declined !== declined) return false;
  if (typeof existing.text === "string") return existing.text === text;
  if (existing.sha256) return existing.sha256 === sha256(text);
  return !text;
}
function answerResult(context, state, answer, idempotent) {
  const open = ticketStates(context.fold, state.ref).filter((candidate) => candidate.state === "open");
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
    inline: typeof answer.text === "string" || !answer.bodyRef,
    bodyRef: answer.bodyRef ?? null,
    idempotent,
    openForTicket: open.map((candidate) => candidate.qid),
    blockingOpen: open.filter((candidate) => candidate.asked.blocking).length
  };
}
function writeBody(dir, aid, text) {
  const bodies = import_node_path.default.join(dir, BODIES_DIR);
  import_node_fs.default.mkdirSync(bodies, { recursive: true });
  writeFileAtomic(import_node_path.default.join(bodies, `${aid}.txt`), text);
  return `${BODIES_DIR}/${aid}.txt`;
}
function answerQuestion(dir, input, options = {}) {
  const ref = requireRef(input.ref);
  const via = assertEnum("via", input.via ?? "user", ANSWER_VIAS);
  const declined = input.decline === true;
  const text = typeof input.text === "string" ? input.text : "";
  if (!declined && !text.trim()) return refusal("answer_empty", "Give the answer text, or pass decline:true.");
  const bytes = byteLength(text);
  if (bytes > MAX_ANSWER_BYTES) return tooLong("answer_too_long", "answer", bytes, MAX_ANSWER_BYTES, "bytes");
  const requested = typeof input.question === "string" && input.question ? input.question : null;
  return underLock(dir, options, (context) => {
    let located = null;
    if (requested) {
      located = isQuestionId(requested) ? locateState(dir, context.fold, requested) : null;
    } else {
      const oldest = ticketStates(context.fold, ref).find((state2) => state2.state === "open");
      located = oldest ? { state: oldest, active: true } : null;
    }
    if (!located || refKey(located.state.ref) !== refKey(ref) || located.state.state === "withdrawn") {
      return noSuchQuestion(context.fold, ref, requested);
    }
    const state = located.state;
    const supersedes = typeof input.supersedes === "string" && input.supersedes ? input.supersedes : null;
    if (state.answered) {
      if (!supersedes || supersedes !== state.answered.aid) {
        if (sameAnswer(state.answered, text, declined)) return answerResult(context, state, state.answered, true);
        return refusal(
          "already_answered",
          `${state.ref} ${state.seq} is already answered (${state.answered.aid}): "${answerQuote(state.answered)}". Do not ask the user again; pass supersedes:${state.answered.aid} only if the user changed their mind.`,
          { qid: state.qid, aid: state.answered.aid, via: state.answered.via, declined: state.answered.declined }
        );
      }
    }
    const aid = newAnswerId(context.now);
    const event = {
      ...baseEvent("answered", state, context, stringOrNull(input.session)),
      aid,
      via,
      declined,
      ...state.answered && supersedes ? { supersedes } : {}
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
    const events = located.active ? [event] : [carriedLine(state, context.now.toISOString()), event];
    appendEvents(context, events);
    const folded = lookup(context.fold, state.qid) || state;
    return answerResult(context, folded, folded.answered || answerFromEvent(event), false);
  });
}
function withdrawQuestion(dir, input, options = {}) {
  const ref = requireRef(input.ref);
  const reason = assertEnum("reason", input.reason, WITHDRAW_REASONS);
  const requested = typeof input.qid === "string" && input.qid ? input.qid : null;
  return underLock(dir, options, (context) => {
    const open = ticketStates(context.fold, ref).filter((state) => state.state === "open");
    let targets = open;
    if (requested) {
      targets = open.filter((state) => state.qid === requested);
      if (!targets.length) return noSuchQuestion(context.fold, ref, requested);
    }
    appendEvents(context, targets.map((state) => ({ ...baseEvent("withdrawn", state, context, stringOrNull(input.session)), reason })));
    return { ok: true, withdrawn: targets.map((state) => state.qid) };
  });
}
function stateForAid(fold, aid) {
  return foldQuestions(fold).find((state) => state.answered?.aid === aid || state.superseded.some((answer) => answer.aid === aid)) || null;
}
function recordSent(dir, input, options = {}) {
  const aid = isAnswerId(input.aid) ? input.aid : null;
  const qid = isQuestionId(input.qid) ? input.qid : null;
  return underLock(dir, options, (context) => {
    const state = qid ? lookup(context.fold, qid) : aid ? stateForAid(context.fold, aid) : null;
    if (!state) return refusal("no_such_question", `No live question matches ${qid || aid || "that marker"}.`, { qid, aid });
    appendEvents(context, [{ ...baseEvent("sent", state, context, stringOrNull(input.session)), to: String(input.to ?? ""), ...aid ? { aid } : {} }]);
    return { ok: true, qid: state.qid };
  });
}
function recordDelivered(dir, input, options = {}) {
  const aid = isAnswerId(input.aid) ? input.aid : null;
  return underLock(dir, options, (context) => {
    const state = aid ? stateForAid(context.fold, aid) : null;
    if (!state || !aid) return refusal("no_such_question", `No recorded answer matches ${input.aid}.`, { aid: input.aid });
    if (state.delivered.some((delivery) => delivery.aid === aid)) return { ok: true, qid: state.qid, duplicate: true };
    appendEvents(context, [{ ...baseEvent("delivered", state, context, stringOrNull(input.session)), aid }]);
    return { ok: true, qid: state.qid, duplicate: false };
  });
}
function pruneQuestionLog(dir, options = {}) {
  if (!import_node_fs.default.existsSync(dir)) return { ok: true, removedSegments: [], removedIndexes: [], removedBodies: [] };
  return underLock(dir, options, (context) => {
    const cutoff = context.now.getTime() - context.retentionDays * DAY_MS;
    const removedSegments = [];
    const removedIndexes = [];
    const removedBodies = [];
    const retained = /* @__PURE__ */ new Set();
    for (const segment of listArchivedSegments(dir)) {
      const index = readSegmentIndex(dir, segment);
      const newest = Date.parse(String(index?.lastAt || index?.closedAt || archiveStampTime(segment)));
      if (Number.isFinite(newest) && newest < cutoff) {
        import_node_fs.default.rmSync(import_node_path.default.join(dir, segment), { force: true });
        removedSegments.push(segment);
      } else {
        for (const aid of index?.bodies || []) retained.add(aid);
      }
    }
    const live = new Set(listArchivedSegments(dir).map(indexFileName));
    for (const name of import_node_fs.default.readdirSync(dir)) {
      if (/^index-questions-.*\.json$/.test(name) && !live.has(name)) {
        import_node_fs.default.rmSync(import_node_path.default.join(dir, name), { force: true });
        removedIndexes.push(name);
      }
    }
    const active = advanceFold(dir, null, { recentLimit: Infinity });
    for (const aid of bodiesOf(Object.values({ ...active.open, ...active.recent }))) retained.add(aid);
    const bodies = import_node_path.default.join(dir, BODIES_DIR);
    let names = [];
    try {
      names = import_node_fs.default.readdirSync(bodies);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const name of names) {
      const aid = name.endsWith(".txt") ? name.slice(0, -4) : null;
      if (aid && isAnswerId(aid) && retained.has(aid)) continue;
      import_node_fs.default.rmSync(import_node_path.default.join(bodies, name), { force: true });
      removedBodies.push(name);
    }
    return { ok: true, removedSegments, removedIndexes, removedBodies };
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ACTIVE_SEGMENT,
  ANSWER_VIAS,
  APPEND_LOCK,
  ASK_ORIGINS,
  BODIES_DIR,
  FOLD_FILE,
  MAX_ANSWER_BYTES,
  MAX_HEADER_CHARS,
  MAX_INLINE_ANSWER_BYTES,
  MAX_LINE_BYTES,
  MAX_OPEN_PER_TICKET,
  MAX_OPTIONS,
  MAX_OPTION_DESCRIPTION_CHARS,
  MAX_OPTION_LABEL_CHARS,
  MAX_PREVIEW_CHARS,
  MAX_QUESTION_BYTES,
  MAX_SEGMENT_BYTES,
  MIN_OPTIONS,
  NEXT_SEGMENT,
  QUESTION_EVENT_TYPES,
  QUESTION_FOLD_VERSION,
  QUESTION_LOG_REFUSALS,
  QUESTION_LOG_VERSION,
  RECENT_LIMIT,
  RETENTION_DAYS,
  WITHDRAW_REASONS,
  advanceFold,
  answerQuestion,
  askQuestion,
  findQuestion,
  foldQuestions,
  isAnswerId,
  isQuestionId,
  listArchivedSegments,
  newAnswerId,
  newQuestionId,
  openQuestions,
  pruneQuestionLog,
  questionLogDir,
  readAnswerBody,
  readQuestionLog,
  readSegmentIndex,
  recordDelivered,
  recordSent,
  seqNumber,
  summarizeQuestion,
  withdrawQuestion
});
