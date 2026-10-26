'use strict';
// SQ-137: one topic shard of the former hooks.test.ts, split so the runner can spread its tests
// across workers. Shared setup and helpers live in ./_hooks-fixture.ts; the tests are moved unchanged.
import {
  test,
  assert,
  os,
  fs,
  path,
  crypto,
  spawn,
  SIDEQUEST_HOME,
  store,
  worktrees,
  WORKTREE_CREATE_HOOK_TIMEOUT_SECONDS,
  db,
  BOARD_PATH,
  slug,
  database,
  HOOKS,
  SESSION,
  FORCE_BYPASS,
  SUBAGENT_START,
  SUBAGENT_STOP,
  GUARD_WORKTREE_ISOLATION,
  STOP,
  POST_COMPACT,
  BUDGET,
  RETIRED_SCOUT,
  runHookOutput,
  runHookWithFailureDetails,
  runHookProcessForBudget,
  hostContinuationCount,
  runHook,
  runHookForBudget,
  registerProject,
  gitFixture,
  completeCheckoutCreation,
  preparedPrompt,
  fixtureTicket,
  runForceBypassWithEnv,
  addTicket,
  addStopTicket,
  addEffortTicket,
  claimStopTicket,
  recordTerminalAgentFailure,
  backdateSessionClaims,
  sq303Repo,
  fixtureState,
  type HookProcessResult,
} from './_hooks-fixture.js';

