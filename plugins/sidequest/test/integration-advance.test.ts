'use strict';
// SQ-137: one topic shard of the former integration-advance.test.ts, split so the runner can spread its tests
// across workers. Shared setup and helpers live in ./_integration-advance-fixture.ts; the tests are moved unchanged.
import {
  test,
  assert,
  fs,
  os,
  path,
  execFileSync,
  SIDEQUEST_HOME,
  store,
  worktrees,
  makeCliRunner,
  BIN,
  exploration,
  git,
  head,
  commitFile,
  remoteRefs,
  makeRepo,
  advance,
  submitFixture,
} from './_integration-advance-fixture.js';

test('a clean fast-forward advances the local integration branch to the integrated commit', async () => {
  const fixture = makeRepo('clean');
  const before = head(fixture.repo, 'refs/heads/main');
  const refsBefore = remoteRefs(fixture.repo);

  const result = await advance(fixture);

  assert.equal(result.advanced, true, result.message);
  assert.equal(result.reason, 'advanced');
  assert.equal(result.branch, 'main');
  assert.equal(result.from, before);
  assert.equal(result.to, fixture.integrated);
  assert.equal(head(fixture.repo, 'refs/heads/main'), fixture.integrated);
  assert.equal(head(fixture.repo), fixture.integrated, 'the checkout follows its own branch');
  assert.match(result.message, /main/);
  assert.match(result.message, new RegExp(fixture.integrated.slice(0, 12)));
  assert.equal(remoteRefs(fixture.repo), refsBefore, 'no remote ref is written');
  assert.equal(git(['log', '--merges', '--oneline', 'main'], fixture.repo), '', 'never a merge commit');
});

test('advancing a local branch leaves every remote-tracking ref where it was', async () => {
  const fixture = makeRepo('remoterefs');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-advance-bare-'));
  execFileSync('git', ['init', '-b', 'main', '--bare', bare], { encoding: 'utf8', windowsHide: true });
  git(['remote', 'add', 'origin', bare], fixture.repo);
  git(['push', '-u', 'origin', 'main'], fixture.repo);
  const refsBefore = remoteRefs(fixture.repo);
  assert.match(refsBefore, /refs\/remotes\/origin\/main/);

  const result = await advance(fixture);

  assert.equal(result.advanced, true, result.message);
  assert.equal(head(fixture.repo, 'refs/heads/main'), fixture.integrated);
  assert.equal(remoteRefs(fixture.repo), refsBefore, 'origin/main still points at the pushed commit');
  assert.equal(git(['rev-parse', 'refs/heads/main'], bare), result.from, 'nothing was pushed');
});

test('a second closure over the same integrated commit is a quiet no-op', async () => {
  const fixture = makeRepo('idempotent');
  assert.equal((await advance(fixture)).advanced, true);

  const result = await advance(fixture);
  assert.equal(result.advanced, false);
  assert.equal(result.reason, 'already_integrated');
  assert.equal(head(fixture.repo, 'refs/heads/main'), fixture.integrated);
});

test('a non-fast-forward refuses, names the branch and commit, and changes nothing', async () => {
  const fixture = makeRepo('diverged');
  const diverged = commitFile(fixture.repo, 'local.txt', 'main moved on its own\n');
  const refsBefore = remoteRefs(fixture.repo);

  const result = await advance(fixture);

  assert.equal(result.advanced, false);
  assert.equal(result.reason, 'not_fast_forward');
  assert.match(result.message, /main/);
  assert.match(result.message, new RegExp(fixture.integrated.slice(0, 12)));
  assert.match(result.message, /do not descend/);
  assert.equal(head(fixture.repo, 'refs/heads/main'), diverged, 'main is untouched');
  assert.equal(remoteRefs(fixture.repo), refsBefore);
});

test('a dirty working tree refuses with the command and changes nothing', async () => {
  const fixture = makeRepo('dirty');
  fs.writeFileSync(path.join(fixture.repo, 'README.md'), 'uncommitted edit\n');
  const before = head(fixture.repo, 'refs/heads/main');

  const result = await advance(fixture);

  assert.equal(result.advanced, false);
  assert.equal(result.reason, 'checkout_dirty');
  assert.match(result.message, /main/);
  assert.match(result.message, new RegExp(fixture.integrated.slice(0, 12)));
  assert.match(result.message, /modified tracked files/);
  assert.equal(result.command, `git -C "${fixture.repo}" merge --ff-only ${fixture.integrated}`);
  assert.equal(head(fixture.repo, 'refs/heads/main'), before);
  assert.equal(git(['status', '--porcelain', '--untracked-files=no'], fixture.repo), 'M README.md', 'the edit survives');
});

