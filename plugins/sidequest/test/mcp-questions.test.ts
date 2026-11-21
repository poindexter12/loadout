'use strict';
// US-8 Q4 (SQ-418): the ask and answer board tools. Each records into the question log and returns
// the SendMessage the model must make, because this server cannot send one. An answer the executor
// has not yet received rides on its next board-tool reply, once per aid. pulse({ref}) carries the
// open questions' full text. Release kind question parks the ticket released on its open questions.
import {
  test,
  assert,
  os,
  path,
  fs,
  store,
  callTool,
} from './_mcp-fixture.js';

const ql = require('../lib/store/question-log.js');
const { ANSWER_RULE, ASK_INSTRUCTION } = require('../lib/mcp-questions.js');

const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-questions-project-'));
const project = store.ensureProject(PROJECT_DIR).slug;
for (const name of ['codebase-exploration', 'coding.normal']) {
  const category = store.getCategory(name);
  store.setCategory(Object.assign({}, category, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));
}
const QDIR = ql.questionLogDir(project);
let launches = 0;

function addTicket(title: string) {
  return store.createTicket(project, {
    title,
    description: 'Where: MCP question tool fixture. Contract: ask and answer through the board tools. Verify: inspect replies and the question log.',
    category: 'codebase-exploration',
    files: ['lib/fixture.js'],
    source: 'cli',
  });
}

// A launched, bound and claimed dispatch: the agent name is the reply-to the ask message carries,
// and markDispatchStopped can find the attempt by identity to park it.
function launchAndClaim(ticket: any) {
  const sessionId = `mcp-questions-${++launches}-${Date.now()}`;
  const prepared = store.prepareDispatch(project, ticket.ref, { sessionId, sharedTree: false });
  const executor = prepared.ticket.dispatchExecutor;
  const by = `mcp-questions-worker-${ticket.id}`;
  const agentName = `sq-${ticket.ref.toLowerCase()}-agent`;
  assert.strictEqual(store.recordDispatchLaunch(project, ticket.ref, { token: prepared.token, executor, sessionId, agentName }).ok, true);
  assert.strictEqual(store.bindDispatchAgent(sessionId, executor, by, agentName).ok, true);
  const claimed = store.claimTicket(project, ticket.ref, by, { token: prepared.token, executor, source: 'mcp' });
  assert.strictEqual(claimed.ok, true, claimed.message);
  return { by, sessionId, executor, agentName };
}

async function ask(ticket: any, run: any, extra: any = {}) {
  return callTool('ask', Object.assign({
    project,
    ref: ticket.ref,
    by: run.by,
    header: 'Schema',
    question: 'Which schema should the migration target?',
    options: [{ label: 'v1', description: 'Keep the current shape' }, { label: 'v2' }],
    default: 'Target v2.',
  }, extra));
}

test('ask by the claim holder records the question without a board write and returns the SendMessage to make', async () => {
  const ticket = addTicket('ask records and returns the send');
  const run = launchAndClaim(ticket);
  const before = store.getTicket(project, ticket.ref);

  const asked = await ask(ticket, run, { question: 'Which schema should the migration target?\nThe v1 shape drops two columns.' });
  assert.strictEqual(asked.ok, true, asked.message);
  assert.ok(ql.isQuestionId(asked.qid));
  assert.strictEqual(asked.seq, 'Q1');
  assert.strictEqual(asked.status, 'doing');
  assert.strictEqual(asked.instruction, ASK_INSTRUCTION);
  assert.strictEqual(asked.send.to, 'main');
  assert.strictEqual(asked.send.summary, `${ticket.ref} Q1 needs the user`);
  const lines = asked.send.message.split('\n');
  assert.strictEqual(lines[0], `${ticket.ref} Q1 needs a user decision: Schema: Which schema should the migration target?`);
  assert.strictEqual(lines[1], `[sidequest:question ${ticket.ref} Q1 qid=${asked.qid} blocking=y reply-to=${run.agentName}]`);
  assert.strictEqual(lines[2], '1) v1: Keep the current shape 2) v2');
  assert.strictEqual(lines[3], `Full text: pulse({ref:"${ticket.ref}"}) questions.items.`);
  assert.strictEqual(lines[4], 'Default if unanswered: Target v2.');
  assert.strictEqual(lines[5], `Record with answer({ref:"${ticket.ref}", question:"${asked.qid}"}).`);

  const open = ql.openQuestions(QDIR, { ref: ticket.ref });
  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].asked.agent, run.agentName);
  assert.strictEqual(open[0].asked.ownerSession, run.sessionId, 'the spawning session routes the question');
  assert.strictEqual(open[0].asked.blocking, true, 'a question blocks by default');
  const after = store.getTicket(project, ticket.ref);
  assert.strictEqual(after.status, before.status);
  assert.strictEqual(after.comments.length, before.comments.length, 'ask writes no board comment');
});

