import './_temp-cleanup.js';
import './_gateway-catalog-freshness.js';
import './_sidequest-install-fixture.js';
import './_hook-runtime.js';
'use strict';
export const test = require('node:test');
export const assert = require('node:assert');
export const os = require('os');
export const fs = require('fs');
export const path = require('path');
export const crypto = require('node:crypto');
export const { execFileSync, spawn, spawnSync } = require('node:child_process');
export const { waitForCapacity, capacityWaitTimeoutMessage } = require('./_capacity-deadline.js');

// A throwaway store home so the SubagentStop hook (which loads lib/store.js as a
// subprocess and inherits this env) reads a fixture board, never the real one. The
// other hooks in this file don't touch the store, so this redirect is harmless to
// them. Set BEFORE requiring store so its lazy home resolution picks it up.
export const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-test-'));
export const DISCOVERY = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-catalog-'));
fs.mkdirSync(path.join(DISCOVERY, 'model-gateway'), { recursive: true });
fs.writeFileSync(path.join(DISCOVERY, 'model-gateway', 'catalog.json'), JSON.stringify({
  schemaVersion: 3,
  updatedAt: new Date().toISOString(),
  source: 'model-gateway',
  codexReadiness: { ready: true, state: 'ready', message: 'Codex readiness confirms the local gateway is ready.' },
  models: [
    { slug: 'codex-gpt-5-6-luna', id: 'claude-gpt-5.6-luna[1m]', label: 'GPT-5.6 Luna' },
    { slug: 'codex-gpt-5-6-sol', id: 'claude-gpt-5.6-sol[1m]', label: 'GPT-5.6 Sol' },
    { slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra[1m]', label: 'GPT-5.6 Terra' },
  ],
}));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
process.env.SIDEQUEST_DISCOVERY_DIRS = DISCOVERY;
export const store = require('../lib/store.js');
export const { boardReconciliationReminderForStore } = require('../src/hooks/board-reconciliation-reminder.ts');
export const worktrees = require('../lib/worktrees.js');
export const worktreeLease = require('../lib/kernel/worktree.js');
export const { WORKTREE_CREATE_HOOK_TIMEOUT_SECONDS } = require('../src/lib/hook-timeouts.ts');
export const db = require('../lib/db.js');
export const { EFFORTS, stableReadOnlyClaudeName, stableReadOnlyDispatchName } = require('../lib/exec-names.js');
export const agentsync = require('../lib/agentsync.js');
export const BOARD_PATH = path.join(os.tmpdir(), 'sq-hooks-fixtures', 'board');
export const { slug } = store.ensureProject(BOARD_PATH);
export const database = db.openDb(SIDEQUEST_HOME);

export const HOOKS = path.join(__dirname, '..', 'hooks');
export const SESSION = path.join(HOOKS, 'session-start.js');
export const SESSION_END = path.join(HOOKS, 'session-end.js');
export const FORCE_BYPASS = path.join(HOOKS, 'force-exec-bypass.js');
export const SUBAGENT_START = path.join(HOOKS, 'subagent-start.js');
export const SUBAGENT_STOP = path.join(HOOKS, 'subagent-stop.js');
export const GUARD_PEER = path.join(HOOKS, 'guard-peer-message.js');
export const GUARD_HOME_DELETE = path.join(HOOKS, 'guard-home-delete.js');
export const GUARD_WORKTREE_ISOLATION = path.join(HOOKS, 'guard-worktree-isolation.js');
export const GUARD_BASH_WINDOWS_PATHS = path.join(HOOKS, 'guard-bash-windows-paths.js');
export const GUARD_HEREDOC_ISOLATED = path.join(HOOKS, 'guard-heredoc-isolated.js');
export const GUARD_POWERSHELL_CMD_SHIMS = path.join(HOOKS, 'guard-powershell-cmd-shims.js');
export const REPEATED_COMMAND_WARN = path.join(HOOKS, 'repeated-command-warn.js');
export const INLINE_WORK_NUDGE = path.join(HOOKS, 'inline-work-nudge.js');
export const BOARD_FIRST_REMINDER = path.join(HOOKS, 'board-first-reminder.js');
export const BOARD_RECONCILIATION_REMINDER = path.join(HOOKS, 'board-reconciliation-reminder.js');
export const STOP = path.join(HOOKS, 'stop.js');
export const POST_COMPACT = path.join(HOOKS, 'post-compact.js');
export const GUARD_TASK_OUTPUT = path.join(HOOKS, 'guard-task-output.js');
export const GUARD_SHARED_CHECKOUT_GIT = path.join(HOOKS, 'guard-shared-checkout-git.js');
export const GUARD_SHARED_TREE_COMMIT = path.join(HOOKS, 'guard-shared-tree-commit.js');
export const WORKTREE_CREATE = path.join(HOOKS, 'worktree-create.js');

// Budget tests pin the plugin root because the nudge embeds it in CLI fallbacks.
export const BUDGET = {
  session: 5200,
  compact: 3200,
  workforce: 1800,
  reconciliation: 360,
  longrun: 400, // SubagentStop runaway note — one short line, like the standing reminder
};
export const PLUGIN_ROOT = fs.realpathSync(path.join(__dirname, '..'));
export const PINNED_ROOT_NAME_LENGTH = 'sq-plugin-root'.length;
export const PINNED_ROOT_NAME = crypto
  .createHash('sha256')
  .update(PLUGIN_ROOT)
  .digest('hex')
  .slice(0, PINNED_ROOT_NAME_LENGTH);
export const FIXED_PLUGIN_ROOT = path.join(os.tmpdir(), PINNED_ROOT_NAME);

export function ensurePinnedPluginRoot() {
  let currentTarget;
  let pinnedRootExists = false;
  try {
    fs.lstatSync(FIXED_PLUGIN_ROOT);
    pinnedRootExists = true;
    currentTarget = fs.realpathSync(FIXED_PLUGIN_ROOT);
  } catch (error) {
    if ((error as any)?.code !== 'ENOENT') throw error;
  }
  if (pinnedRootExists && currentTarget !== PLUGIN_ROOT) {
    fs.rmSync(FIXED_PLUGIN_ROOT, { recursive: true, force: true });
  }
  if (currentTarget !== PLUGIN_ROOT) {
    try {
      fs.symlinkSync(PLUGIN_ROOT, FIXED_PLUGIN_ROOT, 'junction');
    } catch (error) {
      if ((error as any)?.code !== 'EEXIST') throw error;
    }
  }
  assert.equal(fs.realpathSync(FIXED_PLUGIN_ROOT), PLUGIN_ROOT);
}

ensurePinnedPluginRoot();

export const RETIRED_SCOUT = `sidequest-${'scout'}`;

// Run a hook with the given stdin payload and return the injected
// additionalContext string (or '' when the hook stays silent).
export function runHookOutput(script?: any, payload?: any, envOverrides?: any) {
  const out = execFileSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...(envOverrides || {}) },
  });
  return out.trim() ? JSON.parse(out) : null;
}

