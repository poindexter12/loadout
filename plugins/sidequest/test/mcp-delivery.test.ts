'use strict';
// SQ-137: one topic shard of the former mcp.test.ts, split so the runner can spread its tests
// across workers. Shared setup and helpers live in ./_mcp-fixture.ts; the tests are moved unchanged.
import {
  test,
  assert,
  path,
  fs,
  store,
  committedRepo,
  callTool,
  gitAt,
  persistTicket,
  createGitWorktree,
  prepareIsolatedWorktreeDispatch,
  submitIsolatedDeliveryCandidate,
  removeTestWorktree,
} from './_mcp-fixture.js';

test('MCP delivery preserves a retained continuation worktree', async (context: any) => {
  const primary = createGitWorktree();
  const project = store.ensureProject(primary).slug;
  store.setBoardConfig(project, { integrationMode: 'local', integrationBranch: 'main', worktreeBase: 'local-main' });
  const ticket = store.createTicket(project, {
    title: 'preserve retained continuation', files: ['feature.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'preserve the continuation checkout after a delivery record',
  });
  const by = 'delivery-continuation-worker';
  const worktree = prepareIsolatedWorktreeDispatch(project, primary, ticket, by);
  context.after(() => removeTestWorktree(primary, worktree));
  await submitIsolatedDeliveryCandidate(project, ticket, by, worktree);
  const retained = store.getTicket(project, ticket.ref);
  retained.dispatch.continuation = { mode: 'retained_worktree_resume', sourceWorktree: worktree };
  persistTicket(project, retained);

  const integrated = await callTool('integrate', { project, ref: ticket.ref, by: 'delivery-continuation-integrator' });
  assert.equal(integrated.ok, true, integrated.message || integrated.reason);
  assert.equal(store.getTicket(project, ticket.ref).status, 'done');
  assert.equal(fs.existsSync(worktree), true);
});

test('MCP delivery records completion when its isolated worktree is locked', async (context: any) => {
  const primary = createGitWorktree();
  const project = store.ensureProject(primary).slug;
  store.setBoardConfig(project, { integrationMode: 'local', integrationBranch: 'main', worktreeBase: 'local-main' });
  const ticket = store.createTicket(project, {
    title: 'defer locked delivery worktree', files: ['feature.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm cleanup failure cannot roll back delivery recording',
  });
  const by = 'delivery-locked-worker';
  const worktree = prepareIsolatedWorktreeDispatch(project, primary, ticket, by);
  context.after(() => removeTestWorktree(primary, worktree));
  await submitIsolatedDeliveryCandidate(project, ticket, by, worktree);
  gitAt(primary, ['worktree', 'lock', '--reason', 'delivery cleanup fixture lock', worktree]);

  const integrated = await callTool('integrate', { project, ref: ticket.ref, by: 'delivery-locked-integrator' });
  assert.equal(integrated.ok, true, integrated.message || integrated.reason);
  assert.equal(store.getTicket(project, ticket.ref).status, 'done');
  assert.equal(fs.existsSync(worktree), true);
});

test('MCP groomClose abandons an unconsumed prepared dispatch without waiting for claim idleness', async () => {
  const worktree = createGitWorktree();
  const project = store.ensureProject(worktree).slug;
  const preparedTicket = store.createTicket(project, {
    title: 'prepared dispatch abandoned during grooming', files: ['feature.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm grooming can close an unconsumed dispatch immediately',
  });
  store.prepareDispatch(project, preparedTicket.ref, { sharedTree: true });

  const closed = await callTool('groomClose', {
    project, ref: preparedTicket.ref, by: 'groomer', reason: 'The prepared ticket is obsolete.',
  });
  assert.equal(closed.ok, true, closed.message || closed.reason);
  const completed = store.getTicket(project, preparedTicket.ref);
  assert.equal(completed.status, 'done');
  assert.ok(completed.dispatch.terminalAt);
  const abandonedAttempt = completed.dispatch.attempts.at(-2);
  assert.equal(abandonedAttempt.outcome, 'abandoned');
  assert.equal(abandonedAttempt.failureShape, 'unconsumed_prepared_dispatch_abandoned');
  assert.equal(abandonedAttempt.launchedAt, null);
  assert.equal(abandonedAttempt.boundAt, null);
  assert.equal(abandonedAttempt.claimedAt, null);

  const liveTicket = store.createTicket(project, {
    title: 'live dispatch remains protected during grooming', files: ['feature.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm grooming still refuses a dispatch with a live claim',
  });
  const liveDispatch = store.prepareDispatch(project, liveTicket.ref, { sharedTree: true });
  const holder = 'grooming-claim-holder';
  assert.equal(store.claimTicket(project, liveTicket.ref, holder, {
    token: liveDispatch.token,
    executor: liveDispatch.ticket.dispatchExecutor,
  }).ok, true);

  const refused = await callTool('groomClose', {
    project, ref: liveTicket.ref, by: 'groomer', reason: 'The live ticket is obsolete.',
  });
  assert.equal(refused.reason, 'active_dispatch');
  // This refusal used to print `sidequest release <ref> --by <holder>`, which is
  // the board instructing the caller to act under the holder's identity. It must
  // still name a release that unblocks the closure, but not that one (SQ-69).
  assert.doesNotMatch(refused.message, new RegExp(`--by ${holder}`));
  assert.match(refused.message, /Release it first/);
  assert.match(refused.message, new RegExp(`mcp__plugin_sidequest_board__release\\(\\{ ref: "${liveTicket.ref}"`));
  assert.match(refused.message, /force: true/);
});

test('MCP delivery closure points live claims at the owning release command', async () => {
  const worktree = createGitWorktree();
  const project = store.ensureProject(worktree).slug;
  const ticket = store.createTicket(project, {
    title: 'live hand delivery closure', files: ['feature.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm delivery refusal names a command accepted by the CLI',
  });
  const by = 'delivery-claim-holder';
  assert.equal((await callTool('claim', { project, ref: ticket.ref, by, direct: true, reason: 'The delivery refusal fixture needs a direct claim.' })).ok, true);

  const refused = await callTool('groomClose', {
    project, ref: ticket.ref, by: 'integrator', reason: 'Delivered the candidate by hand.', deliveryCommit: gitAt(worktree, ['rev-parse', 'HEAD']),
  });
  assert.equal(refused.reason, 'active_dispatch');
  // Same as grooming: name a release the caller may actually run as itself, not
  // one that borrows the claim holder's identity (SQ-69).
  assert.doesNotMatch(refused.message, new RegExp(`--by ${by}`));
  assert.match(refused.message, /Release it first/);
  assert.match(refused.message, new RegExp(`mcp__plugin_sidequest_board__release\\(\\{ ref: "${ticket.ref}"`));
  assert.match(refused.message, /force: true/);
  assert.doesNotMatch(refused.message, /recoverDispatch/);
});

test('MCP delivery closure binds the integration revision resolved after board initialization', async () => {
  const worktree = createGitWorktree();
  const project = store.ensureProject(worktree).slug;
  store.setBoardConfig(project, { integrationMode: 'local', integrationBranch: 'main' });
  const ticket = store.createTicket(project, {
    title: 'current integration delivery', files: ['feature.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm a later local integration commit is evaluated at closure time',
  });
  fs.writeFileSync(path.join(worktree, 'feature.js'), 'delivered after board initialization\n');
  gitAt(worktree, ['add', 'feature.js']);
  gitAt(worktree, ['commit', '-m', 'advance main after board initialization']);
  const deliveryCommit = gitAt(worktree, ['rev-parse', 'HEAD']);

  const closed = await callTool('groomClose', {
    project, ref: ticket.ref, by: 'integrator', reason: 'The candidate reached the integration branch after board initialization.', deliveryCommit,
  });
  assert.equal(closed.ok, true, `delivery closure was refused: ${closed.message}`);
  const completed = store.getTicket(project, ticket.ref);
  assert.equal(completed.completion.delivery.commit, deliveryCommit);
  assert.deepEqual(completed.completion.delivery.integrationRevision, {
    source: 'git:main',
    value: deliveryCommit,
    observedAt: completed.completion.delivery.integrationRevision.observedAt,
  }, 'the closure records the exact integration revision used for reachability');
});

test('MCP delivery closure keeps each prepared branch after the project target and checkout change', async () => {
  const repository = committedRepo('sq-ticket-delivery-target-');
  gitAt(repository, ['switch', '-c', 'branch-a']);
  gitAt(repository, ['branch', 'branch-b', 'main']);
  gitAt(repository, ['config', 'user.name', 'Sidequest Tests']);
  gitAt(repository, ['config', 'user.email', 'sidequest@example.invalid']);
  const project = store.ensureProject(repository).slug;
  store.setBoardConfig(project, { integrationMode: 'local', integrationBranch: 'branch-a' });
  const correctDeliveryTicket = store.createTicket(project, {
    title: 'deliver on prepared branch', files: ['correct.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm delivery retains the prepared branch target',
  });
  const wrongDeliveryTicket = store.createTicket(project, {
    title: 'reject delivery from another branch', files: ['wrong.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm another branch cannot satisfy the prepared target',
  });
  for (const [ticket, by] of [
    [correctDeliveryTicket, 'correct-branch-worker'],
    [wrongDeliveryTicket, 'wrong-branch-worker'],
  ]) {
    const prepared = store.prepareDispatch(project, ticket.ref, {
      sharedTree: true,
      integrationMode: 'local',
      integrationBranch: 'branch-a',
    });
    assert.deepEqual(prepared.ticket.dispatch.integrationTarget, {
      mode: 'local', upstream: 'branch-a', branch: 'branch-a',
    });
    assert.equal(store.claimTicket(project, ticket.ref, by, {
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
    }).ok, true);
    assert.equal(store.releaseTicket(project, ticket.ref, by, {
      status: 'todo',
      releaseKind: 'handback',
      releaseReason: 'Prepared work is ready for user-authorized delivery.',
    }).ok, true);
  }

  fs.writeFileSync(path.join(repository, 'correct.js'), 'delivered on branch a\n');
  gitAt(repository, ['add', 'correct.js']);
  gitAt(repository, ['commit', '-m', 'deliver correct branch work']);
  const correctDeliveryCommit = gitAt(repository, ['rev-parse', 'HEAD']);

  gitAt(repository, ['switch', 'branch-b']);
  fs.writeFileSync(path.join(repository, 'wrong.js'), 'unrelated branch delivery\n');
  gitAt(repository, ['add', 'wrong.js']);
  gitAt(repository, ['commit', '-m', 'commit unrelated branch work']);
  const wrongDeliveryCommit = gitAt(repository, ['rev-parse', 'HEAD']);
  store.setBoardConfig(project, { integrationMode: 'local', integrationBranch: 'branch-b' });

  const correctDelivery = await callTool('groomClose', {
    project,
    ref: correctDeliveryTicket.ref,
    by: 'delivery-integrator',
    reason: 'User authorized delivery on the branch recorded for this ticket.',
    deliveryCommit: correctDeliveryCommit,
  });
  const wrongDelivery = await callTool('groomClose', {
    project,
    ref: wrongDeliveryTicket.ref,
    by: 'delivery-integrator',
    reason: 'An unrelated branch commit must not satisfy this ticket.',
    deliveryCommit: wrongDeliveryCommit,
  });

  assert.deepEqual({
    correctDeliveryClosed: correctDelivery.ok,
    wrongDeliveryReason: wrongDelivery.reason,
  }, {
    correctDeliveryClosed: true,
    wrongDeliveryReason: 'delivery_not_reachable',
  }, 'groomClose must retain each ticket\'s prepared branch authority');
  assert.match(wrongDelivery.message, /refs\/heads\/branch-a/);
  const completed = store.getTicket(project, correctDeliveryTicket.ref);
  assert.equal(completed.completion.delivery.targetBranch, 'branch-a');
  assert.equal(completed.completion.delivery.integrationRevision.value, correctDeliveryCommit);
  assert.equal(store.getTicket(project, wrongDeliveryTicket.ref).status, 'todo');
});

test('SQ-2434: MCP delivery closure accepts local main ahead of origin and records upstream reachability', async () => {
  const worktree = createGitWorktree();
  const project = store.ensureProject(worktree).slug;
  store.setBoardConfig(project, { integrationMode: 'remote', integrationBranch: 'main' });
  const ticket = store.createTicket(project, {
    title: 'local main delivery before push', files: ['feature.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm local integration delivery does not wait for an upstream push',
  });
  fs.writeFileSync(path.join(worktree, 'feature.js'), 'delivered locally before push\n');
  gitAt(worktree, ['add', 'feature.js']);
  gitAt(worktree, ['commit', '-m', 'deliver on local main before push']);
  const deliveryCommit = gitAt(worktree, ['rev-parse', 'HEAD']);
  assert.notEqual(deliveryCommit, gitAt(worktree, ['rev-parse', 'origin/main']), 'local main is ahead of origin/main');

  const closed = await callTool('groomClose', {
    project, ref: ticket.ref, by: 'integrator', reason: 'The commit reached local main and awaits the next push.', deliveryCommit,
  });
  assert.equal(closed.ok, true, `local delivery closure was refused: ${closed.message}`);
  const completed = store.getTicket(project, ticket.ref);
  assert.deepEqual(completed.completion.delivery.integrationRevision, {
    source: 'git:main',
    value: deliveryCommit,
    observedAt: completed.completion.delivery.integrationRevision.observedAt,
  }, 'the closure records the local main revision used for reachability');
  assert.deepEqual(completed.completion.delivery.upstream, {
    ref: 'origin/main',
    reachable: false,
  }, 'the completion records that the local delivery has not reached origin/main yet');
});

test('SQ-2429: MCP groomClose records a delivered candidate despite a live overlapping sibling', async () => {
  const worktree = createGitWorktree();
  const project = store.ensureProject(worktree).slug;
  store.setBoardConfig(project, { integrationMode: 'local', integrationBranch: 'main' });
  const delivered = store.createTicket(project, {
    title: 'delivered prose candidate', files: ['docs'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm delivery reconciliation ignores a sibling that only holds a live claim',
  });
  assert.equal(store.claimTicket(project, delivered.ref, 'delivered-prose-worker', {
    direct: true, reason: 'The delivery reconciliation fixture requires a local direct claim.',
  }).ok, true);
  fs.mkdirSync(path.join(worktree, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'docs', 'guide.md'), 'delivered\n');
  gitAt(worktree, ['add', 'docs/guide.md']);
  gitAt(worktree, ['commit', '-m', 'delivered prose candidate']);
  const candidate = gitAt(worktree, ['rev-parse', 'HEAD']);
  gitAt(worktree, ['update-ref', `refs/sidequest/${delivered.ref}`, candidate]);
  assert.equal(store.submitTicket(project, delivered.ref, 'delivered-prose-worker', {
    commit: candidate, verify: 'node -e "process.exit(0)"',
  }).ok, true);
  const submitted = store.getTicket(project, delivered.ref);
  const base = gitAt(worktree, ['rev-parse', `${candidate}^`]);
  Object.assign(submitted.submission, {
    base, upstream: 'origin/main', upstreamCommit: base, integrationBranch: 'main',
    commits: [candidate], changedPaths: ['docs/guide.md'],
  });
  persistTicket(project, submitted);

  const liveSibling = store.createTicket(project, {
    title: 'live prose sibling', files: ['docs'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm declared scope without a candidate cannot block recorded delivery',
  });
  assert.equal(store.claimTicket(project, liveSibling.ref, 'live-prose-worker', {
    direct: true, reason: 'The delivery reconciliation fixture requires a local direct claim.',
  }).ok, true);

  const closed = await callTool('groomClose', {
    project: worktree, ref: delivered.ref, by: 'delivery-integrator', deliveryCommit: candidate,
    reason: 'The integration branch already contains the candidate.',
  });
  assert.equal(closed.ok, true, closed.message || closed.reason);
  assert.equal(store.getTicket(project, delivered.ref).status, 'done');
  assert.equal(store.getTicket(project, liveSibling.ref).claim.by, 'live-prose-worker');
});

export {};
