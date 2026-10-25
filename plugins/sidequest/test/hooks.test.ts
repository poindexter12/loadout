'use strict';
// SQ-137: one topic shard of the former hooks.test.ts, split so the runner can spread its tests
// across workers. Shared setup and helpers live in ./_hooks-fixture.ts; the tests are moved unchanged.
import {
  hookShardSources,
  test,
  assert,
  os,
  fs,
  path,
  crypto,
  spawn,
  store,
  worktrees,
  db,
  EFFORTS,
  stableReadOnlyClaudeName,
  stableReadOnlyDispatchName,
  BOARD_PATH,
  slug,
  database,
  SESSION,
  FORCE_BYPASS,
  INLINE_WORK_NUDGE,
  GUARD_SHARED_TREE_COMMIT,
  BUDGET,
  PLUGIN_ROOT,
  PINNED_ROOT_NAME_LENGTH,
  PINNED_ROOT_NAME,
  FIXED_PLUGIN_ROOT,
  RETIRED_SCOUT,
  runHookOutput,
  runHook,
  unpinnedBudgetTests,
  gitFixture,
  completeCheckoutCreation,
  preparedPrompt,
  addStopTicket,
  claimStopTicket,
  fixtureState,
} from './_hooks-fixture.js';

test('budget assertions must use a fixed plugin root', () => {
  const source = hookShardSources();
  assert.deepStrictEqual(unpinnedBudgetTests(source), [], 'budget assertions must use a budget helper that pins CLAUDE_PLUGIN_ROOT');

  const fixture = "test('fixture', () => { const ctx = runHook(SESSION); assert.ok(ctx.length <= BUDGET.session); });";
  assert.equal(unpinnedBudgetTests(fixture).length, 1, 'the guard must reject an unpinned budget assertion');
});

test('budget pin resolves to this checkout and isolates its fixed-length path', () => {
  assert.equal(path.basename(FIXED_PLUGIN_ROOT).length, PINNED_ROOT_NAME_LENGTH);
  assert.equal(fs.realpathSync(FIXED_PLUGIN_ROOT), PLUGIN_ROOT);

  const otherPluginRoot = `${PLUGIN_ROOT}-other`;
  const otherName = crypto.createHash('sha256').update(otherPluginRoot).digest('hex').slice(0, PINNED_ROOT_NAME_LENGTH);
  assert.notEqual(otherName, PINNED_ROOT_NAME);
});

test('pre-tool hook: exact Sidequest executors remain allowed and forced to bypass', () => {
  const original = {
    subagent_type: 'sidequest-exec-high',
    isolation: 'worktree',
    model: 'grade-3',
    name: 'sq36-srs-cards',
    prompt: 'work SQ-36',
  };
  const out = runHookOutput(FORCE_BYPASS, { tool_name: 'Agent', tool_input: original });
  assert.deepStrictEqual(out.hookSpecificOutput.updatedInput, {
    ...original,
    mode: 'bypassPermissions',
  });
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
});

test('pre-tool hook: a spawn prompt naming another ticket still records its launch', () => {
  // Spawn prompts carry ticket title, description, and anchors, so a ticket that
  // mentions another ticket puts two SQ refs in the prompt. Pairing refs to tokens
  // by counting them prompt-wide recorded no launch at all, and the executor then
  // failed its claim with unbound_dispatch (2026-08-07, sidequest 4.40.0).
  const ticket = store.createTicket(slug, {
    title: 'Four parameterised node kinds, following the pattern SQ-49 pinned',
    description: 'Mirror what SQ-51 established, and keep SQ-52 unaffected.',
    category: 'debugging',
    source: 'cli',
  });
  const sessionId = `prompt-extra-refs-${++fixtureState.sqSeq}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { allowUnscoped: true, sessionId });
  const prompt = preparedPrompt(prepared);

  runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    session_id: sessionId,
    cwd: BOARD_PATH,
    tool_input: {
      subagent_type: prepared.ticket.dispatchExecutor,
      isolation: 'worktree',
      name: 'sq-extra-refs',
      prompt,
    },
  });

  const launched = store.getTicket(slug, ticket.ref);
  assert.ok(launched.dispatch?.launchedAt, 'the launch must be recorded even when the prompt names other tickets');
});

test('pre-tool hook: a groomClosed executor is denied every later tool call', () => {
  const ticket = addStopTicket('terminal executor stops after grooming');
  const stop = claimStopTicket(ticket, `groom-closed-${++fixtureState.sqSeq}`, 'groomed-worker');
  assert.equal(store.releaseTicket(slug, ticket.ref, 'groomed-worker', {
    status: 'todo',
  }).ok, true);
  assert.equal(store.closeTicketForGrooming(slug, ticket.ref, {
    by: 'orchestrator',
    reason: 'The work was delivered outside the executor.',
  }).ok, true);

  const payload = {
    session_id: stop.session_id,
    agent_type: stop.agent_type,
    agent_id: stop.agent_id,
    cwd: BOARD_PATH,
    tool_input: { command: 'git status --short' },
  };
  for (const tool_name of ['Bash', 'mcp__plugin_sidequest_board__comment']) {
    const blocked = runHookOutput(FORCE_BYPASS, { ...payload, tool_name });
    assert.equal(blocked.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(blocked.hookSpecificOutput.permissionDecisionReason, new RegExp(ticket.ref));
    assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /groomClosed by orchestrator/);
    assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /End this turn now without further calls/);
  }
});

test('pre-tool hook: terminal guard leaves live and submitted executors alone', () => {
  const live = addStopTicket('live executor remains allowed');
  const liveStop = claimStopTicket(live, `terminal-live-${++fixtureState.sqSeq}`, 'live-worker');
  const liveResult = runHookOutput(FORCE_BYPASS, {
    session_id: liveStop.session_id,
    agent_type: liveStop.agent_type,
    agent_id: liveStop.agent_id,
    tool_name: 'Bash',
    tool_input: { command: 'git status --short' },
  });
  assert.equal(liveResult, null);

  const submitted = addStopTicket('submitted executor remains allowed');
  const submittedStop = claimStopTicket(submitted, `terminal-submitted-${++fixtureState.sqSeq}`, 'submitted-worker');
  assert.equal(store.submitTicket(slug, submitted.ref, 'submitted-worker', {
    commit: 'a'.repeat(40),
    range: {
      base: 'b'.repeat(40), upstream: 'main', upstreamCommit: 'c'.repeat(40), commits: [], changedPaths: [], noOp: true,
    },
  }).ok, true);
  const submittedResult = runHookOutput(FORCE_BYPASS, {
    session_id: submittedStop.session_id,
    agent_type: submittedStop.agent_type,
    agent_id: submittedStop.agent_id,
    tool_name: 'Bash',
    tool_input: { command: 'git status --short' },
  });
  assert.equal(submittedResult, null);
});

test('pre-tool hook: an executor cannot redispatch its own active ticket', () => {
  const ticket = store.createTicket(slug, {
    title: 'own dispatch refusal fixture',
    category: 'debugging',
    source: 'cli',
  });
  const sessionId = `own-dispatch-${++fixtureState.sqSeq}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { allowUnscoped: true, sessionId });
  const agentId = `own-dispatch-agent-${fixtureState.sqSeq}`;
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName: agentId,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentId, agentId).ok, true);

  const payload = {
    session_id: sessionId,
    agent_type: prepared.ticket.dispatchExecutor,
    agent_id: agentId,
    cwd: BOARD_PATH,
    tool_name: 'mcp__plugin_sidequest_board__dispatch',
    tool_input: { ref: ticket.ref, project: BOARD_PATH },
  };
  const blocked = runHookOutput(FORCE_BYPASS, payload);
  assert.equal(blocked.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, new RegExp(ticket.ref));
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /Release.*with a reason/i);
  assert.equal(runHookOutput(FORCE_BYPASS, { ...payload, agent_id: 'unrelated-agent' }), null);

  const shellBlocked = runHookOutput(FORCE_BYPASS, {
    ...payload,
    tool_name: 'Bash',
    tool_input: { command: `sidequest dispatch ${ticket.ref}` },
  });
  assert.equal(shellBlocked.hookSpecificOutput.permissionDecision, 'deny');
});

