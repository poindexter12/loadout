import './_temp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

// US-3 wave 1 (A): the PR delivery board config and the awaiting-merge
// integration state. Store-level only; no GitHub, no network.
const ROOT = path.resolve(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-pr-delivery-home-'));
process.env.SIDEQUEST_HOME = home;

const store = require('../lib/store.js');
const commitScope = require('../lib/commit-scope.js');

const MANUAL_VERIFY = 'manual: fixture gate recorded';
const LOCAL_DEFAULT = { mode: 'local', remote: 'origin', target: 'main' };

function git(args: string[], cwd: string) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function makeBoard(label: string) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `sq-pr-delivery-${label}-`));
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.name', 'Sidequest Test'], repo);
  git(['config', 'user.email', 'sidequest-test@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  git(['add', 'README.md'], repo);
  git(['commit', '-m', 'base'], repo);
  return { repo, slug: store.ensureProject(repo).slug as string, base: git(['rev-parse', 'HEAD'], repo) };
}

type Board = ReturnType<typeof makeBoard>;

// One submitted candidate built off the untouched main, the way an executor
// worktree leaves it: main stays at the base and the candidate lives on its ref.
function submitCandidate(board: Board, file: string) {
  const ticket = store.createTicket(board.slug, {
    title: `candidate ${file}`,
    files: [file],
    executorVerifyKind: 'manual',
    executorVerify: MANUAL_VERIFY,
  });
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
  const wave = store.assembleSubmissionWave(board.slug, refs, {
    waveId,
    verification: store.getTicket(board.slug, refs[0]).submission.verificationResult,
  });
  assert.equal(wave.ok, true, wave.message || wave.reason);
  return wave;
}

function prFor(waveId: string, overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    url: 'https://github.com/example/repo/pull/42',
    branch: `sidequest/wave/${waveId}`,
    headSha: 'a'.repeat(40),
    base: 'main',
    openedAt: '2026-09-24T12:00:00.000Z',
    ...overrides,
  };
}

function submissionSnapshot(board: Board, ref: string) {
  const ticket = store.getTicket(board.slug, ref);
  return JSON.stringify({ submission: ticket.submission, updatedAt: ticket.updatedAt, status: ticket.status });
}

test('local delivery stays the default and the existing delivery key is untouched', () => {
  const board = makeBoard('defaults');
  const config = store.boardConfig(board.slug);
  assert.deepEqual(config.deliveryChannel, LOCAL_DEFAULT);
  assert.equal(config.delivery, 'merge');
  assert.deepEqual(store.resolveDeliveryConfig(board.slug), LOCAL_DEFAULT);
  assert.equal(store.resolveDeliveryConfig('no-such-board'), null);

  const written = store.setBoardConfig(board.slug, { delivery: 'replay' });
  assert.equal(written.ok, true);
  assert.equal(written.config.delivery, 'replay');
  assert.deepEqual(written.config.deliveryChannel, LOCAL_DEFAULT);
  assert.equal(Object.hasOwn(store.readMeta(board.slug), 'deliveryChannel'), false, 'a local board never stores a channel it did not set');
  assert.equal(store.submissionsPayload(board.slug).delivery, 'replay');
});

test('the delivery target follows integrationBranch and explicit values are stored as set', () => {
  const board = makeBoard('explicit');
  assert.equal(store.setBoardConfig(board.slug, { integrationBranch: 'trunk' }).ok, true);
  assert.deepEqual(store.boardConfig(board.slug).deliveryChannel, { mode: 'local', remote: 'origin', target: 'trunk' });

  const pr = store.setBoardConfig(board.slug, { deliveryChannel: { mode: ' PR ', remote: 'upstream' } });
  assert.equal(pr.ok, true);
  assert.deepEqual(pr.config.deliveryChannel, { mode: 'pr', remote: 'upstream', target: 'trunk' });
  assert.deepEqual(store.readMeta(board.slug).deliveryChannel, { mode: 'pr', remote: 'upstream' });
  assert.equal(pr.config.delivery, 'merge', 'the git delivery method is a separate key');

  // A write replaces the whole channel rather than merging into it.
  store.setBoardConfig(board.slug, { deliveryChannel: { mode: 'pr', target: 'release/next' } });
  const expected = { mode: 'pr', remote: 'origin', target: 'release/next' };
  assert.deepEqual(store.resolveDeliveryConfig(board.slug), expected);
  assert.deepEqual(store.resolveDeliveryConfig(store.readMeta(board.slug)), expected);
  assert.deepEqual(store.resolveDeliveryConfig(store.boardConfig(board.slug)), expected);

  const cleared = store.setBoardConfig(board.slug, { deliveryChannel: null });
  assert.deepEqual(cleared.config.deliveryChannel, { mode: 'local', remote: 'origin', target: 'trunk' });
  assert.equal(Object.hasOwn(store.readMeta(board.slug), 'deliveryChannel'), false);
});

