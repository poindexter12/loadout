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
var lock_trace_exports = {};
__export(lock_trace_exports, {
  LOCK_TRACE_ENV: () => LOCK_TRACE_ENV,
  LOCK_TRACE_FILENAME: () => LOCK_TRACE_FILENAME,
  UNATTRIBUTED_CALLER: () => UNATTRIBUTED_CALLER,
  beginLockHold: () => beginLockHold,
  beginLockWait: () => beginLockWait,
  defaultLockTracePath: () => defaultLockTracePath,
  flushLockTrace: () => flushLockTrace,
  formatLockTraceReport: () => formatLockTraceReport,
  lockTraceEnabled: () => lockTraceEnabled,
  lockTracePath: () => lockTracePath,
  readLockTraceRecords: () => readLockTraceRecords,
  resetLockTrace: () => resetLockTrace,
  summarizeLockTrace: () => summarizeLockTrace
});
module.exports = __toCommonJS(lock_trace_exports);
var import_node_crypto = __toESM(require("node:crypto"));
var import_node_fs = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path = __toESM(require("node:path"));
var import_node_perf_hooks = require("node:perf_hooks");
var import_node_url = require("node:url");
var import_claude_home = require("./claude-home.js");
const LOCK_TRACE_ENV = "SIDEQUEST_LOCK_TRACE";
const LOCK_TRACE_FILENAME = "lock-trace.jsonl";
const OFF_VALUES = /* @__PURE__ */ new Set(["", "0", "false", "off", "no"]);
const ON_VALUES = /* @__PURE__ */ new Set(["1", "true", "on", "yes"]);
const CALLER_CAPTURE_FRAME_LIMIT = 32;
const CALLER_CHAIN_LIMIT = 5;
const UNATTRIBUTED_CALLER = "(unattributed)";
const PENDING_RECORD_LIMIT = 1024;
let config;
let broken = false;
let projectSlug;
let sinkFd = null;
let sinkFile = null;
let exitFlushInstalled = false;
const openFrames = [];
const pending = [];
function resolveConfig(env) {
  const raw = String(env[LOCK_TRACE_ENV] ?? "").trim();
  const word = raw.toLowerCase();
  if (OFF_VALUES.has(word)) return null;
  if (ON_VALUES.has(word)) return { file: import_node_path.default.join((0, import_claude_home.resolveSidequestHome)(env), LOCK_TRACE_FILENAME) };
  return { file: import_node_path.default.resolve(raw) };
}
function lockTraceConfig() {
  if (broken) return null;
  if (config === void 0) config = resolveConfig(process.env);
  return config;
}
function lockTracePath() {
  return lockTraceConfig()?.file ?? null;
}
function lockTraceEnabled() {
  return lockTraceConfig() !== null;
}
function defaultLockTracePath(env = process.env) {
  return import_node_path.default.join((0, import_claude_home.resolveSidequestHome)(env), LOCK_TRACE_FILENAME);
}
function traceProject() {
  if (projectSlug !== void 0) return projectSlug;
  projectSlug = null;
  try {
    const { createPaths } = require("./store/paths.js");
    const paths = createPaths({ fs: import_node_fs.default, os: import_node_os.default, path: import_node_path.default, crypto: import_node_crypto.default });
    projectSlug = paths.slugify(paths.nearestRepoRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd()));
  } catch (_) {
    projectSlug = null;
  }
  return projectSlug;
}
const seamDirectory = __dirname;
const seamModules = /* @__PURE__ */ new Set(["db", "lock-trace"]);
const storeFacadePrefix = import_node_path.default.join(seamDirectory, "store.");
const storeDirectoryPrefix = import_node_path.default.join(seamDirectory, "store") + import_node_path.default.sep;
function captureCallSites() {
  const previousPrepare = Error.prepareStackTrace;
  const previousLimit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = CALLER_CAPTURE_FRAME_LIMIT;
    Error.prepareStackTrace = (_error, callSites) => callSites;
    const holder = {};
    Error.captureStackTrace(holder, captureCallSites);
    const captured = holder.stack;
    return Array.isArray(captured) ? captured : [];
  } catch (_) {
    return [];
  } finally {
    Error.prepareStackTrace = previousPrepare;
    Error.stackTraceLimit = previousLimit;
  }
}
function frameFile(raw) {
  if (!raw) return null;
  if (!raw.startsWith("file://")) return raw;
  try {
    return (0, import_node_url.fileURLToPath)(raw);
  } catch (_) {
    return null;
  }
}
function isPlumbingFrame(file) {
  if (file.startsWith("node:") || file.includes(`${import_node_path.default.sep}node_modules${import_node_path.default.sep}`)) return true;
  if (import_node_path.default.dirname(file) !== seamDirectory) return false;
  return seamModules.has(import_node_path.default.basename(file).replace(/\.[cm]?[jt]s$/, ""));
}
function frameLocation(file, line) {
  const relative = import_node_path.default.relative(seamDirectory, file);
  const shown = !relative || relative.startsWith("..") ? import_node_path.default.basename(file) : relative;
  return `${shown}:${line}`;
}
function resolveAttribution() {
  const frames = [];
  for (const site of captureCallSites()) {
    const file = frameFile(site.getFileName());
    if (!file || isPlumbingFrame(file)) continue;
    frames.push({
      name: site.getFunctionName() || site.getMethodName() || null,
      file,
      line: site.getLineNumber() ?? 0,
      store: file.startsWith(storeDirectoryPrefix) || file.startsWith(storeFacadePrefix)
    });
  }
  let outermostNamedStore = null;
  let outermostNamed = null;
  for (const frame of frames) {
    if (!frame.name) continue;
    outermostNamed = frame;
    if (frame.store) outermostNamedStore = frame;
  }
  const chosen = outermostNamedStore ?? outermostNamed;
  const innermost = frames[0];
  const chain = frames.slice(0, CALLER_CHAIN_LIMIT);
  if (chosen && !chain.includes(chosen)) chain.splice(CALLER_CHAIN_LIMIT - 1, 1, chosen);
  return {
    caller: chosen?.name ?? (innermost ? frameLocation(innermost.file, innermost.line) : UNATTRIBUTED_CALLER),
    callerStack: chain.map((frame) => `${frame.name ?? "<anonymous>"} (${frameLocation(frame.file, frame.line)})`)
  };
}
function closeSink() {
  if (sinkFd === null) return;
  try {
    import_node_fs.default.closeSync(sinkFd);
  } catch (_) {
  }
  sinkFd = null;
  sinkFile = null;
}
function breakTrace(what, error) {
  broken = true;
  config = null;
  pending.length = 0;
  closeSink();
  const detail = error instanceof Error ? error.message : String(error);
  try {
    import_node_fs.default.writeSync(2, `sidequest: lock tracing turned itself off after failing to ${what}: ${detail}
`);
  } catch (_) {
  }
}
function flushLockTrace() {
  if (!pending.length) return;
  const active = lockTraceConfig();
  if (!active) {
    pending.length = 0;
    return;
  }
  const payload = Buffer.from(pending.join(""), "utf8");
  pending.length = 0;
  try {
    if (sinkFd === null || sinkFile !== active.file) {
      closeSink();
      import_node_fs.default.mkdirSync(import_node_path.default.dirname(active.file), { recursive: true });
      sinkFd = import_node_fs.default.openSync(active.file, "a");
      sinkFile = active.file;
    }
    let written = 0;
    while (written < payload.length) {
      written += import_node_fs.default.writeSync(sinkFd, payload, written, payload.length - written);
    }
  } catch (error) {
    breakTrace(`append to ${active.file}`, error);
  }
}
function activate() {
  traceProject();
  if (exitFlushInstalled) return;
  exitFlushInstalled = true;
  process.once("exit", () => {
    try {
      flushLockTrace();
    } catch (_) {
    }
  });
}
function emit(record) {
  pending.push(`${JSON.stringify(record)}
`);
  if (pending.length >= PENDING_RECORD_LIMIT) flushLockTrace();
}
function round(milliseconds) {
  return Math.round(milliseconds * 1e3) / 1e3;
}
function beginLockWait(operation, policy) {
  if (!lockTraceConfig()) return null;
  activate();
  const depth = openFrames.length;
  const attribution = openFrames[depth - 1] ?? resolveAttribution();
  openFrames.push(attribution);
  const startedAt = import_node_perf_hooks.performance.now();
  let finished = false;
  let released = false;
  const finish = (outcome, attempts) => {
    if (finished) return;
    finished = true;
    emit({
      kind: "wait",
      at: (/* @__PURE__ */ new Date()).toISOString(),
      pid: process.pid,
      policy,
      project: traceProject(),
      operation,
      caller: attribution.caller,
      callerStack: [...attribution.callerStack],
      depth,
      waitMs: round(import_node_perf_hooks.performance.now() - startedAt),
      attempts,
      // A retry only ever follows a busy error, and only a busy error can exhaust the budget, so these
      // two facts are exactly "some attempt saw SQLITE_BUSY" without db.ts reporting it separately.
      blocked: attempts > 1 || outcome === "exhausted",
      outcome
    });
    if (outcome === "exhausted") flushLockTrace();
  };
  return {
    finish,
    release() {
      if (released) return;
      released = true;
      finish("abandoned", 0);
      openFrames.pop();
      if (openFrames.length === 0) flushLockTrace();
    }
  };
}
function beginLockHold(operation, policy) {
  if (!lockTraceConfig()) return null;
  activate();
  const depth = Math.max(0, openFrames.length - 1);
  const attribution = openFrames[openFrames.length - 1] ?? resolveAttribution();
  const startedAt = import_node_perf_hooks.performance.now();
  let finished = false;
  return {
    finish(outcome) {
      if (finished) return;
      finished = true;
      emit({
        kind: "hold",
        at: (/* @__PURE__ */ new Date()).toISOString(),
        pid: process.pid,
        policy,
        project: traceProject(),
        operation,
        caller: attribution.caller,
        callerStack: [...attribution.callerStack],
        depth,
        holdMs: round(import_node_perf_hooks.performance.now() - startedAt),
        outcome
      });
    }
  };
}
function resetLockTrace() {
  flushLockTrace();
  closeSink();
  config = void 0;
  broken = false;
  projectSlug = void 0;
  openFrames.length = 0;
}
function isLockTraceRecord(value) {
  if (value === null || typeof value !== "object") return false;
  const kind = value.kind;
  return kind === "wait" || kind === "hold";
}
function readLockTraceRecords(file) {
  const records = [];
  let skipped = 0;
  for (const line of import_node_fs.default.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (isLockTraceRecord(parsed)) records.push(parsed);
      else skipped += 1;
    } catch (_) {
      skipped += 1;
    }
  }
  return { records, skipped };
}
function percentile(sortedAscending, quantile) {
  if (!sortedAscending.length) return 0;
  const rank = Math.min(sortedAscending.length - 1, Math.max(0, Math.ceil(quantile * sortedAscending.length) - 1));
  return sortedAscending[rank] ?? 0;
}
function groupStats(key, records) {
  const waits = records.filter((record) => record.kind === "wait");
  const holds = records.filter((record) => record.kind === "hold");
  const sortedWaits = waits.map((record) => record.waitMs).sort((left, right) => left - right);
  return {
    key,
    waits: waits.length,
    nested: waits.filter((record) => record.depth > 0).length,
    blocked: waits.filter((record) => record.blocked).length,
    exhausted: waits.filter((record) => record.outcome === "exhausted").length,
    failed: waits.filter((record) => record.outcome === "failed").length,
    p50WaitMs: percentile(sortedWaits, 0.5),
    p95WaitMs: percentile(sortedWaits, 0.95),
    maxWaitMs: sortedWaits.at(-1) ?? 0,
    holds: holds.length,
    maxHoldMs: holds.reduce((highest, record) => Math.max(highest, record.holdMs), 0),
    rollbacks: holds.filter((record) => record.outcome === "rollback").length
  };
}
function groupBy(records, keyOf) {
  const buckets = /* @__PURE__ */ new Map();
  for (const record of records) {
    const key = keyOf(record);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(record);
    else buckets.set(key, [record]);
  }
  return [...buckets.entries()].map(([key, bucket]) => groupStats(key, bucket)).sort((left, right) => right.blocked - left.blocked || right.maxWaitMs - left.maxWaitMs || left.key.localeCompare(right.key));
}
function summarizeLockTrace(records) {
  const overall = groupStats("all", records);
  const timestamps = records.map((record) => record.at).filter((at) => typeof at === "string").sort();
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
    projects: [...new Set(records.map((record) => record.project ?? "(unresolved)"))].sort(),
    firstAt: timestamps[0] ?? null,
    lastAt: timestamps.at(-1) ?? null
  };
}
function statsTable(title, rows) {
  const header = ["waits", "nested", "blocked", "exhausted", "p50ms", "p95ms", "maxms", "holds", "maxholdms", title];
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
    row.key
  ]);
  const widths = header.map((cell, column) => Math.max(cell.length, ...body.map((line) => (line[column] ?? "").length)));
  const render = (cells) => cells.map((cell, column) => column === cells.length - 1 ? cell : cell.padStart(widths[column] ?? cell.length)).join("  ").trimEnd();
  return [render(header), ...body.map(render)].join("\n");
}
function formatLockTraceReport(summary, options) {
  const lines = [
    `lock trace: ${options.file}`,
    `window: ${summary.firstAt ?? "(none)"} .. ${summary.lastAt ?? "(none)"}`,
    `pids: ${summary.pids.length} | projects: ${summary.projects.join(", ") || "(none)"}`,
    "",
    `waits: ${summary.waits} (${summary.nested} nested inside another wait, so wait time is not additive)`,
    `blocked: ${summary.blocked} wait${summary.blocked === 1 ? "" : "s"} hit SQLITE_BUSY at least once`,
    `budget exhausted: ${summary.exhausted} (a hook failing open, or a refused write)`,
    `wait ms: p50 ${summary.p50WaitMs} | p95 ${summary.p95WaitMs} | max ${summary.maxWaitMs}`,
    `holds: ${summary.holds} | max hold ms ${summary.maxHoldMs}`
  ];
  if (options.skipped) lines.push(`unparsed lines: ${options.skipped}`);
  lines.push("", statsTable("caller", summary.byCaller), "", statsTable("operation", summary.byOperation), "", statsTable("policy", summary.byPolicy));
  return `${lines.join("\n")}
`;
}
function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`Usage: node lock-trace.js [<trace.jsonl>] [--json]

Summarises a Sidequest board lock trace, broken down by the board function that held
the lock, then by statement, then by lock policy. Collect one by running the board with
${LOCK_TRACE_ENV}=1 (writes <board root>/${LOCK_TRACE_FILENAME}) or ${LOCK_TRACE_ENV}=/path/to/trace.jsonl.
`);
    return;
  }
  const file = argv.find((argument) => !argument.startsWith("-")) || lockTracePath() || defaultLockTracePath();
  let parsed;
  try {
    parsed = readLockTraceRecords(file);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`No lock trace to read at ${file}: ${detail}
Collect one by setting ${LOCK_TRACE_ENV}=1 (or to a file path) for the processes you want measured.
`);
    process.exitCode = 2;
    return;
  }
  const summary = summarizeLockTrace(parsed.records);
  process.stdout.write(json ? `${JSON.stringify({ file, skipped: parsed.skipped, ...summary }, null, 2)}
` : formatLockTraceReport(summary, { file, skipped: parsed.skipped }));
}
if (require.main === module) main();
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LOCK_TRACE_ENV,
  LOCK_TRACE_FILENAME,
  UNATTRIBUTED_CALLER,
  beginLockHold,
  beginLockWait,
  defaultLockTracePath,
  flushLockTrace,
  formatLockTraceReport,
  lockTraceEnabled,
  lockTracePath,
  readLockTraceRecords,
  resetLockTrace,
  summarizeLockTrace
});
