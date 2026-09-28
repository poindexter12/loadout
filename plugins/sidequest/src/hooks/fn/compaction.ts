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

/**
 * True when the stored record of a result carries a content block that is not text (an image,
 * say). `text` holds only the text blocks joined, so rebuilding such a result from it would
 * hand the model less than it read.
 */
export function nonTextResult(result: ToolResultSummary): boolean {
  const record = result.result;
  const blocks = Array.isArray(record)
    ? record
    : record && typeof record === 'object' && Array.isArray((record as { content?: unknown }).content)
      ? (record as { content: unknown[] }).content
      : null;
  if (!blocks) return false;
  return blocks.some((block) => Boolean(block) && typeof block === 'object'
    && typeof (block as { type?: unknown }).type === 'string' && (block as { type: string }).type !== 'text');
}

const freshUse = (use: ToolUseSummary): ToolUseSummary => ({ tool_use_id: use.tool_use_id, tool: use.tool, input: use.input });
const freshResult = (result: ToolResultSummary): ToolResultSummary => ({ tool_use_id: result.tool_use_id, text: result.text, isError: result.isError });

export interface RestoreReport {
  messages: SessionMessage[];
  /** Protected ids whose full text went back in, in hook-built messages. */
  restored: string[];
  /** Protected ids left as the compaction had them, with a retrieval pointer. */
  pointed: string[];
  /** Protected ids with a non-text result: left exactly as the compaction had them. */
  skipped: string[];
}

/**
 * Puts back protected tool results that a replacing compaction truncated or dropped.
 *
 * Every restored block is hook-built (no `handle`): the engine persists a reinserted message of
 * its own with the parentUuid it had before the compaction boundary, which breaks the chain a
 * later --resume rebuilds, while a hook-built message is chained to the message before it. So:
 * - a result the compaction rebuilt with other text gets the original text back where it sits;
 * - a result dropped while its call was kept goes back right after that call;
 * - a call and result both dropped go back as a fresh tool_use message and tool_result message,
 *   in that order, before the first surviving message that came after them.
 * A result whose record holds non-text content is skipped (the compaction's version stays). A
 * result over `cap.perResult`, or past `cap.total` for the whole restore, stays as the
 * compaction left it, with a retrieval pointer.
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
  const messages = [...output];
  const report: RestoreReport = { messages, restored: [], pointed: [], skipped: [] };
  if (!calls.size) return report;

  const useAt = new Map<string, number>();
  const resultAt = new Map<string, number>();
  input.forEach((message, index) => {
    for (const use of message.toolUses || []) useAt.set(use.tool_use_id, index);
    for (const result of message.toolResults || []) resultAt.set(result.tool_use_id, index);
  });
  const anchors = inputAnchors(input, useAt);

  let spent = 0;
  const pointers: Array<{ call: ProtectedCall; text: string; anchor: number }> = [];

  for (const call of calls.values()) {
    const useIndex = useAt.get(call.id);
    const resultIndex = resultAt.get(call.id);
    // An unanswered call (still in flight) has nothing to lose yet.
    if (useIndex === undefined || resultIndex === undefined) continue;
    const resultMessage = input[resultIndex];
    const use = (input[useIndex]?.toolUses || []).find((entry) => entry.tool_use_id === call.id);
    const original = (resultMessage?.toolResults || []).find((result) => result.tool_use_id === call.id);
    if (!resultMessage || !use || !original) continue;

    // Intact: the engine's own result message kept by handle, or a rebuilt copy with the same text.
    const intact = messages.some((message) => (
      (message.handle !== undefined && message.handle === resultMessage.handle)
      || (message.handle === undefined && (message.toolResults || []).some((result) => (
        result.tool_use_id === call.id && result.text === original.text
      )))
    ));
    if (intact) continue;
    if (nonTextResult(original)) {
      report.skipped.push(call.id);
      continue;
    }

    const bytes = utf8Bytes(original.text);
    let reason = '';
    if (bytes > cap.perResult) reason = `over the ${cap.perResult} B per-result cap`;
    else if (spent + bytes > cap.total) reason = `past the ${cap.total} B restore budget`;
    if (reason) {
      pointers.push({ call, text: pointerText(call, bytes, reason), anchor: useIndex });
      report.pointed.push(call.id);
      continue;
    }
    spent += bytes;

    const holds = (message: SessionMessage) => (message.toolResults || []).some((result) => result.tool_use_id === call.id);
    const callAt = messages.findIndex((message) => (message.toolUses || []).some((entry) => entry.tool_use_id === call.id));
    if (callAt < 0) {
      // The call is gone: a result the compaction kept for it would be an orphan, so it goes too.
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message || message.handle !== undefined || !holds(message)) continue;
        const toolResults = (message.toolResults || []).filter((result) => result.tool_use_id !== call.id);
        if (!message.text && !(message.toolUses || []).length && !toolResults.length) messages.splice(index, 1);
        else messages[index] = { ...message, toolResults };
      }
      messages.splice(insertionPoint(messages, useIndex, anchors), 0,
        { role: 'assistant', text: '', toolUses: [freshUse(use)] },
        { role: 'user', text: '', toolUses: [], toolResults: [freshResult(original)] });
      report.restored.push(call.id);
      continue;
    }
    const holderAt = messages.findIndex((message) => message.handle === undefined && holds(message));
    const holder = holderAt >= 0 ? messages[holderAt] : undefined;
    if (holder) {
      // Truncated: the original text goes back in the slot the compaction left.
      messages[holderAt] = {
        ...holder,
        toolResults: (holder.toolResults || []).map((result) => (result.tool_use_id === call.id ? freshResult(original) : result)),
      };
    } else {
      // Dropped while the call stayed: answer the call from the message right after it, joining
      // the rebuilt results of its sibling calls there when the compaction kept any.
      const callMessage = messages[callAt];
      const after = messages[callAt + 1];
      const siblings = after !== undefined && after.handle === undefined && after.role === 'user'
        && (after.toolResults || []).some((result) => (callMessage?.toolUses || []).some((entry) => entry.tool_use_id === result.tool_use_id));
      if (after && siblings) messages[callAt + 1] = { ...after, toolResults: [...(after.toolResults || []), freshResult(original)] };
      else messages.splice(callAt + 1, 0, { role: 'user', text: '', toolUses: [], toolResults: [freshResult(original)] });
    }
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
