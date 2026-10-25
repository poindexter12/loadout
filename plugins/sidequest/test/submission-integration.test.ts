'use strict';
// SQ-137: one topic shard of the former submission.test.ts, split so the runner can spread its tests
// across workers. Shared setup and helpers live in ./_submission-fixture.ts; the tests are moved unchanged.
import {
  test,
  assert,
  path,
  fs,
  store,
  PROJECT_DIR,
  git,
  cleanBranch,
  pin,
  slug,
  runCli,
  cliJson,
  COMMIT,
  persist,
  addTicket,
  noGitCliTicket,
  registeredNoGitCliRunner,
  callMcp,
  fixtureState,
} from './_submission-fixture.js';

test('legacy root scope cannot bypass integration and names explicit transitions', () => {
  cleanBranch();
  const ticket = addTicket('legacy root scope snapshot', { files: ['lib/legacy.js'] });
  assert.strictEqual(runCli(['claim', ticket.ref, '--by', 'legacy-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'legacy.js'), 'legacy\n');
  git(['add', 'lib/legacy.js']);
  git(['commit', '-m', 'legacy root scope candidate']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(ticket, commit);
  assert.strictEqual(runCli(['submit', ticket.ref, '--by', 'legacy-worker', '--commit', commit]).status, 0);
  const legacy = store.getTicket(slug, ticket.ref);
  legacy.submission.admittedScope = [' . ', '.'];
  persist(legacy);

  const attemptedBypass = store.validateIntegrationSubmission(slug, ticket.ref, { overrideLegacyScope: true });
  assert.strictEqual(attemptedBypass.ok, false);
  assert.strictEqual(attemptedBypass.reason, 'outside_scope');
  assert.match(attemptedBypass.message, /rework/);
  assert.match(attemptedBypass.message, /supersede_submission/);

  const removedFlag = runCli(['groom-close', ticket.ref, '--by', 'orchestrator', '--integration', '--override-legacy-scope', '--reason', 'A removed flag cannot bypass scope admission.']);
  assert.strictEqual(removedFlag.status, 1);
  assert.match(removedFlag.stderr + removedFlag.stdout, /unknown or unsupported flag --override-legacy-scope/);

  const refused = runCli(['groom-close', ticket.ref, '--by', 'orchestrator', '--integration', '--reason', 'Scope admission remains mandatory.']);
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr + refused.stdout, /rework/);
  assert.match(refused.stderr + refused.stdout, /supersede_submission/);
  const retained = store.getTicket(slug, ticket.ref);
  assert.strictEqual(retained.status, 'doing');
  assert.strictEqual(retained.submission.commit, commit);
});

test('scope snapshots refuse changed paths at queue and integration after ticket scope changes', () => {
  cleanBranch();
  const t = addTicket('immutable admitted scope', { files: ['lib/snapshotted.js'] });
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'snapshot-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'snapshotted.js'), 'snapshotted\n');
  git(['add', 'lib/snapshotted.js']);
  git(['commit', '-m', 'snapshotted scope candidate']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(t, commit);
  assert.strictEqual(runCli(['submit', t.ref, '--by', 'snapshot-worker', '--commit', commit]).status, 0);
  assert.deepStrictEqual(store.getTicket(slug, t.ref).submission.admittedScope, ['lib/snapshotted.js']);

  store.updateTicket(slug, t.ref, { files: ['lib'] });
  assert.deepStrictEqual(store.getTicket(slug, t.ref).submission.admittedScope, ['lib/snapshotted.js']);
  const malformed = store.getTicket(slug, t.ref);
  malformed.submission.admittedScope = ['lib/rewritten.js'];
  persist(malformed);

  const queued = cliJson(['publish', 'queue', '--json']).tickets.find((entry?: any) => entry.ref === t.ref);
  assert.strictEqual(queued.rangeValidation.reason, 'outside_scope');
  assert.deepStrictEqual(queued.rangeValidation.outside, ['lib/snapshotted.js']);
  const refused = runCli(['groom-close', t.ref, '--by', 'orchestrator', '--integration', '--reason', `Integrated ${commit} into main.`]);
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr + refused.stdout, /lib\/snapshotted\.js/);
});

test('brief and pulse surface a pending submission', () => {
  const t = addTicket('surfaced submission');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-a', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  assert.strictEqual(store.submitTicket(slug, t.ref, 'worker-a', { commit: COMMIT }).ok, true);

  const brief = store.briefTicket(slug, store.getTicket(slug, t.ref));
  assert.strictEqual(brief.submission.commit, COMMIT);

  const pulse = store.pulsePayload(slug, t.ref);
  assert.strictEqual(pulse.submission.commit, COMMIT);
  assert.strictEqual(pulse.claim, null);
});

test('CLI: scoped commit excludes a foreign staged path and keeps it staged', () => {
  const t = addTicket('cli scoped commit', { files: ['lib/cli-scoped.js'] });
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'scope-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'cli-scoped.js'), 'scoped\n');
  fs.writeFileSync(path.join(PROJECT_DIR, 'foreign.js'), 'foreign\n');
  git(['add', '.']);

  const committed = runCli(['commit', t.ref, '--by', 'scope-worker', '--message', 'scoped fixture']);
  assert.strictEqual(committed.status, 0, committed.stderr + committed.stdout);
  assert.equal(git(['show', '--format=', '--name-only', 'HEAD']), 'lib/cli-scoped.js');
  assert.equal(git(['diff', '--cached', '--name-only']), 'foreign.js');
  assert.match(store.getTicket(slug, t.ref).comments.at(-1).body, /out-of-scope changes present: foreign\.js/);
  assert.strictEqual(runCli(['release', t.ref, '--by', 'scope-worker']).status, 0);
  git(['reset', '--', 'foreign.js']);
});

test('SQ-1008: scope-gated submission is refused and legacy partial records stay visibly blocked', () => {
  const unscopedPaths = [
    'plugins/model-gateway/bin/model-gateway.js',
    'plugins/model-gateway/test/context-window.test.js',
    'plugins/observability/skills/enable-project-telemetry/SKILL.md',
    'plugins/observability/skills/init-workspace/SKILL.md',
    'plugins/observability/test/init-workspace-skill.test.js',
  ];
  const changedPaths = ['docs/src/content/docs/getting-started/codex-gateway.md'];
  const t = addTicket('SQ-1003 partial submission fixture', { files: ['docs/'] });
  assert.strictEqual(store.claimTicket(slug, t.ref, 'docs-worker', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);

  const refused = store.submitTicket(slug, t.ref, 'docs-worker', { commit: COMMIT, unscopedPaths });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'unscoped_paths');
  assert.match(refused.message, /PARTIAL/);
  assert.deepStrictEqual(store.getTicket(slug, t.ref).claim.by, 'docs-worker');
  assert.strictEqual(store.getTicket(slug, t.ref).submission, undefined);

  const legacy = store.getTicket(slug, t.ref);
  legacy.claim = null;
  legacy.submission = {
    commit: COMMIT,
    gitRef: `refs/sidequest/${t.ref}`,
    admittedScope: ['docs/'],
    unscopedPaths,
    changedPaths,
    integratedAt: null,
  };
  persist(legacy);

  assert.deepStrictEqual(store.submissionReadiness(legacy.submission), {
    ok: false,
    state: 'partial',
    reason: 'unscoped_paths',
    unscopedPaths,
    message: `PARTIAL: scope-gated paths remain outside this submission: ${unscopedPaths.join(', ')}.`,
  });
  assert.strictEqual(store.briefTicket(slug, legacy).submission.readiness.state, 'partial');
  assert.strictEqual(store.pulsePayload(slug, t.ref).submission.readiness.state, 'partial');
  assert.strictEqual(store.submissionsPayload(slug).tickets.find((entry?: any) => entry.ref === t.ref).submission.readiness.state, 'partial');

  const queued = cliJson(['publish', 'queue', '--json']).tickets.find((entry?: any) => entry.ref === t.ref);
  assert.strictEqual(queued.rangeValidation.reason, 'unscoped_paths');
  assert.deepStrictEqual(queued.rangeValidation.unscopedPaths, unscopedPaths);

  const integration = store.integrateSubmission(slug, t.ref, {});
  assert.strictEqual(integration.ok, false);
  assert.strictEqual(integration.reason, 'unscoped_paths');
  assert.match(integration.message, /PARTIAL/);
});


test('generated pairs admit tracked output through CLI scoped commit and submit', () => {
  cleanBranch();
  const source = 'plugins/sidequest/src/bin/pair.ts';
  const output = 'plugins/sidequest/bin/pair.js';
  fs.mkdirSync(path.dirname(path.join(PROJECT_DIR, source)), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(PROJECT_DIR, output)), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, source), 'export const pair = true;\n');
  fs.writeFileSync(path.join(PROJECT_DIR, output), 'exports.pair = true;\n');
  git(['add', source, output]);
  git(['commit', '-m', 'tracked generated pair fixture']);
  git(['push', 'origin', `HEAD:main`]);
  cleanBranch();
  store.setBoardConfig(slug, { generatedPairs: [{ from: 'plugins/*/src/bin/*.ts', to: 'plugins/*/bin/*.js' }] });
  const t = addTicket('generated pair submission', { files: [source] });
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'pair-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.writeFileSync(path.join(PROJECT_DIR, source), 'export const pair = false;\n');
  fs.writeFileSync(path.join(PROJECT_DIR, output), 'exports.pair = false;\n');
  const committed = cliJson(['commit', t.ref, '--by', 'pair-worker', '--message', 'paired submission', '--json']);
  assert.deepStrictEqual(committed.paths.sort(), [output, source]);
  pin(t, committed.commit);
  const submitted = runCli(['submit', t.ref, '--by', 'pair-worker', '--commit', committed.commit]);
  assert.strictEqual(submitted.status, 0, submitted.stderr + submitted.stdout);
  assert.deepStrictEqual(store.getTicket(slug, t.ref).submission.admittedScope, [source, output]);
  store.setBoardConfig(slug, { generatedPairs: null });
});


test('publish queue adds release-window context only when release fragments exist', () => {
  cleanBranch();
  const fragments = path.join(PROJECT_DIR, '.release', 'unreleased');
  assert.strictEqual(cliJson(['publish', 'queue', '--json']).releaseWindow, undefined);
  fs.mkdirSync(fragments, { recursive: true });
  fs.writeFileSync(path.join(fragments, 'SQ-1.md'), '---\nhold: true\n---\nHeld\n');
  fs.writeFileSync(path.join(fragments, 'SQ-2.md'), '---\n---\nReady\n');
  store.setBoardConfig(slug, { integrationBranch: 'dev' });
  try {
    const queue = cliJson(['publish', 'queue', '--json']);
    assert.equal(queue.releaseWindow.fragmentCount, 2);
    assert.equal(queue.releaseWindow.heldCount, 1);
    assert.equal(queue.releaseWindow.integrationBranch, 'dev');
    assert.equal(queue.releaseWindow.publishedBranch, 'main');
    assert.equal(queue.releaseWindow.nextScheduledCut, 'daily at 06:00 local');
    const output = runCli(['publish', 'queue']);
    assert.match(output.stdout, /release window: 2 fragment\(s\), 1 held/);
    assert.match(output.stdout, /dev → main/);
  } finally {
    store.setBoardConfig(slug, { integrationBranch: 'main' });
    fs.rmSync(path.join(PROJECT_DIR, '.release'), { recursive: true, force: true });
  }
});

test('CLI: registered capability admits an immutable source revision against the dispatch baseline', () => {
  const { project, projectPath, ticket } = noGitCliTicket('CLI source revision', ['wiki/page.md']);
  const prepared = store.prepareDispatch(project, ticket.ref, { sharedTree: true });
  assert.strictEqual(store.claimTicket(project, ticket.ref, 'cli-source-worker', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  const { runCli: runNoGitCli, invocationLog } = registeredNoGitCliRunner(project, projectPath, {
    candidateExists: true,
    containsCandidate: true,
  });

  const submitted = runNoGitCli([
    'submit', ticket.ref, '--by', 'cli-source-worker',
    '--source-revision-source', 'wiki',
    '--source-revision-value', 'wiki-revision-42',
    '--source-revision-observed-at', '2026-08-14T00:00:00.000Z',
    '--changed-surface', 'wiki/page.md',
    '--no-process', '--no-worktree', '--review',
    '--verify', 'attestation: wiki-revision-42 | editor-approved | editor approved the immutable revision',
    '--body', 'Reviewed immutable wiki revision.',
  ]);
  assert.strictEqual(submitted.status, 0, submitted.stderr + submitted.stdout);
  assert.match(submitted.stdout, /wiki:wiki-revision-42/);

  const stored = store.getTicket(project, ticket.ref);
  assert.deepStrictEqual(stored.submission.sourceRevision, {
    source: 'wiki',
    value: 'wiki-revision-42',
    observedAt: '2026-08-14T00:00:00.000Z',
  });
  assert.deepStrictEqual(stored.submission.changedPaths, ['wiki/page.md']);
  assert.deepStrictEqual(stored.submission.projectCapabilities, {
    process: false,
    worktree: false,
    review: true,
    git: false,
  });
  const invocations = fs.readFileSync(invocationLog, 'utf8').trim().split(/\r?\n/).map((line: string) => JSON.parse(line));
  assert.strictEqual(invocations.length, 1);
  assert.deepStrictEqual(invocations[0].candidate, stored.submission.sourceRevision);
  assert.deepStrictEqual(invocations[0].baseline, prepared.ticket.dispatch.lifecycleAttempt.baseline);
  assert.strictEqual(invocations[0].frozen, true);
  assert.ok(stored.comments.some((comment?: any) => /Reviewed immutable wiki revision/.test(comment.body)));

  const queueJson = runNoGitCli(['publish', 'queue', '--json']);
  assert.strictEqual(queueJson.status, 0, queueJson.stderr + queueJson.stdout);
  const queuedTicket = JSON.parse(queueJson.stdout).tickets.find((entry?: any) => entry.ref === ticket.ref);
  assert.strictEqual(queuedTicket.rangeValidation.ok, true);
  assert.strictEqual(queuedTicket.rangeValidation.reason, null);

  const queueText = runNoGitCli(['publish', 'queue']);
  assert.strictEqual(queueText.status, 0, queueText.stderr + queueText.stdout);
  assert.match(queueText.stdout, /source revision wiki:wiki-revision-42/);
  assert.doesNotMatch(queueText.stdout, /legacy_submission/);
});

test('CLI: source revision submission cannot bypass Git delivery', () => {
  const ticket = addTicket('CLI false non-Git submission', { files: ['wiki/page.md'] });
  assert.strictEqual(runCli([
    'claim', ticket.ref, '--by', 'cli-false-capability-worker', '--direct',
    '--reason', 'This fixture checks one exact public submission refusal.',
  ]).status, 0);

  const refused = runCli([
    'submit', ticket.ref, '--by', 'cli-false-capability-worker',
    '--source-revision-source', 'wiki',
    '--source-revision-value', 'invented-revision',
    '--source-revision-observed-at', '2026-08-14T00:00:00.000Z',
    '--changed-surface', 'wiki/page.md',
    '--verify', 'attestation: invented-revision | self-approved | caller asserted delivery',
  ]);
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr + refused.stdout, /require a project outside Git/);
  const stored = store.getTicket(slug, ticket.ref);
  assert.strictEqual(stored.submission, undefined);
  assert.strictEqual(stored.claim.by, 'cli-false-capability-worker');
});

test('CLI: registered source revision capability preserves scope refusals', () => {
  const { project, projectPath, ticket } = noGitCliTicket('CLI source scope refusal', ['wiki/allowed.md']);
  const prepared = store.prepareDispatch(project, ticket.ref, { sharedTree: true });
  assert.strictEqual(store.claimTicket(project, ticket.ref, 'cli-source-refusal-worker', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  const { runCli: runNoGitCli } = registeredNoGitCliRunner(project, projectPath, {
    candidateExists: true,
    containsCandidate: true,
  });

  const refused = runNoGitCli([
    'submit', ticket.ref, '--by', 'cli-source-refusal-worker',
    '--source-revision-source', 'wiki',
    '--source-revision-value', 'wiki-revision-43',
    '--source-revision-observed-at', '2026-08-14T00:00:00.000Z',
    '--changed-surface', 'wiki/outside.md',
    '--verify', 'attestation: wiki-revision-43 | editor-reviewed | editor found the revision complete',
  ]);
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr + refused.stdout, /outside its declared scope/);
  assert.doesNotMatch(refused.stderr + refused.stdout, /TypeError/);
  assert.strictEqual(store.getTicket(project, ticket.ref).submission, undefined);
});

test('CLI: submit rejects mixed Git and source revision identities', () => {
  const ticket = addTicket('CLI mixed revision identity', { files: ['wiki/page.md'] });
  assert.strictEqual(runCli([
    'claim', ticket.ref, '--by', 'cli-mixed-worker', '--direct',
    '--reason', 'This fixture checks one exact public submission validation.',
  ]).status, 0);

  const refused = runCli([
    'submit', ticket.ref, '--by', 'cli-mixed-worker', '--commit', COMMIT,
    '--source-revision-source', 'wiki', '--source-revision-value', 'wiki-revision-42',
    '--source-revision-observed-at', '2026-08-14T00:00:00.000Z',
    '--changed-surface', 'wiki/page.md',
    '--verify', 'attestation: wiki-revision-42',
  ]);
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr + refused.stdout, /exactly one of --commit or --source-revision-value/);
});

test('CLI: submit parks the ticket READY_FOR_INTEGRATION with an evidence comment, publish queue lists it', () => {
  cleanBranch();
  const t = addTicket('cli submit round-trip');
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'cli-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);

  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'submitted fixture\n');
  git(['add', 'lib/fixture.js']);
  git(['commit', '-m', 'submission fixture']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(t, commit);
  const submitted = runCli([
    'submit', t.ref, '--by', 'cli-worker', '--commit', commit,
    '--verify', 'node --test plugins/sidequest/test/submission.test.js',
    '-m', 'READY_FOR_INTEGRATION evidence body',
  ]);
  assert.strictEqual(submitted.status, 0, submitted.stderr + submitted.stdout);
  assert.match(submitted.stdout, /READY_FOR_INTEGRATION/);

  const after = store.getTicket(slug, t.ref);
  assert.strictEqual(after.submission.verify, 'node --test plugins/sidequest/test/submission.test.js');
  assert.deepStrictEqual(after.submission.commits, [commit]);
  assert.deepStrictEqual(after.submission.changedPaths, ['lib/fixture.js']);
  assert.strictEqual(after.submission.base, git(['rev-parse', 'origin/main']));
  assert.ok(after.comments.some((c?: any) => /READY_FOR_INTEGRATION evidence body/.test(c.body)));

  const queue = cliJson(['publish', 'queue', '--json']);
  assert.ok(queue.tickets.some((x?: any) => x.ref === t.ref));

  // done without integration is the orchestrator's call; the CLI still guards claims:
  const reclaim = runCli(['claim', t.ref, '--by', 'other', '--direct', '--reason', 'The submission fixture requires a local direct claim.']);
  assert.strictEqual(reclaim.status, 1);
  assert.match(reclaim.stdout, /READY_FOR_INTEGRATION/);

  const cleared = runCli(['submit', t.ref, '--by', 'cli-worker', '--clear', '-s', 'todo']);
  assert.strictEqual(cleared.status, 0, cleared.stderr + cleared.stdout);
  assert.strictEqual(store.getTicket(slug, t.ref).submission, null);
});

test('CLI: submit rejects worktree-bound verify commands and preserves portable commands', () => {
  cleanBranch();
  const t = addTicket('worktree-bound verify command');
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'verify-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);

  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'submitted fixture\n');
  git(['add', 'lib/fixture.js']);
  git(['commit', '-m', 'verify fixture']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(t, commit);

  const windowsStyle = `${PROJECT_DIR.replace(/\//g, '\\')}\\lib\\fixture.js`;
  const posixStyle = `${PROJECT_DIR.replace(/\\/g, '/')}/lib/fixture.js`;
  for (const verify of [windowsStyle, posixStyle]) {
    const rejected = runCli(['submit', t.ref, '--by', 'verify-worker', '--commit', commit, '--verify', `node --test ${verify}`]);
    assert.strictEqual(rejected.status, 1, rejected.stderr + rejected.stdout);
    assert.match(rejected.stderr + rejected.stdout, /run verification from the repo root and use repo-relative paths/i);
    assert.ok(store.getTicket(slug, t.ref).claim, 'rejected submission keeps the claim');
  }

  if (process.platform === 'win32') {
    const caseVariant = `${posixStyle.slice(0, 1).toLowerCase()}${posixStyle.slice(1).toUpperCase()}`;
    const rejected = runCli(['submit', t.ref, '--by', 'verify-worker', '--commit', commit, '--verify', `node --test ${caseVariant}`]);
    assert.strictEqual(rejected.status, 1, rejected.stderr + rejected.stdout);
  }

  const verify = 'C:\\tools\\node.exe --test lib/fixture.js --fixture C:\\fixtures\\submission.json';
  const submitted = runCli(['submit', t.ref, '--by', 'verify-worker', '--commit', commit, '--verify', verify]);
  assert.strictEqual(submitted.status, 0, submitted.stderr + submitted.stdout);
  assert.strictEqual(store.getTicket(slug, t.ref).submission.verify, verify);
});

test('CLI: SQ-406-shaped two-commit submissions retain implementation and tests in order', () => {
  cleanBranch();
  const t = addTicket('SQ-406-shaped range', { files: ['lib', 'test'] });
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'range-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(PROJECT_DIR, 'test'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'implementation.js'), 'module.exports = true;\n');
  git(['add', 'lib/implementation.js']);
  git(['commit', '-m', 'implementation']);
  const implementation = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'implementation.test.js'), 'test fixture\n');
  git(['add', 'test/implementation.test.js']);
  git(['commit', '-m', 'tests']);
  const tests = git(['rev-parse', 'HEAD']);
  pin(t, tests);

  const submitted = runCli(['submit', t.ref, '--by', 'range-worker', '--commit', tests, '--verify', 'node --test plugins/sidequest/test/*.test.js']);
  assert.strictEqual(submitted.status, 0, submitted.stderr + submitted.stdout);
  const queue = cliJson(['publish', 'queue', '--json']);
  const entry = queue.tickets.find((item?: any) => item.ref === t.ref);
  assert.deepStrictEqual(entry.submission.commits, [implementation, tests]);
  assert.deepStrictEqual(entry.submission.changedPaths, ['lib/implementation.js', 'test/implementation.test.js']);
});

