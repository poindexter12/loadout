'use strict';

// SQ-345: doctor (and the read-only `wired-projects` report update-loadout runs)
// must name every recorded project still wired to a gateway that is disabled or
// not listening, print each one's exact project-scoped env --remove command,
// report stale wired-projects.json entries, and change nothing unless
// --prune-wired-projects is given.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnGatewayProcessSync } = require('./support.js');

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const COMMANDS = path.join(__dirname, '..', 'lib', 'commands.js');
// CODEX_GATEWAY_PORT=9 below makes this the gateway's own base URL.
const BASE_URL = 'http://127.0.0.1:9';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-wired-projects-')));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(home, '.claude', 'model-gateway');
  return { root, home, project, state, registry: path.join(state, 'wired-projects.json') };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function disable(home) {
  writeJson(path.join(home, '.claude', 'settings.json'), { enabledPlugins: { 'model-gateway@loadout': false } });
}

function wiredProject(root, name, { file = 'settings.local.json', value = BASE_URL } = {}) {
  const directory = path.join(root, name);
  writeJson(path.join(directory, '.claude', file), { env: { ANTHROPIC_BASE_URL: value } });
  return directory;
}

function spawn(home, project, args) {
  const { ANTHROPIC_BASE_URL, ...environment } = process.env;
  const result = spawnGatewayProcessSync(process.execPath, args, {
    cwd: project,
    encoding: 'utf8',
    timeout: 20000,
    isolatedOverrides: { CODEX_GATEWAY_PORT: '9', CODEX_GATEWAY_WORKER_PORT: '9', CODEX_GATEWAY_PROXY_PORT: '9' },
    env: { ...environment, HOME: home, USERPROFILE: home, CODEX_GATEWAY_PORT: '9', CODEX_GATEWAY_PROXY_PORT: '9' },
  });
  assert.ifError(result.error);
  return { code: result.status, output: result.stdout + result.stderr };
}

// doctor with the readiness probe supplied, so the shim's state is the test's
// choice rather than whatever happens to listen on this machine.
function runDoctor(home, project, { shimRunning = true, prune = false } = {}) {
  const readiness = {
    ready: shimRunning,
    state: shimRunning ? 'ready' : 'shim-down',
    checks: { proxyBinary: false, proxyModels: true, codexAuth: true, shimRunning, servingVersion: 'test', servingVersionMatches: true },
  };
  return spawn(home, project, ['-e', `require(${JSON.stringify(COMMANDS)}).commands.doctor({ readiness: ${JSON.stringify(readiness)}, pruneWiredProjects: ${prune} })`]);
}

function removeCommand(project) {
  return `cd "${project}" && node "${CLI}" env --remove`;
}

test('doctor WARNs about a recorded project wired to the shim port while the plugin is disabled, with its env --remove command', (t) => {
  const { root, home, project, registry } = fixture(t);
  disable(home);
  const wired = wiredProject(root, 'wired');
  writeJson(registry, { projects: [wired] });
  const registryBefore = fs.readFileSync(registry, 'utf8');
  const settingsBefore = fs.readFileSync(path.join(wired, '.claude', 'settings.local.json'), 'utf8');

  const { output } = runDoctor(home, project, { shimRunning: true });

  assert.match(output, /model-gateway: WARN: 1 recorded project\(s\) still route ANTHROPIC_BASE_URL through this gateway, but model-gateway@loadout is disabled in .*settings\.json/);
  const warn = output.split('\n').find((line) => line.includes(removeCommand(wired)));
  assert.ok(warn, `expected the exact env --remove command for ${wired}:\n${output}`);
  assert.match(warn, /^model-gateway: WARN: /);
  assert.ok(warn.includes(`ANTHROPIC_BASE_URL=${BASE_URL}`), warn);
  assert.equal(fs.readFileSync(registry, 'utf8'), registryBefore, 'doctor must not rewrite the registry');
  assert.equal(fs.readFileSync(path.join(wired, '.claude', 'settings.local.json'), 'utf8'), settingsBefore, 'doctor must not unwire anything itself');
});

test('doctor WARNs about wired projects when the plugin is enabled but the shim is not listening', (t) => {
  const { root, home, project, registry } = fixture(t);
  const wired = wiredProject(root, 'wired');
  writeJson(registry, { projects: [wired] });

  const { output } = runDoctor(home, project, { shimRunning: false });

  assert.match(output, /WARN: 1 recorded project\(s\) still route ANTHROPIC_BASE_URL through this gateway, but the gateway shim is not listening on :9/);
  assert.doesNotMatch(output, /is disabled in/);
  assert.ok(output.includes(removeCommand(wired)), output);
});

