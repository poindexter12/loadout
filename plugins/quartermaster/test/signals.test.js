'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createSignalCollector, normalizeCommand, tallyFromSignals } = require('../lib/signals.js');
const { frictionOf } = require('../lib/state.js');
const { streamTranscript } = require('../lib/stream.js');

function writeTranscript(records) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-test-')), 'session.jsonl');
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n'), 'utf8');
  return file;
}

function userPrompt(text, extra = {}) {
  return { type: 'user', message: { role: 'user', content: text }, timestamp: '2026-08-01T10:00:00Z', ...extra };
}

function assistantToolUse(name, input, extra = {}) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `tool-${name}-${Math.random()}`, name, input }] },
    timestamp: '2026-08-01T10:01:00Z',
    ...extra,
  };
}

/**
 * A config dir whose installed plugins register the given hooks, so attribution is read from real
 * manifests on disk without touching the host's own install. `plugins` maps a plugin id to its
 * hooks.json `hooks` object, or to `{ manifestHooks }` for hooks named by plugin.json instead.
 */
function pluginHome(plugins = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-plugins-'));
  fs.mkdirSync(path.join(home, 'plugins'), { recursive: true });
  const registry = { version: 2, plugins: {} };
  for (const [id, hooks] of Object.entries(plugins)) {
    const installPath = path.join(home, 'plugins', 'cache', id.replace('@', '-'));
    fs.mkdirSync(path.join(installPath, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(installPath, '.claude-plugin'), { recursive: true });
    if (hooks.manifestHooks) {
      fs.writeFileSync(path.join(installPath, 'extra-hooks.json'), JSON.stringify({ hooks: hooks.manifestHooks }));
      fs.writeFileSync(path.join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: id, hooks: './extra-hooks.json' }));
    } else {
      fs.writeFileSync(path.join(installPath, 'hooks', 'hooks.json'), JSON.stringify({ hooks }));
    }
    registry.plugins[id] = [{ scope: 'user', installPath, version: '1.0.0' }];
  }
  fs.writeFileSync(path.join(home, 'plugins', 'installed_plugins.json'), JSON.stringify(registry));
  return { CLAUDE_CONFIG_DIR: home, home };
}

function commandHook(command, timeout, matcher) {
  return { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, ...(timeout ? { timeout } : {}) }] };
}

function hookTimedOut(hookName, command, durationMs, timeoutMs, extra = {}) {
  return {
    type: 'attachment',
    attachment: {
      type: 'hook_cancelled',
      hookName,
      hookEvent: hookName.split(':')[0],
      toolUseID: `hook-${Math.random()}`,
      ...(command === undefined ? {} : { command }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      timedOut: true,
      ...extra,
    },
    timestamp: '2026-08-01T10:00:00Z',
  };
}

async function collect(records, env = pluginHome()) {
  const collector = createSignalCollector({ env });
  const file = writeTranscript(records);
  await streamTranscript({ scope: 'main', file, sessionId: 'session-1' }, collector);
  return collector.finish();
}

test('counts denials with kind, tool, and target', async () => {
  const use = assistantToolUse('Bash', { command: 'npm test' });
  const toolUseId = use.message.content[0].id;
  const signals = await collect([
    use,
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'denied' }] },
      toolUseResult: 'denied',
      toolDenialKind: 'permission-rule',
      timestamp: '2026-08-01T10:02:00Z',
    },
  ]);
  assert.equal(signals.friction.denials.total, 1);
  assert.equal(signals.friction.denials.byKind['permission-rule'], 1);
  assert.equal(signals.friction.denials.byTool.Bash, 1);
  assert.equal(signals.friction.denials.targets[0].target, 'npm test');
});

test('detects corrections and interrupts from user prompts', async () => {
  const signals = await collect([
    userPrompt('please add a login page'),
    userPrompt("no, that's wrong, I said use the existing form"),
    userPrompt('[Request interrupted by user]'),
    { type: 'assistant', message: { role: 'assistant', content: [] }, isAbortedMidStream: true, timestamp: '2026-08-01T10:03:00Z' },
  ]);
  assert.equal(signals.friction.corrections.count, 1);
  assert.match(signals.friction.corrections.samples[0].quote, /existing form/);
  assert.equal(signals.friction.interrupts, 2);
});

