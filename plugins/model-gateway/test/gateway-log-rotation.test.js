'use strict';

// SQ-31: the gateway's append-only logs (proxy.log, guardian.log,
// request-routes.jsonl) grew without any cap, and the route log created its
// directory on every single request. These cover the size cap swept from
// `ensure` and the hoisted directory creation.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { spawnGatewayProcessSync } = require('./support.js');

const commands = require('../lib/commands.js');
const requestWorker = require('../lib/request-worker.js');

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-log-rotation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeLog(directory, name, bytes, fill = 'a') {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, fill.repeat(bytes));
  return filePath;
}

test('the rotation cap is a const of 10MB', () => {
  assert.equal(commands.LOG_ROTATION_CAP_BYTES, 10 * 1024 * 1024);
});

test('rotates an oversized log into a single .1 predecessor and truncates in place', (t) => {
  const directory = temporaryDirectory(t);
  const filePath = writeLog(directory, 'proxy.log', 40, 'o');
  // The real writers (spawnSupervisedProxy, spawnDetached) hold the log open
  // in append mode for their whole lifetime. Rotation has to leave that fd
  // writing into the live file, not into the predecessor.
  const liveWriter = fs.openSync(filePath, 'a');
  t.after(() => fs.closeSync(liveWriter));

  const result = commands.rotateOversizedLog(filePath, { capBytes: 10 });

  assert.equal(result.path, filePath);
  assert.equal(result.previousPath, `${filePath}.1`);
  assert.equal(result.rotatedBytes, 40);
  assert.equal(fs.readFileSync(`${filePath}.1`, 'utf8'), 'o'.repeat(40));
  assert.equal(fs.statSync(filePath).size, 0);

  fs.writeSync(liveWriter, 'after-rotation');
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'after-rotation');
});

test('leaves a log at or under the cap alone', (t) => {
  const directory = temporaryDirectory(t);
  const filePath = writeLog(directory, 'proxy.log', 10, 'o');

  assert.equal(commands.rotateOversizedLog(filePath, { capBytes: 10 }), null);

  assert.equal(fs.statSync(filePath).size, 10);
  assert.equal(fs.existsSync(`${filePath}.1`), false);
});

test('keeps at most one predecessor across repeated rotations', (t) => {
  const directory = temporaryDirectory(t);
  const filePath = writeLog(directory, 'guardian.log', 40, '1');
  commands.rotateOversizedLog(filePath, { capBytes: 10 });
  fs.writeFileSync(filePath, '2'.repeat(40));

  commands.rotateOversizedLog(filePath, { capBytes: 10 });

  assert.equal(fs.readFileSync(`${filePath}.1`, 'utf8'), '2'.repeat(40));
  assert.equal(fs.existsSync(`${filePath}.2`), false);
  assert.deepEqual(
    fs.readdirSync(directory).sort(),
    ['guardian.log', 'guardian.log.1']
  );
});

