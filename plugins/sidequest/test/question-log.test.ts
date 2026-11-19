import './_temp-cleanup.js';
'use strict';

// SQ-415 (US-8 Q1): the per-project question log. Covers the append race, torn tails, rotation
// carry-over, inode refolds, body files, first-writer-wins, the log's own lock and retention.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MODULE = path.join(__dirname, '..', 'lib', 'store', 'question-log.js');
const LOCK_MODULE = path.join(__dirname, '..', 'lib', 'mkdir-lock.js');
const ql = require(MODULE);
const lock = require(LOCK_MODULE);

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-03-10T12:00:00.000Z');

function logDir(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-question-log-')), 'questions');
}

function activeFile(dir: string): string {
  return path.join(dir, ql.ACTIVE_SEGMENT);
}

function rawLines(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  return text.split('\n').filter((line: string, index: number, all: string[]) => line || index < all.length - 1);
}

function events(file: string): any[] {
  return rawLines(file).map((line) => JSON.parse(line));
}

function at(ms: number) {
  return { now: new Date(ms) };
}

function runChild(script: string, args: string[], timeoutMs = 60_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`child timed out: ${stderr}`)); }, timeoutMs);
    child.on('error', (error: Error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code: number | null) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function waitGate(go: string) {
  return `const fs = require('node:fs');
const go = ${JSON.stringify(go)};
const pause = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 30000;
while (!fs.existsSync(go) && Date.now() < deadline) Atomics.wait(pause, 0, 0, 2);
`;
}

test('questionLogDir sits beside tickets/ under the project and refuses a path-like slug', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-question-home-'));
  assert.strictEqual(ql.questionLogDir('loadout-4d277aeb', home), path.join(home, 'projects', 'loadout-4d277aeb', 'questions'));
  for (const slug of ['', '..', 'a/b', '../x']) assert.throws(() => ql.questionLogDir(slug, home), TypeError);
});

test('ask records one v1 line with qid, per-ticket seq, ticket ref and the asked identity', () => {
  const dir = logDir();
  const asked = ql.askQuestion(dir, {
    ref: 'SQ-7', ticketId: 'tk_1', session: 's-exec', ownerSession: 's-owner', agent: 'sq-7-exec',
    header: 'Scope', text: 'Keep the old flag?', options: [{ label: 'Keep', description: 'compat' }, { label: 'Drop' }],
    default: 'Keep it',
  }, at(T0));
  assert.strictEqual(asked.ok, true);
  assert.match(asked.qid, /^q_[0-9a-z]+_[0-9a-z]{6}$/);
  assert.strictEqual(asked.seq, 'Q1');
  const [line] = events(activeFile(dir));
  assert.deepStrictEqual(
    { v: line.v, type: line.type, qid: line.qid, ref: line.ref, ticketId: line.ticketId, at: line.at, session: line.session },
    { v: 1, type: 'asked', qid: asked.qid, ref: 'SQ-7', ticketId: 'tk_1', at: new Date(T0).toISOString(), session: 's-exec' },
  );
  assert.strictEqual(line.seq, 'Q1');
  assert.strictEqual(line.origin, 'runtime');
  assert.strictEqual(line.ownerSession, 's-owner');
  assert.strictEqual(line.agent, 'sq-7-exec');
  assert.strictEqual(line.blocking, true);
  assert.deepStrictEqual(line.options, [{ label: 'Keep', description: 'compat' }, { label: 'Drop', description: '' }]);
  const second = ql.askQuestion(dir, { ref: 'sq-7', text: 'And the docs?' }, at(T0 + 1));
  assert.strictEqual(second.seq, 'Q2', 'seq is per ticket and case-insensitive on the ref');
  assert.strictEqual(ql.askQuestion(dir, { ref: 'SQ-8', text: 'Other ticket' }, at(T0 + 2)).seq, 'Q1');
});