test('meta and tool-result user records are not prompts', async () => {
  const signals = await collect([
    userPrompt('<command-name>/model</command-name>', { isMeta: true }),
    userPrompt('real prompt here'),
  ]);
  assert.equal(signals.sessions[0].prompts, 1);
});

test('aggregates attribution from tool_use records', async () => {
  const signals = await collect([
    assistantToolUse('Skill', { skill: 'map-codebase' }, { attributionPlugin: 'codebase-mapper', attributionSkill: 'map-codebase' }),
    assistantToolUse('mcp__plugin_sidequest_board__dispatch', {}),
  ]);
  assert.equal(signals.attribution.plugins['codebase-mapper'], 1);
  assert.equal(signals.attribution.skills['map-codebase'], 1);
  assert.equal(signals.attribution.mcpServers['plugin:sidequest:board'], 1);
});

test('separates hook errors and timeouts from successful context attachments', async () => {
  const signals = await collect([
    { type: 'attachment', attachment: { hookEvent: 'SubagentStart', hookName: 'SubagentStart:context', type: 'hook_additional_context' }, timestamp: '2026-08-01T10:00:00Z' },
    { type: 'attachment', attachment: { hookEvent: 'Stop', hookName: 'Stop:sidequest', timedOut: true, exitCode: 1 }, timestamp: '2026-08-01T10:00:15Z' },
    { type: 'attachment', attachment: { hookEvent: 'SessionStart', hookName: 'SessionStart:startup', exitCode: 1 }, timestamp: '2026-08-01T10:00:30Z' },
    assistantToolUse('Bash', { command: 'git   push origin main --force-with-lease' }),
    assistantToolUse('Bash', { command: 'git push' }),
    assistantToolUse('WebFetch', { url: 'https://docs.python.org/3/library/json.html' }),
  ]);
  assert.deepEqual(signals.friction.hookErrors, { 'SessionStart:startup': 1 });
  assert.equal(signals.friction.hookTimeouts.total, 1);
  assert.deepEqual(signals.friction.hookTimeouts.hooks.map((hook) => [hook.attribution, hook.hookNames]), [
    ['unrecorded', { 'Stop:sidequest': 1 }],
  ]);
  const gitPush = signals.habits.commandsTop.find((entry) => entry.name === 'git push');
  assert.equal(gitPush.count, 2);
  assert.equal(signals.habits.webFetchDomainsTop[0].name, 'docs.python.org');
});

const ENSURE = 'node --no-warnings "${CLAUDE_PLUGIN_ROOT}/lib/observability/ensure.js" --launch';
const FRESHNESS = 'node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-freshness.js"';
const REGISTRY_WRITER = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/registry-writer.js"';
const GSD_MONITOR = 'node "/Users/someone/.claude/hooks/gsd-context-monitor.js"';

test('hook timeouts keep command, duration and budget, attributed to the plugin whose manifest registers them', async () => {
  const env = pluginHome({
    'observability@loadout': { SessionStart: [commandHook(ENSURE, 1)] },
    'quartermaster@loadout': { SessionStart: [commandHook(FRESHNESS, 5)] },
  });
  const signals = await collect([
    hookTimedOut('SessionStart:startup', ENSURE, 1189, 1000),
    hookTimedOut('SessionStart:startup', ENSURE, 1025, 1000),
    hookTimedOut('SessionStart:resume', ENSURE, 1100, 1000),
    hookTimedOut('SessionStart:startup', FRESHNESS, 5025, 5000),
  ], env);

  const { total, hooks } = signals.friction.hookTimeouts;
  assert.equal(total, 4);
  assert.equal(hooks.length, 2);
  assert.deepEqual(hooks[0], {
    plugin: 'observability@loadout',
    attribution: 'plugin',
    command: ENSURE,
    hookNames: { 'SessionStart:startup': 2, 'SessionStart:resume': 1 },
    count: 3,
    sessions: 1,
    budgetsMs: [1000],
    maxDurationMs: 1189,
    medianDurationMs: 1100,
    maxOverBudgetMs: 189,
  });
  assert.equal(hooks[1].plugin, 'quartermaster@loadout');
  assert.equal(hooks[1].medianDurationMs, 5025);
  assert.equal(hooks[1].maxOverBudgetMs, 25);
});

