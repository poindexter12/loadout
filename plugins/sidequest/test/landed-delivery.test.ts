import './_temp-cleanup.js';
'use strict';
/**
 * SQ-275: recordDeliveredSubmission's landedness, on a remote-mode board, is decided
 * ONLY by the remote's live advertisement (landed-authority.ts's proveLandedOnRemote),
 * never by any local ref. These tests build real local evidence (checkout HEAD, a local
 * branch, or a stale refs/remotes/origin/<branch>) that genuinely contains the delivery
 * commit, specifically so a refusal only passes when the remote's live state, and nothing
 * local, is what decided it — the trap earlier ad-hoc fixtures missed by always parking
 * the checkout away from the commit.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-landed-delivery-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const {
  nodeVerify,
  makeLandedFixture,
  landDelivery,
  pushDelivery,
  fetchOrigin,
  forceOriginAway,
  makeOriginUnreachable,
  remoteTrackingTip,
  checkoutStatus,
  checkoutHead,
  worktreeList,
} = require('./_landed-delivery-fixture.js');

function deliver(fixture: any, deliveryCommit: string, reason: string, overrides: any = {}) {
  return store.recordDeliveredSubmission(fixture.slug, fixture.ticketRef, Object.assign({
    target: store.integrationTarget(fixture.slug),
    deliveryCommit,
    reason,
  }, overrides));
}

test('SQ-275: a stale refs/remotes/origin/main that still holds the commit does not save a delivery the live tip moved past', () => {
  const fixture = makeLandedFixture('tip-moved-past');
  const delivery = landDelivery(fixture);
  pushDelivery(fixture, delivery);
  fetchOrigin(fixture);
  assert.strictEqual(remoteTrackingTip(fixture), delivery, 'refs/remotes/origin/main caught up to the delivery commit');

  forceOriginAway(fixture);
  assert.strictEqual(remoteTrackingTip(fixture), delivery, 'refs/remotes/origin/main stays stale; nothing re-fetched it');

  const result = deliver(fixture, delivery, 'origin moved past the delivery commit after this clone cached it');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'delivery_not_reachable');

  const ticket = store.getTicket(fixture.slug, fixture.ticketRef);
  assert.notStrictEqual(ticket.status, 'done');
  assert.ok(!ticket.submission?.integration || ticket.submission.integration.outcome !== 'delivered');
});

test('SQ-275: an unreachable remote refuses even though the checkout on main genuinely holds the commit', () => {
  const fixture = makeLandedFixture('remote-unreachable');
  const delivery = landDelivery(fixture);
  assert.strictEqual(checkoutHead(fixture), delivery, 'the checkout really is parked on the delivery commit');

  makeOriginUnreachable(fixture);

  const result = deliver(fixture, delivery, 'origin cannot be contacted right now');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'landed_remote_unavailable');
  assert.match(result.message, /origin/);
  assert.match(result.message, /main/);
  assert.match(result.message, /no local fallback/i);

  const ticket = store.getTicket(fixture.slug, fixture.ticketRef);
  assert.notStrictEqual(ticket.status, 'done');
});

test('SQ-275: checkout on main genuinely holds the commit but origin/main never received it, so delivery refuses', () => {
  const fixture = makeLandedFixture('checkout-only');
  const delivery = landDelivery(fixture);
  assert.strictEqual(checkoutHead(fixture), delivery, 'the checkout really is parked on the delivery commit');
  // deliberately never pushed

  const result = deliver(fixture, delivery, 'the checkout has it, but origin/main was never pushed');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'delivery_not_reachable');

  const ticket = store.getTicket(fixture.slug, fixture.ticketRef);
  assert.notStrictEqual(ticket.status, 'done');
});

test('SQ-275: a non-default local branch genuinely holds the commit but origin does not, so delivery refuses', () => {
  const fixture = makeLandedFixture('side-branch-only');
  const delivery = landDelivery(fixture, { branch: 'side-branch', from: 'main' });
  assert.strictEqual(checkoutHead(fixture), delivery, 'the side branch really does hold the delivery commit');
  // deliberately never pushed; `main` itself never received it either

  const result = deliver(fixture, delivery, 'a side branch has it, but origin/main does not');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'delivery_not_reachable');

  const ticket = store.getTicket(fixture.slug, fixture.ticketRef);
  assert.notStrictEqual(ticket.status, 'done');
});

test('SQ-275: a delivery commit pushed to origin/main closes, names the live tip as its revision, and verifies in a detached scratch worktree', () => {
  const pwdFile = path.join(os.tmpdir(), `sq-landed-happy-pwd-${process.pid}-${Date.now()}.txt`);
  const verify = nodeVerify(`require('fs').writeFileSync('${pwdFile}', process.cwd())`);
  const fixture = makeLandedFixture('happy-path', verify);
  const delivery = landDelivery(fixture);
  pushDelivery(fixture, delivery);
  const liveTip = require('node:child_process').execFileSync('git', ['ls-remote', fixture.origin, 'refs/heads/main'], { encoding: 'utf8' }).split(/\s+/)[0];
  assert.strictEqual(liveTip, delivery);

  const headBefore = checkoutHead(fixture);
  const statusBefore = checkoutStatus(fixture);
  const worktreesBefore = worktreeList(fixture);

  const result = deliver(fixture, delivery, 'origin/main carries the squash-landed delivery commit');
  assert.strictEqual(result.ok, true, result.message);
  assert.strictEqual(result.integration.deliveryRevision.source, 'git:origin/main');
  assert.strictEqual(result.integration.deliveryRevision.value, liveTip);
  assert.strictEqual(result.integration.verify.status, 'passed', JSON.stringify(result.integration.verify));

  const closed = store.completeTicketAsControlPlane(fixture.slug, fixture.ticketRef, {
    by: 'landed-delivery-happy-path',
    reason: result.integration.evidence,
    purpose: 'integration',
  });
  assert.strictEqual(closed.ok, true, closed.message);
  assert.strictEqual(closed.ticket.status, 'done');

  assert.ok(fs.existsSync(pwdFile), 'the verify command ran and wrote its cwd');
  const verifyCwd = fs.readFileSync(pwdFile, 'utf8').trim();
  assert.notStrictEqual(verifyCwd, fixture.repo, 'verification did not run with cwd in the user checkout');
  assert.match(verifyCwd, /sq-delivery-verify-/, 'verification ran in the detached scratch worktree');

  assert.strictEqual(checkoutHead(fixture), headBefore, 'the checkout HEAD is unchanged');
  assert.strictEqual(checkoutStatus(fixture), statusBefore, 'the checkout working tree is unchanged');
  assert.strictEqual(worktreeList(fixture), worktreesBefore, 'no leftover scratch worktree was left registered');
});

test('SQ-275: a wave branch merged into main and deleted still accepts delivery from main (SQ-158 regression guard)', () => {
  const fixture = makeLandedFixture('sq158-regression-guard');
  const waveBranch = 'sidequest/wave/sq158-regression-guard';
  const wave = path.join(os.tmpdir(), `sq-landed-wave-${process.pid}-${Date.now()}`);
  const git = (args: string[]) => require('node:child_process').execFileSync('git', args, { cwd: fixture.repo, encoding: 'utf8', windowsHide: true }).trim();

  git(['worktree', 'add', '-b', waveBranch, wave, fixture.candidate]);
  git(['checkout', 'main']);
  git(['merge', '--ff-only', waveBranch]);
  const mainHead = git(['rev-parse', 'HEAD']);
  git(['worktree', 'remove', '--force', wave]);
  git(['branch', '-D', waveBranch]);

  const delivered = store.recordDeliveredSubmission(fixture.slug, fixture.ticketRef, {
    target: { mode: 'local', branch: waveBranch, upstream: waveBranch },
    deliveryCommit: mainHead,
    deliveryMethod: 'manual',
    reason: 'SQ-158 regression guard: the wave branch merged into main and was deleted; recording from main.',
  });
  assert.strictEqual(delivered.ok, true, delivered.message);
  assert.notStrictEqual(delivered.reason, 'branch_not_checked_out');
  assert.strictEqual(delivered.integration.deliveryCommit, mainHead);
  assert.strictEqual(delivered.integration.targetBranch, waveBranch);
  assert.strictEqual(delivered.integration.resultingHead, mainHead);
});