test('ask validation refuses out-of-range content and the fourth open question, writing nothing', () => {
  const dir = logDir();
  assert.strictEqual(ql.askQuestion(dir, { ref: 'SQ-1', text: '   ' }).reason, 'question_empty');
  assert.strictEqual(ql.askQuestion(dir, { ref: 'SQ-1', text: 'x'.repeat(ql.MAX_QUESTION_BYTES + 1) }).reason, 'question_too_long');
  assert.strictEqual(ql.askQuestion(dir, { ref: 'SQ-1', header: 'thirteen-char', text: 'q' }).reason, 'question_too_long');
  assert.strictEqual(ql.askQuestion(dir, { ref: 'SQ-1', text: 'q', options: [{ label: 'only' }] }).reason, 'options_out_of_range');
  assert.strictEqual(ql.askQuestion(dir, { ref: 'SQ-1', text: 'q', options: Array.from({ length: 5 }, (_, i) => ({ label: `o${i}` })) }).reason, 'options_out_of_range');
  assert.strictEqual(fs.existsSync(activeFile(dir)), false, 'no refusal writes a line');
  for (let index = 0; index < ql.MAX_OPEN_PER_TICKET; index += 1) assert.strictEqual(ql.askQuestion(dir, { ref: 'SQ-1', text: `q${index}` }).ok, true);
  const capped = ql.askQuestion(dir, { ref: 'SQ-1', text: 'one too many' });
  assert.strictEqual(capped.reason, 'too_many_open');
  assert.strictEqual(capped.open.length, ql.MAX_OPEN_PER_TICKET);
  assert.strictEqual(rawLines(activeFile(dir)).length, ql.MAX_OPEN_PER_TICKET);
});

test('two processes appending at once never interleave a line or share a seq', async () => {
  const dir = logDir();
  const go = path.join(path.dirname(dir), 'go');
  const script = path.join(path.dirname(dir), 'race-child.js');
  const perChild = 25;
  fs.writeFileSync(script, `${waitGate(go)}
const ql = require(${JSON.stringify(MODULE)});
const [dir, tag, count] = process.argv.slice(2);
const seqs = [];
for (let index = 0; index < Number(count); index += 1) {
  const asked = ql.askQuestion(dir, { ref: 'SQ-1', agent: tag, text: tag + ' question ' + index + ' ' + 'p'.repeat(600) }, { lockWaitMs: 30000 });
  if (!asked.ok) { process.stderr.write(JSON.stringify(asked)); process.exit(2); }
  const withdrawn = ql.withdrawQuestion(dir, { ref: 'SQ-1', qid: asked.qid, reason: 'resolved' }, { lockWaitMs: 30000 });
  if (!withdrawn.ok || withdrawn.withdrawn.length !== 1) { process.stderr.write(JSON.stringify(withdrawn)); process.exit(3); }
  seqs.push(asked.seq);
}
process.stdout.write(JSON.stringify(seqs));
`);
  const children = [runChild(script, [dir, 'alpha', String(perChild)]), runChild(script, [dir, 'beta', String(perChild)])];
  fs.writeFileSync(go, '');
  const results = await Promise.all(children);
  for (const result of results) assert.strictEqual(result.code, 0, result.stderr);
  const seqs = results.flatMap((result) => JSON.parse(result.stdout));
  const expected = Array.from({ length: perChild * 2 }, (_, index) => `Q${index + 1}`);
  assert.deepStrictEqual([...seqs].sort((a, b) => ql.seqNumber(a) - ql.seqNumber(b)), expected, 'every seq issued exactly once');
  const lines = rawLines(activeFile(dir));
  assert.strictEqual(lines.length, perChild * 2 * 2);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line), `interleaved line: ${line.slice(0, 80)}`);
  const fold = ql.advanceFold(dir, null, { recentLimit: Infinity });
  assert.strictEqual(fold.skipped, 0);
  assert.strictEqual(Object.values(fold.recent).filter((state: any) => state.state === 'withdrawn').length, perChild * 2);
  assert.strictEqual(Object.keys(fold.open).length, 0);
  assert.strictEqual(fs.existsSync(path.join(dir, ql.APPEND_LOCK)), false, 'the lock is released');
});

test('two processes answering the same question concurrently: exactly one answer wins', async () => {
  const dir = logDir();
  const asked = ql.askQuestion(dir, { ref: 'SQ-2', text: 'Ship it?' });
  const go = path.join(path.dirname(dir), 'go');
  const script = path.join(path.dirname(dir), 'answer-child.js');
  fs.writeFileSync(script, `${waitGate(go)}
const ql = require(${JSON.stringify(MODULE)});
const [dir, qid, text] = process.argv.slice(2);
process.stdout.write(JSON.stringify(ql.answerQuestion(dir, { ref: 'SQ-2', question: qid, text, via: 'dashboard' }, { lockWaitMs: 30000 })));
`);
  const children = ['yes', 'no', 'maybe'].map((text) => runChild(script, [dir, asked.qid, text]));
  fs.writeFileSync(go, '');
  const results = (await Promise.all(children)).map((result) => { assert.strictEqual(result.code, 0, result.stderr); return JSON.parse(result.stdout); });
  const winners = results.filter((result) => result.ok);
  assert.strictEqual(winners.length, 1);
  assert.deepStrictEqual(results.filter((result) => !result.ok).map((result) => result.reason), ['already_answered', 'already_answered']);
  const answered = events(activeFile(dir)).filter((event) => event.type === 'answered');
  assert.strictEqual(answered.length, 1, 'losers write nothing');
  assert.strictEqual(ql.findQuestion(dir, asked.qid).answered.aid, winners[0].aid);
});

