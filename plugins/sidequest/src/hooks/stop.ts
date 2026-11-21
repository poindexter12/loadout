#!/usr/bin/env node
import './shared/sqlite-budget.js';
import { boardReconciliationReminder } from './board-reconciliation-reminder.js';
import { compactionSuggestion } from './shared/compaction.js';
import { recordLiveRefs } from './shared/compaction-policy.js';
import { isSubagent, readStdin, stringField, type HookInput } from './shared/input.js';
import { writeContext, writeSystemMessage } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';
import { markSurfaced, projectSlugFor, routedOpenQuestions, stopQuestionItem, surfacedQids } from './shared/questions.js';

// US-8 Q6: one open user question per stop, read from the question log (never the board lock).
// Blocking questions go first. The reconciliation reminder is transition-based, so a stop spent on a
// question leaves it for the next stop.
function questionItem(input: HookInput): string | null {
  if (isSubagent(input)) return null;
  const sessionId = stringField(input, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || '';
  if (!sessionId) return null;
  try {
    const store = require(runtimeModule('store'));
    const slug = projectSlugFor(stringField(input, 'cwd') || process.env.CLAUDE_PROJECT_DIR || process.cwd(), store);
    if (!slug) return null;
    const routed = routedOpenQuestions(slug, sessionId);
    const surfaced = surfacedQids(sessionId);
    const pending = routed.filter((question) => !surfaced.has(question.qid));
    const next = pending.find((question) => question.asked.blocking) || pending[0];
    if (!next) return null;
    markSurfaced(sessionId, [next.qid]);
    return stopQuestionItem(next, routed.length - 1);
  } catch (_) {
    return null;
  }
}

async function main(): Promise<void> {
  const input = readStdin();
  if (!input) return;
  // Feeds the session.compact module (hooks/fn/compaction.js) which refs are still open and the
  // board pin. A no-op unless the compactionGuard option is auto or on; it writes no output.
  await recordLiveRefs(input);
  if (input.stop_hook_active === true) return;

  const question = questionItem(input);
  if (question) {
    writeContext('Stop', question);
    return;
  }

  const reconciliation = boardReconciliationReminder(input);
  if (reconciliation) {
    writeContext('Stop', reconciliation);
    return;
  }

  const compaction = await compactionSuggestion(input);
  if (compaction) writeSystemMessage('Stop', compaction);
}

void main().catch(() => {});
