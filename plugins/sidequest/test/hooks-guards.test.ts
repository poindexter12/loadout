'use strict';
// SQ-137: one topic shard of the former hooks.test.ts, split so the runner can spread its tests
// across workers. Shared setup and helpers live in ./_hooks-fixture.ts; the tests are moved unchanged.
import {
  test,
  assert,
  os,
  fs,
  path,
  execFileSync,
  spawn,
  store,
  worktrees,
  BOARD_PATH,
  slug,
  FORCE_BYPASS,
  REPEATED_COMMAND_WARN,
  INLINE_WORK_NUDGE,
  GUARD_TASK_OUTPUT,
  GUARD_SHARED_CHECKOUT_GIT,
  RETIRED_SCOUT,
  runHookOutput,
  runHook,
  windowsShortPath,
  gitFixture,
  completeCheckoutCreation,
  fixtureTicket,
  addStopTicket,
  fixtureState,
} from './_hooks-fixture.js';

// SQ-128/SQ-227: the guard must key on git as the INVOCATION, never on `git` or the project path as a
// substring. The fixture checkout deliberately sits under a `Code/github.com/...` path so every allowed
// case below passes the real shared-checkout path as an ordinary argument: a substring matcher would
// resolve it to the shared checkout and refuse.
test('shared-checkout git guard: a checkout path used as an argument is allowed while git targets in it are refused', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-shared-checkout-'));
  const projectPath = path.join(sandbox, 'Code', 'github.com', 'poindexter12', 'loadout');
  fs.mkdirSync(projectPath, { recursive: true });
  gitFixture(['init', '-b', 'main', '--quiet'], projectPath);
  gitFixture(['config', 'user.email', 'sidequest@example.invalid'], projectPath);
  gitFixture(['config', 'user.name', 'Sidequest Tests'], projectPath);
  fs.writeFileSync(path.join(projectPath, 'fixture.txt'), 'fixture\n');
  gitFixture(['add', '.'], projectPath);
  gitFixture(['commit', '--quiet', '-m', 'fixture'], projectPath);

  const projectSlug = store.ensureProject(projectPath).slug;
  const ticket = addStopTicket('shared checkout git guard', undefined, projectSlug);
  const sessionId = `shared-checkout-${++fixtureState.sqSeq}`;
  const prepared = store.prepareDispatch(projectSlug, ticket.ref, { allowUnscoped: true, sessionId, sharedTree: false });
  const agentId = `shared-checkout-agent-${fixtureState.sqSeq}`;
  const agentName = `shared-checkout-parent-${fixtureState.sqSeq}`;
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
  assert.equal(store.claimTicket(projectSlug, ticket.ref, 'shared-checkout-parent', {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);

  try {
    const payload = {
      session_id: sessionId,
      agent_type: prepared.ticket.dispatchExecutor,
      agent_id: agentId,
      agent_name: agentName,
      tool_name: 'Bash',
      cwd: assignedWorktree,
    };
    const run = (command: string) => runHookOutput(GUARD_SHARED_CHECKOUT_GIT, { ...payload, tool_input: { command } });
    // Every case is recorded rather than asserted one at a time: a false refusal and a missed refusal are
    // different defects, and stopping at the first one hides whichever cases come after it.
    const wrong: string[] = [];

    for (const [label, command] of [
      // The original SQ-128 report: the exact --project form the briefing tells executors to use.
      ['--project argument', `node ${path.join(sandbox, 'sidequest-launcher.js')} verify ${ticket.ref} --project ${projectPath}`],
      // SQ-227: a scratchpad path encodes `github` for every repo under ~/Code/github.com/.
      ['github scratchpad path', `ls ${path.join(sandbox, 'claude-503', '-Users-joese-Code-github-com-poindexter12-loadout')}`],
      // SQ-227: an install path containing `github` (aqua-github-copilot-cli).
      ['github install path', `ls ${path.join(sandbox, 'installs', 'aqua-github-copilot-cli')} ${projectPath}`],
      // Read-only git against the shared checkout stays available for review.
      ['read-only git -C', `git -C ${projectPath} log --oneline -1`],
      // The briefing's own sync step passes the shared checkout to a non-mutating git subcommand.
      ['git fetch argument', `git fetch ${projectPath} main`],
      // A command-looking string inside a quoted argument is text, not an invocation.
      ['quoted pseudo-command', `node note.js --message "cleanup; git -C ${projectPath} reset --hard"`],
      // Mutating git in the executor's own worktree is the whole point of the dispatch.
      ['own worktree commit', 'git commit -m scoped'],
      ['own worktree update-ref', `git update-ref refs/sidequest/${ticket.ref} HEAD`],
    ] as const) {
      if (run(command) !== null) wrong.push(`falsely refused - ${label}: ${command}`);
    }

    for (const [label, command] of [
      ['git -C the shared checkout', `git -C ${projectPath} commit -m forbidden`],
      ['cd into the shared checkout', `cd ${projectPath} && git reset --hard`],
      ['cd with an intervening command', `cd ${projectPath} && echo staged && git commit -m forbidden`],
      ['a later invocation after a read-only one', `cd ${projectPath} && git status --short && git clean -fd`],
    ] as const) {
      const blocked = run(command);
      const reason = String(blocked?.hookSpecificOutput?.permissionDecisionReason || '');
      if (blocked?.hookSpecificOutput?.permissionDecision !== 'deny') wrong.push(`not refused - ${label}: ${command}`);
      else if (!/refusing a mutating git command against the shared checkout/.test(reason)
        || !/ordinary argument, such as --project <path> or git fetch <path>, is not refused/.test(reason)) {
        wrong.push(`inaccurate refusal text - ${label}: ${reason}`);
      }
    }
    assert.deepEqual(wrong, [], `shared-checkout git guard misjudged ${wrong.length} case(s):\n${wrong.join('\n')}`);
  } finally {
    gitFixture(['worktree', 'remove', '--force', assignedWorktree], projectPath);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('pre-tool hook: an unbound helper can restore only one declared file to HEAD', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-helper-revert-'));
  fs.mkdirSync(path.join(projectPath, 'lib'));
  const allowedPath = path.join(projectPath, 'lib', 'allowed.js');
  const outsidePath = path.join(projectPath, 'lib', 'outside.js');
  const committedContent = 'export const guard = true;\n';
  fs.writeFileSync(allowedPath, committedContent);
  fs.writeFileSync(outsidePath, committedContent);
  gitFixture(['init', '-b', 'main', '--quiet'], projectPath);
  gitFixture(['config', 'user.email', 'sidequest@example.invalid'], projectPath);
  gitFixture(['config', 'user.name', 'Sidequest Tests'], projectPath);
  gitFixture(['add', 'lib/allowed.js', 'lib/outside.js'], projectPath);
  gitFixture(['commit', '--quiet', '-m', 'fixture'], projectPath);
  fs.writeFileSync(allowedPath, 'export const guard = false;\n');
  fs.writeFileSync(outsidePath, 'export const guard = false;\n');

  const project = store.ensureProject(projectPath).slug;
  const parent = store.createTicket(project, { title: 'revert owner', category: 'debugging', files: ['lib/allowed.js'], source: 'cli' });
  const sibling = store.createTicket(project, { title: 'revert sibling', category: 'debugging', files: ['lib/sibling.js'], source: 'cli' });
  const sessionId = `helper-revert-${++fixtureState.sqSeq}`;
  for (const [ticket, agentName] of [[parent, 'revert-owner'], [sibling, 'revert-sibling']] as const) {
    const prepared = store.prepareDispatch(project, ticket.ref, { allowUnscoped: true, sessionId, sharedTree: true });
    assert.equal(store.recordDispatchLaunch(project, ticket.ref, {
      sessionId, token: prepared.token, executor: prepared.ticket.dispatchExecutor, agentName,
    }).ok, true);
    assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, `${agentName}-id`, agentName).ok, true);
    assert.equal(store.claimTicket(project, ticket.ref, `${agentName}-claim`, {
      sessionId, token: prepared.token, executor: prepared.ticket.dispatchExecutor,
    }).ok, true);
  }

  const unbound = {
    session_id: sessionId,
    agent_id: `unbound-helper-${fixtureState.sqSeq}`,
    agent_type: 'general-purpose',
    cwd: projectPath,
    tool_name: 'Write',
    tool_input: { file_path: allowedPath, content: committedContent },
  };
  const editRestore = runHookOutput(FORCE_BYPASS, {
    ...unbound,
    tool_name: 'Edit',
    tool_input: { file_path: allowedPath, old_string: 'export const guard = false;\n', new_string: committedContent },
  });
  assert.equal(editRestore, null);
  assert.equal(runHookOutput(FORCE_BYPASS, unbound), null);
  assert.deepEqual(Buffer.from(unbound.tool_input.content), execFileSync('git', ['show', 'HEAD:lib/allowed.js'], { cwd: projectPath }));

  const smuggled = runHookOutput(FORCE_BYPASS, {
    ...unbound,
    tool_input: { file_path: allowedPath, content: 'export const guard = "smuggled";\n' },
  });
  assert.equal(smuggled.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(smuggled.hookSpecificOutput.permissionDecisionReason, /No active ticket is bound to acting agent/);

  if (process.platform === 'win32') {
    const aliasProjectPath = windowsShortPath(projectPath);
    if (aliasProjectPath.toLowerCase() !== projectPath.toLowerCase()) {
      const aliasAllowed = runHookOutput(FORCE_BYPASS, {
        ...unbound,
        tool_input: { file_path: path.join(aliasProjectPath, 'lib', 'allowed.js'), content: committedContent },
      });
      assert.equal(aliasAllowed, null);

      const aliasOutside = runHookOutput(FORCE_BYPASS, {
        ...unbound,
        tool_input: { file_path: path.join(aliasProjectPath, 'lib', 'outside.js'), content: committedContent },
      });
      assert.equal(aliasOutside.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(aliasOutside.hookSpecificOutput.permissionDecisionReason, /No active ticket is bound to acting agent/);
    }
  }
});

test('pre-tool hook: ordinary subagents without a dispatch stay outside the helper scope guard', () => {
  const out = runHookOutput(FORCE_BYPASS, {
    session_id: `ordinary-${++fixtureState.sqSeq}`,
    agent_id: `ordinary-helper-${fixtureState.sqSeq}`,
    agent_type: 'general-purpose',
    tool_name: 'Write',
    tool_input: { file_path: path.join(BOARD_PATH, 'outside.js') },
  });
  assert.equal(out, null);
});

test('pre-tool hook: an unregistered project gets inline guidance, not a ship-gating deny', () => {
  // dispatchAdmission returns 'no-project' for any cwd with no registered board, which is every
  // project before its first Board MCP call. The guard used to enumerate only 'routing-disabled' and
  // 'no-usable-route', so this case fell through to agentDenyReason and was told not to ship until a
  // ticket it cannot file is closed - while session-start told the same session inline work is fine.
  const unregistered = runHookOutput(FORCE_BYPASS, {
    cwd: path.join(os.tmpdir(), 'sq-hooks-fixtures', 'never-registered'),
    tool_name: 'Agent',
    tool_input: { subagent_type: 'general-purpose', prompt: 'Look at the two config files.' },
  }, { CLAUDE_PROJECT_DIR: '' });
  const reason = unregistered.hookSpecificOutput.permissionDecisionReason;
  assert.equal(unregistered.hookSpecificOutput.permissionDecision, 'deny', 'generic agents stay denied');
  assert.match(reason, /not registered on a Sidequest board/);
  assert.match(reason, /Continue bounded inline work with direct tools/);
  assert.doesNotMatch(reason, /until its ticket is filed, dispatched, and closed/,
    'an unregistered project must not be told its unfileable ticket gates a PR or ship');
  assert.doesNotMatch(reason, /file a spike/,
    'the remedy it names would need the route that does not exist');
});

test('pre-tool hook: a marked arbitrary agent is still denied', () => {
  const marked = runHookOutput(FORCE_BYPASS, {
    cwd: BOARD_PATH,
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'implementation-agent',
      isolation: 'worktree',
      prompt: ` \n\t[${RETIRED_SCOUT}]\nImplement the change.`,
    },
  });
  const reason = marked.hookSpecificOutput.permissionDecisionReason;
  assert.equal(marked.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(reason, /generic Agent, not a Sidequest ticket executor/);
  assert.match(reason, /file a spike/);
  assert.match(reason, /returned executor/);
});

test('pre-tool hook keeps builtin models and rejects an unprepared dispatch executor', () => {
  const dispatch = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'sidequest-exec-dispatch', model: 'fable', name: 'sq210-dispatch',
      prompt: 'work SQ-210\n[sidequest-route model=codex-gpt-5-6-terra effort=high]',
    },
  });
  assert.equal(dispatch.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(dispatch.hookSpecificOutput.permissionDecisionReason, /requires the exact prepared FIRST action briefing command/);

  const builtIn = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-high', model: 'opus', name: 'sq210-builtin' },
  });
  assert.equal(builtIn.hookSpecificOutput.updatedInput.model, 'opus');
  assert.equal(builtIn.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');

  const haiku = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-medium', model: 'haiku', name: 'sq210-haiku' },
  });
  assert.equal(haiku.hookSpecificOutput.updatedInput.model, 'haiku');
  assert.equal(haiku.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');

  for (const subagent_type of ['sidequest-native-sq-210-gpt-5-6-terra', 'sidequest-ticket-sq-584-haiku-b37fffcb']) {
    const out = runHookOutput(FORCE_BYPASS, { tool_name: 'Agent', tool_input: { subagent_type, prompt: 'work SQ-210' } });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /unknown Sidequest agent type|invalid or retired/);
  }
});

