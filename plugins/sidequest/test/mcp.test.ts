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
  MCP_SESSION_ID,
  mcp,
  contextPacket,
  agentsync,
  store,
  db,
  runCapturedVerification,
  payloadBytes,
  DISPATCH_DESCRIPTION,
  committedRepo,
  callTool,
  callToolRaw,
  callToolAsSession,
  callToolOn,
  freshMcpServer,
  callHandler,
  gitAt,
  runCli,
  createGitWorktree,
  fixtureState,
} from './_mcp-fixture.js';

test('untrusted Sidequest versions refuse MCP and CLI writes before creating a board', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mutation-freshness-'));
  const project = path.join(directory, 'project');
  const claudeHome = path.join(directory, 'claude');
  const pluginRoot = path.join(directory, 'loaded-sidequest');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '4.48.0' }));
  fs.mkdirSync(path.join(claudeHome, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: { 'sidequest@loadout': [{ scope: 'project', projectPath: project, version: 'not-semver' }] },
  }));
  const previousClaudeHome = process.env.SIDEQUEST_CLAUDE_HOME;
  const previousPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const previousProjectDirectory = process.env.CLAUDE_PROJECT_DIR;
  const previousSession = process.env.CLAUDE_CODE_SESSION_ID;
  try {
    process.env.SIDEQUEST_CLAUDE_HOME = claudeHome;
    process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
    process.env.CLAUDE_PROJECT_DIR = project;
    process.env.CLAUDE_CODE_SESSION_ID = 'mcp-stale-mutation';
    const mcpRefusal = await callToolRaw('add', {
      project,
      title: 'Refused stale mutation',
      description: 'The freshness guard must run before add creates a board.',
      unclassified: true,
    });
    assert.equal(mcpRefusal.isError, true);
    assert.match(mcpRefusal.content[0].text, /missing or malformed/);
    assert.match(mcpRefusal.content[0].text, /installed not-semver/);
    assert.equal(store.findProject(project).ok, false);

    const cli = path.join(__dirname, '..', 'bin', 'sidequest.js');
    const cliRefusal = spawnSync(process.execPath, [cli, 'add', '--project', project, '--title', 'Refused stale mutation', '--description', 'The freshness guard must run before add creates a board.', '--unclassified'], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: project, CLAUDE_CODE_SESSION_ID: 'cli-stale-mutation' },
    });
    assert.equal(cliRefusal.status, 1);
    assert.match(cliRefusal.stderr, /missing or malformed/);
    assert.match(cliRefusal.stderr, /installed not-semver/);
    assert.equal(store.findProject(project).ok, false);

    const readable = await callToolRaw('list', { project });
    assert.notEqual(readable.isError, true);
  } finally {
    if (previousClaudeHome === undefined) delete process.env.SIDEQUEST_CLAUDE_HOME;
    else process.env.SIDEQUEST_CLAUDE_HOME = previousClaudeHome;
    if (previousPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = previousPluginRoot;
    if (previousProjectDirectory === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = previousProjectDirectory;
    if (previousSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = previousSession;
  }
});

test('initialize returns a protocol version, tools capability, and serverInfo', async () => {
  const resp = await mcp.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.strictEqual(resp.result.protocolVersion, '2025-06-18', 'echoes the client-requested version');
  assert.ok(resp.result.capabilities.tools, 'advertises tools');
  assert.strictEqual(resp.result.serverInfo.name, 'sidequest');
});

test('notifications/initialized takes no response', async () => {
  const resp = await mcp.handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.strictEqual(resp, null);
});

test('tools/list advertises the board tools with input schemas', async () => {
  const resp = await mcp.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = resp.result.tools.map((t: any) => t.name);
  for (const expected of ['context_page', 'list', 'ready', 'add', 'update', 'remove', 'archive', 'unarchive', 'claim', 'sweepClaims', 'next', 'done', 'groomClose', 'release', 'verdict', 'scopeRequest', 'commit', 'rework', 'submit', 'comment', 'plan', 'link', 'unlink', 'assign', 'dispatch', 'story', 'story_contract', 'story_log', 'category_add', 'category_edit', 'category_rm', 'category_detach', 'category_relink', 'category_list', 'global_fallback', 'board_config', 'models', 'projects', 'archive_board', 'unarchive_board', 'route_recipe']) {
    assert.ok(names.includes(expected), `exposes ${expected}`);
  }
  for (const cliOnly of ['native_agent', 'native_agent_cleanup']) {
    assert.ok(!names.includes(cliOnly), `${cliOnly} stays CLI-only`);
  }
  for (const t of resp.result.tools) {
    assert.strictEqual(t.inputSchema.type, 'object', `${t.name} has an object input schema`);
  }
  const contextPage = resp.result.tools.find((tool: any) => tool.name === 'context_page');
  assert.deepEqual(contextPage.inputSchema.required, ['handle', 'cursor', 'expectedRevision']);
  assert.equal(contextPage.inputSchema.properties.limit.maximum, 70 * 1024);
  assert.match(contextPage.inputSchema.properties.cursor.description, /Opaque/);
  assert.match(contextPage.inputSchema.properties.limit.description, /UTF-8 bytes/);
  const rework = resp.result.tools.find((tool: any) => tool.name === 'rework');
  assert.deepEqual(rework.inputSchema.required, ['ref', 'by', 'review', 'reason']);
  assert.match(rework.description, /repair unbound/);
  assert.match(rework.description, /bound needs oracle/, 'rework advertises the bound-candidate oracle route');
  assert.ok(rework.inputSchema.properties.reviewRef, 'reviewRef stays accepted for compatibility');
  for (const tool of resp.result.tools) {
    assert.doesNotMatch(String(tool.description || ''), /permanent/i, `${tool.name} must not promise a permanent candidate rejection`);
  }
  const submit = resp.result.tools.find((tool: any) => tool.name === 'submit');
  assert.ok(submit.inputSchema.properties.base, 'submit exposes an explicit base');
  // body/commit are handler-enforced, not schema-required: clear:true handles
  // an integration bounce and legitimately omits both.
  assert.ok(submit.inputSchema.properties.clear, 'submit exposes clear to reject a pending submission without integrating it');
  assert.equal(submit.inputSchema.required.includes('body'), false, 'body is handler-enforced, not schema-required, so clear:true can omit it');
  assert.ok(resp.result.tools.find((tool: any) => tool.name === 'done').inputSchema.required.includes('body'), 'done requires the final report');
  const groomClose = resp.result.tools.find((tool: any) => tool.name === 'groomClose');
  assert.ok(groomClose.inputSchema.properties.deliveryCommit, 'groomClose records hand-delivered commits');
  assert.ok(groomClose.inputSchema.properties.recoveryEvidence, 'groomClose requires terminal-agent evidence before clearing an unclaimed dispatch');
  const release = resp.result.tools.find((tool: any) => tool.name === 'release');
  assert.ok(release.inputSchema.properties.oracle, 'release exposes an oracle ask');
  assert.deepEqual(release.inputSchema.properties.kind.enum, ['technical_blocker', 'contradiction', 'oracle', 'handback'], 'release classifies reasoned handoffs');
  assert.ok(release.inputSchema.properties.command, 'release exposes command evidence for technical blockers and contradictions');
  assert.match(release.inputSchema.properties.command.description, /Required for blocker\/contradiction/);
  assert.ok(release.inputSchema.properties.exitCode, 'release exposes optional contradiction and required technical-blocker exit-code evidence');
  assert.ok(release.inputSchema.properties.outputTail, 'release exposes output evidence for technical blockers and contradictions');
  assert.match(release.inputSchema.properties.outputTail.description, /Required blocker\/contradiction output/);
  assert.equal(release.inputSchema.required.includes('reason'), false, 'release accepts an oracle ask in place of a reason');
  const integrate = resp.result.tools.find((tool: any) => tool.name === 'integrate');
  assert.match(integrate.description, /Comma-ref group/);
  assert.match(integrate.description, /wave=options, refs in ref/);
  const verdict = resp.result.tools.find((tool: any) => tool.name === 'verdict');
  assert.deepEqual(verdict.inputSchema.required, ['ref', 'text', 'outcome']);
  assert.deepEqual(verdict.inputSchema.properties.outcome.enum, ['accepted', 'rejected', 'inconclusive']);
});

test('context_page resumes Unicode bodies and rows with stable revision-safe cursors', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-context-page-'))).slug;
  const files = ['plugins/sidequest/src/lib/mcp-read.ts', 'plugins/sidequest/src/lib/context-packet.ts'];
  const description = `Unicode continuation: ${'測'.repeat(1600)}`;
  const ticket = store.createTicket(project, { title: 'Context page body', description, files, source: 'test' });

  const detail = await callTool('list', { project, ref: ticket.ref });
  assert.deepEqual(detail.ticket.files, files, 'list(ref).ticket.files keeps its legacy shape');
  assert.equal(detail.ticket.descriptionTruncated, true);
  assert.equal(detail.ticket.descriptionRetrieval.tool, 'context_page');
  const bodyArguments = detail.ticket.descriptionRetrieval.arguments;
  const firstBodyPage = await callTool('context_page', { ...bodyArguments, limit: 1024 });
  const repeatedBodyPage = await callTool('context_page', { ...bodyArguments, limit: 1024 });
  assert.equal(firstBodyPage.nextCursor, repeatedBodyPage.nextCursor, 'unchanged sources produce stable cursors');
  assert.ok(Buffer.byteLength(firstBodyPage.body, 'utf8') <= 1024);
  assert.doesNotMatch(firstBodyPage.body, /�/);

  let reconstructed = '';
  let cursor = bodyArguments.cursor;
  while (cursor !== null) {
    const page = await callTool('context_page', { ...bodyArguments, cursor, limit: 1024 });
    reconstructed += page.body;
    cursor = page.nextCursor;
  }
  assert.equal(reconstructed, description);

  const commentBody = `Nested body: ${'é'.repeat(3000)}`;
  store.addComment(project, ticket.ref, { body: commentBody, by: 'context-page-test', kind: 'comment', source: 'test' });
  const comments = await callTool('comments', { project, ref: ticket.ref });
  const nestedRetrieval = comments.comments[0].retrieval;
  assert.equal(nestedRetrieval.tool, 'context_page');
  const nestedPage = await callTool('context_page', { ...nestedRetrieval.arguments, limit: 1024 });
  assert.equal(nestedPage.body, contextPacket.utf8Excerpt(commentBody, 1024).text);
  assert.equal(nestedPage.position, comments.comments[0].id);

  const wrongRevision = await callToolRaw('context_page', {
    ...nestedRetrieval.arguments,
    expectedRevision: contextPacket.contextRevision('wrong revision'),
  });
  assert.equal(wrongRevision.isError, true);
  assert.match(wrongRevision.content[0].text, /expectedRevision does not match/);

  store.updateTicket(project, ticket.ref, { description: `${description} changed` });
  const stale = await callToolRaw('context_page', { ...bodyArguments, limit: 1024 });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /stale list handle/);

  const unsupportedRevision = contextPacket.contextRevision('unsupported');
  const unsupportedHandle = contextPacket.createContextHandle({
    tool: 'story_contract', project, kind: 'body', field: 'executionContract',
    position: 'executionContract', revision: unsupportedRevision, reason: 'truncated', selector: { story: 'US-1' },
  });
  const wrongTool = await callToolRaw('context_page', {
    handle: unsupportedHandle,
    cursor: contextPacket.contextCursor(unsupportedHandle, 0),
    expectedRevision: unsupportedRevision,
  });
  assert.equal(wrongTool.isError, true);
  assert.match(wrongTool.content[0].text, /unsupported source tool "story_contract"/);

  const rowProject = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-context-rows-'))).slug;
  for (let index = 0; index < 45; index += 1) {
    store.createTicket(rowProject, { title: `Context row ${index}`, source: 'test' });
  }
  const listed = await callTool('list', { project: rowProject, limit: 40 });
  assert.equal(listed.returned, 40);
  assert.equal(listed.retrieval.tool, 'context_page');
  const rowArguments = listed.retrieval.arguments;
  const rowPage = await callTool('context_page', { ...rowArguments, limit: 4096 });
  const repeatedRowPage = await callTool('context_page', { ...rowArguments, limit: 4096 });
  assert.deepEqual(rowPage, repeatedRowPage);
  assert.equal(rowPage.source, 'list');
  assert.equal(rowPage.totalRows, 45);
  assert.equal(rowPage.returned, 5);
  assert.equal(rowPage.complete, true);

  store.createTicket(rowProject, { title: 'Revision invalidator', source: 'test' });
  const staleRows = await callToolRaw('context_page', { ...rowArguments, limit: 4096 });
  assert.equal(staleRows.isError, true);
  assert.match(staleRows.content[0].text, /stale list handle/);
});

