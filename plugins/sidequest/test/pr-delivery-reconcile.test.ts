import './_temp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// US-3 "Reconcile" (SQ-106): integrate on a wave that is awaiting merge asks
// GitHub what became of its PR. MERGED closes every participant through the
// normal integration close with the merge commit as delivery; OPEN and pending
// stays put; failing checks and a PR closed unmerged are refused and recorded.
// Real git with a bare remote stands in for GitHub's repository; the PR API is a
// fake port (store, MCP) or a fake gh on PATH (CLI, fresh process). No network.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-pr-reconcile-home-'));
process.env.SIDEQUEST_HOME = home;

const store = require('../lib/store.js');
const commitScope = require('../lib/commit-scope.js');
const mcp = require('../lib/mcp.js');
const audit = require('../lib/audit/local.js');
const { planGithub } = require('../lib/audit/github.js');
const { makeCliRunner, makeMcpCaller } = require('./_helpers.js');

const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const MANUAL_VERIFY = 'manual: fixture gate recorded';
const { callTool } = makeMcpCaller(mcp);

function git(args: string[], cwd: string) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function configureIdentity(repo: string) {
  git(['config', 'user.name', 'Sidequest Test'], repo);
  git(['config', 'user.email', 'sidequest-test@example.invalid'], repo);
}

function makeBoard(label: string) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `sq-pr-reconcile-${label}-`));
  git(['init', '-b', 'main'], repo);
  configureIdentity(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  git(['add', 'README.md'], repo);
  git(['commit', '-m', 'base'], repo);
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), `sq-pr-reconcile-remote-${label}-`));
  git(['init', '--bare', '-b', 'main'], remote);
  git(['remote', 'add', 'origin', remote], repo);
  git(['push', 'origin', 'main'], repo);
  const slug = store.ensureProject(repo).slug as string;
  assert.equal(store.setBoardConfig(slug, { deliveryChannel: { mode: 'pr' } }).ok, true);
  return { repo, remote, slug, base: git(['rev-parse', 'HEAD'], repo) };
}

type Board = ReturnType<typeof makeBoard>;

function submitCandidate(board: Board, file: string) {
  const ticket = store.createTicket(board.slug, { title: `candidate ${file}`, files: [file], executorVerifyKind: 'manual', executorVerify: MANUAL_VERIFY });
  git(['checkout', '--detach', board.base], board.repo);
  fs.writeFileSync(path.join(board.repo, file), `${file}\n`);
  git(['add', file], board.repo);
  git(['commit', '-m', `candidate ${file}`], board.repo);
  const commit = git(['rev-parse', 'HEAD'], board.repo);
  git(['checkout', 'main'], board.repo);
  const gitRef = `refs/sidequest/${ticket.ref}`;
  git(['update-ref', gitRef, commit], board.repo);
  const target = store.integrationTarget(board.slug);
  const range = commitScope.submissionRange(board.repo, { commit, gitRef, upstream: target.upstream, integrationBranch: target.branch });
  assert.equal(range.ok, true, JSON.stringify(range));
  assert.equal(store.claimTicket(board.slug, ticket.ref, 'worker', { direct: true }).ok, true);
  const submitted = store.submitTicket(board.slug, ticket.ref, 'worker', { commit, gitRef, range, verify: MANUAL_VERIFY, source: 'test' });
  assert.equal(submitted.ok, true, submitted.message || submitted.reason);
  return ticket.ref as string;
}

function assemble(board: Board, refs: string[], waveId: string) {
  const wave = store.assembleSubmissionWave(board.slug, refs, { waveId, verification: store.getTicket(board.slug, refs[0]).submission.verificationResult });
  assert.equal(wave.ok, true, wave.message || wave.reason);
}

const prUrl = (number: number) => `https://github.com/example/repo/pull/${number}`;

