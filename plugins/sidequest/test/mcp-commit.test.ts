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
  PROJ,
  MCP_SESSION_ID,
  mcp,
  agentsync,
  store,
  db,
  DISPATCH_DESCRIPTION,
  seedCatalog,
  committedRepo,
  callTool,
  callToolRaw,
  callToolAsSession,
  callToolRawAsSession,
  gitAt,
  runCli,
  createGitWorktree,
  claimDispatchedTicket,
  stageLongOutOfScopeChangeSet,
  repoWithDirectories,
  isolatedDispatch,
} from './_mcp-fixture.js';

test('MCP commit truncates out-of-scope comments and retains successful commits on comment failures', async () => {
  const worktree = createGitWorktree();
  const project = store.ensureProject(worktree).slug;
  const ticket = store.createTicket(project, {
    title: 'MCP out-of-scope warning', files: ['lib/allowed.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'exercise bounded MCP commit warnings',
  });
  const by = 'mcp-bounded-warning-worker';
  assert.equal((await callTool('claim', { project, ref: ticket.ref, by, direct: true, reason: 'The MCP warning fixture requires a local direct claim.' })).ok, true);
  const foreignPaths = stageLongOutOfScopeChangeSet(worktree);
  const committed = await callTool('commit', { project, ref: ticket.ref, by, message: 'MCP bounded warning', worktree });
  const comment = store.getTicket(project, ticket.ref).comments.at(-1);
  assert.ok(committed.commit, 'commit succeeds with long unscoped path lists');
  assert.ok(comment.body.length <= 16000, `comment is ${comment.body.length} characters`);
  assert.match(comment.body, /^out-of-scope changes present: foreign\/000-/);
  assert.match(comment.body, /… \+\d+ more \(run git status in the worktree for the full list\)$/);
  assert.equal(gitAt(worktree, ['diff', '--cached', '--name-only']).split('\n').length, foreignPaths.length);

  const failedCommentWorktree = createGitWorktree();
  const failedCommentProject = store.ensureProject(failedCommentWorktree).slug;
  const failedCommentTicket = store.createTicket(failedCommentProject, {
    title: 'MCP comment failure warning', files: ['lib/allowed.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm comments cannot turn committed MCP work into a tool error',
  });
  const failedCommentBy = 'mcp-comment-failure-worker';
  assert.equal((await callTool('claim', { project: failedCommentProject, ref: failedCommentTicket.ref, by: failedCommentBy, direct: true, reason: 'The MCP comment failure fixture requires a local direct claim.' })).ok, true);
  fs.mkdirSync(path.join(failedCommentWorktree, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(failedCommentWorktree, 'lib', 'allowed.js'), 'allowed\n');
  fs.writeFileSync(path.join(failedCommentWorktree, 'foreign.js'), 'foreign\n');
  gitAt(failedCommentWorktree, ['add', '.']);
  const addComment = store.addComment;
  store.addComment = () => ({ ok: false, reason: 'too_long' });
  try {
    const warning = await callTool('commit', {
      project: failedCommentProject, ref: failedCommentTicket.ref, by: failedCommentBy,
      message: 'MCP comment failure warning', worktree: failedCommentWorktree,
    });
    assert.ok(warning.commit, 'the commit acknowledgement stays successful');
    assert.deepEqual(warning.warnings, ["out-of-scope paths weren't recorded: too_long"]);
  } finally {
    store.addComment = addComment;
  }
});

test('CLI commit truncates out-of-scope comments', async () => {
  const worktree = createGitWorktree();
  const project = store.ensureProject(worktree).slug;
  const ticket = store.createTicket(project, {
    title: 'CLI out-of-scope warning', files: ['lib/allowed.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'exercise bounded CLI commit warnings',
  });
  const by = 'cli-bounded-warning-worker';
  assert.equal((await callTool('claim', { project, ref: ticket.ref, by, direct: true, reason: 'The CLI warning fixture requires a local direct claim.' })).ok, true);
  stageLongOutOfScopeChangeSet(worktree);
  const committed = runCli(['commit', ticket.ref, '--project', project, '--by', by, '--message', 'CLI bounded warning', '--json'], worktree);
  const comment = store.getTicket(project, ticket.ref).comments.at(-1);
  assert.ok(committed.commit, 'CLI commit succeeds with long unscoped path lists');
  assert.equal(committed.warnings, undefined, 'a recorded warning does not add a failure warning');
  assert.ok(comment.body.length <= 16000, `comment is ${comment.body.length} characters`);
  assert.match(comment.body, /^out-of-scope changes present: foreign\/000-/);
  assert.match(comment.body, /… \+\d+ more \(run git status in the worktree for the full list\)$/);
});

test('MCP submit refuses out-of-scope committed ranges', async () => {
  const worktree = createGitWorktree();
  const project = store.ensureProject(worktree).slug;
  const ticket = store.createTicket(project, {
    title: 'MCP range scope refusal', files: ['lib/allowed.js'], complexity: 3,
    labels: ['direct-ok'],
    complexityWhy: 'confirm MCP submit refuses a committed range outside the declared scope',
  });
  const by = 'mcp-range-worker';
  assert.equal((await callTool('claim', { project, ref: ticket.ref, by, direct: true, reason: 'The MCP worktree fixture requires a local direct claim.' })).ok, true);
  fs.writeFileSync(path.join(worktree, 'foreign.js'), 'foreign\n');
  gitAt(worktree, ['add', 'foreign.js']);
  gitAt(worktree, ['commit', '-m', 'foreign work']);
  const commit = gitAt(worktree, ['rev-parse', 'HEAD']);
  gitAt(worktree, ['update-ref', `refs/sidequest/${ticket.ref}`, commit]);
  const refused = await callTool('submit', { project, ref: ticket.ref, by, commit, worktree, body: 'MCP scope refusal evidence' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'outside_scope');
  assert.match(refused.message, new RegExp(`sidequest update ${ticket.ref} --files`));
  assert.ok(store.getTicket(project, ticket.ref).claim, 'scope refusal keeps the claim');
});

test('MCP scopeRequest and submit agree on declared descendant globs', async () => {
  const worktree = createGitWorktree();
  const project = store.ensureProject(worktree).slug;
  const ticket = await callTool('add', {
    project,
    title: 'glob scope agreement',
    files: ['src/**'],
    unclassified: true,
  });
  const by = 'mcp-glob-scope-worker';
  assert.deepEqual(store.getTicket(project, ticket.ref).files, ['src/**'], 'add preserves a declared descendant glob');
  assert.equal((await callTool('claim', {
    project,
    ref: ticket.ref,
    by,
    direct: true,
    reason: 'The public MCP scope agreement fixture requires a local direct claim.',
  })).ok, true);

  fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'src', 'covered.js'), 'covered\n');
  const requested = await callTool('scopeRequest', {
    project,
    ref: ticket.ref,
    by,
    files: ['src/covered.js'],
  });
  assert.equal(requested.state, 'granted');
  assert.deepEqual(requested.covered, ['src/covered.js']);
  assert.deepEqual(requested.resolution.effectiveScope, ['src/**']);

  const committed = await callTool('commit', {
    project,
    ref: ticket.ref,
    by,
    message: 'MCP declared descendant glob',
    worktree,
  });
  assert.ok(committed.commit, 'commit accepts the path scopeRequest covered');
  gitAt(worktree, ['update-ref', `refs/sidequest/${ticket.ref}`, committed.commit]);
  const submitted = await callTool('submit', {
    project,
    ref: ticket.ref,
    by,
    commit: committed.commit,
    worktree,
    body: 'MCP declared descendant glob evidence.',
  });
  assert.equal(submitted.ok, true, submitted.message || submitted.reason);
  assert.deepEqual(store.getTicket(project, ticket.ref).submission.changedPaths, ['src/covered.js']);
});

test('MCP commit honors a granted scope ruling without copying it into ticket files', async () => {
  const worktree = createGitWorktree();
  const project = store.ensureProject(worktree).slug;
  const ticket = store.createTicket(project, {
    title: 'granted commit scope', files: ['src/declared.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'the commit gate must admit board-granted paths without mutating declared files',
  });
  const by = 'mcp-granted-commit-worker';
  assert.equal((await callTool('claim', {
    project, ref: ticket.ref, by, direct: true, reason: 'The granted scope fixture requires a local direct claim.',
  })).ok, true);
  fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'src', 'granted.js'), 'granted\n');
  const granted = store.getTicket(project, ticket.ref);
  granted.scopeResolution = {
    state: 'granted', requested: ['src/granted.js'], granted: ['src/granted.js'], refused: [], at: new Date().toISOString(),
  };
  db.putRow(db.openDb(SIDEQUEST_HOME), 'tickets', {
    id: granted.id, project, ref: granted.ref, status: granted.status,
    archived: granted.archived ? 1 : 0, ord: granted.order, claim_by: granted.claim.by, data: granted,
  });

  const committed = await callTool('commit', {
    project, ref: ticket.ref, by, message: 'MCP granted commit scope', worktree,
  });
  assert.ok(committed.commit, 'commit admits a path granted in board state');
});


// A flat repo is the common case outside this marketplace, and it is where the
// policy kept failing to fire: the ticket declares source, needs to register a
// new suite in tests/, and the run stops on a directory nobody thought to name.

test('MCP scopeRequest derives build registration from a new in-scope source file', async () => {
  const root = repoWithDirectories('sq-mcp-build-registration-', ['src/plugin']);
  fs.writeFileSync(path.join(root, 'CMakeLists.txt'), 'add_library(plugin)\n');
  const project = store.ensureProject(root).slug;
  const ticket = store.createTicket(project, {
    title: 'Register graph parameters', files: ['src/plugin/graph_parameters.cpp'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'the new source needs the governing CMake registration to build',
  });
  const by = 'mcp-build-registration-worker';
  assert.equal((await callTool('claim', { project, ref: ticket.ref, by, direct: true, reason: 'The scope fixture requires a local direct claim.' })).ok, true);

  const approved = await callTool('scopeRequest', { project, ref: ticket.ref, by, files: ['CMakeLists.txt'] });
  assert.equal(approved.autoApproved, true);
  assert.deepEqual(approved.approved, ['CMakeLists.txt']);
  assert.deepEqual(store.getTicket(project, ticket.ref).files, ['src/plugin/graph_parameters.cpp', 'CMakeLists.txt']);
  assert.match(store.getTicket(project, ticket.ref).comments.at(-1).body, /build-registration scope derived/);
});

test('MCP scopeRequest derives barrel registration without widening past the governing file', async () => {
  const root = repoWithDirectories('sq-mcp-barrel-registration-', ['src/models']);
  fs.writeFileSync(path.join(root, 'src/models/index.ts'), 'export {};\n');
  const project = store.ensureProject(root).slug;
  const ticket = store.createTicket(project, {
    title: 'Export widget model', files: ['src/models/widget.ts'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'the new model requires its local barrel export',
  });
  const by = 'mcp-barrel-registration-worker';
  assert.equal((await callTool('claim', { project, ref: ticket.ref, by, direct: true, reason: 'The scope fixture requires a local direct claim.' })).ok, true);

  const approved = await callTool('scopeRequest', { project, ref: ticket.ref, by, files: ['src/models/index.ts'] });
  assert.deepEqual(approved.approved, ['src/models/index.ts']);
  assert.deepEqual(store.getTicket(project, ticket.ref).files, ['src/models/widget.ts', 'src/models/index.ts']);
});




test('MCP scopeRequest reports the implicit release fragment as covered for its dispatched ticket', async () => {
  const fixture = isolatedDispatch('sq-mcp-release-scope-', 'release-scope-worker', ['plugins/sidequest/src/lib/store/tickets.ts']);
  const fragment = `.release/unreleased/${fixture.ref}.md`;

  const requested = await callTool('scopeRequest', {
    project: fixture.project,
    ref: fixture.ref,
    by: fixture.by,
    files: [fragment],
  });

  assert.equal(requested.state, 'granted');
  assert.deepEqual(requested.covered, [fragment]);
  assert.deepEqual(requested.refused, []);
  assert.deepEqual(store.getTicket(fixture.project, fixture.ref).dispatch.declaredFiles, [
    'plugins/sidequest/src/lib/store/tickets.ts', fragment,
  ]);
});

test('MCP scopeRequest auto-approves a concrete path inside the declared plugin without ending the attempt', async () => {
  const fixture = isolatedDispatch('sq-mcp-package-scope-', 'a1384package', ['plugins/sidequest/src/lib/store/tickets.ts']);
  const requestedFile = 'plugins/sidequest/src/lib/store/dispatch.ts';

  const approved = await callTool('scopeRequest', {
    project: fixture.project,
    ref: fixture.ref,
    by: fixture.by,
    files: [requestedFile],
  });

  assert.equal(approved.autoApproved, true);
  assert.deepEqual(approved.approved, [requestedFile]);
  assert.equal(approved.scopeRequest, null);
  const ticket = store.getTicket(fixture.project, fixture.ref);
  assert.deepEqual(ticket.files, ['plugins/sidequest/src/lib/store/tickets.ts', requestedFile]);
  assert.equal(ticket.scopeResolution.state, 'granted');
  assert.deepEqual(ticket.scopeResolution.requested, [requestedFile]);
  assert.deepEqual(ticket.scopeResolution.granted, [requestedFile]);
  assert.match(ticket.comments.at(-1).body, /matching package surface derived from the ticket’s declared files/);
  assert.equal(ticket.dispatch.outcome, 'claimed');
  assert.equal(ticket.dispatch.terminalAt, null);
  assert.equal(ticket.dispatch.scopeRequest, undefined);
  assert.equal(ticket.dispatch.attempts, undefined);
});


test('MCP scopeRequest names declared-files scope for refused tracked source', async () => {
  const fixture = isolatedDispatch('sq-mcp-evidence-scope-', 'evidence-scope-worker', ['plugins/sidequest/src/lib/store/tickets.ts']);
  const requestedFile = 'plugins/sidequest/.claude/skills/verify/SKILL.md';

  const result = await callTool('scopeRequest', {
    project: fixture.project,
    ref: fixture.ref,
    by: fixture.by,
    files: [requestedFile],
  });

  assert.equal(result.autoApproved, false);
  assert.equal(result.state, 'refused');
  assert.deepEqual(result.refused, [requestedFile]);
  const ticket = store.getTicket(fixture.project, fixture.ref);
  assert.equal(ticket.files.includes(requestedFile), false);
  assert.match(ticket.comments.at(-1).body, /The refused path is outside this ticket's declared files/);
  assert.doesNotMatch(ticket.comments.at(-1).body, /Verification evidence belongs in/);
});

test('MCP submit keeps board-owned evidence out of delivered paths', async () => {
  const fixture = isolatedDispatch('sq-mcp-evidence-submit-', 'evidence-submit-worker', ['src']);
  const ticket = store.getTicket(fixture.project, fixture.ref);
  const evidenceDirectory = ticket.dispatch.evidenceDirectory;
  assert.equal(path.relative(fixture.worktree, evidenceDirectory).startsWith('..'), true);
  fs.writeFileSync(path.join(evidenceDirectory, 'browser.html'), '<main>verification evidence</main>\n');
  fs.mkdirSync(path.join(fixture.worktree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(fixture.worktree, 'src', 'delivered.js'), 'export const delivered = true;\n');
  gitAt(fixture.worktree, ['config', 'user.name', 'Sidequest Test']);
  gitAt(fixture.worktree, ['config', 'user.email', 'sidequest-test@example.invalid']);

  const committed = await callTool('commit', {
    project: fixture.project,
    ref: fixture.ref,
    by: fixture.by,
    message: 'Keep verification evidence outside the candidate',
    worktree: fixture.worktree,
  });
  assert.ok(committed.commit, committed.message || committed.reason);
  const gitRef = `refs/sidequest/${fixture.ref}`;
  gitAt(fixture.worktree, ['update-ref', gitRef, committed.commit]);
  const submitted = await callTool('submit', {
    project: fixture.project,
    ref: fixture.ref,
    by: fixture.by,
    commit: committed.commit,
    gitRef,
    worktree: fixture.worktree,
    verify: 'node --test test/evidence.test.js',
    body: `Verification evidence: ${evidenceDirectory}`,
  });
  assert.equal(submitted.ok, true, submitted.message || submitted.reason);
  assert.deepEqual(store.getTicket(fixture.project, fixture.ref).submission.changedPaths, ['src/delivered.js']);

  const delivered = store.integrateSubmission(fixture.project, fixture.ref, {
    mode: 'merge',
    target: store.integrationTarget(fixture.project),
    skipVerify: true,
    verificationWaiver: {
      authority: 'fixture release manager',
      reason: 'this test covers evidence-path delivery only',
      affectedGate: 'node --test test/evidence.test.js',
      scope: fixture.ref,
    },
  });
  assert.equal(delivered.ok, true, delivered.message || delivered.reason);
  assert.deepEqual(store.getTicket(fixture.project, fixture.ref).submission.integration.deliveredFiles, ['src/delivered.js']);
});

test('MCP scopeRequest keeps declared bundled hook output one-way: the source needs approval, the source grants its output', async () => {
  const worktree = createGitWorktree();
  const source = 'plugins/sidequest/src/hooks/subagent-stop.ts';
  const output = 'plugins/sidequest/hooks/subagent-stop.js';
  for (const file of [source, output, 'plugins/sidequest/scripts/build.mjs']) {
    fs.mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
  }
  fs.writeFileSync(path.join(worktree, source), 'export const stop = true;\n');
  fs.writeFileSync(path.join(worktree, output), 'module.exports = { stop: true };\n');
  fs.writeFileSync(path.join(worktree, 'plugins', 'sidequest', 'scripts', 'build.mjs'), [
    'export const bundledBuildOutputs = [{',
    "  sourceDirectory: 'src/hooks',",
    "  outputDirectory: 'hooks',",
    "  sourceExtension: '.ts',",
    "  outputExtension: '.js',",
    '}];',
  ].join('\n'));
  fs.writeFileSync(path.join(worktree, 'plugins', 'sidequest', 'package.json'), JSON.stringify({ scripts: { build: 'node scripts/build.mjs' } }));
  gitAt(worktree, ['add', '.']);
  gitAt(worktree, ['commit', '-m', 'generated scope fixture']);
  const project = store.ensureProject(worktree).slug;
  const outputOnly = store.createTicket(project, {
    title: 'Generated hook output scope', files: ['plugins/sidequest/hooks'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'editing generated output without its source is a mistake worth an approval round trip',
  });
  const by = 'mcp-generated-output-scope-worker';
  assert.equal((await callTool('claim', { project, ref: outputOnly.ref, by, direct: true, reason: 'The generated scope fixture requires a local direct claim.' })).ok, true);

  const sourceRequest = await callTool('scopeRequest', { project, ref: outputOnly.ref, by, files: [source] });
  assert.deepEqual(sourceRequest.covered, [], 'declared output must not admit its source without approval');
  assert.equal(sourceRequest.state, 'refused');
  assert.deepEqual(sourceRequest.refused, [source]);

  const sourceDeclared = store.createTicket(project, {
    title: 'Declared source grants output', files: [source], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'a declared source implies its compiled output without a round trip',
  });
  const sourceBy = 'mcp-generated-source-scope-worker';
  assert.equal((await callTool('claim', { project, ref: sourceDeclared.ref, by: sourceBy, direct: true, reason: 'The generated scope fixture requires a local direct claim.' })).ok, true);
  const outputCovered = await callTool('scopeRequest', { project, ref: sourceDeclared.ref, by: sourceBy, files: [output] });
  assert.deepEqual(outputCovered.covered, [output], 'a declared source grants its tracked compiled output');
  assert.equal(outputCovered.state, 'granted');
});








test('shared-tree live dispatches grow their scope without shedding the submission binding', async () => {
  const updatedWorktree = createGitWorktree();
  const updatedProject = store.ensureProject(updatedWorktree).slug;
  const updatedTicket = store.createTicket(updatedProject, {
    title: 'shared dispatch control-plane scope refresh', files: ['lib/original.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'a live shared dispatch must admit its control-plane-approved scope',
  });
  const updatedBy = 'shared-scope-update-worker';
  claimDispatchedTicket(updatedProject, updatedTicket, updatedBy, true);

  await callToolAsSession(MCP_SESSION_ID, 'update', {
    project: updatedProject, ref: updatedTicket.ref, by: 'control-plane',
    files: ['lib/original.js', 'lib/updated.js'],
  });
  const updatedFragment = `.release/unreleased/${updatedTicket.ref}.md`;
  let updated = store.getTicket(updatedProject, updatedTicket.ref);
  assert.deepEqual(updated.dispatch.declaredFiles, ['lib/original.js', updatedFragment, 'lib/updated.js']);
  fs.mkdirSync(path.join(updatedWorktree, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(updatedWorktree, 'lib', 'updated.js'), 'updated\n');
  gitAt(updatedWorktree, ['add', 'lib/updated.js']);
  const updatedCommit = await callTool('commit', {
    project: updatedProject, ref: updatedTicket.ref, by: updatedBy,
    message: 'commit control-plane-approved shared scope', worktree: updatedWorktree,
  });
  assert.ok(updatedCommit.commit, 'the normal commit gate admits a live shared dispatch scope update');

  await callToolAsSession(MCP_SESSION_ID, 'update', {
    project: updatedProject, ref: updatedTicket.ref, by: 'control-plane', files: ['lib/original.js'],
  });
  updated = store.getTicket(updatedProject, updatedTicket.ref);
  assert.deepEqual(updated.dispatch.declaredFiles, ['lib/original.js', updatedFragment, 'lib/updated.js'], 'shared-tree scope updates retain the submission binding when ticket scope sheds a path');

  const grantedWorktree = createGitWorktree();
  const grantedProject = store.ensureProject(grantedWorktree).slug;
  assert.equal(store.setBoardConfig(grantedProject, { autoApproveScope: ['lib/*.js'] }).ok, true);
  const grantedTicket = store.createTicket(grantedProject, {
    title: 'shared dispatch granted scope refresh', files: ['lib/original.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'a live shared dispatch must admit its granted scope request',
  });
  const grantedBy = 'shared-scope-request-worker';
  claimDispatchedTicket(grantedProject, grantedTicket, grantedBy, true);

  const granted = await callTool('scopeRequest', {
    project: grantedProject, ref: grantedTicket.ref, by: grantedBy, files: ['lib/granted.js'],
  });
  assert.equal(granted.autoApproved, true);
  const grantedTicketAfterRequest = store.getTicket(grantedProject, grantedTicket.ref);
  assert.deepEqual(grantedTicketAfterRequest.dispatch.declaredFiles, ['lib/original.js', `.release/unreleased/${grantedTicket.ref}.md`, 'lib/granted.js']);
  fs.mkdirSync(path.join(grantedWorktree, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(grantedWorktree, 'lib', 'granted.js'), 'granted\n');
  gitAt(grantedWorktree, ['add', 'lib/granted.js']);
  const grantedCommit = await callTool('commit', {
    project: grantedProject, ref: grantedTicket.ref, by: grantedBy,
    message: 'commit granted shared scope', worktree: grantedWorktree,
  });
  assert.ok(grantedCommit.commit, 'the normal commit gate admits a granted shared dispatch scope');
});

test('MCP update refuses claim-holder live scope changes and admits a control-plane approval', async () => {
  const project = store.ensureProject(committedRepo('sq-mcp-scope-shed-')).slug;
  const ticket = store.createTicket(project, {
    title: 'MCP active claim scope shed', files: ['lib/allowed.js', 'screenshots'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'claimed executors must request scope approval before changing the declared paths',
  });
  const by = 'mcp-active-scope-shed-worker';
  const prepared = store.prepareDispatch(project, ticket.ref, { allowUnscoped: true, sharedTree: false, sessionId: MCP_SESSION_ID });
  assert.equal(store.claimTicket(project, ticket.ref, by, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId: MCP_SESSION_ID,
  }).ok, true);

  const refused = await callToolRawAsSession('mcp-scope-executor-session', 'update', { project, ref: ticket.ref, by, files: ['lib/allowed.js'] });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /scopeRequest/i);
  assert.deepEqual(store.getTicket(project, ticket.ref).files, ['lib/allowed.js', 'screenshots']);

  await callToolAsSession(MCP_SESSION_ID, 'update', {
    project, ref: ticket.ref, by: 'mcp-scope-control-plane', files: ['lib/allowed.js'],
  });
  const narrowed = store.getTicket(project, ticket.ref);
  assert.deepEqual(narrowed.files, ['lib/allowed.js']);
  assert.deepEqual(narrowed.dispatch.declaredFiles, ['lib/allowed.js', `.release/unreleased/${ticket.ref}.md`]);
});

test('MCP update handler grants live scope changes without deriving authority from session identity', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-scope-update-'))).slug;
  const ticket = store.createTicket(project, {
    title: 'MCP active claim scope update', files: ['lib/allowed.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'the PreToolUse hook keeps subagents away from this main-thread handler grant',
  });
  const by = 'mcp-active-scope-worker';
  claimDispatchedTicket(project, ticket, by, false);

  await callToolAsSession('mcp-unrelated-control-session', 'update', {
    project, ref: ticket.ref, files: ['lib/allowed.js', 'foreign/new.js'],
  });
  assert.deepEqual(store.getTicket(project, ticket.ref).files, ['lib/allowed.js', 'foreign/new.js']);

  const holderRefusal = await callToolRaw('update', { project, ref: ticket.ref, by, files: ['lib/allowed.js'] });
  assert.equal(holderRefusal.isError, true);
  assert.match(holderRefusal.content[0].text, /scopeRequest/i);
  assert.deepEqual(store.getTicket(project, ticket.ref).files, ['lib/allowed.js', 'foreign/new.js']);

  await callToolAsSession(MCP_SESSION_ID, 'update', {
    project, ref: ticket.ref, by: 'mcp-scope-control-plane', files: ['lib/allowed.js'],
  });
  assert.deepEqual(store.getTicket(project, ticket.ref).files, ['lib/allowed.js']);

  const unclaimed = store.createTicket(project, {
    title: 'MCP unclaimed scope update', files: ['lib/allowed.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'unclaimed tickets remain editable by the control plane',
  });
  await callTool('update', { project, ref: unclaimed.ref, files: ['lib/allowed.js', 'foreign/new.js'] });
  assert.deepEqual(store.getTicket(project, unclaimed.ref).files, ['lib/allowed.js', 'foreign/new.js']);
});

test('MCP update schema exposes control-plane scope approval', () => {
  const update = mcp.toolDescriptors().find((descriptor: any) => descriptor.name === 'update');
  assert.ok(update);
  assert.equal(update.inputSchema.properties.by.type, 'string');
});

test('sweepClaims releases stale claims through MCP', async () => {
  const created = await callTool('add', { title: 'MCP stale sweep', unclassified: true });
  const slug = created.project;
  assert.equal(store.claimTicket(slug, created.ref, 'mcp-stale').ok, true);
  const stale = store.getTicket(slug, created.ref);
  stale.claim.at = new Date(Date.now() - store.claimIdleMs() - 1).toISOString();
  const dbModule = require('../lib/db.js');
  dbModule.putRow(dbModule.openDb(SIDEQUEST_HOME), 'tickets', {
    id: stale.id, project: slug, ref: stale.ref, status: stale.status,
    archived: stale.archived ? 1 : 0, ord: stale.order, claim_by: stale.claim.by, data: stale,
  });
  const swept = await callTool('sweepClaims', { project: slug });
  assert.equal(swept.released.length, 1);
  assert.equal(store.getTicket(slug, created.ref).claim, null);
});


test('MCP board archive tools match the CLI archive-board lifecycle', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-board-archive-'));
  const project = store.ensureProject(projectPath).slug;
  const cliArchived = runCli(['archive-board', project, '--json']);
  assert.equal(cliArchived.ok, true);
  assert.ok(store.findProject(project).meta.archivedAt);

  const restored = await callTool('unarchive_board', { project });
  assert.equal(restored.ok, true);
  assert.equal(store.findProject(project).meta.archivedAt, undefined);

  const archived = await callTool('archive_board', { project });
  assert.equal(archived.ok, true);
  assert.ok(store.findProject(project).meta.archivedAt);

  const cliRestored = runCli(['unarchive-board', project, '--json']);
  assert.equal(cliRestored.ok, true);
  assert.equal(store.findProject(project).meta.archivedAt, undefined);
});
test('dispatch returns a stable executor, one spawn prompt, and a token', async () => {
  const d = mcp.toolDescriptors().find((t: any) => t.name === 'dispatch');
  assert.ok(d);
  assert.deepStrictEqual(Object.keys(d.inputSchema.properties).sort(), ['allowRepeatFailure', 'allowUnscoped', 'claimHolder', 'full', 'integrationBranch', 'priorityOverride', 'project', 'recoveryEvidence', 'recoveryTaskId', 'ref', 'sharedTree', 'worktree']);
  assert.deepStrictEqual(d.inputSchema.required, ['ref']);

  seedCatalog([{ slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra', label: 'Terra' }]);
  store.setCategory({ id: 'dispatch-codex', name: 'Dispatch Codex', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
  const slug = store.ensureProject(PROJ).slug;

  const addedInstant = await callTool('add', { title: 'instant dispatch', description: DISPATCH_DESCRIPTION, category: 'dispatch-codex' });
  const instant = await callTool('dispatch', { allowUnscoped: true, ref: addedInstant.ref, session: 'mcp-dispatch-session', full: true });
  assert.equal(instant.mode, 'instant');
  assert.deepEqual(instant.exec, {
    agent: 'sidequest-exec-codex-gpt-5-6-terra-high', model: null, backend: 'codex',
    runsModel: 'codex-gpt-5-6-terra', apiModel: 'claude-gpt-5.6-terra',
    runsLabel: 'Terra', dispatch: 'native-agent',
  });
  assert.equal(instant.agent, 'sidequest-exec-codex-gpt-5-6-terra-high');
  assert.equal(instant.spawn.description, 'Terra, high · instant dispatch');
  assert.equal(instant.spawn.name, `${addedInstant.ref.toLowerCase()}-instant-dispatch-terra-high`);
  assert.equal(instant.spawn.model, undefined);
  assert.equal(instant.spawn.subagent_type, instant.agent);
  assert.equal(instant.tokenPrefix, instant.token.slice(0, 12));
  assert.equal(Object.hasOwn(instant, 'briefing'), false);
  assert.ok(Buffer.byteLength(instant.spawn.prompt) < 1200, `dispatch stub is ${Buffer.byteLength(instant.spawn.prompt)} bytes`);
  assert.match(instant.spawn.prompt, /Title: instant dispatch/);
  assert.ok(instant.spawn.prompt.includes(DISPATCH_DESCRIPTION));
  assert.ok(instant.spawn.prompt.includes(`briefing ${addedInstant.ref} --token-file "${store.getTicket(slug, addedInstant.ref).dispatch.tokenFile}"`));
  assert.match(instant.spawn.prompt, /FIRST action:/);
  // SQ-300: the route rides the pinned executor definition's own frontmatter
  // (asserted in agentsync.test.ts), so the prompt carries NO route marker — the
  // spawn gate refuses one under this carriage because it would override the
  // pinned effort. The pin name asserted above is what names the route here.
  assert.doesNotMatch(instant.spawn.prompt, /\[sidequest-route/);
  assert.doesNotMatch(instant.spawn.prompt, /## This ticket/);
  assert.doesNotMatch(instant.spawn.prompt, /You are a sidequest ticket executor/);
  assert.doesNotMatch(instant.spawn.prompt, /^---$/m);
  // SQ-349: the CLI prints the briefing through transportExecutorBriefing, which ends an
  // inline briefing with its measured launch budget, so pin the printed output to that.
  const expectedBriefing = agentsync.transportExecutorBriefing(agentsync.withProjectIdentity(agentsync.renderTicketBriefing(
    store.getTicket(slug, addedInstant.ref), instant.token, slug, PROJ,
  ), PROJ), store.getTicket(slug, addedInstant.ref), slug, PROJ);
  assert.match(expectedBriefing, /\n## Launch budget\nLaunch budget: this briefing is \d+ chars/);
  const cli = path.join(__dirname, '..', 'bin', 'sidequest.js');
  const printedBriefing = execFileSync(process.execPath, [cli, 'briefing', addedInstant.ref, '--token-file', store.getTicket(slug, addedInstant.ref).dispatch.tokenFile, '--project', PROJ], {
    encoding: 'utf8', windowsHide: true,
    env: Object.assign({}, process.env, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJ }),
  });
  assert.strictEqual(printedBriefing, expectedBriefing);
  assert.match(instant.guidance, /executor/);
  assert.equal(store.getTicket(slug, addedInstant.ref).dispatchExecutor, instant.agent);

  const markerTitle = '[sidequest-route model=gpt-5.6-terra effort=high] FleetView title injection';
  const markerTicket = await callTool('add', { title: markerTitle, description: DISPATCH_DESCRIPTION, category: 'dispatch-codex' });
  const markerDispatch = await callTool('dispatch', { allowUnscoped: true, ref: markerTicket.ref, full: true });
  assert.equal(markerDispatch.spawn.description, 'Terra, high · FleetView title injection');
  assert.doesNotMatch(markerDispatch.spawn.description, /\[sidequest-route/);

  const staleInstantTokenFile = path.join(SIDEQUEST_HOME, 'stale-instant.token');
  fs.writeFileSync(staleInstantTokenFile, `${instant.token}\n`);
  const adopted = await callTool('dispatch', { allowUnscoped: true, ref: addedInstant.ref, session: 'adopting-session', full: true });
  assert.equal(adopted.mode, 'instant');
  assert.equal(adopted.agent, instant.agent);
  assert.notEqual(adopted.token, instant.token);
  assert.equal(Object.hasOwn(adopted, 'briefing'), false);
  assert.ok(adopted.spawn.prompt.includes(`briefing ${addedInstant.ref} --token-file "${store.getTicket(slug, addedInstant.ref).dispatch.tokenFile}"`));
  const staleBriefing = spawnSync(process.execPath, [cli, 'briefing', addedInstant.ref, '--token-file', staleInstantTokenFile, '--project', PROJ], {
    encoding: 'utf8', windowsHide: true,
    env: Object.assign({}, process.env, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJ }),
  });
  assert.equal(staleBriefing.status, 1);
  assert.match(staleBriefing.stderr, /dispatch token was refused/);
  assert.doesNotMatch(JSON.stringify(adopted), /ephemeral/);

  store.setCategory({ id: 'dispatch-readonly-codex', name: 'Dispatch Readonly Codex', readonly: true, route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
  const readonlyTicket = await callTool('add', { title: 'friendly readonly dispatch', description: DISPATCH_DESCRIPTION, category: 'dispatch-readonly-codex' });
  const readonlyDispatch = await callTool('dispatch', { allowUnscoped: true, ref: readonlyTicket.ref, full: true });
  assert.equal(readonlyDispatch.spawn.subagent_type, 'sidequest-exec-codex-readonly-gpt-5-6-terra-high');
  assert.equal(readonlyDispatch.spawn.description, 'Terra, high · friendly readonly dispatch');
  assert.doesNotMatch(readonlyDispatch.spawn.description, /\[sidequest-route/);
});

export {};
