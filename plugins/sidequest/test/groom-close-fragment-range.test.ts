'use strict';
/**
 * SQ-186 regression: groomClose's missing_release_fragment check for a
 * hand-delivered candidate must cover the whole submitted range (dispatch/
 * submission base..delivery commit), not just the delivery tip commit's own
 * diff.
 *
 * SQ-181 hit this: a 4-commit candidate added the release fragment in its
 * first commit; main was fast-forwarded to the tip commit, whose own diff
 * touched only an unrelated test file under the shipped plugin path.
 * groomClose(deliveryMethod: manual, deliveryCommit: <tip>) refused with
 * missing_release_fragment because the old code derived changed paths from
 * commitPaths(repo, delivery.commit) — the tip commit alone — instead of the
 * range the submission actually recorded.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-186-test-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-186-fixtures-'));
process.env.CLAUDE_PROJECT_DIR = path.join(FIXTURE_ROOT, 'board');
fs.mkdirSync(process.env.CLAUDE_PROJECT_DIR, { recursive: true });
execFileSync('git', ['init', '-b', 'main', '--quiet'], { cwd: process.env.CLAUDE_PROJECT_DIR, windowsHide: true });
execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: process.env.CLAUDE_PROJECT_DIR, windowsHide: true });

const store = require('../lib/store.js');
const db = require('../lib/db.js');

function gitAt(cwd: any, args: any) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function persistTicket(project: string, ticket: any) {
  db.putRow(db.openDb(SIDEQUEST_HOME), 'tickets', {
    id: ticket.id,
    project,
    ref: ticket.ref,
    status: ticket.status,
    archived: ticket.archived ? 1 : 0,
    ord: ticket.order,
    claim_by: ticket.claim?.by || null,
    data: ticket,
  });
}

function createGitWorktree() {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-186-worktree-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-186-remote-'));
  gitAt(worktree, ['init', '-b', 'main']);
  gitAt(worktree, ['config', 'user.name', 'Sidequest Test']);
  gitAt(worktree, ['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(worktree, 'README.md'), 'base\n');
  gitAt(worktree, ['add', 'README.md']);
  gitAt(worktree, ['commit', '-m', 'base']);
  execFileSync('git', ['init', '-b', 'main', '--bare', remote], { encoding: 'utf8', windowsHide: true });
  gitAt(worktree, ['remote', 'add', 'origin', remote]);
  gitAt(worktree, ['push', '-u', 'origin', 'main']);
  return worktree;
}

function addMarketplaceFixture(worktree: string) {
  const marketplacePath = path.join(worktree, '.claude-plugin');
  fs.mkdirSync(marketplacePath, { recursive: true });
  fs.writeFileSync(path.join(marketplacePath, 'marketplace.json'), JSON.stringify({
    plugins: [{ name: 'fixture-plugin', source: './plugins/fixture-plugin' }],
  }));
  gitAt(worktree, ['add', '.claude-plugin/marketplace.json']);
  gitAt(worktree, ['commit', '-m', 'fixture marketplace']);
  gitAt(worktree, ['push']);
}

test('SQ-186: groomClose manual delivery covers the whole submitted range, not just the delivery tip commit', () => {
  const worktree = createGitWorktree();
  addMarketplaceFixture(worktree);
  const project = store.ensureProject(worktree).slug;
  store.setBoardConfig(project, { integrationMode: 'local', integrationBranch: 'main' });

  const ticket = store.createTicket(project, {
    title: 'multi-commit candidate, fragment not in tip', files: ['plugins/fixture-plugin'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm the delivered-fragment range check covers every commit in the submitted range, not only the delivery tip commit',
  });
  assert.equal(store.claimTicket(project, ticket.ref, 'range-fragment-worker', {
    direct: true, reason: 'The multi-commit delivery-range fixture requires a local direct claim.',
  }).ok, true);

  // Commit 1: the shipped plugin change, plus its release fragment, exactly as
  // an executor should write them (SQ-181's actual first commit).
  fs.mkdirSync(path.join(worktree, 'plugins', 'fixture-plugin'), { recursive: true });
  fs.mkdirSync(path.join(worktree, '.release', 'unreleased'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'plugins', 'fixture-plugin', 'index.js'), 'changed\n');
  fs.writeFileSync(
    path.join(worktree, '.release', 'unreleased', `${ticket.ref}.md`),
    `---\nref: ${ticket.ref}\ntitle: Fixture change\nbump: patch\nplugins:\n  - fixture-plugin\n---\n\nFixture change.\n`,
  );
  gitAt(worktree, ['add', 'plugins/fixture-plugin/index.js', `.release/unreleased/${ticket.ref}.md`]);
  gitAt(worktree, ['commit', '-m', 'plugin change with fragment']);
  const base = gitAt(worktree, ['rev-parse', 'HEAD^']);
  const firstCommit = gitAt(worktree, ['rev-parse', 'HEAD']);

  // Commit 2 (the delivery tip): an unrelated follow-up under the same
  // shipped plugin path that does NOT touch the fragment — SQ-181's actual
  // final commit, which is what the buggy check diffed in isolation.
  fs.writeFileSync(path.join(worktree, 'plugins', 'fixture-plugin', 'negative-control.test.js'), 'test\n');
  gitAt(worktree, ['add', 'plugins/fixture-plugin/negative-control.test.js']);
  gitAt(worktree, ['commit', '-m', 'unrelated follow-up test file']);
  const tipCommit = gitAt(worktree, ['rev-parse', 'HEAD']);
  gitAt(worktree, ['push']);
  gitAt(worktree, ['update-ref', `refs/sidequest/${ticket.ref}`, tipCommit]);

  assert.equal(store.submitTicket(project, ticket.ref, 'range-fragment-worker', {
    commit: tipCommit, verify: 'node -e "process.exit(0)"',
  }).ok, true);

  // Mirror what the real MCP submit path records for a multi-commit range
  // (mcp-lifecycle.ts computes this correctly at submit time; that part is
  // not the bug under test): the fragment IS part of the recorded range.
  const submitted = store.getTicket(project, ticket.ref);
  Object.assign(submitted.submission, {
    base,
    upstream: 'origin/main',
    upstreamCommit: base,
    integrationBranch: 'main',
    commits: [firstCommit, tipCommit],
    changedPaths: [
      'plugins/fixture-plugin/index.js',
      `.release/unreleased/${ticket.ref}.md`,
      'plugins/fixture-plugin/negative-control.test.js',
    ],
  });
  persistTicket(project, submitted);

  // Sanity: the tip commit alone really does omit the fragment — this is
  // exactly the shape that fooled the old single-commit check.
  const tipOnlyDiff = gitAt(worktree, ['diff-tree', '--root', '--no-commit-id', '-r', '--name-only', tipCommit]);
  assert.doesNotMatch(tipOnlyDiff, /\.release\/unreleased/, 'fixture setup: the delivery tip commit must not itself touch the fragment');

  const closed = store.completeTicketAsControlPlane(project, ticket.ref, {
    by: 'range-fragment-integrator',
    reason: 'The candidate reached local main; delivering by hand after the fast-forward.',
    deliveryCommit: tipCommit,
    deliveryMethod: 'manual',
    purpose: 'delivery',
  });
  assert.equal(closed.ok, true, `expected the whole submitted range (which includes the fragment) to satisfy the check, got: ${closed.reason} ${closed.message || ''}`);
  assert.equal(store.getTicket(project, ticket.ref).status, 'done');
});
