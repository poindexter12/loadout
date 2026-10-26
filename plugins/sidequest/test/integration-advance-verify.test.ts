'use strict';
// SQ-137: one topic shard of the former integration-advance.test.ts, split so the runner can spread its tests
// across workers. Shared setup and helpers live in ./_integration-advance-fixture.ts; the tests are moved unchanged.
import {
  test,
  assert,
  fs,
  path,
  execFileSync,
  SIDEQUEST_HOME,
  store,
  mcp,
  makeCliRunner,
  BIN,
  exploration,
  git,
  head,
  commitFile,
  makeRepo,
  submitFixture,
  deliveryTicket,
  nodeVerify,
  dirtyIntegrationTargetStates,
  makeGreenfieldRepo,
} from './_integration-advance-fixture.js';

for (const mode of ['merge', 'replay', 'apply']) {
  test(`integrate ${mode} refuses delivery when the assembled-wave gate fails`, () => {
    const { fixture, slug, ticket, runCli } = deliveryTicket(`verify-fail-${mode}`, {
      verify: nodeVerify("console.error('integration verify failure'); process.exit(7)"),
    });
    const before = head(fixture.repo);
    const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--mode', mode, '--json']);

    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.ok(result.stdout, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.delivery, null);
    assert.equal(payload.reason, 'assembled_wave_gate_failed');
    assert.equal(payload.gate.verification.status, 'failed_suite');
    assert.equal(payload.gate.verification.exitCode, 7);
    assert.match(payload.gate.verification.outputTail, /integration verify failure/);
    assert.ok(fs.existsSync(payload.gate.verification.logPath));
    const stored = store.getTicket(slug, ticket.ref);
    assert.equal(stored.status, 'doing');
    assert.equal(stored.submission.integration, undefined);
    assert.equal(head(fixture.repo), before);
    assert.equal(git(['status', '--porcelain', '--untracked-files=no'], fixture.repo), '');
    assert.equal(fs.existsSync(path.join(fixture.repo, 'feature.txt')), false);
  });
}

test('post-merge verification rolls back a rebuilt committed output to its recorded pre-merge head', () => {
  const fixture = makeRepo('post-merge-rebuilt-output');
  fixture.submitted = commitFile(fixture.executor, 'generated-output.js', 'candidate generated output\n');
  const verify = nodeVerify("const fs=require('node:fs'); const {execFileSync}=require('node:child_process'); const branch=execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(); fs.writeFileSync('generated-output.js',branch==='main'?'rebuilt generated output\\n':'candidate generated output\\n'); if(branch==='main') process.exit(7)");
  const { slug } = store.ensureProject(fixture.repo);
  const ticket = store.createTicket(slug, {
    title: 'rollback rebuilt generated output',
    category: 'codebase-exploration',
    description: 'A delivery fixture whose post-merge verifier rebuilds a committed output before failing.',
    files: ['feature.txt', 'generated-output.js'],
  });
  submitFixture(slug, ticket, fixture);
  store.updateTicket(slug, ticket.ref, { executorVerifyKind: 'suite', executorVerify: verify });
  const before = head(fixture.repo);

  const result = store.integrateSubmission(slug, ticket.ref, { mode: 'merge', target: fixture.target });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'verification_failed_suite_post_merge');
  assert.equal(result.before, before);
  assert.equal(head(fixture.repo), before);
  assert.equal(git(['status', '--porcelain=v2', '--untracked-files=all'], fixture.repo), '');
  assert.equal(fs.existsSync(path.join(fixture.repo, 'generated-output.js')), false);
  const integration = store.getTicket(slug, ticket.ref).submission.integration;
  assert.equal(integration.reason, 'verification_failed_suite_post_merge');
  assert.equal(integration.rollback.strategy, 'hard-reset-delivery-head');
  assert.match(integration.message, /rolled back delivery/);
});

test('post-merge verification refuses a hard reset after an extra main commit', () => {
  const fixture = makeRepo('post-merge-extra-commit');
  const verify = nodeVerify("const fs=require('node:fs'); const {execFileSync}=require('node:child_process'); const branch=execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(); if(branch==='main'){fs.writeFileSync('verify-extra.txt','unexpected main commit\\n'); execFileSync('git',['add','verify-extra.txt']); execFileSync('git',['commit','-m','verify extra commit']); process.exit(7)}");
  const { slug } = store.ensureProject(fixture.repo);
  const ticket = store.createTicket(slug, {
    title: 'refuse reset after extra commit',
    category: 'codebase-exploration',
    description: 'A delivery fixture whose verifier advances main after the delivery merge.',
    files: ['feature.txt'],
  });
  submitFixture(slug, ticket, fixture);
  store.updateTicket(slug, ticket.ref, { executorVerifyKind: 'suite', executorVerify: verify });
  const before = head(fixture.repo);

  const result = store.integrateSubmission(slug, ticket.ref, { mode: 'merge', target: fixture.target });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'verification_failed_suite_post_merge_rollback_failed');
  assert.notEqual(head(fixture.repo), before);
  assert.equal(git(['status', '--porcelain=v2', '--untracked-files=all'], fixture.repo), '');
  assert.match(result.message, /main STILL CONTAINS the delivered merge/);
  assert.match(result.message, /manual recovery/i);
});

