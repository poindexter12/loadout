#!/usr/bin/env node
/**
 * live-rules - PreToolUse hook (Edit | Write | MultiEdit | NotebookEdit)
 *
 * Right before Claude edits a file, re-states any project rule scoped to that
 * file whose content has CHANGED since the rule was loaded.
 *
 * SQ-293, native first: native Claude Code loads a `paths:` rule itself when a
 * tool touches a matching file, so on the first match the rule is already on
 * its way into context and live-rules stays silent, recording the hash in the
 * session ledger. What native cannot do is notice that a rule file was edited
 * after it loaded, leaving a stale copy in context. That is this hook's job.
 *
 * It emits ONLY hookSpecificOutput.additionalContext. It deliberately does NOT
 * return a permissionDecision: setting "allow" would skip the user's normal
 * edit-permission prompt, and this hook's job is to inform Claude, not to change
 * what gets approved. The edit proceeds through the usual permission flow.
 *
 * Design constraints:
 *   - No external dependencies (Node stdlib only).
 *   - Cross-platform (Windows / macOS / Linux).
 *   - Silent when there are no .claude/rules/*.md files / no matching rule.
 *   - Never blocks or breaks an edit: any error -> exit 0 with no output.
 *     (Exit 2 would block the tool; we never do that.)
 */

'use strict';

const path = require('path');

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
  const ti = (data && data.tool_input) || {};
  const filePath = ti.file_path || ti.notebook_path;
  if (!filePath || typeof filePath !== 'string') process.exit(0);

  const projectDir = lib.getProjectDir(data);

  const ruleSet = lib.loadRuleSet(projectDir);
  if (!ruleSet.rules.length) process.exit(0);

  // Resolve to a repo-relative POSIX path. path.resolve handles both absolute
  // (Windows "C:\repo\..." or POSIX "/repo/...") and already-relative inputs.
  let relPath;
  try {
    const abs = path.resolve(projectDir, filePath);
    relPath = projectRelative(projectDir, abs);
  } catch (_) {
    relPath = filePath.replace(/\\/g, '/');
  }

  // The file is outside this project: `paths:` patterns are repo-relative, so a
  // catch-all pattern should not match it. Stay silent.
  if (relPath === '..' || relPath.startsWith('../') || path.isAbsolute(relPath)) {
    process.exit(0);
  }

  // SQ-293, native first: this touch is exactly what makes native load a
  // matching `paths:` rule, so on a first match live-rules records the hash and
  // says nothing. It speaks on a later touch only if the file changed since,
  // which native will not notice on its own.
  const selected = lib.attachIncludes(lib.selectForEdit(ruleSet.rules, relPath), projectDir);
  const changed = ledger.reconcile(projectDir, data.session_id, selected, { reset: false });
  if (!changed.length) process.exit(0);

  const header =
    '=== LIVE RULES for ' + relPath + ' (live-rules) ===\n' +
    'A project rule that applies to this file changed since it was loaded. ' +
    'Follow the updated rule in this change. ' +
    'Source: ' + lib.displayPath(projectDir, ruleSet.source);

  lib.emit('PreToolUse', lib.renderRules(changed, header));
  process.exit(0);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
