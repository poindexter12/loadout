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
  SIDEQUEST_HOME,
  store,
  worktrees,
  worktreeLease,
  agentsync,
  SESSION,
  SUBAGENT_START,
  POST_COMPACT,
  WORKTREE_CREATE,
  runHookOutput,
  runHook,
  gitFixture,
  replacementMarkerPath,
  SESSION_START_READERS,
  sessionStartReaderFixture,
  assertAllShortNotes,
  assertAllFullContexts,
  linkedWorktreeFixturePath,
  fixtureState,
  type SessionStartReader,
} from './_hooks-fixture.js';

// SQ-197: a replacement compaction (host kept history verbatim; PostCompact saw
// compact_summary === '') leaves the prior SessionStart re-grounding sitting in history. The
// PostCompact->SessionStart(compact) pair should collapse to a short note instead of duplicating
// the full board-context block again.
test('a replacement compaction collapses SessionStart(compact) to a short note', () => {
  const sessionId = `sq197-replacement-${++fixtureState.sqSeq}`;
  const transcript = path.join(SIDEQUEST_HOME, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, '[]');
  runHookOutput(POST_COMPACT, { session_id: sessionId, transcript_path: transcript, compact_summary: '' });

  const note = runHook(SESSION, { session_id: sessionId, source: 'compact' });
  assert.match(note, /history retained across a replacement compaction/);
  assert.doesNotMatch(note, /ROLE: ORCHESTRATOR/);
  assert.ok(Buffer.byteLength(note, 'utf8') <= 200, `expected <=200 bytes, got ${Buffer.byteLength(note, 'utf8')}`);

  // SQ-200: reading is a peek, never a delete. codebase-mapper and live-rules read the same marker
  // in parallel with this hook, so the marker survives every read inside the age bound.
  assert.equal(fs.existsSync(replacementMarkerPath(sessionId)), true, 'SessionStart must not delete the marker');
  const again = runHook(SESSION, { session_id: sessionId, source: 'compact' });
  assert.match(again, /history retained across a replacement compaction/);
});

test('a normal summarized compaction keeps full SessionStart(compact) re-grounding', () => {
  const sessionId = `sq197-summarized-${++fixtureState.sqSeq}`;
  const transcript = path.join(SIDEQUEST_HOME, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, '[]');
  runHookOutput(POST_COMPACT, { session_id: sessionId, transcript_path: transcript, compact_summary: 'a real summary' });

  const full = runHook(SESSION, { session_id: sessionId, source: 'compact' });
  assert.match(full, /ROLE: ORCHESTRATOR/);
  assert.doesNotMatch(full, /history retained across a replacement compaction/);
});

// SQ-200: Claude Code runs one event's hooks in parallel, so the three SessionStart(compact)
// readers reach the marker in no fixed order. Before SQ-200 sidequest unlinked it on read, so
// whenever sidequest ran first codebase-mapper and live-rules re-injected in full.
test('all three SessionStart(compact) readers emit the short note from one marker in either order', () => {
  const fixture = sessionStartReaderFixture();
  const orders: Array<readonly SessionStartReader[]> = [
    ['sidequest', 'codebase-mapper', 'live-rules'],
    ['live-rules', 'codebase-mapper', 'sidequest'],
  ];
  for (const order of orders) {
    const sessionId = `sq200-order-${++fixtureState.sqSeq}`;
    const transcript = path.join(SIDEQUEST_HOME, `${sessionId}.jsonl`);
    fs.writeFileSync(transcript, '[]');
    runHookOutput(POST_COMPACT, { session_id: sessionId, transcript_path: transcript, compact_summary: '' });
    const contexts = fixture.runInOrder(sessionId, order);
    assertAllShortNotes(contexts, fixture.readers, `order ${order.join(' -> ')}`);
    assert.equal(fs.existsSync(replacementMarkerPath(sessionId)), true, `order ${order.join(' -> ')}: no reader deletes the marker`);
  }
});

test('all three SessionStart(compact) readers emit the short note when they run in parallel', async () => {
  const fixture = sessionStartReaderFixture();
  const sessionId = `sq200-parallel-${++fixtureState.sqSeq}`;
  const transcript = path.join(SIDEQUEST_HOME, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, '[]');
  runHookOutput(POST_COMPACT, { session_id: sessionId, transcript_path: transcript, compact_summary: '' });
  assertAllShortNotes(await fixture.runInParallel(sessionId), fixture.readers, 'parallel');
  assert.equal(fs.existsSync(replacementMarkerPath(sessionId)), true, 'parallel: no reader deletes the marker');
});