test('pre-tool hook: shared-tree claims cannot run raw git commit', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-shared-commit-'));
  gitFixture(['init', '-b', 'main', '--quiet'], projectPath);
  gitFixture(['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], projectPath);
  const project = store.ensureProject(projectPath).slug;
  const ticket = store.createTicket(project, { title: 'shared commit guard', category: 'debugging', source: 'cli' });
  const sessionId = `shared-commit-${++fixtureState.sqSeq}`;
  const prepared = store.prepareDispatch(project, ticket.ref, { allowUnscoped: true, sessionId, sharedTree: true });
  const agentId = `shared-commit-agent-${fixtureState.sqSeq}`;
  assert.equal(store.recordDispatchLaunch(project, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName: agentId,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentId, agentId).ok, true);
  assert.equal(store.claimTicket(project, ticket.ref, 'shared-commit-worker', {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);

  const payload = {
    session_id: sessionId,
    agent_type: prepared.ticket.dispatchExecutor,
    agent_id: agentId,
    cwd: projectPath,
    tool_name: 'Bash',
    tool_input: { command: 'git commit -m "bypass"' },
  };
  const blocked = runHookOutput(GUARD_SHARED_TREE_COMMIT, payload);
  assert.equal(blocked.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, new RegExp(ticket.ref));
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /mcp__plugin_sidequest_board__commit/);

  assert.equal(runHookOutput(GUARD_SHARED_TREE_COMMIT, { ...payload, agent_id: 'unrelated-agent' }), null);
  assert.equal(runHookOutput(GUARD_SHARED_TREE_COMMIT, payload, {
    CLAUDE_PLUGIN_ROOT: path.join(os.tmpdir(), 'missing-sidequest-plugin'),
  }), null);
});

test('pre-tool hook: readonly Claude executors bypass while dispatch executors require preparation', () => {
  for (const effort of EFFORTS) {
    const claude = runHookOutput(FORCE_BYPASS, {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: stableReadOnlyClaudeName(effort),
        model: 'sonnet',
        prompt: `Review SQ-1 at ${effort} effort.`,
      },
    });
    assert.equal(claude.hookSpecificOutput.permissionDecision, undefined);
    assert.equal(claude.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');

    const dispatch = runHookOutput(FORCE_BYPASS, {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: stableReadOnlyDispatchName(effort),
        model: 'fable',
        prompt: `Review SQ-1.\n[sidequest-route model=gpt-5.6-sol effort=${effort}]`,
      },
    });
    assert.equal(dispatch.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(dispatch.hookSpecificOutput.permissionDecisionReason, /requires the exact prepared FIRST action briefing command/);
  }
});

test('pre-tool hook: native Explore and approved harness utilities pass through unchanged', () => {
  for (const subagent_type of ['Explore', 'claude-code-guide', 'statusline-setup']) {
    assert.equal(runHookOutput(FORCE_BYPASS, {
      tool_name: 'Agent',
      tool_input: { subagent_type, isolation: 'worktree', prompt: 'Read-only reconnaissance.' },
    }), null, subagent_type);
  }
  for (const subagent_type of ['claude-code-guide', 'statusline-setup']) {
    assert.equal(runHookOutput(FORCE_BYPASS, {
      session_id: `utility-${subagent_type}-${Date.now()}`, cwd: BOARD_PATH,
      tool_name: 'Agent',
      tool_input: { subagent_type, prompt: 'Read-only reconnaissance.' },
    }), null, `${subagent_type} stays untouched on a routed board`);
  }
});

test('pre-tool hook: main-session Explore on a routed board nudges twice then denies fan-out', () => {
  const session_id = `explore-fanout-${Date.now()}`;
  const spawn = (round: number) => runHookOutput(FORCE_BYPASS, {
    session_id, cwd: BOARD_PATH, tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', prompt: `Sweep the hooks directory, angle ${round}.` },
  });
  for (const round of [1, 2]) {
    const out = spawn(round);
    assert.equal(out.hookSpecificOutput.permissionDecision, undefined, `spawn ${round}`);
    assert.match(out.hookSpecificOutput.additionalContext, /quick evidence sweeps/);
    assert.match(out.hookSpecificOutput.additionalContext, /inherits the session model/);
    assert.match(out.hookSpecificOutput.additionalContext, /codebase-exploration/);
  }
  const denied = spawn(3);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /Explore spawn 3 this session with no board interaction/);
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /codebase-exploration/);
  assert.match(spawn(4).hookSpecificOutput.permissionDecisionReason, /no board interaction/, 'a denied spawn does not consume a pass');
});

