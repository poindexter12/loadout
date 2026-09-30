import test from 'node:test';
import assert from 'node:assert/strict';

const { findLandedFixes, releasedIn } = require('../lib/audit/local');

function log(records: Array<{ sha: string; date: string; subject: string; body?: string }>) {
  return records.map((record) => `${record.sha}\x1f${record.date}\x1f${record.subject}\x1f${record.body || ''}\x1e`).join('');
}

function localGit(options: { log?: string; fragments?: string; changelog?: string; tags?: string; ancestors?: Record<string, string | null> } = {}) {
  const calls: string[][] = [];
  const git = (args: string[]) => {
    calls.push(args);
    if (args.join(' ') === 'rev-parse --verify origin/main') return 'main-sha';
    if (args.join(' ') === 'rev-parse --verify main') return 'main-sha';
    if (args[0] === 'log') return options.log ?? '';
    if (args[0] === 'ls-tree') return options.fragments ?? '';
    if (args[0] === 'show') return options.changelog ?? '';
    if (args.join(' ') === 'tag --contains abc1234 --list v* --sort=creatordate') return options.tags ?? '';
    if (args[0] === 'merge-base') return options.ancestors?.[args[args.length - 1] || ''] ?? null;
    throw new Error(`unexpected git command: ${args.join(' ')}`);
  };
  return { git, calls };
}

function activeTicket(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tk_7',
    ref: 'SQ-7',
    status: 'todo',
    createdAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

test('findLandedFixes accepts subject-tagged releases and fixes with delivery evidence', () => {
  const { git, calls } = localGit({
    log: log([
      { sha: '75', date: '2026-01-03T00:00:00.000Z', subject: 'release v4.0.0 (SQ-75)', body: '' },
      { sha: '156', date: '2026-01-04T00:00:00.000Z', subject: 'fix(sidequest): tighten audit evidence (SQ-156)', body: '' },
    ]),
    fragments: '.release/unreleased/SQ-156.md\n',
    changelog: '# Changelog\n\n## v4.0.0 (2026-01-05)\n\n- Release (SQ-75)\n',
  });

  assert.deepEqual(findLandedFixes([
    activeTicket({ id: 'tk_75', ref: 'SQ-75' }),
    activeTicket({ id: 'tk_156', ref: 'SQ-156' }),
  ], git), [
    {
      ticketId: 'tk_75',
      ref: 'SQ-75',
      status: 'todo',
      commits: [{ sha: '75', subject: 'release v4.0.0 (SQ-75)', date: '2026-01-03T00:00:00.000Z' }],
      fragment: false,
      changelogVersion: 'v4.0.0',
    },
    {
      ticketId: 'tk_156',
      ref: 'SQ-156',
      status: 'todo',
      commits: [{ sha: '156', subject: 'fix(sidequest): tighten audit evidence (SQ-156)', date: '2026-01-04T00:00:00.000Z' }],
      fragment: true,
      changelogVersion: null,
    },
  ]);
  assert.equal(calls.filter((args) => args[0] === 'log').length, 1);
});

test('findLandedFixes rejects body-only and unrelated delivery references', () => {
  const { git } = localGit({
    log: log([
      { sha: '128', date: '2026-01-03T00:00:00.000Z', subject: 'fix(sidequest): capture verification budget', body: '(SQ-45, SQ-128) could never pass the submit gate.' },
      { sha: '81', date: '2026-01-04T00:00:00.000Z', subject: 'fix(sidequest): repair SQ-162', body: "SQ-81's shell stood in the canonical path." },
      { sha: '121', date: '2026-01-05T00:00:00.000Z', subject: 'chore(upstream): record UP-004 (SQ-121)', body: 'ledger note, not a fix' },
    ]),
  });

  assert.deepEqual(findLandedFixes([
    activeTicket({ id: 'tk_128', ref: 'SQ-128' }),
    activeTicket({ id: 'tk_81', ref: 'SQ-81' }),
    activeTicket({ id: 'tk_121', ref: 'SQ-121' }),
  ], git), []);
});

test('findLandedFixes ignores a reused ref in a commit older than the ticket', () => {
  const { git } = localGit({
    log: log([{ sha: 'old', date: '2026-01-01T00:00:00.000Z', subject: 'fix SQ-7', body: '' }]),
  });

  assert.deepEqual(findLandedFixes([activeTicket()], git), []);
});

test('findLandedFixes skips archived tickets without reading git', () => {
  const { git, calls } = localGit();

  assert.deepEqual(findLandedFixes([activeTicket({ archived: true })], git), []);
  assert.deepEqual(calls, []);
});

test('findLandedFixes returns null when git evidence cannot be read', () => {
  assert.equal(findLandedFixes([activeTicket()], () => null), null);
});

test('releasedIn returns null for a done ticket whose delivery has no release tag', () => {
  const { git } = localGit({ tags: '' });
  const ticket = activeTicket({ status: 'done', submission: { integration: { deliveryCommit: 'abc1234' } } });

  assert.equal(releasedIn(ticket, git), null);
});

test('releasedIn returns the earliest containing tag with one bounded lookup', () => {
  const { git, calls } = localGit({ tags: 'v3.2.0\nv3.3.0\n' });
  const ticket = activeTicket({ status: 'done', completion: { delivery: { commit: 'abc1234' } } });

  assert.deepEqual(releasedIn(ticket, git), { version: '3.2.0', tag: 'v3.2.0' });
  assert.deepEqual(calls.filter((args) => args[0] === 'tag'), [['tag', '--contains', 'abc1234', '--list', 'v*', '--sort=creatordate']]);
  assert.equal(calls.some((args) => args[0] === 'merge-base'), false);
});

test('releasedIn explains a done ticket without a recoverable delivery commit', () => {
  const { git, calls } = localGit();

  assert.deepEqual(releasedIn(activeTicket({ status: 'done' }), git), {
    version: null,
    tag: null,
    reason: 'delivery_commit_unavailable',
  });
  assert.deepEqual(calls, []);
});

test('releasedIn returns null rather than throwing when tag lookup fails', () => {
  const ticket = activeTicket({ status: 'done', submission: { integration: { deliveryCommit: 'abc1234' } } });

  assert.deepEqual(releasedIn(ticket, () => null), {
    version: null,
    tag: null,
    reason: 'git_evidence_unavailable',
  });
});
