import './_temp-cleanup.js';
import './_hook-runtime.js';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  PER_RESULT_CAP_BYTES,
  PREPEND_NOTICE,
  TOTAL_CAP_BYTES,
  nonTextResult,
  protectedCalls,
  register,
  restoreProtected,
  type HookContext,
  type On,
  type SessionMessage,
  type TraceEntry,
} from '../src/hooks/fn/compaction.js';
import {
  COMPACTION_RECOVERY_MARKER,
  compactionGuardMode,
  liveRefsPath,
  parseLiveRefs,
  serializeLiveRefs,
  sidequestHome,
} from '../src/hooks/shared/live-refs.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-fn-compaction-test-'));
process.env.SIDEQUEST_HOME = HOME;
delete process.env.CLAUDE_PLUGIN_OPTION_COMPACTIONGUARD;

const PLUGIN = path.join(__dirname, '..');
const DISPATCH = 'mcp__plugin_sidequest_board__dispatch';
const DISPATCH_ID = 'toolu_dispatch';
const DISPATCH_TEXT = `{"ok":true,"ref":"SQ-7","spawn":{"description":"sq-7 exec","prompt":"${'x'.repeat(200)}"}}`;
const BRIEF_COMMAND = 'node "/h/.claude/sidequest/sidequest-launcher.js" briefing SQ-9 --token-file "/h/t.token"';

const CORE: TraceEntry[] = [{ index: 0, plugin: 'engine', tier: 'core', outcome: 'returned' }];
const JEV: TraceEntry = { index: 0, plugin: 'fast-jev-compaction', tier: 'user', outcome: 'returned' };
const JEV_REPLACED: TraceEntry[] = [JEV];
const JEV_FELL_BACK: TraceEntry[] = [JEV, { index: 1, plugin: 'engine', tier: 'core', outcome: 'returned' }];

function transcript(): SessionMessage[] {
  return [
    { role: 'user', text: 'start', toolUses: [], handle: 'h0' },
    { role: 'assistant', text: 'dispatching', toolUses: [{ tool_use_id: DISPATCH_ID, tool: DISPATCH, input: { ref: 'SQ-7' }, text: DISPATCH_TEXT }], handle: 'h1' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: DISPATCH_ID, text: DISPATCH_TEXT, isError: false, result: { content: [{ type: 'text', text: DISPATCH_TEXT }] } }], handle: 'h2' },
    { role: 'assistant', text: 'listing', toolUses: [{ tool_use_id: 'toolu_ls', tool: 'Bash', input: { command: 'ls' } }], handle: 'h3' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_ls', text: 'a b c', isError: false }], handle: 'h4' },
    { role: 'user', text: 'later', toolUses: [], handle: 'h5' },
  ];
}

/** What a jev-shaped replacer hands up: fresh objects, tool text cut to 12 characters. */
function rebuilt(messages: readonly SessionMessage[], drop: number[] = []): SessionMessage[] {
  return messages.filter((_, index) => !drop.includes(index)).map((message) => {
    const out: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((use) => ({ tool_use_id: use.tool_use_id, tool: use.tool, input: use.input })),
    };
    if (message.toolResults) out.toolResults = message.toolResults.map((result) => ({ tool_use_id: result.tool_use_id, text: result.text.slice(0, 12), isError: result.isError }));
    return out;
  });
}

const resultText = (messages: readonly SessionMessage[], id: string): string | undefined => messages
  .flatMap((message) => message.toolResults || []).find((result) => result.tool_use_id === id)?.text;
const holderOf = (messages: readonly SessionMessage[], id: string): number => messages
  .findIndex((message) => (message.toolResults || []).some((result) => result.tool_use_id === id));
const callerOf = (messages: readonly SessionMessage[], id: string): number => messages
  .findIndex((message) => message.toolUses.some((use) => use.tool_use_id === id));