test('briefings retain complete frozen story contracts after the live contract changes', () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-frozen-contract-'))).slug;
  const story = store.createStory(project, { title: 'Frozen contract retrieval' });
  const frozenContract = `FROZEN-SNAPSHOT-${'測🧪'.repeat(5_000)}`;
  const liveContract = `LIVE-CONTRACT-${'é'.repeat(15_000)}`;
  store.updateStory(project, story.ref, { executionContract: frozenContract });
  store.setCategory({ id: 'frozen-snapshot-context', name: 'Frozen snapshot context', route: { model: 'sonnet', effort: 'low' } });
  const ticket = store.createTicket(project, {
    title: 'Retrieve frozen dispatch contract', storyId: story.id, category: 'frozen-snapshot-context', source: 'test',
  });
  const prepared = store.prepareDispatch(project, ticket.ref, { allowUnscoped: true, sessionId: 'frozen-contract-session' });
  const briefing = runCli(['briefing', ticket.ref, '--token-file', prepared.ticket.dispatch.tokenFile, '--project', project]);
  assert.ok(briefing.includes(frozenContract));
  assert.doesNotMatch(briefing, /fetch the paged snapshot/);

  store.updateStory(project, story.ref, { executionContract: liveContract });
  const frozenBriefing = agentsync.renderTicketBriefing(prepared.ticket, prepared.token, project);
  assert.ok(frozenBriefing.includes(frozenContract));
  assert.doesNotMatch(frozenBriefing, new RegExp(liveContract.slice(0, 32)));
});

test('briefings preserve an explicit frozen absence when contracts appear after dispatch', () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-frozen-absence-'))).slug;
  store.setCategory({ id: 'frozen-absence-context', name: 'Frozen absence context', route: { model: 'sonnet', effort: 'low' } });
  for (const liveContract of [
    `LIVE-CONTRACT-SMALL-${'é'.repeat(100)}`,
    `LIVE-CONTRACT-OVERSIZED-${'測🧪'.repeat(5_000)}`,
  ]) {
    const story = store.createStory(project, { title: 'Frozen absence retrieval' });
    const ticket = store.createTicket(project, {
      title: 'Preserve frozen absence', storyId: story.id, category: 'frozen-absence-context', source: 'test',
    });
    const prepared = store.prepareDispatch(project, ticket.ref, { allowUnscoped: true, sessionId: 'frozen-absence-session' });
    assert.equal(prepared.ticket.dispatch.storyContract, null);
    store.updateStory(project, story.ref, { executionContract: liveContract });
    const briefing = agentsync.renderTicketBriefing(prepared.ticket, 'frozen-absence-token', project, project);
    assert.match(briefing, /Frozen dispatch snapshot contains no contract/);
    assert.doesNotMatch(briefing, new RegExp(liveContract.slice(0, 32)));
    assert.doesNotMatch(briefing, /Required before editing: fetch the paged snapshot/);
  }
});

test('context_page explains that old briefing handles are retired', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-retired-briefing-'))).slug;
  const ticket = store.createTicket(project, { title: 'Retired briefing handle', source: 'test' });
  const revision = contextPacket.contextRevision('old briefing body');
  const handle = contextPacket.createContextHandle({
    tool: 'briefing',
    project,
    kind: 'body',
    field: 'task-and-scope',
    position: 'task-and-scope',
    revision,
    reason: 'budget',
    selector: { ref: ticket.ref },
  });
  const page = await callTool('context_page', {
    handle,
    cursor: contextPacket.contextCursor(handle, 0),
    expectedRevision: revision,
  });
  assert.equal(page.message, 'context_page: briefing sections are no longer elided; the full text is in the briefing itself.');
});

test('context_page row continuations retain their revision when claim liveness changes', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-context-liveness-'))).slug;
  const originalIdleMinutes = process.env.SIDEQUEST_CLAIM_IDLE_MIN;
  process.env.SIDEQUEST_CLAIM_IDLE_MIN = '60';
  try {
    const tickets = Array.from({ length: 45 }, (_, index) => store.createTicket(project, { title: `Liveness row ${index}`, source: 'test' }));
    const claimed = tickets[tickets.length - 1];
    assert.equal(store.claimTicket(project, claimed.ref, 'liveness-worker', {
      direct: true,
      reason: 'The continuation fixture needs a live claim.',
    }).ok, true);

    const listed = await callTool('list', { project, limit: 0 });
    assert.equal(listed.returned, 0);
    assert.equal(listed.retrieval.tool, 'context_page');
    const rowArguments = listed.retrieval.arguments;

    process.env.SIDEQUEST_CLAIM_IDLE_MIN = '0.000001';
    const resumed = await callTool('context_page', { ...rowArguments, limit: 4096 });
    const claimedRow = resumed.rows.find((row: any) => row.ref === claimed.ref);
    assert.equal(resumed.revision, rowArguments.expectedRevision);
    assert.equal(resumed.totalRows, 45);
    assert.equal(claimedRow.claim.stale, true);
  } finally {
    if (originalIdleMinutes === undefined) delete process.env.SIDEQUEST_CLAIM_IDLE_MIN;
    else process.env.SIDEQUEST_CLAIM_IDLE_MIN = originalIdleMinutes;
  }
});

test('every oversized read carries a universal continuation handle', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-universal-page-'))).slug;
  for (let index = 0; index < 750; index += 1) {
    store.createTicket(project, { title: `Oversized change ${index} ${'x'.repeat(500)}`, source: 'test' });
  }

  const changes = await callTool('changes', { project, since: '2000-01-01T00:00:00.000Z' });
  assert.ok(Buffer.byteLength(JSON.stringify(changes), 'utf8') <= 70 * 1024);
  assert.equal(changes.ticketsRetrieval.tool, 'context_page');
  assert.equal(changes.ticketsTotal, 750);

  const resumed = await callTool('context_page', { ...changes.ticketsRetrieval.arguments, limit: 4096 });
  assert.equal(resumed.source, 'changes');
  assert.ok(resumed.returned > 0);
  assert.ok(resumed.totalRows === 750);
});

test('context_page row continuations project oversized detail bodies into nested pages', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-context-oversized-row-'))).slug;
  for (let index = 0; index < 44; index += 1) {
    store.createTicket(project, { title: `Detail row ${index}`, source: 'test' });
  }
  const description = '測'.repeat(6000);
  const newest = store.createTicket(project, { title: 'Oversized detail row', description, source: 'test' });

  const listed = await callTool('list', { project, detail: true, limit: 0 });
  assert.equal(listed.returned, 0);
  assert.equal(listed.retrieval.tool, 'context_page');
  const rowsPage = await callTool('context_page', { ...listed.retrieval.arguments, limit: 16384 });
  const recoveredRow = rowsPage.rows.find((row: any) => row.ref === newest.ref);
  assert.equal(recoveredRow.descriptionTruncated, true);
  assert.equal(recoveredRow.descriptionRetrieval.tool, 'context_page');

  let reconstructed = '';
  let cursor = recoveredRow.descriptionRetrieval.arguments.cursor;
  while (cursor !== null) {
    const page = await callTool('context_page', { ...recoveredRow.descriptionRetrieval.arguments, cursor, limit: 16384 });
    reconstructed += page.body;
    cursor = page.nextCursor;
  }
  assert.equal(reconstructed, description);
});

