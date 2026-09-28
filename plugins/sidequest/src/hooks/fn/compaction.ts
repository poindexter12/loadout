// sidequest compaction guard: a Claude Code function-hook module (hooks.json "modules").
//
// A third-party compaction plugin (fast-jev-compaction today) that answers session.compact
// itself replaces the transcript without calling core, so the classic PreCompact pin never runs
// and it may truncate or drop the dispatch and briefing results an orchestrator or executor
// still needs. Sitting above that plugin, this module puts those results back.
//
// Loaded only when CLAUDE_CODE_ENABLE_FUNCTION_HOOKS is on; the classic hooks in hooks.json run
// either way. Gated again by the `compactionGuard` plugin option (off by default). No node:*
// imports: the build bundles this file as ESM for a neutral platform, and the hooks host gives a
// module no Node. The Stop hook feeds it the board's closed refs and pin (live-refs/<session>.json).

import {
  COMPACTION_RECOVERY_MARKER,
  compactionGuardMode,
  liveRefsPath,
  parseLiveRefs,
  sidequestHome,
  type CompactionGuardMode,
} from '../shared/live-refs.js';

// The subset of the hooks API this module touches, typed locally (the host's d.ts ships with the
// engine, not with this repo).
export interface ToolUseSummary {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  result?: unknown;
  text?: string;
  isError?: true;
}

export interface ToolResultSummary {
  tool_use_id: string;
  text: string;
  isError: boolean;
  result?: unknown;
}

export interface SessionMessage {
  role: 'user' | 'assistant';
  text: string;
  toolUses: ToolUseSummary[];
  toolResults?: ToolResultSummary[];
  /** The engine's token for its own message; absent on one a hook built. */
  handle?: string;
}

export interface TraceEntry {
  readonly index: number;
  readonly plugin: string;
  readonly tier: string;
  readonly outcome: string;
}

export interface SessionCompactInput {
  trigger: 'manual' | 'auto' | 'plugin' | 'precompute';
  agentId?: string;
  instructions?: string;
  messages: readonly SessionMessage[];
}

export type SessionCompactResult =
  | { messages: readonly SessionMessage[]; tokensBefore?: number; tokensAfter?: number; skip?: undefined }
  | { skip: string; messages?: undefined };

export interface NextFn<E, O> {
  (e: E): Promise<O>;
  readonly trace: readonly TraceEntry[];
}

export interface HookContext {
  fs: { read: (path: string) => Promise<string> };
  env: { get: (name: string) => Promise<string | undefined> };
  session: { id: () => Promise<string> };
  settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  ui: { log: (text: string) => void };
}

type Hook<E, O> = ($: HookContext, e: E, next: NextFn<E, O>) => Promise<O>;
export type On = {
  (event: 'session.compact', hook: Hook<SessionCompactInput, SessionCompactResult>): void;
  (event: 'turn.complete', hook: Hook<unknown, unknown>): void;
};

export const PER_RESULT_CAP_BYTES = 32 * 1024;
export const TOTAL_CAP_BYTES = 64 * 1024;

export interface RestoreCap {
  perResult: number;
  total: number;
}

export type ProtectedKind = 'dispatch' | 'briefing' | 'agent';

export interface ProtectedCall {
  id: string;
  kind: ProtectedKind;
  /** The board ref the call names, or '' when none could be read from it. */
  ref: string;
  /** The Bash briefing command, kept for the retrieval pointer. */
  command?: string;
}

const DISPATCH_TOOL = 'mcp__plugin_sidequest_board__dispatch';
const BRIEFING = /sidequest-launcher\.js["']?\s+briefing\s+([A-Za-z][A-Za-z0-9]*-\d+)/;
const REF = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const JEV_PLUGIN = 'fast-jev-compaction';

const encoder = new TextEncoder();
const utf8Bytes = (text: string): number => encoder.encode(text).length;

/**
 * The calls whose results a compaction must not lose: board `dispatch`, the Bash briefing
 * command, and an Agent spawn whose prompt carries that command. Refs listed in `closedRefs`
 * are let go; a call whose ref cannot be read stays protected.
 */
export function protectedCalls(messages: readonly SessionMessage[], closedRefs: ReadonlySet<string> = new Set()): ProtectedCall[] {
  const calls: ProtectedCall[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const use of message.toolUses || []) {
      const input = use.input || {};
      let call: ProtectedCall | null = null;
      if (use.tool === DISPATCH_TOOL) {
        const ref = typeof input.ref === 'string' && REF.test(input.ref) ? input.ref : '';
        call = { id: use.tool_use_id, kind: 'dispatch', ref };
      } else if (use.tool === 'Bash' && typeof input.command === 'string') {
        const match = BRIEFING.exec(input.command);
        if (match) call = { id: use.tool_use_id, kind: 'briefing', ref: match[1] || '', command: input.command };
      } else if ((use.tool === 'Agent' || use.tool === 'Task') && typeof input.prompt === 'string') {
        const match = BRIEFING.exec(input.prompt);
        if (match) call = { id: use.tool_use_id, kind: 'agent', ref: match[1] || '' };
      }
      if (call && !(call.ref && closedRefs.has(call.ref))) calls.push(call);
    }
  }
  return calls;
}

