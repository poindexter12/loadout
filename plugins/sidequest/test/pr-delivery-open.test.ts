import './_temp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// US-3 wave 2 (C): with deliveryChannel mode "pr", integrate builds the wave
// on <remote>/<target>, pushes sidequest/wave/<id>, opens one PR with
// auto-merge, and records awaiting-merge. Real git with a bare remote; the
// GitHub side is a fake port (store) or a fake gh on PATH (CLI). No network.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-pr-open-home-'));
process.env.SIDEQUEST_HOME = home;

const store = require('../lib/store.js');
const commitScope = require('../lib/commit-scope.js');
const mcp = require('../lib/mcp.js');
const { PrDeliveryUnavailableError } = require('../lib/ports/github-pr.js');
const { makeCliRunner, makeMcpCaller } = require('./_helpers.js');

const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const MANUAL_VERIFY = 'manual: fixture gate recorded';
const BOARD_REF = /\b(?:SQ|US)-\d+\b/;
const { callTool } = makeMcpCaller(mcp);

function git(args: string[], cwd: string) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function configureIdentity(repo: string) {
  git(['config', 'user.name', 'Sidequest Test'], repo);
  git(['config', 'user.email', 'sidequest-test@example.invalid'], repo);
}

function makeBoard(label: string, opts: { remote?: boolean; pr?: boolean } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `sq-pr-open-${label}-`));
  git(['init', '-b', 'main'], repo);
  configureIdentity(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  git(['add', 'README.md'], repo);
  git(['commit', '-m', 'base'], repo);
  let remote = '';
  if (opts.remote !== false) {
    remote = fs.mkdtempSync(path.join(os.tmpdir(), `sq-pr-open-remote-${label}-`));
    git(['init', '--bare', '-b', 'main'], remote);
    git(['remote', 'add', 'origin', remote], repo);
    git(['push', 'origin', 'main'], repo);
  }
  const slug = store.ensureProject(repo).slug as string;
  if (opts.pr !== false) assert.equal(store.setBoardConfig(slug, { deliveryChannel: { mode: 'pr' } }).ok, true);
  return { repo, remote, slug, base: git(['rev-parse', 'HEAD'], repo) };
}

type Board = ReturnType<typeof makeBoard>;

// One submitted candidate built off the untouched local main, the way an
// executor worktree leaves it: main stays put and the candidate lives on its ref.
function submitCandidate(board: Board, file: string, opts: { title?: string; content?: string } = {}) {
  const ticket = store.createTicket(board.slug, {
    title: opts.title || `candidate ${file}`,
    files: [file],
    executorVerifyKind: 'manual',
    executorVerify: MANUAL_VERIFY,
  });
  git(['checkout', '--detach', board.base], board.repo);
  fs.writeFileSync(path.join(board.repo, file), opts.content || `${file}\n`);
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
  return { ref: ticket.ref as string, commit };
}

function assemble(board: Board, refs: string[], waveId: string) {
  const wave = store.assembleSubmissionWave(board.slug, refs, {
    waveId,
    verification: store.getTicket(board.slug, refs[0]).submission.verificationResult,
  });
  assert.equal(wave.ok, true, wave.message || wave.reason);
  return wave;
}

type Call = { op: 'create' | 'auto'; cwd: string; head?: string; base?: string; title?: string; body?: string; number?: number };

function fakePort(opts: { failCreate?: Error; failAuto?: Error; firstNumber?: number } = {}) {
  const calls: Call[] = [];
  let next = opts.firstNumber || 100;
  return {
    calls,
    creates: () => calls.filter((call) => call.op === 'create'),
    autos: () => calls.filter((call) => call.op === 'auto'),
    async createPr(o: { cwd: string; head: string; base: string; title: string; body: string }) {
      calls.push({ op: 'create', ...o });
      if (opts.failCreate) throw opts.failCreate;
      const number = next++;
      return { number, url: `https://github.com/example/repo/pull/${number}` };
    },
    async enableAutoMerge(o: { cwd: string; number: number }) {
      calls.push({ op: 'auto', ...o });
      if (opts.failAuto) throw opts.failAuto;
    },
    async viewPr() {
      throw new Error('opening a PR never views one');
    },
  };
}