test('an unknown delivery mode or unsafe channel value is refused with a clear message and nothing is written', () => {
  const board = makeBoard('refusals');
  const refused: Array<[unknown, RegExp]> = [
    [{ mode: 'github' }, /^deliveryChannel\.mode must be "local" or "pr"; got "github"\.$/],
    [{ remote: 'origin' }, /^deliveryChannel\.mode must be "local" or "pr"; got null\.$/],
    ['pr', /^deliveryChannel must be an object/],
    [{ mode: 'pr', branch: 'main' }, /^deliveryChannel does not accept "branch"/],
    [{ mode: 'pr', remote: '-origin' }, /^deliveryChannel\.remote must be a Git remote name/],
    [{ mode: 'pr', remote: 'a/b' }, /^deliveryChannel\.remote must be a Git remote name/],
    [{ mode: 'pr', target: '-main' }, /^deliveryChannel\.target must be a valid Git branch name that does not start with "-"/],
    [{ mode: 'pr', target: 'a..b' }, /^deliveryChannel\.target must be a valid Git branch name/],
  ];
  for (const [deliveryChannel, message] of refused) {
    assert.throws(() => store.setBoardConfig(board.slug, { deliveryChannel }), { message }, JSON.stringify(deliveryChannel));
  }
  assert.equal(Object.hasOwn(store.readMeta(board.slug), 'deliveryChannel'), false);

  // PR mode needs a base that cannot be read as an option, even when the
  // target falls back to integrationBranch. Local mode keeps accepting it.
  assert.equal(store.setBoardConfig(board.slug, { integrationBranch: '-trunk' }).ok, true);
  assert.throws(() => store.setBoardConfig(board.slug, { deliveryChannel: { mode: 'pr' } }), /deliveryChannel mode "pr" needs a PR base branch/);
  assert.deepEqual(store.boardConfig(board.slug).deliveryChannel, { mode: 'local', remote: 'origin', target: '-trunk' });
  assert.equal(store.setBoardConfig(board.slug, { deliveryChannel: { mode: 'pr', target: 'main' } }).ok, true);
  assert.throws(() => store.setBoardConfig(board.slug, { deliveryChannel: { mode: 'pr' } }), /needs a PR base branch/);
  assert.deepEqual(store.resolveDeliveryConfig(board.slug), { mode: 'pr', remote: 'origin', target: 'main' });
});