// With no delete-on-read, a summarized compaction inside the age bound would inherit the earlier
// replacement's marker and wrongly skip re-grounding. PostCompact, the only writer, removes it.
test('a summarized PostCompact removes an earlier replacement marker so every reader re-grounds', () => {
  const fixture = sessionStartReaderFixture();
  const sessionId = `sq200-summarized-after-replacement-${++fixtureState.sqSeq}`;
  const transcript = path.join(SIDEQUEST_HOME, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, '[]');
  runHookOutput(POST_COMPACT, { session_id: sessionId, transcript_path: transcript, compact_summary: '' });
  assert.equal(fs.existsSync(replacementMarkerPath(sessionId)), true);

  runHookOutput(POST_COMPACT, { session_id: sessionId, transcript_path: transcript, compact_summary: 'a real summary' });
  assert.equal(fs.existsSync(replacementMarkerPath(sessionId)), false, 'a summarized PostCompact leaves no marker behind');
  assertAllFullContexts(
    fixture.runInOrder(sessionId, SESSION_START_READERS),
    fixture.readers,
    'summarized after replacement',
  );
});

test('every reader ignores a marker past the shared age bound, and PostCompact replaces it with a fresh timestamped one', () => {
  const fixture = sessionStartReaderFixture();
  const sessionId = `sq200-stale-${++fixtureState.sqSeq}`;
  const transcript = path.join(SIDEQUEST_HOME, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, '[]');
  const marker = replacementMarkerPath(sessionId);

  const before = Date.now();
  runHookOutput(POST_COMPACT, { session_id: sessionId, transcript_path: transcript, compact_summary: '' });
  const written = JSON.parse(fs.readFileSync(marker, 'utf8'));
  const writtenAt = Date.parse(written.at);
  assert.ok(Number.isFinite(writtenAt), `the marker carries an ISO timestamp, got ${JSON.stringify(written)}`);
  assert.ok(writtenAt >= before - 1000 && writtenAt <= Date.now() + 1000, 'the marker timestamp is the write time');

  // Age the marker past the 2-minute bound the three readers share. Sidequest used to accept a
  // marker of any age because it only checked that the unlink succeeded.
  const past = (Date.now() - 5 * 60 * 1000) / 1000;
  fs.writeFileSync(marker, JSON.stringify({ at: new Date(past * 1000).toISOString() }));
  fs.utimesSync(marker, past, past);
  assertAllFullContexts(fixture.runInOrder(sessionId, SESSION_START_READERS), fixture.readers, 'stale marker');

  // The next replacement PostCompact removes the stale marker and writes a fresh one.
  runHookOutput(POST_COMPACT, { session_id: sessionId, transcript_path: transcript, compact_summary: '' });
  const refreshed = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.ok(Date.parse(refreshed.at) >= before - 1000, 'the rewritten marker carries a fresh timestamp');
  assert.ok(Date.now() - fs.statSync(marker).mtimeMs < 60 * 1000, 'the rewritten marker is fresh on disk');
  assertAllShortNotes(fixture.runInOrder(sessionId, SESSION_START_READERS), fixture.readers, 'refreshed marker');
});

test('session-start: SIDEQUEST_NUDGE=off silences it', () => {
  const out = execFileSync(process.execPath, [SESSION], {
    input: JSON.stringify({ session_id: 'test' }),
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_NUDGE: 'off' },
  });
  assert.strictEqual(out.trim(), '', 'should emit nothing when nudge is off');
});

