'use strict';
// SQ-137: one topic shard of the former integration-advance.test.ts, split so the runner can spread its tests
// across workers. Shared setup and helpers live in ./_integration-advance-fixture.ts; the tests are moved unchanged.
import {
  test,
  assert,
  fs,
  os,
  path,
  execFileSync,
  SIDEQUEST_HOME,
  store,
  commitScope,
  worktrees,
  makeCliRunner,
  BIN,
  exploration,
  git,
  head,
  commitFile,
  makeRepo,
  advance,
  submitFixture,
  squashReviewedDescendant,
  nodeVerify,
} from './_integration-advance-fixture.js';

test('one passing wave delivers its exact Git participant set before recording delivery', () => {
  const fixture = makeRepo('wave-delivery');
  const secondWorktree = path.join(fixture.repo, '.claude', 'worktrees', 'agent-second');
  git(['worktree', 'add', '-b', 'worktree-agent-second', secondWorktree, 'main'], fixture.repo);
  const secondCommit = commitFile(secondWorktree, 'second.txt', 'second executor work\n');
  const { slug } = store.ensureProject(fixture.repo);
  const first = store.createTicket(slug, {
    title: 'deliver first wave candidate',
    category: 'codebase-exploration',
    description: 'Deliver the first independent candidate.',
    files: ['feature.txt'],
  });
  const second = store.createTicket(slug, {
    title: 'deliver second wave candidate',
    category: 'codebase-exploration',
    description: 'Deliver the second independent candidate.',
    files: ['second.txt'],
  });
  submitFixture(slug, first, fixture);
  const secondRef = `refs/sidequest/${second.ref}`;
  git(['update-ref', secondRef, secondCommit], secondWorktree);
  const target = store.integrationTarget(slug);
  const secondRange = commitScope.submissionRange(secondWorktree, {
    commit: secondCommit,
    gitRef: secondRef,
    upstream: target.upstream,
    integrationBranch: target.branch,
  });
  assert.equal(secondRange.ok, true, JSON.stringify(secondRange));
  assert.equal(store.claimTicket(slug, second.ref, 'second-fixture-worker', { direct: true, reason: 'The integration fixture requires a local direct claim.' }).ok, true);
  assert.equal(store.submitTicket(slug, second.ref, 'second-fixture-worker', {
    commit: secondCommit,
    gitRef: secondRef,
    range: secondRange,
    worktree: secondWorktree,
  }).ok, true);

  const wave = store.assembleSubmissionWave(slug, [first.ref, second.ref], {
    verification: store.getTicket(slug, first.ref).submission.verificationResult,
  });
  assert.equal(wave.ok, true, JSON.stringify(wave));
  assert.equal(wave.gate.state, 'gate_passed');
  const individual = store.integrateSubmission(slug, first.ref, { mode: 'merge', target });
  assert.equal(individual.ok, false);
  assert.equal(individual.reason, 'assembled_wave_delivery_required');

  const { runCli } = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: fixture.repo }, { cwd: fixture.repo });
  const result = runCli(['integrate', first.ref, second.ref, '--by', 'orchestrator', '--mode', 'merge', '--json']);

  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.delivery.participants, [first.ref, second.ref]);
  assert.equal(head(fixture.repo), payload.delivery.resultingHead);
  assert.equal(fs.readFileSync(path.join(fixture.repo, 'feature.txt'), 'utf8'), 'executor work\n');
  assert.equal(fs.readFileSync(path.join(fixture.repo, 'second.txt'), 'utf8'), 'second executor work\n');
  for (const ticketRef of [first.ref, second.ref]) {
    const stored = store.getTicket(slug, ticketRef);
    assert.equal(stored.status, 'done');
    assert.equal(stored.submission.wave.state, 'delivered');
    assert.equal(stored.submission.integration.outcome, 'verified');
    assert.equal(stored.submission.integration.resultingHead, payload.delivery.resultingHead);
  }
});