test('add and update preserve descriptions and expose storyId explicitly', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-description-'))).slug;
  const story = store.createStory(project, { title: 'Description contract' });
  const description = 'Where: MCP add.\nContract: preserve this prose byte-for-byte.\nVerify: read the ticket.';
  const added = await callTool('add', { project, title: 'description persistence', description, storyId: story.ref, unclassified: true });
  let ticket = store.getTicket(project, added.ref);
  assert.equal(ticket.description, description);
  assert.equal(ticket.storyId, story.id);

  const updatedDescription = 'Where: MCP update.\nContract: keep every newline.\nVerify: inspect the returned ticket.';
  await callTool('update', { project, ref: added.ref, description: updatedDescription, storyId: 'none' });
  ticket = store.getTicket(project, added.ref);
  assert.equal(ticket.description, updatedDescription);
  assert.equal(ticket.storyId, null);

  const tools = mcp.toolDescriptors();
  for (const name of ['add', 'update']) {
    const properties = tools.find((tool: any) => tool.name === name).inputSchema.properties;
    assert.ok(properties.description, `${name} exposes description`);
    assert.ok(properties.storyId, `${name} exposes storyId`);
    assert.equal(properties.story, undefined, `${name} does not overload story`);
  }
  assert.equal(tools.find((tool: any) => tool.name === 'add').inputSchema.properties.storyId.pattern, '^US-\\d+$');
});

test('update amends a claimed dispatch verifier and its next capture uses the amended command', async () => {
  const repository = committedRepo('sq-mcp-verify-amendment-');
  const project = store.ensureProject(repository).slug;
  const pinnedCommand = 'node -e "process.exit(0)" && node -e "process.exit(1)"';
  const amendedCommand = 'node -e "process.exit(0)"';
  const added = await callTool('add', {
    project,
    title: 'live verifier amendment',
    description: DISPATCH_DESCRIPTION,
    category: 'general',
    files: ['src/fixture.js'],
    verifyKind: 'command',
    verify: pinnedCommand,
  });
  const firstDispatch = store.prepareDispatch(project, added.ref, {
    allowUnscoped: true,
    sharedTree: true,
    sessionId: MCP_SESSION_ID,
  });
  const by = 'verify-amendment-worker';
  assert.equal(store.claimTicket(project, added.ref, by, {
    token: firstDispatch.token,
    executor: firstDispatch.ticket.dispatchExecutor,
    sessionId: MCP_SESSION_ID,
  }).ok, true);

  const executorRefusal = await callToolRaw('update', {
    project,
    ref: added.ref,
    by,
    verifyKind: 'command',
    verify: amendedCommand,
  });
  assert.equal(executorRefusal.isError, true);
  assert.match(executorRefusal.content[0].text, /active-claim update for verify/i);

  const updated = await callTool('update', {
    project,
    ref: added.ref,
    by: 'orchestrator',
    verifyKind: 'command',
    verify: amendedCommand,
  });

  assert.equal(updated.verificationAmendment.status, 'applied_to_live_dispatch');
  assert.equal(updated.verificationAmendment.oldCommand, pinnedCommand);
  assert.equal(updated.verificationAmendment.newCommand, amendedCommand);
  // SQ-223: the ack hands the orchestrator the current wrapper invocation for the executor.
  assert.ok(updated.verificationAmendment.message.includes(`--base64 ${Buffer.from(amendedCommand, 'utf8').toString('base64')}`), updated.verificationAmendment.message);
  assert.match(updated.verificationAmendment.message, new RegExp(`claim holder ${by}`));
  const liveTicket = store.getTicket(project, added.ref);
  assert.equal(liveTicket.executorVerify, amendedCommand);
  assert.equal(liveTicket.dispatch.verificationRequirement.command, amendedCommand);
  assert.equal(liveTicket.dispatch.lifecycleAttempt.verificationRequirement.command, amendedCommand);
  assert.deepEqual(liveTicket.verificationAmendments.at(-1), {
    at: liveTicket.verificationAmendments.at(-1).at,
    by: 'orchestrator',
    oldCommand: pinnedCommand,
    newCommand: amendedCommand,
  });

  const { capture, recorded } = await runCapturedVerification(amendedCommand, { project, ticket: added.ref }, repository);
  try {
    assert.equal(capture.status, 'passed');
    assert.equal(recorded?.ok, true);
    assert.equal(store.getTicket(project, added.ref).verificationCaptures.at(-1).command, amendedCommand);
  } finally {
    fs.rmSync(capture.logPath, { force: true });
  }
});

// SQ-900: a 25- and then 28-entry files array both returned ok:true and persisted
// only the first 20, so the executor's board commit refused paths the orchestrator
// had already approved. A scope write now round-trips whole, or it is refused.
test('add and update persist a declared scope past 20 entries and refuse an over-limit one', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-scope-cap-'))).slug;
  const scope = (count: number) => Array.from({ length: count }, (_, i) => `plugins/sidequest/src/lib/part-${String(i).padStart(3, '0')}.ts`);

  const added = await callTool('add', { project, title: 'wide declared scope', files: scope(25), unclassified: true });
  assert.deepEqual(store.getTicket(project, added.ref).files, scope(25));

  await callTool('update', { project, ref: added.ref, files: scope(28) });
  assert.deepEqual(store.getTicket(project, added.ref).files, scope(28));
  const listed = (await callTool('list', { project, detail: true })).tickets.find((ticket: any) => ticket.ref === added.ref);
  assert.deepEqual(listed.files, scope(28));

  const rejected = await callToolRaw('update', { project, ref: added.ref, files: scope(store.DECLARED_FILES_MAX + 3) });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, new RegExp(`at most ${store.DECLARED_FILES_MAX} entries.*${store.DECLARED_FILES_MAX + 3} \\(3 over\\)`));
  assert.match(rejected.content[0].text, /directory entries/);
  assert.deepEqual(store.getTicket(project, added.ref).files, scope(28), 'a refused write leaves the approved scope untouched');

  const rejectedAdd = await callToolRaw('add', { project, title: 'too wide', unclassified: true, files: scope(store.DECLARED_FILES_MAX + 1) });
  assert.equal(rejectedAdd.isError, true);
  assert.match(rejectedAdd.content[0].text, /declared file scope accepts at most/);

  const absolutePath = process.platform === 'win32' ? 'D:\\terge-tuner-data\\design\\generative-tuner-design.md' : '/abs/generative-tuner-design.md';
  const rejectedAbsoluteAdd = await callToolRaw('add', { project, title: 'outside scope', unclassified: true, files: [absolutePath] });
  assert.equal(rejectedAbsoluteAdd.isError, true);
  assert.match(rejectedAbsoluteAdd.content[0].text, /paths outside the repo worktree/);
  assert.match(rejectedAbsoluteAdd.content[0].text, /non-repo\/artifact work/);

  const rejectedAbsoluteUpdate = await callToolRaw('update', { project, ref: added.ref, files: [absolutePath] });
  assert.equal(rejectedAbsoluteUpdate.isError, true);
  assert.match(rejectedAbsoluteUpdate.content[0].text, /paths outside the repo worktree/);
  assert.match(rejectedAbsoluteUpdate.content[0].text, /declare in-repo paths/);
  assert.deepEqual(store.getTicket(project, added.ref).files, scope(28), 'an absolute-path refusal leaves the approved scope untouched');

  const contracts = await callTool('add', {
    project, title: 'wide contracts', unclassified: true,
    produces: scope(24).map((file) => `Payload:${file}`), consumes: scope(23).map((file) => `Input:${file}`), changes: scope(22).map((file) => `Shape:${file}`),
  });
  const stored = store.getTicket(project, contracts.ref).contracts;
  assert.deepEqual([stored.produces.length, stored.consumes.length, stored.changes.length], [24, 23, 22]);

  const rejectedContract = await callToolRaw('add', { project, title: 'too many contracts', unclassified: true, produces: scope(store.CONTRACT_NAMES_MAX + 1).map((file) => `Payload:${file}`) });
  assert.equal(rejectedContract.isError, true);
  assert.match(rejectedContract.content[0].text, /contract produces accepts at most/);

  const labels = Array.from({ length: store.LABELS_MAX + 1 }, (_, i) => `label-${i}`);
  const rejectedLabels = await callToolRaw('add', { project, title: 'too many labels', unclassified: true, labels });
  assert.equal(rejectedLabels.isError, true);
  assert.match(rejectedLabels.content[0].text, /labels accepts at most/);
});

test('storyId rejects values outside the US-n format', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-story-id-'))).slug;
  const response = await mcp.handleRequest({
    jsonrpc: '2.0', id: ++fixtureState.idc, method: 'tools/call',
    params: { name: 'add', arguments: { project, title: 'invalid story ID', storyId: 'story prose', unclassified: true } },
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /storyId must be a US-n story ref/);
});

test('story MCP tool covers the CLI story lifecycle', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-story-lifecycle-'))).slug;
  const created = await callTool('story', {
    project, action: 'add', title: 'MCP story', description: 'Group story work.', color: 'teal',
  });
  assert.equal(created.ok, true);
  assert.equal(created.project, project);
  assert.equal(created.story.title, 'MCP story');

  const ticket = store.createTicket(project, { title: 'Story member', storyId: created.story.ref, source: 'test' });
  const listed = await callTool('story', { project, action: 'list' });
  assert.equal(listed.stories[0].ticketCount, 1);
  const shown = await callTool('story', { project, action: 'show', story: created.story.id });
  assert.deepEqual(shown.tickets.map((entry: any) => entry.ref), [ticket.ref]);

  const updated = await callTool('story', { project, action: 'update', story: created.story.ref, title: 'Renamed story' });
  assert.equal(updated.ok, true);
  assert.equal(updated.story.title, 'Renamed story');
  const removed = await callTool('story', { project, action: 'rm', story: created.story.ref });
  assert.equal(removed.ok, true);
  assert.equal(removed.story.id, created.story.id);
  assert.equal(store.getTicket(project, ticket.ref).storyId, null);
});

test('story MCP tool rejects missing and invalid identifiers', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-story-identifiers-'))).slug;
  for (const action of ['show', 'update', 'rm']) {
    const missing = await callToolRaw('story', { project, action });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, new RegExp(`story ${action}: pass a story ref`));
  }
  for (const action of ['show', 'update']) {
    const missing = await callToolRaw('story', { project, action, story: 'US-999' });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, new RegExp(`story ${action}: no story "US-999"`));
  }
  const removed = await callTool('story', { project, action: 'rm', story: 'US-999' });
  assert.deepEqual(removed, { ok: false, project, story: null });
});