test('integrate finalizes after a passing recorded verification command', () => {
  const { slug, ticket, runCli } = deliveryTicket('verify-pass', {
    verify: nodeVerify("console.log('integration verify passed')"),
  });
  const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--json']);

  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verify.status, 'passed');
  assert.equal(payload.verify.outputTail, undefined);
  assert.ok(fs.existsSync(payload.verify.logPath));
  assert.equal(store.getTicket(slug, ticket.ref).status, 'done');
});

test('document verification integrates submitted evidence without invoking the process runner', () => {
  const evidence = 'updated guide explains X';
  const { slug, ticket, runCli } = deliveryTicket('verify-document', {
    verify: evidence,
    verifyKind: 'document',
  });
  const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--json']);

  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verify.kind, 'document');
  assert.equal(payload.verify.status, 'passed');
  assert.equal(payload.verify.evidence, evidence);
  assert.equal(payload.verify.command, undefined);
  assert.equal(payload.verify.logPath, undefined);
  assert.match(payload.ticket.completion.reason, new RegExp(evidence));
  assert.equal(store.getTicket(slug, ticket.ref).submission.integration.verify.evidence, evidence);
});

test('manual verification closes with the executor evidence', () => {
  const evidence = 'manual: executor inspected the rendered guide';
  const { slug, ticket, runCli } = deliveryTicket('verify-manual', {
    verify: evidence,
    verifyKind: 'manual',
  });
  const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--json']);

  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verify.status, 'manual');
  assert.equal(payload.verify.evidence, evidence);
  assert.match(payload.ticket.completion.reason, new RegExp(evidence));
  assert.doesNotMatch(payload.ticket.completion.reason, /undefined/);
  assert.equal(store.getTicket(slug, ticket.ref).completion.reason, payload.ticket.completion.reason);
});

test('integrate refuses delivery when recorded verification times out', () => {
  const { slug, ticket, runCli } = deliveryTicket('verify-timeout', {
    verify: nodeVerify('setTimeout(() => {}, 1000)'),
    timeoutMs: 25,
  });
  const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--json']);

  assert.equal(result.status, 1, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.delivery, null);
  assert.equal(payload.reason, 'assembled_wave_gate_failed');
  assert.equal(payload.gate.verification.status, 'timeout');
  assert.equal(payload.gate.verification.timeoutMilliseconds, 25);
  assert.equal(store.getTicket(slug, ticket.ref).status, 'doing');
});

