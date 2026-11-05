#!/usr/bin/env node
import './shared/sqlite-budget.js';
import { readStdin, stringField } from './shared/input.js';
import { runtimeModule } from './shared/paths.js';
import { detachSweep } from './shared/sweep-handoff.js';
import { unregisterSweepSession } from './shared/worktree-sweep.js';

function main(): void {
  const data = readStdin();
  if (!data) return;
  const sessionId = stringField(data, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
  if (!sessionId) return;
  const reasonValue = data.reason;
  const reason = reasonValue ? `session ended (${String(reasonValue)})` : 'session ended';
  const notices: string[] = [];

  try {
    const store = require(runtimeModule('store')) as {
      reconcileSession: (sessionId: string, options: { reason: string; source: string }) => unknown;
    };
    store.reconcileSession(sessionId, { reason, source: 'session-end' });
    const agentsync = require(runtimeModule('agentsync')) as {
      cleanupNativeAgents: (options: { sessionId: string }) => unknown;
    };
    agentsync.cleanupNativeAgents({ sessionId });
  } catch (error: any) {
    notices.push(`sidequest: session-end reconciliation failed: ${(error && error.message) || error}`);
  }

  unregisterSweepSession(data);

  // SQ-386: the sweep runs in a detached worker. Claude Code cancels a SessionEnd hook
  // that outlives its shutdown window, and an inline sweep takes seconds.
  try {
    notices.push(...detachSweep(data));
  } catch (error: any) {
    notices.push(`sidequest: session-end worktree sweep failed: ${(error && error.message) || error}`);
  }

  if (notices.length) console.error(notices.join('\n'));
}

try {
  main();
} catch (error: any) {
  console.error(`sidequest: session-end failed: ${(error && error.message) || error}`);
}
