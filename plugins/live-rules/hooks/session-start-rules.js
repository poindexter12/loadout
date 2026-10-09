#!/usr/bin/env node
/**
 * live-rules - SessionStart hook
 *
 * Injects the project's always-on rules once, at session start, as a fallback
 * delivery path alongside the UserPromptSubmit hook.
 *
 * Why this exists: Claude Code snapshots a session's hook registrations at
 * session start. If live-rules is installed or updated mid-session, the new
 * UserPromptSubmit wiring does not take effect until the session restarts, but
 * nothing tells you that: the hook just never fires, silently, for the rest of
 * the session. This hook cannot fix that same-session gap (it also only fires
 * at session start), but it does two useful things for every session going
 * forward:
 *   - guarantees always-on rules reach the model at least once, even if
 *     UserPromptSubmit's wiring is somehow stale or broken that session, and
 *   - gives a concrete, checkable signal: if this block does not reappear on
 *     your very next prompt, the per-prompt hook is not wired. See the README
 *     "Restart after enabling or updating" section.
 *
 * Design constraints (shared with the rest of live-rules):
 *   - No external dependencies (Node stdlib only).
 *   - Cross-platform (Windows / macOS / Linux).
 *   - Silent when there are no .claude/rules/*.md files, or no always-on rule.
 *   - Never breaks a session: any error -> exit 0 with no output.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

// SQ-197: sidequest's PostCompact hook is the only one of the three plugins that observes
// compact_summary, so it marks a "replacement" compaction (host kept history verbatim, no
// summary) with a small file. This formula is duplicated (not imported — plugins don't import
// each other) in sidequest's shared/compaction.ts and codebase-mapper's inject-context.js, and
// must stay exactly in sync there: SIDEQUEST_HOME first (any subprocess in the session can read
// this env var), else a CLAUDE_CONFIG_DIR-rooted path, never a bare hardcoded ~/.claude. Only
// sidequest deletes the marker; this is a non-destructive peek, bounded by age so a marker
// sidequest never got to consume cannot suppress re-grounding on a later, unrelated compaction.
const REPLACEMENT_MARKER_MAX_AGE_MS = 2 * 60 * 1000;

function replacementMarkerFile(sessionId) {
  const sidequestHome = String(process.env.SIDEQUEST_HOME || '').trim();
  const home = sidequestHome || path.join(String(process.env.CLAUDE_CONFIG_DIR || '').trim() || path.join(os.homedir(), '.claude'), 'sidequest');
  return path.join(home, 'replacement-compactions', encodeURIComponent(sessionId) + '.json');
}

function isReplacementCompaction(sessionId) {
  if (!sessionId) return false;
  try {
    const stat = fs.statSync(replacementMarkerFile(sessionId));
    return Date.now() - stat.mtimeMs <= REPLACEMENT_MARKER_MAX_AGE_MS;
  } catch (_) {
    return false;
  }
}

function main() {
  // Deliberately does not filter on data.source (startup | resume | clear |
  // compact): always-on rules must re-inject after compaction too, or the
  // README's promise that they survive compaction would silently break.
  const data = lib.readStdin();
  const projectDir = lib.getProjectDir(data);

  // SQ-292: rules live in .claude/rules/*.md and are read straight off disk, so
  // there is nothing to migrate or verify here. A project whose rules are still
  // in a retired store gets one notice telling it how to move them; this hook is
  // the only one that emits it, so the nudge does not repeat on every prompt.
  const ruleSet = lib.loadRuleSet(projectDir);
  if (!ruleSet.rules.length) {
    if (ruleSet.notice) lib.emit('SessionStart', ruleSet.notice);
    process.exit(0);
  }

  // SQ-197: a replacement compaction keeps the prior full rule re-injection sitting verbatim in
  // history; emit a short note instead. A normal summarized compaction keeps today's behaviour
  // (the reset-every-time re-injection below, which exists so always-on rules survive compaction).
  if (data.source === 'compact' && isReplacementCompaction(data.session_id)) {
    lib.emit('SessionStart', (ruleSet.notice ? ruleSet.notice + '\n\n' : '') +
      'live-rules: history retained across a replacement compaction; the rule set is already in the transcript.');
    process.exit(0);
  }

  const cwd = (data && typeof data.cwd === 'string' && data.cwd) || projectDir;
  const cwdRel = projectRelative(projectDir, cwd);
  const selected = lib.attachIncludes(lib.selectForPrompt(ruleSet.rules, { promptText: '', cwdRel }), projectDir);
  const changed = ledger.changed(projectDir, data.session_id, selected, true);
  if (!changed.length) {
    if (ruleSet.notice) lib.emit('SessionStart', ruleSet.notice);
    process.exit(0);
  }

  const header =
    (ruleSet.notice ? ruleSet.notice + '\n\n' : '') +
    '=== LIVE RULES (live-rules, session start) ===\n' +
    'Rules re-grounded after SessionStart (' + (data.source || 'startup') + '). ' +
    'Source: ' + lib.displayPath(projectDir, ruleSet.source);

  lib.emit('SessionStart', lib.renderRules(changed, header));
  process.exit(0);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