test('protectedCalls: dispatch, Bash briefing and Agent briefing are protected; closed refs and other calls are not', () => {
  const messages: SessionMessage[] = [
    ...transcript(),
    { role: 'assistant', text: '', toolUses: [
      { tool_use_id: 'toolu_brief', tool: 'Bash', input: { command: BRIEF_COMMAND } },
      { tool_use_id: 'toolu_agent', tool: 'Agent', input: { prompt: `FIRST action: run \`${BRIEF_COMMAND}\`` } },
      { tool_use_id: 'toolu_other', tool: 'Bash', input: { command: 'node sidequest-launcher.js list' } },
    ] },
  ];
  assert.deepStrictEqual(protectedCalls(messages).map((call) => [call.id, call.kind, call.ref]), [
    [DISPATCH_ID, 'dispatch', 'SQ-7'],
    ['toolu_brief', 'briefing', 'SQ-9'],
    ['toolu_agent', 'agent', 'SQ-9'],
  ]);
  assert.deepStrictEqual(protectedCalls(messages, new Set(['SQ-9'])).map((call) => call.id), [DISPATCH_ID]);
});

test('restoreProtected: a truncated protected result gets its full text back in place, hook-built', () => {
  const input = transcript();
  const output = rebuilt(input);
  const report = restoreProtected(input, output, protectedCalls(input));
  assert.deepStrictEqual(report.restored, [DISPATCH_ID]);
  assert.strictEqual(report.messages.length, output.length);
  assert.strictEqual(resultText(report.messages, DISPATCH_ID), DISPATCH_TEXT);
  assert.strictEqual(holderOf(report.messages, DISPATCH_ID), callerOf(report.messages, DISPATCH_ID) + 1);
  assert.ok(report.messages.every((message) => message.handle === undefined));
  // Unprotected results keep what the compaction gave them.
  assert.strictEqual(resultText(report.messages, 'toolu_ls'), 'a b c');
  assert.strictEqual(resultText(output, DISPATCH_ID), DISPATCH_TEXT.slice(0, 12), 'the input list is not mutated');
});

test('restoreProtected: a dropped result whose call stayed is answered right after the call', () => {
  const input = transcript();
  const output = rebuilt(input, [2]);
  const report = restoreProtected(input, output, protectedCalls(input));
  assert.deepStrictEqual(report.restored, [DISPATCH_ID]);
  const call = callerOf(report.messages, DISPATCH_ID);
  assert.strictEqual(holderOf(report.messages, DISPATCH_ID), call + 1);
  const answer = report.messages[call + 1]!;
  assert.deepStrictEqual(answer, { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: DISPATCH_ID, text: DISPATCH_TEXT, isError: false }] });
});

test('restoreProtected: a dropped result joins the kept results of its sibling calls', () => {
  const input = transcript();
  input[1] = { ...input[1]!, toolUses: [...input[1]!.toolUses, { tool_use_id: 'toolu_sib', tool: 'Read', input: { file_path: '/x' } }] };
  input[2] = { ...input[2]!, toolResults: [...input[2]!.toolResults!, { tool_use_id: 'toolu_sib', text: 'sibling', isError: false }] };
  const output = rebuilt(input);
  output[2] = { ...output[2]!, toolResults: output[2]!.toolResults!.filter((result) => result.tool_use_id === 'toolu_sib') };
  const report = restoreProtected(input, output, protectedCalls(input));
  assert.strictEqual(report.messages.length, output.length);
  assert.deepStrictEqual(report.messages[2]!.toolResults!.map((result) => [result.tool_use_id, result.text]), [
    ['toolu_sib', 'sibling'],
    [DISPATCH_ID, DISPATCH_TEXT],
  ]);
});

test('restoreProtected: a dropped call and result go back as a fresh pair at their original position', () => {
  const input = transcript();
  const output = rebuilt(input, [1, 2]);
  const report = restoreProtected(input, output, protectedCalls(input));
  assert.deepStrictEqual(report.restored, [DISPATCH_ID]);
  assert.deepStrictEqual(report.messages.map((message) => message.text), ['start', '', '', 'listing', '', 'later']);
  assert.deepStrictEqual(report.messages[1], { role: 'assistant', text: '', toolUses: [{ tool_use_id: DISPATCH_ID, tool: DISPATCH, input: { ref: 'SQ-7' } }] });
  assert.deepStrictEqual(report.messages[2], { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: DISPATCH_ID, text: DISPATCH_TEXT, isError: false }] });
});

