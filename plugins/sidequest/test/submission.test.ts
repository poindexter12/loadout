'use strict';
// SQ-137: one topic shard of the former submission.test.ts, split so the runner can spread its tests
// across workers. Shared setup and helpers live in ./_submission-fixture.ts; the tests are moved unchanged.
import {
  test,
  assert,
  os,
  path,
  fs,
  execFileSync,
  SIDEQUEST_HOME,
  store,
  recordCapture,
  runVerifyCapture,
  agentsync,
  mcp,
  db,
  submissionRangeFailureMessage,
  createLocks,
  makeCliRunner,
  PROJECT_DIR,
  git,
  cleanBranch,
  pin,
  slug,
  BIN,
  runCli,
  COMMIT,
  persist,
  addTicket,
  addClaimedTicket,
  createCandidateCommit,
  assertForeignSubmissionWasRefused,
  callMcp,
  captureThenCommit,
} from './_submission-fixture.js';

test('submit requires a held claim, records the submission, and releases the claim in doing', () => {
  const t = addTicket('submit happy path');

  // No claim yet: the submit is refused — it is the terminal act of a claimed run.
  const unclaimed = store.submitTicket(slug, t.ref, 'worker-a', { commit: COMMIT });
  assert.strictEqual(unclaimed.ok, false);
  assert.strictEqual(unclaimed.reason, 'not_claimed');

  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-a', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);

  // Another worker can't submit over worker-a's claim.
  const stranger = store.submitTicket(slug, t.ref, 'worker-b', { commit: COMMIT });
  assert.strictEqual(stranger.ok, false);
  assert.strictEqual(stranger.reason, 'not_owner');

  const res = store.submitTicket(slug, t.ref, 'worker-a', {
    commit: COMMIT.toUpperCase(), // normalized to lowercase
    verify: 'node --test plugins/sidequest/test/submission.test.js',
    worktree: 'C:/tmp/worktrees/agent-x',
  });
  assert.strictEqual(res.ok, true);
  const after = store.getTicket(slug, t.ref);
  assert.strictEqual(after.status, 'doing', 'ready-for-integration parks in doing, never done');
  assert.strictEqual(after.claim, null, 'submit releases the claim');
  assert.strictEqual(after.submission.commit, COMMIT.toLowerCase());
  assert.strictEqual(after.submission.gitRef, `refs/sidequest/${t.ref}`, 'durable ref defaults per ticket');
  assert.strictEqual(after.submission.by, 'worker-a');
  assert.strictEqual(after.submission.integratedAt, null);
  assert.ok(store.pendingSubmission(after));
});

test('submission cases do not inherit tickets from prior cases', () => {
  assert.deepStrictEqual(store.listTickets(slug), []);
});

test('an invalid commit hash is rejected before anything is written', () => {
  const t = addTicket('bad hash');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-a', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  for (const bad of [null, '', 'not-a-hash', 'abc123', 'g'.repeat(10)]) {
    assert.throws(() => store.submitTicket(slug, t.ref, 'worker-a', { commit: bad }), /invalid commit/);
  }
  assert.ok(store.getTicket(slug, t.ref).claim, 'the claim survives a rejected submit');
});

test('submit rejects invalid verify commands without releasing the claim or pin', () => {
  const t = addTicket('invalid submit verify');
  const by = 'verify-worker';
  const pinnedCommit = git(['rev-parse', 'origin/main']);
  pin(t, pinnedCommit);
  assert.strictEqual(store.claimTicket(slug, t.ref, by, { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);

  const refused = store.submitTicket(slug, t.ref, by, {
    commit: pinnedCommit,
    verify: 'GIT_TERMINAL_PROMPT=0; cd plugins/sidequest && npx tsx --test test/*.test.ts',
  });

  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'invalid_verify');
  assert.match(refused.message, /Verify cannot use `;` command chaining/);
  assert.match(refused.message, /join dependent steps with `&&`/);
  assert.strictEqual(store.getTicket(slug, t.ref).claim.by, by);
  assert.strictEqual(git(['rev-parse', `refs/sidequest/${t.ref}`]), pinnedCommit);
});

test('submit rejects bare manual prose without releasing the claim', () => {
  const t = addTicket('bare manual submit verify');
  const by = 'bare-manual-worker';
  assert.strictEqual(store.claimTicket(slug, t.ref, by, { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);

  const refused = store.submitTicket(slug, t.ref, by, {
    commit: COMMIT,
    verify: 'manual focused verifier',
  });

  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'invalid_verify');
  assert.match(refused.message, /exact prefix `manual: <what you checked>`/);
  assert.strictEqual(store.getTicket(slug, t.ref).claim.by, by);
});

test('integration rejects legacy invalid submission verify before delivery', () => {
  const t = addTicket('legacy malformed submission');
  t.submission = { commit: COMMIT, verify: 'manual focused verifier', integratedAt: null };
  persist(t);

  const refused = store.validateIntegrationSubmission(slug, t.ref);

  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'invalid_submission_verify');
  assert.match(refused.message, /submission record verify "manual focused verifier"/);
  assert.match(refused.message, /reads the executor's submission\.verify record; update\(\{verify\}\) re-pins which command integration runs but does not rewrite that record/);
});

test('MCP submit requires a completed capture for the declared executor verifier', async () => {
  fs.mkdirSync(path.join(PROJECT_DIR, 'test'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'scoped-surface.test.js'), '');
  const command = 'node --test test/scoped-surface.test.js';
  const t = addTicket('declared scoped verify', { executorVerify: command, files: ['README.md'] });
  const by = 'scoped-verify-worker';
  const pinnedCommit = git(['rev-parse', 'origin/main']);
  pin(t, pinnedCommit);
  assert.strictEqual(store.claimTicket(slug, t.ref, by, { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);

  const missingCapture = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: t.ref,
    by,
    commit: pinnedCommit,
    base: pinnedCommit,
    worktree: PROJECT_DIR,
    verify: command,
    body: 'Retyped verifier string without a completed capture.',
  });

  assert.strictEqual(missingCapture.ok, false);
  assert.strictEqual(missingCapture.reason, 'verification_capture_required');
  assert.match(missingCapture.message, /No completed passed verification capture exists/);
  assert.match(missingCapture.message, /node --test test\/scoped-surface\.test\.js/);
  assert.strictEqual(store.getTicket(slug, t.ref).claim.by, by);

  const capture = await runVerifyCapture(command, PROJECT_DIR);
  try {
    assert.deepStrictEqual({ status: capture.status, exitCode: capture.exitCode }, { status: 'passed', exitCode: 0 });
    const recorded = recordCapture({ project: PROJECT_DIR, ticket: t.ref }, capture, PROJECT_DIR);
    assert.strictEqual(recorded.ok, true, recorded.message);
    assert.strictEqual(recorded.capture.candidate.value, pinnedCommit);
    assert.strictEqual(recorded.capture.shell, capture.shell);

    const accepted = await callMcp('submit', {
      project: PROJECT_DIR,
      ref: t.ref,
      by,
      commit: pinnedCommit,
      base: pinnedCommit,
      worktree: PROJECT_DIR,
      verify: command,
      body: 'Completed capture verified the submitted candidate.',
    });
    assert.strictEqual(accepted.ok, true, accepted.message);
  } finally {
    fs.rmSync(capture.logPath, { force: true });
  }
});

test('SQ-81: MCP submit accepts a capture when only an unreleased release fragment follows it', async () => {
  const { submit, capture, captured, tip } = await captureThenCommit('fragment only follows capture', { '.release/unreleased/{ref}.md': '---\nsidequest: patch\n---\nfixture\n' });
  try {
    assert.notStrictEqual(captured, tip);
    const accepted = await submit();
    assert.strictEqual(accepted.ok, true, accepted.message);
  } finally {
    fs.rmSync(capture.logPath, { force: true });
    cleanBranch();
  }
});

test('SQ-81: MCP submit rejects a capture followed by a release fragment and source change in one commit', async () => {
  const { submit, capture } = await captureThenCommit('fragment plus source follows capture', {
    '.release/unreleased/{ref}.md': '---\nsidequest: patch\n---\nfixture\n',
    'src/changed.js': 'module.exports = 1;\n',
  });
  try {
    const refused = await submit();
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.reason, 'verification_capture_required');
  } finally {
    fs.rmSync(capture.logPath, { force: true });
    cleanBranch();
  }
});

test('SQ-81: MCP submit rejects a capture followed only by a source change', async () => {
  const { submit, capture } = await captureThenCommit('source only follows capture', { 'src/changed.js': 'module.exports = 2;\n' });
  try {
    const refused = await submit();
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.reason, 'verification_capture_required');
  } finally {
    fs.rmSync(capture.logPath, { force: true });
    cleanBranch();
  }
});

test('SQ-179: an orchestrator capture waiver admits a load-only failed capture; self-authored and mis-signed waivers stay refused', async () => {
  const command = 'node -e "process.exit(1)"';
  const t = addTicket('load-only capture failure', { executorVerify: command, files: ['README.md'] });
  const by = 'load-only-capture-worker';
  const pinnedCommit = git(['rev-parse', 'origin/main']);
  pin(t, pinnedCommit);
  assert.strictEqual(store.claimTicket(slug, t.ref, by, { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  const submit = () => callMcp('submit', { project: PROJECT_DIR, ref: t.ref, by, commit: pinnedCommit, base: pinnedCommit, worktree: PROJECT_DIR, verify: command, body: 'Capture failed only from host load.' });

  const capture = await runVerifyCapture(command, PROJECT_DIR);
  try {
    assert.deepStrictEqual({ status: capture.status, exitCode: capture.exitCode }, { status: 'failed_suite', exitCode: 1 });
    const recorded = recordCapture({ project: PROJECT_DIR, ticket: t.ref }, capture, PROJECT_DIR);
    assert.strictEqual(recorded.ok, true, recorded.message);
    const captureId = recorded.capture.id;
    const waiverLine = (signature: string) => `[sidequest:capture-waiver] capture=${captureId} signature=${signature} authority=joe; port race while three sibling full suites ran, rerun passed at load 2`;

    const refused = await submit();
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.reason, 'verification_capture_required');
    assert.match(refused.message, /do not hand-edit refs\/sidequest/);
    assert.ok(refused.message.includes(`[sidequest:capture-waiver] capture=${captureId} signature=failed_suite:exit-1 authority=<who>`), refused.message);

    // SQ-306: the claim holder's own waiver no longer reaches the thread at all. Before this it was
    // recorded, read as authoritative, and only discarded at submit.
    const selfAuthored = store.addComment(slug, t.ref, { by, body: waiverLine('failed_suite:exit-1') });
    assert.strictEqual(selfAuthored.ok, false);
    assert.strictEqual(selfAuthored.reason, 'authority_comment_author');
    assert.match(selfAuthored.message, /forbidden from waiving its own capture/);
    assert.ok(!(store.getTicket(slug, t.ref).comments || []).some((comment: any) => comment.body.includes('[sidequest:capture-waiver]')), 'no waiver is stored');

    store.addComment(slug, t.ref, { by: 'orchestrator', body: waiverLine('timeout') });
    const misSigned = await submit();
    assert.strictEqual(misSigned.reason, 'verification_capture_required');
    assert.match(misSigned.message, /signature timeout does not match the recorded failed_suite:exit-1/);
    assert.strictEqual(store.getTicket(slug, t.ref).claim.by, by);

    store.addComment(slug, t.ref, { by: 'orchestrator', body: `Evidence reviewed.\n${waiverLine('failed_suite:exit-1')}` });
    const accepted = await submit();
    assert.strictEqual(accepted.ok, true, accepted.message);
    const result = store.getTicket(slug, t.ref).submission.verificationResult;
    assert.strictEqual(result.status, 'skipped');
    assert.strictEqual(result.waiver.affectedGate, 'verification_capture_required');
    assert.strictEqual(result.waiver.authority, 'joe');
    assert.ok(result.waiver.scope.includes(`load-only capture ${captureId} (failed_suite:exit-1) of git:${pinnedCommit}`), result.waiver.scope);
    assert.match(result.waiver.scope, /waived by orchestrator$/);
    assert.strictEqual(result.diagnostics[0].code, 'verification_waived');
  } finally {
    fs.rmSync(capture.logPath, { force: true });
  }
});

test('SQ-179: capture waivers bind only a timeout or failed_suite capture of the same candidate, command, and dispatch attempt', () => {
  const { commandVerificationResult } = require('../src/lib/kernel/verification.ts');
  const requirement = { kind: 'command', command: 'npm test', evidenceContract: 'npm test' };
  const candidate = { source: 'git', value: 'a'.repeat(40) };
  const capture = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, ticket: 'SQ-9', command: 'npm test', status, candidate, dispatchNonce: 'n1', completedAt: '2026-09-28T00:00:00.000Z', ...extra });
  const captures = [
    capture('timed-out', 'timeout'),
    capture('no-run', 'could_not_run', { exitCode: 2 }),
    capture('old-attempt', 'failed_suite', { exitCode: 1, dispatchNonce: 'n0' }),
    capture('other-commit', 'failed_suite', { exitCode: 1, candidate: { source: 'git', value: 'b'.repeat(40) } }),
  ];
  const verdict = (body: string, by = 'orchestrator') => commandVerificationResult(requirement, 'npm test', captures, 'SQ-9', candidate, 'n1', { comments: [{ by, body }], excludedAuthors: ['worker'] });
  const reason = 'capture budget timeout at load 14 on ten cores while other suites ran';

  for (const id of ['no-run', 'old-attempt', 'other-commit']) {
    const refused = verdict(`[sidequest:capture-waiver] capture=${id} signature=failed_suite:exit-1 authority=joe; ${reason}`);
    assert.strictEqual(refused.diagnostic.code, 'verification_capture_required', id);
    assert.match(refused.diagnostic.message, new RegExp(`capture ${id} waiver by orchestrator \\(not a timeout or failed_suite capture of this candidate, command, and dispatch attempt\\)`));
  }
  // The write path refuses a waiver authored by the claim holder, but it cannot know who will
  // submit, so the submit gate still has to reject a waiver authored by the submitter.
  const bySubmitter = verdict(`[sidequest:capture-waiver] capture=timed-out signature=timeout authority=joe; ${reason}`, 'worker');
  assert.strictEqual(bySubmitter.diagnostic.code, 'verification_capture_required');
  assert.match(bySubmitter.diagnostic.message, /waiver by worker \(the claim holder or submitter cannot waive its own capture\)/);
  const malformed = verdict('[sidequest:capture-waiver] capture=timed-out signature=timeout authority=joe; too short');
  assert.strictEqual(malformed.diagnostic.code, 'verification_capture_required');
  assert.match(malformed.diagnostic.message, /Ignored capture waivers: malformed waiver by orchestrator/);
  assert.match(malformed.diagnostic.message, /The latest waivable capture is timed-out \(timeout\)/);
  const unattributed = verdict(`[sidequest:capture-waiver] capture=timed-out signature=timeout authority=joe; ${reason}`, '');
  assert.strictEqual(unattributed.diagnostic.code, 'verification_capture_required');

  const waived = verdict(`[sidequest:capture-waiver] capture=timed-out signature=timeout authority=joe; ${reason}`);
  assert.strictEqual(waived.diagnostic, undefined);
  assert.strictEqual(waived.result.status, 'skipped');
  assert.strictEqual(waived.result.waiver.scope, `load-only capture timed-out (timeout) of git:${'a'.repeat(40)}, dispatch attempt n1, waived by orchestrator`);

  const passed = commandVerificationResult(requirement, 'npm test', [...captures, capture('green', 'passed', { exitCode: 0 })], 'SQ-9', candidate, 'n1', { comments: [{ by: 'orchestrator', body: `[sidequest:capture-waiver] capture=timed-out signature=timeout authority=joe; ${reason}` }] });
  assert.strictEqual(passed.result.status, 'passed', 'a passing capture still wins over a waiver');
});