test('pre-tool hook: board interaction lifts the Explore fan-out cap', () => {
  const session_id = `explore-board-${Date.now()}`;
  runHookOutput(INLINE_WORK_NUDGE, {
    session_id, cwd: BOARD_PATH, tool_name: 'mcp__plugin_sidequest_board__claim', tool_input: {},
  });
  for (let round = 1; round <= 4; round += 1) {
    const out = runHookOutput(FORCE_BYPASS, {
      session_id, cwd: BOARD_PATH, tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: `Sweep the docs tree, angle ${round}.` },
    });
    if (round <= 2) {
      assert.match(out.hookSpecificOutput.additionalContext, /quick evidence sweeps/, `spawn ${round}`);
    } else {
      assert.equal(out, null, `spawn ${round} passes silently after board interaction`);
    }
  }
});

test('pre-tool hook: denied generic work cannot relaunch as Explore', () => {
  const session_id = `explore-reroute-${Date.now()}`;
  const prompt = 'Deep dive: map every hook injection surface and report the guidance gaps.';
  const denied = runHookOutput(FORCE_BYPASS, {
    session_id, cwd: BOARD_PATH, tool_name: 'Agent',
    tool_input: { subagent_type: 'general-purpose', description: 'Hook surface deep dive', prompt },
  });
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');

  const sameDescription = runHookOutput(FORCE_BYPASS, {
    session_id, cwd: BOARD_PATH, tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', description: 'Hook surface deep dive', prompt: 'Different text entirely.' },
  });
  assert.equal(sameDescription.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(sameDescription.hookSpecificOutput.permissionDecisionReason, /the work, not the agent type/);
  assert.match(sameDescription.hookSpecificOutput.permissionDecisionReason, /rerouting denied work through Explore is a violation/);

  const samePrompt = runHookOutput(FORCE_BYPASS, {
    session_id, cwd: BOARD_PATH, tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', prompt: `  ${prompt.toUpperCase()}  ` },
  });
  assert.equal(samePrompt.hookSpecificOutput.permissionDecision, 'deny', 'prompt matching survives case and whitespace changes');

  const helper = runHookOutput(FORCE_BYPASS, {
    session_id, cwd: BOARD_PATH, agent_id: 'exec-helper', agent_type: 'sidequest-exec-dispatch',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', model: 'haiku', prompt },
  });
  assert.equal(helper.hookSpecificOutput.permissionDecision, undefined, 'executor Explore helpers bypass the fan-out guard');
  assert.equal(helper.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');
});

test('pre-tool hook: the Explore guard stays out of unrouted and unidentified sessions', () => {
  store.setProjectRouting(slug, 'disabled');
  try {
    assert.equal(runHookOutput(FORCE_BYPASS, {
      session_id: `explore-disabled-${Date.now()}`, cwd: BOARD_PATH, tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'Sweep the repo.' },
    }), null, 'routing-disabled boards leave Explore alone');
  } finally {
    store.setProjectRouting(slug, 'enabled');
  }
  assert.equal(runHookOutput(FORCE_BYPASS, {
    cwd: BOARD_PATH, tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', prompt: 'Sweep the repo.' },
  }, { CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' }), null, 'no session id means no tracking');
});

test('pre-tool hook: a bounded read-only diagnostic probe may self-test dispatch', () => {
  const probe = {
    subagent_type: 'sidequest-diagnostic-probe',
    description: 'Sidequest dispatch self-test.',
    prompt: 'Diagnose Sidequest dispatch machinery. Read package.json, then report whether the Agent spawn can use a read-only tool.',
  };
  const out = runHookOutput(FORCE_BYPASS, { tool_name: 'Agent', tool_input: probe });
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(out.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');

  for (const tool_input of [
    { ...probe, prompt: 'Implement the new flow.' },
    { ...probe, isolation: 'worktree' },
    { ...probe, model: 'sonnet' },
  ]) {
    const denied = runHookOutput(FORCE_BYPASS, { tool_name: 'Agent', tool_input });
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /reserved for a foreground dispatch self-test/);
  }
});

test('pre-tool hook: arbitrary implementation agents are denied and directed to ticketed routes', () => {
  for (const [subagent_type, prompt] of [
    ['web-researcher', 'Research the latest routing guidance.'],
    ['implementation-agent', 'Implement the new flow.'],
  ]) {
    const out = runHookOutput(FORCE_BYPASS, {
      cwd: BOARD_PATH, tool_name: 'Agent',
      tool_input: { subagent_type, isolation: 'worktree', prompt },
    });
    const reason = out.hookSpecificOutput.permissionDecisionReason;
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', subagent_type);
    assert.match(reason, /generic Agent, not a Sidequest ticket executor/);
    assert.match(reason, /Read, Glob, Grep, or WebFetch inline, not WebSearch/);
    assert.match(reason, /A usable route needs a fresh Board MCP dispatch and its exact returned executor/);
    assert.match(reason, /Board MCP is the lifecycle authority: reload or reconnect Sidequest, then re-dispatch/);
    assert.match(reason, /Do not use a raw Agent or Sidequest CLI fallback/);
    assert.match(reason, /quick investigation, needs a ticket: file a spike/);
    assert.match(reason, /codebase-exploration/);
    assert.match(reason, /route it, dispatch it, then spawn the returned executor/);
    assert.match(reason, /blocked work still gates any dependent action/);
    assert.match(reason, /do not proceed to a PR, merge, publish, or ship until its ticket is filed, dispatched, and closed/);
    assert.match(reason, /rerouting around this block is a violation/);
    assert.doesNotMatch(reason, /sidequest-diagnostic-probe only|WebSearch is executor-only/);
  }
  const mismatch = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-invalid', isolation: 'worktree', prompt: 'Quick lookup.' },
  });
  assert.equal(mismatch.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(
    mismatch.hookSpecificOutput.permissionDecisionReason,
    'sidequest: sidequest-invalid is an unknown Sidequest agent type. Use the executor returned by dispatch.'
  );
  assert.doesNotMatch(mismatch.hookSpecificOutput.permissionDecisionReason, /update\+reload|version mismatch/);
  const malformedExecutor = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-readonly-ultra', prompt: 'Quick lookup.' },
  });
  assert.match(malformedExecutor.hookSpecificOutput.permissionDecisionReason, /looks like a Sidequest executor name but is invalid or retired/);
  assert.doesNotMatch(malformedExecutor.hookSpecificOutput.permissionDecisionReason, /update\+reload|version mismatch/);
  assert.doesNotMatch(mismatch.hookSpecificOutput.permissionDecisionReason, new RegExp(RETIRED_SCOUT));
});

test('pre-tool hook: executor helpers allow mechanical sweeps with parent-tree safeguards', () => {
  for (const subagent_type of ['Explore', 'claude-code-guide', 'web-researcher', 'general-purpose']) {
    const out = runHookOutput(FORCE_BYPASS, {
      agent_id: `native-task@${subagent_type}`,
      agent_type: 'sidequest-exec-dispatch',
      tool_name: 'Agent',
      tool_input: {
        subagent_type,
        model: 'haiku',
        isolation: 'worktree',
        run_in_background: false,
        prompt: 'Locate matching test fixtures in the parent worktree without editing.',
      },
    });
    assert.equal(out.hookSpecificOutput.updatedInput.model, 'haiku', subagent_type);
    assert.equal(out.hookSpecificOutput.updatedInput.mode, 'bypassPermissions', subagent_type);
    assert.equal(out.hookSpecificOutput.updatedInput.run_in_background, true, subagent_type);
    assert.equal(out.hookSpecificOutput.updatedInput.isolation, undefined, subagent_type);
    assert.match(out.hookSpecificOutput.updatedInput.prompt, /quoted ticket strings appear in this session’s context/);
    assert.match(out.hookSpecificOutput.updatedInput.prompt, /self-reference, not evidence/);
    assert.match(out.hookSpecificOutput.updatedInput.prompt, /report a visibility block rather than a finding/);
    assert.match(out.systemMessage, /background from the parent working tree/);
    assert.match(out.systemMessage, /report the visibility block instead of returning clean findings/);
  }
});

test('pre-tool hook: helper session transcript hits are self-reference', () => {
  const transcriptPath = path.join(os.tmpdir(), 'sq-current-session.jsonl');
  const out = runHookOutput(FORCE_BYPASS, {
    agent_id: 'evidence-helper',
    agent_type: 'sidequest-exec-dispatch',
    transcript_path: transcriptPath,
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', model: 'haiku', prompt: 'Find quoted evidence.' },
  });
  const prompt = out.hookSpecificOutput.updatedInput.prompt;
  assert.match(prompt, /self-reference, not evidence/);
  assert.match(prompt, /report it as such/);
  assert.match(prompt, /Current session self-reference locations:/);
  assert.ok(prompt.includes(transcriptPath));
  assert.ok(prompt.includes(path.join(path.dirname(transcriptPath), 'subagents')));
});

test('pre-tool hook: executor helpers reject review work and model defaults', () => {
  for (const subagent_type of ['Explore', 'claude-code-guide', 'web-researcher', 'general-purpose']) {
    const review = runHookOutput(FORCE_BYPASS, {
      agent_id: `review-helper-${subagent_type}`,
      agent_type: 'sidequest-exec-dispatch',
      tool_name: 'Agent',
      tool_input: {
        subagent_type,
        model: 'haiku',
        isolation: 'worktree',
        description: 'Inspect the parent work.',
        prompt: 'Audit the ticket-scoped storage API.',
      },
    });
    assert.equal(review.hookSpecificOutput.permissionDecision, 'deny', subagent_type);
    assert.match(review.hookSpecificOutput.permissionDecisionReason, /review-audit/, subagent_type);
    assert.doesNotMatch(review.hookSpecificOutput.permissionDecisionReason, /Use Explore|claude-code-guide|web-researcher/, subagent_type);
  }

  for (const prompt of ['Audits the ticket-scoped storage API.', 'Reviews the ticket-scoped storage API.']) {
    const review = runHookOutput(FORCE_BYPASS, {
      agent_id: `plural-review-helper-${prompt[0]}`,
      agent_type: 'sidequest-exec-dispatch',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', model: 'haiku', prompt },
    });
    assert.equal(review.hookSpecificOutput.permissionDecision, 'deny', prompt);
    assert.match(review.hookSpecificOutput.permissionDecisionReason, /review-audit/, prompt);
  }

  const reviewDescription = runHookOutput(FORCE_BYPASS, {
    agent_id: 'review-description-helper',
    agent_type: 'sidequest-exec-dispatch',
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'general-purpose',
      model: 'haiku',
      description: 'Act as a reviewer for the parent work.',
      prompt: 'Locate the relevant test fixture.',
    },
  });
  assert.equal(reviewDescription.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(reviewDescription.hookSpecificOutput.permissionDecisionReason, /review-audit/);

  const defaulted = runHookOutput(FORCE_BYPASS, {
    agent_id: 'defaulted-helper',
    agent_type: 'sidequest-exec-dispatch',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', prompt: 'Read the parent diff.' },
  });
  assert.equal(defaulted.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(defaulted.hookSpecificOutput.permissionDecisionReason, /needs an explicit Agent model/);
  assert.match(defaulted.hookSpecificOutput.permissionDecisionReason, /do not inherit the parent route/);

  const chained = runHookOutput(FORCE_BYPASS, {
    agent_id: 'already-running-helper',
    agent_type: 'general-purpose',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', model: 'haiku', prompt: 'Read the parent diff.' },
  });
  assert.equal(chained.hookSpecificOutput.updatedInput.run_in_background, true);

  const mainThread = runHookOutput(FORCE_BYPASS, {
    cwd: BOARD_PATH,
    agent_type: 'sidequest-exec-dispatch',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'general-purpose', prompt: 'Quick lookup.' },
  });
  assert.equal(mainThread.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(mainThread.hookSpecificOutput.permissionDecisionReason, /generic Agent, not a Sidequest ticket executor/);
});

test('pre-tool hook: a generated per-ticket executor definition owns its ticket by name', () => {
  // A per-ticket definition spawns under the dispatch's agentName as its subagent_type, and
  // its runtime id never binds, so matching on agentId alone refused every edit it made
  // (contractify, 2026-08-05: two executors blocked identically, wave stalled).
  const ticket = addStopTicket('generated definition scope', { files: ['lib/allowed.js'] });
  const sessionId = `generated-definition-${++fixtureState.sqSeq}`;
  // A second live ticket in the same session is what makes this bite: with only one,
  // the sole-active-ticket fallback masks a failed identity match (contractify ran
  // SQ-64 and SQ-85 concurrently).
  claimStopTicket(addStopTicket('concurrent generated sibling', { files: ['lib/sibling.js'] }), sessionId, 'generated-sibling');
  const prepared = store.prepareDispatch(slug, ticket.ref, { allowUnscoped: true, sessionId });
  const agentName = `asq-${ticket.id}-generated-${fixtureState.sqSeq}`;
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName,
  }).ok, true);
  assert.equal(store.claimTicket(slug, ticket.ref, 'generated-definition-claim', {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  const worktree = path.join(BOARD_PATH, '.claude', 'worktrees', `agent-${agentName}`);
  // The runtime name is DERIVED from the launch name: "a" + name + "-" + hash.
  const runtimeName = `a${agentName}-207bbcf0be435ec2`;
  const acting = { session_id: sessionId, agent_type: runtimeName, agent_id: runtimeName, cwd: worktree };

  assert.equal(runHookOutput(FORCE_BYPASS, {
    ...acting,
    tool_name: 'Write',
    tool_input: { file_path: path.join(worktree, 'lib', 'allowed.js') },
  }), null);

  const outside = runHookOutput(FORCE_BYPASS, {
    ...acting,
    tool_name: 'Write',
    tool_input: { file_path: path.join(worktree, 'lib', 'elsewhere.js') },
  });
  assert.equal(outside.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(outside.hookSpecificOutput.permissionDecisionReason, /effective scope/);
});

test('pre-tool hook: an unbound helper inherits the sole active ticket', () => {
  // The helper's own id never binds to a dispatch. With exactly one active ticket in the
  // session there is nothing to borrow from, so refusing it only blocked legitimate work.
  const ticket = addStopTicket('sole active helper scope', { files: ['lib/allowed.js'] });
  const sessionId = `sole-active-helper-${++fixtureState.sqSeq}`;
  const parent = claimStopTicket(ticket, sessionId, 'sole-active-parent');
  const worktree = path.join(BOARD_PATH, '.claude', 'worktrees', 'sq-sole-active');
  const helper = {
    ...parent,
    agent_type: 'general-purpose',
    agent_id: `unbound-helper-${++fixtureState.sqSeq}`,
    cwd: worktree,
  };

  assert.equal(runHookOutput(FORCE_BYPASS, {
    ...helper,
    tool_name: 'Write',
    tool_input: { file_path: path.join(worktree, 'lib', 'allowed.js') },
  }), null);

  const outside = runHookOutput(FORCE_BYPASS, {
    ...helper,
    tool_name: 'Write',
    tool_input: { file_path: path.join(worktree, 'lib', 'elsewhere.js') },
  });
  assert.equal(outside.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(outside.hookSpecificOutput.permissionDecisionReason, /effective scope/);
});

test('pre-tool hook: a steer between turns is delivered, but a terminal failure is recorded', () => {
  const ticket = addStopTicket('late steer capture', { files: ['lib/allowed.js'] });
  const sessionId = `late-steer-${++fixtureState.sqSeq}`;
  const acting = claimStopTicket(ticket, sessionId, 'late-steer-worker');
  assert.equal(store.markDispatchStopped(sessionId, acting.agent_type, acting.agent_id, acting.agent_name).ok, true);

  const steer = {
    session_id: sessionId,
    agent_id: 'orchestrator-late-steer',
    tool_name: 'SendMessage',
    tool_input: { to: acting.agent_name, message: 'Prefer type filters over content search.' },
  };
  assert.equal(runHookOutput(FORCE_BYPASS, steer), null);

  const dispatch = store.getTicket(slug, ticket.ref).dispatch;
  assert.equal(store.recordDispatchAgentFailure(slug, ticket.ref, {
    token: store.getTicket(slug, ticket.ref).dispatchNonce,
    executor: dispatch.executor,
    sessionId,
    taskName: acting.agent_name,
    agentId: acting.agent_id,
    agentName: acting.agent_name,
    error: 'Prompt is too long',
  }).ok, true);
  const denied = runHookOutput(FORCE_BYPASS, steer);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  const reason = denied.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, new RegExp(ticket.ref));
  assert.match(reason, /now a comment on the ticket/);
  assert.match(reason, /Re-dispatch/);

  const bodies = store.getTicket(slug, ticket.ref).comments.map((comment: any) => comment.body);
  assert.ok(bodies.some((body: string) => /Late steer/.test(body) && /Prefer type filters over content search\./.test(body)), bodies.join(' | '));
});

test('pre-tool hook: a steer to a live executor is untouched', () => {
  const ticket = addStopTicket('live steer passthrough', { files: ['lib/allowed.js'] });
  const sessionId = `live-steer-${++fixtureState.sqSeq}`;
  const acting = claimStopTicket(ticket, sessionId, 'live-steer-worker');

  assert.equal(runHookOutput(FORCE_BYPASS, {
    session_id: sessionId,
    agent_id: 'orchestrator-live-steer',
    tool_name: 'SendMessage',
    tool_input: { to: acting.agent_name, message: 'Check the fixture before you commit.' },
  }), null);

  assert.equal(runHookOutput(FORCE_BYPASS, {
    session_id: sessionId,
    agent_id: 'orchestrator-live-steer',
    tool_name: 'SendMessage',
    tool_input: { to: 'some-unrelated-teammate', message: 'Ping.' },
  }), null);
});

test('executor template calls transcript evidence self-reference', () => {
  const template = fs.readFileSync(path.join(__dirname, '..', 'scripts', '_exec-template.md'), 'utf8');
  assert.match(template, /Evidence work that needs session, transcript, or task-output searching is not helper work/);
  assert.match(template, /a match there is self-reference, not evidence/);
  assert.match(template, /report a visibility block rather than a finding/);
});

test('pre-tool hook: helper writes use the bound agent scope in linked worktrees', () => {
  const parentTicket = addStopTicket('helper scope capability', { files: ['lib/allowed.js'] });
  const sessionId = `helper-scope-${++fixtureState.sqSeq}`;
  const parent = claimStopTicket(parentTicket, sessionId, 'helper-parent');
  const siblingTicket = addStopTicket('concurrent helper scope', { files: ['lib/sibling.js'] });
  claimStopTicket(siblingTicket, sessionId, 'helper-sibling');
  const worktree = path.join(BOARD_PATH, '.claude', 'worktrees', 'sq-538-river-bluffs');
  const helper = {
    ...parent,
    agent_type: 'general-purpose',
    cwd: worktree,
  };
  const inside = runHookOutput(FORCE_BYPASS, {
    ...helper,
    tool_name: 'Write',
    tool_input: { file_path: path.join(worktree, 'lib', 'allowed.js') },
  });
  assert.equal(inside, null);

  const outside = runHookOutput(FORCE_BYPASS, {
    ...helper,
    tool_name: 'Write',
    tool_input: { file_path: path.join(worktree, 'lib', 'sibling.js') },
  });
  const reason = outside.hookSpecificOutput.permissionDecisionReason;
  assert.equal(outside.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(reason, /lib[\\/]sibling\.js/);
  assert.match(reason, new RegExp(parentTicket.ref));
  assert.doesNotMatch(reason, new RegExp(siblingTicket.ref));
  assert.match(reason, /effective scope/);

  const unbound = runHookOutput(FORCE_BYPASS, {
    ...helper,
    agent_id: `unbound-helper-${fixtureState.sqSeq}`,
    tool_name: 'Write',
    tool_input: { file_path: path.join(worktree, 'lib', 'outside.js') },
  });
  assert.equal(unbound.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(unbound.hookSpecificOutput.permissionDecisionReason, /No active ticket is bound to acting agent/);
  assert.doesNotMatch(unbound.hookSpecificOutput.permissionDecisionReason, new RegExp(parentTicket.ref));
  assert.doesNotMatch(unbound.hookSpecificOutput.permissionDecisionReason, new RegExp(siblingTicket.ref));

  const scratchpad = path.join(os.tmpdir(), 'claude', `helper-scratchpad-${fixtureState.sqSeq}`, 'temp.js');
  const scratchpadWrite = runHookOutput(FORCE_BYPASS, {
    ...helper,
    tool_name: 'Write',
    tool_input: { file_path: scratchpad },
  });
  assert.equal(scratchpadWrite, null);

  const read = runHookOutput(FORCE_BYPASS, {
    ...helper,
    tool_name: 'Read',
    tool_input: { file_path: path.join(worktree, 'lib', 'outside.js') },
  });
  assert.equal(read, null);
});

test('pre-tool hook: helpers write only canonically contained owned verification evidence', () => {
  const ownerTicket = addStopTicket('owned helper evidence', { files: ['lib/allowed.js'] });
  const sessionId = `helper-evidence-${++fixtureState.sqSeq}`;
  const owner = claimStopTicket(ownerTicket, sessionId, 'helper-evidence-owner');
  const siblingTicket = addStopTicket('sibling helper evidence', { files: ['lib/sibling.js'] });
  claimStopTicket(siblingTicket, sessionId, 'helper-evidence-sibling');
  const evidenceDirectory = store.getTicket(slug, ownerTicket.ref).dispatch.evidenceDirectory;
  const siblingEvidenceDirectory = store.getTicket(slug, siblingTicket.ref).dispatch.evidenceDirectory;
  const helper = {
    ...owner,
    agent_id: `${owner.agent_name}-researcher`,
    agent_type: 'general-purpose',
    cwd: BOARD_PATH,
  };
  assert.notEqual(helper.agent_id, owner.agent_id, 'the helper must be a distinct identity admitted by the recorded owner name');

  assert.equal(runHookOutput(FORCE_BYPASS, {
    ...helper,
    tool_name: 'Write',
    tool_input: { file_path: path.join(evidenceDirectory, 'owned-probe.log') },
  }), null, 'an admitted helper may write its resolved owner’s evidence child');

  const foreignEvidence = runHookOutput(FORCE_BYPASS, {
    ...helper,
    tool_name: 'Write',
    tool_input: { file_path: path.join(siblingEvidenceDirectory, 'sibling-probe.log') },
  });
  assert.equal(foreignEvidence.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(foreignEvidence.hookSpecificOutput.permissionDecisionReason, /Board-owned verification evidence/);
  assert.match(foreignEvidence.hookSpecificOutput.permissionDecisionReason, /Do not request scope/);

  const scratchpad = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-helper-evidence-scratch-'));
  const foreignEvidenceAlias = path.join(scratchpad, 'foreign-evidence');
  try {
    fs.symlinkSync(siblingEvidenceDirectory, foreignEvidenceAlias, process.platform === 'win32' ? 'junction' : 'dir');
    const scratchAliasForeignEvidence = runHookOutput(FORCE_BYPASS, {
      ...helper,
      tool_name: 'Write',
      tool_input: { file_path: path.join(foreignEvidenceAlias, 'through-alias.log') },
    }, { CLAUDE_SCRATCHPAD_DIR: scratchpad });
    assert.equal(
      scratchAliasForeignEvidence.hookSpecificOutput.permissionDecision,
      'deny',
      'canonical foreign evidence ownership takes precedence over raw scratchpad allowance',
    );
    assert.match(scratchAliasForeignEvidence.hookSpecificOutput.permissionDecisionReason, /Board-owned verification evidence/);
  } finally {
    fs.rmSync(scratchpad, { recursive: true, force: true });
  }

  const siblingPrefix = runHookOutput(FORCE_BYPASS, {
    ...helper,
    tool_name: 'Write',
    tool_input: { file_path: `${evidenceDirectory}-sibling${path.sep}probe.log` },
  });
  assert.equal(siblingPrefix.hookSpecificOutput.permissionDecision, 'deny');

  const parentTraversal = runHookOutput(FORCE_BYPASS, {
    ...helper,
    tool_name: 'Write',
    tool_input: { file_path: `${evidenceDirectory}${path.sep}..${path.sep}escaped-probe.log` },
  });
  assert.equal(parentTraversal.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(parentTraversal.hookSpecificOutput.permissionDecisionReason, /Board-owned verification evidence/);
  assert.doesNotMatch(parentTraversal.hookSpecificOutput.permissionDecisionReason, /Ask the parent executor to request scope/);

  const escapedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-helper-evidence-escape-'));
  const escapeLink = path.join(evidenceDirectory, 'escape');
  try {
    fs.symlinkSync(escapedDirectory, escapeLink, process.platform === 'win32' ? 'junction' : 'dir');
    const symlinkEscape = runHookOutput(FORCE_BYPASS, {
      ...helper,
      tool_name: 'Write',
      tool_input: { file_path: path.join(escapeLink, 'escaped-probe.log') },
    });
    assert.equal(symlinkEscape.hookSpecificOutput.permissionDecision, 'deny');
  } finally {
    fs.rmSync(escapeLink, { recursive: true, force: true });
    fs.rmSync(escapedDirectory, { recursive: true, force: true });
  }

  const ambiguousHelper = runHookOutput(FORCE_BYPASS, {
    ...helper,
    agent_id: `unbound-helper-${fixtureState.sqSeq}`,
    tool_name: 'Write',
    tool_input: { file_path: path.join(evidenceDirectory, 'ambiguous-probe.log') },
  });
  assert.equal(ambiguousHelper.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(ambiguousHelper.hookSpecificOutput.permissionDecisionReason, /No active ticket is bound/);

  const terminalTicket = addStopTicket('terminal helper evidence', { files: ['lib/terminal.js'] });
  const terminalSessionId = `terminal-helper-evidence-${++fixtureState.sqSeq}`;
  const terminalOwner = claimStopTicket(terminalTicket, terminalSessionId, 'terminal-helper-evidence-owner');
  const terminalEvidenceDirectory = store.getTicket(slug, terminalTicket.ref).dispatch.evidenceDirectory;
  assert.equal(store.releaseTicket(slug, terminalTicket.ref, 'terminal-helper-evidence-owner', { status: 'todo' }).ok, true);
  const terminalHelper = runHookOutput(FORCE_BYPASS, {
    ...terminalOwner,
    agent_id: `${terminalOwner.agent_name}-researcher`,
    agent_type: 'general-purpose',
    cwd: BOARD_PATH,
    tool_name: 'Write',
    tool_input: { file_path: path.join(terminalEvidenceDirectory, 'terminal-probe.log') },
  });
  assert.equal(terminalHelper.hookSpecificOutput.permissionDecision, 'deny');
});

test('pre-tool hook: helper writes honor granted scope rulings and descendant globs', () => {
  const grantedTicket = addStopTicket('granted helper scope', { files: ['lib/declared.js'] });
  const grantedSession = `granted-helper-${++fixtureState.sqSeq}`;
  const grantedActor = claimStopTicket(grantedTicket, grantedSession, 'granted-helper-parent');
  const granted = store.getTicket(slug, grantedTicket.ref);
  granted.scopeResolution = {
    state: 'granted',
    requested: ['lib/granted.js'],
    granted: ['lib/granted.js'],
    refused: [],
    at: new Date().toISOString(),
  };
  db.putRow(database, 'tickets', {
    id: granted.id, project: slug, ref: granted.ref, status: granted.status,
    archived: granted.archived ? 1 : 0, ord: granted.order, claim_by: granted.claim.by, data: granted,
  });
  const worktree = path.join(BOARD_PATH, '.claude', 'worktrees', 'sq-granted-helper');
  const helper = { ...grantedActor, agent_type: 'general-purpose', cwd: worktree };

  assert.equal(runHookOutput(FORCE_BYPASS, {
    ...helper,
    tool_name: 'Write',
    tool_input: { file_path: path.join(worktree, 'lib', 'granted.js') },
  }), null, 'a granted ruling must work without copying its path into ticket.files');
  const ungranted = runHookOutput(FORCE_BYPASS, {
    ...helper,
    tool_name: 'Write',
    tool_input: { file_path: path.join(worktree, 'lib', 'ungranted.js') },
  });
  assert.equal(ungranted.hookSpecificOutput.permissionDecision, 'deny');

  const globTicket = addStopTicket('glob helper scope', { files: ['lib/**/*.js'] });
  const globSession = `glob-helper-${++fixtureState.sqSeq}`;
  const globActor = claimStopTicket(globTicket, globSession, 'glob-helper-parent');
  const globHelper = { ...globActor, agent_type: 'general-purpose', cwd: worktree };
  assert.equal(runHookOutput(FORCE_BYPASS, {
    ...globHelper,
    tool_name: 'Write',
    tool_input: { file_path: path.join(worktree, 'lib', 'nested', 'covered.js') },
  }), null, 'a descendant glob must match helper writes like commit admission does');
  const globMiss = runHookOutput(FORCE_BYPASS, {
    ...globHelper,
    tool_name: 'Write',
    tool_input: { file_path: path.join(worktree, 'lib', 'nested', 'covered.txt') },
  });
  assert.equal(globMiss.hookSpecificOutput.permissionDecision, 'deny');
});

test('pre-tool hook: external linked worktrees preserve helper scope enforcement', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-helper-external-'));
  fs.mkdirSync(path.join(projectPath, 'lib'));
  fs.writeFileSync(path.join(projectPath, 'lib', 'allowed.js'), 'export const allowed = true;\n');
  fs.writeFileSync(path.join(projectPath, 'lib', 'outside.js'), 'export const outside = true;\n');
  gitFixture(['init', '-b', 'main', '--quiet'], projectPath);
  gitFixture(['config', 'user.email', 'sidequest@example.invalid'], projectPath);
  gitFixture(['config', 'user.name', 'Sidequest Tests'], projectPath);
  gitFixture(['add', '.'], projectPath);
  gitFixture(['commit', '--quiet', '-m', 'fixture'], projectPath);

  const projectSlug = store.ensureProject(projectPath).slug;
  const ticket = addStopTicket('external helper scope', { files: ['lib/allowed.js'] }, projectSlug);
  const sessionId = `helper-external-${++fixtureState.sqSeq}`;
  const prepared = store.prepareDispatch(projectSlug, ticket.ref, { allowUnscoped: true, sessionId, sharedTree: false });
  const agentId = `helper-external-agent-${fixtureState.sqSeq}`;
  const agentName = `helper-external-parent-${fixtureState.sqSeq}`;
  assert.equal(store.recordDispatchLaunch(projectSlug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName,
  }).ok, true);
  const assignedWorktree = worktrees.namedWorktreePath(projectPath, agentId);
  assert.equal(store.bindDispatchWorktreeCreation(projectSlug, sessionId, assignedWorktree).ok, true);
  gitFixture(['worktree', 'add', '--detach', assignedWorktree], projectPath);
  completeCheckoutCreation(projectSlug, sessionId, assignedWorktree);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentId, agentName, assignedWorktree).ok, true);
  assert.equal(store.claimTicket(projectSlug, ticket.ref, 'helper-external-parent', {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  const parent = { session_id: sessionId, agent_type: prepared.ticket.dispatchExecutor, agent_id: agentId, agent_name: agentName };

  try {
    const helper = { ...parent, agent_type: 'general-purpose', cwd: assignedWorktree };
    assert.equal(runHookOutput(FORCE_BYPASS, {
      ...helper,
      tool_name: 'Write',
      tool_input: { file_path: path.join(assignedWorktree, 'lib', 'allowed.js') },
    }), null);

    const outside = runHookOutput(FORCE_BYPASS, {
      ...helper,
      tool_name: 'Write',
      tool_input: { file_path: path.join(assignedWorktree, 'lib', 'outside.js') },
    });
    assert.equal(outside.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(outside.hookSpecificOutput.permissionDecisionReason, /lib[\\/]outside\.js/);
    assert.match(outside.hookSpecificOutput.permissionDecisionReason, /effective scope/);
  } finally {
    gitFixture(['worktree', 'remove', '--force', assignedWorktree], projectPath);
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

export {};
