import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';

// US-8 Q2: the awaiting-user park (story contract U1). A park is held by default (claim and
// worktree stay) and detaches to released on the 24 h abandon backstop, owner SessionEnd, a
// missing SendMessage, or release kind "question". A parked ticket is never ready or dispatchable.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-awaiting-user-test-'));
const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-awaiting-user-project-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
process.env.SIDEQUEST_CLAIM_TTL_MIN = '60';

const store = require('../lib/store.js');
const ql = require('../lib/store/question-log.js');

const { slug } = store.ensureProject(PROJECT_DIR);
for (const name of ['codebase-exploration', 'coding.normal']) {
  const category = store.getCategory(name);
  store.setCategory(Object.assign({}, category, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));
}
const QDIR = ql.questionLogDir(slug);
const COMMIT = 'abc1234def5678abc1234def5678abc1234def56';
const HOUR_MS = 60 * 60 * 1000;
let launches = 0;

function addTicket(title?: any, category = 'codebase-exploration') {
  return store.createTicket(slug, {
    title,
    description: 'Where: awaiting-user park fixture. Contract: park on a user question. Verify: inspect persisted board state.',
    category,
    files: ['lib/fixture.js'],
    source: 'cli',
  });
}

// A launched, bound and claimed dispatch, so markDispatchStopped finds the attempt by identity.
function launchAndClaim(ticket?: any) {
  const sessionId = `awaiting-user-${++launches}-${Date.now()}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId, sharedTree: false });
  const executor = prepared.ticket.dispatchExecutor;
  const by = `awaiting-user-worker-${ticket.id}`;
  assert.strictEqual(store.recordDispatchLaunch(slug, ticket.ref, { token: prepared.token, executor, sessionId, agentName: by }).ok, true);
  assert.strictEqual(store.bindDispatchAgent(sessionId, executor, by, by).ok, true);
  const claimed = store.claimTicket(slug, ticket.ref, by, { token: prepared.token, executor, source: 'mcp' });
  assert.strictEqual(claimed.ok, true, claimed.message);
  return { by, sessionId, executor };
}

function ask(ticket?: any, opts: any = {}) {
  const asked = ql.askQuestion(QDIR, {
    ref: ticket.ref,
    ticketId: ticket.id,
    header: 'Schema',
    text: opts.text || 'Which schema should the migration target?',
    blocking: true,
  });
  assert.strictEqual(asked.ok, true, asked.message);
  if (opts.sent !== false) assert.strictEqual(ql.recordSent(QDIR, { qid: asked.qid, to: 'main' }).ok, true);
  return asked;
}

function answer(ticket?: any, qid?: any, text = 'Use v2.') {
  const answered = ql.answerQuestion(QDIR, { ref: ticket.ref, question: qid, text });
  assert.strictEqual(answered.ok, true, answered.message);
}

function stopTurn(run?: any) {
  const stopped = store.markDispatchStopped(run.sessionId, run.executor, run.by, run.by);
  assert.strictEqual(stopped.ok, true, stopped.reason);
  return stopped;
}

function isReady(ticket?: any) {
  return store.readyTickets(slug).some((candidate: any) => candidate.ref === ticket.ref);
}

test('awaiting-user is a valid status that a manual status change cannot enter', () => {
  assert.ok(store.VALID_STATUS.includes('awaiting-user'));
  const ticket = addTicket('manual park refusal fixture');
  assert.throws(() => store.updateTicket(slug, ticket.ref, { status: 'awaiting-user' }), /awaiting-user/);
  assert.strictEqual(store.getTicket(slug, ticket.ref).status, 'todo');
  assert.throws(
    () => store.releaseTicket(slug, ticket.ref, 'anyone', { status: 'awaiting-user', source: 'mcp' }),
    /without kind "question"/,
  );
});

test('a turn end after a sent blocking question parks held: claim kept, never ready, dispatch and foreign claims refused, holder call resumes', () => {
  const ticket = addTicket('held park fixture');
  const run = launchAndClaim(ticket);
  const asked = ask(ticket);
  stopTurn(run);

  const parked = store.getTicket(slug, ticket.ref);
  assert.strictEqual(parked.status, 'awaiting-user');
  assert.strictEqual(parked.park.mode, 'held');
  assert.deepStrictEqual(parked.park.qids, [asked.qid]);
  assert.strictEqual(parked.claim.by, run.by, 'a held park keeps the claim');
  assert.ok(parked.comments.some((comment: any) => comment.body.includes(asked.qid)), 'the park comment names the qid');
  assert.strictEqual(isReady(ticket), false, 'an awaiting-user ticket is never ready');
  assert.throws(() => store.prepareDispatch(slug, ticket.ref, {}), /awaiting_user/);
  const foreign = store.claimTicket(slug, ticket.ref, 'someone-else', { direct: true, reason: 'Fixture: a foreign claim on a park.', source: 'cli' });
  assert.strictEqual(foreign.ok, false);
  assert.strictEqual(foreign.reason, 'awaiting_user');

  const pulse = JSON.stringify(store.pulsePayload(slug, ticket.ref));
  assert.match(pulse, /"questions":\{"open":1,"oldest":"[^"]+"\}/);
  assert.match(pulse, /"mode":"held"/);

  store.addComment(slug, ticket.id, { by: run.by, kind: 'comment', source: 'mcp', body: 'Resuming on my held claim.' });
  const resumed = store.getTicket(slug, ticket.ref);
  assert.strictEqual(resumed.status, 'doing');
  assert.strictEqual(resumed.park, undefined);
  assert.strictEqual(resumed.claim.by, run.by);
});

test('answering the last open blocking question unparks a held park to doing with its claim intact', () => {
  const ticket = addTicket('held unpark fixture');
  const run = launchAndClaim(ticket);
  const first = ask(ticket);
  const second = ask(ticket, { text: 'Which region should it deploy to?' });
  stopTurn(run);
  assert.deepStrictEqual(store.getTicket(slug, ticket.ref).park.qids.sort(), [first.qid, second.qid].sort());

  answer(ticket, first.qid);
  const partial = store.unparkTicket(slug, ticket.ref);
  assert.strictEqual(partial.unparked, false);
  assert.strictEqual(partial.reason, 'questions_open');
  assert.deepStrictEqual(partial.open, [second.qid]);

  answer(ticket, second.qid, 'eu-west');
  const unparked = store.unparkTicket(slug, ticket.ref, { detail: 'Both questions answered.' });
  assert.strictEqual(unparked.unparked, true);
  assert.strictEqual(unparked.status, 'doing');
  const after = store.getTicket(slug, ticket.ref);
  assert.strictEqual(after.claim.by, run.by);
  assert.strictEqual(after.park, undefined);
});

test('a turn end on an asked but unsent question detaches to a released park that unparks to todo', () => {
  const ticket = addTicket('unsent park fixture');
  const run = launchAndClaim(ticket);
  const asked = ask(ticket, { sent: false });
  stopTurn(run);

  const parked = store.getTicket(slug, ticket.ref);
  assert.strictEqual(parked.status, 'awaiting-user');
  assert.strictEqual(parked.park.mode, 'released');
  assert.strictEqual(parked.park.detach, 'no_send_message');
  assert.ok(!parked.claim || !parked.claim.by, 'a released park has given up its claim');
  assert.strictEqual(isReady(ticket), false);

  answer(ticket, asked.qid);
  const unparked = store.unparkTicket(slug, ticket.ref);
  assert.strictEqual(unparked.status, 'todo');
  assert.strictEqual(isReady(ticket), true, 'a released park returns to the ready pool once answered');
});

test('a held park ignores idle silence until the 24 h backstop, and owner SessionEnd detaches it to released', () => {
  const ticket = addTicket('held backstop fixture');
  const run = launchAndClaim(ticket);
  ask(ticket);
  stopTurn(run);
  const parked = store.getTicket(slug, ticket.ref);
  assert.strictEqual(parked.park.mode, 'held');

  assert.strictEqual(store.claimReleaseVerdict(parked, Date.now() + 23 * HOUR_MS), null);
  const verdict = store.claimReleaseVerdict(parked, Date.now() + 25 * HOUR_MS);
  assert.strictEqual(verdict.kind, 'abandoned');
  assert.match(verdict.reason, /held awaiting-user park passed the 24 h abandon backstop/);

  const released = store.releaseTicket(slug, ticket.ref, run.by, {
    status: 'todo',
    source: 'session-end',
    claimRelease: { kind: 'session_ended', reason: 'the owning session ended' },
  });
  assert.strictEqual(released.ok, true, released.message);
  const detached = store.getTicket(slug, ticket.ref);
  assert.strictEqual(detached.status, 'awaiting-user', 'SessionEnd keeps the ticket parked, not todo');
  assert.strictEqual(detached.park.mode, 'released');
  assert.strictEqual(detached.park.detach, 'session_ended');
  assert.strictEqual(detached.park.parkedAt, parked.park.parkedAt, 'the park keeps its original start');
  assert.ok(!detached.claim || !detached.claim.by);
});

test('release kind question parks released and refuses a missing question, a non-holder, and an unpinned writable dispatch', () => {
  const ticket = addTicket('question release fixture', 'coding.normal');
  const run = launchAndClaim(ticket);
  const parkArgs = { status: 'awaiting-user', releaseKind: 'question', source: 'mcp' };

  const none = store.releaseTicket(slug, ticket.ref, run.by, parkArgs);
  assert.strictEqual(none.ok, false);
  assert.strictEqual(none.reason, 'no_open_question');

  const asked = ask(ticket);
  const foreign = store.releaseTicket(slug, ticket.ref, 'someone-else', parkArgs);
  assert.strictEqual(foreign.ok, false);
  assert.strictEqual(store.getTicket(slug, ticket.ref).claim.by, run.by);

  const unpinned = store.releaseTicket(slug, ticket.ref, run.by, parkArgs);
  assert.strictEqual(unpinned.ok, false);
  assert.strictEqual(unpinned.reason, 'checkpoint_required');

  const checkpoint = store.checkpointTicket(slug, ticket.ref, run.by, { commit: COMMIT, verify: 'focused: 3 passed, 0 failed', ttlMinutes: 15, source: 'mcp' });
  assert.strictEqual(checkpoint.ok, true, checkpoint.message);
  const parked = store.releaseTicket(slug, ticket.ref, run.by, parkArgs);
  assert.strictEqual(parked.ok, true, parked.message);
  const after = store.getTicket(slug, ticket.ref);
  assert.strictEqual(after.status, 'awaiting-user');
  assert.strictEqual(after.park.mode, 'released');
  assert.strictEqual(after.park.detach, 'question');
  assert.deepStrictEqual(after.park.qids, [asked.qid]);
  assert.ok(!after.claim || !after.claim.by);
  assert.strictEqual(ql.openQuestions(QDIR, { ref: ticket.ref }).length, 1, 'the question stays open for the user');
});

test('handing a claim back to todo withdraws the questions it asked instead of parking', () => {
  const ticket = addTicket('withdraw on handback fixture');
  const run = launchAndClaim(ticket);
  ask(ticket);
  const released = store.releaseTicket(slug, ticket.ref, run.by, { status: 'todo', source: 'mcp' });
  assert.strictEqual(released.ok, true, released.message);
  const after = store.getTicket(slug, ticket.ref);
  assert.strictEqual(after.status, 'todo');
  assert.strictEqual(after.park, undefined);
  assert.strictEqual(ql.openQuestions(QDIR, { ref: ticket.ref }).length, 0);
});