test('a torn final line is ignored by readers and repaired, never fatal, by the next writer', () => {
  const dir = logDir();
  const first = ql.askQuestion(dir, { ref: 'SQ-3', text: 'first' }, at(T0));
  const file = activeFile(dir);
  const intactBytes = fs.statSync(file).size;
  const torn = '{"v":1,"type":"asked","qid":"q_torn';
  fs.appendFileSync(file, torn);
  let fold = ql.readQuestionLog(dir);
  assert.deepStrictEqual(Object.keys(fold.open), [first.qid]);
  assert.strictEqual(fold.skipped, 0, 'an unterminated tail is in progress, not yet a bad line');
  assert.strictEqual(fold.offset, intactBytes, 'the fold stops before the torn tail');
  const second = ql.askQuestion(dir, { ref: 'SQ-3', text: 'second' }, at(T0 + 1));
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.seq, 'Q2');
  const lines = rawLines(file);
  assert.strictEqual(lines.length, 3);
  assert.strictEqual(lines[1], torn, 'the fragment was terminated in place');
  assert.strictEqual(JSON.parse(lines[2] ?? '').qid, second.qid, 'the new event starts on its own line');
  fold = ql.readQuestionLog(dir);
  assert.deepStrictEqual(Object.keys(fold.open).sort(), [first.qid, second.qid].sort());
  assert.strictEqual(fold.skipped, 1, 'the repaired fragment is one skipped, counted line');
  const scratch = ql.advanceFold(dir, null);
  assert.strictEqual(scratch.skipped, 1);
  assert.deepStrictEqual(Object.keys(scratch.open).sort(), Object.keys(fold.open).sort());
});

test('readers skip and count unparseable lines and an unknown v', () => {
  const dir = logDir();
  const asked = ql.askQuestion(dir, { ref: 'SQ-4', text: 'kept' });
  fs.appendFileSync(activeFile(dir), `not json\n${JSON.stringify({ v: 99, type: 'asked', qid: 'q_1_abcdef', ref: 'SQ-4', at: new Date().toISOString(), text: 'future' })}\n`);
  ql.askQuestion(dir, { ref: 'SQ-4', text: 'after' });
  const fold = ql.readQuestionLog(dir);
  assert.strictEqual(fold.skipped, 2);
  assert.strictEqual(Object.keys(fold.open).length, 2);
  assert.ok(fold.open[asked.qid]);
});

test('fold.json advances incrementally on the same inode and refolds when the inode changes', () => {
  const dir = logDir();
  const asked = ql.askQuestion(dir, { ref: 'SQ-5', text: `long enough to fill the head digest ${'h'.repeat(400)}` }, at(T0));
  ql.withdrawQuestion(dir, { ref: 'SQ-5', qid: asked.qid, reason: 'resolved' }, at(T0 + 1));
  const file = activeFile(dir);
  const first = ql.readQuestionLog(dir);
  assert.strictEqual(first.inode, fs.statSync(file).ino);
  assert.strictEqual(first.lines, 2);
  assert.strictEqual(ql.findQuestion(dir, asked.qid).state, 'withdrawn');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, ql.FOLD_FILE), 'utf8'));
  assert.deepStrictEqual([saved.segment, saved.inode, saved.offset], [ql.ACTIVE_SEGMENT, first.inode, fs.statSync(file).size]);
  assert.ok(saved.open && saved.recent);

  // Same inode, appended bytes: only the new bytes are parsed (lines accumulate on the cached fold).
  ql.askQuestion(dir, { ref: 'SQ-5', text: 'next' }, at(T0 + 2));
  const grown = ql.readQuestionLog(dir);
  assert.strictEqual(grown.inode, first.inode);
  assert.strictEqual(grown.lines, 3);

  // Replace the segment with a new inode whose first line and size both still satisfy the cached
  // fold: only the inode check can tell the reader to refold.
  const [askedLine] = rawLines(file);
  const answeredLine = JSON.stringify({ v: 1, type: 'answered', qid: asked.qid, ref: 'SQ-5', ticketId: null, at: new Date(T0 + 3).toISOString(), session: null, aid: 'a_1_zzzzzz', via: 'user', declined: false, text: `replaced ${'r'.repeat(600)}` });
  const replacement = `${askedLine}\n${answeredLine}\n`;
  assert.ok(Buffer.byteLength(replacement) >= grown.offset);
  const temp = path.join(dir, 'replacement.tmp');
  fs.writeFileSync(temp, replacement);
  fs.renameSync(temp, file);
  assert.notStrictEqual(fs.statSync(file).ino, first.inode);
  const refolded = ql.readQuestionLog(dir);
  assert.strictEqual(refolded.inode, fs.statSync(file).ino);
  assert.strictEqual(refolded.lines, 2, 'refolded from scratch, not appended to the stale fold');
  assert.strictEqual(refolded.skipped, 0, 'no read started mid-line at the stale offset');
  assert.strictEqual(ql.findQuestion(dir, asked.qid).state, 'answered');
});