test('story contracts keep a durable 256 KiB capacity while reads page with stable metadata', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-story-contract-'))).slug;
  const story = store.createStory(project, { title: 'Contract packet' });
  const ticket = store.createTicket(project, { title: 'Member ticket', storyId: story.ref, source: 'test' });
  assert.equal(store.claimTicket(project, ticket.ref, 'contract-worker', { direct: true }).ok, true);

  const body = `Decision: ${'測'.repeat(7000)}\nInvariant: retain every byte.`;
  const set = await callTool('story_contract', { project, story: story.ref, contract: body });
  assert.equal(set.story.contractRevision, 1);
  assert.equal(set.contract.totalBytes, Buffer.byteLength(body, 'utf8'));
  assert.equal(set.contract.complete, false);
  assert.ok(set.contract.pageBytes <= 16 * 1024);
  assert.match(set.contract.sha256, /^[a-f0-9]{64}$/);

  const firstRead = await callTool('story_contract', { project, story: story.ref });
  const repeatedRead = await callTool('story_contract', { project, story: story.ref });
  assert.equal(firstRead.contract.revision, repeatedRead.contract.revision);
  assert.equal(firstRead.contract.sha256, repeatedRead.contract.sha256);
  assert.equal(firstRead.contract.body, repeatedRead.contract.body);

  let cursor: number | null = 0;
  let reconstructed = '';
  while (cursor !== null) {
    const page = await callTool('story_contract', { project, story: story.ref, cursor });
    reconstructed += page.contract.body;
    cursor = page.contract.nextCursor;
  }
  assert.equal(reconstructed, body);
  const ranged = await callTool('story_contract', { project, story: story.ref, cursor: 1, limit: 99 });
  assert.ok(Buffer.byteLength(ranged.contract.body, 'utf8') <= 99);
  assert.doesNotMatch(ranged.contract.body, /^�/);
  const tooSmall = await callToolRaw('story_contract', { project, story: story.ref, limit: 1 });
  assert.equal(tooSmall.isError, true);
  assert.match(tooSmall.content[0].text, /at least 4 UTF-8 bytes/);

  const maximum = 'x'.repeat(256 * 1024);
  assert.equal(store.updateStory(project, story.ref, { executionContract: maximum }).executionContract, maximum);
  assert.throws(
    () => store.updateStory(project, story.ref, { executionContract: `${maximum}x` }),
    /story execution contract is 262145 UTF-8 bytes, 1 over the 262144-byte capacity\./,
  );

  const pulse = await callTool('pulse', { project, ref: ticket.ref });
  assert.match(pulse.warnings.join('\n'), /execution contract changed/);
  const changes = await callTool('changes', { project, since: '2000-01-01T00:00:00.000Z' });
  assert.match(changes.tickets.find((entry: any) => entry.ref === ticket.ref).warnings.join('\n'), /execution contract changed/);
});

test('story_log reads, appends from a claimed member, and rotates after promotion', async () => {
  const storyLog = mcp.toolDescriptors().find((tool: any) => tool.name === 'story_log');
  assert.match(storyLog.description, /Story log/);
  assert.equal(storyLog.inputSchema.properties.entry.pattern, '^(DECISION|CONSTRAINT|DISCOVERY)\\s*:');
  assert.match(storyLog.inputSchema.properties.entry.description, /Must begin DECISION:, CONSTRAINT:, or DISCOVERY:/);
  assert.match(storyLog.inputSchema.properties.entry.description, /16,000 UTF-8 bytes/);

  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-story-log-'))).slug;
  const story = store.createStory(project, { title: 'Decision log packet' });
  const ticket = store.createTicket(project, { title: 'Member ticket', storyId: story.ref, source: 'test' });
  assert.equal(store.claimTicket(project, ticket.ref, 'log-worker', { direct: true }).ok, true);

  const empty = await callTool('story_log', { project, story: story.ref });
  assert.equal(empty.story.logBytes, 0);
  assert.equal(empty.story.logCapacity, 16 * 1024);
  assert.equal(empty.story.logRevision, 0);
  assert.deepEqual(empty.story.entries, []);

  const appended = await callTool('story_log', {
    project, story: story.ref, ref: ticket.ref, by: 'log-worker', entry: 'DISCOVERY: CLI and MCP share the same store API.',
  });
  assert.equal(appended.story.logRevision, 1);
  assert.deepEqual(
    { ref: appended.story.entries[0].ref, by: appended.story.entries[0].by, kind: appended.story.entries[0].kind, text: appended.story.entries[0].text },
    { ref: ticket.ref, by: 'log-worker', kind: 'DISCOVERY', text: 'CLI and MCP share the same store API.' },
  );

  const malformed = await callToolRaw('story_log', {
    project, story: story.ref, ref: ticket.ref, by: 'log-worker', entry: 'missing prefix',
  });
  assert.equal(malformed.isError, true);
  assert.match(malformed.content[0].text, /story log entry must begin with DECISION:, CONSTRAINT:, or DISCOVERY:/);

  const rotated = await callTool('story_log', { project, story: story.ref, rotate: true, by: 'orchestrator' });
  assert.equal(rotated.story.logBytes, 0);
  assert.equal(rotated.story.logCapacity, 16 * 1024);
  assert.equal(rotated.story.logRevision, 1);
  assert.deepEqual(rotated.story.entries, []);
  assert.equal(rotated.story.archivedEntries, 1);
  const denied = await callToolRaw('story_log', { project, story: story.ref, rotate: true, by: 'log-worker' });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /rotate:true requires by:"orchestrator"/);
});

test('MCP comment attribution keeps the control plane distinct from a claim holder', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-comment-attribution-'))).slug;
  const ticket = store.createTicket(project, { title: 'Comment authoring' });
  assert.equal(store.claimTicket(project, ticket.ref, 'claim-holder', { direct: true, sessionId: 'executor-session' }).ok, true);

  const controlPlane = freshMcpServer();
  const controlPlaneComment = await callToolOn(controlPlane, 'comment', { project, ref: ticket.ref, body: 'Control-plane comment.' });
  assert.ok(controlPlaneComment.commentId, 'control-plane comment is acknowledged');
  const storedControlPlaneComment = store.getTicket(project, ticket.ref).comments.at(-1);
  assert.equal(storedControlPlaneComment.by, `orchestrator-${MCP_SESSION_ID.slice(0, 12)}`);
  assert.equal(storedControlPlaneComment.sourceSession, MCP_SESSION_ID);
  assert.equal(storedControlPlaneComment.actor, storedControlPlaneComment.by);
  assert.equal(storedControlPlaneComment.operation, 'comment');

  await callTool('comment', { project, ref: ticket.ref, body: 'Executor comment.', by: 'claim-holder' });
  assert.equal(store.getTicket(project, ticket.ref).comments.at(-1).by, 'claim-holder');

  await callTool('comment', { project, ref: ticket.ref, body: 'Named control-plane comment.', by: 'orchestrator-review' });
  assert.equal(store.getTicket(project, ticket.ref).comments.at(-1).by, 'orchestrator-review');
});

test('SQ-306: a capture waiver comment needs an explicit author, and its ack says whether the waiver can bind', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-capture-waiver-author-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const project = store.ensureProject(root).slug;
  const command = 'npm test';
  const ticket = store.createTicket(project, { title: 'Capture waiver authorship', executorVerify: command });
  // An executor subagent runs inside its orchestrator's runtime session, which is exactly why the
  // claim-holder default fired on an orchestrator comment in the SQ-299 repro.
  const executorSession = `sq306-executor-${process.pid}`;
  assert.equal(store.claimTicket(project, ticket.ref, 'sq306-claim-holder', { direct: true, sessionId: executorSession }).ok, true);
  const recorded = store.recordVerificationCapture(project, ticket.ref, {
    id: 'cap-sq306',
    command,
    status: 'timeout',
    candidate: { source: 'git', value: 'a'.repeat(40) },
    completedAt: '2026-10-09T00:00:00.000Z',
  });
  assert.equal(recorded.ok, true, recorded.message);
  const waiver = '[sidequest:capture-waiver] capture=cap-sq306 signature=timeout authority=orchestrator-sq306; capture budget timeout while three sibling suites ran and reruns keep timing out';
  const comments = () => store.getTicket(project, ticket.ref).comments || [];

  const defaulted = await callToolAsSession(executorSession, 'comment', { project, ref: ticket.ref, body: waiver });
  assert.equal(defaulted.ok, false);
  assert.equal(defaulted.reason, 'authority_comment_author');
  assert.match(defaulted.message, /Nothing was recorded\./);
  assert.match(defaulted.message, /Repost it with by:/);
  assert.equal(comments().length, 0, 'a waiver that cannot bind is never left sitting in the thread');

  const asClaimHolder = await callTool('comment', { project, ref: ticket.ref, body: waiver, by: 'sq306-claim-holder' });
  assert.equal(asClaimHolder.ok, false);
  assert.equal(asClaimHolder.reason, 'authority_comment_author');
  assert.equal(comments().length, 0, 'naming the claim holder explicitly is refused at the shared write path too');

  const accepted = await callToolAsSession(executorSession, 'comment', { project, ref: ticket.ref, body: waiver, by: 'orchestrator-sq306' });
  assert.equal(accepted.ok, true, accepted.message);
  assert.deepEqual({
    capture: accepted.captureWaiver.capture,
    author: accepted.captureWaiver.author,
    authorEligible: accepted.captureWaiver.authorEligible,
    captureKnown: accepted.captureWaiver.captureKnown,
    candidate: accepted.captureWaiver.candidate,
    candidateMatchesPinned: accepted.captureWaiver.candidateMatchesPinned,
    binds: accepted.captureWaiver.binds,
  }, {
    capture: 'cap-sq306',
    author: 'orchestrator-sq306',
    authorEligible: true,
    captureKnown: true,
    candidate: 'a'.repeat(40),
    candidateMatchesPinned: true,
    binds: true,
  });
  assert.match(accepted.captureWaiver.note, /stops binding the moment that candidate changes/);
  assert.equal(comments().at(-1).by, 'orchestrator-sq306');

  // SQ-299's second failure: the capture the waiver names is no longer the candidate in play.
  assert.equal(store.recordVerificationCapture(project, ticket.ref, {
    id: 'cap-sq306-amended',
    command,
    status: 'timeout',
    candidate: { source: 'git', value: 'b'.repeat(40) },
    completedAt: '2026-10-09T01:00:00.000Z',
  }).ok, true);
  const superseded = await callToolAsSession(executorSession, 'comment', { project, ref: ticket.ref, body: waiver, by: 'orchestrator-sq306' });
  assert.equal(superseded.ok, true, superseded.message);
  assert.equal(superseded.captureWaiver.binds, false);
  assert.equal(superseded.captureWaiver.candidateMatchesPinned, false);
  assert.match(superseded.captureWaiver.note, /the live pinned candidate is b{40}/);

  // A non-authority comment keeps the claim-holder fallback and the lean ack. The fallback is
  // load-bearing, not cosmetic: recordClaimVerification only captures a [sidequest:verify-complete]
  // marker whose by equals the claim holder, so defaulting these to the caller identity would drop
  // verify capture for every executor that omits by.
  const plain = await callToolAsSession(executorSession, 'comment', { project, ref: ticket.ref, body: 'Load evidence attached.' });
  assert.equal(plain.ok, true);
  assert.equal(comments().at(-1).by, 'sq306-claim-holder');
  assert.equal(plain.captureWaiver, undefined);
  assert.deepStrictEqual(Object.keys(plain).sort(), ['at', 'commentId', 'ok', 'project', 'ref', 'status']);

  const marker = await callToolAsSession(executorSession, 'comment', {
    project,
    ref: ticket.ref,
    body: `[sidequest:verify-complete] passed: ${command} exercised the waiver binding.`,
  });
  assert.equal(marker.ok, true, marker.message);
  assert.equal(comments().at(-1).by, 'sq306-claim-holder', 'the verify marker stays the claim holder\'s so submit can capture it');
});

