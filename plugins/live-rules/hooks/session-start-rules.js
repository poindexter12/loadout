#!/usr/bin/env node
/**
 * live-rules - SessionStart hook
 *
 * Re-grounds the project's always-on rules after a summarising compaction, and
 * records what native already loaded at every other kind of session start.
 *
 * SQ-293, native first: native Claude Code reads .claude/rules/ itself when a
 * context begins, so at startup | resume | clear the rules are in context
 * before this hook runs and emitting them would be saying everything twice.
 * The hook instead records their hashes in the session ledger, which is what
 * lets the prompt and edit hooks notice later that a rule file CHANGED.
 *
 * A summarising compaction is the one SessionStart where that is not true: the
 * transcript is replaced by a summary, nothing re-reads the rule files, and the
 * rules native loaded at startup are gone. Re-grounding there is the README's
 * promise that always-on rules survive compaction. (A *replacement* compaction
 * keeps history verbatim, so it gets a short note instead - see SQ-197 below.)
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

/**
 * Is native Claude Code loading the rule files itself on this SessionStart?
 *
 * startup | resume | clear all begin a context that native populates from
 * .claude/rules/ directly, so every global rule is already in it and live-rules
 * must not say it again (SQ-293). A missing source is treated the same way:
 * staying silent risks nothing, since native is the one carrier that is always
 * present.
 *
 * compact is the exception. A summarising compaction replaces the transcript
 * with a summary, and nothing re-reads the rule files at that boundary, so the
 * rules native loaded at startup are simply gone. live-rules re-grounding them
 * is the only thing that puts them back, which is the README's promise that
 * always-on rules survive compaction.
 */
function nativeLoadsRules(source) {
  return String(source || 'startup') !== 'compact';
}

function main() {
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

  // SQ-293, native first: at a real session start the rules are already in
  // context because native read the same files. Record their hashes so a later
  // edit can be detected as a change, and say nothing.
  if (nativeLoadsRules(data.source)) {
    ledger.record(projectDir, data.session_id, selected);
    if (ruleSet.notice) lib.emit('SessionStart', ruleSet.notice);
    process.exit(0);
  }

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
