'use strict';
// SQ-137: one topic shard of the former submission.test.ts, split so the runner can spread its tests
// across workers. Shared setup and helpers live in ./_submission-fixture.ts; the tests are moved unchanged.
import {
  test,
  assert,
  path,
  fs,
  execFileSync,
  store,
  PROJECT_DIR,
  git,
  cleanBranch,
  pin,
  slug,
  persist,
  addTicket,
  addClaimedTicket,
  createCandidateCommit,
  callMcp,
  submittedGateSource,
  dispatchedIsolatedReview,
  completeIsolatedReview,
  fixtureState,
} from './_submission-fixture.js';

test('a read-only isolated review satisfies the candidate gate only once its board call bound its runtime identity', () => {
  const unrepaired = submittedGateSource('gate source without review identity', 'gate-unrepaired.js', 'gate-source-unrepaired');
  const unrepairedReview = dispatchedIsolatedReview('gate review unrepaired', unrepaired.ticket.ref, unrepaired.commit, 'gate-review-unrepaired');
  const unrepairedAttempt = completeIsolatedReview(unrepairedReview, false);
  assert.strictEqual(unrepairedAttempt.outcome, 'done');
  assert.strictEqual(unrepairedAttempt.agentId, null, 'the raced read-only review completes with no hook-bound identity');

  const blocked = store.validateIntegrationSubmission(slug, unrepaired.ticket.ref, {});
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.reason, 'candidate_review_required');
  assert.match(blocked.message, /do not both carry a hook-bound runtime agent identity/);

  const repaired = submittedGateSource('gate source with review identity', 'gate-repaired.js', 'gate-source-repaired');
  const repairedReview = dispatchedIsolatedReview('gate review repaired', repaired.ticket.ref, repaired.commit, 'gate-review-repaired');
  const repairedAttempt = completeIsolatedReview(repairedReview, true);
  assert.strictEqual(repairedAttempt.outcome, 'done');
  assert.strictEqual(repairedAttempt.agentId, repairedReview.agentId, 'the board call bound the exact reserved runtime identity');

  const accepted = store.validateIntegrationSubmission(slug, repaired.ticket.ref, {});
  assert.notStrictEqual(accepted.reason, 'candidate_review_required', 'the identified independent review no longer blocks integration');

  for (const worktree of [unrepairedReview.worktree, repairedReview.worktree]) {
    if (fs.existsSync(worktree)) execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: PROJECT_DIR, windowsHide: true });
  }
});

test('SQ-2169: integrate records an already delivered reviewed candidate or a resolved equivalent patch', () => {
  cleanBranch();
  const ticket = addTicket('record delivered reviewed candidate', { files: ['README.md'] });
  fs.writeFileSync(path.join(PROJECT_DIR, 'README.md'), 'submission fixture\ncandidate\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'recorded delivery candidate']);
  const candidate = git(['rev-parse', 'HEAD']);
  pin(ticket, candidate);
  assert.strictEqual(store.claimTicket(slug, ticket.ref, 'recorded-delivery-source', {
    direct: true,
    reason: 'The submission fixture requires a local direct claim.',
  }).ok, true);
  assert.strictEqual(store.submitTicket(slug, ticket.ref, 'recorded-delivery-source', {
    commit: candidate,
    verify: 'node -e "process.exit(0)"',
  }).ok, true);
  const submitted = store.getTicket(slug, ticket.ref);
  const base = git(['rev-parse', `${candidate}^`]);
  Object.assign(submitted.submission, {
    base,
    upstream: 'origin/main',
    upstreamCommit: base,
    commits: [candidate],
    changedPaths: ['README.md'],
  });
  submitted.dispatch = {
    outcome: 'submitted',
    terminalAt: new Date(Date.now() - 60_000).toISOString(),
    attempts: [{ outcome: 'submitted', commit: candidate, agentId: 'recorded-delivery-source', terminalAt: new Date(Date.now() - 60_000).toISOString() }],
  };
  persist(submitted);

  const originalConfig = store.boardConfig(slug);
  try {
    const review = dispatchedIsolatedReview('recorded delivery review', ticket.ref, candidate, 'recorded-delivery-review');
    // SQ-275: landedness is proven only by the remote's live advertisement, so "already reached the
    // integration branch" must be true on origin, not merely on this checkout's local branch.
    const candidateBranch = git(['branch', '--show-current']);
    git(['push', 'origin', `${candidate}:refs/heads/${candidateBranch}`]);
    const candidateTarget = Object.assign({}, store.integrationTarget(slug), { branch: candidateBranch, upstream: `origin/${candidateBranch}` });
    const missingReview = store.recordDeliveredSubmission(slug, ticket.ref, {
      target: candidateTarget,
      deliveryCommit: candidate,
      reason: 'Candidate commit already reached the integration branch.',
    });
    assert.strictEqual(missingReview.ok, false);
    assert.strictEqual(missingReview.reason, 'candidate_review_required');

    completeIsolatedReview(review, true);
    const alreadyApplied = store.recordDeliveredSubmission(slug, ticket.ref, {
      target: candidateTarget,
      deliveryCommit: candidate,
      reason: 'Candidate commit already reached the integration branch.',
    });
    assert.strictEqual(alreadyApplied.ok, true, alreadyApplied.message);
    assert.strictEqual(alreadyApplied.integration.contentEvidence, 'candidate_ancestor');

    git(['checkout', '-f', '-B', `recorded-delivery-${++fixtureState.branchSeq}`, 'origin/main']);
    fs.writeFileSync(path.join(PROJECT_DIR, 'README.md'), 'submission fixture\ntarget\n');
    git(['add', 'README.md']);
    git(['commit', '-m', 'recorded delivery target']);
    fs.writeFileSync(path.join(PROJECT_DIR, 'README.md'), 'submission fixture\ntarget\ncandidate\n');
    git(['add', 'README.md']);
    git(['commit', '-m', 'recorded delivery resolution']);
    const delivery = git(['rev-parse', 'HEAD']);
    store.setBoardConfig(slug, { integrationMode: 'local', integrationBranch: git(['branch', '--show-current']) });
    const target = store.integrationTarget(slug);

    const unreachable = store.recordDeliveredSubmission(slug, ticket.ref, {
      target,
      deliveryCommit: candidate,
      reason: 'The candidate branch is not the integration branch.',
    });
    assert.strictEqual(unreachable.ok, false);
    assert.strictEqual(unreachable.reason, 'delivery_not_reachable');

    const recorded = store.recordDeliveredSubmission(slug, ticket.ref, {
      target,
      deliveryCommit: delivery,
      reason: 'Resolved the shared README conflict and retained both changes.',
    });
    assert.strictEqual(recorded.ok, true, recorded.message);
    assert.strictEqual(recorded.integration.contentEvidence, 'equivalent_patches');
    assert.strictEqual(recorded.integration.deliveryCommit, delivery);
    assert.strictEqual(recorded.integration.verify.status, 'passed');

    const closed = store.completeTicketAsControlPlane(slug, ticket.ref, {
      by: 'recorded-delivery-integrator',
      reason: recorded.integration.evidence,
      purpose: 'integration',
    });
    assert.strictEqual(closed.ok, true, closed.message);
    assert.strictEqual(closed.ticket.status, 'done');
    assert.strictEqual(closed.ticket.submission.integration.deliveryCommit, delivery);
  } finally {
    store.setBoardConfig(slug, { integrationMode: originalConfig.integrationMode, integrationBranch: originalConfig.integrationBranch });
  }
});

test('SQ-236: a squash merge of a multi-commit candidate is accepted by content, and only by content', () => {
  cleanBranch();
  const ticket = addTicket('record squashed multi-commit delivery', { files: ['README.md', 'squash-a.txt', 'squash-b.txt'] });
  const base = git(['rev-parse', 'HEAD']);
  // Two candidate commits on origin/main; the second deletes README.md, so the
  // deletion is part of what a delivery must preserve.
  fs.writeFileSync(path.join(PROJECT_DIR, 'squash-a.txt'), 'squash first\n');
  git(['add', 'squash-a.txt']);
  git(['commit', '-q', '-m', 'squash candidate first']);
  const first = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(PROJECT_DIR, 'squash-b.txt'), 'squash second\n');
  git(['rm', '-q', 'README.md']);
  git(['add', 'squash-b.txt']);
  git(['commit', '-q', '-m', 'squash candidate second']);
  const candidate = git(['rev-parse', 'HEAD']);
  pin(ticket, candidate);
  assert.strictEqual(store.claimTicket(slug, ticket.ref, 'squash-delivery-source', {
    direct: true,
    reason: 'The submission fixture requires a local direct claim.',
  }).ok, true);
  assert.strictEqual(store.submitTicket(slug, ticket.ref, 'squash-delivery-source', {
    commit: candidate,
    verify: 'node -e "process.exit(0)"',
  }).ok, true);
  const submitted = store.getTicket(slug, ticket.ref);
  Object.assign(submitted.submission, {
    base,
    upstream: 'origin/main',
    upstreamCommit: base,
    // Two candidate commits: the squash route only matters because there is
    // more than one. Paths in rangePaths order (first appearance per commit).
    commits: [first, candidate],
    changedPaths: ['squash-a.txt', 'README.md', 'squash-b.txt'],
  });
  submitted.dispatch = {
    outcome: 'submitted',
    terminalAt: new Date(Date.now() - 60_000).toISOString(),
    attempts: [{ outcome: 'submitted', commit: candidate, agentId: 'squash-delivery-source', terminalAt: new Date(Date.now() - 60_000).toISOString() }],
  };
  persist(submitted);

  // One squash commit on origin/main with a chosen tree for the candidate paths.
  const squash = (a: string, keepReadme: boolean) => {
    git(['checkout', '-q', '-f', '-B', `squash-delivery-${++fixtureState.branchSeq}`, 'origin/main']);
    fs.writeFileSync(path.join(PROJECT_DIR, 'squash-a.txt'), a);
    fs.writeFileSync(path.join(PROJECT_DIR, 'squash-b.txt'), 'squash second\n');
    git(['add', 'squash-a.txt', 'squash-b.txt']);
    if (!keepReadme) git(['rm', '-q', 'README.md']);
    git(['commit', '-q', '-m', 'squash delivery']);
    return git(['rev-parse', 'HEAD']);
  };

  const originalConfig = store.boardConfig(slug);
  try {
    const review = dispatchedIsolatedReview('squash delivery review', ticket.ref, candidate, 'squash-delivery-review');
    completeIsolatedReview(review, true);
    const record = (delivery: string) => {
      store.setBoardConfig(slug, { integrationMode: 'local', integrationBranch: git(['branch', '--show-current']) });
      return store.recordDeliveredSubmission(slug, ticket.ref, {
        target: store.integrationTarget(slug),
        deliveryCommit: delivery,
        reason: 'Squash-merged on the forge.',
      });
    };

    // Content differs on one submitted path: still refused.
    const drifted = record(squash('something else\n', false));
    assert.strictEqual(drifted.ok, false);
    assert.strictEqual(drifted.reason, 'delivery_content_missing');

    // The candidate's deletion was dropped: still refused.
    const undeleted = record(squash('squash first\n', true));
    assert.strictEqual(undeleted.ok, false);
    assert.strictEqual(undeleted.reason, 'delivery_content_missing');

    // A faithful squash of both candidate commits: accepted by content.
    const faithful = squash('squash first\n', false);
    assert.strictEqual(git(['rev-parse', `${faithful}^{tree}`]), git(['rev-parse', `${candidate}^{tree}`]));
    const recorded = record(faithful);
    assert.strictEqual(recorded.ok, true, recorded.message);
    assert.strictEqual(recorded.integration.contentEvidence, 'squashed_candidate_content');
    assert.strictEqual(recorded.integration.deliveryCommit, faithful);
  } finally {
    store.setBoardConfig(slug, { integrationMode: originalConfig.integrationMode, integrationBranch: originalConfig.integrationBranch });
  }
});