test('MCP accepts curated natural aliases and names each accepted mapping', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-argument-aliases-'))).slug;
  const first = store.createTicket(project, { title: 'Alias source', source: 'test' });
  const second = store.createTicket(project, { title: 'Alias target', source: 'test' });
  const story = store.createStory(project, { title: 'Alias story' });
  store.updateTicket(project, first.ref, { storyId: story.ref });
  assert.equal(store.claimTicket(project, first.ref, 'alias-worker', { direct: true }).ok, true);

  const comment = await callTool('comment', { project, ref: first.ref, message: 'Accepted through message.', by: 'alias-worker' });
  assert.deepEqual(comment.acceptedAliases, ['accepted message as body']);
  assert.equal(store.getTicket(project, first.ref).comments.at(-1).body, 'Accepted through message.');

  const shortComment = await callTool('comment', { project, ref: first.ref, m: 'Accepted through m.', by: 'alias-worker' });
  assert.deepEqual(shortComment.acceptedAliases, ['accepted m as body']);
  assert.equal(store.getTicket(project, first.ref).comments.at(-1).body, 'Accepted through m.');

  const link = await callTool('link', { project, ref: first.ref, type: 'related', target: second.ref });
  assert.equal(link.ok, true);
  assert.deepEqual(link.acceptedAliases, ['accepted type as verb', 'accepted target as to', 'accepted ref as from']);
  assert.equal(link.type, 'related');

  const addedToStory = await callTool('add', { project, title: 'Added with story alias', story: story.ref, unclassified: true });
  assert.equal(addedToStory.ok, true);
  assert.deepEqual(addedToStory.acceptedAliases, ['accepted story as storyId']);
  assert.equal(store.getTicket(project, addedToStory.ref).storyId, story.id);

  const unlinked = await callTool('unlink', { project, from: first.ref, to: second.ref });
  assert.equal(unlinked.ok, true);
  assert.deepEqual(unlinked.acceptedAliases, ['accepted from as a', 'accepted to as b']);

  const missingReview = await callToolRaw('rework', { project, ref: first.ref, by: 'alias-worker', reason: 'Review found a defect.' });
  assert.equal(missingReview.isError, true);
  assert.match(missingReview.content[0].text, /rework: missing required argument "review"\./);

  const documentedReadForm = await callToolRaw('board_config', { project, action: 'get' });
  assert.equal(documentedReadForm.isError, true);
  assert.match(documentedReadForm.content[0].text, /call with no arguments to read board settings/);

  const log = await callTool('story_log', {
    project, story: story.ref, ref: first.ref, by: 'alias-worker', append: 'DISCOVERY: aliases shorten failed calls.',
  });
  assert.deepEqual(log.acceptedAliases, ['accepted append as entry']);
  assert.equal(log.story.entries[0].text, 'aliases shorten failed calls.');

  const added = await callTool('add', {
    project, title: 'Medium is normal', priority: 'medium', complexity: 1, why: 'Exercise the compatibility priority alias over the MCP surface.',
  });
  assert.deepEqual(added.acceptedAliases, ['accepted priority "medium" as "normal"']);
  assert.equal(store.getTicket(project, added.ref).priority, 'normal');
});

test('MCP suggests a unique close argument and preserves unrelated unknown-argument errors', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-argument-suggestions-'))).slug;
  const close = await callToolRaw('comment', { project, ref: 'SQ-1', bodz: 'typo' });
  assert.equal(close.isError, true);
  assert.match(close.content[0].text, /comment: unknown argument "bodz" — comment accepts: .*body, by\. did you mean body\?/);

  const distant = await callToolRaw('comment', { project, ref: 'SQ-1', unrelated: 'value' });
  assert.equal(distant.isError, true);
  assert.match(distant.content[0].text, /comment: unknown argument "unrelated" — comment accepts: .*body, by\.$/);
  assert.doesNotMatch(distant.content[0].text, /did you mean/);
});

test('MCP rejects missing required arguments before tools receive undefined values', async () => {
  const pulse = await callToolRaw('pulse', {});
  assert.equal(pulse.isError, true);
  assert.equal(pulse.content[0].text, 'pulse: missing required argument "ref" — pulse reads one ticket; for a project-wide liveness/progress read call changes.');
  assert.doesNotMatch(pulse.content[0].text, /no ticket "undefined"/);

  const update = await callToolRaw('update', {});
  assert.equal(update.isError, true);
  assert.equal(update.content[0].text, 'update: missing required argument "ref".');
  assert.doesNotMatch(update.content[0].text, /no ticket "undefined"/);

  const commit = await callToolRaw('commit', {});
  assert.equal(commit.isError, true);
  assert.equal(commit.content[0].text, 'commit: missing required arguments "ref", "by", "message", "worktree".');
});

test('MCP list accepts brief output shaping and advertises it in the schema', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-list-brief-'))).slug;
  store.createTicket(project, { title: 'Brief list row', source: 'test' });
  const listed = await callTool('list', { project, brief: true });
  assert.equal(listed.tickets.length, 1);
  assert.equal(Object.hasOwn(listed.tickets[0], 'description'), false, 'brief list rows omit full ticket bodies');
  const descriptor = mcp.toolDescriptors().find((tool: any) => tool.name === 'list');
  assert.match(descriptor.inputSchema.properties.brief.description, /One compact row per ticket/);
});

test('CLI accepts natural aliases and list output flags', () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-cli-argument-aliases-'))).slug;
  const first = store.createTicket(project, { title: 'CLI alias source', source: 'test' });
  const second = store.createTicket(project, { title: 'CLI alias target', source: 'test' });
  const controlPlaneComment = runCli(['comment', first.ref, '-m', 'CLI control-plane comment', '--project', project, '--json']);
  assert.equal(controlPlaneComment.comment.by, `orchestrator-${MCP_SESSION_ID.slice(0, 12)}`);

  const comment = runCli(['comment', first.ref, '--message', 'CLI message alias', '--project', project, '--json']);
  assert.deepEqual(comment.acceptedAliases, ['accepted message as body']);
  assert.equal(store.getTicket(project, first.ref).comments.at(-1).body, 'CLI message alias');

  const link = runCli(['link', '--ref', first.ref, '--type', 'related', '--target', second.ref, '--project', project, '--json']);
  assert.deepEqual(link.acceptedAliases, ['accepted ref as from', 'accepted type as verb', 'accepted target as to']);

  const brief = runCli(['list', '--project', project, '--brief']);
  assert.equal(brief.tickets.length, 2);
  assert.equal(Object.hasOwn(brief.tickets[0], 'description'), false, 'CLI --brief uses compact ticket rows');

  const added = runCli(['add', '--title', 'CLI medium priority', '--priority', 'medium', '--complexity', '1', '--why', 'Exercise the CLI compatibility priority alias for normal priority.', '--project', project, '--json']);
  assert.equal(added.ticket.priority, 'normal');
});

test('MCP rejects unsupported write and read parameters before they can be ignored', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-strict-arguments-'))).slug;
  const story = store.createStory(project, { title: 'Strict arguments' });
  const ticket = store.createTicket(project, { title: 'Member ticket', storyId: story.ref, source: 'test' });
  assert.equal(store.claimTicket(project, ticket.ref, 'argument-worker', { direct: true }).ok, true);

  const invalidStoryLogArguments = [
    { text: 'DISCOVERY: ignored entry' },
    { kind: 'DISCOVERY' },
  ];
  for (const invalidArguments of invalidStoryLogArguments) {
    const parameter = Object.keys(invalidArguments)[0];
    const rejected = await callToolRaw('story_log', Object.assign({
      project, story: story.ref, ref: ticket.ref, by: 'argument-worker',
    }, invalidArguments));
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, new RegExp(`story_log: unknown argument \"${parameter}\" — story_log accepts: .*entry`));
  }
  assert.deepEqual(store.storyDecisionLog(store.getStory(project, story.ref)).entries, []);

  const rejectedComments = await callToolRaw('comments', { project, ref: ticket.ref, order: 'newest' });
  assert.equal(rejectedComments.isError, true);
  assert.match(rejectedComments.content[0].text, /comments: unknown argument "order" — comments accepts: .*ref/);

  const rejectedEnum = await callToolRaw('category_edit', { project, id: 'coding.normal', routeEffort: 'ultra' });
  assert.equal(rejectedEnum.isError, true);
  assert.match(rejectedEnum.content[0].text, /category_edit: routeEffort received "ultra" — must be one of: low, medium, high, xhigh, max\./);
  const omittedEnum = await callToolRaw('category_edit', { project, id: 'coding.normal', routeEffort: undefined });
  assert.equal(omittedEnum.isError, undefined);
});

