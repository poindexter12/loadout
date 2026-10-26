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
  db,
  sourceRevisionCapability,
  DISPATCH_DESCRIPTION,
  committedRepo,
  callTool,
  callToolRaw,
  gitAt,
  runCli,
  createGitWorktree,
  addMarketplaceFixture,
  windowsShortPath,
  createLinkedWorktree,
  claimDispatchedTicket,
} from './_mcp-fixture.js';

test('CLI submit requires release fragments for marketplace plugin changes', async () => {
  const missingWorktree = createGitWorktree();
  addMarketplaceFixture(missingWorktree);
  const missingProject = store.ensureProject(missingWorktree).slug;
  const missing = store.createTicket(missingProject, {
    title: 'CLI missing release fragment', files: ['plugins/fixture-plugin'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm CLI submissions require an authored release fragment',
  });
  const missingBy = 'cli-release-fragment-worker';
  assert.equal((await callTool('claim', { project: missingProject, ref: missing.ref, by: missingBy, direct: true, reason: 'The CLI release fragment fixture requires a local direct claim.' })).ok, true);
  fs.mkdirSync(path.join(missingWorktree, 'plugins', 'fixture-plugin'), { recursive: true });
  fs.writeFileSync(path.join(missingWorktree, 'plugins', 'fixture-plugin', 'index.js'), 'changed\n');
  gitAt(missingWorktree, ['add', 'plugins/fixture-plugin/index.js']);
  gitAt(missingWorktree, ['commit', '-m', 'CLI plugin change without fragment']);
  const missingCommit = gitAt(missingWorktree, ['rev-parse', 'HEAD']);
  gitAt(missingWorktree, ['update-ref', `refs/sidequest/${missing.ref}`, missingCommit]);
  const refused = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'sidequest.js'), 'submit', missing.ref, '--project', missingProject, '--by', missingBy, '--commit', missingCommit, '--worktree', missingWorktree, '--verify', 'node --test plugins/sidequest/test/mcp.test.js', '--body', 'Missing fragment evidence'], {
    cwd: missingWorktree, encoding: 'utf8', windowsHide: true,
    env: Object.assign({}, process.env, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJ }),
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout, new RegExp(`so it rides along:\\n---\\nref: ${missing.ref}`));
  assert.doesNotMatch(refused.stdout, /Request scope/);
  assert.ok(store.getTicket(missingProject, missing.ref).claim, 'CLI fragment refusal keeps the claim');

  const docsWorktree = createGitWorktree();
  addMarketplaceFixture(docsWorktree);
  const docsProject = store.ensureProject(docsWorktree).slug;
  const docs = store.createTicket(docsProject, {
    title: 'CLI docs-only submission', files: ['docs'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm CLI docs-only submissions remain admitted',
  });
  const docsBy = 'cli-docs-worker';
  assert.equal((await callTool('claim', { project: docsProject, ref: docs.ref, by: docsBy, direct: true, reason: 'The CLI docs-only fixture requires a local direct claim.' })).ok, true);
  fs.mkdirSync(path.join(docsWorktree, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(docsWorktree, 'docs', 'guide.md'), 'docs\n');
  gitAt(docsWorktree, ['add', 'docs/guide.md']);
  gitAt(docsWorktree, ['commit', '-m', 'CLI docs change']);
  const docsCommit = gitAt(docsWorktree, ['rev-parse', 'HEAD']);
  gitAt(docsWorktree, ['update-ref', `refs/sidequest/${docs.ref}`, docsCommit]);
  assert.equal(runCli(['submit', docs.ref, '--project', docsProject, '--by', docsBy, '--commit', docsCommit, '--worktree', docsWorktree, '--verify', 'node --test plugins/sidequest/test/mcp.test.js', '--body', 'CLI docs evidence', '--json'], docsWorktree).ok, true);

  const fragmentWorktree = createGitWorktree();
  addMarketplaceFixture(fragmentWorktree);
  const fragmentProject = store.ensureProject(fragmentWorktree).slug;
  const fragment = store.createTicket(fragmentProject, {
    title: 'CLI plugin submission with release fragment', files: ['plugins/fixture-plugin'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm CLI plugin submissions can commit their ticket-bound fragment without declared release scope',
  });
  const fragmentBy = 'cli-valid-fragment-worker';
  assert.equal((await callTool('claim', { project: fragmentProject, ref: fragment.ref, by: fragmentBy, direct: true, reason: 'The CLI valid fragment fixture requires a local direct claim.' })).ok, true);
  fs.mkdirSync(path.join(fragmentWorktree, 'plugins', 'fixture-plugin'), { recursive: true });
  fs.mkdirSync(path.join(fragmentWorktree, '.release', 'unreleased'), { recursive: true });
  fs.writeFileSync(path.join(fragmentWorktree, 'plugins', 'fixture-plugin', 'index.js'), 'changed\n');
  fs.writeFileSync(path.join(fragmentWorktree, '.release', 'unreleased', `${fragment.ref}.md`), `---\nref: ${fragment.ref}\ntitle: Fixture change\nbump: patch\nplugins:\n  - fixture-plugin\n---\n\nFixture change.\n`);
  gitAt(fragmentWorktree, ['add', 'plugins/fixture-plugin/index.js', `.release/unreleased/${fragment.ref}.md`]);
  const fragmentCommit = runCli(['commit', fragment.ref, '--project', fragmentProject, '--by', fragmentBy, '--message', 'CLI plugin change with fragment', '--json'], fragmentWorktree).commit;
  assert.ok(fragmentCommit, 'CLI commit admits the ticket-bound fragment without declared release scope');
  gitAt(fragmentWorktree, ['update-ref', `refs/sidequest/${fragment.ref}`, fragmentCommit]);
  assert.equal(runCli(['submit', fragment.ref, '--project', fragmentProject, '--by', fragmentBy, '--commit', fragmentCommit, '--worktree', fragmentWorktree, '--verify', 'node --test plugins/sidequest/test/mcp.test.js', '--body', 'CLI valid fragment evidence', '--json'], fragmentWorktree).ok, true);
  assert.deepEqual(store.getTicket(fragmentProject, fragment.ref).submission.admittedScope, ['plugins/fixture-plugin']);
  assert.equal(store.validateIntegrationSubmission(fragmentProject, fragment.ref, {}).ok, true);
});


test('MCP commit and submit accept an 8.3 worktree alias', { skip: process.platform !== 'win32' }, async (context: any) => {
  const worktree = createGitWorktree();
  const alias = windowsShortPath(worktree);
  if (alias.toLowerCase() === worktree.toLowerCase()) {
    context.skip('8.3 aliases are unavailable on this volume');
    return;
  }
  const project = store.ensureProject(worktree).slug;
  const ticket = store.createTicket(project, {
    title: 'MCP 8.3 worktree alias', files: ['lib/allowed.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'exercise canonical worktree root matching',
  });
  const by = 'mcp-8dot3-worker';
  assert.equal((await callTool('claim', { project, ref: ticket.ref, by, direct: true, reason: 'The 8.3 alias fixture requires a local direct claim.' })).ok, true);

  fs.mkdirSync(path.join(worktree, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'lib', 'allowed.js'), 'allowed\n');
  gitAt(worktree, ['add', 'lib/allowed.js']);
  const committed = await callTool('commit', {
    project, ref: ticket.ref, by, message: 'MCP 8.3 alias commit', worktree: alias,
  });
  gitAt(worktree, ['update-ref', `refs/sidequest/${ticket.ref}`, committed.commit]);
  const submitted = await callTool('submit', {
    project, ref: ticket.ref, by, commit: committed.commit, worktree: alias,
    body: 'MCP 8.3 alias submission evidence',
  });
  assert.equal(submitted.ok, true);
});

test('MCP commit refuses an isolated dispatch in the primary worktree but permits linked and shared trees', async () => {
  const primary = createGitWorktree();
  const project = store.ensureProject(primary).slug;
  const isolated = store.createTicket(project, {
    title: 'isolated commit guard', description: DISPATCH_DESCRIPTION, category: 'coding.normal', files: ['lib/guarded.js'],
  });
  const isolatedBy = 'mcp-isolated-guard-worker';
  claimDispatchedTicket(project, isolated, isolatedBy);

  fs.mkdirSync(path.join(primary, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(primary, 'lib', 'guarded.js'), 'primary\n');
  gitAt(primary, ['add', 'lib/guarded.js']);
  const primaryHead = gitAt(primary, ['rev-parse', 'HEAD']);
  const refused = await callTool('commit', {
    project, ref: isolated.ref, by: isolatedBy, message: 'must not commit in primary', worktree: primary,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'worktree_isolation');
  assert.match(refused.message, /requires a linked worktree/);
  assert.equal(gitAt(primary, ['rev-parse', 'HEAD']), primaryHead, 'primary worktree remains uncommitted');

  const linked = createLinkedWorktree(primary);
  fs.mkdirSync(path.join(linked, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(linked, 'lib', 'guarded.js'), 'linked\n');
  gitAt(linked, ['add', 'lib/guarded.js']);
  const committed = await callTool('commit', {
    project, ref: isolated.ref, by: isolatedBy, message: 'commit from linked worktree', worktree: linked,
  });
  assert.ok(committed.commit, 'isolated dispatch can commit from a linked worktree');

  const shared = store.createTicket(project, {
    title: 'shared commit exemption', description: DISPATCH_DESCRIPTION, category: 'coding.normal', files: ['lib/shared.js'],
  });
  const sharedBy = 'mcp-shared-guard-worker';
  claimDispatchedTicket(project, shared, sharedBy, true);
  fs.writeFileSync(path.join(primary, 'lib', 'shared.js'), 'shared\n');
  gitAt(primary, ['add', 'lib/shared.js']);
  const sharedCommit = await callTool('commit', {
    project, ref: shared.ref, by: sharedBy, message: 'shared tree commit', worktree: primary,
  });
  assert.ok(sharedCommit.commit, 'shared-tree dispatch can commit from the primary worktree');
});

test('MCP submits and integrates project-neutral source revisions through one registered capability', async (context: any) => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-source-revisions-'));
  const project = store.ensureProject(projectPath).slug;
  const capabilityInvocations: any[] = [];
  const unregister = store.registerSourceRevisionCapability(project, (candidate: any, baseline: any) => {
    capabilityInvocations.push({ candidate, baseline });
    return { candidateExists: true, containsCandidate: true };
  });
  context.after(unregister);
  const revisions = [
    { source: 'wiki', value: 'wiki-42', surface: 'wiki/page.md' },
    { source: 'document-set', value: 'documents-17', surface: 'documents/index.md' },
    { source: 'docs-vault', value: 'vault-91', surface: 'vault/note.md' },
    { source: 'research-collection', value: 'research-8', surface: 'research/result.md' },
  ];

  for (const revision of revisions) {
    const ticket = store.createTicket(project, {
      title: `publish ${revision.source} revision`,
      files: [revision.surface],
      complexity: 2,
      complexityWhy: 'publish one pinned immutable source revision',
      executorVerifyKind: 'attestation',
      executorAttestationArtifact: revision.value,
      labels: ['direct-ok'],
    });
    const by = `mcp-${revision.source}-worker`;
    claimDispatchedTicket(project, ticket, by, true);

    const submitted = await callTool('submit', {
      project,
      ref: ticket.ref,
      by,
      sourceRevision: {
        source: revision.source,
        value: revision.value,
        observedAt: '2026-08-14T00:00:00.000Z',
      },
      changedSurfaces: [revision.surface],
      projectCapabilities: {
        process: false,
        worktree: false,
        review: true,
      },
      verify: `attestation: ${revision.value} | review-accepted | reviewer approved the immutable revision`,
      body: `Reviewed ${revision.source} revision ${revision.value}.`,
    });
    assert.equal(submitted.ok, true, submitted.message || submitted.reason);
    assert.equal(store.getTicket(project, ticket.ref).submission.sourceRevision.source, revision.source);
    const assembled = await callTool('integrate', {
      project,
      ref: ticket.ref,
      by: 'mcp-source-publisher',
      wave: { verification: store.getTicket(project, ticket.ref).submission.verificationResult },
    });
    assert.equal(assembled.ok, true, assembled.message || assembled.reason);
    assert.equal(assembled.action, 'wave_assembled');
    assert.equal(assembled.deliveryRequired, true);
    assert.equal(assembled.waveId, assembled.wave.id);
    assert.deepEqual(assembled.participantRefs, [ticket.ref]);
    assert.equal(assembled.gateState, 'gate_passed');

    const integrated = await callTool('integrate', { project, ref: ticket.ref, by: 'mcp-source-publisher' });
    assert.equal(integrated.ok, true, integrated.message || integrated.reason);
    assert.equal(integrated.action, 'delivered');
    assert.notEqual(integrated.action, assembled.action, 'assembly and delivery acknowledgements must be distinguishable');
    assert.equal(integrated.delivery.mode, 'source-revision');
    assert.equal(integrated.message, `Delivered source revision ${revision.source}:${revision.value}.`);
    assert.deepEqual(integrated.delivery.changedPaths, [revision.surface]);
    assert.equal(store.getTicket(project, ticket.ref).lifecycleAttempt.state, 'closed');
  }
  assert.equal(capabilityInvocations.length, revisions.length);
  assert.deepEqual(capabilityInvocations.map((invocation) => invocation.candidate.source), revisions.map((revision) => revision.source));
  assert.ok(capabilityInvocations.every((invocation) => invocation.baseline.purpose === 'dispatch'));
});

test('MCP integrate preserves assembled-wave failure details', async () => {
  const projectPath = committedRepo('sq-mcp-wave-ack-');
  const project = store.ensureProject(projectPath).slug;
  const originalAssembleSubmissionWave = store.assembleSubmissionWave;
  const wave = { id: 'wave-ack-fixture', baseline: { revision: { source: 'git', value: 'base-commit' } } };
  const invalidated = [{ ref: 'SQ-9002', reason: 'baseline_moved', message: 'SQ-9002 was verified against an earlier baseline.' }];
  store.assembleSubmissionWave = (_slug: string, refs: string[]) => (
    refs.length === 1 && refs[0] === 'SQ-9001'
      ? {
        ok: false,
        reason: 'assembled_wave_gate_failed',
        message: 'Wave wave-ack-fixture gate returned failed_suite. Refresh and reverify its candidates before delivery.',
        wave: { ...wave, participants: refs },
        assembly: { state: 'assembled' },
        gate: { state: 'gate_failed', verification: { status: 'failed_suite' } },
      }
      : { ok: false, reason: 'wave_invalidated', invalidated, wave }
  );
  try {
    const gateFailed = await callTool('integrate', {
      project,
      ref: 'SQ-9001',
      by: 'wave-ack-tester',
      wave: {},
    });
    assert.equal(gateFailed.action, 'wave_assembly_refused');
    assert.equal(gateFailed.waveId, wave.id);
    assert.equal(gateFailed.gateState, 'gate_failed');
    assert.deepEqual(gateFailed.gate, { state: 'gate_failed', verification: { status: 'failed_suite' } });

    const invalidatedResult = await callTool('integrate', {
      project,
      ref: 'SQ-9001,SQ-9002',
      by: 'wave-ack-tester',
      wave: {},
    });
    assert.equal(invalidatedResult.action, 'wave_assembly_refused');
    assert.equal(invalidatedResult.reason, 'wave_invalidated');
    assert.equal(invalidatedResult.waveId, wave.id);
    assert.deepEqual(invalidatedResult.invalidated, invalidated);
  } finally {
    store.assembleSubmissionWave = originalAssembleSubmissionWave;
  }
});

test('MCP integrate refuses array wave inputs and documents comma-separated groups', async () => {
  const project = store.ensureProject(committedRepo('sq-mcp-integrate-wave-shape-')).slug;
  const originalAssembleSubmissionWave = store.assembleSubmissionWave;
  const received: any[] = [];
  store.assembleSubmissionWave = (_slug: string, refs: string[], wave: any) => {
    received.push({ refs, wave });
    return {
      ok: true,
      wave: { id: 'wave-input-shape', participants: refs },
      gate: { state: 'gate_passed' },
    };
  };
  try {
    const arrayWave = await callTool('integrate', {
      project,
      ref: 'SQ-9001',
      by: 'wave-input-tester',
      wave: ['SQ-9001', 'SQ-9002'],
    });
    assert.equal(arrayWave.ok, false);
    assert.equal(arrayWave.reason, 'wave_options_required');
    assert.match(arrayWave.message, /comma-separated ref string/);
    assert.deepEqual(received, []);

    const scalarWave = await callTool('integrate', {
      project,
      ref: 'SQ-9001',
      by: 'wave-input-tester',
      wave: 'SQ-9001,SQ-9002',
    });
    assert.equal(scalarWave.ok, false);
    assert.equal(scalarWave.reason, 'wave_options_required');

    const grouped = await callTool('integrate', {
      project,
      ref: 'SQ-9001,SQ-9002',
      by: 'wave-input-tester',
      wave: {},
    });
    assert.equal(grouped.ok, true, grouped.message || grouped.reason);
    assert.deepEqual(grouped.participantRefs, ['SQ-9001', 'SQ-9002']);
    assert.deepEqual(received, [{ refs: ['SQ-9001', 'SQ-9002'], wave: {} }]);
  } finally {
    store.assembleSubmissionWave = originalAssembleSubmissionWave;
  }

  const repositoryRoot = path.resolve(__dirname, '..', '..', '..');
  const cliHelp = fs.readFileSync(path.join(repositoryRoot, 'plugins', 'sidequest', 'bin', 'sidequest.js'), 'utf8');
  const invocationContracts = fs.readFileSync(path.join(repositoryRoot, 'plugins', 'sidequest', 'skills', 'sidequest', 'references', 'invocation-contracts.md'), 'utf8');
  const gettingStarted = fs.readFileSync(path.join(repositoryRoot, 'docs', 'src', 'content', 'docs', 'getting-started', 'sidequest.md'), 'utf8');
  assert.match(cliHelp, /MCP ref uses one comma-separated string and wave is an options object/);
  assert.match(invocationContracts, /MCP `ref` is one ticket ref or a comma-separated participant group/);
  assert.doesNotMatch(gettingStarted, /MCP wave groups go in one comma-separated `ref` string/);
});

test('MCP integrate acknowledges pending submitted overlaps omitted from a singleton wave', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-wave-omitted-overlap-'))).slug;
  const candidate = store.createTicket(project, {
    title: 'singleton wave candidate', files: ['lib/shared.js'], complexity: 2,
    labels: ['direct-ok'], complexityWhy: 'exercise the singleton wave acknowledgement',
  });
  const sibling = store.createTicket(project, {
    title: 'submitted sibling', files: ['lib/shared.js'], complexity: 2,
    labels: ['direct-ok'], complexityWhy: 'exercise the pending overlap acknowledgement',
  });
  claimDispatchedTicket(project, candidate, 'singleton-wave-worker', true);
  claimDispatchedTicket(project, sibling, 'submitted-sibling-worker', true);
  const pendingCandidate = store.getTicket(project, candidate.ref);
  const pendingSibling = store.getTicket(project, sibling.ref);
  const baseline = {
    revision: { source: 'fixture', value: 'base-1', observedAt: '2026-09-04T00:00:00.000Z' },
    purpose: 'dispatch',
  };
  const verification = { kind: 'custom', status: 'manual', evidence: 'fixture gate accepted' };
  for (const [ticket, revision] of [[pendingCandidate, 'candidate-1'], [pendingSibling, 'sibling-1']] as const) {
    ticket.claim = null;
    ticket.submission = {
      sourceRevision: { source: 'fixture', value: revision, observedAt: '2026-09-04T00:00:00.000Z' },
      baseline,
      changedPaths: ['lib/shared.js'],
      verificationResult: verification,
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
  }

  const assembled = await callTool('integrate', {
    project,
    ref: candidate.ref,
    by: 'wave-overlap-tester',
    wave: { verification },
  });
  assert.equal(assembled.ok, true, assembled.message || assembled.reason);
  assert.deepEqual(assembled.omittedPendingOverlaps, [{ ref: sibling.ref, surfaces: ['lib/shared.js'] }]);
  assert.match(assembled.message, new RegExp(`Submitted candidates outside this wave overlap its declared scope: ${sibling.ref}`));
});

test('MCP resolves a persisted filesystem-snapshot adapter without runtime registration', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-persisted-source-revision-'));
  const project = store.ensureProject(projectPath).slug;
  assert.equal(store.readMeta(project).sourceRevisionAdapter, 'filesystem-snapshot');
  const ticket = store.createTicket(project, {
    title: 'publish a persisted filesystem snapshot',
    files: ['wiki/page.md'],
    complexity: 2,
    complexityWhy: 'exercise the persisted non-Git adapter through the MCP lifecycle',
    executorVerifyKind: 'attestation',
    executorAttestationArtifact: 'filesystem snapshot reviewed',
    labels: ['direct-ok'],
  });
  const by = 'mcp-persisted-filesystem-worker';
  claimDispatchedTicket(project, ticket, by, true);
  const dispatchBaseline = store.getTicket(project, ticket.ref).lifecycleAttempt.baseline;
  assert.equal(dispatchBaseline.revision.source, 'filesystem-snapshot');
  assert.ok(store.readMeta(project).sourceRevisionSnapshots.some((snapshot: any) => snapshot.value === dispatchBaseline.revision.value));
  fs.mkdirSync(path.join(projectPath, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'wiki', 'page.md'), 'persisted adapter revision\n');
  const revision = sourceRevisionCapability.filesystemSnapshotRevision(projectPath);
  assert.ok(revision, 'the production adapter can derive an immutable candidate from the project tree');

  const submitted = await callTool('submit', {
    project,
    ref: ticket.ref,
    by,
    sourceRevision: revision,
    changedSurfaces: ['wiki/page.md'],
    projectCapabilities: {
      process: false,
      worktree: false,
      review: true,
    },
    verify: `attestation: ${revision.value} | reviewer approved the immutable filesystem snapshot | source and snapshot value matched`,
    body: 'Reviewed the persisted filesystem snapshot.',
  });
  assert.equal(submitted.ok, true, submitted.message || submitted.reason);
  assert.deepEqual(store.getTicket(project, ticket.ref).submission.sourceRevision, revision);

  const assembled = await callTool('integrate', {
    project,
    ref: ticket.ref,
    by: 'mcp-persisted-source-publisher',
    wave: { verification: store.getTicket(project, ticket.ref).submission.verificationResult },
  });
  assert.equal(assembled.ok, true, assembled.message || assembled.reason);
  const integrated = await callTool('integrate', { project, ref: ticket.ref, by: 'mcp-persisted-source-publisher' });
  assert.equal(integrated.ok, true, integrated.message || integrated.reason);
  assert.equal(integrated.delivery.mode, 'source-revision');
});

test('MCP submit requires exactly one revision identity', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-source-exclusive-'));
  const project = store.ensureProject(projectPath).slug;
  const ticket = store.createTicket(project, {
    title: 'reject mixed revision identities',
    files: ['wiki/page.md'],
    complexity: 2,
    complexityWhy: 'exercise public submission validation',
    labels: ['direct-ok'],
  });
  const by = 'mcp-exclusive-worker';
  assert.equal((await callTool('claim', {
    project,
    ref: ticket.ref,
    by,
    direct: true,
    reason: 'This fixture checks one exact public submission validation.',
  })).ok, true);

  const refused = await callToolRaw('submit', {
    project,
    ref: ticket.ref,
    by,
    commit: 'abc1234',
    sourceRevision: { source: 'wiki', value: 'wiki-42', observedAt: '2026-08-14T00:00:00.000Z' },
    changedSurfaces: ['wiki/page.md'],
    projectCapabilities: {},
    verify: 'attestation: wiki-42',
    body: 'Mixed revision identity must fail.',
  });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /exactly one of commit or sourceRevision/);
});

test('MCP submit accepts a known submitted commit as an explicit base', async () => {
  const worktree = createGitWorktree();
  const project = store.ensureProject(worktree).slug;
  const first = store.createTicket(project, {
    title: 'MCP explicit base ancestor', files: ['lib/first.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'provide a validated submission boundary for a dependent range',
  });
  assert.equal((await callTool('claim', { project, ref: first.ref, by: 'mcp-base-worker', direct: true, reason: 'The MCP explicit-base fixture requires a local direct claim.' })).ok, true);
  fs.mkdirSync(path.join(worktree, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'lib', 'first.js'), 'first\n');
  gitAt(worktree, ['add', 'lib/first.js']);
  gitAt(worktree, ['commit', '-m', 'MCP explicit base ancestor']);
  const firstTip = gitAt(worktree, ['rev-parse', 'HEAD']);
  gitAt(worktree, ['update-ref', `refs/sidequest/${first.ref}`, firstTip]);
  assert.equal((await callTool('submit', { project, ref: first.ref, by: 'mcp-base-worker', commit: firstTip, worktree, body: 'MCP explicit-base evidence' })).ok, true);

  const second = store.createTicket(project, {
    title: 'MCP explicit dependent range', files: ['lib/second.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'prove the MCP base input isolates the unsubmitted suffix',
  });
  assert.equal((await callTool('claim', { project, ref: second.ref, by: 'mcp-dependent-worker', direct: true, reason: 'The MCP explicit-base fixture requires a local direct claim.' })).ok, true);
  fs.writeFileSync(path.join(worktree, 'lib', 'second.js'), 'second\n');
  gitAt(worktree, ['add', 'lib/second.js']);
  gitAt(worktree, ['commit', '-m', 'MCP explicit dependent range']);
  const secondTip = gitAt(worktree, ['rev-parse', 'HEAD']);
  gitAt(worktree, ['update-ref', `refs/sidequest/${second.ref}`, secondTip]);

  const submitted = await callTool('submit', {
    project, ref: second.ref, by: 'mcp-dependent-worker', commit: secondTip, base: firstTip, worktree, body: 'MCP dependent-range evidence',
  });
  assert.equal(submitted.ok, true);
  const submission = store.getTicket(project, second.ref).submission;
  assert.equal(submission.base, firstTip);
  assert.deepEqual(submission.commits, [secondTip]);
  assert.deepEqual(submission.changedPaths, ['lib/second.js']);
});

test('MCP commit explains in-place external-output recovery', async () => {
  const worktree = createGitWorktree();
  const project = store.ensureProject(worktree).slug;
  const outside = path.join(os.tmpdir(), `sq-mcp-external-output-${process.pid}.html`);
  const ticket = store.createTicket(project, {
    title: 'MCP external output', files: ['lib/allowed.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm external output commit refusal names the recovery path',
  });
  const by = 'mcp-external-output-worker';
  assert.equal((await callTool('claim', { project, ref: ticket.ref, by, direct: true, reason: 'The external output fixture requires a local direct claim.' })).ok, true);
  const originalGetTicket = store.getTicket;
  store.getTicket = (slug: string, ref: string) => {
    const found = originalGetTicket(slug, ref);
    return found?.ref === ticket.ref ? { ...found, files: [outside] } : found;
  };
  let refused: any;
  try {
    refused = await callTool('commit', { project, ref: ticket.ref, by, message: 'MCP external output', worktree });
  } finally {
    store.getTicket = originalGetTicket;
  }

  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'outside_scope');
  assert.match(refused.message, /declared paths are outside the repo worktree/i);
  assert.match(refused.message, /update.*--files.*drop the stale path/i);
  assert.match(refused.message, /release and reclassify as non-repo\/artifact work/i);
});

export {};