test('integrate public surfaces honor a bounded verification waiver and refuse a missing payload', async () => {
  const { slug, ticket, runCli } = deliveryTicket('verify-skip', {
    verify: nodeVerify("process.exit(7)"),
  });
  const refused = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--skip-verify', '--json']);

  assert.equal(refused.status, 1, refused.stderr + refused.stdout);
  const refusedPayload = JSON.parse(refused.stdout);
  assert.equal(refusedPayload.reason, 'verification_waiver_required');
  assert.match(refusedPayload.message, /human waiver with authority, reason, affectedGate/);
  assert.equal(refusedPayload.gate, undefined);
  assert.equal(store.getTicket(slug, ticket.ref).status, 'doing');

  const accepted = runCli([
    'integrate', ticket.ref,
    '--by', 'orchestrator',
    '--skip-verify',
    '--waiver-authority', 'release-manager',
    '--waiver-reason', 'vendor verifier outage',
    '--waiver-gate', 'integration-suite',
    '--waiver-scope', ticket.ref,
    '--json',
  ]);

  assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);
  const acceptedPayload = JSON.parse(accepted.stdout);
  assert.equal(acceptedPayload.verify.status, 'skipped');
  assert.equal(acceptedPayload.verify.waiver.authority, 'release-manager');
  assert.deepEqual(acceptedPayload.verify.diagnostics, [{
    code: 'verification_waived',
    message: 'Verification gate integration-suite waived by release-manager: vendor verifier outage',
    actionable: true,
  }]);
  const stored = store.getTicket(slug, ticket.ref);
  assert.equal(stored.status, 'done');
  assert.deepEqual(stored.submission.integration.verify.diagnostics, acceptedPayload.verify.diagnostics);

  const mcpFixture = deliveryTicket('verify-skip-mcp', {
    verify: nodeVerify("process.exit(7)"),
  });
  const mcpResponse = await mcp.handleRequest({
    jsonrpc: '2.0',
    id: 2247,
    method: 'tools/call',
    params: {
      name: 'integrate',
      arguments: {
        project: mcpFixture.fixture.repo,
        ref: mcpFixture.ticket.ref,
        by: 'orchestrator',
        skipVerify: true,
        verificationWaiver: {
          authority: 'release-manager',
          reason: 'vendor verifier outage',
          affectedGate: 'integration-suite',
          scope: mcpFixture.ticket.ref,
        },
      },
    },
  });
  assert.ok(mcpResponse.result, JSON.stringify(mcpResponse));
  assert.ok(!mcpResponse.result.isError, mcpResponse.result.content?.[0]?.text);
  const mcpPayload = JSON.parse(mcpResponse.result.content[0].text);
  assert.equal(mcpPayload.ok, true, JSON.stringify(mcpPayload));
  assert.equal(mcpPayload.verify.status, 'skipped');
  assert.equal(mcpPayload.verify.diagnostics[0].code, 'verification_waived');
  assert.deepEqual(
    store.getTicket(mcpFixture.slug, mcpFixture.ticket.ref).submission.integration.verify.diagnostics,
    mcpPayload.verify.diagnostics,
  );
});

for (const [state, dirtyTarget] of dirtyIntegrationTargetStates) {
  test(`integrate refuses a ${state} target without changing the pending submission`, () => {
    const { fixture, slug, ticket } = deliveryTicket(`dirty-target-${state}`);
    dirtyTarget(fixture, ticket);
    const checkoutBefore = git(['status', '--porcelain=v2', '--untracked-files=all'], fixture.repo);
    const submissionBefore = store.getTicket(slug, ticket.ref).submission;
    const headBefore = head(fixture.repo);

    const result = store.integrateSubmission(slug, ticket.ref, { mode: 'merge', target: fixture.target });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'integration_target_dirty');
    if (state === 'untracked') assert.match(result.message, /target-scratch\.log/);
    assert.equal(git(['status', '--porcelain=v2', '--untracked-files=all'], fixture.repo), checkoutBefore);
    assert.equal(head(fixture.repo), headBefore);
    assert.deepEqual(store.getTicket(slug, ticket.ref).submission, submissionBefore);
    assert.equal(git(['rev-parse', `refs/sidequest/${ticket.ref}`], fixture.repo), fixture.submitted);
  });
}

test('integration does not derive a suite for an unprepared greenfield submission', () => {
  const fixture = makeGreenfieldRepo('locked-dependencies');
  const { slug } = store.ensureProject(fixture.repo);
  const ticket = store.createTicket(slug, {
    title: 'greenfield package',
    category: 'codebase-exploration',
    description: 'A new locked package requires its dependencies during integration.',
    files: ['plugins/greenfield'],
  });
  submitFixture(slug, ticket, fixture);
  const { runCli } = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: fixture.repo }, { cwd: fixture.repo });

  assert.equal(fs.existsSync(path.join(fixture.repo, 'plugins', 'greenfield', 'node_modules')), false);
  const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--json']);

  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verify.status, 'passed');
  assert.equal(payload.verify.kind, 'custom');
  assert.equal(fs.existsSync(path.join(fixture.repo, 'plugins', 'greenfield', 'node_modules')), false);
});

test('integration does not derive an unlocked greenfield suite after submission', () => {
  const fixture = makeGreenfieldRepo('missing-lock', false);
  const { slug } = store.ensureProject(fixture.repo);
  const ticket = store.createTicket(slug, {
    title: 'unlocked greenfield package',
    category: 'codebase-exploration',
    description: 'A package without a lockfile cannot use mutable dependency resolution.',
    files: ['plugins/greenfield'],
  });
  submitFixture(slug, ticket, fixture);
  const { runCli } = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: fixture.repo }, { cwd: fixture.repo });

  const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--json']);

  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verify.status, 'passed');
  assert.equal(payload.verify.kind, 'custom');
  assert.equal(fs.existsSync(path.join(fixture.repo, 'plugins', 'greenfield', 'node_modules')), false);
});

export {};
