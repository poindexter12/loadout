'use strict';
// SQ-137: one topic shard of the former integration-advance.test.ts, split so the runner can spread its tests
// across workers. Shared setup and helpers live in ./_integration-advance-fixture.ts; the tests are moved unchanged.
import {
  test,
  assert,
  fs,
  path,
  store,
  mcp,
  worktrees,
  exploration,
  git,
  head,
  commitFile,
  makeRepo,
  submitFixture,
  deliveryTicket,
  squashReviewedDescendant,
  squashThenLaterChange,
  nodeVerify,
} from './_integration-advance-fixture.js';

test('a manual delivery of the pinned candidate accepts working-tree content from its reviewed descendant', () => {
  const { fixture, slug, ticket, interaction } = squashReviewedDescendant('manual-descendant', 'manual reviewed fix\n');

  const withoutInteraction = store.recordDeliveredSubmission(slug, ticket.ref, {
    target: store.integrationTarget(slug),
    deliveryCommit: fixture.submitted,
    deliveryMethod: 'manual',
    reason: 'The working tree carries the reviewed fix, not the pinned candidate alone.',
  });
  assert.equal(withoutInteraction.ok, false);
  assert.equal(withoutInteraction.reason, 'delivery_content_missing');

  const delivered = store.completeTicketAsControlPlane(slug, ticket.ref, {
    purpose: 'delivery',
    by: 'orchestrator',
    reason: 'The pinned candidate plus its reviewed fix is present on the integration tree.',
    deliveryCommit: fixture.submitted,
    deliveryMethod: 'manual',
    deliveryInteractionCommit: interaction,
  });
  assert.equal(delivered.ok, true, delivered.message);
  const stored = store.getTicket(slug, ticket.ref);
  assert.equal(stored.status, 'done');
  assert.equal(stored.submission.integration.deliveryIdentity.kind, 'reviewed-candidate-descendant');
  assert.equal(stored.submission.integration.deliveryIdentity.method, 'manual');
  assert.equal(stored.submission.integration.deliveryIdentity.interaction.commit, interaction);
  assert.equal(stored.submission.integration.contentEvidence, 'working_tree_matches_candidate:reviewed_candidate_descendant');
});

test('a reviewed candidate descendant is refused when it leaves submitted paths or the delivery lacks its content', () => {
  const { slug, ticket, review, squash } = squashReviewedDescendant('refused-descendant', 'refused reviewed fix\n');
  const outside = commitFile(review, 'unrelated.txt', 'outside the candidate\n');
  const outsideResult = store.recordDeliveredSubmission(slug, ticket.ref, {
    target: store.integrationTarget(slug),
    deliveryCommit: squash,
    deliveryInteractionCommit: outside,
    reason: 'The descendant also changes a path the candidate never submitted.',
  });
  assert.equal(outsideResult.ok, false);
  assert.equal(outsideResult.reason, 'delivery_interaction_outside_candidate');
  assert.deepEqual(outsideResult.unrelatedPaths, ['unrelated.txt']);

  git(['checkout', '-b', `divergent-refused`, `${outside}~1`], review);
  const divergent = commitFile(review, 'feature.txt', 'a different fix that never landed\n');
  const divergentResult = store.recordDeliveredSubmission(slug, ticket.ref, {
    target: store.integrationTarget(slug),
    deliveryCommit: squash,
    deliveryInteractionCommit: divergent,
    reason: 'The named descendant is not what the squash delivered.',
  });
  assert.equal(divergentResult.ok, false);
  assert.equal(divergentResult.reason, 'delivery_content_missing');
  assert.match(divergentResult.message, new RegExp(`reviewed descendant ${divergent}`));
  assert.notEqual(store.getTicket(slug, ticket.ref).status, 'done');
});

test('SQ-322: a manual delivery of a squash-landed candidate closes after a later commit changes its paths', () => {
  const { fixture, slug, ticket, landing, later } = squashThenLaterChange('squash-later-found');
  assert.equal(head(fixture.repo), later);
  assert.notEqual(fs.readFileSync(path.join(fixture.repo, 'feature.txt'), 'utf8'), 'executor work\n');

  const delivered = store.completeTicketAsControlPlane(slug, ticket.ref, {
    purpose: 'delivery',
    by: 'orchestrator',
    reason: 'PR #156 squash-merged the pinned candidate; PR #158 later changed feature.txt.',
    deliveryCommit: fixture.submitted,
    deliveryMethod: 'manual',
  });
  assert.equal(delivered.ok, true, delivered.message);
  const stored = store.getTicket(slug, ticket.ref);
  assert.equal(stored.status, 'done');
  const integration = stored.submission.integration;
  assert.equal(integration.contentEvidence, 'landed_candidate_content');
  assert.equal(integration.deliveryIdentity.kind, 'landed-candidate-content');
  assert.equal(integration.deliveryIdentity.landingCommit, landing);
  assert.equal(integration.deliveryIdentity.candidate, fixture.submitted);
  assert.equal(integration.deliveryCommit, fixture.submitted);
  assert.equal(integration.contentCommit, landing);
  assert.equal(integration.resultingHead, later);
  assert.deepEqual(integration.deliveredFiles, ['feature.txt']);
});