// SQ-56: the warning embeds the checkout's own worktree roots verbatim, and that path is unbounded (it
// grows with checkout depth, e.g. nested full-suite temp dirs). Tail truncation in projectedText() used to
// delete exactly the two sentences that change what the receiving agent does whenever that path pushed the
// message over the SubagentStart budget -- a checkout past ~75 characters lost them silently, and the only
// signal was an environment-dependent test failure under nested CI temp dirs (path-length dependent, so it
// read as flaky noise rather than a real defect). Pin the invariant directly against a deliberately deep
// checkout path instead of asserting on a string that only happens to fit at a short mkdtemp path.
test('subagent-start keeps the actionable diagnostic-worktree sentences at any checkout path length', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-diagnostic-worktrees-deep-'));
  // Well past the ~75-char root that used to trip truncation, and past the ~107-char nested full-suite
  // temp dir that reproduced the real CI failure.
  const repo = path.join(base, 'nested-segment-'.repeat(4), 'sq-hooks-test-deep-checkout', 'repo');
  fs.mkdirSync(repo, { recursive: true });
  gitFixture(['init', '-b', 'main'], repo);
  const worktrees = path.join(repo, '.claude', 'worktrees');
  const current = path.join(worktrees, 'agent-current');
  fs.mkdirSync(current, { recursive: true });
  fs.writeFileSync(path.join(current, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'agent-current')}\n`);
  fs.mkdirSync(path.join(worktrees, 'agent-foreign'));
  const payload = {
    session_id: 'diagnostic-worktree-warning-deep',
    agent_type: 'sidequest-exec-dispatch',
    agent_id: 'diagnostic-worktree-agent-deep',
    cwd: current,
  };

  const warning = runHook(SUBAGENT_START, payload);
  assert.ok(Buffer.byteLength(warning, 'utf8') <= 512, 'the projected warning must respect the SubagentStart budget');
  assert.match(warning, /content omitted/, 'this checkout path is deliberately deep enough to overflow the budget');
  assert.match(warning, /1 foreign agent worktree in play/);
  assert.match(warning, /Keep error-severity diagnostics in your own files actionable\./, 'the actionable trailer must survive truncation regardless of checkout path length');
});

test('combined Stop hook gives actionable reconciliation priority over a compaction suggestion', () => {
  const sessionId = `combined-stop-${++fixtureState.sqSeq}`;
  const transcript = path.join(SIDEQUEST_HOME, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, '[]');
  runHookOutput(POST_COMPACT, { session_id: sessionId, transcript_path: transcript });

  const submitted = addTicket('combined stop submission');
  claimStopTicket(submitted, sessionId, 'combined-stop-executor');
  assert.equal(store.submitTicket(slug, submitted.ref, 'combined-stop-executor', {
    commit: 'abcdef0',
    sessionId,
  }).ok, true);
  for (const title of ['combined compact one', 'combined compact two', 'combined compact three']) {
    const ticket = addTicket(title);
    assert.equal(store.completeTicket(slug, ticket.ref, 'test-worker').ok, true);
  }

  const input = { session_id: sessionId, cwd: BOARD_PATH, transcript_path: transcript };
  const output = runHookOutput(STOP, input);
  assert.match(output.hookSpecificOutput.additionalContext, /Integrate pending submissions now\./);
  assert.equal(output.systemMessage, undefined, 'one Stop response cannot schedule a second model wake');
  assert.equal(runHookOutput(STOP, { ...input, stop_hook_active: true }), null);
});

test('four concurrent Stop hooks preserve independent responsibilities in one host continuation', async (t?: any) => {
  const sessionId = `stop-cascade-${++fixtureState.sqSeq}`;
  const firstSubmission = addTicket('runtime-shaped Stop cascade');
  claimStopTicket(firstSubmission, sessionId, 'stop-cascade-worker');
  assert.equal(store.submitTicket(slug, firstSubmission.ref, 'stop-cascade-worker', {
    commit: 'abc1234',
    sessionId,
  }).ok, true);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-cascade-hooks-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const securityHook = path.join(directory, 'security-guidance.js');
  fs.writeFileSync(securityHook, [
    "const fs = require('node:fs');",
    "const input = JSON.parse(fs.readFileSync(0, 'utf8'));",
    "if (input.stop_hook_active) process.exit(0);",
    "if (process.env.SECURITY_FIXTURE_FAIL === '1') process.exit(1);",
    "process.stderr.write('security review feedback');",
    "process.stdout.write(JSON.stringify({ decision: 'block', reason: 'security review feedback' }));",
    'process.exit(2);',
  ].join('\n'));
  const mapperHook = path.join(__dirname, '..', '..', 'codebase-mapper', 'hooks', 'inject-context.js');
  const observerHook = path.join(__dirname, '..', '..', 'observability', 'hooks', 'observability.js');
  const observerSpool = path.join(directory, 'hook-spool.jsonl');
  const mapperState = path.join(directory, 'mapper-state');
  const payload = {
    hook_event_name: 'Stop',
    session_id: sessionId,
    cwd: BOARD_PATH,
    stop_hook_active: false,
    last_assistant_message: 'Documentation check complete. Running /codebase-mapper:update-codebase-map to update documentation.',
  };
  const hooks = [
    {
      script: STOP,
      env: { SIDEQUEST_HOME, CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..') },
    },
    {
      script: mapperHook,
      env: { CODEBASE_MAPPER_STATE_DIR: mapperState },
    },
    { script: observerHook, env: { OBSERVABILITY_HOOK_SPOOL: observerSpool } },
    { script: securityHook, env: {}, asyncRewake: true },
  ];
  const runAll = (input?: any, securityEnv?: any) => Promise.all(hooks.map((hook?: any) => runHookProcessForBudget(
    hook.script,
    input,
    { ...hook.env, ...(hook.asyncRewake ? securityEnv : {}) },
  )));
  const actionableOutputs = (results: HookProcessResult[]) => results.slice(0, 2)
    .map((result) => result.stdout.trim() ? JSON.parse(result.stdout) : null)
    .filter(Boolean);

  const first = await runAll(payload);
  assert.equal(hostContinuationCount(first, hooks), 1, 'Claude batches all synchronous blockers into one continuation');
  assert.equal(actionableOutputs(first).length, 2, 'Sidequest and mapper must both preserve distinct responsibilities');
  assert.match(actionableOutputs(first)[0]?.hookSpecificOutput?.additionalContext, /Integrate pending submissions now/);
  assert.match(actionableOutputs(first)[1]?.reason, /update-codebase-map now/);
  assert.ok(Buffer.byteLength(actionableOutputs(first)[0].hookSpecificOutput.additionalContext) <= BUDGET.reconciliation);
  assert.ok(Buffer.byteLength(actionableOutputs(first)[1].reason) <= 192);
  assert.equal(first[3]!.status, 2, 'official asynchronous security guidance coexists with the host continuation');
  assert.equal(fs.readFileSync(observerSpool, 'utf8').trim().split('\n').length, 1);

  for (let repeatedStop = 0; repeatedStop < 3; repeatedStop += 1) {
    const repeated = await runAll(payload);
    assert.equal(hostContinuationCount(repeated, hooks), 0, 'unchanged responsibilities stay silent independently');
    assert.equal(actionableOutputs(repeated).length, 0);
  }
  assert.equal(fs.readFileSync(observerSpool, 'utf8').trim().split('\n').length, 4);

  const reentry = await runAll({ ...payload, stop_hook_active: true });
  assert.equal(hostContinuationCount(reentry, hooks), 0);
  assert.equal(fs.readFileSync(observerSpool, 'utf8').trim().split('\n').length, 4);

  runHookOutput(mapperHook, {
    ...payload,
    hook_event_name: 'PreToolUse',
    tool_name: 'Skill',
    tool_input: { skill: 'codebase-mapper:update-codebase-map' },
  }, { CODEBASE_MAPPER_STATE_DIR: mapperState });
  const completedUpdate = await runAll(payload);
  assert.equal(hostContinuationCount(completedUpdate, hooks), 0, 'the completed map update consumes its prompt-less invocation record');
  assert.equal(actionableOutputs(completedUpdate).length, 0);
  const secondSubmission = addTicket('second runtime-shaped responsibility');
  claimStopTicket(secondSubmission, sessionId, 'stop-cascade-worker-two');
  assert.equal(store.submitTicket(slug, secondSubmission.ref, 'stop-cascade-worker-two', {
    commit: 'def5678',
    sessionId,
  }).ok, true);
  const failedSecurity = await runAll(payload, { SECURITY_FIXTURE_FAIL: '1' });
  assert.equal(failedSecurity[3]!.status, 1);
  assert.equal(hostContinuationCount(failedSecurity, hooks), 1, 'the host gets one continuation for both transitions');
  assert.equal(actionableOutputs(failedSecurity).length, 2, 'neither transitioned responsibility can suppress the other');
});

test('ticket filing stays explicit while the Agent gate enforces dispatch and docs match it', () => {
  const pluginRoot = path.join(__dirname, '..');
  const repoRoot = path.join(pluginRoot, '..', '..');
  const references = [
    path.join(repoRoot, 'README.md'),
    path.join(pluginRoot, 'README.md'),
    path.join(pluginRoot, 'bin', 'sidequest.js'),
    path.join(HOOKS, 'session-start.js'),
    path.join(pluginRoot, 'skills', 'sidequest', 'SKILL.md'),
  ];

  assert.ok(!fs.existsSync(path.join(pluginRoot, 'agents', 'ticket-filer.md')));
  assert.ok(!fs.existsSync(path.join(HOOKS, 'capture-nudge.js')));
  for (const file of references) {
    assert.ok(!fs.readFileSync(file, 'utf8').includes('ticket-filer'), `${file} must not reference ticket-filer`);
  }

  const config = JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8'));
  assert.match(config.description, /Stop reconciliation atomically emits one <=360 B item per responsibility transition/);
  assert.match(config.description, /from the current project's tickets/);
  assert.match(config.description, /generation-bound stale-lock cleanup cannot delete a live replacement/);
  assert.match(config.description, /claim generations distinguish reopened work/);
  assert.match(config.description, /Claude batches it with concurrent blocking hooks into one continuation/);
  assert.match(config.description, /unchanged board revisions and stop_hook_active re-entry stay silent/);
  assert.ok(config.hooks.WorktreeCreate.some((entry?: any) => entry.hooks
    .some((hook?: any) => hook.command.includes('worktree-create.js'))), 'isolated worktrees must use the external placement hook');
  const worktreeCreateHook = config.hooks.WorktreeCreate.flatMap((entry?: any) => entry.hooks || [])
    .find((hook?: any) => hook.command.includes('worktree-create.js'));
  assert.equal(worktreeCreateHook.timeout, WORKTREE_CREATE_HOOK_TIMEOUT_SECONDS, 'the hook deadline and manifest timeout must stay aligned');
  assert.ok(config.hooks.UserPromptSubmit.some((entry?: any) => entry.hooks
    .some((hook?: any) => hook.command.includes('board-first-reminder.js'))), 'the board-first reminder must run for user prompts');
  const stopCommands = config.hooks.Stop.flatMap((entry?: any) => entry.hooks || [])
    .filter((hook?: any) => hook.type === 'command');
  assert.equal(stopCommands.length, 1, 'Stop must launch one Sidequest handler');
  assert.match(stopCommands[0].command, /stop\.js/);
  assert.doesNotMatch(stopCommands[0].command, /compaction-suggestion|board-reconciliation-reminder/);
  assert.doesNotMatch(JSON.stringify(config), /capture-nudge|ticket-filer/);
  assert.ok(config.hooks.PreToolUse.some((entry?: any) => entry.matcher === '*'
    && entry.hooks.some((hook?: any) => hook.command.includes('inline-work-nudge.js'))), 'the inline-work reminder must be registered for every tool');
  assert.ok(config.hooks.PreToolUse.some((entry?: any) => entry.matcher === 'Agent'
    && entry.hooks.some((hook?: any) => hook.command.includes('force-exec-bypass.js'))), 'the Agent gate must be registered');
  assert.ok(config.hooks.PreToolUse.some((entry?: any) => entry.matcher === 'mcp__plugin_sidequest_board__dispatch'
    && entry.hooks.some((hook?: any) => hook.command.includes('force-exec-bypass.js'))), 'the own-dispatch guard must cover the dispatch MCP tool');
  assert.ok(config.hooks.PreToolUse.some((entry?: any) => entry.matcher === 'mcp__plugin_sidequest_board__update'
    && entry.hooks.some((hook?: any) => hook.command.includes('force-exec-bypass.js'))), 'the closeout update guard must cover the update MCP tool');
  assert.ok(config.hooks.PreToolUse.some((entry?: any) => entry.matcher === 'Bash|PowerShell'
    && entry.hooks.some((hook?: any) => hook.command.includes('force-exec-bypass.js'))), 'the own-dispatch guard must cover Sidequest CLI commands');
  assert.ok(!config.hooks.PreToolUse.some((entry?: any) => entry.matcher === 'Skill'), 'the oversized Skill guard stays removed: its one activation cost a turn and prevented nothing');
  assert.ok(config.hooks.PreToolUse.some((entry?: any) => entry.matcher === 'Edit|Write|MultiEdit|NotebookEdit'
    && entry.hooks.some((hook?: any) => hook.command.includes('force-exec-bypass.js'))), 'the helper write guard must be registered');
  assert.ok(config.hooks.PreToolUse.some((entry?: any) => entry.matcher === 'TaskOutput'
    && entry.hooks.some((hook?: any) => hook.command.includes('guard-task-output.js'))), 'the TaskOutput guard must be registered');
  assert.ok(config.hooks.PreToolUse.some((entry?: any) => entry.matcher === 'Bash|PowerShell'
    && entry.hooks.some((hook?: any) => hook.command.includes('repeated-command-warn.js'))), 'the repeated-command warning must run for shell commands');
  // SQ-224: a pattern-selected kill reaches every worktree on the host, so the guard has to see
  // PowerShell too, and the description is what tells an agent the guard exists at all.
  assert.ok(config.hooks.PreToolUse.some((entry?: any) => entry.matcher === 'Bash|PowerShell'
    && entry.hooks.some((hook?: any) => hook.command.includes('guard-process-signal.js'))), 'the cross-worktree signal guard must run for shell commands');
  assert.match(config.description, /pattern-selected process signal that would reach a sibling executor's run in another worktree is denied/);
  assert.equal(config.hooks.TeammateIdle, undefined, 'terminal executors must not be woken');

  const readme = fs.readFileSync(path.join(pluginRoot, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /per-prompt "use sidequest" reminder/);
  assert.doesNotMatch(readme, /marker-triggered capture/);
  assert.doesNotMatch(readme, /native_agent/);
  for (const file of [
    path.join(pluginRoot, 'README.md'),
    path.join(HOOKS, 'force-exec-bypass.js'),
    path.join(HOOKS, 'session-start.js'),
    path.join(pluginRoot, 'skills', 'sidequest', 'SKILL.md'),
    path.join(pluginRoot, 'skills', 'sidequest', 'references', 'orchestration.md'),
  ]) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), new RegExp(RETIRED_SCOUT), `${file} must not carry the retired bypass`);
  }
});

test('subagent-stop: a terminal Agent failure preserves recovery evidence without a TaskStop instruction', () => {
  const sess = `sess-long-${++fixtureState.sqSeq}`;
  const t = addTicket('terminal release ticket');
  const stop = claimStopTicket(t, sess, 'worker-long');
  backdateSessionClaims(sess, 28);
  assert.equal(recordTerminalAgentFailure(t, stop).ok, true);
  const context = runHookForBudget(SUBAGENT_STOP, stop);
  assert.match(context, new RegExp(`^exec FINISHED after terminal died: ${t.ref}\\. Preserve recovery evidence before a replacement\\.`));
  assert.doesNotMatch(context, /TaskStop/, 'SQ-183: a terminal SubagentStop verdict must not tell the orchestrator to TaskStop an executor');
  assert.equal(store.getTicket(slug, t.ref).claim, null);
  assert.equal(store.getTicket(slug, t.ref).dispatch.outcome, 'died');
  assert.ok(store.getTicket(slug, t.ref).dispatch.terminalAt);
});

test('subagent-stop: a held claim is classified regardless of claimed effort', () => {
  const tiers = ['low', 'medium', 'high', 'xhigh'];

  for (const effort of tiers) {
    const session = `sess-${effort}-${++fixtureState.sqSeq}`;
    const ticket = addEffortTicket(`${effort} stopped claim`, effort);
    const stop = claimStopTicket(ticket, session, `worker-${effort}`);
    const ctx = runHook(SUBAGENT_STOP, stop);
    assert.match(ctx, new RegExp(`^exec WAITING: ${ticket.ref} ended a turn while holding its claim; it may resume\.`));
  }
});

test('subagent-stop: stop_hook_active suppresses the note (no self-continuation loop)', () => {
  const sess = `sess-active-${++fixtureState.sqSeq}`;
  const t = addTicket('over-threshold ticket, but re-entrant fire');
  store.updateTicket(slug, t.ref, { labels: ['direct-ok'] });
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-active', { direct: true, reason: 'The re-entrant hook fixture needs a direct claim.', sessionId: sess }).ok, true);
  backdateSessionClaims(sess, 28);
  assert.strictEqual(
    runHook(SUBAGENT_STOP, { session_id: sess, stop_hook_active: true }),
    '',
    'a fire carrying stop_hook_active is our own continuation and must never re-emit'
  );
});

test('subagent-stop: a non-executor child (reviewer) is not nagged about a session claim', () => {
  const sess = `sess-reviewer-${++fixtureState.sqSeq}`;
  const t = addTicket('over-threshold executor claim, unrelated reviewer stops');
  const stop = claimStopTicket(t, sess, 'worker-rev');
  backdateSessionClaims(sess, 28);
  assert.strictEqual(
    runHook(SUBAGENT_STOP, { session_id: sess, agent_type: 'code-reviewer' }),
    '',
    'a reviewer shares the session id but never held the claim — it must stay silent'
  );
  // The same over-threshold claim still surfaces for the actual executor child.
  const ctx = runHook(SUBAGENT_STOP, stop);
  assert.ok(ctx.includes(t.ref), 'a sidequest executor child must still get the note');
});

test('subagent-stop: a repeated stop repeats the held-claim verdict until release', () => {
  const sess = `sess-dedupe-${++fixtureState.sqSeq}`;
  const t = addTicket('over-threshold claim reports every stop');
  const stop = claimStopTicket(t, sess, 'worker-dedupe');
  backdateSessionClaims(sess, 28);
  const expected = runHook(SUBAGENT_STOP, stop);
  assert.match(expected, new RegExp(`^exec WAITING: ${t.ref} ended a turn while holding its claim; it may resume\.`));
  assert.strictEqual(runHook(SUBAGENT_STOP, stop), expected);
});

test('subagent-stop: a stopped executor holding a fresh claim remains resumable', () => {
  const sess = `sess-fresh-${++fixtureState.sqSeq}`;
  const t = addTicket('quick ticket, just claimed');
  const stop = claimStopTicket(t, sess, 'worker-fresh');
  const ctx = runHook(SUBAGENT_STOP, stop);
  assert.match(ctx, new RegExp(`^exec WAITING: ${t.ref} ended a turn while holding its claim; it may resume\.`));
});

test('subagent-stop: a terminal release preserves board closeout without a TaskStop instruction', () => {
  const sess = `sess-released-${++fixtureState.sqSeq}`;
  const t = addStopTicket('released ticket with a monitor still armed');
  const stop = claimStopTicket(t, sess, 'worker-released');
  assert.strictEqual(store.releaseTicket(slug, t.ref, 'worker-released', { status: 'todo' }).ok, true);
  const context = runHook(SUBAGENT_STOP, stop);
  assert.match(context, new RegExp(`^exec FINISHED after terminal release: ${t.ref}\\. The terminal board state is authoritative; do not redispatch or investigate a contradictory task notification\\.`));
  assert.doesNotMatch(context, /TaskStop/, 'SQ-183: a terminal SubagentStop verdict must not tell the orchestrator to TaskStop an executor');
});

test('subagent-stop: a failed-before-claim attempt carries no TaskStop instruction', () => {
  const sessionId = `failed-before-claim-${++fixtureState.sqSeq}`;
  const ticket = addEffortTicket('failed before claim ticket', 'high');
  const prepared = store.prepareDispatch(slug, ticket.ref, { allowUnscoped: true, sessionId });
  const agentName = `failed-before-claim-agent-${ticket.id}`;
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName,
  }).ok, true);

  const context = runHook(SUBAGENT_STOP, {
    session_id: sessionId,
    agent_type: prepared.ticket.dispatchExecutor,
    agent_id: `failed-before-claim-id-${ticket.id}`,
    agent_name: agentName,
  });
  assert.match(context, new RegExp(`^exec FINISHED after terminal failed: ${ticket.ref}\\.`));
  assert.doesNotMatch(context, /TaskStop/, 'SQ-183: a terminal SubagentStop verdict must not tell the orchestrator to TaskStop an executor');
});

test('subagent-stop: a superseded unclaimed attempt carries no TaskStop instruction', () => {
  const sessionId = `superseded-attempt-${++fixtureState.sqSeq}`;
  const ticket = addEffortTicket('superseded unclaimed attempt', 'high');
  const prepared = store.prepareDispatch(slug, ticket.ref, { allowUnscoped: true, sessionId });
  const agentName = `superseded-attempt-agent-${ticket.id}`;
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName,
  }).ok, true);
  assert.doesNotThrow(() => store.prepareDispatch(slug, ticket.ref, {
    allowUnscoped: true,
    sessionId: `superseded-replacement-${ticket.id}`,
    recoveryEvidence: 'Observed terminal launch failure before the claim.',
    source: 'test',
  }));

  const context = runHook(SUBAGENT_STOP, {
    session_id: sessionId,
    agent_type: prepared.ticket.dispatchExecutor,
    agent_id: `superseded-attempt-id-${ticket.id}`,
    agent_name: agentName,
  });
  assert.match(context, new RegExp(`^exec FINISHED after superseded terminal failed: ${ticket.ref}\\.`));
  assert.doesNotMatch(context, /TaskStop/, 'SQ-183: a terminal SubagentStop verdict must not tell the orchestrator to TaskStop an executor');
});

test('subagent-stop: completed board closeout overrides a contradictory task notification', () => {
  const sess = `sess-completed-${++fixtureState.sqSeq}`;
  const t = addStopTicket('completed ticket with commit note', { files: ['lib/fixture.js'] });
  const stop = claimStopTicket(t, sess, 'worker-completed');
  assert.strictEqual(store.addComment(slug, t.ref, { by: 'worker-completed', kind: 'comment', body: 'Shipped abc1234.', source: 'cli' }).ok, true);
  assert.strictEqual(store.releaseTicket(slug, t.ref, 'worker-completed', { status: 'todo' }).ok, true);
  assert.strictEqual(store.closeTicketForGrooming(slug, t.ref, { by: 'hook-test-groomer', reason: 'Shipped abc1234.' }).ok, true);
  const context = runHook(SUBAGENT_STOP, stop);
  assert.match(context, new RegExp(`^exec FINISHED: ${t.ref} done \\(abc1234\\); review the recorded board result\\.`));
  assert.doesNotMatch(context, /TaskStop/, 'SQ-183: a terminal SubagentStop verdict must not tell the orchestrator to TaskStop an executor');
});

test('subagent-stop: completed board closeout without a hash still overrides task state', () => {
  const sess = `sess-no-hash-${++fixtureState.sqSeq}`;
  const t = addStopTicket('completed ticket without commit note', { files: ['lib/fixture.js'] });
  const stop = claimStopTicket(t, sess, 'worker-no-hash');
  assert.strictEqual(store.addComment(slug, t.ref, { by: 'worker-no-hash', kind: 'comment', body: 'Done and verified.', source: 'cli' }).ok, true);
  assert.strictEqual(store.releaseTicket(slug, t.ref, 'worker-no-hash', { status: 'todo' }).ok, true);
  assert.strictEqual(store.closeTicketForGrooming(slug, t.ref, { by: 'hook-test-groomer', reason: 'Done and verified.' }).ok, true);
  const context = runHook(SUBAGENT_STOP, stop);
  assert.match(context, new RegExp(`^exec FINISHED: ${t.ref} done WITHOUT commit hash; review the recorded board result\\.`));
  assert.doesNotMatch(context, /TaskStop/, 'SQ-183: a terminal SubagentStop verdict must not tell the orchestrator to TaskStop an executor');
});

test('subagent-stop: a legacy partial submission is not reported ready for integration', () => {
  const sess = `sess-partial-${++fixtureState.sqSeq}`;
  const t = addStopTicket('partial submission awaiting scope', { files: ['docs/'] });
  const stop = claimStopTicket(t, sess, 'worker-partial');
  assert.strictEqual(store.submitTicket(slug, t.ref, 'worker-partial', { commit: 'abc1234def5678abc1234def5678abc1234def56' }).ok, true);
  const partial = store.getTicket(slug, t.ref);
  partial.submission.unscopedPaths = ['plugins/model-gateway/bin/model-gateway.js'];
  db.putRow(database, 'tickets', {
    id: partial.id, project: slug, ref: partial.ref, status: partial.status,
    archived: partial.archived ? 1 : 0, ord: partial.order, claim_by: null, data: partial,
  });
  const context = runHook(SUBAGENT_STOP, stop);
  assert.match(context, new RegExp(`^exec FINISHED with PARTIAL_SUBMISSION: ${t.ref} has scope-gated paths \\(plugins/model-gateway/bin/model-gateway\\.js\\); do not integrate it`));
  assert.doesNotMatch(context, /TaskStop/, 'SQ-183: a terminal SubagentStop verdict must not tell the orchestrator to TaskStop an executor');
});

test('subagent-stop: submitted board state overrides a contradictory task notification', () => {
  const sess = `sess-submitted-${++fixtureState.sqSeq}`;
  const t = addStopTicket('submitted ticket awaiting the publish transaction', { files: ['lib/fixture.js'] });
  const stop = claimStopTicket(t, sess, 'worker-submitted');
  assert.strictEqual(store.submitTicket(slug, t.ref, 'worker-submitted', { commit: 'abc1234def5678abc1234def5678abc1234def56' }).ok, true);
  const context = runHook(SUBAGENT_STOP, stop);
  assert.match(context, new RegExp(`^exec FINISHED: ${t.ref} READY_FOR_INTEGRATION \\(abc1234def56\\); run the publish transaction \\(references/publishing\\.md\\)\\.`));
  assert.doesNotMatch(context, /TaskStop/, 'SQ-183: a terminal SubagentStop verdict must not tell the orchestrator to TaskStop an executor');
});

test('subagent-stop: a prior owner is silent after another worker reclaims the ticket', () => {
  const sess = `sess-prior-owner-${++fixtureState.sqSeq}`;
  const t = addTicket('reclaimed ticket with stale prior owner entry');
  const stop = claimStopTicket(t, sess, 'worker-prior');
  backdateSessionClaims(sess, 28);
  assert.strictEqual(store.releaseTicket(slug, t.ref, 'worker-prior', {}).ok, true);
  store.updateTicket(slug, t.ref, { labels: ['direct-ok'] });
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-current', { direct: true, reason: 'The prior-owner fixture needs a direct reclaim.', sessionId: `sess-current-${fixtureState.sqSeq}` }).ok, true);

  assert.strictEqual(runHook(SUBAGENT_STOP, stop), '', 'a prior owner must not be warned about another worker\'s live claim');
});
test('subagent-stop: an unidentifiable executor stays silent', () => {
  assert.strictEqual(runHook(SUBAGENT_STOP, { session_id: 'sess-nobody-here', agent_type: 'sidequest-exec-high' }), '');
  assert.strictEqual(runHook(SUBAGENT_STOP, {}), '', 'a bare payload with no session id stays silent');
});

test('subagent-stop: long-run threshold settings do not suppress a held-claim verdict', () => {
  const sess = `sess-tuned-${++fixtureState.sqSeq}`;
  const t = addEffortTicket('5-min high-effort stopped claim', 'high');
  const stop = claimStopTicket(t, sess, 'worker-tuned');
  backdateSessionClaims(sess, 5);

  const out = runHookWithFailureDetails(SUBAGENT_STOP, stop, {
    SIDEQUEST_LONG_RUN_MIN: '2',
  });
  const parsed = out.trim() ? JSON.parse(out) : null;
  const ctx = parsed ? parsed.hookSpecificOutput.additionalContext : '';
  assert.match(ctx, new RegExp(`^exec WAITING: ${t.ref} ended a turn while holding its claim; it may resume\.`));
});

// Registered LAST: creates extra fixture categories, which would otherwise grow
// the taxonomy line inside earlier byte-budget assertions.
test('pre-tool hook: route marker batches require an exact prepared briefing', () => {
  const catalog = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-dispatch-catalog-'));
  fs.mkdirSync(path.join(catalog, 'model-gateway'), { recursive: true });
  fs.writeFileSync(path.join(catalog, 'model-gateway', 'catalog.json'), JSON.stringify({
    schemaVersion: 3,
    updatedAt: new Date().toISOString(),
    source: 'model-gateway',
    codexReadiness: { ready: true, state: 'ready', message: 'Codex readiness confirms the local gateway is ready.' },
    models: [
      { slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra[1m]' },
      { slug: 'codex-gpt-5-6-sol', id: 'claude-gpt-5.6-sol[1m]' },
    ],
  }));
  const a = fixtureTicket('SQ-347 dispatch batch A', 'codex-gpt-5-6-terra', 'high');
  const b = fixtureTicket('SQ-347 dispatch batch B', 'codex-gpt-5-6-sol', 'high');
  const proseSibling = runForceBypassWithEnv(
    { subagent_type: 'sidequest-exec-dispatch', name: 'w-dispatch-prose', prompt: `Ref: ${a.ref}\n[sidequest-route model=codex-gpt-5-6-terra effort=high]\nPrior ${b.ref} had a sol route. --project "${slug}"` },
    { SIDEQUEST_DISCOVERY_DIRS: catalog }
  );
  assert.equal(proseSibling.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(proseSibling.hookSpecificOutput.permissionDecisionReason, /requires the exact prepared FIRST action briefing command/);
  const mixed = runForceBypassWithEnv(
    { subagent_type: 'sidequest-exec-dispatch', name: 'w-dispatch-mixed', prompt: `Ref: ${a.ref}\n[sidequest-route model=codex-gpt-5-6-terra effort=high]\nRef: ${b.ref}\n[sidequest-route model=codex-gpt-5-6-sol effort=high]\n--project "${slug}"` },
    { SIDEQUEST_DISCOVERY_DIRS: catalog }
  );
  assert.equal(mixed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(mixed.hookSpecificOutput.permissionDecisionReason, /requires the exact prepared FIRST action briefing command/);
  const same = runForceBypassWithEnv(
    { subagent_type: 'sidequest-exec-dispatch', name: 'w-dispatch-same', prompt: `Ref: ${a.ref}\n[sidequest-route model=codex-gpt-5-6-terra effort=high]\nRef: SQ-999\n[sidequest-route model=codex-gpt-5-6-terra effort=high]\n--project "${slug}"` },
    { SIDEQUEST_DISCOVERY_DIRS: catalog }
  );
  assert.equal(same.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(same.hookSpecificOutput.permissionDecisionReason, /requires the exact prepared FIRST action briefing command/);
});

// The collapsed executor name carries no effort, so name-vs-marker auditing only
// applies to legacy per-effort executors; on the collapsed def the marker owns effort
// and the prepared-spawn comparison audits it against the board.
test('pre-tool hook: a route marker cannot authorize a legacy dispatch executor', () => {
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'sidequest-exec-dispatch-high', name: 'w-dispatch-mismatch',
      prompt: 'work SQ-377\n[sidequest-route model=codex-gpt-5-6-terra effort=medium]',
    },
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /requires the exact prepared FIRST action briefing command/);
});

test('pre-tool hook: a route marker cannot authorize the collapsed dispatch executor', () => {
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'sidequest-exec-dispatch', name: 'w-dispatch-collapsed',
      prompt: 'work SQ-377\n[sidequest-route model=codex-gpt-5-6-terra effort=medium]',
    },
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /requires the exact prepared FIRST action briefing command/);
});

test('pre-tool hook: prepared codex dispatch accepts the gateway-form route marker (SQ-753)', () => {
  const catalog = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-marker-form-'));
  fs.mkdirSync(path.join(catalog, 'model-gateway'), { recursive: true });
  fs.writeFileSync(path.join(catalog, 'model-gateway', 'catalog.json'), JSON.stringify({
    schemaVersion: 3,
    updatedAt: new Date().toISOString(),
    source: 'model-gateway',
    codexReadiness: { ready: true, state: 'ready', message: 'Codex readiness confirms the local gateway is ready.' },
    models: [{ slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra[1m]' }],
  }));
  const previousDirs = process.env.SIDEQUEST_DISCOVERY_DIRS;
  const previousCarrier = process.env.SIDEQUEST_DISPATCH_EFFORT_CARRIER;
  process.env.SIDEQUEST_DISCOVERY_DIRS = catalog;
  // SQ-300 moved the default carriage to frontmatter, which emits no marker at
  // all. The marker grammar still has to be audited exactly as before for a relay
  // older than SQ-299, so this regression runs on the marker carriage explicitly.
  process.env.SIDEQUEST_DISPATCH_EFFORT_CARRIER = 'marker';
  const markerEnv = { SIDEQUEST_DISCOVERY_DIRS: catalog, SIDEQUEST_DISPATCH_EFFORT_CARRIER: 'marker' };
  try {
    const ticket = fixtureTicket('SQ-753 marker form regression', 'codex-gpt-5-6-terra', 'high');
    const prepared = store.prepareDispatch(slug, ticket.ref, { allowUnscoped: true, sessionId: `marker-form-${++fixtureState.sqSeq}` });
    assert.equal(prepared.ticket.dispatch.route.model, 'codex-gpt-5-6-terra');
    assert.equal(prepared.ticket.dispatch.route.marker, 'gpt-5.6-terra');
    // The gate picks the carriage off the executor NAME, so the collapsed name is
    // part of what keeps the marker grammar live here.
    assert.equal(prepared.ticket.dispatchExecutor, 'sidequest-exec-dispatch');

    const base = {
      subagent_type: prepared.ticket.dispatchExecutor,
      name: prepared.ticket.dispatch.launchName,
      description: prepared.ticket.dispatch.description,
      prompt: preparedPrompt(prepared),
    };
    const exact = runForceBypassWithEnv(base, markerEnv);
    assert.ok(!exact.hookSpecificOutput.permissionDecision, 'the production marker form must be allowed');
    assert.equal(exact.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');

    const retiredMarker = ['switch', 'board-route'].join('');
    const retired = runForceBypassWithEnv(
      { ...base, prompt: base.prompt.replace('sidequest-route', retiredMarker) },
      markerEnv
    );
    assert.equal(retired.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(retired.hookSpecificOutput.permissionDecisionReason, /ticket resolved route is/);

    const drifted = runForceBypassWithEnv(
      { ...base, prompt: base.prompt.replace('model=gpt-5.6-terra', 'model=gpt-5.6-sol') },
      markerEnv
    );
    assert.equal(drifted.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(drifted.hookSpecificOutput.permissionDecisionReason, /ticket resolved route is codex-gpt-5-6-terra \/ high/);
    assert.match(drifted.hookSpecificOutput.permissionDecisionReason, /pass its spawn unchanged/);
  } finally {
    if (previousDirs === undefined) delete process.env.SIDEQUEST_DISCOVERY_DIRS;
    else process.env.SIDEQUEST_DISCOVERY_DIRS = previousDirs;
    if (previousCarrier === undefined) delete process.env.SIDEQUEST_DISPATCH_EFFORT_CARRIER;
    else process.env.SIDEQUEST_DISPATCH_EFFORT_CARRIER = previousCarrier;
  }
});

// SQ-300: on the default carriage the pinned definition's frontmatter carries
// both halves, so the spawn must carry no marker. SQ-299 gives a marker
// precedence over output_config.effort, so one stray line would silently
// override the pinned effort — the gate has to refuse it rather than pass it on.
test('pre-tool hook: a pinned codex dispatch is allowed bare and denied with a marker (SQ-300)', () => {
  const catalog = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-pin-form-'));
  fs.mkdirSync(path.join(catalog, 'model-gateway'), { recursive: true });
  fs.writeFileSync(path.join(catalog, 'model-gateway', 'catalog.json'), JSON.stringify({
    schemaVersion: 3,
    updatedAt: new Date().toISOString(),
    source: 'model-gateway',
    codexReadiness: { ready: true, state: 'ready', message: 'Codex readiness confirms the local gateway is ready.' },
    models: [{ slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra[1m]' }],
  }));
  const previousDirs = process.env.SIDEQUEST_DISCOVERY_DIRS;
  process.env.SIDEQUEST_DISCOVERY_DIRS = catalog;
  try {
    const ticket = fixtureTicket('SQ-300 pinned dispatch', 'codex-gpt-5-6-terra', 'high');
    const prepared = store.prepareDispatch(slug, ticket.ref, { allowUnscoped: true, sessionId: `pin-form-${++fixtureState.sqSeq}` });
    // The executor is the per-(model, effort) pin, and the prepared route records
    // no marker, which is how the gate knows to require none.
    assert.equal(prepared.ticket.dispatchExecutor, 'sidequest-exec-codex-gpt-5-6-terra-1m-high');
    assert.equal(prepared.ticket.dispatch.route.marker, undefined);

    const base = {
      subagent_type: prepared.ticket.dispatchExecutor,
      name: prepared.ticket.dispatch.launchName,
      description: prepared.ticket.dispatch.description,
      prompt: preparedPrompt(prepared),
    };
    assert.doesNotMatch(base.prompt, /\[sidequest-route/, 'the prepared spawn must carry no marker');

    const exact = runForceBypassWithEnv(base, { SIDEQUEST_DISCOVERY_DIRS: catalog });
    assert.ok(!exact.hookSpecificOutput.permissionDecision, 'the prepared pinned spawn must be allowed');
    assert.equal(exact.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');
    // The pin applies only with the Agent model parameter omitted; the gate must
    // not reintroduce one.
    assert.equal(exact.hookSpecificOutput.updatedInput.model, undefined);

    const withMarker = runForceBypassWithEnv(
      { ...base, prompt: `${base.prompt}\n[sidequest-route model=gpt-5.6-terra effort=high]` },
      { SIDEQUEST_DISCOVERY_DIRS: catalog }
    );
    assert.equal(withMarker.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(withMarker.hookSpecificOutput.permissionDecisionReason, /must carry no \[sidequest-route\] marker/);

    // Even a marker naming a different effort is refused, not silently honoured.
    const driftedMarker = runForceBypassWithEnv(
      { ...base, prompt: `${base.prompt}\n[sidequest-route model=gpt-5.6-terra effort=low]` },
      { SIDEQUEST_DISCOVERY_DIRS: catalog }
    );
    assert.equal(driftedMarker.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(driftedMarker.hookSpecificOutput.permissionDecisionReason, /override the pinned effort/);
  } finally {
    if (previousDirs === undefined) delete process.env.SIDEQUEST_DISCOVERY_DIRS;
    else process.env.SIDEQUEST_DISCOVERY_DIRS = previousDirs;
  }
});

test('pre-tool hook: exact prepared briefing is the sole dispatch launch authority', () => {
  const cases = [
    {
      name: 'exact valid briefing',
      mutate: (prompt: string) => prompt,
      accepted: true,
    },
    {
      name: 'no prepared dispatch',
      prepare: false,
      mutate: (_prompt: string, ticket: any) => `FIRST action: run \`node "C:\\launcher\\sidequest-launcher.js" briefing ${ticket.ref} --token-file "C:\\missing.token" --project "${BOARD_PATH}"\` and execute exactly what it prints.\n[sidequest-route model=gpt-5.6-terra effort=high]`,
    },
    {
      name: 'marker only',
      mutate: () => '[sidequest-route model=gpt-5.6-terra effort=high]',
    },
    {
      name: 'copied current token without FIRST action',
      mutate: (_prompt: string, ticket: any) => `Ref: ${ticket.ref}\n--token-file "${ticket.dispatch.tokenFile}"\n--project "${BOARD_PATH}"\n[sidequest-route model=gpt-5.6-terra effort=high]`,
    },
    {
      name: 'drifted command',
      mutate: (prompt: string) => prompt.replace(' briefing ', ' brief '),
    },
    {
      name: 'stale token',
      rotate: true,
      mutate: (prompt: string) => prompt,
    },
    {
      name: 'executor mismatch',
      type: 'sidequest-exec-dispatch-readonly',
      mutate: (prompt: string) => prompt,
    },
    {
      name: 'project mismatch',
      mutate: (prompt: string) => prompt.replace(`--project "${BOARD_PATH}"`, '--project "C:\\wrong-project"'),
    },
    {
      // Under the SQ-300 default carriage the prepared prompt carries no marker,
      // so route tampering means ADDING one: the gateway would give it precedence
      // over the pinned output_config.effort. The marker-carriage equivalent, a
      // marker whose model was swapped, is covered by the SQ-753 regression above.
      name: 'route marker smuggled onto a pinned spawn',
      mutate: (prompt: string) => `${prompt}\n[sidequest-route model=gpt-5.6-sol effort=low]`,
    },
  ];
  for (const dispatchCase of cases) {
    const ticket = fixtureTicket(`SQ-1494 ${dispatchCase.name}`, 'codex-gpt-5-6-terra', 'high');
    const sessionId = `exact-briefing-${++fixtureState.sqSeq}`;
    const prepared = dispatchCase.prepare === false ? null : store.prepareDispatch(slug, ticket.ref, { allowUnscoped: true, sessionId });
    const prompt = prepared ? preparedPrompt(prepared) : '';
    const dispatchedTicket = prepared?.ticket || ticket;
    if (dispatchCase.rotate) {
      const initialLaunch = runHookOutput(FORCE_BYPASS, {
        session_id: sessionId,
        tool_name: 'Agent',
        tool_input: {
          subagent_type: prepared.ticket.dispatchExecutor,
          name: prepared.ticket.dispatch.launchName,
          description: prepared.ticket.dispatch.description,
          prompt,
        },
      });
      assert.equal(initialLaunch.hookSpecificOutput.permissionDecision, undefined);
      assert.equal(store.markDispatchStopped(sessionId, prepared.ticket.dispatchExecutor, null, prepared.ticket.dispatch.launchName).stopped, true);
      store.prepareDispatch(slug, ticket.ref, { allowUnscoped: true, sessionId });
    }
    const launch = runHookOutput(FORCE_BYPASS, {
      session_id: sessionId,
      tool_name: 'Agent',
      tool_input: {
        subagent_type: dispatchCase.type || prepared?.ticket.dispatchExecutor || 'sidequest-exec-dispatch',
        name: prepared?.ticket.dispatch.launchName,
        description: prepared?.ticket.dispatch.description,
        prompt: dispatchCase.mutate(prompt, dispatchedTicket),
      },
    });
    if (dispatchCase.accepted) {
      assert.equal(launch.hookSpecificOutput.permissionDecision, undefined, dispatchCase.name);
      assert.ok(store.getTicket(slug, ticket.ref).dispatch.launchedAt, `${dispatchCase.name} records the authoritative launch`);
    } else {
      assert.equal(launch.hookSpecificOutput.permissionDecision, 'deny', dispatchCase.name);
      assert.ok(!store.getTicket(slug, ticket.ref).dispatch?.launchedAt, `${dispatchCase.name} denies before launch recording`);
    }
  }
});