test('fold.json refolds when the segment shrinks or its head changes on the same inode', () => {
  const dir = logDir();
  const a = ql.askQuestion(dir, { ref: 'SQ-6', text: 'a' });
  const b = ql.askQuestion(dir, { ref: 'SQ-6', text: 'b' });
  const file = activeFile(dir);
  const inode = ql.readQuestionLog(dir).inode;
  const [lineA, lineB] = rawLines(file);
  fs.writeFileSync(file, `${lineA}\n`); // truncate in place: same inode, size < offset
  assert.strictEqual(fs.statSync(file).ino, inode);
  assert.deepStrictEqual(Object.keys(ql.readQuestionLog(dir).open), [a.qid]);
  fs.writeFileSync(file, `${lineB}\n${lineA}\n`); // same inode, same size class, different head
  const fold = ql.readQuestionLog(dir);
  assert.strictEqual(fold.lines, 2);
  assert.deepStrictEqual(Object.keys(fold.open).sort(), [a.qid, b.qid].sort());
});

test('a long answer goes to bodies/<aid>.txt and list reads never open bodies/', () => {
  const dir = logDir();
  const asked = ql.askQuestion(dir, { ref: 'SQ-9', text: 'Write up the migration plan?' });
  const marker = `BODY-MARKER-${crypto.randomUUID()}`;
  const body = `${marker} ${'é'.repeat(1500)}`;
  const answered = ql.answerQuestion(dir, { ref: 'SQ-9', question: asked.qid, text: body });
  assert.strictEqual(answered.ok, true);
  assert.strictEqual(answered.inline, false);
  assert.strictEqual(answered.bodyRef, `bodies/${answered.aid}.txt`);
  const bodyFile = path.join(dir, 'bodies', `${answered.aid}.txt`);
  assert.strictEqual(fs.readFileSync(bodyFile, 'utf8'), body);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'bodies')), [`${answered.aid}.txt`], 'no temp file left behind');
  const line = events(activeFile(dir)).find((event) => event.type === 'answered');
  assert.strictEqual(line.text, undefined, 'a long answer is not inline');
  assert.strictEqual(line.bodyRef, `bodies/${answered.aid}.txt`);
  assert.strictEqual(line.bytes, Buffer.byteLength(body));
  assert.strictEqual(line.sha256, crypto.createHash('sha256').update(body).digest('hex'));
  assert.strictEqual(Array.from(line.preview).length, ql.MAX_PREVIEW_CHARS);
  assert.ok(body.startsWith(line.preview));

  const touched: string[] = [];
  const bodiesPath = path.join(dir, 'bodies');
  const originals = { openSync: fs.openSync, readFileSync: fs.readFileSync, readdirSync: fs.readdirSync, existsSync: fs.existsSync, statSync: fs.statSync };
  for (const name of Object.keys(originals) as Array<keyof typeof originals>) {
    (fs as any)[name] = function spy(target: unknown, ...rest: unknown[]) {
      if (typeof target === 'string' && target.startsWith(bodiesPath)) touched.push(`${name} ${target}`);
      return (originals[name] as any).call(fs, target, ...rest);
    };
  }
  let summary: any;
  try {
    fs.rmSync(path.join(dir, ql.FOLD_FILE), { force: true });
    ql.readQuestionLog(dir);
    ql.openQuestions(dir);
    summary = ql.summarizeQuestion(ql.findQuestion(dir, asked.qid));
    ql.foldQuestions(ql.readQuestionLog(dir));
    assert.deepStrictEqual(touched, [], 'list reads opened a body file');
    assert.strictEqual(ql.readAnswerBody(dir, answered.aid), body);
    assert.strictEqual(touched.length, 1, 'only readAnswerBody opens bodies/');
  } finally {
    Object.assign(fs, originals);
  }
  assert.strictEqual(summary.state, 'answered');
  assert.ok(!JSON.stringify(summary).includes(marker), 'a summary carries no answer text or preview');
  assert.strictEqual(ql.readAnswerBody(dir, 'a_bad'), null);
});

