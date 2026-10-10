'use strict';

const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { gatewayTestEnvironment, spawnGatewayProcess, spawnGatewayProcessSync, startGateway } = require('./support.js');
const { commandIncludesFile, commandResultAsync, createProxyRecovery, installBelongsToThisPlugin, isDescendantOfAsync } = require('../lib/process-supervision.js');
const { canReplaceInstalledCliPath } = require('../lib/runtime.js');

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const COMMANDS = path.join(__dirname, '..', 'lib', 'commands.js');
const BODY_SESSION_ID = 'gateway-fixture-body-sentinel';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, body) {
  return new Promise((resolve, reject) => {
    const clientRequest = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-claude-code-session-id': BODY_SESSION_ID,
      },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    clientRequest.once('error', reject);
    clientRequest.end(body);
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
  });
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('foreign gateway fixture did not become ready')), 5000);
    child.stdout.once('data', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`foreign gateway fixture exited before becoming ready (${code ?? signal})`));
    });
  });
}

// SQ-37: replaces the bind/close/reuse freePort() pattern for fixture
// processes we author ourselves (the "foreign" gateway stand-ins below). The
// fixture binds its own listener on port 0 and reports the OS-assigned port
// back over stdout once it actually holds it, so there is never a gap where
// another process on the machine can steal the number between reservation
// and use.
function waitForReadyPort(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('foreign gateway fixture did not report a ready port')), 5000);
    let buffered = '';
    const onData = (chunk) => {
      buffered += chunk;
      const match = buffered.match(/ready:(\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      resolve(Number(match[1]));
    };
    child.stdout.on('data', onData);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`foreign gateway fixture exited before reporting a ready port (${code ?? signal})`));
    });
  });
}

// SQ-37: same idea, for the real model-gateway shim under test. request-worker.js
// logs `... shim listening on 127.0.0.1:<port> ...` with the real bound port once
// its listener is actually up (CODEX_GATEWAY_PORT='0' lets the OS pick it), so a
// sibling-detection test that needs a second process to target the same port can
// read the true value here instead of pre-reserving one.
function waitForListeningPort(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`shim did not report a listening port: ${buffered}`)), 5000);
    let buffered = '';
    const onData = (chunk) => {
      buffered += chunk;
      const match = buffered.match(/listening on 127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      resolve(Number(match[1]));
    };
    child.stdout.on('data', onData);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`shim exited before reporting a listening port (${code ?? signal}): ${buffered}`));
    });
  });
}

function waitForOutput(child, expectedOutput) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`foreign gateway fixture did not write ${expectedOutput}`)), 5000);
    const onData = (chunk) => {
      if (!String(chunk).includes(expectedOutput)) return;
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      resolve();
    };
    child.stdout.on('data', onData);
  });
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

async function waitForPidRecord(filePath) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { return Number(fs.readFileSync(filePath, 'utf8')); } catch { await pause(25); }
  }
  throw new Error(`pid record was not written: ${filePath}`);
}

async function waitForPidRecordDetails(filePath, pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (record.pid === pid) return;
    } catch {}
    await pause(25);
  }
  throw new Error(`pid record details were not written: ${filePath}`);
}

async function waitForReplacementPidRecord(filePath, retiredPid) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const pid = await waitForPidRecord(filePath).catch(() => null);
    if (pid && pid !== retiredPid && processIsRunning(pid)) return pid;
    await pause(25);
  }
  throw new Error(`replacement pid record was not written: ${filePath}`);
}

function descendantPids(parentPid) {
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${parentPid}" | Select-Object ProcessId | ConvertTo-Json -Compress`,
    ], { encoding: 'utf8', windowsHide: true });
    try {
      const entries = JSON.parse(result.stdout || '[]');
      return (Array.isArray(entries) ? entries : [entries]).map((entry) => Number(entry.ProcessId)).filter(Boolean);
    } catch { return []; }
  }
  const result = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
  return String(result.stdout).split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, processParentPid]) => pid && processParentPid === parentPid).map(([pid]) => pid);
}

// Probe children are spawned detached, so on POSIX they lead their own process
// group and only the parent pid links them to the supervisor.
function childPidsOf(parentPid) {
  const result = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
  return String(result.stdout).split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, processParentPid]) => pid && processParentPid === parentPid).map(([pid]) => pid);
}

async function waitForProcessesToExit(processIds, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (processIds.every((pid) => !processIsRunning(pid))) return;
    await pause(20);
  }
  assert.deepEqual(processIds.filter(processIsRunning), [], 'probe child survived its supervisor');
}

function recordedGatewayFixturePids(home) {
  const state = path.join(home, '.claude', 'model-gateway');
  return [...new Set(['guardian', 'shim', 'proxy'].map((name) => {
    try { return Number(fs.readFileSync(path.join(state, `${name}.pid`), 'utf8').trim()) || null; } catch { return null; }
  }).filter(Boolean))];
}

function gatewayFixturePids(home) {
  const fixtureRoot = fs.realpathSync(home);
  const result = spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' });
  const fixtureProxyPids = String(result.stdout).split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match && commandIncludesFile(match[2], fixtureRoot) ? [Number(match[1])] : [];
  });
  return [...new Set([...recordedGatewayFixturePids(home), ...fixtureProxyPids])];
}

async function stopGatewayFixture(home, environment, expectedPids) {
  // With every gateway port set to 0, `stop` cannot inspect the listener it must
  // prove belongs to this fixture. It is still worthwhile to ask for a graceful
  // stop first, then terminate only PIDs recorded under this test's own home.
  const fixturePids = [...new Set([...expectedPids, ...gatewayFixturePids(home)])];
  await runGatewayCli(CLI, 'stop', environment, { cwd: home }).catch(() => {});
  fixturePids.push(...gatewayFixturePids(home));
  const uniqueFixturePids = [...new Set(fixturePids)];
  const runningFixturePids = uniqueFixturePids.filter(processIsRunning);
  for (const pid of runningFixturePids) {
    try { process.kill(pid, 'SIGTERM'); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  await waitForProcessesToExit(uniqueFixturePids, 5000);
  assert.equal(
    uniqueFixturePids.filter(processIsRunning).length,
    0,
    `fixture cleanup reaped ${uniqueFixturePids.length} fixture processes`,
  );
}

async function waitForGatewayFixturePids(home) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const pids = recordedGatewayFixturePids(home);
    if (pids.length === 3 && pids.every(processIsRunning)) return pids;
    await pause(25);
  }
  const pids = recordedGatewayFixturePids(home);
  assert.equal(pids.length, 3, `fixture recorded ${pids.length} of its three gateway processes`);
  assert.deepEqual(pids.filter(processIsRunning), pids, 'fixture recorded a gateway process that is no longer running');
  return pids;
}

function installNodeProxy(home) {
  const proxyBinary = path.join(home, '.claude', 'model-gateway', 'bin', process.platform === 'win32' ? 'claude-code-proxy.exe' : 'claude-code-proxy');
  fs.mkdirSync(path.dirname(proxyBinary), { recursive: true });
  fs.copyFileSync(process.execPath, proxyBinary);
  if (process.platform !== 'win32') fs.chmodSync(proxyBinary, 0o755);
}

function runGatewayCli(cliPath, command, environment, { arguments: commandArguments = [], cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, command, ...commandArguments], { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (status) => resolve({ status, stderr, stdout }));
  });
}

function installCachedGatewayCliVersions(home) {
  const cacheRoot = path.join(home, '.claude', 'plugins', 'cache', 'loadout', 'model-gateway');
  const cliPaths = {};
  for (const version of ['0.49.0', '0.50.0']) {
    const pluginRoot = path.join(cacheRoot, version);
    fs.cpSync(path.join(__dirname, '..'), pluginRoot, { recursive: true });
    const manifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.version = version;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    cliPaths[version] = path.join(pluginRoot, 'bin', 'model-gateway.js');
  }
  return { olderCli: cliPaths['0.49.0'], newerCli: cliPaths['0.50.0'] };
}