test('CLI: hidden out-of-scope path in the first range commit is refused', () => {
  cleanBranch();
  const t = addTicket('hidden first commit scope', { files: ['lib/allowed.js'] });
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'scope-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'foreign.js'), 'foreign\n');
  git(['add', 'foreign.js']);
  git(['commit', '-m', 'hidden foreign path']);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'allowed.js'), 'allowed\n');
  git(['add', 'lib/allowed.js']);
  git(['commit', '-m', 'allowed tip']);
  const tip = git(['rev-parse', 'HEAD']);
  pin(t, tip);

  const submitted = runCli(['submit', t.ref, '--by', 'scope-worker', '--commit', tip]);
  assert.strictEqual(submitted.status, 1);
  assert.match(submitted.stderr + submitted.stdout, /foreign\.js/);
  assert.match(submitted.stderr + submitted.stdout, new RegExp(`sidequest update ${t.ref} --files`));
  assert.ok(store.getTicket(slug, t.ref).claim, 'failed range validation keeps the claim');
  assert.strictEqual(runCli(['release', t.ref, '--by', 'scope-worker']).status, 0);
});

test('CLI: unrelated durable-ref history is refused', () => {
  cleanBranch();
  const t = addTicket('unrelated submission', { files: ['lib/unrelated.js'] });
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'unrelated-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  git(['checkout', '--orphan', `unrelated-${++fixtureState.branchSeq}`]);
  git(['rm', '-rf', '.']);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'unrelated.js'), 'unrelated\n');
  git(['add', '.']);
  git(['commit', '-m', 'unrelated root']);
  const tip = git(['rev-parse', 'HEAD']);
  pin(t, tip);

  const submitted = runCli(['submit', t.ref, '--by', 'unrelated-worker', '--commit', tip]);
  assert.strictEqual(submitted.status, 1);
  assert.match(submitted.stderr + submitted.stdout, /unrelated_history/);
  assert.strictEqual(runCli(['release', t.ref, '--by', 'unrelated-worker']).status, 0);
});