test('restoreProtected: a kept result whose call was dropped is not left an orphan', () => {
  const input = transcript();
  const output = rebuilt(input, [1]);
  const report = restoreProtected(input, output, protectedCalls(input));
  assert.strictEqual(report.messages.filter((message) => (message.toolResults || []).some((result) => result.tool_use_id === DISPATCH_ID)).length, 1);
  assert.strictEqual(holderOf(report.messages, DISPATCH_ID), callerOf(report.messages, DISPATCH_ID) + 1);
  assert.strictEqual(resultText(report.messages, DISPATCH_ID), DISPATCH_TEXT);
});

test('restoreProtected: an intact result, the engine object or a same-text copy, is left alone', () => {
  const input = transcript();
  const kept = [input[0]!, input[1]!, input[2]!, ...rebuilt(input).slice(3)];
  const byHandle = restoreProtected(input, kept, protectedCalls(input));
  assert.deepStrictEqual(byHandle.restored, []);
  assert.deepStrictEqual(byHandle.messages, kept);
  const copy = rebuilt(input);
  copy[2] = { ...copy[2]!, toolResults: [{ tool_use_id: DISPATCH_ID, text: DISPATCH_TEXT, isError: false }] };
  assert.deepStrictEqual(restoreProtected(input, copy, protectedCalls(input)).messages, copy);
});

test('restoreProtected: a non-text result is skipped, never degraded to its text', () => {
  const input = transcript();
  input[2] = { ...input[2]!, toolResults: [{ tool_use_id: DISPATCH_ID, text: DISPATCH_TEXT, isError: false, result: { content: [{ type: 'text', text: 'x' }, { type: 'image', source: {} }] } }] };
  assert.strictEqual(nonTextResult(input[2]!.toolResults![0]!), true);
  assert.strictEqual(nonTextResult({ tool_use_id: 'b', text: 'out', isError: false, result: { stdout: 'out' } }), false);
  for (const drop of [[], [2], [1, 2]]) {
    const output = rebuilt(input, drop);
    const report = restoreProtected(input, output, protectedCalls(input));
    assert.deepStrictEqual(report.skipped, [DISPATCH_ID]);
    assert.deepStrictEqual(report.messages, output);
  }
});

test('restoreProtected: over the per-result cap, the compaction text stays with a retrieval pointer', () => {
  assert.strictEqual(PER_RESULT_CAP_BYTES, 32 * 1024);
  assert.strictEqual(TOTAL_CAP_BYTES, 64 * 1024);
  const input = transcript();
  const output = rebuilt(input);
  const report = restoreProtected(input, output, protectedCalls(input), { perResult: 64, total: 1024 });
  assert.deepStrictEqual([report.restored, report.pointed], [[], [DISPATCH_ID]]);
  const text = resultText(report.messages, DISPATCH_ID)!;
  assert.ok(text.startsWith(DISPATCH_TEXT.slice(0, 12)));
  assert.match(text, new RegExp(`${COMPACTION_RECOVERY_MARKER}: the dispatch result for SQ-7 \\(\\d+ B\\) was not restored after compaction, over the 64 B per-result cap\\. Retrieve: ${DISPATCH} for SQ-7`));
  // Dropped outright: the pointer goes in its own message where the pair stood.
  const dropped = restoreProtected(input, rebuilt(input, [1, 2]), protectedCalls(input), { perResult: 64, total: 1024 });
  assert.match(dropped.messages[1]!.text, new RegExp(COMPACTION_RECOVERY_MARKER));
  assert.strictEqual(dropped.messages[1]!.role, 'user');
});

