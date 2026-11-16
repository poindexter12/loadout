import './_temp-cleanup.js';
'use strict';
/**
 * SQ-400 (confirmed by SQ-399): abandoning a pending submission on a remote-mode board must not
 * decide landedness from the local remote-tracking ref when the remote cannot be reached. The
 * abandon path used to fall back to refs/remotes/<remote>/<branch>, so a candidate that was
 * pushed, then force-reset away on origin, then made unreachable was recorded as an
 * `already-landed` delivery (source `git-tracking:origin/main`) and the ticket closed `done`.
 *
 * The abandon path now refuses with `landed_remote_unavailable` and writes nothing, exactly as
 * the delivery path does. Reachable-remote abandonment and local-mode boards are unchanged.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-abandon-remote-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const {
  makeLandedFixture,
  pushDelivery,
  fetchOrigin,
  forceOriginAway,
  makeOriginUnreachable,
  originTip,
  remoteTrackingTip,
} = require('./_landed-delivery-fixture.js');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function abandonClose(fixture: any) {
  return store.completeTicketAsControlPlane(fixture.slug, fixture.ticketRef, {
    purpose: 'grooming',
    abandonSubmission: true,
    by: 'groomer',
    reason: 'SQ-400 fixture: believed never landed',
  });
}

function snapshot(fixture: any) {
  return JSON.stringify(store.getTicket(fixture.slug, fixture.ticketRef));
}

test('SQ-400: an unreachable remote refuses abandonment even though the stale tracking ref still holds the candidate', () => {
  const fixture = makeLandedFixture('sq400-stale-tracking');
  pushDelivery(fixture, fixture.candidate);
  fetchOrigin(fixture);
  assert.strictEqual(remoteTrackingTip(fixture), fixture.candidate, 'fixture: the tracking ref caught up to the pushed candidate');
  forceOriginAway(fixture);
  assert.notStrictEqual(originTip(fixture), fixture.candidate, 'fixture: origin was force-reset onto a different history');
  assert.throws(() => git(fixture.origin, ['merge-base', '--is-ancestor', fixture.candidate, originTip(fixture)]), 'fixture: the candidate is genuinely not on origin');
  assert.strictEqual(remoteTrackingTip(fixture), fixture.candidate, 'fixture: the stale tracking ref still holds the candidate');
  makeOriginUnreachable(fixture);
  const before = snapshot(fixture);

  const closed = abandonClose(fixture);

  assert.strictEqual(closed.ok, false, 'abandonment must refuse while the remote cannot answer');
  assert.strictEqual(closed.reason, 'landed_remote_unavailable');
  assert.strictEqual(closed.remote, 'origin');
  assert.strictEqual(closed.branch, 'main');
  assert.match(String(closed.message), /abandon/i, 'the refusal names the abandonment it refused');
  assert.match(String(closed.message), /refs\/remotes\/origin\/main/, 'the refusal says the tracking ref is never consulted');
  assert.strictEqual(snapshot(fixture), before, 'a refused abandonment writes nothing to the ticket');
  const after = store.getTicket(fixture.slug, fixture.ticketRef);
  assert.notStrictEqual(after.status, 'done');
  assert.ok(!after.submission.integratedAt, 'the submission is still pending');
  assert.ok(!after.submission.integration, 'no integration outcome was recorded');
  assert.strictEqual(remoteTrackingTip(fixture), fixture.candidate, 'the tracking ref is left exactly as it was');
});

test('SQ-400: an unreachable remote refuses abandonment of a candidate the tracking ref never held', () => {
  const fixture = makeLandedFixture('sq400-never-pushed');
  makeOriginUnreachable(fixture);
  const before = snapshot(fixture);

  const closed = abandonClose(fixture);

  assert.strictEqual(closed.ok, false);
  assert.strictEqual(closed.reason, 'landed_remote_unavailable');
  assert.strictEqual(snapshot(fixture), before, 'a refused abandonment writes nothing to the ticket');
});

test('SQ-400: with the remote reachable, a candidate origin moved away from is still recorded abandoned', () => {
  const fixture = makeLandedFixture('sq400-reachable-abandon');
  pushDelivery(fixture, fixture.candidate);
  fetchOrigin(fixture);
  forceOriginAway(fixture);
  assert.strictEqual(remoteTrackingTip(fixture), fixture.candidate, 'fixture: the stale tracking ref still holds the candidate');

  const closed = abandonClose(fixture);

  assert.strictEqual(closed.ok, true, JSON.stringify(closed));
  assert.strictEqual(closed.ticket.status, 'done');
  const integration = closed.ticket.submission.integration;
  assert.strictEqual(integration.mode, 'abandoned');
  assert.strictEqual(integration.outcome, 'abandoned');
  assert.strictEqual(integration.candidateState, 'unreachable');
  assert.strictEqual(integration.candidateStateSource, 'git:origin/main');
});

test('SQ-400: with the remote reachable, a candidate on the live tip is still recorded delivered', () => {
  const fixture = makeLandedFixture('sq400-reachable-landed');
  pushDelivery(fixture, fixture.candidate);

  const closed = abandonClose(fixture);

  assert.strictEqual(closed.ok, true, JSON.stringify(closed));
  const integration = closed.ticket.submission.integration;
  assert.strictEqual(integration.mode, 'already-landed');
  assert.strictEqual(integration.outcome, 'delivered');
  assert.strictEqual(integration.deliveryRevision.source, 'git:origin/main');
  assert.strictEqual(integration.deliveryRevision.value, fixture.candidate);
});

test('SQ-400: a local-mode board (no remote) still abandons against its local branch', () => {
  const fixture = makeLandedFixture('sq400-local-abandon');
  git(fixture.repo, ['remote', 'remove', 'origin']);

  const closed = abandonClose(fixture);

  assert.strictEqual(closed.ok, true, JSON.stringify(closed));
  const integration = closed.ticket.submission.integration;
  assert.strictEqual(integration.mode, 'abandoned');
  assert.strictEqual(integration.candidateState, 'unreachable');
  assert.strictEqual(integration.candidateStateSource, 'git:main');
});

test('SQ-400: a local-mode board (no remote) still records a candidate on its local branch as delivered', () => {
  const fixture = makeLandedFixture('sq400-local-landed');
  git(fixture.repo, ['remote', 'remove', 'origin']);
  git(fixture.repo, ['merge', '--ff-only', fixture.candidate]);

  const closed = abandonClose(fixture);

  assert.strictEqual(closed.ok, true, JSON.stringify(closed));
  const integration = closed.ticket.submission.integration;
  assert.strictEqual(integration.mode, 'already-landed');
  assert.strictEqual(integration.outcome, 'delivered');
  assert.strictEqual(integration.deliveryRevision.source, 'git:main');
});
