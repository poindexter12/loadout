import './_temp-cleanup.js';
import './_hook-runtime.js';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-compaction-test-'));
process.env.SIDEQUEST_HOME = HOME;

const store = require('../lib/store.js');
const boardPath = path.join(HOME, 'board');
fs.mkdirSync(boardPath, { recursive: true });
const { slug } = store.ensureProject(boardPath);
const hooks = path.join(__dirname, '..', 'hooks');
const stopHook = path.join(hooks, 'stop.js');
const postCompactHook = path.join(hooks, 'post-compact.js');

function hook(script: string, payload: unknown, env: Record<string, string> = {}): any {
  const output = execFileSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }).trim();
  return output ? JSON.parse(output) : null;
}

function closeTicket(title: string): any {
  const ticket = store.createTicket(slug, { title, source: 'test' });
  assert.equal(store.completeTicket(slug, ticket.ref, 'test-worker').ok, true);
  return ticket;
}

function stop(sessionId: string, transcriptPath: string, env: Record<string, string> = {}): any {
  return hook(stopHook, {
    session_id: sessionId,
    cwd: boardPath,
    transcript_path: transcriptPath,
    last_assistant_message: 'Finished the last task.',
  }, env);
}

test('compaction suggestion fires only at a real board boundary and rearms on PostCompact', () => {
  const transcript = path.join(HOME, 'transcript.jsonl');
  fs.writeFileSync(transcript, '[]');
  const sessionId = 'compaction-boundary';
  hook(postCompactHook, { session_id: sessionId, transcript_path: transcript });

  assert.equal(stop(sessionId, transcript), null, 'nothing accumulated stays silent');

  const first = [closeTicket('first'), closeTicket('second'), closeTicket('third')];
  const suggestion = stop(sessionId, transcript);
  assert.match(suggestion.systemMessage, /compaction is safe/);
  for (const ticket of first) assert.match(suggestion.systemMessage, new RegExp(ticket.ref));
  assert.equal(stop(sessionId, transcript), null, 'cooldown suppresses consecutive turns without PostCompact');

  const afterFirstSuggestion = [
    closeTicket('fourth'),
    closeTicket('fifth'),
    closeTicket('sixth'),
    closeTicket('seventh'),
    closeTicket('eighth'),
    closeTicket('ninth'),
  ];
  const active = store.createTicket(slug, { title: 'still running', source: 'test' });
  assert.equal(store.claimTicket(slug, active.ref, 'live-worker').ok, true);
  assert.equal(stop(sessionId, transcript), null, 'a live claim blocks the suggestion');
  assert.equal(store.releaseTicket(slug, active.ref, 'live-worker', { status: 'todo' }).ok, true);
  const resumed = stop(sessionId, transcript);
  assert.match(resumed.systemMessage, new RegExp(afterFirstSuggestion.at(-1)!.ref), 'materially higher accumulation rearms after an ignored suggestion');
  for (let turn = 1; turn <= 5; turn += 1) {
    assert.equal(stop(sessionId, transcript), null, `turn ${turn} after the second suggestion stays silent without PostCompact`);
  }

  hook(postCompactHook, { session_id: sessionId, transcript_path: transcript });
  assert.equal(stop(sessionId, transcript), null, 'PostCompact clears the accumulators and cooldown');
  closeTicket('after compact one');
  closeTicket('after compact two');
  const afterCompactThree = closeTicket('after compact three');
  const afterCompactSuggestion = stop(sessionId, transcript);
  assert.match(afterCompactSuggestion.systemMessage, new RegExp(afterCompactThree.ref));
});

test('compaction suggestion tracks transcript bytes and honors the kill switch', () => {
  const transcript = path.join(HOME, 'growth.jsonl');
  fs.writeFileSync(transcript, '[]');
  const sessionId = 'compaction-growth';
  hook(postCompactHook, { session_id: sessionId, transcript_path: transcript });

  // The engine re-appends jev's kept history between PostCompact and the first Stop. The first
  // Stop after a compaction must absorb that into the new baseline rather than suggest on it.
  fs.writeFileSync(transcript, 'x'.repeat(1024 * 1024));
  assert.equal(stop(sessionId, transcript), null, 'the first Stop after compaction only records the new baseline');

  fs.writeFileSync(transcript, 'x'.repeat(1024 * 1024 + 3 * 1024 * 1024 + 2));
  const suggestion = stop(sessionId, transcript);
  assert.match(suggestion.systemMessage, /Transcript growth: 3.0 MB/, 'growth is measured from the post-reappend baseline, not the PostCompact-time size');
  fs.writeFileSync(transcript, 'x'.repeat(1024 * 1024 + 9 * 1024 * 1024 + 4));
  const rearmed = stop(sessionId, transcript);
  assert.match(rearmed.systemMessage, /Transcript growth: 6.0 MB/, 'the retry threshold measures fresh growth after the first suggestion');
  assert.equal(stop(sessionId, transcript), null, 'the second transcript suggestion does not nag on later turns');
  assert.equal(stop(sessionId, transcript, { SIDEQUEST_COMPACTION_SUGGESTIONS: 'off' }), null);
});

test('compaction baseline absorbs the kept-history re-append instead of counting it as growth', () => {
  const transcript = path.join(HOME, 'reappend.jsonl');
  fs.writeFileSync(transcript, '[]');
  const sessionId = 'compaction-reappend';
  hook(postCompactHook, { session_id: sessionId, transcript_path: transcript });

  // Simulate the engine re-appending a large chunk of kept history before the session's first
  // Stop fires. Under the SQ-195 bug this alone would look like 1.5MB of growth and (combined
  // with enough closed tickets) could trip the suggestion immediately after compaction.
  fs.writeFileSync(transcript, 'x'.repeat(1536 * 1024));
  closeTicket('reappend one');
  closeTicket('reappend two');
  closeTicket('reappend three');
  assert.equal(stop(sessionId, transcript), null, 'the kept-history re-append produces no suggestion on the first post-compaction Stop');

  // Real growth after that first Stop still trips the suggestion normally.
  fs.writeFileSync(transcript, 'x'.repeat(1536 * 1024 + 3 * 1024 * 1024 + 2));
  const suggestion = stop(sessionId, transcript);
  assert.match(suggestion.systemMessage, /compaction is safe/);
  assert.match(suggestion.systemMessage, /Transcript growth: 3.0 MB/, 'real growth after the established baseline still triggers a suggestion');
});
