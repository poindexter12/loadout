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
var failClosedEvent = null;
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
function failClosed(error) {
  const hook = hookName();
  const reason = `sidequest: ${hook} refused this call because of board lock contention: another process holds the Sidequest board database lock, so this security guard could not finish its board check, and it refuses rather than allow the call unchecked. The call did not run. Retry the same call in a few seconds; if it keeps failing, a long-running Sidequest writer is holding the board lock.`;
  let denied = false;
  try {
    import_node_fs.default.writeSync(1, JSON.stringify({
      hookSpecificOutput: {
        hookEventName: failClosedEvent || "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason
      }
    }));
    denied = true;
  } catch (_) {
  }
  writeStderr(`${denied ? "" : `${reason}
`}sidequest: ${hook} refused this event without its board check (fail-closed, board lock busy): ${error.message}
`);
  process.exit(denied ? 0 : 2);
}
function boardBusy(error) {
  if (!(error instanceof Error)) return false;
  const code = Reflect.get(error, "code");
  const errcode = Reflect.get(error, "errcode");
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || errcode === 5 || errcode === 6) return true;
  if (/database (?:table )?is (?:locked|busy)/i.test(error.message)) return true;
  return boardBusy(Reflect.get(error, "cause"));
}
installBudget(failOpen);
function failClosedOnBoardBusy(hookEventName = "PreToolUse") {
  failClosedEvent = hookEventName;
  installBudget(failClosed);
}
function refuseWhenBoardBusy(error) {
  if (failClosedEvent && boardBusy(error)) failClosed(error);
}

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
function writeDeny(hookEventName, permissionDecisionReason) {
  writeJson({
    hookSpecificOutput: {
      hookEventName,
      permissionDecision: "deny",
      permissionDecisionReason: projectedText(hookEventName, permissionDecisionReason)
    }
  });
}