test('answers at the inline limit stay inline; one byte over goes to a body; over 64 KiB is refused', () => {
  const dir = logDir();
  const one = ql.askQuestion(dir, { ref: 'SQ-10', text: 'one' });
  const two = ql.askQuestion(dir, { ref: 'SQ-10', text: 'two' });
  const three = ql.askQuestion(dir, { ref: 'SQ-10', text: 'three' });
  const inline = ql.answerQuestion(dir, { ref: 'SQ-10', question: one.qid, text: 'i'.repeat(ql.MAX_INLINE_ANSWER_BYTES) });
  assert.strictEqual(inline.inline, true);
  assert.strictEqual(fs.existsSync(path.join(dir, 'bodies')), false);
  const over = ql.answerQuestion(dir, { ref: 'SQ-10', question: two.qid, text: 'o'.repeat(ql.MAX_INLINE_ANSWER_BYTES + 1) });
  assert.strictEqual(over.inline, false);
  assert.ok(fs.existsSync(path.join(dir, 'bodies', `${over.aid}.txt`)));
  const before = fs.statSync(activeFile(dir)).size;
  const huge = ql.answerQuestion(dir, { ref: 'SQ-10', question: three.qid, text: 'h'.repeat(ql.MAX_ANSWER_BYTES + 1) });
  assert.strictEqual(huge.reason, 'answer_too_long');
  assert.strictEqual(fs.statSync(activeFile(dir)).size, before);
  assert.strictEqual(ql.answerQuestion(dir, { ref: 'SQ-10', question: three.qid, text: ' ' }).reason, 'answer_empty');
});

test('first answer wins: a repeat is idempotent, a different one is refused, supersedes replaces it', () => {
  const dir = logDir();
  const oldest = ql.askQuestion(dir, { ref: 'SQ-11', text: 'oldest' }, at(T0));
  const newer = ql.askQuestion(dir, { ref: 'SQ-11', text: 'newer' }, at(T0 + 1));
  const answered = ql.answerQuestion(dir, { ref: 'SQ-11', text: 'yes' }, at(T0 + 2));
  assert.strictEqual(answered.qid, oldest.qid, 'no question id: the oldest open question');
  assert.deepStrictEqual(answered.openForTicket, [newer.qid]);
  assert.strictEqual(answered.blockingOpen, 1);
  const lineCount = rawLines(activeFile(dir)).length;
  const repeat = ql.answerQuestion(dir, { ref: 'SQ-11', question: oldest.qid, text: 'yes' });
  assert.strictEqual(repeat.idempotent, true);
  assert.strictEqual(repeat.aid, answered.aid);
  assert.strictEqual(rawLines(activeFile(dir)).length, lineCount, 'an idempotent repeat writes nothing');
  const conflict = ql.answerQuestion(dir, { ref: 'SQ-11', question: oldest.qid, text: 'no' });
  assert.strictEqual(conflict.reason, 'already_answered');
  assert.strictEqual(conflict.aid, answered.aid);
  assert.match(conflict.message, /"yes"/);
  const changed = ql.answerQuestion(dir, { ref: 'SQ-11', question: oldest.qid, text: 'no', supersedes: answered.aid }, at(T0 + 3));
  assert.strictEqual(changed.ok, true);
  const state = ql.findQuestion(dir, oldest.qid);
  assert.strictEqual(state.answered.text, 'no');
  assert.deepStrictEqual(state.superseded.map((answer: any) => answer.aid), [answered.aid]);
  assert.strictEqual(ql.answerQuestion(dir, { ref: 'SQ-12', question: newer.qid, text: 'x' }).reason, 'no_such_question', 'the qid must belong to the ref');
  ql.withdrawQuestion(dir, { ref: 'SQ-11', reason: 'ticket-closed' });
  const withdrawnAnswer = ql.answerQuestion(dir, { ref: 'SQ-11', question: newer.qid, text: 'late' });
  assert.strictEqual(withdrawnAnswer.reason, 'no_such_question');
  assert.deepStrictEqual(withdrawnAnswer.open, []);
});