test('sequential singleton waves use the selected local integration branch after it advances past origin', () => {
  const fixture = makeRepo('sequential-local-wave');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-advance-bare-'));
  execFileSync('git', ['init', '-b', 'main', '--bare', bare], { encoding: 'utf8', windowsHide: true });
  git(['remote', 'add', 'origin', bare], fixture.repo);
  git(['push', '-u', 'origin', 'main'], fixture.repo);
  const { slug } = store.ensureProject(fixture.repo);
  const target = { mode: 'local', branch: 'main', upstream: 'main' };
  const first = store.createTicket(slug, {
    title: 'first sequential local candidate',
    category: 'codebase-exploration',
    description: 'Advances local main without pushing origin.',
    files: ['feature.txt'],
  });
  submitFixture(slug, first, fixture);
  const firstDelivery = store.integrateSubmission(slug, first.ref, { mode: 'merge', target });
  assert.equal(firstDelivery.ok, true, JSON.stringify(firstDelivery));
  assert.notEqual(head(fixture.repo, 'main'), head(fixture.repo, 'origin/main'));

  const secondWorktree = path.join(fixture.repo, '.claude', 'worktrees', 'agent-sequential-second');
  git(['worktree', 'add', '-b', 'worktree-agent-sequential-second', secondWorktree, 'main'], fixture.repo);
  const secondCommit = commitFile(secondWorktree, 'second.txt', 'second sequential executor work\n');
  const second = store.createTicket(slug, {
    title: 'second sequential local candidate',
    category: 'codebase-exploration',
    description: 'Must assemble against the advanced local integration branch.',
    files: ['second.txt'],
  });
  const secondRef = `refs/sidequest/${second.ref}`;
  git(['update-ref', secondRef, secondCommit], secondWorktree);
  const secondRange = commitScope.submissionRange(secondWorktree, {
    commit: secondCommit,
    gitRef: secondRef,
    upstream: target.upstream,
    integrationBranch: target.branch,
  });
  assert.equal(secondRange.ok, true, JSON.stringify(secondRange));
  assert.equal(store.claimTicket(slug, second.ref, 'sequential-second-worker', { direct: true, reason: 'The sequential local integration fixture needs a direct claim.' }).ok, true);
  assert.equal(store.submitTicket(slug, second.ref, 'sequential-second-worker', {
    commit: secondCommit,
    gitRef: secondRef,
    range: secondRange,
    worktree: secondWorktree,
  }).ok, true);

  const secondBase = head(fixture.repo, 'main');
  const secondDelivery = store.integrateSubmission(slug, second.ref, { mode: 'merge', target });
  assert.equal(secondDelivery.ok, true, JSON.stringify(secondDelivery));
  assert.equal(secondDelivery.ticket.submission.wave.baseline.revision.value, secondBase);
  assert.equal(fs.readFileSync(path.join(fixture.repo, 'second.txt'), 'utf8'), 'second sequential executor work\n');
});