test('MCP category_edit rejects guessed fields and reports applied routing changes', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-category-edit-'))).slug;
  const rejectedEffort = await callToolRaw('category_edit', { project, id: 'coding.normal', effort: 'medium' });
  assert.equal(rejectedEffort.isError, true);
  assert.match(rejectedEffort.content[0].text, /category_edit: unknown argument "effort" — category_edit accepts: id, project, profile, name, description, contract, artifactRoots, routeModel, routeEffort, fallbackModel, fallbackEffort, enabled, readonly\./);

  const rejectedRoute = await callToolRaw('category_edit', { project, id: 'coding.normal', route: { model: 'codex-gpt-5-6-luna', effort: 'medium' } });
  assert.equal(rejectedRoute.isError, true);
  assert.match(rejectedRoute.content[0].text, /category_edit: unknown argument "route" — category_edit accepts:/);

  const edited = await callTool('category_edit', {
    project,
    id: 'coding.normal',
    routeModel: 'codex-gpt-5-6-luna',
    routeEffort: 'medium',
    fallbackModel: 'codex-gpt-5-6-terra',
    fallbackEffort: 'low',
    readonly: true,
  });
  assert.deepEqual(edited.changed.sort(), ['fallback', 'readonly', 'route']);
  assert.equal(edited.localRow.kind, 'DETACH');

  const unchanged = await callTool('category_edit', {
    project,
    id: 'coding.normal',
    routeModel: 'codex-gpt-5-6-luna',
    routeEffort: 'medium',
    fallbackModel: 'codex-gpt-5-6-terra',
    fallbackEffort: 'low',
    readonly: true,
  });
  assert.deepEqual(unchanged.changed, []);

  const clearedFallback = await callTool('category_edit', { project, id: 'coding.normal', fallbackModel: null });
  assert.deepEqual(clearedFallback.changed, ['fallback']);
  assert.equal(store.getCategory('coding.normal', { project }).fallback, null);
});

test('list returns verify while retaining executorVerify for compatibility', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-verify-name-'))).slug;
  const ticket = store.createTicket(project, {
    title: 'Verify field', executorVerify: 'node --test plugins/sidequest/test/mcp.test.ts', source: 'test',
  });

  const listed = await callTool('list', { project, all: true, detail: true });
  const row = listed.tickets.find((candidate: any) => candidate.ref === ticket.ref);
  assert.equal(row.verify, ticket.executorVerify);
  assert.equal(row.executorVerify, ticket.executorVerify);
});

test('the build budget report itemizes the served MCP descriptors', () => {
  const report = mcp.toolDescriptorByteReport();
  assert.equal(report.maxBytes, mcp.MCP_TOOLS_LIST_MAX_BYTES);
  assert.equal(report.reserveBytes, mcp.MCP_TOOLS_LIST_HEADROOM_BYTES);
  assert.equal(report.tools[0].name, 'update');
  assert.ok(report.tools.every((tool: any, index: number) => index === 0 || report.tools[index - 1].bytes >= tool.bytes));
});

test('tools/list preserves MCP contracts within the payload budget', async (context: { diagnostic(message: string): void }) => {
  const tools = mcp.toolDescriptors();
  const report = mcp.toolDescriptorByteReport();
  const payloadBytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
  const headroom = mcp.MCP_TOOLS_LIST_MAX_BYTES - payloadBytes;
  context.diagnostic(`tools/list budget: ${tools.length} tools, ${payloadBytes}/${mcp.MCP_TOOLS_LIST_MAX_BYTES} payload bytes, ${headroom}/${mcp.MCP_TOOLS_LIST_HEADROOM_BYTES} bytes headroom; largest: ${report.tools.slice(0, 5).map((tool: any) => `${tool.name}=${tool.bytes}`).join(', ')}`);
  assert.equal(report.payloadBytes, payloadBytes);
  assert.equal(report.headroomBytes, headroom);
  assert.ok(payloadBytes <= mcp.MCP_TOOLS_LIST_MAX_BYTES, `tools/list payload is ${payloadBytes} bytes, over the ${mcp.MCP_TOOLS_LIST_MAX_BYTES}-byte budget`);
  assert.ok(headroom >= mcp.MCP_TOOLS_LIST_HEADROOM_BYTES, `tools/list headroom is ${headroom} bytes, below ${mcp.MCP_TOOLS_LIST_HEADROOM_BYTES}`);
  assert.match(tools.find((tool: any) => tool.name === 'claim').description, /ok:true/);
  assert.match(tools.find((tool: any) => tool.name === 'dispatch').description, /token and spawn spec/);
  assert.match(tools.find((tool: any) => tool.name === 'dispatch').inputSchema.properties.recoveryEvidence.description, /Proof/);
  assert.match(tools.find((tool: any) => tool.name === 'done').description, /declared external needs current capture/);
  assert.match(tools.find((tool: any) => tool.name === 'list').description, /changes\/pulse/);
  const list = tools.find((tool: any) => tool.name === 'list');
  assert.match(list.inputSchema.properties.detail.description, /Full comments/);
  const comments = tools.find((tool: any) => tool.name === 'comments');
  assert.match(comments.inputSchema.properties.full.description, /Whole bodies/);
  assert.match(comments.inputSchema.properties.since.description, /Comment id.*ISO timestamp/);
  const add = tools.find((tool: any) => tool.name === 'add');
  assert.match(add.inputSchema.properties.complexity.description, /why required/);
  assert.equal(tools.find((tool: any) => tool.name === 'changes').description, 'Poll ticket changes.');
  assert.equal(tools.find((tool: any) => tool.name === 'ready').description, 'List ready ticket refs, by priority.');
  assert.deepEqual(Object.keys(comments.inputSchema.properties).sort(), ['cursor', 'full', 'limit', 'project', 'ref', 'since']);
  assert.equal(comments.inputSchema.properties.full.type, 'boolean');
  assert.equal(Object.hasOwn(tools.find((tool: any) => tool.name === 'unarchive').inputSchema.properties, 'full'), false);
  for (const tool of tools) {
    const source = mcp.TOOLS.find((candidate: any) => candidate.name === tool.name);
    assert.deepEqual(
      Object.keys(tool.inputSchema.properties).sort(),
      Object.keys(source.inputSchema.properties).sort(),
      `${tool.name} preserves every input property`,
    );
  }
});

test('board_config defaults docs to always-in-scope', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-docs-scope-'));
  fs.mkdirSync(path.join(root, 'docs'));
  const project = store.ensureProject(root, 'SQ docs config').slug;
  assert.deepEqual((await callTool('board_config', { project })).alwaysInScope, ['docs/']);
});


test('board_config reads and replaces always-in-scope paths', async () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-board-config'), 'SQ config').slug;
  const configured = await callTool('board_config', { project, alwaysInScope: ['docs', 'notes'] });
  assert.deepEqual(configured.alwaysInScope, ['docs', 'notes']);
  assert.deepEqual((await callTool('board_config', { project })).alwaysInScope, ['docs', 'notes']);
});

test('board_config stores read-only MCP deny patterns', async () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-read-only-deny'), 'SQ read-only deny').slug;
  const patterns = ['mcp__notion__search', 'mcp__plugin_svelte_svelte__*'];
  const configured = await callTool('board_config', { project, readOnlyDeniedTools: patterns });
  assert.deepEqual(configured.readOnlyDeniedTools, patterns);
  assert.deepEqual((await callTool('board_config', { project })).readOnlyDeniedTools, patterns);
  const rejected = await callToolRaw('board_config', { project, readOnlyDeniedTools: ['Bash'] });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /must target MCP tools/);
});

test('board_config stores generated source-to-output pairs', async () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-generated-pairs'), 'SQ generated pairs').slug;
  const pairs = [{ from: 'plugins/*/src/lib/*.ts', to: 'plugins/*/lib/*.js' }];
  assert.deepEqual((await callTool('board_config', { project, generatedPairs: pairs })).generatedPairs, pairs);
  assert.deepEqual((await callTool('board_config', { project })).generatedPairs, pairs);
  const rejected = await callToolRaw('board_config', { project, generatedPairs: [{ from: 'src/*.ts', to: 'lib/*.js*' }] });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /same number of \* placeholders/);
});

test('board_config defaults and stores the integration branch', async () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-integration-branch'), 'SQ integration branch').slug;
  assert.equal((await callTool('board_config', { project })).integrationBranch, 'main');
  assert.equal((await callTool('board_config', { project, integrationBranch: 'feat/release' })).integrationBranch, 'feat/release');
  const rejected = await callToolRaw('board_config', { project, integrationBranch: 'feat//release' });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /integrationBranch must be a valid Git branch name/);
});

test('board_config defaults to automatic worktree bases and stores explicit choices', async () => {
  const project = store.ensureProject(createGitWorktree(), 'SQ worktree base').slug;
  assert.equal((await callTool('board_config', { project })).worktreeBase, 'auto');
  assert.equal((await callTool('board_config', { project, worktreeBase: 'origin-main' })).worktreeBase, 'origin-main');
  assert.equal((await callTool('board_config', { project, worktreeBase: 'local-main' })).worktreeBase, 'local-main');
  const rejected = await callToolRaw('board_config', { project, worktreeBase: 'head' });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /must be one of: auto, origin-main, local-main/);
});

test('board_config renames only a board display name', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-board-rename-'));
  const project = store.ensureProject(projectPath, 'Original board').slug;
  const ticket = store.createTicket(project, {
    title: 'rename keeps ticket refs', complexity: 2,
    complexityWhy: 'The display name changes while the stable ticket reference remains intact.',
  });
  const before = store.readMeta(project);
  const renamed = await callTool('board_config', { project, name: 'Renamed board' });

  assert.equal(renamed.name, 'Renamed board');
  assert.equal(renamed.projectName, 'Renamed board');
  assert.equal(store.readMeta(project).path, before.path);
  assert.equal(store.findProject(project).slug, project);
  assert.equal(store.getTicket(project, ticket.ref).ref, ticket.ref);

  const duplicate = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-duplicate-name-')), 'Renamed board').slug;
  assert.equal((await callTool('board_config', { project: duplicate, name: 'Renamed board' })).name, 'Renamed board');

  const rejected = await callToolRaw('board_config', { project, name: '   ' });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /Board name cannot be empty/);
});