test('SQ-306: captureWaiverBinding reports author eligibility, capture identity, and candidate currency at post time', () => {
  const { captureWaiverBinding } = require('../src/lib/kernel/verification.ts');
  const candidate = { source: 'git', value: 'a'.repeat(40) };
  const captures = [
    { id: 'timed-out', ticket: 'SQ-9', command: 'npm test', status: 'timeout', candidate, dispatchNonce: 'n1', completedAt: '2026-10-09T00:00:00.000Z' },
    { id: 'no-run', ticket: 'SQ-9', command: 'npm test', status: 'could_not_run', exitCode: 2, candidate, dispatchNonce: 'n1', completedAt: '2026-10-09T00:00:00.000Z' },
    { id: 'old-attempt', ticket: 'SQ-9', command: 'npm test', status: 'timeout', candidate, dispatchNonce: 'n0', completedAt: '2026-10-09T00:00:00.000Z' },
  ];
  const reason = 'capture budget timeout at load 14 on ten cores while other suites ran';
  const bind = (body: string, by = 'orchestrator', pinnedCandidate = candidate.value) => captureWaiverBinding({
    comment: { by, body },
    captures,
    claimHolder: 'worker',
    dispatchNonce: 'n1',
    pinnedCandidate,
  });

  assert.strictEqual(bind('Plain handoff comment, no marker.'), null, 'a comment with no marker has no binding to report');

  const binds = bind(`[sidequest:capture-waiver] capture=timed-out signature=timeout authority=joe; ${reason}`);
  assert.deepStrictEqual({ ...binds }, {
    capture: 'timed-out',
    author: 'orchestrator',
    authorEligible: true,
    captureKnown: true,
    candidate: candidate.value,
    candidateMatchesPinned: true,
    binds: true,
    note: binds.note,
  });
  assert.match(binds.note, /^This waiver binds capture timed-out \(timeout\) of candidate a{40}\./);

  const selfAuthored = bind(`[sidequest:capture-waiver] capture=timed-out signature=timeout authority=joe; ${reason}`, 'worker');
  assert.strictEqual(selfAuthored.authorEligible, false);
  assert.strictEqual(selfAuthored.binds, false);
  assert.match(selfAuthored.note, /its recorded author worker holds the claim/);

  const superseded = bind(`[sidequest:capture-waiver] capture=timed-out signature=timeout authority=joe; ${reason}`, 'orchestrator', 'b'.repeat(40));
  assert.strictEqual(superseded.candidateMatchesPinned, false);
  assert.strictEqual(superseded.binds, false);
  assert.match(superseded.note, /checked candidate a{40}, and the live pinned candidate is b{40}/);

  const unknownStatus = bind(`[sidequest:capture-waiver] capture=no-run signature=could_not_run:exit-2 authority=joe; ${reason}`);
  assert.strictEqual(unknownStatus.captureKnown, false);
  assert.match(unknownStatus.note, /capture no-run is could_not_run, and only a timeout or failed_suite capture can be waived/);

  const otherAttempt = bind(`[sidequest:capture-waiver] capture=old-attempt signature=timeout authority=joe; ${reason}`);
  assert.strictEqual(otherAttempt.captureKnown, false);
  assert.match(otherAttempt.note, /belongs to an earlier dispatch attempt, not n1/);

  const unrecorded = bind(`[sidequest:capture-waiver] capture=missing signature=timeout authority=joe; ${reason}`);
  assert.strictEqual(unrecorded.captureKnown, false);
  assert.match(unrecorded.note, /capture missing is not recorded on this ticket/);

  const misSigned = bind(`[sidequest:capture-waiver] capture=timed-out signature=failed_suite:exit-1 authority=joe; ${reason}`);
  assert.strictEqual(misSigned.captureKnown, false);
  assert.match(misSigned.note, /signature failed_suite:exit-1 does not match the recorded timeout/);

  const malformed = bind('[sidequest:capture-waiver] capture=timed-out signature=timeout authority=joe; too short');
  assert.strictEqual(malformed.binds, false);
  assert.match(malformed.note, /This waiver cannot bind: malformed waiver by orchestrator/);
});

test('capture accepts a live verify amendment and still rejects unrelated commands', async () => {
  const pinnedCommand = 'node -e "process.exit(0)" && node -e "process.exit(1)"';
  const amendedCommand = 'node -e "process.exit(0)"';
  const dispatched = addTicket('amended dispatched capture', {
    category: 'submission.fixture',
    executorVerifyKind: 'command',
    executorVerify: pinnedCommand,
  });
  const prepared = store.prepareDispatch(slug, dispatched.ref, {
    sessionId: 'amended-capture-dispatch',
    sharedTree: true,
  });
  assert.strictEqual(prepared.ticket.dispatch.verificationRequirement.command, pinnedCommand);
  store.updateTicket(slug, dispatched.ref, {
    executorVerifyKind: 'command',
    executorVerify: amendedCommand,
    source: 'test',
  });
  const amendedTicket = store.getTicket(slug, dispatched.ref);
  assert.strictEqual(amendedTicket.dispatch.verificationRequirement.command, amendedCommand);
  assert.deepStrictEqual(amendedTicket.verificationAmendments.at(-1), {
    at: amendedTicket.verificationAmendments.at(-1).at,
    by: null,
    oldCommand: pinnedCommand,
    newCommand: amendedCommand,
  });

  const amendedCapture = await runVerifyCapture(amendedCommand, PROJECT_DIR);
  try {
    assert.strictEqual(amendedCapture.status, 'passed');
    const recorded = recordCapture({ project: PROJECT_DIR, ticket: dispatched.ref }, amendedCapture, PROJECT_DIR);
    assert.strictEqual(recorded.ok, true);
    assert.strictEqual(recorded.capture.command, amendedCommand);

    const unrelated = recordCapture({ project: PROJECT_DIR, ticket: dispatched.ref }, {
      ...amendedCapture,
      command: 'node --version',
    }, PROJECT_DIR);
    assert.strictEqual(unrelated.reason, 'verification_capture_command_mismatch');
    assert.match(unrelated.message, /declared command pinned at dispatch/);
    assert.match(unrelated.message, /Pinned command: /);
    assert.match(unrelated.message, /Captured command: /);
    assert.ok(unrelated.message.includes(JSON.stringify(amendedCommand)));
    assert.ok(unrelated.message.includes(JSON.stringify('node --version')));
  } finally {
    fs.rmSync(amendedCapture.logPath, { force: true });
  }

  const legacy = addTicket('legacy amended capture', {
    executorVerifyKind: 'command',
    executorVerify: amendedCommand,
  });
  const legacyCapture = await runVerifyCapture(amendedCommand, PROJECT_DIR);
  try {
    const accepted = recordCapture({ project: PROJECT_DIR, ticket: legacy.ref }, legacyCapture, PROJECT_DIR);
    assert.strictEqual(accepted.ok, true, accepted.message);
  } finally {
    fs.rmSync(legacyCapture.logPath, { force: true });
  }
});

test('repeated captures use the dispatch pin after a stale lifecycle mirror rewrite', async () => {
  cleanBranch();
  const command = 'node --version';
  const dispatched = addTicket('repeated dispatched capture', {
    category: 'submission.fixture',
    executorVerifyKind: 'command',
    executorVerify: command,
  });
  const prepared = store.prepareDispatch(slug, dispatched.ref, {
    sessionId: 'repeated-capture-dispatch',
    sharedTree: true,
  });
  assert.strictEqual(prepared.ok, true, prepared.message);

  const firstCapture = await runVerifyCapture(command, PROJECT_DIR);
  let secondCapture: any;
  try {
    assert.strictEqual(firstCapture.status, 'passed');
    const firstRecorded = recordCapture({ project: PROJECT_DIR, ticket: dispatched.ref }, firstCapture, PROJECT_DIR);
    assert.strictEqual(firstRecorded.ok, true, firstRecorded.message);

    fs.writeFileSync(path.join(PROJECT_DIR, 'README.md'), 'second verification candidate\n');
    git(['add', 'README.md']);
    git(['commit', '-m', 'second verification candidate']);

    const rewritten = store.getTicket(slug, dispatched.ref);
    rewritten.lifecycleAttempt = {
      ...rewritten.lifecycleAttempt,
      verificationRequirement: {
        ...rewritten.lifecycleAttempt.verificationRequirement,
        command: 'node -e "process.exit(1)"',
      },
    };
    persist(rewritten);

    secondCapture = await runVerifyCapture(command, PROJECT_DIR);
    assert.strictEqual(secondCapture.status, 'passed');
    const secondRecorded = recordCapture({ project: PROJECT_DIR, ticket: dispatched.ref }, secondCapture, PROJECT_DIR);
    assert.strictEqual(secondRecorded.ok, true, secondRecorded.message);
    assert.notStrictEqual(secondRecorded.capture.candidate.value, firstRecorded.capture.candidate.value);
  } finally {
    fs.rmSync(firstCapture.logPath, { force: true });
    if (secondCapture?.logPath) fs.rmSync(secondCapture.logPath, { force: true });
  }
});

