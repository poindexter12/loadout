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
  execFileSync,
  spawn,
  SIDEQUEST_HOME,
  store,
  boardReconciliationReminderForStore,
  worktrees,
  db,
  BOARD_PATH,
  slug,
  database,
  HOOKS,
  SESSION,
  SESSION_END,
  FORCE_BYPASS,
  GUARD_PEER,
  GUARD_HOME_DELETE,
  GUARD_WORKTREE_ISOLATION,
  GUARD_HEREDOC_ISOLATED,
  INLINE_WORK_NUDGE,
  BOARD_FIRST_REMINDER,
  BOARD_RECONCILIATION_REMINDER,
  GUARD_SHARED_TREE_COMMIT,
  runHookOutput,
  runHookProcessForBudget,
  waitForPath,
  sweepReportFile,
  publishStateLock,
  runHook,
  runHookOutputForBudget,
  gitFixture,
  completeCheckoutCreation,
  fixtureTicket,
  runForceBypassWithEnv,
  runGuardPeer,
  runHomeDeleteGuard,
  runBashWindowsPathGuard,
  runPowerShellCmdShimGuard,
  failClosedBoardHome,
  holdExclusiveBoardLock,
  runGuardUnderBoardLock,
  assertBoardContentionDeny,
  executorPayload,
  claimHeredocWorker,
  addTicket,
  addStopTicket,
  addEffortTicket,
  claimStopTicket,
  recordTerminalAgentFailure,
  fixtureState,
  type HookProcessResult,
} from './_hooks-fixture.js';

test('usable-route admission keeps unavailable boards inline without a raw Agent fallback', () => {
  const categories = store.getCategories({ project: slug, includeDisabled: false });
  try {
    for (const category of categories) {
      if (category.id !== 'general') store.setProjectCategory(slug, category.id, 'DISABLE', {});
    }
    store.setProjectCategory(slug, 'general', 'OVERRIDE', {
      route: { model: 'unavailable-test-route', effort: 'high' },
    });
    assert.equal(store.projectDispatchAdmission(slug).status, 'no-usable-route');
    assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
      session_id: `inline-unavailable-${Date.now()}`, cwd: BOARD_PATH, tool_name: 'Write', tool_input: {},
    }), null);
    const denied = runHookOutput(FORCE_BYPASS, {
      cwd: BOARD_PATH,
      tool_name: 'Agent',
      tool_input: { subagent_type: 'general-purpose', prompt: 'Inspect this repository.' },
    });
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /Continue bounded inline work with direct tools/);
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /do not create a fake Sidequest or raw Agent lifecycle fallback/);
  } finally {
    store.removeProjectCategory(slug, 'general');
    for (const category of categories) {
      if (category.id !== 'general') store.removeProjectCategory(slug, category.id);
    }
  }
  assert.equal(store.projectDispatchAdmission(slug).status, 'routed');
});

test('pre-tool inline-work nudge ignores automation prompts', () => {
  const payload = {
    session_id: `inline-automation-${Date.now()}`, cwd: BOARD_PATH, tool_name: 'Read', tool_input: {},
    prompt: '<task-notification>Executor completed.</task-notification>',
  };
  for (let i = 0; i < 12; i += 1) assert.equal(runHookOutput(INLINE_WORK_NUDGE, payload), null);
});

test('user-prompt reminder fires once for the first human prompt', () => {
  const payload = { session_id: `board-first-${Date.now()}`, cwd: BOARD_PATH, prompt: 'Fix the board hook.' };
  const reminder = runHookOutput(BOARD_FIRST_REMINDER, payload);
  assert.equal(reminder.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(reminder.hookSpecificOutput.additionalContext, /using Explore only for a quick sweep/);
  assert.match(reminder.hookSpecificOutput.additionalContext, /codebase-exploration spike/);
  assert.equal(runHookOutput(BOARD_FIRST_REMINDER, payload), null);
});

test('user-prompt reminder ignores automation without consuming the session flag', () => {
  const payload = { session_id: `board-automation-${Date.now()}`, cwd: BOARD_PATH };
  assert.equal(runHookOutput(BOARD_FIRST_REMINDER, { ...payload, prompt: '<task-notification>Executor completed.</task-notification>' }), null);
  assert.equal(runHookOutput(BOARD_FIRST_REMINDER, { ...payload, prompt: '<agent-message>Worker needs input.</agent-message>' }), null);
  assert.equal(runHookOutput(BOARD_FIRST_REMINDER, { ...payload, prompt: '<local-command>Command output.</local-command>' }), null);
  assert.equal(runHookOutput(BOARD_FIRST_REMINDER, { ...payload, prompt: '<local-command-caveat>Command output.</local-command-caveat>' }), null);
  assert.match(runHook(BOARD_FIRST_REMINDER, { ...payload, prompt: 'Implement the ticket.' }), /Use informed inline judgment/);
});

test('user-prompt reminder ignores subagent identity variants and routing-disabled boards', () => {
  for (const identity of [
    { agent_id: 'executor' }, { agentId: 'executor' }, { agent_type: 'sidequest-exec-high' }, { agentType: 'sidequest-exec-high' },
  ]) {
    const subagent = { session_id: `board-subagent-${Date.now()}`, cwd: BOARD_PATH, ...identity, prompt: 'Implement the ticket.' };
    assert.equal(runHookOutput(BOARD_FIRST_REMINDER, subagent), null);
  }

  store.setProjectRouting(slug, 'disabled');
  try {
    const disabled = { session_id: `board-disabled-${Date.now()}`, cwd: BOARD_PATH, prompt: 'Implement the ticket.' };
    assert.equal(runHookOutput(BOARD_FIRST_REMINDER, disabled), null);
  } finally {
    store.setProjectRouting(slug, 'enabled');
  }
});

test('pre-tool hook keeps a complete Claude worktree spawn valid outside its board cwd', () => {
  const ticket = fixtureTicket('SQ-399 worktree spawn regression', 'fable', 'xhigh');
  const unregisteredWorktree = path.join(os.tmpdir(), 'sq-unregistered-worktree');
  const original = {
    subagent_type: 'sidequest-exec-xhigh',
    name: 'sq399-worktree',
    mode: 'bypassPermissions',
    isolation: 'worktree',
    model: 'fable',
    prompt: `Implement ${ticket.ref}. --project "${path.join(os.tmpdir(), 'sq-hooks-fixtures', 'board')}"`,
  };
  const out = runHookOutput(FORCE_BYPASS, { tool_name: 'Agent', cwd: unregisteredWorktree, tool_input: original });

  assert.deepStrictEqual(out.hookSpecificOutput.updatedInput, original);
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
});
test('pre-tool hook: builtin exec without a model injects the resolved Claude model from a prompt ref', () => {
  const t = fixtureTicket('SQ-232 inject fixture', 'sonnet', 'high');
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-high', name: 'w-inject', prompt: `work ${t.ref} --project "${slug}"` },
  });
  assert.equal(out.hookSpecificOutput.updatedInput.model, 'sonnet');
  assert.equal(out.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');
  assert.ok(!out.hookSpecificOutput.permissionDecision, 'a resolvable spawn must not be denied');
  assert.match(out.systemMessage, /injected "sonnet"/);
  assert.match(out.systemMessage, /resolved category route/);
  assert.ok(out.systemMessage.includes(t.ref), 'systemMessage must name the ref it resolved from');
});

test('pre-tool hook: builtin exec without a model and no ticket ref in the prompt is denied', () => {
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-high', name: 'w-norefs', prompt: 'go fix the reporter, no ticket named here' },
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /missing its dispatched ticket/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /dispatch briefing/);
  assert.doesNotMatch(out.hookSpecificOutput.permissionDecisionReason, /model: exec\.model/);
});

test('pre-tool hook: a modeled builtin executor without a ticket is denied on a routed board', () => {
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    cwd: BOARD_PATH,
    tool_input: {
      subagent_type: 'sidequest-exec-readonly-high',
      model: 'opus',
      prompt: 'Blind review of this diff. No ticket anywhere.',
    },
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /missing its dispatched ticket/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /dispatch briefing/);
  assert.doesNotMatch(out.hookSpecificOutput.permissionDecisionReason, /model: exec\.model/);
});

test('pre-tool hook: a modeled builtin executor with a fabricated ticket is denied on a routed board', () => {
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    cwd: BOARD_PATH,
    tool_input: {
      subagent_type: 'sidequest-exec-readonly-high',
      model: 'opus',
      prompt: 'Blind review for SQ-99999.',
    },
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /SQ-99999.*isn't on the resolved board/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /rather than retyping refs/);
});

