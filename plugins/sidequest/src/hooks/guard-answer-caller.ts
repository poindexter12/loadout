#!/usr/bin/env node
// US-8 Q6 (SQ-420): the story invariant "an executor can never answer its own or a sibling's question".
// The answer handler's `by === claim.by` check is a label comparison an in-session executor can step
// around, because it shares its parent's session id (plan §1 (a)). The hook input is the one place that
// tells them apart: Claude Code adds `agent_id` only to calls made inside a subagent. `agent_type`
// alone is not used, because a main session started with `--agent` carries it too and is a legitimate
// orchestrator. Pure input inspection: no store, no lock.
//
// Imported first like every 10s hook (SQ-125). The decision never opens the board, so the budget is inert
// here and fail-open is safe: holding the board lock cannot change what this guard decides. It keeps any
// board read added later inside the hook budget instead of the server's 15s waits.
import './shared/sqlite-budget.js';
import { readStdin, stringField } from './shared/input.js';
import { writeDeny } from './shared/output.js';

// The plugin's board server, or the same server registered directly as `sidequest`.
const ANSWER_TOOL = /^mcp__(?:plugin_sidequest_board|sidequest)__answer$/;

function main(): void {
  const input = readStdin();
  if (!input || !ANSWER_TOOL.test(stringField(input, 'tool_name'))) return;
  if (!stringField(input, 'agent_id', 'agentId')) return;
  writeDeny(
    'PreToolUse',
    'sidequest: answer is for the orchestrating session; an executor cannot answer its own or a sibling\'s question. ' +
      'Send the question to main with the SendMessage that ask returned, or release with kind question.',
  );
}

try {
  main();
} catch (_) {
  process.exit(0);
}