test('pre-tool hook: malformed input fails soft', () => {
  const out = execFileSync(process.execPath, [FORCE_BYPASS], {
    input: '{"tool_input":',
    encoding: 'utf8',
    env: process.env,
  });
  assert.strictEqual(out, '');
});

test('task-output guard: blocks Sidequest native task identities and dispatched names', () => {
  const reason = 'native Agent results arrive automatically. Use pulse <ref> / changes --since for liveness. Never TaskStop an executor; it ends on its own.';
  const direct = runHookOutput(GUARD_TASK_OUTPUT, {
    tool_name: 'TaskOutput', tool_input: { task_id: 'sidequest-exec-dispatch@session-abc' },
  });
  assert.equal(direct.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(direct.hookSpecificOutput.permissionDecisionReason, new RegExp(reason.replace(/[<>]/g, '\\$&')));

  const ticket = fixtureTicket('task-output mapped launch', 'sonnet', 'high');
  const sessionId = `task-output-${Date.now()}`;
  const agentName = 'friendly-launch-name';
  const agentId = 'native-task@session-sidequest-guard';
  const prepared = store.prepareDispatch(slug, ticket.ref, { allowUnscoped: true, sessionId });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId, token: prepared.token, executor: prepared.ticket.dispatchExecutor, agentName,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentId, agentName).ok, true);

  for (const tool_input of [{ task_id: agentName }, { id: agentId }]) {
    const out = runHookOutput(GUARD_TASK_OUTPUT, { session_id: sessionId, tool_name: 'TaskOutput', tool_input });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  }
});

