'use strict';
// SQ-137: one topic shard of the former mcp.test.ts, split so the runner can spread its tests
// across workers. Shared setup and helpers live in ./_mcp-fixture.ts; the tests are moved unchanged.
import {
  test,
  assert,
  os,
  path,
  fs,
  spawnSync,
  execFileSync,
  SIDEQUEST_HOME,
  FIXTURE_ROOT,
  PROJ,
  MCP_SESSION_ID,
  mcp,
  agentsync,
  store,
  db,
  createCheckoutInstanceMarker,
  DISPATCH_DESCRIPTION,
  NO_SCOPE_WARNING,
  seedCatalog,
  seedCatalogV4,
  clearCatalog,
  committedRepo,
  callTool,
  callToolRaw,
  callToolAsSession,
  callToolRawAsSession,
  callToolOn,
  freshMcpServer,
  callHandler,
  persistTicket,
  runCli,
  runForceBypass,
  resultChars,
  isolatedDispatch,
  recordExternalDeliverableCapture,
  fixtureState,
} from './_mcp-fixture.js';

test('MCP dispatch records the runtime session and the Agent lifecycle binds it', async () => {
  const slug = store.ensureProject(PROJ).slug;
  store.setCategory({ id: 'mcp-runtime-session', name: 'MCP runtime session', route: { model: 'sonnet', effort: 'high' } });
  const friendly = await callTool('add', { title: 'friendly dispatch session', description: DISPATCH_DESCRIPTION, category: 'mcp-runtime-session' });
  const omitted = await callTool('add', { title: 'omitted dispatch session', description: DISPATCH_DESCRIPTION, category: 'mcp-runtime-session' });
  const real = await callTool('add', { title: 'runtime dispatch session', description: DISPATCH_DESCRIPTION, category: 'mcp-runtime-session' });

  const friendlyDispatch = await callTool('dispatch', { allowUnscoped: true, ref: friendly.ref, session: 'hh6-quant', full: true });
  await callTool('dispatch', { allowUnscoped: true, ref: omitted.ref });
  await callTool('dispatch', { allowUnscoped: true, ref: real.ref, session: MCP_SESSION_ID });

  for (const ref of [friendly.ref, omitted.ref, real.ref]) {
    assert.equal(store.getTicket(slug, ref).dispatch.sessionId, MCP_SESSION_ID);
  }

  const launched = runForceBypass({
    session_id: MCP_SESSION_ID,
    cwd: PROJ,
    tool_name: 'Agent',
    tool_input: friendlyDispatch.spawn,
  });
  const agentName = launched.hookSpecificOutput.updatedInput.name;
  let pulse = await callTool('pulse', { ref: friendly.ref, full: true });
  assert.equal(pulse.dispatch.state, 'launched');
  assert.equal(pulse.dispatch.sessionId, MCP_SESSION_ID);
  assert.ok(pulse.dispatch.launchedAt);

  assert.equal(store.bindDispatchAgent(MCP_SESSION_ID, friendlyDispatch.agent, 'native-mcp-session-agent', agentName).ok, true);
  pulse = await callTool('pulse', { ref: friendly.ref, full: true });
  assert.equal(pulse.dispatch.state, 'bound');
  assert.equal(pulse.dispatch.agentId, 'native-mcp-session-agent');
});

test('MCP dispatch refuses a caller session label without runtime identity', async () => {
  const slug = store.ensureProject(PROJ).slug;
  const ticket = await callTool('add', { title: 'missing runtime dispatch session', description: DISPATCH_DESCRIPTION, category: 'mcp-runtime-session' });
  const runtime = process.env.CLAUDE_CODE_SESSION_ID;
  const legacy = process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  try {
    const refused = await callToolRaw('dispatch', { allowUnscoped: true, ref: ticket.ref, session: 'hh6-review' });
    assert.ok(refused.isError);
    assert.equal(refused.content[0].text, 'dispatch: MCP runtime session identity is unavailable. Reload Sidequest in Claude Code and retry; do not pass a session label.');
    assert.equal(store.getTicket(slug, ticket.ref).dispatch, null);
  } finally {
    process.env.CLAUDE_CODE_SESSION_ID = runtime;
    if (legacy == null) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = legacy;
  }
});