test('pre-tool hook: builtin exec without a model and conflicting concrete models across refs is denied', () => {
  const a = fixtureTicket('SQ-232 conflict fixture A', 'sonnet', 'high');
  const b = fixtureTicket('SQ-232 conflict fixture B', 'opus', 'high');
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-high', name: 'w-conflict', prompt: `batch ${a.ref} and ${b.ref} --project "${slug}"` },
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /conflicting concrete models/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /split it per model/);
});

test('pre-tool hook: builtin exec spawned WITH a model that mismatches the resolved route keeps the caller value and warns', () => {
  const t = fixtureTicket('SQ-232 mismatch fixture', 'sonnet', 'high');
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-high', name: 'w-mismatch', model: 'opus', prompt: `work ${t.ref} --project "${slug}"` },
  });
  assert.equal(out.hookSpecificOutput.updatedInput.model, 'opus', 'a deliberate cap must be kept, not overwritten');
  assert.match(out.systemMessage, /model "opus" but .* resolves to "sonnet"/);
});

test('pre-tool hook gates MCP closeout updates by subagent caller, not executor classification', () => {
  const generalPurposeSubagent = { agent_id: 'closeout-update-child', agent_type: 'general-purpose' };
  const closeoutUpdates: Array<[string, unknown]> = [
    ['files', ['src/other.ts']],
    ['status', 'todo'],
    ['readonly', true],
    ['readonlyOverride', true],
    ['workingTreeDelivery', true],
    ['externalDeliverable', true],
    ['verify', 'node --test test/hooks.test.ts'],
    ['verifyKind', 'suite'],
    ['attestationArtifact', 'verification.json'],
    ['executorVerify', 'node --test test/hooks.test.ts'],
    ['executorVerifyKind', 'suite'],
    ['executorAttestationArtifact', 'verification.json'],
  ];
  for (const [field, value] of closeoutUpdates) {
    const output = runHookOutput(FORCE_BYPASS, {
      ...generalPurposeSubagent,
      tool_name: 'mcp__plugin_sidequest_board__update',
      tool_input: { ref: 'SQ-2397', [field]: value },
    });
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny', String(field) + ' must be denied');
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /subagents cannot update closeout fields through MCP/i);
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /scopeRequest.*orchestrator.*main thread/i);
  }

  const mainThread = runHookOutput(FORCE_BYPASS, {
    tool_name: 'mcp__plugin_sidequest_board__update',
    tool_input: { ref: 'SQ-2397', externalDeliverable: true },
  });
  assert.equal(mainThread, null, 'the main thread reaches the MCP handler');

  const descriptiveUpdate = runHookOutput(FORCE_BYPASS, {
    agent_id: 'closeout-update-executor',
    agent_type: 'sidequest-exec-dispatch',
    tool_name: 'mcp__plugin_sidequest_board__update',
    tool_input: { ref: 'SQ-2397', title: 'Reworded', description: 'No closeout fields changed.' },
  });
  assert.equal(descriptiveUpdate, null, 'ordinary ticket text remains editable through MCP');

  const cli = runHookOutput(FORCE_BYPASS, {
    agent_id: 'closeout-update-executor',
    agent_type: 'sidequest-exec-dispatch',
    tool_name: 'Bash',
    tool_input: { command: 'node sidequest.js update SQ-1 --readonly' },
  });
  assert.equal(cli, null, 'the CLI store guard, not the hook regex, refuses this update');
});

test('pre-tool hook denies a subagent MCP remove carrying force (the delete-to-shed-claim escape)', () => {
  const subagent = { agent_id: 'remove-force-child', agent_type: 'general-purpose' };

  const denied = runHookOutput(FORCE_BYPASS, {
    ...subagent,
    tool_name: 'mcp__plugin_sidequest_board__remove',
    tool_input: { ref: 'SQ-2397', project: 'p', force: true },
  });
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /subagents cannot force-remove/i);

  // A subagent remove WITHOUT force is not the escape (the handler still refuses a
  // live claim); the hook lets it reach the handler.
  const noForce = runHookOutput(FORCE_BYPASS, {
    ...subagent,
    tool_name: 'mcp__plugin_sidequest_board__remove',
    tool_input: { ref: 'SQ-2397', project: 'p' },
  });
  assert.equal(noForce, null, 'a non-force remove reaches the handler, which guards live claims');

  // The main thread reaches the handler even with force.
  const mainThread = runHookOutput(FORCE_BYPASS, {
    tool_name: 'mcp__plugin_sidequest_board__remove',
    tool_input: { ref: 'SQ-2397', project: 'p', force: true },
  });
  assert.equal(mainThread, null, 'the orchestrator main thread may force-remove');
});

test('pre-tool hook: stable dispatch executors require preparation even with a ref', () => {
  const t = fixtureTicket('SQ-232 dispatch passthrough fixture', 'codex-gpt-5-6-terra', 'high');
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'sidequest-exec-dispatch', model: 'fable', name: 'w-dispatch',
      prompt: `work ${t.ref} --project "${slug}"\n[sidequest-route model=codex-gpt-5-6-terra effort=high]`,
    },
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /requires the exact prepared FIRST action briefing command/);
});

test('pre-tool hook: an unprepared dispatch executor denies before model override checks', () => {
  const out = runForceBypassWithEnv(
    { subagent_type: 'sidequest-exec-dispatch', name: 'sq-env-codex', prompt: 'work SQ-1\n[sidequest-route model=codex-gpt-5-6-terra effort=high]' },
    { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' }
  );
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /requires the exact prepared FIRST action briefing command/);
});

test('pre-tool hook: CLAUDE_CODE_SUBAGENT_MODEL set denies a builtin executor spawn too', () => {
  const out = runForceBypassWithEnv(
    { subagent_type: 'sidequest-exec-high', name: 'sq-env-builtin', prompt: 'work SQ-1' },
    { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' }
  );
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Unset it/);
});

test('pre-tool hook: an unprepared dispatch executor remains denied without a model override', () => {
  const out = runForceBypassWithEnv(
    { subagent_type: 'sidequest-exec-dispatch', model: 'fable', name: 'sq-env-off', prompt: 'work SQ-1\n[sidequest-route model=codex-gpt-5-6-terra effort=high]' },
    { CLAUDE_CODE_SUBAGENT_MODEL: '' }
  );
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /requires the exact prepared FIRST action briefing command/);
});

test('peer-guard: executor and Codex executor peer messages are allowed', () => {
  for (const agent_type of ['sidequest-exec-high', 'sidequest-exec-codex-gpt-5-6-luna-medium']) {
    assert.strictEqual(runGuardPeer({ agent_type, tool_input: { to: 'reviewer', message: 'look at SQ-70' } }), null);
  }
});

test('peer-guard: an executor reporting to main is allowed', () => {
  assert.strictEqual(runGuardPeer({ agent_type: 'sidequest-exec-high', tool_input: { to: 'main', message: 'done' } }), null);
});

test('peer-guard: a main-thread SendMessage (no agent_type) is allowed', () => {
  assert.strictEqual(runGuardPeer({ tool_input: { to: 'reviewer', message: 'assign' } }), null);
});

