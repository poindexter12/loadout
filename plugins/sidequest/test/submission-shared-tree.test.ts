'use strict';
// SQ-137: one topic shard of the former submission.test.ts, split so the runner can spread its tests
// across workers. Shared setup and helpers live in ./_submission-fixture.ts; the tests are moved unchanged.
import {
  test,
  assert,
  path,
  fs,
  SIDEQUEST_HOME,
  store,
  mcp,
  db,
  PROJECT_DIR,
  REMOTE_DIR,
  git,
  cleanBranch,
  pin,
  slug,
  runCli,
  addTicket,
  noGitCliTicket,
  registeredNoGitCliRunnerWithCapability,
  callMcp,
  fixtureState,
} from './_submission-fixture.js';

test('SQ-2399: shared-tree siblings select submitted boundaries while isolated candidates keep their merge base', async (t?: any) => {
  if (git(['remote']).split(/\r?\n/).includes('origin')) {
    git(['remote', 'set-url', 'origin', REMOTE_DIR]);
  } else {
    git(['remote', 'add', 'origin', REMOTE_DIR]);
  }
  git(['fetch', 'origin']);
  cleanBranch();
  const dispatchBase = git(['rev-parse', 'origin/main']);
  const priorBoardConfig = store.boardConfig(slug);
  assert.strictEqual(store.setBoardConfig(slug, { integrationMode: 'remote', integrationBranch: 'main' }).ok, true);
  t.after(() => {
    store.setBoardConfig(slug, {
      integrationMode: priorBoardConfig.integrationMode,
      integrationBranch: priorBoardConfig.integrationBranch,
    });
    git(['checkout', '-f', '-B', `submission-${++fixtureState.branchSeq}`, dispatchBase]);
    git(['branch', '-f', 'main', dispatchBase]);
    git(['push', '--force', 'origin', 'main']);
    git(['fetch', 'origin']);
  });

  function dispatchTicket(title: string, file: string | string[], worker: string, sessionId: string, sharedTree: boolean) {
    const ticket = addTicket(title, { files: Array.isArray(file) ? file : [file], category: 'submission.fixture' });
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId, sharedTree });
    assert.strictEqual(store.claimTicket(slug, ticket.ref, worker, {
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
      sessionId,
    }).ok, true);
    return ticket;
  }

  async function submitTicket(ticket: any, worker: string, commit: string, base?: string) {
    pin(ticket, commit);
    return callMcp('submit', {
      project: PROJECT_DIR,
      ref: ticket.ref,
      by: worker,
      commit,
      ...(base ? { base } : {}),
      worktree: PROJECT_DIR,
      body: 'Shared-tree boundary fixture.',
    });
  }

  const first = dispatchTicket('shared boundary first', 'lib/shared-first.js', 'shared-first-worker', 'shared-boundary-first', true);
  const second = dispatchTicket('shared boundary second', 'lib/shared-second.js', 'shared-second-worker', 'shared-boundary-second', true);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'shared-first.js'), 'first\n');
  git(['add', 'lib/shared-first.js']);
  git(['commit', '-m', 'shared boundary first']);
  const firstCommit = git(['rev-parse', 'HEAD']);
  const firstSubmitted = await submitTicket(first, 'shared-first-worker', firstCommit);
  assert.strictEqual(firstSubmitted.ok, true, firstSubmitted.message);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'shared-second.js'), 'second\n');
  git(['add', 'lib/shared-second.js']);
  git(['commit', '-m', 'shared boundary second']);
  const secondCommit = git(['rev-parse', 'HEAD']);
  const secondSubmitted = await submitTicket(second, 'shared-second-worker', secondCommit);
  assert.strictEqual(secondSubmitted.ok, true, secondSubmitted.message);
  const storedSecondSubmission = store.getTicket(slug, second.ref).submission;
  assert.strictEqual(storedSecondSubmission.base, firstCommit);
  assert.deepStrictEqual(storedSecondSubmission.commits, [secondCommit]);
  assert.deepStrictEqual(storedSecondSubmission.changedPaths, ['lib/shared-second.js']);

  const integrationTarget = Object.assign({}, store.integrationTarget(slug), { branch: 'main' });
  git(['checkout', '-f', '-B', 'main', dispatchBase]);
  const firstDelivery = store.integrateSubmission(slug, first.ref, { target: integrationTarget, mode: 'replay' });
  assert.strictEqual(firstDelivery.ok, true, firstDelivery.message);
  const beforeSecondDelivery = git(['rev-parse', 'HEAD']);
  const secondDelivery = store.integrateSubmission(slug, second.ref, { target: integrationTarget, mode: 'replay' });
  assert.strictEqual(secondDelivery.ok, true, secondDelivery.message);
  assert.deepStrictEqual(git(['diff', '--name-only', beforeSecondDelivery, 'HEAD']).split(/\r?\n/).filter(Boolean), ['lib/shared-second.js']);

  cleanBranch();
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  const explicitFirst = dispatchTicket('explicit shared boundary first', 'lib/explicit-first.js', 'explicit-first-worker', 'explicit-shared-first', true);
  const explicitSecond = dispatchTicket('explicit shared boundary second', 'lib/explicit-second.js', 'explicit-second-worker', 'explicit-shared-second', true);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'explicit-first.js'), 'first\n');
  git(['add', 'lib/explicit-first.js']);
  git(['commit', '-m', 'explicit shared boundary first']);
  const explicitFirstCommit = git(['rev-parse', 'HEAD']);
  assert.strictEqual((await submitTicket(explicitFirst, 'explicit-first-worker', explicitFirstCommit)).ok, true);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'explicit-second.js'), 'second\n');
  git(['add', 'lib/explicit-second.js']);
  git(['commit', '-m', 'explicit shared boundary second']);
  const explicitSecondCommit = git(['rev-parse', 'HEAD']);
  const explicitSecondSubmitted = await submitTicket(explicitSecond, 'explicit-second-worker', explicitSecondCommit, explicitFirstCommit);
  assert.strictEqual(explicitSecondSubmitted.ok, true, explicitSecondSubmitted.message);
  assert.strictEqual(store.getTicket(slug, explicitSecond.ref).submission.base, explicitFirstCommit);

  cleanBranch();
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  const duplicateFirst = dispatchTicket('duplicate boundary first', 'lib/duplicate-first.js', 'duplicate-first-worker', 'duplicate-boundary-first', true);
  const duplicateSecond = dispatchTicket('duplicate boundary second', 'lib/duplicate-second.js', 'duplicate-second-worker', 'duplicate-boundary-second', true);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'duplicate-first.js'), 'first\n');
  git(['add', 'lib/duplicate-first.js']);
  git(['commit', '-m', 'duplicate boundary first']);
  const duplicateFirstCommit = git(['rev-parse', 'HEAD']);
  assert.strictEqual((await submitTicket(duplicateFirst, 'duplicate-first-worker', duplicateFirstCommit)).ok, true);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'duplicate-second.js'), 'second\n');
  git(['add', 'lib/duplicate-second.js']);
  git(['commit', '-m', 'duplicate boundary second']);
  const duplicateSecondCommit = git(['rev-parse', 'HEAD']);
  const duplicateRefused = await submitTicket(duplicateSecond, 'duplicate-second-worker', duplicateSecondCommit, dispatchBase);
  assert.strictEqual(duplicateRefused.ok, false);
  assert.strictEqual(duplicateRefused.reason, 'duplicate_submission');
  assert.match(duplicateRefused.message, new RegExp(duplicateFirstCommit));
  assert.match(duplicateRefused.message, new RegExp(`--base ${duplicateFirstCommit}`));

  // SQ-304: a review-rejected candidate is parked, never integrated, and a repair is
  // expected to branch from it and carry its range forward, so it must not count as the
  // duplicate source that forces an undocumented squash.
  cleanBranch();
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  const rejectedCandidate = dispatchTicket('rejected candidate', 'lib/rejected-candidate.js', 'rejected-candidate-worker', 'rejected-candidate', false);
  const repairOfRejected = dispatchTicket('repair of rejected candidate', ['lib/rejected-candidate.js', 'lib/rejected-repair.js'], 'rejected-repair-worker', 'rejected-repair', false);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'rejected-candidate.js'), 'rejected\n');
  git(['add', 'lib/rejected-candidate.js']);
  git(['commit', '-m', 'rejected candidate']);
  const rejectedCandidateCommit = git(['rev-parse', 'HEAD']);
  assert.strictEqual((await submitTicket(rejectedCandidate, 'rejected-candidate-worker', rejectedCandidateCommit)).ok, true);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'rejected-repair.js'), 'repair\n');
  git(['add', 'lib/rejected-repair.js']);
  git(['commit', '-m', 'repair of rejected candidate']);
  const repairCommit = git(['rev-parse', 'HEAD']);
  // Negative control: while the candidate carries no rejection, the same range is still
  // a duplicate, so the exclusion below is what admits the repair.
  const notYetRejected = await submitTicket(repairOfRejected, 'rejected-repair-worker', repairCommit, dispatchBase);
  assert.strictEqual(notYetRejected.ok, false);
  assert.strictEqual(notYetRejected.reason, 'duplicate_submission');
  assert.match(notYetRejected.message, new RegExp(rejectedCandidate.ref));
  const rejectedTicket = store.getTicket(slug, rejectedCandidate.ref);
  rejectedTicket.submission.review = { outcome: 'rejected' };
  db.putRow(db.openDb(SIDEQUEST_HOME), 'tickets', {
    id: rejectedTicket.id, project: slug, ref: rejectedTicket.ref, status: rejectedTicket.status,
    archived: rejectedTicket.archived ? 1 : 0, ord: rejectedTicket.order,
    claim_by: rejectedTicket.claim?.by || null, data: rejectedTicket,
  });
  const repairSubmitted = await submitTicket(repairOfRejected, 'rejected-repair-worker', repairCommit, dispatchBase);
  assert.strictEqual(repairSubmitted.ok, true, repairSubmitted.message);
  assert.deepStrictEqual(
    store.getTicket(slug, repairOfRejected.ref).submission.changedPaths.slice().sort(),
    ['lib/rejected-candidate.js', 'lib/rejected-repair.js'],
    'the repair carries the rejected candidate range forward without a squash',
  );

  cleanBranch();
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  const chainFirst = dispatchTicket('three-deep first', 'lib/chain-first.js', 'chain-first-worker', 'chain-first', true);
  const chainSecond = dispatchTicket('three-deep second', 'lib/chain-second.js', 'chain-second-worker', 'chain-second', true);
  const chainThird = dispatchTicket('three-deep third', 'lib/chain-third.js', 'chain-third-worker', 'chain-third', true);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'chain-first.js'), 'first\n');
  git(['add', 'lib/chain-first.js']);
  git(['commit', '-m', 'three-deep first']);
  const chainFirstCommit = git(['rev-parse', 'HEAD']);
  assert.strictEqual((await submitTicket(chainFirst, 'chain-first-worker', chainFirstCommit)).ok, true);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'chain-second.js'), 'second\n');
  git(['add', 'lib/chain-second.js']);
  git(['commit', '-m', 'three-deep second']);
  const chainSecondCommit = git(['rev-parse', 'HEAD']);
  assert.strictEqual((await submitTicket(chainSecond, 'chain-second-worker', chainSecondCommit)).ok, true);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'chain-third.js'), 'third\n');
  git(['add', 'lib/chain-third.js']);
  git(['commit', '-m', 'three-deep third']);
  const chainThirdCommit = git(['rev-parse', 'HEAD']);
  const chainThirdSubmitted = await submitTicket(chainThird, 'chain-third-worker', chainThirdCommit);
  assert.strictEqual(chainThirdSubmitted.ok, true, chainThirdSubmitted.message);
  const storedChainThirdSubmission = store.getTicket(slug, chainThird.ref).submission;
  assert.strictEqual(storedChainThirdSubmission.base, chainSecondCommit);
  assert.deepStrictEqual(storedChainThirdSubmission.commits, [chainThirdCommit]);

  cleanBranch();
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  const integratedSibling = dispatchTicket('integrated sibling', 'lib/integrated-sibling.js', 'integrated-sibling-worker', 'integrated-sibling', true);
  const isolated = dispatchTicket('isolated fast-forward candidate', 'lib/isolated-candidate.js', 'isolated-candidate-worker', 'isolated-candidate', false);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'integrated-sibling.js'), 'sibling\n');
  git(['add', 'lib/integrated-sibling.js']);
  git(['commit', '-m', 'integrated sibling']);
  const integratedSiblingCommit = git(['rev-parse', 'HEAD']);
  assert.strictEqual((await submitTicket(integratedSibling, 'integrated-sibling-worker', integratedSiblingCommit)).ok, true);
  git(['checkout', '-f', '-B', 'main', dispatchBase]);
  const siblingDelivery = store.integrateSubmission(slug, integratedSibling.ref, { target: integrationTarget, mode: 'replay' });
  assert.strictEqual(siblingDelivery.ok, true, siblingDelivery.message);
  const integratedSiblingHead = git(['rev-parse', 'HEAD']);
  git(['push', 'origin', 'main']);
  git(['fetch', 'origin']);
  git(['checkout', '-f', '-B', `submission-${++fixtureState.branchSeq}`, 'main']);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'isolated-candidate.js'), 'isolated\n');
  git(['add', 'lib/isolated-candidate.js']);
  git(['commit', '-m', 'isolated candidate after sibling']);
  const isolatedCommit = git(['rev-parse', 'HEAD']);
  const isolatedSubmitted = await submitTicket(isolated, 'isolated-candidate-worker', isolatedCommit);
  assert.strictEqual(isolatedSubmitted.ok, true, isolatedSubmitted.message);
  const storedIsolatedSubmission = store.getTicket(slug, isolated.ref).submission;
  assert.strictEqual(storedIsolatedSubmission.base, integratedSiblingHead);
  assert.deepStrictEqual(storedIsolatedSubmission.commits, [isolatedCommit]);
});