// The PR API as GitHub would answer it: report() sets what viewPr says next.
function fakePort(firstNumber = 100) {
  const calls: any[] = [];
  let next = firstNumber;
  let status: any = {};
  return {
    calls,
    creates: () => calls.filter((call) => call.op === 'create'),
    views: () => calls.filter((call) => call.op === 'view'),
    report(value: any) { status = value; },
    async createPr(o: any) {
      calls.push({ op: 'create', ...o });
      const number = next++;
      return { number, url: prUrl(number) };
    },
    async enableAutoMerge(o: any) { calls.push({ op: 'auto', ...o }); },
    async viewPr(o: { cwd: string; number: number }) {
      calls.push({ op: 'view', ...o });
      if (status instanceof Error) throw status;
      return { number: o.number, url: prUrl(o.number), state: 'OPEN', headSha: 'f'.repeat(40), mergeCommit: null, checks: 'pending', failingChecks: [], ...status };
    },
  };
}
type Port = ReturnType<typeof fakePort>;

const forbiddenPort = {
  async createPr() { throw new Error('unexpected GitHub call: createPr'); },
  async enableAutoMerge() { throw new Error('unexpected GitHub call: enableAutoMerge'); },
  async viewPr() { throw new Error('unexpected GitHub call: viewPr'); },
};
const originalPort = store.setGitHubPrPort(forbiddenPort);
test.after(() => store.setGitHubPrPort(originalPort));

async function withPort(port: Port, run: () => unknown): Promise<any> {
  const previous = store.setGitHubPrPort(port);
  try {
    return await run();
  } finally {
    store.setGitHubPrPort(previous);
  }
}

async function viaMcp(board: Board, port: Port, refs: string[]): Promise<any> {
  const previousDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = board.repo;
  try {
    return await withPort(port, () => callTool('integrate', { project: board.slug, ref: refs.join(','), by: 'pr-integrator' }));
  } finally {
    if (previousDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = previousDir;
  }
}

function viaStore(board: Board, port: Port, refs: string[]): Promise<any> {
  const target = store.integrationTarget(board.slug);
  return withPort(port, () => (refs.length === 1
    ? store.integrateSubmission(board.slug, refs[0], { target })
    : store.integrateSubmissionWave(board.slug, refs, { target })));
}

// Submits and assembles one wave, then opens its PR (awaiting merge).
async function openWave(board: Board, files: string[], waveId: string, port: Port) {
  const refs = files.map((file) => submitCandidate(board, file));
  assemble(board, refs, waveId);
  const opened = await viaStore(board, port, refs);
  assert.equal(opened.ok, true, opened.message || opened.reason);
  assert.equal(opened.state, 'awaiting-merge');
  return { refs, pr: opened.pr, branch: `sidequest/wave/${waveId}` };
}

// GitHub merging the PR: a --no-ff merge of the wave branch pushed onto main.
function mergeOnRemote(board: Board, branch: string) {
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-pr-reconcile-github-'));
  git(['clone', '-q', board.remote, clone], os.tmpdir());
  configureIdentity(clone);
  git(['merge', '--no-ff', '-m', `Merge pull request from ${branch}`, `origin/${branch}`], clone);
  git(['push', '-q', 'origin', 'HEAD:main'], clone);
  return git(['rev-parse', 'HEAD'], clone);
}

const snapshot = (board: Board, refs: string[]) => refs.map((ref) => JSON.stringify(store.getTicket(board.slug, ref)));
const tagGit = (board: Board) => (args: string[]) => git(args, board.repo);
const ISSUE_LIST = 'issue list --repo owner/repo --state all --limit 1000 --json number,state,labels,title';

function issuePlan(ticket: any, released: any, label: string) {
  const gh = (_program: string, args: string[]) => {
    const key = args.join(' ');
    if (key === ISSUE_LIST) return JSON.stringify([{ number: 12, state: 'OPEN', labels: [{ name: label }], title: 'linked' }]);
    if (key === 'api repos/owner/repo/issues/12/comments --paginate') return '[]';
    throw new Error(`unexpected gh ${key}`);
  };
  return planGithub({
    links: [{ ticketId: ticket.id, ref: ticket.ref, provider: 'github', repo: 'owner/repo', number: 12 }],
    tickets: [ticket],
    released: { [ticket.id]: released },
    gh,
  });
}

test('MERGED closes every wave participant through the integration close with the merge commit as delivery', async () => {
  const board = makeBoard('merged');
  const port = fakePort(200);
  const { refs, pr, branch } = await openWave(board, ['alpha.txt', 'beta.txt'], 'wave-merged', port);
  // While the PR is open a linked issue reads in progress.
  assert.deepEqual(issuePlan(store.getTicket(board.slug, refs[0]), null, 'status:in-progress').linkedDrift, []);

  const mergeSha = mergeOnRemote(board, branch);
  port.report({ state: 'MERGED', mergeCommit: mergeSha, headSha: pr.headSha, checks: 'success' });
  const result = await viaMcp(board, port, refs);
  assert.equal(result.ok, true, result.message || result.reason);
  assert.match(result.message, new RegExp(`PR #200 \\(${prUrl(200)}\\), merged as ${mergeSha}`));
  assert.equal(port.creates().length, 1, 'reconcile opens no second PR');
  assert.equal(port.views().length, 1);

  for (const ref of refs) {
    const ticket = store.getTicket(board.slug, ref);
    assert.equal(ticket.status, 'done', `${ref} closed on merge`);
    assert.ok(ticket.submission.integratedAt, 'closed as integrated, not groomed');
    assert.equal(ticket.lifecycleAttempt?.state, 'closed');
    const integration = ticket.submission.integration;
    assert.deepEqual(
      { mode: integration.mode, outcome: integration.outcome, deliveryCommit: integration.deliveryCommit, resultingHead: integration.resultingHead, evidence: integration.evidence, targetUpstream: integration.targetUpstream },
      { mode: 'pr', outcome: 'verified', deliveryCommit: mergeSha, resultingHead: mergeSha, evidence: prUrl(200), targetUpstream: 'origin/main' },
    );
    assert.equal(integration.pr.state, 'MERGED');
    assert.equal(integration.pr.mergeCommit, mergeSha);
    assert.equal(ticket.submission.wave.delivery.state, 'delivered');
    assert.equal(ticket.submission.wave.delivery.revision.value, mergeSha);
    assert.equal(ticket.completion.delivery.commit, mergeSha);
    assert.equal(ticket.completion.delivery.evidence, prUrl(200));
    assert.equal(audit.deliveryCommit(ticket), mergeSha);
  }
  assert.deepEqual(store.findAwaitingMergeWaves(board.slug), []);
  assert.equal(git(['rev-parse', 'refs/heads/main'], board.repo), board.base, 'PR delivery never moves local main');

  // Audit release detection and issue status read the recorded merge commit.
  const done = store.getTicket(board.slug, refs[0]);
  assert.equal(audit.releasedIn(done, tagGit(board)), null, 'not released before a tag contains the merge');
  assert.deepEqual(issuePlan(done, null, 'status:in-progress').linkedDrift[0]?.desired.labels, ['status:in-testing']);
  git(['tag', 'v9.9.9', mergeSha], board.repo);
  const released = audit.releasedIn(done, tagGit(board));
  assert.deepEqual(released, { version: '9.9.9', tag: 'v9.9.9' });
  assert.equal(issuePlan(done, released, 'status:in-testing').linkedDrift[0]?.desired.state, 'CLOSED');

  // Closed participants no longer hold the PR: integrate reads nothing more.
  const again = await viaMcp(board, port, refs);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'submission_required');
  assert.equal(port.views().length, 1);
});