test('a verify mismatch names the command the submission had to match', async () => {
  // SQ-319: the mismatch refusal did not say what it wanted, so SQ-300's executor had no
  // way to see which string it was failing to reproduce.
  const command = 'node --version';
  const expected = 'node -e "process.exit(0)"';
  const t = addTicket('verify mismatch names the expected command', { executorVerify: command, files: ['lib'] });
  const by = 'verify-mismatch-worker';
  const base = git(['rev-parse', 'origin/main']);
  assert.strictEqual(store.claimTicket(slug, t.ref, by, { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  const capture = await runVerifyCapture(command, PROJECT_DIR);
  try {
    assert.strictEqual(capture.status, 'passed');
    assert.strictEqual(recordCapture({ project: PROJECT_DIR, ticket: t.ref }, capture, PROJECT_DIR).ok, true);
    const candidate = createCandidateCommit('verify-mismatch.js', 'mismatch candidate\n');
    pin(t, candidate);

    // Re-pin the requirement under the executor, which is exactly the shape a ticket
    // amended mid-dispatch (or filed before SQ-319's validation) presents at submit.
    const repin = (pinned: string) => {
      const ticket = store.getTicket(slug, t.ref);
      ticket.lifecycleAttempt = {
        ...ticket.lifecycleAttempt,
        verificationRequirement: { ...ticket.lifecycleAttempt.verificationRequirement, command: pinned },
      };
      if (ticket.dispatch?.verificationRequirement) {
        ticket.dispatch.verificationRequirement = { ...ticket.dispatch.verificationRequirement, command: pinned };
      }
      persist(ticket);
    };

    repin(expected);
    const refused = await callMcp('submit', {
      project: PROJECT_DIR,
      ref: t.ref,
      by,
      commit: candidate,
      base,
      worktree: PROJECT_DIR,
      verify: command,
      body: 'The captured command is not the pinned one.',
    });
    assert.strictEqual(refused.ok, false);
    assert.match(refused.message, /Expected command: "node -e \\"process\.exit\(0\)\\""/);
    // The command the executor actually ran is still the thing being rejected, so the
    // original sentence has to survive in front of the added detail.
    assert.match(refused.message, /verification must match the declared executor verify command/);

  } finally {
    fs.rmSync(capture.logPath, { force: true });
  }
});

test('MCP submit refuses a completed capture from before the submitted candidate', async () => {
  const command = 'node --version';
  const t = addTicket('stale declared capture', { executorVerify: command, files: ['lib'] });
  const by = 'stale-capture-worker';
  const captureBase = git(['rev-parse', 'origin/main']);
  assert.strictEqual(store.claimTicket(slug, t.ref, by, { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  const capture = await runVerifyCapture(command, PROJECT_DIR);
  try {
    assert.strictEqual(capture.status, 'passed');
    assert.strictEqual(recordCapture({ project: PROJECT_DIR, ticket: t.ref }, capture, PROJECT_DIR).ok, true);
    const candidate = createCandidateCommit('stale-capture.js', 'candidate after capture\n');
    pin(t, candidate);

    const refused = await callMcp('submit', {
      project: PROJECT_DIR,
      ref: t.ref,
      by,
      commit: candidate,
      base: captureBase,
      worktree: PROJECT_DIR,
      verify: command,
      body: 'Capture belongs to the prior candidate.',
    });
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.reason, 'verification_capture_required');
    assert.match(refused.message, /Run "node --version" through the dispatched verify-capture wrapper again/);
    assert.strictEqual(store.getTicket(slug, t.ref).claim.by, by);
    assert.strictEqual(store.releaseTicket(slug, t.ref, by, {
      status: 'todo',
      source: 'test',
      releaseKind: 'handback',
      releaseReason: 'The stale capture fixture leaves no candidate for later tests.',
    }).ok, true);
  } finally {
    fs.rmSync(capture.logPath, { force: true });
  }
});

test('submit accepts runnable, manual, and attestation verifier kinds', () => {
  const runnable = addTicket('runnable submit verify');
  const manual = addTicket('manual submit verify', { executorVerifyKind: 'manual', executorVerify: 'manual: inspect the candidate' });
  const artifact = 'grafana://dashboards/submission-fixture';
  const attestationEvidence = `attestation: ${artifact} | captured dashboard render | all panels showed fixture data`;
  const attestation = addTicket('attestation submit verify', { executorVerifyKind: 'attestation', executorAttestationArtifact: artifact, executorVerify: attestationEvidence });
  assert.strictEqual(store.claimTicket(slug, runnable.ref, 'worker-a', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  assert.strictEqual(store.claimTicket(slug, manual.ref, 'worker-b', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  assert.strictEqual(store.claimTicket(slug, attestation.ref, 'worker-c', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);

  const runnableResult = store.submitTicket(slug, runnable.ref, 'worker-a', {
    commit: COMMIT,
    verify: 'cd plugins/sidequest && npm run test:full',
  });
  const manualResult = store.submitTicket(slug, manual.ref, 'worker-b', {
    commit: COMMIT,
    verify: 'manual: submission tests passed',
  });
  const attestationResult = store.submitTicket(slug, attestation.ref, 'worker-c', {
    commit: COMMIT,
    verify: attestationEvidence,
  });

  assert.strictEqual(runnableResult.ok, true);
  assert.strictEqual(manualResult.ok, true);
  assert.strictEqual(attestationResult.ok, true, attestationResult.message);
  assert.strictEqual(store.getTicket(slug, runnable.ref).submission.verify, 'cd plugins/sidequest && npm run test:full');
  assert.strictEqual(store.getTicket(slug, manual.ref).submission.verify, 'manual: submission tests passed');
  assert.match(store.getTicket(slug, attestation.ref).submission.verify, /^attestation: grafana:\/\/dashboards\/submission-fixture \|/);
});

test('integration keeps a recorded verifier instead of re-deriving a plugin gate', () => {
  const pluginDir = path.join(PROJECT_DIR, 'plugins', 'integration-gate-fixture');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ scripts: { 'test:full': 'node -e "process.exit(7)"' } }));
  const t = addTicket('integration full gate', { files: ['plugins/integration-gate-fixture/src/changed.js'] });
  t.submission = {
    commit: COMMIT,
    verify: 'cd plugins/integration-gate-fixture && node --test test/changed.test.js',
    integration: { outcome: 'delivered' },
  };
  persist(t);

  const result = store.verifyIntegration(slug, t.ref);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'verification_failed_suite');
  assert.strictEqual(result.verify.status, 'failed_suite');
  assert.strictEqual(result.verify.command, 'cd plugins/integration-gate-fixture && node --test test/changed.test.js');
});

test('SQ-123: update re-pins the verify a pending submission integrates with, and says which verify runs next', async () => {
  const submittedCommand = 'node -e "process.exit(0)" && node -e "process.exit(1)"';
  const narrowedCommand = 'node -e "process.exit(0)"';
  const t = addTicket('pending submission verify re-pin', {
    category: 'submission.fixture',
    executorVerifyKind: 'command',
    executorVerify: submittedCommand,
  });
  // The dispatch that produced the submission is terminal and pinned the slow verify.
  t.dispatch = {
    terminalAt: '2026-09-24T00:00:00.000Z',
    verificationRequirement: { kind: 'command', command: submittedCommand, evidence: submittedCommand },
  };
  t.submission = { commit: COMMIT, verify: submittedCommand, integration: { outcome: 'delivered' } };
  persist(t);

  const updated = await callMcp('update', { project: PROJECT_DIR, ref: t.ref, by: 'orchestrator', verify: narrowedCommand });

  assert.strictEqual(updated.verificationAmendment.status, 'applied_to_pending_submission');
  assert.strictEqual(updated.verificationAmendment.oldCommand, submittedCommand);
  assert.strictEqual(updated.verificationAmendment.newCommand, narrowedCommand);
  assert.match(updated.verificationAmendment.message, /next integrate or groomClose merged-tree verification runs node -e "process\.exit\(0\)"/);
  const repinned = store.getTicket(slug, t.ref);
  assert.strictEqual(repinned.submission.verify, submittedCommand, 'the executor record is not rewritten');
  assert.strictEqual(repinned.submission.verificationRequirement.command, narrowedCommand);
  assert.deepStrictEqual(repinned.verificationAmendments.at(-1), {
    at: repinned.verificationAmendments.at(-1).at,
    by: 'orchestrator',
    oldCommand: submittedCommand,
    newCommand: narrowedCommand,
    appliesTo: 'pending_submission',
    candidate: COMMIT.slice(0, 12),
  });

  const result = store.verifyIntegration(slug, t.ref);

  assert.strictEqual(result.ok, true, JSON.stringify(result.verify));
  assert.strictEqual(result.verify.status, 'passed');
  assert.strictEqual(result.verify.command, narrowedCommand);
});

test('SQ-123: clearing a pending submission verify refuses and names the verify that still runs', () => {
  const submittedCommand = 'node -e "process.exit(0)"';
  const t = addTicket('pending submission verify clear', {
    category: 'submission.fixture',
    executorVerifyKind: 'command',
    executorVerify: submittedCommand,
  });
  t.dispatch = {
    terminalAt: '2026-09-24T00:00:00.000Z',
    verificationRequirement: { kind: 'command', command: submittedCommand, evidence: submittedCommand },
  };
  t.submission = { commit: COMMIT, verify: submittedCommand };
  persist(t);

  assert.throws(
    () => store.updateTicket(slug, t.ref, { executorVerifyKind: 'suite', executorVerify: '', source: 'test' }),
    /pending submission .*Nothing changed: the next integration verification still runs "node -e \\"process\.exit\(0\)\\""/,
  );
  const unchanged = store.getTicket(slug, t.ref);
  assert.strictEqual(unchanged.executorVerify, submittedCommand);
  assert.strictEqual(unchanged.submission.verificationRequirement, undefined);
});

test('SQ-123: a timed-out integration verification names the re-pin path', () => {
  const slowCommand = 'node -e "process.exit(0)"';
  const t = addTicket('timed out integration verify', { executorVerifyKind: 'command', executorVerify: slowCommand });
  t.submission = {
    commit: COMMIT,
    verify: slowCommand,
    integration: { outcome: 'delivered', verify: { kind: 'command', status: 'timeout', command: slowCommand, evidence: 'timed out' } },
  };
  persist(t);

  const result = store.verifyIntegration(slug, t.ref);

  assert.strictEqual(result.ok, false);
  const body = String(result.ticket.comments.at(-1).body);
  assert.match(body, /Integration verification returned timeout/);
  assert.match(body, new RegExp(`update\\(\\{ref:"${t.ref}", verify:"<narrower command>"\\}\\)`));
  assert.match(body, /runs the re-pinned command/);
});

test('SQ-1875: every rejected submission range reason gives a pinned-base remedy', () => {
  const ticket = { ref: 'SQ-1875', dispatch: { baseCommit: '1234567890abcdef1234567890abcdef12345678' } };
  const reasons = ['empty_range', 'base_not_reachable', 'range_changed', 'no_op_changed', 'reconciled_path_diverged'];
  for (const reason of reasons) {
    const message = submissionRangeFailureMessage(ticket, { reason, commit: 'abcdef1' }, 'refs/sidequest/SQ-1875');
    assert.match(message, new RegExp(`submit: refused SQ-1875; ${reason}`));
    assert.match(message, /behind the integration tip is expected/);
    assert.doesNotMatch(message, /rebase onto|current integration target|origin\/main|\bmain\b/);
  }
});

test('SQ-971: rejected range submission keeps the candidate and claim for repair', async () => {
  cleanBranch();
  const t = addTicket('rejected range preservation', { files: ['lib/rebased.js'] });
  const by = 'rebase-worker';
  assert.strictEqual(store.claimTicket(slug, t.ref, by, { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'parent.js'), 'feature parent\n');
  git(['add', 'parent.js']);
  git(['commit', '-m', 'unrecognized feature parent']);
  const parent = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'rebased.js'), 'verified work\n');
  git(['add', 'lib/rebased.js']);
  git(['commit', '-m', 'verified ticket work']);
  const rejectedCommit = git(['rev-parse', 'HEAD']);
  pin(t, rejectedCommit);

  const rejected = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: t.ref,
    by,
    commit: rejectedCommit,
    base: parent,
    verify: 'npm run test:files -- test/submission.test.ts',
    worktree: PROJECT_DIR,
    body: 'Changed lib/rebased.js. Scoped submission test passed. Nothing skipped.',
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'unrecognized_base');
  assert.match(rejected.message, /recorded .*base|approved submitted-ticket boundary/);
  assert.doesNotMatch(rejected.message, /Rebase onto the current|current origin\/main target/);
  const preserved = store.getTicket(slug, t.ref);
  assert.equal(preserved.claim.by, by);
  assert.equal(preserved.submission, undefined);
  assert.equal(git(['rev-parse', `refs/sidequest/${t.ref}`]), rejectedCommit);

  git(['rebase', '--onto', 'origin/main', parent, rejectedCommit]);
  const rebasedCommit = git(['rev-parse', 'HEAD']);
  assert.notEqual(rebasedCommit, rejectedCommit);
  pin(t, rebasedCommit);
  const reworked = await callMcp('rework', {
    project: PROJECT_DIR,
    ref: t.ref,
    by,
    review: 'The immutable rejected range needs a different candidate identity.',
    reason: 'Replace the rejected range through the explicit rework transition.',
  });
  assert.equal(reworked.ok, true, reworked.message);
  assert.equal(store.getTicket(slug, t.ref).submissionRetry, undefined);
  assert.equal(store.getTicket(slug, t.ref).rejectedSubmissions[0].commit, rejectedCommit);
  const resubmitted = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: t.ref,
    by,
    commit: rebasedCommit,
    verify: 'npm run test:files -- test/submission.test.ts',
    worktree: PROJECT_DIR,
    body: 'Rebased lib/rebased.js onto origin/main. Scoped submission test passed. Nothing skipped.',
  });
  assert.equal(resubmitted.ok, true, resubmitted.message);
  const after = store.getTicket(slug, t.ref);
  assert.equal(after.claim, null);
  assert.equal(after.submission.commit, rebasedCommit);
  assert.deepEqual(after.submission.commits, [rebasedCommit]);
  assert.equal(after.submission.base, git(['rev-parse', 'origin/main']));
});

test('SQ-822: MCP submit refuses uncommitted declared work, then accepts it once committed', async () => {
  cleanBranch();
  const t = addTicket('declared work must be committed', { files: ['lib/committed.js'] });
  const by = 'committed-work-worker';
  assert.equal(store.claimTicket(slug, t.ref, by, { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'committed.js'), 'first version\n');
  git(['add', 'lib/committed.js']);
  git(['commit', '-m', 'first declared version']);
  const firstCommit = git(['rev-parse', 'HEAD']);
  pin(t, firstCommit);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'committed.js'), 'second version\n');

  const refused = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: t.ref,
    by,
    commit: firstCommit,
    verify: 'npm run test:files -- test/submission.test.ts',
    worktree: PROJECT_DIR,
    body: 'Changed lib/committed.js. Scoped submission test passed. Nothing skipped.',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'dirty_scope');
  assert.match(refused.message, /uncommitted changes fall inside this ticket's declared scope: lib\/committed\.js/);
  assert.match(refused.message, /Commit these paths, or explain why they are deliberately excluded/);
  assert.equal(store.getTicket(slug, t.ref).claim.by, by, 'refusal retains the claim so the executor can commit its work');

  git(['add', 'lib/committed.js']);
  git(['commit', '-m', 'second declared version']);
  const committed = git(['rev-parse', 'HEAD']);
  pin(t, committed);
  const submitted = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: t.ref,
    by,
    commit: committed,
    verify: 'npm run test:files -- test/submission.test.ts',
    worktree: PROJECT_DIR,
    body: 'Changed lib/committed.js. Scoped submission test passed. Nothing skipped.',
  });
  assert.equal(submitted.ok, true, submitted.message);

  cleanBranch();
  const outsideScope = addTicket('outside dirty work does not block submit', { files: ['lib/declared.js'] });
  const outsideBy = 'outside-work-worker';
  assert.equal(store.claimTicket(slug, outsideScope.ref, outsideBy, { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'declared.js'), 'declared work\n');
  git(['add', 'lib/declared.js']);
  git(['commit', '-m', 'declared work']);
  const outsideCommit = git(['rev-parse', 'HEAD']);
  pin(outsideScope, outsideCommit);
  fs.mkdirSync(path.join(PROJECT_DIR, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'notes', 'noise.md'), 'out of scope\n');
  const outsideSubmitted = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: outsideScope.ref,
    by: outsideBy,
    commit: outsideCommit,
    verify: 'npm run test:files -- test/submission.test.ts',
    worktree: PROJECT_DIR,
    body: 'Changed lib/declared.js. Scoped submission test passed. Nothing skipped.',
  });
  assert.equal(outsideSubmitted.ok, true, outsideSubmitted.message);
});