// Any test that forgets to install its fake must fail loudly, never reach gh.
const forbiddenPort = {
  async createPr() { throw new Error('unexpected GitHub call: createPr'); },
  async enableAutoMerge() { throw new Error('unexpected GitHub call: enableAutoMerge'); },
  async viewPr() { throw new Error('unexpected GitHub call: viewPr'); },
};
const originalPort = store.setGitHubPrPort(forbiddenPort);
test.after(() => store.setGitHubPrPort(originalPort));

async function withPort(port: ReturnType<typeof fakePort>, run: () => unknown): Promise<any> {
  const previous = store.setGitHubPrPort(port);
  try {
    return await run();
  } finally {
    store.setGitHubPrPort(previous);
  }
}

function remoteBranch(board: Board, branch: string) {
  return git(['ls-remote', '--heads', board.remote, `refs/heads/${branch}`], board.repo);
}

function worktreeCount(repo: string) {
  return git(['worktree', 'list', '--porcelain'], repo).split('\n').filter((line) => line.startsWith('worktree ')).length;
}

function snapshot(board: Board, ref: string) {
  const ticket = store.getTicket(board.slug, ref);
  return JSON.stringify({ submission: ticket.submission, status: ticket.status });
}

test('pr mode opens one PR for an assembled wave with auto-merge and leaves main alone', async () => {
  const board = makeBoard('wave');
  const first = submitCandidate(board, 'alpha.txt');
  const second = submitCandidate(board, 'beta.txt');
  assemble(board, [first.ref, second.ref], 'wave-open');
  const port = fakePort();
  const result = await withPort(port, () => store.integrateSubmissionWave(board.slug, [first.ref, second.ref], { target: store.integrationTarget(board.slug) }));

  assert.equal(result.ok, true, result.message || result.reason);
  assert.equal(result.state, 'awaiting-merge');
  assert.equal(result.waveId, 'wave-open');
  assert.deepEqual(result.participants, [first.ref, second.ref].sort());
  const branch = 'sidequest/wave/wave-open';
  assert.equal(port.creates().length, 1, 'exactly one PR per wave');
  assert.equal(port.autos().length, 1, 'auto-merge enabled once');
  assert.deepEqual(
    { head: port.creates()[0]!.head, base: port.creates()[0]!.base, cwd: port.creates()[0]!.cwd },
    { head: branch, base: 'main', cwd: board.repo },
  );
  assert.equal(port.autos()[0]!.number, result.pr.number);
  assert.deepEqual(
    { number: result.pr.number, url: result.pr.url, branch: result.pr.branch, base: result.pr.base },
    { number: 100, url: 'https://github.com/example/repo/pull/100', branch, base: 'main' },
  );

  // The pushed head is two --no-ff merges on the remote base, in wave order.
  const head = remoteBranch(board, branch).split(/\s+/)[0]!;
  assert.equal(head, result.pr.headSha);
  git(['fetch', 'origin', `refs/heads/${branch}`], board.repo);
  assert.equal(git(['rev-list', '--parents', '-n', '1', head], board.repo).split(' ').length, 3, 'head is a merge commit');
  assert.equal(git(['rev-parse', `${head}^1^1`], board.repo), board.base, 'first parent chain starts at the remote base');
  assert.deepEqual(new Set([git(['rev-parse', `${head}^1^2`], board.repo), git(['rev-parse', `${head}^2`], board.repo)]), new Set([first.commit, second.commit]));
  const tree = git(['ls-tree', '--name-only', head], board.repo).split('\n');
  assert.ok(tree.includes('alpha.txt') && tree.includes('beta.txt'), tree.join(','));

  // No local or remote main movement, no leftover temp worktree.
  assert.equal(git(['rev-parse', 'refs/heads/main'], board.repo), board.base);
  assert.equal(git(['rev-parse', 'refs/heads/main'], board.remote), board.base);
  assert.equal(worktreeCount(board.repo), 1);

  for (const ref of [first.ref, second.ref]) {
    const ticket = store.getTicket(board.slug, ref);
    assert.equal(ticket.status, 'doing', 'participants stay doing while the PR is open');
    assert.equal(ticket.submission.integration.outcome, 'awaiting-merge');
    assert.equal(ticket.submission.integration.pr.number, 100);
  }
  assert.deepEqual(store.findAwaitingMergeWaves(board.slug).map((entry: any) => entry.waveId), ['wave-open']);

  // Re-integrating returns the recorded PR: no second PR, no push.
  const again = await withPort(port, () => store.integrateSubmissionWave(board.slug, [first.ref, second.ref], { target: store.integrationTarget(board.slug) }));
  assert.equal(again.ok, true, again.message || again.reason);
  assert.equal(again.state, 'awaiting-merge');
  assert.equal(again.existing, true);
  assert.deepEqual(again.pr, result.pr);
  assert.equal(port.creates().length, 1, 'idempotent re-integrate opens no second PR');
  assert.equal(port.autos().length, 1);
  assert.equal(remoteBranch(board, branch).split(/\s+/)[0], head, 'branch never re-pushed');

  // A subset of an awaiting wave is refused, never opened separately.
  const subset = await withPort(port, () => store.integrateSubmission(board.slug, first.ref, { target: store.integrationTarget(board.slug) }));
  assert.equal(subset.ok, false);
  assert.equal(subset.reason, 'assembled_wave_delivery_required');
  assert.equal(port.creates().length, 1);
});