function resultTexts(message: SessionMessage): string {
  return (message.toolResults || []).map((result) => result.text || '').join('');
}

function blockIds(message: SessionMessage): string[] {
  return [
    ...(message.toolUses || []).map((use) => use.tool_use_id),
    ...(message.toolResults || []).map((result) => result.tool_use_id),
  ];
}

function retrieval(call: ProtectedCall): string {
  if (call.kind === 'briefing' && call.command) {
    const command = call.command.length > 400 ? `${call.command.slice(0, 400)}...` : call.command;
    return `re-run ${command}`;
  }
  if (call.kind === 'dispatch' && call.ref) return `${DISPATCH_TOOL} for ${call.ref} returns the spawn again`;
  if (call.ref) return `mcp__plugin_sidequest_board__pulse and comments for ${call.ref}`;
  return 'the sidequest board tools';
}

function pointerText(call: ProtectedCall, bytes: number, reason: string): string {
  const what = `${call.kind} result${call.ref ? ` for ${call.ref}` : ''}`;
  return `[${COMPACTION_RECOVERY_MARKER}: the ${what} (${bytes} B) was not restored after compaction, ${reason}. Retrieve: ${retrieval(call)}.]`;
}

export interface RestoreReport {
  messages: SessionMessage[];
  /** Protected ids put back as the engine's own message pair. */
  restored: string[];
  /** Protected ids left as the compaction had them, with a retrieval pointer. */
  pointed: string[];
}

/**
 * Puts back protected tool results that a replacing compaction truncated or dropped.
 *
 * For each protected id missing from `output`, or present there with text other than the
 * engine's, the engine's own tool_use message and tool_result message from `input` go back as a
 * pair, at the place their neighbours hold in `output`. Every block of that pair is first taken
 * out of any message the compaction rebuilt, so no tool_use id appears twice and no result is
 * left without its call. A pair over `cap.perResult`, or past `cap.total` for the whole restore,
 * stays as the compaction left it, with a retrieval pointer.
 *
 * Pure: reads its arguments, returns a new message list.
 */