test('SQ-1880: MCP submit inspects a pinned candidate from the repository after its worktree is gone', async () => {
  cleanBranch();
  const ticket = addTicket('worktree swept after verified commit', { files: ['lib/swept-worktree.js'] });
  const by = 'swept-worktree-worker';
  assert.equal(store.claimTicket(slug, ticket.ref, by, { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'swept-worktree.js'), 'verified before sweep\n');
  git(['add', 'lib/swept-worktree.js']);
  git(['commit', '-m', 'verified swept worktree candidate']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(ticket, commit);
  git(['reset', '--hard', 'origin/main']);
  const missingWorktree = path.join(PROJECT_DIR, 'missing-agent-worktree');

  const submitted = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: ticket.ref,
    by,
    commit,
    verify: 'npm run test:files -- test/submission.test.ts',
    worktree: missingWorktree,
    body: 'Changed lib/swept-worktree.js. Scoped submission test passed. Nothing skipped.',
  });

  assert.equal(submitted.ok, true, submitted.message);
  const stored = store.getTicket(slug, ticket.ref);
  assert.equal(stored.submission.commit, commit);
  assert.equal(stored.submission.worktree, missingWorktree);
  assert.equal(stored.claim, null);
});

test('SQ-971: an unavailable recorded integration target preserves the claim', async () => {
  cleanBranch();
  const t = addTicket('missing integration target preservation', { files: ['lib/missing-target.js'] });
  const by = 'missing-target-worker';
  assert.equal(store.claimTicket(slug, t.ref, by, { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  const claimed = store.getTicket(slug, t.ref);
  claimed.dispatch = {
    integrationTarget: {
      mode: 'local',
      upstream: 'missing-feature-target',
      branch: 'missing-feature-target',
    },
  };
  persist(claimed);

  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'missing-target.js'), 'verified work\n');
  git(['add', 'lib/missing-target.js']);
  git(['commit', '-m', 'verified work for deleted target']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(t, commit);

  const rejected = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: t.ref,
    by,
    commit,
    verify: 'npm run test:files -- test/submission.test.ts',
    worktree: PROJECT_DIR,
    body: 'Changed lib/missing-target.js. Scoped submission test passed. Nothing skipped.',
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'integration_target_unavailable');
  assert.match(rejected.message, /Fetch or recreate missing-feature-target/);
  assert.equal(git(['rev-parse', `refs/sidequest/${t.ref}`]), commit);
  const preserved = store.getTicket(slug, t.ref);
  assert.equal(preserved.claim.by, by);
  assert.equal(preserved.submission, undefined);
});

test('SQ-971: a retryable range refusal leaves the existing pinned ref untouched', async () => {
  cleanBranch();
  const t = addTicket('checkpoint failure after quarantine', { files: ['lib/checkpoint-failure.js'] });
  const by = 'checkpoint-failure-worker';
  assert.equal(store.claimTicket(slug, t.ref, by, { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  fs.writeFileSync(path.join(PROJECT_DIR, 'parent.js'), 'unrecognized parent\n');
  git(['add', 'parent.js']);
  git(['commit', '-m', 'checkpoint failure parent']);
  const parent = git(['rev-parse', 'HEAD']);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'checkpoint-failure.js'), 'verified work\n');
  git(['add', 'lib/checkpoint-failure.js']);
  git(['commit', '-m', 'verified work before checkpoint failure']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(t, commit);

  const rejected = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: t.ref,
    by,
    commit,
    base: parent,
    verify: 'npm run test:files -- test/submission.test.ts',
    worktree: PROJECT_DIR,
    body: 'Changed lib/checkpoint-failure.js. Scoped submission test passed. Nothing skipped.',
  });

  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'unrecognized_base');
  assert.equal(git(['rev-parse', `refs/sidequest/${t.ref}`]), commit);
  const preserved = store.getTicket(slug, t.ref);
  assert.equal(preserved.claim.by, by);
  assert.equal(preserved.checkpoint, null);
});

test('submitted tickets leave the ready pool and refuse claims until cleared', () => {
  const t = addTicket('submitted leaves ready');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-a', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  assert.strictEqual(store.submitTicket(slug, t.ref, 'worker-a', { commit: COMMIT }).ok, true);

  const readyRefs = store.readyTickets(slug, {}).map((x?: any) => x.ref);
  assert.ok(!readyRefs.includes(t.ref), 'a submitted ticket is not re-dispatchable');

  const reclaim = store.claimTicket(slug, t.ref, 'worker-b', { direct: true, reason: 'The submission fixture requires a local direct claim.' });
  assert.strictEqual(reclaim.ok, false);
  assert.strictEqual(reclaim.reason, 'submitted');

  const queue = store.submissionsPayload(slug);
  assert.ok(queue.tickets.some((x?: any) => x.ref === t.ref), 'the integration queue lists it');

  // Orchestrator reset: integration bounced, the work must be redone.
  const cleared = store.clearSubmission(slug, t.ref, { by: 'worker-a', status: 'todo' });
  assert.strictEqual(cleared.ok, true);
  assert.strictEqual(cleared.cleared.commit, COMMIT);
  const after = store.getTicket(slug, t.ref);
  assert.strictEqual(after.submission, null);
  assert.strictEqual(after.status, 'todo');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-b', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true, 'claimable again once cleared');
  assert.strictEqual(store.clearSubmission(slug, t.ref, {}).reason, 'no_submission');
});

