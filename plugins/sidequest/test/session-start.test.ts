'use strict';
// SQ-405: SessionStart used to wait up to 2500ms for its worktree sweep. The sweep's
// whole-board bookkeeping alone measured 2.3-7.3s, so the wait could never be met: every
// start paid the full budget and printed a deferral. SessionStart now hands the sweep to the
// detached worker and returns at once, the way SessionEnd does (SQ-386), and the worker's
// report surfaces on the next start. These pin that, using a worker held at a gate the test
// controls, so "returned without waiting" is a fact about ordering, not about timing.
import {
  test,
  assert,
  os,
  fs,
  path,
  SESSION,
  PLUGIN_ROOT,
  gitFixture,
  registerProject,
  sweepReportFile,
  waitForPath,
  waitForCapacity,
  capacityWaitTimeoutMessage,
  WAIT_FOR_PATH_PER_TEST_WORKER_MS,
  WAIT_FOR_PATH_FLOOR_MS,
  db,
} from './_hooks-fixture.js';
import { spawnSync } from 'node:child_process';

const handoff = require('../src/hooks/shared/sweep-handoff.ts');

const BUSY_POLICY_KEY = Symbol.for('sidequest.sqlite-busy-policy');

function repository(label: string): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sq-session-start-${label}-`)));
  gitFixture(['init', '-b', 'main'], repo);
  gitFixture(['config', 'user.name', 'Sidequest Test'], repo);
  gitFixture(['config', 'user.email', 'sidequest-test@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'session-start fixture\n');
  gitFixture(['add', 'README.md'], repo);
  gitFixture(['commit', '-m', 'base'], repo);
  gitFixture(['branch', '-M', 'main'], repo);
  return repo;
}

// An agent worktree whose one commit was cherry-picked onto main hours ago: integrated work
// the sweep may reclaim.
function integratedWorktree(repo: string, name: string): { worktree: string; branch: string } {
  const worktree = path.join(repo, '.claude', 'worktrees', name);
  const branch = `worktree-${name}`;
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  gitFixture(['worktree', 'add', '-b', branch, worktree, 'main'], repo);
  fs.writeFileSync(path.join(worktree, `${name}.txt`), `${name}\n`);
  gitFixture(['add', `${name}.txt`], worktree);
  gitFixture(['commit', '-m', `integrated ${name}`], worktree);
  gitFixture(['cherry-pick', gitFixture(['rev-parse', 'HEAD'], worktree)], repo);
  const aged = new Date(Date.now() - 4 * 60 * 60 * 1000);
  fs.utimesSync(worktree, aged, aged);
  return { worktree, branch };
}

interface SweepReport {
  notices: string[];
  finishedAt: string;
}

function readReport(file: string): SweepReport | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.notices) && typeof parsed?.finishedAt === 'string' ? parsed : null;
  } catch (_) {
    return null;
  }
}

async function waitForReport(file: string): Promise<SweepReport> {
  const result = await waitForCapacity(() => readReport(file) !== null, {
    perTestWorkerMilliseconds: WAIT_FOR_PATH_PER_TEST_WORKER_MS,
    floorMilliseconds: WAIT_FOR_PATH_FLOOR_MS,
    pollMilliseconds: 5,
  });
  if (!result.ready) throw new Error(capacityWaitTimeoutMessage(file, result));
  return readReport(file) as SweepReport;
}

// Loaded into every node process the hook starts. Only the sweep worker is held: it records
// that it started, blocks until the test opens the gate, and on exit records the SQLite lock
// budget it ran under.
function gatedWorkerPreload(dir: string): { preload: string; started: string; gate: string; policy: string } {
  const started = path.join(dir, 'worker-started');
  const gate = path.join(dir, 'worker-gate');
  const policy = path.join(dir, 'worker-policy.json');
  const preload = path.join(dir, 'gate-sweep-worker.cjs');
  fs.writeFileSync(preload, `'use strict';