test('CLI: a dependent submission retains its pinned dispatch baseline after an ancestor closes', () => {
  cleanBranch();
  const first = addTicket('integrated ancestor', { files: ['lib/first.js'] });
  assert.strictEqual(runCli(['claim', first.ref, '--by', 'first-integrated-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'first.js'), 'first\n');
  git(['add', 'lib/first.js']);
  git(['commit', '-m', 'integrated ancestor']);
  const firstTip = git(['rev-parse', 'HEAD']);
  pin(first, firstTip);
  assert.strictEqual(runCli(['submit', first.ref, '--by', 'first-integrated-worker', '--commit', firstTip]).status, 0);
  const target = Object.assign({}, store.integrationTarget(slug), { branch: git(['branch', '--show-current']) });
  const delivered = store.integrateSubmission(slug, first.ref, { target });
  assert.strictEqual(delivered.ok, true, delivered.message);
  const integrated = runCli(['groom-close', first.ref, '--by', 'orchestrator', '--integration', '--reason', `Integrated ${firstTip} into main.`]);
  assert.strictEqual(integrated.status, 0, integrated.stderr + integrated.stdout);

  const second = addTicket('dependent submission duplicate check', { files: ['lib'] });
  assert.strictEqual(runCli(['claim', second.ref, '--by', 'dependent-duplicate-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'second.js'), 'second\n');
  git(['add', 'lib/second.js']);
  git(['commit', '-m', 'dependent submission']);
  const secondTip = git(['rev-parse', 'HEAD']);
  pin(second, secondTip);

  const submitted = runCli(['submit', second.ref, '--by', 'dependent-duplicate-worker', '--commit', secondTip]);
  assert.strictEqual(submitted.status, 0, submitted.stderr + submitted.stdout);
  const submission = store.getTicket(slug, second.ref).submission;
  assert.strictEqual(submission.base, git(['rev-parse', 'origin/main']));
  assert.deepStrictEqual(submission.commits, [firstTip, secondTip]);
  assert.deepStrictEqual(submission.changedPaths, ['lib/first.js', 'lib/second.js']);
});

test('CLI: a dependent submission cannot hide an ancestor path outside its pinned scope', () => {
  cleanBranch();
  const first = addTicket('integrated out-of-scope ancestor', { files: ['foreign.js'] });
  assert.strictEqual(runCli(['claim', first.ref, '--by', 'first-scope-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.writeFileSync(path.join(PROJECT_DIR, 'foreign.js'), 'foreign\n');
  git(['add', 'foreign.js']);
  git(['commit', '-m', 'integrated foreign path']);
  const firstTip = git(['rev-parse', 'HEAD']);
  pin(first, firstTip);
  assert.strictEqual(runCli(['submit', first.ref, '--by', 'first-scope-worker', '--commit', firstTip]).status, 0);
  const target = Object.assign({}, store.integrationTarget(slug), { branch: git(['branch', '--show-current']) });
  const delivered = store.integrateSubmission(slug, first.ref, { target });
  assert.strictEqual(delivered.ok, true, delivered.message);
  const integrated = runCli(['groom-close', first.ref, '--by', 'orchestrator', '--integration', '--reason', `Integrated ${firstTip} into main.`]);
  assert.strictEqual(integrated.status, 0, integrated.stderr + integrated.stdout);

  const second = addTicket('dependent submission scope check', { files: ['lib/second.js'] });
  assert.strictEqual(runCli(['claim', second.ref, '--by', 'dependent-scope-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'second.js'), 'second\n');
  git(['add', 'lib/second.js']);
  git(['commit', '-m', 'scoped dependent submission']);
  const secondTip = git(['rev-parse', 'HEAD']);
  pin(second, secondTip);

  const submitted = runCli(['submit', second.ref, '--by', 'dependent-scope-worker', '--commit', secondTip]);
  assert.strictEqual(submitted.status, 1);
  assert.match(submitted.stderr + submitted.stdout, /foreign\.js/);
});

test('CLI: an explicit base cannot replace a submitted ticket baseline', () => {
  cleanBranch();
  const first = addTicket('explicit base ancestor', { files: ['lib/first.js'] });
  assert.strictEqual(runCli(['claim', first.ref, '--by', 'explicit-base-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'first.js'), 'first\n');
  git(['add', 'lib/first.js']);
  git(['commit', '-m', 'explicit base ancestor']);
  const firstTip = git(['rev-parse', 'HEAD']);
  pin(first, firstTip);
  assert.strictEqual(runCli(['submit', first.ref, '--by', 'explicit-base-worker', '--commit', firstTip]).status, 0);

  const second = addTicket('explicit dependent range', { files: ['lib/second.js'] });
  assert.strictEqual(runCli(['claim', second.ref, '--by', 'explicit-dependent-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'second.js'), 'second\n');
  git(['add', 'lib/second.js']);
  git(['commit', '-m', 'explicit dependent range']);
  const secondTip = git(['rev-parse', 'HEAD']);
  pin(second, secondTip);

  const submitted = runCli(['submit', second.ref, '--by', 'explicit-dependent-worker', '--commit', secondTip, '--base', firstTip]);
  assert.strictEqual(submitted.status, 1);
  assert.match(submitted.stderr + submitted.stdout, /unrecognized_base/);
});

test('CLI: a control-plane-integrated local main commit is accepted as an explicit base', (t?: any) => {
  cleanBranch();
  t.after(() => git(['branch', '-f', 'main', 'origin/main']));

  const integratedTicket = addTicket('control-plane-integrated base', { files: ['foreign.js'] });
  fs.writeFileSync(path.join(PROJECT_DIR, 'foreign.js'), 'integrated locally\n');
  git(['add', 'foreign.js']);
  git(['commit', '-m', 'control-plane-integrated base']);
  const integratedBase = git(['rev-parse', 'HEAD']);
  git(['branch', '-f', 'main', integratedBase]);
  const closed = runCli(['groom-close', integratedTicket.ref, '--by', 'orchestrator', '--reason', `Integrated ${integratedBase} into local main without a submission.`]);
  assert.strictEqual(closed.status, 0, closed.stderr + closed.stdout);
  assert.ok(!store.getTicket(slug, integratedTicket.ref).submission);

  const ticket = addTicket('depends on control-plane-integrated base', { files: ['lib/allowed.js'] });
  assert.strictEqual(runCli(['claim', ticket.ref, '--by', 'local-main-base-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'allowed.js'), 'allowed\n');
  git(['add', 'lib/allowed.js']);
  git(['commit', '-m', 'dependent submission']);
  const tip = git(['rev-parse', 'HEAD']);
  pin(ticket, tip);

  const submitted = runCli(['submit', ticket.ref, '--by', 'local-main-base-worker', '--commit', tip, '--base', integratedBase]);
  assert.strictEqual(submitted.status, 0, submitted.stderr + submitted.stdout);
  const submission = store.getTicket(slug, ticket.ref).submission;
  assert.strictEqual(submission.base, integratedBase);
  assert.deepStrictEqual(submission.commits, [tip]);
  assert.deepStrictEqual(submission.changedPaths, ['lib/allowed.js']);
});

test('CLI: an arbitrary explicit base cannot hide an out-of-scope commit', () => {
  cleanBranch();
  const ticket = addTicket('unrecognized explicit base', { files: ['lib/allowed.js'] });
  assert.strictEqual(runCli(['claim', ticket.ref, '--by', 'unrecognized-base-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.writeFileSync(path.join(PROJECT_DIR, 'foreign.js'), 'foreign\n');
  git(['add', 'foreign.js']);
  git(['commit', '-m', 'unrecognized base']);
  const hiddenCommit = git(['rev-parse', 'HEAD']);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'allowed.js'), 'allowed\n');
  git(['add', 'lib/allowed.js']);
  git(['commit', '-m', 'allowed tip']);
  const tip = git(['rev-parse', 'HEAD']);
  pin(ticket, tip);

  const submitted = runCli(['submit', ticket.ref, '--by', 'unrecognized-base-worker', '--commit', tip, '--base', hiddenCommit]);
  assert.strictEqual(submitted.status, 1);
  assert.match(submitted.stderr + submitted.stdout, /unrecognized_base/);
  assert.ok(store.getTicket(slug, ticket.ref).claim, 'rejected base keeps the claim');
});

test('CLI: a genuine ownership overlap with another queued submission is refused', () => {
  cleanBranch();
  const first = addTicket('first queued submission', { files: ['lib/first.js'] });
  assert.strictEqual(runCli(['claim', first.ref, '--by', 'first-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'first.js'), 'first\n');
  git(['add', 'lib/first.js']);
  git(['commit', '-m', 'first ticket']);
  const firstTip = git(['rev-parse', 'HEAD']);
  pin(first, firstTip);
  assert.strictEqual(runCli(['submit', first.ref, '--by', 'first-worker', '--commit', firstTip]).status, 0);

  const second = addTicket('second includes first', { files: ['lib'] });
  assert.strictEqual(runCli(['claim', second.ref, '--by', 'second-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'second.js'), 'second\n');
  git(['add', 'lib/second.js']);
  git(['commit', '-m', 'second ticket']);
  const secondTip = git(['rev-parse', 'HEAD']);
  pin(second, secondTip);
  const submitted = runCli(['submit', second.ref, '--by', 'second-worker', '--commit', secondTip]);
  assert.strictEqual(submitted.status, 1);
  assert.match(submitted.stderr + submitted.stdout, new RegExp(first.ref));
  assert.strictEqual(runCli(['release', second.ref, '--by', 'second-worker']).status, 0);
});

test('CLI: board config stores a worktree setup command', () => {
  const setup = 'cd plugins/sidequest && npm ci';
  const pairs = JSON.stringify([{ from: 'plugins/*/src/lib/*.ts', to: 'plugins/*/lib/*.js' }]);
  const configured = cliJson(['board-config', '--worktree-setup', setup, '--generated-pairs', pairs, '--json']);
  assert.strictEqual(configured.worktreeSetup, setup);
  assert.deepStrictEqual(configured.generatedPairs, JSON.parse(pairs));
  assert.strictEqual(cliJson(['board-config', '--json']).worktreeSetup, setup);
});

test('CLI: board config renames only the display name', () => {
  const ticket = addTicket('rename keeps CLI ticket refs');
  const before = store.readMeta(slug);
  const renamed = cliJson(['board-config', '--name', 'CLI renamed board', '--json']);

  assert.strictEqual(renamed.project, slug);
  assert.strictEqual(renamed.name, 'CLI renamed board');
  assert.strictEqual(renamed.projectName, 'CLI renamed board');
  assert.strictEqual(store.readMeta(slug).path, before.path);
  assert.strictEqual(store.getTicket(slug, ticket.ref).ref, ticket.ref);

  const rejected = runCli(['board-config', '--name', '', '--json']);
  assert.strictEqual(rejected.status, 1);
  assert.match(rejected.stderr, /Board name cannot be empty/);
});

test('CLI: a configured feature integration branch accepts its base and main refuses it', () => {
  cleanBranch();
  assert.equal(store.boardConfig(slug).integrationBranch, 'main');

  git(['checkout', '-f', '-B', 'feat/submission-target', 'origin/main']);
  fs.writeFileSync(path.join(PROJECT_DIR, 'feature-base.txt'), 'feature baseline\n');
  git(['add', 'feature-base.txt']);
  git(['commit', '-m', 'feature integration baseline']);
  const featureBase = git(['rev-parse', 'HEAD']);
  git(['push', '-f', '-u', 'origin', 'feat/submission-target']);
  store.setBoardConfig(slug, { integrationMode: 'remote', integrationBranch: 'feat/submission-target' });
  assert.deepStrictEqual(store.integrationTarget(slug), {
    mode: 'remote', upstream: 'origin/feat/submission-target', branch: 'feat/submission-target',
  });

  const accepted = addTicket('feature integration branch submission', { files: ['lib/feature-target.js'] });
  assert.equal(runCli(['claim', accepted.ref, '--by', 'feature-target-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'feature-target.js'), 'feature target\n');
  git(['add', 'lib/feature-target.js']);
  git(['commit', '-m', 'feature target submission']);
  const tip = git(['rev-parse', 'HEAD']);
  pin(accepted, tip);
  assert.equal(runCli(['submit', accepted.ref, '--by', 'feature-target-worker', '--commit', tip, '--base', featureBase]).status, 0);

  const refused = addTicket('main rejects feature integration base', { files: ['lib/feature-target.js'] });
  assert.equal(runCli(['claim', refused.ref, '--by', 'main-target-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  pin(refused, tip);
  store.setBoardConfig(slug, { integrationBranch: 'main' });
  const rejected = runCli(['submit', refused.ref, '--by', 'main-target-worker', '--commit', tip, '--base', featureBase]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr + rejected.stdout, /unrecognized_base/);
  assert.ok(store.getTicket(slug, refused.ref).claim, 'rejected submission keeps the claim');
  assert.equal(runCli(['release', refused.ref, '--by', 'main-target-worker']).status, 0);

  store.setBoardConfig(slug, { integrationBranch: 'missing-integration-branch' });
  assert.throws(() => store.integrationTarget(slug), /Configured integration ref "refs\/remotes\/origin\/missing-integration-branch"/);
  store.setBoardConfig(slug, { integrationBranch: 'main' });
});

test('CLI: a remote-less board auto-selects local integration and records a main baseline', () => {
  git(['checkout', '-f', 'main']);
  git(['clean', '-fd']);
  git(['remote', 'remove', 'origin']);
  git(['checkout', '-f', '-B', 'local-only', 'main']);

  const configured = cliJson(['board-config', '--integration-mode', 'local', '--json']);
  assert.strictEqual(configured.integrationMode, 'local');
  store.setBoardConfig(slug, { integrationMode: 'auto' });
  assert.deepStrictEqual(store.integrationTarget(slug), { mode: 'local', upstream: 'main', branch: 'main' });

  const t = addTicket('local-only submit', { files: ['lib/local-only.js'] });
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'local-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'local-only.js'), 'local-only\n');
  git(['add', 'lib/local-only.js']);
  git(['commit', '-m', 'local-only submission']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(t, commit);

  const submitted = runCli(['submit', t.ref, '--by', 'local-worker', '--commit', commit]);
  assert.strictEqual(submitted.status, 0, submitted.stderr + submitted.stdout);
  assert.match(submitted.stdout, /against local main, then marks done without pushing/);
  const submission = store.getTicket(slug, t.ref).submission;
  assert.strictEqual(submission.integrationMode, 'local');
  assert.strictEqual(submission.upstream, 'main');
  assert.strictEqual(submission.base, git(['rev-parse', 'main']));
});

// A shared tree is the user's own checkout and can already be dirty with work
// that has nothing to do with the run. Gating a verified submission on those
// paths costs a scope round trip nobody can rule on usefully (contractify SQ-95).
test('SQ-1367: a shared-tree submission is not gated on paths that were already dirty at dispatch', () => {
  const stray = path.join(PROJECT_DIR, 'before-neutral-rework.jpeg');
  fs.writeFileSync(stray, 'the user\'s own screenshot\n');

  const t = addTicket('inherited dirt', { files: ['lib/inherited.js'], category: 'submission.fixture' });
  const prepared = store.prepareDispatch(slug, t.ref, { sessionId: 'inherited-dirt', sharedTree: true });
  assert.ok(
    store.getTicket(slug, t.ref).dispatch.dirtyBaseline.some((entry: any) => entry.path === 'before-neutral-rework.jpeg'),
    'the dispatch records what was already dirty in the shared tree',
  );
  assert.strictEqual(store.claimTicket(slug, t.ref, 'inherited-worker', {
    token: prepared.token, executor: prepared.ticket.dispatchExecutor, sessionId: 'inherited-dirt',
  }).ok, true);

  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'inherited.js'), 'scoped work\n');
  git(['add', 'lib/inherited.js']);
  git(['commit', '-m', 'scoped work beside inherited dirt']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(t, commit);

  const unscopedPaths = ['before-neutral-rework.jpeg'];
  const submitted = store.submitTicket(slug, t.ref, 'inherited-worker', { commit, unscopedPaths });
  assert.strictEqual(submitted.ok, true, submitted.message);
  assert.deepStrictEqual(submitted.ticket.submission.unscopedPaths, []);
  assert.deepStrictEqual(submitted.ticket.submission.inheritedPaths, unscopedPaths);

  // Touching an inherited path puts it back under the gate: the exemption is
  // content-aware, not a permanent pass for the path.
  const reworked = addTicket('inherited dirt, then touched', { files: ['lib/reworked.js'], category: 'submission.fixture' });
  const second = store.prepareDispatch(slug, reworked.ref, { sessionId: 'inherited-touch', sharedTree: true });
  assert.strictEqual(store.claimTicket(slug, reworked.ref, 'touch-worker', {
    token: second.token, executor: second.ticket.dispatchExecutor, sessionId: 'inherited-touch',
  }).ok, true);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'reworked.js'), 'more scoped work\n');
  git(['add', 'lib/reworked.js']);
  git(['commit', '-m', 'more scoped work']);
  const reworkedCommit = git(['rev-parse', 'HEAD']);
  pin(reworked, reworkedCommit);
  fs.writeFileSync(stray, 'an executor overwrote it\n');
  const refused = store.submitTicket(slug, reworked.ref, 'touch-worker', { commit: reworkedCommit, unscopedPaths });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'unscoped_paths');
  assert.match(refused.message, /before-neutral-rework\.jpeg/);
  fs.rmSync(stray);
});

test('SQ-1328: concurrent shared-tree submissions attribute foreign working paths without weakening range scope', async () => {
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  cleanBranch();
  const upstreamCommit = git(['rev-parse', 'origin/main']);
  const userNotes = path.join(PROJECT_DIR, 'user-notes.txt');
  fs.writeFileSync(userNotes, 'pre-existing user work\n');

  const firstTicket = addTicket('first concurrent executor', { files: ['lib/first.js'], category: 'submission.fixture' });
  const secondTicket = addTicket('second concurrent executor', { files: ['lib/second.js'], category: 'submission.fixture' });
  const firstDispatch = store.prepareDispatch(slug, firstTicket.ref, { sessionId: 'concurrent-first', sharedTree: true });
  const secondDispatch = store.prepareDispatch(slug, secondTicket.ref, { sessionId: 'concurrent-second', sharedTree: true });
  assert.strictEqual(store.claimTicket(slug, firstTicket.ref, 'concurrent-first-worker', {
    token: firstDispatch.token, executor: firstDispatch.ticket.dispatchExecutor, sessionId: 'concurrent-first',
  }).ok, true);
  assert.strictEqual(store.claimTicket(slug, secondTicket.ref, 'concurrent-second-worker', {
    token: secondDispatch.token, executor: secondDispatch.ticket.dispatchExecutor, sessionId: 'concurrent-second',
  }).ok, true);

  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'second.js'), 'second executor in flight\n');
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'first.js'), 'first executor committed\n');
  git(['add', 'lib/first.js']);
  git(['commit', '-m', 'first concurrent submission']);
  const firstCommit = git(['rev-parse', 'HEAD']);
  pin(firstTicket, firstCommit);

  const firstSubmission = store.submitTicket(slug, firstTicket.ref, 'concurrent-first-worker', {
    commit: firstCommit,
    unscopedPaths: ['user-notes.txt', 'lib/second.js'],
    range: {
      base: upstreamCommit,
      upstream: 'origin/main',
      upstreamCommit,
      commits: [firstCommit],
      changedPaths: ['lib/first.js'],
    },
  });
  assert.strictEqual(firstSubmission.ok, true, firstSubmission.message);
  assert.deepStrictEqual(firstSubmission.ticket.submission.inheritedPaths, ['user-notes.txt']);
  assert.deepStrictEqual(firstSubmission.ticket.submission.unsubmittedWorkingPaths, ['lib/second.js']);
  assert.match(firstSubmission.advisory, /user-notes\.txt \(present before dispatch\)/);
  assert.match(firstSubmission.advisory, /lib\/second\.js \(not in submitted range\)/);
  assert.match(firstSubmission.advisory, /Commit only your declared scope; never stash or revert foreign paths/);

  git(['add', 'lib/second.js']);
  git(['commit', '-m', 'second concurrent submission']);
  const secondCommit = git(['rev-parse', 'HEAD']);
  pin(secondTicket, secondCommit);
  const secondSubmission = store.submitTicket(slug, secondTicket.ref, 'concurrent-second-worker', {
    commit: secondCommit,
    unscopedPaths: ['user-notes.txt'],
    range: {
      base: firstCommit,
      upstream: 'origin/main',
      upstreamCommit,
      commits: [secondCommit],
      changedPaths: ['lib/second.js'],
    },
  });
  assert.strictEqual(secondSubmission.ok, true, secondSubmission.message);
  assert.deepStrictEqual(secondSubmission.ticket.submission.inheritedPaths, ['user-notes.txt']);

  const escapedTicket = addTicket('submitted range still owns its scope', { files: ['lib/scoped.js'], category: 'submission.fixture' });
  const escapedDispatch = store.prepareDispatch(slug, escapedTicket.ref, { sessionId: 'escaped-range', sharedTree: true });
  assert.strictEqual(store.claimTicket(slug, escapedTicket.ref, 'escaped-range-worker', {
    token: escapedDispatch.token, executor: escapedDispatch.ticket.dispatchExecutor, sessionId: 'escaped-range',
  }).ok, true);
  fs.mkdirSync(path.join(PROJECT_DIR, 'foreign'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'scoped.js'), 'scoped\n');
  fs.writeFileSync(path.join(PROJECT_DIR, 'foreign', 'escaped.js'), 'escaped\n');
  git(['add', 'lib/scoped.js', 'foreign/escaped.js']);
  git(['commit', '-m', 'range with escaped path']);
  const escapedCommit = git(['rev-parse', 'HEAD']);
  pin(escapedTicket, escapedCommit);
  const mcpEscapedSubmission = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: escapedTicket.ref,
    by: 'escaped-range-worker',
    commit: escapedCommit,
    base: secondCommit,
    worktree: PROJECT_DIR,
    body: 'Escaped range refusal fixture.',
  });
  assert.strictEqual(mcpEscapedSubmission.ok, false);
  assert.strictEqual(mcpEscapedSubmission.reason, 'outside_scope');
  assert.deepStrictEqual(mcpEscapedSubmission.foreignWorkingPaths, ['foreign/escaped.js']);
  assert.deepStrictEqual(store.getTicket(slug, escapedTicket.ref).submissionRetry.foreignWorkingPaths, ['foreign/escaped.js']);
  assert.match(mcpEscapedSubmission.message, /never stash, revert, or include foreign paths/);

  const cliEscapedSubmission = runCli([
    'submit', escapedTicket.ref, '--by', 'escaped-range-worker', '--commit', escapedCommit, '--base', secondCommit,
  ]);
  assert.strictEqual(cliEscapedSubmission.status, 1);
  assert.match(cliEscapedSubmission.stderr + cliEscapedSubmission.stdout, /never stash, revert, or include foreign paths/);

  const escapedSubmission = store.submitTicket(slug, escapedTicket.ref, 'escaped-range-worker', {
    commit: escapedCommit,
    range: {
      base: secondCommit,
      upstream: 'origin/main',
      upstreamCommit,
      commits: [escapedCommit],
      changedPaths: ['foreign/escaped.js', 'lib/scoped.js'],
    },
  });
  assert.strictEqual(escapedSubmission.ok, false);
  assert.strictEqual(escapedSubmission.reason, 'outside_scope');
  assert.deepStrictEqual(escapedSubmission.outside, ['foreign/escaped.js']);
  assert.deepStrictEqual(escapedSubmission.foreignWorkingPaths, ['foreign/escaped.js']);
  assert.match(escapedSubmission.message, /never stash, revert, or include foreign paths/);
});

export {};