test('SQ-2369: reachable manual delivery survives a later folder rename while non-reachable manual delivery requires working-tree content', () => {
  const originalConfig = store.boardConfig(slug);
  try {
    cleanBranch();
    const originalFolder = 'articles/original-title';
    const settledFolder = 'articles/settled-title';
    const submittedFiles = [`${originalFolder}/DRAFT.md`, `${originalFolder}/OUTLINE.md`];
    const renamedTicket = addTicket('manual delivery renamed after integration', { files: [originalFolder] });
    fs.mkdirSync(path.join(PROJECT_DIR, originalFolder), { recursive: true });
    fs.writeFileSync(path.join(PROJECT_DIR, submittedFiles[0]), 'draft candidate\n');
    fs.writeFileSync(path.join(PROJECT_DIR, submittedFiles[1]), 'outline candidate\n');
    git(['add', originalFolder]);
    git(['commit', '-m', 'candidate under original article title']);
    const renamedCandidate = git(['rev-parse', 'HEAD']);
    const renamedBase = git(['rev-parse', `${renamedCandidate}^`]);
    pin(renamedTicket, renamedCandidate);
    assert.strictEqual(store.claimTicket(slug, renamedTicket.ref, 'renamed-manual-source', {
      direct: true,
      reason: 'The renamed manual delivery fixture requires a local direct claim.',
    }).ok, true);
    assert.strictEqual(store.submitTicket(slug, renamedTicket.ref, 'renamed-manual-source', {
      commit: renamedCandidate,
      verify: 'node -e "process.exit(0)"',
    }).ok, true);
    const renamedSubmission = store.getTicket(slug, renamedTicket.ref);
    Object.assign(renamedSubmission.submission, {
      base: renamedBase,
      upstream: 'origin/main',
      upstreamCommit: renamedBase,
      commits: [renamedCandidate],
      changedPaths: submittedFiles,
    });
    renamedSubmission.dispatch = {
      outcome: 'submitted',
      terminalAt: new Date(Date.now() - 60_000).toISOString(),
      attempts: [{ outcome: 'submitted', commit: renamedCandidate, agentId: 'renamed-manual-source', terminalAt: new Date(Date.now() - 60_000).toISOString() }],
    };
    persist(renamedSubmission);

    git(['mv', originalFolder, settledFolder]);
    git(['commit', '-m', 'settle article title']);
    const targetBranch = git(['branch', '--show-current']);
    store.setBoardConfig(slug, { integrationMode: 'local', integrationBranch: targetBranch });

    const renamedDelivery = store.recordDeliveredSubmission(slug, renamedTicket.ref, {
      target: store.integrationTarget(slug),
      deliveryCommit: renamedCandidate,
      deliveryMethod: 'manual',
      reason: 'The submitted candidate was integrated before its article folder received the settled title.',
    });
    assert.strictEqual(renamedDelivery.ok, true, renamedDelivery.message);
    assert.strictEqual(renamedDelivery.integration.contentEvidence, 'candidate_ancestor');
    assert.strictEqual(renamedDelivery.integration.deliveryCommit, renamedCandidate);

    cleanBranch();
    const missingFolder = 'articles/manual-content-reset-away';
    const missingFile = `${missingFolder}/DRAFT.md`;
    const missingTicket = addTicket('non-reachable manual delivery without working-tree content', { files: [missingFolder] });
    fs.mkdirSync(path.join(PROJECT_DIR, missingFolder), { recursive: true });
    fs.writeFileSync(path.join(PROJECT_DIR, missingFile), 'manual candidate\n');
    git(['add', missingFolder]);
    git(['commit', '-m', 'manual candidate reset away']);
    const missingCandidate = git(['rev-parse', 'HEAD']);
    const missingBase = git(['rev-parse', `${missingCandidate}^`]);
    pin(missingTicket, missingCandidate);
    assert.strictEqual(store.claimTicket(slug, missingTicket.ref, 'missing-manual-source', {
      direct: true,
      reason: 'The missing manual delivery fixture requires a local direct claim.',
    }).ok, true);
    assert.strictEqual(store.submitTicket(slug, missingTicket.ref, 'missing-manual-source', {
      commit: missingCandidate,
      verify: 'node -e "process.exit(0)"',
    }).ok, true);
    const missingSubmission = store.getTicket(slug, missingTicket.ref);
    Object.assign(missingSubmission.submission, {
      base: missingBase,
      upstream: 'origin/main',
      upstreamCommit: missingBase,
      commits: [missingCandidate],
      changedPaths: [missingFile],
    });
    missingSubmission.dispatch = {
      outcome: 'submitted',
      terminalAt: new Date(Date.now() - 60_000).toISOString(),
      attempts: [{ outcome: 'submitted', commit: missingCandidate, agentId: 'missing-manual-source', terminalAt: new Date(Date.now() - 60_000).toISOString() }],
    };
    persist(missingSubmission);
    store.setBoardConfig(slug, { integrationMode: 'local', integrationBranch: git(['branch', '--show-current']) });
    git(['reset', '--hard', 'origin/main']);
    assert.notStrictEqual(git(['merge-base', missingCandidate, 'HEAD']), missingCandidate, 'the manual candidate is not reachable after reset');

    const missingDelivery = store.recordDeliveredSubmission(slug, missingTicket.ref, {
      target: store.integrationTarget(slug),
      deliveryCommit: missingCandidate,
      deliveryMethod: 'manual',
      reason: 'The non-reachable manual candidate is absent from the integration working tree.',
    });
    assert.strictEqual(missingDelivery.ok, false, 'non-reachable manual delivery still checks the integration working tree');
    assert.strictEqual(missingDelivery.reason, 'delivery_content_missing');
    assert.match(missingDelivery.message, /articles\/manual-content-reset-away\/DRAFT\.md/);
  } finally {
    store.setBoardConfig(slug, { integrationMode: originalConfig.integrationMode, integrationBranch: originalConfig.integrationBranch });
  }
});