test('pr mode builds on the fetched remote target, not local main', async () => {
  const board = makeBoard('remote-base');
  const candidate = submitCandidate(board, 'gamma.txt');
  // Someone else lands a change on the remote target after the candidate was cut.
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-pr-open-clone-'));
  git(['clone', board.remote, clone], os.tmpdir());
  configureIdentity(clone);
  fs.writeFileSync(path.join(clone, 'upstream.txt'), 'upstream\n');
  git(['add', 'upstream.txt'], clone);
  git(['commit', '-m', 'upstream change'], clone);
  git(['push', 'origin', 'main'], clone);
  const remoteMain = git(['rev-parse', 'HEAD'], clone);

  const port = fakePort({ firstNumber: 7 });
  const result = await withPort(port, () => store.integrateSubmission(board.slug, candidate.ref, { target: store.integrationTarget(board.slug) }));
  assert.equal(result.ok, true, result.message || result.reason);
  assert.equal(result.state, 'awaiting-merge');
  assert.equal(result.ticket.ref, candidate.ref);
  assert.equal(result.pr.number, 7);
  assert.match(result.waveId, /^delivery-/, 'a singleton integrate assembles its own wave');
  const head = result.pr.headSha;
  git(['fetch', 'origin', `refs/heads/${result.pr.branch}`], board.repo);
  assert.equal(git(['rev-parse', `${head}^1`], board.repo), remoteMain, 'merge base is <remote>/<target>');
  assert.equal(git(['rev-parse', `${head}^2`], board.repo), candidate.commit);
  assert.equal(git(['rev-parse', 'refs/heads/main'], board.repo), board.base, 'local main unmoved');
  assert.equal(git(['rev-parse', 'refs/heads/main'], board.remote), remoteMain, 'remote main unmoved');
  assert.equal(store.getTicket(board.slug, candidate.ref).status, 'doing');
});

test('PR title and body carry ticket titles only: a conventional type, no board refs, no local paths', async () => {
  const board = makeBoard('text');
  const first = submitCandidate(board, 'delta.txt', { title: `fix: repair delta export for SQ-12 in ${path.join(os.homedir(), 'private', 'delta.txt')} (US-3)` });
  const second = submitCandidate(board, 'epsilon.txt', { title: `feat(board): epsilon view from ${board.repo}/src/view.ts` });
  assemble(board, [first.ref, second.ref], 'wave-text');
  const port = fakePort();
  const result = await withPort(port, () => store.integrateSubmissionWave(board.slug, [first.ref, second.ref], { target: store.integrationTarget(board.slug) }));
  assert.equal(result.ok, true, result.message || result.reason);
  assert.equal(result.state, 'awaiting-merge');
  assert.equal(port.creates().length, 1, 'the wave opened one PR');
  const { title, body } = port.creates()[0]!;
  assert.match(title!, /^feat: /, 'the highest-priority conventional type wins');
  assert.match(title!, /\(\+1 more\)$/);
  for (const text of [title!, body!]) {
    assert.doesNotMatch(text, BOARD_REF, text);
    assert.equal(text.includes(os.homedir()), false, text);
    assert.equal(text.includes(board.repo), false, text);
    assert.equal(text.includes(os.tmpdir()), false, text);
  }
  assert.match(body!, /- fix: repair delta export for in \[path\]/);
  assert.match(body!, /- feat\(board\): epsilon view from \[path\]$/m);
  assert.equal(body!.split('\n').filter((line) => line.startsWith('- ')).length, 2);

  const board2 = makeBoard('text-default');
  const plain = submitCandidate(board2, 'zeta.txt', { title: 'Tidy zeta helper' });
  const solo = await withPort(port, () => store.integrateSubmission(board2.slug, plain.ref, { target: store.integrationTarget(board2.slug) }));
  assert.equal(solo.ok, true, solo.message || solo.reason);
  assert.equal(port.creates()[1]!.title, 'chore: Tidy zeta helper', 'titles without a type default to chore');
});

