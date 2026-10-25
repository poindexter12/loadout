'use strict';
// SQ-137: one topic shard of the former mcp.test.ts, split so the runner can spread its tests
// across workers. Shared setup and helpers live in ./_mcp-fixture.ts; the tests are moved unchanged.
import {
  test,
  assert,
  os,
  path,
  fs,
  mcp,
  store,
  DISPATCH_DESCRIPTION,
  callTool,
  gitAt,
  persistTicket,
  createGitWorktree,
  addMarketplaceFixture,
  claimDispatchedTicket,
} from './_mcp-fixture.js';

test('MCP submit requires release fragments for marketplace plugin changes', async () => {
  const missingWorktree = createGitWorktree();
  addMarketplaceFixture(missingWorktree);
  const missingProject = store.ensureProject(missingWorktree).slug;
  const missing = store.createTicket(missingProject, {
    title: 'missing release fragment', files: ['plugins/fixture-plugin'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm shipped plugin changes require an authored release fragment',
  });
  const missingBy = 'mcp-release-fragment-worker';
  assert.equal((await callTool('claim', { project: missingProject, ref: missing.ref, by: missingBy, direct: true, reason: 'The release fragment fixture requires a local direct claim.' })).ok, true);
  fs.mkdirSync(path.join(missingWorktree, 'plugins', 'fixture-plugin'), { recursive: true });
  fs.writeFileSync(path.join(missingWorktree, 'plugins', 'fixture-plugin', 'index.js'), 'changed\n');
  gitAt(missingWorktree, ['add', 'plugins/fixture-plugin/index.js']);
  gitAt(missingWorktree, ['commit', '-m', 'plugin change without fragment']);
  const missingCommit = gitAt(missingWorktree, ['rev-parse', 'HEAD']);
  gitAt(missingWorktree, ['update-ref', `refs/sidequest/${missing.ref}`, missingCommit]);
  const refused = await callTool('submit', {
    project: missingProject, ref: missing.ref, by: missingBy, commit: missingCommit, worktree: missingWorktree, body: 'Missing fragment evidence',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'missing_release_fragment');
  assert.match(refused.message, new RegExp(`so it rides along:\\n---\\nref: ${missing.ref}`));
  assert.match(refused.message, /Write the fragment, then commit it, then submit again\./);
  assert.doesNotMatch(refused.message, /Request scope/);
  assert.match(refused.message, /ref: .*\ntitle: <short user-facing title>\nbump: patch\nplugins:/);
  assert.ok(store.getTicket(missingProject, missing.ref).claim, 'fragment refusal keeps the claim');

  const docsWorktree = createGitWorktree();
  addMarketplaceFixture(docsWorktree);
  const docsProject = store.ensureProject(docsWorktree).slug;
  const docs = store.createTicket(docsProject, {
    title: 'docs-only submission', files: ['docs'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm a marketplace fixture does not block unrelated documentation work',
  });
  const docsBy = 'mcp-docs-worker';
  assert.equal((await callTool('claim', { project: docsProject, ref: docs.ref, by: docsBy, direct: true, reason: 'The docs-only fixture requires a local direct claim.' })).ok, true);
  fs.mkdirSync(path.join(docsWorktree, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(docsWorktree, 'docs', 'guide.md'), 'docs\n');
  gitAt(docsWorktree, ['add', 'docs/guide.md']);
  gitAt(docsWorktree, ['commit', '-m', 'docs change']);
  const docsCommit = gitAt(docsWorktree, ['rev-parse', 'HEAD']);
  gitAt(docsWorktree, ['update-ref', `refs/sidequest/${docs.ref}`, docsCommit]);
  assert.equal((await callTool('submit', {
    project: docsProject, ref: docs.ref, by: docsBy, commit: docsCommit, worktree: docsWorktree, body: 'Docs-only evidence',
  })).ok, true);

  const fragmentWorktree = createGitWorktree();
  addMarketplaceFixture(fragmentWorktree);
  const fragmentProject = store.ensureProject(fragmentWorktree).slug;
  const fragment = store.createTicket(fragmentProject, {
    title: 'plugin submission with release fragment', files: ['plugins/fixture-plugin'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm a shipped plugin change can include its ticket-bound fragment without declared release scope',
  });
  const fragmentBy = 'mcp-valid-fragment-worker';
  assert.equal((await callTool('claim', { project: fragmentProject, ref: fragment.ref, by: fragmentBy, direct: true, reason: 'The valid release fragment fixture requires a local direct claim.' })).ok, true);
  fs.mkdirSync(path.join(fragmentWorktree, 'plugins', 'fixture-plugin'), { recursive: true });
  fs.mkdirSync(path.join(fragmentWorktree, '.release', 'unreleased'), { recursive: true });
  fs.writeFileSync(path.join(fragmentWorktree, 'plugins', 'fixture-plugin', 'index.js'), 'changed\n');
  fs.writeFileSync(path.join(fragmentWorktree, '.release', 'unreleased', `${fragment.ref}.md`), `---\nref: ${fragment.ref}\ntitle: Fixture change\nbump: patch\nplugins:\n  - fixture-plugin\n---\n\nFixture change.\n`);
  gitAt(fragmentWorktree, ['add', 'plugins/fixture-plugin/index.js', `.release/unreleased/${fragment.ref}.md`]);
  assert.deepEqual(store.effectiveScope(fragmentProject, fragment.files), ['plugins/fixture-plugin'], 'ordinary scope reporting excludes the ticket-bound grant');
  const fragmentCommit = await callTool('commit', {
    project: fragmentProject, ref: fragment.ref, by: fragmentBy, message: 'plugin change with fragment', worktree: fragmentWorktree,
  });
  assert.ok(fragmentCommit.commit, 'a ticket can commit its own release fragment without declaring it');
  gitAt(fragmentWorktree, ['update-ref', `refs/sidequest/${fragment.ref}`, fragmentCommit.commit]);
  assert.equal((await callTool('submit', {
    project: fragmentProject, ref: fragment.ref, by: fragmentBy, commit: fragmentCommit.commit, worktree: fragmentWorktree, body: 'Valid fragment evidence',
  })).ok, true);
  assert.deepEqual(store.getTicket(fragmentProject, fragment.ref).submission.admittedScope, ['plugins/fixture-plugin']);
  assert.equal(store.validateIntegrationSubmission(fragmentProject, fragment.ref, {}).ok, true, 'integration revalidation admits only the matching ticket fragment');

  const foreignWorktree = createGitWorktree();
  addMarketplaceFixture(foreignWorktree);
  fs.mkdirSync(path.join(foreignWorktree, '.release', 'unreleased'), { recursive: true });
  fs.writeFileSync(path.join(foreignWorktree, '.release', 'unreleased', 'SQ-other.md'), 'foreign\n');
  gitAt(foreignWorktree, ['add', '.release/unreleased/SQ-other.md']);
  gitAt(foreignWorktree, ['commit', '-m', 'foreign release fragment']);
  const foreignProject = store.ensureProject(foreignWorktree).slug;
  const foreign = store.createTicket(foreignProject, {
    title: 'other release fragment', files: ['plugins/fixture-plugin'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm a ticket cannot remove an unrelated ticket release fragment',
  });
  const foreignBy = 'mcp-foreign-fragment-worker';
  assert.equal((await callTool('claim', { project: foreignProject, ref: foreign.ref, by: foreignBy, direct: true, reason: 'The foreign release fragment fixture requires a local direct claim.' })).ok, true);
  fs.mkdirSync(path.join(foreignWorktree, 'plugins', 'fixture-plugin'), { recursive: true });
  fs.writeFileSync(path.join(foreignWorktree, 'plugins', 'fixture-plugin', 'index.js'), 'changed\n');
  fs.unlinkSync(path.join(foreignWorktree, '.release', 'unreleased', 'SQ-other.md'));
  const foreignCommit = await callTool('commit', {
    project: foreignProject, ref: foreign.ref, by: foreignBy, message: 'remove foreign release fragment', worktree: foreignWorktree,
  });
  assert.equal(foreignCommit.ok, false);
  assert.equal(foreignCommit.reason, 'outside_scope');
  assert.match(foreignCommit.message, new RegExp(`only \\.release/unreleased/${foreign.ref}\\.md is implicitly writable`));
  // SQ-304: a fragment whose candidate no review rejected gets the condition spelled out
  // rather than a bare exception it cannot reach.
  assert.match(foreignCommit.message, new RegExp(`\\.release/unreleased/SQ-other\\.md belongs to another ticket: a foreign fragment becomes deletable only once its candidate is review-rejected and its ticket is linked to ${foreign.ref} with`));
});

test('MCP repair submission transfers a related rejected candidate fragment to its shipping ticket', async () => {
  const worktree = createGitWorktree();
  addMarketplaceFixture(worktree);
  const project = store.ensureProject(worktree).slug;
  const source = store.createTicket(project, {
    title: 'rejected plugin candidate', files: ['plugins/fixture-plugin'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'fixture for a review-rejected candidate release fragment',
  });
  const sourceFragment = `.release/unreleased/${source.ref}.md`;
  fs.mkdirSync(path.join(worktree, 'plugins', 'fixture-plugin'), { recursive: true });
  fs.mkdirSync(path.join(worktree, '.release', 'unreleased'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'plugins', 'fixture-plugin', 'index.js'), 'rejected candidate\n');
  fs.writeFileSync(path.join(worktree, sourceFragment), `---\nref: ${source.ref}\ntitle: Rejected fixture change\nbump: patch\nplugins:\n  - fixture-plugin\n---\n\nRejected fixture change.\n`);
  gitAt(worktree, ['add', 'plugins/fixture-plugin/index.js', sourceFragment]);
  gitAt(worktree, ['commit', '-m', 'rejected plugin candidate']);
  const sourceCommit = gitAt(worktree, ['rev-parse', 'HEAD']);
  const sourceTicket = store.getTicket(project, source.ref);
  const terminalAt = new Date().toISOString();
  sourceTicket.status = 'doing';
  sourceTicket.dispatch = { terminalAt, outcome: 'submitted', attempts: [{ outcome: 'submitted', commit: sourceCommit, terminalAt }] };
  sourceTicket.submission = {
    by: 'rejected-candidate-worker', at: terminalAt, commit: sourceCommit,
    verify: 'manual: rejected fixture', changedPaths: ['plugins/fixture-plugin/index.js', sourceFragment], integratedAt: null,
  };
  persistTicket(project, sourceTicket);
  const review = store.createTicket(project, {
    title: 'review rejected fixture candidate', category: 'review-audit', files: ['plugins/fixture-plugin'],
  }, { ref: source.ref, commit: sourceCommit });
  const rejectedSource = store.getTicket(project, source.ref);
  rejectedSource.submission.review.outcome = 'rejected';
  persistTicket(project, rejectedSource);
  const rejectedReview = store.getTicket(project, review.ref);
  rejectedReview.reviewTarget.outcome = 'rejected';
  persistTicket(project, rejectedReview);

  // SQ-304: the reproduction had no `related` link, so the commit gate refused the
  // deletion too while the refusal named an exception it would not reach. It must now
  // print the exact link a control-plane identity has to add.
  const unlinkedRepair = store.createTicket(project, {
    title: 'unlinked repair of rejected candidate', files: ['plugins/fixture-plugin'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'fixture for a repair filed without the related link',
  });
  const unlinkedBy = 'unlinked-repair-worker';
  assert.equal((await callTool('claim', {
    project, ref: unlinkedRepair.ref, by: unlinkedBy, direct: true,
    reason: 'The unlinked repair fixture requires a local direct claim.',
  })).ok, true);
  fs.writeFileSync(path.join(worktree, 'plugins', 'fixture-plugin', 'index.js'), 'unlinked repair attempt\n');
  fs.unlinkSync(path.join(worktree, sourceFragment));
  const unlinkedRefused = await callTool('commit', {
    project, ref: unlinkedRepair.ref, by: unlinkedBy, message: 'delete the rejected fragment without a link', worktree,
  });
  assert.equal(unlinkedRefused.ok, false);
  assert.equal(unlinkedRefused.reason, 'outside_scope');
  assert.match(unlinkedRefused.message, new RegExp(`\`sidequest link ${unlinkedRepair.ref} related ${source.ref}\``));
  gitAt(worktree, ['checkout', '--', sourceFragment, 'plugins/fixture-plugin/index.js']);

  const repair = store.createTicket(project, {
    title: 'repair rejected plugin candidate', files: ['plugins/fixture-plugin'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'fixture for a repair that ships the rejected candidate correction',
  });
  assert.equal(store.linkTickets(project, repair.ref, 'related', source.ref).ok, true);
  const repairTicket = store.getTicket(project, repair.ref);
  repairTicket.dispatch = { baseCommit: sourceCommit };
  persistTicket(project, repairTicket);
  const repairBy = 'repair-release-fragment-worker';
  assert.equal((await callTool('claim', {
    project, ref: repair.ref, by: repairBy, direct: true,
    reason: 'The repair fixture validates the release fragment takeover wire.',
  })).ok, true);

  const repairFragment = `.release/unreleased/${repair.ref}.md`;
  fs.renameSync(path.join(worktree, sourceFragment), path.join(worktree, repairFragment));
  fs.writeFileSync(path.join(worktree, repairFragment), fs.readFileSync(path.join(worktree, repairFragment), 'utf8').replace(source.ref, repair.ref));
  const committed = await callTool('commit', {
    project, ref: repair.ref, by: repairBy, message: 'transfer rejected candidate release fragment', worktree,
  });
  assert.ok(committed.commit, 'the repair can rename the related rejected source fragment');
  gitAt(worktree, ['update-ref', `refs/sidequest/${repair.ref}`, committed.commit]);
  const submitted = await callTool('submit', {
    project, ref: repair.ref, by: repairBy, commit: committed.commit, worktree,
    verify: 'manual: repair fragment takeover fixture',
    body: 'Repair candidate renamed the rejected source release fragment to its shipping ticket.',
  });
  assert.equal(submitted.ok, true, submitted.message);
  assert.deepEqual(store.getTicket(project, repair.ref).submission.changedPaths.sort(), [sourceFragment, repairFragment].sort());
});

test('MCP carries a derived release scope through a released continuation and integration admission', async () => {
  const worktree = createGitWorktree();
  addMarketplaceFixture(worktree);
  const project = store.ensureProject(worktree).slug;
  store.setBoardConfig(project, { alwaysInScope: ['.release/unreleased'] });
  const ticket = store.createTicket(project, {
    title: 'continued release fragment scope',
    description: DISPATCH_DESCRIPTION,
    category: 'coding.normal',
    files: ['plugins/fixture-plugin'],
    executorVerify: 'node --test plugins/fixture-plugin/test/declared.test.js',
  });
  const first = store.prepareDispatch(project, ticket.ref, { allowUnscoped: true, sharedTree: true });
  assert.deepEqual(first.ticket.dispatch.declaredFiles, ['plugins/fixture-plugin', '.release/unreleased']);
  assert.equal(store.claimTicket(project, ticket.ref, 'release-scope-first-worker', {
    token: first.token,
    executor: first.ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.releaseTicket(project, ticket.ref, 'release-scope-first-worker', {
    status: 'todo',
    source: 'test',
    releaseKind: 'handback',
    releaseReason: 'Continue the prepared release-fragment work.',
  }).ok, true);
  store.setBoardConfig(project, { alwaysInScope: [] });

  const continued = store.prepareDispatch(project, ticket.ref, { allowUnscoped: true, sharedTree: true });
  assert.deepEqual(continued.ticket.dispatch.declaredFiles, ['plugins/fixture-plugin', '.release/unreleased']);
  const by = 'release-scope-continuation-worker';
  assert.equal(store.claimTicket(project, ticket.ref, by, {
    token: continued.token,
    executor: continued.ticket.dispatchExecutor,
  }).ok, true);

  fs.mkdirSync(path.join(worktree, 'plugins', 'fixture-plugin', 'test'), { recursive: true });
  fs.mkdirSync(path.join(worktree, '.release', 'unreleased'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'plugins', 'fixture-plugin', 'index.js'), 'changed\n');
  fs.writeFileSync(path.join(worktree, '.release', 'unreleased', `${ticket.ref}.md`), `---\nref: ${ticket.ref}\ntitle: Continued fixture change\nbump: patch\nplugins:\n  - fixture-plugin\n---\n\nContinued fixture change.\n`);
  const committed = await callTool('commit', {
    project, ref: ticket.ref, by, message: 'continued release fragment scope', worktree,
  });
  assert.ok(committed.commit, 'the continuation admits its ticket-bound release fragment');
  gitAt(worktree, ['update-ref', `refs/sidequest/${ticket.ref}`, committed.commit]);
  assert.equal(store.recordVerificationCapture(project, ticket.ref, {
    command: ticket.executorVerify,
    status: 'passed',
    candidate: { source: 'git', value: committed.commit },
    completedAt: new Date().toISOString(),
  }).ok, true);
  assert.equal((await callTool('submit', {
    project, ref: ticket.ref, by, commit: committed.commit, worktree,
    verify: 'node --test plugins/fixture-plugin/test/declared.test.js',
    body: 'Continued release fragment scope evidence.',
  })).ok, true);
  assert.deepEqual(store.getTicket(project, ticket.ref).submission.admittedScope, ['plugins/fixture-plugin', '.release/unreleased']);
  assert.equal(store.validateIntegrationSubmission(project, ticket.ref, {}).ok, true, 'integration revalidation keeps the derived release scope');
});

test('MCP submit reports every independently fixable completion refusal together', async () => {
  const worktree = createGitWorktree();
  addMarketplaceFixture(worktree);
  const project = store.ensureProject(worktree).slug;
  const ticket = store.createTicket(project, {
    title: 'batched submission refusals',
    description: DISPATCH_DESCRIPTION,
    category: 'coding.normal',
    files: ['plugins/fixture-plugin'],
    executorVerify: 'node --test plugins/fixture-plugin/test/declared.test.js',
  });
  const by = 'mcp-batched-refusal-worker';
  claimDispatchedTicket(project, ticket, by, true);
  fs.mkdirSync(path.join(worktree, 'plugins', 'fixture-plugin', 'test'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'plugins', 'fixture-plugin', 'index.js'), 'module.exports = true;\n');
  fs.writeFileSync(path.join(worktree, 'plugins', 'fixture-plugin', 'test', 'index.test.js'), 'module.exports = true;\n');
  gitAt(worktree, ['add', 'plugins/fixture-plugin']);
  gitAt(worktree, ['commit', '-m', 'batched refusal fixture']);
  const commit = gitAt(worktree, ['rev-parse', 'HEAD']);
  gitAt(worktree, ['update-ref', `refs/sidequest/${ticket.ref}`, commit]);

  const refused = await callTool('submit', {
    project,
    ref: ticket.ref,
    by,
    commit,
    worktree,
    verify: 'node --test plugins/fixture-plugin/test/other.test.js',
    body: 'Batched refusal evidence.',
  });

  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'negative_control_required');
  assert.deepEqual(refused.failures.map((failure: any) => failure.code), [
    'negative_control_required',
    'executor_verify_mismatch',
    'missing_release_fragment',
  ]);
  const refusalMessages = refused.failures.map((failure: any) => failure.message).join('\n');
  assert.match(refusalMessages, /Write the fragment, then commit it, then submit again\./);
  assert.match(refusalMessages, /has not recorded a negative control/);
  assert.match(refusalMessages, /must match the declared executor verify command/);
});

test('MCP add reports every verify-command defect together', async () => {
  const refused = await callTool('add', {
    title: 'batched verify command refusal',
    unclassified: true,
    verify: 'check test; npm run test',
  });

  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'invalid_verify');
  assert.equal(refused.failures.length, 2);
  assert.match(refused.failures[0].message, /cannot use `;`/);
  assert.match(refused.failures[1].message, /must start with a runnable command/);
});

test('MCP add and update refuse verifyKind: command with an empty verify', async () => {
  // SQ-319: this pairing was accepted, and dispatch then silently pinned a DERIVED
  // requirement (usually the whole plugin suite) that no submission could match against
  // the ticket's own empty command. SQ-300 lost three hours to it.
  for (const verify of [undefined, '', '   ']) {
    const refused = await callTool('add', {
      title: 'empty verify under kind command',
      unclassified: true,
      verifyKind: 'command',
      ...(verify === undefined ? {} : { verify }),
    });

    assert.equal(refused.ok, false, `verify ${JSON.stringify(verify)} must be refused`);
    assert.equal(refused.reason, 'invalid_verify');
    // The refusal has to name the MCP field names the caller actually passed.
    assert.match(refused.message, /verifyKind: command requires a runnable verify command/);
    assert.match(refused.message, /verify is empty/);
  }

  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-empty-command-'));
  // `npm run <script>` is only accepted as a verify command when the script exists.
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'sq319-mcp-fixture', scripts: { 'test:files': 'node --test' } }),
  );
  const project = store.ensureProject(projectRoot, 'empty command update').slug;
  const ticket = store.createTicket(project, { title: 'ticket with a real command', executorVerify: 'npm run test:files test/mcp.test.ts' });

  const clearing = await callTool('update', { project, ref: ticket.ref, verify: '' });
  assert.equal(clearing.ok, false);
  assert.equal(clearing.reason, 'invalid_verify');
  assert.match(clearing.message, /verifyKind: command requires a runnable verify command/);
  // Nothing may be written by a refused update.
  assert.equal(store.getTicket(project, ticket.ref).executorVerify, 'npm run test:files test/mcp.test.ts');

  // Filing a ticket before its verifier is known stays legal: the kind defaults to
  // `command`, so only an explicit declaration is refused.
  const filed = await callTool('add', { title: 'verify not decided yet', unclassified: true });
  assert.equal(filed.ok, true);
});

test('MCP rejects incompatible attestation fields on add and update', async () => {
  const artifact = 'grafana://caller-controlled-artifact';
  const invalidAttestationCalls = [
    {
      fields: { verifyKind: 'attestation' },
      expected: /verifyKind: attestation requires attestationArtifact/,
    },
    {
      fields: {
        verifyKind: 'attestation',
        attestationArtifact: artifact,
        verify: 'attestation: Sidequest overview dashboard | provisioned a full render | dashboard data rendered',
      },
      expected: /Expected prefix: `attestation: grafana:\/\/caller-controlled-artifact \| `\. Received first segment: `attestation: Sidequest overview dashboard`\./,
    },
    {
      fields: { attestationArtifact: artifact },
      expected: /attestationArtifact requires verifyKind: attestation/,
    },
  ];

  for (const { fields, expected } of invalidAttestationCalls) {
    const refused = await callTool('add', {
      title: 'invalid attestation add',
      unclassified: true,
      ...fields,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'invalid_verify');
    assert.match(refused.message, expected);
  }

  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-attestation-update-')), 'attestation update').slug;
  const ticket = store.createTicket(project, { title: 'valid command ticket' });
  for (const { fields, expected } of invalidAttestationCalls) {
    const refused = await callTool('update', { project, ref: ticket.ref, ...fields });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'invalid_verify');
    assert.match(refused.message, expected);
  }

  for (const name of ['add', 'update']) {
    const properties = mcp.TOOLS.find((tool: any) => tool.name === name).inputSchema.properties;
    assert.match(properties.verify.description, /attestation: <artifact> \| <evidence produced> \| <what it showed>/);
    assert.match(properties.verifyKind.description, /attestationArtifact is rejected when verifyKind is command/);
    assert.match(properties.attestationArtifact.description, /Required only when verifyKind is attestation/);
  }
});

export {};
