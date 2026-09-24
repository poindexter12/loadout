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

test('findLandedFixes matches a whole ref token once across the main log', () => {
  const { git, calls } = localGit({
    log: log([
      { sha: '78', date: '2026-01-03T00:00:00.000Z', subject: 'fix SQ-78', body: '' },
      { sha: '7', date: '2026-01-04T00:00:00.000Z', subject: 'other work', body: 'delivers SQ-7.' },
    ]),
    fragments: '.release/unreleased/SQ-7.md\n',
    changelog: '# Changelog\n\n## v3.5.0 (2026-01-05)\n\n- Fix (SQ-7)\n',
  });

  assert.deepEqual(findLandedFixes([activeTicket()], git), [{
    ticketId: 'tk_7',
    ref: 'SQ-7',
    status: 'todo',
    commits: [{ sha: '7', subject: 'other work', date: '2026-01-04T00:00:00.000Z' }],
    fragment: true,
    changelogVersion: 'v3.5.0',
  }]);
  assert.equal(calls.filter((args) => args[0] === 'log').length, 1);
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
