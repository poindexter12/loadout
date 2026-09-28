#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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

// src/hooks/shared/sqlite-budget.ts
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var SQLITE_BUSY_POLICY_KEY = /* @__PURE__ */ Symbol.for("sidequest.sqlite-busy-policy");
var HOOK_SQLITE_BUSY_TIMEOUT_MS = 1500;
function hookName() {
  return import_node_path.default.basename(process.argv[1] || "hook", ".js");
}
function installBudget(onExhausted) {
  Reflect.set(globalThis, SQLITE_BUSY_POLICY_KEY, Object.freeze({
    label: "hook",
    timeoutMs: HOOK_SQLITE_BUSY_TIMEOUT_MS,
    attempts: 1,
    onExhausted
  }));
}
function writeStderr(text) {
  try {
    import_node_fs.default.writeSync(2, text);
  } catch (_) {
  }
}
function failOpen(error) {
  writeStderr(`sidequest: ${hookName()} allowed this event without its board check (fail-open, board lock busy): ${error.message}
`);
  process.exit(0);
}
installBudget(failOpen);

// src/hooks/board-reconciliation-reminder.ts
var import_node_crypto2 = __toESM(require("node:crypto"));
var import_node_fs3 = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path3 = __toESM(require("node:path"));

// src/hooks/shared/input.ts
var import_node_fs2 = __toESM(require("node:fs"));

// src/lib/exec-names.ts
var EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
var CLAUDE_PREFIX = "sidequest-exec-";
var READ_ONLY_CLAUDE_PREFIX = "sidequest-exec-readonly-";
var DIAGNOSTIC_PROBE_NAME = "sidequest-diagnostic-probe";
var DISPATCH_NAME = "sidequest-exec-dispatch";
var READ_ONLY_DISPATCH_NAME = "sidequest-exec-dispatch-readonly";
function stableClaudeName(effort) {
  return `${CLAUDE_PREFIX}${effort}`;
}
function stableReadOnlyClaudeName(effort) {
  return `${READ_ONLY_CLAUDE_PREFIX}${effort}`;
}
var BUNDLED_AGENT_NAMES = /* @__PURE__ */ new Set([
  DISPATCH_NAME,
  READ_ONLY_DISPATCH_NAME,
  DIAGNOSTIC_PROBE_NAME,
  ...EFFORTS.map(stableClaudeName),
  ...EFFORTS.map(stableReadOnlyClaudeName)
]);
var PLUGIN_NAMESPACE = "sidequest:";
function canonicalExecutorName(name) {
  if (!name.startsWith(PLUGIN_NAMESPACE)) return name;
  const unqualifiedName = name.slice(PLUGIN_NAMESPACE.length);
  return BUNDLED_AGENT_NAMES.has(unqualifiedName) ? unqualifiedName : name;
}

// src/hooks/shared/input.ts
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readStdin() {
  try {
    const raw = import_node_fs2.default.readFileSync(0, "utf8");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    for (const field of ["agent_type", "agentType", "subagent_type"]) {
      const executor = parsed[field];
      if (typeof executor === "string") parsed[field] = canonicalExecutorName(executor);
    }
    return parsed;
  } catch (_) {
    return null;
  }
}
function stringField(input, ...names) {
  for (const name of names) {
    const value = input[name];
    if (value != null) return String(value);
  }
  return "";
}
function isSubagent(input) {
  return ["agent_id", "agentId", "agent_type", "agentType"].some((name) => {
    const identity = String(input[name] || "").trim().toLowerCase();
    return identity && identity !== "main" && identity !== "main-thread";
  });
}

// src/hooks/shared/output.ts
var import_node_crypto = __toESM(require("node:crypto"));
var CONTEXT_BUDGETS = Object.freeze({
  SessionStart: 4 * 1024,
  UserPromptSubmit: 1024,
  PreToolUse: 768,
  PreCompact: 1500,
  PostCompact: 1500,
  SubagentStart: 512,
  SubagentStop: 512,
  Stop: 512,
  PostToolUseFailure: 512,
  TeammateIdle: 512
});
function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}
function contextBudget(hookEventName) {
  return CONTEXT_BUDGETS[hookEventName] || 512;
}
function stableWatermark(value) {
  return import_node_crypto.default.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}