// SQ-230: when the loaded Sidequest drifted from the install, recordDispatchLaunch
// retired the prepared attempt as prepared_compatibility_stale, but PreToolUse ignored
// the refusal and let the spawn proceed. WorktreeCreate then found no launched
// dispatch and refused with the misleading dispatch_binding_unavailable.
test('pre-tool hook: denies a dispatch spawn whose launch the store retired as stale (SQ-230)', () => {
  // Private claude home, same isolation as the dispatch-lifecycle stale test: flipping
  // the shared install identity would retire concurrent launches in other files.
  const isolatedClaudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-stale-launch-home-'));
  const isolatedInstallPath = path.join(isolatedClaudeHome, 'sidequest-test-install');
  fs.mkdirSync(path.join(isolatedClaudeHome, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(isolatedInstallPath, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(isolatedInstallPath, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {} }));
  fs.writeFileSync(path.join(isolatedInstallPath, '.mcp.json'), JSON.stringify({ mcpServers: { board: { command: 'node', args: ['bin/sidequest-mcp.js'] } } }));
  const loadedVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const registryPath = path.join(isolatedClaudeHome, 'plugins', 'installed_plugins.json');
  const writeRegistry = (version: string) => fs.writeFileSync(registryPath, JSON.stringify({
    plugins: { 'sidequest@loadout': [{ scope: 'user', installPath: isolatedInstallPath, version }] },
  }));
  writeRegistry(loadedVersion);
  const sharedClaudeHome = process.env.SIDEQUEST_CLAUDE_HOME;
  process.env.SIDEQUEST_CLAUDE_HOME = isolatedClaudeHome;
  try {
    const ticket = addEffortTicket('stale prepared launch refusal', 'high');
    const sessionId = `stale-launch-${++fixtureState.sqSeq}`;
    const prepared = store.prepareDispatch(slug, ticket.ref, { allowUnscoped: true, sessionId });
    assert.ok(prepared.ticket.dispatch.preparedCompatibility?.pluginInstall, 'the prepare must snapshot the install it ran under');
    writeRegistry(`${loadedVersion}-stale-launch-test`);
    const spawn = {
      subagent_type: prepared.ticket.dispatchExecutor,
      name: prepared.ticket.dispatch.launchName,
      description: prepared.ticket.dispatch.description,
      prompt: preparedPrompt(prepared),
    };
    const launch = runHookOutput(FORCE_BYPASS, { session_id: sessionId, tool_name: 'Agent', tool_input: spawn });
    assert.equal(launch.hookSpecificOutput.permissionDecision, 'deny', 'a retired stale launch must not reach WorktreeCreate');
    assert.match(launch.hookSpecificOutput.permissionDecisionReason, /install snapshot is stale/);
    const retired = store.getTicket(slug, ticket.ref);
    assert.equal(retired.dispatch.failureShape, 'prepared_compatibility_stale');
    assert.equal(retired.dispatch.terminalSource, 'tokened-launch-refusal');
  } finally {
    if (sharedClaudeHome === undefined) delete process.env.SIDEQUEST_CLAUDE_HOME;
    else process.env.SIDEQUEST_CLAUDE_HOME = sharedClaudeHome;
  }
});

test('pre-tool hook: prepared dispatches correct cosmetic spawn drift and reject integrity drift', () => {
  const ticket = addEffortTicket('correct prepared dispatch spawn drift', 'high');
  const sessionId = `description-${++fixtureState.sqSeq}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { allowUnscoped: true, sessionId });
  const description = prepared.ticket.dispatch.description;
  assert.equal(description, `Claude Sonnet, high · ${ticket.title}`);
  const prompt = preparedPrompt(prepared);
  const expectedName = `${ticket.ref.toLowerCase()}-correct-prepared-sonnet-high`;
  assert.equal(prepared.ticket.dispatch.launchName, expectedName);
  const base = {
    subagent_type: prepared.ticket.dispatchExecutor,
    name: expectedName,
    description,
    prompt,
  };

  const exact = runHookOutput(FORCE_BYPASS, { session_id: sessionId, tool_name: 'Agent', tool_input: base });
  assert.equal(exact.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(exact.hookSpecificOutput.updatedInput.description, description);
  assert.equal(exact.hookSpecificOutput.updatedInput.name, expectedName);

  const driftedDescription = runHookOutput(FORCE_BYPASS, {
    session_id: sessionId,
    tool_name: 'Agent',
    tool_input: { ...base, description: 'shorter paraphrase' },
  });
  assert.equal(driftedDescription.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(driftedDescription.hookSpecificOutput.updatedInput.description, description);
  assert.match(driftedDescription.systemMessage, /corrected prepared dispatch description/);

  const driftedName = runHookOutput(FORCE_BYPASS, {
    session_id: sessionId,
    tool_name: 'Agent',
    tool_input: { ...base, name: 'drifted-agent-name' },
  });
  assert.equal(driftedName.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(driftedName.hookSpecificOutput.updatedInput.name, expectedName);
  assert.match(driftedName.systemMessage, /corrected prepared dispatch name/);

  const ordinary = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'sidequest-exec-high',
      model: 'sonnet',
      description: 'ordinary executor launch',
      prompt: 'Read one file.',
    },
  });
  assert.equal(ordinary.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(ordinary.hookSpecificOutput.updatedInput.description, 'ordinary executor launch');
});

test('pre-tool hook preserves old launch records and accepts route-bearing names', () => {
  const oldTicket = addEffortTicket('old launch record', 'high');
  const oldPrepared = store.prepareDispatch(slug, oldTicket.ref, { allowUnscoped: true, sessionId: `old-launch-${++fixtureState.sqSeq}` });
  const oldName = `${oldTicket.ref.toLowerCase()}-old-launch-record`;
  const oldRow = database.prepare('SELECT data FROM tickets WHERE id = ?').get(oldTicket.id);
  const oldData = JSON.parse(oldRow.data);
  oldData.dispatch.launchName = oldName;
  database.prepare('UPDATE tickets SET data = ? WHERE id = ?').run(JSON.stringify(oldData), oldTicket.id);
  const oldLaunch = runHookOutput(FORCE_BYPASS, {
    session_id: oldPrepared.ticket.dispatch.sessionId,
    tool_name: 'Agent',
    tool_input: {
      subagent_type: oldPrepared.ticket.dispatchExecutor,
      name: oldName,
      description: oldPrepared.ticket.dispatch.description,
      prompt: preparedPrompt(oldPrepared),
    },
  });
  assert.equal(oldLaunch.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(oldLaunch.hookSpecificOutput.updatedInput.name, oldName);

  const currentTicket = addEffortTicket('route-bearing launch record', 'high');
  const currentPrepared = store.prepareDispatch(slug, currentTicket.ref, { allowUnscoped: true, sessionId: `route-launch-${++fixtureState.sqSeq}` });
  assert.match(currentPrepared.ticket.dispatch.launchName, /-sonnet-high$/);
  const currentLaunch = runHookOutput(FORCE_BYPASS, {
    session_id: currentPrepared.ticket.dispatch.sessionId,
    tool_name: 'Agent',
    tool_input: {
      subagent_type: currentPrepared.ticket.dispatchExecutor,
      name: currentPrepared.ticket.dispatch.launchName,
      description: currentPrepared.ticket.dispatch.description,
      prompt: preparedPrompt(currentPrepared),
    },
  });
  assert.equal(currentLaunch.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(currentLaunch.hookSpecificOutput.updatedInput.name, currentPrepared.ticket.dispatch.launchName);
});

test('dispatch ledger records an authoritative launch, agent bind, and claim acknowledgement', () => {
  const ticket = addEffortTicket('dispatch launch acknowledgement', 'high');
  const sessionId = `launch-${++fixtureState.sqSeq}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { allowUnscoped: true, sessionId });
  const projectPath = store.readMeta(slug).path;
  const prompt = preparedPrompt(prepared);
  const launch = runHookOutput(FORCE_BYPASS, {
    session_id: sessionId,
    tool_name: 'Agent',
    tool_input: {
      subagent_type: prepared.ticket.dispatchExecutor,
      name: 'dispatch-ledger',
      description: prepared.ticket.dispatch.description,
      prompt,
    },
  });
  const agentName = launch.hookSpecificOutput.updatedInput.name;
  assert.equal(store.getTicket(slug, ticket.ref).dispatch.outcome, 'launched');
  runHookOutput(SUBAGENT_START, {
    session_id: sessionId,
    agent_type: prepared.ticket.dispatchExecutor,
    agent_id: 'native-launch-1',
    agent_name: agentName,
  });
  assert.equal(store.getTicket(slug, ticket.ref).dispatch.agentId, 'native-launch-1');
  assert.equal(store.claimTicket(slug, ticket.ref, 'dispatch-worker', {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  const pulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(pulse.dispatch.outcome, 'claimed');
  assert.equal(pulse.dispatch.tokenPrefix, prepared.token.slice(0, 12));
  assert.equal(pulse.dispatch.agentName, agentName);
});

test('readonly category executors pass spawn correction, start binding, and stop verdict hooks', () => {
  const catalog = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-readonly-catalog-'));
  fs.mkdirSync(path.join(catalog, 'model-gateway'), { recursive: true });
  fs.writeFileSync(path.join(catalog, 'model-gateway', 'catalog.json'), JSON.stringify({
    schemaVersion: 3,
    updatedAt: new Date().toISOString(),
    source: 'model-gateway',
    codexReadiness: { ready: true, state: 'ready', message: 'Codex readiness confirms the local gateway is ready.' },
    models: [{ slug: 'codex-gpt-5-6-sol', id: 'claude-gpt-5.6-sol[1m]' }],
  }));
  const previousDirs = process.env.SIDEQUEST_DISCOVERY_DIRS;
  process.env.SIDEQUEST_DISCOVERY_DIRS = catalog;
  try {
    const cases = [
      ['codebase-exploration', 'sonnet', 'low', 'sidequest-exec-readonly-low'],
      // SQ-300: a readonly codex route resolves to its own per-(model, effort) pin,
      // so the two codex rows differ by effort where they used to collapse onto one
      // effort-free name.
      ['research', 'codex-gpt-5-6-sol', 'medium', 'sidequest-exec-codex-readonly-gpt-5-6-sol-1m-medium'],
      ['review-audit', 'sonnet', 'high', 'sidequest-exec-readonly-high'],
      ['spike-investigation', 'codex-gpt-5-6-sol', 'xhigh', 'sidequest-exec-codex-readonly-gpt-5-6-sol-1m-xhigh'],
    ] as const;
    const projectPath = store.readMeta(slug).path;

    for (const [category, model, effort, expectedExecutor] of cases) {
      store.setCategory({ id: category, name: category, route: { model, effort }, fallback: null, readonly: true, enabled: true });
      const ticket = store.createTicket(slug, { title: `readonly ${category} hook fixture`, category, source: 'cli' });
      const sessionId = `readonly-${category}-${++fixtureState.sqSeq}`;
      const prepared = store.prepareDispatch(slug, ticket.ref, { allowUnscoped: true, sessionId });
      assert.equal(prepared.ticket.dispatchExecutor, expectedExecutor);
      const prompt = preparedPrompt(prepared);
      const launch = runHookOutput(FORCE_BYPASS, {
        session_id: sessionId,
        tool_name: 'Agent',
        tool_input: {
          subagent_type: expectedExecutor,
          model,
          name: 'drifted-readonly-name',
          description: 'drifted readonly description',
          prompt,
        },
      });
      assert.equal(launch.hookSpecificOutput.permissionDecision, undefined);
      assert.equal(launch.hookSpecificOutput.updatedInput.description, prepared.ticket.dispatch.description);
      assert.match(launch.systemMessage, /corrected prepared dispatch description/);

      const agentId = `readonly-agent-${category}`;
      const agentName = launch.hookSpecificOutput.updatedInput.name;
      runHookOutput(SUBAGENT_START, {
        session_id: sessionId,
        agent_type: expectedExecutor,
        agent_id: agentId,
        agent_name: agentName,
      });
      assert.equal(store.getTicket(slug, ticket.ref).dispatch.agentId, agentId);
      assert.equal(store.claimTicket(slug, ticket.ref, `readonly-worker-${category}`, {
        sessionId,
        token: prepared.token,
        executor: expectedExecutor,
      }).ok, true);
      const verdict = runHook(SUBAGENT_STOP, {
        session_id: sessionId,
        agent_type: expectedExecutor,
        agent_id: agentId,
        agent_name: agentName,
      });
      assert.match(verdict, new RegExp(`^exec WAITING: ${ticket.ref} ended a turn while holding its claim; it may resume\.`));
    }
  } finally {
    if (previousDirs === undefined) delete process.env.SIDEQUEST_DISCOVERY_DIRS;
    else process.env.SIDEQUEST_DISCOVERY_DIRS = previousDirs;
  }
});

test('concurrent same-type dispatches isolate launch, bind, claim, and stop by token-derived native identity', () => {
  const first = addEffortTicket('first same-type dispatch', 'high');
  const second = addEffortTicket('second same-type dispatch', 'high');
  const sessionId = `concurrent-${++fixtureState.sqSeq}`;
  const projectPath = store.readMeta(slug).path;
  const preparedFirst = store.prepareDispatch(slug, first.ref, { allowUnscoped: true, sessionId });
  const preparedSecond = store.prepareDispatch(slug, second.ref, { allowUnscoped: true, sessionId });
  const launches = [preparedFirst, preparedSecond].map((prepared) => runHookOutput(FORCE_BYPASS, {
    session_id: sessionId,
    tool_name: 'Agent',
    tool_input: {
      subagent_type: prepared.ticket.dispatchExecutor,
      name: 'sidequest-exec-dispatch',
      description: prepared.ticket.dispatch.description,
      prompt: preparedPrompt(prepared),
    },
  }));
  const names = launches.map((launch) => launch.hookSpecificOutput.updatedInput.name);
  assert.notEqual(names[0], names[1]);
  assert.equal(names[0], `${first.ref.toLowerCase()}-first-same-type-sonnet-high`);
  assert.equal(names[1], `${second.ref.toLowerCase()}-second-same-type-sonnet-high`);
  for (const name of names) assert.doesNotMatch(name, /[A-Z_]|-[a-z0-9]{8,}$/, `${name} still reads as an opaque id`);

  for (const [index, prepared] of [preparedFirst, preparedSecond].entries()) {
    runHookOutput(SUBAGENT_START, {
      session_id: sessionId,
      agent_type: prepared.ticket.dispatchExecutor,
      agent_id: `native-concurrent-${index + 1}`,
      agent_name: names[index],
    });
    assert.equal(store.getTicket(slug, prepared.ticket.ref).dispatch.agentId, `native-concurrent-${index + 1}`);
    assert.equal(store.claimTicket(slug, prepared.ticket.ref, `concurrent-worker-${index + 1}`, {
      sessionId,
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
    }).ok, true);
  }

  const firstStop = runHook(SUBAGENT_STOP, {
    session_id: sessionId,
    agent_type: preparedFirst.ticket.dispatchExecutor,
    agent_id: 'native-concurrent-1',
    agent_name: names[0],
  });
  assert.match(firstStop, new RegExp(`^exec WAITING: ${first.ref} ended a turn while holding its claim; it may resume\.`));
  assert.equal(store.getTicket(slug, first.ref).dispatch.outcome, 'claimed');
  assert.equal(store.getTicket(slug, second.ref).dispatch.outcome, 'claimed');

  const secondStop = runHook(SUBAGENT_STOP, {
    session_id: sessionId,
    agent_type: preparedSecond.ticket.dispatchExecutor,
    agent_id: 'native-concurrent-2',
  });
  assert.match(secondStop, new RegExp(`^exec WAITING: ${second.ref} ended a turn while holding its claim; it may resume\.`));
  assert.doesNotMatch(secondStop, new RegExp(`${first.ref}.*(?:release \\+ fresh dispatch|TaskStop)`));
  assert.equal(store.getTicket(slug, second.ref).dispatch.outcome, 'claimed');
});

test('session start reconciles a reload-lost launch once and leaves it ready to respawn', () => {
  const ticket = addEffortTicket('reload before claim', 'high');
  const sessionId = `reload-${++fixtureState.sqSeq}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { allowUnscoped: true, sessionId });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName: 'lost-native-task',
  }).ok, true);
  const first = runHook(SESSION, { session_id: sessionId, source: 'resume' }, { SIDEQUEST_SWEEP_DEADLINE_MS: '60000' });
  assert.match(first, new RegExp(`${ticket.ref} launched but never claimed`));
  const after = store.getTicket(slug, ticket.ref);
  assert.equal(after.status, 'todo');
  assert.equal(after.dispatch.outcome, 'failed');
  assert.equal(after.dispatchNonce, null);
  assert.deepStrictEqual(store.reconcileLaunchedDispatches(sessionId, { source: 'session-start' }).reconciled, []);
  const second = runHook(SESSION, { session_id: sessionId, source: 'resume' }, { SIDEQUEST_SWEEP_DEADLINE_MS: '60000' });
  assert.ok(!second.includes('launched but never claimed'));
});

test('SQ-220: a same-process session start never fails a live launched-but-unbound dispatch', () => {
  // Compaction (the orchestrator's or any in-process subagent's) and a subagent's own
  // SessionStart share the orchestrator session id, but the host process and every
  // background executor it launched are still alive. Only a restart may reconcile.
  const ticket = addEffortTicket('live launch across compaction', 'high');
  const sessionId = `live-launch-${++fixtureState.sqSeq}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { allowUnscoped: true, sessionId });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName: 'live-native-task',
  }).ok, true);
  const env = { SIDEQUEST_SWEEP_DEADLINE_MS: '60000' };
  const sameProcessStarts = [
    { session_id: sessionId, source: 'compact' },
    { session_id: sessionId, source: 'clear' },
    { session_id: sessionId, source: 'startup', agent_id: 'native-sibling', agent_type: prepared.ticket.dispatchExecutor },
    { session_id: sessionId, source: 'compact', agent_id: 'native-sibling', agent_type: prepared.ticket.dispatchExecutor },
  ];
  for (const payload of sameProcessStarts) {
    const context = runHook(SESSION, payload, env);
    assert.ok(!context.includes('launched but never claimed'), `${JSON.stringify(payload)} reported a live launch as lost`);
    const live = store.getTicket(slug, ticket.ref);
    assert.equal(live.dispatch.outcome, 'launched', `${JSON.stringify(payload)} terminalized a live launch`);
    assert.equal(live.dispatch.terminalAt ?? null, null);
    assert.ok(live.dispatchNonce, `${JSON.stringify(payload)} revoked the live dispatch token`);
  }
  assert.equal(store.claimTicket(slug, ticket.ref, 'live-launch-worker', {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
});

test('subagent stop terminalizes an unclaimed launch so the next dispatch can recover safely', () => {
  const ticket = addEffortTicket('stop before claim', 'high');
  const sessionId = `stop-${++fixtureState.sqSeq}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { allowUnscoped: true, sessionId });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, 'native-stop-1', 'stop-before-claim').ok, true);
  const context = runHook(SUBAGENT_STOP, {
    session_id: sessionId,
    agent_type: prepared.ticket.dispatchExecutor,
    agent_id: 'native-stop-1',
    agent_name: 'stop-before-claim',
  });
  assert.match(context, new RegExp(`^exec FINISHED after terminal failed: ${ticket.ref}\\. Preserve recovery evidence before a replacement\\.`));
  assert.doesNotMatch(context, /TaskStop/, 'SQ-183: a terminal SubagentStop verdict must not tell the orchestrator to TaskStop an executor');
  const after = store.getTicket(slug, ticket.ref);
  assert.equal(after.dispatch.outcome, 'failed');
  assert.ok(after.dispatch.terminalAt);
  assert.equal(after.dispatchNonce, null);
});

test('subagent-stop: legacy ticket executors without identity stay silent', () => {
  assert.strictEqual(
    runHook(SUBAGENT_STOP, { session_id: 'sess-legacy-ticket', agent_type: 'sidequest-ticket-sq-584-haiku-b37fffcb' }),
    ''
  );
});

test('pre-tool hook: dispatch executor requires an exact briefing and legacy executors cannot launch', () => {
  const missingMarker = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-dispatch', name: 'w-dispatch-no-marker', prompt: 'work SQ-377' },
  });
  assert.equal(missingMarker.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(missingMarker.hookSpecificOutput.permissionDecisionReason, /requires the exact prepared FIRST action briefing command/);

  const builtIn = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-high', model: 'opus', name: 'w-builtin-no-marker', prompt: 'work SQ-377' },
  });
  assert.ok(!builtIn.hookSpecificOutput.permissionDecision, 'markerless builtin executors remain valid');
  assert.equal(builtIn.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');

  const legacy = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-ticket-sq-584-haiku-b37fffcb', name: 'w-legacy', prompt: 'work SQ-377' },
  });
  assert.equal(legacy.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(legacy.hookSpecificOutput.permissionDecisionReason, /invalid or retired/);
});

test('session-start audit report is quiet at zero, surfaces carried summaries, and defers at budget', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-audit-handoff-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-audit-handoff-cwd-'));
  registerProject(home, cwd);
  // The quiet and carried-summary branches require the detached audit to finish now.
  // Keep their deadline independent of host load; only the final call pins deferral.
  const env = {
    SIDEQUEST_HOME: home,
    CLAUDE_PROJECT_DIR: cwd,
    CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..'),
    SIDEQUEST_AUDIT_DEADLINE_MS: '60000',
  };

  const quiet = runHook(SESSION, { session_id: 'audit-quiet', source: 'startup', cwd }, env);
  assert.doesNotMatch(quiet, /sidequest audit:/);
  assert.doesNotMatch(quiet, /audit report exceeded its SessionStart budget/);

  const auditReport = path.join(home, 'audit-reports', `${crypto.createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 16)}.json`);
  fs.mkdirSync(path.dirname(auditReport), { recursive: true });
  fs.writeFileSync(auditReport, JSON.stringify({ summary: 'sidequest audit: 2 untracked issues. Run `sidequest audit` for detail.' }));
  const carried = runHook(SESSION, { session_id: 'audit-carried', source: 'startup', cwd }, env);
  assert.match(carried, /sidequest audit: 2 untracked issues/);
  assert.doesNotMatch(carried, /audit report exceeded its SessionStart budget/);

  const deferred = runHook(SESSION, { session_id: 'audit-deferred', source: 'startup', cwd }, { ...env, SIDEQUEST_AUDIT_DEADLINE_MS: '0' });
  assert.match(deferred, /audit report exceeded its SessionStart budget/);
});

test('SQ-303: observedGitFacts reads git-dir, common-dir and HEAD off disk, matching git itself', () => {
  const identity = require('../src/hooks/shared/runtime-identity.ts');
  const repo = sq303Repo('sq-303-facts-');
  const expectFacts = (checkout: string) => {
    const resolve = (value: string) => path.isAbsolute(value) ? value : path.resolve(checkout, value);
    const facts = identity.observedGitFacts(checkout);
    assert.ok(facts, `${checkout} must be readable from disk`);
    assert.equal(fs.realpathSync(facts.gitDirectory), fs.realpathSync(resolve(gitFixture(['rev-parse', '--git-dir'], checkout))));
    assert.equal(fs.realpathSync(facts.commonGitDirectory), fs.realpathSync(resolve(gitFixture(['rev-parse', '--git-common-dir'], checkout))));
    assert.equal(facts.revision, gitFixture(['rev-parse', '--verify', 'HEAD^{commit}'], checkout));
  };

  // A primary checkout, where `.git` is a directory and is its own common dir.
  expectFacts(repo);

  // A linked worktree, where `.git` is a file naming a per-worktree dir whose `commondir` names the
  // shared one, and whose HEAD is detached rather than a ref.
  const linked = path.join(path.dirname(repo), `${path.basename(repo)}-linked`);
  gitFixture(['worktree', 'add', '--detach', linked], repo);
  try {
    expectFacts(linked);
    // And a branch-backed HEAD in a linked worktree, where the ref it names lives in the common dir.
    gitFixture(['switch', '-c', 'sq303/branch'], linked);
    expectFacts(linked);
    // Packed refs are the other place a branch tip can live.
    gitFixture(['pack-refs', '--all'], repo);
    expectFacts(linked);
  } finally {
    gitFixture(['worktree', 'remove', '--force', linked], repo);
  }

  // An unborn HEAD has no revision at all. Reporting the layout as unreadable keeps the `git rev-parse
  // --verify` spawn, and its throw, as the refusal the guard already produced there.
  const unborn = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-303-unborn-')));
  gitFixture(['init', '-b', 'main'], unborn);
  assert.equal(identity.observedGitFacts(unborn), null, 'an unborn HEAD must fall back to the git spawn');
  assert.equal(identity.observedGitFacts(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-303-plain-'))), null, 'a directory that is not a checkout reads as unreadable');

  // The case that makes this reader dangerous if it walks up from nothing. `git rev-parse` runs with the
  // candidate as its working directory and fails when that directory is gone, which is how a removed
  // worktree reads as "no facts". A reader that kept climbing would find the enclosing checkout and report
  // ITS identity as the removed worktree's, binding a dispatch to the shared tree (the SQ-2189 class).
  const removed = path.join(repo, 'worktrees', 'gone');
  assert.equal(identity.observedGitFacts(removed), null, 'a path that no longer exists must not inherit the enclosing checkout');
  const { checkoutLayout } = require('../src/lib/kernel/worktree.ts');
  assert.equal(checkoutLayout(removed), null, 'the kernel reader must stop where git stops');
  assert.equal(checkoutLayout(path.join(repo, '.git', 'HEAD')), null, 'a file is not a working directory');
});

test('SQ-303: the Edit-path guard allows the assigned worktree with no git on PATH', () => {
  const repo = sq303Repo('sq-303-guard-');
  const project = store.ensureProject(repo).slug;
  const category = `sq-303-guard-${++fixtureState.fixtureSeq}`;
  store.setCategory({ id: category, name: category, route: { model: 'sonnet', effort: 'medium' }, fallback: null, enabled: true });
  const ticket = store.createTicket(project, { title: 'sq-303 edit path', category, source: 'cli', files: ['README.md'] });
  const agentId = 'sq303edit';
  const sessionId = `sq-303-guard-${++fixtureState.sqSeq}`;
  const prepared = store.prepareDispatch(project, ticket.ref, { sessionId });
  const executor = prepared.ticket.dispatchExecutor;
  assert.equal(store.recordDispatchLaunch(project, ticket.ref, {
    token: prepared.token, executor, sessionId, agentName: agentId,
  }).ok, true);
  const worktree = worktrees.resolvedAgentWorktree(repo, agentId);
  assert.equal(store.bindDispatchWorktreeCreation(project, sessionId, worktree).ok, true);
  gitFixture(['worktree', 'add', '--detach', worktree], repo);
  try {
    completeCheckoutCreation(project, sessionId, worktree);
    assert.equal(store.bindDispatchAgent(sessionId, executor, agentId, agentId, worktree).ok, true);
    const payload = {
      session_id: sessionId,
      agent_id: agentId,
      agent_type: executor,
      cwd: worktree,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(worktree, 'README.md'), old_string: 'a', new_string: 'b' },
    };

    // The first write is the one allowed to pay for a `merge-base --is-ancestor` probe: reachability is
    // not a fact on disk. It is a pure function of two revisions, so it is memoized per session.
    assert.equal(runHookOutput(GUARD_WORKTREE_ISOLATION, payload, { SIDEQUEST_HOME }), null, 'the assigned worktree is allowed');

    // Every write after it must decide from the board read and git's on-disk layout alone. An empty PATH
    // makes any surviving spawn an ENOENT the guard turns into a refusal, so an allow here is the
    // assertion that the Edit path no longer shells out to git.
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-303-nogit-'));
    const second = runHookOutput(GUARD_WORKTREE_ISOLATION, payload, { SIDEQUEST_HOME, PATH: noGit, Path: noGit });
    assert.equal(second, null, 'the Edit path must not spawn git once the ancestry probe is memoized');

    // The guard must still refuse a write into the shared checkout, with no git on PATH either: the
    // decision it exists to make cannot depend on the spawns that were removed.
    const shared = runHookOutput(GUARD_WORKTREE_ISOLATION, {
      ...payload,
      cwd: repo,
      tool_input: { file_path: path.join(repo, 'README.md'), old_string: 'a', new_string: 'b' },
    }, { SIDEQUEST_HOME, PATH: noGit, Path: noGit });
    assert.equal(shared.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(shared.hookSpecificOutput.permissionDecisionReason.includes(ticket.ref), 'the refusal still names the ticket');
  } finally {
    gitFixture(['worktree', 'remove', '--force', worktree], repo);
  }
});

test('SQ-303: identity binding is attempted once per agent and checkout, not once per write', () => {
  const identity = require('../src/hooks/shared/runtime-identity.ts');
  const repo = sq303Repo('sq-303-bind-');
  const other = sq303Repo('sq-303-bind-other-');
  const sessionId = `sq-303-bind-${++fixtureState.sqSeq}`;
  const input = { session_id: sessionId, agent_id: 'sq303bind', agent_name: 'sq303bind' };
  const once = (checkout: string) => identity.bindObservedRuntimeIdentityOnce(input, 'sq303bind', 'sidequest-exec-high', checkout);

  assert.equal(once(repo), true, 'the first offer binds');
  assert.equal(once(repo), false, 'repeating the same offer must not reach the board again');
  assert.equal(once(repo), false, 'and must stay skipped for the life of the session');
  // Re-offering a DIFFERENT checkout is the SQ-2153 retry, where the worktree was not ready at spawn.
  assert.equal(once(other), true, 'a newly offered checkout must still bind');
  assert.equal(once(other), false);

  // The marker is hook state, so it survives into the next hook process rather than only this one.
  const stateFile = path.join(SIDEQUEST_HOME, 'tmp', 'state', `runtime-identity-${encodeURIComponent(sessionId)}.json`);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(Object.keys(state.agents).length, 2, 'one entry per agent and offered checkout');
  assert.ok(Object.keys(state.agents).every((key) => state.agents[key].attempted), 'each records that the bind was spent');
});

test('SQ-303: a deferred binding is still owed, and a memoized ancestry answer is not re-probed', () => {
  const identity = require('../src/hooks/shared/runtime-identity.ts');
  const repo = sq303Repo('sq-303-defer-');
  const sessionId = `sq-303-defer-${++fixtureState.sqSeq}`;

  // A bind that never reached the store leaves the offer in hook state. The next hook to hold the store
  // has to settle it, so the once-per-agent marker must not count it as spent.
  identity.deferRuntimeIdentityBinding(sessionId, 'sidequest-exec-high', 'sq303defer', 'sq303defer', repo);
  const deferred = JSON.parse(fs.readFileSync(path.join(SIDEQUEST_HOME, 'tmp', 'state', `runtime-identity-${encodeURIComponent(sessionId)}.json`), 'utf8'));
  assert.equal((Object.values(deferred.agents) as any[])[0].deferred, true);
  assert.equal(
    identity.bindObservedRuntimeIdentityOnce({ session_id: sessionId, agent_id: 'sq303defer', agent_name: 'sq303defer' }, 'sq303defer', 'sidequest-exec-high', repo),
    true,
    'a deferred binding is owed one attempt, not already spent',
  );

  // Settling it is what a hook that reaches the store does, and it must leave the offer spent.
  identity.settleRuntimeIdentityBinding(sessionId, 'sq303defer', 'sq303defer', repo);
  const settled = JSON.parse(fs.readFileSync(path.join(SIDEQUEST_HOME, 'tmp', 'state', `runtime-identity-${encodeURIComponent(sessionId)}.json`), 'utf8'));
  assert.equal((Object.values(settled.agents) as any[])[0].deferred, false, 'a settled binding is no longer owed');

  // The ancestry probe is the one git spawn the Edit path cannot read off disk, so it is memoized on the
  // pair of revisions it answers for. A second write must not re-run it.
  let probes = 0;
  const probe = () => { probes += 1; return 'ancestor'; };
  assert.equal(identity.cachedBaselineAncestry(sessionId, 'base1', 'rev1', probe), 'ancestor');
  assert.equal(identity.cachedBaselineAncestry(sessionId, 'base1', 'rev1', probe), 'ancestor');
  assert.equal(probes, 1, 'the memoized answer must not re-spawn git');
  // A moved HEAD is a different question and must be probed again.
  assert.equal(identity.cachedBaselineAncestry(sessionId, 'base1', 'rev2', probe), 'ancestor');
  assert.equal(probes, 2);
  // 'unknown' means the probe could not run. Caching it would freeze a transient failure into a
  // standing refusal for the rest of the session.
  let unknowns = 0;
  const failing = () => { unknowns += 1; return 'unknown'; };
  assert.equal(identity.cachedBaselineAncestry(sessionId, 'base2', 'rev1', failing), 'unknown');
  assert.equal(identity.cachedBaselineAncestry(sessionId, 'base2', 'rev1', failing), 'unknown');
  assert.equal(unknowns, 2, 'a probe that could not run must never be cached');
});

test('SQ-303: subagent-start records the binding offer, binds inline, and settles the offer', () => {
  const repo = sq303Repo('sq-303-spawn-');
  const project = store.ensureProject(repo).slug;
  const category = `sq-303-spawn-${++fixtureState.fixtureSeq}`;
  store.setCategory({ id: category, name: category, route: { model: 'sonnet', effort: 'medium' }, fallback: null, enabled: true });
  const ticket = store.createTicket(project, { title: 'sq-303 spawn path', category, source: 'cli', files: ['README.md'] });
  const agentId = 'sq303spawn';
  const sessionId = `sq-303-spawn-${++fixtureState.sqSeq}`;
  const prepared = store.prepareDispatch(project, ticket.ref, { sessionId });
  const executor = prepared.ticket.dispatchExecutor;
  assert.equal(store.recordDispatchLaunch(project, ticket.ref, {
    token: prepared.token, executor, sessionId, agentName: agentId,
  }).ok, true);

  runHookOutput(SUBAGENT_START, {
    session_id: sessionId,
    agent_type: executor,
    agent_id: agentId,
    agent_name: agentId,
    cwd: repo,
  }, { SIDEQUEST_HOME });

  // The offer is written BEFORE the bind is attempted, which is the whole mechanism: anything that ends this
  // hook early — an exhausted SQLite budget failing open, or Claude Code killing it at the 10s deadline —
  // now leaves the binding owed on disk instead of silently lost. The hook still binds inline, so the
  // offer is the fallback and not the normal path; that the inline bind survives is covered by the
  // worktree-create tests above, which assert dispatch.agentId against a real linked worktree.
  const offers = JSON.parse(fs.readFileSync(path.join(SIDEQUEST_HOME, 'tmp', 'state', `runtime-identity-${encodeURIComponent(sessionId)}.json`), 'utf8'));
  const offer = (Object.values(offers.agents) as any[])[0];
  assert.equal(offer.worktree, repo, 'the spawn records which checkout it offered');
  assert.equal(offer.executor, executor);

  // And reaching the store spends the offer. This checkout is a primary one, so the bind has no worktree
  // facts to record and answers with a refusal — which is still an answer. Leaving it owed would send the
  // guard back to the store on every Edit for the life of the agent, which is the loop being removed here.
  assert.ok(offer.attempted, 'the offer is marked attempted');
  assert.ok(!offer.deferred, 'a bind that reached the store is spent, however it answered');
});

export {};
