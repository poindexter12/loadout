import './_temp-cleanup.js';
'use strict';
/**
 * SQ-275: refusal guidance for the two landedness refusal codes recordDeliveredSubmission can
 * return on a remote-mode board. `landed_remote_unavailable` must tell the caller the remote
 * is unreachable, name it and the branch, and say there is no local fallback. `delivery_not_reachable`
 * must name the live tip it checked against and must NOT claim any local ref as proof the commit
 * landed (checkout HEAD, a local branch, or refs/remotes are never consulted for landedness).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-landed-guidance-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const landedAuthority = require('../lib/store/landed-authority.js');
const {
  makeLandedFixture,
  landDelivery,
  pushDelivery,
  makeOriginUnreachable,
} = require('./_landed-delivery-fixture.js');

function deliver(fixture: any, deliveryCommit: string, reason: string, overrides: any = {}) {
  return store.recordDeliveredSubmission(fixture.slug, fixture.ticketRef, Object.assign({
    target: store.integrationTarget(fixture.slug),
    deliveryCommit,
    reason,
  }, overrides));
}

test('SQ-275: landedRemoteUnavailableMessage (landed-authority.ts) names the remote, refs/heads/<branch>, no local fallback, and tells the caller to restore network access', () => {
  const message = landedAuthority.landedRemoteUnavailableMessage('SQ-9', 'origin', 'main', 'could not resolve host');
  assert.match(message, /origin/);
  assert.match(message, /refs\/heads\/main/);
  assert.match(message, /no local fallback/i);
  assert.match(message, /restore network access/i);
});

test('SQ-275: the actual landed_remote_unavailable refusal from recordDeliveredSubmission carries the same guidance', () => {
  const fixture = makeLandedFixture('guidance-unreachable');
  const delivery = landDelivery(fixture);
  makeOriginUnreachable(fixture);

  const result = deliver(fixture, delivery, 'origin cannot be contacted right now');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'landed_remote_unavailable');
  assert.match(result.message, /origin/);
  assert.match(result.message, /refs\/heads\/main/);
  assert.match(result.message, /no local fallback/i);
  assert.match(result.message, /restore network access/i);
});

test('SQ-275: the delivery_not_reachable message names the live tip and does not claim local refs as proof', () => {
  const fixture = makeLandedFixture('guidance-not-reachable');
  const delivery = landDelivery(fixture);
  // Push a DIFFERENT commit to origin/main so there is a live tip to name, but it is not the
  // delivery commit; the checkout and a local branch genuinely hold the delivery commit anyway.
  pushDelivery(fixture, fixture.base);

  const liveTip = require('node:child_process').execFileSync('git', ['ls-remote', fixture.origin, 'refs/heads/main'], { encoding: 'utf8' }).split(/\s+/)[0];
  assert.notStrictEqual(liveTip, delivery);

  const result = deliver(fixture, delivery, 'the checkout has it, but the live tip does not');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'delivery_not_reachable');
  assert.match(result.message, new RegExp(liveTip), 'names the live tip it actually checked against');
  assert.doesNotMatch(result.message, /refs\/remotes/i, 'never cites refs/remotes as proof');
  assert.doesNotMatch(result.message, /checkout'?s? HEAD is (proof|evidence)/i);
  assert.match(result.message, /not consulted|no local fallback|never consulted/i, 'says local evidence was not what decided this');
});
