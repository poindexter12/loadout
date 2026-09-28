'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const { spawnGatewayProcessSync } = require('./support.js');

const root = path.resolve(__dirname, '..');
const writer = require('../hooks/registry-writer.js');

function home(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-registry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// This process may itself be running under a non-default account (CLAUDE_CONFIG_DIR set, e.g.
// ~/.poindexter/claude). activeConfigDir() reads that ambient env directly, so any test exercising
// the `home` fixture as the resolution base must clear it first, or writeUpdateLauncher would write
// into this real, live account tree instead of the fixture (see the incident this ticket describes).
function isolatedAccountEnv(t, overrides = {}) {
  const restore = {};
  for (const key of ['CLAUDE_CONFIG_DIR', 'MODEL_GATEWAY_CLAUDE_HOME']) {
    restore[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const key of ['CLAUDE_CONFIG_DIR', 'MODEL_GATEWAY_CLAUDE_HOME']) {
      if (restore[key] === undefined) delete process.env[key];
      else process.env[key] = restore[key];
    }
  });
}

test('writes an atomic Codex Gateway registry breadcrumb', (t) => {
  isolatedAccountEnv(t);
  const directory = home(t);
  const result = writer.writeBreadcrumb({ root, home: directory, version: '1.2.3' });
  const file = writer.registryPath(directory);

  assert.equal(result.written, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    schemaVersion: 1,
    name: 'model-gateway',
    version: '1.2.3',
    root,
    capabilities: ['model-catalog'],
    catalog: {
      path: path.join(directory, '.claude', 'model-gateway', 'catalog.json'),
      schemaVersion: 4,
    },
  });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['model-gateway.json']);
});

test('preserves a future Codex Gateway registry schema', (t) => {
  isolatedAccountEnv(t);
  const directory = home(t);
  const file = writer.registryPath(directory);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, name: 'codex-gateway' }));

  assert.deepEqual(
    writer.writeBreadcrumb({ root, home: directory, version: '1.2.3' }),
    { written: false, reason: 'future-schema', file }
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { schemaVersion: 2, name: 'codex-gateway' });
});

test('updater launcher path falls back to home/.claude when no account config dir is set', (t) => {
  isolatedAccountEnv(t);
  const directory = home(t);
  assert.equal(writer.updateLauncherPath(directory), path.join(directory, '.claude', 'model-gateway', 'update.js'));
});

test('updater launcher path resolves under CLAUDE_CONFIG_DIR when set, distinct from the plain home directory', (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-registry-configdir-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  isolatedAccountEnv(t, { CLAUDE_CONFIG_DIR: configDir });
  const directory = home(t);

  const resolved = writer.updateLauncherPath(directory);
  assert.equal(resolved, path.join(configDir, 'model-gateway', 'update.js'));
  assert.notEqual(resolved, path.join(directory, '.claude', 'model-gateway', 'update.js'));
});

test('MODEL_GATEWAY_CLAUDE_HOME outranks CLAUDE_CONFIG_DIR for the updater launcher path', (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-registry-configdir-'));
  const gatewayHome = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-registry-gatewayhome-'));
  t.after(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(gatewayHome, { recursive: true, force: true });
  });
  isolatedAccountEnv(t, { CLAUDE_CONFIG_DIR: configDir, MODEL_GATEWAY_CLAUDE_HOME: gatewayHome });
  const directory = home(t);

  assert.equal(writer.updateLauncherPath(directory), path.join(gatewayHome, 'model-gateway', 'update.js'));
});

test('two isolated fixture accounts write the updater launcher to two distinct paths, never a shared one', (t) => {
  const workConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-registry-work-'));
  const personalConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-registry-personal-'));
  t.after(() => {
    fs.rmSync(workConfigDir, { recursive: true, force: true });
    fs.rmSync(personalConfigDir, { recursive: true, force: true });
  });
  const directory = home(t);

  isolatedAccountEnv(t, { CLAUDE_CONFIG_DIR: workConfigDir });
  const workResult = writer.writeUpdateLauncher({ home: directory });

  isolatedAccountEnv(t, { CLAUDE_CONFIG_DIR: personalConfigDir });
  const personalResult = writer.writeUpdateLauncher({ home: directory });

  assert.notEqual(workResult.file, personalResult.file);
  assert.equal(workResult.file, path.join(workConfigDir, 'model-gateway', 'update.js'));
  assert.equal(personalResult.file, path.join(personalConfigDir, 'model-gateway', 'update.js'));
  assert.ok(fs.existsSync(workResult.file));
  assert.ok(fs.existsSync(personalResult.file));
});

test('legacy updater launcher path always sits under home/.claude regardless of the active account config dir', (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-registry-configdir-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  isolatedAccountEnv(t, { CLAUDE_CONFIG_DIR: configDir });
  const directory = home(t);

  assert.equal(writer.legacyUpdateLauncherPath(directory), path.join(directory, '.claude', 'model-gateway', 'update.js'));
  assert.notEqual(writer.legacyUpdateLauncherPath(directory), writer.updateLauncherPath(directory));
});

test('does not fail SessionStart when registry state cannot be initialized', () => {
  const result = spawnGatewayProcessSync(process.execPath, [path.join(root, 'hooks', 'registry-writer.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: path.join(root, 'missing-plugin-root') },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});
