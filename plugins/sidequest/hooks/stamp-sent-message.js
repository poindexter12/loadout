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

// src/hooks/shared/paths.ts
var import_node_path2 = __toESM(require("node:path"));
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || import_node_path2.default.join(__dirname, "..");
}
function runtimeModule(name) {
  return import_node_path2.default.join(pluginRoot(), "lib", `${name}.js`);
}

// src/hooks/shared/questions.ts
var import_node_crypto = __toESM(require("node:crypto"));
var import_node_fs3 = __toESM(require("node:fs"));
var import_node_path4 = __toESM(require("node:path"));

// src/lib/claude-home.ts
var import_node_os = __toESM(require("node:os"));
var import_node_path3 = __toESM(require("node:path"));

// src/hooks/shared/questions.ts
var ORPHAN_AFTER_MS = 10 * 60 * 1e3;
var MARKER_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
function questionLog() {
  return require(runtimeModule("store/question-log"));
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
function messageMarkers(message) {
  const text = typeof message === "string" ? message : message == null ? "" : JSON.stringify(message);
  if (!text.includes("[sidequest:")) return [];
  const log = questionLog();
  const markers = [];
  for (const match of text.matchAll(/\[sidequest:(question|answer)\b([^\]]*)\]/g)) {
    const fields = match[2] ?? "";
    const field = (name) => {
      const found = new RegExp(`(?:^|\\s)${name}=(\\S+)`).exec(fields);
      return found?.[1] ?? null;
    };
    const qid = field("qid");
    const aid = field("aid");
    markers.push({
      kind: match[1],
      raw: match[0],
      qid: qid && log.isQuestionId(qid) ? qid : null,
      aid: aid && log.isAnswerId(aid) ? aid : null
    });
  }
  return markers;
}

// src/hooks/stamp-sent-message.ts
function main() {
  const input = readStdin();
  if (!input || stringField(input, "tool_name") !== "SendMessage" || !isRecord(input.tool_input)) return;
  const markers = messageMarkers(input.tool_input.message).filter((marker) => marker.qid || marker.aid);
  if (!markers.length) return;
  const store = require(runtimeModule("store"));
  const slug = projectSlugFor(stringField(input, "cwd") || process.env.CLAUDE_PROJECT_DIR || process.cwd(), store);
  if (!slug) return;
  const log = questionLog();
  const dir = log.questionLogDir(slug);
  const toRaw = input.tool_input.to;
  const to = String(toRaw == null ? "" : toRaw).trim();
  const session = stringField(input, "session_id", "sessionId") || null;
  for (const marker of markers) {
    try {
      log.recordSent(dir, { qid: marker.qid, aid: marker.kind === "answer" ? marker.aid : null, to, session });
    } catch (_) {
    }
  }
}
try {
  main();
} catch (_) {
  process.exit(0);
}
