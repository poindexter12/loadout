import './_temp-cleanup.js';
'use strict';

// Regression for poindexter12/loadout#16 (SQ-201): integrate refused
// disjoint-file tickets with wave_invalidated although `git merge-tree` showed
// no conflicts. The project had an origin, so the integration target resolved
// to remote mode and the wave pinned to origin/main, while local delivery
// advanced the checked-out local main. After the first sequential integration
// local main sat ahead of origin, and every later candidate based on it was
// refused as baseline_moved. SQ-59 pins such a wave to local main when it
// contains origin; these tests lock that in for the sequential shape of #16.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-wave-ff-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const commitScope = require('../lib/commit-scope.js');

const exploration = store.getCategory('codebase-exploration');
store.setCategory(Object.assign({}, exploration, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));

function git(args: string[], cwd: string) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
}

function head(cwd: string, revision = 'HEAD') {
  return git(['rev-parse', revision], cwd);
}

function commitFile(cwd: string, filename: string, body: string) {
  fs.writeFileSync(path.join(cwd, filename), body);
  git(['add', filename], cwd);
  git(['commit', '-m', `fixture ${filename}`], cwd);
  return head(cwd);
}

// A project with an origin that main has been pushed to, so auto mode resolves
// the integration target to remote (origin/main), exactly as in #16.
function makeRemoteRepo(label: string) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `sq-wave-ff-${label}-`));
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.name', 'Sidequest Test'], repo);
  git(['config', 'user.email', 'sidequest-test@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'wave-invalidated fixture\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/*\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'base'], repo);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-wave-ff-bare-'));
  execFileSync('git', ['init', '-b', 'main', '--bare', bare], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
  git(['remote', 'add', 'origin', bare], repo);
  git(['push', '-u', 'origin', 'main'], repo);
  return repo;
}

// An isolated dispatch: a linked worktree based on local main, one commit on a
// file no sibling touches, submitted through the real submission range.
function dispatchAndSubmit(slug: string, repo: string, label: string, filename: string) {
  const worktree = path.join(repo, '.claude', 'worktrees', `agent-${label}`);
  git(['worktree', 'add', '-b', `worktree-agent-${label}`, worktree, 'main'], repo);
  const dispatchBase = head(worktree);
  const commit = commitFile(worktree, filename, `${label} executor work\n`);
  const ticket = store.createTicket(slug, {
    title: `${label} disjoint candidate`,
    category: 'codebase-exploration',
    description: `Touches only ${filename}.`,
    files: [filename],
  });
  const gitRef = `refs/sidequest/${ticket.ref}`;
  git(['update-ref', gitRef, commit], worktree);
  const range = commitScope.submissionRange(worktree, { commit, gitRef, upstream: 'main', integrationBranch: 'main' });
  assert.equal(range.ok, true, JSON.stringify(range));
  const by = `${label}-worker`;
  assert.equal(store.claimTicket(slug, ticket.ref, by, { direct: true, reason: 'The #16 regression fixture needs a direct claim.' }).ok, true);
  const submitted = store.submitTicket(slug, ticket.ref, by, { commit, gitRef, range, worktree });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  assert.equal(store.getTicket(slug, ticket.ref).submission.baseline.revision.value, dispatchBase);
  return { ticket, commit, worktree, dispatchBase };
}

// The operator check from #16: a clean three-way merge-tree against local main.
function assertMergeTreeClean(repo: string, commit: string) {
  const base = git(['merge-base', 'main', commit], repo);
  const out = git(['merge-tree', base, 'main', commit], repo);
  assert.doesNotMatch(out, /^[<>=]{7}/m, `git merge-tree must report no conflict markers for ${commit}`);
}

function assertDelivered(delivered: any, expectedBaseline: string) {
  assert.equal(delivered.ok, true, `expected delivery, got ${delivered.reason}: ${delivered.message}`);
  assert.notEqual(delivered.reason, 'wave_invalidated');
  assert.equal(delivered.ticket.submission.wave.baseline.revision.value, expectedBaseline);
}

test('#16: sequential disjoint-file candidates integrate without wave_invalidated once local main is ahead of origin', () => {
  const repo = makeRemoteRepo('sequential');
  const { slug } = store.ensureProject(repo);
  const target = store.integrationTarget(slug);
  assert.deepEqual(target, { mode: 'remote', upstream: 'origin/main', branch: 'main' });
  const originBefore = head(repo, 'origin/main');

  // First candidate: dispatched while local main and origin agree.
  const first = dispatchAndSubmit(slug, repo, 'first', 'first.txt');
  assertMergeTreeClean(repo, first.commit);
  assertDelivered(store.integrateSubmission(slug, first.ticket.ref, { mode: 'merge', target }), originBefore);
  assert.equal(fs.readFileSync(path.join(repo, 'first.txt'), 'utf8'), 'first executor work\n');
  const afterFirst = head(repo, 'main');
  assert.notEqual(afterFirst, head(repo, 'origin/main'), 'local delivery leaves origin behind local main');

  // Second candidate: dispatched from the advanced local main, which origin
  // does not contain. This is the fast-forward #16 refused as baseline_moved.
  const second = dispatchAndSubmit(slug, repo, 'second', 'second.txt');
  assert.equal(second.dispatchBase, afterFirst);
  assertMergeTreeClean(repo, second.commit);
  const delivered = store.integrateSubmission(slug, second.ticket.ref, { mode: 'merge', target });
  assertDelivered(delivered, afterFirst);
  assert.equal(fs.readFileSync(path.join(repo, 'second.txt'), 'utf8'), 'second executor work\n');
  assert.equal(head(repo, 'origin/main'), originBefore, 'integrate never moves the remote-tracking ref');
});

test('#16: a disjoint candidate dispatched before a sibling integrated still delivers after main moves', () => {
  const repo = makeRemoteRepo('moved-base');
  const { slug } = store.ensureProject(repo);
  const target = store.integrationTarget(slug);
  assert.equal(target.mode, 'remote');

  // Both dispatched from the same base; the sibling lands first, so the
  // remaining candidate's merge base has moved but its change is disjoint.
  const sibling = dispatchAndSubmit(slug, repo, 'sibling', 'sibling.txt');
  const late = dispatchAndSubmit(slug, repo, 'late', 'late.txt');
  assert.equal(late.dispatchBase, sibling.dispatchBase);
  assertDelivered(store.integrateSubmission(slug, sibling.ticket.ref, { mode: 'merge', target }), sibling.dispatchBase);
  const moved = head(repo, 'main');
  assert.notEqual(moved, late.dispatchBase);

  // A third candidate dispatched from the moved local main keeps local main
  // ahead of origin for the wave that delivers the late candidate.
  const third = dispatchAndSubmit(slug, repo, 'third', 'third.txt');
  assertDelivered(store.integrateSubmission(slug, third.ticket.ref, { mode: 'merge', target }), moved);

  const beforeLate = head(repo, 'main');
  assertMergeTreeClean(repo, late.commit);
  const delivered = store.integrateSubmission(slug, late.ticket.ref, { mode: 'merge', target });
  assertDelivered(delivered, beforeLate);
  for (const [file, label] of [['sibling.txt', 'sibling'], ['third.txt', 'third'], ['late.txt', 'late']]) {
    assert.equal(fs.readFileSync(path.join(repo, file), 'utf8'), `${label} executor work\n`);
  }
});
