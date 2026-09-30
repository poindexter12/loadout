#!/usr/bin/env node
import './shared/sqlite-budget.js';
import { readStdin, stringField } from './shared/input.js';
import { isPrimarySession, recordReplacementCompaction, resetCompactionState } from './shared/compaction.js';

function main(): void {
  const input = readStdin();
  if (!input || !isPrimarySession(input)) return;
  const sessionId = stringField(input, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || '';
  if (!sessionId) return;
  resetCompactionState(sessionId, input.transcript_path || input.transcriptPath);
  // A replacement compaction (no summary generated) keeps prior SessionStart re-grounding in
  // history verbatim; mark it so SessionStart(compact) can emit a short note instead (SQ-197).
  // Every compaction first drops any earlier marker, so a summarized one never inherits it (SQ-200).
  recordReplacementCompaction(sessionId, input.compact_summary === '');
}

try {
  main();
} catch (_) {
  process.exit(0);
}