test('SQ-59: remote-mode integrate assembles a candidate based on local main that is ahead of an unpushed origin', () => {
  // Auto mode with an origin resolves to remote, so the configured target
  // names origin/main. Delivery still merges into the checked-out local
  // branch, and an isolated dispatch bases on local main when it is ahead of
  // origin. Pinning the wave to origin/main refused that candidate as
  // baseline_moved although merging it into local main is a clean fast-forward.
  const fixture = makeRepo('remote-local-ahead');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-advance-bare-'));
  execFileSync('git', ['init', '-b', 'main', '--bare', bare], { encoding: 'utf8', windowsHide: true });
  git(['remote', 'add', 'origin', bare], fixture.repo);
  git(['push', '-u', 'origin', 'main'], fixture.repo);
  const unpushed = commitFile(fixture.repo, 'unpushed.txt', 'local main is ahead of origin\n');
  assert.notEqual(unpushed, head(fixture.repo, 'origin/main'));
  const { slug } = store.ensureProject(fixture.repo);
  const target = store.integrationTarget(slug);
  assert.deepEqual(target, { mode: 'remote', upstream: 'origin/main', branch: 'main' });

  const worktree = path.join(fixture.repo, '.claude', 'worktrees', 'agent-remote-local-ahead');
  git(['worktree', 'add', '-b', 'worktree-agent-remote-local-ahead', worktree, 'main'], fixture.repo);
  const candidate = commitFile(worktree, 'ahead.txt', 'work based on local main\n');
  const ticket = store.createTicket(slug, {
    title: 'candidate based on local main ahead of origin',
    category: 'codebase-exploration',
    description: 'Its baseline is local main, which origin/main does not contain.',
    files: ['ahead.txt'],
  });
  const gitRef = `refs/sidequest/${ticket.ref}`;
  git(['update-ref', gitRef, candidate], worktree);
  const range = commitScope.submissionRange(worktree, { commit: candidate, gitRef, upstream: 'main', integrationBranch: 'main' });
  assert.equal(range.ok, true, JSON.stringify(range));
  assert.equal(store.claimTicket(slug, ticket.ref, 'remote-ahead-worker', { direct: true, reason: 'The remote local-ahead fixture needs a direct claim.' }).ok, true);
  const submitted = store.submitTicket(slug, ticket.ref, 'remote-ahead-worker', { commit: candidate, gitRef, range, worktree });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  assert.equal(store.getTicket(slug, ticket.ref).submission.baseline.revision.value, unpushed);

  const originBefore = head(fixture.repo, 'origin/main');
  const delivered = store.integrateSubmission(slug, ticket.ref, { mode: 'merge', target });
  assert.equal(delivered.ok, true, JSON.stringify(delivered));
  assert.equal(delivered.ticket.submission.wave.baseline.revision.value, unpushed);
  assert.equal(fs.readFileSync(path.join(fixture.repo, 'ahead.txt'), 'utf8'), 'work based on local main\n');
  assert.equal(head(fixture.repo, 'origin/main'), originBefore, 'integrate never moves the remote-tracking ref');
});

test('SQ-59: remote-mode wave stays pinned to origin when local main has diverged from it', () => {
  // The local branch is only preferred when it contains the upstream commit.
  // A local branch beside origin keeps the upstream pin, so a candidate based
  // on origin/main (which that local branch lacks) is still admitted.
  const fixture = makeRepo('remote-local-diverged');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-advance-bare-'));
  execFileSync('git', ['init', '-b', 'main', '--bare', bare], { encoding: 'utf8', windowsHide: true });
  git(['remote', 'add', 'origin', bare], fixture.repo);
  git(['push', '-u', 'origin', 'main'], fixture.repo);
  const pushedBase = head(fixture.repo, 'main');
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-advance-other-'));
  git(['clone', bare, other], os.tmpdir());
  git(['config', 'user.name', 'Sidequest Test'], other);
  git(['config', 'user.email', 'sidequest-test@example.invalid'], other);
  const remoteOnly = commitFile(other, 'remote-only.txt', 'pushed elsewhere\n');
  git(['push', 'origin', 'main'], other);
  git(['fetch', 'origin'], fixture.repo);
  git(['merge', '--ff-only', 'origin/main'], fixture.repo);
  const { slug } = store.ensureProject(fixture.repo);
  const target = store.integrationTarget(slug);
  assert.equal(target.upstream, 'origin/main');

  const worktree = path.join(fixture.repo, '.claude', 'worktrees', 'agent-remote-diverged');
  git(['worktree', 'add', '-b', 'worktree-agent-remote-diverged', worktree, 'main'], fixture.repo);
  const candidate = commitFile(worktree, 'beside.txt', 'work based on origin/main\n');
  const ticket = store.createTicket(slug, {
    title: 'candidate against a diverged local main',
    category: 'codebase-exploration',
    description: 'Wave must stay pinned to origin/main.',
    files: ['beside.txt'],
  });
  const gitRef = `refs/sidequest/${ticket.ref}`;
  git(['update-ref', gitRef, candidate], worktree);
  const range = commitScope.submissionRange(worktree, { commit: candidate, gitRef, upstream: target.upstream, integrationBranch: target.branch });
  assert.equal(range.ok, true, JSON.stringify(range));
  assert.equal(store.claimTicket(slug, ticket.ref, 'remote-diverged-worker', { direct: true, reason: 'The remote diverged fixture needs a direct claim.' }).ok, true);
  const submitted = store.submitTicket(slug, ticket.ref, 'remote-diverged-worker', { commit: candidate, gitRef, range, worktree });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  assert.equal(store.getTicket(slug, ticket.ref).submission.baseline.revision.value, remoteOnly);

  // Local main now sits beside origin/main: it lacks remoteOnly.
  git(['reset', '--hard', pushedBase], fixture.repo);
  commitFile(fixture.repo, 'local-only.txt', 'unpushed local\n');
  const delivered = store.integrateSubmission(slug, ticket.ref, { mode: 'merge', target });
  assert.equal(delivered.ok, true, JSON.stringify(delivered));
  assert.equal(delivered.ticket.submission.wave.baseline.revision.value, remoteOnly);
});