test('task-output guard: leaves background task IDs and malformed unrelated input alone', () => {
  for (const tool_input of [
    { task_id: 'build-123' },
    { id: 'unrelated-SQ-439-process' },
    { task_id: {} },
  ]) {
    assert.strictEqual(runHookOutput(GUARD_TASK_OUTPUT, { tool_name: 'TaskOutput', tool_input }), null);
  }
});

test('task-output guard: executor identity variants bypass the main-thread guard', () => {
  for (const identity of [
    { agent_id: 'executor' }, { agentId: 'executor' }, { agent_type: 'sidequest-exec-high' }, { agentType: 'sidequest-exec-high' },
  ]) {
    assert.strictEqual(runHookOutput(GUARD_TASK_OUTPUT, {
      tool_name: 'TaskOutput', ...identity, tool_input: { task_id: 'sidequest-exec-dispatch@session-abc' },
    }), null);
  }
});

test('pre-tool repeated-command hook ignores main-thread and unrelated subagent calls', () => {
  assert.equal(runHookOutput(REPEATED_COMMAND_WARN, { tool_name: 'Bash', agent_id: 'main-thread', tool_input: { command: 'npm test' } }), null);
  assert.equal(runHookOutput(REPEATED_COMMAND_WARN, { tool_name: 'Bash', agent_type: 'explore', agent_id: 'other-agent', tool_input: { command: 'npm test' } }), null);
});