test('SQ-2254: MCP records a reset delivery from its pinned candidate and refuses absent working-tree content', async () => {
  const originalConfig = store.boardConfig(slug);
  try {
  cleanBranch();
  const deliveredTicket = addTicket('reset-delivered submission', { files: ['lib/reset-delivery.js'] });
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'reset-delivery.js'), 'reset-delivered\n');
  git(['add', 'lib/reset-delivery.js']);
  git(['commit', '-m', 'reset delivery candidate']);
  const deliveredCandidate = git(['rev-parse', 'HEAD']);
  pin(deliveredTicket, deliveredCandidate);
  assert.strictEqual(store.claimTicket(slug, deliveredTicket.ref, 'reset-delivery-source', {
    direct: true,
    reason: 'The reset delivery fixture requires a local direct claim.',
  }).ok, true);
  assert.strictEqual(store.submitTicket(slug, deliveredTicket.ref, 'reset-delivery-source', {
    commit: deliveredCandidate,
    verify: 'node -e "process.exit(0)"',
  }).ok, true);
  const deliveredSubmission = store.getTicket(slug, deliveredTicket.ref);
  const base = git(['rev-parse', `${deliveredCandidate}^`]);
  Object.assign(deliveredSubmission.submission, {
    base,
    upstream: 'origin/main',
    upstreamCommit: base,
    commits: [deliveredCandidate],
    changedPaths: ['lib/reset-delivery.js'],
  });
  deliveredSubmission.dispatch = {
    outcome: 'submitted',
    terminalAt: new Date(Date.now() - 60_000).toISOString(),
    attempts: [{ outcome: 'submitted', commit: deliveredCandidate, agentId: 'reset-delivery-source', terminalAt: new Date(Date.now() - 60_000).toISOString() }],
  };
  persist(deliveredSubmission);
  const targetBranch = git(['branch', '--show-current']);
  store.setBoardConfig(slug, { integrationMode: 'local', integrationBranch: targetBranch });
  git(['reset', '--mixed', 'origin/main']);
  assert.notStrictEqual(git(['merge-base', deliveredCandidate, 'HEAD']), deliveredCandidate, 'the reset delivery candidate is not reachable from the integration branch');

  const delivered = await callMcp('groomClose', {
    project: PROJECT_DIR,
    ref: deliveredTicket.ref,
    by: 'reset-delivery-integrator',
    deliveryCommit: deliveredCandidate,
    deliveryMethod: 'reset',
    reason: 'The integration branch was reset for editor review and retains the pinned candidate in its working tree.',
  });
  assert.strictEqual(delivered.ok, true, delivered.message);
  const recordedDelivery = store.getTicket(slug, deliveredTicket.ref);
  assert.strictEqual(recordedDelivery.submission.integration.mode, 'recorded-working-tree');
  assert.strictEqual(recordedDelivery.submission.integration.contentCommit, deliveredCandidate);
  assert.deepStrictEqual(recordedDelivery.submission.integration.deliveryIdentity, {
    kind: 'pinned-working-tree',
    pinnedRef: `refs/sidequest/${deliveredTicket.ref}`,
    candidate: deliveredCandidate,
    sourceRevision: recordedDelivery.submission.integration.deliveryRevision,
    method: 'reset',
  }, 'the supersession-facing delivery identity retains the immutable candidate and observed integration revision');
  assert.deepStrictEqual(recordedDelivery.submission.integration.deliveredFiles, ['lib/reset-delivery.js']);

  cleanBranch();
  const absentTicket = addTicket('reset delivery without content', { files: ['lib/reset-absent.js'] });
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'reset-absent.js'), 'missing after reset\n');
  git(['add', 'lib/reset-absent.js']);
  git(['commit', '-m', 'reset absent candidate']);
  const absentCandidate = git(['rev-parse', 'HEAD']);
  pin(absentTicket, absentCandidate);
  assert.strictEqual(store.claimTicket(slug, absentTicket.ref, 'reset-absent-source', {
    direct: true,
    reason: 'The absent reset delivery fixture requires a local direct claim.',
  }).ok, true);
  assert.strictEqual(store.submitTicket(slug, absentTicket.ref, 'reset-absent-source', {
    commit: absentCandidate,
    verify: 'node -e "process.exit(0)"',
  }).ok, true);
  const absentSubmission = store.getTicket(slug, absentTicket.ref);
  const absentBase = git(['rev-parse', `${absentCandidate}^`]);
  Object.assign(absentSubmission.submission, {
    base: absentBase,
    upstream: 'origin/main',
    upstreamCommit: absentBase,
    commits: [absentCandidate],
    changedPaths: ['lib/reset-absent.js'],
  });
  absentSubmission.dispatch = {
    outcome: 'submitted',
    terminalAt: new Date(Date.now() - 60_000).toISOString(),
    attempts: [{ outcome: 'submitted', commit: absentCandidate, agentId: 'reset-absent-source', terminalAt: new Date(Date.now() - 60_000).toISOString() }],
  };
  persist(absentSubmission);
  store.setBoardConfig(slug, { integrationMode: 'local', integrationBranch: git(['branch', '--show-current']) });
  git(['reset', '--hard', 'origin/main']);

  const absent = await callMcp('groomClose', {
    project: PROJECT_DIR,
    ref: absentTicket.ref,
    by: 'reset-absent-integrator',
    deliveryCommit: absentCandidate,
    deliveryMethod: 'reset',
    reason: 'The candidate was reset away before delivery.',
  });
  assert.strictEqual(absent.ok, false);
  assert.strictEqual(absent.reason, 'delivery_content_missing');
  assert.strictEqual(store.getTicket(slug, absentTicket.ref).status, 'doing');
  } finally {
    store.setBoardConfig(slug, { integrationMode: originalConfig.integrationMode, integrationBranch: originalConfig.integrationBranch });
  }
});