test('an absent log is not an error', (t) => {
  const directory = temporaryDirectory(t);

  assert.equal(commands.rotateOversizedLog(path.join(directory, 'proxy.log'), { capBytes: 10 }), null);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('a failed copy reports and leaves the oversized log untouched', (t) => {
  const directory = temporaryDirectory(t);
  const filePath = writeLog(directory, 'proxy.log', 40, 'o');
  const reported = [];
  const fsImpl = {
    ...fs,
    copyFileSync() {
      const error = new Error('read-only volume');
      error.code = 'EROFS';
      throw error;
    },
  };

  const result = commands.rotateOversizedLog(filePath, { capBytes: 10, fsImpl, report: (line) => reported.push(line) });

  assert.equal(result, null);
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'o'.repeat(40));
  assert.equal(fs.existsSync(`${filePath}.1`), false);
  assert.equal(reported.length, 1);
  assert.match(reported[0], /could not rotate .*proxy\.log: EROFS/);
});

test('rotatableLogPaths covers the three logs this plugin owns and dedupes', () => {
  const paths = commands.rotatableLogPaths({ directory: '/logs', routeLogPath: '/logs/request-routes.jsonl' });

  assert.deepEqual(paths, ['/logs/proxy.log', '/logs/guardian.log', '/logs/request-routes.jsonl']);
  assert.deepEqual(commands.ROTATED_LOG_NAMES, ['proxy.log', 'guardian.log']);
});

test('rotatableLogPaths follows an overridden route-log path outside the logs directory', () => {
  const paths = commands.rotatableLogPaths({ directory: '/logs', routeLogPath: '/elsewhere/routes.jsonl' });

  assert.deepEqual(paths, ['/logs/proxy.log', '/logs/guardian.log', '/elsewhere/routes.jsonl']);
});

test('the ensure-time sweep rotates every oversized log and skips the small ones', (t) => {
  const directory = temporaryDirectory(t);
  writeLog(directory, 'proxy.log', 40, 'p');
  writeLog(directory, 'guardian.log', 40, 'g');
  writeLog(directory, 'request-routes.jsonl', 5, 'r');
  writeLog(directory, 'shim.log', 40, 's');
  writeLog(directory, 'lifecycle.jsonl', 40, 'l');

  const rotated = commands.sweepOversizedLogs({
    paths: commands.rotatableLogPaths({ directory, routeLogPath: path.join(directory, 'request-routes.jsonl') }),
    capBytes: 10,
  });

  assert.deepEqual(rotated.map((entry) => path.basename(entry.path)), ['proxy.log', 'guardian.log']);
  assert.equal(fs.statSync(path.join(directory, 'proxy.log')).size, 0);
  assert.equal(fs.statSync(path.join(directory, 'guardian.log')).size, 0);
  assert.equal(fs.readFileSync(path.join(directory, 'guardian.log.1'), 'utf8'), 'g'.repeat(40));
  // request-routes.jsonl is under the cap; shim.log and lifecycle.jsonl are
  // deliberately outside the rotated set.
  assert.equal(fs.statSync(path.join(directory, 'request-routes.jsonl')).size, 5);
  assert.equal(fs.statSync(path.join(directory, 'shim.log')).size, 40);
  assert.equal(fs.statSync(path.join(directory, 'lifecycle.jsonl')).size, 40);
});

test('the sweep rotates an oversized route log', (t) => {
  const directory = temporaryDirectory(t);
  const routeLogPath = writeLog(directory, 'request-routes.jsonl', 40, 'r');

  const rotated = commands.sweepOversizedLogs({
    paths: commands.rotatableLogPaths({ directory, routeLogPath }),
    capBytes: 10,
  });

  assert.deepEqual(rotated.map((entry) => entry.path), [routeLogPath]);
  assert.equal(fs.statSync(routeLogPath).size, 0);
  assert.equal(fs.readFileSync(`${routeLogPath}.1`, 'utf8'), 'r'.repeat(40));
});

// The sweep is only worth anything if `ensure` actually runs it, so this drives
// the real CLI the way a hook does rather than calling the helper again.
test('ensure sweeps an oversized gateway log', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-ensure-rotation-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'model-gateway@loadout': true } })
  );
  const logs = path.join(home, '.claude', 'model-gateway', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const proxyLog = path.join(logs, 'proxy.log');
  const shimLog = path.join(logs, 'shim.log');
  // A literal, not the exported const: this test has to fail on a tree with no
  // rotation at all, which is exactly a tree where that const does not exist.
  const oversizedBytes = 11 * 1024 * 1024;
  fs.writeFileSync(proxyLog, 'o'.repeat(oversizedBytes));
  fs.writeFileSync(shimLog, 's'.repeat(1024));
  const { ANTHROPIC_BASE_URL, ...environment } = process.env;

  const result = spawnGatewayProcessSync(process.execPath, [CLI, 'ensure'], {
    cwd: project,
    encoding: 'utf8',
    timeout: 120000,
    isolatedOverrides: { CODEX_GATEWAY_PORT: '9', CODEX_GATEWAY_WORKER_PORT: '9', CODEX_GATEWAY_PROXY_PORT: '9' },
    env: { ...environment, HOME: home, USERPROFILE: home },
  });

  assert.ifError(result.error);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.equal(fs.statSync(proxyLog).size, 0, output);
  assert.equal(fs.readFileSync(`${proxyLog}.1`, 'utf8').length, oversizedBytes);
  assert.equal(fs.statSync(shimLog).size, 1024, 'ensure must not rotate a log outside the capped set');
});

test('the route-log writer creates its directory once, not once per request', (t) => {
  const directory = temporaryDirectory(t);
  const logPath = path.join(directory, 'logs', 'request-routes.jsonl');
  let directoryCreations = 0;
  const write = requestWorker.createRequestRouteLogWriter({
    logPath,
    makeDirectories: () => {
      directoryCreations += 1;
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
    },
  });

  for (let index = 0; index < 25; index += 1) assert.equal(write({ at: index }), true);

  assert.equal(directoryCreations, 1);
  assert.equal(fs.readFileSync(logPath, 'utf8').trim().split('\n').length, 25);
});

test('the route-log writer recreates the directory when it disappears under a live worker', (t) => {
  const directory = temporaryDirectory(t);
  const logsDirectory = path.join(directory, 'logs');
  const logPath = path.join(logsDirectory, 'request-routes.jsonl');
  let directoryCreations = 0;
  const write = requestWorker.createRequestRouteLogWriter({
    logPath,
    makeDirectories: () => {
      directoryCreations += 1;
      fs.mkdirSync(logsDirectory, { recursive: true });
    },
  });

  assert.equal(write({ at: 'first' }), true);
  fs.rmSync(logsDirectory, { recursive: true, force: true });
  assert.equal(write({ at: 'second' }), true);

  assert.equal(directoryCreations, 2);
  assert.equal(fs.readFileSync(logPath, 'utf8'), `${JSON.stringify({ at: 'second' })}\n`);
});

test('the route-log writer reports a write it cannot recover from and keeps serving', (t) => {
  const directory = temporaryDirectory(t);
  const reported = [];
  const write = requestWorker.createRequestRouteLogWriter({
    logPath: path.join(directory, 'request-routes.jsonl'),
    makeDirectories: () => {},
    appendFile: () => {
      const error = new Error('no space left on device');
      error.code = 'ENOSPC';
      throw error;
    },
    report: (line) => reported.push(line),
  });

  assert.equal(write({ at: 'first' }), false);

  assert.equal(reported.length, 1);
  assert.match(reported[0], /could not write request route log: ENOSPC/);
});
