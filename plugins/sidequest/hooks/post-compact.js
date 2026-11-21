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

// src/hooks/shared/compaction.ts
var import_node_fs3 = __toESM(require("node:fs"));
var import_node_os2 = __toESM(require("node:os"));
var import_node_path4 = __toESM(require("node:path"));

// src/lib/claude-home.ts
var import_node_os = __toESM(require("node:os"));
var import_node_path2 = __toESM(require("node:path"));
function resolveSidequestHome(env = process.env) {
  const explicit = String(env.SIDEQUEST_HOME || "").trim();
  if (explicit) return import_node_path2.default.resolve(explicit);
  const configDir = String(env.CLAUDE_CONFIG_DIR || "").trim();
  return import_node_path2.default.join(configDir ? import_node_path2.default.resolve(configDir) : import_node_path2.default.join(import_node_os.default.homedir(), ".claude"), "sidequest");
}

// src/hooks/shared/paths.ts
var import_node_path3 = __toESM(require("node:path"));
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || import_node_path3.default.join(__dirname, "..");
}
function runtimeModule(name) {
  return import_node_path3.default.join(pluginRoot(), "lib", `${name}.js`);
}

// src/hooks/shared/compaction.ts
var TRANSCRIPT_BYTES_THRESHOLD = 3 * 1024 * 1024;
function isPrimarySession(input) {
  return !isSubagent(input);
}
function stateDirectory() {
  const home = resolveSidequestHome();
  return import_node_path4.default.join(home, "compaction-suggestions");
}
function stateFile(sessionId) {
  return import_node_path4.default.join(stateDirectory(), `${encodeURIComponent(sessionId)}.json`);
}
function transcriptBytes(transcriptPath) {
  try {
    return import_node_fs3.default.statSync(String(transcriptPath || "")).size;
  } catch (_) {
    return 0;
  }
}
function writeState(sessionId, state) {
  try {
    import_node_fs3.default.mkdirSync(stateDirectory(), { recursive: true });
    import_node_fs3.default.writeFileSync(stateFile(sessionId), JSON.stringify(state));
    return true;
  } catch (_) {
    return false;
  }
}
function resetCompactionState(sessionId, transcriptPath) {
  if (!sessionId) return;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  writeState(sessionId, {
    resetAt: now,
    ticketBaselineAt: now,
    transcriptBytes: transcriptBytes(transcriptPath),
    baselinePending: true
  });
}
function replacementMarkerHome() {
  const sidequestHome = String(process.env.SIDEQUEST_HOME || "").trim();
  if (sidequestHome) return sidequestHome;
  const configDir = String(process.env.CLAUDE_CONFIG_DIR || "").trim();
  return import_node_path4.default.join(configDir || import_node_path4.default.join(import_node_os2.default.homedir(), ".claude"), "sidequest");
}
function replacementMarkerFile(sessionId) {
  return import_node_path4.default.join(replacementMarkerHome(), "replacement-compactions", `${encodeURIComponent(sessionId)}.json`);
}
function recordReplacementCompaction(sessionId, replacement) {
  if (!sessionId) return;
  const file = replacementMarkerFile(sessionId);
  try {
    import_node_fs3.default.rmSync(file, { force: true });
  } catch (_) {
  }
  if (!replacement) return;
  try {
    import_node_fs3.default.mkdirSync(import_node_path4.default.dirname(file), { recursive: true });
    import_node_fs3.default.writeFileSync(file, JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString() }));
  } catch (_) {
  }
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

