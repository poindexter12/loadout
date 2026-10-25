import './_temp-cleanup.js';
'use strict';
/**
 * findProject folds a linked git worktree to its main repository's board (SQ-237).
 *
 * A linked worktree that lives OUTSIDE the main checkout (baude, sidequest's own worktree root)
 * used to resolve as not_found: findProject matched only the registered path, so every hook that
 * hands it the session cwd (the force-exec-bypass Agent gate, dispatch launch recording) refused
 * with "this project is not registered on a Sidequest board" while the CLI, which resolves the cwd
 * through nearestRepoRoot first, found the board. findProject now applies the same fold, so the
 * two surfaces agree.
 *
 * Run: cd plugins/sidequest && npm run test:files -- test/find-project-linked-worktree.test.ts
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-find-project-wt-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function repoWithOutsideWorktree() {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-find-project-fx-')));
  const repo = path.join(parent, 'checkout', 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const worktree = path.join(parent, 'elsewhere', 'worktrees', 'primary-1');
  git(repo, ['worktree', 'add', '-q', '--detach', worktree]);
  return { repo, worktree };
}

test('findProject resolves a linked worktree outside the checkout to the main repository board', () => {
  const { repo, worktree } = repoWithOutsideWorktree();
  const slug = store.ensureProject(repo, 'outside-worktree-repo').slug;

  const direct = store.findProject(repo);
  assert.strictEqual(direct.ok, true);
  assert.strictEqual(direct.slug, slug);

  const viaWorktree = store.findProject(worktree);
  assert.strictEqual(viaWorktree.ok, true, `linked worktree resolved as ${JSON.stringify(viaWorktree)}`);
  assert.strictEqual(viaWorktree.slug, slug);

  const viaWorktreeSubdir = path.join(worktree, 'nested');
  fs.mkdirSync(viaWorktreeSubdir);
  assert.strictEqual(store.findProject(viaWorktreeSubdir).slug, slug);

  // The Agent gate's admission is keyed off this lookup.
  assert.notStrictEqual(store.projectDispatchAdmission(viaWorktree.slug).status, 'no-project');
});

test('findProject still reports not_found for an unregistered repository and its worktrees', () => {
  const { repo, worktree } = repoWithOutsideWorktree();
  assert.strictEqual(store.findProject(repo).ok, false);
  const result = store.findProject(worktree);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'not_found');
});

test('a worktree registered as its own board keeps that board', () => {
  const { repo, worktree } = repoWithOutsideWorktree();
  const mainSlug = store.ensureProject(repo, 'own-board-main').slug;
  const worktreeSlug = store.ensureProject(worktree, 'own-board-worktree').slug;
  assert.notStrictEqual(mainSlug, worktreeSlug);
  assert.strictEqual(store.findProject(worktree).slug, worktreeSlug);
});