test('a gh failure opening the PR is pr_delivery_unavailable with its cause and leaves no state', async () => {
  const board = makeBoard('create-fails');
  const candidate = submitCandidate(board, 'eta.txt');
  assemble(board, [candidate.ref], 'wave-create-fails');
  const before = snapshot(board, candidate.ref);
  const failing = fakePort({ failCreate: new PrDeliveryUnavailableError('gh auth login required') });
  const result = await withPort(failing, () => store.integrateSubmission(board.slug, candidate.ref, { target: store.integrationTarget(board.slug) }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'pr_delivery_unavailable');
  assert.match(result.cause, /gh auth login required/);
  assert.match(result.message, /^PR delivery unavailable: /);
  assert.equal(snapshot(board, candidate.ref), before, 'no partial board state');
  assert.equal(remoteBranch(board, 'sidequest/wave/wave-create-fails'), '', 'the pushed branch is withdrawn');
  assert.equal(failing.autos().length, 0);
  assert.equal(worktreeCount(board.repo), 1);

  // The failure left nothing behind, so a retry with a working gh succeeds.
  const port = fakePort({ firstNumber: 11 });
  const retried = await withPort(port, () => store.integrateSubmission(board.slug, candidate.ref, { target: store.integrationTarget(board.slug) }));
  assert.equal(retried.ok, true, retried.message || retried.reason);
  assert.equal(retried.pr.number, 11);
});

test('an auto-merge failure withdraws the branch and records nothing', async () => {
  const board = makeBoard('auto-fails');
  const candidate = submitCandidate(board, 'theta.txt');
  assemble(board, [candidate.ref], 'wave-auto-fails');
  const before = snapshot(board, candidate.ref);
  const port = fakePort({ firstNumber: 21, failAuto: new PrDeliveryUnavailableError('auto-merge is not allowed for this repository') });
  const result = await withPort(port, () => store.integrateSubmission(board.slug, candidate.ref, { target: store.integrationTarget(board.slug) }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'pr_delivery_unavailable');
  assert.match(result.cause, /auto-merge is not allowed/);
  assert.deepEqual(result.pr, { number: 21, url: 'https://github.com/example/repo/pull/21' });
  assert.match(result.message, /closed with its branch/);
  assert.equal(snapshot(board, candidate.ref), before);
  assert.equal(remoteBranch(board, 'sidequest/wave/wave-auto-fails'), '');
});

test('remote problems are pr_delivery_unavailable before any GitHub call', async () => {
  const noRemote = makeBoard('no-remote', { remote: false });
  const lonely = submitCandidate(noRemote, 'iota.txt');
  const port = fakePort();
  const missing = await withPort(port, () => store.integrateSubmission(noRemote.slug, lonely.ref, { target: store.integrationTarget(noRemote.slug) }));
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'pr_delivery_unavailable');
  assert.match(missing.cause, /remote origin is not configured/);
  assert.notEqual(store.getTicket(noRemote.slug, lonely.ref).submission.integration?.outcome, 'awaiting-merge');

  const taken = makeBoard('branch-taken');
  const candidate = submitCandidate(taken, 'kappa.txt');
  assemble(taken, [candidate.ref], 'wave-taken');
  git(['push', 'origin', `${taken.base}:refs/heads/sidequest/wave/wave-taken`], taken.repo);
  const refused = await withPort(port, () => store.integrateSubmission(taken.slug, candidate.ref, { target: store.integrationTarget(taken.slug) }));
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'pr_delivery_unavailable');
  assert.match(refused.cause, /already exists on origin/);
  assert.equal(remoteBranch(taken, 'sidequest/wave/wave-taken').split(/\s+/)[0], taken.base, 'never force-pushes over it');
  assert.equal(port.calls.length, 0);
});

