#!/usr/bin/env node
import './shared/sqlite-budget.js';
import { boardReconciliationReminder } from './board-reconciliation-reminder.js';
import { compactionSuggestion } from './shared/compaction.js';
import { recordLiveRefs } from './shared/compaction-policy.js';
import { readStdin } from './shared/input.js';
import { writeContext, writeSystemMessage } from './shared/output.js';

async function main(): Promise<void> {
  const input = readStdin();
  if (!input) return;
  // Feeds the session.compact module (hooks/fn/compaction.js) which refs are still open and the
  // board pin. A no-op unless the compactionGuard option is auto or on; it writes no output.
  await recordLiveRefs(input);
  if (input.stop_hook_active === true) return;

  const reconciliation = boardReconciliationReminder(input);
  if (reconciliation) {
    writeContext('Stop', reconciliation);
    return;
  }

  const compaction = await compactionSuggestion(input);
  if (compaction) writeSystemMessage('Stop', compaction);
}

void main().catch(() => {});