test('pre-tool repeated-command hook warns on the third repeat and every fifth after', () => {
  const agentId = `repeated-command-${Date.now()}`;
  const payload = { tool_name: 'Bash', agent_type: 'sidequest-exec-high', agent_id: agentId, tool_input: { command: 'npm   run\n test' } };
  assert.equal(runHookOutput(REPEATED_COMMAND_WARN, payload), null);
  assert.equal(runHookOutput(REPEATED_COMMAND_WARN, { ...payload, tool_input: { command: 'npm run test' } }), null);
  const third = runHook(REPEATED_COMMAND_WARN, payload);
  assert.equal(third, 'sidequest: you have run this exact command 3 times; if you are waiting on something, run it with run_in_background and let the completion notification wake you — polling burns ~14s and ~60k tokens per call');
  for (let i = 0; i < 4; i += 1) assert.equal(runHookOutput(REPEATED_COMMAND_WARN, payload), null);
  assert.match(runHook(REPEATED_COMMAND_WARN, payload), /you have run this exact command 3 times/);
  assert.equal(runHookOutput(REPEATED_COMMAND_WARN, { ...payload, tool_input: { command: 'npm run typecheck' } }), null);
  assert.equal(runHookOutput(REPEATED_COMMAND_WARN, { ...payload, tool_input: { command: 'npm run typecheck' } }), null);
  assert.match(runHook(REPEATED_COMMAND_WARN, { ...payload, tool_input: { command: 'npm run typecheck' } }), /you have run this exact command 3 times/);
});

