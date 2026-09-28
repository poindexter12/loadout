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
const { submissionRangeFailureMessage } = require('../lib/mcp-lifecycle.js') as {
  submissionRangeFailureMessage(ticket: any, range: any, gitRef: string): string;
};

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