// src/hooks/shared/questions.ts
var import_node_crypto2 = __toESM(require("node:crypto"));
var import_node_fs4 = __toESM(require("node:fs"));
var import_node_path5 = __toESM(require("node:path"));
var ORPHAN_AFTER_MS = 10 * 60 * 1e3;
var MARKER_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
function questionLog() {
  return require(runtimeModule("store/question-log"));
}
function hash(value) {
  return import_node_crypto2.default.createHash("sha256").update(value).digest("hex");
}
function stateDir(...parts) {
  return import_node_path5.default.join(resolveSidequestHome(), "hook-state", ...parts);
}
function suppressionFile(sessionId) {
  return stateDir(`question-surfaced-${hash(sessionId)}.json`);
}
function seenFile(qid) {
  return stateDir("question-seen", qid);
}
function sessionEndedFile(sessionId) {
  return stateDir("question-session-ended", hash(sessionId));
}
function mtimeMs(file) {
  try {
    return import_node_fs4.default.statSync(file).mtimeMs;
  } catch (_) {
    return null;
  }
}
function projectSlugFor(start, store) {
  try {
    let project = store.findProject(store.nearestRepoRoot(start));
    if (!project.ok || !project.slug) project = store.findProject(start);
    return project.ok && project.slug ? project.slug : null;
  } catch (_) {
    return null;
  }
}
function clearSuppression(sessionId) {
  if (!sessionId) return;
  try {
    import_node_fs4.default.rmSync(suppressionFile(sessionId), { force: true });
  } catch (_) {
  }
}
function routedTo(question, sessionId, now) {
  const owner = question.asked.ownerSession;
  if (!owner || owner === sessionId) return true;
  if (mtimeMs(sessionEndedFile(owner)) !== null) return true;
  const lastSeen = mtimeMs(seenFile(question.qid)) ?? Date.parse(question.asked.at);
  return Number.isFinite(lastSeen) && now - lastSeen >= ORPHAN_AFTER_MS;
}
function routedOpenQuestions(slug, sessionId, now = Date.now()) {
  const ql = questionLog();
  const dir = ql.questionLogDir(slug);
  if (!import_node_fs4.default.existsSync(dir)) return [];
  return ql.openQuestions(dir).filter((question) => routedTo(question, sessionId, now));
}
function byteLength2(value) {
  return Buffer.byteLength(value, "utf8");
}
function clipText(value, maxBytes) {
  const flat = String(value || "").replace(/\s+/g, " ").trim();
  if (byteLength2(flat) <= maxBytes) return flat;
  let clipped = "";
  for (const character of flat) {
    if (byteLength2(clipped + character) > Math.max(0, maxBytes - byteLength2("…"))) break;
    clipped += character;
  }
  return `${clipped.trimEnd()}…`;
}
function questionLabel(question) {
  return `${question.ref} ${question.seq}`;
}
function questionSummaryLine(questions, maxBytes = 400) {
  if (!questions.length) return "";
  const shown = questions.slice(0, 6).map(questionLabel).join(", ");
  const extra = questions.length > 6 ? ` (+${questions.length - 6} more)` : "";
  const line = `Sidequest: ${questions.length} open question${questions.length === 1 ? "" : "s"} need${questions.length === 1 ? "s" : ""} the user: ${shown}${extra}. Read each with pulse({ref}), ask with AskUserQuestion, then answer({ref,question,text}).`;
  return clipText(line, maxBytes);
}

// src/hooks/post-compact.ts
function openQuestionLine(input, sessionId) {
  clearSuppression(sessionId);
  try {
    const store = require(runtimeModule("store"));
    const slug = projectSlugFor(stringField(input, "cwd") || process.env.CLAUDE_PROJECT_DIR || process.cwd(), store);
    return slug ? questionSummaryLine(routedOpenQuestions(slug, sessionId)) : "";
  } catch (_) {
    return "";
  }
}
function main() {
  const input = readStdin();
  if (!input || !isPrimarySession(input)) return;
  const sessionId = stringField(input, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || "";
  if (!sessionId) return;
  resetCompactionState(sessionId, input.transcript_path || input.transcriptPath);
  recordReplacementCompaction(sessionId, input.compact_summary === "");
  const line = openQuestionLine(input, sessionId);
  if (line) writeContext("PostCompact", line);
}
try {
  main();
} catch (_) {
  process.exit(0);
}