test('a fresh CLI process reconciles the stored awaiting-merge record and closes the ticket (restart)', async () => {
  const board = makeBoard('restart');
  const port = fakePort(41);
  const { refs, pr, branch } = await openWave(board, ['gamma.txt'], 'wave-restart', port);
  const mergeSha = mergeOnRemote(board, branch);
  // The orchestrator pulled main after the merge; the stored range still admits.
  git(['pull', '-q', '--ff-only', 'origin', 'main'], board.repo);

  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-pr-reconcile-gh-'));
  const log = path.join(binDir, 'gh.log');
  const view = JSON.stringify({ number: 41, url: prUrl(41), state: 'MERGED', headRefOid: pr.headSha, mergeCommit: { oid: mergeSha }, statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS', status: 'COMPLETED' }] });
  fs.writeFileSync(path.join(binDir, 'gh'), [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$FAKE_GH_LOG"',
    'case "$1 $2" in',
    `  "pr view") echo '${view}' ;;`,
    '  *) echo "unexpected gh $*" >&2; exit 1 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  const { runCli } = makeCliRunner(BIN, { SIDEQUEST_HOME: home, CLAUDE_PROJECT_DIR: board.repo, FAKE_GH_LOG: log, PATH: `${binDir}${path.delimiter}${process.env.PATH}` }, { cwd: board.repo });

  const result = runCli(['integrate', refs[0]!, '--by', 'orchestrator']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, new RegExp(`delivered by pr onto main \\(HEAD ${mergeSha.slice(0, 12)}\\)`));
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['pr view 41 --json number,url,state,headRefOid,mergeCommit,statusCheckRollup']);

  const ticket = store.getTicket(board.slug, refs[0]);
  assert.equal(ticket.status, 'done');
  assert.ok(ticket.submission.integratedAt);
  assert.equal(ticket.submission.integration.outcome, 'verified');
  assert.equal(ticket.submission.integration.deliveryCommit, mergeSha);
  assert.deepEqual(ticket.completion.delivery.pr, { number: 41, url: prUrl(41) });
  assert.equal(ticket.completion.delivery.commit, mergeSha);
});

test('OPEN with pending checks returns awaiting-merge unchanged and writes nothing', async () => {
  const board = makeBoard('pending');
  const port = fakePort();
  const { refs, pr } = await openWave(board, ['delta.txt', 'epsilon.txt'], 'wave-pending', port);
  const before = snapshot(board, refs);
  const again = await viaStore(board, port, refs);
  assert.equal(again.ok, true, again.message || again.reason);
  assert.deepEqual({ state: again.state, existing: again.existing, checks: again.checks }, { state: 'awaiting-merge', existing: true, checks: 'pending' });
  assert.deepEqual(again.pr, pr);
  assert.deepEqual(snapshot(board, refs), before, 'no board write while the PR is pending');
  assert.equal(port.creates().length, 1);
});

test('failing checks refuse wave_ci_failed, record the gate failure, and a re-run reconciles again', async () => {
  const board = makeBoard('ci-failed');
  const port = fakePort(300);
  const { refs, pr, branch } = await openWave(board, ['zeta.txt', 'eta.txt'], 'wave-ci', port);
  const failing = ['test (ubuntu-latest)', 'lint'];
  port.report({ checks: 'failure', failingChecks: failing });
  const failed = await viaMcp(board, port, refs);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'wave_ci_failed');
  assert.deepEqual(failed.failingChecks, failing);
  assert.equal(failed.pr.number, 300);
  assert.equal(failed.pr.url, prUrl(300));
  assert.match(failed.message, /failing checks: test \(ubuntu-latest\), lint/);
  for (const ref of refs) {
    const ticket = store.getTicket(board.slug, ref);
    assert.equal(ticket.status, 'doing', 'participants stay pending for rework or supersede');
    assert.ok(!ticket.submission.integratedAt, 'never stamped integrated');
    assert.deepEqual(
      { outcome: ticket.submission.integration.outcome, reason: ticket.submission.integration.reason, failingChecks: ticket.submission.integration.failingChecks, url: ticket.submission.integration.pr.url },
      { outcome: 'failed', reason: 'wave_ci_failed', failingChecks: failing, url: prUrl(300) },
    );
    assert.equal(ticket.submission.wave.delivery.state, 'delivery_failed');
    assert.deepEqual(ticket.submission.wave.delivery.verification.failureIdentities, failing);
  }
  assert.deepEqual(store.findAwaitingMergeWaves(board.slug), []);

  // Still failing: the same refusal, the same PR, nothing opened.
  const still = await viaStore(board, port, refs);
  assert.equal(still.reason, 'wave_ci_failed');
  assert.equal(port.creates().length, 1);

  // The checks are re-run: the wave awaits merge again with its gate restored.
  port.report({ checks: 'pending' });
  const rerun = await viaStore(board, port, refs);
  assert.equal(rerun.ok, true, rerun.message || rerun.reason);
  assert.equal(rerun.state, 'awaiting-merge');
  for (const ref of refs) {
    const ticket = store.getTicket(board.slug, ref);
    assert.equal(ticket.submission.integration.outcome, 'awaiting-merge');
    assert.equal(ticket.submission.integration.reason, undefined);
    assert.equal(ticket.submission.wave.delivery, undefined);
    assert.equal(ticket.submission.wave.state, 'gate_passed');
  }
  assert.deepEqual(store.findAwaitingMergeWaves(board.slug).map((wave: any) => wave.waveId), ['wave-ci']);

  const mergeSha = mergeOnRemote(board, branch);
  port.report({ state: 'MERGED', mergeCommit: mergeSha, headSha: pr.headSha, checks: 'success' });
  const merged = await viaStore(board, port, refs);
  assert.equal(merged.ok, true, merged.message || merged.reason);
  assert.equal(merged.state, 'merged');
  assert.equal(merged.integration.deliveryCommit, mergeSha);
});

test('a wave_ci_failed participant takes the normal rework path', async () => {
  const board = makeBoard('rework');
  const port = fakePort();
  const { refs } = await openWave(board, ['theta.txt'], 'wave-rework', port);
  port.report({ checks: 'failure', failingChecks: ['build'] });
  assert.equal((await viaStore(board, port, refs)).reason, 'wave_ci_failed');
  const reworked = store.reworkSubmission(board.slug, refs[0], { by: 'worker', review: 'PR #100 CI', reason: 'wave_ci_failed: build' });
  assert.equal(reworked.ok, true, reworked.message || reworked.reason);
  const again = await viaStore(board, port, refs);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'submission_required');
  assert.equal(port.views().length, 1, 'a reworked participant no longer reconciles the PR');
});

test('CLOSED unmerged refuses wave_pr_closed_unmerged and records it', async () => {
  const board = makeBoard('closed');
  const port = fakePort(51);
  const { refs } = await openWave(board, ['iota.txt'], 'wave-closed', port);
  port.report({ state: 'CLOSED' });
  const closed = await viaMcp(board, port, refs);
  assert.equal(closed.ok, false);
  assert.equal(closed.reason, 'wave_pr_closed_unmerged');
  assert.equal(closed.pr.number, 51);
  assert.match(closed.message, /closed without merging/);
  const ticket = store.getTicket(board.slug, refs[0]);
  assert.equal(ticket.status, 'doing');
  assert.deepEqual({ outcome: ticket.submission.integration.outcome, reason: ticket.submission.integration.reason, state: ticket.submission.integration.pr.state }, { outcome: 'failed', reason: 'wave_pr_closed_unmerged', state: 'CLOSED' });
  assert.deepEqual(store.findAwaitingMergeWaves(board.slug), []);
  const again = await viaStore(board, port, refs);
  assert.equal(again.reason, 'wave_pr_closed_unmerged', 'a closed PR is re-read, never replaced');
  assert.equal(port.creates().length, 1);
});

test('a merge commit not on the remote target is refused and records nothing', async () => {
  const board = makeBoard('unreachable');
  const port = fakePort();
  const { refs, pr } = await openWave(board, ['kappa.txt'], 'wave-unreachable', port);
  const before = snapshot(board, refs);
  // The PR head exists on the remote but never reached main.
  port.report({ state: 'MERGED', mergeCommit: pr.headSha, checks: 'success' });
  const result = await viaStore(board, port, refs);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'wave_merge_unreachable');
  assert.equal(result.mergeCommit, pr.headSha);
  assert.deepEqual(snapshot(board, refs), before);
});