export function restoreProtected(
  input: readonly SessionMessage[],
  output: readonly SessionMessage[],
  protectedIds: Iterable<ProtectedCall | string>,
  cap: RestoreCap = { perResult: PER_RESULT_CAP_BYTES, total: TOTAL_CAP_BYTES },
): RestoreReport {
  const calls = new Map<string, ProtectedCall>();
  for (const entry of protectedIds) {
    const call = typeof entry === 'string' ? { id: entry, kind: 'dispatch' as const, ref: '' } : entry;
    calls.set(call.id, call);
  }
  let messages = [...output];
  const report: RestoreReport = { messages, restored: [], pointed: [] };
  if (!calls.size) return report;

  const useAt = new Map<string, number>();
  const resultAt = new Map<string, number>();
  input.forEach((message, index) => {
    for (const use of message.toolUses || []) useAt.set(use.tool_use_id, index);
    for (const result of message.toolResults || []) resultAt.set(result.tool_use_id, index);
  });
  const anchors = inputAnchors(input, useAt);

  let spent = 0;
  const done = new Set<string>();
  const pointers: Array<{ call: ProtectedCall; text: string; anchor: number }> = [];

  for (const call of calls.values()) {
    if (done.has(call.id)) continue;
    const useIndex = useAt.get(call.id);
    const resultIndex = resultAt.get(call.id);
    // An unanswered call (still in flight) has nothing to lose yet.
    if (useIndex === undefined || resultIndex === undefined) continue;
    const useMessage = input[useIndex];
    const resultMessage = input[resultIndex];
    if (!useMessage || !resultMessage) continue;
    const original = (resultMessage.toolResults || []).find((result) => result.tool_use_id === call.id);
    if (!original) continue;

    // Intact: the engine's own result message kept by handle, or a rebuilt copy with the same text.
    const intact = messages.some((message) => (
      (message.handle !== undefined && message.handle === resultMessage.handle)
      || (message.handle === undefined && (message.toolResults || []).some((result) => (
        result.tool_use_id === call.id && result.text === original.text
      )))
    ));
    if (intact) continue;

    const pairIds = new Set([...blockIds(useMessage), ...blockIds(resultMessage)]);
    for (const id of pairIds) done.add(id);
    const bytes = utf8Bytes(resultTexts(resultMessage));
    // The pair must be adjacent and self-contained, or putting it back would orphan a block.
    const adjacent = resultIndex === useIndex + 1
      && (useMessage.toolUses || []).every((use) => resultAt.get(use.tool_use_id) === resultIndex)
      && (resultMessage.toolResults || []).every((result) => useAt.get(result.tool_use_id) === useIndex);
    let reason = '';
    if (!adjacent) reason = 'its call and result are not one adjacent message pair';
    else if (bytes > cap.perResult) reason = `over the ${cap.perResult} B per-result cap`;
    else if (spent + bytes > cap.total) reason = `past the ${cap.total} B restore budget`;
    if (reason) {
      pointers.push({ call, text: pointerText(call, bytes, reason), anchor: useIndex });
      report.pointed.push(call.id);
      continue;
    }
    spent += bytes;

    // Take every block of the pair out of what the compaction handed up, noting where the first
    // of them sat: the pair goes back in that slot.
    const kept: SessionMessage[] = [];
    let slot = -1;
    for (const message of messages) {
      const own = message.handle !== undefined && (message.handle === useMessage.handle || message.handle === resultMessage.handle);
      const shares = blockIds(message).some((id) => pairIds.has(id));
      if ((own || shares) && slot < 0) slot = kept.length;
      if (own) continue;
      if (!shares) {
        kept.push(message);
      } else if (message.handle !== undefined) {
        // An engine message of another pair that shares an id cannot be split; it is dropped
        // only when all of its blocks belong to this pair.
        if (!blockIds(message).every((id) => pairIds.has(id))) kept.push(message);
      } else {
        const toolUses = (message.toolUses || []).filter((use) => !pairIds.has(use.tool_use_id));
        const toolResults = (message.toolResults || []).filter((result) => !pairIds.has(result.tool_use_id));
        if (!message.text && !toolUses.length && !toolResults.length) continue;
        const rebuilt: SessionMessage = { role: message.role, text: message.text, toolUses };
        if (message.toolResults !== undefined) rebuilt.toolResults = toolResults;
        kept.push(rebuilt);
      }
    }
    messages = kept;
    const at = slot >= 0 ? stepPastAnswers(messages, slot) : insertionPoint(messages, useIndex, anchors);
    messages.splice(at, 0, useMessage, resultMessage);
    report.restored.push(call.id);
  }

  for (const pointer of pointers) {
    const holder = messages.findIndex((message) => message.handle === undefined
      && (message.toolResults || []).some((result) => result.tool_use_id === pointer.call.id));
    const message = holder >= 0 ? messages[holder] : undefined;
    if (message) {
      messages[holder] = {
        ...message,
        toolResults: (message.toolResults || []).map((result) => (
          result.tool_use_id === pointer.call.id ? { ...result, text: `${result.text}\n${pointer.text}` } : result
        )),
      };
    } else {
      messages.splice(insertionPoint(messages, pointer.anchor, anchors), 0, { role: 'user', text: pointer.text, toolUses: [] });
    }
  }
  report.messages = messages;
  return report;
}

interface InputAnchors {
  useAt: ReadonlyMap<string, number>;
  handleAt: ReadonlyMap<string, number>;
  /** role + text of an input message with text, to its first index: places a rebuilt text-only message. */
  textAt: ReadonlyMap<string, number>;
}

const textKey = (message: SessionMessage): string => `${message.role}\u0000${message.text}`;

function inputAnchors(input: readonly SessionMessage[], useAt: ReadonlyMap<string, number>): InputAnchors {
  const handleAt = new Map<string, number>();
  const textAt = new Map<string, number>();
  input.forEach((message, index) => {
    if (message.handle) handleAt.set(message.handle, index);
    if (message.text && !textAt.has(textKey(message))) textAt.set(textKey(message), index);
  });
  return { useAt, handleAt, textAt };
}

