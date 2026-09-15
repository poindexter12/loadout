#!/usr/bin/env node
'use strict';

/**
 * SessionStart: put the capability-capture charter in front of every session, and tell Claude to
 * offer a resupply pass when one is due. This hook never analyzes anything itself. Continuous
 * background analysis is the documented failure mode of this plugin category (piles of suggestions
 * nobody triages), so deep analysis only starts after the user accepts a bounded optimization round,
 * and every recommendation that pass surfaces still needs the user's per-item approval before anything
 * changes.
 */

const fs = require('node:fs');
const path = require('node:path');

const { countRecentTranscripts } = require('../lib/scan.js');
const { markNudged, readProjectState, statusFor } = require('../lib/state.js');

const FIRST_RUN_MIN_TRANSCRIPTS = 5;

// Setup seeds a project-specific live rule; Live Rules deduplicates it by path/hash within a
// session. This fallback covers projects without that file and grants no permission to make changes.
const CAPABILITY_CHARTER = 'quartermaster: notice repeated manual work, missing checks, re-derived knowledge, and unclear conventions during the requested work. Check project code, native platform features, the standard library, and installed dependencies, plugins, and skills before proposing another capability. Reuse what works; a missing check need not become a new measurement skill. If an existing skill misfires, under-triggers, or needs manual correction, offer to improve it. If nothing was missing, stay silent. At a useful pause, offer a focused optimization round for the development system, setup, tooling, or workflow. Before running resupply or mining transcripts, require current user approval or explicit standing permission for these rounds. Round approval does not authorize unrelated edits. Show each exact change and get per-item approval unless explicit standing permission covers that exact class of change.';

function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function emit(context) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
  }));
}

function seededSelfImprovementRuleExists(projectDir) {
  return fs.existsSync(path.join(projectDir, '.claude', 'live-rules', 'rules', 'self-improvement.md'));
}

function resupplyNudge(projectDir) {
  const state = readProjectState(projectDir);
  if (!state.sessions.length && !state.lastResupplyAt) {
    // Freshly installed: no tallies yet, but past transcripts may already be worth a first look.
    if (state.lastNudgeAt) return null;
    const recent = countRecentTranscripts(projectDir, 14);
    if (recent < FIRST_RUN_MIN_TRANSCRIPTS) return null;
    markNudged(projectDir);
    return `quartermaster is newly installed and found ${recent} recent sessions for this project. Once the user's current ask is handled, proactively ask whether they want a focused optimization round for their development system, setup, tooling, or workflow. Run the quartermaster resupply skill after they say yes, or automatically if they have explicitly given standing permission for these rounds. It proposes one recommendation at a time, and nothing changes without approval unless their standing permission also covers that exact class of change.`;
  }

  const status = statusFor(projectDir);
  if (!status.shouldNudge) return null;
  markNudged(projectDir);
  return `quartermaster: ${status.unanalyzedSessions} sessions since the last resupply, with ${status.frictionEvents} friction events recorded (permission denials, interrupts, corrections). The Stop-time offer will hold one real pause open so you briefly offer the user a focused optimization round for their development system, setup, tooling, or workflow. Run the quartermaster resupply skill after they say yes, or automatically if they have explicitly given standing permission for these rounds. Nothing has been analyzed yet, and each recommendation still needs separate approval unless their standing permission also covers that exact class of change.`;
}

function main() {
  const data = readStdin();
  if (data.source && data.source !== 'startup') return;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || data.cwd || process.cwd();

  const parts = [];
  if (!seededSelfImprovementRuleExists(projectDir)) parts.push(CAPABILITY_CHARTER);
  const nudge = resupplyNudge(projectDir);
  if (nudge) parts.push(nudge);
  if (parts.length) emit(parts.join('\n\n'));
}

try {
  main();
} catch {
  process.exit(0);
}