test('CLI commit admits a related review-rejected fragment transfer and refuses unrelated deletion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-cli-release-fragment-'));
  const runAtRoot = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: root }, { cwd: root }).runCli;
  const gitAtRoot = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  gitAtRoot(['init', '-b', 'main']);
  gitAtRoot(['config', 'user.name', 'Sidequest Test']);
  gitAtRoot(['config', 'user.email', 'sidequest-test@example.invalid']);
  const project = store.ensureProject(root).slug;
  const source = store.createTicket(project, {
    title: 'rejected release candidate', files: ['plugins/fixture-plugin'], complexity: 3,
    complexityWhy: 'The CLI commit fixture needs a rejected source release fragment.', labels: ['direct-ok'],
  });
  const sourceFragment = `.release/unreleased/${source.ref}.md`;
  fs.mkdirSync(path.join(root, 'plugins', 'fixture-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, '.release', 'unreleased'), { recursive: true });
  fs.writeFileSync(path.join(root, 'plugins', 'fixture-plugin', 'index.js'), 'rejected candidate\n');
  fs.writeFileSync(path.join(root, sourceFragment), 'rejected release fragment\n');
  gitAtRoot(['add', '.']);
  gitAtRoot(['commit', '-m', 'rejected release candidate']);
  const rejectedSource = store.getTicket(project, source.ref);
  rejectedSource.submission = { review: { outcome: 'rejected' } };
  db.putRow(db.openDb(SIDEQUEST_HOME), 'tickets', {
    id: rejectedSource.id, project, ref: rejectedSource.ref, status: rejectedSource.status,
    archived: rejectedSource.archived ? 1 : 0, ord: rejectedSource.order,
    claim_by: rejectedSource.claim?.by || null, data: rejectedSource,
  });

  const repair = store.createTicket(project, {
    title: 'repair rejected release candidate', files: ['plugins/fixture-plugin'], complexity: 3,
    complexityWhy: 'The CLI commit fixture transfers a rejected source release fragment.', labels: ['direct-ok'],
  });
  assert.equal(store.linkTickets(project, repair.ref, 'related', source.ref).ok, true);
  const repairBy = 'cli-repair-worker';
  assert.equal(store.claimTicket(project, repair.ref, repairBy, { direct: true, reason: 'The CLI fixture requires a local direct claim.' }).ok, true);
  const repairFragment = `.release/unreleased/${repair.ref}.md`;
  fs.renameSync(path.join(root, sourceFragment), path.join(root, repairFragment));
  const admitted = runAtRoot(['commit', repair.ref, '--by', repairBy, '--message', 'transfer rejected release fragment']);
  assert.equal(admitted.status, 0, admitted.stderr + admitted.stdout);
  assert.equal(fs.existsSync(path.join(root, repairFragment)), true, 'the related rejected fragment transfer was committed');

  const unrelated = store.createTicket(project, {
    title: 'unrelated release candidate', files: ['plugins/fixture-plugin'], complexity: 3,
    complexityWhy: 'The CLI commit fixture needs an unrelated release fragment.', labels: ['direct-ok'],
  });
  const unrelatedFragment = `.release/unreleased/${unrelated.ref}.md`;
  fs.writeFileSync(path.join(root, unrelatedFragment), 'unrelated release fragment\n');
  gitAtRoot(['add', unrelatedFragment]);
  gitAtRoot(['commit', '-m', 'unrelated release candidate']);
  const blocked = store.createTicket(project, {
    title: 'unrelated fragment removal', files: ['plugins/fixture-plugin'], complexity: 3,
    complexityWhy: 'The CLI commit fixture confirms unrelated release fragments stay protected.', labels: ['direct-ok'],
  });
  const blockedBy = 'cli-foreign-fragment-worker';
  assert.equal(store.claimTicket(project, blocked.ref, blockedBy, { direct: true, reason: 'The CLI fixture requires a local direct claim.' }).ok, true);
  fs.writeFileSync(path.join(root, 'plugins', 'fixture-plugin', 'index.js'), 'unrelated deletion attempt\n');
  fs.unlinkSync(path.join(root, unrelatedFragment));
  const refused = runAtRoot(['commit', blocked.ref, '--by', blockedBy, '--message', 'remove unrelated release fragment']);
  assert.equal(refused.status, 1);
  // SQ-304: the refusal must say what makes a foreign fragment deletable rather than
  // naming an exception the caller has no way to reach.
  assert.match(refused.stderr + refused.stdout, new RegExp(`\\.release/unreleased/${unrelated.ref}\\.md belongs to another ticket: a foreign fragment becomes deletable only once its candidate is review-rejected and its ticket is linked to ${blocked.ref} with`));
  assert.doesNotMatch(refused.stderr + refused.stdout, /except a deleted fragment from a related review-rejected candidate/);
  assert.match(refused.stderr + refused.stdout, new RegExp(`Other release fragments: \\.release/unreleased/${unrelated.ref}\\.md`));
});

// SQ-1010: release --force + update --status todo both used to report ok while
// leaving the submission in place, so the next claim kept refusing the ticket
// as already-submitted even though it looked reopened. release/update must
// now either refuse with the correct command, or (release --force) actually
// reject the submission as part of the explicit reopen.
test('release --status todo on a pending submission refuses instead of silently wedging it (SQ-1010)', () => {
  const t = addTicket('release reopen refuses on pending submission');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-a', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  assert.strictEqual(store.submitTicket(slug, t.ref, 'worker-a', { commit: COMMIT }).ok, true);

  const released = store.releaseTicket(slug, t.ref, 'worker-a', { status: 'todo' });
  assert.strictEqual(released.ok, false);
  assert.strictEqual(released.reason, 'pending_submission');
  assert.match(released.message, /pending submission/);
  assert.match(released.message, /submit .*--clear/);

  const after = store.getTicket(slug, t.ref);
  assert.strictEqual(store.pendingSubmission(after), true, 'the submission is untouched by the refused release');
  const stillRefused = store.claimTicket(slug, t.ref, 'worker-b', { direct: true, reason: 'The submission fixture requires a local direct claim.' });
  assert.strictEqual(stillRefused.ok, false);
  assert.strictEqual(stillRefused.reason, 'submitted');
});

test('store force cannot release a foreign live claim or mutate its status (SQ-1711)', () => {
  const ticket = addClaimedTicket('store foreign forced claim release', 'victim-worker');
  const result = store.releaseTicket(slug, ticket.ref, 'attacker-worker', { status: 'todo', force: true });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'not_owner');
  const stored = store.getTicket(slug, ticket.ref);
  assert.strictEqual(stored.claim.by, 'victim-worker');
  assert.strictEqual(stored.status, 'doing');
  assert.strictEqual(stored.reworkEvents, undefined);
});

test('CLI force cannot release a foreign live claim or mutate its status (SQ-1711)', () => {
  const ticket = addClaimedTicket('CLI foreign forced claim release', 'victim-worker');
  const result = runCli(['release', ticket.ref, '--by', 'attacker-worker', '--status', 'todo', '--force']);
  assert.strictEqual(result.status, 1);
  assert.doesNotMatch(result.stderr + result.stdout, /add `?--force|pass --force/i);
  const stored = store.getTicket(slug, ticket.ref);
  assert.strictEqual(stored.claim.by, 'victim-worker');
  assert.strictEqual(stored.status, 'doing');
  assert.strictEqual(stored.reworkEvents, undefined);
});

test('store force cannot clear a foreign pending submission or write rework history (SQ-1711)', () => {
  const ticket = addClaimedTicket('store foreign forced submission release', 'victim-worker');
  assert.strictEqual(store.submitTicket(slug, ticket.ref, 'victim-worker', { commit: COMMIT }).ok, true);
  const result = store.releaseTicket(slug, ticket.ref, 'attacker-worker', { status: 'todo', force: true });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'not_owner');
  const stored = store.getTicket(slug, ticket.ref);
  assert.strictEqual(stored.claim, null);
  assert.strictEqual(stored.submission.by, 'victim-worker');
  assert.strictEqual(stored.status, 'doing');
  assert.strictEqual(stored.reworkEvents, undefined);
});

test('CLI force cannot clear a foreign pending submission or write rework history (SQ-1711)', () => {
  const ticket = addClaimedTicket('CLI foreign forced submission release', 'victim-worker');
  assert.strictEqual(store.submitTicket(slug, ticket.ref, 'victim-worker', { commit: COMMIT }).ok, true);
  const result = runCli(['release', ticket.ref, '--by', 'attacker-worker', '--status', 'todo', '--force']);
  assert.strictEqual(result.status, 1);
  assert.doesNotMatch(result.stderr + result.stdout, /add `?--force|pass --force/i);
  const stored = store.getTicket(slug, ticket.ref);
  assert.strictEqual(stored.claim, null);
  assert.strictEqual(stored.submission.by, 'victim-worker');
  assert.strictEqual(stored.status, 'doing');
  assert.strictEqual(stored.reworkEvents, undefined);
});

test('release --status todo --force rejects the pending submission and reopens in one step (SQ-1010)', () => {
  const t = addTicket('release force reopen clears submission');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-a', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  assert.strictEqual(store.submitTicket(slug, t.ref, 'worker-a', { commit: COMMIT }).ok, true);

  const released = store.releaseTicket(slug, t.ref, 'worker-a', { status: 'todo', force: true });
  assert.strictEqual(released.ok, true);
  assert.strictEqual(released.clearedSubmission.commit, COMMIT);
  const after = store.getTicket(slug, t.ref);
  assert.strictEqual(after.submission, null);
  assert.strictEqual(after.status, 'todo');

  // Redispatch: a fresh executor claims cleanly, no leftover "submitted" refusal.
  const reclaimed = store.claimTicket(slug, t.ref, 'worker-b', { direct: true, reason: 'The submission fixture requires a local direct claim.' });
  assert.strictEqual(reclaimed.ok, true);
});

test('update --status todo refuses on a pending submission instead of silently applying (SQ-1010)', () => {
  const t = addTicket('update reopen refuses on pending submission');
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'worker-a', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  assert.strictEqual(store.submitTicket(slug, t.ref, 'worker-a', { commit: COMMIT }).ok, true);

  assert.throws(() => store.updateTicket(slug, t.ref, { status: 'todo', source: 'test' }), /pending submission/);
  const after = store.getTicket(slug, t.ref);
  assert.strictEqual(store.pendingSubmission(after), true, 'the submission is untouched by the refused update');
  assert.strictEqual(after.status, 'doing', 'status did not silently move');

  const cliAttempt = runCli(['update', t.ref, '--status', 'todo']);
  assert.strictEqual(cliAttempt.status, 1);
  assert.match(cliAttempt.stderr + cliAttempt.stdout, /pending submission/);

  // The documented escape works and unwedges the ticket.
  const cleared = store.clearSubmission(slug, t.ref, { by: 'worker-a', status: 'todo' });
  assert.strictEqual(cleared.ok, true);
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-b', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
});

test('review rejection preserves the candidate through a normal repair dispatch until replacement submission (SQ-1642)', async () => {
  cleanBranch();
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'original candidate\n');
  git(['add', 'lib/fixture.js']);
  git(['commit', '-m', 'original candidate']);
  const originalCommit = git(['rev-parse', 'HEAD']);
  const t = addTicket('high-stakes rejected candidate', { highStakes: true, category: 'submission.fixture' });
  pin(t, originalCommit);
  assert.strictEqual(store.claimTicket(slug, t.ref, 'original-worker', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  assert.strictEqual(store.submitTicket(slug, t.ref, 'original-worker', { commit: originalCommit }).ok, true);

  const unauthorizedCliRejection = runCli([
    'rework', t.ref,
    '--by', 'review-audit',
    '--review', 'SQ-1640 rejected: missing lifecycle coverage',
    '--reason', 'Repair the rejected submission without dropping the candidate.',
    '--force',
  ]);
  assert.strictEqual(unauthorizedCliRejection.status, 1);
  assert.strictEqual(store.getTicket(slug, t.ref).submission.commit, originalCommit);
  assert.strictEqual(store.getTicket(slug, t.ref).rejectedSubmissions, undefined);

  const unauthorizedRejection = await callMcp('rework', {
    project: PROJECT_DIR,
    ref: t.ref,
    by: 'review-audit',
    review: 'SQ-1640 rejected: missing lifecycle coverage',
    reason: 'Repair the rejected submission without dropping the candidate.',
    force: true,
  });
  assert.strictEqual(unauthorizedRejection.reason, 'not_owner');
  assert.strictEqual(store.getTicket(slug, t.ref).submission.commit, originalCommit);
  assert.strictEqual(store.getTicket(slug, t.ref).rejectedSubmissions, undefined);

  const rejected = await callMcp('rework', {
    project: PROJECT_DIR,
    ref: t.ref,
    by: 'original-worker',
    review: 'SQ-1640 rejected: missing lifecycle coverage',
    reason: 'Repair the rejected submission without dropping the candidate.',
  });
  assert.strictEqual(rejected.ok, true, rejected.message);
  const afterRejection = store.getTicket(slug, t.ref);
  assert.strictEqual(afterRejection.submission, null);
  assert.strictEqual(afterRejection.status, 'todo');
  assert.strictEqual(afterRejection.rejectedSubmissions[0].commit, originalCommit);
  assert.match(afterRejection.rejectedSubmissions[0].review, /SQ-1640/);
  assert.strictEqual(afterRejection.rejectedSubmissions[0].quarantineRef, `refs/sidequest/${t.ref}-rejected`);
  assert.strictEqual(git(['rev-parse', afterRejection.rejectedSubmissions[0].quarantineRef]), originalCommit);

  const firstRepair = store.prepareDispatch(slug, t.ref, { sessionId: 'sq-1642-first-repair', sharedTree: true });
  assert.strictEqual(store.claimTicket(slug, t.ref, 'repair-worker', {
    token: firstRepair.token, executor: firstRepair.ticket.dispatchExecutor, sessionId: 'sq-1642-first-repair',
  }).ok, true);
  assert.strictEqual(store.claimTicket(slug, t.ref, 'duplicate-repair-worker', {
    token: firstRepair.token, executor: firstRepair.ticket.dispatchExecutor, sessionId: 'sq-1642-first-repair',
  }).reason, 'claimed');
  const reused = store.submitTicket(slug, t.ref, 'repair-worker', { commit: originalCommit });
  assert.strictEqual(reused.ok, false);
  assert.strictEqual(reused.reason, 'rejected_submission_reused');
  assert.strictEqual(store.getTicket(slug, t.ref).rejectedSubmissions[0].supersededAt, undefined, 'the rejected candidate cannot be reused as its own repair');
  assert.throws(() => store.submitTicket(slug, t.ref, 'repair-worker', { commit: 'not-a-commit' }), /invalid commit/);
  assert.strictEqual(store.getTicket(slug, t.ref).rejectedSubmissions[0].supersededAt, undefined, 'a failed repair leaves the rejected candidate intact');
  assert.strictEqual(store.releaseTicket(slug, t.ref, 'repair-worker', { status: 'todo', reason: 'Repair submission validation failed.' }).ok, true);

  const repaired = store.prepareDispatch(slug, t.ref, { sessionId: 'sq-1642-second-repair', sharedTree: true });
  assert.strictEqual(store.claimTicket(slug, t.ref, 'stale-repair-worker', {
    token: firstRepair.token, executor: repaired.ticket.dispatchExecutor, sessionId: 'sq-1642-second-repair',
  }).reason, 'token');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'replacement-worker', {
    token: repaired.token, executor: repaired.ticket.dispatchExecutor, sessionId: 'sq-1642-second-repair',
  }).ok, true);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'replacement candidate\n');
  git(['add', 'lib/fixture.js']);
  git(['commit', '-m', 'replacement candidate']);
  const replacementCommit = git(['rev-parse', 'HEAD']);
  pin(t, replacementCommit);
  const replacement = store.submitTicket(slug, t.ref, 'replacement-worker', { commit: replacementCommit });
  assert.strictEqual(replacement.ok, true, replacement.message);
  const afterReplacement = store.getTicket(slug, t.ref);
  assert.strictEqual(afterReplacement.submission.integratedAt, null, 'repair submission is still queued, never integrated early');
  assert.strictEqual(afterReplacement.submission.supersedesRejectedSubmission, originalCommit);
  assert.strictEqual(afterReplacement.rejectedSubmissions[0].supersededBy.commit, replacementCommit);
});