test('restoreProtected: past the total cap, later results get pointers and earlier ones are restored', () => {
  const input = transcript();
  input.splice(5, 0,
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'toolu_brief', tool: 'Bash', input: { command: BRIEF_COMMAND } }], handle: 'h6' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_brief', text: 'B'.repeat(300), isError: false }], handle: 'h7' });
  const bytes = Buffer.byteLength(DISPATCH_TEXT);
  const report = restoreProtected(input, rebuilt(input), protectedCalls(input), { perResult: 1024, total: bytes + 100 });
  assert.deepStrictEqual([report.restored, report.pointed], [[DISPATCH_ID], ['toolu_brief']]);
  assert.strictEqual(resultText(report.messages, DISPATCH_ID), DISPATCH_TEXT);
  assert.match(resultText(report.messages, 'toolu_brief')!, /restore budget\. Retrieve: re-run node .*briefing SQ-9/);
});

// ---- register(): the off / auto / on gate ----

type Hooks = Map<string, (...args: any[]) => Promise<any>>;

function registered(options?: Record<string, unknown>): Hooks {
  const hooks: Hooks = new Map();
  register(((event: string, hook: (...args: any[]) => Promise<any>) => { hooks.set(event, hook); }) as On, options);
  return hooks;
}

function context(files: Record<string, string> = {}, settings: Record<string, unknown> = {}) {
  const reads: string[] = [];
  const logs: string[] = [];
  const $: HookContext = {
    fs: { read: async (file) => { reads.push(file); if (file in files) return files[file]!; throw new Error('ENOENT'); } },
    env: { get: async (name) => (name === 'SIDEQUEST_HOME' ? '/sq' : name === 'HOME' ? '/home/u' : undefined) },
    session: { id: async () => 'sess-1' },
    settings: { read: async () => settings },
    ui: { log: (text) => { logs.push(text); } },
  };
  return { $, reads, logs };
}

function link<T>(result: T, trace: TraceEntry[]) {
  const seen: any[] = [];
  const next = Object.assign(async (e: unknown) => { seen.push(e); return result; }, { trace });
  return { next, seen };
}

const LIVE = { [liveRefsPath('/sq', 'sess-1')]: serializeLiveRefs('sess-1', `${COMPACTION_RECOVERY_MARKER}: PIN`, ['SQ-3']) };

test('off (the default, and any unknown value) registers nothing', () => {
  assert.strictEqual(compactionGuardMode(undefined), 'off');
  assert.strictEqual(compactionGuardMode('bogus'), 'off');
  for (const options of [undefined, {}, { compactionGuard: 'off' }, { compactionGuard: 'bogus' }]) {
    assert.strictEqual(registered(options).size, 0, JSON.stringify(options));
  }
});

test('auto without a compaction plugin beneath changes nothing and reads nothing', async () => {
  const hooks = registered({ compactionGuard: 'auto' });
  const { $, reads, logs } = context(LIVE, { enabledPlugins: {} });
  const e = { trigger: 'manual', instructions: 'keep it short', messages: transcript() };
  const coreResult = { messages: rebuilt(transcript(), [1, 2]) };
  const { next, seen } = link(coreResult, CORE);
  assert.strictEqual(await hooks.get('session.compact')!($, e, next), coreResult);
  assert.strictEqual(seen[0], e, 'the event goes down untouched: no pin');
  const turn = { id: 't' };
  const done = link(turn, CORE);
  assert.strictEqual(await hooks.get('turn.complete')!($, {}, done.next), turn);
  assert.deepStrictEqual([reads, logs], [[], []]);
  // A skip also passes straight through.
  const skip = { skip: 'nothing to compact' };
  assert.strictEqual(await hooks.get('session.compact')!($, e, link(skip, JEV_REPLACED).next), skip);
});

test('auto acts once a trace shows a plugin beneath: restore at once, pin from the next compaction', async () => {
  const hooks = registered({ compactionGuard: 'auto' });
  const { $ } = context(LIVE);
  const e = { trigger: 'auto', messages: transcript() };
  const first = link({ messages: rebuilt(transcript()) }, JEV_REPLACED);
  const result = await hooks.get('session.compact')!($, e, first.next);
  assert.strictEqual(first.seen[0], e);
  assert.strictEqual(resultText(result.messages, DISPATCH_ID), DISPATCH_TEXT);
  const second = link({ messages: rebuilt(transcript()) }, JEV_REPLACED);
  await hooks.get('session.compact')!($, e, second.next);
  assert.strictEqual(second.seen[0].instructions, `${COMPACTION_RECOVERY_MARKER}: PIN`);
});