test('worktree-create refuses an unbound request before Git or target mutation', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-unbound-worktree-repo-'));
  gitFixture(['init', '--quiet', '-b', 'main'], repo);
  gitFixture(['config', 'user.email', 'test@example.invalid'], repo);
  gitFixture(['config', 'user.name', 'Worktree Hook Test'], repo);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'seed\n');
  gitFixture(['add', 'tracked.txt'], repo);
  gitFixture(['commit', '--quiet', '-m', 'seed'], repo);
  store.ensureProject(repo, 'unbound worktree hook');
  const name = `unknown-${++fixtureState.sqSeq}`;
  const target = worktrees.namedWorktreePath(repo, name);
  let stderr = '';
  assert.throws(() => execFileSync(process.execPath, [WORKTREE_CREATE], {
    input: JSON.stringify({ hook_event_name: 'WorktreeCreate', session_id: `unknown-session-${fixtureState.sqSeq}`, cwd: repo, name }),
    encoding: 'utf8',
    env: { ...process.env, GIT_TRACE: '1' },
  }), (error: any) => {
    stderr = String(error.stderr || '');
    return stderr.includes('worktree lease refused creation');
  });
  assert.doesNotMatch(stderr, /worktree add/, 'unknown identity must never invoke git worktree add');
  assert.equal(fs.existsSync(target), false, 'unknown identity must not create the target directory');
  assert.throws(() => gitFixture(['show-ref', '--verify', `refs/heads/worktree-${name}`], repo));
});

test('linked worktree fixture paths include entropy beyond their sequence number', () => {
  const first = linkedWorktreeFixturePath();
  const second = linkedWorktreeFixturePath();
  const pathPattern = /^sq-linked-worktree-hook-\d+-([0-9a-f-]{36})$/;
  const firstEntropy = path.basename(first).match(pathPattern)?.[1];
  const secondEntropy = path.basename(second).match(pathPattern)?.[1];

  assert.ok(firstEntropy, 'the first fixture path must include a UUID suffix');
  assert.ok(secondEntropy, 'the second fixture path must include a UUID suffix');
  assert.notEqual(firstEntropy, secondEntropy, 'fixture paths must not rely only on the per-process sequence number');
});

test('worktree-create binds a linked checkout to its registered main board', () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-linked-worktree-hook-repo-'));
  const linkedCheckout = linkedWorktreeFixturePath();
  gitFixture(['init', '--quiet', '-b', 'main'], repository);
  gitFixture(['config', 'user.email', 'test@example.invalid'], repository);
  gitFixture(['config', 'user.name', 'Linked Worktree Hook Test'], repository);
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'seed\n');
  gitFixture(['add', 'tracked.txt'], repository);
  gitFixture(['commit', '--quiet', '-m', 'seed'], repository);
  const project = store.ensureProject(repository, 'linked worktree hook').slug;
  const category = `linked-worktree-hook-${fixtureState.sqSeq}`;
  store.setCategory({
    id: category,
    name: category,
    route: { model: 'sonnet', effort: 'medium' },
    fallback: null,
    enabled: true,
  });
  const ticket = store.createTicket(project, { title: 'linked worktree creation', category, files: ['tracked.txt'] });
  const sessionId = `linked-worktree-hook-${fixtureState.sqSeq}`;
  const prepared = store.prepareDispatch(project, ticket.ref, { sessionId });
  assert.equal(store.recordDispatchLaunch(project, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
  }).ok, true);
  gitFixture(['worktree', 'add', '--detach', linkedCheckout], repository);
  const name = `agent-linked-${fixtureState.sqSeq}`;
  const target = worktrees.namedWorktreePath(linkedCheckout, name);
  try {
    // SQ-237: findProject folds the linked checkout to its main board instead of reporting not_found.
    assert.equal(store.findProject(linkedCheckout).slug, project);
    const output = execFileSync(process.execPath, [WORKTREE_CREATE], {
      input: JSON.stringify({ hook_event_name: 'WorktreeCreate', session_id: sessionId, cwd: linkedCheckout, name }),
      encoding: 'utf8',
      env: process.env,
    }).trim();
    assert.equal(output, gitFixture(['rev-parse', '--show-toplevel'], target), 'the hook must return Git’s host-facing path spelling');
    assert.equal(store.listProjects({ all: true }).some((entry: any) => entry.path === linkedCheckout), false, 'the linked checkout must not mint a second board');
    assert.equal(store.findProject(linkedCheckout).slug, project, 'the linked checkout resolves to its main board');
    const dispatch = store.getTicket(project, ticket.ref).dispatch;
    assert.equal(store.findProject(repository).slug, project);
    assert.equal(worktrees.canonicalPath(dispatch.worktree), worktrees.canonicalPath(target));
  } finally {
    if (fs.existsSync(target)) gitFixture(['worktree', 'remove', '--force', target], repository);
    if (fs.existsSync(linkedCheckout)) gitFixture(['worktree', 'remove', '--force', linkedCheckout], repository);
    try { gitFixture(['branch', '-D', `worktree-${name}`], repository); } catch (_) {}
  }
});

