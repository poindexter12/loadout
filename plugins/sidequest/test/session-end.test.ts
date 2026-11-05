'use strict';
// SQ-386: Claude Code gives a SessionEnd hook a shutdown window far shorter than the timeout
// hooks.json declares, and cancels the hook ("Hook cancelled") when it overruns. The inline
// worktree sweep took seconds on a real repository, so SessionEnd now hands the sweep to the
// detached worker SessionStart already uses. These fixtures model what a user actually has at
// exit: a git repository with several agent worktrees left behind by integrated work.
import {
  test,
  assert,
  os,
  fs,
  path,
  SESSION,
  SESSION_END,
  PLUGIN_ROOT,
  gitFixture,
  registerProject,
  sweepReportFile,
  waitForPath,
  runHook,
} from './_hooks-fixture.js';
import { spawnSync } from 'node:child_process';

const EXIT_BUDGET_MS = 1000;
const STALE_WORKTREES = 5;

function repository(label: string): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sq-session-end-${label}-`)));
  gitFixture(['init', '-b', 'main'], repo);
  gitFixture(['config', 'user.name', 'Sidequest Test'], repo);
  gitFixture(['config', 'user.email', 'sidequest-test@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'session-end fixture\n');
  gitFixture(['add', 'README.md'], repo);
  gitFixture(['commit', '-m', 'base'], repo);
  gitFixture(['branch', '-M', 'main'], repo);
  return repo;
}

// An agent worktree whose one commit was cherry-picked onto main hours ago: integrated work
// the sweep is meant to reclaim.
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

function hookEnv(home: string, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, SIDEQUEST_HOME: home, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...overrides };
}

function runSessionEnd(home: string, payload: Record<string, unknown>): { status: number | null; stderr: string; elapsedMs: number } {
  const started = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [SESSION_END], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: hookEnv(home),
    windowsHide: true,
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(result.error, undefined, String(result.error));
  return { status: result.status, stderr: result.stderr || '', elapsedMs };
}

function progressFile(home: string, cwd: string): string {
  return sweepReportFile(home, cwd).replace(/\.json$/, '.progress.json');
}

function sweepSessionState(home: string): { sessions?: Record<string, string> } {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'worktree-sweep-sessions.json'), 'utf8'));
  } catch (_) {
    return {};
  }
}

test('session-end exits inside the shutdown window and a detached worker reclaims the stale worktrees', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-session-end-home-'));
  const repo = repository('sweep');
  try {
    const stale = Array.from({ length: STALE_WORKTREES }, (_, index) => integratedWorktree(repo, `agent-exit-${index}`));
    registerProject(home, repo);
    const sessionId = 'session-end-exit';
    fs.writeFileSync(path.join(home, 'worktree-sweep-sessions.json'), JSON.stringify({ sessions: { [sessionId]: repo } }));
    const report = sweepReportFile(home, repo);
    assert.equal(fs.existsSync(report), false);

    const result = runSessionEnd(home, { session_id: sessionId, cwd: repo, reason: 'prompt_input_exit' });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      result.elapsedMs < EXIT_BUDGET_MS,
      `session-end took ${Math.round(result.elapsedMs)}ms with ${STALE_WORKTREES} sweep candidates; it must exit within ${EXIT_BUDGET_MS}ms`,
    );
    assert.equal(sweepSessionState(home).sessions?.[sessionId], undefined, 'session-end must still unregister the ending session');

    // The sweep keeps running after the hook exits and leaves its report for the next start.
    await waitForPath(report);
    for (const { worktree, branch } of stale) {
      assert.equal(fs.existsSync(worktree), false, `the detached sweep must reclaim ${worktree}`);
      assert.equal(gitFixture(['branch', '--list', branch], repo), '');
    }
    assert.ok(Array.isArray(JSON.parse(fs.readFileSync(report, 'utf8')).notices));

    runHook(SESSION, { session_id: 'session-end-next', source: 'startup', cwd: repo }, {
      SIDEQUEST_HOME: home,
      SIDEQUEST_SWEEP_DEADLINE_MS: '0',
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    });
    assert.equal(fs.existsSync(report), false, 'the next session start must drain the session-end sweep report');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('session-end keeps an unread sweep report for the next session start instead of overwriting it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-session-end-carry-home-'));
  const repo = repository('carry');
  try {
    registerProject(home, repo);
    const report = sweepReportFile(home, repo);
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, JSON.stringify({ notices: ['sidequest: unread notice from the SessionStart sweep'] }));

    const result = runSessionEnd(home, { session_id: 'session-end-carry', cwd: repo });
    assert.equal(result.status, 0, result.stderr);
    await waitForPath(report);

    const context = runHook(SESSION, { session_id: 'session-end-carry-next', source: 'startup', cwd: repo }, {
      SIDEQUEST_HOME: home,
      SIDEQUEST_SWEEP_DEADLINE_MS: '0',
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    });
    assert.match(context, /unread notice from the SessionStart sweep/);
    const replay = runHook(SESSION, { session_id: 'session-end-carry-replay', source: 'startup', cwd: repo }, {
      SIDEQUEST_HOME: home,
      SIDEQUEST_SWEEP_DEADLINE_MS: '0',
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    });
    assert.doesNotMatch(replay, /unread notice from the SessionStart sweep/, 'a carried notice is reported once, not replayed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('session-end does not start a second sweep while one for the checkout is still running', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-session-end-inflight-home-'));
  const repo = repository('inflight');
  try {
    const { worktree } = integratedWorktree(repo, 'agent-inflight');
    registerProject(home, repo);
    const progress = progressFile(home, repo);
    fs.mkdirSync(path.dirname(progress), { recursive: true });
    const running = { planned: 3, removed: 1, keptByReason: {}, considered: 4, total: 9 };
    fs.writeFileSync(progress, JSON.stringify(running));

    const result = runSessionEnd(home, { session_id: 'session-end-inflight', cwd: repo });

    assert.equal(result.status, 0, result.stderr);
    // A worker start resets progress to zero before it spawns, so untouched progress proves
    // no second worker was started.
    assert.deepEqual(JSON.parse(fs.readFileSync(progress, 'utf8')), running);
    assert.equal(fs.existsSync(sweepReportFile(home, repo)), false);
    assert.equal(fs.existsSync(worktree), true);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('session-end sweeps again when the earlier worker died without a report', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-session-end-dead-home-'));
  const repo = repository('dead');
  try {
    const { worktree } = integratedWorktree(repo, 'agent-dead-worker');
    registerProject(home, repo);
    const progress = progressFile(home, repo);
    fs.mkdirSync(path.dirname(progress), { recursive: true });
    fs.writeFileSync(progress, JSON.stringify({ planned: 0, removed: 0, keptByReason: {}, considered: 0, total: 1 }));
    const abandoned = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(progress, abandoned, abandoned);

    const result = runSessionEnd(home, { session_id: 'session-end-dead', cwd: repo });

    assert.equal(result.status, 0, result.stderr);
    await waitForPath(sweepReportFile(home, repo));
    assert.equal(fs.existsSync(worktree), false, 'an abandoned progress file must not block collection forever');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('session-end stays fail-soft when the sweep worker cannot be found', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-session-end-failsoft-home-'));
  const repo = repository('failsoft');
  try {
    registerProject(home, repo);
    const result = spawnSync(process.execPath, [SESSION_END], {
      input: JSON.stringify({ session_id: 'session-end-failsoft', cwd: repo }),
      encoding: 'utf8',
      env: hookEnv(home, { CLAUDE_PLUGIN_ROOT: path.join(repo, 'missing-plugin') }),
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
