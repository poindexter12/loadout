import './_temp-cleanup.js';
'use strict';
/**
 * SQ-383 (fix plan from SQ-366): groom-close must be able to close work that shipped through a
 * forge, not only work the board integrated itself. Three regressions, each red on the pre-fix
 * base:
 *   1. A ticket whose frozen dispatch target names a remote branch that was since deleted
 *      (a merged PR branch) can still be abandoned, and still be delivered against the board's
 *      own target, instead of every closure refusing integration_target_unavailable.
 *   2. A manual delivery whose squash exists only on origin/main closes while the canonical
 *      checkout sits on an unrelated branch: landedness comes from the remote, and the checkout
 *      plays no part in a delivery it does not carry.
 *   3. A forge squash of a candidate whose shared file was concurrently edited on main is
 *      accepted as a forge-squash delivery, because the squash is exactly the 3-way merge of the
 *      candidate onto its first parent, while a squash carrying anything else is still refused.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-forge-squash-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const {
  SHARED_FILE,
  SHARED_BASE_LINES,
  nodeVerify,
  makeLandedFixture,
  patchTicket,
  landDelivery,
  pushDelivery,
  originTip,
  checkoutStatus,
  checkoutHead,
} = require('./_landed-delivery-fixture.js');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function commitFile(repo: string, file: string, contents: string, message: string): string {
  fs.writeFileSync(path.join(repo, file), contents);
  git(repo, ['add', file]);
  git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

function deliverClose(fixture: any, opts: any) {
  return store.completeTicketAsControlPlane(fixture.slug, fixture.ticketRef, Object.assign({
    purpose: 'delivery',
    by: 'groomer',
    reason: 'shipped through the forge',
  }, opts));
}

// Verifies only where the candidate content exists, so a delivery verified in the checkout
// (which never holds feature.txt in these tests) fails loudly instead of passing by accident.
const CONTENT_VERIFY = nodeVerify("process.exit(require('fs').existsSync('feature.txt') ? 0 : 1)");

// The PR branch the dispatch was frozen against: pushed, fetched, then deleted on the forge and
// pruned locally, the way GitHub's post-merge branch cleanup leaves it.
function freezeOnDeletedPrBranch(fixture: any, branch: string) {
  git(fixture.repo, ['push', 'origin', `${fixture.base}:refs/heads/${branch}`]);
  git(fixture.repo, ['fetch', 'origin']);
  git(fixture.repo, ['rev-parse', '--verify', `refs/remotes/origin/${branch}`]);
  git(fixture.repo, ['push', 'origin', '--delete', branch]);
  git(fixture.repo, ['fetch', '--prune', 'origin']);
  assert.throws(() => git(fixture.repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]), 'fixture: the frozen PR branch is gone');
  patchTicket(fixture, (ticket: any) => {
    ticket.dispatch = Object.assign({}, ticket.dispatch || {}, {
      integrationTarget: { mode: 'remote', branch, upstream: `origin/${branch}` },
      terminalAt: new Date().toISOString(),
    });
  });
}

test('SQ-383: abandoning a submission whose frozen remote target branch was deleted closes instead of refusing integration_target_unavailable', () => {
  const fixture = makeLandedFixture('frozen-deleted-abandon');
  freezeOnDeletedPrBranch(fixture, 'pr/320');

  const closed = store.completeTicketAsControlPlane(fixture.slug, fixture.ticketRef, {
    purpose: 'grooming',
    abandonSubmission: true,
    by: 'groomer',
    reason: 'PR #320 was superseded and its branch deleted; this candidate never landed',
  });
  assert.strictEqual(closed.ok, true, JSON.stringify({ reason: closed.reason, message: closed.message }));

  const ticket = store.getTicket(fixture.slug, fixture.ticketRef);
  assert.strictEqual(ticket.status, 'done');
  const integration = ticket.submission.integration;
  assert.strictEqual(integration.outcome, 'abandoned');
  assert.strictEqual(integration.candidateState, 'unreachable', 'reachability was measured against the fallback target, not guessed');
  assert.strictEqual(integration.targetBranch, 'main', 'the board target stood in for the deleted branch');
  assert.strictEqual(integration.frozenTarget?.branch, 'pr/320', 'the frozen branch name is kept as evidence');
});

test('SQ-383: abandoning a candidate that did land on the remote target records it as already landed, measured against the remote', () => {
  const fixture = makeLandedFixture('abandon-landed-remote');
  // The candidate itself reaches origin/main, but local main never moves: only the remote knows.
  git(fixture.repo, ['push', 'origin', `${fixture.candidate}:refs/heads/main`]);
  assert.notStrictEqual(git(fixture.repo, ['rev-parse', 'refs/heads/main']), fixture.candidate);

  const closed = store.completeTicketAsControlPlane(fixture.slug, fixture.ticketRef, {
    purpose: 'grooming',
    abandonSubmission: true,
    by: 'groomer',
    reason: 'believed abandoned',
  });
  assert.strictEqual(closed.ok, true, JSON.stringify({ reason: closed.reason, message: closed.message }));
  const integration = store.getTicket(fixture.slug, fixture.ticketRef).submission.integration;
  assert.strictEqual(integration.outcome, 'delivered', 'shipped work is never written off as abandoned');
  assert.strictEqual(integration.mode, 'already-landed');
  assert.strictEqual(integration.resultingHead, originTip(fixture));
});

test('SQ-383: a delivery against a frozen target whose branch was deleted falls back to the board target and records the frozen one', () => {
  const fixture = makeLandedFixture('frozen-deleted-deliver');
  freezeOnDeletedPrBranch(fixture, 'pr/407');
  const squash = landDelivery(fixture);
  pushDelivery(fixture, squash);

  const closed = deliverClose(fixture, { deliveryCommit: squash });
  assert.strictEqual(closed.ok, true, JSON.stringify({ reason: closed.reason, message: closed.message }));
  const integration = store.getTicket(fixture.slug, fixture.ticketRef).submission.integration;
  assert.strictEqual(integration.deliveryCommit, squash);
  assert.strictEqual(integration.targetBranch, 'main');
  assert.strictEqual(integration.frozenTarget?.branch, 'pr/407');
});

// Squash on origin/main only; the canonical checkout on a chore branch that contains neither the
// squash nor local main's tip (so no local evidence can stand in for the remote).
function squashOnlyOnOriginWithCheckoutElsewhere(label: string) {
  const fixture = makeLandedFixture(label, CONTENT_VERIFY);
  git(fixture.repo, ['checkout', '-b', 'chore/map-refresh', fixture.base]);
  commitFile(fixture.repo, 'chore.txt', 'map refresh\n', 'chore: map refresh');
  git(fixture.repo, ['checkout', 'main']);
  const other = commitFile(fixture.repo, 'other.txt', 'unrelated main work\n', 'unrelated main work');
  git(fixture.repo, ['push', 'origin', 'main']);
  const squash = landDelivery(fixture);
  pushDelivery(fixture, squash);
  git(fixture.repo, ['checkout', 'chore/map-refresh']);
  git(fixture.repo, ['branch', '-f', 'main', other]);
  const head = checkoutHead(fixture);
  assert.throws(() => git(fixture.repo, ['merge-base', '--is-ancestor', squash, head]), 'fixture: the checkout does not carry the squash');
  assert.throws(() => git(fixture.repo, ['merge-base', '--is-ancestor', other, head]), 'fixture: the checkout does not carry local main');
  assert.strictEqual(originTip(fixture), squash);
  return { fixture, squash, head };
}

test('SQ-383: a manual delivery naming the squash closes when the squash is only on origin/main and the checkout is on another branch', () => {
  const { fixture, squash, head } = squashOnlyOnOriginWithCheckoutElsewhere('squash-origin-only');

  const closed = deliverClose(fixture, { deliveryCommit: squash, deliveryMethod: 'manual' });
  assert.strictEqual(closed.ok, true, JSON.stringify({ reason: closed.reason, message: closed.message }));

  const ticket = store.getTicket(fixture.slug, fixture.ticketRef);
  assert.strictEqual(ticket.status, 'done');
  const integration = ticket.submission.integration;
  assert.strictEqual(integration.deliveryCommit, squash);
  assert.strictEqual(integration.deliveryRevision.source, 'git:origin/main');
  assert.strictEqual(integration.resultingHead, squash, 'the recorded head is the remote tip, not the unrelated checkout');
  assert.strictEqual(integration.verify.status, 'passed');
  assert.strictEqual(checkoutHead(fixture), head, 'the checkout never moved');
  assert.strictEqual(checkoutStatus(fixture), '');
});

test('SQ-383: a manual delivery naming the pinned candidate closes from the squash on origin/main while the checkout is on another branch', () => {
  const { fixture, squash, head } = squashOnlyOnOriginWithCheckoutElsewhere('candidate-origin-only');

  const closed = deliverClose(fixture, { deliveryCommit: fixture.candidate, deliveryMethod: 'manual' });
  assert.strictEqual(closed.ok, true, JSON.stringify({ reason: closed.reason, message: closed.message }));

  const integration = store.getTicket(fixture.slug, fixture.ticketRef).submission.integration;
  assert.strictEqual(integration.deliveryIdentity.landingCommit, squash);
  assert.strictEqual(integration.contentCommit, squash);
  assert.strictEqual(integration.verify.status, 'passed', 'verified at the landing commit, not in the checkout that lacks the content');
  assert.strictEqual(checkoutHead(fixture), head);
  assert.strictEqual(checkoutStatus(fixture), '');
});

// main edits the THIRD line of the shared file while the candidate edits the FIRST; the forge
// squash merges both cleanly, so no commit on main ever holds the candidate's exact shared-file
// content, and the candidate is two commits, so the squash's combined patch-id matches neither
// candidate commit's either (the SQ-236 residual case).
function concurrentSharedEditSquash(label: string, squashEdit?: (repo: string) => void) {
  const fixture = makeLandedFixture(label, CONTENT_VERIFY, { sharedFile: true });
  git(fixture.repo, ['checkout', 'main']);
  commitFile(fixture.repo, SHARED_FILE, `${SHARED_BASE_LINES.map((line: string, index: number) => (index === 2 ? 'CHARLIE (main)' : line)).join('\n')}\n`, 'concurrent shared-file edit on main');
  git(fixture.repo, ['push', 'origin', 'main']);
  git(fixture.repo, ['merge', '--squash', fixture.candidate]);
  if (squashEdit) squashEdit(fixture.repo);
  git(fixture.repo, ['commit', '-m', `${fixture.ticketRef} forge squash`]);
  const squash = git(fixture.repo, ['rev-parse', 'HEAD']);
  pushDelivery(fixture, squash);
  const merged = fs.readFileSync(path.join(fixture.repo, SHARED_FILE), 'utf8');
  return { fixture, squash, merged };
}

test('SQ-383: a forge squash whose shared file merged a concurrent main edit is accepted as a forge-squash delivery', () => {
  const { fixture, squash, merged } = concurrentSharedEditSquash('forge-squash-shared');
  assert.match(merged, /^ALPHA \(candidate\)\n/);
  assert.match(merged, /\nCHARLIE \(main\)\n/);

  const closed = deliverClose(fixture, { deliveryCommit: squash });
  assert.strictEqual(closed.ok, true, JSON.stringify({ reason: closed.reason, message: closed.message }));

  const integration = store.getTicket(fixture.slug, fixture.ticketRef).submission.integration;
  assert.strictEqual(integration.deliveryCommit, squash);
  assert.strictEqual(integration.deliveryIdentity.kind, 'forge-squash');
  assert.deepStrictEqual(integration.deliveryIdentity.forgeSquash.mergedPaths, [SHARED_FILE]);
  assert.strictEqual(integration.contentEvidence, 'forge_squash_merge');
});

test('SQ-383: a manual delivery of the pinned candidate finds its forge squash on the target history despite the concurrent shared-file edit', () => {
  const { fixture, squash } = concurrentSharedEditSquash('forge-squash-candidate');

  const closed = deliverClose(fixture, { deliveryCommit: fixture.candidate, deliveryMethod: 'manual' });
  assert.strictEqual(closed.ok, true, JSON.stringify({ reason: closed.reason, message: closed.message }));

  const integration = store.getTicket(fixture.slug, fixture.ticketRef).submission.integration;
  assert.strictEqual(integration.deliveryIdentity.kind, 'forge-squash');
  assert.strictEqual(integration.deliveryIdentity.landingCommit, squash);
  assert.strictEqual(integration.verify.status, 'passed');
});

test('SQ-383: a squash that also carries an unsubmitted path is not a forge squash of the candidate', () => {
  const { fixture, squash } = concurrentSharedEditSquash('forge-squash-extra-path', (repo: string) => {
    fs.writeFileSync(path.join(repo, 'bonus.txt'), 'not part of the candidate\n');
    git(repo, ['add', 'bonus.txt']);
  });

  const closed = deliverClose(fixture, { deliveryCommit: squash });
  assert.strictEqual(closed.ok, false);
  assert.strictEqual(closed.reason, 'delivery_content_missing');
  assert.notStrictEqual(store.getTicket(fixture.slug, fixture.ticketRef).status, 'done');
});

test('SQ-383: a squash whose shared file is not the merge of the candidate onto its parent is refused', () => {
  const { fixture, squash } = concurrentSharedEditSquash('forge-squash-rewritten', (repo: string) => {
    const lines = fs.readFileSync(path.join(repo, SHARED_FILE), 'utf8').split('\n');
    lines[3] = 'DELTA (rewritten in the squash)';
    fs.writeFileSync(path.join(repo, SHARED_FILE), lines.join('\n'));
    git(repo, ['add', SHARED_FILE]);
  });

  const closed = deliverClose(fixture, { deliveryCommit: squash });
  assert.strictEqual(closed.ok, false);
  assert.strictEqual(closed.reason, 'delivery_content_missing');

  const manual = deliverClose(fixture, { deliveryCommit: fixture.candidate, deliveryMethod: 'manual' });
  assert.strictEqual(manual.ok, false);
  assert.strictEqual(manual.reason, 'delivery_content_missing');
  assert.notStrictEqual(store.getTicket(fixture.slug, fixture.ticketRef).status, 'done');
});