test('the fold keeps the first answered line per qid even when two were written', () => {
  const dir = logDir();
  const asked = ql.askQuestion(dir, { ref: 'SQ-13', text: 'q' });
  const answer = (aid: string, text: string) => JSON.stringify({ v: 1, type: 'answered', qid: asked.qid, ref: 'SQ-13', ticketId: null, at: new Date().toISOString(), session: null, aid, via: 'user', declined: false, text });
  fs.appendFileSync(activeFile(dir), `${answer('a_1_aaaaaa', 'first')}\n${answer('a_1_bbbbbb', 'second')}\n`);
  assert.strictEqual(ql.findQuestion(dir, asked.qid).answered.text, 'first');
});

test('sent and delivered stamps: delivery closes a live answered question and is idempotent by aid', () => {
  const dir = logDir();
  const asked = ql.askQuestion(dir, { ref: 'SQ-14', text: 'q' });
  assert.strictEqual(ql.recordSent(dir, { qid: asked.qid, to: 'main' }).ok, true);
  const answered = ql.answerQuestion(dir, { ref: 'SQ-14', question: asked.qid, text: 'a' });
  assert.ok(ql.readQuestionLog(dir).open[asked.qid], 'answered but undelivered stays live');
  assert.strictEqual(ql.recordSent(dir, { aid: answered.aid, to: 'sq-14-exec' }).ok, true);
  assert.strictEqual(ql.recordDelivered(dir, { aid: answered.aid }).duplicate, false);
  assert.strictEqual(ql.recordDelivered(dir, { aid: answered.aid }).duplicate, true);
  const fold = ql.readQuestionLog(dir);
  assert.strictEqual(fold.open[asked.qid], undefined);
  assert.strictEqual(fold.recent[asked.qid].delivered.length, 1);
  assert.strictEqual(fold.recent[asked.qid].sent.length, 2);
  assert.strictEqual(events(activeFile(dir)).filter((event) => event.type === 'delivered').length, 1);
  assert.strictEqual(ql.recordDelivered(dir, { aid: 'a_9_nonexx' }).reason, 'no_such_question');
});

test('rotation archives the segment, carries every open or undelivered question, and keeps seqs', () => {
  const dir = logDir();
  const small = (ms: number) => ({ now: new Date(ms), maxSegmentBytes: 6000 });
  const open = ql.askQuestion(dir, { ref: 'SQ-20', text: 'still open' }, small(T0));
  const undelivered = ql.askQuestion(dir, { ref: 'SQ-21', text: 'answered, not delivered' }, small(T0 + 1));
  ql.answerQuestion(dir, { ref: 'SQ-21', question: undelivered.qid, text: 'ok' }, small(T0 + 2));
  const delivered = ql.askQuestion(dir, { ref: 'SQ-22', text: 'answered and delivered' }, small(T0 + 3));
  const deliveredAnswer = ql.answerQuestion(dir, { ref: 'SQ-22', question: delivered.qid, text: 'DELIVERED-ANSWER-TEXT' }, small(T0 + 4));
  ql.recordDelivered(dir, { aid: deliveredAnswer.aid }, small(T0 + 5));
  const withBody = ql.askQuestion(dir, { ref: 'SQ-23', text: 'long answer' }, small(T0 + 6));
  const bodyAnswer = ql.answerQuestion(dir, { ref: 'SQ-23', question: withBody.qid, text: 'b'.repeat(3000) }, small(T0 + 7));
  let tick = T0 + 10;
  for (let index = 0; index < 3; index += 1) {
    const closed = ql.askQuestion(dir, { ref: 'SQ-29', text: `closed ${index}` }, small(tick += 1));
    ql.withdrawQuestion(dir, { ref: 'SQ-29', qid: closed.qid, reason: 'resolved' }, small(tick += 1));
  }
  // Fill with sent stamps on a closed question, so no filler is itself open at rotation time.
  for (let fills = 0; !ql.listArchivedSegments(dir).length; fills += 1) {
    assert.ok(fills < 40, 'rotation never triggered');
    assert.strictEqual(ql.recordSent(dir, { qid: delivered.qid, to: `x${'x'.repeat(300)}` }, small(tick += 1)).ok, true);
  }
  const [archived] = ql.listArchivedSegments(dir);
  assert.match(archived, /^questions-\d{8}T\d{9}Z\.jsonl$/);
  const carried = events(activeFile(dir)).filter((event) => event.type === 'carried');
  assert.deepStrictEqual(carried.map((event) => event.qid).sort(), [open.qid, undelivered.qid, withBody.qid].sort());
  assert.strictEqual(carried.find((event) => event.qid === undelivered.qid).state.answered.text, 'ok');
  assert.ok(fs.statSync(activeFile(dir)).size < 6000);

  const index = ql.readSegmentIndex(dir, archived);
  assert.strictEqual(index.segment, archived);
  assert.ok(fs.existsSync(path.join(dir, `index-${archived.replace(/\.jsonl$/, '')}.json`)));
  assert.ok(index.questions.some((question: any) => question.qid === delivered.qid));
  assert.ok(index.bodies.includes(bodyAnswer.aid));
  assert.ok(!JSON.stringify(index).includes('DELIVERED-ANSWER-TEXT'), 'the index carries no answer text');

  // After rotation the active fold alone is complete, and a refold from scratch still knows seqs.
  fs.rmSync(path.join(dir, ql.FOLD_FILE), { force: true });
  const fold = ql.readQuestionLog(dir);
  assert.deepStrictEqual(Object.keys(fold.open).sort(), [open.qid, undelivered.qid, withBody.qid].sort());
  assert.strictEqual(ql.askQuestion(dir, { ref: 'SQ-20', text: 'second on SQ-20' }, small(tick += 1)).seq, 'Q2');
  assert.strictEqual(ql.askQuestion(dir, { ref: 'SQ-29', text: 'after rotation' }, small(tick += 1)).seq, 'Q4', 'a ticket with nothing carried still continues its seq from the archive index');
  assert.strictEqual(ql.answerQuestion(dir, { ref: 'SQ-20', question: open.qid, text: 'carried answer' }, small(tick += 1)).ok, true);
  assert.strictEqual(ql.readAnswerBody(dir, bodyAnswer.aid), 'b'.repeat(3000));
  const archivedState = ql.findQuestion(dir, delivered.qid);
  assert.strictEqual(archivedState.state, 'answered', 'a closed question is still found in its archived segment');
  assert.strictEqual(archivedState.delivered.length, 1);
});