test('rework preserves every rejected commit and avoids quarantine ref collisions (SQ-1642)', async () => {
  cleanBranch();
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'candidate one\n');
  git(['add', 'lib/fixture.js']);
  git(['commit', '-m', 'candidate one']);
  const candidateOne = git(['rev-parse', 'HEAD']);
  const collisionCommit = git(['rev-parse', 'origin/main']);
  const t = addTicket('repeated rejected candidates', { category: 'submission.fixture' });
  pin(t, candidateOne);
  git(['update-ref', `refs/sidequest/${t.ref}-rejected`, collisionCommit]);
  assert.strictEqual(store.claimTicket(slug, t.ref, 'first-worker', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  assert.strictEqual(store.submitTicket(slug, t.ref, 'first-worker', { commit: candidateOne }).ok, true);
  assert.strictEqual(runCli([
    'rework', t.ref,
    '--by', 'first-worker',
    '--review', 'First repair review evidence.',
    '--reason', 'Replace the first rejected candidate.',
  ]).status, 0);
  assert.strictEqual(git(['rev-parse', `refs/sidequest/${t.ref}-rejected`]), collisionCommit, 'an existing quarantine ref remains untouched');
  assert.strictEqual(store.getTicket(slug, t.ref).rejectedSubmissions[0].quarantineRef, `refs/sidequest/${t.ref}-rejected-2`);

  const firstRepair = store.prepareDispatch(slug, t.ref, { sessionId: 'first-repeated-repair', sharedTree: true });
  assert.strictEqual(store.claimTicket(slug, t.ref, 'second-worker', {
    token: firstRepair.token, executor: firstRepair.ticket.dispatchExecutor, sessionId: 'first-repeated-repair',
  }).ok, true);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'candidate two\n');
  git(['add', 'lib/fixture.js']);
  git(['commit', '-m', 'candidate two']);
  const candidateTwo = git(['rev-parse', 'HEAD']);
  pin(t, candidateTwo);
  assert.strictEqual(store.submitTicket(slug, t.ref, 'second-worker', { commit: candidateTwo }).ok, true);
  assert.strictEqual((await callMcp('rework', {
    project: PROJECT_DIR,
    ref: t.ref,
    by: 'second-worker',
    review: 'Second repair review evidence.',
    reason: 'Replace the second rejected candidate.',
  })).ok, true);

  const afterSecondRejection = store.getTicket(slug, t.ref);
  assert.strictEqual(afterSecondRejection.rejectedSubmissions[1].quarantineRef, `refs/sidequest/${t.ref}-rejected-3`);
  const secondRepair = store.prepareDispatch(slug, t.ref, { sessionId: 'second-repeated-repair', sharedTree: true });
  assert.strictEqual(store.claimTicket(slug, t.ref, 'third-worker', {
    token: secondRepair.token, executor: secondRepair.ticket.dispatchExecutor, sessionId: 'second-repeated-repair',
  }).ok, true);
  const reused = store.submitTicket(slug, t.ref, 'third-worker', { commit: candidateOne });
  assert.strictEqual(reused.reason, 'rejected_submission_reused');
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'candidate three\n');
  git(['add', 'lib/fixture.js']);
  git(['commit', '-m', 'candidate three']);
  const candidateThree = git(['rev-parse', 'HEAD']);
  const replayedRange = store.submitTicket(slug, t.ref, 'third-worker', {
    commit: candidateThree,
    range: {
      base: candidateOne,
      upstream: 'main',
      upstreamCommit: candidateOne,
      commits: [candidateOne, candidateThree],
      changedPaths: [],
    },
  });
  assert.strictEqual(replayedRange.reason, 'rejected_submission_reused', 'a new tip cannot replay a rejected commit in its admitted range');
  assert.strictEqual(store.getTicket(slug, t.ref).rejectedSubmissions.length, 2, 'a failed third repair retains the full rejection history');
});

test('store force cannot submit over a foreign claim or replace its pending submission (SQ-1702)', () => {
  const ticket = addClaimedTicket('store foreign forced submission', 'victim-worker');
  const forcedSubmission = store.submitTicket(slug, ticket.ref, 'attacker-worker', { commit: COMMIT, force: true });
  assert.strictEqual(forcedSubmission.ok, false);
  assert.strictEqual(forcedSubmission.reason, 'not_owner');
  assertForeignSubmissionWasRefused(ticket, 'victim-worker');

  const ownerSubmission = store.submitTicket(slug, ticket.ref, 'victim-worker', { commit: COMMIT });
  assert.strictEqual(ownerSubmission.ok, true, ownerSubmission.message);
  const forcedReplacement = store.submitTicket(slug, ticket.ref, 'attacker-worker', { commit: 'def5678abc1234def5678abc1234def5678abc12', force: true });
  assert.strictEqual(forcedReplacement.ok, false);
  assert.strictEqual(forcedReplacement.reason, 'not_owner');
  const stored = store.getTicket(slug, ticket.ref);
  assert.strictEqual(stored.claim, null);
  assert.strictEqual(stored.submission.by, 'victim-worker');
  assert.strictEqual(stored.submission.commit, COMMIT);

  const ownerReplacement = store.submitTicket(slug, ticket.ref, 'victim-worker', { commit: 'def5678abc1234def5678abc1234def5678abc12', force: true });
  assert.strictEqual(ownerReplacement.ok, true, ownerReplacement.message);
  assert.strictEqual(ownerReplacement.ticket.submission.by, 'victim-worker');
});

test('CLI force cannot submit over a foreign claim (SQ-1702)', () => {
  const commit = createCandidateCommit('cli-force-submit.js', 'CLI force submit candidate\n');
  const ticket = addClaimedTicket('CLI foreign forced submission', 'victim-worker', { files: ['lib/cli-force-submit.js'], category: 'submission.fixture' });
  pin(ticket, commit);
  const result = runCli([
    'submit', ticket.ref,
    '--by', 'attacker-worker',
    '--commit', commit,
    '--gitref', `refs/sidequest/${ticket.ref}`,
    '--verify', 'node --test test/submission.test.ts',
    '--force',
  ]);
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr + result.stdout, /not_owner|claimed by "victim-worker"|rather than you/);
  assertForeignSubmissionWasRefused(ticket, 'victim-worker');

  const ownerSubmission = store.submitTicket(slug, ticket.ref, 'victim-worker', { commit });
  assert.strictEqual(ownerSubmission.ok, true, ownerSubmission.message);
  const forcedReplacement = runCli([
    'submit', ticket.ref,
    '--by', 'attacker-worker',
    '--commit', commit,
    '--gitref', `refs/sidequest/${ticket.ref}`,
    '--verify', 'node --test test/submission.test.ts',
    '--force',
  ]);
  assert.strictEqual(forcedReplacement.status, 1);
  const stored = store.getTicket(slug, ticket.ref);
  assert.strictEqual(stored.claim, null);
  assert.strictEqual(stored.submission.by, 'victim-worker');
  assert.strictEqual(stored.rejectedSubmissions, undefined);
});

test('MCP force cannot submit over a foreign claim (SQ-1702)', async () => {
  const commit = createCandidateCommit('mcp-force-submit.js', 'MCP force submit candidate\n');
  const ticket = addClaimedTicket('MCP foreign forced submission', 'victim-worker', { files: ['lib/mcp-force-submit.js'], category: 'submission.fixture' });
  pin(ticket, commit);
  const result = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: ticket.ref,
    by: 'attacker-worker',
    commit,
    gitRef: `refs/sidequest/${ticket.ref}`,
    verify: 'node --test test/submission.test.ts',
    worktree: PROJECT_DIR,
    body: 'A foreign force must not submit or release the victim claim.',
    force: true,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'not_owner');
  assertForeignSubmissionWasRefused(ticket, 'victim-worker');

  const ownerSubmission = store.submitTicket(slug, ticket.ref, 'victim-worker', { commit });
  assert.strictEqual(ownerSubmission.ok, true, ownerSubmission.message);
  const forcedReplacement = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: ticket.ref,
    by: 'attacker-worker',
    commit,
    gitRef: `refs/sidequest/${ticket.ref}`,
    verify: 'node --test test/submission.test.ts',
    worktree: PROJECT_DIR,
    body: 'A foreign force must not replace the victim submission.',
    force: true,
  });
  assert.strictEqual(forcedReplacement.ok, false);
  assert.strictEqual(forcedReplacement.reason, 'not_owner');
  const stored = store.getTicket(slug, ticket.ref);
  assert.strictEqual(stored.claim, null);
  assert.strictEqual(stored.submission.by, 'victim-worker');
  assert.strictEqual(stored.rejectedSubmissions, undefined);
});

test('store force cannot preserve rejection history for a foreign claim (SQ-1702)', () => {
  const commit = createCandidateCommit('store-force-rejection.js', 'Store force rejection candidate\n');
  const ticket = addClaimedTicket('store foreign forced rejection', 'victim-worker', { files: ['lib/store-force-rejection.js'], category: 'submission.fixture' });
  const result = store.recordSubmissionRejection(slug, ticket.ref, {
    by: 'attacker-worker',
    review: 'Foreign rejection evidence must be refused.',
    reason: 'Foreign force must not poison rejection history.',
    commit,
    root: PROJECT_DIR,
    force: true,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'not_owner');
  assertForeignSubmissionWasRefused(ticket, 'victim-worker');
});

test('CLI forced validation failure cannot preserve rejection history for a foreign claim (SQ-1702)', () => {
  const commit = createCandidateCommit('cli-force-rejection.js', 'CLI force rejection candidate\n');
  const ticket = addClaimedTicket('CLI foreign forced rejection', 'victim-worker', { files: ['lib/cli-force-rejection.js'], category: 'submission.fixture' });
  const result = runCli([
    'submit', ticket.ref,
    '--by', 'attacker-worker',
    '--commit', commit,
    '--gitref', `refs/sidequest/${ticket.ref}-missing`,
    '--verify', 'node --test test/submission.test.ts',
    '--force',
  ]);
  assert.strictEqual(result.status, 1);
  assertForeignSubmissionWasRefused(ticket, 'victim-worker');
});

test('MCP forced validation failure cannot preserve rejection history for a foreign claim (SQ-1702)', async () => {
  const commit = createCandidateCommit('mcp-force-rejection.js', 'MCP force rejection candidate\n');
  const ticket = addClaimedTicket('MCP foreign forced rejection', 'victim-worker', { files: ['lib/mcp-force-rejection.js'], category: 'submission.fixture' });
  const result = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: ticket.ref,
    by: 'attacker-worker',
    commit,
    gitRef: `refs/sidequest/${ticket.ref}-missing`,
    verify: 'node --test test/submission.test.ts',
    worktree: PROJECT_DIR,
    body: 'A foreign forced validation failure must not preserve rejection history.',
    force: true,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'not_owner');
  assertForeignSubmissionWasRefused(ticket, 'victim-worker');
});