test('peer-guard: terminal dispatch blocks delayed steering before delivery', () => {
  const ticket = addEffortTicket('terminal executor cannot be revived', 'high');
  const sessionId = `terminal-message-${++fixtureState.sqSeq}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { allowUnscoped: true, sessionId });
  const executorName = 'finished-dispatch-worker';
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName: executorName,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, 'terminal-agent-id', executorName).ok, true);
  assert.equal(store.claimTicket(slug, ticket.ref, 'terminal-worker', {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.recordDispatchAgentFailure(slug, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    taskName: executorName,
    agentId: 'terminal-agent-id',
    agentName: executorName,
    error: 'Prompt is too long',
  }).ok, true);

  const after = store.getTicket(slug, ticket.ref);
  assert.equal(after.claim, null);
  assert.equal(after.dispatch.agentName, executorName, 'terminal failures retain the mapped executor for terminal cleanup');
  assert.equal(after.dispatch.outcome, 'died');
  assert.ok(after.dispatch.terminalAt);

  const out = runGuardPeer({ tool_input: { to: executorName, message: 'one more thing' } });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, new RegExp(ticket.ref));
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /follow-up ticket/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /redispatch the existing ticket/i);
});

test('peer-message hooks refuse a completed executor by its exact SendMessage target', () => {
  const ticket = addStopTicket('completed executor cannot receive follow-up work');
  const acting = claimStopTicket(ticket, `completed-message-${++fixtureState.sqSeq}`, 'completed-worker');
  assert.equal(store.completeTicket(slug, ticket.ref, 'completed-worker', {
    model: 'sonnet',
    effort: 'high',
    cleanDeclaredScope: true,
  }).ok, true);

  const after = store.getTicket(slug, ticket.ref);
  assert.equal(after.status, 'done');
  assert.equal(after.claim, null);
  assert.equal(after.dispatch.outcome, 'done');

  const payload = {
    agent_id: 'orchestrator-after-completion',
    tool_name: 'SendMessage',
    tool_input: { to: acting.agent_name, message: 'Make one more revision.' },
  };
  for (const hook of [GUARD_PEER, FORCE_BYPASS]) {
    const out = runHookOutput(hook, payload);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, new RegExp(ticket.ref));
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /follow-up ticket/);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /redispatch the existing ticket/i);
  }
});

test('peer-message hooks refuse a submitted executor by its exact SendMessage target', () => {
  const ticket = addStopTicket('submitted executor cannot receive follow-up work');
  const acting = claimStopTicket(ticket, `submitted-message-${++fixtureState.sqSeq}`, 'submitted-worker');
  assert.equal(store.submitTicket(slug, ticket.ref, 'submitted-worker', {
    commit: 'a'.repeat(40),
    range: {
      base: 'b'.repeat(40),
      upstream: 'main',
      upstreamCommit: 'c'.repeat(40),
      commits: [],
      changedPaths: [],
      noOp: true,
    },
  }).ok, true);

  const after = store.getTicket(slug, ticket.ref);
  assert.equal(after.claim, null);
  assert.equal(after.dispatch.outcome, 'submitted');

  const payload = {
    agent_id: 'orchestrator-after-submission',
    tool_name: 'SendMessage',
    tool_input: { to: acting.agent_name, message: 'Make one more revision.' },
  };
  for (const hook of [GUARD_PEER, FORCE_BYPASS]) {
    const out = runHookOutput(hook, payload);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, new RegExp(ticket.ref));
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /follow-up ticket/);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /redispatch the existing ticket/i);
  }
});

test('peer-guard: missing isolated worktree blocks a non-terminal resume only', () => {
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-missing-worktree-'));
  fs.writeFileSync(path.join(isolatedRoot, 'fixture.txt'), 'fixture\n');
  gitFixture(['init', '-b', 'main'], isolatedRoot);
  gitFixture(['config', 'user.email', 'sidequest@example.test'], isolatedRoot);
  gitFixture(['config', 'user.name', 'Sidequest Test'], isolatedRoot);
  gitFixture(['add', 'fixture.txt'], isolatedRoot);
  gitFixture(['commit', '-m', 'fixture'], isolatedRoot);
  const { slug: isolatedSlug } = store.ensureProject(isolatedRoot);
  const category = 'general';
  const isolated = store.createTicket(isolatedSlug, { title: 'missing worktree cannot be resumed', category, files: ['lib'], source: 'cli' });
  const sessionId = `missing-worktree-${++fixtureState.sqSeq}`;
  const prepared = store.prepareDispatch(isolatedSlug, isolated.ref, { allowUnscoped: true, sessionId, sharedTree: false });
  assert.equal(prepared.ticket.dispatch.sharedTree, false);
  const isolatedName = 'missing-worktree-worker';
  const agentId = `missing-worktree-agent-${fixtureState.sqSeq}`;
  assert.equal(store.recordDispatchLaunch(isolatedSlug, isolated.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName: isolatedName,
  }).ok, true);
  const worktree = worktrees.agentWorktreePath(isolatedRoot, agentId);
  assert.equal(store.bindDispatchWorktreeCreation(isolatedSlug, sessionId, worktree).ok, true);
  gitFixture(['worktree', 'add', '--detach', worktree], isolatedRoot);
  completeCheckoutCreation(isolatedSlug, sessionId, worktree);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentId, isolatedName, worktree).ok, true);
  assert.strictEqual(runGuardPeer({ tool_input: { to: isolatedName, message: 'continue' } }), null);
  fs.rmSync(worktree, { recursive: true, force: true });

  const blocked = runGuardPeer({ tool_input: { to: isolatedName, message: 'continue' } });
  assert.equal(blocked.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, new RegExp(isolated.ref));
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /worktree-isolated/);
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /Redispatch/);

  const shared = store.createTicket(isolatedSlug, { title: 'shared worker remains reachable', category, files: ['lib'], source: 'cli' });
  const sharedSession = `shared-worktree-${++fixtureState.sqSeq}`;
  const sharedPrepared = store.prepareDispatch(isolatedSlug, shared.ref, { allowUnscoped: true, sessionId: sharedSession, sharedTree: true });
  assert.equal(sharedPrepared.ticket.dispatch.sharedTree, true);
  assert.equal(store.recordDispatchLaunch(isolatedSlug, shared.ref, {
    sessionId: sharedSession,
    token: sharedPrepared.token,
    executor: sharedPrepared.ticket.dispatchExecutor,
    agentName: 'shared-worktree-worker',
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sharedSession, sharedPrepared.ticket.dispatchExecutor, `shared-agent-${fixtureState.sqSeq}`, 'shared-worktree-worker').ok, true);
  assert.strictEqual(runGuardPeer({ tool_input: { to: 'shared-worktree-worker', message: 'continue' } }), null);
  assert.equal(store.deleteProjectExact(isolatedSlug).ok, true);
  fs.rmSync(isolatedRoot, { recursive: true, force: true });
});

test('hook manifest registers no TeammateIdle wakeup for terminal executors', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
  assert.equal(config.hooks.TeammateIdle, undefined, 'a TeammateIdle hook would wake completed executors');
});


test('peer-guard: an active dispatch still accepts main-thread steering', () => {
  const ticket = addEffortTicket('active executor accepts steering', 'high');
  const sessionId = `active-message-${++fixtureState.sqSeq}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { allowUnscoped: true, sessionId });
  const executorName = 'active-dispatch-worker';
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName: executorName,
  }).ok, true);

  assert.strictEqual(runGuardPeer({ tool_input: { to: executorName, message: 'please check the test' } }), null);
});

test('peer-guard: a non-sidequest subagent messaging a peer is allowed', () => {
  assert.strictEqual(runGuardPeer({ agent_type: 'code-reviewer', tool_input: { to: 'researcher', message: 'hi' } }), null);
});

test('Bash Windows-path guard: denies an unquoted backslash path', () => {
  const token = 'C:\\Users\\kenny\\AppData\\Local\\Temp\\lookup4.err';
  const out = runBashWindowsPathGuard(`node script.js 2> ${token}`);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, new RegExp(token.replace(/\\/g, '\\\\')));
});

test('Bash Windows-path guard: allows a backslash path inside a heredoc body', () => {
  for (const command of [
    "cat <<'EOF'\nCONFIRMED REPRO (C:\\dev\\atomic-agents)\nEOF\n",
    'cat <<END\nCONFIRMED REPRO (C:\\dev\\atomic-agents)\nEND\n',
    'cat <<-END\nCONFIRMED REPRO (C:\\dev\\atomic-agents)\n\tEND\n',
  ]) {
    assert.strictEqual(runBashWindowsPathGuard(command), null, command);
  }
});

test('Bash Windows-path guard: allows a single-quoted backslash path', () => {
  assert.strictEqual(runBashWindowsPathGuard("node script.js 'C:\\Users\\kenny\\lookup4.err'"), null);
});

test('Bash Windows-path guard: allows a double-quoted backslash path', () => {
  assert.strictEqual(runBashWindowsPathGuard('node script.js "C:\\Users\\kenny\\lookup4.err"'), null);
});

test('Bash Windows-path guard: denies a double-quoted path whose backslash escapes a dollar', () => {
  const out = runBashWindowsPathGuard('node script.js "C:\\Users\\kenny\\$name\\lookup4.err"');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /double quotes eat the backslash/);
});

test('Bash Windows-path guard: allows writing a scratch script through a heredoc', () => {
  const command = [
    'cat > "C:\\Users\\kenny\\AppData\\Local\\Temp\\claude\\scratch\\probe.js" <<\'EOF\'',
    'const root = "C:\\dev\\poindexter12\\loadout";',
    'const raw = C:\\dev\\poindexter12\\loadout;',
    'console.log(root, raw);',
    'EOF',
  ].join('\n');
  assert.strictEqual(runBashWindowsPathGuard(command), null);
});

