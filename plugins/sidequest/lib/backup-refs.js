"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var backup_refs_exports = {};
__export(backup_refs_exports, {
  BACKUP_REF_NAMESPACE: () => BACKUP_REF_NAMESPACE,
  CANDIDATE_REF_NAMESPACE: () => CANDIDATE_REF_NAMESPACE,
  backupRefName: () => backupRefName,
  backupStamp: () => backupStamp,
  boardRefSurface: () => boardRefSurface,
  isTicketRef: () => isTicketRef,
  listBackupRefs: () => listBackupRefs,
  pruneBackupRefs: () => pruneBackupRefs,
  ticketRefSurface: () => ticketRefSurface,
  unrecognizedCandidateRefs: () => unrecognizedCandidateRefs,
  writeBackupRef: () => writeBackupRef
});
module.exports = __toCommonJS(backup_refs_exports);
var import_node_child_process = require("node:child_process");
const BACKUP_REF_NAMESPACE = "refs/sidequest-backup";
const CANDIDATE_REF_NAMESPACE = "refs/sidequest";
const EMPTY_OID = "0000000000000000000000000000000000000000";
const TICKET_REF_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const STAMP_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z(?:-(\d+))?$/;
const BOARD_CANDIDATE_SUFFIX_RE = /^(?:-rejected(?:-\d+)?|\/r\d+)?$/;
const BOARD_CANDIDATE_RE = /^([A-Za-z][A-Za-z0-9]*-\d+)(?:-rejected(?:-\d+)?|\/r\d+)?$/;
function errorMessage(error) {
  const stderr = error?.stderr;
  const text = typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf8") : "";
  return (text || (error instanceof Error ? error.message : String(error))).trim();
}
function git(cwd, args) {
  try {
    const value = (0, import_node_child_process.execFileSync)("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, value: value.trim() };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}
function usableDirectory(cwd) {
  const dir = String(cwd || "").trim();
  return dir || null;
}
function isTicketRef(value) {
  return TICKET_REF_RE.test(String(value || ""));
}
function backupStamp(nowMs) {
  return new Date(nowMs).toISOString().replace(/[-:]/g, "").replace(".", "");
}
function backupRefName(ticketRef, nowMs, attempt = 0) {
  return `${BACKUP_REF_NAMESPACE}/${ticketRef}/${backupStamp(nowMs)}${attempt > 0 ? `-${attempt}` : ""}`;
}
function stampTime(stamp) {
  const match = STAMP_RE.exec(stamp);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms] = match;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`;
}
function parseBackupRef(gitRef, commit) {
  const prefix = `${BACKUP_REF_NAMESPACE}/`;
  if (!gitRef.startsWith(prefix)) return null;
  const [ticket, stamp, ...rest] = gitRef.slice(prefix.length).split("/");
  if (!ticket || !stamp || rest.length) return null;
  return { gitRef, ticket, commit, at: stampTime(stamp) };
}
function forEachRef(cwd, pattern) {
  const listed = git(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)", pattern]);
  if (!listed.ok) return listed;
  const refs = listed.value.split("\n").filter(Boolean).map((line) => {
    const [name = "", oid = ""] = line.split("\0");
    return { name, oid };
  });
  return { ok: true, refs };
}
function writeBackupRef(cwd, ticketRef, commit, options = {}) {
  const root = usableDirectory(cwd);
  const ref = String(ticketRef || "").trim();
  if (!root) return { ok: false, reason: "no_repository", message: "no project or worktree path to write the backup ref in" };
  if (!isTicketRef(ref)) return { ok: false, reason: "invalid_ticket_ref", message: `"${ref}" is not a ticket ref` };
  const resolved = git(root, ["rev-parse", "--verify", "--quiet", `${String(commit || "").trim()}^{commit}`]);
  if (!resolved.ok || !resolved.value) {
    return { ok: false, reason: "missing_commit", message: `commit ${String(commit || "")} is not present in ${root}` };
  }
  const nowMs = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const message = options.reason || `sidequest backup ${ref}`;
  let lastError = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const gitRef = backupRefName(ref, nowMs, attempt);
    const created = git(root, ["update-ref", "--create-reflog", "-m", message, gitRef, resolved.value, EMPTY_OID]);
    if (created.ok) return { ok: true, gitRef, commit: resolved.value };
    lastError = created.message;
  }
  return { ok: false, reason: "git_error", message: lastError };
}
function listBackupRefs(cwd, ticketRef) {
  const root = usableDirectory(cwd);
  if (!root) return { ok: false, reason: "no_repository", backups: [] };
  const ref = ticketRef == null ? "" : String(ticketRef).trim();
  const listed = forEachRef(root, ref ? `${BACKUP_REF_NAMESPACE}/${ref}/` : `${BACKUP_REF_NAMESPACE}/`);
  if (!listed.ok) return { ok: false, reason: "git_error", message: listed.message, backups: [] };
  const backups = listed.refs.map((entry) => parseBackupRef(entry.name, entry.oid)).filter((entry) => Boolean(entry && (!ref || entry.ticket === ref))).sort((a, b) => a.gitRef.localeCompare(b.gitRef));
  return { ok: true, backups };
}
function unrecognizedCandidateRefs(cwd, ticketRef, knownRefs = []) {
  const root = usableDirectory(cwd);
  if (!root) return [];
  const ref = ticketRef == null ? "" : String(ticketRef).trim();
  const listed = forEachRef(root, `${CANDIDATE_REF_NAMESPACE}/`);
  if (!listed.ok) return [];
  const known = new Set(knownRefs.map((value) => String(value || "").trim()).filter(Boolean));
  const prefix = `${CANDIDATE_REF_NAMESPACE}/`;
  return listed.refs.filter((entry) => {
    if (known.has(entry.name)) return false;
    const rest = entry.name.slice(prefix.length);
    if (ref) {
      if (!rest.startsWith(`${ref}-`) && !rest.startsWith(`${ref}/`)) return false;
      return !BOARD_CANDIDATE_SUFFIX_RE.test(rest.slice(ref.length));
    }
    return !BOARD_CANDIDATE_RE.test(rest);
  }).map((entry) => ({ gitRef: entry.name, commit: entry.oid }));
}
function pruneBackupRefs(cwd, isDone) {
  const listed = listBackupRefs(cwd);
  const pruned = [];
  const failures = [];
  if (!listed.ok) return { ok: false, reason: listed.reason, pruned, failures };
  const root = String(cwd).trim();
  const decided = /* @__PURE__ */ new Map();
  for (const backup of listed.backups) {
    if (!decided.has(backup.ticket)) {
      let done = false;
      try {
        done = isDone(backup.ticket) === true;
      } catch (_) {
        done = false;
      }
      decided.set(backup.ticket, done);
    }
    if (!decided.get(backup.ticket)) continue;
    const removed = git(root, ["update-ref", "-m", `sidequest prune ${backup.ticket} done`, "-d", backup.gitRef, backup.commit]);
    if (removed.ok) pruned.push(backup.gitRef);
    else failures.push({ gitRef: backup.gitRef, message: removed.message });
  }
  return { ok: failures.length === 0, pruned, failures };
}
function ticketRefSurface(cwd, ticket) {
  const ref = String(ticket?.ref || "").trim();
  if (!ref || !usableDirectory(cwd)) return null;
  const backups = listBackupRefs(cwd, ref).backups;
  const known = [ticket?.submission?.gitRef, ticket?.checkpoint?.gitRef];
  const unrecognized = unrecognizedCandidateRefs(cwd, ref, known);
  if (!backups.length && !unrecognized.length) return null;
  return {
    ...backups.length ? { backupRefs: backups } : {},
    ...unrecognized.length ? {
      unrecognizedRefs: unrecognized,
      unrecognizedRefsHint: `These refs under ${CANDIDATE_REF_NAMESPACE}/ were not written by the board and are not ${ref}'s candidate. Back up through checkpoint (${BACKUP_REF_NAMESPACE}/${ref}/<stamp>); delete ad hoc refs once their commits are safe.`
    } : {}
  };
}
function boardRefSurface(cwd) {
  if (!usableDirectory(cwd)) return null;
  const counts = /* @__PURE__ */ new Map();
  for (const backup of listBackupRefs(cwd).backups) counts.set(backup.ticket, (counts.get(backup.ticket) || 0) + 1);
  const unrecognized = unrecognizedCandidateRefs(cwd);
  if (!counts.size && !unrecognized.length) return null;
  return {
    ...counts.size ? { backupRefs: Array.from(counts, ([ticket, count]) => ({ ticket, count })) } : {},
    ...unrecognized.length ? { unrecognizedRefs: unrecognized.map((entry) => entry.gitRef) } : {}
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BACKUP_REF_NAMESPACE,
  CANDIDATE_REF_NAMESPACE,
  backupRefName,
  backupStamp,
  boardRefSurface,
  isTicketRef,
  listBackupRefs,
  pruneBackupRefs,
  ticketRefSurface,
  unrecognizedCandidateRefs,
  writeBackupRef
});
