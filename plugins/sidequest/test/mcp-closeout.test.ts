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
  SIDEQUEST_HOME,
  PROJ,
  mcp,
  store,
  runCapturedVerification,
  payloadBytes,
  DISPATCH_DESCRIPTION,
  seedCatalog,
  committedRepo,
  callTool,
  callToolRaw,
  gitAt,
  runCli,
  claimDispatchedTicket,
  isolatedDispatch,
  recordNoOpVerification,
  recordExternalDeliverableCapture,
  redispatchExternalDeliverableFixture,
} from './_mcp-fixture.js';

test('SQ-2391: done refuses a declared external deliverable when only a previous dispatch captured the pinned verifier', async () => {
  const verifyCommand = 'node -p "process.cwd()"';
  const first = isolatedDispatch('sq-mcp-external-deliverable-prior-', 'a2391first', ['src/engine.js'], verifyCommand, { externalDeliverable: true });
  const capture = await recordExternalDeliverableCapture(first);
  const firstDispatchNonce = store.getTicket(first.project, first.ref).dispatchNonce;
  const second = redispatchExternalDeliverableFixture({ ...first, dispatchNonce: firstDispatchNonce }, 'a2391second');
  assert.equal(store.getTicket(second.project, second.ref).verificationCaptures[0].dispatchNonce, firstDispatchNonce, 'the retained capture belongs to the first dispatch');

  const refused = await callTool('done', {
    project: second.project,
    ref: second.ref,
    by: second.by,
    model: 'opus',
    effort: 'high',
    body: 'The external deliverable is unchanged after redispatch.',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'submission_required');
  assert.match(refused.message, /dispatch attempt/, 'the refusal requires this attempt to capture the verifier');
  assert.equal(store.getTicket(second.project, second.ref).status, 'doing');
  assert.ok(capture.id);
});

test('SQ-2391: CLI done records an explicitly declared clean external-deliverable completion', async () => {
  const verifyCommand = 'node -p "process.cwd()"';
  const fixture = isolatedDispatch('sq-cli-external-deliverable-', 'a2391cli', ['src/engine.js'], verifyCommand, { externalDeliverable: true });
  const capture = await recordExternalDeliverableCapture(fixture);
  const cli = path.join(__dirname, '..', 'bin', 'sidequest.js');
  const result = spawnSync(process.execPath, [cli, 'done', fixture.ref, '--project', fixture.repo, '--by', fixture.by, '--model', 'opus', '--effort', 'high', '--body', 'External deliverable completed and the declared repository scope is clean.', '--json'], {
    cwd: fixture.worktree,
    encoding: 'utf8',
    env: process.env,
  });
  assert.equal(result.status, 0, result.stdout + '\\n' + result.stderr);
  const closed = JSON.parse(result.stdout);
  assert.equal(closed.ok, true);
  assert.equal(closed.ticket.completion.purpose, 'external-deliverable');
  assert.equal(closed.ticket.completion.externalDeliverable.declared, true);
  assert.equal(closed.ticket.completion.externalDeliverable.capture.id, capture.id);
});

test('SQ-1339: submit records and integrates an explicit no-op range', async () => {
  const fixture = isolatedDispatch('sq-mcp-submit-noop-', 'a1339noop', ['src/engine.js']);
  const commit = gitAt(fixture.worktree, ['rev-parse', 'HEAD']);
  const gitRef = `refs/sidequest/${fixture.ref}`;
  gitAt(fixture.worktree, ['update-ref', gitRef, commit]);
  recordNoOpVerification(fixture);

  const submitted = await callTool('submit', {
    project: fixture.project,
    ref: fixture.ref,
    by: fixture.by,
    commit,
    base: commit,
    gitRef,
    verify: 'npm run test:full',
    worktree: fixture.worktree,
    body: 'No repository change. Verification completed against the declared clean scope.',
  });
  assert.equal(submitted.ok, true, `submit was refused: ${submitted.message}`);
  const submittedTicket = store.getTicket(fixture.project, fixture.ref);
  assert.equal(submittedTicket.submission.noOp, true);
  assert.deepEqual(submittedTicket.submission.commits, []);
  assert.deepEqual(submittedTicket.submission.changedPaths, []);

  const delivered = store.integrateSubmission(fixture.project, fixture.ref, {
    mode: 'replay',
    target: store.integrationTarget(fixture.project),
    skipVerify: true,
    verificationWaiver: {
      authority: 'fixture release manager',
      reason: 'the explicit no-op verification is already recorded',
      affectedGate: 'npm run test:full',
      scope: fixture.ref,
    },
  });
  assert.equal(delivered.ok, true, `no-op integration was refused: ${delivered.message}`);
  assert.equal(delivered.integration.resultingHead, commit);
});

test('SQ-923: done still refuses a write-routed dispatch that has work in its scope', async () => {
  const dirty = isolatedDispatch('sq-mcp-dirty-', 'a923dirty', ['src'], undefined, { externalDeliverable: true });
  fs.mkdirSync(path.join(dirty.worktree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dirty.worktree, 'src', 'engine.js'), 'real work\n');
  const refusedDirty = await callToolRaw('done', {
    project: dirty.project,
    ref: dirty.ref,
    by: dirty.by,
    model: 'opus',
    body: 'Claiming a no-op while the declared scope holds uncommitted work.',
  });
  const dirtyAck = JSON.parse(refusedDirty.content[0].text);
  assert.equal(dirtyAck.ok, false);
  assert.equal(dirtyAck.reason, 'submission_required');
  assert.match(dirtyAck.message, /src\/engine\.js/, 'names the uncommitted path it found');
  assert.equal(store.getTicket(dirty.project, dirty.ref).status, 'doing');

  const committed = isolatedDispatch('sq-mcp-committed-', 'a923committed', ['src'], undefined, { externalDeliverable: true });
  fs.mkdirSync(path.join(committed.worktree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(committed.worktree, 'src', 'engine.js'), 'real work\n');
  gitAt(committed.worktree, ['add', '--', 'src/engine.js']);
  gitAt(committed.worktree, ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '-q', '-m', 'scoped work']);
  const refusedCommitted = await callToolRaw('done', {
    project: committed.project,
    ref: committed.ref,
    by: committed.by,
    model: 'opus',
    body: 'Committed but never submitted, which is the case the guard exists for.',
  });
  const committedAck = JSON.parse(refusedCommitted.content[0].text);
  assert.equal(committedAck.ok, false);
  assert.equal(committedAck.reason, 'submission_required');
  assert.match(committedAck.message, /committed but not submitted/);
  assert.equal(store.getTicket(committed.project, committed.ref).status, 'doing');
});

test('SQ-2391: readonly dispatches still close without the external-deliverable declaration or a capture', async () => {
  const fixture = isolatedDispatch('sq-mcp-readonly-', 'a2391readonly', ['src/engine.js'], undefined, { readonly: true });
  const closed = await callTool('done', {
    project: fixture.project,
    ref: fixture.ref,
    by: fixture.by,
    model: 'opus',
    effort: 'high',
    body: 'Read-only investigation complete.',
  });
  assert.equal(closed.ok, true, 'readonly done was refused: ' + closed.message);
  assert.equal(store.getTicket(fixture.project, fixture.ref).status, 'done');
});

// SQ-923: executors stamp the runtime id they can actually see. "claude-fable-5"
// passes the backend slug pattern, so it reached the catalog lookup and died as
// "unknown model" on an otherwise correct closeout (eige:SQ-828, eige:SQ-913).
test('SQ-923: done accepts the runtime id an executor reports for a Claude tier', async () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-model-alias'), 'SQ-923 model alias').slug;
  for (const [reported, expected] of [['claude-fable-5', 'fable'], ['claude-opus-5[1m]', 'opus'], ['sonnet-4-5', 'sonnet']]) {
    const ticket = store.createTicket(project, { title: `reported as ${reported}` });
    assert.equal(store.claimTicket(project, ticket.ref, 'alias-worker', { direct: true, reason: 'fixture claim for a provenance stamp' }).ok, true);
    const closed = await callTool('done', {
      project,
      ref: ticket.ref,
      by: 'alias-worker',
      model: reported,
      effort: 'high',
      body: `Closed with the runtime id the executor actually sees: ${reported}.`,
    });
    assert.equal(closed.ok, true, `done refused ${reported}: ${closed.message}`);
    assert.equal(store.getTicket(project, ticket.ref).workedBy.model, expected);
  }
  const unknown = await callToolRaw('done', {
    project,
    ref: store.createTicket(project, { title: 'genuinely unknown model' }).ref,
    by: 'alias-worker',
    model: 'gpt-9-imaginary',
    body: 'A model nobody routes still has to be refused by name.',
  });
  assert.equal(unknown.isError, true, 'an unknown model is still refused');
});