test('an untracked file does not block the fast-forward', async () => {
  const fixture = makeRepo('untracked');
  fs.writeFileSync(path.join(fixture.repo, 'scratch.log'), 'ignore me\n');

  const result = await advance(fixture);

  assert.equal(result.advanced, true, result.message);
  assert.equal(head(fixture.repo, 'refs/heads/main'), fixture.integrated);
  assert.equal(fs.readFileSync(path.join(fixture.repo, 'scratch.log'), 'utf8'), 'ignore me\n');
});

test('a scoped integration branch advance leaves unrelated dirty files untouched', async () => {
  const fixture = makeRepo('scoped-dirty');
  const unrelated = path.join(fixture.repo, 'README.md');
  fs.writeFileSync(unrelated, 'user keeps working\n');
  const before = fs.readFileSync(unrelated);

  const result = await advance(fixture, { admittedScope: ['feature.txt'], changedPaths: ['feature.txt'] });

  assert.equal(result.advanced, true, result.message);
  assert.deepEqual(result.ignoredDirtyPaths, ['README.md']);
  assert.deepEqual(fs.readFileSync(unrelated), before);
  assert.equal(git(['status', '--porcelain', '--untracked-files=no'], fixture.repo), 'M README.md');
});

test('a scoped integration branch advance refuses a dirty file inside scope', async () => {
  const fixture = makeRepo('scoped-overlap');
  const scoped = path.join(fixture.repo, 'feature.txt');
  fs.writeFileSync(scoped, 'user edit\n');

  const result = await advance(fixture, { admittedScope: ['feature.txt'], changedPaths: ['feature.txt'] });

  assert.equal(result.advanced, false);
  assert.equal(result.reason, 'checkout_dirty');
  assert.deepEqual(result.dirtyPaths, ['feature.txt']);
  assert.match(result.message, /declared scope: feature\.txt/);
  assert.equal(fs.readFileSync(scoped, 'utf8'), 'user edit\n');
});

test('a checkout sitting on another branch refuses and prints the command to run', async () => {
  const fixture = makeRepo('elsewhere');
  git(['switch', '-c', 'spike'], fixture.repo);
  const before = head(fixture.repo, 'refs/heads/main');

  const result = await advance(fixture);

  assert.equal(result.advanced, false);
  assert.equal(result.reason, 'branch_not_checked_out');
  assert.match(result.message, /main/);
  assert.match(result.message, /"spike" checked out/);
  assert.match(result.message, new RegExp(fixture.integrated.slice(0, 12)));
  assert.equal(
    result.command,
    `git -C "${fixture.repo}" switch main && git -C "${fixture.repo}" merge --ff-only ${fixture.integrated}`,
  );
  assert.equal(head(fixture.repo, 'refs/heads/main'), before, 'main is untouched');
  assert.equal(git(['branch', '--show-current'], fixture.repo), 'spike', 'no branch is checked out for the user');
});

test('a detached main checkout refuses rather than moving the branch behind it', async () => {
  const fixture = makeRepo('detached');
  git(['switch', '--detach', 'main'], fixture.repo);
  const before = head(fixture.repo, 'refs/heads/main');

  const result = await advance(fixture);

  assert.equal(result.reason, 'branch_not_checked_out');
  assert.match(result.message, /detached HEAD/);
  assert.equal(head(fixture.repo, 'refs/heads/main'), before);
});

test('remote mode does nothing at all', async () => {
  const fixture = makeRepo('remote');
  const before = head(fixture.repo, 'refs/heads/main');

  const result = await advance(fixture, { integrationTarget: { mode: 'remote', branch: 'main', upstream: 'origin/main' } });

  assert.equal(result.attempted, false);
  assert.equal(result.advanced, false);
  assert.equal(result.reason, 'remote_mode');
  assert.equal(head(fixture.repo, 'refs/heads/main'), before);
  assert.equal(remoteRefs(fixture.repo), '');
});