test('SQ-2413: MCP groomClose records terminal recovery evidence and accepts a reachable manual delivery', async () => {
  const originalConfig = store.boardConfig(slug);
  try {
    cleanBranch();
    const abandonedTicket = addTicket('terminal submitted dispatch with abandoned candidate', { files: ['lib/terminal-submitted.js'] });
    fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'terminal-submitted.js'), 'candidate\n');
    git(['add', 'lib/terminal-submitted.js']);
    git(['commit', '-m', 'terminal submitted candidate']);
    const abandonedCandidate = git(['rev-parse', 'HEAD']);
    const abandonedBase = git(['rev-parse', `${abandonedCandidate}^`]);
    pin(abandonedTicket, abandonedCandidate);
    assert.strictEqual(store.claimTicket(slug, abandonedTicket.ref, 'terminal-submitted-source', {
      direct: true,
      reason: 'The terminal submitted fixture requires a local direct claim.',
    }).ok, true);
    assert.strictEqual(store.submitTicket(slug, abandonedTicket.ref, 'terminal-submitted-source', {
      commit: abandonedCandidate,
      verify: 'node -e "process.exit(0)"',
    }).ok, true);
    const submittedTicket = store.getTicket(slug, abandonedTicket.ref);
    Object.assign(submittedTicket.submission, {
      base: abandonedBase,
      upstream: 'origin/main',
      upstreamCommit: abandonedBase,
      commits: [abandonedCandidate],
      changedPaths: ['lib/terminal-submitted.js'],
    });
    submittedTicket.dispatch = {
      outcome: 'submitted',
      terminalAt: new Date(Date.now() - 60_000).toISOString(),
      attempts: [{ outcome: 'submitted', commit: abandonedCandidate, agentId: 'terminal-submitted-source', terminalAt: new Date(Date.now() - 60_000).toISOString() }],
    };
    persist(submittedTicket);
    const terminalRecovery = store.clearUnclaimedDispatch(slug, abandonedTicket.ref, {
      by: 'terminal-submitted-integrator',
      evidence: 'The submitted executor already terminated before closeout.',
    });
    assert.strictEqual(terminalRecovery.ok, false);
    assert.strictEqual(terminalRecovery.reason, 'no_unclaimed_dispatch');
    assert.match(terminalRecovery.message, /outcome "submitted"/);
    assert.match(terminalRecovery.message, /recoveryEvidence does not apply to a terminal dispatch/);
    assert.match(terminalRecovery.message, /deliveryCommit[\s\S]*abandonSubmission/);
    const release = store.releaseTicket(slug, abandonedTicket.ref, 'terminal-submitted-source', { status: 'todo' });
    assert.strictEqual(release.ok, false);
    assert.match(release.message, /no claim to release/);
    const rework = await callMcp('rework', {
      project: PROJECT_DIR,
      ref: abandonedTicket.ref,
      by: 'unrelated-reworker',
      review: 'The submitted candidate needs a different repair owner.',
      reason: 'Reject only from the candidate owner.',
    });
    assert.strictEqual(rework.ok, false);
    assert.match(rework.message, /no claim to release/);
    git(['reset', '--hard', 'origin/main']);
    fs.writeFileSync(path.join(PROJECT_DIR, 'unrelated-delivery.js'), 'reachable but unrelated\n');
    git(['add', 'unrelated-delivery.js']);
    git(['commit', '-m', 'unrelated reachable delivery']);
    const unrelatedDelivery = git(['rev-parse', 'HEAD']);
    assert.notStrictEqual(git(['merge-base', abandonedCandidate, unrelatedDelivery]), abandonedCandidate, 'the submitted candidate is not reachable');
    store.setBoardConfig(slug, { integrationMode: 'local', integrationBranch: git(['branch', '--show-current']) });

    const abandoned = await callMcp('groomClose', {
      project: PROJECT_DIR,
      ref: abandonedTicket.ref,
      by: 'terminal-submitted-integrator',
      recoveryEvidence: 'The submitted executor already terminated before closeout.',
      abandonSubmission: true,
      reason: 'The candidate was reset away and the reachable delivery does not preserve it.',
    });
    assert.strictEqual(abandoned.ok, true, abandoned.message);
    const closedTicket = store.getTicket(slug, abandonedTicket.ref);
    assert.strictEqual(closedTicket.status, 'done');
    assert.strictEqual(closedTicket.submission.integration.outcome, 'abandoned');
    assert.match(closedTicket.completion.reason, /submitted executor already terminated/);

    cleanBranch();
    const deliveredTicket = addTicket('reachable manual delivery with candidate-preserving descendant', { files: ['lib/reachable-manual.js'] });
    fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'reachable-manual.js'), 'candidate\n');
    git(['add', 'lib/reachable-manual.js']);
    git(['commit', '-m', 'reachable manual candidate']);
    const deliveredCandidate = git(['rev-parse', 'HEAD']);
    const deliveredBase = git(['rev-parse', `${deliveredCandidate}^`]);
    pin(deliveredTicket, deliveredCandidate);
    assert.strictEqual(store.claimTicket(slug, deliveredTicket.ref, 'reachable-manual-source', {
      direct: true,
      reason: 'The reachable manual fixture requires a local direct claim.',
    }).ok, true);
    assert.strictEqual(store.submitTicket(slug, deliveredTicket.ref, 'reachable-manual-source', {
      commit: deliveredCandidate,
      verify: 'node -e "process.exit(0)"',
    }).ok, true);
    const submittedDelivery = store.getTicket(slug, deliveredTicket.ref);
    Object.assign(submittedDelivery.submission, {
      base: deliveredBase,
      upstream: 'origin/main',
      upstreamCommit: deliveredBase,
      commits: [deliveredCandidate],
      changedPaths: ['lib/reachable-manual.js'],
    });
    submittedDelivery.dispatch = {
      outcome: 'submitted',
      terminalAt: new Date(Date.now() - 60_000).toISOString(),
      attempts: [{ outcome: 'submitted', commit: deliveredCandidate, agentId: 'reachable-manual-source', terminalAt: new Date(Date.now() - 60_000).toISOString() }],
    };
    persist(submittedDelivery);
    fs.writeFileSync(path.join(PROJECT_DIR, 'unrelated-delivery.js'), 'candidate-preserving descendant\n');
    git(['add', 'unrelated-delivery.js']);
    git(['commit', '-m', 'candidate preserving reachable delivery']);
    const reachableDelivery = git(['rev-parse', 'HEAD']);
    store.setBoardConfig(slug, { integrationMode: 'local', integrationBranch: git(['branch', '--show-current']) });

    const delivered = await callMcp('groomClose', {
      project: PROJECT_DIR,
      ref: deliveredTicket.ref,
      by: 'reachable-manual-integrator',
      deliveryCommit: reachableDelivery,
      deliveryMethod: 'manual',
      reason: 'The reachable descendant preserves the submitted candidate.',
    });
    assert.strictEqual(delivered.ok, true, delivered.message);
    const deliveredRecord = store.getTicket(slug, deliveredTicket.ref);
    assert.strictEqual(deliveredRecord.submission.integration.deliveryCommit, reachableDelivery);
    assert.strictEqual(deliveredRecord.submission.integration.deliveryIdentity.kind, 'reachable-commit');
    assert.strictEqual(deliveredRecord.submission.integration.deliveryIdentity.method, undefined);
  } finally {
    store.setBoardConfig(slug, { integrationMode: originalConfig.integrationMode, integrationBranch: originalConfig.integrationBranch });
  }
});