test('auto learns jev beneath from turn.complete and pins the first compaction', async () => {
  const hooks = registered({ compactionGuard: 'auto' });
  const { $, logs } = context(LIVE, { enabledPlugins: { 'fast-jev-compaction@x': true } });
  await hooks.get('turn.complete')!($, {}, link({}, [JEV, ...CORE]).next);
  const down = link({ messages: [] }, JEV_FELL_BACK);
  await hooks.get('session.compact')!($, { trigger: 'manual', instructions: 'mine', messages: [] }, down.next);
  assert.strictEqual(down.seen[0].instructions, `mine\n\n${COMPACTION_RECOVERY_MARKER}: PIN`);
  assert.deepStrictEqual(logs, [], 'jev beneath sidequest needs no notice');
});

test('on pins even over core, skips a pin already there, and leaves a core summary untouched', async () => {
  const hooks = registered({ compactionGuard: 'on' });
  const { $ } = context(LIVE);
  const coreResult = { messages: rebuilt(transcript(), [1, 2]) };
  const pinned = link(coreResult, CORE);
  assert.strictEqual(await hooks.get('session.compact')!($, { trigger: 'manual', messages: transcript() }, pinned.next), coreResult);
  assert.strictEqual(pinned.seen[0].instructions, `${COMPACTION_RECOVERY_MARKER}: PIN`);
  const already = { trigger: 'manual', instructions: `${COMPACTION_RECOVERY_MARKER}: from PreCompact`, messages: [] };
  const twice = link({ messages: [] }, CORE);
  await hooks.get('session.compact')!($, already, twice.next);
  assert.strictEqual(twice.seen[0], already);
});

test('on restores under a replacing plugin and lets a closed ref go', async () => {
  const hooks = registered({ compactionGuard: 'on' });
  const input = transcript();
  input[1] = { ...input[1]!, toolUses: [{ ...input[1]!.toolUses[0]!, input: { ref: 'SQ-3' } }] };
  const { $ } = context(LIVE);
  const replaced = { messages: rebuilt(input) };
  const result = await hooks.get('session.compact')!($, { trigger: 'auto', messages: input }, link(replaced, JEV_REPLACED).next);
  assert.strictEqual(result, replaced, 'SQ-3 is closed on the board, so its dispatch result is not restored');
  const { $: noFile } = context();
  const open = await hooks.get('session.compact')!(noFile, { trigger: 'auto', messages: input }, link({ messages: rebuilt(input) }, JEV_REPLACED).next);
  assert.strictEqual(resultText(open.messages, DISPATCH_ID), DISPATCH_TEXT, 'with no live-refs file, protection is by pattern alone');
});

test('turn.complete suggests prependPlugins once when jev is enabled but not beneath sidequest', async () => {
  const hooks = registered({ compactionGuard: 'on' });
  const { $, logs } = context({}, { enabledPlugins: { 'fast-jev-compaction@fast-jev-compaction': true } });
  await hooks.get('turn.complete')!($, {}, link({}, CORE).next);
  await hooks.get('turn.complete')!($, {}, link({}, CORE).next);
  assert.deepStrictEqual(logs, [PREPEND_NOTICE]);
  const quiet = context({}, { enabledPlugins: {} });
  await registered({ compactionGuard: 'on' }).get('turn.complete')!(quiet.$, {}, link({}, CORE).next);
  assert.deepStrictEqual(quiet.logs, []);
});

