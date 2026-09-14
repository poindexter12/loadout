import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { analyseSession, classify, collectFiles, formatReport, measure } from '../measure.mjs';

const cli = fileURLToPath(new URL('../measure.mjs', import.meta.url));
const use = (id, name = 'Read', input = {}) => ({ type: 'tool_use', id, name, input });
const assistant = (id, content = [], usage = { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 80, output_tokens: 10 }) => ({
  type: 'assistant', message: { id, content, usage },
});
const result = (id, content, extra = {}) => ({
  type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] },
});
function fixture(t, records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'synthetic.jsonl');
  fs.writeFileSync(file, records.map((record) => typeof record === 'string' ? record : JSON.stringify(record)).join('\n'));
  return { dir, file };
}
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('classifies read and shell heuristics, not shell semantics', () => {
  for (const [name, input, expected] of [
    ['Read', {}, 'bulk-read'], ['Read', null, 'bulk-read'],
    ['Read', { offset: 0 }, 'targeted-read'], ['Read', { limit: 20 }, 'targeted-read'],
    ['Read', { pages: '1-5' }, 'targeted-read'],
    ['Bash', { command: ' cat file' }, 'bulk-read'],
    ['Bash', { command: 'head -n 10 file' }, 'bulk-read'],
    ['BashOutput', {}, 'other'], ['Bash', { command: 'cat file | sort' }, 'targeted-read'],
    ['Bash', { command: 'npm test > log' }, 'targeted-read'],
    ['Bash', { command: 'cd src && cat file' }, 'other'],
    ['Grep', {}, 'search'], ['Glob', {}, 'search'],
    ['Task', {}, 'subagent'], ['Agent', {}, 'subagent'], ['Write', {}, 'other'],
  ]) assert.equal(classify({ name, input }), expected);
});

test('sums observed usage and carries from result arrival, including zero subsequent turns', async (t) => {
  const { file } = fixture(t, [
    assistant('a', [use('read')]), assistant('b'),
    result('read', 'x'.repeat(8000)), assistant('c'), assistant('d'),
    result('read', 'x'.repeat(8000)),
  ]);
  const row = await analyseSession(file);
  assert.equal(row.assistantTurns, 4);
  assert.equal(row.observedInputTokens, 800);
  assert.equal(row.inputTokens, 400);
  assert.equal(row.cacheCreationInputTokens, 80);
  assert.equal(row.cacheReadInputTokens, 320);
  assert.equal(row.outputTokens, 40);
  assert.equal(row.candidateCount, 2);
  assert.equal(row.candidateOneShot, 4000);
  assert.equal(row.candidateCarried, 4000);
  assert.deepEqual(row.byKind['bulk-read'], { count: 2, oneShot: 4000, carried: 4000 });
});

test('deduplicates record UUIDs and counts last usage snapshot once per message ID', async (t) => {
  const start = { ...assistant('a', [use('read')]), uuid: 'uuid-a' };
  const payload = { ...result('read', '12345678'), uuid: 'uuid-result' };
  const { file } = fixture(t, [
    start, start,
    assistant('a', [], { input_tokens: 120, output_tokens: 30 }),
    payload, payload, assistant('b'),
  ]);
  const row = await analyseSession(file, { minChars: 8 });
  assert.equal(row.assistantTurns, 2);
  assert.equal(row.observedInputTokens, 320);
  assert.equal(row.outputTokens, 40);
  assert.equal(row.duplicateRecords, 2);
  assert.equal(row.candidateCount, 1);
  assert.equal(row.candidateCarried, 2);
});

test('stops carry at visible compaction boundaries', async (t) => {
  const { file } = fixture(t, [
    assistant('a', [use('old')]), result('old', '12345678'), assistant('b'),
    { type: 'system', subtype: 'compact_boundary' },
    assistant('c', [use('new')]), result('new', '1234'), assistant('d'),
  ]);
  const row = await analyseSession(file, { minChars: 4 });
  assert.equal(row.assistantTurns, 4);
  assert.equal(row.compactionBoundaries, 1);
  assert.equal(row.candidateCarried, 3);
});