test('the first append of a new UTC month rotates even a small segment', () => {
  const dir = logDir();
  const open = ql.askQuestion(dir, { ref: 'SQ-30', text: 'march' }, at(Date.parse('2026-03-31T23:59:00.000Z')));
  assert.strictEqual(ql.listArchivedSegments(dir).length, 0);
  ql.askQuestion(dir, { ref: 'SQ-31', text: 'april' }, at(Date.parse('2026-04-01T00:00:05.000Z')));
  assert.strictEqual(ql.listArchivedSegments(dir).length, 1);
  const [first, second] = events(activeFile(dir));
  assert.deepStrictEqual([first.type, first.qid], ['carried', open.qid]);
  assert.strictEqual(second.type, 'asked');
  ql.askQuestion(dir, { ref: 'SQ-31', text: 'april again' }, at(Date.parse('2026-04-02T00:00:00.000Z')));
  assert.strictEqual(ql.listArchivedSegments(dir).length, 1, 'only the first append of the month rotates');
});

test('retention prunes expired segments, their indexes and unreferenced bodies, and stops carrying stale answers', () => {
  const dir = logDir();
  const open = ql.askQuestion(dir, { ref: 'SQ-40', text: 'open for months' }, at(T0));
  const stale = ql.askQuestion(dir, { ref: 'SQ-41', text: 'answered, never delivered' }, at(T0 + 1));
  const staleAnswer = ql.answerQuestion(dir, { ref: 'SQ-41', question: stale.qid, text: 's'.repeat(3000) }, at(T0 + 2));
  ql.askQuestion(dir, { ref: 'SQ-42', text: 'next month' }, at(T0 + 30 * DAY)); // rotates (April)
  assert.strictEqual(ql.listArchivedSegments(dir).length, 1);
  const orphan = path.join(dir, 'bodies', 'a_1_orphan.txt');
  fs.writeFileSync(orphan, 'nobody references this');
  fs.writeFileSync(path.join(dir, 'index-questions-20200101T000000000Z.json'), '{}');

  const later = T0 + 200 * DAY;
  ql.askQuestion(dir, { ref: 'SQ-43', text: 'much later' }, at(later)); // rotates again
  assert.strictEqual(ql.listArchivedSegments(dir).length, 2);
  const carried = events(activeFile(dir)).filter((event) => event.type === 'carried').map((event) => event.qid);
  assert.ok(carried.includes(open.qid), 'an open question is always carried');
  assert.ok(!carried.includes(stale.qid), 'an undelivered answer past retention is not carried');

  const pruned = ql.pruneQuestionLog(dir, at(later));
  assert.strictEqual(pruned.ok, true);
  assert.strictEqual(pruned.removedSegments.length, 2);
  assert.strictEqual(ql.listArchivedSegments(dir).length, 0);
  assert.ok(pruned.removedIndexes.includes('index-questions-20200101T000000000Z.json'));
  assert.ok(!fs.readdirSync(dir).some((name: string) => name.startsWith('index-')));
  assert.deepStrictEqual(pruned.removedBodies.sort(), ['a_1_orphan.txt', `${staleAnswer.aid}.txt`].sort());
  assert.ok(ql.readQuestionLog(dir).open[open.qid], 'the active segment is never pruned');

  const kept = ql.askQuestion(dir, { ref: 'SQ-44', text: 'recent body' }, at(later + 1));
  const keptAnswer = ql.answerQuestion(dir, { ref: 'SQ-44', question: kept.qid, text: 'k'.repeat(3000) }, at(later + 2));
  assert.deepStrictEqual(ql.pruneQuestionLog(dir, at(later + 3)).removedBodies, []);
  assert.ok(ql.readAnswerBody(dir, keptAnswer.aid));
});

