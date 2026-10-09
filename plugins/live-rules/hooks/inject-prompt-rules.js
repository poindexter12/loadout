#!/usr/bin/env node
/**
 * live-rules - UserPromptSubmit hook
 *
 * On every user prompt, injects the project rules that apply right now AND are
 * not already in context. It reads .claude/rules fresh on every prompt, so an
 * edit to a rule takes effect on the very next prompt with no restart. That is
 * the "live" part.
 *
 * SQ-293, native first: native Claude Code loads the same files, so this hook
 * does not re-say what native has already delivered. It emits in exactly three
 * cases:
 *   - a prompt-keyword rule matched. Native scopes only by `paths:`, so it can
 *     never fire a rule off what the user just typed; these rules carry the
 *     NEVER_MATCH_PATH sentinel to stay out of native's global load, and this
 *     hook is their only delivery path.
 *   - a rule's file changed since it entered context, leaving a stale copy
 *     there that only live-rules can see is stale.
 *   - a `reground: true` rule's cadence came due (session-ledger.js).
 *
 * Always-on and cwd-scoped rules are otherwise silent here: native put them in
 * context already, and the ledger remembers that.
 *
 * Design constraints (shared with the rest of live-rules):
 *   - No external dependencies (Node stdlib only).
 *   - Cross-platform (Windows / macOS / Linux).
 *   - Silent when the project has no .claude/rules/*.md files.
 *   - Never breaks a prompt: any error -> exit 0 with no output.
 */

'use strict';

let lib;
let projectRelative;
let ledger;
try {
  lib = require('./lib/rules');
  ledger = require('./lib/session-ledger');
  ({ projectRelative } = require('./lib/canonical-path'));
} catch (_) {
  process.exit(0);
}

function main() {
  const data = lib.readStdin();
  const projectDir = lib.getProjectDir(data);

  const ruleSet = lib.loadRuleSet(projectDir);
  if (!ruleSet.rules.length) process.exit(0);

  const cwd = (data && typeof data.cwd === 'string' && data.cwd) || projectDir;
  let cwdRel = '';
  try {
    cwdRel = projectRelative(projectDir, cwd);
  } catch (_) {
    cwdRel = '';
  }

  const promptText = data && typeof data.prompt === 'string' ? data.prompt : '';

  // SQ-293, native first. `turn: true` counts this prompt, which is the clock
  // the `reground:` cadence runs on. reconcile() keeps quiet about anything
  // native has already put in context at this hash.
  const selected = lib.attachIncludes(lib.selectForPrompt(ruleSet.rules, { promptText, cwdRel }), projectDir);
  const changed = ledger.reconcile(projectDir, data.session_id, selected, { reset: false, turn: true });
  if (!changed.length) process.exit(0);

  const header =
    '=== LIVE RULES (live-rules) ===\n' +
    'Project rules that apply to this prompt and are not already in context. Follow them for the work in this session. ' +
    'Source: ' + lib.displayPath(projectDir, ruleSet.source);

  lib.emit('UserPromptSubmit', lib.renderRules(changed, header));
  process.exit(0);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
