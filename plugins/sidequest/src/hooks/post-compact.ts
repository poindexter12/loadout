#!/usr/bin/env node
import './shared/sqlite-budget.js';
import { readStdin, stringField, type HookInput } from './shared/input.js';
import { isPrimarySession, recordReplacementCompaction, resetCompactionState } from './shared/compaction.js';
import { writeContext } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';
import { clearSuppression, projectSlugFor, questionSummaryLine, routedOpenQuestions } from './shared/questions.js';

// US-8 Q6: a compaction drops whatever question text the session was shown, so the session's
// suppression is cleared (each open question is asked once more at the next stop or prompt) and one
// line names what is still open. Reads the question log, never the board lock.
function openQuestionLine(input: HookInput, sessionId: string): string {
  clearSuppression(sessionId);
  try {
    const store = require(runtimeModule('store'));
    const slug = projectSlugFor(stringField(input, 'cwd') || process.env.CLAUDE_PROJECT_DIR || process.cwd(), store);
    return slug ? questionSummaryLine(routedOpenQuestions(slug, sessionId)) : '';
  } catch (_) {
    return '';
  }
}

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
  const line = openQuestionLine(input, sessionId);
  if (line) writeContext('PostCompact', line);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