test('MCP add, update, and route_recipe carry a one-ticket route override', async () => {
  const category = `mcp-ticket-route-${process.pid}`;
  store.setCategory({ id: category, name: 'MCP ticket route', route: { model: 'sonnet', effort: 'medium' }, enabled: true });

  const added = await callTool('add', {
    project: PROJ,
    title: 'Use an explicit ticket route',
    category,
    route: { model: 'sonnet', effort: 'high' },
  });
  const projectSlug = added.project;
  assert.deepEqual(store.getTicket(projectSlug, added.ref)?.route, { model: 'sonnet', effort: 'high' }, 'MCP add persists the route under its acknowledged project slug');

  await callTool('update', {
    project: PROJ,
    ref: added.ref,
    route: { model: 'opus', effort: 'high' },
  });
  assert.deepEqual(store.getTicket(projectSlug, added.ref)?.route, { model: 'opus', effort: 'high' });

  const recipe = await callTool('route_recipe', { project: PROJ, category, ticket: added.ref });
  assert.deepEqual(recipe.route, { model: 'opus', effort: 'high' });
  assert.deepEqual(recipe.ticket, { ref: added.ref, route: { model: 'opus', effort: 'high' } });
});

// SQ-316: a dispatch that registers the first pin for its route must write it where
// Claude Code's agent loader reads AND say so, because the definition is newer than
// the session's agent snapshot and a spawn against it fails until the session reloads.
test('a freshly registered Codex pin lands in the Claude agent directory and is named in the dispatch result', async () => {
  // The suite's own Claude home, pinned by the install fixture at import: relocating
  // it would move `plugins/installed_plugins.json` too and the dispatch preflight
  // would refuse before any pin was written. Only the agents-dir override is lifted,
  // which is the assertion that the unpinned resolution follows the Claude home and
  // not the SIDEQUEST_HOME board tree.
  const claudeHome = String(process.env.SIDEQUEST_CLAUDE_HOME);
  assert.ok(claudeHome && claudeHome !== 'undefined', 'the install fixture pins a Claude home');
  const previous = { agentsDir: process.env.SIDEQUEST_AGENTS_DIR };
  delete process.env.SIDEQUEST_AGENTS_DIR;
  try {
    seedCatalog([{ slug: 'codex-gpt-5-6-luna', id: 'claude-gpt-5.6-luna', label: 'Luna' }]);
    store.setCategory({ id: 'pin-notice-codex', name: 'Pin Notice Codex', route: { model: 'codex-gpt-5-6-luna', effort: 'high' } });
    const added = await callTool('add', { title: 'pin notice dispatch', description: DISPATCH_DESCRIPTION, category: 'pin-notice-codex' });
    const dispatched = await callTool('dispatch', { allowUnscoped: true, ref: added.ref, full: true });

    const agentsDir = path.join(claudeHome, 'agents');
    assert.equal(dispatched.spawn.subagent_type, dispatched.agent);
    assert.ok(fs.existsSync(path.join(agentsDir, `${dispatched.agent}.md`)), `the spawned executor must exist in ${agentsDir}`);
    assert.ok(!fs.existsSync(path.join(SIDEQUEST_HOME, 'agents')), 'the board home holds no agent definitions');

    const notice = (dispatched.warnings || []).find((warning: string) => warning.includes('Codex pin'));
    assert.ok(notice, `expected a pin notice, got ${JSON.stringify(dispatched.warnings)}`);
    assert.ok(notice.includes(agentsDir), 'the notice names the directory it wrote to');
    assert.match(notice, /SIDEQUEST_AGENTS_DIR/);
    assert.match(notice, /reload-plugins/);

    // Second dispatch of the same route: the pin is unchanged, so no notice.
    const again = await callTool('add', { title: 'pin notice repeat', description: DISPATCH_DESCRIPTION, category: 'pin-notice-codex' });
    const repeat = await callTool('dispatch', { allowUnscoped: true, ref: again.ref, full: true });
    assert.equal((repeat.warnings || []).find((warning: string) => warning.includes('Codex pin')), undefined);
  } finally {
    if (previous.agentsDir === undefined) delete process.env.SIDEQUEST_AGENTS_DIR;
    else process.env.SIDEQUEST_AGENTS_DIR = previous.agentsDir;
  }
});