test('doctor stays quiet about wired projects when the plugin is enabled and the shim is listening', (t) => {
  const { root, home, project, registry } = fixture(t);
  const wired = wiredProject(root, 'wired');
  writeJson(registry, { projects: [wired] });

  const { output } = runDoctor(home, project, { shimRunning: true });

  assert.match(output, /wired projects: 1 recorded project\(s\) route through this gateway, which is enabled and listening/);
  assert.doesNotMatch(output, /WARN/);
  assert.doesNotMatch(output, /env --remove/);
});

test('doctor reports stale registry entries and prunes them only for --prune-wired-projects', (t) => {
  const { root, home, project, registry } = fixture(t);
  disable(home);
  const wired = wiredProject(root, 'wired');
  const gone = path.join(root, 'gone');
  const relay = wiredProject(root, 'relay', { value: 'http://127.0.0.1:4001' });
  writeJson(registry, { projects: [wired, gone, relay, 'relative/path', wired] });
  const registryBefore = fs.readFileSync(registry, 'utf8');

  const reported = runDoctor(home, project);

  assert.match(reported.output, /wired projects: .*wired-projects\.json has 4 stale entries:/);
  assert.ok(reported.output.includes(`${gone}: the project directory no longer exists`), reported.output);
  assert.ok(reported.output.includes(`${relay}: its settings no longer point at this gateway (ANTHROPIC_BASE_URL=http://127.0.0.1:4001)`), reported.output);
  assert.ok(reported.output.includes('"relative/path": not an absolute project path'), reported.output);
  assert.ok(reported.output.includes(`${wired}: recorded more than once`), reported.output);
  assert.match(reported.output, /doctor --prune-wired-projects` to drop them/);
  assert.equal(fs.readFileSync(registry, 'utf8'), registryBefore, 'without the flag the registry is untouched');

  const pruned = runDoctor(home, project, { prune: true });

  assert.match(pruned.output, /wired projects: pruned 4 stale entries from .*wired-projects\.json/);
  assert.deepEqual(JSON.parse(fs.readFileSync(registry, 'utf8')).projects, [wired]);
  assert.ok(fs.existsSync(path.join(relay, '.claude', 'settings.local.json')), 'pruning never touches project settings');
  assert.ok(pruned.output.includes(removeCommand(wired)), 'the still-wired project keeps its WARN after pruning');
});

test('wiring in a committed settings.json gets a delete-by-hand instruction, not an env --remove that would miss it', (t) => {
  const { root, home, project, registry } = fixture(t);
  disable(home);
  const shared = wiredProject(root, 'shared', { file: 'settings.json' });
  writeJson(registry, { projects: [shared] });

  const { output } = runDoctor(home, project);

  const warn = output.split('\n').find((line) => line.includes(path.join(shared, '.claude', 'settings.json')));
  assert.ok(warn, output);
  assert.match(warn, /^model-gateway: WARN: .*delete ANTHROPIC_BASE_URL from that committed settings\.json by hand/);
  assert.ok(!output.includes(removeCommand(shared)), output);
});

test('doctor on a disabled, unwired tree does not tell the user to wire it', (t) => {
  const { home, project } = fixture(t);
  disable(home);

  const { output } = runDoctor(home, project);

  assert.match(output, /plugin: model-gateway@loadout is disabled in .*settings\.json/);
  assert.match(output, /wiring: not configured, as expected while the plugin is disabled/);
  assert.doesNotMatch(output, /ERROR: wiring is not configured/);
  assert.match(output, /wired projects: none recorded in /);
});

test('the wired-projects subcommand prints the same WARN list and starts nothing', (t) => {
  const { root, home, project, registry, state } = fixture(t);
  disable(home);
  const wired = wiredProject(root, 'wired');
  writeJson(registry, { projects: [wired] });
  const registryBefore = fs.readFileSync(registry, 'utf8');

  const { code, output } = spawn(home, project, [CLI, 'wired-projects']);

  assert.equal(code, 0, output);
  assert.match(output, /model-gateway: WARN: 1 recorded project\(s\) still route ANTHROPIC_BASE_URL through this gateway, but model-gateway@loadout is disabled/);
  assert.ok(output.includes(removeCommand(wired)), output);
  assert.equal(fs.readFileSync(registry, 'utf8'), registryBefore);
  assert.equal(fs.existsSync(path.join(state, 'bin')), false, 'wired-projects must not set anything up');
});