test('SQ-2152: shared-tree retries replace stale candidates while disjoint descendants remain admissible', async () => {
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  cleanBranch();

  const staleTicket = addTicket('stale shared-tree candidate', {
    files: ['lib/shared-stale.js'],
    category: 'submission.fixture',
  });
  const staleDispatch = store.prepareDispatch(slug, staleTicket.ref, { sessionId: 'stale-shared-tree', sharedTree: true });
  assert.strictEqual(staleDispatch.ticket.dispatch.sharedTree, true);
  assert.strictEqual(store.claimTicket(slug, staleTicket.ref, 'stale-shared-tree-worker', {
    token: staleDispatch.token,
    executor: staleDispatch.ticket.dispatchExecutor,
    sessionId: 'stale-shared-tree',
  }).ok, true);

  const staleFragment = `.release/unreleased/${staleTicket.ref}.md`;
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(PROJECT_DIR, staleFragment)), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'shared-stale.js'), 'candidate\n');
  fs.writeFileSync(path.join(PROJECT_DIR, staleFragment), 'candidate fragment\n');
  git(['add', 'lib/shared-stale.js', staleFragment]);
  git(['commit', '-m', 'stale shared-tree candidate']);
  const staleCandidate = git(['rev-parse', 'HEAD']);
  pin(staleTicket, staleCandidate);

  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'shared-stale.js'), 'orchestrator descendant\n');
  fs.writeFileSync(path.join(PROJECT_DIR, staleFragment), 'orchestrator fragment\n');
  git(['add', 'lib/shared-stale.js', staleFragment]);
  git(['commit', '-m', 'orchestrator touches stale candidate scope']);
  const staleDescendant = git(['rev-parse', 'HEAD']);
  git(['update-ref', 'refs/remotes/origin/main', staleDescendant]);
  git(['update-ref', 'refs/heads/main', staleDescendant]);

  const staleRefusal = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: staleTicket.ref,
    by: 'stale-shared-tree-worker',
    commit: staleCandidate,
    worktree: PROJECT_DIR,
    verify: 'npm run test:files -- test/submission.test.ts',
    body: 'Stale shared-tree candidate refusal fixture.',
  });
  assert.strictEqual(staleRefusal.ok, false);
  assert.strictEqual(staleRefusal.reason, 'stale_shared_tree_candidate');
  assert.match(staleRefusal.message, /lib\/shared-stale\.js/);
  assert.match(staleRefusal.message, new RegExp(staleFragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.strictEqual(store.getTicket(slug, staleTicket.ref).submissionRetry.candidate.value, staleCandidate);

  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'shared-stale.js'), 'replacement candidate\n');
  fs.writeFileSync(path.join(PROJECT_DIR, staleFragment), 'replacement fragment\n');
  git(['add', 'lib/shared-stale.js', staleFragment]);
  git(['commit', '-m', 'replacement shared-tree candidate']);
  const replacementCandidate = git(['rev-parse', 'HEAD']);
  pin(staleTicket, replacementCandidate);

  const replacement = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: staleTicket.ref,
    by: 'stale-shared-tree-worker',
    commit: replacementCandidate,
    base: staleDescendant,
    worktree: PROJECT_DIR,
    verify: 'npm run test:files -- test/submission.test.ts',
    body: 'Replacement shared-tree candidate fixture.',
  });
  assert.strictEqual(replacement.ok, true, replacement.message);
  const replacementTicket = store.getTicket(slug, staleTicket.ref);
  assert.strictEqual(replacementTicket.submission.commit, replacementCandidate);
  assert.deepStrictEqual(replacementTicket.submission.commits, [replacementCandidate]);
  assert.strictEqual(replacementTicket.submission.base, staleDescendant);
  assert.strictEqual(replacementTicket.submission.worktree, PROJECT_DIR);
  assert.ok(replacementTicket.submission.admittedScope.includes(staleFragment));

  cleanBranch();
  const disjointTicket = addTicket('disjoint shared-tree candidate', {
    files: ['lib/disjoint-candidate.js'],
    category: 'submission.fixture',
  });
  const disjointDispatch = store.prepareDispatch(slug, disjointTicket.ref, { sessionId: 'disjoint-shared-tree', sharedTree: true });
  assert.strictEqual(store.claimTicket(slug, disjointTicket.ref, 'disjoint-shared-tree-worker', {
    token: disjointDispatch.token,
    executor: disjointDispatch.ticket.dispatchExecutor,
    sessionId: 'disjoint-shared-tree',
  }).ok, true);

  const disjointFragment = `.release/unreleased/${disjointTicket.ref}.md`;
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'disjoint-candidate.js'), 'candidate\n');
  fs.writeFileSync(path.join(PROJECT_DIR, disjointFragment), 'candidate fragment\n');
  git(['add', 'lib/disjoint-candidate.js', disjointFragment]);
  git(['commit', '-m', 'disjoint shared-tree candidate']);
  const disjointCandidate = git(['rev-parse', 'HEAD']);
  pin(disjointTicket, disjointCandidate);

  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'orchestrator-only.js'), 'independent descendant\n');
  git(['add', 'lib/orchestrator-only.js']);
  git(['commit', '-m', 'orchestrator changes disjoint path']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(['update-ref', 'refs/heads/main', 'HEAD']);

  const disjointAdmission = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: disjointTicket.ref,
    by: 'disjoint-shared-tree-worker',
    commit: disjointCandidate,
    worktree: PROJECT_DIR,
    verify: 'npm run test:files -- test/submission.test.ts',
    body: 'Disjoint shared-tree candidate fixture.',
  });
  assert.strictEqual(disjointAdmission.ok, true, disjointAdmission.message);
  assert.strictEqual(store.getTicket(slug, disjointTicket.ref).submission.commit, disjointCandidate);
});

test('SQ-2184: control-plane closure recognizes released submissions and consumed fragments', () => {
  cleanBranch();
  const originalConfig = store.boardConfig(slug);
  const integrationBranch = git(['branch', '--show-current']);
  store.setBoardConfig(slug, { integrationMode: 'local', integrationBranch });
  try {
    const groomingTicket = addTicket('released grooming submission', { files: ['lib/released-grooming.js'] });
    fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'released-grooming.js'), 'candidate\n');
    git(['add', 'lib/released-grooming.js']);
    git(['commit', '-m', 'released grooming candidate']);
    const groomingCandidate = git(['rev-parse', 'HEAD']);
    pin(groomingTicket, groomingCandidate);
    assert.strictEqual(store.claimTicket(slug, groomingTicket.ref, 'released-grooming-worker', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
    assert.strictEqual(store.submitTicket(slug, groomingTicket.ref, 'released-grooming-worker', { commit: groomingCandidate, verify: 'node -e "process.exit(0)"' }).ok, true);
    const submittedGroomingTicket = store.getTicket(slug, groomingTicket.ref);
    Object.assign(submittedGroomingTicket.submission, {
      base: git(['rev-parse', `${groomingCandidate}^`]),
      upstream: integrationBranch,
      upstreamCommit: groomingCandidate,
      integrationBranch,
      commits: [groomingCandidate],
      changedPaths: ['lib/released-grooming.js'],
    });
    persist(submittedGroomingTicket);
    fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'delivery-after-grooming.js'), 'delivered\n');
    git(['add', 'lib/delivery-after-grooming.js']);
    git(['commit', '-m', 'released grooming delivery']);

    const groomed = store.completeTicketAsControlPlane(slug, groomingTicket.ref, {
      by: 'orchestrator',
      purpose: 'grooming',
      reason: 'The submitted candidate is reachable from the integration branch.',
    });
    assert.strictEqual(groomed.ok, true, groomed.message);
    assert.strictEqual(groomed.ticket.status, 'done');
    assert.strictEqual(groomed.ticket.submission.integration.outcome, 'verified');

    const integrationTicket = addTicket('released integration submission', { files: ['lib/released-integration.js'] });
    fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'released-integration.js'), 'candidate\n');
    git(['add', 'lib/released-integration.js']);
    git(['commit', '-m', 'released integration candidate']);
    const integrationCandidate = git(['rev-parse', 'HEAD']);
    pin(integrationTicket, integrationCandidate);
    assert.strictEqual(store.claimTicket(slug, integrationTicket.ref, 'released-integration-worker', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
    assert.strictEqual(store.submitTicket(slug, integrationTicket.ref, 'released-integration-worker', { commit: integrationCandidate, verify: 'node -e "process.exit(0)"' }).ok, true);
    const submittedIntegrationTicket = store.getTicket(slug, integrationTicket.ref);
    Object.assign(submittedIntegrationTicket.submission, {
      base: git(['rev-parse', `${integrationCandidate}^`]),
      upstream: integrationBranch,
      upstreamCommit: integrationCandidate,
      integrationBranch,
      commits: [integrationCandidate],
      changedPaths: ['lib/released-integration.js'],
    });
    persist(submittedIntegrationTicket);
    fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'delivery-after-integration.js'), 'delivered\n');
    git(['add', 'lib/delivery-after-integration.js']);
    git(['commit', '-m', 'released integration delivery']);
    pin(integrationTicket, git(['rev-parse', 'HEAD']));

    const recordedDeliveryCommit = git(['rev-parse', 'HEAD']);
    const recordedDelivery = store.recordDeliveredSubmission(slug, integrationTicket.ref, {
      target: { branch: integrationBranch, upstream: `refs/heads/${integrationBranch}` },
      deliveryCommit: recordedDeliveryCommit,
      reason: 'The submitted candidate is already an ancestor of the integration branch.',
    });
    assert.strictEqual(recordedDelivery.ok, true, recordedDelivery.message);
    const integrated = store.completeTicketAsControlPlane(slug, integrationTicket.ref, {
      by: 'orchestrator',
      purpose: 'integration',
      reason: 'The submitted candidate is already an ancestor of the integration branch.',
    });
    assert.strictEqual(integrated.ok, true, integrated.message);
    assert.strictEqual(integrated.ticket.status, 'done');

    fs.mkdirSync(path.join(PROJECT_DIR, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(PROJECT_DIR, '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'released-fixture', source: 'plugins/released-fixture' }] }));
    git(['add', '.claude-plugin/marketplace.json']);
    git(['commit', '-m', 'add released fixture manifest']);
    const deliveryTicket = addTicket('released delivery fragment', { files: ['plugins/released-fixture/index.js'] });
    const fragmentPath = `.release/unreleased/${deliveryTicket.ref}.md`;
    fs.mkdirSync(path.join(PROJECT_DIR, 'plugins', 'released-fixture'), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(PROJECT_DIR, fragmentPath)), { recursive: true });
    fs.writeFileSync(path.join(PROJECT_DIR, 'plugins', 'released-fixture', 'index.js'), 'released\n');
    fs.writeFileSync(path.join(PROJECT_DIR, fragmentPath), 'fragment\n');
    git(['add', 'plugins/released-fixture/index.js', fragmentPath]);
    git(['commit', '-m', 'released delivery candidate']);
    const deliveryCommit = git(['rev-parse', 'HEAD']);
    fs.rmSync(path.join(PROJECT_DIR, fragmentPath));

    const delivered = store.completeTicketAsControlPlane(slug, deliveryTicket.ref, {
      by: 'orchestrator',
      purpose: 'delivery',
      deliveryCommit,
      reason: 'The release cut consumed this ticket fragment.',
    });
    assert.strictEqual(delivered.ok, true, delivered.message);
    assert.strictEqual(delivered.ticket.status, 'done');
  } finally {
    store.setBoardConfig(slug, { integrationMode: originalConfig.integrationMode, integrationBranch: originalConfig.integrationBranch });
    cleanBranch();
  }
});