test('the log takes only its own lock: a held append.lock refuses busy, a dead owner is cleaned up', async () => {
  const dir = logDir();
  ql.askQuestion(dir, { ref: 'SQ-50', text: 'seed' });
  const before = fs.statSync(activeFile(dir)).size;
  const held = lock.acquireMkdirLock(path.join(dir, ql.APPEND_LOCK));
  assert.ok(held);
  let busy: any;
  try {
    busy = ql.askQuestion(dir, { ref: 'SQ-50', text: 'blocked' }, { lockWaitMs: 40 });
  } finally {
    lock.releaseMkdirLock(held);
  }
  assert.strictEqual(busy.reason, 'question_log_busy');
  assert.strictEqual(busy.retryable, true);
  assert.strictEqual(fs.statSync(activeFile(dir)).size, before, 'a busy refusal writes nothing');
  assert.strictEqual(ql.askQuestion(dir, { ref: 'SQ-50', text: 'free' }).ok, true);

  const exited = spawn(process.execPath, ['-e', '']);
  const deadPid: number = await new Promise((resolve) => exited.on('close', () => resolve(exited.pid)));
  const lockDir = path.join(dir, ql.APPEND_LOCK);
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, `owner-${deadPid}-stale`), `${deadPid}\n`);
  assert.strictEqual(ql.askQuestion(dir, { ref: 'SQ-50', text: 'after a crashed writer' }, { lockWaitMs: 2000 }).ok, true);
  assert.strictEqual(fs.existsSync(lockDir), false);
});

test('withMkdirLock runs the callback once under the lock and releases it after a throw', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mkdir-lock-'));
  const lockDir = path.join(root, 'nested', 'x.lock');
  assert.deepStrictEqual(lock.withMkdirLock(lockDir, () => fs.existsSync(lockDir)), { acquired: true, value: true });
  assert.strictEqual(fs.existsSync(lockDir), false);
  assert.throws(() => lock.withMkdirLock(lockDir, () => { throw new Error('boom'); }), /boom/);
  assert.strictEqual(fs.existsSync(lockDir), false, 'released after a throw');
  const held = lock.acquireMkdirLock(lockDir);
  let called = false;
  assert.deepStrictEqual(lock.withMkdirLock(lockDir, () => { called = true; }, { waitMs: 20 }), { acquired: false });
  assert.strictEqual(called, false);
  lock.releaseMkdirLock(held);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'nested')), [], 'no candidate directory is left behind');
});

test('the question log never reaches the board lock or the store', () => {
  const source = fs.readFileSync(MODULE, 'utf8');
  const required = [...source.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]).sort();
  assert.deepStrictEqual(required, ['../claude-home.js', '../mkdir-lock.js', 'node:crypto', 'node:fs', 'node:path']);
  const hook = fs.readFileSync(path.join(__dirname, '..', 'src', 'hooks', 'board-reconciliation-reminder.ts'), 'utf8');
  assert.match(hook, /from '\.\.\/lib\/mkdir-lock\.js'/, 'the Stop reminder uses the shared lock');
  assert.doesNotMatch(hook, /renameSync\(candidateDirectory/, 'the hook no longer carries its own copy');
});
