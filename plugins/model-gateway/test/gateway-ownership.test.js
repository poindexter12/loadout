'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const supervision = require('../lib/process-supervision.js');
const gateway = require('../lib/commands.js');

const sourcePath = require.resolve('../lib/process-supervision.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const localProcess = { pid: 42, command: `node ${path.join(supervision.gatewayInstallRoot(), 'bin', 'model-gateway.js')} serve-shim` };

// Platform behavior and mutation-negative tests never spawn or signal real
// processes. All filesystem/process/HTTP mutation surfaces fail unless stubbed.
function isolatedSupervision({ platform = process.platform, dependencies = {} } = {}) {
  const localRequire = createRequire(sourcePath);
  const forbidden = () => assert.fail('unexpected lifecycle mutation');
  const runtime = { ...localRequire('./runtime.js'), WIN: platform === 'win32' };
  const defaults = {
    'node:child_process': { spawn: forbidden, spawnSync: forbidden },
    'node:fs': { ...fs, writeFileSync: forbidden, rmSync: forbidden, openSync: forbidden },
    'node:http': { get: forbidden, request: forbidden },
    './lifecycle-diagnostics.js': { recordGatewayLifecycle: forbidden },
    './runtime.js': runtime,
  };
  const context = {
    module: { exports: {} }, Buffer, console, setTimeout, clearTimeout,
    process: { platform, pid: 1, env: {}, kill: forbidden },
    require: (id) => dependencies[id] || defaults[id] || localRequire(id),
  };
  vm.runInNewContext(source, context, { filename: sourcePath });
  return context.module.exports;
}

for (const missing of [null, undefined]) {
  test(`bound port with ${missing} PID stays unknown, never unowned`, async () => {
    let probes = 0;
    const owner = await supervision.resolvePortOwner(1234, {
      listening: async () => true,
      owner: async () => { probes += 1; return missing; },
      inspectProcess: async () => assert.fail('no PID to inspect'),
    });
    assert.equal(owner.state, 'unknown');
    assert.equal(probes, 2);
  });
}

test('ownership inspection retries missing process data and can later confirm the listener', async () => {
  let inspections = 0;
  const owner = await supervision.resolvePortOwner(1234, {
    listening: async () => true,
    owner: async () => 42,
    inspectProcess: async () => ++inspections === 1 ? null : localProcess,
  });
  assert.equal(owner.state, 'same-install');
  assert.equal(owner.pid, 42);
  assert.equal(inspections, 2);
});

test('unbound port needs no PID discovery, and changing unresolved PIDs remain unknown', async () => {
  const empty = await supervision.resolvePortOwner(1234, {
    listening: async () => false, owner: async () => assert.fail('unbound port'),
  });
  assert.deepEqual(empty, { state: 'unowned', pid: null });
  let pid = 40;
  const changing = await supervision.resolvePortOwner(1234, {
    listening: async () => true, owner: async () => ++pid,
    inspectProcess: async () => pid === 41 ? null : localProcess,
  });
  assert.equal(changing.state, 'unknown');
});

test('ownership resolver refuses inspection exceptions and honors its shared deadline', async () => {
  let clock = 0;
  let calls = 0;
  const result = await supervision.resolvePortOwner(1234, {
    now: () => clock, timeout: 10, listening: async () => true,
    owner: async (_port, options) => {
      assert.equal(options.timeout, 10);
      calls += 1; clock = 10; throw new Error('inspection unavailable');
    },
  });
  assert.equal(result.state, 'unknown');
  assert.equal(calls, 1);
});

test('ownership resolver distinguishes foreign install and unknown command lines', async () => {
  for (const [command, expected] of [['node /foreign/model-gateway/bin/model-gateway.js serve-shim', 'foreign-install'], ['', 'unknown'], ['unrelated-server', 'unknown']]) {
    const result = await supervision.resolvePortOwner(1234, {
      listening: async () => true, owner: async () => 42,
      inspectProcess: async () => ({ pid: 42, command }),
    });
    assert.equal(result.state, expected);
  }
});

for (const state of ['unknown', 'foreign-install']) {
  test(`${state} stop, supervisor replacement, drain and restart perform no mutation or control HTTP`, async () => {
    const safe = isolatedSupervision();
    const resolveOwner = async () => ({ state, pid: 42, installRoot: '/foreign/model-gateway' });
    for (const operation of ['stopAll', 'stopRunningSupervisor', 'stopShimWithDrain', 'restartWorkerWithDrain']) {
      const result = await safe[operation]({ resolveOwner, report: () => {} });
      assert.equal(result.ok, false, operation);
      assert.match(result.reason, state === 'unknown' ? /left the listener untouched/ : /different install root/);
    }
  });

  test(`${state} startup refuses before cleanup, replacement or health HTTP`, async (t) => {
    // Startup's only allowed action here is the injected ownership resolution.
    t.mock.method(fs, 'existsSync', () => assert.fail('startup must refuse before checking/installing the proxy'));
    const result = await gateway.startAll({
      resolveOwner: async () => ({ state, pid: 42, installRoot: '/foreign/model-gateway' }),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, state === 'unknown' ? /left the listener untouched/ : /different install root/);
  });
}

test('unknown stopAll is retryable and preserves records until an unbound retry', async () => {
  let removed = 0;
  const safe = isolatedSupervision({ dependencies: {
    'node:fs': { ...fs, readFileSync: () => { throw new Error('no record'); }, rmSync: () => { removed += 1; } },
  } });
  let state = 'unknown';
  const resolveOwner = async () => ({ state, pid: null });
  assert.equal((await safe.stopAll({ resolveOwner, report: () => {} })).ok, false);
  assert.equal(removed, 0);
  state = 'unowned';
  assert.equal((await safe.stopAll({ resolveOwner, report: () => {} })).ok, true);
  assert.ok(removed > 0, 'the later unbound stop may clean records');
});

for (const missing of [null, undefined, { pid: 42, command: '' }]) {
  test(`second recovery inspection ${JSON.stringify(missing)} does not permanently halt later recovery`, async () => {
    let clock = 0;
    let confirmed = false;
    let started = 0;
    const stopped = [];
    const recovery = supervision.createProxyRecovery({
      proxyBinary: 'fixture-proxy', probe: async () => started > 0, listening: async () => true,
      owner: async () => 42, ownsProxy: async () => confirmed,
      inspectProcess: async () => missing,
      stop: async (pid) => stopped.push(pid), waitForRelease: async () => true,
      start: async () => { started += 1; }, binaryExists: () => true,
      now: () => clock, report: () => {}, probeFailureThreshold: 1,
    });
    assert.equal((await recovery.recover()).state, 'owner-unknown');
    assert.deepEqual(stopped, []);
    assert.equal(started, 0);
    assert.equal((await recovery.recover()).state, 'backing-off');
    confirmed = true; clock = 1000;
    assert.equal((await recovery.recover()).state, 'recovered');
    assert.deepEqual(stopped, [42]);
    assert.equal(started, 1);
  });
}

test('default proxy ownership remains retryable after null process inspection', async () => {
  let clock = 0;
  let available = false;
  let started = false;
  const proxyBinary = path.join(supervision.gatewayInstallRoot(), 'fixture-proxy');
  const processes = new Map([[42, { pid: 42, parentPid: process.pid, command: `${proxyBinary} serve` }]]);
  const recovery = supervision.createProxyRecovery({
    proxyBinary, probe: async () => started, listening: async () => true,
    owner: async () => 42, inspectProcess: async () => available ? processes.get(42) : null,
    processTable: async () => processes, stop: async () => {}, waitForRelease: async () => true,
    start: async () => { started = true; }, binaryExists: () => true,
    now: () => clock, report: () => {}, probeFailureThreshold: 1,
  });
  assert.equal((await recovery.recover()).state, 'owner-unknown');
  available = true; clock = 1000;
  assert.equal((await recovery.recover()).state, 'recovered');
});

test('genuinely foreign proxy refuses both initial and subsequent recovery attempts', async () => {
  const recovery = supervision.createProxyRecovery({
    probe: async () => false, listening: async () => true, owner: async () => 42,
    ownsProxy: async () => false, inspectProcess: async () => ({ command: 'foreign-server' }),
    stop: async () => assert.fail('foreign signal'), start: async () => assert.fail('foreign replacement'),
    binaryExists: () => true, now: () => 0, report: () => {}, probeFailureThreshold: 1,
  });
  assert.equal((await recovery.recover()).state, 'foreign-port-owner');
  assert.equal((await recovery.recover()).state, 'foreign-port-owner');
});

test('Linux async discovery keeps the no-lsof /proc fallback and its deadline', async () => {
  const linux = isolatedSupervision({ platform: 'linux' });
  const port = 1234;
  const fsImpl = {
    readFile: async () => 'header\n 0: 0100007F:04D2 00000000:0000 0A 0:0 0:0 0 0 0 999\n',
    readdir: async (directory) => directory === '/proc' ? ['net', '42'] : ['0', '1'],
    readlink: async (descriptor) => descriptor.endsWith('/1') ? 'socket:[999]' : '/dev/null',
  };
  const result = await linux.processOwningPortAsync(port, {
    commandResult: async () => ({ status: null, stderr: 'ENOENT' }),
    procOwner: (value, options) => linux.processOwningPortInProcAsync(value, { ...options, fsImpl }),
  });
  assert.equal(result, 42);
  assert.equal(await linux.processOwningPortInProcAsync(port, { fsImpl, timeout: 1, now: (() => { let time = 0; return () => time++; })() }), undefined);
});

test('live ephemeral listener PID discovery succeeds within the normal probe budget', async (t) => {
  const server = require('node:net').createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const shortStarted = Date.now();
  const shortPid = await supervision.processOwningPortAsync(port, { timeout: 100 });
  const shortElapsed = Date.now() - shortStarted;
  const started = Date.now();
  const pid = await supervision.processOwningPortAsync(port, { timeout: 2000 });
  t.diagnostic(`100ms probe: PID ${shortPid}, ${shortElapsed}ms; normal probe: PID ${pid}, ${Date.now() - started}ms`);
  assert.equal(pid, process.pid);
});

test('Windows discovery retains netstat/PowerShell output without detached children', async () => {
  const windows = isolatedSupervision({ platform: 'win32' });
  const commandResult = (command, args, options) => windows.commandResultAsync(command, args, {
    ...options,
    spawnProcess: (_command, _args, spawnOptions) => {
      assert.equal(spawnOptions.detached, false);
      assert.equal(spawnOptions.windowsHide, true);
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', command === 'netstat'
          ? ' TCP 127.0.0.1:1234 0.0.0.0:0 LISTENING 42\r\n'
          : JSON.stringify({ ProcessId: 42, ParentProcessId: 1, CommandLine: localProcess.command }));
        child.emit('close', 0);
      });
      return child;
    },
  });
  assert.equal(await windows.processOwningPortAsync(1234, { commandResult }), 42);
  assert.equal((await windows.processInfoAsync(42, { commandResult })).command, localProcess.command);
});

test('Windows probe shutdown taskkills and waits for attached children to close', async () => {
  const probe = new EventEmitter();
  probe.pid = 42; probe.stdout = new EventEmitter(); probe.stderr = new EventEmitter();
  let killed = false;
  const windows = isolatedSupervision({ platform: 'win32', dependencies: {
    'node:child_process': { spawn: (command, args, options) => {
      assert.equal(command, 'taskkill');
      assert.deepEqual(Array.from(args), ['/pid', '42', '/T', '/F']);
      assert.equal(options.windowsHide, true);
      const taskkill = new EventEmitter();
      queueMicrotask(() => { killed = true; probe.emit('close', 1); taskkill.emit('close', 0); });
      return taskkill;
    } },
  } });
  const registry = windows.createProbeChildRegistry();
  const result = windows.commandResultAsync('powershell.exe', [], { probeChildren: registry, spawnProcess: () => probe });
  await new Promise((resolve) => setImmediate(resolve));
  await registry.stop();
  await result;
  assert.equal(killed, true);
});