function truncateUtf8(value, maxBytes) {
  if (byteLength(value) <= maxBytes) return value;
  let truncated = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    truncated += character;
    bytes += characterBytes;
  }
  return truncated;
}
function projectedText(hookEventName, value) {
  const budget = contextBudget(hookEventName);
  if (byteLength(value) <= budget) return value;
  const watermark = stableWatermark(value);
  const omission = `
[sidequest v1 id=${hookEventName} revision=${watermark}; content omitted (${budget}B budget). Full state: mcp__plugin_sidequest_board__comments({ref:"<ticket-ref>"}).]`;
  return `${truncateUtf8(value, Math.max(0, budget - byteLength(omission)))}${omission}`;
}
function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}
function writeContext(hookEventName, additionalContext, initialUserMessage = "") {
  writeJson({
    hookSpecificOutput: {
      hookEventName,
      additionalContext: projectedText(hookEventName, additionalContext),
      ...initialUserMessage ? { initialUserMessage } : {}
    }
  });
}
var MODEL_VISIBLE_MIRROR_EVENTS = /* @__PURE__ */ new Set(["PreToolUse", "PostToolUseFailure"]);
function writeSystemMessage(hookEventName, systemMessage) {
  const projected = projectedText(hookEventName, systemMessage);
  writeJson({
    systemMessage: projected,
    hookSpecificOutput: {
      hookEventName,
      ...MODEL_VISIBLE_MIRROR_EVENTS.has(hookEventName) ? { additionalContext: projected } : {}
    }
  });
}

// src/hooks/shared/paths.ts
var import_node_path2 = __toESM(require("node:path"));
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || import_node_path2.default.join(__dirname, "..");
}
function runtimeModule(name) {
  return import_node_path2.default.join(pluginRoot(), "lib", `${name}.js`);
}