test('a hook command two installed plugins both register is reported ambiguous, never assigned to one', async () => {
  const env = pluginHome({
    'model-gateway@loadout': { SessionStart: [commandHook(REGISTRY_WRITER, 10)] },
    'sidequest@loadout': { SessionStart: [commandHook(REGISTRY_WRITER, 10)] },
    'observability@loadout': { SessionStart: [commandHook(ENSURE, 1)] },
  });
  const signals = await collect([
    hookTimedOut('SessionStart:startup', REGISTRY_WRITER, 10400, 10000),
    hookTimedOut('SessionStart:startup', REGISTRY_WRITER, 10200, 10000),
    hookTimedOut('SessionStart:startup', ENSURE, 1189, 1000),
  ], env);

  const [shared, ensure] = signals.friction.hookTimeouts.hooks;
  assert.equal(shared.attribution, 'ambiguous');
  assert.equal(shared.plugin, null);
  assert.deepEqual(shared.candidates, ['model-gateway@loadout', 'sidequest@loadout']);
  assert.equal(shared.count, 2);
  assert.equal(shared.medianDurationMs, 10300);
  assert.equal(ensure.plugin, 'observability@loadout');
  assert.equal(ensure.candidates, undefined);
});

test('a shared hook name resolves to one plugin when the event, matcher or recorded budget rules the other out', async () => {
  const env = pluginHome({
    'model-gateway@loadout': {
      SessionStart: [commandHook(REGISTRY_WRITER, 5)],
      PreToolUse: [commandHook(REGISTRY_WRITER, 10, 'Bash|PowerShell')],
    },
    'sidequest@loadout': {
      SessionStart: [commandHook(REGISTRY_WRITER, 10)],
      PreToolUse: [commandHook(REGISTRY_WRITER, 10, 'Read')],
      Stop: [commandHook(REGISTRY_WRITER, 10)],
    },
  });
  const signals = await collect([
    // Both register it at SessionStart; only model-gateway's 5s budget matches the recorded one.
    hookTimedOut('SessionStart:startup', REGISTRY_WRITER, 5100, 5000),
    // Both register it at PreToolUse; only model-gateway's matcher admits Bash.
    hookTimedOut('PreToolUse:Bash', REGISTRY_WRITER, 10100, 10000),
    // Only sidequest registers it at Stop.
    hookTimedOut('Stop', REGISTRY_WRITER, 10050, 10000),
  ], env);

  const byPlugin = Object.fromEntries(signals.friction.hookTimeouts.hooks.map((hook) => [hook.plugin, hook]));
  assert.deepEqual(Object.keys(byPlugin).sort(), ['model-gateway@loadout', 'sidequest@loadout']);
  assert.deepEqual(byPlugin['model-gateway@loadout'].hookNames, { 'SessionStart:startup': 1, 'PreToolUse:Bash': 1 });
  assert.deepEqual(byPlugin['model-gateway@loadout'].budgetsMs, [5000, 10000]);
  assert.deepEqual(byPlugin['sidequest@loadout'].hookNames, { Stop: 1 });
});

test('hooks named by plugin.json, or recorded with the plugin root expanded, resolve to their plugin', async () => {
  const env = pluginHome({ 'quartermaster@loadout': { manifestHooks: { SessionStart: [commandHook(FRESHNESS, 5)] } } });
  const installPath = path.join(env.home, 'plugins', 'cache', 'quartermaster-loadout');
  const expanded = FRESHNESS.replace('${CLAUDE_PLUGIN_ROOT}', installPath);
  const signals = await collect([
    hookTimedOut('SessionStart:startup', FRESHNESS, 5025, 5000),
    hookTimedOut('SessionStart:startup', expanded, 5030, 5000),
  ], env);

  const hooks = signals.friction.hookTimeouts.hooks;
  assert.deepEqual(hooks.map((hook) => [hook.plugin, hook.attribution]), [
    ['quartermaster@loadout', 'plugin'],
    ['quartermaster@loadout', 'plugin'],
  ]);
});