test('a submit after a terminal dispatch is gated on current ticket scope, not the dead binding', () => {
  const ticket = addTicket('terminal dispatch binding must not gate the submit', { files: ['lib/original.js'], category: 'submission.fixture' });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: 'terminal-binding', sharedTree: true });
  assert.strictEqual(store.claimTicket(slug, ticket.ref, 'terminal-binding-worker', {
    token: prepared.token, executor: prepared.ticket.dispatchExecutor, sessionId: 'terminal-binding',
  }).ok, true);
  assert.strictEqual(store.releaseTicket(slug, ticket.ref, 'terminal-binding-worker', {
    status: 'todo',
    source: 'mcp',
    releaseKind: 'handback',
    releaseReason: 'A stale pin outside the dispatched binding blocks verify.',
  }).ok, true);
  assert.ok(store.getTicket(slug, ticket.ref).dispatch.terminalAt);
  store.updateTicket(slug, ticket.ref, { files: ['lib/original.js', 'lib/granted-late.js'] });
  assert.deepStrictEqual(store.getTicket(slug, ticket.ref).files, ['lib/original.js', 'lib/granted-late.js']);
  assert.strictEqual(store.claimTicket(slug, ticket.ref, 'orchestrator-main', {
    direct: true, reason: 'Finishing the granted-path edit inline after the handback.',
  }).ok, true);
  cleanBranch();
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'original.js'), 'original\n');
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'granted-late.js'), 'granted\n');
  git(['add', 'lib/original.js', 'lib/granted-late.js']);
  git(['commit', '-m', 'granted-path candidate']);
  const grantedCommit = git(['rev-parse', 'HEAD']);
  pin(ticket, grantedCommit);
  const grantedBase = git(['rev-parse', 'origin/main']);
  const submission = store.submitTicket(slug, ticket.ref, 'orchestrator-main', {
    commit: grantedCommit,
    range: {
      base: grantedBase,
      upstream: 'origin/main',
      upstreamCommit: grantedBase,
      commits: [grantedCommit],
      changedPaths: ['lib/granted-late.js', 'lib/original.js'],
    },
  });
  assert.strictEqual(submission.ok, true, submission.message);
  assert.ok(submission.ticket.submission.admittedScope.includes('lib/granted-late.js'));
});