test('CLI and MCP reject unauthorized or independently invalid ranges without poisoning history (SQ-1667)', async () => {
  cleanBranch();
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'validation-parity.js'), 'candidate\n');
  git(['add', 'lib/validation-parity.js']);
  git(['commit', '-m', 'validation parity candidate']);
  const commit = git(['rev-parse', 'HEAD']);
  const ticket = addTicket('canonical submission validation', { files: ['lib/validation-parity.js'], category: 'submission.fixture' });
  assert.strictEqual(store.claimTicket(slug, ticket.ref, 'owner-worker', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);

  const unauthorizedCli = runCli(['submit', ticket.ref, '--by', 'intruder-worker', '--commit', commit, '--verify', 'node --test test/submission.test.ts']);
  assert.strictEqual(unauthorizedCli.status, 1);
  assert.strictEqual(store.getTicket(slug, ticket.ref).rejectedSubmissions, undefined);
  const unauthorizedMcp = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: ticket.ref,
    by: 'intruder-worker',
    commit,
    verify: 'node --test test/submission.test.ts',
    worktree: PROJECT_DIR,
    body: 'No paths admitted. Validation was expected to refuse the caller.',
  });
  assert.strictEqual(unauthorizedMcp.reason, 'not_owner');
  assert.strictEqual(store.getTicket(slug, ticket.ref).rejectedSubmissions, undefined);

  const invalidCli = runCli(['submit', ticket.ref, '--by', 'owner-worker', '--commit', commit, '--verify', 'Unstructured prose']);
  assert.strictEqual(invalidCli.status, 1);
  assert.strictEqual(store.getTicket(slug, ticket.ref).rejectedSubmissions, undefined);
  const invalidMcp = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: ticket.ref,
    by: 'owner-worker',
    commit,
    verify: 'Unstructured prose',
    worktree: PROJECT_DIR,
    body: 'No paths admitted. Independent verify validation must prevent rejection history.',
  });
  assert.strictEqual(invalidMcp.reason, 'missing_git_ref');
  assert.ok(invalidMcp.failures.some((failure: any) => failure.code === 'invalid_verify'));
  assert.strictEqual(store.getTicket(slug, ticket.ref).rejectedSubmissions, undefined);
});

test('pending rejection transactions recover the quarantine ref and store transition (SQ-1667)', () => {
  cleanBranch();
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'crash recovery candidate\n');
  git(['add', 'lib/fixture.js']);
  git(['commit', '-m', 'crash recovery candidate']);
  const commit = git(['rev-parse', 'HEAD']);
  const ticket = addTicket('recover a staged rejection', { category: 'submission.fixture' });
  const stored = store.getTicket(slug, ticket.ref);
  stored.rejectedSubmissions = [{
    commit,
    rejectedAt: '2026-08-09T12:00:00.000Z',
    rejectedBy: 'recovery-worker',
    review: 'Recovery evidence survives the interrupted transaction.',
    reason: 'The process stopped after the store intent was committed.',
    quarantineRef: `refs/sidequest/${ticket.ref}-rejected`,
    validation: true,
    rejectionKind: 'validation',
    preservationState: 'pending',
    source: 'mcp',
  }];
  persist(stored);
  git(['update-ref', '-d', stored.rejectedSubmissions[0].quarantineRef]);

  const recovered = store.reconcileSubmissionRejections(slug, ticket.ref);
  assert.strictEqual(recovered.ok, true, recovered.message);
  assert.strictEqual(recovered.recovered.length, 1);
  assert.strictEqual(git(['rev-parse', stored.rejectedSubmissions[0].quarantineRef]), commit);
  assert.strictEqual(store.getTicket(slug, ticket.ref).rejectedSubmissions[0].preservationState, 'preserved');
});

test('rejection history renders every row inline oldest first (SQ-1667)', async () => {
  const ticket = addTicket('retrieve complete rejection history', { category: 'submission.fixture' });
  const stored = store.getTicket(slug, ticket.ref);
  stored.rejectedSubmissions = Array.from({ length: 6 }, (_, index) => ({
    commit: `${index + 1}`.repeat(40),
    rejectedAt: `2026-08-09T12:00:0${index}.000Z`,
    rejectedBy: 'review-audit',
    review: `${index}:` + 'v'.repeat(990),
    reason: `${index}:` + 'r'.repeat(3990),
    quarantineRef: `refs/sidequest/${ticket.ref}-rejected-${index + 1}`,
    preservationState: 'preserved',
  }));
  persist(stored);
  const briefing = agentsync.renderTicketBriefing(store.getTicket(slug, ticket.ref), 'history-token', slug, PROJECT_DIR);
  assert.match(briefing, /## Rejected submission history/);
  for (const [index, rejected] of stored.rejectedSubmissions.entries()) {
    assert.ok(briefing.includes(`### Rejected candidate ${index + 1}/6`));
    assert.ok(briefing.includes(rejected.commit));
    assert.ok(briefing.includes(rejected.reason));
    assert.ok(briefing.includes(rejected.review));
  }
  assert.doesNotMatch(briefing, /context_page\(/);
});

test('rework leaves a pending submission intact when quarantine preservation fails (SQ-1642)', async () => {
  cleanBranch();
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'preservation failure candidate\n');
  git(['add', 'lib/fixture.js']);
  git(['commit', '-m', 'preservation failure candidate']);
  const candidate = git(['rev-parse', 'HEAD']);
  const t = addTicket('rework preservation failure', { category: 'submission.fixture' });
  pin(t, candidate);
  assert.strictEqual(store.claimTicket(slug, t.ref, 'failure-worker', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  assert.strictEqual(store.submitTicket(slug, t.ref, 'failure-worker', { commit: candidate }).ok, true);
  const pending = store.getTicket(slug, t.ref);
  pending.submission.commit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  persist(pending);

  const rejected = await callMcp('rework', {
    project: PROJECT_DIR,
    ref: t.ref,
    by: 'failure-worker',
    review: 'Preservation failure review evidence.',
    reason: 'Keep the pending candidate when its quarantine ref cannot be created.',
  });
  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(rejected.reason, 'rejected_submission_preservation_failed');
  const afterFailure = store.getTicket(slug, t.ref);
  assert.strictEqual(afterFailure.submission.commit, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.strictEqual(afterFailure.rejectedSubmissions, undefined);
});

test('MCP submit(clear:true) clears a bounced submission end to end: submit -> clear -> redispatch -> fresh claim succeeds (SQ-1010)', async () => {
  const t = addTicket('mcp submit clear end to end');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-a', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  assert.strictEqual(store.submitTicket(slug, t.ref, 'worker-a', { commit: COMMIT }).ok, true);
  assert.strictEqual(store.pendingSubmission(store.getTicket(slug, t.ref)), true);

  const unauthorizedCliClear = runCli(['submit', t.ref, '--by', 'orchestrator', '--clear', '--status', 'todo', '--force']);
  assert.strictEqual(unauthorizedCliClear.status, 1);
  assert.strictEqual(store.getTicket(slug, t.ref).submission.commit, COMMIT);

  const unauthorizedClear = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: t.ref,
    by: 'orchestrator',
    clear: true,
    status: 'todo',
    force: true,
  });
  assert.strictEqual(unauthorizedClear.reason, 'not_owner');
  assert.strictEqual(store.getTicket(slug, t.ref).submission.commit, COMMIT);

  const rejected = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: t.ref,
    by: 'worker-a',
    clear: true,
    status: 'todo',
  });
  assert.strictEqual(rejected.ok, true);
  assert.strictEqual(rejected.status, 'todo');

  const after = store.getTicket(slug, t.ref);
  assert.strictEqual(after.submission, null);
  assert.strictEqual(store.pendingSubmission(after), false);

  const redispatched = store.claimTicket(slug, t.ref, 'worker-b', { direct: true, reason: 'The submission fixture requires a local direct claim.' });
  assert.strictEqual(redispatched.ok, true, 'a fresh executor claims successfully after the reject');

  const doubleClear = await callMcp('submit', { project: PROJECT_DIR, ref: t.ref, by: 'orchestrator', clear: true });
  assert.strictEqual(doubleClear.ok, false);
  assert.strictEqual(doubleClear.reason, 'no_submission');
});

test('existing tickets with prose verify fields remain readable', () => {
  const t = addTicket('legacy prose verify');
  t.executorVerify = 'Read the rendered page source and confirm the required points.';
  persist(t);

  assert.strictEqual(store.getTicket(slug, t.ref).executorVerify, t.executorVerify);
});

test('SQ-2355: integration reports a diverged expected upstream without an empty scope list', () => {
  cleanBranch();
  const originalConfig = store.boardConfig(slug);
  const divergenceBranch = `diverged-upstream-${process.pid}-${Date.now()}`;
  try {
    const ticket = addTicket('diverged expected upstream', { files: ['lib/diverged-upstream.js'] });
    const expectedUpstream = git(['rev-parse', 'HEAD']);
    fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'diverged-upstream.js'), 'candidate\n');
    git(['add', 'lib/diverged-upstream.js']);
    git(['commit', '-m', 'diverged upstream candidate']);
    const candidate = git(['rev-parse', 'HEAD']);
    pin(ticket, candidate);
    assert.strictEqual(store.claimTicket(slug, ticket.ref, 'diverged-upstream-worker', { direct: true, reason: 'The divergence fixture requires a local direct claim.' }).ok, true);
    assert.strictEqual(store.submitTicket(slug, ticket.ref, 'diverged-upstream-worker', { commit: candidate, verify: 'node -e "process.exit(0)"' }).ok, true);
    const submitted = store.getTicket(slug, ticket.ref);
    Object.assign(submitted.submission, {
      base: expectedUpstream,
      upstream: divergenceBranch,
      upstreamCommit: expectedUpstream,
      integrationBranch: divergenceBranch,
      commits: [candidate],
      changedPaths: ['lib/diverged-upstream.js'],
    });
    persist(submitted);

    git(['checkout', '--orphan', divergenceBranch]);
    git(['rm', '-rf', '.']);
    fs.writeFileSync(path.join(PROJECT_DIR, 'README.md'), 'replacement integration history\n');
    git(['add', 'README.md']);
    git(['commit', '-m', 'replacement integration history']);
    store.setBoardConfig(slug, { integrationMode: 'local', integrationBranch: divergenceBranch });

    const refused = store.integrateSubmission(slug, ticket.ref, {
      mode: 'merge',
      target: { branch: divergenceBranch, upstream: `refs/heads/${divergenceBranch}` },
    });

    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.reason, 'expected_upstream_diverged');
    assert.match(refused.message, new RegExp(`recorded expected upstream ${expectedUpstream}`));
    assert.match(refused.message, new RegExp(`no longer reachable from target branch ${divergenceBranch}`));
    assert.match(refused.message, /Rework and submit a fresh candidate against current main/);
    assert.match(refused.message, /groomClose with deliveryCommit/);
    assert.doesNotMatch(refused.message, /outside its admitted scope:/);
  } finally {
    store.setBoardConfig(slug, { integrationMode: originalConfig.integrationMode, integrationBranch: originalConfig.integrationBranch });
    cleanBranch();
  }
});

