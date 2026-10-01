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

// src/hooks/guard-home-delete.ts
var import_node_os = __toESM(require("node:os"));
var import_node_path2 = __toESM(require("node:path"));

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

// src/hooks/guard-home-delete.ts
var UNKNOWN = "\0";
function deleteArguments(command) {
  const commands = /(?:^|[;&|{}()\n])\s*(?:[\w.-]+\s+)*(?:remove-item|rm|rmdir|rd|ri|del|erase)\b((?:\$\{[^{}\n]*\}|[^;&|{}\n])*)/gi;
  return [...command.matchAll(commands)].map((match) => match[1] || "");
}
function tokenize(text) {
  const tokens = [];
  let current = "";
  let started = false;
  let quote = "";
  const flush = () => {
    if (started) tokens.push(current);
    current = "";
    started = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === "$" && text[index + 1] === "(") {
      let depth = 0;
      let end = index + 1;
      for (; end < text.length; end += 1) {
        if (text[end] === "(") depth += 1;
        else if (text[end] === ")" && --depth === 0) break;
      }
      current += text.slice(index, end + 1);
      started = true;
      index = end;
      continue;
    }
    if (char === "`") {
      const end = text.indexOf("`", index + 1);
      const stop = end === -1 ? text.length : end;
      current += text.slice(index, stop + 1);
      started = true;
      index = stop;
      continue;
    }
    if (/\s/.test(char) || char === "(" || char === ")" || char === "<" || char === ">") {
      flush();
      continue;
    }
    if (char === "#" && !started) break;
    current += char;
    started = true;
  }
  flush();
  return tokens;
}
function parseDeleteArguments(argumentsAfterDelete) {
  const parsed = { recursive: false, targets: [] };
  let optionsEnded = false;
  for (const token of tokenize(argumentsAfterDelete)) {
    if (!token || token === "\\") continue;
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith("--")) {
      const name = token.toLowerCase().split("=")[0] ?? "";
      if (name.length >= 3 && "--recursive".startsWith(name)) parsed.recursive = true;
      continue;
    }
    if (!optionsEnded && token.startsWith("-") && token.length > 1) {
      const separator = token.indexOf(":");
      const name = separator === -1 ? token.slice(1) : token.slice(1, separator);
      if (/^[a-z]+$/i.test(name) && /r/i.test(name)) parsed.recursive = true;
      const value = separator === -1 ? "" : token.slice(separator + 1);
      if (value && /^(?:path|literalpath|lp|pspath)$/i.test(name)) parsed.targets.push(value);
      continue;
    }
    if (/^(?:\/[a-z?])+$/i.test(token)) {
      if (/\/s/i.test(token)) parsed.recursive = true;
      continue;
    }
    parsed.targets.push(token);
  }
  return parsed;
}
function expandHome(target, home) {
  return target.replace(/^~(?=[\\/]|$)/, () => home).replace(/\$\{(?:env:)?(?:home|userprofile)\}|\$env:(?:userprofile|home)(?![\w:])|\$home(?![\w:])|%userprofile%|%homedrive%%homepath%/gi, () => home);
}
function markUnknown(target) {
  let result = "";
  for (let index = 0; index < target.length; index += 1) {
    const char = target[index] ?? "";
    const next = target[index + 1] || "";
    if (index === 0 && char === "~") {
      const end = target.slice(1).search(/[\\/]/);
      result += UNKNOWN;
      index = end === -1 ? target.length : end;
      continue;
    }
    if (char === "$" && next === "(") {
      let depth = 0;
      let end = index + 1;
      for (; end < target.length; end += 1) {
        if (target[end] === "(") depth += 1;
        else if (target[end] === ")" && --depth === 0) break;
      }
      result += UNKNOWN;
      index = end;
      continue;
    }
    if (char === "$" && next === "{") {
      const end = target.indexOf("}", index);
      result += UNKNOWN;
      index = end === -1 ? target.length : end;
      continue;
    }
    if (char === "$" && /[a-z_]/i.test(next)) {
      const match = /^\$(?:env:)?\w+/i.exec(target.slice(index));
      result += UNKNOWN;
      index += (match ? match[0].length : 1) - 1;
      continue;
    }
    if (char === "$" && /[0-9@*#?!$-]/.test(next)) {
      result += UNKNOWN;
      index += 1;
      continue;
    }
    if (char === "`") {
      const end = target.indexOf("`", index + 1);
      result += UNKNOWN;
      index = end === -1 ? target.length : end;
      continue;
    }
    if (char === "%") {
      const match = /^%[a-z_][\w()]*%/i.exec(target.slice(index));
      if (match) {
        result += UNKNOWN;
        index += match[0].length - 1;
        continue;
      }
    }
    result += char;
  }
  return result;
}
function slashes(value) {
  return value.replace(/\\/g, "/");
}
function trimTrailingSlashes(value) {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed || "/";
}
function protectedPaths(home) {
  const paths = [import_node_path2.default.join(home, ".claude")];
  for (let current = home; ; current = import_node_path2.default.dirname(current)) {
    paths.push(current);
    if (import_node_path2.default.dirname(current) === current) break;
  }
  return paths.map((value) => trimTrailingSlashes(slashes(value)).toLowerCase());
}
function patternFor(target) {
  let source = "";
  for (let index = 0; index < target.length; index += 1) {
    const char = target[index] ?? "";
    if (char === UNKNOWN) source += ".*";
    else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "[") {
      const end = target.indexOf("]", index + 1);
      if (end === -1) source += "\\[";
      else {
        source += "[^/]";
        index = end;
      }
    } else source += char.replace(/[.+^${}()|\\\]]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}
function isProtectedTarget(rawTarget) {
  const home = import_node_path2.default.resolve(import_node_os.default.homedir());
  const marked = markUnknown(expandHome(rawTarget, home));
  if (!marked) return false;
  let candidate;
  if (marked.includes(UNKNOWN)) {
    const normalized = slashes(marked);
    if (normalized.split("/").some((part) => part === "." || part === "..")) return true;
    if (!normalized.startsWith(UNKNOWN) && !import_node_path2.default.isAbsolute(normalized.split(UNKNOWN)[0] || ".")) return false;
    candidate = trimTrailingSlashes(normalized);
  } else {
    const normalized = import_node_path2.default.sep === "/" ? slashes(marked) : marked;
    if (!import_node_path2.default.isAbsolute(normalized)) return false;
    const resolved = import_node_path2.default.resolve(normalized);
    if (import_node_path2.default.parse(resolved).root === resolved) return true;
    candidate = trimTrailingSlashes(slashes(resolved));
    const globAt = candidate.search(/[*?[]/);
    if (globAt !== -1) {
      const globDirectory = candidate.slice(0, candidate.lastIndexOf("/", globAt) + 1);
      if (import_node_path2.default.parse(import_node_path2.default.resolve(globDirectory)).root === import_node_path2.default.resolve(globDirectory)) return true;
    }
  }
  const pattern = patternFor(candidate);
  return protectedPaths(home).some((protectedPath) => pattern.test(protectedPath));
}
function hasProtectedRecursiveDelete(command) {
  return deleteArguments(command).some((argumentsAfterDelete) => {
    const parsed = parseDeleteArguments(argumentsAfterDelete);
    return parsed.recursive && parsed.targets.some(isProtectedTarget);
  });
}
function main() {
  const input = readStdin();
  if (!input || !["Bash", "PowerShell"].includes(stringField(input, "tool_name"))) return;
  const toolInput = input.tool_input;
  const command = toolInput !== null && typeof toolInput === "object" && !Array.isArray(toolInput) ? String(toolInput.command || "") : "";
  if (!hasProtectedRecursiveDelete(command)) return;
  writeDeny("PreToolUse", "sidequest: blocked a recursive delete aimed at the user profile or .claude root. Use a specific project or scratchpad path instead.");
}
try {
  main();
} catch (_) {
  process.exit(0);
}