export function runHookWithFailureDetails(script?: any, payload?: any, envOverrides?: any): string {
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...(envOverrides || {}) },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const details = [
    `exit=${result.status === null ? 'none' : result.status}`,
    `signal=${result.signal || 'none'}`,
    `spawn_error=${result.error?.message || 'none'}`,
    `stderr=${JSON.stringify(result.stderr || '')}`,
    `stdout=${JSON.stringify(result.stdout || '')}`,
  ].join('\n');
  assert.equal(result.error, undefined, `SubagentStop hook could not start:\n${details}`);
  assert.equal(result.signal, null, `SubagentStop hook ended on a signal:\n${details}`);
  assert.equal(result.status, 0, `SubagentStop hook exited nonzero:\n${details}`);
  return result.stdout || '';
}

export interface HookProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runHookProcessForBudget(script?: any, payload?: any, envOverrides?: any): Promise<HookProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: FIXED_PLUGIN_ROOT,
        ...(envOverrides || {}),
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk?: any) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk?: any) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (status?: any) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

export const WAIT_FOR_PATH_PER_TEST_WORKER_MS = 2_000;
export const WAIT_FOR_PATH_FLOOR_MS = 60_000;

export async function waitForPath(file: string): Promise<void> {
  // Detached workers run slower under host load than worker count predicts; the poll returns
  // as soon as the file lands, so the floor only lengthens a failure. SQ-74: the per-worker
  // term also scales with the measured load, the way the capture budget around it does.
  const result = await waitForCapacity(() => fs.existsSync(file), {
    perTestWorkerMilliseconds: WAIT_FOR_PATH_PER_TEST_WORKER_MS,
    floorMilliseconds: WAIT_FOR_PATH_FLOOR_MS,
    pollMilliseconds: 5,
  });
  if (!result.ready) throw new Error(capacityWaitTimeoutMessage(file, result));
}

