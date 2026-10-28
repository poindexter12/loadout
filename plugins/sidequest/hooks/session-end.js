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

// src/hooks/shared/paths.ts
var import_node_path2 = __toESM(require("node:path"));
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || import_node_path2.default.join(__dirname, "..");
}
function runtimeModule(name) {
  return import_node_path2.default.join(pluginRoot(), "lib", `${name}.js`);
}

// src/hooks/shared/sweep-handoff.ts
var import_node_child_process = require("node:child_process");
var import_node_crypto = __toESM(require("node:crypto"));
var import_node_fs3 = __toESM(require("node:fs"));
var import_node_path4 = __toESM(require("node:path"));

// src/lib/claude-home.ts
var import_node_os = __toESM(require("node:os"));
var import_node_path3 = __toESM(require("node:path"));
function resolveSidequestHome(env = process.env) {
  const explicit = String(env.SIDEQUEST_HOME || "").trim();
  if (explicit) return import_node_path3.default.resolve(explicit);
  const configDir = String(env.CLAUDE_CONFIG_DIR || "").trim();
  return import_node_path3.default.join(configDir ? import_node_path3.default.resolve(configDir) : import_node_path3.default.join(import_node_os.default.homedir(), ".claude"), "sidequest");
}

// src/hooks/shared/sweep-handoff.ts
var EMPTY_SWEEP_PROGRESS = { planned: 0, removed: 0, keptByReason: {}, considered: 0, total: 0 };
var HANDOFF_FAILED_NOTICE = "sidequest: worktree sweep could not run, so stale agent worktrees were not collected this session.";
function stateDirectory() {
  const home = resolveSidequestHome();
  return import_node_path4.default.join(home, "sweep-reports");
}
function reportFile(cwd) {
  const key = import_node_crypto.default.createHash("sha1").update(import_node_path4.default.resolve(cwd || ".")).digest("hex").slice(0, 16);
  return import_node_path4.default.join(stateDirectory(), `${key}.json`);
}
function progressFile(cwd) {
  return reportFile(cwd).replace(/\.json$/, ".progress.json");
}
function normalizedProgress(value) {
  if (!value || typeof value !== "object") return EMPTY_SWEEP_PROGRESS;
  const record = value;
  const count = (candidate) => Number.isFinite(Number(candidate)) && Number(candidate) >= 0 ? Math.floor(Number(candidate)) : 0;
  const keptByReason = Object.fromEntries(Object.entries(record.keptByReason || {}).map(([reason, amount]) => [reason, count(amount)]).filter(([, amount]) => amount > 0));
  return {
    planned: count(record.planned),
    removed: count(record.removed),
    keptByReason,
    considered: count(record.considered),
    total: count(record.total)
  };
}
function writeSweepProgress(cwd, progress) {
  try {
    import_node_fs3.default.mkdirSync(stateDirectory(), { recursive: true });
    import_node_fs3.default.writeFileSync(progressFile(cwd), JSON.stringify(normalizedProgress(progress)));
  } catch (_) {
  }
}
function clearSweepProgress(cwd) {
  try {
    import_node_fs3.default.rmSync(progressFile(cwd), { force: true });
  } catch (_) {
  }
}
function drainReport(cwd) {
  const file = reportFile(cwd);
  let raw;
  try {
    raw = import_node_fs3.default.readFileSync(file, "utf8");
  } catch (_) {
    return null;
  }
  import_node_fs3.default.rmSync(file, { force: true });
  clearSweepProgress(cwd);
  try {
    const parsed = JSON.parse(raw);
    const notices = parsed?.notices;
    return Array.isArray(notices) ? notices.map((notice) => String(notice)).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}
function sweepCwd(data) {
  return stringField(data, "cwd", "project_dir", "projectDir") || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}
function spawnSweepWorker(data, cwd, options) {
  return (0, import_node_child_process.spawn)(process.execPath, [
    import_node_path4.default.join(pluginRoot(), "hooks", "sweep-worktrees.js"),
    "--cwd",
    cwd,
    "--session",
    options.sessionId,
    // SQ-220: the child decides from these whether this start is a host restart, the only
    // start that may retire this session's unbound launches.
    "--source",
    stringField(data, "source"),
    "--subagent",
    isSubagent(data) ? "1" : "0"
  ], { detached: true, stdio: "ignore", windowsHide: true, ...options.env ? { env: options.env } : {} });
}
function carriedFile(cwd) {
  return reportFile(cwd).replace(/\.json$/, ".carried.json");
}
function readNotices(file) {
  try {
    const parsed = JSON.parse(import_node_fs3.default.readFileSync(file, "utf8"));
    const notices = parsed?.notices;
    return Array.isArray(notices) ? notices.map((notice) => String(notice)).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}
function carryPendingReport(cwd) {
  const pending = drainReport(cwd);
  if (!pending || !pending.length) return;
  try {
    import_node_fs3.default.mkdirSync(stateDirectory(), { recursive: true });
    import_node_fs3.default.writeFileSync(carriedFile(cwd), JSON.stringify({ notices: [...readNotices(carriedFile(cwd)), ...pending] }));
  } catch (_) {
  }
}
function sweepInFlight(cwd) {
  const staleAfterMs = 10 * 60 * 1e3;
  let modified;
  try {
    modified = import_node_fs3.default.statSync(progressFile(cwd)).mtimeMs;
  } catch (_) {
    return false;
  }
  return Date.now() - modified < staleAfterMs && !import_node_fs3.default.existsSync(reportFile(cwd));
}
function detachSweep(data) {
  const cwd = sweepCwd(data);
  if (sweepInFlight(cwd)) return [];
  carryPendingReport(cwd);
  writeSweepProgress(cwd, EMPTY_SWEEP_PROGRESS);
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_SESSION_ID;
  try {
    const child = spawnSweepWorker(data, cwd, { sessionId: "", env });
    child.once("error", () => {
    });
    child.unref();
  } catch (_) {
    clearSweepProgress(cwd);
    return [HANDOFF_FAILED_NOTICE];
  }
  return [];
}

// src/hooks/shared/worktree-sweep.ts
var import_node_child_process2 = require("node:child_process");
var import_node_fs4 = __toESM(require("node:fs"));
var import_promises = require("node:fs/promises");
var import_node_path5 = __toESM(require("node:path"));
var DEFAULT_NOT_INTEGRATED_SALVAGE_AGE_HOURS = 7 * 24;
function stateFile() {
  const home = resolveSidequestHome();
  return import_node_path5.default.join(home, "worktree-sweep-sessions.json");
}
function readState() {
  try {
    return JSON.parse(import_node_fs4.default.readFileSync(stateFile(), "utf8"));
  } catch (_) {
    return {};
  }
}
function writeState(state) {
  try {
    import_node_fs4.default.mkdirSync(import_node_path5.default.dirname(stateFile()), { recursive: true });
    import_node_fs4.default.writeFileSync(stateFile(), JSON.stringify(state), "utf8");
  } catch (_) {
  }
}
function sessionId(data) {
  return stringField(data, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
}
function unregisterSweepSession(data) {
  const id = sessionId(data);
  if (!id) return;
  const state = readState();
  if (state.sessions) delete state.sessions[id];
  if (state.reportedOrphans) delete state.reportedOrphans[id];
  writeState(state);
}

// src/hooks/session-end.ts
function main() {
  const data = readStdin();
  if (!data) return;
  const sessionId2 = stringField(data, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
  if (!sessionId2) return;
  const reasonValue = data.reason;
  const reason = reasonValue ? `session ended (${String(reasonValue)})` : "session ended";
  const notices = [];
  try {
    const store = require(runtimeModule("store"));
    store.reconcileSession(sessionId2, { reason, source: "session-end" });
    const agentsync = require(runtimeModule("agentsync"));
    agentsync.cleanupNativeAgents({ sessionId: sessionId2 });
  } catch (error) {
    notices.push(`sidequest: session-end reconciliation failed: ${error && error.message || error}`);
  }
  unregisterSweepSession(data);
  try {
    notices.push(...detachSweep(data));
  } catch (error) {
    notices.push(`sidequest: session-end worktree sweep failed: ${error && error.message || error}`);
  }
  if (notices.length) console.error(notices.join("\n"));
}
try {
  main();
} catch (error) {
  console.error(`sidequest: session-end failed: ${error && error.message || error}`);
}