function linkDirectory(targetDirectory, linkPath) {
  fs.symlinkSync(targetDirectory, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// SQ-266: fixture process reaping.
//
// Every test below spawns real supervisors, workers and proxies into a temp
// fixture home. On 2026-10-05 five `claude-code-proxy` processes launched from
// this file's fixtures were still holding listening TCP ports after six to
// eight days, three of them from fixture directories that had already been
// deleted. Three distinct leak paths had to be closed at once:
//
//   1. a kill written into the test body never runs once an assertion throws
//      above it, so a failing test always leaks;
//   2. a teardown that kills only the pids it happens to remember misses the
//      replacement supervisor tree `ensure` spawns, and the one place that did
//      try to kill that tree used `taskkill` -- a Windows command -- on every
//      platform, so on darwin it was a silent no-op (Windows is an abandoned
//      platform here as of 2026-09-15, so the fix is POSIX-only);
//   3. nothing in this process runs at all when the harness itself is killed
//      (Ctrl-C, or the runner's watchdog SIGKILLing the test file), which is
//      where the orphans whose fixture directories were already gone came
//      from.
//
// (1) and (2) are closed by reapFixtureHome(): teardown kills by recorded pid
// AND by any process whose command line still names the fixture root, so a
// supervisor's children count even when this file never learned their pids. A
// `t.after` hook runs regardless of how the test ended, and the root-level
// `test.after` at the end of this file is the backstop for anything a test's
// own teardown missed. (3) is closed by spawnFixtureReaper(): a detached process
// that outlives this one and performs the same sweep once this process is
// gone. Only an out-of-process watcher can cover SIGKILL, which no in-process
// handler ever sees.
//
// Both paths only ever signal a pid this file registered or a process whose
// command names a `model-gateway-*` directory directly under the OS temp dir,
// and only ever delete directories of that same shape, so neither can reach a
// real gateway install under ~/.claude or ~/.poindexter/claude. The model-
// gateway suite has clobbered a real settings.json once before; nothing here
// resolves a path outside the temp fixture root.
const FIXTURE_PREFIX = 'model-gateway-';
const trackedFixtureHomes = new Set();
const trackedFixturePids = new Set();
let fixtureReaper = null;
let fixtureReaperRegistry = null;

function isFixtureHome(directory) {
  if (typeof directory !== 'string' || !directory) return false;
  if (!path.basename(directory).startsWith(FIXTURE_PREFIX)) return false;
  try {
    return fs.realpathSync(path.dirname(directory)) === fs.realpathSync(os.tmpdir());
  } catch { return false; }
}

// Runs in a detached child, so it shares no state with this file: everything it
// needs arrives through the JSON registry whose path is in the environment. It
// is written to a file rather than passed with `-e` so its own `ps` entry stays
// one short line, which the command-line matching below reads.
const FIXTURE_REAPER_SOURCE = `
'use strict';
const fs = require('node:fs');
// The script has already been loaded, so drop it immediately: nothing else
// needs it and nothing is left behind if this process is killed.
try { fs.unlinkSync(__filename); } catch {}
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const registryPath = process.env.MODEL_GATEWAY_FIXTURE_REGISTRY;
const prefix = ${JSON.stringify(FIXTURE_PREFIX)};
const deadline = Date.now() + 20 * 60 * 1000;
const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const running = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let realTmp = os.tmpdir();
try { realTmp = fs.realpathSync(realTmp); } catch {}
function isFixtureHome(directory) {
  if (typeof directory !== 'string' || !directory) return false;
  if (!path.basename(directory).startsWith(prefix)) return false;
  try { return fs.realpathSync(path.dirname(directory)) === realTmp; } catch { return false; }
}
// pid -> start time, for everything ever seen below the harness. Recorded while
// the harness is alive because once it dies its children are reparented to init
// and the tree that identified them is gone. The start time is kept so a pid
// the OS has since recycled onto an unrelated process is never signalled.
const descendants = new Map();
// Two queries rather than one: \`lstart\` prints a date full of spaces, so
// picking it out of a row that also ends in a space-filled command needs a
// brittle regex. Each row here has exactly one free-form field, at the end.
function processTable() {
  const entries = new Map();
  const tree = String(spawnSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' }).stdout || '');
  for (const line of tree.split(/\\r?\\n/)) {
    const match = line.trim().match(/^(\\d+)\\s+(\\d+)\\s+(.+)$/);
    if (match) entries.set(Number(match[1]), { command: match[3], parentPid: Number(match[2]), startedAt: '' });
  }
  const starts = String(spawnSync('ps', ['-Ao', 'pid=,lstart='], { encoding: 'utf8' }).stdout || '');
  for (const line of starts.split(/\\r?\\n/)) {
    const match = line.trim().match(/^(\\d+)\\s+(.+)$/);
    const entry = match && entries.get(Number(match[1]));
    if (entry) entry.startedAt = match[2];
  }
  return entries;
}
function recordDescendants(parentPid, table) {
  const children = new Map();
  for (const [pid, entry] of table) {
    if (!children.has(entry.parentPid)) children.set(entry.parentPid, []);
    children.get(entry.parentPid).push(pid);
  }
  const queue = [parentPid];
  const seen = new Set(queue);
  while (queue.length) {
    for (const pid of children.get(queue.shift()) || []) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      // Never record this reaper or anything below it: its own \`ps\` probes are
      // descendants of the harness too, and it must not target itself.
      if (pid === process.pid) continue;
      queue.push(pid);
      const { command, startedAt } = table.get(pid);
      // Already exited, waiting only to be waited on: \`(name)\` on darwin,
      // \`<defunct>\` on linux.
      if (!/^\\(.*\\)$/.test(command) && !command.includes('<defunct>')) descendants.set(pid, startedAt);
    }
  }
}
function fixturePids(homes, seeded, table) {
  const pids = new Set(seeded.filter(Boolean));
  for (const home of homes) {
    for (const name of ['guardian', 'shim', 'proxy']) {
      try {
        const pid = Number(fs.readFileSync(path.join(home, '.claude', 'model-gateway', name + '.pid'), 'utf8').trim());
        if (pid) pids.add(pid);
      } catch {}
    }
  }
  for (const [pid, entry] of table) {
    if (homes.some((home) => entry.command.includes(home))) pids.add(pid);
    // Only when the recorded start time still matches, so a recycled pid is
    // left alone.
    if (descendants.get(pid) === entry.startedAt) pids.add(pid);
  }
  pids.delete(process.pid);
  return [...pids].filter(Boolean);
}
function sweep() {
  let registry;
  try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')); } catch { return; }
  const homes = (registry.homes || []).filter(isFixtureHome);
  const seeded = registry.pids || [];
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const pids = fixturePids(homes, seeded, processTable()).filter(running);
    if (!pids.length) break;
    for (const pid of pids) { try { process.kill(pid, signal); } catch {} }
    const until = Date.now() + (signal === 'SIGTERM' ? 3000 : 1000);
    while (Date.now() < until && fixturePids(homes, seeded, processTable()).some(running)) sleep(100);
  }
  for (const home of homes) { try { fs.rmSync(home, { force: true, recursive: true }); } catch {} }
  try { fs.rmSync(registryPath, { force: true }); } catch {}
}
setInterval(() => {
  let registry;
  // A missing registry is the clean-exit handshake: the harness tore its own
  // fixtures down, so there is nothing to sweep.
  try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')); } catch { process.exit(0); }
  const table = processTable();
  if (!running(registry.parentPid)) {
    sweep();
    process.exit(0);
  }
  recordDescendants(registry.parentPid, table);
  if (Date.now() > deadline) process.exit(0);
}, 250);
`;

function writeFixtureReaperRegistry() {
  if (!fixtureReaperRegistry) return;
  // Both spellings of every home: a child launched from a `/var/folders/...`
  // home records the canonicalized `/private/var/folders/...` form of its own
  // path, so matching on one alone misses it.
  const homes = new Set();
  for (const home of trackedFixtureHomes) {
    homes.add(home);
    try { homes.add(fs.realpathSync(home)); } catch {}
  }
  try {
    fs.writeFileSync(fixtureReaperRegistry, JSON.stringify({
      homes: [...homes],
      parentPid: process.pid,
      pids: [...trackedFixturePids],
    }));
  } catch {}
}

function spawnDetachedFixtureReaper(registryPath) {
  const scriptPath = path.join(os.tmpdir(), `${FIXTURE_PREFIX}fixture-reaper-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(scriptPath, FIXTURE_REAPER_SOURCE);
  const reaper = spawn(process.execPath, [scriptPath], {
    detached: true,
    env: { ...process.env, MODEL_GATEWAY_FIXTURE_REGISTRY: registryPath },
    stdio: 'ignore',
  });
  reaper.unref();
  return reaper;
}

function spawnFixtureReaper() {
  if (fixtureReaper || process.platform === 'win32') return;
  fixtureReaperRegistry = path.join(os.tmpdir(), `${FIXTURE_PREFIX}fixture-reaper-${process.pid}-${Date.now()}.json`);
  writeFixtureReaperRegistry();
  fixtureReaper = spawnDetachedFixtureReaper(fixtureReaperRegistry);
}

function trackFixtureHome(home, pids = []) {
  assert.ok(isFixtureHome(home), `refusing to track a fixture home outside the OS temp dir: ${home}`);
  trackedFixtureHomes.add(home);
  for (const pid of pids) if (pid) trackedFixturePids.add(pid);
  spawnFixtureReaper();
  writeFixtureReaperRegistry();
  return home;
}

function trackFixturePid(pid) {
  if (pid) {
    trackedFixturePids.add(pid);
    writeFixtureReaperRegistry();
  }
  return pid;
}

// Anything still running below this process once a test is over. Command-line
// matching on the fixture home cannot find all of it: the supervisors these
// tests start through `CLI` are named by this checkout, not by the temp home,
// and one of those -- a `serve-shim` holding an ephemeral port and this
// process's inherited stdout pipe -- is what kept a finished run from exiting.
// Being a descendant of the harness is the property they all share.
function survivingTestChildren() {
  if (process.platform === 'win32') return [];
  const entries = new Map();
  const output = String(spawnSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' }).stdout || '');
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (match) entries.set(Number(match[1]), { command: match[3], parentPid: Number(match[2]) });
  }
  const children = new Map();
  for (const [pid, entry] of entries) {
    if (!children.has(entry.parentPid)) children.set(entry.parentPid, []);
    children.get(entry.parentPid).push(pid);
  }
  const found = [];
  const queue = [process.pid];
  const seen = new Set(queue);
  while (queue.length) {
    for (const pid of children.get(queue.shift()) || []) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      queue.push(pid);
      // The detached reaper is meant to outlive this process. The `ps` probe
      // above is a child of this process and so appears in its own output,
      // already exited. A process that has exited and is only waiting to be
      // waited on shows as `(name)` on darwin and `<defunct>` on linux. None of
      // these holds a port or a pipe.
      const { command } = entries.get(pid);
      if (pid === fixtureReaper?.pid) continue;
      if (/^\(.*\)$/.test(command) || command.includes('<defunct>')) continue;
      if (/\bps\b.*-Ao pid=/.test(command)) continue;
      found.push([pid, command]);
    }
  }
  return found;
}

// SIGTERM, then SIGKILL on a deadline. Several teardowns used
// `child.kill(); await waitForExit(child)`, which waits forever when the child
// is slow to honour SIGTERM: the hook never returns, the test is cancelled for
// exceeding its timeout, and every later hook in it is skipped -- which is how
// a supervisor outlived its own teardown.
async function stopSpawnedProcess(child, timeout = 5000) {
  if (!child || child.pid == null) return;
  if (processIsRunning(child.pid)) { try { child.kill('SIGTERM'); } catch {} }
  const until = Date.now() + timeout;
  while (Date.now() < until && processIsRunning(child.pid)) await pause(50);
  if (processIsRunning(child.pid)) { try { process.kill(child.pid, 'SIGKILL'); } catch {} }
  const hardUntil = Date.now() + 2000;
  while (Date.now() < hardUntil && processIsRunning(child.pid)) await pause(50);
}

// Every process still naming this fixture root, whether or not the test ever
// learned its pid. Tolerates a home that has already been removed, which is
// exactly the state the surviving 2026-10-05 orphans were found in.
function fixturePidsForHome(home, seeded = []) {
  const roots = new Set([home]);
  try { roots.add(fs.realpathSync(home)); } catch {}
  const pids = new Set([...seeded.filter(Boolean), ...recordedGatewayFixturePids(home)]);
  if (process.platform !== 'win32') {
    const table = String(spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' }).stdout || '');
    for (const line of table.split(/\r?\n/)) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (match && [...roots].some((root) => match[2].includes(root))) pids.add(Number(match[1]));
    }
  }
  pids.delete(process.pid);
  return [...pids].filter(Boolean);
}

async function reapFixtureHome(home, seeded = [], { remove = true } = {}) {
  assert.ok(isFixtureHome(home), `refusing to reap a fixture home outside the OS temp dir: ${home}`);
  const signalled = new Set();
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const pids = fixturePidsForHome(home, seeded).filter(processIsRunning);
    if (!pids.length) break;
    for (const pid of pids) {
      signalled.add(pid);
      try { process.kill(pid, signal); } catch {}
    }
    const until = Date.now() + (signal === 'SIGTERM' ? 5000 : 2000);
    while (Date.now() < until && fixturePidsForHome(home, seeded).some(processIsRunning)) await pause(50);
  }
  const survivors = fixturePidsForHome(home, seeded).filter(processIsRunning);
  trackedFixtureHomes.delete(home);
  for (const pid of [...signalled, ...seeded]) trackedFixturePids.delete(pid);
  writeFixtureReaperRegistry();
  if (remove) {
    try { fs.rmSync(home, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 }); } catch {}
  }
  return { reaped: [...signalled], survivors };
}

// The last-chance in-process sweep: synchronous, because `exit` handlers cannot
// await, and bounded so a clean run (nothing registered) costs nothing.
function reapTrackedFixturesSync() {
  const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
  for (const home of [...trackedFixtureHomes]) {
    const seeded = [...trackedFixturePids];
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      const pids = fixturePidsForHome(home, seeded).filter(processIsRunning);
      if (!pids.length) break;
      for (const pid of pids) { try { process.kill(pid, signal); } catch {} }
      const until = Date.now() + (signal === 'SIGTERM' ? 1500 : 500);
      while (Date.now() < until && fixturePidsForHome(home, seeded).some(processIsRunning)) sleep(100);
    }
    try { fs.rmSync(home, { force: true, recursive: true }); } catch {}
    trackedFixtureHomes.delete(home);
  }
  for (const pid of survivingTestChildren().map(([pid]) => pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  trackedFixturePids.clear();
  // Removed last: dying part-way through the sweep must leave the detached
  // reaper a registry to finish the job from.
  if (fixtureReaperRegistry) {
    try { fs.rmSync(fixtureReaperRegistry, { force: true }); } catch {}
  }
}

process.on('exit', reapTrackedFixturesSync);
for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    reapTrackedFixturesSync();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

// Belt and braces around every per-test teardown, and the regression guard for
// requirement 3 of SQ-266: nothing this file spawned may outlive it. A root
// `afterEach` would be the wrong hook -- node:test runs it BEFORE each test's
// own `t.after`, so it would reap processes those hooks still assert on. This
// runs once, after the last test and all of its hooks, and reaps before it
// asserts, so a red result still leaves a clean machine.
test.after(async () => {
  for (const home of [...trackedFixtureHomes]) await reapFixtureHome(home, [...trackedFixturePids]);
  let leaked = survivingTestChildren();
  for (const [pid] of leaked) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  const until = Date.now() + 5000;
  while (Date.now() < until && leaked.some(([pid]) => processIsRunning(pid))) await pause(100);
  for (const [pid] of leaked.filter(([pid]) => processIsRunning(pid))) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  leaked = leaked.filter(([, command]) => !command.includes(`${FIXTURE_PREFIX}fixture-reaper-`));
  assert.deepEqual(
    leaked.map(([pid, command]) => `${pid} ${command}`),
    [],
    'a test left a spawned process running after its own teardown finished',
  );
});

function outerSocketPath(home) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\model-gateway-outer-${process.pid}-${Date.now()}`
    : path.join(home, 'outer-gateway.sock');
}

function socketIsListening(socketPath) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function setOuterGatewayEnvironment(t, home, endpointPort) {
  const temporaryDirectory = path.join(home, 'temporary');
  const bodyDirectory = path.join(home, 'request-body');
  const codexHome = path.join(home, 'codex-home');
  const socketPath = outerSocketPath(home);
  fs.mkdirSync(temporaryDirectory, { recursive: true });
  fs.mkdirSync(bodyDirectory, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  const sentinels = [
    [path.join(home, '.claude', 'model-gateway', 'shim.pid'), 'outer-pid'],
    [path.join(home, '.claude', 'model-gateway', 'logs', 'shim.log'), 'outer-log'],
    [path.join(home, '.claude', 'cache', 'gateway-models.json'), 'outer-cache'],
    [path.join(bodyDirectory, 'outer-body.json'), 'outer-body'],
    [path.join(codexHome, 'config.toml'), 'outer-codex-home'],
  ];
  for (const [filePath, contents] of sentinels) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }
  const previous = {};
  const values = {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory,
    TMPDIR: temporaryDirectory,
    MODEL_GATEWAY_REQUEST_BODY_DIR: bodyDirectory,
    ANTHROPIC_UNIX_SOCKET: socketPath,
    CODEX_HOME: codexHome,
    CODEX_GATEWAY_PORT: String(endpointPort),
    CODEX_GATEWAY_WORKER_PORT: String(endpointPort),
    CODEX_GATEWAY_PROXY_PORT: String(endpointPort),
    CODEX_GATEWAY_SOCKET_PATH: socketPath,
  };
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return { bodyDirectory, codexHome, sentinels, socketPath, temporaryDirectory };
}

function assertSentinelsUnchanged(sentinels) {
  for (const [filePath, contents] of sentinels) assert.equal(fs.readFileSync(filePath, 'utf8'), contents, filePath);
}

function assertNoBodyRecord(bodyDirectory) {
  const recordPath = path.join(bodyDirectory, `${Buffer.from(BODY_SESSION_ID).toString('base64url')}.json`);
  assert.equal(fs.existsSync(recordPath), false, recordPath);
}

function testHomes(directory) {
  return new Set(fs.readdirSync(directory).filter((entry) => entry.startsWith('model-gateway-test-')));
}

function assertSameEntries(actual, expected) {
  assert.deepEqual([...actual].sort(), [...expected].sort());
}

function codexMessage() {
  return JSON.stringify({
    model: 'claude-gpt-5.6-terra',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'fixture isolation' }],
  });
}

test('cache ownership resolves physical install roots before accepting sibling versions', (t) => {
  const home = trackFixtureHome(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-cache-identity-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cacheRoot = path.join(home, '.claude', 'plugins', 'cache');
  const olderSibling = path.join(cacheRoot, 'loadout', 'model-gateway', '0.48.0');
  const currentSibling = path.join(cacheRoot, 'loadout', 'model-gateway', '0.50.0');
  const foreignLinkedSibling = path.join(cacheRoot, 'loadout', 'model-gateway', '0.49.0');
  const foreignRoot = path.join(home, 'dev', 'foreign-model-gateway');
  const foreignMarketplace = path.join(cacheRoot, 'other-marketplace', 'model-gateway', '0.49.0');

  fs.mkdirSync(olderSibling, { recursive: true });
  fs.mkdirSync(currentSibling, { recursive: true });
  fs.mkdirSync(foreignRoot, { recursive: true });
  linkDirectory(foreignRoot, foreignLinkedSibling);

  assert.equal(installBelongsToThisPlugin(olderSibling, currentSibling), true);
  assert.equal(installBelongsToThisPlugin(olderSibling.replace('loadout', 'LOADOUT'), currentSibling), true);
  assert.equal(installBelongsToThisPlugin(`${olderSibling}${path.sep}`, currentSibling), true);
  if (process.platform === 'win32') assert.equal(installBelongsToThisPlugin(olderSibling.replaceAll('\\', '/'), currentSibling), true);
  assert.equal(installBelongsToThisPlugin(foreignLinkedSibling, currentSibling), false);
  assert.equal(installBelongsToThisPlugin(foreignMarketplace, currentSibling), false);
});

test('proxy command identity resolves the physical executable path', (t) => {
  const home = trackFixtureHome(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-proxy-command-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const proxyBinary = path.join(home, 'bin', 'claude-code-proxy');
  fs.mkdirSync(path.dirname(proxyBinary), { recursive: true });
  fs.writeFileSync(proxyBinary, 'proxy fixture');
  const alternateProxyPath = `${path.dirname(proxyBinary)}${path.sep}..${path.sep}bin${path.sep}${path.basename(proxyBinary)}`;

  assert.equal(commandIncludesFile(`"${alternateProxyPath}" serve --no-monitor`, proxyBinary), true);
});

test('gateway fixture processes isolate outer body, socket, and Codex state', async (t) => {
  const outerHome = trackFixtureHome(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-outer-user-')));
  t.after(() => fs.rmSync(outerHome, { recursive: true, force: true }));
  let defaultContacts = 0;
  const defaultEndpoint = http.createServer((request, response) => {
    defaultContacts += 1;
    response.writeHead(502);
    response.end();
  });
  const defaultPort = await listen(defaultEndpoint);
  t.after(() => defaultEndpoint.close());
  const outer = setOuterGatewayEnvironment(t, outerHome, defaultPort);

  const isolatedEnvironment = gatewayTestEnvironment(t, { ...process.env });
  assert.notEqual(isolatedEnvironment.HOME, outerHome);
  assert.notEqual(isolatedEnvironment.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
  assert.notEqual(isolatedEnvironment.CODEX_GATEWAY_PORT, String(defaultPort));
  assert.notEqual(isolatedEnvironment.CODEX_GATEWAY_SOCKET_PATH, process.env.CODEX_GATEWAY_SOCKET_PATH);

  const proxy = http.createServer((proxyRequest, proxyResponse) => {
    if (proxyRequest.url === '/v1/models') return proxyResponse.end(JSON.stringify({ data: [{ id: 'gpt-5.6-terra' }] }));
    proxyRequest.resume();
    proxyRequest.once('end', () => proxyResponse.end(JSON.stringify({ type: 'message', model: 'gpt-5.6-terra', content: [] })));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const started = await startGateway(t, 'serve-shim', {
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    CODEX_GATEWAY_REQUEST_LOG: '0',
  });
  assert.equal(await request(started.port, codexMessage()), 200);
  assert.equal(defaultContacts, 0);
  assertSentinelsUnchanged(outer.sentinels);
  assertNoBodyRecord(outer.bodyDirectory);
  assert.equal(await socketIsListening(outer.socketPath), false);
  assert.notEqual(isolatedEnvironment.MODEL_GATEWAY_REQUEST_BODY_DIR, outer.bodyDirectory);
  assert.notEqual(isolatedEnvironment.CODEX_HOME, outer.codexHome);
  assert.equal(isolatedEnvironment.ANTHROPIC_UNIX_SOCKET, undefined);
  await stopSpawnedProcess(started.child);

  const negativeControl = await startGateway(t, 'serve-shim', {
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    CODEX_GATEWAY_REQUEST_LOG: '0',
  }, { isolatedOverrides: { MODEL_GATEWAY_REQUEST_BODY_DIR: outer.bodyDirectory } });
  assert.equal(await request(negativeControl.port, codexMessage()), 200);
  await stopSpawnedProcess(negativeControl.child);
  assert.throws(() => assertNoBodyRecord(outer.bodyDirectory), /true !== false/);
});

test('sync gateway fixture cleanup removes helper-owned homes and preserves supplied homes', (t) => {
  const outerHome = trackFixtureHome(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-outer-user-')));
  t.after(() => fs.rmSync(outerHome, { recursive: true, force: true }));
  const outer = setOuterGatewayEnvironment(t, outerHome, 9);
  const before = testHomes(outer.temporaryDirectory);

  const result = spawnGatewayProcessSync(process.execPath, [CLI, 'env'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assertSameEntries(testHomes(outer.temporaryDirectory), before);

  const suppliedHome = path.join(outerHome, 'supplied-home');
  fs.mkdirSync(suppliedHome);
  const suppliedResult = spawnGatewayProcessSync(process.execPath, [CLI, 'env'], {
    encoding: 'utf8',
    env: { HOME: suppliedHome, USERPROFILE: suppliedHome },
  });
  assert.equal(suppliedResult.status, 0, suppliedResult.stderr);
  assert.equal(fs.existsSync(suppliedHome), true);
});

test('isolated ensure preserves a foreign serve-shim process and cleans its own supervisor', async (t) => {
  const home = trackFixtureHome(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-ensure-isolation-')));
  const foreignScript = path.join(home, 'foreign-install', 'model-gateway', 'bin', 'model-gateway.js');
  const proxyBinary = path.join(home, '.claude', 'model-gateway', 'bin', process.platform === 'win32' ? 'claude-code-proxy.exe' : 'claude-code-proxy');
  fs.mkdirSync(path.dirname(foreignScript), { recursive: true });
  fs.mkdirSync(path.dirname(proxyBinary), { recursive: true });
  fs.writeFileSync(foreignScript, "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);\n");
  fs.copyFileSync(process.execPath, proxyBinary);
  if (process.platform !== 'win32') fs.chmodSync(proxyBinary, 0o755);
  const foreign = spawn(process.execPath, [foreignScript, 'serve-shim'], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(async () => {
    await stopSpawnedProcess(foreign);
    fs.rmSync(home, { recursive: true, force: true });
  });
  await waitForReady(foreign);

  const result = spawnGatewayProcessSync(process.execPath, [CLI, 'ensure', '--quiet'], {
    encoding: 'utf8',
    env: { HOME: home, USERPROFILE: home },
    isolatedOverrides: {
      CODEX_GATEWAY_PORT: '0',
      CODEX_GATEWAY_WORKER_PORT: '0',
      CODEX_GATEWAY_PROXY_PORT: '0',
    },
  });

  const guardianPid = Number(fs.readFileSync(path.join(home, '.claude', 'model-gateway', 'guardian.pid'), 'utf8'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(processIsRunning(foreign.pid), true, 'foreign serve-shim process survived isolated ensure');
  assert.equal(processIsRunning(guardianPid), false, 'sync fixture cleanup stopped its supervisor');
});

test('sibling ensure retires dead records without deleting replacement worker and proxy records', async (t) => {
  // realpath the fixture home: the replacement worker's recorded command comes
  // from the ensure process's canonicalized __filename, so on macOS a /var/...
  // tmpdir home would never match the /private/var/... it logs.
  const home = trackFixtureHome(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-sibling-record-replacement-'))));
  const { olderCli, newerCli } = installCachedGatewayCliVersions(home);
  const proxyBinary = path.join(home, '.claude', 'model-gateway', 'bin', process.platform === 'win32' ? 'claude-code-proxy.exe' : 'claude-code-proxy');
  installNodeProxy(home);
  fs.writeFileSync(path.join(home, 'serve'), "require('node:http').createServer((request, response) => request.url === '/v1/models' ? response.end(JSON.stringify({ data: [] })) : response.end('{}')).listen(process.env.PORT, '127.0.0.1'); setInterval(() => {}, 1000);\n");
  // CODEX_GATEWAY_PORT starts at '0' (the environment default) so the older shim
  // picks its own free port with no reservation gap; the port it actually bound
  // is read back below and only then pinned into `environment` so the sibling
  // `ensure` targets the exact same listener. PROXY_PORT stays at '0' throughout:
  // this test only cares that a proxy process gets spawned and its pid record
  // survives replacement, never that its port is dereferenced.
  const environment = gatewayTestEnvironment(null, { HOME: home, USERPROFILE: home }, {
    CODEX_GATEWAY_WORKER_PORT: '0',
    // Use the production ownership budget: this tests confirmed replacement,
    // not timeout refusal. A 100ms lsof deadline can expire before finding the
    // PID on macOS; dedicated ownership tests cover that conservative refusal.
    //
    // SQ-61: park the supervisor's periodic proxy recovery so the only writers
    // of proxy.pid during this test are the one initial proxy start per
    // supervisor and the sentinel this test plants. CODEX_GATEWAY_PROXY_PORT is
    // '0' here (the fixture default), so `proxyModelsAnswering(0)` can never
    // answer and every recovery tick "recovers" a proxy that was never sick:
    // it spawns a fresh proxy, leaks the previous one, and rewrites proxy.pid
    // with a live PID. The older sibling's tick lands ~3.6s after the sentinel
    // is planted, which on a loaded macOS box beats the `ensure` process to the
    // record and makes it retire a real PID instead of the sentinel
    // (`pid record proxy retired because PID <real> is gone`). CI's faster
    // `ensure` usually wins that race, which is why this only ever went red
    // locally. Each supervisor still starts exactly one proxy, because
    // runShim() calls monitorProxy() once inline before arming the interval.
    CODEX_GATEWAY_PROXY_RECOVERY_INTERVAL_MS: '3600000',
  });
  const olderShim = spawn(process.execPath, [olderCli, 'serve-shim'], { cwd: home, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let ensuring = null;
  let replacementGuardianPid = null;
  trackFixturePid(olderShim.pid);
  // SQ-266: this teardown is where the leak lived. `taskkill` is a Windows
  // command and was run unconditionally, so the replacement supervisor tree was
  // never killed on darwin; `waitForExit(olderShim)` had no timeout; and both
  // ran only after a `stop` that cannot prove port ownership with every port at
  // 0. reapFixtureHome() signals by recorded pid and by any process whose
  // command still names this fixture root, so the replacement tree is reaped
  // whether or not this test learned its pids, and a thrown assertion above
  // cannot skip it.
  t.after(async () => {
    if (ensuring && ensuring.exitCode == null) ensuring.kill();
    await runGatewayCli(newerCli, 'stop', environment, { cwd: home }).catch(() => {});
    const { survivors } = await reapFixtureHome(home, [olderShim.pid, ensuring?.pid, replacementGuardianPid]);
    assert.deepEqual(survivors, [], 'fixture teardown left a spawned gateway process running');
  });
  const shimPort = await waitForListeningPort(olderShim);
  environment.CODEX_GATEWAY_PORT = String(shimPort);

  const state = path.join(home, '.claude', 'model-gateway');
  await waitForPidRecord(path.join(state, 'shim.pid'));
  await waitForPidRecord(path.join(state, 'proxy.pid'));
  const retiredGuardianPid = 987654321;
  const retiredWorkerPid = 987654320;
  const retiredProxyPid = 987654319;
  for (const pid of [retiredGuardianPid, retiredWorkerPid, retiredProxyPid]) assert.equal(processIsRunning(pid), false, `fixture pid ${pid} is unavailable`);
  fs.writeFileSync(path.join(state, 'guardian.pid'), String(retiredGuardianPid));
  fs.writeFileSync(path.join(state, 'shim.pid'), String(retiredWorkerPid));
  fs.writeFileSync(path.join(state, 'proxy.pid'), String(retiredProxyPid));
  ensuring = spawn(process.execPath, [newerCli, 'ensure', '--quiet'], { cwd: home, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let ensureStdout = '';
  let ensureStderr = '';
  ensuring.stdout.on('data', (chunk) => { ensureStdout += chunk; });
  ensuring.stderr.on('data', (chunk) => { ensureStderr += chunk; });
  const ensuredResult = new Promise((resolve, reject) => {
    ensuring.once('error', reject);
    ensuring.once('exit', (status) => resolve({ status, stderr: ensureStderr, stdout: ensureStdout }));
  });
  replacementGuardianPid = await waitForReplacementPidRecord(path.join(state, 'guardian.pid'), retiredGuardianPid)
    .catch((error) => { throw new Error(`${error.message}\nensure stdout: ${ensureStdout}\nensure stderr: ${ensureStderr}`); });
  const replacementWorkerPid = await waitForReplacementPidRecord(path.join(state, 'shim.pid'), retiredWorkerPid);
  const replacementProxyPid = await waitForReplacementPidRecord(path.join(state, 'proxy.pid'), retiredProxyPid);
  await waitForPidRecordDetails(path.join(state, 'shim.pid.json'), replacementWorkerPid);
  await waitForPidRecordDetails(path.join(state, 'proxy.pid.json'), replacementProxyPid);
  fs.writeFileSync(path.join(state, 'shim.pid.json'), JSON.stringify({ pid: replacementWorkerPid, command: 'replaced worker' }));
  if (ensuring.exitCode == null) ensuring.kill();
  const ensured = await ensuredResult;
  assert.equal(processIsRunning(olderShim.pid), false, 'ensure stopped the previous sibling supervisor');
  assert.equal(processIsRunning(replacementWorkerPid), true, 'ensure launched the replacement worker');
  assert.equal(processIsRunning(replacementProxyPid), true, 'ensure launched the replacement proxy');

  const doctor = await runGatewayCli(newerCli, 'doctor', environment, { cwd: home });
  const updaterOutput = `${ensured.stderr}${doctor.stderr}`;
  const legacyUpdaterLogLines = [
    `model-gateway: stale pid file guardian: PID ${retiredGuardianPid} is now not a gateway process`,
    `model-gateway: stale pid file shim: PID ${retiredWorkerPid} is now not a gateway process`,
    `model-gateway: stale pid file proxy: PID ${retiredProxyPid} is now not a gateway process`,
    `model-gateway: stale pid file shim: PID ${replacementWorkerPid} is now ${process.execPath} ${newerCli} serve-worker`,
    `model-gateway: stale pid file proxy: PID ${replacementProxyPid} is now ${proxyBinary} serve --no-monitor`,
  ];
  const expectedPidRecordLines = [
    `model-gateway: pid record guardian retired because PID ${retiredGuardianPid} is gone`,
    `model-gateway: pid record shim retired because PID ${retiredWorkerPid} is gone`,
    `model-gateway: pid record proxy retired because PID ${retiredProxyPid} is gone`,
    `model-gateway: pid record shim rewritten for replaced PID ${replacementWorkerPid}: ${process.execPath} ${newerCli} serve-worker`,
  ];
  const pidRecordLines = updaterOutput.split(/\r?\n/).filter((line) => line.startsWith('model-gateway: pid record'));
  const stalePidFileLines = updaterOutput.split(/\r?\n/).filter((line) => line.startsWith('model-gateway: stale pid file'));

  assert.deepEqual(pidRecordLines, expectedPidRecordLines);
  assert.deepEqual(stalePidFileLines, [], `live replacement records must not produce:\n${legacyUpdaterLogLines.slice(3).join('\n')}`);
  assert.equal(Number(fs.readFileSync(path.join(state, 'shim.pid'), 'utf8')), replacementWorkerPid, 'doctor retained the replacement worker record');
  assert.equal(Number(fs.readFileSync(path.join(state, 'proxy.pid'), 'utf8')), replacementProxyPid, 'doctor retained the replacement proxy record');
  const stopped = await runGatewayCli(newerCli, 'stop', environment, { cwd: home });
  assert.equal(stopped.status, 0, stopped.stderr);
  await waitForProcessesToExit([replacementGuardianPid, replacementWorkerPid, replacementProxyPid], 5000);
});

// SQ-235 (2026-09-29 21:03:31Z): the SessionStart hook running `ensure` hit its
// timeout mid-recovery and was killed together with everything under it. The
// replacement supervisor was spawned `detached` (its own session and process group),
// yet its worker and proxies were SIGTERMed first and the gateway stayed down for
// ten minutes: the kill followed parent PIDs, and a detached child is still its
// spawner's child. This reproduces that kill -- every descendant of the hook by PPID,
// plus its process group -- against both launchers. The plain detached child dying
// proves the kill reaches what the 21:03 incident lost; the reparented one must not.
function descendantPids(rootPid) {
  const table = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).stdout
    .trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
  const found = [];
  const queue = [rootPid];
  while (queue.length) {
    const parent = queue.shift();
    for (const [pid, ppid] of table) {
      if (ppid === parent && !found.includes(pid)) { found.push(pid); queue.push(pid); }
    }
  }
  return found;
}

function parentPidOf(pid) {
  return Number(spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()) || null;
}

test('a supervisor launched from the SessionStart hook survives the hook timeout killing its process tree', { skip: process.platform === 'win32' }, async (t) => {
  const home = trackFixtureHome(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-hook-tree-'))));
  const configDir = path.join(home, '.claude');
  const state = path.join(configDir, 'model-gateway');
  const hook = spawn(process.execPath, ['-e', `
    process.env.HOME = ${JSON.stringify(home)};
    process.env.USERPROFILE = ${JSON.stringify(home)};
    process.env.CLAUDE_CONFIG_DIR = ${JSON.stringify(configDir)};
    require('node:fs').mkdirSync(${JSON.stringify(path.join(state, 'logs'))}, { recursive: true });
    const gateway = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'commands.js'))});
    const { spawnDetached } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'process-supervision.js'))});
    const idle = ['-e', 'setInterval(() => {}, 1000)'];
    const reparented = gateway.spawnReparented('guardian', process.execPath, idle, {});
    const detachedOnly = spawnDetached('detached-only', process.execPath, idle, {});
    process.stdout.write(JSON.stringify({ reparented, detachedOnly }) + '\\n');
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  let pids = null;
  t.after(async () => {
    for (const pid of [pids?.reparented, pids?.detachedOnly]) {
      if (pid && processIsRunning(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
    try { process.kill(-hook.pid, 'SIGKILL'); } catch {}
    fs.rmSync(home, { recursive: true, force: true });
  });

  pids = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('hook fixture did not report its launched pids')), 10000);
    hook.stdout.on('data', (chunk) => {
      output += chunk;
      if (!output.includes('\n')) return;
      clearTimeout(timeout);
      resolve(JSON.parse(output.split('\n')[0]));
    });
    hook.once('error', reject);
  });
  assert.ok(processIsRunning(pids.reparented) && processIsRunning(pids.detachedOnly), 'both fixture supervisors run before the hook is killed');
  assert.notEqual(parentPidOf(pids.reparented), hook.pid, 'the reparented supervisor is no longer the hook process\'s child');
  assert.equal(
    Number(fs.readFileSync(path.join(state, 'guardian.pid'), 'utf8').trim()),
    pids.reparented,
    'the guardian record names the supervisor itself, not the short-lived launcher',
  );

  for (const pid of [...descendantPids(hook.pid), hook.pid]) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  try { process.kill(-hook.pid, 'SIGKILL'); } catch {}
  await waitForExit(hook);
  await waitForProcessesToExit([pids.detachedOnly], 5000);
  await pause(200);

  assert.equal(processIsRunning(pids.reparented), true, 'the reparented supervisor survives the hook timeout kill');
});

// SQ-23: on 2026-09-14 two concurrent `ensure` OS processes both observed the same
// dying supervisor, both independently decided recovery was needed, and both
// mutated lifecycle state — one of them tore down a supervisor that had been
// healthy for 16 hours. There was no lock, mutex, or pidfile serializing `ensure`
// invocations. This spins up two REAL `ensure` processes (not two calls on one
// in-process object — see gateway-drain.test.js's "concurrent supervisor checks
// share one proxy recovery attempt", which only covers the latter) against a
// shared, cold-start home and asserts that only one of them ever decides recovery
// is needed: exactly one `ensure-recovery-started` lifecycle record, one guardian.
test('two concurrent ensure OS processes never both decide the gateway needs recovery', async (t) => {
  const home = trackFixtureHome(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-concurrent-ensure-'))));
  installNodeProxy(home);
  fs.writeFileSync(
    path.join(home, 'serve'),
    "require('node:http').createServer((request, response) => request.url === '/v1/models' ? response.end(JSON.stringify({ data: [] })) : response.end('{}')).listen(process.env.PORT, '127.0.0.1'); setInterval(() => {}, 1000);\n",
  );
  // Only the ensure that wins the SQ-23 lock actually calls startAll() and binds
  // anything; the loser never touches a socket. So there is no cross-process
  // port to pre-arrange here, and the environment default of '0' for all three
  // gateway ports is safe -- the shared home's ensure.lock file is the resource
  // both processes actually race over, not the port number.
  const environment = gatewayTestEnvironment(null, { HOME: home, USERPROFILE: home }, {
    CODEX_GATEWAY_WORKER_PORT: '0',
  });
  let guardianPid = null;
  let fixturePids = [];
  t.after(async () => {
    await stopGatewayFixture(home, environment, fixturePids);
    fs.rmSync(home, { recursive: true, force: true });
  });

  const runEnsure = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'ensure', '--quiet'], { cwd: home, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (status) => resolve({ status, stdout, stderr }));
  });

  const [first, second] = await Promise.all([runEnsure(), runEnsure()]);
  assert.equal(first.status, 0, `first ensure: ${first.stderr}`);
  assert.equal(second.status, 0, `second ensure: ${second.stderr}`);

  const state = path.join(home, '.claude', 'model-gateway');
  guardianPid = await waitForPidRecord(path.join(state, 'guardian.pid'));
  fixturePids = await waitForGatewayFixturePids(home);
  assert.equal(processIsRunning(guardianPid), true, 'exactly one guardian ended up running');

  const lifecycle = fs.readFileSync(path.join(state, 'logs', 'lifecycle.jsonl'), 'utf8')
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const recoveryStarted = lifecycle.filter((record) => record.event === 'ensure-recovery-started');
  assert.equal(
    recoveryStarted.length,
    1,
    `expected exactly one ensure to independently decide recovery was needed, saw: ${JSON.stringify(recoveryStarted)}`,
  );
});

// SQ-23: the ensure lock must never deadlock on a lock file left behind by a process
// that crashed (or was killed) before it could release it — that is exactly the shape
// of failure the lock exists to survive, since the incident it fixes involved processes
// dying mid-recovery. A lock recorded against a pid that is provably not running must be
// reclaimed immediately, not held onto until the follower's wait timeout expires.
test('ensure reclaims a stale lock left by a pid that is no longer running instead of deadlocking', async (t) => {
  const home = trackFixtureHome(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-stale-ensure-lock-'))));
  installNodeProxy(home);
  fs.writeFileSync(
    path.join(home, 'serve'),
    "require('node:http').createServer((request, response) => request.url === '/v1/models' ? response.end(JSON.stringify({ data: [] })) : response.end('{}')).listen(process.env.PORT, '127.0.0.1'); setInterval(() => {}, 1000);\n",
  );
  const state = path.join(home, '.claude', 'model-gateway');
  fs.mkdirSync(state, { recursive: true });
  const deadPid = 987654318;
  assert.equal(processIsRunning(deadPid), false, 'fixture pid is unavailable');
  fs.writeFileSync(path.join(state, 'ensure.lock'), JSON.stringify({ pid: deadPid, startedAt: new Date(0).toISOString() }));
  const environment = gatewayTestEnvironment(null, { HOME: home, USERPROFILE: home });
  let guardianPid = null;
  let fixturePids = [];
  t.after(async () => {
    await stopGatewayFixture(home, environment, fixturePids);
    fs.rmSync(home, { recursive: true, force: true });
  });

  const startedAt = Date.now();
  const ensured = await runGatewayCli(CLI, 'ensure', environment, { cwd: home, arguments: ['--quiet'] });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(ensured.status, 0, ensured.stderr);
  // The default follower fallback is QUIET_STARTUP_WAIT_MS (12s) + 8s = 20s: a lock that
  // is NOT reclaimed forces this lone `ensure` down the follower path, which polls for the
  // (nonexistent, since no other process holds it) holder to finish and only gives up at
  // that 20s deadline -- never starting the gateway. A real cold start's own bounded
  // startup wait already costs several seconds, so this asserts comfortably under the 20s
  // follower deadline rather than near-zero, while still being incompatible with having
  // gone through that fallback.
  assert.ok(elapsedMs < 18000, `ensure took ${elapsedMs}ms; a reclaimed stale lock should finish well short of the 20s follower fallback`);

  assert.equal(fs.existsSync(path.join(state, 'ensure.lock')), false, 'the lock is released once this ensure finishes');
  const holder = JSON.parse(fs.readFileSync(path.join(state, 'ensure.lastResult.json'), 'utf8'));
  assert.equal(holder.ok, true, `expected the reclaiming ensure to record a successful outcome: ${JSON.stringify(holder)}`);

  guardianPid = await waitForPidRecord(path.join(state, 'guardian.pid'));
  fixturePids = await waitForGatewayFixturePids(home);
  assert.equal(processIsRunning(guardianPid), true, 'the reclaiming ensure actually started the gateway');

  const lifecycle = fs.readFileSync(path.join(state, 'logs', 'lifecycle.jsonl'), 'utf8')
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(
    lifecycle.some((record) => record.event === 'ensure-recovery-started'),
    'the reclaiming ensure must have actually driven its own recovery, not merely reported a follower outcome',
  );
});

// SQ-23 follow-up: tryClaimEnsureLock's create (openSync 'wx') and its pid
// write (writeSync) are two separate syscalls. A concurrent claimant that
// hits EEXIST in the gap between them reads an empty, unparseable lock file.
// The original fix treated that identically to "pid confirmed dead" and
// reclaimed it immediately, so two OS-process `ensure`s could both become
// holder -- observed on Windows CI as two `ensure-recovery-started` events
// 2ms apart. An old-but-empty lock file (this test) is genuinely abandoned
// and must still be reclaimed; a fresh one must not be, which the companion
// concurrency test above now covers under real racing load.
test('ensure reclaims an old corrupt (unparseable) lock file instead of treating it as live', async (t) => {
  const home = trackFixtureHome(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-corrupt-ensure-lock-'))));
  installNodeProxy(home);
  fs.writeFileSync(
    path.join(home, 'serve'),
    "require('node:http').createServer((request, response) => request.url === '/v1/models' ? response.end(JSON.stringify({ data: [] })) : response.end('{}')).listen(process.env.PORT, '127.0.0.1'); setInterval(() => {}, 1000);\n",
  );
  const state = path.join(home, '.claude', 'model-gateway');
  fs.mkdirSync(state, { recursive: true });
  const lockPath = path.join(state, 'ensure.lock');
  fs.writeFileSync(lockPath, '');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lockPath, old, old);
  const environment = gatewayTestEnvironment(null, { HOME: home, USERPROFILE: home });
  let guardianPid = null;
  let fixturePids = [];
  t.after(async () => {
    await stopGatewayFixture(home, environment, fixturePids);
    fs.rmSync(home, { recursive: true, force: true });
  });

  const ensured = await runGatewayCli(CLI, 'ensure', environment, { cwd: home, arguments: ['--quiet'] });
  assert.equal(ensured.status, 0, ensured.stderr);
  assert.equal(fs.existsSync(lockPath), false, 'the lock is released once this ensure finishes');

  guardianPid = await waitForPidRecord(path.join(state, 'guardian.pid'));
  fixturePids = await waitForGatewayFixturePids(home);
  assert.equal(processIsRunning(guardianPid), true, 'the reclaiming ensure actually started the gateway');
});

// SQ-34: the three lock-lifecycle races below cannot be staged through the CLI the
// way the two tests above stage theirs — nothing makes a real second `ensure` steal
// the lock at the exact instant the first releases it, and a truncate window is not
// addressable from outside the writing process. So they drive the lock helpers
// directly, from a child process pinned to a throwaway home. That keeps the part of
// the pattern that matters (every write lands in a temp tree, never in the real
// CLAUDE_CONFIG_DIR of whoever runs the suite) while making the race deterministic:
// commands.js resolves its state directory once, at require time, so the isolation
// has to come from the child's environment rather than from an in-process stub.
// Each probe body fills `report`, which comes back as JSON on stdout.
function runEnsureLockProbe(home, environment, body) {
  const script = path.join(home, `ensure-lock-probe-${Date.now()}-${Math.random().toString(16).slice(2)}.js`);
  fs.writeFileSync(script, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const commands = require(${JSON.stringify(COMMANDS)});`,
    'const report = { pid: process.pid };',
    body,
    'process.stdout.write(JSON.stringify(report));',
  ].join('\n'));
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8', env: environment });
  assert.equal(run.status, 0, `ensure-lock probe exited ${run.status}: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

// SQ-34: releaseEnsureLock used to rmSync the lock unconditionally. A claim can end
// before the process holding it does — the absolute age cap exercised below hands the
// lock to a new holder while the old one is still running — and the old one's exit
// handler then deleted a lock that was live, freeing a third `ensure` to start a
// concurrent recovery: exactly the SQ-23 double-recovery the lock exists to prevent.
// Release must free only a lock still naming its own pid, while still recording the
// outcome its followers are waiting to read.
test('releasing the ensure lock frees only a lock this process still holds', (t) => {
  const home = trackFixtureHome(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-release-ensure-lock-'))));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const environment = gatewayTestEnvironment(null, { HOME: home, USERPROFILE: home });

  const report = runEnsureLockProbe(home, environment, `
    report.ownClaim = commands.tryClaimEnsureLock();
    commands.releaseEnsureLock({ ok: true, message: 'own lock' });
    report.ownLockFreed = !fs.existsSync(commands.ENSURE_LOCK_PATH);

    report.reclaim = commands.tryClaimEnsureLock();
    fs.writeFileSync(commands.ENSURE_LOCK_PATH, JSON.stringify({ pid: ${process.pid}, startedAt: new Date().toISOString() }));
    commands.releaseEnsureLock({ ok: true, message: 'foreign lock' });
    report.foreignHolder = fs.existsSync(commands.ENSURE_LOCK_PATH)
      ? JSON.parse(fs.readFileSync(commands.ENSURE_LOCK_PATH, 'utf8'))
      : null;
    report.lastResult = JSON.parse(fs.readFileSync(commands.ENSURE_RESULT_PATH, 'utf8'));
  `);

  assert.equal(report.ownClaim, true, 'the probe took the lock');
  assert.equal(report.ownLockFreed, true, 'releasing a lock this process still holds must remove it');
  assert.equal(report.reclaim, true, 'the probe retook the lock for the foreign-holder leg');
  assert.notEqual(report.foreignHolder, null, 'release must not delete a lock another process now holds');
  assert.equal(report.foreignHolder.pid, process.pid, 'the new holder kept its own lock file');
  assert.equal(report.lastResult.message, 'foreign lock', 'a release that left the lock alone still records its outcome');
});

// SQ-34: reclaim trusted isPidAlive alone, and pid numbers are recycled. A holder
// that died mid-recovery whose number has since been handed to an unrelated live
// process leaves a lock nothing can ever reclaim: every later `ensure` sees a live
// pid, takes the follower path, waits out its deadline, and the gateway is never
// recovered. Past an absolute age cap the lock is reclaimed whatever its pid says —
// and, just as importantly, a lock young enough that its holder could still be doing
// the work is left alone, or the cap would reintroduce the SQ-23 race it guards.
test('a lock naming a live foreign pid is reclaimed once past the absolute age cap, not before', (t) => {
  const home = trackFixtureHome(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-ensure-lock-age-cap-'))));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const environment = gatewayTestEnvironment(null, { HOME: home, USERPROFILE: home });
  fs.mkdirSync(path.join(home, '.claude', 'model-gateway'), { recursive: true });
  // This runner's own pid: unambiguously alive for the whole probe and never the
  // probe child's own — the shape a recycled pid presents to a would-be claimant.
  assert.equal(processIsRunning(process.pid), true, 'the foreign lock pid is alive');

  const report = runEnsureLockProbe(home, environment, `
    const plantForeignLock = (ageMs) => {
      fs.writeFileSync(commands.ENSURE_LOCK_PATH, JSON.stringify({ pid: ${process.pid}, startedAt: new Date(Date.now() - ageMs).toISOString() }));
      const when = (Date.now() - ageMs) / 1000;
      fs.utimesSync(commands.ENSURE_LOCK_PATH, when, when);
    };

    plantForeignLock(Math.round(commands.ENSURE_LOCK_MAX_AGE_MS / 2));
    report.freshClaim = commands.tryClaimEnsureLock();
    report.freshHolder = JSON.parse(fs.readFileSync(commands.ENSURE_LOCK_PATH, 'utf8')).pid;

    plantForeignLock(commands.ENSURE_LOCK_MAX_AGE_MS * 2);
    report.agedClaim = commands.tryClaimEnsureLock();
    report.agedHolder = JSON.parse(fs.readFileSync(commands.ENSURE_LOCK_PATH, 'utf8')).pid;
  `);

  assert.equal(report.freshClaim, false, 'a live holder young enough to still be working keeps its lock');
  assert.equal(report.freshHolder, process.pid, 'the young lock was left untouched');
  assert.equal(report.agedClaim, true, 'a lock past the age cap is reclaimed even though its pid answers as alive');
  assert.equal(report.agedHolder, report.pid, 'the reclaiming process owns the lock afterwards');
  assert.equal(processIsRunning(process.pid), true, 'the displaced pid stayed alive throughout: liveness alone did not decide this');
});

// SQ-34: the outcome file was written with a plain writeFileSync, which truncates in
// place. A follower polls for the lock to disappear and reads this file immediately
// after, so it can land inside that truncate window, parse nothing, and report
// "another ensure is already recovering" instead of the outcome the holder just
// recorded for it. tmp+rename (lib/atomic-file.js) makes the replacement one
// indivisible step — observable here as a new inode rather than a rewritten one.
test('the ensure result is replaced atomically instead of truncated in place', (t) => {
  const home = trackFixtureHome(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-ensure-result-atomic-'))));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const environment = gatewayTestEnvironment(null, { HOME: home, USERPROFILE: home });
  const state = path.join(home, '.claude', 'model-gateway');
  fs.mkdirSync(state, { recursive: true });
  const resultPath = path.join(state, 'ensure.lastResult.json');
  fs.writeFileSync(resultPath, JSON.stringify({ ok: false, message: 'a previous run' }));
  const previousInode = fs.statSync(resultPath).ino;

  const report = runEnsureLockProbe(home, environment, `
    report.claimed = commands.tryClaimEnsureLock();
    commands.releaseEnsureLock({ ok: true, message: 'x'.repeat(8192) });
    report.inode = fs.statSync(commands.ENSURE_RESULT_PATH).ino;
    report.result = JSON.parse(fs.readFileSync(commands.ENSURE_RESULT_PATH, 'utf8'));
    report.temporarySiblings = fs.readdirSync(path.dirname(commands.ENSURE_RESULT_PATH)).filter((entry) => entry.endsWith('.tmp'));
  `);

  assert.equal(report.claimed, true, 'the probe took the lock before releasing it');
  assert.equal(report.result.ok, true, 'the follower reads this run\'s outcome');
  assert.equal(report.result.message.length, 8192, 'the recorded outcome is complete, not a partial write');
  assert.notEqual(report.inode, previousInode, 'the result file was replaced by rename, not rewritten in place');
  assert.deepEqual(report.temporarySiblings, [], 'the atomic write leaves no .tmp residue behind');
});

test('older cache version leaves a newer sibling shim running', async (t) => {
  const home = trackFixtureHome(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-sibling-downgrade-')));
  const { olderCli, newerCli } = installCachedGatewayCliVersions(home);
  // Single spawn, no sibling to agree on a port with -- the environment default
  // of '0' lets the OS assign it with no reservation gap.
  const environment = gatewayTestEnvironment(null, { HOME: home, USERPROFILE: home }, {
    CODEX_GATEWAY_WORKER_PORT: '0',
  });
  const newerShim = spawn(process.execPath, [newerCli, 'serve-shim'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    await runGatewayCli(newerCli, 'stop', environment);
    await stopSpawnedProcess(newerShim);
    fs.rmSync(home, { recursive: true, force: true });
  });
  await waitForReady(newerShim);

  assert.equal(canReplaceInstalledCliPath(newerCli, olderCli), false);
  assert.equal(processIsRunning(newerShim.pid), true, 'older CLI leaves the newer sibling shim running');
});

test('foreign configured-port supervisor is preserved and reported', async (t) => {
  const home = trackFixtureHome(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-foreign-port-')));
  const foreignScript = path.join(home, 'foreign-install', 'model-gateway', 'bin', 'model-gateway.js');
  fs.mkdirSync(path.dirname(foreignScript), { recursive: true });
  fs.writeFileSync(foreignScript, `const http = require('node:http'); const server = http.createServer((request, response) => response.end(JSON.stringify({ proxyRecovery: true }))); server.listen(0, '127.0.0.1', () => process.stdout.write('ready:' + server.address().port + '\\n'));\n`);
  const foreign = spawn(process.execPath, [foreignScript, 'serve-shim'], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(async () => {
    await stopSpawnedProcess(foreign);
    fs.rmSync(home, { recursive: true, force: true });
  });
  const port = await waitForReadyPort(foreign);

  const testOptions = {
    encoding: 'utf8',
    env: { HOME: home, USERPROFILE: home },
    isolatedOverrides: {
      CODEX_GATEWAY_PORT: String(port),
      CODEX_GATEWAY_WORKER_PORT: String(port),
      CODEX_GATEWAY_PROXY_PORT: '0',
    },
  };
  const ensured = spawnGatewayProcessSync(process.execPath, [CLI, 'ensure', '--quiet'], testOptions);
  const stopped = spawnGatewayProcessSync(process.execPath, [CLI, 'stop'], testOptions);
  const diagnosed = spawnGatewayProcessSync(process.execPath, [CLI, 'doctor'], testOptions);
  const foreignRoot = path.dirname(path.dirname(foreignScript));

  assert.equal(ensured.status, 0, ensured.stderr);
  assert.equal(stopped.status, 1, stopped.stderr);
  assert.match(diagnosed.stdout, new RegExp(`shim supervisor conflict: PID ${foreign.pid} owns :${port} from a different install root`));
  assert.match(diagnosed.stdout, new RegExp(foreignRoot.replace(/[\\\\/]/g, '[\\\\\\\\/]')));
  assert.equal(processIsRunning(foreign.pid), true, 'foreign configured-port supervisor survived ensure and stop');
});

test('cache-junction gateway process is preserved as a foreign port owner', async (t) => {
  const home = trackFixtureHome(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-cache-junction-port-')));
  const { olderCli, newerCli } = installCachedGatewayCliVersions(home);
  const foreignRoot = path.join(home, 'dev', 'foreign-model-gateway');
  const junctionRoot = path.dirname(path.dirname(olderCli));
  const foreignScript = path.join(foreignRoot, 'bin', 'model-gateway.js');
  fs.rmSync(junctionRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(foreignScript), { recursive: true });
  fs.writeFileSync(foreignScript, `const http = require('node:http'); const server = http.createServer((request, response) => response.end('foreign')); server.listen(0, '127.0.0.1', () => process.stdout.write('ready:' + server.address().port + '\\n'));\n`);
  linkDirectory(foreignRoot, junctionRoot);
  const foreign = spawn(process.execPath, [path.join(junctionRoot, 'bin', 'model-gateway.js'), 'serve-shim'], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(async () => {
    await stopSpawnedProcess(foreign);
    fs.rmSync(home, { recursive: true, force: true });
  });
  const port = await waitForReadyPort(foreign);

  const environment = gatewayTestEnvironment(null, { HOME: home, USERPROFILE: home }, {
    CODEX_GATEWAY_PORT: String(port),
    CODEX_GATEWAY_WORKER_PORT: String(port),
    CODEX_GATEWAY_PROXY_PORT: '0',
  });
  const stopped = await runGatewayCli(newerCli, 'stop', environment);

  assert.equal(stopped.status, 1, stopped.stderr);
  assert.match(stopped.stdout, /belongs to a different install root/);
  assert.equal(processIsRunning(foreign.pid), true, 'cache-junction foreign supervisor survived stop');
});

test('proxy recovery preserves a foreign configured-port proxy owner', async (t) => {
  const home = trackFixtureHome(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-foreign-proxy-')));
  const foreignScript = path.join(home, 'foreign-install', 'model-gateway', 'bin', 'model-gateway.js');
  fs.mkdirSync(path.dirname(foreignScript), { recursive: true });
  fs.writeFileSync(foreignScript, `const http = require('node:http'); const server = http.createServer((request, response) => { process.stdout.write('models\\n'); response.writeHead(503); response.end('unhealthy'); }); server.listen(0, '127.0.0.1', () => process.stdout.write('ready:' + server.address().port + '\\n'));`);
  const foreign = spawn(process.execPath, [foreignScript], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(async () => {
    await stopSpawnedProcess(foreign);
  });
  const port = await waitForReadyPort(foreign);
  const proxyProbe = waitForOutput(foreign, 'models\n');
  installNodeProxy(home);

  const supervisor = spawnGatewayProcess(t, process.execPath, [CLI, 'serve-shim'], {
    env: {
      HOME: home,
      USERPROFILE: home,
      CODEX_GATEWAY_PORT: '0',
      CODEX_GATEWAY_WORKER_PORT: '0',
      CODEX_GATEWAY_PROXY_PORT: String(port),
      CODEX_GATEWAY_PROXY_RECOVERY_INTERVAL_MS: '20',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(async () => {
    await stopSpawnedProcess(supervisor);
  });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.after(() => assert.equal(
    fs.existsSync(home),
    false,
    'fixture teardown removes the home after the supervisor and worker exit',
  ));
  await waitForReady(supervisor);
  await proxyProbe;
  await pause(2000);

  assert.equal(processIsRunning(supervisor.pid), true, 'this install supervisor stays running after the conflict');
  assert.equal(processIsRunning(foreign.pid), true, 'foreign configured-port proxy survives recovery');
});

test('proxy recovery replaces a shared proxy binary descended from its supervisor', async () => {
  const proxyPid = 903;
  let modelsAvailable = false;
  const stopped = [];
  const sharedProxyBinary = path.join(os.tmpdir(), 'model-gateway-shared-proxy');
  const processes = new Map([
    [proxyPid, { command: `${sharedProxyBinary} serve --no-monitor`, parentPid: process.pid, pid: proxyPid }],
  ]);
  const recovery = createProxyRecovery({
    proxyBinary: sharedProxyBinary,
    probe: async () => modelsAvailable,
    listening: async () => true,
    owner: async () => proxyPid,
    inspectProcess: async (pid) => processes.get(pid) || null,
    processTable: async () => processes,
    stop: async (pid) => stopped.push(pid),
    waitForRelease: async () => true,
    start: async () => { modelsAvailable = true; },
    binaryExists: () => true,
    now: () => 0,
    report: () => {},
    probeFailureThreshold: 1,
  });

  assert.equal((await recovery.recover()).state, 'recovered');
  assert.deepEqual(stopped, [proxyPid]);
});

test('proxy recovery preserves a foreign install proxy using the shared binary', async () => {
  const proxyPid = 903;
  const foreignSupervisorPid = 902;
  const sharedProxyBinary = path.join(os.tmpdir(), 'model-gateway-shared-proxy');
  const foreignInstallScript = path.join(os.tmpdir(), 'foreign-install', 'model-gateway', 'bin', 'model-gateway.js');
  const processes = new Map([
    [proxyPid, { command: `${sharedProxyBinary} serve --no-monitor`, parentPid: foreignSupervisorPid, pid: proxyPid }],
    [foreignSupervisorPid, { command: `${process.execPath} ${foreignInstallScript} serve-shim`, parentPid: null, pid: foreignSupervisorPid }],
  ]);
  let stopped = false;
  let started = false;
  const recovery = createProxyRecovery({
    proxyBinary: sharedProxyBinary,
    probe: async () => false,
    listening: async () => true,
    owner: async () => proxyPid,
    inspectProcess: async (pid) => processes.get(pid) || null,
    processTable: async () => processes,
    stop: async () => { stopped = true; },
    start: async () => { started = true; },
    binaryExists: () => true,
    now: () => 0,
    report: () => {},
    probeFailureThreshold: 1,
  });

  assert.equal((await recovery.recover()).state, 'foreign-port-owner');
  assert.equal(stopped, false, 'recovery leaves a foreign shared-binary proxy running');
  assert.equal(started, false, 'recovery does not replace a foreign shared-binary proxy');
});

test('ensure and stop discard a stale guardian PID without killing its reused process', async (t) => {
  const ensureHome = trackFixtureHome(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-stale-ensure-')));
  const stopHome = trackFixtureHome(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-stale-stop-')));
  const ensureSleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const stopSleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(async () => {
    ensureSleeper.kill();
    stopSleeper.kill();
    await Promise.all([waitForExit(ensureSleeper), waitForExit(stopSleeper)]);
    fs.rmSync(ensureHome, { recursive: true, force: true });
    fs.rmSync(stopHome, { recursive: true, force: true });
  });
  installNodeProxy(ensureHome);
  for (const [home, sleeper] of [[ensureHome, ensureSleeper], [stopHome, stopSleeper]]) {
    const state = path.join(home, '.claude', 'model-gateway');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'guardian.pid'), String(sleeper.pid));
  }

  const ensured = spawnGatewayProcessSync(process.execPath, [CLI, 'ensure', '--quiet'], {
    encoding: 'utf8',
    env: { HOME: ensureHome, USERPROFILE: ensureHome },
    isolatedOverrides: {
      CODEX_GATEWAY_PORT: '0',
      CODEX_GATEWAY_WORKER_PORT: '0',
      CODEX_GATEWAY_PROXY_PORT: '0',
    },
  });
  const stopped = spawnGatewayProcessSync(process.execPath, [CLI, 'stop'], {
    encoding: 'utf8',
    env: { HOME: stopHome, USERPROFILE: stopHome },
  });

  assert.equal(ensured.status, 0, ensured.stderr);
  assert.equal(processIsRunning(ensureSleeper.pid), true, 'ensure preserved the reused non-gateway process');
  assert.match(ensured.stderr, new RegExp(`pid record guardian retired because PID ${ensureSleeper.pid} no longer belongs to this gateway`));
  assert.notEqual(Number(fs.readFileSync(path.join(ensureHome, '.claude', 'model-gateway', 'guardian.pid'), 'utf8')), ensureSleeper.pid);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stderr, new RegExp(`pid record guardian retired because PID ${stopSleeper.pid} no longer belongs to this gateway`));
  assert.equal(fs.existsSync(path.join(stopHome, '.claude', 'model-gateway', 'guardian.pid')), false);
  assert.equal(processIsRunning(stopSleeper.pid), true, 'stop preserved the reused non-gateway process');
});

test('setup restart path refuses a foreign shim before it can restart its worker', async (t) => {
  const home = trackFixtureHome(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-foreign-setup-')));
  const foreignScript = path.join(home, 'foreign-install', 'model-gateway', 'bin', 'model-gateway.js');
  fs.mkdirSync(path.dirname(foreignScript), { recursive: true });
  fs.writeFileSync(foreignScript, `const { spawn } = require('node:child_process'); const http = require('node:http'); const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); const server = http.createServer((request, response) => { if (request.url === '/restart') worker.kill(); response.end(JSON.stringify({ workerPid: worker.pid })); }); server.listen(0, '127.0.0.1', () => process.stdout.write('ready:' + server.address().port + '\\n')); process.on('SIGTERM', () => { worker.kill(); server.close(() => process.exit(0)); });`);
  const foreign = spawn(process.execPath, [foreignScript], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(async () => {
    await stopSpawnedProcess(foreign);
    fs.rmSync(home, { recursive: true, force: true });
  });
  const port = await waitForReadyPort(foreign);
  const health = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/healthz`, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    }).once('error', reject);
  });
  const script = `const supervision = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'process-supervision.js'))}); supervision.restartWorkerWithDrain({ quiet: true }).then((result) => { if (!result.ok) console.error(result.reason); process.exit(result.ok ? 0 : 1); });`;
  const result = spawnGatewayProcessSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { HOME: home, USERPROFILE: home },
    isolatedOverrides: { CODEX_GATEWAY_PORT: String(port) },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(processIsRunning(health.workerPid), true, 'foreign shim worker survives setup restart refusal');
  assert.match(result.stderr, new RegExp(`refusing to stop PID ${foreign.pid} on :${port}; it belongs to a different install root`));
});


test('supervisor health remains responsive while a timed-out ownership probe defers recovery', async (t) => {
  const supervisor = http.createServer((request, response) => response.end(JSON.stringify({ ok: true })));
  const supervisorPort = await listen(supervisor);
  t.after(() => supervisor.close());
  const lifecycle = [];
  const recovery = createProxyRecovery({
    proxyBinary: 'fake-proxy',
    probe: async () => false,
    listening: async () => true,
    owner: async () => {
      const probe = await commandResultAsync(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { timeout: 20 });
      return probe.timedOut ? undefined : null;
    },
    binaryExists: () => true,
    recordLifecycle: (event, details) => lifecycle.push({ event, details }),
    now: () => Date.now(),
    report: () => {},
    probeFailureThreshold: 1,
  });
  const recoveryAttempt = recovery.recover();
  const startedAt = Date.now();
  const health = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${supervisorPort}/healthz`, (response) => {
      response.resume();
      response.once('end', () => resolve({ status: response.statusCode, elapsedMs: Date.now() - startedAt }));
    }).once('error', reject);
  });
  const outcome = await recoveryAttempt;

  assert.equal(health.status, 200);
  assert.ok(health.elapsedMs < 500, `health waited ${health.elapsedMs}ms for the ownership probe`);
  assert.equal(outcome.state, 'owner-unknown');
  assert.equal(lifecycle.at(-1)?.details.outcome, 'owner-unknown');
});

test('supervisor shutdown reaps a timed probe child before fixture cleanup', async (t) => {
  const home = trackFixtureHome(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-probe-child-')));
  const supervisionPath = path.join(__dirname, '..', 'lib', 'process-supervision.js');
  const supervisorScript = `
    const { commandResultAsync, createProbeChildRegistry, createProxyRecovery } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'process-supervision.js'))});
    const probeChildren = createProbeChildRegistry();
    const recovery = createProxyRecovery({
      probeChildren,
      probe: async () => false,
      listening: async () => true,
      owner: async () => {
        await commandResultAsync(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeout: 10000, probeChildren });
        return undefined;
      },
      binaryExists: () => true,
      report: () => {},
      probeFailureThreshold: 1,
    });
    async function stop() { await recovery.stop(); process.exit(0); }
    process.once('SIGTERM', stop);
    process.once('message', stop);
    void recovery.recover();
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `;
  const supervisor = spawn(process.execPath, ['-e', supervisorScript], {
    cwd: home,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'ignore', 'ipc'],
  });
  t.after(async () => {
    await stopSpawnedProcess(supervisor);
    fs.rmSync(home, { recursive: true, force: true });
  });
  await waitForReady(supervisor);
  await pause(50);

  const probePids = process.platform === 'win32'
    ? descendantPids(supervisor.pid)
    : childPidsOf(supervisor.pid);
  assert.ok(probePids.length > 0, `no timed probe child found for ${supervisionPath}`);
  if (process.platform === 'win32') supervisor.send('stop');
  else supervisor.kill('SIGTERM');
  await waitForExit(supervisor);
  await waitForProcessesToExit(probePids);
  assert.doesNotThrow(() => fs.rmSync(home, { recursive: true, force: true }));
});

// SQ-266: the leak reached seven days of uptime because nothing asserted that
// a fixture's processes were gone once its test finished. These two tests cover
// the two ways this file can stop: a teardown that runs, and a harness that is
// killed before any teardown can.
function spawnIdleProcess(executable, cwd) {
  return spawn(executable, ['-e', 'setInterval(() => {}, 1000);'], {
    cwd,
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
}

async function waitUntil(condition, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await pause(100);
  }
  assert.fail(message);
}

test('fixture teardown reaps every process spawned into a fixture home', { skip: process.platform === 'win32' }, async (t) => {
  const home = trackFixtureHome(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-teardown-reaping-'))));
  installNodeProxy(home);
  const proxyBinary = path.join(home, '.claude', 'model-gateway', 'bin', 'claude-code-proxy');

  // Discovered by command line only: the pid is never handed to the reaper,
  // which is the case that matters for a supervisor's own children.
  const unrecordedProxy = spawnIdleProcess(proxyBinary, home);
  // Discovered through the pid record only: its command names nothing under the
  // fixture home, exactly like a real proxy binary resolved outside it.
  const recordedOnly = spawnIdleProcess(process.execPath, os.tmpdir());
  fs.writeFileSync(path.join(home, '.claude', 'model-gateway', 'proxy.pid'), String(recordedOnly.pid));
  // Neither recorded nor named by the fixture: the reaper must leave it alone.
  // A sweep that killed this would be free to kill the real gateway shim.
  const bystander = spawnIdleProcess(process.execPath, os.tmpdir());
  t.after(() => {
    for (const child of [unrecordedProxy, recordedOnly, bystander]) {
      if (processIsRunning(child.pid)) { try { process.kill(child.pid, 'SIGKILL'); } catch {} }
    }
  });
  await waitUntil(
    () => [unrecordedProxy, recordedOnly, bystander].every((child) => processIsRunning(child.pid)),
    'fixture stand-in processes did not start',
  );

  const { reaped, survivors } = await reapFixtureHome(home);

  assert.deepEqual(survivors, [], 'teardown left a spawned fixture process running');
  assert.equal(processIsRunning(unrecordedProxy.pid), false, 'teardown missed a process it could only find by command line');
  assert.equal(processIsRunning(recordedOnly.pid), false, 'teardown missed a process it could only find by pid record');
  assert.ok(reaped.includes(unrecordedProxy.pid), `reaped pids ${reaped} omit the command-matched fixture process`);
  assert.ok(reaped.includes(recordedOnly.pid), `reaped pids ${reaped} omit the recorded fixture process`);
  assert.equal(processIsRunning(bystander.pid), true, 'teardown killed a process outside the fixture home');
  assert.ok(reaped.every((pid) => pid !== bystander.pid), 'teardown signalled a process outside the fixture home');
  assert.equal(fs.existsSync(home), false, 'teardown left the fixture home behind');
});

test('the detached reaper reaps fixture processes when the harness dies before teardown', { skip: process.platform === 'win32' }, async (t) => {
  const home = trackFixtureHome(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-abort-reaping-'))));
  installNodeProxy(home);
  const proxyBinary = path.join(home, '.claude', 'model-gateway', 'bin', 'claude-code-proxy');
  const registryPath = path.join(os.tmpdir(), `${FIXTURE_PREFIX}fixture-reaper-abort-${process.pid}-${Date.now()}.json`);

  // Stands in for this test file's own process: SIGKILLed below, the way the
  // runner's watchdog kills a test file, so no exit or signal handler of its
  // own ever runs.
  const harness = spawnIdleProcess(process.execPath, os.tmpdir());
  const orphan = spawnIdleProcess(proxyBinary, home);
  const bystander = spawnIdleProcess(process.execPath, os.tmpdir());
  fs.writeFileSync(registryPath, JSON.stringify({ homes: [home], parentPid: harness.pid, pids: [] }));
  const reaper = spawnDetachedFixtureReaper(registryPath);
  t.after(() => {
    for (const child of [reaper, harness, orphan, bystander]) {
      if (processIsRunning(child.pid)) { try { process.kill(child.pid, 'SIGKILL'); } catch {} }
    }
    fs.rmSync(registryPath, { force: true });
  });
  await waitUntil(
    () => [harness, orphan, bystander, reaper].every((child) => processIsRunning(child.pid)),
    'abort-path stand-in processes did not start',
  );
  assert.equal(processIsRunning(orphan.pid), true, 'fixture orphan was not running before the harness died');

  process.kill(harness.pid, 'SIGKILL');

  await waitUntil(() => !processIsRunning(orphan.pid), 'the detached reaper left a fixture process running after the harness died');
  await waitUntil(() => !fs.existsSync(home), 'the detached reaper left the fixture home behind');
  await waitUntil(() => !fs.existsSync(registryPath), 'the detached reaper left its registry behind');
  await waitUntil(() => !processIsRunning(reaper.pid), 'the detached reaper did not exit after sweeping');
  assert.equal(processIsRunning(bystander.pid), true, 'the detached reaper killed a process outside the fixture home');
});

test('async parent ownership walk reads the process table once', async () => {
  let processQueries = 0;
  const processes = new Map([
    [903, { parentPid: 902 }],
    [902, { parentPid: 901 }],
    [901, { parentPid: null }],
  ]);

  assert.equal(await isDescendantOfAsync(903, 901, {
    processTable: async () => {
      processQueries += 1;
      return processes;
    },
  }), true);
  assert.equal(processQueries, 1);
});