test('ask refuses a non-holder, a missing default and an out-of-range option list, recording nothing', async () => {
  const ticket = addTicket('ask refusals');
  const run = launchAndClaim(ticket);

  const foreign = await ask(ticket, { by: 'someone-else' });
  assert.strictEqual(foreign.ok, false);
  assert.strictEqual(foreign.reason, 'not_claimed');
  assert.match(foreign.message, /Only the executor holding .* claim may ask/);

  const noDefault = await ask(ticket, run, { default: '  ' });
  assert.strictEqual(noDefault.ok, false);
  assert.strictEqual(noDefault.reason, 'default_empty');
  assert.strictEqual(noDefault.field, 'default');

  const oneOption = await ask(ticket, run, { options: [{ label: 'only' }] });
  assert.strictEqual(oneOption.ok, false);
  assert.strictEqual(oneOption.reason, 'options_out_of_range', 'the question log refusal passes through');

  assert.strictEqual(ql.openQuestions(QDIR, { ref: ticket.ref }).length, 0);
});

test('ask withdraw closes one question and refuses anything that is not a qid with the open list', async () => {
  const ticket = addTicket('ask withdraw');
  const run = launchAndClaim(ticket);
  const asked = await ask(ticket, run);

  const bogus = await callTool('ask', { project, ref: ticket.ref, by: run.by, withdraw: 'Q1' });
  assert.strictEqual(bogus.ok, false);
  assert.strictEqual(bogus.reason, 'no_such_question');
  assert.deepStrictEqual(bogus.open, [asked.qid]);

  const withdrawn = await callTool('ask', { project, ref: ticket.ref, by: run.by, withdraw: asked.qid });
  assert.strictEqual(withdrawn.ok, true, withdrawn.message);
  assert.strictEqual(ql.openQuestions(QDIR, { ref: ticket.ref }).length, 0);
});

test('answer refuses the claim holder answering its own question and leaves the question open', async () => {
  const ticket = addTicket('self answer refusal');
  const run = launchAndClaim(ticket);
  const asked = await ask(ticket, run);

  const self = await callTool('answer', { project, ref: ticket.ref, question: asked.qid, text: 'Use v2.', by: run.by });
  assert.strictEqual(self.ok, false);
  assert.strictEqual(self.reason, 'self_answer');
  assert.strictEqual(ql.findQuestion(QDIR, asked.qid).state, 'open');
});

test('answer to a live claim returns the SendMessage to the executor, and the answer rides once on its next board reply', async () => {
  const ticket = addTicket('answer piggyback');
  const run = launchAndClaim(ticket);
  const asked = await ask(ticket, run, { blocking: false });

  const answered = await callTool('answer', { project, ref: ticket.ref, text: 'Use v2.\nKeep the old columns nullable.', by: 'orchestrator-main' });
  assert.strictEqual(answered.ok, true, answered.message);
  assert.strictEqual(answered.qid, asked.qid, 'question defaults to the oldest open qid');
  assert.strictEqual(answered.send.to, run.agentName);
  const lines = answered.send.message.split('\n');
  assert.strictEqual(lines[0], `Answer for ${ticket.ref} Q1: Use v2.`);
  assert.strictEqual(lines[1], `[sidequest:answer ${ticket.ref} Q1 qid=${asked.qid} aid=${answered.aid}]`);
  assert.ok(answered.send.message.includes('Keep the old columns nullable.'));
  assert.strictEqual(lines[lines.length - 1], ANSWER_RULE, 'every answer restates that it is never a grant');
  assert.match(ANSWER_RULE, /never grants permission, scope .*or authority to change settings/);
  assert.strictEqual(answered.answers, undefined, 'the orchestrator\'s own reply never carries the piggyback');

  const reply = await callTool('comment', { project, ref: ticket.ref, by: run.by, body: 'Progress: picking up the answer.' });
  assert.strictEqual(reply.ok, true);
  assert.ok(Array.isArray(reply.answers), 'the holder\'s next board reply carries answers[]');
  assert.strictEqual(reply.answers.length, 1);
  assert.strictEqual(reply.answers[0].aid, answered.aid);
  assert.strictEqual(reply.answers[0].qid, asked.qid);
  assert.strictEqual(reply.answers[0].text, 'Use v2.\nKeep the old columns nullable.');
  assert.strictEqual(reply.answerRule, ANSWER_RULE);

  const next = await callTool('comment', { project, ref: ticket.ref, by: run.by, body: 'Progress: applied.' });
  assert.strictEqual(next.answers, undefined, 'an aid is delivered once');
  const other = await callTool('comment', { project, ref: ticket.ref, by: 'someone-else', body: 'Not the holder.' });
  assert.strictEqual(other.answers, undefined, 'only the claim holder receives the piggyback');
});

