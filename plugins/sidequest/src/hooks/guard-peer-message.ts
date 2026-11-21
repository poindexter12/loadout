#!/usr/bin/env node
import './shared/sqlite-budget.js';
import { isRecord, readStdin, stringField } from './shared/input.js';
import { writeDeny } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';
import { clipText, messageMarkers, projectSlugFor, questionLog } from './shared/questions.js';

interface TerminalDispatch {
  ref: string;
  outcome: string;
}

interface MissingWorktreeDispatch {
  ref: string;
  worktree: string;
}

function isolatedDispatchWithMissingWorktree(agentName: string): MissingWorktreeDispatch | null {
  try {
    const store = require(runtimeModule('store')) as {
      isolatedDispatchWithMissingWorktree: (agentName: string) => MissingWorktreeDispatch | null;
    };
    return store.isolatedDispatchWithMissingWorktree(agentName);
  } catch (_) {
    return null;
  }
}

function terminalDispatchTarget(agentName: string): TerminalDispatch | null {
  try {
    const store = require(runtimeModule('store')) as {
      terminalDispatchTarget: (agentName: string) => TerminalDispatch | null;
    };
    return store.terminalDispatchTarget(agentName);
  } catch (_) {
    return null;
  }
}

// US-8 Q6 (SQ-420): a question or answer marker must name a qid this project's question log knows. A
// hand-written or stale marker would otherwise reach main or an executor as if the board had sent it,
// and the `sent` stamp could never land on it. An answer marker from a subagent is refused outright:
// an executor can never answer its own or a sibling's question. Reads the question log, never the
// board lock; any failure to resolve the log fails open, like the rest of this guard.
function markerRefusal(input: Record<string, unknown>, message: unknown): string | null {
  const markers = messageMarkers(message);
  if (!markers.length) return null;
  if (stringField(input, 'agent_id', 'agentId') && markers.some((marker) => marker.kind === 'answer')) {
    return 'sidequest: an executor cannot send an answer marker. Only the orchestrating session answers a question, through answer, and an executor can never answer its own or a sibling\'s question.';
  }
  let dir: string;
  let log: ReturnType<typeof questionLog>;
  try {
    const store = require(runtimeModule('store')) as Parameters<typeof projectSlugFor>[1];
    const slug = projectSlugFor(stringField(input, 'cwd') || process.env.CLAUDE_PROJECT_DIR || process.cwd(), store);
    if (!slug) return null;
    log = questionLog();
    dir = log.questionLogDir(slug);
  } catch (_) {
    return null;
  }
  for (const marker of markers) {
    if (marker.qid && log.findQuestion(dir, marker.qid)) continue;
    return `sidequest: ${clipText(marker.raw, 120)} names no question on this board. ` +
      'Send the exact SendMessage that ask or answer returned; never write a sidequest marker by hand.';
  }
  return null;
}

function main(): void {
  const input = readStdin();
  if (!input || stringField(input, 'tool_name') !== 'SendMessage' || !isRecord(input.tool_input)) return;
  const toRaw = input.tool_input.to;
  const to = String(toRaw == null ? '' : toRaw).trim();
  const refusal = markerRefusal(input, input.tool_input.message);
  if (refusal) {
    writeDeny('PreToolUse', refusal);
    return;
  }
  const terminal = terminalDispatchTarget(to);
  if (terminal) {
    writeDeny(
      'PreToolUse',
      `sidequest: ${terminal.ref} is terminal (${terminal.outcome}) and executor "${to}" is closed. ` +
        'File a follow-up ticket for changes, or redispatch the existing ticket when it was released without a pending submission.',
    );
    return;
  }
  const missing = isolatedDispatchWithMissingWorktree(to);
  if (missing) {
    writeDeny(
      'PreToolUse',
      `sidequest: ${missing.ref} is worktree-isolated but its recorded worktree is gone. ` +
        'Do not resume this executor because it could write to the shared checkout. Redispatch the ticket instead.',
    );
  }
}

try {
  main();
} catch (_) {
  process.exit(0);
}