// SQ-320: the compact dispatch result attached warnings only if the whole result still fit
// 1200 bytes, and otherwise returned it without them and without any marker. A normal
// dispatch sits near that line, so Dispatch update notices (SQ-316's Codex pin reload,
// PYTHONIOENCODING) never reached the orchestrator. The CLI dispatched without the board
// slug, so every board-aware warning was absent from its JSON too.
test('dispatch warnings reach the compact MCP result past the old 1200-byte ceiling and the CLI JSON', async () => {
  const referenced = await callTool('add', { title: 'warning channel referenced', description: DISPATCH_DESCRIPTION, category: 'debugging' });
  const mcpTarget = await callTool('add', {
    title: 'warning channel mcp',
    description: `${DISPATCH_DESCRIPTION} Builds on ${referenced.ref}.`,
    category: 'debugging',
  });
  const cliTarget = await callTool('add', {
    title: 'warning channel cli',
    description: `${DISPATCH_DESCRIPTION} Builds on ${referenced.ref}.`,
    category: 'debugging',
    // Declared so the no-scope warning does not crowd the stale-reference one past
    // presentWarnings' three-warning cap.
    files: ['sq320-cli-fixture.ts'],
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  claimDispatchedTicket(referenced.project, referenced, 'warning-channel-holder');
  const stale = new RegExp(`${referenced.ref} changed state \\(todo -> doing\\)`);

  const dispatched = await callToolRaw('dispatch', { allowUnscoped: true, ref: mcpTarget.ref });
  assert.ok(!dispatched.isError, dispatched.content[0].text);
  const compact = JSON.parse(dispatched.content[0].text);
  assert.ok(payloadBytes(dispatched.content[0].text) > 1200, `the fixture must exceed the old ceiling; it is ${payloadBytes(dispatched.content[0].text)} bytes`);
  assert.ok(compact.spawn && compact.spawn.prompt, 'the compact spawn still rides');
  assert.match(compact.warnings.join('\n'), stale);
  assert.match(compact.warnings.join('\n'), /has no verify command/);
  assert.equal(compact.warningsOmitted, undefined);
  assert.equal(compact.token, undefined, 'warnings do not pull the full payload into the compact form');

  const cli = runCli(['dispatch', cliTarget.ref, '--unverified-transport', '--allow-unscoped']);
  assert.match(cli.warnings.join('\n'), stale, `CLI warnings: ${JSON.stringify(cli.warnings)}`);
});

test('a dispatch warning cut by the hard ceiling leaves a count and a retrieval handle, never silence', async () => {
  const { compactDispatchWarnings } = require('../lib/mcp-shared.js');
  const compact = { ref: 'SQ-1', effort: 'high', spawn: { prompt: 'x'.repeat(200) } };
  const warnings = ['Dispatch update: first notice '.padEnd(1500, '.'), 'Dispatch update: second notice '.padEnd(1500, '.')];
  assert.deepEqual(compactDispatchWarnings('demo', compact, []), compact);
  assert.deepEqual(compactDispatchWarnings('demo', compact, warnings).warnings, warnings, 'under the hard ceiling every warning rides whole');

  const wholeBytes = Buffer.byteLength(JSON.stringify(Object.assign({}, compact, { warnings }), null, 2));
  const cut = compactDispatchWarnings('demo', compact, warnings, wholeBytes - 1);
  assert.ok(Buffer.byteLength(JSON.stringify(cut, null, 2)) <= wholeBytes - 1, 'the marked result honors the ceiling it was given');
  assert.deepEqual(cut.warnings, [warnings[0]]);
  assert.equal(cut.warningsOmitted, 1);
  assert.equal(cut.warningsRetrieval.tool, 'context_page');
  const page = await callTool('context_page', { ...cut.warningsRetrieval.arguments, limit: 4096 });
  for (const warning of warnings) assert.ok(JSON.stringify(page).includes(warning.slice(0, 40)), `retrieval returns ${warning.slice(0, 40)}`);

  const none = compactDispatchWarnings('demo', compact, warnings, Buffer.byteLength(JSON.stringify(compact, null, 2)) + 10);
  assert.deepEqual(none.warnings, []);
  assert.equal(none.warningsOmitted, 2);
  assert.ok(none.warningsRetrieval);
});

// SQ-355: integrate held its client silent for the sum of two pinned verify runs,
// which the MCP client reported as `failed` on a delivery that had already merged.
test('MCP handleRequest hands a tool a progress reporter and emits notifications/progress under the client token', async () => {
  const tool = mcp.TOOLS.find((candidate: any) => candidate.name === 'pulse');
  assert.ok(tool, 'the pulse tool is registered');
  const original = tool.handler;
  const reporterTypes: string[] = [];
  tool.handler = (args: any, context: any) => {
    reporterTypes.push(typeof context?.progress);
    if (typeof context?.progress === 'function') {
      context.progress({ phase: 'candidate:started', message: 'integrate: candidate gate started: npm test' });
      context.progress({ phase: 'merged-tree:finished', message: 'integrate: merged-tree gate finished: passed after 42s' });
    }
    return { ok: true, ref: args.ref };
  };
  try {
    const notifications: any[] = [];
    const withToken: any = await mcp.handleRequest(
      { jsonrpc: '2.0', id: 9501, method: 'tools/call', params: { name: 'pulse', arguments: { ref: 'SQ-355' }, _meta: { progressToken: 'tok-355' } } },
      { sendNotification: (notification: any) => notifications.push(notification) },
    );
    assert.equal(withToken.result.isError, undefined, withToken.result.content?.[0]?.text);
    assert.equal(reporterTypes[0], 'function', 'a progress reporter reaches the handler when the client supplied a token');
    assert.deepEqual(notifications.map((notification) => notification.method), ['notifications/progress', 'notifications/progress']);
    assert.deepEqual(notifications.map((notification) => notification.params.progressToken), ['tok-355', 'tok-355']);
    assert.deepEqual(notifications.map((notification) => notification.params.progress), [1, 2], 'progress is monotonic per token, as the protocol requires');
    assert.match(notifications[0].params.message, /candidate gate started/);
    assert.match(notifications[1].params.message, /merged-tree gate finished: passed/);

    // No client token: unsolicited progress is forbidden, so no reporter and no traffic.
    const unsolicited: any[] = [];
    await mcp.handleRequest(
      { jsonrpc: '2.0', id: 9502, method: 'tools/call', params: { name: 'pulse', arguments: { ref: 'SQ-355' } } },
      { sendNotification: (notification: any) => unsolicited.push(notification) },
    );
    assert.equal(reporterTypes[1], 'undefined');
    assert.deepEqual(unsolicited, []);

    // The tests and the in-process callers drive handleRequest with no sink at all.
    const sinkless: any = await mcp.handleRequest({ jsonrpc: '2.0', id: 9503, method: 'tools/call', params: { name: 'pulse', arguments: { ref: 'SQ-355' }, _meta: { progressToken: 7 } } });
    assert.equal(sinkless.result.isError, undefined, sinkless.result.content?.[0]?.text);
    assert.equal(reporterTypes[2], 'undefined');
  } finally {
    tool.handler = original;
  }
});

test('integration delivery reports the verification phase it enters and leaves (SQ-355)', async () => {
  const gate = 'node --version';
  const fixture = isolatedDispatch('sq-mcp-verify-phase-', 'verify-phase-worker', ['src/phase.js'], gate);
  fs.mkdirSync(path.join(fixture.worktree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(fixture.worktree, 'src', 'phase.js'), 'module.exports = { phase: true };\n');
  gitAt(fixture.worktree, ['config', 'user.name', 'Sidequest Test']);
  gitAt(fixture.worktree, ['config', 'user.email', 'sidequest-test@example.invalid']);
  const committed = await callTool('commit', {
    project: fixture.project,
    ref: fixture.ref,
    by: fixture.by,
    message: 'Deliver a candidate whose gate is observable',
    worktree: fixture.worktree,
  });
  assert.ok(committed.commit, committed.message || committed.reason);
  const gitRef = `refs/sidequest/${fixture.ref}`;
  gitAt(fixture.worktree, ['update-ref', gitRef, committed.commit]);
  const { capture } = await runCapturedVerification(gate, { project: fixture.project, ticket: fixture.ref }, fixture.worktree);
  assert.equal(capture.status, 'passed', capture.evidence);
  fs.rmSync(capture.logPath, { force: true });
  const submitted = await callTool('submit', {
    project: fixture.project,
    ref: fixture.ref,
    by: fixture.by,
    commit: committed.commit,
    gitRef,
    worktree: fixture.worktree,
    verify: gate,
    body: 'Phase reporting fixture.',
  });
  assert.equal(submitted.ok, true, submitted.message || submitted.reason);

  const phases: any[] = [];
  const delivered: any = await store.integrateSubmission(fixture.project, fixture.ref, {
    mode: 'merge',
    target: store.integrationTarget(fixture.project),
    onVerifyPhase: (event: any) => phases.push(event),
  });
  assert.equal(delivered.ok, true, delivered.message || delivered.reason);
  assert.deepEqual(
    phases.map((event) => `${event.phase}:${event.state}`),
    ['candidate:started', 'candidate:finished', 'merged-tree:started', 'merged-tree:finished'],
    'both gates announce entry and exit, so neither run is silent',
  );
  assert.equal(phases[0].command, gate, 'the started phase names the command, so a watcher need not probe the process table');
  assert.equal(phases[1].command, gate);
  assert.equal(phases[1].status, 'passed', 'the finished phase reports the status the gate actually returned');
  assert.equal(phases[1].status, store.getTicket(fixture.project, fixture.ref).submission.integration.verify.status, 'the reported status is the one the board recorded');
  assert.equal(typeof phases[1].durationMs, 'number');
});

test('SQ-284: board calls that omit project follow the caller claim to its board, not the cwd board', async () => {
  const cwdRoot = committedRepo('sq-mcp-284-cwd-');
  const otherRoot = committedRepo('sq-mcp-284-other-');
  const cwdBoard = store.ensureProject(cwdRoot).slug;
  const otherBoard = store.ensureProject(otherRoot).slug;
  const previousProjectDirectory = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = cwdRoot;
  try {
    const cwdTicket = store.createTicket(cwdBoard, { title: 'Unrelated cwd ticket', source: 'test' });
    const claimed = store.createTicket(otherBoard, { title: 'Ticket claimed on another board', source: 'test' });
    assert.equal(cwdTicket.ref, claimed.ref, 'both boards hold the same ref');
    assert.equal(store.claimTicket(otherBoard, claimed.ref, 'sq-284-exec', { direct: true }).ok, true);

    await callTool('comment', { ref: claimed.ref, by: 'sq-284-exec', body: 'progress from the executor' });

    const onClaimedBoard = await callTool('comments', { project: otherBoard, ref: claimed.ref });
    assert.ok(
      onClaimedBoard.comments.some((comment: any) => String(comment.body || '').includes('progress from the executor')),
      'the comment lands on the board holding the claim',
    );
    const onCwdBoard = await callTool('comments', { project: cwdBoard, ref: cwdTicket.ref });
    assert.ok(
      !onCwdBoard.comments.some((comment: any) => String(comment.body || '').includes('progress from the executor')),
      'the unrelated cwd ticket of the same ref is untouched',
    );

    // Without a claim match the cwd default still holds.
    await callTool('comment', { ref: cwdTicket.ref, by: 'someone-else', body: 'orchestrator note' });
    const cwdAfter = await callTool('comments', { project: cwdBoard, ref: cwdTicket.ref });
    assert.ok(cwdAfter.comments.some((comment: any) => String(comment.body || '').includes('orchestrator note')));

    // The same caller holding the ref on both boards is ambiguous: refuse rather than guess.
    assert.equal(store.claimTicket(cwdBoard, cwdTicket.ref, 'sq-284-exec', { direct: true }).ok, true);
    const ambiguous = await callToolRaw('comment', { ref: claimed.ref, by: 'sq-284-exec', body: 'which board?' });
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.content[0].text, /ambiguous across boards/);
  } finally {
    if (previousProjectDirectory === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = previousProjectDirectory;
  }
});

export {};