test('SQ-322: naming the squash landing commit records delivery after a later commit changes its paths', () => {
  const { slug, ticket, landing } = squashThenLaterChange('squash-later-named');
  const delivered = store.completeTicketAsControlPlane(slug, ticket.ref, {
    purpose: 'delivery',
    by: 'orchestrator',
    reason: 'Squash commit of PR #156 is on main; a later PR changed feature.txt.',
    deliveryCommit: landing,
    deliveryMethod: 'manual',
  });
  assert.equal(delivered.ok, true, delivered.message);
  const stored = store.getTicket(slug, ticket.ref);
  assert.equal(stored.status, 'done');
  assert.equal(stored.submission.integration.deliveryCommit, landing);
});

test('SQ-322: a manual delivery is still refused when no commit on the branch ever carried the candidate content', () => {
  const { fixture, slug, ticket } = squashThenLaterChange('squash-later-never', 'a different change that is not the candidate\n');
  const refused = store.completeTicketAsControlPlane(slug, ticket.ref, {
    purpose: 'delivery',
    by: 'orchestrator',
    reason: 'Claims the candidate landed, but no branch commit ever held its content.',
    deliveryCommit: fixture.submitted,
    deliveryMethod: 'manual',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'delivery_content_missing');
  assert.match(refused.message, /feature\.txt/);
  assert.notEqual(store.getTicket(slug, ticket.ref).status, 'done');
});

test('SQ-322: a squash-landed reviewed descendant closes through deliveryInteractionCommit after a later change', () => {
  const fixture = makeRepo('descendant-later');
  const { slug } = store.ensureProject(fixture.repo);
  const ticket = store.createTicket(slug, {
    title: 'reviewed descendant squash then later change',
    category: 'codebase-exploration',
    description: 'A candidate plus reviewed fix squash-merged, then a later PR changed its path.',
    files: ['feature.txt'],
  });
  submitFixture(slug, ticket, fixture);
  const review = path.join(fixture.repo, '.claude', 'worktrees', 'review-descendant-later');
  git(['worktree', 'add', '-b', 'review-descendant-later', review, fixture.submitted], fixture.repo);
  const interaction = commitFile(review, 'feature.txt', 'reviewed fix\n');
  git(['merge', '--squash', 'review-descendant-later'], fixture.repo);
  git(['commit', '-m', 'squash reviewed candidate'], fixture.repo);
  const squash = head(fixture.repo);
  commitFile(fixture.repo, 'feature.txt', 'a later PR changed this submitted path\n');

  // The pinned candidate's own content never landed, only the reviewed fix did.
  const withoutInteraction = store.recordDeliveredSubmission(slug, ticket.ref, {
    target: store.integrationTarget(slug),
    deliveryCommit: fixture.submitted,
    deliveryMethod: 'manual',
    reason: 'Names the candidate alone, whose exact content never reached main.',
  });
  assert.equal(withoutInteraction.ok, false);
  assert.equal(withoutInteraction.reason, 'delivery_content_missing');

  const delivered = store.recordDeliveredSubmission(slug, ticket.ref, {
    target: store.integrationTarget(slug),
    deliveryCommit: fixture.submitted,
    deliveryMethod: 'manual',
    deliveryInteractionCommit: interaction,
    reason: 'PR squash-merged the candidate plus reviewed fix; a later PR changed feature.txt.',
  });
  assert.equal(delivered.ok, true, delivered.message);
  assert.equal(delivered.integration.deliveryIdentity.kind, 'reviewed-candidate-descendant');
  assert.equal(delivered.integration.deliveryIdentity.landingCommit, squash);
  assert.equal(delivered.integration.deliveryIdentity.interaction.commit, interaction);
  assert.equal(delivered.integration.contentEvidence, 'landed_candidate_content:reviewed_candidate_descendant');
});

// SQ-158: groomClose's manual delivery targets a wave branch, but by the time
// the orchestrator records the delivery, that wave branch's PR has already
// merged into the checked-out branch (main) — and GitHub may have deleted the
// wave branch entirely. The guard must accept the delivery from main once the
// target (or the delivery commit itself) is an ancestor of HEAD, the same way
// SQ-99 accepts a reviewed descendant standing in for the pinned candidate.
test('a manual delivery accepts a wave branch target once it has merged into the checked-out branch', () => {
  const fixture = makeRepo('wave-merged');
  const { slug } = store.ensureProject(fixture.repo);
  const ticket = store.createTicket(slug, {
    title: 'wave branch merged into main',
    category: 'codebase-exploration',
    description: 'A wave branch delivery recorded from main after the wave PR merged and the branch was deleted.',
    files: ['feature.txt'],
  });
  submitFixture(slug, ticket, fixture);

  const waveBranch = 'sidequest/wave/wave-merged';
  const wave = path.join(fixture.repo, '.claude', 'worktrees', 'wave-merged-wt');
  git(['worktree', 'add', '-b', waveBranch, wave, fixture.submitted], fixture.repo);
  git(['merge', '--ff-only', waveBranch], fixture.repo);
  const mainHead = head(fixture.repo);
  git(['worktree', 'remove', '--force', wave], fixture.repo);
  git(['branch', '-D', waveBranch], fixture.repo);

  const delivered = store.recordDeliveredSubmission(slug, ticket.ref, {
    target: { mode: 'local', branch: waveBranch, upstream: waveBranch },
    deliveryCommit: mainHead,
    deliveryMethod: 'manual',
    reason: 'The wave branch merged into main and was deleted; recording the manual delivery from main.',
  });
  assert.equal(delivered.ok, true, delivered.message);
  assert.equal(delivered.integration.deliveryCommit, mainHead);
  assert.equal(delivered.integration.targetBranch, waveBranch);
  assert.equal(delivered.integration.resultingHead, mainHead);
});

test('a manual delivery is still refused when the wave branch has not merged into the checked-out branch', () => {
  const fixture = makeRepo('wave-unmerged');
  const { slug } = store.ensureProject(fixture.repo);
  const ticket = store.createTicket(slug, {
    title: 'wave branch not yet merged',
    category: 'codebase-exploration',
    description: 'A wave branch delivery attempted from main before the wave PR ever merged.',
    files: ['feature.txt'],
  });
  submitFixture(slug, ticket, fixture);

  const waveBranch = 'sidequest/wave/wave-unmerged';
  const wave = path.join(fixture.repo, '.claude', 'worktrees', 'wave-unmerged-wt');
  git(['worktree', 'add', '-b', waveBranch, wave, fixture.submitted], fixture.repo);
  git(['worktree', 'remove', '--force', wave], fixture.repo);

  const result = store.recordDeliveredSubmission(slug, ticket.ref, {
    target: { mode: 'local', branch: waveBranch, upstream: waveBranch },
    deliveryCommit: fixture.submitted,
    deliveryMethod: 'manual',
    reason: 'The wave branch has not merged into main; this delivery must still be refused.',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'branch_not_checked_out');
});

test('a manual delivery reads the target branch from a linked worktree instead of the canonical root', () => {
  const fixture = makeRepo('wave-worktree');
  const { slug } = store.ensureProject(fixture.repo);
  const ticket = store.createTicket(slug, {
    title: 'wave branch checked out in a linked worktree',
    category: 'codebase-exploration',
    description: 'A wave branch delivery recorded while the wave branch is checked out in a linked worktree, not the canonical root.',
    files: ['feature.txt'],
  });
  submitFixture(slug, ticket, fixture);

  const waveBranch = 'sidequest/wave/wave-worktree';
  const wave = path.join(fixture.repo, '.claude', 'worktrees', 'wave-worktree-wt');
  git(['worktree', 'add', '-b', waveBranch, wave, fixture.submitted], fixture.repo);

  const result = store.recordDeliveredSubmission(slug, ticket.ref, {
    target: { mode: 'local', branch: waveBranch, upstream: waveBranch },
    deliveryCommit: fixture.submitted,
    deliveryMethod: 'manual',
    reason: 'The wave branch is checked out in a linked worktree, not the canonical project root.',
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.integration.deliveryCommit, fixture.submitted);
  assert.equal(result.integration.resultingHead, fixture.submitted);
  assert.equal(result.integration.targetBranch, waveBranch);
});

// SQ-344: a worktree directory deleted without `git worktree remove` keeps holding its branch
// in git's administrative records, and `git worktree list --porcelain` marks the record
// `prunable` on a line AFTER `branch`. The lookup used to answer at the branch line and hand
// back a path that no longer exists, so git was spawned into a missing cwd and the delivery
// was refused as `delivery_evidence_unavailable` — blaming the evidence for a stale
// registration. The refusal must name the real problem instead.
test('a manual delivery refuses on the branch, not the evidence, when the target worktree directory was deleted', () => {
  const fixture = makeRepo('wave-prunable');
  const { slug } = store.ensureProject(fixture.repo);
  const ticket = store.createTicket(slug, {
    title: 'wave branch held by a deleted worktree',
    category: 'codebase-exploration',
    description: 'A wave branch still registered to a worktree whose directory was deleted without git worktree remove.',
    files: ['feature.txt'],
  });
  submitFixture(slug, ticket, fixture);

  const waveBranch = 'sidequest/wave/wave-prunable';
  const wave = path.join(fixture.repo, '.claude', 'worktrees', 'wave-prunable-wt');
  git(['worktree', 'add', '-b', waveBranch, wave, fixture.submitted], fixture.repo);
  fs.rmSync(wave, { recursive: true, force: true });
  assert.match(git(['worktree', 'list', '--porcelain'], fixture.repo), /\nprunable/);

  const result = store.recordDeliveredSubmission(slug, ticket.ref, {
    target: { mode: 'local', branch: waveBranch, upstream: waveBranch },
    deliveryCommit: fixture.submitted,
    deliveryMethod: 'manual',
    reason: 'The wave branch has not merged into main and its worktree directory is gone.',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'branch_not_checked_out');
});

test('a manual delivery accepts a merged wave branch whose worktree directory was deleted', () => {
  const fixture = makeRepo('wave-prunable-merged');
  const { slug } = store.ensureProject(fixture.repo);
  const ticket = store.createTicket(slug, {
    title: 'merged wave branch held by a deleted worktree',
    category: 'codebase-exploration',
    description: 'A merged wave branch still registered to a worktree whose directory was deleted.',
    files: ['feature.txt'],
  });
  submitFixture(slug, ticket, fixture);

  const waveBranch = 'sidequest/wave/wave-prunable-merged';
  const wave = path.join(fixture.repo, '.claude', 'worktrees', 'wave-prunable-merged-wt');
  git(['worktree', 'add', '-b', waveBranch, wave, fixture.submitted], fixture.repo);
  git(['merge', '--ff-only', waveBranch], fixture.repo);
  const mainHead = head(fixture.repo);
  fs.rmSync(wave, { recursive: true, force: true });

  const delivered = store.recordDeliveredSubmission(slug, ticket.ref, {
    target: { mode: 'local', branch: waveBranch, upstream: waveBranch },
    deliveryCommit: mainHead,
    deliveryMethod: 'manual',
    reason: 'The wave branch merged into main; its leaked worktree directory must not block the record.',
  });
  assert.equal(delivered.ok, true, delivered.message);
  assert.equal(delivered.integration.targetBranch, waveBranch);
  assert.equal(delivered.integration.resultingHead, mainHead);
});

// Locking suppresses the prunable line entirely, so a locked worktree whose directory is gone
// reports only `locked` — the same dead path by a different name.
test('a manual delivery accepts a merged wave branch whose locked worktree directory was deleted', () => {
  const fixture = makeRepo('wave-locked-merged');
  const { slug } = store.ensureProject(fixture.repo);
  const ticket = store.createTicket(slug, {
    title: 'merged wave branch held by a deleted locked worktree',
    category: 'codebase-exploration',
    description: 'A merged wave branch still registered to a locked worktree whose directory was deleted.',
    files: ['feature.txt'],
  });
  submitFixture(slug, ticket, fixture);

  const waveBranch = 'sidequest/wave/wave-locked-merged';
  const wave = path.join(fixture.repo, '.claude', 'worktrees', 'wave-locked-merged-wt');
  git(['worktree', 'add', '-b', waveBranch, wave, fixture.submitted], fixture.repo);
  git(['merge', '--ff-only', waveBranch], fixture.repo);
  const mainHead = head(fixture.repo);
  git(['worktree', 'lock', wave], fixture.repo);
  fs.rmSync(wave, { recursive: true, force: true });
  const listing = git(['worktree', 'list', '--porcelain'], fixture.repo);
  assert.match(listing, /\nlocked/);
  assert.doesNotMatch(listing, /\nprunable/);

  const delivered = store.recordDeliveredSubmission(slug, ticket.ref, {
    target: { mode: 'local', branch: waveBranch, upstream: waveBranch },
    deliveryCommit: mainHead,
    deliveryMethod: 'manual',
    reason: 'The wave branch merged into main; its locked, deleted worktree must not block the record.',
  });
  assert.equal(delivered.ok, true, delivered.message);
  assert.equal(delivered.integration.targetBranch, waveBranch);
  assert.equal(delivered.integration.resultingHead, mainHead);
});

test('groomClose delivers a landed candidate despite an overlapping pending sibling candidate', async () => {
  const fixture = makeRepo('gc-ovl');
  const { slug } = store.ensureProject(fixture.repo);
  const participant = store.createTicket(slug, {
    title: 'landed participant candidate',
    category: 'codebase-exploration',
    description: 'A candidate already present on the integration branch.',
    files: ['feature.txt'],
  });
  submitFixture(slug, participant, fixture);
  git(['cherry-pick', fixture.submitted], fixture.repo);
  const landedCommit = head(fixture.repo);

  const siblingWorktree = path.join(fixture.repo, '.claude', 'worktrees', 'agent-ovl');
  git(['worktree', 'add', '-b', 'worktree-agent-ovl', siblingWorktree, 'main'], fixture.repo);
  const siblingCommit = commitFile(siblingWorktree, 'feature.txt', 'overlapping sibling candidate\n');
  const sibling = store.createTicket(slug, {
    title: 'overlapping pending sibling candidate',
    category: 'codebase-exploration',
    description: 'A pending candidate that shares the participant surface.',
    files: ['feature.txt'],
  });
  submitFixture(slug, sibling, { ...fixture, executor: siblingWorktree, submitted: siblingCommit });

  const assembled = store.assembleSubmissionWave(slug, [participant.ref]);
  assert.equal(assembled.ok, false);
  assert.equal(assembled.reason, 'candidate_overlap');

  const response = await mcp.handleRequest({
    jsonrpc: '2.0',
    id: 2435,
    method: 'tools/call',
    params: {
      name: 'groomClose',
      arguments: {
        project: fixture.repo,
        ref: participant.ref,
        by: 'orchestrator',
        reason: 'The participant candidate is already reachable on main.',
        deliveryCommit: landedCommit,
      },
    },
  });

  assert.ok(response.result, JSON.stringify(response));
  assert.ok(!response.result.isError, response.result.content?.[0]?.text);
  const closed = JSON.parse(response.result.content[0].text);
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(store.getTicket(slug, participant.ref).status, 'done');
  assert.equal(store.getTicket(slug, participant.ref).submission.integration.deliveryCommit, landedCommit);
  assert.equal(store.getTicket(slug, sibling.ref).submission.commit, siblingCommit);
});

for (const mode of ['merge', 'replay', 'apply']) {
  test(`integrate ${mode} delivers a ready submission and preserves its pinned ref`, () => {
    const { fixture, slug, ticket, runCli } = deliveryTicket(mode);
    const before = head(fixture.repo);
    const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--mode', mode, '--json']);

    assert.equal(result.status, 0, result.stderr + result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.verify.status, 'passed');
    assert.match(payload.ticket.completion.reason, /Verify passed:/);
    assert.equal(payload.delivery.mode, mode);
    assert.equal(payload.delivery.pinnedRef, `refs/sidequest/${ticket.ref}`);
    assert.equal(payload.delivery.pinnedCommit, fixture.submitted);
    assert.equal(git(['rev-parse', `refs/sidequest/${ticket.ref}`], fixture.repo), fixture.submitted);
    assert.equal(store.getTicket(slug, ticket.ref).status, 'done');
    if (mode === 'apply') {
      assert.equal(head(fixture.repo), before);
      assert.deepEqual(payload.delivery.dirtyFiles, ['feature.txt']);
      assert.equal(fs.readFileSync(path.join(fixture.repo, 'feature.txt'), 'utf8'), 'executor work\n');
    } else {
      assert.notEqual(head(fixture.repo), before);
      assert.equal(fs.readFileSync(path.join(fixture.repo, 'feature.txt'), 'utf8'), 'executor work\n');
    }
  });
}

for (const mode of ['merge', 'replay', 'apply']) {
  test(`integrate ${mode} verifies the delivered result`, () => {
    const { fixture, slug, ticket, runCli } = deliveryTicket(`verify-result-${mode}`, {
      verify: nodeVerify("require('node:fs').accessSync('feature.txt')"),
    });
    const before = head(fixture.repo);
    const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--mode', mode, '--json']);

    assert.equal(result.status, 0, result.stderr + result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.verify.status, 'passed');
    assert.ok(fs.existsSync(payload.verify.logPath));
    assert.equal(store.getTicket(slug, ticket.ref).status, 'done');
    if (mode === 'apply') assert.equal(head(fixture.repo), before);
    else assert.notEqual(head(fixture.repo), before);
  });
}

export {};