test('no-Git submission fixtures pin the available fixture route', () => {
  const { project, ticket } = noGitCliTicket('fixture routing', ['wiki/page.md']);
  assert.strictEqual(ticket.category, 'submission.fixture');
  const prepared = store.prepareDispatch(project, ticket.ref, { sharedTree: true });
  assert.deepStrictEqual(
    { model: prepared.ticket.model, effort: prepared.ticket.effort },
    { model: 'sonnet', effort: 'medium' },
  );
});

test('SQ-1947: MCP retry binds one capability result to the checkpointed candidate', async (context: any) => {
  const { project, projectPath, ticket } = noGitCliTicket('retry checkpoint', ['wiki/page.md']);
  const by = 'checkpoint-worker';
  const prepared = store.prepareDispatch(project, ticket.ref, { sharedTree: true });
  assert.strictEqual(store.claimTicket(project, ticket.ref, by, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  const sourceRevision = { source: 'wiki', value: 'wiki-revision-44', observedAt: '2026-08-14T00:00:00.000Z' };
  const verify = 'attestation: wiki-revision-44 | editor-approved | immutable revision was reviewed';
  const refused = await callMcp('submit', {
    project: projectPath,
    ref: ticket.ref,
    by,
    sourceRevision,
    changedSurfaces: ['wiki/page.md'],
    projectCapabilities: { process: false, worktree: false, review: true },
    verify,
    body: 'Checkpoint the immutable wiki candidate.',
  });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'baseline_membership_unavailable');
  assert.deepStrictEqual(refused.retry.candidate, sourceRevision);
  assert.strictEqual(refused.retry.verify, verify);
  assert.deepStrictEqual(refused.retry.baseline, prepared.ticket.dispatch.lifecycleAttempt.baseline);

  const capabilityInvocations: any[] = [];
  let capabilityAvailable = false;
  const unregister = store.registerSourceRevisionCapability(project, (candidate: any, baseline: any) => {
    capabilityInvocations.push({ candidate, baseline, frozen: Object.isFrozen(baseline) && Object.isFrozen(baseline.revision) });
    return capabilityAvailable ? { candidateExists: true, containsCandidate: true } : null;
  });
  context.after(unregister);

  const checkpoint = store.getTicket(project, ticket.ref).submissionRetry;
  const replacementRefusal = await callMcp('submit', {
    project: projectPath,
    ref: ticket.ref,
    by,
    sourceRevision: { source: 'wiki', value: 'caller-replacement', observedAt: '2026-08-14T01:00:00.000Z' },
    changedSurfaces: ['wiki/replacement.md'],
    projectCapabilities: { process: true, worktree: true, review: false },
    body: 'Retry with a caller replacement that cannot change checkpoint identity.',
  });
  assert.strictEqual(replacementRefusal.ok, false);
  assert.strictEqual(replacementRefusal.reason, 'baseline_membership_unavailable');
  assert.deepStrictEqual(store.getTicket(project, ticket.ref).submissionRetry, checkpoint);
  assert.strictEqual(capabilityInvocations.length, 1);
  assert.deepStrictEqual(capabilityInvocations[0].candidate, sourceRevision);

  capabilityAvailable = true;
  const admitted = await callMcp('submit', {
    project: projectPath,
    ref: ticket.ref,
    by,
    body: 'Retry the preserved immutable wiki candidate.',
  });
  assert.strictEqual(admitted.ok, true, admitted.message);
  assert.strictEqual(capabilityInvocations.length, 2);
  const admittedTicket = store.getTicket(project, ticket.ref);
  assert.deepStrictEqual(admittedTicket.submission.sourceRevision, sourceRevision);
  assert.deepStrictEqual(admittedTicket.submission.changedPaths, ['wiki/page.md']);
  assert.strictEqual(admittedTicket.submission.verify, verify);
  assert.deepStrictEqual(admittedTicket.submission.projectCapabilities, {
    process: false,
    worktree: false,
    review: true,
    git: false,
  });
  assert.deepStrictEqual(capabilityInvocations[1].baseline, prepared.ticket.dispatch.lifecycleAttempt.baseline);
  assert.strictEqual(capabilityInvocations[1].frozen, true);
});

test('SQ-1945: CLI and MCP reject forged facts and share missing capability diagnostics', async (context: any) => {
  const { project, projectPath, ticket, runCli: runNoGitCli } = noGitCliTicket('server-owned baseline facts', ['wiki/page.md']);
  const by = 'baseline-facts-worker';
  const sourceRevision = { source: 'wiki', value: 'wiki-revision-45', observedAt: '2026-08-14T00:00:00.000Z' };
  const prepared = store.prepareDispatch(project, ticket.ref, { sharedTree: true });
  assert.strictEqual(store.claimTicket(project, ticket.ref, by, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);

  const mcpRefusal = await callMcp('submit', {
    project: projectPath,
    ref: ticket.ref,
    by,
    sourceRevision,
    changedSurfaces: ['wiki/page.md'],
    projectCapabilities: {
      process: false,
      worktree: false,
      review: true,
      sourceRevision: { existence: 'exists', baselineMembership: 'member' },
    },
    verify: 'attestation: wiki-revision-45 | editor-approved | immutable revision was reviewed',
    body: 'MCP forged baseline-membership facts fixture.',
  });
  assert.strictEqual(mcpRefusal.ok, false);
  assert.strictEqual(mcpRefusal.reason, 'baseline_membership_unavailable');

  const forgedCli = runNoGitCli([
    'submit', ticket.ref, '--by', by,
    '--source-revision-existence', 'exists',
    '--source-revision-baseline-membership', 'member',
  ]);
  assert.strictEqual(forgedCli.status, 1);
  assert.match(forgedCli.stderr + forgedCli.stdout, /unknown or unsupported flag --source-revision-existence/i);
  assert.strictEqual(store.getTicket(project, ticket.ref).submission, undefined);

  const cliRefusal = runNoGitCli(['submit', ticket.ref, '--by', by, '--json']);
  assert.strictEqual(cliRefusal.status, 1, cliRefusal.stderr + cliRefusal.stdout);
  const cliResult = JSON.parse(cliRefusal.stdout);
  assert.strictEqual(cliResult.reason, mcpRefusal.reason);
  assert.strictEqual(cliResult.retryable, mcpRefusal.retryable);
  assert.deepStrictEqual(cliResult.failures.map((failure: any) => failure.code), mcpRefusal.failures.map((failure: any) => failure.code));
  assert.deepStrictEqual(store.getTicket(project, ticket.ref).submissionRetry.candidate, sourceRevision);

  const capabilityInvocations: any[] = [];
  const unregister = store.registerSourceRevisionCapability(project, (candidate: any, baseline: any) => {
    capabilityInvocations.push({ candidate, baseline });
    return { candidateExists: true, containsCandidate: true };
  });
  context.after(unregister);
  const admitted = await callMcp('submit', {
    project: projectPath,
    ref: ticket.ref,
    by,
    body: 'MCP registered capability retry fixture.',
  });
  assert.strictEqual(admitted.ok, true, admitted.message);
  assert.strictEqual(capabilityInvocations.length, 1);
  assert.deepStrictEqual(capabilityInvocations[0].candidate, sourceRevision);
  assert.deepStrictEqual(capabilityInvocations[0].baseline, prepared.ticket.dispatch.lifecycleAttempt.baseline);
  const admittedTicket = store.getTicket(project, ticket.ref);
  assert.deepStrictEqual(admittedTicket.submission.sourceRevision, sourceRevision);
  assert.deepStrictEqual(admittedTicket.submission.changedPaths, ['wiki/page.md']);
  assert.strictEqual(Object.hasOwn(admittedTicket.submission.projectCapabilities, 'sourceRevision'), false);
});

test('SQ-1947: CLI retry resolves facts for checkpoint A instead of caller candidate B', () => {
  const { project, projectPath, ticket, runCli: runNoGitCli } = noGitCliTicket('CLI checkpoint identity', ['wiki/page.md']);
  const by = 'cli-checkpoint-worker';
  const prepared = store.prepareDispatch(project, ticket.ref, { sharedTree: true });
  assert.strictEqual(store.claimTicket(project, ticket.ref, by, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  const checkpointCandidate = { source: 'wiki', value: 'checkpoint-A', observedAt: '2026-08-14T00:00:00.000Z' };
  const first = runNoGitCli([
    'submit', ticket.ref, '--by', by,
    '--source-revision-source', checkpointCandidate.source,
    '--source-revision-value', checkpointCandidate.value,
    '--source-revision-observed-at', checkpointCandidate.observedAt,
    '--changed-surface', 'wiki/page.md', '--no-process', '--no-worktree', '--review',
    '--verify', 'attestation: checkpoint-A | editor-approved | immutable revision was reviewed',
    '--body', 'Checkpoint candidate A.', '--json',
  ]);
  assert.strictEqual(first.status, 1, first.stderr + first.stdout);
  assert.strictEqual(JSON.parse(first.stdout).reason, 'baseline_membership_unavailable');

  const { runCli: runCandidateOnlyCli, invocationLog } = registeredNoGitCliRunnerWithCapability(project, projectPath, [
    `const admitted = candidate.value === 'caller-B';`,
    `return { candidateExists: admitted, containsCandidate: admitted };`,
  ]);
  const retry = runCandidateOnlyCli([
    'submit', ticket.ref, '--by', by,
    '--source-revision-source', 'wiki',
    '--source-revision-value', 'caller-B',
    '--source-revision-observed-at', '2026-08-14T01:00:00.000Z',
    '--changed-surface', 'wiki/replacement.md',
    '--body', 'Caller candidate B cannot replace checkpoint A.', '--json',
  ]);
  assert.strictEqual(retry.status, 1, retry.stderr + retry.stdout);
  assert.strictEqual(JSON.parse(retry.stdout).reason, 'source_revision_missing');
  const invocations = fs.readFileSync(invocationLog, 'utf8').trim().split(/\r?\n/).map((line: string) => JSON.parse(line));
  assert.strictEqual(invocations.length, 1);
  assert.deepStrictEqual(invocations[0].candidate, checkpointCandidate);
  assert.deepStrictEqual(store.getTicket(project, ticket.ref).submissionRetry.candidate, checkpointCandidate);
  assert.strictEqual(store.getTicket(project, ticket.ref).submission, undefined);
});

test('SQ-1947: a throwing CLI resolver is called once and cannot admit on a second probe', () => {
  const { project, projectPath, ticket } = noGitCliTicket('CLI one-call resolver', ['wiki/page.md']);
  const by = 'cli-one-call-worker';
  const prepared = store.prepareDispatch(project, ticket.ref, { sharedTree: true });
  assert.strictEqual(store.claimTicket(project, ticket.ref, by, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  const { runCli: runThrowingCli, invocationLog } = registeredNoGitCliRunnerWithCapability(project, projectPath, [
    `if (invocationCount === 1) throw new Error('temporary adapter failure');`,
    `return { candidateExists: true, containsCandidate: true };`,
  ]);
  const refused = runThrowingCli([
    'submit', ticket.ref, '--by', by,
    '--source-revision-source', 'wiki',
    '--source-revision-value', 'one-call-revision',
    '--source-revision-observed-at', '2026-08-14T00:00:00.000Z',
    '--changed-surface', 'wiki/page.md', '--no-process', '--no-worktree', '--review',
    '--verify', 'attestation: one-call-revision | editor-approved | immutable revision was reviewed',
    '--body', 'A throwing adapter stays unavailable for this admission.', '--json',
  ]);
  assert.strictEqual(refused.status, 1, refused.stderr + refused.stdout);
  assert.strictEqual(JSON.parse(refused.stdout).reason, 'baseline_membership_unavailable');
  const invocations = fs.readFileSync(invocationLog, 'utf8').trim().split(/\r?\n/).map((line: string) => JSON.parse(line));
  assert.strictEqual(invocations.length, 1);
  assert.strictEqual(store.getTicket(project, ticket.ref).submission, undefined);
});

test('SQ-1947: resolver replacement teardown is generation-owned and project-isolated', () => {
  const sourceRevisionCapability = require('../lib/source-revision-capability.js');
  const firstProject = noGitCliTicket('first capability project', ['wiki/first.md']);
  const secondProject = noGitCliTicket('second capability project', ['wiki/second.md']);
  const firstPrepared = store.prepareDispatch(firstProject.project, firstProject.ticket.ref, { sharedTree: true });
  const secondPrepared = store.prepareDispatch(secondProject.project, secondProject.ticket.ref, { sharedTree: true });
  const candidate = { source: 'wiki', value: 'resolver-generation', observedAt: '2026-08-14T00:00:00.000Z' };
  let staleCalls = 0;
  let replacementCalls = 0;
  let secondProjectCalls = 0;
  const unregisterStale = store.registerSourceRevisionCapability(firstProject.project, () => {
    staleCalls += 1;
    return { candidateExists: false, containsCandidate: false };
  });
  const unregisterReplacement = store.registerSourceRevisionCapability(firstProject.project, () => {
    replacementCalls += 1;
    return { candidateExists: true, containsCandidate: true };
  });
  unregisterStale();
  unregisterReplacement();
  const removedFacts = sourceRevisionCapability.sourceRevisionAdapterFacts(
    firstProject.project,
    candidate,
    firstPrepared.ticket.dispatch.lifecycleAttempt.baseline,
  );
  assert.strictEqual(removedFacts.baseline, null);
  assert.strictEqual(staleCalls, 0);
  assert.strictEqual(replacementCalls, 0);

  const unregisterFirst = store.registerSourceRevisionCapability(firstProject.project, () => {
    replacementCalls += 1;
    return { candidateExists: false, containsCandidate: false };
  });
  const unregisterSecond = store.registerSourceRevisionCapability(secondProject.project, () => {
    secondProjectCalls += 1;
    return { candidateExists: true, containsCandidate: true };
  });
  try {
    const firstFacts = sourceRevisionCapability.sourceRevisionAdapterFacts(
      firstProject.project,
      candidate,
      firstPrepared.ticket.dispatch.lifecycleAttempt.baseline,
    );
    const secondFacts = sourceRevisionCapability.sourceRevisionAdapterFacts(
      secondProject.project,
      candidate,
      secondPrepared.ticket.dispatch.lifecycleAttempt.baseline,
    );
    assert.deepStrictEqual(firstFacts.baseline, { candidateExists: false, containsCandidate: false });
    assert.deepStrictEqual(secondFacts.baseline, { candidateExists: true, containsCandidate: true });
    assert.strictEqual(replacementCalls, 1);
    assert.strictEqual(secondProjectCalls, 1);
  } finally {
    unregisterFirst();
    unregisterSecond();
  }
});

test('SQ-1947: kernel refuses authentic facts bound to a different retry candidate', (context: any) => {
  const sourceRevisionCapability = require('../lib/source-revision-capability.js');
  const { project, ticket } = noGitCliTicket('bound capability facts', ['wiki/page.md']);
  const by = 'bound-facts-worker';
  const prepared = store.prepareDispatch(project, ticket.ref, { sharedTree: true });
  assert.strictEqual(store.claimTicket(project, ticket.ref, by, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  const checkpointCandidate = { source: 'wiki', value: 'checkpoint-A', observedAt: '2026-08-14T00:00:00.000Z' };
  const dispatchBaseline = prepared.ticket.dispatch.lifecycleAttempt.baseline;
  const unavailableFacts = sourceRevisionCapability.sourceRevisionAdapterFacts(project, checkpointCandidate, dispatchBaseline);
  const refused = store.submitTicket(project, ticket.ref, by, {
    sourceRevision: checkpointCandidate,
    changedSurfaces: ['wiki/page.md'],
    projectCapabilities: { process: false, worktree: false, review: true },
    verify: 'attestation: checkpoint-A | editor-approved | immutable revision was reviewed',
    admissionFacts: unavailableFacts,
  });
  assert.strictEqual(refused.reason, 'baseline_membership_unavailable');

  const callerCandidate = { source: 'wiki', value: 'caller-B', observedAt: '2026-08-14T01:00:00.000Z' };
  const unregister = store.registerSourceRevisionCapability(project, () => ({ candidateExists: true, containsCandidate: true }));
  context.after(unregister);
  const callerFacts = sourceRevisionCapability.sourceRevisionAdapterFacts(project, callerCandidate, dispatchBaseline);
  const mismatched = store.submitTicket(project, ticket.ref, by, {
    sourceRevision: callerCandidate,
    admissionFacts: callerFacts,
  });
  assert.strictEqual(mismatched.ok, false);
  assert.strictEqual(mismatched.reason, 'baseline_membership_unavailable');
  assert.deepStrictEqual(store.getTicket(project, ticket.ref).submissionRetry.candidate, checkpointCandidate);
  assert.strictEqual(store.getTicket(project, ticket.ref).submission, undefined);
});

export {};
