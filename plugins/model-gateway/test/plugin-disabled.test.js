'use strict';

// SQ-343: `setup` (what Quartermaster's update-loadout runs through the stable
// update.js launcher) must not download, start, or wire the gateway on a Claude
// Code tree where model-gateway is disabled in enabledPlugins.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnGatewayProcessSync } = require('./support.js');

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const SETTINGS_WIRING = path.join(__dirname, '..', 'lib', 'settings-wiring.js');
const BASE_URL = 'http://127.0.0.1:9';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-disabled-')));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { home, project, state: path.join(home, '.claude', 'model-gateway') };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function disable(file, enabled = false) {
  writeJson(file, { enabledPlugins: { 'model-gateway@loadout': enabled } });
}

function runNode(home, project, args) {
  const { ANTHROPIC_BASE_URL, ...environment } = process.env;
  const result = spawnGatewayProcessSync(process.execPath, args, {
    cwd: project,
    encoding: 'utf8',
    timeout: 20000,
    isolatedOverrides: { CODEX_GATEWAY_PORT: '9', CODEX_GATEWAY_WORKER_PORT: '9', CODEX_GATEWAY_PROXY_PORT: '9' },
    env: { ...environment, HOME: home, USERPROFILE: home, CODEX_GATEWAY_PORT: '9', CODEX_GATEWAY_PROXY_PORT: '9' },
  });
  assert.ifError(result.error);
  return { code: result.status, stdout: result.stdout, output: result.stdout + result.stderr };
}

function enablement(home, project) {
  const { stdout } = runNode(home, project, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(SETTINGS_WIRING)}).gatewayPluginEnablement()))`]);
  return JSON.parse(stdout);
}

test('setup on a tree with model-gateway disabled downloads, starts, and wires nothing', (t) => {
  const { home, project, state } = fixture(t);
  disable(path.join(home, '.claude', 'settings.json'));

  const { code, output } = runNode(home, project, [CLI, 'setup']);

  assert.equal(code, 0, output);
  assert.match(output, /model-gateway@loadout is disabled in .*settings\.json, so setup left the gateway alone: nothing was downloaded, started, or wired/);
  assert.doesNotMatch(output, /fetching latest release/);
  assert.equal(fs.existsSync(path.join(state, 'bin')), false, 'setup must return before creating the proxy bin directory');
  assert.equal(fs.existsSync(path.join(project, '.claude', 'settings.local.json')), false, 'setup must not wire the project');
});

test('ensure run by hand on a disabled tree starts nothing and leaves the picker cache alone', (t) => {
  const { home, project, state } = fixture(t);
  disable(path.join(home, '.claude', 'settings.json'));
  writeJson(path.join(project, '.claude', 'settings.local.json'), { env: { ANTHROPIC_BASE_URL: BASE_URL } });
  const cache = path.join(home, '.claude', 'cache', 'gateway-models.json');
  writeJson(cache, { baseUrl: 'http://127.0.0.1:4001', fetchedAt: 1, models: [] });
  const cacheBefore = fs.readFileSync(cache, 'utf8');

  const { code, output } = runNode(home, project, [CLI, 'ensure']);

  assert.equal(code, 0, output);
  assert.match(output, /model-gateway@loadout is disabled in .*settings\.json; ensure left the gateway alone and started nothing/);
  assert.equal(fs.readFileSync(cache, 'utf8'), cacheBefore);
  assert.equal(fs.existsSync(path.join(state, 'bin')), false);
});

test('setup on a disabled tree names recorded projects still routed through the gateway', (t) => {
  const { home, project, state } = fixture(t);
  disable(path.join(home, '.claude', 'settings.json'));
  const wired = path.join(path.dirname(project), 'wired');
  writeJson(path.join(wired, '.claude', 'settings.local.json'), { env: { ANTHROPIC_BASE_URL: BASE_URL } });
  writeJson(path.join(state, 'wired-projects.json'), { projects: [wired] });
  const registryBefore = fs.readFileSync(path.join(state, 'wired-projects.json'), 'utf8');

  const { code, output } = runNode(home, project, [CLI, 'setup']);

  assert.equal(code, 0, output);
  assert.match(output, /1 recorded project\(s\) still route ANTHROPIC_BASE_URL through this gateway/);
  assert.ok(output.includes(path.join(wired, '.claude', 'settings.local.json')), output);
  assert.match(output, /env --remove/);
  assert.equal(fs.readFileSync(path.join(state, 'wired-projects.json'), 'utf8'), registryBefore, 'reporting stale wiring must not rewrite the registry');
});

test('enablement follows Claude Code precedence and only an explicit false disables', (t) => {
  const { home, project } = fixture(t);

  assert.deepEqual(enablement(home, project), { enabled: true, pluginId: 'model-gateway@loadout', source: null, file: null });

  disable(path.join(home, '.claude', 'settings.json'));
  const user = enablement(home, project);
  assert.equal(user.enabled, false);
  assert.equal(user.source, 'user');

  disable(path.join(project, '.claude', 'settings.local.json'), true);
  const local = enablement(home, project);
  assert.equal(local.enabled, true, 'project-local true outranks user false');
  assert.equal(local.source, 'project-local');
});

test('the plugin id follows the marketplace an installed copy was cached from', () => {
  const { gatewayPluginId } = require(SETTINGS_WIRING);
  const cached = path.join(path.sep, 'cfg', 'plugins', 'cache', 'other-market', 'model-gateway', '1.2.3', 'lib', 'settings-wiring.js');
  const checkout = path.join(path.sep, 'src', 'loadout', 'plugins', 'model-gateway', 'lib', 'settings-wiring.js');

  assert.equal(gatewayPluginId(cached), 'model-gateway@other-market');
  assert.equal(gatewayPluginId(checkout), 'model-gateway@loadout');
});
