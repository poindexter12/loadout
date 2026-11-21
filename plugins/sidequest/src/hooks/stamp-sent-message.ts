#!/usr/bin/env node
// US-8 Q6 (SQ-420): the `sent` stamper. PostToolUse fires only after a SendMessage succeeded, so a
// question or answer marker in its message is evidence the send reached the harness. Each marker
// appends one `sent` event to the question log ({qid|aid, to, session}); that stamp is what parks a
// held claim at SubagentStop and what lets block-once stand down (plan §2.3, §2.5). It takes only the
// question log's own append lock, never the board lock, and writes nothing to the transcript.
import './shared/sqlite-budget.js';
import { isRecord, readStdin, stringField } from './shared/input.js';
import { runtimeModule } from './shared/paths.js';
import { messageMarkers, projectSlugFor, questionLog } from './shared/questions.js';

function main(): void {
  const input = readStdin();
  if (!input || stringField(input, 'tool_name') !== 'SendMessage' || !isRecord(input.tool_input)) return;
  const markers = messageMarkers(input.tool_input.message).filter((marker) => marker.qid || marker.aid);
  if (!markers.length) return;
  const store = require(runtimeModule('store')) as Parameters<typeof projectSlugFor>[1];
  const slug = projectSlugFor(stringField(input, 'cwd') || process.env.CLAUDE_PROJECT_DIR || process.cwd(), store);
  if (!slug) return;
  const log = questionLog();
  const dir = log.questionLogDir(slug);
  const toRaw = input.tool_input.to;
  const to = String(toRaw == null ? '' : toRaw).trim();
  const session = stringField(input, 'session_id', 'sessionId') || null;
  for (const marker of markers) {
    try {
      log.recordSent(dir, { qid: marker.qid, aid: marker.kind === 'answer' ? marker.aid : null, to, session });
    } catch (_) {
      // One marker that cannot be stamped must not cost the others theirs.
    }
  }
}

try {
  main();
} catch (_) {
  process.exit(0);
}