// SQ-230: an orchestrator whose session cwd sits in one registered repository
// dispatches onto another board with --project. PreToolUse records the launch on
// the --project board, but WorktreeCreate only receives the session cwd, so
// resolving the board from cwd alone found no launched dispatch and refused every
// isolated executor with dispatch_binding_unavailable.
test('worktree-create binds a dispatch launched onto another board than the session cwd (SQ-230)', () => {
  const seedRepository = (prefix: string) => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    gitFixture(['init', '--quiet', '-b', 'main'], repository);
    gitFixture(['config', 'user.email', 'test@example.invalid'], repository);
    gitFixture(['config', 'user.name', 'Cross Board Worktree Hook Test'], repository);
    fs.writeFileSync(path.join(repository, 'tracked.txt'), `${prefix}\n`);
    gitFixture(['add', 'tracked.txt'], repository);
    gitFixture(['commit', '--quiet', '-m', 'seed'], repository);
    return repository;
  };
  const sessionRepository = seedRepository('sq-cross-board-session-repo-');
  const dispatchRepository = seedRepository('sq-cross-board-dispatch-repo-');
  const sessionBoard = store.ensureProject(sessionRepository, 'cross board session').slug;
  const dispatchBoard = store.ensureProject(dispatchRepository, 'cross board dispatch').slug;
  assert.notEqual(sessionBoard, dispatchBoard);
  const category = `cross-board-worktree-hook-${++fixtureState.sqSeq}`;
  store.setCategory({
    id: category,
    name: category,
    route: { model: 'sonnet', effort: 'medium' },
    fallback: null,
    enabled: true,
  });
  const ticket = store.createTicket(dispatchBoard, { title: 'cross board worktree creation', category, files: ['tracked.txt'] });
  const sessionId = `cross-board-worktree-hook-${fixtureState.sqSeq}`;
  const prepared = store.prepareDispatch(dispatchBoard, ticket.ref, { sessionId });
  assert.equal(store.recordDispatchLaunch(dispatchBoard, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
  }).ok, true);
  const name = `agent-cross-board-${fixtureState.sqSeq}`;
  const target = worktrees.namedWorktreePath(dispatchRepository, name);
  const wrongTarget = worktrees.namedWorktreePath(sessionRepository, name);
  try {
    const output = execFileSync(process.execPath, [WORKTREE_CREATE], {
      input: JSON.stringify({ hook_event_name: 'WorktreeCreate', session_id: sessionId, cwd: sessionRepository, name }),
      encoding: 'utf8',
      env: process.env,
    }).trim();
    assert.equal(output, gitFixture(['rev-parse', '--show-toplevel'], target), 'the checkout must belong to the dispatch board repository');
    assert.equal(fs.readFileSync(path.join(target, 'tracked.txt'), 'utf8'), 'sq-cross-board-dispatch-repo-\n');
    assert.equal(fs.existsSync(wrongTarget), false, 'the session cwd repository must not receive the checkout');
    const dispatch = store.getTicket(dispatchBoard, ticket.ref).dispatch;
    assert.equal(worktrees.canonicalPath(dispatch.worktree), worktrees.canonicalPath(target));
    assert.equal(dispatch.worktreeBindingSource, 'worktree-create');
    assert.ok(dispatch.worktreeCreationCompletedAt, 'creation completion must be recorded on the dispatch board');
  } finally {
    if (fs.existsSync(target)) gitFixture(['worktree', 'remove', '--force', target], dispatchRepository);
    if (fs.existsSync(wrongTarget)) gitFixture(['worktree', 'remove', '--force', wrongTarget], sessionRepository);
    try { gitFixture(['branch', '-D', `worktree-${name}`], dispatchRepository); } catch (_) {}
    try { gitFixture(['branch', '-D', `worktree-${name}`], sessionRepository); } catch (_) {}
  }
});