test('pre-tool repeated-command hook warns for PowerShell commands', () => {
  const agentId = `repeated-command-powershell-${Date.now()}`;
  const payload = { tool_name: 'PowerShell', agent_type: 'sidequest-exec-high', agent_id: agentId, tool_input: { command: 'npm test' } };
  assert.equal(runHookOutput(REPEATED_COMMAND_WARN, payload), null);
  assert.equal(runHookOutput(REPEATED_COMMAND_WARN, payload), null);
  assert.match(runHook(REPEATED_COMMAND_WARN, payload), /polling burns ~14s and ~60k tokens per call/);
});

test('pre-tool inline-work hook makes board dispatch the default for solo work', () => {
  const session_id = `inline-solo-${Date.now()}`;
  const output = runHookOutput(INLINE_WORK_NUDGE, {
    session_id, cwd: BOARD_PATH, tool_name: 'Write', tool_input: {},
  });
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(output.hookSpecificOutput.additionalContext, output.systemMessage, 'the nudge must reach the model, not only the terminal');
  assert.match(output.systemMessage, /^sidequest: 0 reads \/ 1 commands this session, no board interaction\./);
  assert.match(output.systemMessage, /Multi-file work defaults to board dispatch\./);
  assert.match(output.systemMessage, /offer dispatch, or name why inline serves the user better than an executor/i);
  assert.ok(Buffer.byteLength(output.systemMessage, 'utf8') <= 768, 'the PreToolUse nudge must fit its context budget');
  assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
    session_id, cwd: BOARD_PATH, tool_name: 'Write', tool_input: {},
  }), null);
});

test('pre-tool inline-work hook nudges prolonged investigations with live counts', () => {
  const session_id = `inline-investigation-${Date.now()}`;
  const payload = { session_id, cwd: BOARD_PATH, tool_name: 'Read', tool_input: {} };
  for (let readActions = 1; readActions < 8; readActions += 1) assert.equal(runHookOutput(INLINE_WORK_NUDGE, payload), null);
  const firstInvestigationNudge = runHookOutput(INLINE_WORK_NUDGE, payload);
  assert.match(firstInvestigationNudge.systemMessage, /^sidequest: 8 reads \/ 0 commands this session, no board interaction\./);
  assert.ok(Buffer.byteLength(firstInvestigationNudge.systemMessage, 'utf8') <= 768, 'the PreToolUse investigation nudge must fit its context budget');
  for (let readActions = 9; readActions < 24; readActions += 1) assert.equal(runHookOutput(INLINE_WORK_NUDGE, payload), null);
  const escalation = runHookOutput(INLINE_WORK_NUDGE, payload);
  assert.match(escalation.systemMessage, /^sidequest: 24 reads \/ 0 commands this session, no board interaction\. You have continued after an earlier reminder\./);
  assert.ok(Buffer.byteLength(escalation.systemMessage, 'utf8') <= 768, 'the repeated PreToolUse nudge must fit its context budget');
});