test('an assembled wave preserves candidates, refuses unrelated grooming delivery, and refuses singleton integration', () => {
  const fixture = makeRepo('refused-wave-keeps-candidates');
  const secondWorktree = path.join(fixture.repo, '.claude', 'worktrees', 'agent-conflict');
  git(['worktree', 'add', '-b', 'worktree-agent-conflict', secondWorktree, 'main'], fixture.repo);
  const secondCommit = commitFile(secondWorktree, 'feature.txt', 'conflicting executor work\n');
  const { slug } = store.ensureProject(fixture.repo);
  const first = store.createTicket(slug, {
    title: 'first conflicting wave candidate',
    category: 'codebase-exploration',
    description: 'Keep its submitted candidate after a refused wave.',
    files: ['feature.txt'],
  });
  const second = store.createTicket(slug, {
    title: 'second conflicting wave candidate',
    category: 'codebase-exploration',
    description: 'Conflicts with the first candidate only at wave assembly.',
    files: ['feature.txt'],
  });
  submitFixture(slug, first, fixture);
  const secondRef = `refs/sidequest/${second.ref}`;
  git(['update-ref', secondRef, secondCommit], secondWorktree);
  const target = store.integrationTarget(slug);
  const secondRange = commitScope.submissionRange(secondWorktree, {
    commit: secondCommit,
    gitRef: secondRef,
    upstream: target.upstream,
    integrationBranch: target.branch,
  });
  assert.equal(secondRange.ok, true, JSON.stringify(secondRange));
  assert.equal(store.claimTicket(slug, second.ref, 'conflicting-fixture-worker', { direct: true, reason: 'The conflicting wave fixture needs a direct claim.' }).ok, true);
  assert.equal(store.submitTicket(slug, second.ref, 'conflicting-fixture-worker', {
    commit: secondCommit,
    gitRef: secondRef,
    range: secondRange,
    worktree: secondWorktree,
  }).ok, true);

  const assembled = store.assembleSubmissionWave(slug, [first.ref, second.ref], {
    verification: store.getTicket(slug, first.ref).submission.verificationResult,
  });

  assert.equal(assembled.ok, true, JSON.stringify(assembled));
  assert.deepEqual(assembled.assembly.candidates.map((candidate: any) => candidate.ref), [first.ref, second.ref]);
  for (const ticketRef of [first.ref, second.ref]) {
    const stored = store.getTicket(slug, ticketRef);
    assert.notEqual(stored.status, 'done');
    assert.notEqual(stored.submission.wave?.state, 'invalidated');
  }

  const unrelatedDelivery = commitFile(fixture.repo, 'unrelated.txt', 'unrelated reachable delivery\n');
  const unsafeGroomClose = store.completeTicketAsControlPlane(slug, first.ref, {
    purpose: 'delivery',
    by: 'orchestrator',
    reason: 'An unrelated reachable commit cannot consume the preserved candidate.',
    deliveryCommit: unrelatedDelivery,
  });

  assert.equal(unsafeGroomClose.ok, false);
  assert.equal(unsafeGroomClose.reason, 'delivery_content_missing');
  assert.match(unsafeGroomClose.message, /abandonSubmission: true/);
  const retained = store.getTicket(slug, first.ref);
  assert.notEqual(retained.status, 'done');
  assert.equal(retained.submission.commit, fixture.submitted);
  assert.equal(retained.submission.integratedAt, undefined);

  const individual = store.integrateSubmission(slug, first.ref, { mode: 'merge', target });
  assert.equal(individual.ok, false, JSON.stringify(individual));
  assert.equal(individual.reason, 'assembled_wave_delivery_required');
  assert.match(individual.message, new RegExp(assembled.assembly.waveId));
});

