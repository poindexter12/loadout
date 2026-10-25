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

// src/hooks/guard-heredoc-isolated.ts
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

// src/hooks/shared/paths.ts
var import_node_path2 = __toESM(require("node:path"));
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || import_node_path2.default.join(__dirname, "..");
}
function runtimeModule(name) {
  return import_node_path2.default.join(pluginRoot(), "lib", `${name}.js`);
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

// src/hooks/guard-heredoc-isolated.ts
function bashCommand(input) {
  const toolInput = input.tool_input;
  if (!isRecord(toolInput)) return "";
  return String(toolInput.command || "");
}
function hasHereDoc(command) {
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === "single") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === "double") {
      if (character === "\\") index += 1;
      else if (character === '"') quote = null;
      continue;
    }
    if (character === "'") {
      quote = "single";
      continue;
    }
    if (character === '"') {
      quote = "double";
      continue;
    }
    if (character === "#") {
      const previous = command[index - 1];
      if (previous === void 0 || /[\s;&|(]/.test(previous)) {
        const lineEnd = command.indexOf("\n", index);
        if (lineEnd < 0) return false;
        index = lineEnd;
      }
      continue;
    }
    if (character === "<" && command[index + 1] === "<" && command[index + 2] !== "<") return true;
  }
  return false;
}
var PROGRAM_START = String.raw`(?:^|[;&|\n(\x60{]|\$\()\s*`;
var COMMAND_PREFIX = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:(?:command|exec|env|sudo|nohup|time)\s+(?:-\S+\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)*`;
var GIT_PROGRAM = new RegExp(`${PROGRAM_START}${COMMAND_PREFIX}(?:\\S*/)?git(?=\\s|$|[;&|)])`, "g");
var SHELL_PROGRAM = new RegExp(`${PROGRAM_START}${COMMAND_PREFIX}(?:\\S*/)?(?:ba|z|da|k)?sh(?=\\s|$|[;&|)])`, "g");
function quotedAt(command, index) {
  let quote = "";
  for (let cursor = 0; cursor < index; cursor += 1) {
    const character = command[cursor];
    if (character === "\\") cursor += 1;
    else if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
  }
  return Boolean(quote);
}
function programIn(text, pattern, honourQuotes) {
  for (const match of text.matchAll(pattern)) {
    if (!honourQuotes || !quotedAt(text, match.index || 0)) return true;
  }
  return false;
}
function carriesGitInvocation(command) {
  const shell = withoutHereDocBodies(command);
  if (programIn(shell, GIT_PROGRAM, true)) return true;
  return programIn(shell, SHELL_PROGRAM, true) && programIn(command, GIT_PROGRAM, false);
}
function dispatchedInWorktree(input) {
  try {
    const store = require(runtimeModule("store"));
    const found = store.dispatchIsolationExpectation({
      agentId: stringField(input, "agent_id", "agentId"),
      executor: stringField(input, "agent_type", "agentType", "subagent_type"),
      sessionId: stringField(input, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || "",
      observedWorktree: stringField(input, "cwd") || process.cwd()
    });
    return found?.sharedTree === false;
  } catch (_) {
    return false;
  }
}
function harnessWorktreeCwd(input) {
  const cwd = stringField(input, "cwd") || process.cwd();
  const parts = import_node_path3.default.resolve(cwd).split(/[\\/]+/).map((part) => part.toLowerCase());
  return parts.some((part, index) => part === "worktrees" && parts.slice(0, index).includes(".claude") && (parts[index + 1]?.startsWith("agent-") === true || parts[index + 2]?.startsWith("agent-") === true));
}
function main() {
  const input = readStdin();
  if (!input || stringField(input, "tool_name") !== "Bash") return;
  const command = bashCommand(input);
  if (!hasHereDoc(command) || !carriesGitInvocation(command)) return;
  if (!dispatchedInWorktree(input) && !harnessWorktreeCwd(input)) return;
  writeDeny("PreToolUse", "sidequest: refusing a heredoc that carries a git invocation in an isolated worktree; the harness cannot verify that git stays inside the worktree. Run git as plain, separate commands, or Write the script to your scratchpad and run it by path. A heredoc with no git invocation is allowed.");
}
try {
  main();
} catch (_) {
  process.exit(0);
}