export function publishStateLock(lockDirectory: string, ownerPid: number): string {
  const generation = `fixture-${crypto.randomUUID()}`;
  const candidateDirectory = `${lockDirectory}.${generation}`;
  const ownerName = `owner-${generation}`;
  fs.mkdirSync(candidateDirectory, { recursive: true });
  fs.writeFileSync(path.join(candidateDirectory, ownerName), `${ownerPid}\n`);
  fs.renameSync(candidateDirectory, lockDirectory);
  return path.join(lockDirectory, ownerName);
}

export function blocksStop(result: HookProcessResult, asyncRewake = false): boolean {
  if (asyncRewake) return false;
  let output = null;
  try {
    output = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  } catch (_) {}
  return result.status === 2
    || output?.decision === 'block'
    || Boolean(output?.hookSpecificOutput?.additionalContext);
}

export function hostContinuationCount(
  results: HookProcessResult[],
  hooks: Array<{ asyncRewake?: boolean }>,
): number {
  return Number(results.some((result, index) => blocksStop(result, hooks[index]?.asyncRewake)));
}

export function runHook(script?: any, payload?: any, envOverrides?: any) {
  const parsed = runHookOutput(script, payload, envOverrides);
  if (!parsed) return '';
  return (parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext) || '';
}

export function windowsShortPath(pathname: string): string {
  return execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${pathname}") do @echo %~sI`], {
    encoding: 'utf8', windowsHide: true, shell: true,
  }).trim();
}

export function runSessionWithHome(home?: any, envOverrides?: any) {
  return execFileSync(process.execPath, [SESSION], {
    input: JSON.stringify({ session_id: 'bootstrap-test' }),
    encoding: 'utf8',
    env: {
      ...process.env,
      SIDEQUEST_HOME: home,
      SIDEQUEST_SWEEP_DEADLINE_MS: '60000',
      ...(envOverrides || {}),
    },
  });
}

export function runHookOutputForBudget(script?: any, payload?: any, envOverrides?: any) {
  return runHookOutput(script, payload, { ...(envOverrides || {}), CLAUDE_PLUGIN_ROOT: FIXED_PLUGIN_ROOT });
}

export function runHookForBudget(script?: any, payload?: any, envOverrides?: any) {
  return runHook(script, payload, { ...(envOverrides || {}), CLAUDE_PLUGIN_ROOT: FIXED_PLUGIN_ROOT });
}

export function runSessionWithHomeForBudget(home?: any, envOverrides?: any) {
  return runSessionWithHome(home, { ...(envOverrides || {}), CLAUDE_PLUGIN_ROOT: FIXED_PLUGIN_ROOT });
}

// SQ-137: the budget lint below used to read hooks.test.ts alone. The hooks tests now live in
// several shards, so it reads all of them, each from its first test on, leaving out the shard's
// own preamble (whose imported helper names would otherwise exempt the test beside it).
export function hookShardSources() {
  return fs.readdirSync(__dirname)
    .filter((name: string) => /^hooks(-[a-z-]+)?\.test\.ts$/.test(name))
    .sort()
    .map((name: string) => {
      const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
      return source.slice(source.indexOf('\ntest('));
    })
    .join('\n');
}

