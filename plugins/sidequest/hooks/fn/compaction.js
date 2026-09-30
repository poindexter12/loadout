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
function sidequestHome(sidequestHomeEnv, homeEnv, configDirEnv) {
  const explicit = String(sidequestHomeEnv || "").trim();
  if (explicit) return trimSlashes(explicit);
  const configDir = trimSlashes(String(configDirEnv || "").trim());
  if (configDir) return `${configDir}/sidequest`;
  const home = trimSlashes(String(homeEnv || "").trim());
  return home ? `${home}/.claude/sidequest` : "";
}
function liveRefsPath(home, sessionId) {
  return `${trimSlashes(home)}/live-refs/${encodeURIComponent(sessionId)}.json`;
}
function parseLiveRefs(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || parsed.version !== LIVE_REFS_VERSION || !Array.isArray(parsed.closed)) return null;
    return {
      version: LIVE_REFS_VERSION,
      session: typeof parsed.session === "string" ? parsed.session : "",
      at: typeof parsed.at === "string" ? parsed.at : "",
      pin: typeof parsed.pin === "string" ? parsed.pin : "",
      closed: parsed.closed.filter((ref) => typeof ref === "string" && ref.length > 0)
    };
  } catch (_) {
    return null;
  }
}

// src/hooks/fn/compaction.ts
var PER_RESULT_CAP_BYTES = 32 * 1024;
var TOTAL_CAP_BYTES = 64 * 1024;
var DISPATCH_TOOL = "mcp__plugin_sidequest_board__dispatch";
var BRIEFING = /sidequest-launcher\.js["']?\s+briefing\s+([A-Za-z][A-Za-z0-9]*-\d+)/;
var REF = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
var JEV_PLUGIN = "fast-jev-compaction";
var encoder = new TextEncoder();
var utf8Bytes = (text) => encoder.encode(text).length;
function protectedCalls(messages, closedRefs = /* @__PURE__ */ new Set()) {
  const calls = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const use of message.toolUses || []) {
      const input = use.input || {};
      let call = null;
      if (use.tool === DISPATCH_TOOL) {
        const ref = typeof input.ref === "string" && REF.test(input.ref) ? input.ref : "";
        call = { id: use.tool_use_id, kind: "dispatch", ref };
      } else if (use.tool === "Bash" && typeof input.command === "string") {
        const match = BRIEFING.exec(input.command);
        if (match) call = { id: use.tool_use_id, kind: "briefing", ref: match[1] || "", command: input.command };
      } else if ((use.tool === "Agent" || use.tool === "Task") && typeof input.prompt === "string") {
        const match = BRIEFING.exec(input.prompt);
        if (match) call = { id: use.tool_use_id, kind: "agent", ref: match[1] || "" };
      }
      if (call && !(call.ref && closedRefs.has(call.ref))) calls.push(call);
    }
  }
  return calls;
}
function blockIds(message) {
  return [
    ...(message.toolUses || []).map((use) => use.tool_use_id),
    ...(message.toolResults || []).map((result) => result.tool_use_id)
  ];
}
function retrieval(call) {
  if (call.kind === "briefing" && call.command) {
    const command = call.command.length > 400 ? `${call.command.slice(0, 400)}...` : call.command;
    return `re-run ${command}`;
  }
  if (call.kind === "dispatch" && call.ref) return `${DISPATCH_TOOL} for ${call.ref} returns the spawn again`;
  if (call.ref) return `mcp__plugin_sidequest_board__pulse and comments for ${call.ref}`;
  return "the sidequest board tools";
}
function pointerText(call, bytes, reason) {
  const what = `${call.kind} result${call.ref ? ` for ${call.ref}` : ""}`;
  return `[${COMPACTION_RECOVERY_MARKER}: the ${what} (${bytes} B) was not restored after compaction, ${reason}. Retrieve: ${retrieval(call)}.]`;
}
function nonTextResult(result) {
  const record = result.result;
  const blocks = Array.isArray(record) ? record : record && typeof record === "object" && Array.isArray(record.content) ? record.content : null;
  if (!blocks) return false;
  return blocks.some((block) => Boolean(block) && typeof block === "object" && typeof block.type === "string" && block.type !== "text");
}
var freshUse = (use) => ({ tool_use_id: use.tool_use_id, tool: use.tool, input: use.input });
var freshResult = (result) => ({ tool_use_id: result.tool_use_id, text: result.text, isError: result.isError });
function restoreProtected(input, output, protectedIds, cap = { perResult: PER_RESULT_CAP_BYTES, total: TOTAL_CAP_BYTES }) {
  const calls = /* @__PURE__ */ new Map();
  for (const entry of protectedIds) {
    const call = typeof entry === "string" ? { id: entry, kind: "dispatch", ref: "" } : entry;
    calls.set(call.id, call);
  }
  const messages = [...output];
  const report = { messages, restored: [], pointed: [], skipped: [] };
  if (!calls.size) return report;
  const useAt = /* @__PURE__ */ new Map();
  const resultAt = /* @__PURE__ */ new Map();
  input.forEach((message, index) => {
    for (const use of message.toolUses || []) useAt.set(use.tool_use_id, index);
    for (const result of message.toolResults || []) resultAt.set(result.tool_use_id, index);
  });
  const anchors = inputAnchors(input, useAt);
  let spent = 0;
  const pointers = [];
  for (const call of calls.values()) {
    const useIndex = useAt.get(call.id);
    const resultIndex = resultAt.get(call.id);
    if (useIndex === void 0 || resultIndex === void 0) continue;
    const resultMessage = input[resultIndex];
    const use = (input[useIndex]?.toolUses || []).find((entry) => entry.tool_use_id === call.id);
    const original = (resultMessage?.toolResults || []).find((result) => result.tool_use_id === call.id);
    if (!resultMessage || !use || !original) continue;
    const intact = messages.some((message) => message.handle !== void 0 && message.handle === resultMessage.handle || message.handle === void 0 && (message.toolResults || []).some((result) => result.tool_use_id === call.id && result.text === original.text));
    if (intact) continue;
    if (nonTextResult(original)) {
      report.skipped.push(call.id);
      continue;
    }
    const bytes = utf8Bytes(original.text);
    let reason = "";
    if (bytes > cap.perResult) reason = `over the ${cap.perResult} B per-result cap`;
    else if (spent + bytes > cap.total) reason = `past the ${cap.total} B restore budget`;
    if (reason) {
      pointers.push({ call, text: pointerText(call, bytes, reason), anchor: useIndex });
      report.pointed.push(call.id);
      continue;
    }
    spent += bytes;
    const holds = (message) => (message.toolResults || []).some((result) => result.tool_use_id === call.id);
    const callAt = messages.findIndex((message) => (message.toolUses || []).some((entry) => entry.tool_use_id === call.id));
    if (callAt < 0) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message || message.handle !== void 0 || !holds(message)) continue;
        const toolResults = (message.toolResults || []).filter((result) => result.tool_use_id !== call.id);
        if (!message.text && !(message.toolUses || []).length && !toolResults.length) messages.splice(index, 1);
        else messages[index] = { ...message, toolResults };
      }
      messages.splice(
        insertionPoint(messages, useIndex, anchors),
        0,
        { role: "assistant", text: "", toolUses: [freshUse(use)] },
        { role: "user", text: "", toolUses: [], toolResults: [freshResult(original)] }
      );
      report.restored.push(call.id);
      continue;
    }
    const holderAt = messages.findIndex((message) => message.handle === void 0 && holds(message));
    const holder = holderAt >= 0 ? messages[holderAt] : void 0;
    if (holder) {
      messages[holderAt] = {
        ...holder,
        toolResults: (holder.toolResults || []).map((result) => result.tool_use_id === call.id ? freshResult(original) : result)
      };
    } else {
      const callMessage = messages[callAt];
      const after = messages[callAt + 1];
      const siblings = after !== void 0 && after.handle === void 0 && after.role === "user" && (after.toolResults || []).some((result) => (callMessage?.toolUses || []).some((entry) => entry.tool_use_id === result.tool_use_id));
      if (after && siblings) messages[callAt + 1] = { ...after, toolResults: [...after.toolResults || [], freshResult(original)] };
      else messages.splice(callAt + 1, 0, { role: "user", text: "", toolUses: [], toolResults: [freshResult(original)] });
    }
    report.restored.push(call.id);
  }
  for (const pointer of pointers) {
    const holder = messages.findIndex((message2) => message2.handle === void 0 && (message2.toolResults || []).some((result) => result.tool_use_id === pointer.call.id));
    const message = holder >= 0 ? messages[holder] : void 0;
    if (message) {
      messages[holder] = {
        ...message,
        toolResults: (message.toolResults || []).map((result) => result.tool_use_id === pointer.call.id ? { ...result, text: `${result.text}
${pointer.text}` } : result)
      };
    } else {
      messages.splice(insertionPoint(messages, pointer.anchor, anchors), 0, { role: "user", text: pointer.text, toolUses: [] });
    }
  }
  return report;
}
var textKey = (message) => `${message.role}\0${message.text}`;
function inputAnchors(input, useAt) {
  const handleAt = /* @__PURE__ */ new Map();
  const textAt = /* @__PURE__ */ new Map();
  input.forEach((message, index) => {
    if (message.handle) handleAt.set(message.handle, index);
    if (message.text && !textAt.has(textKey(message))) textAt.set(textKey(message), index);
  });
  return { useAt, handleAt, textAt };
}
function insertionPoint(messages, target, anchors) {
  let anchor = -1;
  let point = messages.length;
  for (const [index, message] of messages.entries()) {
    const byHandle = message.handle !== void 0 ? anchors.handleAt.get(message.handle) : void 0;
    const byBlock = blockIds(message).map((id) => anchors.useAt.get(id)).filter((at) => at !== void 0);
    const byText = message.text ? anchors.textAt.get(textKey(message)) : void 0;
    const own = byHandle ?? (byBlock.length ? Math.min(...byBlock) : byText);
    if (own !== void 0) anchor = own;
    if (anchor > target) {
      point = index;
      break;
    }
  }
  return stepPastAnswers(messages, point);
}
function stepPastAnswers(messages, start) {
  let point = start;
  while (point > 0 && point < messages.length) {
    const before = messages[point - 1];
    const at = messages[point];
    if (!before || !at) break;
    const answers = (at.toolResults || []).some((result) => (before.toolUses || []).some((use) => use.tool_use_id === result.tool_use_id));
    if (!answers) break;
    point += 1;
  }
  return point;
}
function compactionPluginsBeneath(trace) {
  return trace.filter((entry) => entry.tier !== "core" && entry.plugin !== "engine").map((entry) => entry.plugin);
}
function replacedBeneath(trace) {
  return trace.length > 0 && !trace.some((entry) => entry.tier === "core" || entry.plugin === "engine");
}
async function readLiveRefs($) {
  try {
    const home = sidequestHome(await $.env.get("SIDEQUEST_HOME"), await $.env.get("HOME"), await $.env.get("CLAUDE_CONFIG_DIR"));
    const session = await $.session.id();
    if (!home || !session) return null;
    const parsed = parseLiveRefs(await $.fs.read(liveRefsPath(home, session)));
    return parsed ? { closed: new Set(parsed.closed), pin: parsed.pin } : null;
  } catch (_) {
    return null;
  }
}
function jevEnabled(settings) {
  const enabled = settings.enabledPlugins;
  if (!enabled || typeof enabled !== "object") return false;
  return Object.entries(enabled).some(([id, on]) => on === true && (id === JEV_PLUGIN || id.startsWith(`${JEV_PLUGIN}@`)));
}
var isJev = (plugin) => plugin === JEV_PLUGIN || plugin.startsWith(`${JEV_PLUGIN}@`);
var PREPEND_NOTICE = 'sidequest compaction guard: fast-jev-compaction runs above sidequest, so its compactions can drop dispatch and briefing results. Add "sidequest@loadout" to prependPlugins in your user settings.json to seat sidequest outside it.';
function register(on, options) {
  const mode = compactionGuardMode(options?.compactionGuard);
  if (mode === "off") return;
  let pluginBeneath = mode === "on";
  let orderSettled = false;
  on("session.compact", async ($, e, next) => {
    let live;
    const liveRefs = async () => live === void 0 ? live = await readLiveRefs($) : live;
    let down = e;
    if (pluginBeneath && !String(e.instructions || "").includes(COMPACTION_RECOVERY_MARKER)) {
      const pin = (await liveRefs())?.pin;
      if (pin) down = { ...e, instructions: e.instructions ? `${e.instructions}

${pin}` : pin };
    }
    const result = await next(down);
    const trace = next.trace;
    if (compactionPluginsBeneath(trace).length) pluginBeneath = true;
    if (result.skip !== void 0 || !result.messages || !replacedBeneath(trace)) return result;
    const calls = protectedCalls(e.messages, (await liveRefs())?.closed);
    if (!calls.length) return result;
    const restored = restoreProtected(e.messages, result.messages, calls);
    if (!restored.restored.length && !restored.pointed.length) return result;
    return { ...result, messages: restored.messages };
  });
  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (orderSettled) return result;
    if (next.trace.some((entry) => isJev(entry.plugin))) {
      pluginBeneath = true;
      orderSettled = true;
      return result;
    }
    try {
      orderSettled = true;
      if (jevEnabled(await $.settings.read())) $.ui.log(PREPEND_NOTICE);
    } catch (_) {
    }
    return result;
  });
}
export {
  PER_RESULT_CAP_BYTES,
  PREPEND_NOTICE,
  TOTAL_CAP_BYTES,
  compactionPluginsBeneath,
  nonTextResult,
  protectedCalls,
  register,
  replacedBeneath,
  restoreProtected
};