test('pre-tool inline-work hook escalates substantive work at widening intervals', () => {
  const session_id = `inline-escalation-${Date.now()}`;
  const payload = { session_id, cwd: BOARD_PATH, tool_name: 'Write', tool_input: {} };
  assert.match(runHookOutput(INLINE_WORK_NUDGE, payload).systemMessage, /1 commands this session/);
  for (let substantiveActions = 2; substantiveActions < 4; substantiveActions += 1) assert.equal(runHookOutput(INLINE_WORK_NUDGE, payload), null);
  assert.match(runHookOutput(INLINE_WORK_NUDGE, payload).systemMessage, /0 reads \/ 4 commands this session/);
  for (let substantiveActions = 5; substantiveActions < 12; substantiveActions += 1) assert.equal(runHookOutput(INLINE_WORK_NUDGE, payload), null);
  assert.match(runHookOutput(INLINE_WORK_NUDGE, payload).systemMessage, /0 reads \/ 12 commands this session/);
  for (let substantiveActions = 13; substantiveActions < 36; substantiveActions += 1) assert.equal(runHookOutput(INLINE_WORK_NUDGE, payload), null);
  assert.match(runHookOutput(INLINE_WORK_NUDGE, payload).systemMessage, /0 reads \/ 36 commands this session/);
});

test('pre-tool inline-work hook nudges the second native Agent spawn at widening intervals', () => {
  const session_id = `inline-native-agent-${Date.now()}`;
  const payload = { session_id, cwd: BOARD_PATH, tool_name: 'Agent', tool_input: { subagent_type: 'Explore' } };
  assert.equal(runHookOutput(INLINE_WORK_NUDGE, payload), null);
  const secondNativeAgentNudge = runHookOutput(INLINE_WORK_NUDGE, payload);
  assert.ok(secondNativeAgentNudge, 'the second native Agent spawn must nudge');
  assert.match(secondNativeAgentNudge.systemMessage, /^sidequest: 2 native subagents this session;/);
  assert.match(secondNativeAgentNudge.systemMessage, /native Explore\/general-purpose inherits the session model/);
  assert.match(secondNativeAgentNudge.systemMessage, /codebase-exploration, research, spike-investigation/);
  assert.ok(Buffer.byteLength(secondNativeAgentNudge.systemMessage, 'utf8') <= 768, 'the native Agent nudge must fit its context budget');
  for (let nativeAgentSpawns = 3; nativeAgentSpawns < 6; nativeAgentSpawns += 1) assert.equal(runHookOutput(INLINE_WORK_NUDGE, payload), null);
  assert.match(runHookOutput(INLINE_WORK_NUDGE, payload).systemMessage, /^sidequest: 6 native subagents this session;/);
});

test('pre-tool inline-work hook treats Sidequest executor spawns as board interaction', () => {
  const session_id = `inline-sidequest-agent-${Date.now()}`;
  assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
    session_id, cwd: BOARD_PATH, tool_name: 'Agent', tool_input: { subagent_type: 'sidequest-exec-readonly-medium' },
  }), null);
  for (let readActions = 0; readActions < 8; readActions += 1) {
    assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
      session_id, cwd: BOARD_PATH, tool_name: 'Read', tool_input: {},
    }), null);
  }
  for (let substantiveActions = 0; substantiveActions < 4; substantiveActions += 1) {
    assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
      session_id, cwd: BOARD_PATH, tool_name: 'Write', tool_input: {},
    }), null);
  }
  const nativePayload = { session_id, cwd: BOARD_PATH, tool_name: 'Agent', tool_input: { subagent_type: 'Explore' } };
  assert.equal(runHookOutput(INLINE_WORK_NUDGE, nativePayload), null);
  const nativeAgentNudge = runHookOutput(INLINE_WORK_NUDGE, nativePayload);
  assert.ok(nativeAgentNudge, 'native spawns after a Sidequest executor spawn must still nudge');
  assert.match(nativeAgentNudge.systemMessage, /^sidequest: 2 native subagents this session;/);
});