export function unpinnedBudgetTests(source?: any) {
  return source
    .split(/\n(?=test\()/)
    .filter((block?: any) => block.includes('BUDGET.') && !block.includes('budget assertions must use a fixed plugin root') && !block.includes('runHookForBudget') && !block.includes('runHookOutputForBudget') && !block.includes('runHookProcessForBudget') && !block.includes('runSessionWithHomeForBudget'));
}

export function writeCategory(home?: any, category?: any) {
  const database = db.openDb(home);
  const profileId = database.prepare('SELECT new_project_profile_id FROM routing_profile_settings WHERE singleton = 1').get().new_project_profile_id;
  const position = Number(database.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM routing_profile_entries WHERE profile_id = ?').get(profileId).position);
  db.putRow(database, 'routing_profile_entries', {
    profile_id: profileId,
    category_id: category.id,
    data: category,
    position,
    updated_at: new Date().toISOString(),
  });
  database.close();
}

export function withSidequestHome<Result>(home: string, action: () => Result): Result {
  const previousHome = process.env.SIDEQUEST_HOME;
  process.env.SIDEQUEST_HOME = home;
  try {
    return action();
  } finally {
    if (previousHome === undefined) delete process.env.SIDEQUEST_HOME;
    else process.env.SIDEQUEST_HOME = previousHome;
  }
}

export function registerProject(home: string, project: string): void {
  withSidequestHome(home, () => store.ensureProject(project));
}

export function writeModelPrefs(home?: any, prefs?: any) {
  const database = db.openDb(home);
  db.putRow(database, 'globals', { key: 'model-prefs', data: prefs });
}

export function writeOversizedRoutingProfile(home: string): void {
  const previousHome = process.env.SIDEQUEST_HOME;
  process.env.SIDEQUEST_HOME = home;
  try {
    const profileId = 'oversized-workforce';
    store.createRoutingProfile(profileId, { from: 'coding', name: 'Oversized workforce' });
    for (let index = 0; index < 80; index += 1) {
      store.setRoutingProfileCategory(profileId, {
        id: `oversized-category-${String(index).padStart(2, '0')}`,
        name: `Oversized category ${index}`,
        route: { model: 'sonnet', effort: 'medium' },
        enabled: true,
      });
    }
    store.setNewProjectRoutingProfile(profileId);
  } finally {
    if (previousHome === undefined) delete process.env.SIDEQUEST_HOME;
    else process.env.SIDEQUEST_HOME = previousHome;
  }
}

// Phrases from the retired heavy doctrine that must NOT come back to any block.
export const RETIRED = ['95%', 'read ~4+ files', 'AskUserQuestion', 'coreDiscipline'];

export function assertNoRetiredDoctrine(ctx?: any, where?: any) {
  for (const phrase of RETIRED) {
    assert.ok(!ctx.includes(phrase), `${where} must not carry retired doctrine ("${phrase}")`);
  }
}

export function gitFixture(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

export function completeCheckoutCreation(project: string, sessionId: string, worktree: string): void {
  const gitDirectoryValue = gitFixture(['rev-parse', '--git-dir'], worktree);
  const gitDirectory = path.isAbsolute(gitDirectoryValue) ? gitDirectoryValue : path.resolve(worktree, gitDirectoryValue);
  worktreeLease.createCheckoutInstanceMarker(gitDirectory);
  assert.equal(store.completeDispatchWorktreeCreation(project, sessionId, worktree).ok, true);
}

export function preparedPrompt(prepared: any): string {
  return agentsync.renderDispatchStub(prepared.ticket, BOARD_PATH);
}

/* ------------------------------------------------------------------ *
 *  Builtin executors spawned WITHOUT a model must not silently inherit
 *  the session model — resolve the routed model from a ref in the prompt,
 *  or deny the spawn when it can't be resolved unambiguously (SQ-232).
 * ------------------------------------------------------------------ */

export const fixtureState: { fixtureSeq: number; sqSeq: number } = { fixtureSeq: 0, sqSeq: 0 };
export function fixtureTicket(title?: any, model?: any, effort?: any) {
  const category = `hooks-route-${++fixtureState.fixtureSeq}`;
  store.setCategory({
    id: category,
    name: category,
    route: { model, effort },
    fallback: null,
    enabled: true,
  });
  return store.createTicket(slug, { title, category, source: 'cli' });
}



/* ------------------------------------------------------------------ *
 *  CLAUDE_CODE_SUBAGENT_MODEL defeats routing (it overrides both the Agent
 *  model and the frontmatter pin) — so a sidequest executor spawn must be
 *  denied while it's set, not run on the wrong model.
 * ------------------------------------------------------------------ */

export function runForceBypassWithEnv(toolInput?: any, envOverrides?: any) {
  const out = execFileSync(process.execPath, [FORCE_BYPASS], {
    input: JSON.stringify({ tool_name: 'Agent', tool_input: toolInput }),
    encoding: 'utf8',
    env: { ...process.env, ...envOverrides },
  });
  return out.trim() ? JSON.parse(out) : null;
}

/* ------------------------------------------------------------------ *
 *  Peer-message guard — an executor reports UP (final message + its own
 *  ticket comments), never sideways to a peer. This is the other half of
 *  the Contractify loop.
 * ------------------------------------------------------------------ */

export function runGuardPeer(payload?: any) {
  const out = execFileSync(process.execPath, [GUARD_PEER], {
    input: JSON.stringify({ tool_name: 'SendMessage', ...payload }),
    encoding: 'utf8',
  });
  return out.trim() ? JSON.parse(out) : null;
}

export function runHomeDeleteGuard(tool_name?: any, command?: any) {
  return runHookOutput(GUARD_HOME_DELETE, { tool_name, tool_input: { command } });
}

export function runBashWindowsPathGuard(command?: any, platform = 'win32') {
  const out = execFileSync(process.execPath, [
    '-e',
    `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} }); require(${JSON.stringify(GUARD_BASH_WINDOWS_PATHS)});`,
  ], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
  });
  return out.trim() ? JSON.parse(out) : null;
}

export function runPowerShellCmdShimGuard(command?: any, platform = 'win32') {
  const out = execFileSync(process.execPath, [
    '-e',
    `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} }); require(${JSON.stringify(GUARD_POWERSHELL_CMD_SHIMS)});`,
  ], {
    input: JSON.stringify({ tool_name: 'PowerShell', tool_input: { command } }),
    encoding: 'utf8',
  });
  return out.trim() ? JSON.parse(out) : null;
}

// SQ-133. A security guard must never allow a call just because the board is contended: whoever holds the lock
// could then walk any guarded call past it. Each guard below reaches its board read while another process holds
// the board lock, and must refuse with the retry guidance instead of allowing. Since SQ-125 every store open is
// read-only, and under WAL a BEGIN IMMEDIATE writer never blocks a reader, so the holder takes the one lock a
// reader cannot pass: exclusive locking mode plus a read inside BEGIN EXCLUSIVE.
export function failClosedBoardHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-fail-closed-'));
  execFileSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(PLUGIN_ROOT, 'lib', 'store.js'))}).listProjects({ all: true });`], {
    env: { ...process.env, SIDEQUEST_HOME: home },
    stdio: 'ignore',
    windowsHide: true,
  });
  assert.ok(fs.existsSync(path.join(home, 'sidequest.db')), 'fixture board database was not created');
  return home;
}

export function holdExclusiveBoardLock(home: string): Promise<ReturnType<typeof spawn>> {
  const holder = spawn(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(${JSON.stringify(path.join(home, 'sidequest.db'))});
    database.exec('PRAGMA locking_mode = EXCLUSIVE');
    database.exec('BEGIN EXCLUSIVE');
    database.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get();
    process.stdout.write('locked');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return new Promise((resolve, reject) => {
    holder.once('error', reject);
    holder.stdout.once('data', () => resolve(holder));
    holder.stderr.once('data', (data: Buffer) => reject(new Error(String(data))));
  });
}

export async function runGuardUnderBoardLock(script: string, payload: Record<string, unknown>) {
  const home = failClosedBoardHome();
  const holder = await holdExclusiveBoardLock(home);
  try {
    const started = Date.now();
    const result = await runHookProcessForBudget(script, payload, { SIDEQUEST_HOME: home });
    return { ...result, elapsedMs: Date.now() - started };
  } finally {
    holder.kill();
  }
}

export function assertBoardContentionDeny(result: HookProcessResult & { elapsedMs: number }, hook: string): void {
  const details = `exit=${result.status}\nstderr=${JSON.stringify(result.stderr)}\nstdout=${JSON.stringify(result.stdout)}`;
  assert.equal(result.status, 0, `${hook} must deny through its hook output, not crash:\n${details}`);
  let output: any = null;
  try { output = JSON.parse(result.stdout); } catch (_) {}
  assert.equal(output?.hookSpecificOutput?.hookEventName, 'PreToolUse', `${hook} must emit one PreToolUse decision:\n${details}`);
  assert.equal(output?.hookSpecificOutput?.permissionDecision, 'deny', `${hook} allowed a call it could not check:\n${details}`);
  const reason = String(output.hookSpecificOutput.permissionDecisionReason);
  assert.match(reason, new RegExp(`sidequest: ${hook} refused this call because of board lock contention`));
  assert.match(reason, /The call did not run\. Retry the same call in a few seconds/);
  assert.match(result.stderr, /fail-closed, board lock busy/);
  assert.doesNotMatch(result.stderr, /fail-open/);
  // The lock wait is bounded by the budget itself: the guard refuses on its first 1.5s exhaustion and never retries,
  // so it fits its 10s hook timeout. Assert that bound from the guard's own report rather than wall-clock time,
  // which on a loaded machine measures process startup, not lock waiting.
  assert.match(
    result.stderr,
    /after 1 attempt, each waiting up to 1500ms \(hook lock budget\)/,
    `${hook} must refuse on its first hook-budget exhaustion (took ${result.elapsedMs}ms):\n${details}`,
  );
}

export function executorPayload(toolName: string, toolInput: Record<string, unknown>, cwd?: string): Record<string, unknown> {
  return {
    hook_event_name: 'PreToolUse',
    session_id: `sq-133-fail-closed-${crypto.randomUUID()}`,
    agent_id: `sq-133-agent-${crypto.randomUUID()}`,
    agent_type: 'sidequest-exec-high',
    tool_name: toolName,
    tool_input: toolInput,
    ...(cwd ? { cwd } : {}),
  };
}

export function claimHeredocWorker(label: string): Record<string, unknown> {
  const ticket = addStopTicket(label);
  const sessionId = `heredoc-isolated-${++fixtureState.sqSeq}`;
  return claimStopTicket(ticket, sessionId, `heredoc-worker-${fixtureState.sqSeq}`);
}

// The sweep's cost is bimodal, so the hook hands it to a detached worker and waits
// only up to a deadline. These pin the deadline path: a slow sweep must cost the
// session its notices, never its whole injected context.
export function sweepReportFile(home: string, cwd: string): string {
  const key = require('node:crypto').createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 16);
  return path.join(home, 'sweep-reports', `${key}.json`);
}

// The marker path formula, duplicated in sidequest, codebase-mapper, and live-rules. SIDEQUEST_HOME
// is set for this whole file, so every reader resolves the same file.
export function replacementMarkerPath(sessionId: string): string {
  return path.join(SIDEQUEST_HOME, 'replacement-compactions', `${encodeURIComponent(sessionId)}.json`);
}

export const MAPPER_SESSION_START = path.join(__dirname, '..', '..', 'codebase-mapper', 'hooks', 'inject-context.js');
export const LIVE_RULES_SESSION_START = path.join(__dirname, '..', '..', 'live-rules', 'hooks', 'session-start-rules.js');
export const REPLACEMENT_NOTE = /history retained across a replacement compaction/;
export const SESSION_START_READERS = ['sidequest', 'codebase-mapper', 'live-rules'] as const;
export type SessionStartReader = typeof SESSION_START_READERS[number];

// SQ-200: one project that all three SessionStart(compact) readers re-ground from in full, with a
// sentinel line in each full body so a short note is distinguishable from a full re-injection.
export function sessionStartReaderFixture() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sq200-readers-'));
  const mapDir = path.join(projectDir, '.claude', '.codebase-info');
  fs.mkdirSync(mapDir, { recursive: true });
  fs.writeFileSync(path.join(mapDir, 'INDEX.md'), '# SQ-200 fixture map\n\nSQ200_MAPPER_FULL_BODY\n');
  const liveRules = require('../../live-rules/hooks/lib/rules');
  const ruleData = { description: 'Always' };
  liveRules.writeAtomicRuleSet(projectDir, [{
    rule: liveRules.buildRule('rule', ruleData, 'SQ200_LIVE_RULES_FULL_BODY'),
    content: '---\ndescription: Always\n---\nSQ200_LIVE_RULES_FULL_BODY\n',
  }]);
  const readers: Record<SessionStartReader, { script: string; env: Record<string, string>; full: RegExp }> = {
    sidequest: { script: SESSION, env: {}, full: /ROLE: ORCHESTRATOR/ },
    'codebase-mapper': {
      script: MAPPER_SESSION_START,
      env: { CLAUDE_PROJECT_DIR: projectDir, CODEBASE_MAPPER_STATE_DIR: path.join(projectDir, 'mapper-state') },
      full: /SQ200_MAPPER_FULL_BODY/,
    },
    'live-rules': {
      script: LIVE_RULES_SESSION_START,
      env: { CLAUDE_PROJECT_DIR: projectDir, LIVE_RULES_STATE_DIR: path.join(projectDir, 'live-rules-state') },
      full: /SQ200_LIVE_RULES_FULL_BODY/,
    },
  };
  // The peers resolve the project from CLAUDE_PROJECT_DIR (set per reader above); sidequest gets the
  // same payload shape as the SQ-197 tests below.
  const payload = (sessionId: string) => ({ session_id: sessionId, source: 'compact', hook_event_name: 'SessionStart' });
  const contextOf = (stdout: string) => (stdout.trim() ? JSON.parse(stdout).hookSpecificOutput?.additionalContext || '' : '');
  return {
    readers,
    runInOrder(sessionId: string, order: readonly SessionStartReader[]): Record<SessionStartReader, string> {
      const contexts = {} as Record<SessionStartReader, string>;
      for (const name of order) contexts[name] = runHook(readers[name].script, payload(sessionId), readers[name].env);
      return contexts;
    },
    async runInParallel(sessionId: string): Promise<Record<SessionStartReader, string>> {
      const results = await Promise.all(SESSION_START_READERS.map(async (name) => ({
        name,
        result: await runHookProcessForBudget(readers[name].script, payload(sessionId), readers[name].env),
      })));
      const contexts = {} as Record<SessionStartReader, string>;
      for (const { name, result } of results) {
        assert.equal(result.status, 0, `${name} SessionStart exited nonzero: ${result.stderr}`);
        contexts[name] = contextOf(result.stdout);
      }
      return contexts;
    },
  };
}

export type ReaderExpectations = Record<SessionStartReader, { full: RegExp }>;

export function assertAllShortNotes(contexts: Record<SessionStartReader, string>, readers: ReaderExpectations, label: string): void {
  for (const name of SESSION_START_READERS) {
    assert.match(contexts[name], REPLACEMENT_NOTE, `${label}: ${name} must emit the short replacement note`);
    assert.doesNotMatch(contexts[name], readers[name].full, `${label}: ${name} must not re-inject its full context`);
  }
}

export function assertAllFullContexts(contexts: Record<SessionStartReader, string>, readers: ReaderExpectations, label: string): void {
  for (const name of SESSION_START_READERS) {
    assert.match(contexts[name], readers[name].full, `${label}: ${name} must re-ground in full`);
    assert.doesNotMatch(contexts[name], REPLACEMENT_NOTE, `${label}: ${name} must not emit the short replacement note`);
  }
}

/* ------------------------------------------------------------------ *
 *  SubagentStop — flag a runaway (likely non-atomic) executor run post-hoc.
 *
 *  The hook can't stop a running subagent; it turns a long claim into ONE visible
 *  line so the orchestrator notices the ticket wasn't atomic. Elapsed comes from
 *  the claim's OWN start `at` in the worker registry (store already records it),
 *  NOT from the SubagentStop stdin — which we pass BARE here to prove that. We
 *  simulate a 28-min run by backdating the registry claim, then run the hook.
 * ------------------------------------------------------------------ */

export function linkedWorktreeFixturePath() {
  return path.join(os.tmpdir(), `sq-linked-worktree-hook-${++fixtureState.sqSeq}-${crypto.randomUUID()}`);
}
export function addTicket(title?: any) {
  return addStopTicket(title);
}

export function addStopTicket(title?: any, fields?: any, projectSlug: string = slug) {
  const category = `hooks-stop-${++fixtureState.fixtureSeq}`;
  store.setCategory({
    id: category,
    name: category,
    route: { model: 'sonnet', effort: 'high' },
    fallback: null,
    enabled: true,
  });
  return store.createTicket(projectSlug, Object.assign({
    title,
    category,
    source: 'cli',
  }, fields));
}

export function addEffortTicket(title?: any, effort?: any) {
  const category = `hooks-effort-${++fixtureState.fixtureSeq}`;
  store.setCategory({
    id: category,
    name: category,
    route: { model: 'sonnet', effort },
    fallback: null,
    enabled: true,
  });
  return store.createTicket(slug, {
    title,
    category,
    source: 'cli',
  });
}

export function claimStopTicket(ticket?: any, sessionId?: any, by?: any, projectSlug: string = slug) {
  const prepared = store.prepareDispatch(projectSlug, ticket.ref, { allowUnscoped: true, sessionId });
  const agentId = `stop-agent-${ticket.id}-${++fixtureState.sqSeq}`;
  const agentName = `stop-executor-${ticket.id}-${fixtureState.sqSeq}`;
  assert.equal(store.recordDispatchLaunch(projectSlug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentId, agentName).ok, true);
  const worktree = store.getTicket(projectSlug, ticket.ref).dispatch?.worktree;
  if (worktree) fs.mkdirSync(worktree, { recursive: true });
  assert.equal(store.claimTicket(projectSlug, ticket.ref, by, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  return { session_id: sessionId, agent_type: prepared.ticket.dispatchExecutor, agent_id: agentId, agent_name: agentName };
}

export function recordTerminalAgentFailure(ticket?: any, stop?: any) {
  const current = store.getTicket(slug, ticket.ref);
  return store.recordDispatchAgentFailure(slug, ticket.ref, {
    token: current.dispatchNonce,
    executor: stop.agent_type,
    sessionId: stop.session_id,
    taskName: stop.agent_name,
    agentId: stop.agent_id,
    agentName: stop.agent_name,
    error: 'Prompt is too long',
  });
}

// Backdate the claim's `at` without waiting real time.
export function backdateSessionClaims(sessionId?: any, minutesAgo?: any, effort?: any) {
  const w = db.getRow(database, 'globals', 'workers');
  const at = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  for (const c of w.sessions[sessionId].claims) {
    c.at = at;
    if (effort) c.effort = effort;
  }
  w.sessions[sessionId].updatedAt = at;
  db.putRow(database, 'globals', { key: 'workers', data: w });
}

// SQ-303. On a contended host guard-worktree-isolation hit its 10s PreToolUse deadline on 20 of the Edits
// a dispatched executor made, and subagent-start hit the same deadline on 15 executor spawns, where Claude
// Code kills the hook having decided nothing and the caller waited ten seconds for that. Both hooks were
// doing once-per-agent work on every single call: three `git rev-parse` spawns plus a board write
// transaction per Edit, and a whole-board ticket scan plus six git spawns inside a write transaction per
// spawn. These cover the Edit path deciding without spawning git, the binding happening once, and the
// spawn-time binding staying inside a budget with a deferral behind it.

// The shared hook modules resolve the built runtime through CLAUDE_PLUGIN_ROOT, which runHook sets for the
// hook subprocesses it spawns. These tests require those modules in-process, so set it here too.
process.env.CLAUDE_PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || PLUGIN_ROOT;

export function sq303Repo(prefix: string): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  gitFixture(['init', '-b', 'main'], repo);
  gitFixture(['config', 'user.name', 'Sidequest Test'], repo);
  gitFixture(['config', 'user.email', 'sidequest-test@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'sq-303 fixture\n');
  gitFixture(['add', '.'], repo);
  gitFixture(['commit', '-m', 'base'], repo);
  return repo;
}

// SQ-137: the topic shards of the former hooks.test.ts share this setup. Each shard runs in its
// own process, so each gets its own copy of every temp directory and env var made above.