const fs = require('node:fs');
if (/sweep-worktrees\\.js$/.test(process.argv[1] || '')) {
  fs.writeFileSync(${JSON.stringify(started)}, String(process.pid));
  const deadline = Date.now() + 120000;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(${JSON.stringify(gate)}) && Date.now() < deadline) Atomics.wait(cell, 0, 0, 20);
  process.on('exit', () => {
    const installed = Reflect.get(globalThis, Symbol.for('sidequest.sqlite-busy-policy'));
    fs.writeFileSync(${JSON.stringify(policy)}, JSON.stringify(installed ?? null));
  });
}
`);
  return { preload, started, gate, policy };
}

function runSessionStart(env: NodeJS.ProcessEnv, payload: Record<string, unknown>): { status: number | null; stderr: string; context: string } {
  const result = spawnSync(process.execPath, [SESSION], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, String(result.error));
  let context = '';
  try {
    context = JSON.parse(result.stdout || 'null')?.hookSpecificOutput?.additionalContext || '';
  } catch (_) {}
  return { status: result.status, stderr: result.stderr || '', context };
}

function withoutDeadline(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy.SIDEQUEST_SWEEP_DEADLINE_MS;
  return copy;
}

test('sweep deadline is an explicit opt-in: unset, blank, or invalid means no wait', () => {
  const previous = process.env.SIDEQUEST_SWEEP_DEADLINE_MS;
  try {
    delete process.env.SIDEQUEST_SWEEP_DEADLINE_MS;
    assert.equal(handoff.deadlineMs(), null);
    for (const value of ['', '   ', 'soon', '-5']) {
      process.env.SIDEQUEST_SWEEP_DEADLINE_MS = value;
      assert.equal(handoff.deadlineMs(), null, `SIDEQUEST_SWEEP_DEADLINE_MS=${JSON.stringify(value)} must not opt into a wait`);
    }
    process.env.SIDEQUEST_SWEEP_DEADLINE_MS = '0';
    assert.equal(handoff.deadlineMs(), 0);
    process.env.SIDEQUEST_SWEEP_DEADLINE_MS = '60000';
    assert.equal(handoff.deadlineMs(), 60000);
  } finally {
    if (previous === undefined) delete process.env.SIDEQUEST_SWEEP_DEADLINE_MS;
    else process.env.SIDEQUEST_SWEEP_DEADLINE_MS = previous;
  }
});

test('the sweep worker budget replaces the server lock policy with one bounded wait', () => {
  const previous = Reflect.get(globalThis, BUSY_POLICY_KEY);
  try {
    Reflect.deleteProperty(globalThis, BUSY_POLICY_KEY);
    const server = db.sqliteBusyPolicy();
    handoff.installSweepWorkerBudget();
    const worker = db.sqliteBusyPolicy();
    assert.equal(worker.label, 'sweep-worker');
    assert.equal(worker.attempts, 1);
    assert.ok(worker.timeoutMs * worker.attempts < server.timeoutMs * server.attempts,
      `the worker must not keep the server's ${server.timeoutMs}ms x ${server.attempts} budget`);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, BUSY_POLICY_KEY);
    else Reflect.set(globalThis, BUSY_POLICY_KEY, previous);
  }
});

test('session-start returns without waiting on its sweep, and the sweep reports on the next start', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-session-start-detach-home-'));
  const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-session-start-gate-'));
  const repo = repository('detach');
  const { preload, started, gate, policy } = gatedWorkerPreload(gateDir);
  try {
    const { worktree, branch } = integratedWorktree(repo, 'agent-detach');
    registerProject(home, repo);
    const report = sweepReportFile(home, repo);
    const env = withoutDeadline({
      ...process.env,
      SIDEQUEST_HOME: home,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${JSON.stringify(preload)}`.trim(),
    });

    const first = runSessionStart(env, { session_id: 'session-start-detach', source: 'startup', cwd: repo });
    assert.equal(first.status, 0, first.stderr);
    // The hook has exited. Its worker is either about to start or blocked at the closed gate,
    // so nothing the hook printed can have come from this start's sweep.
    assert.equal(fs.existsSync(gate), false);
    assert.doesNotMatch(first.context, /worktree sweep exceeded its SessionStart budget/,
      'with no opt-in deadline, session-start must not wait on its sweep or report a deferral');
    assert.doesNotMatch(first.context, /worktree sweep could not run/);
    assert.match(first.context, /sidequest/i, 'session-start must still inject its block');
    await waitForPath(started);
    assert.equal(readReport(report), null, 'a gated worker cannot have written its report yet');
    assert.equal(fs.existsSync(worktree), true, 'the gated worker has not swept yet');

    fs.writeFileSync(gate, 'open');
    const sweepReport = await waitForReport(report);
    assert.equal(fs.existsSync(worktree), false, 'the detached sweep must still reclaim integrated work');
    assert.equal(gitFixture(['branch', '--list', branch], repo), '');
    await waitForPath(policy);
    const workerPolicy = JSON.parse(fs.readFileSync(policy, 'utf8'));
    assert.equal(workerPolicy?.label, 'sweep-worker', 'the worker must run under its bounded lock budget, not the server policy');

    const next = runSessionStart(env, { session_id: 'session-start-detach-next', source: 'startup', cwd: repo });
    assert.equal(next.status, 0, next.stderr);
    assert.ok(sweepReport.notices.length > 0, 'the reclaiming sweep must leave a report');
    for (const notice of sweepReport.notices) {
      assert.ok(next.context.includes(notice), `the next session start must surface the sweep notice: ${notice}`);
    }
    assert.doesNotMatch(next.context, /worktree sweep exceeded its SessionStart budget/);
  } finally {
    fs.writeFileSync(gate, 'open');
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('session-start keeps a live linked worktree when it does not wait on the sweep', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-session-start-live-home-'));
  const repo = repository('live');
  try {
    const { worktree } = integratedWorktree(repo, 'agent-live');
    registerProject(home, repo);
    const env = withoutDeadline({ ...process.env, SIDEQUEST_HOME: home, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT });

    // The session runs inside the worktree, so the sweep must treat it as live. Its report is
    // keyed by the session's cwd.
    const result = runSessionStart(env, { session_id: 'session-start-live', source: 'startup', cwd: worktree });
    assert.equal(result.status, 0, result.stderr);
    await waitForReport(sweepReportFile(home, worktree));
    assert.equal(fs.existsSync(worktree), true, 'the detached sweep must never remove the worktree its own session runs in');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