test('hooks no installed plugin registers stay apart by command, and records without a command by name', async () => {
  const env = pluginHome({ 'observability@loadout': { SessionStart: [commandHook(ENSURE, 1)] } });
  const other = 'node "/Users/someone/.claude/hooks/gsd-path-export.js"';
  const signals = await collect([
    hookTimedOut('SessionStart:startup', GSD_MONITOR, 5109, 5000),
    hookTimedOut('SessionStart:startup', GSD_MONITOR, 5260, 5000),
    hookTimedOut('SessionStart:startup', other, 5154, 5000),
    hookTimedOut('Stop', undefined, undefined, undefined),
  ], env);

  const { total, hooks } = signals.friction.hookTimeouts;
  assert.equal(total, 4);
  assert.deepEqual(hooks.map((hook) => [hook.attribution, hook.plugin, hook.command, hook.count]), [
    ['unattributed', null, GSD_MONITOR, 2],
    ['unattributed', null, other, 1],
    ['unrecorded', null, null, 1],
  ]);
  assert.equal(hooks[0].maxOverBudgetMs, 260);
  assert.deepEqual(hooks[2].budgetsMs, []);
  assert.equal(hooks[2].maxDurationMs, null);
});

test('normalizeCommand reduces to recognizable headlines', () => {
  assert.equal(normalizeCommand('FOO=1 git commit -m "x"'), 'git commit');
  assert.equal(normalizeCommand('node scripts/build/build.js --watch'), 'node build.js');
  assert.equal(normalizeCommand('C:\\tools\\rg.exe -n pattern'), 'rg');
  assert.equal(normalizeCommand('ls -la'), 'ls');
  assert.equal(normalizeCommand(''), null);
});

test('tallyFromSignals flattens per-session counts', async () => {
  const signals = await collect([
    userPrompt('do the thing'),
    userPrompt('no, not like that'),
  ]);
  const tally = tallyFromSignals(signals);
  assert.equal(tally.prompts, 2);
  assert.equal(tally.corrections, 1);
});

test('denials are tallied per fingerprint, and finish() carries that map through to each session', async () => {
  const npmUse = assistantToolUse('Bash', { command: 'npm test -- --unit' });
  const gitUse = assistantToolUse('Bash', { command: 'git push origin main' });
  const denialOf = (use) => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.message.content[0].id, content: 'denied' }] },
    toolUseResult: 'denied',
    toolDenialKind: 'permission-rule',
    timestamp: '2026-08-01T10:02:00Z',
  });
  const signals = await collect([
    npmUse, denialOf(npmUse),
    npmUse, denialOf(npmUse),
    gitUse, denialOf(gitUse),
  ]);

  assert.deepEqual(signals.sessions[0].denialsByFingerprint, {
    'permission:Bash:npm test': 2,
    'permission:Bash:git push': 1,
  }, 'finish() must carry denialsByFingerprint into the per-session object, not drop it');

  const tally = tallyFromSignals(signals);
  assert.equal(tally.denialsByFingerprint['permission:Bash:npm test'], 2);
  assert.equal(tally.denialsByFingerprint['permission:Bash:git push'], 1);
});

test('only permission-rule denials are tallied against the fingerprint of a permission rule', async () => {
  const blocked = assistantToolUse('Bash', { command: 'npm test -- --unit' });
  const stopped = assistantToolUse('ToolSearch', { query: 'select:Read' });
  const denialOf = (use, kind) => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.message.content[0].id, content: 'denied' }] },
    toolUseResult: 'denied',
    toolDenialKind: kind,
    timestamp: '2026-08-01T10:02:00Z',
  });
  const signals = await collect([
    blocked, denialOf(blocked, 'permission-rule'),
    stopped, denialOf(stopped, 'interrupted'),
    stopped, denialOf(stopped, 'user-rejected'),
  ]);

  assert.deepEqual(signals.sessions[0].denialsByFingerprint, {
    'permission:ToolSearch': 2,
    'permission:Bash:npm test': 1,
  }, 'the total per fingerprint still counts every denial, whatever blocked the call');
  assert.deepEqual(signals.sessions[0].permissionDenialsByFingerprint, {
    'permission:Bash:npm test': 1,
  }, 'interrupted and user-rejected calls must not be attributed to a permission rule');

  const tally = tallyFromSignals(signals);
  assert.equal(tally.permissionDenialsByFingerprint['permission:Bash:npm test'], 1);
  assert.equal(tally.permissionDenialsByFingerprint['permission:ToolSearch'], undefined);
});

