'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { hooks } = require('../hooks/hooks.json');
const { recordSessionTally } = require('../lib/state.js');

test('keeps startup-only and startup-or-resume hooks separate with their existing timeouts', () => {
  assert.deepEqual(hooks, {
    SessionStart: [
      {
        matcher: 'startup',
        hooks: [
          {
            type: 'command',
            command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-auto-allowlist.js"',
            timeout: 10,
          },
          {
            type: 'command',
            command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-nudge.js"',
            timeout: 10,
          },
        ],
      },
      {
        matcher: 'startup|resume',
        hooks: [
          {
            type: 'command',
            command: 'node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-freshness.js"',
            timeout: 5,
          },
          {
            type: 'command',
            command: 'node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/billing-path-check.js"',
            timeout: 5,
          },
          {
            type: 'command',
            command: 'node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/marketplace-freshness-cache.js"',
            timeout: 2,
          },
        ],
      },
    ],
    SessionEnd: [
      {
        hooks: [
          {
            type: 'command',
            command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-end-tally.js"',
            timeout: 30,
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: 'command',
            command: 'node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/stop-resupply-offer.js"',
            timeout: 10,
          },
          {
            type: 'command',
            command: 'node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/stop-update-check.js"',
            timeout: 5,
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: 'command',
            command: 'node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/user-prompt-freshness.js"',
            timeout: 10,
          },
        ],
      },
    ],
  });
});

test('Stop resupply decline command uses resolved hook and project paths', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-project-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-state-'));
  const environment = { QUARTERMASTER_STATE_DIR: stateDir };
  for (let index = 0; index < 4; index += 1) {
    recordSessionTally(projectDir, `session-${index}`, { prompts: 4, toolCalls: 8 }, environment);
  }

  const hook = path.join(__dirname, '..', 'hooks', 'stop-resupply-offer.js');
  const result = spawnSync(process.execPath, [hook], {
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: '/foreign-plugin-root',
      CLAUDE_PROJECT_DIR: projectDir,
      QUARTERMASTER_STATE_DIR: stateDir,
    },
    input: JSON.stringify({ session_id: 'stop-session', cwd: projectDir }),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const { hookSpecificOutput } = JSON.parse(result.stdout);
  const { additionalContext: reason } = hookSpecificOutput;
  assert.equal(hookSpecificOutput.hookEventName, 'Stop');
  assert.match(reason, new RegExp(`node "${path.join(__dirname, '..', 'bin', 'quartermaster.js')}"`));
  assert.match(reason, new RegExp(`--project "${projectDir}"`));
  assert.doesNotMatch(reason, /\$\{CLAUDE_/);
});