// src/hooks/board-reconciliation-reminder.ts
var MAX_MESSAGE_BYTES = 360;
var STATE_LOCK_WAIT_MS = 500;
var STATE_LOCK_RETRY_MS = 5;
var stateLockWaitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
function nudgeOff() {
  const value = String(process.env.SIDEQUEST_NUDGE || "").trim().toLowerCase();
  return value === "off" || value === "0" || value === "false" || value === "no";
}
function pendingSubmission(ticket) {
  return Boolean(ticket.submission?.commit && !ticket.submission.integratedAt);
}
function liveDispatch(ticket, sessionId) {
  return ticket.dispatch?.sessionId === sessionId && !ticket.dispatch.terminalAt && (!ticket.claim?.by || Boolean(ticket.claimLive));
}
function dispatchedBySession(ticket, sessionId) {
  return ticket.dispatch?.sessionId === sessionId;
}
function heldByLiveExecutor(ticket) {
  return Boolean(ticket.claimLive && ticket.dispatch && !ticket.dispatch.terminalAt);
}
function byteCapped(message) {
  return Buffer.byteLength(message) <= MAX_MESSAGE_BYTES ? message : message.slice(0, MAX_MESSAGE_BYTES - 1).trimEnd() + "…";
}
function countLabel(count, singular, plural = singular + "s") {
  return `${count} ${count === 1 ? singular : plural}`;
}
function reminderStateFile(sessionId) {
  const home = process.env.SIDEQUEST_HOME || import_node_path3.default.join(import_node_os.default.homedir(), ".claude", "sidequest");
  const key = import_node_crypto2.default.createHash("sha256").update(sessionId).digest("hex");
  return import_node_path3.default.join(home, "hook-state", `stop-reminder-${key}.json`);
}
function stateLockOwnerFile(lockDirectory) {
  try {
    const owners = import_node_fs3.default.readdirSync(lockDirectory).filter((name) => name.startsWith("owner-"));
    const [ownerName] = owners;
    return owners.length === 1 && ownerName ? import_node_path3.default.join(lockDirectory, ownerName) : null;
  } catch (_) {
    return null;
  }
}
function stateLockOwnerAlive(ownerFile) {
  try {
    const owner = Number(import_node_fs3.default.readFileSync(ownerFile, "utf8").trim());
    if (!Number.isInteger(owner) || owner <= 0) return true;
    try {
      process.kill(owner, 0);
      return true;
    } catch (error) {
      return error.code !== "ESRCH";
    }
  } catch (error) {
    return error.code !== "ENOENT";
  }
}
function waitForTestGate(markerVariable, gateVariable) {
  const marker = process.env[markerVariable];
  if (marker) import_node_fs3.default.writeFileSync(marker, `${process.pid}
`);
  const gate = process.env[gateVariable];
  while (gate && import_node_fs3.default.existsSync(gate)) {
    Atomics.wait(stateLockWaitBuffer, 0, 0, STATE_LOCK_RETRY_MS);
  }
}
function removeStaleStateLock(lockDirectory, ownerFile) {
  try {
    import_node_fs3.default.rmSync(ownerFile, { force: true });
    import_node_fs3.default.rmdirSync(lockDirectory);
    return true;
  } catch (_) {
    return false;
  }
}
function acquireStateLock(file) {
  const lockDirectory = `${file}.lock-v2`;
  const generation = `${process.pid}-${import_node_crypto2.default.randomUUID()}`;
  const ownerName = `owner-${generation}`;
  const candidateDirectory = `${lockDirectory}.${generation}`;
  const publishedOwnerFile = import_node_path3.default.join(lockDirectory, ownerName);
  const deadline = Date.now() + STATE_LOCK_WAIT_MS;
  import_node_fs3.default.mkdirSync(import_node_path3.default.dirname(file), { recursive: true });
  try {
    import_node_fs3.default.mkdirSync(candidateDirectory);
    import_node_fs3.default.writeFileSync(import_node_path3.default.join(candidateDirectory, ownerName), `${process.pid}
`);
    while (true) {
      try {
        import_node_fs3.default.renameSync(candidateDirectory, lockDirectory);
        waitForTestGate("SIDEQUEST_TEST_STOP_LOCK_ACQUIRED_MARKER", "SIDEQUEST_TEST_STOP_LOCK_HOLD_GATE");
        return publishedOwnerFile;
      } catch (_) {
        const ownerFile = stateLockOwnerFile(lockDirectory);
        if (ownerFile && !stateLockOwnerAlive(ownerFile)) {
          waitForTestGate("SIDEQUEST_TEST_STOP_STALE_LOCK_MARKER", "SIDEQUEST_TEST_STOP_STALE_LOCK_GATE");
          removeStaleStateLock(lockDirectory, ownerFile);
          const cleanedMarker = process.env.SIDEQUEST_TEST_STOP_STALE_LOCK_CLEANED_MARKER;
          if (cleanedMarker) import_node_fs3.default.writeFileSync(cleanedMarker, `${process.pid}
`);
          continue;
        }
        if (Date.now() >= deadline) return null;
        Atomics.wait(stateLockWaitBuffer, 0, 0, STATE_LOCK_RETRY_MS);
      }
    }
  } finally {
    try {
      import_node_fs3.default.rmSync(candidateDirectory, { recursive: true, force: true });
    } catch (_) {
    }
  }
}
function releaseStateLock(ownerFile) {
  try {
    import_node_fs3.default.rmSync(ownerFile, { force: true });
    import_node_fs3.default.rmdirSync(import_node_path3.default.dirname(ownerFile));
  } catch (_) {
  }
}
function rememberTransition(reminder) {
  const file = reminderStateFile(reminder.sessionId);
  let lockFile = null;
  try {
    lockFile = acquireStateLock(file);
    if (!lockFile) return false;
    let prior = null;
    try {
      prior = JSON.parse(import_node_fs3.default.readFileSync(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") return false;
    }
    if (prior?.state === reminder.state) return false;
    import_node_fs3.default.writeFileSync(file, JSON.stringify({ state: reminder.state }));
    return true;
  } catch (_) {
    return false;
  } finally {
    if (lockFile) releaseStateLock(lockFile);
  }
}
function clearReminderState(sessionId) {
  if (!sessionId) return;
  const file = reminderStateFile(sessionId);
  let lockFile = null;
  try {
    lockFile = acquireStateLock(file);
    if (!lockFile) return;
    import_node_fs3.default.rmSync(file, { force: true });
  } catch (_) {
  } finally {
    if (lockFile) releaseStateLock(lockFile);
  }
}
function reminderSessionId(data) {
  return stringField(data, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
}
function acknowledgementFreeContinuation(action) {
  return `${action} Continue working without replying to this reminder; do not send an acknowledgment-only or progress reply.`;
}
function reconciliationMessage(data, providedStore) {
  if (nudgeOff()) return null;
  const sessionId = reminderSessionId(data);
  if (!sessionId) return null;
  try {
    const store = providedStore || require(runtimeModule("store"));
    const start = stringField(data, "cwd") || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    let project = store.findProject(store.nearestRepoRoot(start));
    if (!project.ok || !project.slug) project = store.findProject(start);
    if (!project.ok || !project.slug) return null;
    const claimedRefs = new Set(store.sessionClaims(sessionId).filter((claim) => claim.held).map((claim) => String(claim.ref || "")).filter(Boolean));
    const claimedByThisSession = (ticket) => claimedRefs.has(String(ticket.ref || "")) || Boolean(ticket.claim?.by && dispatchedBySession(ticket, sessionId));
    const touched = (ticket) => claimedByThisSession(ticket) || pendingSubmission(ticket) && dispatchedBySession(ticket, sessionId) || dispatchedBySession(ticket, sessionId) && !ticket.dispatch?.terminalAt && !liveDispatch(ticket, sessionId);
    const projectTickets = store.listTickets(project.slug).map((ticket) => ({
      ...ticket,
      project: project.slug,
      claimLive: Boolean(ticket.claim?.by && !store.claimReclaimable(ticket))
    }));
    const open = projectTickets.filter((ticket) => ticket.status !== "done" && touched(ticket) && (!liveDispatch(ticket, sessionId) && !heldByLiveExecutor(ticket) || pendingSubmission(ticket)));
    const doing = open.filter((ticket) => ticket.status === "doing" && !pendingSubmission(ticket));
    const submissions = open.filter(pendingSubmission);
    const submissionStoryIds = new Set(submissions.map((ticket) => ticket.storyId).filter(Boolean));
    const liveClaimCount = projectTickets.filter((ticket) => ticket.claimLive && store.claimMaySubmit(ticket) && (submissionStoryIds.size ? submissionStoryIds.has(ticket.storyId) : dispatchedBySession(ticket, sessionId))).length;
    const otherOpen = open.length - doing.length - submissions.length;
    if (!open.length) return null;
    const actionable = [
      doing.length ? `${countLabel(doing.length, "ticket")} in doing` : "",
      otherOpen ? `${countLabel(otherOpen, "ticket")} still open` : ""
    ].filter(Boolean);
    const waits = [
      submissions.length ? `${countLabel(submissions.length, "submission")} pending integration` : "",
      submissions.length && liveClaimCount ? `${countLabel(liveClaimCount, "live claim")} in progress` : ""
    ].filter(Boolean);
    const state = [...actionable, ...waits].join(" / ");
    const closeActionable = actionable.length ? `Update or close ${actionable.length === 1 && doing.length === 1 ? "it" : "them"} before finishing.` : "Continue working on the board.";
    const action = submissions.length ? liveClaimCount ? `Hold integration until ${countLabel(liveClaimCount, "live claim")} ${liveClaimCount === 1 ? "becomes" : "become"} terminal.` : "Integrate pending submissions now." : closeActionable;
    const holdWaits = submissions.length && !liveClaimCount ? " If integration cannot proceed, record why as a ticket comment and hold the submission; never release it as complete." : "";
    const signature = JSON.stringify({
      liveClaimCount,
      tickets: open.map((ticket) => ({
        ref: ticket.ref || "",
        status: ticket.status || "",
        claimBy: ticket.claim?.by || "",
        claimAt: ticket.claim?.at || "",
        claimGeneration: ticket.claim?.generation || "",
        dispatchSessionId: ticket.dispatch?.sessionId || "",
        dispatchClaimedAt: ticket.dispatch?.claimedAt || "",
        submissionCommit: ticket.submission?.commit || "",
        integratedAt: ticket.submission?.integratedAt || ""
      })).sort((left, right) => left.ref.localeCompare(right.ref))
    });
    return {
      sessionId,
      message: byteCapped(`Sidequest: ${acknowledgementFreeContinuation(action)} ${state}.${holdWaits}`),
      state: signature
    };
  } catch (_) {
    return null;
  }
}
function reconciliationReminder(data, store) {
  const reminder = reconciliationMessage(data, store);
  if (!reminder) {
    clearReminderState(reminderSessionId(data));
    return null;
  }
  return rememberTransition(reminder) ? reminder.message : null;
}
function boardReconciliationReminder(data) {
  return reconciliationReminder(data);
}
function main() {
  const data = readStdin();
  if (!data || data.stop_hook_active === true) return;
  const message = boardReconciliationReminder(data);
  if (message) writeContext("Stop", message);
}
if (import_node_path3.default.basename(process.argv[1] || "") === "board-reconciliation-reminder.js") main();

// src/hooks/shared/compaction.ts
var import_node_fs4 = __toESM(require("node:fs"));
var import_node_os2 = __toESM(require("node:os"));
var import_node_path4 = __toESM(require("node:path"));
var CLOSED_TICKETS_THRESHOLD = 3;
var TRANSCRIPT_BYTES_THRESHOLD = 3 * 1024 * 1024;
var RETRY_MULTIPLIER = 2;
function disabledValue(value) {
  return ["0", "false", "no", "off"].includes(String(value || "").trim().toLowerCase());
}
function compactionSuggestionsEnabled() {
  return !disabledValue(process.env.SIDEQUEST_COMPACTION_SUGGESTIONS);
}
function isPrimarySession(input) {
  return !isSubagent(input);
}
function stateDirectory() {
  const home = String(process.env.SIDEQUEST_HOME || "").trim() || import_node_path4.default.join(import_node_os2.default.homedir(), ".claude", "sidequest");
  return import_node_path4.default.join(home, "compaction-suggestions");
}
function stateFile(sessionId) {
  return import_node_path4.default.join(stateDirectory(), `${encodeURIComponent(sessionId)}.json`);
}
function transcriptBytes(transcriptPath) {
  try {
    return import_node_fs4.default.statSync(String(transcriptPath || "")).size;
  } catch (_) {
    return 0;
  }
}
function readState(sessionId, currentBytes) {
  try {
    const parsed = JSON.parse(import_node_fs4.default.readFileSync(stateFile(sessionId), "utf8"));
    if (parsed && Number.isFinite(parsed.transcriptBytes) && Number.isFinite(Date.parse(parsed.resetAt))) {
      return { ...parsed, ticketBaselineAt: parsed.ticketBaselineAt || parsed.resetAt };
    }
  } catch (_) {
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return { resetAt: now, ticketBaselineAt: now, transcriptBytes: currentBytes };
}
function writeState(sessionId, state) {
  try {
    import_node_fs4.default.mkdirSync(stateDirectory(), { recursive: true });
    import_node_fs4.default.writeFileSync(stateFile(sessionId), JSON.stringify(state));
    return true;
  } catch (_) {
    return false;
  }
}
function completionAt(ticket) {
  const values = [ticket?.submission?.integratedAt, ticket?.completion?.at, ticket?.updatedAt];
  for (const value of values) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}
function versionFor(ticket) {
  const text = Array.isArray(ticket?.comments) ? ticket.comments.map((comment) => String(comment?.body || "")).join("\n") : "";
  const matched = text.match(/\b(?:sidequest|release)\s+v?(\d+\.\d+\.\d+)\b/i);
  if (matched?.[1]) return `v${matched[1]}`;
  const commit = String(ticket?.submission?.commit || "").trim();
  return commit ? commit.slice(0, 10) : "closed";
}
function recentlyClosed(tickets, resetAt) {
  const since = Date.parse(resetAt);
  return tickets.filter((ticket) => ticket?.status === "done" && completionAt(ticket) >= since);
}
function closedAfter(tickets, baselineAt) {
  const since = Date.parse(baselineAt);
  return tickets.filter((ticket) => ticket?.status === "done" && completionAt(ticket) > since);
}
function activeBoardWork(tickets, liveClaimRefs) {
  return tickets.some((ticket) => {
    if (ticket?.status === "doing" && liveClaimRefs.has(ticket.ref)) return true;
    return Boolean(ticket?.dispatch && !ticket.dispatch.terminalAt);
  });
}
function projectFor(cwd) {
  try {
    const store = require(runtimeModule("store"));
    const found = store.findProject(store.nearestRepoRoot(cwd));
    if (!found.ok || !found.slug || !found.meta?.path) return null;
    return { slug: found.slug, path: found.meta.path };
  } catch (_) {
    return null;
  }
}
async function publishLockHeld(repoPath) {
  try {
    const publish = require(runtimeModule("publish"));
    return Boolean((await publish.publishLockStatus(repoPath)).locked);
  } catch (_) {
    return false;
  }
}
function byteLabel(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}
function compactedRefs(tickets) {
  return tickets.slice(0, 5).map((ticket) => `${ticket.ref} (${versionFor(ticket)})`).join(", ") + (tickets.length > 5 ? `, +${tickets.length - 5} more` : "");
}
async function compactionSuggestion(input) {
  if (!compactionSuggestionsEnabled() || !isPrimarySession(input)) return null;
  const sessionId = String(input.session_id || input.sessionId || process.env.CLAUDE_CODE_SESSION_ID || "").trim();
  if (!sessionId) return null;
  const currentBytes = transcriptBytes(input.transcript_path || input.transcriptPath);
  const state = readState(sessionId, currentBytes);
  const project = projectFor(String(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()));
  if (!project) return null;
  try {
    const store = require(runtimeModule("store"));
    const tickets = store.listTickets(project.slug);
    const liveClaimRefs = new Set(tickets.filter((ticket) => ticket.claim?.by && !store.claimReclaimable(ticket) && ticket.ref).map((ticket) => String(ticket.ref)));
    if (activeBoardWork(tickets, liveClaimRefs) || await publishLockHeld(project.path)) return null;
    const closed = recentlyClosed(tickets, state.resetAt);
    const newlyClosed = closedAfter(tickets, state.ticketBaselineAt);
    const growth = Math.max(0, currentBytes - state.transcriptBytes);
    const multiplier = state.suggestedAt ? RETRY_MULTIPLIER : 1;
    const enoughClosed = newlyClosed.length >= CLOSED_TICKETS_THRESHOLD * multiplier;
    const enoughTranscript = growth >= TRANSCRIPT_BYTES_THRESHOLD * multiplier;
    if (!enoughClosed && !enoughTranscript) return null;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    state.suggestedAt = now;
    state.ticketBaselineAt = now;
    state.transcriptBytes = currentBytes;
    if (!writeState(sessionId, state)) return null;
    const accumulated = [
      closed.length ? `Closed/shipped: ${compactedRefs(closed)}.` : "",
      growth ? `Transcript growth: ${byteLabel(growth)}.` : ""
    ].filter(Boolean).join(" ");
    return [
      "sidequest: compaction is safe at this boundary.",
      accumulated,
      "Safe to lose: completed-ticket screenshots, CI output, superseded dispatch chatter.",
      "Keep: open ticket specs, board decisions, and pending submission details. Run /compact when ready."
    ].join("\n");
  } catch (_) {
    return null;
  }
}

// src/hooks/shared/compaction-policy.ts
var import_node_fs5 = __toESM(require("node:fs"));
var import_node_os3 = __toESM(require("node:os"));
var import_node_path5 = __toESM(require("node:path"));

// src/hooks/shared/live-refs.ts
var COMPACTION_RECOVERY_MARKER = "sidequest compaction recovery v1";
var COMPACTION_GUARD_DEFAULT = "off";
function compactionGuardMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  return mode === "auto" || mode === "on" || mode === "off" ? mode : COMPACTION_GUARD_DEFAULT;
}
var LIVE_REFS_VERSION = 1;
function trimSlashes(value) {
  return value.replace(/[\\/]+$/, "");
}
function sidequestHome(sidequestHomeEnv, homeEnv) {
  const explicit = String(sidequestHomeEnv || "").trim();
  if (explicit) return trimSlashes(explicit);
  const home = trimSlashes(String(homeEnv || "").trim());
  return home ? `${home}/.claude/sidequest` : "";
}
function liveRefsPath(home, sessionId) {
  return `${trimSlashes(home)}/live-refs/${encodeURIComponent(sessionId)}.json`;
}
function serializeLiveRefs(session, pin, closed, at = (/* @__PURE__ */ new Date()).toISOString()) {
  const file = { version: LIVE_REFS_VERSION, session, at, pin, closed: [...new Set(closed)].sort() };
  return `${JSON.stringify(file)}
`;
}

// src/hooks/shared/compaction-policy.ts
var MAX_INSTRUCTION_BYTES = 1500;
function compactText(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  const marker = "…";
  let result = "";
  let bytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes + Buffer.byteLength(marker, "utf8") > limit) break;
    result += character;
    bytes += characterBytes;
  }
  return `${result}${marker}`;
}
function ticketLine(ticket, canonicalPreparedDispatchExecutor) {
  const claim = ticket?.claim || {};
  const dispatch = ticket?.dispatch || {};
  const executor = canonicalPreparedDispatchExecutor(ticket);
  const details = claim.by ? [
    `claim ${compactText(claim.by, 100)}`,
    executor ? `executor ${compactText(executor, 100)}` : "",
    dispatch.token || ticket?.dispatchToken ? `dispatch token ${compactText(dispatch.token || ticket.dispatchToken, 160)}` : ""
  ].filter(Boolean).join("; ") : "";
  return `- ${compactText(ticket?.ref, 40)} — ${compactText(ticket?.title, 220)}${details ? ` (${details})` : ""}`;
}
function boundedInstruction(lines) {
  const kept = ["Preserve verbatim in the summary:"];
  for (const line of lines) {
    const candidate = [...kept, line].join("\n");
    if (Buffer.byteLength(candidate, "utf8") > MAX_INSTRUCTION_BYTES) {
      const omitted = `… ${lines.length - (kept.length - 1)} more board entries omitted.`;
      if (Buffer.byteLength([...kept, omitted].join("\n"), "utf8") <= MAX_INSTRUCTION_BYTES) kept.push(omitted);
      break;
    }
    kept.push(line);
  }
  return kept.length > 1 ? kept.join("\n") : "";
}
function liveTicketLine(ticket, story) {
  const ref = compactText(ticket?.ref, 40);
  const claim = compactText(ticket?.claim?.by, 80);
  const storyRef = compactText(story?.ref, 40);
  const revisions = story ? `contractRevision=${Number(story.contractRevision) || 0} logRevision=${Number(story.logRevision) || 0}` : `watermark=${compactText(ticket?.updatedAt, 32) || "unavailable"}`;
  const retrieval = [`mcp__plugin_sidequest_board__comments({ref:"${ref}"})`];
  if (storyRef) {
    retrieval.push(
      `mcp__plugin_sidequest_board__story_contract({story:"${storyRef}"})`,
      `mcp__plugin_sidequest_board__story_log({story:"${storyRef}"})`
    );
  }
  return `Keep live ticket ${ref}${claim ? ` claim=${claim}` : ""}${storyRef ? ` story=${storyRef}` : ""} ${revisions}. ${compactText(ticket?.title, 80)}${story ? ` Story: ${compactText(story.title, 60)}.` : ""} Retrieve: ${retrieval.join(" and ")}.`;
}
function loadBoard(cwd, store) {
  const found = store.findProject(store.nearestRepoRoot(cwd));
  if (!found.ok || !found.slug || !found.meta?.path) return null;
  return { found, tickets: store.listTickets(found.slug) };
}
async function boardState(cwd, store, loaded = loadBoard(cwd, store)) {
  if (!loaded) return null;
  const { found, tickets } = loaded;
  if (!found.slug || !found.meta?.path) return null;
  const liveRefs = new Set(store.worktreeGcTickets().filter((ticket) => ticket.project === found.slug && ticket.claimLive && ticket.ref).map((ticket) => String(ticket.ref)));
  const doing = tickets.filter((ticket) => ticket?.status === "doing");
  const fresh = doing.filter((ticket) => liveRefs.has(String(ticket.ref)));
  const stale = doing.filter((ticket) => !liveRefs.has(String(ticket.ref)));
  const preparedDispatch = require(runtimeModule("prepared-dispatch"));
  const publish = require(runtimeModule("publish"));
  const lock = await publish.publishLockStatus(found.meta.path);
  const storyIds = [...new Set(doing.map((ticket) => String(ticket?.storyId || "")).filter(Boolean))];
  const stories = storyIds.map((id) => store.getStory(found.slug, id)).filter((story) => Boolean(story));
  const storiesByRef = new Map(stories.map((story) => [story.ref, story]));
  const lines = [
    `${COMPACTION_RECOVERY_MARKER}: board history omitted under the 1500B recovery budget.`,
    ...fresh.map((ticket) => liveTicketLine(ticket, storiesByRef.get(String(ticket?.storyId || "")))),
    ...stale.map((ticket) => ticketLine(ticket, preparedDispatch.canonicalPreparedDispatchExecutor)),
    ...stories.filter((story) => !fresh.some((ticket) => String(ticket?.storyId || "") === story.ref)).map((story) => `Compaction policy story ${compactText(story.title, 80)}: id=${compactText(story.ref, 40)} contractRevision=${Number(story.contractRevision) || 0} logRevision=${Number(story.logRevision) || 0}. Retrieve: mcp__plugin_sidequest_board__story_contract({story:"${compactText(story.ref, 40)}"}) and mcp__plugin_sidequest_board__story_log({story:"${compactText(story.ref, 40)}"}).`),
    ...lock.locked ? [`Publish lock: ${compactText(lock.holder?.by || lock.holder?.sessionId || JSON.stringify(lock.holder || "held"), 260)}`] : []
  ];
  if (lines.length === 1) return null;
  const freshRefs = compactText(fresh.map((ticket) => String(ticket.ref)).join(", "), 300);
  const unsafe = [
    fresh.length ? `fresh claims: ${freshRefs}` : "",
    lock.locked ? `publish lock: ${compactText(lock.holder?.by || lock.holder?.sessionId || "held", 180)}` : ""
  ].filter(Boolean).join("; ");
  return { instruction: boundedInstruction(lines), unsafeReason: unsafe };
}
async function compactionRecoverySnapshot(cwd) {
  const store = require(runtimeModule("store"));
  const loaded = loadBoard(cwd, store);
  if (!loaded) return null;
  const state = await boardState(cwd, store, loaded);
  return {
    pin: state?.instruction || "",
    closed: loaded.tickets.filter((ticket) => ticket?.status === "done" || Boolean(ticket?.archived)).map((ticket) => String(ticket?.ref || "")).filter(Boolean)
  };
}
async function recordLiveRefs(input) {
  if (compactionGuardMode(process.env.CLAUDE_PLUGIN_OPTION_COMPACTIONGUARD) === "off") return "";
  const sessionId = String(input.session_id || input.sessionId || process.env.CLAUDE_CODE_SESSION_ID || "").trim();
  const home = sidequestHome(process.env.SIDEQUEST_HOME, import_node_os3.default.homedir());
  if (!sessionId || !home) return "";
  try {
    const snapshot = await compactionRecoverySnapshot(String(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()));
    if (!snapshot) return "";
    const file = liveRefsPath(home, sessionId);
    import_node_fs5.default.mkdirSync(import_node_path5.default.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    import_node_fs5.default.writeFileSync(temporary, serializeLiveRefs(sessionId, snapshot.pin, snapshot.closed));
    import_node_fs5.default.renameSync(temporary, file);
    return file;
  } catch (error) {
    console.error(`sidequest: could not record live refs for the compaction guard: ${String(error)}`);
    return "";
  }
}

// src/hooks/stop.ts
async function main2() {
  const input = readStdin();
  if (!input) return;
  await recordLiveRefs(input);
  if (input.stop_hook_active === true) return;
  const reconciliation = boardReconciliationReminder(input);
  if (reconciliation) {
    writeContext("Stop", reconciliation);
    return;
  }
  const compaction = await compactionSuggestion(input);
  if (compaction) writeSystemMessage("Stop", compaction);
}
void main2().catch(() => {
});
