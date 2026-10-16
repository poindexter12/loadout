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

/**
 * SQ-354 regression: the second axis of the same gate. Within the delivered
 * range the check used to accept ONLY a fragment filed under the closing
 * ticket's own ref, so a ticket whose fix was delivered incidentally by a
 * sibling ticket's commit could not be closed at all — the escape routes were
 * to double-announce the change under a second ref, or to force the status by
 * hand and lose the delivery provenance `--deliveryCommit` exists to record.
 *
 * The fixtures below model the shape that hit it (SQ-227): the closing ticket
 * carries no candidate of its own, and the commit that delivered its fix is a
 * sibling ticket's, announced by the sibling's fragment.
 */
function stageIncidentalDelivery(title: string, options: any) {
  const worktree = createGitWorktree();
  addMarketplaceFixture(worktree);
  const project = store.ensureProject(worktree).slug;
  store.setBoardConfig(project, { integrationMode: 'local', integrationBranch: 'main' });
  const ticket = store.createTicket(project, {
    title, files: ['plugins/fixture-plugin'], complexity: 3, labels: ['direct-ok'],
    complexityWhy: 'confirm the delivered-fragment gate accepts a sibling ref and steps aside for an already-released delivery commit',
  });

  fs.mkdirSync(path.join(worktree, 'plugins', 'fixture-plugin'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'plugins', 'fixture-plugin', 'index.js'), 'changed\n');
  const changedPaths: string[] = ['plugins/fixture-plugin/index.js'];
  if (options.fragmentRef) {
    fs.mkdirSync(path.join(worktree, '.release', 'unreleased'), { recursive: true });
    fs.writeFileSync(
      path.join(worktree, '.release', 'unreleased', `${options.fragmentRef}.md`),
      `---\nref: ${options.fragmentRef}\ntitle: Fixture change\nbump: patch\nplugins:\n  - fixture-plugin\n---\n\nFixture change.\n`,
    );
    changedPaths.push(`.release/unreleased/${options.fragmentRef}.md`);
  }
  gitAt(worktree, ['add', ...changedPaths]);
  gitAt(worktree, ['commit', '-m', 'sibling ticket\'s commit, which also carried this ticket\'s fix']);
  const tipCommit = gitAt(worktree, ['rev-parse', 'HEAD']);
  gitAt(worktree, ['push']);
  if (options.releaseTag) gitAt(worktree, ['tag', options.releaseTag, tipCommit]);
  assert.equal(store.getTicket(project, ticket.ref).submission, undefined, 'fixture setup: the closing ticket must carry no candidate of its own');
  return { project, ticket, tipCommit, worktree };
}

function closeByDelivery(staged: any) {
  return store.completeTicketAsControlPlane(staged.project, staged.ticket.ref, {
    by: 'sibling-fragment-integrator',
    reason: 'The fix landed incidentally in a sibling ticket\'s commit, already reachable from main.',
    deliveryCommit: staged.tipCommit,
    deliveryMethod: 'manual',
    purpose: 'delivery',
  });
}

test('SQ-354: a fragment filed under a sibling ref in the delivered range satisfies the delivery gate', () => {
  const staged = stageIncidentalDelivery('incidental fix delivered under a sibling ticket\'s fragment', { fragmentRef: 'SQ-9001' });
  assert.notEqual('SQ-9001', staged.ticket.ref, 'fixture setup: the fragment must be filed under a ref other than the closing ticket\'s');

  const closed = closeByDelivery(staged);
  assert.equal(closed.ok, true, `expected a sibling ref's fragment to satisfy the delivered-range check, got: ${closed.reason} ${closed.message || ''}`);
  const done = store.getTicket(staged.project, staged.ticket.ref);
  assert.equal(done.status, 'done');
  // The provenance --deliveryCommit exists to record survives the close, which forcing the status
  // by hand would have discarded.
  assert.equal(done.completion?.delivery?.commit, staged.tipCommit);
  assert.equal(done.completion?.delivery?.targetBranch, 'main');
  assert.equal(
    fs.existsSync(path.join(staged.worktree, '.release', 'unreleased', `${staged.ticket.ref}.md`)),
    false,
    'closing this way must not require a second fragment that would double-announce the sibling\'s change',
  );
});

test('SQ-354: an unreleased delivery commit with no fragment anywhere in its range is still refused', () => {
  const staged = stageIncidentalDelivery('shipped plugin change delivered with no fragment at all', {});

  const closed = closeByDelivery(staged);
  assert.equal(closed.ok, false, 'the gate is narrowed, not removed: an unreleased delivery still needs a fragment in its range');
  assert.equal(closed.reason, 'missing_release_fragment');
  assert.match(String(closed.message || ''), new RegExp(`\\.release/unreleased/${staged.ticket.ref}\\.md`));
  assert.notEqual(store.getTicket(staged.project, staged.ticket.ref).status, 'done');
});

test('SQ-354: a delivery commit already published under a release tag closes without any fragment', () => {
  const staged = stageIncidentalDelivery('already-released delivery commit, changelog entry immutable', { releaseTag: 'fixture-plugin-v1.0.0' });

  const closed = closeByDelivery(staged);
  assert.equal(closed.ok, true, `expected a released delivery commit to skip the fragment gate, got: ${closed.reason} ${closed.message || ''}`);
  assert.equal(store.getTicket(staged.project, staged.ticket.ref).status, 'done');
});
