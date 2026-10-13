#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { markOffered, statusFor } = require('../lib/state.js');

function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function offerReason(status, projectDir) {
  const cli = path.resolve(__dirname, '..', 'bin', 'quartermaster.js');
  return `quartermaster: ${status.unanalyzedSessions} sessions and ${status.frictionEvents} friction events since last resupply. Offer an optimization round. With user or standing permission, run /quartermaster:resupply. If declined, run node "${cli}" decline-resupply --project "${projectDir}" to reset.`;
}

function main() {
  const data = readStdin();
  if (data.stop_hook_active || !data.session_id) return;

  const projectDir = process.env.CLAUDE_PROJECT_DIR || data.cwd || process.cwd();
  const status = statusFor(projectDir);
  if (!status.shouldOffer || status.offeredSessionIds.includes(data.session_id)) return;

  markOffered(projectDir, data.session_id);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: offerReason(status, projectDir),
    },
  }));
}

try {
  main();
} catch {
  process.exit(0);
}
