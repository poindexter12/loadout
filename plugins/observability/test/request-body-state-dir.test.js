'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const REQUEST_BODY = path.join(__dirname, '..', 'lib', 'observability', 'request-body.js');

// request-body.js resolves REQUEST_BODY_STATE_DIR once at require time, so an
// in-process env mutation would not be observed (see model-gateway's
// config-dir-state.test.js for the same pattern on its own copy of this
// directory). Read the resolved directory out of a fresh process instead.
function requestBodyStateDir(overrides = {}) {
  const environment = { ...process.env };
  delete environment.MODEL_GATEWAY_REQUEST_BODY_DIR;
  delete environment.MODEL_GATEWAY_CLAUDE_HOME;
  delete environment.CLAUDE_CONFIG_DIR;
  Object.assign(environment, overrides);
  const script = `const path = require('node:path');`
    + `const m = require(${JSON.stringify(REQUEST_BODY)});`
    + `process.stdout.write(path.dirname(m.requestBodyHighWaterPath('probe-session')));`;
  return execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env: environment });
}

// SQ-44: this directory is model-gateway's own state (it writes the
// per-session request-body high water; this statusline-side reader only
// consumes it), so the fallback here must mirror model-gateway's own
// CLAUDE_CONFIG_DIR precedence (lib/runtime.js) or the two plugins disagree
// about where the state lives on a multi-account machine.
test('request-body state dir follows CLAUDE_CONFIG_DIR instead of the OS home', () => {
  const configDir = path.join(os.tmpdir(), 'observability-request-body-account-a', '.claude');
  assert.equal(
    requestBodyStateDir({ CLAUDE_CONFIG_DIR: configDir }),
    path.join(configDir, 'model-gateway', 'request-body'),
  );
});

test('MODEL_GATEWAY_CLAUDE_HOME outranks CLAUDE_CONFIG_DIR for the request-body state dir', () => {
  const configDir = path.join(os.tmpdir(), 'observability-request-body-account-a', '.claude');
  const claudeHome = path.join(os.tmpdir(), 'observability-request-body-account-b', '.claude');
  assert.equal(
    requestBodyStateDir({ CLAUDE_CONFIG_DIR: configDir, MODEL_GATEWAY_CLAUDE_HOME: claudeHome }),
    path.join(claudeHome, 'model-gateway', 'request-body'),
  );
});

test('MODEL_GATEWAY_REQUEST_BODY_DIR still outranks CLAUDE_CONFIG_DIR for the request-body state dir', () => {
  const explicit = path.join(os.tmpdir(), 'observability-request-body-explicit');
  assert.equal(
    requestBodyStateDir({
      CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), 'observability-request-body-irrelevant', '.claude'),
      MODEL_GATEWAY_REQUEST_BODY_DIR: explicit,
    }),
    explicit,
  );
});

test('request-body state dir falls back to the OS home when no config dir is set', () => {
  assert.equal(
    requestBodyStateDir(),
    path.join(os.homedir(), '.claude', 'model-gateway', 'request-body'),
  );
});
