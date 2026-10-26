import './_temp-cleanup.js';
'use strict';

export const test = require('node:test');
export const assert = require('node:assert');
export const fs = require('node:fs');
export const os = require('node:os');
export const path = require('node:path');
export const { execFileSync } = require('node:child_process');

export const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-advance-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

export const store = require('../lib/store.js');
export const mcp = require('../lib/mcp.js');
export const commitScope = require('../lib/commit-scope.js');
export const worktrees = require('../lib/worktrees.js');
export const { makeCliRunner } = require('./_helpers.js');

export const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');

export const exploration = store.getCategory('codebase-exploration');
store.setCategory(Object.assign({}, exploration, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));

export function git(args: string[], cwd: string) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

export function head(cwd: string, revision = 'HEAD') {
  return git(['rev-parse', revision], cwd);
}

export function commitFile(cwd: string, filename: string, body: string) {
  fs.writeFileSync(path.join(cwd, filename), body);
  git(['add', filename], cwd);
  git(['commit', '-m', `fixture ${filename}`], cwd);
  return head(cwd);
}

export function remoteRefs(repo: string) {
  return git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes'], repo);
}

// One fixture, shaped like the real loop: an executor commits in its own agent
// worktree, the orchestrator cherry-picks that range into a separate integration
// checkout and bumps a version on top, and local main is left behind.
export function makeRepo(label: string) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `sq-advance-${label}-`));
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.name', 'Sidequest Test'], repo);
  git(['config', 'user.email', 'sidequest-test@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'advance fixture\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/*\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'base'], repo);
  git(['branch', '-M', 'main'], repo);

  const executor = path.join(repo, '.claude', 'worktrees', 'agent-abc123');
  git(['worktree', 'add', '-b', 'worktree-agent-abc123', executor, 'main'], repo);
  const submitted = commitFile(executor, 'feature.txt', 'executor work\n');

  const integration = path.join(repo, '.claude', 'worktrees', 'integrate');
  git(['worktree', 'add', '-b', 'integration-s16', integration, 'main'], repo);
  git(['cherry-pick', submitted], integration);
  const integrated = commitFile(integration, 'version.txt', '1.2.3\n');

  return { repo, executor, integration, submitted, integrated, target: { mode: 'local', branch: 'main', upstream: 'main' } };
}

export function advance(fixture: any, overrides: any = {}) {
  return worktrees.advanceIntegrationBranch(fixture.repo, Object.assign({
    integrationTarget: fixture.target,
    submissionCommit: fixture.submitted,
    submissionWorktree: fixture.executor,
  }, overrides));
}

export function submitFixture(slug: string, ticket: any, fixture: any, verify: string | null = null) {
  const gitRef = `refs/sidequest/${ticket.ref}`;
  git(['update-ref', gitRef, fixture.submitted], fixture.executor);
  const target = store.integrationTarget(slug);
  const range = commitScope.submissionRange(fixture.executor, {
    commit: fixture.submitted,
    gitRef,
    upstream: target.upstream,
    integrationBranch: target.branch,
  });
  assert.equal(range.ok, true, JSON.stringify(range));
  assert.equal(store.claimTicket(slug, ticket.ref, 'fixture-worker', { direct: true, reason: 'The integration fixture requires a local direct claim.' }).ok, true);
  const submitted = store.submitTicket(slug, ticket.ref, 'fixture-worker', {
    commit: fixture.submitted,
    gitRef,
    range,
    worktree: fixture.executor,
    verify,
  });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
}

export function deliveryTicket(label: string, opts: any = {}) {
  const fixture = makeRepo(label);
  const { slug } = store.ensureProject(fixture.repo);
  if (opts.timeoutMs != null) store.setBoardConfig(slug, { integrationVerifyTimeoutMs: opts.timeoutMs });
  const ticket = store.createTicket(slug, {
    title: `delivery ${label}`,
    category: 'codebase-exploration',
    description: 'A submitted fixture delivered through the integrator command.',
    files: opts.files || ['feature.txt'],
    ...(opts.verifyKind ? { executorVerifyKind: opts.verifyKind, executorVerify: opts.verify } : {}),
  });
  submitFixture(slug, ticket, fixture, opts.verify || null);
  const runner = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: fixture.repo }, { cwd: fixture.repo });
  return { fixture, slug, ticket, runCli: runner.runCli };
}

// SQ-99: the orchestrator reviews a candidate, commits a fix ON TOP of the
// pinned candidate (a reviewed descendant touching only submitted paths), and
// the branch lands as one squash commit. Neither the pinned candidate nor the
// descendant is reachable from main, and main's content differs from the
// candidate, so the content check must compare the delivery against the
// named reviewed descendant instead.
export function squashReviewedDescendant(label: string, reviewedBody: string) {
  // SQ-275: a recorded (non-working-tree) delivery is verified in a detached scratch worktree at the
  // delivery commit, never in the user's checkout, so the integration-side verify sees no branch.
  const verify = nodeVerify(`const fs=require('node:fs'); const {execFileSync}=require('node:child_process'); const branch=execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(); const expected=(branch==='main'||branch==='')?${JSON.stringify(reviewedBody)}:'executor work\\n'; process.exit(fs.readFileSync('feature.txt','utf8')===expected?0:7)`);
  const fixture = makeRepo(label);
  const { slug } = store.ensureProject(fixture.repo);
  const ticket = store.createTicket(slug, {
    title: `reviewed descendant ${label}`,
    category: 'codebase-exploration',
    description: 'A candidate delivered as a squash of itself plus a reviewed fix on top.',
    files: ['feature.txt'],
  });
  submitFixture(slug, ticket, fixture, verify);
  const review = path.join(fixture.repo, '.claude', 'worktrees', `review-${label}`);
  git(['worktree', 'add', '-b', `review-${label}`, review, fixture.submitted], fixture.repo);
  const interaction = commitFile(review, 'feature.txt', reviewedBody);
  commitFile(fixture.repo, 'main-moved.txt', 'main moved before the squash\n');
  git(['merge', '--squash', `review-${label}`], fixture.repo);
  git(['commit', '-m', 'squash reviewed candidate'], fixture.repo);
  return { fixture, slug, ticket, review, interaction, squash: head(fixture.repo) };
}

// SQ-322: a candidate delivered as a forge PR is squash-merged, then a LATER
// PR changes one of its submitted paths. The candidate is not reachable (it was
// squashed) and the integration tree no longer holds its content, so the
// working-tree check alone can never pass again. The delivery is provable at
// the point it landed: a first-parent commit on the integration branch whose
// submitted-path content equals the candidate's.
export function squashThenLaterChange(label: string, landedBody: string | null = null) {
  const fixture = makeRepo(label);
  const { slug } = store.ensureProject(fixture.repo);
  const ticket = store.createTicket(slug, {
    title: `squash then later change ${label}`,
    category: 'codebase-exploration',
    description: 'A candidate squash-merged on the forge whose path a later PR changed.',
    files: ['feature.txt'],
  });
  submitFixture(slug, ticket, fixture);
  commitFile(fixture.repo, 'main-moved.txt', 'main moved before the squash\n');
  let landing: string;
  if (landedBody === null) {
    git(['merge', '--squash', 'worktree-agent-abc123'], fixture.repo);
    git(['commit', '-m', 'squash pinned candidate (#156)'], fixture.repo);
    landing = head(fixture.repo);
  } else {
    landing = commitFile(fixture.repo, 'feature.txt', landedBody);
  }
  commitFile(fixture.repo, 'unrelated-later.txt', 'an unrelated later PR\n');
  const later = commitFile(fixture.repo, 'feature.txt', 'a later PR changed this submitted path\n');
  return { fixture, slug, ticket, landing, later };
}

export function nodeVerify(source: string) {
  return `"${process.execPath}" -e "${source.replace(/"/g, '\\"')}"`;
}

export function makeUnmergedTarget(repo: string, label: string) {
  const currentBranch = git(['branch', '--show-current'], repo);
  const competingBranch = `unmerged-${label}`;
  git(['branch', competingBranch], repo);
  commitFile(repo, 'target-conflict.txt', 'current target\n');
  git(['checkout', competingBranch], repo);
  commitFile(repo, 'target-conflict.txt', 'competing target\n');
  git(['checkout', currentBranch], repo);
  assert.throws(() => git(['merge', competingBranch], repo));
}

export const dirtyIntegrationTargetStates = [
  ['unstaged', (fixture: any) => fs.writeFileSync(path.join(fixture.repo, 'README.md'), 'unstaged target edit\n')],
  ['staged', (fixture: any) => {
    fs.writeFileSync(path.join(fixture.repo, 'README.md'), 'staged target edit\n');
    git(['add', 'README.md'], fixture.repo);
  }],
  ['untracked', (fixture: any) => fs.writeFileSync(path.join(fixture.repo, 'target-scratch.log'), 'untracked target file\n')],
  ['unmerged', (fixture: any, ticket: any) => makeUnmergedTarget(fixture.repo, ticket.ref)],
] as const;

export function makeGreenfieldRepo(label: string, locked = true) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `sq-greenfield-${label}-`));
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.name', 'Sidequest Test'], repo);
  git(['config', 'user.email', 'sidequest-test@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'greenfield fixture\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/*\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'base'], repo);
  git(['branch', '-M', 'main'], repo);

  const executor = path.join(repo, '.claude', 'worktrees', 'agent-greenfield');
  git(['worktree', 'add', '-b', 'worktree-agent-greenfield', executor, 'main'], repo);
  const pluginDirectory = path.join(executor, 'plugins', 'greenfield');
  fs.mkdirSync(path.join(pluginDirectory, 'locked-dependency'), { recursive: true });
  fs.mkdirSync(path.join(pluginDirectory, 'test'), { recursive: true });
  fs.writeFileSync(path.join(pluginDirectory, 'package.json'), JSON.stringify({
    name: 'greenfield',
    private: true,
    scripts: { 'test:full': 'node --test test/greenfield.test.js' },
    ...(locked ? { devDependencies: { 'locked-dependency': 'file:./locked-dependency' } } : {}),
  }));
  if (locked) {
    fs.writeFileSync(path.join(pluginDirectory, 'package-lock.json'), JSON.stringify({
      name: 'greenfield',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'greenfield', devDependencies: { 'locked-dependency': 'file:./locked-dependency' } },
        'locked-dependency': { version: '1.0.0', dev: true },
        'node_modules/locked-dependency': { resolved: 'locked-dependency', link: true },
      },
    }));
    fs.writeFileSync(path.join(pluginDirectory, 'locked-dependency', 'package.json'), JSON.stringify({ name: 'locked-dependency', version: '1.0.0' }));
    fs.writeFileSync(path.join(pluginDirectory, 'locked-dependency', 'index.js'), "module.exports = 'locked';\n");
  }
  fs.writeFileSync(
    path.join(pluginDirectory, 'test', 'greenfield.test.js'),
    locked ? "require('node:assert').equal(require('locked-dependency'), 'locked');\n" : "require('node:assert').ok(true);\n",
  );
  git(['add', 'plugins'], executor);
  git(['commit', '-m', 'add greenfield plugin'], executor);
  const submitted = head(executor);

  return { repo, executor, submitted, target: { mode: 'local', branch: 'main', upstream: 'main' } };
}

// SQ-137: the topic shards of the former integration-advance.test.ts share this setup. Each shard runs in its
// own process, so each gets its own copy of every temp directory and env var made above.