test('Bash Windows-path guard: allows a plain-text heredoc append', () => {
  const command = 'cat >> notes.md <<\'EOF\'\n## findings\n- one\n- two\nEOF\n';
  assert.strictEqual(runBashWindowsPathGuard(command), null);
});

test('Bash Windows-path guard: allows a heredoc body inside a command substitution', () => {
  const command = 'echo "$(cat <<\'EOF\'\nC:\\dev\\atomic-agents\\notes\nEOF\n)"';
  assert.strictEqual(runBashWindowsPathGuard(command), null);
});

test('Bash Windows-path guard: a stray quote in a comment does not leak into a heredoc body', () => {
  for (const comment of ['# writes the "notes" file', "# don't rewrite it"]) {
    const command = `${comment}\ncat > notes.md <<'EOF'\nC:\\dev\\atomic-agents\\notes\nEOF\n`;
    assert.strictEqual(runBashWindowsPathGuard(command), null, comment);
  }
});

test('Bash Windows-path guard: denies an unquoted path on the heredoc-opening line', () => {
  const token = 'C:\\Users\\kenny\\notes.md';
  const out = runBashWindowsPathGuard(`cat > ${token} <<'EOF'\nplain body\nEOF\n`);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, new RegExp(token.replace(/\\/g, '\\\\')));
});

test('Bash Windows-path guard: still denies an unquoted path after a heredoc body', () => {
  const token = 'C:\\Users\\kenny\\lookup4.err';
  const command = `cat <<EOF\nC:\\dev\\atomic-agents\nEOF\nnode script.js ${token}`;
  const out = runBashWindowsPathGuard(command);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, new RegExp(token.replace(/\\/g, '\\\\')));
});

test('Bash Windows-path guard: keeps scanning a continued heredoc header', () => {
  const token = 'C:\\Users\\kenny\\lookup4.err';
  const command = `cat <<EOF \\\nnode script.js ${token}\nC:\\dev\\atomic-agents\nEOF\n`;
  const out = runBashWindowsPathGuard(command);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, new RegExp(token.replace(/\\/g, '\\\\')));
});

test('Bash Windows-path guard: allows forward-slash paths', () => {
  assert.strictEqual(runBashWindowsPathGuard('node script.js 2> C:/Users/kenny/AppData/Local/Temp/lookup4.err'), null);
});

test('Bash Windows-path guard: is a no-op outside Windows', () => {
  assert.strictEqual(runBashWindowsPathGuard('node script.js 2> C:\\Users\\kenny\\AppData\\Local\\Temp\\lookup4.err', 'linux'), null);
});

test('Bash Windows-path guard: warns when Git Bash rewrites a container path', () => {
  const out = runBashWindowsPathGuard('docker exec -w /app contractify-docai uv run python -c "..."');
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
  assert.match(out.hookSpecificOutput.additionalContext, /MSYS_NO_PATHCONV=1 docker exec -w \/app/);
  assert.match(out.hookSpecificOutput.additionalContext, /docker exec -w \/\/app/);
});

test('Bash Windows-path guard: allows protected container path spellings', () => {
  for (const command of [
    'MSYS_NO_PATHCONV=1 docker exec -w /app contractify-docai uv run python -c "..."',
    'docker exec -w //app contractify-docai uv run python -c "..."',
  ]) {
    assert.strictEqual(runBashWindowsPathGuard(command), null, command);
  }
});

test('Bash Windows-path guard: warns for Docker volume and kubectl workdir flags', () => {
  for (const command of [
    'docker run --volume /app:/workspace image',
    'kubectl exec pod --workdir /app -- command',
  ]) {
    assert.match(runBashWindowsPathGuard(command).hookSpecificOutput.additionalContext, /Git Bash rewrites/);
  }
});

test('PowerShell cmd-shim guard: warns with both working Start-Process forms', () => {
  for (const shim of ['npm', 'npx', 'yarn', 'pnpm']) {
    const out = runPowerShellCmdShimGuard(`Start-Process -FilePath "${shim}" -ArgumentList "run","dev"`);
    assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
    assert.match(out.hookSpecificOutput.additionalContext, new RegExp(`-FilePath "${shim}\\.cmd"`));
    assert.match(out.hookSpecificOutput.additionalContext, new RegExp(`-FilePath "cmd" -ArgumentList "\\/c","${shim}","run","dev"`));
  }
});

test('PowerShell cmd-shim guard: allows an explicit shim and non-Windows platforms', () => {
  assert.strictEqual(runPowerShellCmdShimGuard('Start-Process -FilePath "npm.cmd" -ArgumentList "run","dev"'), null);
  assert.strictEqual(runPowerShellCmdShimGuard('Start-Process -FilePath "npm" -ArgumentList "run","dev"', 'linux'), null);
});

test('home-delete guard: blocks a recursive delete using $home', () => {
  const out = runHomeDeleteGuard('PowerShell', 'Remove-Item -Recurse -Force $home');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /user profile or \.claude root/);
});