test('reviewed assembled-wave delivery records a landed source with its verified interaction and refuses unsafe substitutes', () => {
  const verify = nodeVerify("const fs=require('node:fs'); const {execFileSync}=require('node:child_process'); const branch=execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(); const expected=branch==='main'?'46.41\\n':'executor work\\n'; process.exit(fs.readFileSync('feature.txt','utf8')===expected?0:7)");
  const fixture = makeRepo('reviewed-wave-interaction');
  const { slug } = store.ensureProject(fixture.repo);
  const ticket = store.createTicket(slug, {
    title: 'reviewed merged-tree interaction',
    category: 'codebase-exploration',
    description: 'A candidate whose landed source needs a scoped interaction before merged-tree verification.',
    files: ['feature.txt'],
  });
  submitFixture(slug, ticket, fixture, verify);
  commitFile(fixture.repo, 'source-base.txt', 'main moved before the source replay\n');
  git(['cherry-pick', fixture.submitted], fixture.repo);
  const source = head(fixture.repo);
  const interaction = commitFile(fixture.repo, 'feature.txt', '46.41\n');
  const wave = store.assembleSubmissionWave(slug, [ticket.ref]);
  assert.equal(wave.ok, true, JSON.stringify(wave));
  assert.equal(wave.gate.state, 'gate_passed');

  const missingLineage = store.recordDeliveredSubmission(slug, ticket.ref, {
    target: store.integrationTarget(slug),
    deliveryCommit: fixture.submitted,
    deliveryInteractionCommit: interaction,
    reason: 'This source is not on the integration target.',
  });
  assert.equal(missingLineage.ok, false);
  assert.equal(missingLineage.reason, 'delivery_not_reachable');

  const unrelatedInteraction = commitFile(fixture.repo, 'unrelated.txt', 'substitution\n');
  const unrelated = store.recordDeliveredSubmission(slug, ticket.ref, {
    target: store.integrationTarget(slug),
    deliveryCommit: source,
    deliveryInteractionCommit: unrelatedInteraction,
    reason: 'This interaction changes a path outside the candidate.',
  });
  assert.equal(unrelated.ok, false);
  assert.equal(unrelated.reason, 'delivery_interaction_outside_candidate');

  const delivered = store.recordDeliveredSubmission(slug, ticket.ref, {
    target: store.integrationTarget(slug),
    deliveryCommit: source,
    deliveryInteractionCommit: interaction,
    reason: 'The accepted merged-tree interaction updates the landed candidate expectation.',
  });
  assert.equal(delivered.ok, true, delivered.message);
  assert.equal(delivered.integration.mode, 'recorded-reviewed-interaction');
  assert.equal(delivered.integration.verify.status, 'passed');
  assert.equal(delivered.integration.deliveryIdentity.kind, 'reviewed-merged-tree-interaction');
  assert.equal(delivered.integration.deliveryIdentity.sourceCommit, source);
  assert.equal(delivered.integration.deliveryIdentity.interaction.commit, interaction);
  assert.match(delivered.integration.contentEvidence, /reviewed_merged_tree_interaction/);
  assert.equal(store.getTicket(slug, ticket.ref).submission.wave.delivery.state, 'delivered');

  const ungatedFixture = makeRepo('ungated-reviewed-wave-interaction');
  const { slug: ungatedSlug } = store.ensureProject(ungatedFixture.repo);
  const ungatedTicket = store.createTicket(ungatedSlug, {
    title: 'ungated reviewed merged-tree interaction',
    category: 'codebase-exploration',
    description: 'A candidate that must not use the interaction route without a passing wave.',
    files: ['feature.txt'],
  });
  submitFixture(ungatedSlug, ungatedTicket, ungatedFixture, nodeVerify('process.exit(7)'));
  const ungatedWave = store.assembleSubmissionWave(ungatedSlug, [ungatedTicket.ref]);
  assert.equal(ungatedWave.ok, false);
  assert.equal(ungatedWave.reason, 'assembled_wave_gate_failed');
  const ungatedSource = commitFile(ungatedFixture.repo, 'feature.txt', 'landed source\n');
  const ungatedInteraction = commitFile(ungatedFixture.repo, 'feature.txt', 'landed interaction\n');
  const ungated = store.recordDeliveredSubmission(ungatedSlug, ungatedTicket.ref, {
    target: store.integrationTarget(ungatedSlug),
    deliveryCommit: ungatedSource,
    deliveryInteractionCommit: ungatedInteraction,
    reason: 'The wave gate was never accepted and the landed commit carries none of the candidate.',
  });
  assert.equal(ungated.ok, false);
  assert.equal(ungated.reason, 'delivery_content_missing');
});

