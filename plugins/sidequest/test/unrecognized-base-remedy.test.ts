import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * SQ-184: an `unrecognized_base` refusal's remedy text must never name the
 * same base the check just rejected.
 *
 * Repro (SQ-178, 2026-09-28): an executor was dispatched while release
 * commit X sat on local main. `cut.mjs` later rolled that commit back off
 * main. The executor submitted with `--base X` (the recorded dispatch
 * base), got refused `unrecognized_base` because X no longer reaches the
 * current integration target, and the refusal's own remedy text told it to
 * "use the recorded ... base commit X" — the exact commit that was just
 * refused. There was no correct next action until the orchestrator told it
 * to rebase onto current main by hand.
 *
 * These tests cover both layers of the fix:
 *  - commit-scope.ts's `submissionRange` now reports `dispatchBaseResubmittable`
 *    (whether the recorded/pinned dispatch base would itself pass this same
 *    check right now), computed from real git ancestry against the current
 *    integration target.
 *  - mcp-lifecycle.ts's `submissionRangeFailureMessage` uses that flag to
 *    give a real remedy — rebase onto the current integration target — when
 *    the pinned base has fallen off, instead of repeating it back.
 */

process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-unrecognized-base-remedy-home-'));
const commitScope = require('../lib/commit-scope.js') as {
  submissionRange(cwd: string, opts: Record<string, unknown>): {
    ok: boolean;
    reason?: string;
    base?: string;
    dispatchBaseResubmittable?: boolean;
    message?: string;
  };
};
const { submissionRangeFailureMessage, collectGitSubmissionFacts } = require('../lib/mcp-lifecycle.js') as {
  submissionRangeFailureMessage(ticket: any, range: any, gitRef: string): string;
  collectGitSubmissionFacts(options: Record<string, unknown>): any;
};
const store = require('../lib/store.js');

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true }).trim();
}

function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-unrecognized-base-remedy-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Sidequest Test']);
  git(root, ['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base']);
  return root;
}

function commitFile(root: string, file: string, contents: string, message: string): string {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), contents);
  git(root, ['add', '--', file]);
  git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

test('SQ-184: a dispatch base rolled off the integration target is reported non-resubmittable, not repeated back', () => {
  const root = repo();

  // Simulate the dispatch base: a "release commit" landed on main at
  // dispatch time (SQ-178's e3dbbb36).
  const releaseCommit = commitFile(root, 'RELEASE.md', 'release\n', 'release commit (later rolled back)');

  // Executor branches from the dispatch base and does ticket work, leaving
  // main checked out nowhere so it can be force-moved below.
  git(root, ['checkout', '-q', '-b', 'ticket-work']);
  const gitRef = 'refs/sidequest/SQ-184-TEST';
  const tip = commitFile(root, 'lib/fixture.js', 'ticket work\n', 'ticket work');
  git(root, ['update-ref', gitRef, tip]);

  // cut.mjs rolls the release commit back off main: main returns to the
  // pre-release commit, so the dispatch base no longer reaches the current
  // integration target.
  const preRelease = git(root, ['rev-parse', `${releaseCommit}~1`]);
  git(root, ['branch', '-f', 'main', preRelease]);

  const range = commitScope.submissionRange(root, {
    commit: tip,
    gitRef,
    upstream: 'main',
    integrationBranch: 'main',
    base: releaseCommit,
    pinnedBase: releaseCommit,
    allowedBases: [],
  });

  assert.equal(range.ok, false);
  assert.equal(range.reason, 'unrecognized_base');
  assert.equal(range.base, releaseCommit, 'the refusal names the base that was actually rejected');
  assert.equal(range.dispatchBaseResubmittable, false, 'the rolled-back dispatch base must not be reported resubmittable');

  const ticket = { ref: 'SQ-184-TEST', dispatch: { baseCommit: releaseCommit } };
  const message = submissionRangeFailureMessage(ticket, range, gitRef);

  assert.doesNotMatch(
    message,
    new RegExp(releaseCommit),
    'the remedy must never name the exact base commit the check just refused',
  );
  assert.match(message, /rebase this worktree onto the current integration target/);
  assert.match(message, /re-run verify-capture/);
  assert.match(message, /resubmit with no base override/);
});