// Verbatim refusal text recorded by Claude Code for an Agent dispatch in a project with no
// Sidequest board, taken from a real transcript: the whole defect was this advancing the resupply
// threshold in a project the user never wanted a board in.
const UNREGISTERED_BOARD_REFUSAL = 'PreToolUse:Agent hook error: sidequest: this project is not registered on a Sidequest board, so there is no executor route. Continue bounded inline work with direct tools; do not create a fake Sidequest or raw Agent lifecycle fallback.';

test('an unregistered-project gate refusal does not advance the friction count', async () => {
  const dispatches = [0, 1, 2, 3].map(() => assistantToolUse('Agent', { description: 'do the work' }));
  const records = [];
  for (const use of dispatches) {
    records.push(use, {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: use.message.content[0].id, content: UNREGISTERED_BOARD_REFUSAL, is_error: true }],
      },
      toolUseResult: `Error: ${UNREGISTERED_BOARD_REFUSAL}`,
      toolDenialKind: 'permission-rule',
      timestamp: '2026-08-01T10:02:00Z',
    });
  }
  const signals = await collect(records);

  assert.equal(signals.friction.denials.total, 0, 'a gate that does not apply to the project is not a denial');
  assert.deepEqual(signals.friction.denials.byKind, {});
  assert.deepEqual(signals.friction.denials.byTool, {});
  assert.deepEqual(signals.friction.denials.targets, []);
  assert.equal(signals.friction.toolErrors.total, 0, 'nor is it a tool error concentrated in Agent');
  assert.equal(signals.friction.denials.notApplicable.total, 4, 'the evidence is still reported');
  assert.deepEqual(signals.friction.denials.notApplicable.byGate, { 'sidequest:unregistered-project': 4 });

  const [session] = signals.sessions;
  assert.equal(session.denials, 0);
  assert.deepEqual(session.denialsByFingerprint, {}, 'permission:Agent must not collect a fingerprint no rule can fix');
  assert.deepEqual(session.permissionDenialsByFingerprint, {});
  assert.equal(session.notApplicableRefusals, 4);

  const tally = tallyFromSignals(signals);
  assert.equal(tally.denials, 0);
  assert.equal(tally.notApplicableRefusals, 4);
  assert.equal(frictionOf(tally), 0, 'four of these must not reach the six-event resupply threshold');
});

test('a real denial still counts in a session that also hit the unregistered-project gate', async () => {
  const gated = assistantToolUse('Agent', { description: 'dispatch a ticket' });
  const blocked = assistantToolUse('Bash', { command: 'git push origin main' });
  const quoting = assistantToolUse('Bash', { command: 'npm test' });
  const signals = await collect([
    gated,
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: gated.message.content[0].id, content: UNREGISTERED_BOARD_REFUSAL, is_error: true }] },
      toolUseResult: `Error: ${UNREGISTERED_BOARD_REFUSAL}`,
      toolDenialKind: 'permission-rule',
      timestamp: '2026-08-01T10:02:00Z',
    },
    blocked,
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: blocked.message.content[0].id, content: 'denied' }] },
      toolUseResult: 'denied',
      toolDenialKind: 'permission-rule',
      timestamp: '2026-08-01T10:03:00Z',
    },
    // A failing test run whose output quotes the refusal is not a refusal: nothing denied the call,
    // so it stays an ordinary tool error.
    quoting,
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: quoting.message.content[0].id, content: `not ok 1 - expected ${UNREGISTERED_BOARD_REFUSAL}`, is_error: true }] },
      toolUseResult: 'failing suite',
      timestamp: '2026-08-01T10:04:00Z',
    },
  ]);

  assert.equal(signals.friction.denials.total, 1);
  assert.deepEqual(signals.friction.denials.byTool, { Bash: 1 });
  assert.deepEqual(signals.sessions[0].permissionDenialsByFingerprint, { 'permission:Bash:git push': 1 });
  assert.equal(signals.friction.denials.notApplicable.total, 1);
  assert.equal(signals.friction.toolErrors.total, 1, 'the quoting test failure is still a tool error');
  assert.deepEqual(signals.friction.toolErrors.byTool.map((entry) => entry.name), ['Bash']);
  assert.equal(frictionOf(tallyFromSignals(signals)), 1);
});