/** Where input message `target` belongs in `messages`: before the first message that came after it. */
function insertionPoint(messages: readonly SessionMessage[], target: number, anchors: InputAnchors): number {
  let anchor = -1;
  let point = messages.length;
  for (const [index, message] of messages.entries()) {
    const byHandle = message.handle !== undefined ? anchors.handleAt.get(message.handle) : undefined;
    const byBlock = blockIds(message).map((id) => anchors.useAt.get(id)).filter((at): at is number => at !== undefined);
    const byText = message.text ? anchors.textAt.get(textKey(message)) : undefined;
    const own = byHandle ?? (byBlock.length ? Math.min(...byBlock) : byText);
    if (own !== undefined) anchor = own;
    if (anchor > target) {
      point = index;
      break;
    }
  }
  return stepPastAnswers(messages, point);
}

/** Never split a call from its result: step past a result message that answers the one before. */
function stepPastAnswers(messages: readonly SessionMessage[], start: number): number {
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

/** The links beneath that are neither the engine nor its core. */
export function compactionPluginsBeneath(trace: readonly TraceEntry[]): string[] {
  return trace.filter((entry) => entry.tier !== 'core' && entry.plugin !== 'engine').map((entry) => entry.plugin);
}

/** A compaction another link answered itself: the trace stops short of the engine. */
export function replacedBeneath(trace: readonly TraceEntry[]): boolean {
  return trace.length > 0 && !trace.some((entry) => entry.tier === 'core' || entry.plugin === 'engine');
}

async function readLiveRefs($: HookContext): Promise<{ closed: Set<string>; pin: string } | null> {
  try {
    const home = sidequestHome(await $.env.get('SIDEQUEST_HOME'), await $.env.get('HOME'));
    const session = await $.session.id();
    if (!home || !session) return null;
    const parsed = parseLiveRefs(await $.fs.read(liveRefsPath(home, session)));
    return parsed ? { closed: new Set(parsed.closed), pin: parsed.pin } : null;
  } catch (_) {
    // No Stop has run yet in this session, or the option was off then: protect by pattern alone.
    return null;
  }
}

function jevEnabled(settings: Readonly<Record<string, unknown>>): boolean {
  const enabled = settings.enabledPlugins;
  if (!enabled || typeof enabled !== 'object') return false;
  return Object.entries(enabled as Record<string, unknown>)
    .some(([id, on]) => on === true && (id === JEV_PLUGIN || id.startsWith(`${JEV_PLUGIN}@`)));
}

const isJev = (plugin: string): boolean => plugin === JEV_PLUGIN || plugin.startsWith(`${JEV_PLUGIN}@`);

export const PREPEND_NOTICE = 'sidequest compaction guard: fast-jev-compaction runs above sidequest, so its compactions can drop dispatch and briefing results. Add "sidequest@loadout" to prependPlugins in your user settings.json to seat sidequest outside it.';

/**
 * Registers the guard for one activation. A change to the plugin option reloads the plugin and
 * runs this again, so `off` can register nothing at all: no link in any chain, no reads.
 */
export function register(on: On, options?: Readonly<Record<string, unknown>>): void {
  const mode: CompactionGuardMode = compactionGuardMode(options?.compactionGuard);
  if (mode === 'off') return;

  // `auto` learns from a compaction trace whether a plugin beneath answers compactions; only
  // then does it add the pin on the way down. `on` always does.
  let pluginBeneath = mode === 'on';
  let orderSettled = false;

  on('session.compact', async ($, e, next) => {
    let live: Awaited<ReturnType<typeof readLiveRefs>> | undefined;
    const liveRefs = async () => (live === undefined ? (live = await readLiveRefs($)) : live);
    let down = e;
    if (pluginBeneath && !String(e.instructions || '').includes(COMPACTION_RECOVERY_MARKER)) {
      const pin = (await liveRefs())?.pin;
      if (pin) down = { ...e, instructions: e.instructions ? `${e.instructions}\n\n${pin}` : pin };
    }
    const result = await next(down);
    const trace = next.trace;
    if (compactionPluginsBeneath(trace).length) pluginBeneath = true;
    if (result.skip !== undefined || !result.messages || !replacedBeneath(trace)) return result;
    const calls = protectedCalls(e.messages, (await liveRefs())?.closed);
    if (!calls.length) return result;
    const restored = restoreProtected(e.messages, result.messages, calls);
    if (!restored.restored.length && !restored.pointed.length) return result;
    return { ...result, messages: restored.messages };
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (orderSettled) return result;
    if (next.trace.some((entry) => isJev(entry.plugin))) {
      // jev sits beneath: `auto` can pin from the first compaction instead of the second.
      pluginBeneath = true;
      orderSettled = true;
      return result;
    }
    try {
      orderSettled = true;
      if (jevEnabled(await $.settings.read())) $.ui.log(PREPEND_NOTICE);
    } catch (_) {
      /* Settings unreadable: say nothing rather than guess. */
    }
    return result;
  });
}