test('SQ-184: a still-valid pinned dispatch base is reported resubmittable and named in the remedy', () => {
  const root = repo();

  // The dispatch base stays integrated: main advances past it, it is never
  // rolled back.
  const releaseCommit = commitFile(root, 'RELEASE.md', 'release\n', 'release commit (stays integrated)');
  commitFile(root, 'AFTER.md', 'after\n', 'main advances past the dispatch base');

  // Two ticket commits so there is a candidate base strictly between the
  // dispatch base and the tip — an arbitrary wrong `--base` the executor
  // could mistakenly pass, distinct from both the merge base and the
  // recorded dispatch base.
  git(root, ['checkout', '-q', '-b', 'ticket-work', releaseCommit]);
  const midCommit = commitFile(root, 'lib/mid.js', 'mid\n', 'ticket work part 1');
  const gitRef = 'refs/sidequest/SQ-184-TEST-2';
  const tip = commitFile(root, 'lib/fixture.js', 'ticket work part 2\n', 'ticket work part 2');
  git(root, ['update-ref', gitRef, tip]);

  const range = commitScope.submissionRange(root, {
    commit: tip,
    gitRef,
    upstream: 'main',
    integrationBranch: 'main',
    base: midCommit,
    pinnedBase: releaseCommit,
    allowedBases: [],
  });

  assert.equal(range.ok, false);
  assert.equal(range.reason, 'unrecognized_base');
  assert.equal(range.base, midCommit);
  assert.equal(range.dispatchBaseResubmittable, true, 'a dispatch base still integrated must be reported resubmittable');

  const ticket = { ref: 'SQ-184-TEST-2', dispatch: { baseCommit: releaseCommit } };
  const message = submissionRangeFailureMessage(ticket, range, gitRef);

  assert.match(
    message,
    new RegExp(`use the recorded the pinned dispatch base commit ${releaseCommit}`),
    'a still-valid pinned base is named in the remedy exactly as before',
  );
  assert.doesNotMatch(message, /rebase this worktree onto the current integration target/);
});

test('SQ-184: with no recorded dispatch base at all, the remedy keeps its generic fallback text', () => {
  const root = repo();
  git(root, ['checkout', '-q', '-b', 'ticket-work']);
  const gitRef = 'refs/sidequest/SQ-184-TEST-3';
  const midCommit = commitFile(root, 'lib/mid.js', 'mid\n', 'ticket work part 1');
  const tip = commitFile(root, 'lib/fixture.js', 'ticket work part 2\n', 'ticket work part 2');
  git(root, ['update-ref', gitRef, tip]);

  // main never advances past the shared base commit, so requestedBase
  // (midCommit) is neither the merge base nor integrated: this still
  // reaches unrecognized_base, but with no pinnedBase supplied at all.
  const range = commitScope.submissionRange(root, {
    commit: tip,
    gitRef,
    upstream: 'main',
    integrationBranch: 'main',
    base: midCommit,
    allowedBases: [],
  });

  assert.equal(range.ok, false);
  assert.equal(range.reason, 'unrecognized_base');
  assert.equal(range.dispatchBaseResubmittable, true, 'no recorded dispatch base defaults to resubmittable (nothing concrete to repeat back)');

  const ticket = { ref: 'SQ-184-TEST-3', dispatch: {} };
  const message = submissionRangeFailureMessage(ticket, range, gitRef);
  assert.match(message, /use the recorded the pinned dispatch base commit recorded in the dispatch/);
});