test('integration refuses delivery when the assembled-wave gate fails', () => {
  cleanBranch();
  const t = addTicket('post-merge verification', { files: ['lib/preflight.js'] });
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'post-merge-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'preflight.js'), 'preflight\n');
  git(['add', 'lib/preflight.js']);
  git(['commit', '-m', 'post-merge candidate']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(t, commit);
  assert.strictEqual(runCli(['submit', t.ref, '--by', 'post-merge-worker', '--commit', commit, '--verify', 'node -e "process.exit(1)"']).status, 0);

  const before = git(['rev-parse', 'HEAD']);
  const target = Object.assign({}, store.integrationTarget(slug), { branch: git(['branch', '--show-current']) });
  const rejected = store.integrateSubmission(slug, t.ref, { mode: 'merge', target });
  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(rejected.reason, 'assembled_wave_gate_failed');
  assert.strictEqual(rejected.gate.verification.command, 'node -e "process.exit(1)"');
  assert.ok(fs.existsSync(rejected.gate.verification.logPath));
  assert.strictEqual(git(['rev-parse', 'HEAD']), before);
  assert.strictEqual(store.getTicket(slug, t.ref).submission.integration, undefined);

  const missingWaiver = store.integrateSubmission(slug, t.ref, { mode: 'merge', target, skipVerify: true });
  assert.strictEqual(missingWaiver.ok, false);
  assert.strictEqual(missingWaiver.reason, 'verification_waiver_required');
  assert.match(missingWaiver.message, /human waiver with authority, reason, affectedGate/);
});

test('a verify stopped at the integration cap names the observed time, the cap, and the board_config route (SQ-122)', () => {
  cleanBranch();
  const originalConfig = store.boardConfig(slug);
  assert.strictEqual(originalConfig.integrationVerifyTimeoutMaxMs, 60 * 60 * 1000);
  store.setBoardConfig(slug, { integrationVerifyTimeoutMs: 1500 });
  try {
    const t = addTicket('verification cap timeout', { files: ['lib/slow-verify.js'] });
    assert.strictEqual(runCli(['claim', t.ref, '--by', 'slow-verify-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
    fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'slow-verify.js'), 'slow\n');
    git(['add', 'lib/slow-verify.js']);
    git(['commit', '-m', 'slow verify candidate']);
    const commit = git(['rev-parse', 'HEAD']);
    pin(t, commit);
    const slowVerify = 'node -e "setTimeout(() => {}, 20000)"';
    assert.strictEqual(runCli(['submit', t.ref, '--by', 'slow-verify-worker', '--commit', commit, '--verify', slowVerify]).status, 0);

    const target = Object.assign({}, store.integrationTarget(slug), { branch: git(['branch', '--show-current']) });
    const rejected = store.integrateSubmission(slug, t.ref, { mode: 'merge', target });
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.reason, 'assembled_wave_gate_failed');
    const verification = rejected.gate.verification;
    assert.strictEqual(verification.status, 'timeout');
    assert.strictEqual(verification.timeoutMilliseconds, 1500);
    assert.ok(Number.isInteger(verification.durationMs) && verification.durationMs >= 1000 && verification.durationMs < 20000, `durationMs ${verification.durationMs}`);
    assert.match(rejected.message, /Verification ran \d+ms \(\d+s\) and was stopped at the board integration verify cap of 1500ms/);
    assert.match(rejected.message, /board_config\(\{ integrationVerifyTimeoutMs: <ms> \}\) \(maximum 3600000\)/);
    assert.doesNotMatch(rejected.message, /Refresh and reverify its candidates/);
  } finally {
    store.setBoardConfig(slug, { integrationVerifyTimeoutMs: originalConfig.integrationVerifyTimeoutMs });
  }
});

test('timeout guidance is empty for non-timeout results and degrades without duration facts', () => {
  const { verificationTimeoutGuidance } = require('../lib/refusal-guidance.js');
  assert.strictEqual(verificationTimeoutGuidance({ status: 'failed_suite', timeoutMilliseconds: 600000 }), '');
  assert.strictEqual(verificationTimeoutGuidance(null), '');
  const bare = verificationTimeoutGuidance({ status: 'timeout', timeoutMilliseconds: 600000 });
  assert.match(bare, /^Verification was stopped at the board integration verify cap of 600000ms \(600s\)/);
  assert.match(bare, /integrationVerifyTimeoutMs/);
  assert.doesNotMatch(bare, /maximum/);
});

test('a missing assembled-wave command reports the gate environment and its setup', () => {
  cleanBranch();
  const missingCommand = `sidequest-missing-gate-command-${process.pid}-${Date.now()}`;
  const originalConfig = store.boardConfig(slug);
  store.setBoardConfig(slug, { worktreeSetup: 'cd plugins/sidequest && npm ci' });
  try {
    const ticket = addTicket('missing assembled-wave command', { files: ['lib/missing-gate-command.js'] });
    assert.strictEqual(store.claimTicket(slug, ticket.ref, 'missing-command-worker', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
    fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'missing-gate-command.js'), 'candidate\n');
    git(['add', 'lib/missing-gate-command.js']);
    git(['commit', '-m', 'missing gate command candidate']);
    const commit = git(['rev-parse', 'HEAD']);
    pin(ticket, commit);
    assert.strictEqual(store.submitTicket(slug, ticket.ref, 'missing-command-worker', { commit, verify: 'node -e "process.exit(0)"' }).ok, true);
    const submitted = store.getTicket(slug, ticket.ref);
    submitted.executorVerify = missingCommand;
    submitted.submission.verify = missingCommand;
    persist(submitted);

    const refused = store.assembleSubmissionWave(slug, [ticket.ref]);

    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.reason, 'assembled_wave_environment_problem');
    assert.strictEqual(refused.gate.verification.status, 'toolchain_missing');
    assert.match(refused.message, new RegExp(missingCommand));
    assert.match(refused.message, /cd plugins\/sidequest && npm ci/);
    assert.doesNotMatch(refused.message, /Refresh and reverify/);
  } finally {
    store.setBoardConfig(slug, { worktreeSetup: originalConfig.worktreeSetup });
  }
});

test('SQ-1743: a held delivery lock refuses another integration before it changes the checkout', () => {
  cleanBranch();
  const t = addTicket('delivery lock', { files: ['lib/delivery-lock.js'] });
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'delivery-lock-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'delivery-lock.js'), 'locked\n');
  git(['add', 'lib/delivery-lock.js']);
  git(['commit', '-m', 'delivery lock candidate']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(t, commit);
  assert.strictEqual(runCli(['submit', t.ref, '--by', 'delivery-lock-worker', '--commit', commit]).status, 0);
  const before = git(['rev-parse', 'HEAD']);
  const lock = path.resolve(PROJECT_DIR, git(['rev-parse', '--git-common-dir']), 'sidequest-delivery.lock');
  fs.writeFileSync(lock, 'another integration\n');
  try {
    const target = Object.assign({}, store.integrationTarget(slug), { branch: git(['branch', '--show-current']) });
    const refused = store.integrateSubmission(slug, t.ref, { mode: 'merge', target });
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.reason, 'delivery_in_progress');
    assert.strictEqual(git(['rev-parse', 'HEAD']), before);
  } finally {
    fs.unlinkSync(lock);
  }
});

test('SQ-1749: a live owner survives expiry and cannot release a replacement lock', () => {
  const locks = createLocks({ fs, path, ticketsDir: () => SIDEQUEST_HOME, transaction: (fn: any) => fn() });
  const lock = path.join(SIDEQUEST_HOME, 'delivery-owner.lock');
  const owner = locks.acquireLock(lock, { wait: false });
  assert.ok(owner);
  try {
    const expired = new Date(Date.now() - 31_000);
    fs.utimesSync(lock, expired, expired);
    assert.strictEqual(locks.acquireLock(lock, { wait: false }), false);
  } finally {
    assert.deepStrictEqual(locks.releaseLock(lock, owner), { ok: true });
  }

  fs.writeFileSync(lock, JSON.stringify({ pid: 2_147_483_647, token: 'dead-owner' }));
  const replacement = locks.acquireLock(lock, { wait: false });
  assert.ok(replacement);
  assert.deepStrictEqual(locks.releaseLock(lock, 'dead-owner'), { ok: false, reason: 'lock_owner_lost' });
  assert.ok(fs.existsSync(lock));
  assert.deepStrictEqual(locks.releaseLock(lock, replacement), { ok: true });
});

test('integration reports and records merge conflict paths before aborting', () => {
  cleanBranch();
  const t = addTicket('merge conflict paths', { files: ['lib/merge-conflict.js'] });
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'merge-conflict-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'merge-conflict.js'), 'candidate\n');
  git(['add', 'lib/merge-conflict.js']);
  git(['commit', '-m', 'merge conflict candidate']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(t, commit);
  assert.strictEqual(runCli(['submit', t.ref, '--by', 'merge-conflict-worker', '--commit', commit]).status, 0);

  git(['checkout', '-f', '-B', 'merge-conflict-target', 'origin/main']);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'merge-conflict.js'), 'target\n');
  git(['add', 'lib/merge-conflict.js']);
  git(['commit', '-m', 'merge conflict target']);
  const target = Object.assign({}, store.integrationTarget(slug), { branch: git(['branch', '--show-current']) });
  const rejected = store.integrateSubmission(slug, t.ref, { mode: 'merge', target });

  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(rejected.reason, 'merge_failed');
  assert.deepStrictEqual(rejected.conflictedPaths, ['lib/merge-conflict.js']);
  assert.match(rejected.message, /Conflicted paths: lib\/merge-conflict\.js\./);
  assert.deepStrictEqual(store.getTicket(slug, t.ref).submission.integration.conflictedPaths, ['lib/merge-conflict.js']);
  assert.strictEqual(git(['status', '--porcelain']), '');
});

test('integration reports and records replay conflict paths before aborting', () => {
  cleanBranch();
  const t = addTicket('replay conflict paths', { files: ['lib/replay-conflict.js'] });
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'replay-conflict-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'replay-conflict.js'), 'candidate\n');
  git(['add', 'lib/replay-conflict.js']);
  git(['commit', '-m', 'replay conflict candidate']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(t, commit);
  assert.strictEqual(runCli(['submit', t.ref, '--by', 'replay-conflict-worker', '--commit', commit]).status, 0);

  git(['checkout', '-f', '-B', 'replay-conflict-target', 'origin/main']);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'replay-conflict.js'), 'target\n');
  git(['add', 'lib/replay-conflict.js']);
  git(['commit', '-m', 'replay conflict target']);
  const target = Object.assign({}, store.integrationTarget(slug), { branch: git(['branch', '--show-current']) });
  const rejected = store.integrateSubmission(slug, t.ref, { mode: 'replay', target });

  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(rejected.reason, 'replay_failed');
  assert.deepStrictEqual(rejected.conflictedPaths, ['lib/replay-conflict.js']);
  assert.match(rejected.message, /Conflicted paths: lib\/replay-conflict\.js\./);
  assert.deepStrictEqual(store.getTicket(slug, t.ref).submission.integration.conflictedPaths, ['lib/replay-conflict.js']);
  assert.strictEqual(git(['status', '--porcelain']), '');
});

test('integration closure consumes an in-scope submission with control-plane provenance', () => {
  cleanBranch();
  const t = addTicket('integration consumes submission', {
    files: ['lib/integrates.js'],
    category: 'submission.fixture',
  });
  const prepared = store.prepareDispatch(slug, t.ref, {
    sessionId: 'integration-consumes-submission',
    sharedTree: true,
  });
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-a', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId: 'integration-consumes-submission',
  }).ok, true);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'integrates.js'), 'integrated\n');
  git(['add', 'lib/integrates.js']);
  git(['commit', '-m', 'integration candidate']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(t, commit);
  assert.strictEqual(runCli(['submit', t.ref, '--by', 'worker-a', '--commit', commit]).status, 0);
  const submitted = store.getTicket(slug, t.ref);
  assert.strictEqual(submitted.lifecycleAttempt.state, 'submitted');
  assert.strictEqual(submitted.dispatch.lifecycleAttempt.state, 'submitted');
  const target = Object.assign({}, store.integrationTarget(slug), { branch: git(['branch', '--show-current']) });
  const delivered = store.integrateSubmission(slug, t.ref, { target });
  assert.strictEqual(delivered.ok, true, delivered.message);

  const completed = runCli(['groom-close', t.ref, '--by', 'orchestrator', '--integration', '--reason', `Integrated ${commit} into main.`]);
  assert.strictEqual(completed.status, 0, completed.stderr + completed.stdout);
  const after = store.getTicket(slug, t.ref);
  assert.strictEqual(after.status, 'done');
  assert.strictEqual(after.completion.authority, 'control-plane');
  assert.strictEqual(after.completion.purpose, 'integration');
  assert.ok(after.submission.integratedAt, 'integration closure stamps the submission integrated');
  assert.strictEqual(after.lifecycleAttempt.state, 'closed');
  assert.strictEqual(after.dispatch.lifecycleAttempt.state, 'closed');
  assert.strictEqual(store.pendingSubmission(after), false);
  assert.ok(!store.submissionsPayload(slug).tickets.some((x?: any) => x.ref === t.ref));
});

export {};
