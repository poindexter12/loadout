#!/usr/bin/env node
import './shared/sqlite-budget.js';
import fs from 'node:fs';
import { readStdin, stringField, type HookInput } from './shared/input.js';
import { runtimeModule } from './shared/paths.js';
import { markSessionEnded, projectSlugFor, questionLog } from './shared/questions.js';
import { detachSweep } from './shared/sweep-handoff.js';
import { unregisterSweepSession } from './shared/worktree-sweep.js';

interface ParkStore {
  nearestRepoRoot: (start: string) => string;
  findProject: (start: string) => { ok: boolean; slug?: string };
  getTicket: (slug: string, ticketId: string) => { ref?: string; status?: string; park?: { mode?: string } | null; claim?: { by?: string } | null } | null;
  releaseTicket: (slug: string, ticketId: string, by: string, options: Record<string, unknown>) => { ok?: boolean } | null;
}

// US-8 Q6 (story contract U1): the orchestrator that owns a held park is gone, so the SendMessage the
// executor waits on can never come. reconcileSession already released the claims this session
// registered; this pass catches a held park it did not reach. The question log names the tickets
// this session owns (asked.ownerSession), and a `session_ended` release detaches each one to a
// released park, which stays awaiting-user until the next session surfaces and answers it.
function detachHeldParks(store: ParkStore, data: HookInput, sessionId: string, reason: string): string[] {
  const slug = projectSlugFor(stringField(data, 'cwd') || process.env.CLAUDE_PROJECT_DIR || process.cwd(), store);
  if (!slug) return [];
  const ql = questionLog();
  const dir = ql.questionLogDir(slug);
  if (!fs.existsSync(dir)) return [];
  const ticketIds = new Set<string>();
  for (const question of ql.openQuestions(dir)) {
    if (question.asked.ownerSession === sessionId && question.asked.blocking && question.ticketId) ticketIds.add(question.ticketId);
  }
  const detached: string[] = [];
  for (const ticketId of ticketIds) {
    try {
      const ticket = store.getTicket(slug, ticketId);
      if (!ticket || ticket.status !== 'awaiting-user' || ticket.park?.mode !== 'held' || !ticket.claim?.by) continue;
      const result = store.releaseTicket(slug, ticketId, ticket.claim.by, {
        status: 'todo',
        source: 'session-end',
        claimRelease: { kind: 'session_ended', reason },
      });
      if (result && result.ok) detached.push(ticket.ref || ticketId);
    } catch (_) {
      /* one ticket must not stop the rest */
    }
  }
  return detached;
}

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
    try {
      detachHeldParks(store as unknown as ParkStore, data, sessionId, reason);
    } catch (error: any) {
      notices.push(`sidequest: session-end park detach failed: ${(error && error.message) || error}`);
    }
    const agentsync = require(runtimeModule('agentsync')) as {
      cleanupNativeAgents: (options: { sessionId: string }) => unknown;
    };
    agentsync.cleanupNativeAgents({ sessionId });
  } catch (error: any) {
    notices.push(`sidequest: session-end reconciliation failed: ${(error && error.message) || error}`);
  }

  // Orphans this session's open questions, so any later session in the project surfaces them.
  markSessionEnded(sessionId);
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