test('a wave conflict returns the existing conflict refusal and pushes nothing', async () => {
  const board = makeBoard('conflict');
  const first = submitCandidate(board, 'shared.txt', { content: 'first\n' });
  const second = submitCandidate(board, 'shared.txt', { content: 'second\n' });
  assemble(board, [first.ref, second.ref], 'wave-conflict');
  const before = [snapshot(board, first.ref), snapshot(board, second.ref)];
  const port = fakePort();
  const result = await withPort(port, () => store.integrateSubmissionWave(board.slug, [first.ref, second.ref], { target: store.integrationTarget(board.slug) }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'wave_delivery_failed');
  assert.deepEqual(result.conflictedPaths, ['shared.txt']);
  assert.equal(result.before, board.base);
  assert.equal(remoteBranch(board, 'sidequest/wave/wave-conflict'), '');
  assert.equal(port.calls.length, 0);
  assert.equal(worktreeCount(board.repo), 1, 'the temp worktree is removed after a conflict');
  assert.deepEqual([snapshot(board, first.ref), snapshot(board, second.ref)], before);
});

test('local delivery mode is unchanged: synchronous, moves local main, never calls GitHub', () => {
  const board = makeBoard('local', { remote: false, pr: false });
  const candidate = submitCandidate(board, 'lambda.txt');
  const result = store.integrateSubmission(board.slug, candidate.ref, { mode: 'merge', target: store.integrationTarget(board.slug) });
  assert.equal(typeof result?.then, 'undefined', 'local mode returns synchronously');
  assert.equal(result.ok, true, result.message || result.reason);
  assert.notEqual(result.state, 'awaiting-merge');
  assert.notEqual(git(['rev-parse', 'refs/heads/main'], board.repo), board.base, 'local main advanced');
});

test('MCP integrate acknowledges awaiting merge and stays idempotent', async () => {
  const board = makeBoard('mcp');
  const candidate = submitCandidate(board, 'mu.txt');
  const port = fakePort({ firstNumber: 31 });
  const previousDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = board.repo;
  try {
    const opened: any = await withPort(port, () => callTool('integrate', { project: board.slug, ref: candidate.ref, by: 'pr-integrator' }));
    assert.equal(opened.ok, true, opened.message || opened.reason);
    assert.equal(opened.action, 'awaiting_merge');
    assert.equal(opened.state, 'awaiting-merge');
    assert.equal(opened.pr.number, 31);
    assert.deepEqual(opened.participantRefs, [candidate.ref]);
    assert.deepEqual(opened.tickets, [{ ref: candidate.ref, status: 'doing' }]);

    const again: any = await withPort(port, () => callTool('integrate', { project: board.slug, ref: candidate.ref, by: 'pr-integrator' }));
    assert.equal(again.ok, true, again.message || again.reason);
    assert.equal(again.existing, true);
    assert.equal(again.pr.number, 31);
    assert.equal(port.creates().length, 1);
    assert.equal(store.getTicket(board.slug, candidate.ref).status, 'doing');
  } finally {
    if (previousDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = previousDir;
  }
});

test('CLI integrate opens the PR through gh and reports awaiting merge', () => {
  const board = makeBoard('cli');
  const candidate = submitCandidate(board, 'nu.txt');
  // A fake gh on PATH stands in for GitHub; the real gh port drives it.
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-pr-open-gh-'));
  const log = path.join(binDir, 'gh.log');
  fs.writeFileSync(path.join(binDir, 'gh'), [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$FAKE_GH_LOG"',
    'case "$1 $2" in',
    '  "pr create") cat > /dev/null; echo "https://github.com/example/repo/pull/41" ;;',
    '  "pr merge") exit 0 ;;',
    '  *) echo "unexpected gh $*" >&2; exit 1 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  const { runCli } = makeCliRunner(BIN, {
    SIDEQUEST_HOME: home,
    CLAUDE_PROJECT_DIR: board.repo,
    FAKE_GH_LOG: log,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
  }, { cwd: board.repo });

  const result = runCli(['integrate', candidate.ref, '--by', 'orchestrator', '--json']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.state, 'awaiting-merge');
  assert.equal(payload.pr.number, 41);
  assert.deepEqual(payload.participants, [candidate.ref]);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(calls.length, 2, calls.join('\n'));
  assert.match(calls[0]!, new RegExp(`^pr create --base main --head sidequest/wave/${payload.waveId} `));
  assert.equal(calls[1], 'pr merge 41 --auto --merge');
  assert.equal(store.getTicket(board.slug, candidate.ref).status, 'doing');

  const again = runCli(['integrate', candidate.ref, '--by', 'orchestrator']);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.match(again.stdout, /already awaiting merge: PR #41 https:\/\/github\.com\/example\/repo\/pull\/41/);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 2, 'no gh call on re-integrate');
});