test('the executor checkout is never mistaken for the integration', async () => {
  const fixture = makeRepo('executor');
  // The same executor branch, checked out again under a hand-made name so the
  // agent-worktree filter cannot be what saves it.
  const manual = path.join(fixture.repo, '.claude', 'worktrees', 'sq-manual');
  git(['worktree', 'remove', fixture.executor], fixture.repo);
  git(['worktree', 'add', manual, 'worktree-agent-abc123'], fixture.repo);
  git(['worktree', 'remove', fixture.integration], fixture.repo);
  const before = head(fixture.repo, 'refs/heads/main');

  const result = await advance(fixture, { submissionWorktree: manual });

  assert.equal(result.advanced, false);
  assert.equal(result.reason, 'no_integrated_commit');
  assert.match(result.command, /merge --ff-only <integrated-commit>/);
  assert.equal(head(fixture.repo, 'refs/heads/main'), before);
});

test('two checkouts carrying the same work refuse as ambiguous', async () => {
  const fixture = makeRepo('ambiguous');
  const second = path.join(fixture.repo, '.claude', 'worktrees', 'integrate-again');
  git(['worktree', 'add', '-b', 'integration-s17', second, 'main'], fixture.repo);
  git(['cherry-pick', fixture.submitted], second);
  const before = head(fixture.repo, 'refs/heads/main');

  const result = await advance(fixture);

  assert.equal(result.advanced, false);
  assert.equal(result.reason, 'ambiguous_integrated_commit');
  assert.match(result.message, /2 checkouts carry this work/);
  assert.equal(head(fixture.repo, 'refs/heads/main'), before);
});

test('a closure with no submitted commit refuses instead of guessing a target', async () => {
  const fixture = makeRepo('nosubmission');
  const before = head(fixture.repo, 'refs/heads/main');

  const result = await advance(fixture, { submissionCommit: null });

  assert.equal(result.advanced, false);
  assert.equal(result.reason, 'submission_commit_missing');
  assert.match(result.message, /main/);
  assert.equal(head(fixture.repo, 'refs/heads/main'), before);
});

test('a submitted commit missing from the repo refuses instead of guessing a target', async () => {
  const fixture = makeRepo('unresolvable');
  const before = head(fixture.repo, 'refs/heads/main');

  const result = await advance(fixture, { submissionCommit: '0'.repeat(40) });

  assert.equal(result.advanced, false);
  assert.equal(result.reason, 'submission_commit_unresolvable');
  assert.match(result.message, /main/);
  assert.match(result.message, /000000000000 is not in/);
  assert.equal(head(fixture.repo, 'refs/heads/main'), before);
});

test('integrate advances local main and reports it', async () => {
  const fixture = makeRepo('closure');
  const { slug } = store.ensureProject(fixture.repo);
  const ticket = store.createTicket(slug, {
    title: 'advance fixture',
    category: 'codebase-exploration',
    description: 'A fixture ticket whose integration should advance local main.',
    files: ['feature.txt'],
  });
  submitFixture(slug, ticket, fixture);

  const { runCli } = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: fixture.repo }, { cwd: fixture.repo });
  const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--json']);

  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.delivery.resultingHead, head(fixture.repo, 'refs/heads/main'));
  assert.equal(payload.delivery.targetBranch, 'main');
  assert.equal(store.getTicket(slug, ticket.ref).status, 'done');
});

test('integrate refuses loudly when the checkout is not ready', async () => {
  const fixture = makeRepo('closure-refused');
  fs.writeFileSync(path.join(fixture.repo, 'feature.txt'), 'uncommitted edit\n');
  const { slug } = store.ensureProject(fixture.repo);
  const ticket = store.createTicket(slug, {
    title: 'refused advance fixture',
    category: 'codebase-exploration',
    description: 'A fixture ticket whose integration cannot advance local main.',
    files: ['feature.txt'],
  });
  submitFixture(slug, ticket, fixture);

  const { runCli } = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: fixture.repo }, { cwd: fixture.repo });
  const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--json']);

  assert.equal(result.status, 1, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, 'integration_target_dirty');
  assert.equal(head(fixture.repo, 'refs/heads/main'), git(['rev-parse', 'main'], fixture.repo));
});

export {};