test('SQ-2188: grooming records stranded candidates as abandoned and landed candidates as delivered', () => {
  cleanBranch();
  const originalConfig = store.boardConfig(slug);
  const integrationBranch = git(['branch', '--show-current']);
  store.setBoardConfig(slug, { integrationMode: 'local', integrationBranch });
  try {
    const strandedTicket = addTicket('stranded candidate', { files: ['lib/stranded.js'] });
    const branchBeforeCandidate = git(['rev-parse', 'HEAD']);
    fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'stranded.js'), 'candidate\n');
    git(['add', 'lib/stranded.js']);
    git(['commit', '-m', 'stranded candidate']);
    const strandedCandidate = git(['rev-parse', 'HEAD']);
    pin(strandedTicket, strandedCandidate);
    assert.strictEqual(store.claimTicket(slug, strandedTicket.ref, 'stranded-worker', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
    assert.strictEqual(store.submitTicket(slug, strandedTicket.ref, 'stranded-worker', { commit: strandedCandidate, verify: 'node -e "process.exit(0)"' }).ok, true);
    const submittedStranded = store.getTicket(slug, strandedTicket.ref);
    Object.assign(submittedStranded.submission, {
      base: branchBeforeCandidate,
      upstream: integrationBranch,
      upstreamCommit: strandedCandidate,
      integrationBranch,
      commits: [strandedCandidate],
      changedPaths: ['lib/stranded.js'],
    });
    persist(submittedStranded);

    // Strand the candidate the way main really strands them: the branch goes back and moves on
    // without it, so the commit still exists but is no longer an ancestor of the branch.
    git(['reset', '--hard', branchBeforeCandidate]);
    // The reset takes lib/ with it when the candidate created it, so this test cannot assume the
    // directory survived; running it alone is what exposes that.
    fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'moved-on.js'), 'the branch moved on\n');
    git(['add', 'lib/moved-on.js']);
    git(['commit', '-m', 'branch moved past the stranded candidate']);

    const groomedWithoutFlag = store.completeTicketAsControlPlane(slug, strandedTicket.ref, {
      by: 'orchestrator',
      purpose: 'grooming',
      reason: 'The candidate never reached the integration branch.',
    });
    assert.strictEqual(groomedWithoutFlag.ok, false);
    assert.match(
      String(groomedWithoutFlag.message || ''),
      /--abandon-submission/,
      'a refused delivery must name the abandonment path, or grooming has no legal move left',
    );

    const abandoned = store.completeTicketAsControlPlane(slug, strandedTicket.ref, {
      by: 'orchestrator',
      purpose: 'grooming',
      abandonSubmission: true,
      reason: 'The candidate never reached the integration branch and no longer merges.',
    });
    assert.strictEqual(abandoned.ok, true, abandoned.message);
    assert.strictEqual(abandoned.ticket.status, 'done');
    assert.strictEqual(abandoned.ticket.submission.integration.outcome, 'abandoned');
    assert.strictEqual(abandoned.ticket.submission.integration.candidateState, 'unreachable');
    // The whole point of the closure: the board must stop counting this as awaiting integration.
    assert.strictEqual(store.pendingSubmission(store.getTicket(slug, strandedTicket.ref)), false);

    const landedTicket = addTicket('landed candidate', { files: ['lib/landed.js'] });
    const branchBeforeLandedCandidate = git(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'landed.js'), 'candidate\n');
    git(['add', 'lib/landed.js']);
    git(['commit', '-m', 'landed candidate']);
    const landedCandidate = git(['rev-parse', 'HEAD']);
    pin(landedTicket, landedCandidate);
    assert.strictEqual(store.claimTicket(slug, landedTicket.ref, 'landed-worker', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
    assert.strictEqual(store.submitTicket(slug, landedTicket.ref, 'landed-worker', { commit: landedCandidate, verify: 'node -e "process.exit(0)"' }).ok, true);
    const submittedLanded = store.getTicket(slug, landedTicket.ref);
    const missingGateCommand = `sidequest-missing-landed-gate-${process.pid}-${Date.now()}`;
    submittedLanded.executorVerify = missingGateCommand;
    Object.assign(submittedLanded.submission, {
      verify: missingGateCommand,
      base: branchBeforeLandedCandidate,
      upstream: integrationBranch,
      upstreamCommit: branchBeforeLandedCandidate,
      integrationBranch,
      commits: [landedCandidate],
      changedPaths: ['lib/landed.js'],
    });
    persist(submittedLanded);
    fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'after-landed.js'), 'main moved after delivery\n');
    git(['add', 'lib/after-landed.js']);
    git(['commit', '-m', 'main moved after landed candidate']);

    const recordedDelivery = store.completeTicketAsControlPlane(slug, landedTicket.ref, {
      by: 'orchestrator',
      purpose: 'grooming',
      abandonSubmission: true,
      reason: 'Reachability proves this candidate already landed.',
    });
    assert.strictEqual(recordedDelivery.ok, true, recordedDelivery.message);
    assert.strictEqual(recordedDelivery.ticket.status, 'done');
    assert.strictEqual(recordedDelivery.ticket.submission.integration.outcome, 'delivered');
    assert.strictEqual(recordedDelivery.ticket.submission.integration.deliveryCommit, landedCandidate);
    assert.strictEqual(recordedDelivery.ticket.submission.integration.mode, 'already-landed');
    assert.strictEqual(store.pendingSubmission(store.getTicket(slug, landedTicket.ref)), false);

    const commitScope = require('../lib/commit-scope.js');
    assert.strictEqual(
      commitScope.submissionCommitReachedIntegrationBranch(PROJECT_DIR, store.getTicket(slug, landedTicket.ref).submission, integrationBranch),
      true,
    );
    assert.strictEqual(
      commitScope.submissionCommitReachedIntegrationBranch(PROJECT_DIR, submittedStranded.submission, integrationBranch),
      false,
    );
  } finally {
    store.setBoardConfig(slug, { integrationMode: originalConfig.integrationMode, integrationBranch: originalConfig.integrationBranch });
    cleanBranch();
  }
});

