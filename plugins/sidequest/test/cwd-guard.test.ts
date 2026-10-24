'use strict';
// SQ-368: a board server whose inherited cwd was deleted must recover instead of
// throwing ENOENT from process.cwd() on dispatch. These tests use a REAL deleted
// cwd: a shell enters a temp dir, removes it, then execs node from inside it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { waitForCapacity } = require('./_capacity-deadline.js');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const pluginRoot = path.join(__dirname, '..');
const guardModule = path.join(pluginRoot, 'lib', 'cwd-guard.js');
const mcpServer = path.join(pluginRoot, 'bin', 'sidequest-mcp.js');
const ENTER_DELETED_CWD = 'cd "$1" && rmdir "$1" && shift && exec "$@"';

function tempDir(label: string) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sq368-${label}-`)));
}

function probeScript() {
  const dir = tempDir('probe');
  const file = path.join(dir, 'probe.js');
  fs.writeFileSync(file, [
    'let before;',
    "try { process.cwd(); before = 'alive'; } catch (error) { before = error.code; }",
    `const result = require(${JSON.stringify(guardModule)}).ensureLiveCwd({ log: () => {} });`,
    'let after;',
    "try { after = process.cwd(); } catch (error) { after = 'THROW ' + error.code; }",
    'process.stdout.write(JSON.stringify({ before, result, after }));',
  ].join('\n'));
  return file;
}

function runInDeletedCwd(env: Record<string, string | undefined>) {
  const dead = tempDir('dead');
  const run = spawnSync('sh', ['-c', ENTER_DELETED_CWD, 'sh', dead, process.execPath, probeScript()], {
    env: { ...process.env, PWD: dead, ...env },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return { dead, out: JSON.parse(run.stdout) };
}

test('ensureLiveCwd moves a process with a deleted cwd to a surviving CLAUDE_PROJECT_DIR', () => {
  const project = tempDir('project');
  const { dead, out } = runInDeletedCwd({ CLAUDE_PROJECT_DIR: project });
  assert.equal(out.before, 'ENOENT', 'precondition: the inherited cwd is really gone');
  assert.equal(out.result.recovered, true);
  assert.equal(out.result.lost, dead);
  assert.equal(out.after, project);
});

test('ensureLiveCwd falls back to the home directory when CLAUDE_PROJECT_DIR is the deleted directory', () => {
  const home = tempDir('home');
  const dead = tempDir('dead-project');
  fs.rmdirSync(dead);
  const { out } = runInDeletedCwd({ CLAUDE_PROJECT_DIR: dead, HOME: home });
  assert.equal(out.before, 'ENOENT');
  assert.equal(out.after, home);
});

test('ensureLiveCwd leaves a live cwd alone', () => {
  const { ensureLiveCwd } = require(guardModule);
  const before = process.cwd();
  const result = ensureLiveCwd({ log: () => { throw new Error('must not log'); } });
  assert.deepEqual(result, { ok: true, recovered: false, cwd: before });
});

test('board MCP server started in a deleted cwd recovers before serving requests', async () => {
  const project = tempDir('mcp-project');
  const dead = tempDir('mcp-dead');
  const child = spawn('sh', ['-c', ENTER_DELETED_CWD, 'sh', dead, process.execPath, mcpServer], {
    env: { ...process.env, PWD: dead, CLAUDE_PROJECT_DIR: project },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sq368', version: '0' } } })}\n`);
  // SQ-65: a fixed 15s spawn wait loses under load; scale it with the competing test workers.
  await waitForCapacity(() => stdout.includes('"id":1') || child.exitCode !== null, {
    perTestWorkerMilliseconds: 2_000,
    floorMilliseconds: 15_000,
    pollMilliseconds: 50,
  });
  child.stdin.end();
  child.kill();
  assert.match(stdout, /"id":1/, `server answered initialize; stderr: ${stderr}`);
  assert.ok(stderr.includes(`"${dead}" no longer exists`), `recovery names the deleted directory; stderr: ${stderr}`);
  assert.ok(stderr.includes(`continuing from "${project}"`), `recovery names the surviving directory; stderr: ${stderr}`);
});