test('markWaveAwaitingMerge moves every wave participant to awaiting-merge at once', () => {
  const board = makeBoard('pair');
  const refs = [submitCandidate(board, 'a.txt'), submitCandidate(board, 'b.txt')].sort();
  assemble(board, refs, 'wave-pair');
  const attempts = refs.map((ref) => store.getTicket(board.slug, ref).lifecycleAttempt);

  const marked = store.markWaveAwaitingMerge(board.slug, 'wave-pair', prFor('wave-pair', { headSha: 'B'.repeat(40), openedAt: '2026-09-24T12:00:00+02:00' }));
  assert.equal(marked.ok, true, marked.message || marked.reason);
  const expected = prFor('wave-pair', { headSha: 'b'.repeat(40), openedAt: '2026-09-24T10:00:00.000Z' });
  assert.deepEqual(marked.participants, refs);
  assert.deepEqual(marked.pr, expected);
  refs.forEach((ref, index) => {
    const ticket = store.getTicket(board.slug, ref);
    assert.equal(ticket.submission.integration.outcome, 'awaiting-merge');
    assert.deepEqual(ticket.submission.integration.pr, expected);
    assert.equal(ticket.status, 'doing', 'participants stay doing while the PR is open');
    assert.equal(store.pendingSubmission(ticket), true);
    assert.deepEqual(ticket.lifecycleAttempt, attempts[index], 'the lifecycle attempt is not advanced by opening a PR');
  });
  assert.deepEqual(store.findAwaitingMergeWaves(board.slug), [{ waveId: 'wave-pair', participants: refs, pr: expected }]);
  assert.deepEqual(store.readWavePr(board.slug, 'wave-pair'), expected);
  assert.equal(store.readWavePr(board.slug, 'wave-missing'), null);
  assert.deepEqual(store.submissionsPayload(board.slug).tickets.map((ticket: any) => ticket.ref).sort(), refs);

  // Re-recording the same PR is idempotent: fields refresh, the first mark time stays.
  const firstMarkedAt = store.getTicket(board.slug, refs[0]).submission.integration.awaitingMergeAt;
  const refreshed = store.markWaveAwaitingMerge(board.slug, 'wave-pair', prFor('wave-pair', { headSha: 'c'.repeat(40) }));
  assert.equal(refreshed.ok, true, refreshed.message);
  for (const ref of refs) {
    const integration = store.getTicket(board.slug, ref).submission.integration;
    assert.equal(integration.pr.headSha, 'c'.repeat(40));
    assert.equal(integration.awaitingMergeAt, firstMarkedAt);
  }

  // A different PR for the same wave is refused and nothing moves.
  const before = refs.map((ref) => submissionSnapshot(board, ref));
  const other = store.markWaveAwaitingMerge(board.slug, 'wave-pair', prFor('wave-pair', { number: 43, url: 'https://github.com/example/repo/pull/43' }));
  assert.equal(other.ok, false);
  assert.equal(other.reason, 'wave_pr_mismatch');
  assert.deepEqual(refs.map((ref) => submissionSnapshot(board, ref)), before);
});

test('an invalid PR record or wave id is refused before any participant is written', () => {
  const board = makeBoard('invalid-pr');
  const refs = [submitCandidate(board, 'a.txt'), submitCandidate(board, 'b.txt')].sort();
  assemble(board, refs, 'wave-bad');
  const before = refs.map((ref) => submissionSnapshot(board, ref));
  const invalid = [
    prFor('wave-bad', { number: 0 }),
    prFor('wave-bad', { number: 1.5 }),
    prFor('wave-bad', { number: '42' }),
    prFor('wave-bad', { url: 'http://github.com/example/repo/pull/42' }),
    prFor('wave-bad', { url: 'https://github.com/example/repo/pull/41' }),
    prFor('wave-bad', { url: 'https://github.com/example/repo/pull/42?x=1' }),
    prFor('wave-bad', { url: 'not a url' }),
    prFor('wave-bad', { branch: 'sidequest/wave/other' }),
    prFor('wave-bad', { branch: 'main' }),
    prFor('wave-bad', { headSha: 'abc' }),
    prFor('wave-bad', { headSha: 'g'.repeat(40) }),
    prFor('wave-bad', { base: '-main' }),
    prFor('wave-bad', { base: 'a..b' }),
    prFor('wave-bad', { openedAt: 'yesterday' }),
    prFor('wave-bad', { openedAt: 17 }),
    null,
  ];
  for (const pr of invalid) {
    const result = store.markWaveAwaitingMerge(board.slug, 'wave-bad', pr);
    assert.equal(result.ok, false, JSON.stringify(pr));
    assert.equal(result.reason, 'invalid_wave_pr', JSON.stringify(pr));
    assert.equal(typeof result.message, 'string');
  }
  assert.equal(store.markWaveAwaitingMerge(board.slug, '../escape', prFor('../escape')).reason, 'invalid_wave_id');
  assert.equal(store.markWaveAwaitingMerge(board.slug, '-wave', prFor('-wave')).reason, 'invalid_wave_id');
  assert.equal(store.markWaveAwaitingMerge(board.slug, 'wave-unknown', prFor('wave-unknown')).reason, 'wave_not_found');
  assert.deepEqual(refs.map((ref) => submissionSnapshot(board, ref)), before);
  assert.deepEqual(store.findAwaitingMergeWaves(board.slug), []);
});

