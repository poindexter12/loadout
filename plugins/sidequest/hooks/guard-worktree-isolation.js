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

// src/hooks/guard-worktree-isolation.ts
var import_node_path6 = __toESM(require("node:path"));
var import_node_child_process = require("node:child_process");

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

// src/hooks/shared/runtime-identity.ts
var import_node_fs4 = __toESM(require("node:fs"));
var import_node_path5 = __toESM(require("node:path"));

// src/hooks/shared/session-state.ts
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

// src/hooks/shared/session-state.ts
function sessionStateFile(prefix, sessionId) {
  const home = resolveSidequestHome();
  return import_node_path4.default.join(home, "tmp", "state", `${prefix}-${encodeURIComponent(sessionId)}.json`);
}
function readSessionState(file) {
  try {
    const parsed = JSON.parse(import_node_fs3.default.readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}
function writeSessionState(file, state) {
  import_node_fs3.default.mkdirSync(import_node_path4.default.dirname(file), { recursive: true });
  import_node_fs3.default.writeFileSync(file, JSON.stringify(state));
}

// src/hooks/shared/runtime-identity.ts
function canonicalPath(value) {
  const kernel = require(runtimeModule("kernel/worktree"));
  return kernel.canonicalPath(value);
}
function executorAgent(type) {
  if (!type) return false;
  try {
    return require(runtimeModule("exec-names")).classify(type).kind !== "unknown";
  } catch (_) {
    return /^sidequest-exec-/.test(type);
  }
}
function hookSessionId(input) {
  return stringField(input, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || "";
}
function enclosingCheckout(start) {
  let directory = canonicalPath(start);
  for (; ; ) {
    const gitEntry = import_node_path5.default.join(directory, ".git");
    let stats = null;
    try {
      stats = import_node_fs4.default.statSync(gitEntry);
    } catch (_) {
      stats = null;
    }
    if (stats) return { root: directory, linked: stats.isFile() };
    const parent = import_node_path5.default.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
function observedGitFacts(worktree) {
  const { checkoutLayout } = require(runtimeModule("kernel/worktree"));
  const layout = checkoutLayout(worktree);
  if (!layout?.revision) return null;
  return { gitDirectory: layout.gitDirectory, commonGitDirectory: layout.commonGitDirectory, revision: layout.revision };
}
var RUNTIME_IDENTITY_STATE_PREFIX = "runtime-identity";
var MAX_TRACKED_AGENTS = 32;
var MAX_TRACKED_ANCESTRY = 32;
function identityStateFile(sessionId) {
  return sessionStateFile(RUNTIME_IDENTITY_STATE_PREFIX, sessionId);
}
function readIdentityState(sessionId) {
  return readSessionState(identityStateFile(sessionId));
}
function writeIdentityState(sessionId, state) {
  try {
    writeSessionState(identityStateFile(sessionId), state);
  } catch (_) {
  }
}
function boundedEntries(entries, limit) {
  const keys = Object.keys(entries);
  if (keys.length <= limit) return entries;
  return Object.fromEntries(keys.slice(keys.length - limit).map((key) => [key, entries[key]]));
}
function agentKey(agentId, agentName, worktree) {
  return `${agentId || agentName || ""}\0${worktree}`;
}
function cachedBaselineAncestry(sessionId, baseline, revision, probe) {
  const key = `${baseline}\0${revision}`;
  if (!sessionId) return probe();
  const state = readIdentityState(sessionId);
  const cached = state.ancestry?.[key];
  if (cached === "ancestor" || cached === "unrelated") return cached;
  const answer = probe();
  if (answer === "unknown") return answer;
  writeIdentityState(sessionId, {
    ...state,
    ancestry: boundedEntries({ ...state.ancestry || {}, [key]: answer }, MAX_TRACKED_ANCESTRY)
  });
  return answer;
}
function isolationExpectation(input, agentId, executor, includeSessionFallback = true, observedWorktree = "") {
  try {
    const store = require(runtimeModule("store"));
    const found = store.dispatchIsolationExpectation({ agentId, executor, sessionId: hookSessionId(input), observedWorktree });
    return agentId && !includeSessionFallback && found?.matchedBy === "session" ? null : found;
  } catch (error) {
    refuseWhenBoardBusy(error);
    return null;
  }
}
function identityDiagnosis(input, agentId, executor, observedWorktree) {
  try {
    const store = require(runtimeModule("store"));
    return store.dispatchIdentityDiagnosis({ agentId, executor, sessionId: hookSessionId(input), observedWorktree });
  } catch (error) {
    refuseWhenBoardBusy(error);
    return null;
  }
}
function unboundClaim(input, executor, observedWorktree) {
  try {
    const store = require(runtimeModule("store"));
    return store.dispatchUnboundClaim({
      executor,
      sessionId: hookSessionId(input),
      observedWorktree,
      agentName: stringField(input, "agent_name", "agentName", "name")
    });
  } catch (error) {
    refuseWhenBoardBusy(error);
    return null;
  }
}
function bindObservedRuntimeIdentity(input, agentId, executor, worktree) {
  try {
    const store = require(runtimeModule("store"));
    const sessionId = hookSessionId(input);
    if (!sessionId) return;
    store.bindDispatchAgent(
      sessionId,
      executor,
      agentId,
      stringField(input, "agent_name", "agentName", "name") || null,
      worktree
    );
  } catch (error) {
    refuseWhenBoardBusy(error);
  }
}
function bindObservedRuntimeIdentityOnce(input, agentId, executor, worktree) {
  const sessionId = hookSessionId(input);
  if (!sessionId) return false;
  const agentName = stringField(input, "agent_name", "agentName", "name") || null;
  const key = agentKey(agentId, agentName, worktree);
  const state = readIdentityState(sessionId);
  const agents = state.agents || {};
  if (agents[key]?.attempted && !agents[key]?.deferred) return false;
  writeIdentityState(sessionId, {
    ...state,
    agents: boundedEntries({ ...agents, [key]: { attempted: true, executor, agentName, worktree } }, MAX_TRACKED_AGENTS)
  });
  bindObservedRuntimeIdentity(input, agentId, executor, worktree);
  return true;
}

// src/hooks/guard-worktree-isolation.ts
failClosedOnBoardBusy();
var leaseKernel = require(runtimeModule("kernel/worktree"));
var WRITE_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
function targetPath(input) {
  const toolInput = input.tool_input;
  if (!isRecord(toolInput)) return "";
  const value = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
  const target = value == null ? "" : String(value);
  return target && import_node_path6.default.isAbsolute(target) ? import_node_path6.default.resolve(target) : "";
}
function samePath(a, b) {
  const normalize = (value) => {
    const resolved = canonicalPath(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}
function registeredProjectCheckout(root) {
  try {
    const store = require(runtimeModule("store"));
    return Boolean(store.findProject(root)?.ok);
  } catch (error) {
    refuseWhenBoardBusy(error);
    return false;
  }
}
function observedWorktreeLease(found, worktree, agentId, sessionId) {
  const git = (args) => (0, import_node_child_process.execFileSync)("git", args, {
    cwd: worktree,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
  const gitPath = (value) => import_node_path6.default.isAbsolute(value) ? value : import_node_path6.default.resolve(worktree, value);
  let observed = observedGitFacts(worktree);
  if (!observed) {
    observed = {
      gitDirectory: gitPath(git(["rev-parse", "--git-dir"])),
      commonGitDirectory: gitPath(git(["rev-parse", "--git-common-dir"])),
      revision: git(["rev-parse", "--verify", "HEAD^{commit}"])
    };
  }
  const baselineAncestry = (baseline) => {
    if (!baseline) return "unknown";
    return cachedBaselineAncestry(sessionId, baseline, observed.revision, () => {
      try {
        git(["merge-base", "--is-ancestor", baseline, "HEAD"]);
        return "ancestor";
      } catch (error) {
        return error.status === 1 ? "unrelated" : "unknown";
      }
    });
  };
  const repository = found?.projectPath || worktree;
  return leaseKernel.createWorktreeLease({
    repository,
    gitDirectory: observed.gitDirectory,
    commonGitDirectory: observed.commonGitDirectory,
    dispatchRef: found?.ref || null,
    dispatchBaseline: found?.dispatchBaseline || null,
    sanctionedRevisions: found?.sanctionedRevisions || [],
    baselineAncestry: baselineAncestry(found?.dispatchBaseline || null),
    claimHeld: Boolean(found?.claimHeld),
    observedRevision: observed.revision,
    observedWorktree: worktree,
    boundRevision: found?.expectedRevision || null,
    boundWorktree: found?.sharedTree ? found.projectPath : found?.expectedWorktree || null,
    boundGitDirectory: found?.sharedTree ? null : found?.expectedGitDirectory || null,
    boundCommonGitDirectory: found?.sharedTree ? null : found?.expectedCommonGitDirectory || null,
    boundCheckoutInstance: found?.sharedTree ? null : found?.expectedCheckoutInstance || null,
    identity: found?.identityBound ? { status: "bound", agentId } : { status: "unknown" },
    phase: found?.terminal ? "terminal" : found?.phase || "created",
    locked: false,
    liveness: found?.terminal ? { status: "terminal", evidence: "the dispatch is terminal" } : found ? { status: "live", evidence: `dispatch ${found.ref} is active` } : { status: "unknown", evidence: "no dispatch matched this agent" },
    provisioning: "host"
  });
}
function expectedWorktree(found) {
  if (found.sharedTree && found.projectPath) return found.projectPath;
  return found.expectedWorktree || "(immutable worktree binding unavailable)";
}
function boundedText(value, limit) {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  const suffix = "…";
  let result = "";
  let bytes = Buffer.byteLength(suffix, "utf8");
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > limit) break;
    result += character;
    bytes += characterBytes;
  }
  return `${result}${suffix}`;
}
var REFUSAL_FACT_LIMITS = { "writing to": 60, "lease decision": 240 };
var DEFAULT_REFUSAL_FACT_LIMIT = 140;
function boundedRefusal(summary, facts, recovery) {
  const factLines = facts.map(([label, value]) => `  ${label}: ${boundedText(value, REFUSAL_FACT_LIMITS[label] ?? DEFAULT_REFUSAL_FACT_LIMIT)}`);
  return [
    `sidequest: refusing this write. ${boundedText(summary, 180)}`,
    ...factLines,
    `Recovery: ${recovery}`
  ].join("\n");
}
function refusal(found, target, repoRoot, cwd) {
  const expected = expectedWorktree(found);
  const sharedCheckout = `${repoRoot}${cwd && !samePath(cwd, repoRoot) ? ` (cwd ${cwd})` : ""}`;
  return boundedRefusal(
    `${found.ref} was dispatched with worktree isolation, but this write lands in the SHARED checkout.`,
    [["expected worktree", expected], ["writing to", target], ["shared checkout", sharedCheckout]],
    `This is a harness worktree-loss failure, not executor behavior. Stop writing, tell the orchestrator "${found.ref} lost its worktree, re-dispatch it", and leave the shared tree untouched. Report any staged work.`
  );
}
function terminalRefusal(found, target) {
  return boundedRefusal(
    `${found.ref} already reached a terminal board state, so this executor has no legal write target.`,
    [["writing to", target]],
    "Do not work around this or re-arm any Monitor. Stop owned background tasks and end this executor. Redispatch the ticket if more work is needed."
  );
}
function unknownRefusal(target, repo, diagnosis, unboundRef = null) {
  const matches = diagnosis ? `live ${diagnosis.live}, session ${diagnosis.session}, session+executor ${diagnosis.sessionExecutor}, agent id ${diagnosis.agent}, worktree ${diagnosis.worktree}` : "(unavailable)";
  const unboundSummary = unboundRef ? `this executor's claim on ${unboundRef} is not bound to an agent id.` : repo.linked ? "This executor is in an isolated worktree the board cannot match to any dispatch record, so it holds no write authority here." : "This executor has no active dispatch record for a shared-checkout write.";
  const recovery = unboundRef ? "Claim through the Sidequest MCP hook so it can attach this runtime agent id. Redispatch alone does not bind this claim; stop and report this refusal." : 'Do not work around this. If this is the same live claim after an API resume, call mcp__plugin_sidequest_board__dispatch({ ref: "<ref>", recoveryEvidence: "<observed refusal>", claimHolder: "<your by>", worktree: "<linked checkout>" }) before writing. It verifies the stored executor, re-mints the token, and re-binds this worktree without releasing. Otherwise stop owned background tasks, report these dispatch-record counts, and redispatch before making more changes.';
  return boundedRefusal(
    unboundSummary,
    [["writing to", target], [repo.linked ? "isolated worktree" : "shared checkout", repo.root], ["dispatch records", matches]],
    recovery
  );
}
function leaseRefusal(found, target, reason) {
  return boundedRefusal(
    `${found?.ref || "This executor"} has no write lease for the observed worktree.`,
    [["writing to", target], ["lease decision", reason]],
    "Do not work around this. Stop writing and ask the orchestrator to redispatch the ticket."
  );
}
function linkedWorktreeLeaseRefusal(found, target, actualRoot, reason) {
  const expected = found.expectedWorktree || "(unavailable)";
  const worktreeFacts = found.expectedWorktree && samePath(expected, actualRoot) ? [["worktree", actualRoot]] : [["expected worktree", expected], ["actual worktree", actualRoot]];
  return boundedRefusal(
    `${found.ref} has no write lease for this linked worktree.`,
    [...worktreeFacts, ["writing to", target], ["lease decision", reason]],
    "Use the worktree assigned to this executor. If it no longer exists, stop and ask the orchestrator to redispatch the ticket."
  );
}
function main() {
  const input = readStdin();
  if (!input || !WRITE_TOOLS.has(stringField(input, "tool_name"))) return;
  const agentId = stringField(input, "agent_id", "agentId");
  const executor = stringField(input, "agent_type", "agentType", "subagent_type");
  if (!agentId || !executorAgent(executor)) return;
  const target = targetPath(input);
  if (!target) return;
  const repo = enclosingCheckout(import_node_path6.default.dirname(canonicalPath(target)));
  if (!repo) return;
  const sessionId = hookSessionId(input);
  let found = isolationExpectation(input, agentId, executor, true, repo.root);
  if (!found?.terminal && !found?.identityBound && (repo.linked || !found && registeredProjectCheckout(repo.root)) && bindObservedRuntimeIdentityOnce(input, agentId, executor, repo.root)) {
    found = isolationExpectation(input, agentId, executor, true, repo.root);
  }
  if (found?.terminal) {
    writeDeny("PreToolUse", terminalRefusal(found, target));
    return;
  }
  if (!found) {
    try {
      const decision = leaseKernel.worktreeWriteDecision(observedWorktreeLease(null, repo.root, agentId, sessionId), target);
      if (!decision.allowed) {
        const diagnosis = identityDiagnosis(input, agentId, executor, repo.root);
        const unbound = unboundClaim(input, executor, repo.root);
        writeDeny("PreToolUse", unknownRefusal(target, repo, diagnosis, unbound?.ref || null));
      }
    } catch (_) {
      const diagnosis = identityDiagnosis(input, agentId, executor, repo.root);
      const unbound = unboundClaim(input, executor, repo.root);
      writeDeny("PreToolUse", unknownRefusal(target, repo, diagnosis, unbound?.ref || null));
    }
    return;
  }
  try {
    const decision = leaseKernel.worktreeWriteDecision(observedWorktreeLease(found, repo.root, agentId, sessionId), target);
    if (!decision.allowed) {
      const message = !found.sharedTree && repo.linked ? linkedWorktreeLeaseRefusal(found, target, repo.root, decision.reason) : !found.sharedTree ? refusal(found, target, repo.root, stringField(input, "cwd")) : leaseRefusal(found, target, decision.reason);
      writeDeny("PreToolUse", message);
    }
  } catch (_) {
    writeDeny("PreToolUse", leaseRefusal(found, target, "the observed Git facts could not hydrate a lease."));
  }
}
try {
  main();
} catch (error) {
  refuseWhenBoardBusy(error);
  process.exit(0);
}