test('home-delete guard: applies to executors too', () => {
  const out = runHookOutput(GUARD_HOME_DELETE, {
    tool_name: 'PowerShell', agent_type: 'sidequest-exec-high', agent_id: 'executor',
    tool_input: { command: 'Remove-Item -Recurse -Force $home' },
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('home-delete guard: blocks profile and .claude roots', () => {
  for (const command of [
    'Remove-Item -Recurse -Force $env:USERPROFILE',
    'rm -rf %USERPROFILE%',
    `rm -rf ${path.join(os.homedir(), '.claude')}`,
  ]) {
    assert.equal(runHomeDeleteGuard('Bash', command).hookSpecificOutput.permissionDecision, 'deny');
  }
});

test('home-delete guard: blocks a recursive delete of the profile root', () => {
  const out = runHomeDeleteGuard('Bash', `rm -rf ${os.homedir()}`);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('home-delete guard: blocks a parent traversal from .claude', () => {
  const out = runHomeDeleteGuard('Bash', `rm -rf ${path.join(os.homedir(), '.claude', '..')}`);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('home-delete guard: allows forced non-recursive and continued scoped deletes', () => {
  for (const command of [
    'rm -f C:/Users/x/AppData/Local/Temp/observability/file',
    `rm -f "C:\\scratchpad\\observability" \\
  "C:\\scratchpad\\logs"`,
    `rm -rf "C:\\scratchpad\\observability" \\
  "C:\\scratchpad\\logs"`,
  ]) {
    assert.strictEqual(runHomeDeleteGuard('Bash', command), null, command);
  }
});

test('home-delete guard: a lone forward slash is still the drive root', () => {
  const commands = ['rm -rf /', 'rm -rf C:\\scratchpad\\observability /'];
  if (process.platform === 'win32') commands.push('rm -rf D:/');
  for (const command of commands) {
    assert.equal(runHomeDeleteGuard('Bash', command).hookSpecificOutput.permissionDecision, 'deny', command);
  }
});

test('home-delete guard: allows scratchpad deletion', () => {
  assert.strictEqual(runHomeDeleteGuard('PowerShell', 'Remove-Item -Recurse -Force C:\\scratchpad\\run-42'), null);
});

test('home-delete guard: allows non-delete PowerShell commands', () => {
  assert.strictEqual(runHomeDeleteGuard('PowerShell', 'Get-ChildItem $HOME'), null);
});

test('home-delete guard: allows observed non-destructive scratchpad commands', () => {
  const scratchpad = path.join(os.tmpdir(), 'claude', 'sq-1330');
  for (const command of [
    `grep -n "profile" ${path.join(scratchpad, 'verify.log')}`,
    `cat <<'EOF' > ${path.join(scratchpad, 'script.js')}\nconsole.log('scratchpad');\nEOF`,
    `rm -f ${path.join(scratchpad, 'script.js')}`,
    `rm -rf ${path.join(scratchpad, 'cache')}; grep -n "$home" ${path.join(scratchpad, 'verify.log')}`,
  ]) {
    assert.strictEqual(runHomeDeleteGuard('Bash', command), null, command);
  }
});

test('worktree isolation guard: allows unparseable read and verify-wrapper Bash commands', () => {
  const filteredVerifyCommand = 'log="$(mktemp "${TMPDIR:-/tmp}/sidequest-verify.XXXXXX.log")"\n(cd plugins/sidequest && npm run test:full) > "$log" 2>&1\nstatus=$?\ngrep -nE "^not ok|^# (fail|pass)" "$log" | head -40';
  for (const command of [
    'grep -n "guard" plugins/sidequest/test/hooks.test.ts',
    filteredVerifyCommand,
  ]) {
    assert.strictEqual(runHookOutput(GUARD_WORKTREE_ISOLATION, {
      tool_name: 'Bash',
      agent_type: 'sidequest-exec-dispatch',
      agent_id: 'sq-1330-fixture',
      tool_input: { command },
    }), null, command);
  }
});

test('fail-closed guard: guard-destructive-git denies a push it cannot check while the board lock is held', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-fail-closed-push-'));
  gitFixture(['init', '-q', '-b', 'main'], repo);
  gitFixture(['remote', 'add', 'origin', path.join(repo, 'missing-remote.git')], repo);
  // Unlocked, this push is allowed: an unregistered repo integrates on main, so main is not the published branch
  // it guards. Only the board can say that, so under contention the guard refuses instead of guessing.
  const result = await runGuardUnderBoardLock(path.join(HOOKS, 'guard-destructive-git.js'), {
    hook_event_name: 'PreToolUse',
    session_id: `sq-133-fail-closed-${crypto.randomUUID()}`,
    tool_name: 'Bash',
    tool_input: { command: 'git push origin main' },
    cwd: repo,
  });
  assertBoardContentionDeny(result, 'guard-destructive-git');
});

test('fail-closed guard: guard-shared-checkout-git denies an executor git write it cannot check while the board lock is held', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-fail-closed-commit-'));
  gitFixture(['init', '-q', '-b', 'main'], repo);
  const result = await runGuardUnderBoardLock(
    path.join(HOOKS, 'guard-shared-checkout-git.js'),
    executorPayload('Bash', { command: 'git commit -m checked' }, repo),
  );
  assertBoardContentionDeny(result, 'guard-shared-checkout-git');
});

test('fail-closed guard: guard-worktree-isolation denies an executor write it cannot check while the board lock is held', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-fail-closed-write-'));
  gitFixture(['init', '-q', '-b', 'main'], repo);
  const result = await runGuardUnderBoardLock(
    GUARD_WORKTREE_ISOLATION,
    executorPayload('Write', { file_path: path.join(repo, 'checked.txt'), content: 'checked\n' }, repo),
  );
  assertBoardContentionDeny(result, 'guard-worktree-isolation');
});

test('fail-closed guard: force-exec-bypass denies an executor call it cannot check while the board lock is held', async () => {
  const result = await runGuardUnderBoardLock(FORCE_BYPASS, executorPayload('Bash', { command: 'ls' }));
  assertBoardContentionDeny(result, 'force-exec-bypass');
});

test('fail-closed guard: guard-shared-tree-commit denies an executor raw commit it cannot check while the board lock is held', async () => {
  // SQ-370: this guard reads the board to find the executor's shared-tree claim. Before the fix its catch swallowed
  // the lock error and the raw commit went through unchecked.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-fail-closed-shared-commit-'));
  gitFixture(['init', '-q', '-b', 'main'], repo);
  const result = await runGuardUnderBoardLock(
    GUARD_SHARED_TREE_COMMIT,
    executorPayload('Bash', { command: 'git commit -m unchecked' }, repo),
  );
  assertBoardContentionDeny(result, 'guard-shared-tree-commit');
});

test('guard-destructive-git spawns no git for a command that cannot destroy work or publish (SQ-370)', async () => {
  // Every Bash call runs this guard under the harness's 10s hook timeout, and a guard killed there decides nothing.
  // A slow git must therefore never be on the path of a plain command. Assert that property directly, not through
  // wall-clock time (SQ-381): on a loaded machine the hook's own process startup exceeds any tight bound. The guard
  // reaches git only through synchronous, PATH-resolved execFileSync('git'), so a fake git first on PATH records
  // every invocation before the guard can exit.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-370-fake-git-'));
  const marker = path.join(bin, 'git-invoked');
  const fakeGit = path.join(bin, 'git');
  fs.writeFileSync(fakeGit, `#!/bin/sh\necho "$*" >> "${marker}"\nexit 1\n`, { mode: 0o755 });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-370-plain-cwd-'));
  const runGuard = (command: string) => runHookProcessForBudget(
    path.join(HOOKS, 'guard-destructive-git.js'),
    { hook_event_name: 'PreToolUse', session_id: `sq-370-${crypto.randomUUID()}`, tool_name: 'Bash', tool_input: { command }, cwd },
    { PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` },
  );
  const invocations = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '');
  for (const command of ['ls', 'git log --oneline -1', 'git status --short']) {
    const result = await runGuard(command);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), '', `${command} must be allowed silently: ${result.stdout}`);
    assert.equal(invocations(), '', `${command} must not spawn git, but the guard ran: ${invocations()}`);
  }
  // Positive control: a command that could destroy work does make the guard resolve its repository through git, and
  // the fake git records it. Without this the empty marker above could pass because the shim was never reachable.
  const destructiveResult = await runGuard('git reset --hard');
  assert.equal(destructiveResult.status, 0, `git reset --hard: ${destructiveResult.stderr}`);
  assert.match(invocations(), /rev-parse --show-toplevel/, 'the fake git must intercept the guard\'s git spawns');
});

test('fail-closed guard: guard-home-delete, guard-process-signal and read-only git stay unrefused while the board lock is held', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-fail-closed-read-'));
  gitFixture(['init', '-q', '-b', 'main'], repo);
  const home = failClosedBoardHome();
  const holder = await holdExclusiveBoardLock(home);
  try {
    for (const [script, payload] of [
      [GUARD_HOME_DELETE, executorPayload('Bash', { command: 'rm -rf ./build' }, repo)],
      [path.join(HOOKS, 'guard-process-signal.js'), executorPayload('Bash', { command: 'kill %1' }, repo)],
      [path.join(HOOKS, 'guard-shared-checkout-git.js'), executorPayload('Bash', { command: 'git status --short' }, repo)],
      [path.join(HOOKS, 'guard-destructive-git.js'), executorPayload('Bash', { command: 'git log --oneline -1' }, repo)],
    ] as const) {
      const result = await runHookProcessForBudget(script, payload, { SIDEQUEST_HOME: home });
      const hook = path.basename(script, '.js');
      assert.equal(result.status, 0, `${hook}: ${result.stderr}`);
      assert.equal(result.stdout.trim(), '', `${hook} must not decide a call that never needs the board: ${result.stdout}`);
      assert.doesNotMatch(result.stderr, /board lock busy/, hook);
    }
  } finally {
    holder.kill();
  }
});

test('heredoc guard: denies a heredoc that carries a git invocation in a dispatched isolated worktree', () => {
  const acting = claimHeredocWorker('heredoc isolation guard');
  const commands = [
    "git commit -F - <<'EOF'\nsubject line\nEOF",
    "cd sub && git tag -a v1 -F - <<'EOF'\nnotes\nEOF",
    "bash <<'SH'\ncd /tmp/elsewhere\ngit push origin main\nSH",
    "sh -s <<'SH'\nset -e\n  git reset --hard\nSH",
  ];
  for (const command of commands) {
    const out = runHookOutput(GUARD_HEREDOC_ISOLATED, { ...acting, tool_name: 'Bash', tool_input: { command } });
    assert.equal(out?.hookSpecificOutput?.permissionDecision, 'deny', command);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /heredoc that carries a git invocation/, command);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /Write the script to your scratchpad and run it by path/, command);
  }
});

// SQ-227: the guard refused EVERY heredoc in an isolated worktree, so a readonly executor (no Write tool) could
// not write evidence or scratch files at all, and the session scratchpad path of any repo under
// ~/Code/github.com/ encodes "github" into it. Only a heredoc that carries a git invocation may be refused.
test('heredoc guard: allows a non-git heredoc in a dispatched isolated worktree (SQ-227)', () => {
  const acting = claimHeredocWorker('heredoc non-git allowance');
  const scratch = '/private/tmp/claude-503/-Users-joese-Code-github-com-poindexter12-muximus/0b1c/scratchpad';
  const commands = [
    `cat <<'EOF' > ${scratch}/x\nevidence line\nEOF`,
    `cat > "${scratch}/notes.md" <<EOF\nRun git push later, after review.\nThe github.com remote is fine.\nEOF`,
    "node - <<'JS'\nconsole.log('probe');\nJS",
    `ls ${scratch} && cat <<-'EOF' >> ${scratch}/log\n\tline\n\tEOF`,
    `printf '%s\\n' "$(cat <<'EOF'\nprobe output\nEOF\n)" > /Users/me/.claude/sidequest/projects/p/verification/SQ-1/out.txt`,
    "/Users/me/.local/share/mise/installs/aqua-github-copilot-cli/1.0/bin/copilot --help <<'EOF'\nq\nEOF",
    "echo 'git push' && cat <<'EOF' > /tmp/x\nbody\nEOF",
  ];
  for (const command of commands) {
    assert.strictEqual(
      runHookOutput(GUARD_HEREDOC_ISOLATED, { ...acting, tool_name: 'Bash', tool_input: { command } }),
      null,
      command,
    );
  }
});

test('heredoc guard: stays silent for non-isolated and non-heredoc Bash commands', () => {
  const heredoc = "node - <<'JS'\nconsole.log('probe');\nJS";
  assert.strictEqual(runHookOutput(GUARD_HEREDOC_ISOLATED, {
    tool_name: 'Bash',
    cwd: path.join(BOARD_PATH, 'src'),
    tool_input: { command: heredoc },
  }), null);
  assert.strictEqual(runHookOutput(GUARD_HEREDOC_ISOLATED, {
    tool_name: 'Bash',
    cwd: path.join(BOARD_PATH, '.claude', 'worktrees', 'agent-heredoc-fixture'),
    tool_input: { command: 'node script.js' },
  }), null);
});

test('home-delete guard: blocks the 2026-07-16 incident command verbatim', () => {
  const out = runHomeDeleteGuard('PowerShell', '$home = Join-Path "C:\\Temp\\x" "sq330-runtime"; if (Test-Path $home) { Remove-Item -Recurse -Force $home -Confirm:$false }');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('home-delete guard: blocks deletes wrapped in blocks, pipelines, and aliases', () => {
  for (const command of [
    'Get-ChildItem ~ | ForEach-Object { Remove-Item -Recurse -Force $home }',
    'if (Test-Path $home) { ri -Recurse -Force $home }',
    'rd /s %USERPROFILE%',
  ]) {
    assert.equal(runHomeDeleteGuard('PowerShell', command).hookSpecificOutput.permissionDecision, 'deny', command);
  }
});

test('session-start sweep is fail-soft and releases only claims past the TTL', () => {
  const stale = addTicket('session-start stale claim');
  const fresh = addTicket('session-start fresh claim');
  store.updateTicket(slug, stale.ref, { labels: ['direct-ok'] });
  store.updateTicket(slug, fresh.ref, { labels: ['direct-ok'] });
  const reason = 'The stale-claim fixture needs local direct claims.';
  assert.equal(store.claimTicket(slug, stale.ref, 'stale-session', { direct: true, reason }).ok, true);
  assert.equal(store.claimTicket(slug, fresh.ref, 'fresh-session', { direct: true, reason }).ok, true);
  const staleTicket = store.getTicket(slug, stale.ref);
  staleTicket.claim.at = new Date(Date.now() - store.claimIdleMs() - 1).toISOString();
  db.putRow(database, 'tickets', {
    id: staleTicket.id, project: slug, ref: staleTicket.ref, status: staleTicket.status,
    archived: staleTicket.archived ? 1 : 0, ord: staleTicket.order, claim_by: staleTicket.claim.by, data: staleTicket,
  });
  assert.doesNotThrow(() => runHook(SESSION, { session_id: 'sweep-test' }, { SIDEQUEST_SWEEP_DEADLINE_MS: '60000' }));
  assert.equal(store.getTicket(slug, stale.ref).claim, null);
  assert.equal(store.getTicket(slug, fresh.ref).claim.by, 'fresh-session');
});

test('session-end reclaims an unbound old patch-equivalent worktree and stays fail-soft', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-session-end-project-'));
  const worktrees = path.join(project, '.claude', 'worktrees');
  const projectGit = (args: string[], cwd?: string) => execFileSync('git', args, { cwd: cwd || project, encoding: 'utf8', windowsHide: true }).trim();
  projectGit(['init', '-b', 'main']);
  projectGit(['config', 'user.name', 'Sidequest Test']);
  projectGit(['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(project, 'README.md'), 'session-end fixture\n');
  projectGit(['add', '.']);
  projectGit(['commit', '-m', 'base']);
  projectGit(['branch', '-M', 'main']);
  fs.mkdirSync(worktrees, { recursive: true });
  const worktree = path.join(worktrees, 'agent-session-end');
  const branch = 'worktree-agent-session-end';
  projectGit(['worktree', 'add', '-b', branch, worktree, 'main']);
  fs.writeFileSync(path.join(worktree, 'integrated.txt'), 'integrated\n');
  projectGit(['add', 'integrated.txt'], worktree);
  projectGit(['commit', '-m', 'integrated fixture'], worktree);
  const commit = projectGit(['rev-parse', 'HEAD'], worktree);
  projectGit(['cherry-pick', commit]);
  const old = new Date(Date.now() - 4 * 60 * 60 * 1000);
  fs.utimesSync(worktree, old, old);
  store.ensureProject(project);
  const report = sweepReportFile(SIDEQUEST_HOME, project);
  fs.rmSync(report, { force: true });

  assert.doesNotThrow(() => runHook(SESSION_END, { session_id: 'session-end-test', cwd: project }));
  // SQ-386: SessionEnd hands the sweep to a detached worker, which reports when it is done.
  await waitForPath(report);
  assert.equal(fs.existsSync(worktree), false);
  assert.equal(projectGit(['branch', '--list', branch]), '');
  assert.doesNotThrow(() => runHook(SESSION_END, { session_id: 'session-end-fail-soft' }, { CLAUDE_PLUGIN_ROOT: path.join(project, 'missing-plugin') }));
  fs.rmSync(project, { recursive: true, force: true });
});


// Session ids diverge across a long orchestration, and the old exemption was
// keyed on them, so a healthy running wave read as unfinished business and the
// orchestrator was told to go close tickets its executors were mid-way through
// (the-bot-resurrection, three times in one night).
test('stop reminder: a live executor claim is in progress, not unfinished business', () => {
  const dispatchSession = `reconcile-live-dispatch-${++fixtureState.sqSeq}`;
  const ticket = addStopTicket('live executor mid-run');
  claimStopTicket(ticket, dispatchSession, 'reconcile-live-executor');

  const laterSession = `reconcile-live-later-${++fixtureState.sqSeq}`;
  assert.equal(runHookOutput(BOARD_RECONCILIATION_REMINDER, { session_id: dispatchSession, cwd: BOARD_PATH }), null,
    'the session that dispatched it sees a running wave, not an open ticket');
  assert.equal(runHookOutput(BOARD_RECONCILIATION_REMINDER, { session_id: laterSession, cwd: BOARD_PATH }), null,
    'a session id that moved on does not resurrect the reminder');

  // Once the dispatch goes terminal the claim is nobody's live work, and the
  // ticket is business the orchestrator still owes an answer on.
  assert.equal(store.releaseTicket(slug, ticket.ref, 'reconcile-live-executor', { status: 'todo', source: 'test' }).ok, true);
  assert.equal(store.getTicket(slug, ticket.ref).status, 'todo');
  assert.equal(runHookOutput(BOARD_RECONCILIATION_REMINDER, { session_id: dispatchSession, cwd: BOARD_PATH }), null,
    'a terminal dispatch released to todo is no longer this session\'s responsibility');
  assert.equal(store.claimTicket(slug, ticket.ref, 'reconcile-live-orchestrator', {
    direct: true, reason: 'A direct claim with no live dispatch stays this session\'s own to close.',
  }).ok, true);
  const reminded = runHookOutput(BOARD_RECONCILIATION_REMINDER, { session_id: dispatchSession, cwd: BOARD_PATH });
  assert.match(reminded.hookSpecificOutput.additionalContext, /1 ticket in doing/);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'reconcile-live-orchestrator', { status: 'todo', source: 'test' }).ok, true);
});

test('stop reminder reads only the current project instead of scanning every board ticket', () => {
  const sessionId = `reconcile-project-scope-${++fixtureState.sqSeq}`;
  const currentTicket = {
    ref: 'SQ-current',
    status: 'doing',
    claim: { by: 'project-scope-worker', at: new Date().toISOString() },
  };
  const scopedStore = {
    nearestRepoRoot: (start: string) => start,
    findProject: () => ({ ok: true, slug: 'current-project' }),
    sessionClaims: (requestedSessionId: string) => {
      assert.equal(requestedSessionId, sessionId);
      return [{ ref: currentTicket.ref, held: true }];
    },
    listTickets: (projectSlug: string) => {
      assert.equal(projectSlug, 'current-project');
      return [currentTicket];
    },
    claimReclaimable: () => false,
    claimMaySubmit: () => false,
    worktreeGcTickets: () => {
      throw new Error('Stop reconciliation must not deserialize tickets from other projects.');
    },
  };

  const reminder = boardReconciliationReminderForStore({ session_id: sessionId, cwd: BOARD_PATH }, scopedStore);
  assert.match(reminder, /1 ticket in doing/);
});

test('stop reminder: holds a pending submission only while a live claim may submit', () => {
  const sessionId = `reconcile-wave-hold-${++fixtureState.sqSeq}`;
  const story = store.createStory(slug, { title: 'integration wave hold' });
  const submitted = addStopTicket('submission waits for the wave', { storyId: story.ref });
  claimStopTicket(submitted, sessionId, 'reconcile-wave-submission');
  assert.equal(store.submitTicket(slug, submitted.ref, 'reconcile-wave-submission', {
    commit: 'abc1234',
    sessionId,
  }).ok, true);
  const live = addStopTicket('live wave executor', { storyId: story.ref });
  const stopped = claimStopTicket(live, `reconcile-wave-live-${++fixtureState.sqSeq}`, 'reconcile-wave-live');

  try {
    const ready = runHookOutput(BOARD_RECONCILIATION_REMINDER, { session_id: sessionId, cwd: BOARD_PATH });
    assert.match(ready.hookSpecificOutput.additionalContext, /1 submission pending integration/);
    assert.doesNotMatch(ready.hookSpecificOutput.additionalContext, /live claim in progress/);
    assert.match(ready.hookSpecificOutput.additionalContext, /Integrate pending submissions now\./);

    assert.equal(store.addComment(slug, live.ref, {
      by: 'reconcile-wave-live',
      body: '[sidequest:verify-start] node --test plugins/sidequest/test/hooks.test.ts',
      source: 'test',
    }).ok, true);
    const verifying = runHookOutput(BOARD_RECONCILIATION_REMINDER, { session_id: sessionId, cwd: BOARD_PATH });
    assert.match(verifying.hookSpecificOutput.additionalContext, /1 live claim in progress/);
    assert.match(verifying.hookSpecificOutput.additionalContext, /Hold integration until 1 live claim becomes terminal\./);

    assert.equal(store.addComment(slug, live.ref, {
      by: 'reconcile-wave-live',
      body: '[sidequest:verify-complete] passed: hooks test passed',
      source: 'test',
    }).ok, true);
    const stateFile = path.join(SIDEQUEST_HOME, 'hook-state', `stop-reminder-${crypto.createHash('sha256').update(sessionId).digest('hex')}.json`);
    fs.rmSync(stateFile, { force: true });
    const submittedAfterPassingVerification = runHookOutput(BOARD_RECONCILIATION_REMINDER, { session_id: sessionId, cwd: BOARD_PATH });
    assert.match(submittedAfterPassingVerification.hookSpecificOutput.additionalContext, /Hold integration until 1 live claim becomes terminal\./);

    assert.equal(store.addComment(slug, live.ref, {
      by: 'reconcile-wave-live',
      body: '[sidequest:verify-start] node --test plugins/sidequest/test/hooks.test.ts',
      source: 'test',
    }).ok, true);
    assert.equal(store.addComment(slug, live.ref, {
      by: 'reconcile-wave-live',
      body: '[sidequest:verify-complete] failed-suite: hooks test failed',
      source: 'test',
    }).ok, true);
    const readyAfterFailedVerification = runHookOutput(BOARD_RECONCILIATION_REMINDER, { session_id: sessionId, cwd: BOARD_PATH });
    assert.match(readyAfterFailedVerification.hookSpecificOutput.additionalContext, /Integrate pending submissions now\./);
  } finally {
    assert.equal(recordTerminalAgentFailure(live, stopped).ok, true);
  }
});

test('stop reminder: requests integration after concurrent live claims become terminal', () => {
  const sessionId = `reconcile-wave-terminal-${++fixtureState.sqSeq}`;
  const story = store.createStory(slug, { title: 'integration wave terminal' });
  const submitted = addStopTicket('submission after the wave', { storyId: story.ref });
  claimStopTicket(submitted, sessionId, 'reconcile-wave-terminal-submission');
  assert.equal(store.submitTicket(slug, submitted.ref, 'reconcile-wave-terminal-submission', {
    commit: 'def5678',
    sessionId,
  }).ok, true);
  const firstLive = addStopTicket('first terminal wave executor', { storyId: story.ref });
  const secondLive = addStopTicket('second terminal wave executor', { storyId: story.ref });
  const firstStop = claimStopTicket(firstLive, `reconcile-wave-terminal-first-${++fixtureState.sqSeq}`, 'reconcile-wave-terminal-first');
  const secondStop = claimStopTicket(secondLive, `reconcile-wave-terminal-second-${++fixtureState.sqSeq}`, 'reconcile-wave-terminal-second');
  assert.equal(recordTerminalAgentFailure(firstLive, firstStop).ok, true);
  assert.equal(recordTerminalAgentFailure(secondLive, secondStop).ok, true);

  const output = runHookOutput(BOARD_RECONCILIATION_REMINDER, { session_id: sessionId, cwd: BOARD_PATH });
  assert.match(output.hookSpecificOutput.additionalContext, /1 submission pending integration/);
  assert.match(output.hookSpecificOutput.additionalContext, /Integrate pending submissions now\./);
});


test('stop reminder: emits once when the responsibility signature changes', () => {
  const sessionId = `reconcile-reset-${++fixtureState.sqSeq}`;
  const submitted = addTicket('reset reconciliation reminder');
  claimStopTicket(submitted, sessionId, 'reconcile-reset');
  assert.equal(store.submitTicket(slug, submitted.ref, 'reconcile-reset', {
    commit: 'def1234',
    sessionId,
  }).ok, true);

  const stateFile = path.join(SIDEQUEST_HOME, 'hook-state', `stop-reminder-${crypto.createHash('sha256').update(sessionId).digest('hex')}.json`);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ state: 'stale-signature' }));

  const output = runHookOutput(BOARD_RECONCILIATION_REMINDER, { session_id: sessionId, cwd: BOARD_PATH });
  assert.match(output.hookSpecificOutput.additionalContext, /1 submission pending integration/);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(stateFile, 'utf8'))), ['state']);
  assert.equal(runHookOutput(BOARD_RECONCILIATION_REMINDER, { session_id: sessionId, cwd: BOARD_PATH }), null);
});

test('stop reminder: overlapping processes atomically claim one responsibility', async () => {
  const sessionId = `reconcile-overlap-${++fixtureState.sqSeq}`;
  const ticket = addTicket('overlapping reconciliation responsibility');
  store.updateTicket(slug, ticket.ref, { labels: ['direct-ok'] });
  assert.equal(store.claimTicket(slug, ticket.ref, 'reconcile-overlap-worker', {
    direct: true,
    reason: 'Concurrent Stop responsibility fixture.',
    sessionId,
  }).ok, true);
  const stateFile = path.join(SIDEQUEST_HOME, 'hook-state', `stop-reminder-${crypto.createHash('sha256').update(sessionId).digest('hex')}.json`);
  const lockDirectory = `${stateFile}.lock-v2`;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  publishStateLock(lockDirectory, process.pid);
  const input = { session_id: sessionId, cwd: BOARD_PATH };

  const pending = Promise.all([
    runHookProcessForBudget(BOARD_RECONCILIATION_REMINDER, input),
    runHookProcessForBudget(BOARD_RECONCILIATION_REMINDER, input),
  ]);
  setTimeout(() => fs.rmSync(lockDirectory, { recursive: true, force: true }), 100);
  const results = await pending;
  assert.deepEqual(results.map((result) => result.status), [0, 0]);
  assert.equal(results.filter((result) => result.stdout.trim()).length, 1);
  assert.ok(results.every((result) => result.stderr === ''));
  assert.equal(runHookOutput(BOARD_RECONCILIATION_REMINDER, input), null);
});

test('stop reminder: two stale-lock cleaners preserve a live replacement generation', async () => {
  const sessionId = `reconcile-stale-cleaners-${++fixtureState.sqSeq}`;
  const ticket = addTicket('stale cleaner reconciliation responsibility');
  store.updateTicket(slug, ticket.ref, { labels: ['direct-ok'] });
  assert.equal(store.claimTicket(slug, ticket.ref, 'reconcile-stale-cleaner-worker', {
    direct: true,
    reason: 'Stale cleaner generation fixture.',
    sessionId,
  }).ok, true);
  const stateFile = path.join(SIDEQUEST_HOME, 'hook-state', `stop-reminder-${crypto.createHash('sha256').update(sessionId).digest('hex')}.json`);
  const lockDirectory = `${stateFile}.lock-v2`;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  publishStateLock(lockDirectory, 99999999);

  const staleGate = path.join(SIDEQUEST_HOME, `first-cleaner-${fixtureState.sqSeq}.gate`);
  const staleMarker = path.join(SIDEQUEST_HOME, `first-cleaner-${fixtureState.sqSeq}-inspected`);
  const cleanedMarker = path.join(SIDEQUEST_HOME, `first-cleaner-${fixtureState.sqSeq}-cleaned`);
  const firstAcquiredMarker = path.join(SIDEQUEST_HOME, `first-cleaner-${fixtureState.sqSeq}-acquired`);
  const replacementHoldGate = path.join(SIDEQUEST_HOME, `replacement-${fixtureState.sqSeq}.gate`);
  const replacementAcquiredMarker = path.join(SIDEQUEST_HOME, `replacement-${fixtureState.sqSeq}-acquired`);
  fs.writeFileSync(staleGate, 'hold');
  fs.writeFileSync(replacementHoldGate, 'hold');
  const input = { session_id: sessionId, cwd: BOARD_PATH };

  const first = runHookProcessForBudget(BOARD_RECONCILIATION_REMINDER, input, {
    SIDEQUEST_TEST_STOP_STALE_LOCK_GATE: staleGate,
    SIDEQUEST_TEST_STOP_STALE_LOCK_MARKER: staleMarker,
    SIDEQUEST_TEST_STOP_STALE_LOCK_CLEANED_MARKER: cleanedMarker,
    SIDEQUEST_TEST_STOP_LOCK_ACQUIRED_MARKER: firstAcquiredMarker,
  });
  await waitForPath(staleMarker);
  const replacement = runHookProcessForBudget(BOARD_RECONCILIATION_REMINDER, input, {
    SIDEQUEST_TEST_STOP_LOCK_ACQUIRED_MARKER: replacementAcquiredMarker,
    SIDEQUEST_TEST_STOP_LOCK_HOLD_GATE: replacementHoldGate,
  });
  await waitForPath(replacementAcquiredMarker);
  const replacementOwnerName = fs.readdirSync(lockDirectory).find((ownerName: string) => ownerName.startsWith('owner-'));
  assert.ok(replacementOwnerName);
  const replacementOwner = path.join(lockDirectory, replacementOwnerName);

  let results: HookProcessResult[];
  try {
    fs.rmSync(staleGate, { force: true });
    await waitForPath(cleanedMarker);
    assert.equal(fs.existsSync(replacementOwner), true, 'the first cleaner preserves the replacement generation');
    assert.equal(fs.existsSync(firstAcquiredMarker), false, 'the first cleaner cannot acquire through the live replacement');
  } finally {
    fs.rmSync(staleGate, { force: true });
    fs.rmSync(replacementHoldGate, { force: true });
    results = await Promise.all([first, replacement]);
  }
  assert.deepEqual(results.map((result) => result.status), [0, 0]);
  assert.equal(results.filter((result) => result.stdout.trim()).length, 1);
  assert.ok(results.every((result) => result.stderr === ''));
});

test('stop reminder: ignores this session\'s live dispatched tickets before and after the executor claims them', () => {
  const sessionId = `reconcile-live-${++fixtureState.sqSeq}`;
  const doing = addTicket('executor is verifying');
  const awaitingClaim = addTicket('executor is bound before its claim');
  claimStopTicket(doing, sessionId, 'reconcile-live-doing');
  const prepared = store.prepareDispatch(slug, awaitingClaim.ref, { allowUnscoped: true, sessionId });
  const agentId = `stop-agent-${awaitingClaim.id}-${++fixtureState.sqSeq}`;
  const agentName = `stop-executor-${awaitingClaim.id}-${fixtureState.sqSeq}`;
  assert.equal(store.recordDispatchLaunch(slug, awaitingClaim.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentId, agentName).ok, true);

  assert.equal(store.getTicket(slug, doing.ref).status, 'doing');
  assert.ok(store.getTicket(slug, awaitingClaim.ref).dispatch?.boundAt);
  assert.equal(runHookOutputForBudget(BOARD_RECONCILIATION_REMINDER, { session_id: sessionId, cwd: BOARD_PATH }), null);
});

test('stop reminder stays silent after a terminal failure releases its claim immediately', () => {
  const sessionId = `reconcile-terminal-${++fixtureState.sqSeq}`;
  const ticket = addTicket('dead executor');
  const stop = claimStopTicket(ticket, sessionId, 'reconcile-terminal');
  assert.equal(recordTerminalAgentFailure(ticket, stop).ok, true);
  assert.equal(store.getTicket(slug, ticket.ref).claim, null);

  assert.equal(runHookOutputForBudget(BOARD_RECONCILIATION_REMINDER, { session_id: sessionId, cwd: BOARD_PATH }), null);
});

test('stop reminder excludes live and already released terminal claims', () => {
  const sessionId = `reconcile-mixed-${++fixtureState.sqSeq}`;
  const live = addTicket('live executor');
  const dead = addTicket('dead executor');
  claimStopTicket(live, sessionId, 'reconcile-mixed-live');
  const stop = claimStopTicket(dead, sessionId, 'reconcile-mixed-dead');
  assert.equal(recordTerminalAgentFailure(dead, stop).ok, true);

  assert.equal(runHookOutputForBudget(BOARD_RECONCILIATION_REMINDER, { session_id: sessionId, cwd: BOARD_PATH }), null);
});test('stop reminder: stays silent for a quiet session and when nudges are off', () => {
  assert.equal(runHookOutput(BOARD_RECONCILIATION_REMINDER, {
    session_id: `reconcile-quiet-${++fixtureState.sqSeq}`,
    cwd: BOARD_PATH,
  }, { CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..') }), null);

  const sessionId = `reconcile-off-${++fixtureState.sqSeq}`;
  const ticket = addTicket('nudge disabled');
  claimStopTicket(ticket, sessionId, 'reconcile-off');
  assert.equal(runHookOutput(BOARD_RECONCILIATION_REMINDER, {
    session_id: sessionId,
    cwd: BOARD_PATH,
  }, { SIDEQUEST_NUDGE: 'off' }), null);
});

test('stop reminder: changed signatures during its continuation stay silent and require work, not acknowledgment', () => {
  const sessionId = `reconcile-continuation-${++fixtureState.sqSeq}`;
  const firstSubmission = addTicket('first continuing submission');
  claimStopTicket(firstSubmission, sessionId, 'reconcile-continuation-first');
  assert.equal(store.submitTicket(slug, firstSubmission.ref, 'reconcile-continuation-first', {
    commit: 'abc1234',
    sessionId,
  }).ok, true);

  const input = { session_id: sessionId, cwd: BOARD_PATH };
  const firstOutput = runHookOutput(BOARD_RECONCILIATION_REMINDER, input);
  assert.match(firstOutput.hookSpecificOutput.additionalContext, /Integrate pending submissions now\./);
  assert.match(firstOutput.hookSpecificOutput.additionalContext, /Continue working without replying to this reminder/);
  assert.match(firstOutput.hookSpecificOutput.additionalContext, /do not send an acknowledgment-only or progress reply/);

  const secondSubmission = addTicket('second continuing submission');
  claimStopTicket(secondSubmission, sessionId, 'reconcile-continuation-second');
  assert.equal(store.submitTicket(slug, secondSubmission.ref, 'reconcile-continuation-second', {
    commit: 'def5678',
    sessionId,
  }).ok, true);

  assert.equal(runHookOutput(BOARD_RECONCILIATION_REMINDER, {
    ...input,
    stop_hook_active: true,
  }), null, 'a Stop continuation stays silent even when a background submission changes the board signature');

  const transitioned = runHookOutput(BOARD_RECONCILIATION_REMINDER, input);
  assert.match(transitioned.hookSpecificOutput.additionalContext, /2 submissions pending integration/);
  assert.equal(runHookOutput(BOARD_RECONCILIATION_REMINDER, input), null);
});

export {};