test('board_config stores and clears worktree provisioning', async () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-worktree-setup'), 'SQ worktree setup').slug;
  const setup = 'cd plugins/sidequest && npm ci';
  const dependencyPaths = [{ path: 'node_modules', mode: 'copy' }];
  const configured = await callTool('board_config', { project, worktreeSetup: setup, worktreeDependencyPaths: dependencyPaths });
  assert.equal(configured.worktreeSetup, setup);
  assert.deepStrictEqual(configured.worktreeDependencyPaths, dependencyPaths);
  assert.deepStrictEqual((await callTool('board_config', { project })).worktreeDependencyPaths, dependencyPaths);
  const cleared = await callTool('board_config', { project, worktreeSetup: null, worktreeDependencyPaths: [] });
  assert.equal(cleared.worktreeSetup, null);
  assert.deepStrictEqual(cleared.worktreeDependencyPaths, []);
});

test('board_config sets worktree recovery retention', async () => {
  const root = path.join(os.tmpdir(), 'sq-mcp-recovery-retention');
  const project = store.ensureProject(root, 'SQ recovery retention').slug;
  const configured = await callTool('board_config', {
    project,
    worktreeRecoveryRetentionAgeHours: 336,
    worktreeRecoveryRetentionMaxPerAgent: 5,
  });
  assert.equal(configured.worktreeRecoveryRetentionAgeHours, 336);
  assert.equal(configured.worktreeRecoveryRetentionMaxPerAgent, 5);
  const cli = runCli([
    'board-config', '--project', root,
    '--worktree-recovery-retention-age-hours', '504',
    '--worktree-recovery-retention-max-per-agent', '6',
    '--json',
  ]);
  assert.equal(cli.worktreeRecoveryRetentionAgeHours, 504);
  assert.equal(cli.worktreeRecoveryRetentionMaxPerAgent, 6);
  await assert.rejects(() => callTool('board_config', { project, worktreeRecoveryRetentionAgeHours: 0 }), /at least 1 hour/);
  await assert.rejects(() => callTool('board_config', { project, worktreeRecoveryRetentionMaxPerAgent: 0 }), /at least 1/);
});

test('board_config sets the unintegrated worktree salvage age', async () => {
  const root = path.join(os.tmpdir(), 'sq-mcp-salvage-age');
  const project = store.ensureProject(root, 'SQ salvage age').slug;
  const configured = await callTool('board_config', { project, notIntegratedSalvageAgeHours: 336 });
  assert.equal(configured.notIntegratedSalvageAgeHours, 336);
  assert.equal(runCli(['board-config', '--project', root, '--not-integrated-salvage-age-hours', '504', '--json']).notIntegratedSalvageAgeHours, 504);
  await assert.rejects(() => callTool('board_config', { project, notIntegratedSalvageAgeHours: 24 }), /at least 168 hours/);
});

test('board worktree isolation defaults on and overrides dispatch isolation when disabled', async () => {
  const isolatedRoot = committedRepo('sq-mcp-worktree-isolation-default-');
  const isolatedProject = store.ensureProject(isolatedRoot, 'SQ default isolation').slug;
  assert.equal((await callTool('board_config', { project: isolatedProject })).worktreeIsolation, true);
  assert.equal((await callTool('board_config', { project: isolatedProject })).autoApproveTestScope, true);
  const isolatedTicket = store.createTicket(isolatedProject, {
    title: 'default board isolation', description: DISPATCH_DESCRIPTION, category: 'coding.normal', files: ['src/work.ts'],
  });
  const isolated = await callTool('dispatch', { allowUnscoped: true, project: isolatedProject, ref: isolatedTicket.ref, full: true });
  assert.equal(isolated.spawn.isolation, 'worktree');
  assert.equal(store.getTicket(isolatedProject, isolatedTicket.ref).dispatch.sharedTree, false);

  const scopeLessTicket = store.createTicket(isolatedProject, {
    title: 'scope-less default board isolation', description: DISPATCH_DESCRIPTION, category: 'coding.normal',
  });
  const scopeLess = await callTool('dispatch', { allowUnscoped: true, project: isolatedProject, ref: scopeLessTicket.ref, full: true });
  assert.equal(scopeLess.spawn.isolation, 'worktree');
  assert.equal(store.getTicket(isolatedProject, scopeLessTicket.ref).dispatch.sharedTree, false);

  store.setCategory({ id: 'readonly-zero-scope', name: 'Readonly zero scope', route: { model: 'sonnet', effort: 'medium' }, fallback: null, readonly: true, enabled: true });
  const readonlyTicket = store.createTicket(isolatedProject, {
    title: 'zero-scope read-only isolated checkout', description: DISPATCH_DESCRIPTION, category: 'readonly-zero-scope',
  });
  const isolatedOrchestrator = path.join(isolatedRoot, 'isolated-orchestrator');
  execFileSync('git', ['worktree', 'add', '--detach', isolatedOrchestrator], { cwd: isolatedRoot, windowsHide: true });
  const originalWorkingDirectory = process.cwd();
  let readonly;
  try {
    process.chdir(isolatedOrchestrator);
    readonly = await callTool('dispatch', { allowUnscoped: true, project: isolatedProject, ref: readonlyTicket.ref, full: true });
  } finally {
    process.chdir(originalWorkingDirectory);
    execFileSync('git', ['worktree', 'remove', '--force', isolatedOrchestrator], { cwd: isolatedRoot, windowsHide: true });
  }
  assert.equal(readonly.spawn.isolation, 'worktree');
  assert.equal(store.getTicket(isolatedProject, readonlyTicket.ref).dispatch.sharedTree, false);
  assert.match(readonly.spawn.prompt, /zero-scope read-only isolated checkout/);
  assert.match(readonly.spawn.prompt, new RegExp(`--project "${isolatedRoot.replace(/\\/g, '\\\\')}"`));
  const readonlyBriefing = agentsync.renderTicketBriefing(store.getTicket(isolatedProject, readonlyTicket.ref), readonly.token, isolatedProject, isolatedRoot);
  assert.match(readonlyBriefing, /Worktree isolation contract: this dispatch runs in its own linked worktree/);
  const explicitlyIsolated = await callTool('dispatch', { allowUnscoped: true, project: isolatedProject, ref: readonlyTicket.ref, sharedTree: false, full: true });
  assert.equal(explicitlyIsolated.spawn.isolation, 'worktree');
  assert.equal(store.getTicket(isolatedProject, readonlyTicket.ref).dispatch.sharedTree, false);

  const sharedRoot = committedRepo('sq-mcp-worktree-isolation-off-');
  const sharedProject = store.ensureProject(sharedRoot, 'SQ shared isolation').slug;
  const configured = await callTool('board_config', { project: sharedProject, worktreeIsolation: false });
  assert.equal(configured.worktreeIsolation, false);
  assert.equal((await callTool('board_config', { project: sharedProject })).worktreeIsolation, false);
  assert.equal(runCli(['board-config', '--project', sharedRoot, '--worktree-isolation', '--json'], sharedRoot).worktreeIsolation, true);
  assert.equal(runCli(['board-config', '--project', sharedRoot, '--no-worktree-isolation', '--json'], sharedRoot).worktreeIsolation, false);
  assert.equal(runCli(['board-config', '--project', sharedRoot, '--no-auto-approve-test-scope', '--json'], sharedRoot).autoApproveTestScope, false);
  assert.equal(runCli(['board-config', '--project', sharedRoot, '--auto-approve-test-scope', '--json'], sharedRoot).autoApproveTestScope, true);
  assert.deepEqual(runCli(['board-config', '--project', sharedRoot, '--auto-approve-scope', 'generated/**', '--auto-approve-scope', 'snapshots/**', '--json'], sharedRoot).autoApproveScope, ['generated/**', 'snapshots/**']);

  const sharedTicket = store.createTicket(sharedProject, {
    title: 'scope-less disabled board isolation', description: DISPATCH_DESCRIPTION, category: 'coding.normal',
  });
  const shared = await callTool('dispatch', { allowUnscoped: true, project: sharedProject, ref: sharedTicket.ref, full: true });
  assert.equal(shared.spawn.isolation, undefined);
  assert.equal(store.getTicket(sharedProject, sharedTicket.ref).dispatch.sharedTree, true);
  const legacyShared = await callHandler('native_agent', { project: sharedProject, ref: sharedTicket.ref, prompt: 'Implement the ticket.' });
  assert.equal(legacyShared.spawn.isolation, undefined);

  const overriddenTicket = store.createTicket(sharedProject, {
    title: 'forced shared tree', description: DISPATCH_DESCRIPTION, category: 'coding.normal', files: ['src/other.ts'],
  });
  const overridden = await callTool('dispatch', { allowUnscoped: true, project: sharedProject, ref: overriddenTicket.ref, sharedTree: false, full: true });
  assert.equal(overridden.spawn.isolation, undefined);
  assert.equal(store.getTicket(sharedProject, overriddenTicket.ref).dispatch.sharedTree, true);
  assert.match(store.getTicket(sharedProject, overriddenTicket.ref).dispatch.worktreeWarning, /explicit sharedTree:false was overridden/);
});


test('pulse exposes an immediate refused scope ruling', async () => {
  // Terge_VST, 2026-08-05: with no scope in pulse, the orchestrator shelled out to
  // `sidequest.js show <ref> --json` piped through python just to confirm a grant landed.
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-pulse-scope-'))).slug;
  const ticket = store.createTicket(project, {
    title: 'scope visible in pulse', files: ['lib/a.js'], complexity: 2,
    labels: ['direct-ok'], complexityWhy: 'the scope in force must be readable straight from pulse',
  });
  const by = 'pulse-scope-worker';
  assert.equal((await callTool('claim', { project, ref: ticket.ref, by, direct: true, reason: 'The pulse scope fixture requires a local direct claim.' })).ok, true);
  await callTool('scopeRequest', { project, ref: ticket.ref, by, files: ['lib/b.js'] });

  const ruled = await callTool('pulse', { project, ref: ticket.ref });
  assert.deepEqual(ruled.scope.files, ['lib/a.js', `.release/unreleased/${ticket.ref}.md`]);
  assert.equal(ruled.scope.request, undefined);
  assert.equal(ruled.scope.lastRuling.state, 'refused');
  assert.deepEqual(ruled.scope.lastRuling.refused, ['lib/b.js']);
});