test('a wave whose participant set changed is refused whole, and a singleton wave marks on its own', () => {
  const board = makeBoard('changed');
  const [first, second] = [submitCandidate(board, 'a.txt'), submitCandidate(board, 'b.txt')].sort() as [string, string];
  assemble(board, [first, second], 'wave-both');
  assemble(board, [second], 'wave-second');
  const firstBefore = submissionSnapshot(board, first);

  const refused = store.markWaveAwaitingMerge(board.slug, 'wave-both', prFor('wave-both'));
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'wave_participants_changed');
  assert.equal(submissionSnapshot(board, first), firstBefore, 'the remaining participant is not written');
  assert.deepEqual(store.findAwaitingMergeWaves(board.slug), []);

  const pr = prFor('wave-second', { number: 7, url: 'https://github.com/example/repo/pull/7' });
  const singleton = store.markWaveAwaitingMerge(board.slug, 'wave-second', pr);
  assert.equal(singleton.ok, true, singleton.message);
  assert.deepEqual(singleton.participants, [second]);
  assert.deepEqual(store.findAwaitingMergeWaves(board.slug), [{ waveId: 'wave-second', participants: [second], pr }]);
  assert.equal(submissionSnapshot(board, first), firstBefore);
});

test('a wave already delivered locally cannot move to awaiting-merge', () => {
  const board = makeBoard('delivered');
  const ref = submitCandidate(board, 'a.txt');
  assemble(board, [ref], 'wave-local');
  const integrated = store.integrateSubmission(board.slug, ref, { mode: 'replay', target: store.integrationTarget(board.slug) });
  assert.equal(integrated.ok, true, integrated.message || integrated.reason);
  const before = submissionSnapshot(board, ref);

  const refused = store.markWaveAwaitingMerge(board.slug, 'wave-local', prFor('wave-local'));
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'wave_integration_settled');
  assert.equal(submissionSnapshot(board, ref), before);
  assert.equal(store.readWavePr(board.slug, 'wave-local'), null);
});

test('awaiting-merge and the delivery channel survive a fresh process reading the same store', () => {
  const board = makeBoard('restart');
  const refs = [submitCandidate(board, 'a.txt'), submitCandidate(board, 'b.txt')].sort();
  assemble(board, refs, 'wave-restart');
  assert.equal(store.setBoardConfig(board.slug, { deliveryChannel: { mode: 'pr', remote: 'upstream' } }).ok, true);
  const pr = prFor('wave-restart');
  assert.equal(store.markWaveAwaitingMerge(board.slug, 'wave-restart', pr).ok, true);

  const script = [
    `const store = require(${JSON.stringify(path.join(ROOT, 'lib', 'store.js'))});`,
    `const slug = ${JSON.stringify(board.slug)};`,
    `const refs = ${JSON.stringify(refs)};`,
    'process.stdout.write(JSON.stringify({',
    '  waves: store.findAwaitingMergeWaves(slug),',
    "  pr: store.readWavePr(slug, 'wave-restart'),",
    '  channel: store.resolveDeliveryConfig(slug),',
    '  outcomes: refs.map((ref) => store.getTicket(slug, ref).submission.integration.outcome),',
    '}));',
  ].join('\n');
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, SIDEQUEST_HOME: home }, windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    waves: [{ waveId: 'wave-restart', participants: refs, pr }],
    pr,
    channel: { mode: 'pr', remote: 'upstream', target: 'main' },
    outcomes: ['awaiting-merge', 'awaiting-merge'],
  });
});