test('worktree-create refuses a pre-existing same-repository checkout without creation proof', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-existing-worktree-repo-'));
  gitFixture(['init', '--quiet', '-b', 'main'], repo);
  gitFixture(['config', 'user.email', 'test@example.invalid'], repo);
  gitFixture(['config', 'user.name', 'Worktree Hook Test'], repo);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'seed\n');
  gitFixture(['add', 'tracked.txt'], repo);
  gitFixture(['commit', '--quiet', '-m', 'seed'], repo);
  const project = store.ensureProject(repo, 'existing worktree hook').slug;
  const category = `existing-worktree-hook-${++fixtureState.sqSeq}`;
  store.setCategory({
    id: category,
    name: category,
    route: { model: 'sonnet', effort: 'medium' },
    fallback: null,
    enabled: true,
  });
  store.setBoardConfig(project, {
    worktreeDependencyPaths: [],
    worktreeSetup: 'node -e "require(\'node:fs\').writeFileSync(\'provisioned.txt\', \'wrong\')"',
  });
  const ticket = store.createTicket(project, { title: 'existing target refusal', category, files: ['tracked.txt'] });
  const sessionId = `existing-target-${fixtureState.sqSeq}`;
  const prepared = store.prepareDispatch(project, ticket.ref, { sessionId });
  assert.equal(store.recordDispatchLaunch(project, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
  }).ok, true);
  const name = `agent-existing-${fixtureState.sqSeq}`;
  const target = worktrees.namedWorktreePath(repo, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  gitFixture(['worktree', 'add', '--detach', target], repo);
  const originalRevision = gitFixture(['rev-parse', 'HEAD'], target);
  try {
    assert.throws(() => execFileSync(process.execPath, [WORKTREE_CREATE], {
      input: JSON.stringify({ hook_event_name: 'WorktreeCreate', session_id: sessionId, cwd: repo, name }),
      encoding: 'utf8',
      env: process.env,
    }), (error: any) => String(error.stderr || '').includes('existed before this dispatch completed its creation'));
    assert.equal(gitFixture(['rev-parse', 'HEAD'], target), originalRevision);
    assert.equal(fs.existsSync(path.join(target, 'provisioned.txt')), false);
    const refusedDispatch = store.getTicket(project, ticket.ref).dispatch;
    assert.equal(refusedDispatch.worktreeCreationCompletedAt, undefined);
    assert.equal(refusedDispatch.agentId, undefined);
  } finally {
    gitFixture(['worktree', 'remove', '--force', target], repo);
  }
});

test('worktree-create forks local-main directly when origin main is stale', () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-local-main-worktree-repo-'));
  gitFixture(['init', '--quiet', '-b', 'main'], repository);
  gitFixture(['config', 'user.email', 'test@example.invalid'], repository);
  gitFixture(['config', 'user.name', 'Worktree Hook Test'], repository);
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'origin\n');
  gitFixture(['add', 'tracked.txt'], repository);
  gitFixture(['commit', '--quiet', '-m', 'origin main'], repository);
  const originMain = gitFixture(['rev-parse', 'HEAD'], repository);
  gitFixture(['update-ref', 'refs/remotes/origin/main', originMain], repository);
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'local\n');
  gitFixture(['commit', '--quiet', '-am', 'local main'], repository);
  const localMain = gitFixture(['rev-parse', 'HEAD'], repository);

  const project = store.ensureProject(repository, 'local main worktree hook').slug;
  store.setBoardConfig(project, { worktreeBase: 'local-main' });
  const category = `local-main-worktree-hook-${++fixtureState.sqSeq}`;
  store.setCategory({
    id: category,
    name: category,
    route: { model: 'sonnet', effort: 'medium' },
    fallback: null,
    enabled: true,
  });
  const ticket = store.createTicket(project, { title: 'local main worktree creation', category, files: ['tracked.txt'] });
  const sessionId = `local-main-worktree-${fixtureState.sqSeq}`;
  const prepared = store.prepareDispatch(project, ticket.ref, { sessionId });
  assert.equal(prepared.ticket.dispatch.baseCommit, localMain);
  assert.equal(store.recordDispatchLaunch(project, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
  }).ok, true);

  const name = `agent-local-main-${fixtureState.sqSeq}`;
  const target = worktrees.namedWorktreePath(repository, name);
  try {
    execFileSync(process.execPath, [WORKTREE_CREATE], {
      input: JSON.stringify({ hook_event_name: 'WorktreeCreate', session_id: sessionId, cwd: repository, name }),
      encoding: 'utf8',
      env: process.env,
    });
    assert.equal(gitFixture(['rev-parse', 'HEAD'], target), localMain);
    assert.notEqual(gitFixture(['rev-parse', 'HEAD'], target), originMain);
  } finally {
    if (fs.existsSync(target)) gitFixture(['worktree', 'remove', '--force', target], repository);
    try { gitFixture(['branch', '-D', `worktree-${name}`], repository); } catch (_) {}
  }
});

