'use strict';

// SQ-25: every shim boot logged "could not bind ANTHROPIC_UNIX_SOCKET ...
// EADDRINUSE" and silently fell back to an ephemeral TCP port. The root cause
// was a stale gateway.sock file left behind by an unclean worker death (the
// concurrent-`ensure` SIGTERM race is one source) -- Node's listen() never
// unlinks an existing path for you, so every subsequent boot re-hit the same
// dead file forever. These tests exercise reclaimStaleUnixSocket() directly:
// it must remove a genuinely orphaned socket file, and it must NEVER touch
// one a healthy peer is still serving.

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const { probeUnixSocketLive, reclaimStaleUnixSocket } = require('../lib/request-worker.js');

function socketFixtureDir(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `model-gateway-socket-${label}-`));
  return { directory, socketPath: path.join(directory, 'gateway.sock') };
}

// Simulates the real orphan: a process binds the socket, then dies without
// running any cleanup (SIGKILL stands in for a SIGTERM the process never got
// to handle, or any other unclean exit). The socket *file* outlives it; a
// connect attempt against it gets ECONNREFUSED, never ENOENT, because the
// directory entry is still there even though nothing is listening.
async function spawnOrphanedSocketHolder(socketPath) {
  const child = spawn(process.execPath, [
    '-e',
    "const net=require('net');const s=net.createServer();s.listen(process.argv[1],()=>{process.stdout.write('ready\\n');});",
    socketPath,
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  await once(child.stdout, 'data');
  return child;
}

test('probeUnixSocketLive reports stale for an orphaned socket file and live for an active listener', { skip: process.platform === 'win32' }, async (t) => {
  const { directory, socketPath } = socketFixtureDir('probe');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const holder = await spawnOrphanedSocketHolder(socketPath);
  holder.kill('SIGKILL');
  await once(holder, 'exit');
  assert.equal(fs.existsSync(socketPath), true, 'the file outlives the killed process');
  assert.equal(await probeUnixSocketLive(socketPath), 'stale');

  fs.rmSync(socketPath, { force: true });
  const liveServer = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    liveServer.once('error', reject);
    liveServer.listen(socketPath, resolve);
  });
  t.after(() => new Promise((resolve) => liveServer.close(resolve)));
  assert.equal(await probeUnixSocketLive(socketPath), 'live');
});

test('reclaimStaleUnixSocket removes a socket file orphaned by an unclean shutdown', { skip: process.platform === 'win32' }, async (t) => {
  const { directory, socketPath } = socketFixtureDir('stale');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const holder = await spawnOrphanedSocketHolder(socketPath);
  holder.kill('SIGKILL');
  await once(holder, 'exit');
  assert.equal(fs.existsSync(socketPath), true);

  const result = await reclaimStaleUnixSocket(socketPath);
  assert.equal(result, 'removed');
  assert.equal(fs.existsSync(socketPath), false, 'the stale file must be gone so listen() can succeed');
});

test('reclaimStaleUnixSocket leaves a live peer socket in place -- conservative by construction', { skip: process.platform === 'win32' }, async (t) => {
  const { directory, socketPath } = socketFixtureDir('live');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let contacted = 0;
  const liveServer = net.createServer((socket) => { contacted += 1; socket.end(); });
  await new Promise((resolve, reject) => {
    liveServer.once('error', reject);
    liveServer.listen(socketPath, resolve);
  });
  t.after(() => new Promise((resolve) => liveServer.close(resolve)));

  const result = await reclaimStaleUnixSocket(socketPath);
  assert.equal(result, 'live');
  assert.equal(fs.existsSync(socketPath), true, 'a live peer\'s socket file must never be removed');

  // The peer must still be the one actually listening -- reclaim must not
  // have raced in and rebound the path out from under it. reclaim's own
  // internal liveness probe already contacted it once; this is a second,
  // independent confirmation after reclaim has returned.
  await new Promise((resolve, reject) => {
    const probe = net.connect(socketPath);
    probe.once('connect', () => { probe.destroy(); resolve(); });
    probe.once('error', reject);
  });
  assert.equal(contacted, 2);
});

test('reclaimStaleUnixSocket is a no-op when nothing has ever bound the path', { skip: process.platform === 'win32' }, async (t) => {
  const { directory, socketPath } = socketFixtureDir('absent');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.equal(fs.existsSync(socketPath), false);
  assert.equal(await reclaimStaleUnixSocket(socketPath), 'absent');
});

test('reclaimStaleUnixSocket leaves a non-socket file alone rather than guessing', { skip: process.platform === 'win32' }, async (t) => {
  const { directory, socketPath } = socketFixtureDir('notasocket');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(socketPath, 'unexpected regular file, not a socket');

  const result = await reclaimStaleUnixSocket(socketPath);
  assert.equal(result, 'not-a-socket');
  assert.equal(fs.existsSync(socketPath), true, 'never delete something that is not ours to clean up');
});

// The Windows named-pipe path (see runtime.js SOCKET_PATH / socketScopeSuffix)
// has no filesystem entry to leak in the first place -- a dead process's pipe
// name is released by the kernel automatically. reclaimStaleUnixSocket must
// bail out before touching fs at all on that platform, leaving the existing
// (already-scoped, see commit b4d7d37c) listen() call exactly as it was.
// process.platform can't be flipped for a real Windows run from here, so this
// simulates it the same way rc-compat-mode.test.js reloads the gateway module
// graph under a fixture HOME: evict lib/, flip platform, re-require, restore.
test('reclaimStaleUnixSocket skips every filesystem check on win32 (named pipes leak nothing)', async (t) => {
  const { directory, socketPath } = socketFixtureDir('winguard');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.rmSync(directory, { recursive: true, force: true }); // this platform never gets to create anything to check
  fs.mkdirSync(directory, { recursive: true });

  const libDir = path.join(__dirname, '..', 'lib') + path.sep;
  const evicted = new Map();
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(libDir)) {
      evicted.set(key, require.cache[key]);
      delete require.cache[key];
    }
  }
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  let windowsRequestWorker;
  try {
    windowsRequestWorker = require('../lib/request-worker.js');
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(libDir)) delete require.cache[key];
    }
    for (const [key, value] of evicted) require.cache[key] = value;
  }

  const result = await windowsRequestWorker.reclaimStaleUnixSocket(socketPath);
  assert.equal(result, 'skipped-windows');
  assert.equal(fs.existsSync(socketPath), false, 'nothing should have been statted or created for a win32 path');
});