test('control-plane delivery validates a reviewed interaction and keeps no-submission reachable closure', () => {
  const refusedFixture = makeRepo('control-plane-refused-interaction');
  const { slug: refusedSlug } = store.ensureProject(refusedFixture.repo);
  const refusedTicket = store.createTicket(refusedSlug, {
    title: 'refuse unrelated reviewed interaction delivery',
    category: 'codebase-exploration',
    description: 'A submitted candidate must not close against unrelated reachable delivery evidence.',
    files: ['feature.txt'],
  });
  submitFixture(refusedSlug, refusedTicket, refusedFixture);
  const unrelatedSource = commitFile(refusedFixture.repo, 'unrelated.txt', 'unrelated reachable source\n');

  const refused = store.completeTicketAsControlPlane(refusedSlug, refusedTicket.ref, {
    purpose: 'delivery',
    by: 'orchestrator',
    reason: 'An unrelated source and invalid interaction cannot consume the candidate.',
    deliveryCommit: unrelatedSource,
    deliveryInteractionCommit: 'deadbeef',
  });

  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'delivery_content_missing');
  const retained = store.getTicket(refusedSlug, refusedTicket.ref);
  assert.equal(retained.status, 'doing');
  assert.equal(retained.submission.commit, refusedFixture.submitted);
  assert.equal(retained.submission.integratedAt, undefined);

  const reviewedVerify = nodeVerify("const fs=require('node:fs'); const {execFileSync}=require('node:child_process'); const branch=execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(); const expected=branch==='main'?'reviewed result\\n':'executor work\\n'; process.exit(fs.readFileSync('feature.txt','utf8')===expected?0:7)");
  const reviewedFixture = makeRepo('control-plane-reviewed-interaction');
  const { slug: reviewedSlug } = store.ensureProject(reviewedFixture.repo);
  const reviewedTicket = store.createTicket(reviewedSlug, {
    title: 'accept reviewed descendant interaction delivery',
    category: 'codebase-exploration',
    description: 'A reviewed descendant interaction closes through the recorded-delivery validator.',
    files: ['feature.txt'],
  });
  submitFixture(reviewedSlug, reviewedTicket, reviewedFixture, reviewedVerify);
  git(['cherry-pick', reviewedFixture.submitted], reviewedFixture.repo);
  const reviewedSource = head(reviewedFixture.repo);
  const reviewedInteraction = commitFile(reviewedFixture.repo, 'feature.txt', 'reviewed result\n');

  const delivered = store.completeTicketAsControlPlane(reviewedSlug, reviewedTicket.ref, {
    purpose: 'delivery',
    by: 'orchestrator',
    reason: 'The reviewed descendant is present and verified on the integration tree.',
    deliveryCommit: reviewedSource,
    deliveryInteractionCommit: reviewedInteraction,
  });

  assert.equal(delivered.ok, true, delivered.message);
  const reviewed = store.getTicket(reviewedSlug, reviewedTicket.ref);
  assert.equal(reviewed.status, 'done');
  assert.equal(reviewed.submission.integration.mode, 'recorded-reviewed-interaction');
  assert.equal(reviewed.submission.integration.deliveryIdentity.sourceCommit, reviewedSource);
  assert.equal(reviewed.submission.integration.deliveryIdentity.interaction.commit, reviewedInteraction);
  assert.equal(reviewed.submission.integration.verify.status, 'passed');
  assert.equal(reviewed.submission.wave.delivery.state, 'delivered');

  const ordinaryFixture = makeRepo('control-plane-ordinary-reachable');
  const { slug: ordinarySlug } = store.ensureProject(ordinaryFixture.repo);
  const ordinaryTicket = store.createTicket(ordinarySlug, {
    title: 'preserve ordinary reachable delivery closure',
    category: 'codebase-exploration',
    description: 'A reachable hand delivery without a submitted candidate keeps its existing closure path.',
    files: ['feature.txt'],
  });
  const ordinaryDelivery = commitFile(ordinaryFixture.repo, 'ordinary.txt', 'ordinary reachable delivery\n');

  const ordinary = store.completeTicketAsControlPlane(ordinarySlug, ordinaryTicket.ref, {
    purpose: 'delivery',
    by: 'orchestrator',
    reason: 'The ordinary reachable delivery remains supported without a submission.',
    deliveryCommit: ordinaryDelivery,
  });

  assert.equal(ordinary.ok, true, ordinary.message);
  assert.equal(store.getTicket(ordinarySlug, ordinaryTicket.ref).status, 'done');
  assert.equal(ordinary.ticket.completion.delivery.commit, ordinaryDelivery);
});