test('worktree-create provisions configured dependencies before dispatch and removes failed worktrees', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-external-worktree-repo-'));
  gitFixture(['init', '--quiet', '-b', 'main'], repo);
  gitFixture(['config', 'user.email', 'test@example.invalid'], repo);
  gitFixture(['config', 'user.name', 'Worktree Hook Test'], repo);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'seed\n');
  gitFixture(['add', 'tracked.txt'], repo);
  gitFixture(['commit', '--quiet', '-m', 'seed'], repo);
  fs.mkdirSync(path.join(repo, 'cached-dependency'));
  fs.writeFileSync(path.join(repo, 'cached-dependency', 'cache.txt'), 'warm\n');
  const project = store.ensureProject(repo, 'worktree hook provisioning').slug;
  store.setBoardConfig(project, {
    worktreeDependencyPaths: [{ path: 'cached-dependency', mode: 'copy' }],
    worktreeSetup: 'node -e "require(\'node:fs\').writeFileSync(\'setup-ready.txt\', \'ready\')"',
  });
  const category = `worktree-hook-${++fixtureState.sqSeq}`;
  store.setCategory({
    id: category,
    name: category,
    route: { model: 'sonnet', effort: 'medium' },
    fallback: null,
    enabled: true,
  });
  const launch = (sessionId: string, title: string) => {
    const ticket = store.createTicket(project, { title, category, files: ['tracked.txt'] });
    const prepared = store.prepareDispatch(project, ticket.ref, { sessionId });
    assert.equal(store.recordDispatchLaunch(project, ticket.ref, {
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
      sessionId,
    }).ok, true);
    return ticket;
  };
  const createdTicket = launch('hook-test', 'bound worktree creation');
  const name = 'agent-hook-test';
  const payload = { hook_event_name: 'WorktreeCreate', session_id: 'hook-test', cwd: repo, name };
  const expected = worktrees.namedWorktreePath(repo, name);

  const first = execFileSync(process.execPath, [WORKTREE_CREATE], {
    input: JSON.stringify(payload), encoding: 'utf8', env: process.env,
  }).trim();
  assert.equal(worktrees.canonicalPath(first), worktrees.canonicalPath(expected));
  assert.equal(first, gitFixture(['rev-parse', '--show-toplevel'], expected), 'the hook must preserve Git’s exact checkout path spelling');
  assert.equal(path.relative(repo, first).startsWith('..'), true);
  assert.equal(worktrees.canonicalPath(gitFixture(['rev-parse', '--show-toplevel'], first)), worktrees.canonicalPath(expected));
  assert.equal(gitFixture(['branch', '--show-current'], first), `worktree-${name}`);
  assert.equal(fs.readFileSync(path.join(first, 'cached-dependency', 'cache.txt'), 'utf8'), 'warm\n');
  assert.equal(fs.readFileSync(path.join(first, 'setup-ready.txt'), 'utf8'), 'ready');

  const createdDispatch = store.getTicket(project, createdTicket.ref).dispatch;
  runHook(SUBAGENT_START, {
    hook_event_name: 'SubagentStart',
    session_id: 'hook-test',
    agent_type: createdDispatch.executor,
    agent_id: 'hook-runtime-agent',
    agent_name: createdDispatch.agentName,
    cwd: first,
  });
  const boundDispatch = store.getTicket(project, createdTicket.ref).dispatch;
  const gitDirectory = path.resolve(first, gitFixture(['rev-parse', '--git-dir'], first));
  const commonGitDirectory = path.resolve(first, gitFixture(['rev-parse', '--git-common-dir'], first));
  assert.equal(boundDispatch.agentId, 'hook-runtime-agent');
  assert.equal(worktrees.canonicalPath(boundDispatch.worktree), worktrees.canonicalPath(first));
  assert.equal(worktrees.canonicalPath(boundDispatch.worktreeGitDirectory), worktrees.canonicalPath(gitDirectory));
  assert.equal(worktrees.canonicalPath(boundDispatch.worktreeCommonGitDirectory), worktrees.canonicalPath(commonGitDirectory));
  assert.equal(boundDispatch.worktreeCheckoutInstance, worktreeLease.checkoutInstanceIdentity(gitDirectory));
  assert.equal(boundDispatch.worktreeBindingSource, 'worktree-create');

  const second = execFileSync(process.execPath, [WORKTREE_CREATE], {
    input: JSON.stringify(payload), encoding: 'utf8', env: process.env,
  }).trim();
  assert.equal(worktrees.canonicalPath(second), worktrees.canonicalPath(expected));
  gitFixture(['worktree', 'remove', '--force', expected], repo);
  gitFixture(['branch', '-D', `worktree-${name}`], repo);

  const timedOutSetup = 'node -e "process.stderr.write(\'setup audit notice\\n\'); setTimeout(() => process.exit(0), 5000)"';
  store.setBoardConfig(project, { worktreeDependencyPaths: [], worktreeSetup: timedOutSetup });
  const incompleteTicket = launch('hook-setup-timeout', 'bound worktree setup timeout');
  const incompleteName = 'agent-hook-setup-timeout';
  const incompleteTarget = worktrees.namedWorktreePath(repo, incompleteName);
  const incompleteOutput = execFileSync(process.execPath, [WORKTREE_CREATE], {
    input: JSON.stringify({ hook_event_name: 'WorktreeCreate', session_id: 'hook-setup-timeout', cwd: repo, name: incompleteName }),
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_WORKTREE_CREATE_HOOK_TIMEOUT_MS: '1000' },
  }).trim();
  assert.equal(worktrees.canonicalPath(incompleteOutput), worktrees.canonicalPath(incompleteTarget));
  assert.equal(fs.existsSync(incompleteTarget), true, 'a timed-out setup preserves its completed checkout');
  const incomplete = store.getTicket(project, incompleteTicket.ref);
  const incompleteDispatch = incomplete.dispatch;
  assert.ok(incompleteDispatch.worktreeCreationCompletedAt, 'checkout creation must be recorded before setup runs');
  assert.equal(incompleteDispatch.worktreeProvisioningFailure.command, timedOutSetup);
  assert.match(incompleteDispatch.worktreeProvisioningFailure.reason, /timed out after 900ms/);
  const incompleteBriefing = agentsync.renderTicketBriefing(incomplete, incomplete.dispatchNonce, project, repo);
  assert.match(incompleteBriefing, /worktree setup incomplete: node -e/);
  assert.match(incompleteBriefing, /Run it in .*agent-hook-setup-timeout before work/);
  assert.match(incompleteBriefing, /Setup stderr tail: setup audit notice/);
  gitFixture(['worktree', 'remove', '--force', incompleteTarget], repo);
  gitFixture(['branch', '-D', `worktree-${incompleteName}`], repo);
});

test('subagent-start warns only for embedded worktrees outside the receiving agent checkout', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-diagnostic-worktrees-'));
  gitFixture(['init', '-b', 'main'], repo);
  const worktrees = path.join(repo, '.claude', 'worktrees');
  const current = path.join(worktrees, 'agent-current');
  fs.mkdirSync(current, { recursive: true });
  fs.writeFileSync(path.join(current, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'agent-current')}\n`);
  const payload = {
    session_id: 'diagnostic-worktree-warning',
    agent_type: 'sidequest-exec-dispatch',
    agent_id: 'diagnostic-worktree-agent',
    cwd: current,
  };

  assert.equal(runHook(SUBAGENT_START, payload), '', 'the receiving agent\'s own worktree must stay quiet');
  fs.mkdirSync(path.join(worktrees, 'agent-foreign'));
  const warning = runHook(SUBAGENT_START, payload);
  assert.match(warning, /1 foreign agent worktree in play/);
  assert.match(warning, /Keep error-severity diagnostics in your own files actionable\./);
});

export {};