test('dispatch returns a complete Claude worktree spawn spec', async () => {
  store.setCategory({ id: 'dispatch-fable', name: 'Dispatch Fable', route: { model: 'fable', effort: 'xhigh' } });
  const added = await callTool('add', { title: 'complete instant spawn', description: DISPATCH_DESCRIPTION, category: 'dispatch-fable', files: ['plugins/sidequest'] });
  const dispatched = await callTool('dispatch', { allowUnscoped: true, ref: added.ref, full: true });

  const { prompt, ...spawn } = dispatched.spawn;
  assert.deepStrictEqual(spawn, {
    subagent_type: 'sidequest:sidequest-exec-xhigh',
    name: `${added.ref.toLowerCase()}-complete-instant-spawn-fable-xhigh`,
    mode: 'bypassPermissions',
    description: 'Claude Fable, xhigh · complete instant spawn',
    isolation: 'worktree',
    model: 'fable',
  });
  assert.match(prompt, /briefing SQ-/);
  assert.match(prompt, /FIRST action:.*--project/);
  assert.doesNotMatch(prompt, /## This ticket/);
  assert.doesNotMatch(prompt, /You are a sidequest ticket executor/);
  assert.equal(dispatched.effort, 'xhigh');
  assert.equal(dispatched.projectPath, PROJ);
});

test('MCP sharedTree dispatch from a session rooted in another repository refuses instead of handing out a broken spawn (SQ-309)', async () => {
  const board = committedRepo('sq-mcp-sq309-board-');
  const foreign = committedRepo('sq-mcp-sq309-foreign-');
  const added = await callTool('add', {
    project: board,
    title: 'cross-repo shared-tree dispatch',
    description: DISPATCH_DESCRIPTION,
    category: 'coding.normal',
    files: ['src/work.ts'],
    verify: 'node --test test/work.test.ts',
  });
  fixtureState.mcpDispatchCwd = foreign;
  let refused: any;
  try {
    refused = await callToolRaw('dispatch', { project: board, ref: added.ref, sharedTree: true, full: true });
  } finally {
    fixtureState.mcpDispatchCwd = null;
  }
  assert.equal(refused.isError, true);
  const text = refused.content[0].text;
  assert.match(text, /sharedTree:true requires the spawning runtime to be rooted in the declared project checkout/);
  assert.ok(text.includes(fs.realpathSync.native(foreign)), `refusal names the foreign root: ${text}`);
  assert.equal(store.getTicket(added.project, added.ref).dispatchNonce, null, 'no token was minted');

  // The same request from a session rooted in the board's checkout is admitted.
  const admitted = await callTool('dispatch', { project: board, ref: added.ref, sharedTree: true, full: true });
  assert.strictEqual(admitted.spawn.isolation, undefined);
  assert.strictEqual(store.getTicket(added.project, added.ref).dispatch.sharedTree, true);
});

test('MCP dispatch falls back to shared tree when the repo has no commits', async () => {
  const unborn = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-unborn-'));
  execFileSync('git', ['init', '-b', 'main', '--quiet'], { cwd: unborn, windowsHide: true });
  const added = await callTool('add', {
    project: unborn,
    title: 'unborn repo dispatch',
    description: DISPATCH_DESCRIPTION,
    category: 'coding.normal',
    files: ['src/work.ts'],
    verify: 'node --test test/work.test.ts',
  });

  const dispatched = await callTool('dispatch', { allowUnscoped: true, project: unborn, ref: added.ref, full: true });
  const stored = store.getTicket(added.project, added.ref);

  assert.strictEqual(dispatched.spawn.isolation, undefined);
  assert.strictEqual(stored.dispatch.sharedTree, true);
  assert.match(stored.dispatch.worktreeWarning, /repo has no commits/);
  assert.match(dispatched.warnings.join('\n'), /spawning in shared tree/);
});

test('MCP shared-tree dispatch activates the bounded artifact lifecycle', async () => {
  store.setCategory({ id: 'dispatch-artifact', name: 'Dispatch Artifact', route: { model: 'sonnet', effort: 'medium' }, artifactRoots: ['.claude/.codebase-info'] });
  const added = await callTool('add', {
    title: 'shared-tree artifact',
    description: `Write only the declared documentation artifact.\n${store.SHARED_TREE_ARTIFACT_MARKER}`,
    category: 'dispatch-artifact',
    files: ['.claude/.codebase-info/'],
  });
  const dispatched = await callTool('dispatch', { allowUnscoped: true, ref: added.ref, sharedTree: true, full: true });
  const stored = store.getTicket(added.project, added.ref);

  assert.strictEqual(dispatched.spawn.isolation, undefined);
  assert.strictEqual(stored.dispatch.sharedTree, true);
  assert.strictEqual(stored.dispatch.artifactMode, true);
  assert.match(agentsync.renderTicketBriefing(stored, dispatched.token), /\[sidequest-artifact-mode\]/);
});

test('native_agent refuses an executor-held claim instead of opening a second spawn path', async () => {
  const slug = store.ensureProject(PROJ).slug;
  store.setCategory({ id: 'native-dispatch-guard', name: 'Native dispatch guard', route: { model: 'sonnet', effort: 'high' } });
  const held = store.createTicket(slug, {
    title: 'native agent held claim',
    category: 'native-dispatch-guard',
    files: ['plugins/sidequest'],
  });
  const executorSessionId = `native-agent-dispatch-guard-${Date.now()}`;
  const heldDispatch = store.prepareDispatch(slug, held.ref, { allowUnscoped: true, sessionId: MCP_SESSION_ID });
  assert.equal(store.claimTicket(slug, held.ref, 'native-agent-dispatch-guard', {
    token: heldDispatch.token,
    executor: heldDispatch.ticket.dispatchExecutor,
    sessionId: executorSessionId,
  }).ok, true);
  const subordinate = store.createTicket(slug, {
    title: 'native agent subordinate',
    category: 'native-dispatch-guard',
    files: ['plugins/sidequest'],
  });

  const originalSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = executorSessionId;
  try {
    await assert.rejects(
      () => callHandler('native_agent', { ref: subordinate.ref, prompt: 'Implement the ticket.' }),
      /dispatch: refused while you hold SQ-\d+\. Executors cannot dispatch child tickets\. Record the follow-up on SQ-\d+; the orchestration session must dispatch it/,
    );
  } finally {
    process.env.CLAUDE_CODE_SESSION_ID = originalSessionId;
    assert.equal(store.releaseTicket(slug, held.ref, 'native-agent-dispatch-guard', { status: 'todo', source: 'test' }).ok, true);
  }
});

test('native_agent carries ticket anchors and verify command through its stable fallback', async () => {
  seedCatalog([{ slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra', label: 'Terra' }]);
  try {
    store.setCategory({ id: 'native-codex', name: 'Native Codex', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
    const added = await callTool('add', {
      title: 'prompt context', category: 'native-codex',
      anchors: 'lib/work.js:14 executorPrompt', verify: 'node --test plugins/sidequest/test/work.test.js',
    });
    const native = await callHandler('native_agent', { ref: added.ref, prompt: 'Implement exactly this ticket.' });
    assert.strictEqual(native.fallback, true);
    assert.strictEqual(native.file, null);
    assert.strictEqual(native.spawn.subagent_type, 'sidequest-exec-codex-gpt-5-6-terra-high');
    assert.strictEqual(native.spawn.description, 'Terra, high · prompt context');
    assert.strictEqual(native.spawn.name, `${added.ref.toLowerCase()}-prompt-context-terra-high`);
    assert.strictEqual(native.spawn.model, undefined);
    assert.match(native.prompt, /Authoritative ticket contract \(the task prompt may add logistics only; do not narrow this scope\):/);
    assert.match(native.prompt, /Title: prompt context/);
    assert.match(native.prompt, /Anchors:\nlib\/work\.js:14 executorPrompt/);
    assert.match(native.prompt, /Verify command:\nnode --test plugins\/sidequest\/test\/work\.test\.js/);
  } finally {
    clearCatalog();
  }
});

test('native_agent applies explicit ticket route override refusals before spawning', async () => {
  seedCatalog([
    { slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra', label: 'Terra' },
    { slug: 'codex-gpt-5-6-sol', id: 'claude-gpt-5.6-sol', label: 'Sol' },
  ]);
  try {
    const slug = store.ensureProject(PROJ).slug;
    store.setCategory({ id: 'native-route-override-codex', name: 'Native route override Codex', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
    store.setCategory({ id: 'native-route-override-claude', name: 'Native route override Claude', route: { model: 'sonnet', effort: 'high' } });
    const crossing = store.createTicket(slug, {
      title: 'Refuse provider crossing through MCP native agent',
      category: 'native-route-override-claude',
      route: { model: 'codex-gpt-5-6-sol', effort: 'high' },
    });
    const sameProvider = store.createTicket(slug, {
      title: 'Allow same provider through MCP native agent',
      category: 'native-route-override-codex',
      route: { model: 'codex-gpt-5-6-sol', effort: 'high' },
    });

    await assert.rejects(
      () => callHandler('native_agent', { ref: crossing.ref, prompt: 'Implement the ticket.' }),
      /route override "codex-gpt-5-6-sol" crosses providers from category "native-route-override-claude" and was refused/,
    );

    const native = await callHandler('native_agent', { ref: sameProvider.ref, prompt: 'Implement the ticket.' });
    assert.equal(native.effort, 'high');
    assert.equal(native.spawn.subagent_type, 'sidequest-exec-codex-gpt-5-6-sol-high');
  } finally {
    clearCatalog();
  }
});

test('native_agent returns a complete Claude worktree spawn spec', async () => {
  store.setCategory({ id: 'native-fable', name: 'Native Fable', route: { model: 'fable', effort: 'xhigh' } });
  const added = await callTool('add', { title: 'complete native spawn', category: 'native-fable', files: ['plugins/sidequest'] });
  const native = await callHandler('native_agent', { ref: added.ref, prompt: 'Implement the ticket.' });

  assert.deepStrictEqual(native.spawn, {
    subagent_type: 'sidequest:sidequest-exec-xhigh',
    name: added.ref.toLowerCase() + '-complete-native-spawn-fable-xhigh',
    mode: 'bypassPermissions',
    description: 'Claude Fable, xhigh · complete native spawn',
    isolation: 'worktree',
    model: 'fable',
    prompt: native.prompt,
  });
  assert.equal(native.effort, 'xhigh');
  assert.equal(native.projectPath, PROJ);
  assert.match(native.spawn.prompt, new RegExp(`--project "${PROJ.replace(/\\/g, '\\\\')}"`));
});

test('native_agent isolates declared-file tickets unless shared-tree is requested', async () => {
  seedCatalog([{ slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra', label: 'Terra' }]);
  try {
    store.setCategory({ id: 'native-worktree', name: 'Native Worktree', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
    const added = await callTool('add', { title: 'worktree dispatch', category: 'native-worktree', files: ['plugins/sidequest'] });
    const isolated = await callHandler('native_agent', { ref: added.ref, prompt: 'Implement the ticket.' });
    const shared = await callHandler('native_agent', { ref: added.ref, prompt: 'Implement the ticket.', sharedTree: true });
    assert.equal(isolated.spawn.isolation, 'worktree');
    assert.equal(shared.spawn.isolation, undefined);
  } finally {
    clearCatalog();
  }
});

test('an unknown method is a JSON-RPC method-not-found error', async () => {
  const resp = await mcp.handleRequest({ jsonrpc: '2.0', id: 3, method: 'does/not/exist' });
  assert.ok(resp.error, 'returns an error object');
  assert.strictEqual(resp.error.code, -32601);
});

test('add rejects incomplete routing inputs', async () => {
  assert.ok((await callToolRaw('add', { title: 'no score' })).isError, 'missing complexity/why errors');
  assert.ok((await callToolRaw('add', { title: 'bad', complexity: 3, why: 'too short' })).isError, 'a thin why errors');
  assert.ok((await callToolRaw('add', { title: 'direct', complexity: 3, why: 'x'.repeat(25), model: 'grade-3' })).isError, 'a direct model errors');
});
test('add returns a compact acknowledgement', async () => {
  const out = await callTool('add', { title: 'MCP add works', complexity: 3, why: 'a real motivation referencing the actual single-file change' });
  // Complexity 3 and no declared files trips the no-declared-scope warning, so
  // "compact" still carries a warnings key here.
  assert.deepStrictEqual(Object.keys(out).sort(), ['ok', 'project', 'ref', 'status', 'warnings']);
  assert.match(out.ref, /^SQ-\d+$/);
  assert.strictEqual(out.status, 'todo');
});

test('MCP add refuses declared output outside the repo worktree', async () => {
  const outside = path.join(os.tmpdir(), `sq-mcp-add-audition-${process.pid}.html`).replace(/\\/g, '/');
  const refused = await callToolRaw('add', {
    title: 'MCP external output refusal',
    files: [outside],
    complexity: 3,
    why: 'confirm planning guidance appears before an external-output executor dispatch',
  });

  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /paths outside the repo worktree/);
  assert.match(refused.content[0].text, /non-repo\/artifact work/);
});

test('MCP add warns when coding.hard already prescribes a fix', async () => {
  await callTool('category_list', {});
  const added = await callTool('add', {
    title: 'MCP prescriptive hard change',
    category: 'coding.hard',
    description: 'FIX: replace the legacy parser with the shared parser.',
  });
  assert.deepStrictEqual(added.warnings, [
    'coding.hard is for unknown approaches; this description already spells out the fix, which usually means coding.normal. Recheck the category.',
    NO_SCOPE_WARNING,
  ]);
});

test('category stamps stay quiet across MCP server restarts', async () => {
  const session = freshMcpServer();
  const slug = store.ensureProject(PROJ).slug;
  const existing = store.createTicket(slug, { title: 'update without category', category: 'coding.easy' });
  const unchangedCategory = await callToolOn(session, 'update', { ref: existing.ref, title: 'update without a category stamp' });
  assert.deepEqual(unchangedCategory.warnings, [NO_SCOPE_WARNING]);

  await callToolOn(session, 'category_list', {});
  const acknowledged = await callToolOn(session, 'add', { title: 'category stamped after read', category: 'coding.easy' });
  assert.deepEqual(acknowledged.warnings, [NO_SCOPE_WARNING]);

  const restarted = freshMcpServer();
  const afterRestart = await callToolOn(restarted, 'add', { title: 'category stamped after restart', category: 'coding.easy' });
  assert.deepEqual(afterRestart.warnings, [NO_SCOPE_WARNING]);

  await callTool('category_list', {});
});

test('dispatch rejects a thin routed brief but only warns about a missing coding verify command', async () => {
  const added = await callTool('add', { title: 'thin dispatch fixture', category: 'debugging' });
  assert.equal(added.ok, true);
  const refused = await callToolRaw('dispatch', { allowUnscoped: true, ref: added.ref });
  assert.ok(refused.isError);
  assert.match(refused.content[0].text, /executor's entire brief is this ticket/);

  await callTool('update', { ref: added.ref, description: DISPATCH_DESCRIPTION });
  const dispatched = await callTool('dispatch', { ref: added.ref, full: true, allowUnscoped: true });
  assert.deepStrictEqual(dispatched.warnings, [
    `Dispatch warning: ${NO_SCOPE_WARNING.replace('Planning-depth warning: ', '')}`,
    'Dispatch warning: this coding/debugging ticket has no verify command. Add one before the executor starts.',
  ]);

  seedCatalog([{ id: 'claude-gpt-5.6-luna', slug: 'codex-gpt-5-6-luna', label: 'GPT-5.6 Luna' }]);
  const research = await callTool('add', { title: 'research dispatch fixture', description: DISPATCH_DESCRIPTION, category: 'source-lookup' });
  assert.deepEqual((await callTool('dispatch', { allowUnscoped: true, ref: research.ref, full: true })).warnings, []);
});

test('readonly false keeps experiment-shaped spikes on the writing executor', async () => {
  const added = await callTool('add', {
    title: 'mutable spike dispatch fixture',
    description: DISPATCH_DESCRIPTION,
    category: 'spike-investigation',
    readonly: false,
  });
  assert.equal(store.getTicket(added.project, added.ref).readonlyOverride, false);
  const dispatched = await callTool('dispatch', { allowUnscoped: true, ref: added.ref, full: true });
  assert.doesNotMatch(dispatched.agent, /readonly/);
  assert.match(dispatched.warnings.join('\n'), /readonly override active/);

  await callTool('update', { ref: added.ref, readonly: false });
  assert.equal(store.getTicket(added.project, added.ref).readonlyOverride, false);
});

test('update returns a compact acknowledgement', async () => {
  store.setCategory({ id: 'mcp-update-echo', name: 'MCP update echo', route: { model: 'opus', effort: 'high' } });
  const added = await callTool('add', { title: 'MCP update echo', category: 'coding.easy' });
  const updated = await callTool('update', { ref: added.ref, category: 'mcp-update-echo' });
  // The add already served the no-declared-scope warning in this MCP session.
  assert.deepStrictEqual(Object.keys(updated).sort(), ['ok', 'project', 'ref', 'status']);
  assert.equal(store.getTicket(added.project, added.ref).categoryId, 'mcp-update-echo');
});

test('add and update warn only for unknown ticket refs introduced by the operation', async () => {
  const known = await callTool('add', { title: 'known ticket', unclassified: true });
  const added = await callTool('add', { title: `use ${known.ref} and SQ-9999`, unclassified: true });
  assert.deepStrictEqual(added.warnings, ['Unknown ticket refs: SQ-9999.', NO_SCOPE_WARNING]);

  const updated = await callTool('update', { ref: added.ref, description: 'now use SQ-9998' });
  assert.deepStrictEqual(updated.warnings, ['Unknown ticket refs: SQ-9998.']);

  fs.mkdirSync(path.join(PROJ, 'src'), { recursive: true });
  const filesOnly = await callTool('update', { ref: added.ref, files: ['src/changed.ts'] });
  assert.deepStrictEqual(filesOnly.warnings, ['Planning-depth warning: declared file scope does not exist in the repo: src/changed.ts.']);
});

test('status validation fails loudly and directs deletion to remove', async () => {
  const added = await callTool('add', { title: 'strict status', complexity: 1, why: 'exercise loud validation for invalid MCP status values' });
  const invalid = await callToolRaw('update', { ref: added.ref, status: 'deleted' });
  assert.ok(invalid.isError);
  assert.match(invalid.content[0].text, /must be one of: todo, doing, awaiting-oracle, done/);
  assert.throws(() => store.updateTicket(store.ensureProject(PROJ).slug, added.ref, { status: 'deleted' }), /remove tool/i);
  assert.throws(() => store.createTicket(store.ensureProject(PROJ).slug, { title: 'bad status', status: 'deleted' }), /remove tool/i);
});

test('CLI and MCP remove protect live claims; only main-thread MCP force and stale claims delete', async () => {
  const cliLive = await callTool('add', { title: 'CLI live claim removal', unclassified: true });
  assert.equal(store.claimTicket(cliLive.project, cliLive.ref, 'cli-live-worker', { direct: true }).ok, true);
  assert.throws(
    () => runCli(['rm', cliLive.ref, '--project', cliLive.project]),
    (error: any) => /live-claimed by "cli-live-worker".*release the claim first/.test(error.stderr)
  );
  assert.ok(store.getTicket(cliLive.project, cliLive.ref));
  // --force is typeable from an executor's Bash, so it is not a grant: a live
  // claim survives it, and the caller is told the flag cannot override the claim.
  assert.throws(
    () => runCli(['rm', cliLive.ref, '--force', '--project', cliLive.project]),
    (error: any) => /rm --force cannot override a live claim/.test(error.stderr)
  );
  assert.ok(store.getTicket(cliLive.project, cliLive.ref), 'the live-claimed ticket survives rm --force');
  assert.equal(store.releaseTicket(cliLive.project, cliLive.ref, 'cli-live-worker').ok, true);
  runCli(['rm', cliLive.ref, '--project', cliLive.project]);
  assert.equal(store.getTicket(cliLive.project, cliLive.ref), null);

  const cliStale = await callTool('add', { title: 'CLI stale claim removal', unclassified: true });
  assert.equal(store.claimTicket(cliStale.project, cliStale.ref, 'cli-stale-worker', { direct: true }).ok, true);
  const staleCliTicket = store.getTicket(cliStale.project, cliStale.ref);
  staleCliTicket.claim.at = new Date(Date.now() - store.claimIdleMs() - 1).toISOString();
  const db = require('../lib/db.js');
  db.putRow(db.openDb(SIDEQUEST_HOME), 'tickets', {
    id: staleCliTicket.id, project: cliStale.project, ref: staleCliTicket.ref, status: staleCliTicket.status,
    archived: staleCliTicket.archived ? 1 : 0, ord: staleCliTicket.order, claim_by: staleCliTicket.claim.by, data: staleCliTicket,
  });
  runCli(['rm', cliStale.ref, '--project', cliStale.project]);
  assert.equal(store.getTicket(cliStale.project, cliStale.ref), null);

  const mcpLive = await callTool('add', { title: 'MCP live claim removal', unclassified: true });
  assert.equal(store.claimTicket(mcpLive.project, mcpLive.ref, 'mcp-live-worker', { direct: true }).ok, true);
  const refused = await callTool('remove', { project: mcpLive.project, ref: mcpLive.ref });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'claimed');
  assert.equal(refused.claim.by, 'mcp-live-worker');
  assert.ok(store.getTicket(mcpLive.project, mcpLive.ref));
  assert.equal((await callTool('remove', { project: mcpLive.project, ref: mcpLive.ref, force: true })).ok, true);
  assert.equal(store.getTicket(mcpLive.project, mcpLive.ref), null);

  const mcpStale = await callTool('add', { title: 'MCP stale claim removal', unclassified: true });
  assert.equal(store.claimTicket(mcpStale.project, mcpStale.ref, 'mcp-stale-worker', { direct: true }).ok, true);
  const staleMcpTicket = store.getTicket(mcpStale.project, mcpStale.ref);
  staleMcpTicket.claim.at = new Date(Date.now() - store.claimIdleMs() - 1).toISOString();
  db.putRow(db.openDb(SIDEQUEST_HOME), 'tickets', {
    id: staleMcpTicket.id, project: mcpStale.project, ref: staleMcpTicket.ref, status: staleMcpTicket.status,
    archived: staleMcpTicket.archived ? 1 : 0, ord: staleMcpTicket.order, claim_by: staleMcpTicket.claim.by, data: staleMcpTicket,
  });
  assert.equal((await callTool('remove', { project: mcpStale.project, ref: mcpStale.ref })).ok, true);
  assert.equal(store.getTicket(mcpStale.project, mcpStale.ref), null);
});

test('MCP archive and unarchive match the CLI ticket archive lifecycle', async () => {
  const cliTicket = await callTool('add', { title: 'CLI ticket archive', unclassified: true });
  const cliArchived = runCli(['archive', cliTicket.ref, '--project', cliTicket.project, '--json']);
  assert.equal(cliArchived.ok, true);
  assert.equal(store.getTicket(cliTicket.project, cliTicket.ref).archived, true);

  const restored = await callTool('unarchive', { project: cliTicket.project, ref: cliTicket.ref });
  assert.equal(restored.ok, true);
  assert.equal(store.getTicket(cliTicket.project, cliTicket.ref).archived, false);

  const mcpTicket = await callTool('add', { title: 'MCP ticket archive', unclassified: true });
  const archived = await callTool('archive', { project: mcpTicket.project, ref: mcpTicket.ref });
  assert.equal(archived.ok, true);
  assert.equal(store.getTicket(mcpTicket.project, mcpTicket.ref).archived, true);

  const cliRestored = runCli(['unarchive', mcpTicket.ref, '--project', mcpTicket.project, '--json']);
  assert.equal(cliRestored.ok, true);
  assert.equal(store.getTicket(mcpTicket.project, mcpTicket.ref).archived, false);
});

test('MCP admin/config tools share CLI state transitions', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-admin-'));
  const project = store.ensureProject(projectPath).slug;
  const categoryId = `mcp-admin-${process.pid}`;
  const fallback = store.getRoutingFallback();
  try {
    const cliCategory = runCli(['category', 'add', categoryId, '--profile', 'coding', '--name', 'MCP admin category', '--route-model', 'sonnet', '--route-effort', 'low', '--json']);
    assert.equal(cliCategory.ok, true);
    assert.equal((await callTool('category_detach', { project, id: categoryId })).localRow.kind, 'DETACH');
    const relinked = runCli(['category', 'relink', categoryId, '--project', project, '--json']);
    assert.equal(relinked.localRow, null);

    const mcpFallback = await callTool('global_fallback', { project, model: 'sonnet', effort: 'low' });
    assert.deepEqual(runCli(['global-fallback', '--project', project, '--json']).fallback, mcpFallback.fallback);
    const cliFallback = runCli(['global-fallback', '--project', project, '--model', 'opus', '--effort', 'high', '--json']);
    assert.deepEqual((await callTool('global_fallback', { project })).fallback, cliFallback.fallback);

    const a = await callTool('add', { project, title: 'CLI assignment and link', unclassified: true });
    const b = await callTool('add', { project, title: 'MCP assignment and unlink', unclassified: true });
    assert.equal(runCli(['assign', a.ref, '--project', project, '--to', 'cli-owner', '--json']).ticket.assignee, 'cli-owner');
    assert.equal((await callTool('assign', { project, ref: a.ref, to: 'mcp-owner' })).assignee, 'mcp-owner');
    assert.equal(runCli(['link', a.ref, 'related', b.ref, '--project', project, '--json']).ok, true);
    assert.equal((await callTool('unlink', { project, a: a.ref, b: b.ref })).ok, true);
    assert.equal(store.getTicket(project, a.ref).links.length, 0);

    assert.deepEqual(await callTool('models', { project }), runCli(['models', '--project', project, '--json']));
    const projects = await callTool('projects', {});
    assert.ok(projects.projects.some((entry: any) => entry.slug === project) || projects.projectsRetrieval?.tool === 'context_page');
    assert.equal((await callTool('category_rm', { profile: 'coding', id: categoryId })).ok, true);

    const mcpCategoryId = `${categoryId}-mcp`;
    assert.equal((await callTool('category_add', {
      profile: 'coding', id: mcpCategoryId, name: 'MCP-created admin category', routeModel: 'sonnet', routeEffort: 'low',
    })).ok, true);
    assert.ok(runCli(['category', 'list', '--json']).categories.some((category: any) => category.id === mcpCategoryId));
    assert.equal(runCli(['category', 'rm', mcpCategoryId, '--profile', 'coding', '--json']).ok, true);
  } finally {
    if (fallback) store.setRoutingFallback(fallback);
  }
});


test('claim -> comment -> done return compact acknowledgements', async () => {
  const added = await callTool('add', { title: 'work me', complexity: 2, why: 'a straightforward change to exercise the claim/done path over MCP', labels: ['direct-ok'] });
  const ref = added.ref;
  const ticket = store.getTicket(added.project, ref);

  const claim = await callTool('claim', { ref, by: 'mcp-worker-1', direct: true, reason: 'The compact acknowledgement fixture needs a direct claim.' });
  assert.deepStrictEqual(Object.keys(claim).sort(), ['ok', 'project', 'ref', 'status']);
  assert.strictEqual(claim.status, 'doing');

  const note = await callTool('comment', { ref, body: 'progress note from an MCP tool call' });
  assert.deepStrictEqual(Object.keys(note).sort(), ['at', 'commentId', 'ok', 'project', 'ref', 'status']);
  const stored = store.getTicket(added.project, ref).comments.at(-1);
  assert.strictEqual(stored.source, 'mcp', 'MCP actions are tagged as background (not dashboard)');

  const done = await callTool('done', { ref, by: 'mcp-worker-1', model: ticket.model, effort: ticket.effort, body: 'MCP completion evidence' });
  assert.deepStrictEqual(Object.keys(done).sort(), ['ok', 'project', 'ref', 'status']);
  assert.strictEqual(done.status, 'done');
});

test('MCP done requires a final report and release records its reason', async () => {
  const added = await callTool('add', { title: 'required final report', complexity: 2, why: 'exercise final-report validation and durable release reasons', labels: ['direct-ok'] });
  const ticket = store.getTicket(added.project, added.ref);
  await callTool('claim', { ref: added.ref, by: 'mcp-report-worker', direct: true, reason: 'The required-report fixture needs a direct claim.' });

  const missing = await callToolRaw('done', { ref: added.ref, by: 'mcp-report-worker', model: ticket.model, effort: ticket.effort });
  assert.ok(missing.isError, 'done refuses a missing final report');
  assert.equal(missing.content[0].text, 'done: missing required argument "body".');
  const blank = await callToolRaw('done', { ref: added.ref, by: 'mcp-report-worker', model: ticket.model, effort: ticket.effort, body: ' \n\t ' });
  assert.ok(blank.isError, 'done refuses a blank final report');
  assert.match(blank.content[0].text, /"body" is required.*full final report/i);
  assert.ok(store.getTicket(added.project, added.ref).claim, 'report validation keeps the claim');

  await callTool('done', { ref: added.ref, by: 'mcp-report-worker', model: ticket.model, effort: ticket.effort, body: 'Changed mcp.ts; tests passed.' });
  const completed = store.getTicket(added.project, added.ref);
  assert.ok(completed.completion.commentId, 'done stores the completion comment id');
  assert.equal(completed.comments.at(-1).body, 'Changed mcp.ts; tests passed.');

  const released = await callTool('add', { title: 'required release reason', complexity: 2, why: 'exercise durable release-reason validation', labels: ['direct-ok'] });
  await callTool('claim', { ref: released.ref, by: 'mcp-release-worker', direct: true, reason: 'The release-reason fixture needs a direct claim.' });
  const missingReason = await callToolRaw('release', { ref: released.ref, by: 'mcp-release-worker' });
  assert.ok(missingReason.isError, 'release refuses a missing reason');
  assert.match(missingReason.content[0].text, /"reason" is required.*why.*released/i);
  const unclassified = await callTool('release', { ref: released.ref, by: 'mcp-release-worker', reason: 'Scope path was refused.', status: 'todo' });
  assert.equal(unclassified.ok, false, 'release refuses an unclassified reasoned handback');
  assert.equal(unclassified.reason, 'release_kind_required');
  await callTool('release', { ref: released.ref, by: 'mcp-release-worker', reason: 'Scope path was refused.', kind: 'handback', status: 'todo' });
  const afterRelease = store.getTicket(released.project, released.ref);
  assert.equal(afterRelease.claim, null);
  assert.deepEqual(afterRelease.release, {
    kind: 'handback',
    reason: 'Scope path was refused.',
    evidence: null,
    source: 'mcp',
    at: afterRelease.release.at,
  });
  assert.equal(afterRelease.comments.at(-1).body, 'Released: Scope path was refused.');
  assert.equal(afterRelease.comments.at(-1).by, 'mcp-release-worker');
});

test('MCP release records technical-blocker evidence and refuses incomplete evidence', async () => {
  const added = await callTool('add', { title: 'technical blocker evidence', complexity: 2, why: 'exercise evidence required for command-failure handoffs', labels: ['direct-ok'] });
  await callTool('claim', { ref: added.ref, by: 'mcp-technical-blocker-worker', direct: true, reason: 'The technical blocker fixture needs a direct claim.' });

  const incomplete = await callTool('release', {
    ref: added.ref,
    by: 'mcp-technical-blocker-worker',
    reason: 'The targeted test failed.',
    kind: 'technical_blocker',
    command: 'npm run test:files -- test/mcp.test.ts',
    exitCode: 1,
    status: 'todo',
  });
  assert.equal(incomplete.ok, false, 'technical blockers require an output tail');
  assert.equal(incomplete.reason, 'technical_blocker_evidence_required');
  assert.ok(store.getTicket(added.project, added.ref).claim, 'evidence refusal keeps the claim');

  await callTool('release', {
    ref: added.ref,
    by: 'mcp-technical-blocker-worker',
    reason: 'The targeted test failed.',
    kind: 'technical_blocker',
    command: 'npm run test:files -- test/mcp.test.ts',
    exitCode: 1,
    outputTail: 'not ok 1 - technical blocker fixture',
    status: 'todo',
  });
  const released = store.getTicket(added.project, added.ref);
  assert.equal(released.release.kind, 'technical_blocker');
  assert.deepEqual(released.release.evidence, {
    kind: 'technical_blocker',
    command: 'npm run test:files -- test/mcp.test.ts',
    exitCode: 1,
    outputTail: 'not ok 1 - technical blocker fixture',
  });
  assert.match(released.comments.at(-1).body, /Command: npm run test:files -- test\/mcp\.test\.ts/);
  assert.match(released.comments.at(-1).body, /Exit code: 1/);
  assert.match(released.comments.at(-1).body, /not ok 1 - technical blocker fixture/);
});

test('MCP release records contradiction probe evidence and accepts a zero exit code', async () => {
  const added = await callTool('add', { title: 'contradiction evidence', complexity: 2, why: 'exercise probe evidence required for contradiction handoffs', labels: ['direct-ok'] });
  await callTool('claim', { ref: added.ref, by: 'mcp-contradiction-worker', direct: true, reason: 'The contradiction fixture needs a direct claim.' });

  const incomplete = await callTool('release', {
    ref: added.ref,
    by: 'mcp-contradiction-worker',
    reason: 'The named target is absent.',
    kind: 'contradiction',
    command: 'rg -n "named target" plugins/sidequest/src',
    status: 'todo',
  });
  assert.equal(incomplete.ok, false, 'contradictions require actual probe output');
  assert.equal(incomplete.reason, 'contradiction_evidence_required');
  assert.ok(store.getTicket(added.project, added.ref).claim, 'evidence refusal keeps the claim');

  await callTool('release', {
    ref: added.ref,
    by: 'mcp-contradiction-worker',
    reason: 'The named target is absent.',
    kind: 'contradiction',
    command: 'rg -n "named target" plugins/sidequest/src',
    exitCode: 0,
    outputTail: 'no matches',
    status: 'todo',
  });
  const released = store.getTicket(added.project, added.ref);
  assert.match(released.comments.at(-1).body, /Contradiction evidence/);
  assert.match(released.comments.at(-1).body, /Command: rg -n "named target" plugins\/sidequest\/src/);
  assert.match(released.comments.at(-1).body, /Exit code: 0/);
  assert.match(released.comments.at(-1).body, /no matches/);
});

test('MCP release records an oracle handoff without a separate reason', async () => {
  seedCatalog([{ id: 'claude-gpt-5.6-terra', slug: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra' }]);
  const added = await callTool('add', { title: 'oracle release fixture', complexity: 2, why: 'exercise the human verdict handoff through the MCP release surface' });
  const prepared = store.prepareDispatch(added.project, added.ref, { allowUnscoped: true, sessionId: `oracle-release-${Date.now()}` });
  assert.equal(store.claimTicket(added.project, added.ref, 'mcp-oracle-worker', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);

  await callTool('release', {
    project: added.project,
    ref: added.ref,
    by: 'mcp-oracle-worker',
    kind: 'oracle',
    oracle: 'Rank the two rendered candidates without reading the measurements.',
    candidate: 'abc1234',
    deliverable: 'artifacts/comparison.wav',
  });

  const ticket = store.getTicket(added.project, added.ref);
  assert.deepEqual(ticket.oracle, {
    round: 1,
    at: ticket.oracle.at,
    candidate: 'abc1234',
    deliverable: 'artifacts/comparison.wav',
    ask: 'Rank the two rendered candidates without reading the measurements.',
  });
  assert.equal(ticket.status, 'awaiting-oracle');
  assert.equal(ticket.claim, null);
  assert.equal(ticket.comments.at(-1).body, 'Released: Rank the two rendered candidates without reading the measurements.');
  const pulse = await callTool('pulse', { project: added.project, ref: added.ref });
  assert.equal(pulse.oracle.summary, `awaiting oracle since ${ticket.oracle.at}, round 1, candidate abc1234, ask: Rank the two rendered candidates without reading the measurements.`);
});

test('MCP pulse omits a superseded oracle handoff when verdict refuses it', async () => {
  const added = await callTool('add', { title: 'superseded oracle handoff fixture', complexity: 2, why: 'exercise the oracle state after an executor resumes work' });
  const parkedDispatch = store.prepareDispatch(added.project, added.ref, { allowUnscoped: true, sessionId: `oracle-parked-${Date.now()}` });
  assert.equal(store.claimTicket(added.project, added.ref, 'mcp-parked-oracle-worker', {
    token: parkedDispatch.token,
    executor: parkedDispatch.ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.releaseTicket(added.project, added.ref, 'mcp-parked-oracle-worker', {
    releaseKind: 'oracle',
    oracle: 'Choose the candidate that best fits the baseline.',
    candidate: 'abc1234',
  }).ok, true);

  const resumedDispatch = store.prepareDispatch(added.project, added.ref, { allowUnscoped: true, sessionId: `oracle-resumed-${Date.now()}` });
  assert.equal(store.claimTicket(added.project, added.ref, 'mcp-resumed-oracle-worker', {
    token: resumedDispatch.token,
    executor: resumedDispatch.ticket.dispatchExecutor,
  }).ok, true);
  assert.equal((await callTool('comment', {
    project: added.project,
    ref: added.ref,
    by: 'mcp-resumed-oracle-worker',
    body: '[sidequest:verify-complete] passed: resumed work completed.',
  })).ok, true);

  const pulse = await callTool('pulse', { project: added.project, ref: added.ref });
  assert.equal(pulse.status, 'doing');
  assert.equal(pulse.oracle, undefined, 'pulse omits an oracle that verdict would refuse');
  const verdict = await callTool('verdict', {
    project: added.project,
    ref: added.ref,
    text: 'The baseline candidate wins.',
    outcome: 'accepted',
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'no_oracle');
});

test('MCP verdict creates a missing oracle round and refuses a ticket with no oracle marker', async () => {
  const added = await callTool('add', { title: 'oracle verdict fixture', complexity: 2, why: 'exercise the verdict operation through MCP' });
  const prepared = store.prepareDispatch(added.project, added.ref, { allowUnscoped: true, sessionId: `mcp-verdict-${Date.now()}` });
  assert.equal(store.claimTicket(added.project, added.ref, 'mcp-verdict-worker', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.releaseTicket(added.project, added.ref, 'mcp-verdict-worker', {
    releaseKind: 'oracle',
    oracle: 'Rank the candidates.',
    candidate: 'abc1234',
  }).ok, true);

  const verdict = await callTool('verdict', {
    project: added.project,
    ref: added.ref,
    text: 'Candidate B wins.',
    outcome: 'accepted',
    why: 'The transient is less sharp.',
    constraint: 'Keep the transient below the reference.',
  });
  assert.equal(verdict.ok, true);
  assert.equal(store.getTicket(added.project, added.ref).status, 'todo');
  assert.equal(store.getTicket(added.project, added.ref).oracle.verdict.text, 'Candidate B wins.');
  const experiment = store.experimentPacket(added.project, added.ref);
  const log = fs.readFileSync(store.assetPath(added.project, store.getTicket(added.project, added.ref).id, experiment.asset), 'utf8');
  assert.match(log, /Verdict: "Candidate B wins\." — accepted/);
  assert.match(log, /Status: accepted abc1234/);
  assert.match(log, /\[R1\] Keep the transient below the reference\./);

  const refused = await callTool('verdict', {
    project: added.project,
    ref: added.ref,
    text: 'Candidate B wins.',
    outcome: 'accepted',
  });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /not awaiting an oracle verdict/i);
});

test('MCP executor comments without an author keep the active claim holder identity', async () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-comment-claim-holder')).slug;
  const ticket = store.createTicket(project, {
    title: 'comment control-plane fixture', complexity: 1,
    complexityWhy: 'prove an omitted MCP comment author remains distinct from the claim holder',
  });
  const by = 'mcp-comment-claim-holder';
  assert.equal((await callTool('claim', {
    project, ref: ticket.ref, by, direct: true,
    reason: 'The comment attribution fixture requires a local direct claim.',
  })).ok, true);

  assert.equal((await callTool('comment', {
    project,
    ref: ticket.ref,
    body: 'Executor comment without an explicit author.',
  })).ok, true);

  assert.equal(store.getTicket(project, ticket.ref).comments.at(-1).by, by);
});

test('oversized comment acks advise without changing stored bodies', async () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-comment-advisory')).slug;
  const ticket = store.createTicket(project, {
    title: 'comment advisory fixture', complexity: 1, complexityWhy: 'exercise the oversized comment acknowledgement without changing storage',
  });
  const small = 'Tight closeout with commit abc1234.';
  const large = `Verification output:\n${'測'.repeat(1400)}`;

  const smallAck = await callTool('comment', { project, ref: ticket.ref, body: small, by: 'advisory-worker' });
  const largeAck = await callTool('comment', { project, ref: ticket.ref, body: large, by: 'advisory-worker' });
  const stored = store.getTicket(project, ticket.ref).comments;

  assert.equal(smallAck.advisory, undefined);
  assert.match(largeAck.advisory, /body stored in full \(4\.1 KB\); default reads excerpt bodies past 1200 chars/);
  assert.strictEqual(stored[0].body, small);
  assert.strictEqual(stored[1].body, large);

  const completion = store.createTicket(project, {
    title: 'completion advisory fixture', complexity: 1, complexityWhy: 'exercise the oversized completion acknowledgement without changing storage',
  });
  await callTool('claim', { project, ref: completion.ref, by: 'advisory-worker', direct: true, reason: 'The completion advisory fixture requires a direct claim.' });
  const doneAck = await callTool('done', { project, ref: completion.ref, by: 'advisory-worker', model: completion.model, effort: completion.effort, body: large });
  assert.match(doneAck.advisory, /body stored in full \(4\.1 KB\); default reads excerpt bodies past 1200 chars/);
  assert.strictEqual(store.getTicket(project, completion.ref).comments.at(-1).body, large);
});

test('SQ-174: a spaced comment round-trips with spaces intact and no NUL bytes', async () => {
  const added = await callTool('add', { title: 'spaces intact', complexity: 1, why: 'exercise the MCP comment write path preserves internal spaces verbatim' });
  const ref = added.ref;
  const body = 'alpha  beta   gamma    delta'; // 2, 3, then 4 internal spaces
  const posted = await callTool('comment', { ref, body });
  assert.strictEqual(posted.ok, true);
  const back = await callTool('comments', { ref });
  assert.ok(back.comments[back.comments.length - 1].id, 'comments retain ids for replies and references');
  assert.equal(back.comments[back.comments.length - 1].source, undefined, 'comments omit storage-only source metadata');
  const stored = back.comments[back.comments.length - 1].body;
  assert.strictEqual(stored, body, 'the stored body equals the posted body verbatim');
  assert.ok(!stored.includes('\u0000'), 'no NUL byte anywhere in the stored body');
  assert.strictEqual((stored.match(/ /g) || []).length, 9, 'all nine internal spaces survive');
});

test('SQ-174: an author-supplied NUL (a NUL-separated key in prose) is stripped, not persisted', async () => {
  const added = await callTool('add', { title: 'nul stripped', complexity: 1, why: 'a comment describing a NUL-separated dedup key must not persist the raw 0x00' });
  const ref = added.ref;
  // Mirrors the real SQ-171 note that misfired: `source + '\0' + slug`, but with
  // a genuine 0x00 char between the quotes (as the reporter's body had).
  const body = 'dedup key: source + \u0000 + slug (works)';
  const posted = await callTool('comment', { ref, body });
  assert.strictEqual(posted.ok, true, 'the comment still stores (a lone control byte is normalized, not rejected)');
  const back = await callTool('comments', { ref });
  const stored = back.comments[back.comments.length - 1].body;
  assert.ok(!stored.includes('\u0000'), 'the raw NUL is gone from storage');
  assert.strictEqual(stored, 'dedup key: source +  + slug (works)', 'only the NUL is removed; surrounding spaces stay');
});

test('SQ-404: long handoff comments are stored whole and still have a clear cap', async () => {
  const added = await callTool('add', { title: 'long handoff', complexity: 1, why: 'confirm durable evidence can outlast the bounded executor digest' });
  const ref = added.ref;

  const handoff = 'x'.repeat(5481);
  const stored = await callTool('comment', { ref, body: handoff });
  assert.strictEqual(stored.ok, true, 'a useful long handoff stores whole');
  assert.strictEqual((await callTool('comments', { ref, full: true })).comments[0].body.length, 5481);

  const tooLong = 'x'.repeat(16001);
  const rejected = await callTool('comment', { ref, body: tooLong });
  assert.strictEqual(rejected.ok, false, 'the storage cap still rejects oversized bodies');
  assert.strictEqual(rejected.reason, 'too_long');
  assert.strictEqual(rejected.max, 16000, 'the error names the expanded cap');
  assert.strictEqual(rejected.length, 16001, 'the error names the actual length');
});

test('SQ-1015: plan writes replace-whole-document, past the 16K comment cap, and reject oversized bodies', async () => {
  const added = await callTool('add', { title: 'plan document fixture', complexity: 1, why: 'exercise the plan MCP verb round trip' });
  const ref = added.ref;

  const first = `# Plan\n\n${'x'.repeat(60_000)}`;
  const written = await callTool('plan', { ref, body: first, by: 'planner-1' });
  assert.strictEqual(written.ok, true);
  assert.strictEqual(written.revision, 1);
  assert.ok(written.path, 'the write ack names the stored path');
  assert.strictEqual(fs.readFileSync(written.path, 'utf8'), first, 'the plan asset holds the full body, unbounded by the comment cap');

  const second = '# Replaced plan\n\nEntirely different content.';
  const replaced = await callTool('plan', { ref, body: second, by: 'planner-2' });
  assert.strictEqual(replaced.ok, true);
  assert.strictEqual(replaced.revision, 2, 'a rewrite bumps the revision rather than appending');
  assert.strictEqual(fs.readFileSync(replaced.path, 'utf8'), second, 'the document is replaced whole, not appended to');
  assert.strictEqual(replaced.path, written.path, 'the plan lives at one stable path across revisions');

  const tooLong = 'x'.repeat(256 * 1024 + 1);
  const rejected = await callTool('plan', { ref, body: tooLong });
  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(rejected.reason, 'too_long');
  assert.strictEqual(rejected.max, 256 * 1024);
  assert.strictEqual(rejected.length, 256 * 1024 + 1);
  assert.strictEqual(fs.readFileSync(replaced.path, 'utf8'), second, 'a rejected oversized write leaves the prior revision untouched');

  const empty = await callTool('plan', { ref, body: '   ' });
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.reason, 'empty');
});

test('claim requires a worker id (no shared-identity default)', async () => {
  const added = await callTool('add', { title: 'needs by', complexity: 2, why: 'confirm the atomic-claim identity guard is enforced over MCP' });
  const res = await callToolRaw('claim', { ref: added.ref });
  assert.ok(res.isError, 'a claim without by is refused');
  assert.match(res.content[0].text, /missing required argument "by"/);
});

test('MCP guidance protects live claims and labels force operator-only', async () => {
  const added = await callTool('add', { title: 'live claim recovery guidance', category: 'coding.easy' });
  const owner = 'mcp-live-guidance-owner';
  const claimed = await callTool('claim', {
    ref: added.ref,
    by: owner,
    direct: true,
    reason: 'This fixture directly checks the claimed-refusal recovery guidance.',
  });
  assert.equal(claimed.ok, true);
  try {
    const refused = await callTool('claim', {
      ref: added.ref,
      by: 'mcp-live-guidance-contender',
      direct: true,
      reason: 'This fixture checks that an already claimed ticket cannot be taken over.',
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'claimed');
    assert.match(refused.message, new RegExp(`sidequest pulse ${added.ref}`));
    assert.match(refused.message, /observed terminal evidence/);
    assert.match(refused.message, /salvage useful work/);
    assert.match(refused.message, new RegExp(`sidequest release ${added.ref}`));
    assert.doesNotMatch(refused.message, /use `--force`/);

    const claimTool = mcp.toolDescriptors().find((tool: any) => tool.name === 'claim');
    assert.match(claimTool.inputSchema.properties.force.description, /Operator-only/);
  } finally {
    assert.equal(store.releaseTicket(added.project, added.ref, owner, { status: 'todo', source: 'test' }).ok, true);
  }
});

test('MCP dispatch returns the Codex readiness recovery text without preparing state', async () => {
  const message = 'Codex dispatch refused: claude-code-proxy is not answering on /v1/models. Run `node "gateway" ensure`, then retry. No Anthropic fallback was used.';
  seedCatalog([{ id: 'claude-gpt-5.6-terra', slug: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra' }], {
    ready: false,
    state: 'proxy-down',
    message,
  });
  try {
    store.setCategory({ id: 'mcp-readiness-refusal', name: 'MCP readiness refusal', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
    const added = await callTool('add', { title: 'readiness refusal', description: DISPATCH_DESCRIPTION, category: 'mcp-readiness-refusal' });
    const refused = await callToolRaw('dispatch', { allowUnscoped: true, ref: added.ref });
    assert.ok(refused.isError);
    assert.equal(refused.content[0].text, message);
    const ticket = store.getTicket(added.project, added.ref);
    assert.equal(ticket.dispatchNonce, null);
    assert.equal(ticket.dispatch, null);
  } finally {
    seedCatalog([
      { id: 'claude-gpt-5.6-terra', slug: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra' },
      { id: 'claude-gpt-5.6-luna', slug: 'codex-gpt-5-6-luna', label: 'GPT-5.6 Luna' },
    ]);
  }
});

test('MCP dispatch refuses external providers without a ready schema-4 entry', async () => {
  const grok = { id: 'claude-grok-test', slug: 'grok-test', label: 'Grok Test', provider: 'grok' };
  const fixtures = [
    { id: 'missing-provider', providers: { codex: { ready: true, state: 'ready', message: 'Codex is ready.' } }, expected: /provider grok is unavailable/ },
    { id: 'missing-readiness', providers: { grok: {} }, expected: /provider grok is unavailable/ },
    { id: 'not-ready', providers: { grok: { ready: false, state: 'signed-out', message: 'Sign in to Grok CLI.' } }, expected: /grok dispatch refused: Sign in to Grok CLI\./ },
  ];
  try {
    for (const fixture of fixtures) {
      seedCatalogV4([grok], fixture.providers);
      store.setCategory({ id: `mcp-grok-${fixture.id}`, name: `MCP Grok ${fixture.id}`, route: { model: grok.slug, effort: 'high' } });
      const added = await callTool('add', { title: `grok ${fixture.id}`, description: DISPATCH_DESCRIPTION, category: `mcp-grok-${fixture.id}` });
      const refused = await callToolRaw('dispatch', { allowUnscoped: true, ref: added.ref });
      assert.ok(refused.isError);
      assert.match(refused.content[0].text, fixture.expected);
      assert.match(refused.content[0].text, /No Anthropic fallback was used\./);
      const ticket = store.getTicket(added.project, added.ref);
      assert.equal(ticket.dispatchNonce, null);
      assert.equal(ticket.dispatch, null);
    }
  } finally {
    seedCatalog([
      { id: 'claude-gpt-5.6-terra', slug: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra' },
      { id: 'claude-gpt-5.6-luna', slug: 'codex-gpt-5-6-luna', label: 'GPT-5.6 Luna' },
    ]);
  }
});

test('MCP claim binds an unlaunched isolated dispatch with its prepared token', async () => {
  seedCatalog([{ id: 'claude-gpt-5.6-terra[1m]', slug: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra' }]);
  store.setCategory({ id: 'mcp-dispatch-claim', name: 'MCP dispatch claim', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
  const added = await callTool('add', { title: 'nonce through MCP', category: 'mcp-dispatch-claim' });
  const slug = store.ensureProject(PROJ).slug;
  const prepared = store.prepareDispatch(slug, added.ref, { allowUnscoped: true, sessionId: 'mcp-launch-session', sharedTree: false });
  const refused = await callTool('claim', { ref: added.ref, by: 'mcp-no-token' });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'token');

  const accepted = await callTool('claim', {
    ref: added.ref,
    by: 'mcp-token-bound-agent',
    tokenFile: prepared.ticket.dispatch.tokenFile,
    executor: prepared.ticket.dispatchExecutor,
  });
  assert.strictEqual(accepted.ok, true);
  const dispatch = store.getTicket(slug, added.ref).dispatch;
  assert.equal(dispatch.bindSource, 'claim_token');
  assert.equal(dispatch.sessionId, MCP_SESSION_ID);
  assert.ok(dispatch.boundAt);
  assert.equal(store.releaseTicket(slug, added.ref, 'mcp-token-bound-agent', { status: 'todo', source: 'test' }).ok, true);
});

test('MCP dispatch recovers a live claim without releasing it', async () => {
  const project = committedRepo('sq-mcp-live-claim-recovery-');
  const slug = store.ensureProject(project).slug;
  const originalSession = `mcp-live-claim-${Date.now()}`;
  const resumedSession = `${originalSession}-resumed`;
  const claimHolder = `mcp-live-claim-worker-${Date.now()}`;
  const agentName = `mcp-live-claim-agent-${Date.now()}`;
  const worktree = path.join(FIXTURE_ROOT, agentName);
  store.setCategory({ id: 'mcp-live-claim-recovery', name: 'MCP live claim recovery', route: { model: 'sonnet', effort: 'high' } });
  const ticket = store.createTicket(slug, {
    title: 'MCP live claim recovery',
    description: DISPATCH_DESCRIPTION,
    category: 'mcp-live-claim-recovery',
    files: ['recovered.js'],
    executorVerify: 'node --test test/mcp.test.ts',
    source: 'test',
  });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: originalSession, sharedTree: false });
  const executor = prepared.ticket.dispatchExecutor;
  try {
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId: originalSession,
      token: prepared.token,
      executor,
      agentName,
    }).ok, true);
    assert.equal(store.claimTicket(slug, ticket.ref, claimHolder, {
      sessionId: originalSession,
      token: prepared.token,
      executor,
      requireBoundAgent: true,
    }).ok, true);
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    execFileSync('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], { cwd: project, windowsHide: true });
    const gitDirectory = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: worktree, encoding: 'utf8', windowsHide: true }).trim();
    createCheckoutInstanceMarker(path.isAbsolute(gitDirectory) ? gitDirectory : path.resolve(worktree, gitDirectory));
    fs.rmSync(prepared.ticket.dispatch.tokenFile);

    const recovered = await callToolAsSession(resumedSession, 'dispatch', {
      project: slug,
      ref: ticket.ref,
      recoveryEvidence: 'The resumed executor lost its token file and worktree binding after an API failure.',
      claimHolder,
      worktree,
      full: true,
    });
    assert.equal(recovered.ref, ticket.ref);
    assert.equal(recovered.recovery.kind, 'live_claim_resume');
    assert.equal(store.getTicket(slug, ticket.ref).claim.by, claimHolder);
    assert.equal(store.readDispatchBriefing(slug, ticket.ref, undefined, prepared.ticket.dispatch.tokenFile).ok, true);
  } finally {
    store.releaseTicket(slug, ticket.ref, claimHolder, { status: 'todo', source: 'test', force: true });
    if (fs.existsSync(worktree)) execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: project, windowsHide: true });
  }
});

test('MCP blocks no-dispatch routed claims and records an explicit direct research bypass', async () => {
  const added = await callTool('add', { title: 'no-file research', category: 'coding.easy' });
  const ticket = store.getTicket(added.project, added.ref);
  assert.deepStrictEqual(ticket.files, []);
  const refused = await callTool('claim', { ref: added.ref, by: 'mcp-routed', effort: ticket.effort, executor: ticket.exec.agent });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'dispatch_required');
  assert.match(refused.message, /dispatch/i);
  assert.match(refused.message, /direct:true/i);
  const direct = await callTool('claim', { ref: added.ref, by: 'mcp-inline', direct: true, reason: 'The MCP research fixture requires a local direct claim.' });
  assert.strictEqual(direct.ok, true);
  const pulse = await callTool('pulse', { ref: added.ref, full: true });
  assert.strictEqual(pulse.direct.by, 'mcp-inline');
  assert.strictEqual(pulse.direct.model, ticket.model);
});

test('MCP direct-claim refusal requires a reason and prints the prepared executor call', async () => {
  const added = await callTool('add', { title: 'direct reason required', category: 'coding.easy' });
  const refused = await callTool('claim', { ref: added.ref, by: 'mcp-direct-refusal', direct: true });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'direct_reason_required');
  assert.match(refused.message, /recorded direct rationale/);
  assert.match(refused.message, /inline-safe/);
});

test('MCP direct claim refuses rationalizations outside the inline-safe allowlist', async () => {
  const added = await callTool('add', { title: 'invalid direct rationale', category: 'coding.easy' });
  const refused = await callTool('claim', {
    ref: added.ref,
    by: 'mcp-invalid-direct-reason',
    direct: true,
    reason: 'The context already loaded makes this a faster myself small change.',
  });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'direct_not_allowed');
  assert.match(refused.message, /inline-safe allowlist/);
  assert.match(refused.message, /new behavior\/API/);
  assert.match(refused.message, /failing test that does not pinpoint/);
});

test('MCP claim rejects a generic executor for a Codex route', async () => {
  seedCatalog([{ id: 'claude-gpt-5.6-terra[1m]', slug: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra' }]);
  try {
    store.setCategory({ id: 'claim-codex', name: 'Claim Codex', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
    const added = await callTool('add', { title: 'Codex executor guard', category: 'claim-codex' });
    const ticket = store.getTicket(store.ensureProject(PROJ).slug, added.ref);
    const prepared = store.prepareDispatch(store.ensureProject(PROJ).slug, added.ref, { allowUnscoped: true });
    const rejected = await callTool('claim', { ref: added.ref, by: 'mcp-generic', effort: ticket.effort, executor: `sidequest-exec-${ticket.effort}`, tokenFile: prepared.ticket.dispatch.tokenFile });
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.reason, 'executor_mismatch');
    assert.strictEqual(rejected.expectedExecutor, prepared.ticket.dispatchExecutor);
    assert.ok(rejected.message.includes('Expected executor: `' + prepared.ticket.dispatchExecutor + '`'));
    assert.ok(rejected.message.includes(`executor: ${JSON.stringify(prepared.ticket.dispatchExecutor)}`));
    assert.ok(rejected.message.includes(`tokenFile: ${JSON.stringify(prepared.ticket.dispatch.tokenFile)}`));
    assert.ok(rejected.message.includes(`project: ${JSON.stringify(PROJ)}`));
  } finally {
    clearCatalog();
  }
});

test('MCP token-file claims use the prepared readonly executor and resolve once', async () => {
  seedCatalog([{ id: 'claude-gpt-5.6-terra[1m]', slug: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra' }]);
  try {
    const slug = store.ensureProject(PROJ).slug;
    store.setCategory({ id: 'mcp-readonly-token-file', name: 'MCP readonly token file', readonly: true, route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
    const accepted = await callTool('add', { title: 'MCP readonly token-file success', category: 'mcp-readonly-token-file' });
    const prepared = store.prepareDispatch(slug, accepted.ref, { allowUnscoped: true, sessionId: 'mcp-readonly-token-file' });
    assert.notEqual(store.getTicket(slug, accepted.ref).exec.agent, prepared.ticket.dispatchExecutor);
    const tokenFile = prepared.ticket.dispatch.tokenFile;
    const originalReadFileSync = fs.readFileSync;
    let tokenFileReads = 0;
    fs.readFileSync = function (filename: any, ...args: any[]) {
      if (path.resolve(String(filename)) === path.resolve(tokenFile)) tokenFileReads += 1;
      return originalReadFileSync.call(fs, filename, ...args);
    };
    try {
      const claimed = await callTool('claim', { ref: accepted.ref, by: 'mcp-readonly-token-file', executor: prepared.ticket.dispatchExecutor, tokenFile });
      assert.equal(claimed.ok, true);
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
    assert.equal(tokenFileReads, 1);
    assert.equal(store.releaseTicket(slug, accepted.ref, 'mcp-readonly-token-file', { status: 'todo', source: 'test' }).ok, true);

    const wrong = await callTool('add', { title: 'MCP readonly token-file mismatch', category: 'mcp-readonly-token-file' });
    const wrongPrepared = store.prepareDispatch(slug, wrong.ref, { allowUnscoped: true, sessionId: 'mcp-readonly-token-file-wrong' });
    const mismatch = await callTool('claim', { ref: wrong.ref, by: 'mcp-wrong-readonly-token-file', executor: 'sidequest-exec-dispatch', tokenFile: wrongPrepared.ticket.dispatch.tokenFile });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reason, 'executor_mismatch');
    assert.equal(mismatch.expectedExecutor, wrongPrepared.ticket.dispatchExecutor);

    const invalidTokenFile = path.join(FIXTURE_ROOT, 'invalid-dispatch.token');
    fs.writeFileSync(invalidTokenFile, 'invalid-dispatch-token\n');
    const invalid = await callTool('claim', { ref: wrong.ref, by: 'mcp-invalid-token-file', executor: wrongPrepared.ticket.dispatchExecutor, tokenFile: invalidTokenFile });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.reason, 'token');
  } finally {
    clearCatalog();
  }
});

test('claim with a mismatched effort is refused (drift guard mirrors the CLI)', async () => {
  const added = await callTool('add', { title: 'effort guard', category: 'coding.easy' });
  const ref = added.ref;
  const derived = store.getTicket(added.project, added.ref).effort;
  assert.ok(derived, 'routing on -> a derived effort');
  const wrong = store.VALID_EFFORTS.find((e: any) => e !== derived);
  const res = await callTool('claim', { ref, by: 'mcp-w', effort: wrong });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'effort_mismatch');
  assert.strictEqual(res.derivedEffort, derived);
  // The ticket must stay unclaimed after a refused claim.
  const after = await callTool('list', {});
  const t = after.tickets.find((x: any) => x.ref === ref);
  assert.strictEqual(t.status, 'todo');
  assert.equal(Object.hasOwn(t, 'claim'), false);
});

test('MCP board reads omit taxonomy and default ready rows stay summary-sized', async () => {
  const added = await callTool('add', { title: 'trimmed taxonomy response', category: 'coding.easy' });
  const list = await callTool('list', {});
  const ready = await callTool('ready', {});
  const changes = await callTool('changes', {});
  const pulse = await callTool('pulse', { ref: added.ref });

  assert.equal(list.categories, undefined);
  assert.equal(ready.categories, undefined);
  assert.equal(changes.categories, undefined);
  assert.equal(pulse.categories, undefined);
  assert.equal(typeof list.claimIdleMs, 'number');
  assert.equal(ready.claimIdleMs, undefined);
  assert.equal(list.tickets.find((ticket: any) => ticket.ref === added.ref).categoryId, 'coding.easy');
  // SQ-348: priority rides each default row so the bands are visible before a dispatch is chosen.
  assert.deepEqual(ready.tickets.find((ticket: any) => ticket.ref === added.ref), { ref: added.ref, title: 'trimmed taxonomy response', priority: 'normal' });
  assert.equal(ready.count, ready.tickets.length);
});

test('MCP brief ready response stays under 2 KB', async () => {
  const small = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-trimmed-ready'), 'SQ trimmed ready');
  store.createTicket(small.slug, { title: 'the only ticket', category: 'coding.easy' });
  const out = await callToolRaw('ready', { project: small.slug, brief: true });
  assert.ok(out.content[0].text.length < 2048, `brief ready response is ${out.content[0].text.length} bytes`);
});


test('read-only calls can finish out of order while retaining their JSON-RPC ids', async () => {
  const tool = mcp.TOOLS.find((candidate: any) => candidate.name === 'list');
  const original = tool.handler;
  const releases: Array<() => void> = [];
  tool.handler = (args: any) => new Promise((resolve) => releases.push(() => resolve({ marker: args.ref })));
  try {
    const first = mcp.handleRequest({ jsonrpc: '2.0', id: 9101, method: 'tools/call', params: { name: 'list', arguments: { ref: 'first' } } });
    const second = mcp.handleRequest({ jsonrpc: '2.0', id: 9102, method: 'tools/call', params: { name: 'list', arguments: { ref: 'second' } } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(releases.length, 2);
    releases[1]!();
    const secondResponse = await second;
    releases[0]!();
    const firstResponse = await first;
    assert.equal(secondResponse.id, 9102);
    assert.equal(firstResponse.id, 9101);
    assert.deepEqual(JSON.parse(secondResponse.result.content[0].text), { marker: 'second' });
  } finally {
    tool.handler = original;
  }
});

test('mutations queue FIFO per board without blocking another board', async () => {
  const tool = mcp.TOOLS.find((candidate: any) => candidate.name === 'comment');
  const original = tool.handler;
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  tool.handler = (args: any) => new Promise((resolve) => {
    started.push(args.ref);
    releases.set(args.ref, () => resolve({ marker: args.ref }));
  });
  const first = mcp.handleRequest({ jsonrpc: '2.0', id: 9201, method: 'tools/call', params: { name: 'comment', arguments: { project: PROJ, ref: 'first', body: 'first comment' } } });
  const second = mcp.handleRequest({ jsonrpc: '2.0', id: 9202, method: 'tools/call', params: { name: 'comment', arguments: { project: PROJ, ref: 'second', body: 'second comment' } } });
  const otherProject = store.ensureProject(path.join(FIXTURE_ROOT, 'other-board')).slug;
  const other = mcp.handleRequest({ jsonrpc: '2.0', id: 9203, method: 'tools/call', params: { name: 'comment', arguments: { project: otherProject, ref: 'other', body: 'other comment' } } });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ['first', 'other']);
    releases.get('other')!();
    await other;
    releases.get('first')!();
    await first;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ['first', 'other', 'second']);
    releases.get('second')!();
    await second;
  } finally {
    for (const release of releases.values()) release();
    await new Promise((resolve) => setImmediate(resolve));
    for (const release of releases.values()) release();
    await Promise.allSettled([first, second, other]);
    tool.handler = original;
  }
});

test('the real stdio server frames newline-delimited JSON-RPC', async () => {
  const BIN = path.join(__dirname, '..', 'bin', 'sidequest-mcp.js');
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list', arguments: {} } },
  ];
  const input = requests.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const env = Object.assign({}, process.env, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJ });
  const res = spawnSync(process.execPath, [BIN], { input, encoding: 'utf8', env, timeout: 10000 });
  const lines = (res.stdout || '').split('\n').filter((l: any) => l.trim());
  const parsed = lines.map((l: any) => JSON.parse(l));
  // Three responses (the notification produced none).
  assert.strictEqual(parsed.length, 3, `expected 3 responses, got ${parsed.length}: ${res.stdout}`);
  assert.strictEqual(parsed[0].id, 1);
  assert.ok(parsed[0].result.serverInfo);
  assert.strictEqual(parsed[1].id, 2);
  assert.ok(Array.isArray(parsed[1].result.tools));
  assert.strictEqual(parsed[2].id, 3);
  assert.ok(!parsed[2].result.isError, 'list tool call succeeded');
});

test('models reports concrete routes and no grade output', async () => {
  seedCatalog([{ slug: 'codex-terra', id: 'claude-gpt-5.6-terra[1m]', label: 'Codex Terra' }]);
  try {
    store.setCategory({ id: 'model-codex', name: 'Model Codex', route: { model: 'codex-terra', effort: 'high' }, fallback: { model: 'opus', effort: 'high' } });
    const out = await callHandler('models', {});
    assert.ok(out.models.includes('codex-terra'));
    assert.ok(out.categories.some((category: any) => category.id === 'model-codex' && category.route === 'codex-terra·high'));
    const full = await callHandler('models', { full: true });
    assert.ok(full.categories.some((category: any) => category.id === 'model-codex' && category.resolved.model === 'codex-terra'));
    assert.ok(!JSON.stringify(out).includes('grade-'));
  } finally {
    clearCatalog();
  }
});

test('route_recipe resolves a live route and makes category errors explicit', async () => {
  seedCatalog([{ slug: 'codex-terra', id: 'claude-gpt-5.6-terra[1m]', label: 'Codex Terra' }]);
  try {
    store.setCategory({ id: 'recipe-codex', name: 'Recipe Codex', route: { model: 'codex-terra', effort: 'high' } });
    const recipe = await callTool('route_recipe', { category: 'recipe-codex' });
    assert.deepEqual(recipe.route, { model: 'codex-terra', effort: 'high' });
    assert.deepEqual(recipe.agent, {
      model: 'claude-gpt-5.6-terra[1m]',
      promptPrefix: '',
    });
    assert.equal(recipe.effortCarrier, 'frontmatter');
    assert.deepEqual(recipe.warnings, []);

    store.setCategory({ id: 'recipe-disabled', name: 'Recipe Disabled', route: { model: 'sonnet', effort: 'high' }, enabled: false });
    const disabled = await callToolRaw('route_recipe', { category: 'recipe-disabled' });
    assert.ok(disabled.isError);
    assert.match(disabled.content[0].text, /disabled for this project/i);

    const unknown = await callToolRaw('route_recipe', { category: 'missing-recipe' });
    assert.ok(unknown.isError);
    assert.match(unknown.content[0].text, /unknown/i);

    const resolveCategoryRoute = store.resolveCategoryRoute;
    store.resolveCategoryRoute = () => ({ exec: null });
    try {
      const unroutable = await callToolRaw('route_recipe', { category: 'recipe-codex' });
      assert.ok(unroutable.isError);
      assert.match(unroutable.content[0].text, /no available route/i);
    } finally {
      store.resolveCategoryRoute = resolveCategoryRoute;
    }
  } finally {
    clearCatalog();
  }
});

test('done stamps workedBy with a discovered Codex slug', async () => {
  seedCatalog([{ slug: 'codex-terra', id: 'claude-gpt-5.6-terra[1m]' }]);
  try {
    store.setCategory({ id: 'provenance-codex', name: 'Provenance Codex', route: { model: 'codex-terra', effort: 'high' } });
    const added = await callTool('add', { title: 'codex provenance', category: 'provenance-codex' });
    const ref = added.ref;
    await callTool('claim', { ref, by: 'mcp-w-codex' });
    const done = await callTool('done', { ref, by: 'mcp-w-codex', model: 'codex-terra', effort: 'high', body: 'Codex completion evidence' });
    assert.strictEqual(done.ok, true);
    assert.strictEqual(store.getTicket(added.project, ref).workedBy.model, 'codex-terra');
  } finally {
    clearCatalog();
  }
});

test('reporting aliases resolve to catalog slugs and dispatched done defaults provenance', async () => {
  seedCatalog([
    { slug: 'codex-gpt-5-6-terra-fast', id: 'claude-gpt-5.6-terra-fast[1m]' },
    { slug: 'codex-gpt-5-6-luna-fast', id: 'claude-gpt-5.6-luna-fast[1m]' },
  ]);
  try {
    store.setCategory({ id: 'alias-codex', name: 'Alias Codex', route: { model: 'codex-gpt-5-6-terra-fast', effort: 'high' } });
    const complete = async (title: any, model?: any) => {
      const added = await callTool('add', {
        title,
        category: 'alias-codex',
        description: DISPATCH_DESCRIPTION,
        verify: 'node --test test/mcp.test.js',
      });
      const prepared = await callTool('dispatch', { allowUnscoped: true, ref: added.ref, full: true });
      const by = `mcp-alias-${added.ref}`;
      await callTool('claim', { ref: added.ref, by, executor: prepared.agent, effort: 'high', tokenFile: store.getTicket(added.project, added.ref).dispatch.tokenFile });
      await callTool('done', { ref: added.ref, by, body: 'Alias completion evidence', ...(model == null ? {} : { model, effort: 'high' }) });
      return store.getTicket(added.project, added.ref);
    };

    for (const alias of ['gpt-5.6-terra-fast', 'claude-gpt-5.6-terra-fast[1m]', 'CLAUDE-CODEX-GPT-5.6-TERRA-FAST']) {
      const ticket = await complete(`alias ${alias}`, alias);
      assert.equal(ticket.workedBy.model, 'codex-gpt-5-6-terra-fast');
    }
    assert.equal(store.classifyModelFilter('gpt-5.6-terra-fast'), 'codex-gpt-5-6-terra-fast');
    assert.equal(store.classifyModelFilter('claude-gpt-5.6-terra-fast'), 'codex-gpt-5-6-terra-fast');
    assert.throws(() => store.setCategory({
      id: 'alias-route-rejected',
      name: 'Alias Route Rejected',
      route: { model: 'gpt-5.6-terra-fast', effort: 'high' },
    }), /valid model and effort/);
    await callTool('ready', { model: 'gpt-5.6-terra-fast' });

    const defaulted = await complete('dispatched default');
    assert.deepEqual(defaulted.workedBy.model, 'codex-gpt-5-6-terra-fast');
    assert.deepEqual(defaulted.workedBy.effort, 'high');

    const overridden = await complete('dispatched alternate model', 'gpt-5.6-luna-fast');
    assert.equal(overridden.workedBy.model, 'codex-gpt-5-6-luna-fast');

    const added = await callTool('add', {
      title: 'unknown alias',
      category: 'alias-codex',
      description: DISPATCH_DESCRIPTION,
      verify: 'node --test test/mcp.test.js',
    });
    const prepared = await callTool('dispatch', { allowUnscoped: true, ref: added.ref, full: true });
    const unknown = await callToolRaw('done', { ref: added.ref, by: 'mcp-alias-unknown', model: 'claude-codex-auto', body: 'Unknown-model completion evidence' });
    assert.ok(unknown.isError);
    assert.match(unknown.content[0].text, /expected for .*: codex-gpt-5-6-terra-fast/);
    assert.equal(store.getTicket(added.project, added.ref).dispatchNonce, prepared.token);
  } finally {
    clearCatalog();
  }
});

test('ready with an unrecognized model errors instead of silently meaning "no filter"', async () => {
  const res = await callToolRaw('ready', { model: 'totally-bogus-tier' });
  assert.ok(res.isError, 'an unrecognized model filter is refused, not silently ignored');
  assert.match(res.content[0].text, /unknown model/i);
  assert.match(res.content[0].text, /totally-bogus-tier/, 'names the offending value');
});

test('claim guard refusal names the Codex-backed executor for a concrete route', async () => {
  seedCatalog([{ slug: 'codex-terra', id: 'claude-gpt-5.6-terra[1m]' }]);
  try {
    store.setCategory({ id: 'guard-codex', name: 'Guard Codex', route: { model: 'codex-terra', effort: 'high' } });
    const added = await callTool('add', { title: 'codex guard', category: 'guard-codex' });
    const wrong = store.VALID_EFFORTS.find((effort: any) => effort !== store.getTicket(added.project, added.ref).effort);
    const res = await callTool('claim', { ref: added.ref, by: 'mcp-w-guard', effort: wrong });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'effort_mismatch');
    assert.match(res.message, /spawn sidequest-exec-codex-gpt-5-6-terra-1m-high./);
  } finally {
    clearCatalog();
  }
});

test('SQ-228: a large board pages under the cap; cursors iterate the full set exactly once', async () => {
  // A dedicated board so seeding 500 tickets can't perturb the shared-board
  // tests above. Every call passes project explicitly.
  const big = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-bigboard-228'), 'SQ-228 Big Board');
  const N = 500;
  for (let i = 0; i < N; i++) {
    store.createTicket(big.slug, { title: `bulk todo ticket number ${i} on the oversized board`, files: [`lib/mod-${i}.js`] });
  }

  // all:true is the escape hatch — the whole column in one call, and (this is the
  // bug) it serializes far past the tool-result ceiling. total/returned agree.
  const allRes = await callTool('list', { project: big.slug, all: true });
  assert.strictEqual(allRes.total, N, 'all:true reports the true total');
  assert.equal(allRes.ticketsRetrieval.tool, 'context_page');
  const allRows = [...allRes.tickets];
  let allCursor = allRes.ticketsRetrieval.arguments.cursor;
  while (allCursor !== null) {
    const page = await callTool('context_page', { ...allRes.ticketsRetrieval.arguments, cursor: allCursor, limit: 70 * 1024 });
    allRows.push(...page.rows);
    allCursor = page.nextCursor;
  }
  assert.strictEqual(allRows.length, N, 'all 500 remain retrievable through the continuation');
  const allChars = await resultChars('list', { project: big.slug, all: true });
  assert.ok(allChars <= 70 * 1024, `compact all:true stays under the result ceiling (${allChars} chars)`);

  // Page 1 (default): bounded well under the ceiling, reports the true total, and
  // hands back a cursor because there's more.
  const p1 = await callTool('list', { project: big.slug });
  assert.strictEqual(p1.total, N, 'page 1 reports the true total');
  assert.ok(p1.returned > 0 && p1.returned < N, 'page 1 is a partial page');
  assert.strictEqual(p1.tickets.length, p1.returned, 'returned matches the array length');
  assert.ok(p1.nextCursor, 'page 1 hands back a cursor');
  assert.match(p1.hint, /cursor/, 'the hint tells the caller to follow the cursor');
  const p1Chars = await resultChars('list', { project: big.slug });
  assert.ok(p1Chars <= 70 * 1024, `page 1 stays under the ceiling (${p1Chars} chars vs unbounded ${allChars})`);

  // Iterate the cursor to exhaustion: collect every ref, assert we saw all 500
  // exactly once, every page fit under the ceiling, and paging terminates.
  const seen = [];
  let cursor = undefined;
  let pages = 0;
  let maxPageChars = 0;
  do {
    const args = cursor === undefined ? { project: big.slug } : { project: big.slug, cursor };
    maxPageChars = Math.max(maxPageChars, await resultChars('list', args));
    const page = await callTool('list', args);
    for (const t of page.tickets) seen.push((t as any).ref);
    cursor = page.nextCursor;
    pages++;
    assert.ok(pages <= N + 5, 'paging terminates (no runaway loop)');
  } while (cursor);

  assert.ok(maxPageChars <= 70 * 1024, `every page stayed under the ceiling (max ${maxPageChars} chars)`);
  assert.strictEqual(seen.length, N, 'iterating cursors yielded exactly N rows');
  assert.strictEqual(new Set(seen).size, N, 'every ticket appears exactly once (no dupes, no gaps)');
  assert.ok(pages >= 2, `a 500-ticket board takes several pages (took ${pages})`);

  // limit:N is an exact page size and its own cursor advances correctly.
  const capped = await callTool('list', { project: big.slug, limit: 10 });
  assert.strictEqual(capped.returned, 10, 'limit:N returns exactly N');
  assert.strictEqual(capped.tickets.length, 10, 'exactly N rows');
  assert.strictEqual(capped.total, N, 'the true total rides alongside the page');
  assert.strictEqual(capped.nextCursor, '10', 'the cursor is the next offset');
  const capped2 = await callTool('list', { project: big.slug, limit: 10, cursor: capped.nextCursor });
  assert.strictEqual(capped2.returned, 10, 'page 2 is also exactly N');
  assert.strictEqual(capped2.nextCursor, '20', 'page 2 advances the cursor to offset 20');
  assert.notStrictEqual(capped2.tickets[0].ref, capped.tickets[0].ref, 'page 2 starts past page 1');
  // The two limit-pages are disjoint and contiguous (no overlap, no gap).
  const p1Refs = new Set(capped.tickets.map((t: any) => t.ref));
  assert.ok(!capped2.tickets.some((t: any) => p1Refs.has(t.ref)), 'limit pages do not overlap');

  // A page well below the external ceiling returns every row without a
  // continuation, even though it is larger than the former 12 KiB cap.
  const underCeiling = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-under-ceiling-2230'), 'SQ-2230 Under Ceiling');
  for (let index = 0; index < 80; index += 1) {
    store.createTicket(underCeiling.slug, { title: `under-ceiling row ${index} ${'x'.repeat(600)}` });
  }
  const underCeilingList = await callTool('list', { project: underCeiling.slug });
  assert.equal(underCeilingList.returned, 80);
  assert.equal(underCeilingList.nextCursor, null);
  assert.equal(underCeilingList.retrieval, undefined);
  assert.ok(await resultChars('list', { project: underCeiling.slug }) > 12 * 1024);
  assert.ok(await resultChars('list', { project: underCeiling.slug }) <= 70 * 1024);

  // A small board is a single call: no cursor, everything returned (backward
  // compatible). Brief row shape is untouched (SQ-220 parity).
  const small = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-smallboard-228'), 'SQ-228 Small Board');
  store.createTicket(small.slug, { title: 'the only ticket' });
  const smallList = await callTool('list', { project: small.slug });
  assert.strictEqual(smallList.nextCursor, null, 'a small board fits in one page');
  assert.strictEqual(smallList.returned, smallList.tickets.length);
  assert.strictEqual(smallList.total, smallList.tickets.length);
  assert.strictEqual(smallList.hint, undefined, 'no paging hint when there is no next page');
});

test('SQ-2391: done refuses an ordinary writable clean scope even after its pinned verifier passes, then closes after the orchestrator declares the external deliverable', async () => {
  const verifyCommand = 'node -p "process.cwd()"';
  const fixture = isolatedDispatch('sq-mcp-external-deliverable-', 'a2391ordinary', ['src/engine.js'], verifyCommand);
  const capture = await recordExternalDeliverableCapture(fixture);

  const refused = await callTool('done', {
    project: fixture.project,
    ref: fixture.ref,
    by: fixture.by,
    model: 'opus',
    effort: 'high',
    body: 'The repository scope is clean and the external deliverable is complete.',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'submission_required');
  assert.match(refused.message, /externalDeliverable:true/, 'the refusal names the ticket declaration');
  assert.match(refused.message, /orchestrator can set.*through update/i, 'the refusal names the mid-claim recovery');
  assert.equal(store.getTicket(fixture.project, fixture.ref).status, 'doing');

  const updated = await callToolAsSession('sq2391-different-main-session', 'update', {
    project: fixture.project,
    ref: fixture.ref,
    by: 'mcp-external-deliverable-orchestrator',
    externalDeliverable: true,
  });
  assert.equal(updated.ok, true);
  const declared = store.getTicket(fixture.project, fixture.ref);
  assert.equal(declared.externalDeliverable, true, 'the ticket records the external-deliverable declaration');
  assert.equal(declared.claim?.by, fixture.by, 'the same executor keeps its live claim after the update');

  const closed = await callTool('done', {
    project: fixture.project,
    ref: fixture.ref,
    by: fixture.by,
    model: 'opus',
    effort: 'high',
    body: 'The declared external deliverable is complete and the repository scope is clean.',
  });
  assert.equal(closed.ok, true, 'done was refused: ' + closed.message);
  const done = store.getTicket(fixture.project, fixture.ref);
  assert.equal(done.status, 'done');
  assert.equal(done.completion.purpose, 'external-deliverable');
  assert.equal(done.completion.externalDeliverable.declared, true);
  assert.equal(done.completion.externalDeliverable.candidate.value, capture.candidate.value);
  assert.equal(done.completion.externalDeliverable.capture.id, capture.id);
  assert.equal(done.completion.externalDeliverable.verification.command, verifyCommand);
});

test('SQ-2397: MCP handler grant is explicit while CLI source, by, and session stay non-authoritative', async () => {
  const acceptedMcpCalls = [
    { label: 'no by', agentId: 'a2397mcpnoby', sessionId: 'sq2397-unrelated-no-by', patch: {} },
    { label: 'forged by', agentId: 'a2397mcpforged', sessionId: 'sq2397-unrelated-forged', patch: { by: 'forged-control-plane' } },
    { label: 'different session', agentId: 'a2397mcpsession', sessionId: 'sq2397-different-session', patch: { by: 'main-control-plane' } },
  ] as const;
  for (const acceptedCall of acceptedMcpCalls) {
    const fixture = isolatedDispatch(`sq2397-${acceptedCall.label.replace(/ /g, '-')}-`, acceptedCall.agentId, ['src/engine.js'], 'node -p "process.cwd()"', {
      preparingSessionId: `sq2397-preparer-${acceptedCall.agentId}`,
      preparingSource: 'mcp',
    });
    const updated = await callToolAsSession(acceptedCall.sessionId, 'update', {
      project: fixture.project,
      ref: fixture.ref,
      ...acceptedCall.patch,
      externalDeliverable: true,
    });
    assert.equal(updated.ok, true, `${acceptedCall.label} reaches the handler's explicit grant`);
    assert.equal(store.getTicket(fixture.project, fixture.ref).externalDeliverable, true);
  }

  const claimHolder = isolatedDispatch('sq2397-claim-holder-', 'a2397holder', ['src/engine.js'], 'node -p "process.cwd()"', {
    preparingSessionId: 'sq2397-holder-preparer',
    preparingSource: 'mcp',
  });
  const holderRefusal = await callToolRawAsSession('sq2397-holder-main-thread', 'update', {
    project: claimHolder.project,
    ref: claimHolder.ref,
    by: claimHolder.by,
    externalDeliverable: true,
  });
  assert.equal(holderRefusal.isError, true, 'the explicit grant can still refuse the claim holder by label');
  assert.match(holderRefusal.content[0].text, /without the claim holder's `by`/i);
  assert.equal(store.getTicket(claimHolder.project, claimHolder.ref).externalDeliverable, false);

  const cliFixture = isolatedDispatch('sq2397-cli-', 'a2397cli', ['src/engine.js'], 'node -p "process.cwd()"', {
    preparingSessionId: 'sq2397-cli-preparer',
    preparingSource: 'cli',
  });
  const cliAttempts = [
    { label: 'plain CLI', sessionId: 'sq2397-cli-unrelated', args: [] },
    { label: 'source spoof', sessionId: 'sq2397-cli-unrelated', args: ['--source', 'mcp'] },
    { label: 'preparing session', sessionId: cliFixture.preparingSessionId, args: ['--by', 'forged-control-plane'] },
  ];
  for (const attempt of cliAttempts) {
    const cli = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'sidequest.js'),
      'update', cliFixture.ref, '--project', cliFixture.repo,
      '--external-deliverable', ...attempt.args,
    ], {
      cwd: cliFixture.worktree,
      encoding: 'utf8',
      env: { ...process.env, SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: cliFixture.repo, CLAUDE_CODE_SESSION_ID: attempt.sessionId },
    });
    assert.notEqual(cli.status, 0, `${attempt.label}: ${cli.stdout}\n${cli.stderr}`);
    assert.match(cli.stderr, /release the claim.*MCP `update`.*orchestrator's main thread/i);
  }
  assert.equal(store.getTicket(cliFixture.project, cliFixture.ref).externalDeliverable, false);

  const reclaimable = isolatedDispatch('sq2397-reclaimable-', 'a2397reclaimable', ['src/engine.js'], 'node -p "process.cwd()"', {
    preparingSessionId: 'sq2397-reclaimable-preparer',
    preparingSource: 'cli',
  });
  const reclaimableTicket = store.getTicket(reclaimable.project, reclaimable.ref);
  reclaimableTicket.claim.at = '2000-01-01T00:00:00.000Z';
  persistTicket(reclaimable.project, reclaimableTicket);
  assert.equal(store.claimReclaimable(store.getTicket(reclaimable.project, reclaimable.ref)), true);
  const reclaimableUpdate = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'bin', 'sidequest.js'),
    'update', reclaimable.ref, '--project', reclaimable.repo, '--external-deliverable', '--json',
  ], {
    cwd: reclaimable.worktree,
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: reclaimable.repo },
  });
  assert.equal(reclaimableUpdate.status, 0, reclaimableUpdate.stderr);
  assert.equal(JSON.parse(reclaimableUpdate.stdout).ticket.externalDeliverable, true);

  const unclaimed = store.createTicket(reclaimable.project, {
    title: 'Unclaimed CLI closeout update',
    files: ['src/unclaimed.js'],
    complexity: 3,
    complexityWhy: 'The live-claim guard leaves unclaimed ticket behavior unchanged.',
  });
  const unclaimedUpdate = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'bin', 'sidequest.js'),
    'update', unclaimed.ref, '--project', reclaimable.repo, '--external-deliverable', '--json',
  ], {
    cwd: reclaimable.worktree,
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: reclaimable.repo },
  });
  assert.equal(unclaimedUpdate.status, 0, unclaimedUpdate.stderr);
  assert.equal(JSON.parse(unclaimedUpdate.stdout).ticket.externalDeliverable, true);
});

export {};
