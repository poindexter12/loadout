import './_temp-cleanup.js';
'use strict';
/**
 * SQ-275: recording one landed delivery commit against a GROUP of two tickets (a squash-landed
 * wave of two candidates) must apply the same remote-only landedness decision to each ref
 * independently — both close when the remote carries the commit, and neither closes when it
 * does not, even though local main genuinely holds it in both cases.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-landed-delivery-group-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const {
  makeLandedFixture,
  addTicket,
  landDeliveryMulti,
  pushDelivery,
  checkoutHead,
} = require('./_landed-delivery-fixture.js');

function deliver(fixture: any, ref: string, deliveryCommit: string, reason: string) {
  return store.recordDeliveredSubmission(fixture.slug, ref, {
    target: store.integrationTarget(fixture.slug),
    deliveryCommit,
    reason,
  });
}

test('SQ-275: a group of two refs both close from one shared landed commit when origin carries it', () => {
  const fixture = makeLandedFixture('group-happy');
  const second = addTicket(fixture, 'group-happy-second');
  const delivery = landDeliveryMulti(fixture, [fixture.candidate, second.candidate]);
  pushDelivery(fixture, delivery);
  assert.strictEqual(checkoutHead(fixture), delivery);

  const first = deliver(fixture, fixture.ticketRef, delivery, 'group squash-landed commit reached origin/main');
  assert.strictEqual(first.ok, true, first.message);
  const closedFirst = store.completeTicketAsControlPlane(fixture.slug, fixture.ticketRef, {
    by: 'landed-delivery-group-happy',
    reason: first.integration.evidence,
    purpose: 'integration',
  });
  assert.strictEqual(closedFirst.ok, true, closedFirst.message);
  assert.strictEqual(closedFirst.ticket.status, 'done');

  const secondResult = deliver(fixture, second.ref, delivery, 'group squash-landed commit reached origin/main');
  assert.strictEqual(secondResult.ok, true, secondResult.message);
  const closedSecond = store.completeTicketAsControlPlane(fixture.slug, second.ref, {
    by: 'landed-delivery-group-happy',
    reason: secondResult.integration.evidence,
    purpose: 'integration',
  });
  assert.strictEqual(closedSecond.ok, true, closedSecond.message);
  assert.strictEqual(closedSecond.ticket.status, 'done');
});

test('SQ-275: a group of two refs both refuse from one shared landed commit when origin never received it, even though local main does', () => {
  const fixture = makeLandedFixture('group-refuse');
  const second = addTicket(fixture, 'group-refuse-second');
  const delivery = landDeliveryMulti(fixture, [fixture.candidate, second.candidate]);
  // deliberately never pushed: local `main` (checked out) genuinely holds `delivery`, origin does not.
  assert.strictEqual(checkoutHead(fixture), delivery);

  const first = deliver(fixture, fixture.ticketRef, delivery, 'local main has it, origin/main was never pushed');
  assert.strictEqual(first.ok, false);
  assert.strictEqual(first.reason, 'delivery_not_reachable');
  const firstTicket = store.getTicket(fixture.slug, fixture.ticketRef);
  assert.notStrictEqual(firstTicket.status, 'done');

  const secondResult = deliver(fixture, second.ref, delivery, 'local main has it, origin/main was never pushed');
  assert.strictEqual(secondResult.ok, false);
  assert.strictEqual(secondResult.reason, 'delivery_not_reachable');
  const secondTicket = store.getTicket(fixture.slug, second.ref);
  assert.notStrictEqual(secondTicket.status, 'done');
});