test('captures session purpose from title, opening ask, and area touched', async () => {
  const signals = await collect([
    { type: 'ai-title', aiTitle: 'Make the ingest pipeline reliable', sessionId: 'session-1' },
    userPrompt('The ingest job keeps dropping rows and I need it to stop.'),
    userPrompt('try the retry path'),
    assistantToolUse('Edit', { file_path: 'C:\\work\\app\\src\\ingest\\loader.py' }),
    assistantToolUse('Edit', { file_path: '/home/me/app/src/ingest/parser.py' }),
  ]);

  const [session] = signals.sessions;
  assert.equal(session.title, 'Make the ingest pipeline reliable');
  assert.match(session.openingAsk, /keeps dropping rows/);
  assert.equal(session.humanDriven, true, 'two prompts is a person, not a hook');
  assert.equal(signals.purpose.areasTop[0].name, 'src/ingest', 'area is the tail, so it matches across machines');
  assert.equal(signals.purpose.areasTop[0].count, 2);
});

test('a one-prompt session is not treated as the user own purpose', async () => {
  const signals = await collect([
    { type: 'ai-title', aiTitle: 'Review change for security issues', sessionId: 'session-1' },
    userPrompt('Review this change for security vulnerabilities.'),
    assistantToolUse('Read', { file_path: '/repo/src/api/routes.js' }),
  ]);

  const [session] = signals.sessions;
  assert.equal(session.title, 'Review change for security issues');
  assert.equal(session.humanDriven, false, 'hook-spawned sessions must be distinguishable');
});

test('goals are deduplicated and a satisfied goal counts as met', async () => {
  const condition = 'make the parser handle every real input';
  const signals = await collect([
    { type: 'queue-operation', operation: 'enqueue', content: `Goal set: ${condition}`, timestamp: '2026-08-01T10:00:00Z' },
    { type: 'attachment', attachment: { type: 'goal_status', met: false, condition }, timestamp: '2026-08-01T10:05:00Z' },
    { type: 'attachment', attachment: { type: 'goal_status', met: false, condition }, timestamp: '2026-08-01T10:09:00Z' },
    { type: 'attachment', attachment: { type: 'goal_status', met: true, condition }, timestamp: '2026-08-01T10:30:00Z' },
  ]);

  assert.equal(signals.purpose.goals.set, 1, 'one goal, not four records');
  assert.equal(signals.purpose.goals.met, 1);
  assert.equal(signals.sessions[0].goal.condition, condition);
  assert.equal(signals.sessions[0].goal.met, true);
});

test('an unmet goal stays unmet', async () => {
  const signals = await collect([
    { type: 'attachment', attachment: { type: 'goal_status', met: false, condition: 'get the build under two minutes' }, timestamp: '2026-08-01T10:05:00Z' },
  ]);

  assert.equal(signals.purpose.goals.set, 1);
  assert.equal(signals.purpose.goals.met, 0);
  assert.equal(signals.sessions[0].goal.met, false);
});

test('purpose fields stay absent rather than invented when a session has none', async () => {
  const signals = await collect([assistantToolUse('Bash', { command: 'git status' })]);
  const [session] = signals.sessions;
  assert.equal(session.title, null);
  assert.equal(session.openingAsk, null);
  assert.equal(session.goal, null);
  assert.equal(signals.purpose.goals.set, 0);
});

test('the opening ask skips harness prompts and takes the first real one', async () => {
  const signals = await collect([
    userPrompt('<command-name>/clear</command-name> <command-message>clear</command-message>'),
    userPrompt('<local-command-stdout></local-command-stdout>'),
    userPrompt('the export job silently drops duplicate rows, find out why'),
  ]);

  assert.match(signals.sessions[0].openingAsk, /export job silently drops/);
});

test('scratch space and per-session directories never rank as an area', async () => {
  const signals = await collect([
    assistantToolUse('Write', { file_path: '/tmp/claude/3f2a1c8d-4b5e-6f70-8192-a3b4c5d6e7f8/scratchpad/probe.py' }),
    assistantToolUse('Write', { file_path: '/repo/node_modules/left-pad/index.js' }),
    assistantToolUse('Edit', { file_path: '/repo/services/billing/invoice.rb' }),
  ]);

  assert.deepEqual(signals.purpose.areasTop.map((area) => area.name), ['services/billing']);
});