test('a gh pr view failure is unavailable and records nothing', async () => {
  const board = makeBoard('view-fails');
  const port = fakePort();
  const { refs } = await openWave(board, ['lambda.txt'], 'wave-view', port);
  const before = snapshot(board, refs);
  port.report(new Error('HTTP 502: bad gateway'));
  const result = await viaStore(board, port, refs);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'pr_delivery_unavailable');
  assert.match(result.message, /gh pr view failed for PR #100: .*HTTP 502/);
  assert.deepEqual(snapshot(board, refs), before);
});

test('a participant reassembled into a new wave opens that wave its own PR', async () => {
  const board = makeBoard('reassembled');
  const port = fakePort();
  const { refs } = await openWave(board, ['mu.txt'], 'wave-first', port);
  port.report({ state: 'CLOSED' });
  assert.equal((await viaStore(board, port, refs)).reason, 'wave_pr_closed_unmerged');
  assemble(board, refs, 'wave-second');
  const reopened = await viaStore(board, port, refs);
  assert.equal(reopened.ok, true, reopened.message || reopened.reason);
  assert.equal(reopened.existing, undefined);
  assert.deepEqual({ number: reopened.pr.number, branch: reopened.pr.branch }, { number: 101, branch: 'sidequest/wave/wave-second' });
  assert.equal(port.creates().length, 2);
});