test('SQ-2337: a failed delivery gate cannot redirect already-landed abandonment back to delivery', () => {
  cleanBranch();
  const originalConfig = store.boardConfig(slug);
  const integrationBranch = git(['branch', '--show-current']);
  store.setBoardConfig(slug, { integrationMode: 'local', integrationBranch });
  try {
    const ticket = addTicket('landed candidate after failed gate', { files: ['lib/landed-after-failed-gate.js'] });
    const baseline = git(['rev-parse', 'HEAD']);
    fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'landed-after-failed-gate.js'), 'candidate\n');
    git(['add', 'lib/landed-after-failed-gate.js']);
    git(['commit', '-m', 'landed candidate before failed gate']);
    const candidate = git(['rev-parse', 'HEAD']);
    pin(ticket, candidate);
    assert.strictEqual(store.claimTicket(slug, ticket.ref, 'failed-gate-worker', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
    assert.strictEqual(store.submitTicket(slug, ticket.ref, 'failed-gate-worker', { commit: candidate, verify: 'node -e "process.exit(0)"' }).ok, true);
    const submitted = store.getTicket(slug, ticket.ref);
    const missingGateCommand = `sidequest-missing-cycle-gate-${process.pid}-${Date.now()}`;
    submitted.executorVerify = missingGateCommand;
    Object.assign(submitted.submission, {
      verify: missingGateCommand,
      base: baseline,
      upstream: integrationBranch,
      upstreamCommit: baseline,
      integrationBranch,
      commits: [candidate],
      changedPaths: ['lib/landed-after-failed-gate.js'],
    });
    persist(submitted);
    fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'after-failed-gate.js'), 'main moved after candidate\n');
    git(['add', 'lib/after-failed-gate.js']);
    git(['commit', '-m', 'main moved before failed gate']);

    const target = store.integrationTarget(slug);
    const refusedDelivery = store.recordDeliveredSubmission(slug, ticket.ref, {
      target,
      deliveryCommit: candidate,
      reason: 'The already-landed candidate still encountered a gate environment failure.',
    });
    assert.strictEqual(refusedDelivery.ok, false);

    const terminalRecording = store.recordAbandonedSubmission(slug, ticket.ref, {
      target,
      reason: 'Reachability must terminate the abandonment path as delivered.',
    });
    assert.strictEqual(terminalRecording.ok, true, terminalRecording.message);
    assert.strictEqual(terminalRecording.integration.outcome, 'delivered');
    assert.strictEqual(terminalRecording.integration.deliveryCommit, candidate);
    assert.strictEqual(store.pendingSubmission(store.getTicket(slug, ticket.ref)), false);
  } finally {
    store.setBoardConfig(slug, { integrationMode: originalConfig.integrationMode, integrationBranch: originalConfig.integrationBranch });
    cleanBranch();
  }
});

test('SQ-2429: pending candidates block a singleton without invalidation while an explicit clean same-file wave assembles', () => {
  cleanBranch();
  const originalConfig = store.boardConfig(slug);
  const integrationBranch = git(['branch', '--show-current']);
  store.setBoardConfig(slug, { integrationMode: 'local', integrationBranch });
  try {
    const docsPath = path.join(PROJECT_DIR, 'docs', 'guide.md');
    fs.mkdirSync(path.dirname(docsPath), { recursive: true });
    fs.writeFileSync(docsPath, 'base\n');
    git(['add', 'docs/guide.md']);
    git(['commit', '-m', 'same-file wave baseline']);
    const baseline = git(['rev-parse', 'HEAD']);

    const primary = addTicket('primary prose candidate', { files: ['docs'] });
    assert.strictEqual(store.claimTicket(slug, primary.ref, 'primary-prose-worker', { direct: true, reason: 'The same-file wave fixture requires a local direct claim.' }).ok, true);
    fs.writeFileSync(docsPath, 'base\nprimary\n');
    git(['add', 'docs/guide.md']);
    git(['commit', '-m', 'primary prose candidate']);
    const primaryCandidate = git(['rev-parse', 'HEAD']);
    pin(primary, primaryCandidate);
    assert.strictEqual(store.submitTicket(slug, primary.ref, 'primary-prose-worker', { commit: primaryCandidate, verify: 'node -e "process.exit(0)"' }).ok, true);
    const primarySubmission = store.getTicket(slug, primary.ref);
    Object.assign(primarySubmission.submission, {
      base: baseline, upstream: 'origin/main', upstreamCommit: baseline, integrationBranch: git(['branch', '--show-current']),
      commits: [primaryCandidate], changedPaths: ['docs/guide.md'],
    });
    persist(primarySubmission);

    const liveSibling = addClaimedTicket('live prose sibling without a candidate', 'live-prose-worker', { files: ['docs'] });
    const liveSiblingAssembly = store.assembleSubmissionWave(slug, [primary.ref]);
    assert.strictEqual(liveSiblingAssembly.ok, true, liveSiblingAssembly.message);
    assert.strictEqual(store.releaseTicket(slug, liveSibling.ref, 'live-prose-worker', { status: 'todo' }).ok, true);

    git(['reset', '--hard', baseline]);
    const sibling = addTicket('submitted prose sibling', { files: ['docs'] });
    assert.strictEqual(store.claimTicket(slug, sibling.ref, 'submitted-prose-worker', { direct: true, reason: 'The same-file wave fixture requires a local direct claim.' }).ok, true);
    fs.writeFileSync(docsPath, 'base\n\nsibling\n');
    git(['add', 'docs/guide.md']);
    git(['commit', '-m', 'submitted prose sibling']);
    const siblingCandidate = git(['rev-parse', 'HEAD']);
    pin(sibling, siblingCandidate);
    assert.strictEqual(store.submitTicket(slug, sibling.ref, 'submitted-prose-worker', { commit: siblingCandidate, verify: 'node -e "process.exit(0)"' }).ok, true);
    const siblingSubmission = store.getTicket(slug, sibling.ref);
    Object.assign(siblingSubmission.submission, {
      base: baseline, upstream: 'origin/main', upstreamCommit: baseline, integrationBranch: git(['branch', '--show-current']),
      commits: [siblingCandidate], changedPaths: ['docs/guide.md'],
    });
    persist(siblingSubmission);

    const storedPrimary = store.getTicket(slug, primary.ref).submission;
    const storedSibling = store.getTicket(slug, sibling.ref).submission;
    assert.deepStrictEqual(storedPrimary.changedPaths, ['docs/guide.md']);
    assert.deepStrictEqual(storedSibling.changedPaths, ['docs/guide.md']);
    assert.ok(!storedPrimary.commits.includes(siblingCandidate));
    assert.ok(!storedSibling.commits.includes(primaryCandidate));
    const singleton = store.assembleSubmissionWave(slug, [primary.ref]);
    assert.strictEqual(singleton.ok, false);
    assert.strictEqual(singleton.reason, 'candidate_overlap');
    assert.match(singleton.message, new RegExp(`${primary.ref} and ${sibling.ref} \\(docs\\/guide\\.md\\)`));
    assert.strictEqual(store.getTicket(slug, primary.ref).status, 'doing');
    assert.strictEqual(store.getTicket(slug, sibling.ref).status, 'doing');
    assert.strictEqual(store.pendingSubmission(store.getTicket(slug, primary.ref)), true);
    assert.strictEqual(store.pendingSubmission(store.getTicket(slug, sibling.ref)), true);

    const assembled = store.assembleSubmissionWave(slug, [primary.ref, sibling.ref]);
    assert.strictEqual(assembled.ok, true, assembled.message);
    assert.deepStrictEqual(assembled.wave.participants, [primary.ref, sibling.ref]);
  } finally {
    store.setBoardConfig(slug, { integrationMode: originalConfig.integrationMode, integrationBranch: originalConfig.integrationBranch });
    cleanBranch();
  }
});

