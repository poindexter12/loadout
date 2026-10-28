'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  defaultTranscriptDir,
  parseCompactBoundary,
  parseJevOutcome,
  readCompactionOutcomes,
  scanTranscript,
} = require('../lib/observability/compaction.js');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'compaction-transcripts');
const MAIN_SESSION = '11111111-aaaa-4bbb-8ccc-000000000001';
const SENTINELS = [
  'SENTINEL-PROMPT-TEXT', 'SentinelTool', 'SENTINEL-TOOL-INPUT', 'SENTINEL-SUMMARY-TEXT',
  'SENTINEL-ERROR-BODY', 'DOCTYPE', 'SENTINEL-SPAWN-PROMPT', 'SENTINEL-UNCOMPACTED-SESSION', 'decisions',
];

function rowFor(result, agentId = null) {
  return result.transcripts.find((row) => row.session_id === MAIN_SESSION && row.agent_id === agentId);
}

test('parses a jev replacement notice into message counts and reduction', () => {
  assert.deepEqual(
    parseJevOutcome('fast-jev-compaction: kept 73/139 messages, no summary (81% reduction)'),
    { kind: 'replacement', messages_kept: 73, messages_total: 139, reduction_percent: 81 },
  );
  assert.deepEqual(
    parseJevOutcome('fast-jev-compaction: kept 103/221 messages, no summary (66% reduction; 2 results truncated, 59 call_dropped, 1 pinned; state ~23231 tokens (inputs<=200) in 2 request(s))'),
    { kind: 'replacement', messages_kept: 103, messages_total: 221, reduction_percent: 66 },
  );
});

test('classifies jev fallbacks by reason and never keeps the fallback text', () => {
  assert.deepEqual(
    parseJevOutcome('fast-jev-compaction: fallback to built-in summary (below 25% minimum: 18% reduction; 17 call_dropped, 2 pinned)'),
    { kind: 'fallback', reason: 'below_minimum', minimum_percent: 25, reduction_percent: 18, status_code: null },
  );
  const failed = parseJevOutcome('fast-jev-compaction: fallback to built-in summary (Jev request failed (520): <!DOCTYPE html><body>SENTINEL-ERROR-BODY</body>)');
  assert.deepEqual(failed, { kind: 'fallback', reason: 'request_failed', minimum_percent: null, reduction_percent: null, status_code: 520 });
  assert.deepEqual(
    parseJevOutcome('fast-jev-compaction: fallback to built-in summary (something new happened)'),
    { kind: 'fallback', reason: 'other', minimum_percent: null, reduction_percent: null, status_code: null },
  );
});

test('ignores jev decision lines, other notices, and non-string content', () => {
  assert.equal(parseJevOutcome('fast-jev-compaction: decisions: t1:Bash:drop_call/call=0.24/result=0.15'), null);
  assert.equal(parseJevOutcome('fast-jev-compaction: decisions (1/2): t1:Edit:drop_call/call=0.25/result=0.23'), null);
  assert.equal(parseJevOutcome('Some other plugin notice'), null);
  assert.equal(parseJevOutcome(undefined), null);
  assert.equal(parseJevOutcome({ text: 'fast-jev-compaction: kept 1/2 messages, no summary (50% reduction)' }), null);
});

test('reads trigger and token counts from a compact_boundary record', () => {
  assert.deepEqual(
    parseCompactBoundary({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 167000, postTokens: 33400, durationMs: 900 } }),
    { trigger: 'auto', pre_tokens: 167000, post_tokens: 33400, duration_ms: 900, reduction_percent: 80 },
  );
  assert.deepEqual(
    parseCompactBoundary({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 159996 } }),
    { trigger: 'manual', pre_tokens: 159996, post_tokens: null, duration_ms: null, reduction_percent: null },
  );
  assert.equal(parseCompactBoundary({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'plugin', preTokens: -1 } }).trigger, 'other');
  assert.equal(parseCompactBoundary({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'plugin', preTokens: -1 } }).pre_tokens, null);
  assert.equal(parseCompactBoundary({ type: 'user', subtype: 'compact_boundary' }), null);
});

test('counts only system records, so quoted notices and malformed lines do not inflate totals', () => {
  const text = fs.readFileSync(path.join(FIXTURE_DIR, `${MAIN_SESSION}.jsonl`), 'utf8');
  const events = scanTranscript(text);
  assert.equal(events.boundaries.length, 3);
  assert.equal(events.replacements.length, 2, 'the user message quoting a kept notice must not count');
  assert.equal(events.fallbacks.length, 2);
});