// SQ-287. Repro (jacaranda-platform SQ-2, 2026-10-08): an executor committed a fix on top of an open
// PR's head. Submitting with no base measured the range from the integration target and swallowed the
// PR's own out-of-scope paths; submitting with `--base <PR head>` refused unrecognized_base because the
// PR head is not on the integration target. No board path admitted the candidate. A ticket that names
// its base (SQ-286) is forked from the recorded commit, and submit now treats that commit as the range
// boundary, so scope is checked over base..candidate only.
test('SQ-287: a candidate built on the ticket\'s named PR branch is admitted with scope checked over base..candidate', () => {
  const root = repo();
  const mainTip = git(root, ['rev-parse', 'HEAD']);
  git(root, ['checkout', '--quiet', '-b', 'feat/pr-branch']);
  fs.mkdirSync(path.join(root, 'laya'));
  fs.writeFileSync(path.join(root, 'laya', 'app.txt'), 'pr work outside the ticket scope\n');
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', 'open pull request work']);
  const prTip = git(root, ['rev-parse', 'HEAD']);
  git(root, ['checkout', '--quiet', 'main']);

  const slug = store.ensureProject(root, 'sq-287 named base submit').slug;
  store.setCategory({ id: 'sq287-base', name: 'sq287 base', route: { model: 'sonnet', effort: 'medium' }, fallback: null, enabled: true, readonly: false });
  store.setBoardConfig(slug, { worktreeBase: 'local-main', integrationBranch: 'main', worktreeIsolation: true });

  const onPr = store.createTicket(slug, { title: 'fix on top of the PR', category: 'sq287-base', files: ['install.sh'], baseRef: 'feat/pr-branch', source: 'test' });
  store.prepareDispatch(slug, onPr.ref, { sessionId: 'sq287-pr', sharedTree: false });
  const ticket = store.getTicket(slug, onPr.ref);
  assert.deepEqual(ticket.dispatch.baseRef, { ref: 'feat/pr-branch', commit: prTip });

  const worktree = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-287-executor-')), 'executor');
  git(root, ['worktree', 'add', '--quiet', '-b', 'sq287-executor', worktree, prTip]);
  fs.writeFileSync(path.join(worktree, 'install.sh'), '#!/bin/sh\necho fixed\n');
  git(worktree, ['add', 'install.sh']);
  git(worktree, ['commit', '--quiet', '-m', 'fix on the PR']);
  const candidate = git(worktree, ['rev-parse', 'HEAD']);
  const gitRef = `refs/sidequest/${onPr.ref}`;
  git(worktree, ['update-ref', gitRef, candidate]);

  const defaulted = collectGitSubmissionFacts({ slug, ticket, root: worktree, commit: candidate, gitRef });
  assert.equal(defaulted.range.ok, true, `default range must start at the named base: ${JSON.stringify(defaulted.range)}`);
  assert.equal(defaulted.range.base, prTip, 'the default range starts at the named PR head, not the integration target');
  assert.deepEqual(defaulted.range.changedPaths, ['install.sh'], 'the PR\'s inherited paths are not charged to this ticket');

  const explicit = collectGitSubmissionFacts({ slug, ticket, root: worktree, commit: candidate, gitRef, base: prTip });
  assert.equal(explicit.range.ok, true, `--base <named PR head> must not refuse unrecognized_base: ${JSON.stringify(explicit.range)}`);
  assert.equal(explicit.range.base, prTip);
  assert.deepEqual(explicit.range.changedPaths, ['install.sh']);

  // Unchanged: a ticket that names no base still may not pick an arbitrary off-target base.
  const plain = store.createTicket(slug, { title: 'no named base', category: 'sq287-base', files: ['install.sh'], source: 'test' });
  store.prepareDispatch(slug, plain.ref, { sessionId: 'sq287-plain', sharedTree: false });
  const plainTicket = store.getTicket(slug, plain.ref);
  assert.equal(plainTicket.dispatch.baseCommit, mainTip);
  const refused = collectGitSubmissionFacts({ slug, ticket: plainTicket, root: worktree, commit: candidate, gitRef, base: prTip });
  assert.equal(refused.range.ok, false);
  assert.equal(refused.range.reason, 'unrecognized_base');
  git(root, ['worktree', 'remove', '--force', worktree]);
});