test('live-refs: path, round trip, and a malformed file reads as absent', () => {
  assert.strictEqual(sidequestHome('/a/b/', '/home/u'), '/a/b');
  assert.strictEqual(sidequestHome(undefined, '/home/u'), '/home/u/.claude/sidequest');
  assert.strictEqual(liveRefsPath('/sq', 'a/b'), '/sq/live-refs/a%2Fb.json');
  const parsed = parseLiveRefs(serializeLiveRefs('s', 'pin', ['SQ-1'], '2026-09-28T00:00:00.000Z'));
  assert.deepStrictEqual(parsed, { version: 1, session: 's', at: '2026-09-28T00:00:00.000Z', pin: 'pin', closed: ['SQ-1'] });
  assert.strictEqual(parseLiveRefs('{"version":2,"session":"s","at":"t","pin":"p","closed":[]}'), null, 'another version reads as absent');
  assert.strictEqual(parseLiveRefs('{"version":1,"session":"s","at":"t","pin":"p","closed":"SQ-1"}'), null);
  assert.strictEqual(parseLiveRefs('not json'), null);
});

// ---- the built surfaces ----

const store = require('../lib/store.js');
const boardPath = path.join(HOME, 'board');
fs.mkdirSync(boardPath, { recursive: true });
execFileSync('git', ['init', '-b', 'main', '--quiet'], { cwd: boardPath, windowsHide: true });
const { slug } = store.ensureProject(boardPath);

function runHook(script: string, payload: unknown, env: Record<string, string | undefined>): string {
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
  for (const [key, value] of Object.entries(childEnv)) if (value === undefined) delete childEnv[key];
  return execFileSync(process.execPath, [path.join(PLUGIN, 'hooks', script)], {
    input: JSON.stringify(payload), encoding: 'utf8', env: childEnv as NodeJS.ProcessEnv, windowsHide: true,
  });
}

test('Stop writes live-refs only when compactionGuard is not off', () => {
  const closed = store.createTicket(slug, { title: 'closed one', source: 'test' });
  assert.strictEqual(store.completeTicket(slug, closed.ref, 'test-worker').ok, true);
  const transcriptPath = path.join(HOME, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, '');
  const stop = (session: string, mode: string | undefined) => runHook('stop.js', {
    session_id: session, cwd: boardPath, transcript_path: transcriptPath, last_assistant_message: 'done',
  }, { CLAUDE_PLUGIN_OPTION_COMPACTIONGUARD: mode });
  stop('stop-unset', undefined);
  stop('stop-off', 'off');
  assert.strictEqual(fs.existsSync(path.join(HOME, 'live-refs')), false, 'off touches neither the board nor the disk');
  stop('stop-auto', 'auto');
  const written = parseLiveRefs(fs.readFileSync(liveRefsPath(HOME, 'stop-auto'), 'utf8'));
  assert.ok(written && written.session === 'stop-auto');
  assert.ok(written.closed.includes(closed.ref));
});

test('PreCompact skips its pin when the instructions already carry the recovery marker', () => {
  const live = store.createTicket(slug, { title: 'live one', source: 'test' });
  assert.strictEqual(store.claimTicket(slug, live.ref, 'policy-executor').ok, true);
  const policy = (session: string, instructions: string) => runHook('compaction-policy.js', {
    hook_event_name: 'PreCompact', session_id: session, cwd: boardPath, trigger: 'manual', custom_instructions: instructions,
  }, { SIDEQUEST_COMPACTION_POLICY: undefined }).trim();
  assert.strictEqual(policy('pc-pinned', `${COMPACTION_RECOVERY_MARKER}: already here`), '');
  assert.match(policy('pc-fresh', ''), new RegExp(COMPACTION_RECOVERY_MARKER));
});

test('the built module is a neutral ESM bundle listed under hooks.json modules, and plugin.json declares the option', async () => {
  const hooksJson = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepStrictEqual(hooksJson.modules, ['./fn/compaction.js']);
  const built = path.join(PLUGIN, 'hooks', 'fn', 'compaction.js');
  const source = fs.readFileSync(built, 'utf8');
  assert.doesNotMatch(source, /\bfrom\s+["']node:|require\(|import\(["']node:/);
  const loaded = await import(pathToFileURL(built).href);
  assert.strictEqual(typeof loaded.register, 'function');
  assert.strictEqual(typeof loaded.restoreProtected, 'function');
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
  const option = manifest.userConfig.compactionGuard;
  assert.strictEqual(option.default, 'off');
  assert.deepStrictEqual([...option.options].sort(), ['auto', 'off', 'on']);
});