test('SQ-2463: wave assembly replaces a stale wave baseline with the current target and gates ancestor candidates once', () => {
  cleanBranch();
  const originalConfig = store.boardConfig(slug);
  const integrationBranch = git(['branch', '--show-current']);
  store.setBoardConfig(slug, { integrationMode: 'local', integrationBranch });
  try {
    const docsPath = path.join(PROJECT_DIR, 'docs', 'wave-baseline.md');
    fs.mkdirSync(path.dirname(docsPath), { recursive: true });
    fs.writeFileSync(docsPath, 'base\n');
    git(['add', 'docs/wave-baseline.md']);
    git(['commit', '-m', 'wave baseline fixture']);
    const candidateBaseline = git(['rev-parse', 'HEAD']);
    const observedAt = new Date().toISOString();
    const staleWave = {
      id: 'stale-wave',
      baseline: { revision: { source: 'git', value: candidateBaseline, observedAt }, purpose: 'wave' },
      participants: [],
      state: 'gate_failed',
    };

    const primary = addTicket('primary stale-wave candidate', { files: ['docs'] });
    assert.strictEqual(store.claimTicket(slug, primary.ref, 'primary-wave-worker', { direct: true, reason: 'The stale wave fixture requires a local direct claim.' }).ok, true);
    fs.writeFileSync(docsPath, 'base\nprimary\n');
    git(['add', 'docs/wave-baseline.md']);
    git(['commit', '-m', 'primary stale-wave candidate']);
    const primaryCandidate = git(['rev-parse', 'HEAD']);
    pin(primary, primaryCandidate);
    assert.strictEqual(store.submitTicket(slug, primary.ref, 'primary-wave-worker', { commit: primaryCandidate, verify: 'node -e "process.exit(0)"' }).ok, true);
    const primarySubmission = store.getTicket(slug, primary.ref);
    Object.assign(primarySubmission.submission, {
      baseline: { revision: { source: 'git', value: candidateBaseline, observedAt }, purpose: 'dispatch' },
      changedPaths: ['docs/wave-baseline.md'],
      wave: staleWave,
    });
    persist(primarySubmission);

    git(['reset', '--hard', candidateBaseline]);
    const sibling = addTicket('sibling stale-wave candidate', { files: ['docs'] });
    assert.strictEqual(store.claimTicket(slug, sibling.ref, 'sibling-wave-worker', { direct: true, reason: 'The stale wave fixture requires a local direct claim.' }).ok, true);
    fs.writeFileSync(docsPath, 'base\nsibling\n');
    git(['add', 'docs/wave-baseline.md']);
    git(['commit', '-m', 'sibling stale-wave candidate']);
    const siblingCandidate = git(['rev-parse', 'HEAD']);
    pin(sibling, siblingCandidate);
    assert.strictEqual(store.submitTicket(slug, sibling.ref, 'sibling-wave-worker', { commit: siblingCandidate, verify: 'node -e "process.exit(0)"' }).ok, true);
    const siblingSubmission = store.getTicket(slug, sibling.ref);
    Object.assign(siblingSubmission.submission, {
      baseline: { revision: { source: 'git', value: candidateBaseline, observedAt }, purpose: 'dispatch' },
      changedPaths: ['docs/wave-baseline.md'],
      wave: staleWave,
    });
    persist(siblingSubmission);

    git(['reset', '--hard', candidateBaseline]);
    fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'wave-target-advance.js'), 'current target\n');
    git(['add', 'lib/wave-target-advance.js']);
    git(['commit', '-m', 'advance integration target after candidate baselines']);
    const currentTarget = git(['rev-parse', 'HEAD']);
    const gateScriptPath = path.join(PROJECT_DIR, 'count-wave-gates.cjs');
    const gateLogPath = path.join(PROJECT_DIR, 'wave-gates.log');
    fs.writeFileSync(gateScriptPath, `require('node:fs').appendFileSync(${JSON.stringify(gateLogPath)}, 'gate\\n');\n`);
    const gateCommand = `node ${JSON.stringify(gateScriptPath)}`;
    for (const ref of [primary.ref, sibling.ref]) {
      const ticket = store.getTicket(slug, ref);
      ticket.executorVerify = gateCommand;
      persist(ticket);
    }

    const assembled = store.assembleSubmissionWave(slug, [primary.ref, sibling.ref], { waveId: 'fresh-wave' });
    assert.strictEqual(assembled.ok, true, assembled.message);
    assert.strictEqual(assembled.wave.id, 'fresh-wave');
    assert.strictEqual(assembled.wave.baseline.revision.value, currentTarget);
    assert.deepStrictEqual(assembled.wave.participants, [primary.ref, sibling.ref]);
    assert.strictEqual(fs.readFileSync(gateLogPath, 'utf8'), 'gate\n');
    for (const ref of [primary.ref, sibling.ref]) {
      const ticket = store.getTicket(slug, ref);
      assert.strictEqual(ticket.status, 'doing');
      assert.strictEqual(store.pendingSubmission(ticket), true);
    }
  } finally {
    store.setBoardConfig(slug, { integrationMode: originalConfig.integrationMode, integrationBranch: originalConfig.integrationBranch });
    cleanBranch();
  }
});

test('SQ-2463: a wave invalidation preserves submitted candidate status', () => {
  cleanBranch();
  const originalConfig = store.boardConfig(slug);
  const integrationBranch = git(['branch', '--show-current']);
  store.setBoardConfig(slug, { integrationMode: 'local', integrationBranch });
  try {
    const primary = addTicket('valid current-target wave candidate', { files: ['docs'] });
    const primaryCandidate = createCandidateCommit('wave-status.js', 'primary\n');
    pin(primary, primaryCandidate);
    assert.strictEqual(store.claimTicket(slug, primary.ref, 'current-target-worker', { direct: true, reason: 'The invalidation fixture requires a local direct claim.' }).ok, true);
    assert.strictEqual(store.submitTicket(slug, primary.ref, 'current-target-worker', { commit: primaryCandidate, verify: 'node -e "process.exit(0)"' }).ok, true);
    const currentTarget = git(['rev-parse', 'HEAD']);
    const observedAt = new Date().toISOString();
    const currentSubmission = store.getTicket(slug, primary.ref);
    Object.assign(currentSubmission.submission, {
      baseline: { revision: { source: 'git', value: currentTarget, observedAt }, purpose: 'dispatch' },
      changedPaths: ['docs/wave-status.js'],
    });
    persist(currentSubmission);

    const invalid = addTicket('invalid wave candidate', { files: ['docs'] });
    const invalidPath = path.join(PROJECT_DIR, 'docs', 'invalid-wave-status.js');
    fs.mkdirSync(path.dirname(invalidPath), { recursive: true });
    fs.writeFileSync(invalidPath, 'invalid\n');
    git(['add', 'docs/invalid-wave-status.js']);
    git(['commit', '-m', 'invalid wave candidate']);
    const invalidCandidate = git(['rev-parse', 'HEAD']);
    pin(invalid, invalidCandidate);
    assert.strictEqual(store.claimTicket(slug, invalid.ref, 'invalid-wave-worker', { direct: true, reason: 'The invalidation fixture requires a local direct claim.' }).ok, true);
    assert.strictEqual(store.submitTicket(slug, invalid.ref, 'invalid-wave-worker', { commit: invalidCandidate, verify: 'node -e "process.exit(0)"' }).ok, true);
    const invalidSubmission = store.getTicket(slug, invalid.ref);
    Object.assign(invalidSubmission.submission, {
      baseline: { revision: { source: 'git', value: '0'.repeat(40), observedAt }, purpose: 'dispatch' },
      changedPaths: ['docs/invalid-wave-status.js'],
    });
    persist(invalidSubmission);

    const refused = store.assembleSubmissionWave(slug, [primary.ref, invalid.ref], { waveId: 'invalid-wave' });
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.reason, 'wave_invalidated');
    // SQ-59: the MCP ack forwards only reason and message, so the message must name the cause.
    assert.match(refused.message, new RegExp(`${invalid.ref} baseline_moved: `));
    // createCandidateCommit switches HEAD to a fresh branch, so the pinned target is
    // the configured integration branch's tip, not HEAD.
    assert.match(refused.message, new RegExp(`integration target git:${git(['rev-parse', `refs/heads/${integrationBranch}`])}\\. `));
    assert.strictEqual(store.getTicket(slug, primary.ref).status, 'doing');
    assert.strictEqual(store.getTicket(slug, invalid.ref).status, 'doing');
    assert.strictEqual(store.pendingSubmission(store.getTicket(slug, invalid.ref)), true);
  } finally {
    store.setBoardConfig(slug, { integrationMode: originalConfig.integrationMode, integrationBranch: originalConfig.integrationBranch });
    cleanBranch();
  }
});

export {};