test('summarizes per-session counts, reduction, and fallback rate from synthetic transcripts', () => {
  const result = readCompactionOutcomes({ transcriptDir: FIXTURE_DIR });
  assert.equal(result.available, true);
  assert.equal(result.source.files_scanned, 3);
  assert.equal(result.source.files_with_compaction, 2);
  assert.equal(result.transcripts.length, 2, 'a session with no compaction is not a row');

  const main = rowFor(result);
  assert.equal(main.kind, 'main');
  assert.deepEqual(main.compactions, { total: 3, auto: 2, manual: 1, other: 0 });
  assert.equal(main.pre_tokens_max, 167000);
  assert.equal(main.pre_tokens_mean, 163998.7);
  assert.equal(main.boundary_reduction_percent_mean, 75);
  assert.deepEqual(main.jev, {
    replacements: 2,
    fallbacks: 2,
    fallback_rate: 0.5,
    fallback_reasons: { below_minimum: 1, request_failed: 1, other: 0 },
    reduction_percent_mean: 73.5,
    reduction_percent_min: 66,
    reduction_percent_max: 81,
    messages_kept: 176,
    messages_total: 360,
  });

  const subagent = rowFor(result, 'a0000000000000001');
  assert.equal(subagent.kind, 'subagent');
  assert.deepEqual(subagent.compactions, { total: 1, auto: 1, manual: 0, other: 0 });
  assert.equal(subagent.boundary_reduction_percent_mean, 80.5);
  assert.equal(subagent.jev.replacements, 0);
  assert.equal(subagent.jev.fallback_rate, null, 'no jev outcome means the rate is unknown, not zero');

  assert.equal(result.totals.transcripts, 2);
  assert.deepEqual(result.totals.compactions, { total: 4, auto: 3, manual: 1, other: 0 });
  assert.equal(result.totals.pre_tokens_max, 167775);
  assert.equal(result.totals.jev.replacements, 2);
  assert.equal(result.totals.jev.fallbacks, 2);
  assert.equal(result.totals.jev.fallback_rate, 0.5);
  assert.equal(result.totals.jev.reduction_percent_mean, 73.5);
});

test('retains numbers and ids only, never transcript text, tool names, or fallback error bodies', () => {
  const serialized = JSON.stringify(readCompactionOutcomes({ transcriptDir: FIXTURE_DIR }));
  for (const sentinel of SENTINELS) assert.equal(serialized.includes(sentinel), false, `${sentinel} leaked into the result`);
});

test('applies the --since/--until usage window to compaction events', () => {
  const later = readCompactionOutcomes({ transcriptDir: FIXTURE_DIR, since: '2026-09-01T11:30:00.000Z' });
  const laterMain = rowFor(later);
  assert.deepEqual(laterMain.compactions, { total: 2, auto: 2, manual: 0, other: 0 });
  assert.equal(laterMain.jev.replacements, 0);
  assert.equal(laterMain.jev.fallbacks, 2);
  assert.equal(laterMain.jev.fallback_rate, 1);
  assert.ok(rowFor(later, 'a0000000000000001'));

  const earlier = readCompactionOutcomes({ transcriptDir: FIXTURE_DIR, until: '2026-09-01T11:30:00.000Z' });
  assert.equal(earlier.transcripts.length, 1);
  assert.deepEqual(rowFor(earlier).compactions, { total: 1, auto: 0, manual: 1, other: 0 });
  assert.equal(rowFor(earlier).jev.fallback_rate, 0);
});

test('reports a missing transcript directory as unavailable instead of throwing', () => {
  const missing = path.join(os.tmpdir(), `loadout-compaction-missing-${process.pid}-${Date.now()}`);
  const result = readCompactionOutcomes({ transcriptDir: missing });
  assert.equal(result.available, false);
  assert.match(result.reason, /transcript directory not found/);
  assert.equal(readCompactionOutcomes({}).available, false);
});

test('rejects an invalid usage window instead of silently scanning everything', () => {
  assert.throws(() => readCompactionOutcomes({ transcriptDir: FIXTURE_DIR, since: 'not-a-date' }), /Invalid --since/);
});

test('derives the Claude Code transcript directory from the project path and config dir', () => {
  assert.equal(
    defaultTranscriptDir('/Users/someone/Code/github.com/org/repo', { CLAUDE_CONFIG_DIR: '/cfg/claude' }, '/home/ignored'),
    path.join('/cfg/claude', 'projects', '-Users-someone-Code-github-com-org-repo'),
  );
  assert.equal(
    defaultTranscriptDir('/srv/my_repo', {}, '/home/someone'),
    path.join('/home/someone', '.claude', 'projects', '-srv-my-repo'),
  );
});