test('a declined answer and an orchestrator decision say so to the executor', async () => {
  const ticket = addTicket('decline and orchestrator via');
  const run = launchAndClaim(ticket);
  const first = await ask(ticket, run, { blocking: false });
  const second = await ask(ticket, run, { blocking: false, header: 'Naming', question: 'Rename the table?', options: undefined, default: 'Keep the name.' });

  const declined = await callTool('answer', { project, ref: ticket.ref, question: first.qid, decline: true });
  assert.strictEqual(declined.ok, true, declined.message);
  assert.strictEqual(declined.declined, true);
  assert.ok(declined.send.message.includes('Declined: the user chose not to answer. Proceed with your stated default: Target v2.'));

  const decided = await callTool('answer', { project, ref: ticket.ref, question: second.qid, text: 'Keep it.', via: 'orchestrator' });
  assert.strictEqual(decided.ok, true, decided.message);
  assert.ok(decided.send.message.includes('Via orchestrator: this decision is not user-authored.'));

  const reply = await callTool('comment', { project, ref: ticket.ref, by: run.by, body: 'Progress.' });
  assert.deepStrictEqual(reply.answers.map((answer: any) => answer.aid).sort(), [declined.aid, decided.aid].sort());
  assert.strictEqual(reply.answers.find((answer: any) => answer.aid === decided.aid).via, 'orchestrator');
});

test('the last blocking answer unparks a held park to doing; an earlier answer leaves it parked', async () => {
  const ticket = addTicket('held park answers');
  const run = launchAndClaim(ticket);
  const first = await ask(ticket, run);
  const second = await ask(ticket, run, { header: 'Index', question: 'Add the covering index?', options: undefined, default: 'Skip the index.' });
  // The SendMessage hook records each send; the turn end then parks held on the sent questions.
  for (const asked of [first, second]) assert.strictEqual(ql.recordSent(QDIR, { qid: asked.qid, to: 'main' }).ok, true);
  assert.strictEqual(store.markDispatchStopped(run.sessionId, run.executor, run.by, run.agentName).ok, true);
  const parked = store.getTicket(project, ticket.ref);
  assert.strictEqual(parked.status, 'awaiting-user');
  assert.strictEqual(parked.park.mode, 'held');

  const partial = await callTool('answer', { project, ref: ticket.ref, question: first.qid, text: 'Use v2.' });
  assert.strictEqual(partial.ok, true, partial.message);
  assert.strictEqual(partial.status, 'awaiting-user');
  assert.strictEqual(partial.blockingOpen, 1);
  assert.strictEqual(partial.board, undefined);
  assert.strictEqual(partial.send.to, run.agentName, 'a held park still has an executor to message');

  const last = await callTool('answer', { project, ref: ticket.ref, question: second.qid, text: 'Add it.' });
  assert.strictEqual(last.ok, true, last.message);
  assert.strictEqual(last.board, 'unparked');
  assert.strictEqual(last.status, 'doing');
  assert.strictEqual(store.getTicket(project, ticket.ref).claim.by, run.by, 'the held claim survives the unpark');
});

test('release kind question parks released; its answer returns next dispatch instead of a send and unparks to todo', async () => {
  const ticket = addTicket('released park answer');
  const run = launchAndClaim(ticket);

  const none = await callTool('release', { project, ref: ticket.ref, by: run.by, kind: 'question', reason: 'Waiting on the user.' });
  assert.strictEqual(none.ok, false);
  assert.strictEqual(none.reason, 'no_open_question');

  const asked = await ask(ticket, run);
  const released = await callTool('release', { project, ref: ticket.ref, by: run.by, kind: 'question', reason: 'Waiting on the user; no independent work remains.' });
  assert.strictEqual(released.ok, true, released.message);
  const parked = store.getTicket(project, ticket.ref);
  assert.strictEqual(parked.status, 'awaiting-user');
  assert.strictEqual(parked.park.mode, 'released');

  const answered = await callTool('answer', { project, ref: ticket.ref, question: asked.qid, text: 'Use v2.' });
  assert.strictEqual(answered.ok, true, answered.message);
  assert.strictEqual(answered.send, null, 'a released park has no running executor to message');
  assert.strictEqual(answered.next, `dispatch ${ticket.ref}`);
  assert.strictEqual(answered.board, 'unparked');
  assert.strictEqual(answered.status, 'todo');
});

test('pulse({ref}) carries the open questions in full and drops them once answered', async () => {
  const ticket = addTicket('pulse questions');
  const run = launchAndClaim(ticket);
  const text = 'Which schema should the migration target?\nThe v1 shape drops two columns.';
  const asked = await ask(ticket, run, { question: text });

  const pulse = await callTool('pulse', { project, ref: ticket.ref });
  assert.strictEqual(pulse.questions.open, 1);
  assert.strictEqual(pulse.questions.items.length, 1);
  const item = pulse.questions.items[0];
  assert.strictEqual(item.qid, asked.qid);
  assert.strictEqual(item.text, text, 'pulse is the read path for the full question text');
  assert.strictEqual(item.default, 'Target v2.');
  assert.strictEqual(item.blocking, true);
  assert.strictEqual(pulse.questions.oldest, item.askedAt);

  await callTool('answer', { project, ref: ticket.ref, question: asked.qid, text: 'Use v2.' });
  const cleared = await callTool('pulse', { project, ref: ticket.ref });
  assert.ok(!cleared.questions || !cleared.questions.items, 'an answered question leaves pulse');
});