test('pulse exposes a refused wave without making callers fetch full submission data', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-pulse-invalidated-wave-'))).slug;
  const ticket = store.createTicket(project, {
    title: 'invalidated wave pulse', files: ['lib/a.js'], complexity: 2,
    labels: ['direct-ok'], complexityWhy: 'the compact pulse must name a refused wave directly',
  });
  ticket.submission = {
    wave: {
      id: 'wave-pulse-fixture',
      state: 'invalidated',
      invalidation: { reason: 'surface_overlap' },
    },
  };
  db.putRow(db.openDb(SIDEQUEST_HOME), 'tickets', {
    id: ticket.id,
    project,
    ref: ticket.ref,
    status: ticket.status,
    archived: 0,
    ord: ticket.order,
    claim_by: null,
    data: ticket,
  });

  const pulse = await callTool('pulse', { project, ref: ticket.ref });

  assert.deepEqual(pulse.wave, { id: 'wave-pulse-fixture', state: 'invalidated', reason: 'surface_overlap' });
  assert.equal(pulse.submission, undefined);
});

test('write acks and pulse stay lean: no body echoes, no lifecycle noise by default', async () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-lean-shapes'), 'SQ lean shapes').slug;
  const ticket = store.createTicket(project, {
    title: 'lean wire shapes', complexity: 2, complexityWhy: 'exercise ack and pulse response shapes',
  });

  const body = 'A long durable handoff body that must never ride back in the ack.\n'.repeat(5);
  const ack = await callTool('comment', { project, ref: ticket.ref, body, by: 'shape-tester' });
  assert.equal(ack.ok, true);
  assert.ok(ack.commentId, 'ack carries the comment id');
  assert.ok(ack.at, 'ack carries the timestamp');
  assert.equal(ack.comment, undefined, 'ack must not echo the comment object');
  assert.ok(!JSON.stringify(ack).includes('durable handoff body'), 'ack must not echo the body text');


  store.prepareDispatch(project, ticket.ref, { allowUnscoped: true, sessionId: 'shape-session' });
  const pulse = await callTool('pulse', { project, ref: ticket.ref });
  assert.ok(pulse.dispatch, 'pulse still reports dispatch state');
  assert.ok(pulse.dispatch.state, 'slim dispatch keeps state');
  for (const noisy of ['sessionId', 'preparedAt', 'launchedAt', 'boundAt', 'claimedAt', 'terminalAt', 'terminalSource', 'agentId']) {
    assert.ok(!(noisy in pulse.dispatch), `slim pulse omits ${noisy}`);
  }
  const full = await callTool('pulse', { project, ref: ticket.ref, full: true });
  assert.ok('preparedAt' in full.dispatch, 'full:true restores the full dispatch lifecycle');
  const pulseDescriptor = mcp.toolDescriptors().find((descriptor: any) => descriptor.name === 'pulse');
  assert.equal('detail' in pulseDescriptor.inputSchema.properties, false);
});

test('MCP defaults cap category, dispatch, and pulse result payloads', async () => {
  const projectPath = path.join(os.tmpdir(), 'sq-mcp-payload-budget-');
  const project = store.ensureProject(projectPath).slug;
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'fixture.ts'), 'export {};\n');
  for (let index = 0; index < 18; index += 1) {
    const id = `payload-${index}`;
    store.setProjectCategory(project, id, 'ADD', {
      id,
      name: `Payload category ${index}`,
      description: `Classify work that changes the payload fixture ${index}. `.repeat(3),
      contract: `Full contract ${index}. `.repeat(10),
      route: { model: 'sonnet', effort: 'low' },
      fallback: null,
      enabled: true,
    });
  }

  const categories = await callToolRaw('category_list', { project });
  assert.ok(payloadBytes(categories.content[0].text) <= 70 * 1024, `category_list is ${payloadBytes(categories.content[0].text)} bytes`);
  const categoryPayload = JSON.parse(categories.content[0].text);
  assert.ok(categoryPayload.total >= 18);
  assert.equal(categoryPayload.returned, categoryPayload.categories.length);
  const localCategory = categoryPayload.categories.find((category: any) => category.id === 'payload-0');
  assert.equal(localCategory.localRow, undefined);
  assert.deepEqual(localCategory.route, { model: 'sonnet', effort: 'low' });
  const fullCategories = await callTool('category_list', { project, full: true });
  assert.equal(fullCategories.retrieval, undefined);

  const ticket = await callTool('add', { project, title: 'payload dispatch', description: DISPATCH_DESCRIPTION, category: 'payload-0' });
  const dispatched = await callToolRaw('dispatch', { allowUnscoped: true, project, ref: ticket.ref });
  const dispatchPayload = JSON.parse(dispatched.content[0].text);
  // SQ-320: this plain dispatch carries warnings (an unscoped write ticket), which the old
  // ceiling dropped without a marker. The 1220-byte cap now bounds the payload apart
  // from its warnings, which always ride.
  const { warnings: plainWarnings, ...plainBase } = dispatchPayload;
  assert.ok(Array.isArray(plainWarnings) && plainWarnings.length > 0, 'the plain dispatch keeps its warnings');
  assert.ok(payloadBytes(JSON.stringify(plainBase, null, 2)) <= 1220, `dispatch without warnings is ${payloadBytes(JSON.stringify(plainBase, null, 2))} bytes`);
  assert.deepStrictEqual(Object.keys(plainBase).sort(), ['effort', 'ref', 'runsLabel', 'spawn']);
  assert.equal(dispatchPayload.token, undefined);
  assert.equal(dispatchPayload.agent, undefined);
  assert.equal(dispatchPayload.guidance, undefined);

  const warningTicket = await callTool('add', { project, title: 'payload warning', description: DISPATCH_DESCRIPTION, category: 'debugging', files: ['fixture.ts'] });
  // SQ-320: warnings are exempt from the spawn budget. Before, a warning that pushed the
  // compact result past 1200 bytes was dropped with no marker, so the payload carrying it
  // is now allowed to exceed the cap, and the cap still bounds everything else.
  const warningDispatch = await callToolRaw('dispatch', { allowUnscoped: true, project, ref: warningTicket.ref });
  const warningPayload = JSON.parse(warningDispatch.content[0].text);
  assert.match(warningPayload.warnings.join('\n'), /has no verify command/);
  assert.equal(warningPayload.warningsOmitted, undefined);
  const { warnings: _carried, ...warningBase } = warningPayload;
  assert.ok(payloadBytes(JSON.stringify(warningBase, null, 2)) <= 1220, `warning dispatch without warnings is ${payloadBytes(JSON.stringify(warningBase, null, 2))} bytes`);

  const pulse = await callToolRaw('pulse', { project, ref: ticket.ref });
  assert.ok(payloadBytes(pulse.content[0].text) <= 1200, `pulse is ${payloadBytes(pulse.content[0].text)} bytes`);
  const pulsePayload = JSON.parse(pulse.content[0].text);
  assert.equal(pulsePayload.submission, undefined);
  assert.equal(pulsePayload.git, undefined);
  assert.equal(pulsePayload.dispatch.tokenPrefix, undefined);

  for (const [name, args, maxBytes] of [
    ['list', { project }, 70 * 1024],
    ['comments', { project, ref: ticket.ref }, 70 * 1024],
    ['changes', { project }, 1200],
    ['ready', { project }, 1200],
    ['integrate', { project, ref: 'SQ-999999', by: 'payload-tester' }, 1200],
  ] as const) {
    const result = await callToolRaw(name, args);
    assert.ok(payloadBytes(result.content[0].text) <= maxBytes, `${name} is ${payloadBytes(result.content[0].text)} bytes`);
  }
});

test('MCP integrate preflight routes malformed legacy submissions without a scope bypass', async () => {
  const repo = committedRepo('sq-mcp-legacy-preflight-');
  const project = store.ensureProject(repo).slug;
  const ticket = store.createTicket(project, {
    title: 'Malformed legacy submission',
    files: ['lib/legacy.js'],
    complexity: 3,
    complexityWhy: 'fixture for legacy integration preflight',
    labels: ['direct-ok'],
  });
  const legacy = store.getTicket(project, ticket.ref);
  const commit = gitAt(repo, ['rev-parse', 'HEAD']);
  const gitRef = `refs/sidequest/${ticket.ref}`;
  gitAt(repo, ['update-ref', gitRef, commit]);
  legacy.status = 'doing';
  legacy.executorVerifyKind = 'attestation';
  legacy.submission = {
    commit,
    gitRef,
    verify: 'attestation: legacy record',
    base: commit,
    upstream: 'main',
    upstreamCommit: commit,
    commits: [],
    changedPaths: [],
    noOp: true,
  };
  const dbModule = require('../lib/db.js');
  dbModule.putRow(dbModule.openDb(SIDEQUEST_HOME), 'tickets', {
    id: legacy.id, project, ref: legacy.ref, status: legacy.status,
    archived: 0, ord: legacy.order, claim_by: null, data: legacy,
  });

  const result = await callHandler('integrate', { project, ref: ticket.ref, by: 'payload-tester' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_scope_snapshot');
  assert.match(result.message, /rework/);
  assert.match(result.message, /supersede_submission/);
  const groomClose = mcp.toolDescriptors().find((descriptor: any) => descriptor.name === 'groomClose');
  assert.equal('overrideLegacyScope' in groomClose.inputSchema.properties, false);
});

test('integrate returns actionable post-merge verification failures', async () => {
  const project = store.ensureProject(committedRepo('sq-mcp-integrate-verify-failure-')).slug;
  const original = store.integrateSubmission;
  const verify = {
    kind: 'command',
    status: 'failed_suite',
    command: 'node --test failing-test.js',
    exitCode: 7,
    logPath: 'C:/tmp/integration-verify.log',
    outputTail: 'not ok 1 - integration verify failure',
  };
  store.integrateSubmission = () => ({
    ok: false,
    reason: 'verification_failed_suite_post_merge',
    ticket: { ref: 'SQ-verify-failure', status: 'doing' },
    verify,
  });
  try {
    const result = await callHandler('integrate', { project, ref: 'SQ-verify-failure', by: 'payload-tester' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'verification_failed_suite_post_merge');
    assert.deepEqual(result.verifyFailed, verify);
  } finally {
    store.integrateSubmission = original;
  }
});

export {};