// src/hooks/shared/heredocs.ts
function hereDocAt(command, index) {
  let cursor = index + 2;
  const stripTabs = command[cursor] === "-";
  if (stripTabs) cursor += 1;
  while (command[cursor] === " " || command[cursor] === "	") cursor += 1;
  const quote = command[cursor];
  if (quote === "'" || quote === '"') {
    const end = command.indexOf(quote, cursor + 1);
    if (end < 0) return null;
    return { hereDoc: { delimiter: command.slice(cursor + 1, end), stripTabs }, end: end + 1 };
  }
  const match = command.slice(cursor).match(/^[^\s|&;()<>]+/);
  if (!match) return null;
  return { hereDoc: { delimiter: match[0], stripTabs }, end: cursor + match[0].length };
}
function skipHereDocBodies(command, index, hereDocs) {
  let cursor = index;
  for (const { delimiter, stripTabs } of hereDocs) {
    while (cursor < command.length) {
      const lineEnd = command.indexOf("\n", cursor);
      const end = lineEnd < 0 ? command.length : lineEnd;
      let line = command.slice(cursor, end).replace(/\r$/, "");
      if (stripTabs) line = line.replace(/^\t+/, "");
      cursor = lineEnd < 0 ? command.length : lineEnd + 1;
      if (line === delimiter) break;
    }
  }
  return cursor;
}
function escapedNewline(command, index) {
  let backslashes = 0;
  for (let cursor = index - 1; command[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}
function commentStart(command, index) {
  if (command[index] !== "#") return false;
  const previous = command[index - 1];
  return previous === void 0 || /[\s;&|(]/.test(previous);
}
function withoutHereDocBodies(command) {
  let quote = "";
  let hereDocs = [];
  let result = "";
  let copiedThrough = 0;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\n" && hereDocs.length > 0 && !escapedNewline(command, index)) {
      result += command.slice(copiedThrough, index + 1);
      index = skipHereDocBodies(command, index + 1, hereDocs) - 1;
      copiedThrough = index + 1;
      hereDocs = [];
      continue;
    }
    if (commentStart(command, index)) {
      const lineEnd = command.indexOf("\n", index);
      if (lineEnd < 0) break;
      index = lineEnd - 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "<" && command[index - 1] !== "<" && command[index + 1] === "<") {
      const parsed = hereDocAt(command, index);
      if (parsed) {
        hereDocs.push(parsed.hereDoc);
        index = parsed.end - 1;
      }
    }
  }
  return result + command.slice(copiedThrough);
}

// src/hooks/guard-process-signal.ts
failClosedOnBoardBusy();
var WRAPPERS = /* @__PURE__ */ new Set([
  "sudo",
  "doas",
  "command",
  "builtin",
  "env",
  "exec",
  "nohup",
  "setsid",
  "stdbuf",
  "nice",
  "ionice",
  "time",
  "timeout",
  "if",
  "then",
  "else",
  "elif",
  "while",
  "until",
  "do",
  "!"
]);
var SHELLS = /* @__PURE__ */ new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "busybox", "pwsh", "powershell", "cmd"]);
var KILL_VERBS = /* @__PURE__ */ new Set(["kill", "pkill", "killall", "killall5", "taskkill", "stop-process", "spps"]);
var SELECTOR = /(?:^|[^\w.-])(?:pgrep|pidof|ps|lsof|get-process|gps)(?:\s|$)/i;
var XARGS_VALUE_FLAGS = /* @__PURE__ */ new Set(["-a", "-d", "-E", "-e", "-I", "-i", "-L", "-l", "-n", "-P", "-s"]);
var SUBSTITUTIONS = /\$\(([\s\S]*?)\)|`([\s\S]*?)`/g;
function reasonFor(label) {
  return `sidequest: blocked ${label}. It picks its targets by pattern or by search rather than by ownership, so on this host it reaches other worktrees: a sibling executor's test or build command line is byte-identical to yours, and exactly this killed another ticket's verify run (SQ-224). Signal only a process this attempt started, by a pid or job spec this shell owns (\`kill "$pid"\`, \`kill %1\`). A verify run that overruns its budget is terminated by the verify wrapper itself, which kills the process group it spawned. A task you started is stopped with TaskStop. Another ticket's run is never yours to stop. Read-only \`pgrep\`/\`ps\` stays allowed if you only need to look.`;
}
function basename(token) {
  const name = (token.replace(/\\/g, "/").split("/").pop() || "").toLowerCase();
  return name.replace(/\.(?:exe|cmd|bat|ps1)$/, "");
}
function segmentsOf(command) {
  const segments = [];
  let tokens = [];
  let current = "";
  let started = false;
  const flushToken = () => {
    if (started) tokens.push(current);
    current = "";
    started = false;
  };
  const flushSegment = () => {
    flushToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "\\") {
      current += command[index + 1] ?? "";
      started = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = command.indexOf(char, index + 1);
      const stop = end === -1 ? command.length : end;
      current += command.slice(index + 1, stop);
      started = true;
      index = stop;
      continue;
    }
    if (char === "$" && command[index + 1] === "(") {
      let depth = 0;
      let end = index + 1;
      for (; end < command.length; end += 1) {
        if (command[end] === "(") depth += 1;
        else if (command[end] === ")" && --depth === 0) break;
      }
      current += command.slice(index, Math.min(end + 1, command.length));
      started = true;
      index = end;
      continue;
    }
    if (char === "`") {
      const end = command.indexOf("`", index + 1);
      const stop = end === -1 ? command.length : end;
      current += command.slice(index, stop + 1);
      started = true;
      index = stop;
      continue;
    }
    if (char === "#" && !started) {
      const lineEnd = command.indexOf("\n", index);
      if (lineEnd === -1) break;
      index = lineEnd - 1;
      continue;
    }
    if (";&|\n(){}".includes(char)) {
      flushSegment();
      continue;
    }
    if (char === "<" || char === ">" || /\s/.test(char)) {
      flushToken();
      continue;
    }
    current += char;
    started = true;
  }
  flushSegment();
  return segments;
}
function fromProcessSearch(token) {
  return [...token.matchAll(SUBSTITUTIONS)].some((match) => SELECTOR.test(match[1] ?? match[2] ?? ""));
}
function invocationOf(tokens) {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (/^[A-Za-z_]\w*=/.test(token)) {
      index += 1;
      continue;
    }
    if (WRAPPERS.has(basename(token))) {
      index += 1;
      while (index < tokens.length && /^(?:-|[\d.]+[smhd]?$)/.test(tokens[index] ?? "")) index += 1;
      continue;
    }
    return { head: basename(token), rest: tokens.slice(index + 1) };
  }
  return null;
}
function xargsCommand(rest) {
  let index = 0;
  while (index < rest.length) {
    const token = rest[index] ?? "";
    if (!token.startsWith("-")) break;
    index += 1;
    if (XARGS_VALUE_FLAGS.has(token)) index += 1;
  }
  return basename(rest[index] ?? "");
}
function powershellStopSelectsByName(rest) {
  if (rest.some((token) => /^-(?:n(?:a(?:me?)?)?|processname|pn)(?::|$)/i.test(token))) return true;
  return !rest.some((token) => /^-(?:id|i|inputobject)(?::|$)/i.test(token) || /^\$/.test(token) || /^\d+$/.test(token));
}
function denialFor(command, depth = 0) {
  const segments = segmentsOf(command);
  let searchedTargets = false;
  let signals = false;
  for (const tokens of segments) {
    if (tokens.some((token) => /^[A-Za-z_]\w*=/.test(token) && fromProcessSearch(token))) searchedTargets = true;
    const invocation = invocationOf(tokens);
    if (!invocation) continue;
    const { head, rest } = invocation;
    if (head === "pkill") return "a pattern-selected kill (pkill)";
    if (head === "killall" || head === "killall5") return "a name-selected kill (killall)";
    if (head === "taskkill" && rest.some((token) => /^[-/](?:im|fi)(?:[:=]|$)/i.test(token))) {
      return "an image-name kill (taskkill /IM)";
    }
    if ((head === "stop-process" || head === "spps") && powershellStopSelectsByName(rest)) {
      return "a name-selected or pipeline-fed kill (Stop-Process)";
    }
    if (head === "xargs" && KILL_VERBS.has(xargsCommand(rest))) {
      return "a kill fed through xargs (xargs kill)";
    }
    if (KILL_VERBS.has(head)) {
      signals = true;
      if (rest.some(fromProcessSearch)) return "a kill whose target came from a process search";
    }
    if (head === "for" && tokens.some(fromProcessSearch)) searchedTargets = true;
    if (SHELLS.has(head) && depth < 3) {
      for (let index = 0; index < rest.length; index += 1) {
        if (!/^(?:-c|-command|\/c|\/k)$/i.test(rest[index] ?? "")) continue;
        const nested = denialFor(rest[index + 1] ?? "", depth + 1);
        if (nested) return nested;
      }
    }
  }
  return searchedTargets && signals ? "a kill whose target came from a process search" : null;
}
function main() {
  const input = readStdin();
  if (!input || !["Bash", "PowerShell"].includes(stringField(input, "tool_name"))) return;
  const toolInput = input.tool_input;
  const command = isRecord(toolInput) ? String(toolInput.command || "") : "";
  if (!command) return;
  const label = denialFor(withoutHereDocBodies(command));
  if (!label) return;
  writeDeny("PreToolUse", reasonFor(label));
}
try {
  main();
} catch (error) {
  refuseWhenBoardBusy(error);
  process.exit(0);
}