test('a squash-merged reviewed descendant of the pinned candidate records delivery through deliveryInteractionCommit', () => {
  const { fixture, slug, ticket, interaction, squash } = squashReviewedDescendant('squash-descendant', 'reviewed fix\n');

  const withoutInteraction = store.recordDeliveredSubmission(slug, ticket.ref, {
    target: store.integrationTarget(slug),
    deliveryCommit: squash,
    reason: 'The squash carries a reviewed fix, so it is not the pinned candidate alone.',
  });
  assert.equal(withoutInteraction.ok, false);
  assert.equal(withoutInteraction.reason, 'delivery_content_missing');
  assert.match(withoutInteraction.message, /deliveryInteractionCommit/);

  const delivered = store.recordDeliveredSubmission(slug, ticket.ref, {
    target: store.integrationTarget(slug),
    deliveryCommit: squash,
    deliveryInteractionCommit: interaction,
    reason: 'PR squash-merged the pinned candidate plus the reviewed one-line fix.',
  });
  assert.equal(delivered.ok, true, delivered.message);
  assert.equal(delivered.integration.mode, 'recorded-reviewed-interaction');
  assert.equal(delivered.integration.verify.status, 'passed');
  assert.equal(delivered.integration.deliveryCommit, squash);
  assert.equal(delivered.integration.deliveryIdentity.kind, 'reviewed-candidate-descendant');
  assert.equal(delivered.integration.deliveryIdentity.candidate, fixture.submitted);
  assert.equal(delivered.integration.deliveryIdentity.interaction.commit, interaction);
  assert.deepEqual(delivered.integration.deliveryIdentity.interaction.paths, ['feature.txt']);
  assert.equal(delivered.integration.contentEvidence, 'equivalent_patches:reviewed_candidate_descendant');
});

export {};