test('pre-tool inline-work hook nudges native Agent spawns after board interaction', () => {
  const session_id = `inline-native-after-board-${Date.now()}`;
  assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
    session_id, cwd: BOARD_PATH, tool_name: 'mcp__plugin_sidequest_board__claim', tool_input: {},
  }), null);
  const payload = { session_id, cwd: BOARD_PATH, tool_name: 'Agent', tool_input: {} };
  assert.equal(runHookOutput(INLINE_WORK_NUDGE, payload), null);
  const nativeAgentNudge = runHookOutput(INLINE_WORK_NUDGE, payload);
  assert.ok(nativeAgentNudge, 'native Agent spawns must nudge even after a board interaction');
  assert.match(nativeAgentNudge.systemMessage, /^sidequest: 2 native subagents this session;/);
});

test('pre-tool inline-work hook keeps bounded transcript lookups inline-safe', () => {
  const output = runHookOutput(INLINE_WORK_NUDGE, {
    session_id: `inline-transcript-${Date.now()}`,
    cwd: BOARD_PATH,
    prompt: 'Find the session transcript entry for this claim.',
    tool_name: 'Bash',
    tool_input: { command: 'node -p "process.argv.slice(1, 2)[0]" transcript --limit 1' },
  });
  assert.equal(output, null);
});

test('pre-tool inline-work hook records activity without injecting repeat reminders after board interaction', () => {
  const session_id = `inline-advisory-${Date.now()}`;
  assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
    session_id, cwd: BOARD_PATH, tool_name: 'mcp__plugin_sidequest_board__claim', tool_input: {},
  }), null);
  for (let i = 0; i < 20; i += 1) {
    assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
      session_id, cwd: BOARD_PATH, tool_name: i % 2 ? 'Read' : 'Write', tool_input: {},
    }), null);
  }
});

test('pre-tool inline-work nudge stays quiet after a board interaction', () => {
  const session_id = `inline-board-${Date.now()}`;
  assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
    session_id, cwd: BOARD_PATH, tool_name: 'mcp__plugin_sidequest_board__claim', tool_input: {},
  }), null);
  for (let i = 0; i < 12; i += 1) {
    assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
      session_id, cwd: BOARD_PATH, tool_name: 'Read', tool_input: {},
    }), null);
  }
  const cliSession = `inline-cli-${Date.now()}`;
  assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
    session_id: cliSession, cwd: BOARD_PATH, tool_name: 'Bash',
    tool_input: { command: 'node "C:/plugins/sidequest/bin/sidequest.js" list' },
  }), null);
  for (let i = 0; i < 12; i += 1) {
    assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
      session_id: cliSession, cwd: BOARD_PATH, tool_name: 'Glob', tool_input: {},
    }), null);
  }
});

test('pre-tool inline-work nudge ignores subagent identity variants and routing-disabled boards', () => {
  for (const identity of [
    { agent_id: 'executor' }, { agentId: 'executor' }, { agent_type: 'sidequest-exec-high' }, { agentType: 'sidequest-exec-high' },
  ]) {
    const subagent = { session_id: `inline-subagent-${Date.now()}`, cwd: BOARD_PATH, ...identity, tool_name: 'Read', tool_input: {} };
    for (let i = 0; i < 12; i += 1) assert.equal(runHookOutput(INLINE_WORK_NUDGE, subagent), null);
  }

  store.setProjectRouting(slug, 'disabled');
  try {
    const disabled = { session_id: `inline-disabled-${Date.now()}`, cwd: BOARD_PATH, tool_name: 'Read', tool_input: {} };
    for (let i = 0; i < 12; i += 1) assert.equal(runHookOutput(INLINE_WORK_NUDGE, disabled), null);
  } finally {
    store.setProjectRouting(slug, 'enabled');
  }
});

export {};