test('reports malformed, unmatched and non-text results; excludes errors from candidates', async (t) => {
  const { file } = fixture(t, [
    '', '{truncated', 'null', '[]',
    assistant('a', [use('mixed'), use('error')]),
    result('mixed', [{ type: 'text', text: '12345' }, { type: 'image', source: { data: 'not-text' } }]),
    result('error', '12345678', { is_error: true }),
    result('orphan', '1234'), assistant('b'),
    { type: 'progress', data: { message: assistant('nested') } },
  ]);
  const row = await analyseSession(file, { minChars: 5 });
  assert.equal(row.malformedLines, 3);
  assert.equal(row.unmatchedResults, 1);
  assert.equal(row.nonTextBlocks, 1);
  assert.equal(row.candidateCount, 1);
  assert.equal(row.candidateOneShot, 2);
  assert.equal(row.allResultOneShot, 5);
  assert.equal(row.allResultCarried, 5);
  assert.equal(row.assistantTurns, 2);
});

test('uses UUID or line fallback for missing IDs and tolerates string content', async (t) => {
  const { file } = fixture(t, [
    { ...assistant(undefined, 'text'), uuid: 'uuid-fallback' },
    assistant(undefined, null), assistant('no-usage', [], undefined),
    { type: 'assistant', message: { id: 'really-no-usage', content: 'text' } },
    { type: 'user', message: { content: 'plain prompt' } },
  ]);
  const row = await analyseSession(file);
  assert.equal(row.assistantTurns, 3);
  assert.equal(row.missingMessageIds, 2);
});

test('collects shallow directories, deduplicates inputs, and filters short sessions', async (t) => {
  const { dir, file } = fixture(t, [assistant('a'), assistant('b')]);
  const second = path.join(dir, 'short.jsonl');
  fs.writeFileSync(second, `${JSON.stringify(assistant('c'))}\n{broken`);
  fs.mkdirSync(path.join(dir, 'subagents'));
  fs.writeFileSync(path.join(dir, 'subagents', 'child.jsonl'), JSON.stringify(assistant('child')));
  fs.writeFileSync(path.join(dir, 'ignore.txt'), 'ignored');
  assert.equal(collectFiles([file, dir, file]).length, 2);
  const report = await measure([dir, file], { minTurns: 2 });
  assert.equal(report.sessions, 1);
  assert.equal(report.files, 2);
  assert.equal(report.skippedSessions, 1);
  assert.equal(report.skippedMalformedLines, 1);
  assert.equal(report.assistantTurns, 2);
});

test('fails visibly on missing paths and no usable sessions', async (t) => {
  const { dir, file } = fixture(t, ['{broken']);
  await assert.rejects(measure([file]), /No usable sessions.*1 malformed lines/);
  await assert.rejects(analyseSession(path.join(dir, 'missing.jsonl')), /ENOENT/);
  assert.throws(() => collectFiles([path.join(dir, 'missing')]), /ENOENT/);
  const result = run(file);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /No usable sessions/);
});

test('CLI help, aggregate JSON, validation and privacy', (t) => {
  const { file } = fixture(t, [
    assistant('private-session-id', [use('read', 'Read', { file_path: '/private/secret-name' })]),
    result('read', 'sensitive-payload'), assistant('b'),
  ]);
  assert.equal(run('--help').status, 0);
  for (const args of [[], ['--unknown'], ['--min-turns'], ['--min-turns', '-1'], ['--min-chars', '1.5']]) {
    assert.equal(run(...args).status, 1);
  }
  const invocation = run('--json', '--min-turns', '1', '--min-chars', '1', '--', file);
  assert.equal(invocation.status, 0, invocation.stderr);
  const report = JSON.parse(invocation.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.candidateCount, 1);
  for (const output of [invocation.stdout, formatReport(report)]) {
    for (const privateText of ['private-session-id', '/private/secret-name', 'sensitive-payload', file]) {
      assert.equal(output.includes(privateText), false);
    }
  }
  assert.match(formatReport({ ...report, observedInputTokens: 0 }), /n\/a/);
  assert.match(formatReport(report), /not avoidable cost or dollar savings/);
});
