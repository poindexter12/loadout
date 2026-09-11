'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RUNTIME = path.join(__dirname, '..', 'lib', 'runtime.js');

// Read the constant out of a fresh process: runtime.js resolves paths once at
// require time, so an in-process env mutation would not be observed.
function runtimePaths(overrides = {}) {
  const environment = { ...process.env };
  delete environment.MODEL_GATEWAY_CLAUDE_HOME;
  delete environment.CLAUDE_CONFIG_DIR;
  Object.assign(environment, overrides);
  const script = `const r = require(${JSON.stringify(RUNTIME)});`
    + 'process.stdout.write(JSON.stringify({ state: r.STATE, logs: r.LOGS, socket: r.SOCKET_PATH }));';
  return JSON.parse(execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: environment,
  }));
}

test('gateway state follows CLAUDE_CONFIG_DIR', () => {
  const configDir = path.join(os.tmpdir(), 'model-gateway-account-a', '.claude');
  const { state, logs } = runtimePaths({ CLAUDE_CONFIG_DIR: configDir });
  assert.equal(state, path.join(configDir, 'model-gateway'));
  assert.equal(logs, path.join(configDir, 'model-gateway', 'logs'));
});

test('MODEL_GATEWAY_CLAUDE_HOME outranks CLAUDE_CONFIG_DIR', () => {
  const configDir = path.join(os.tmpdir(), 'model-gateway-account-a', '.claude');
  const claudeHome = path.join(os.tmpdir(), 'model-gateway-account-b', '.claude');
  const { state } = runtimePaths({
    CLAUDE_CONFIG_DIR: configDir,
    MODEL_GATEWAY_CLAUDE_HOME: claudeHome,
  });
  assert.equal(state, path.join(claudeHome, 'model-gateway'));
});

test('state falls back to ~/.claude when no config dir is set', () => {
  const { state } = runtimePaths();
  assert.equal(state, path.join(os.homedir(), '.claude', 'model-gateway'));
});

// The regression that motivated this: two account trees resolving to one STATE
// dir share a pid file, a gateway.sock, and a supervisor's proxy-port view.
test('separate config dirs never share gateway state', () => {
  const a = runtimePaths({ CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), 'mg-work', '.claude') });
  const b = runtimePaths({ CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), 'mg-personal', '.claude') });
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.socket, b.socket);
});
