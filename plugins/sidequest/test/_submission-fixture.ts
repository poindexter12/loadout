import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
import './_hook-runtime.js';
'use strict';
/**
 * Tests for the ready-for-integration submission lifecycle (SQ-398).
 *
 * Executors never publish: a repo-changing run ends at a verified LOCAL commit
 * submitted for the orchestrator's publish transaction. These tests pin the
 * lifecycle invariants — submit requires the held claim and releases it, the
 * ticket parks in "doing" (distinct from done), submitted work leaves the
 * ready/claim pool, done consumes the submission, and clear reopens the ticket.
 *
 * Run: node --test plugins/sidequest/test/submission.test.js
 */
export const test = require('node:test');
export const { afterEach } = test;
export const assert = require('node:assert');
export const os = require('os');
export const path = require('path');
export const fs = require('fs');
export const { execFileSync } = require('child_process');

export const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-submission-test-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

export const store = require('../lib/store.js');
export const { recordCapture, runVerifyCapture } = require('../lib/verify-capture.js');
export const agentsync = require('../lib/agentsync.js');
export const mcp = require('../lib/mcp.js');
export const db = require('../lib/db.js');
export const { submissionRangeFailureMessage } = require('../lib/mcp-lifecycle.js');

afterEach(() => db.openDb(SIDEQUEST_HOME).exec('DELETE FROM tickets'));
export const { createLocks } = require('../src/lib/store/locks.ts');
export const { makeCliRunner } = require('./_helpers.js');

// realpath so the worktree-bound verify check sees the same root the CLI's
// process.cwd() reports (macOS tmpdir lives behind the /var -> /private/var symlink)
export const PROJECT_DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-submission-project-')));
export const REMOTE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-submission-remote-'));
export function git(args?: any) {
  return execFileSync('git', args, { cwd: PROJECT_DIR, encoding: 'utf8', windowsHide: true }).trim();
}
git(['init', '-b', 'main']);
git(['config', 'user.name', 'Sidequest Test']);
git(['config', 'user.email', 'sidequest-test@example.invalid']);
fs.writeFileSync(path.join(PROJECT_DIR, 'README.md'), 'submission fixture\n');
git(['add', '.']);
git(['commit', '-m', 'base']);
git(['branch', '-M', 'main']);
execFileSync('git', ['init', '-b', 'main', '--bare', REMOTE_DIR], { encoding: 'utf8', windowsHide: true });
git(['remote', 'add', 'origin', REMOTE_DIR]);
git(['push', '-u', 'origin', 'main']);
export const fixtureState: { branchSeq: number } = { branchSeq: 0 };
export function cleanBranch() {
  git(['checkout', '-f', '-B', `submission-${++fixtureState.branchSeq}`, 'origin/main']);
  git(['clean', '-fd']);
}
export function pin(ticket?: any, commit?: any) {
  git(['update-ref', `refs/sidequest/${ticket.ref}`, commit]);
}
export const { slug } = store.ensureProject(PROJECT_DIR);
export const exploration = store.getCategory('codebase-exploration');
store.setCategory(Object.assign({}, exploration, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));
// Dispatch fixtures route through a Claude model on purpose: the default routes
// are Codex, and CI has no model gateway to confirm readiness against.
store.setCategory({
  id: 'submission.fixture',
  name: 'Submission fixture',
  description: 'Fixed submission lifecycle fixture.',
  route: { model: 'sonnet', effort: 'medium' },
  fallback: null,
  enabled: true,
});
export const reviewAudit = store.getCategory('review-audit');
store.setCategory(Object.assign({}, reviewAudit, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));
export const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
export const BIND_RUNTIME_IDENTITY = path.join(__dirname, '..', 'hooks', 'bind-runtime-identity.js');
export const worktreeLease = require('../lib/kernel/worktree.js');
export const { runCli, cliJson } = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJECT_DIR }, { cwd: PROJECT_DIR });

export const COMMIT = 'abc1234def5678abc1234def5678abc1234def56';

export function persist(ticket?: any) {
  db.putRow(db.openDb(SIDEQUEST_HOME), 'tickets', {
    id: ticket.id,
    project: slug,
    ref: ticket.ref,
    status: ticket.status,
    archived: ticket.archived ? 1 : 0,
    ord: ticket.order,
    claim_by: ticket.claim ? ticket.claim.by : null,
    data: ticket,
  });
}

export function addTicket(title?: any, extra?: any) {
  return store.createTicket(slug, Object.assign({
    title,
    complexity: 3,
    complexityWhy: 'fixture for the submission lifecycle tests, single mechanical change',
    files: ['lib/fixture.js'],
    source: 'cli',
    labels: ['direct-ok'],
  }, extra || {}));
}

export function noGitCliTicket(title: string, files: string[]) {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-submission-no-git-project-'));
  const project = store.ensureProject(projectPath).slug;
  const ticket = store.createTicket(project, {
    title,
    complexity: 3,
    complexityWhy: 'fixture for one immutable non-Git project revision',
    files,
    source: 'cli',
    labels: ['direct-ok'],
    category: 'submission.fixture',
  });
  const runner = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: projectPath }, { cwd: projectPath });
  return { project, projectPath, ticket, runCli: runner.runCli };
}

export function registeredNoGitCliRunner(project: string, projectPath: string, resolution: { candidateExists: boolean; containsCandidate: boolean }) {
  const bootstrapDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-source-revision-capability-'));
  const bootstrapPath = path.join(bootstrapDirectory, 'register.cjs');
  const invocationLog = path.join(bootstrapDirectory, 'invocations.jsonl');
  const storeModule = path.join(__dirname, '..', 'lib', 'store.js');
  fs.writeFileSync(bootstrapPath, [
    `const fs = require('node:fs');`,
    `const store = require(${JSON.stringify(storeModule)});`,
    `store.registerSourceRevisionCapability(${JSON.stringify(project)}, (candidate, baseline) => {`,
    `  fs.appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify({ candidate, baseline, frozen: Object.isFrozen(baseline) && Object.isFrozen(baseline.revision) }) + '\\n');`,
    `  return ${JSON.stringify(resolution)};`,
    `});`,
  ].join('\n'));
  const existingNodeOptions = String(process.env.NODE_OPTIONS || '').trim();
  const nodeOptions = [existingNodeOptions, `--require=${bootstrapPath}`].filter(Boolean).join(' ');
  const runner = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: projectPath, NODE_OPTIONS: nodeOptions }, { cwd: projectPath });
  return { runCli: runner.runCli, invocationLog };
}

export function registeredNoGitCliRunnerWithCapability(project: string, projectPath: string, capabilityStatements: string[]) {
  const bootstrapDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-source-revision-capability-'));
  const bootstrapPath = path.join(bootstrapDirectory, 'register.cjs');
  const invocationLog = path.join(bootstrapDirectory, 'invocations.jsonl');
  const storeModule = path.join(__dirname, '..', 'lib', 'store.js');
  fs.writeFileSync(bootstrapPath, [
    `const fs = require('node:fs');`,
    `const store = require(${JSON.stringify(storeModule)});`,
    `let invocationCount = 0;`,
    `store.registerSourceRevisionCapability(${JSON.stringify(project)}, (candidate, baseline) => {`,
    `  invocationCount += 1;`,
    `  fs.appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify({ candidate, baseline, invocationCount }) + '\\n');`,
    ...capabilityStatements.map((statement) => `  ${statement}`),
    `});`,
  ].join('\n'));
  const existingNodeOptions = String(process.env.NODE_OPTIONS || '').trim();
  const nodeOptions = [existingNodeOptions, `--require=${bootstrapPath}`].filter(Boolean).join(' ');
  const runner = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: projectPath, NODE_OPTIONS: nodeOptions }, { cwd: projectPath });
  return { runCli: runner.runCli, invocationLog };
}

export function addClaimedTicket(title: string, owner: string, extra?: any) {
  const ticket = addTicket(title, extra);
  const claim = store.claimTicket(slug, ticket.ref, owner, { direct: true, reason: 'The submission fixture requires a local direct claim.' });
  assert.strictEqual(claim.ok, true, claim.message);
  return ticket;
}

export function createCandidateCommit(filename: string, content: string) {
  cleanBranch();
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', filename), content);
  git(['add', `lib/${filename}`]);
  git(['commit', '-m', `candidate ${filename}`]);
  return git(['rev-parse', 'HEAD']);
}

export function assertForeignSubmissionWasRefused(ticket: any, owner: string) {
  const stored = store.getTicket(slug, ticket.ref);
  assert.strictEqual(stored.claim.by, owner);
  assert.strictEqual(stored.submission, undefined);
  assert.strictEqual(stored.rejectedSubmissions, undefined);
}

export async function callMcp(name: string, args: Record<string, unknown>) {
  const tool = mcp.TOOLS.find((candidate: any) => candidate.name === name);
  assert.ok(tool, `missing MCP tool ${name}`);
  return tool.handler(args);
}

// SQ-81: a green capture at A survives a later commit B only when A is B's ancestor and the
// A..B diff touches nothing outside `.release/unreleased/`.
export async function captureThenCommit(title: string, files: Record<string, string>) {
  cleanBranch();
  fs.mkdirSync(path.join(PROJECT_DIR, 'test'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'scoped-surface.test.js'), '');
  const command = 'node --test test/scoped-surface.test.js';
  const t = addTicket(title, { executorVerify: command, files: ['README.md', 'src/'] });
  const by = `sq-81-${t.ref}`;
  const base = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(PROJECT_DIR, 'README.md'), `${title}\n`);
  git(['add', 'README.md']);
  git(['commit', '-m', `${t.ref} candidate`]);
  const captured = git(['rev-parse', 'HEAD']);
  pin(t, captured);
  assert.strictEqual(store.claimTicket(slug, t.ref, by, { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  const capture = await runVerifyCapture(command, PROJECT_DIR);
  assert.strictEqual(capture.status, 'passed');
  const recorded = recordCapture({ project: PROJECT_DIR, ticket: t.ref }, capture, PROJECT_DIR);
  assert.strictEqual(recorded.ok, true, recorded.message);
  assert.strictEqual(recorded.capture.candidate.value, captured);
  for (const [rawFile, body] of Object.entries(files)) {
    const file = rawFile.replace('{ref}', t.ref);
    fs.mkdirSync(path.dirname(path.join(PROJECT_DIR, file)), { recursive: true });
    fs.writeFileSync(path.join(PROJECT_DIR, file), body);
    git(['add', file]);
  }
  git(['commit', '-m', `${t.ref} follow-up`]);
  const tip = git(['rev-parse', 'HEAD']);
  pin(t, tip);
  const submit = () => callMcp('submit', { project: PROJECT_DIR, ref: t.ref, by, commit: tip, base, worktree: PROJECT_DIR, verify: command, body: 'SQ-81 fragment carry fixture.' });
  return { submit, capture, captured, tip };
}

// SQ-2159. A read-only review that completed its exact candidate still failed
// integration with candidate_review_required, because its SubagentStart raced
// its own worktree creation and no later write ever repaired the identity the
// gate reads out of the terminal done attempt.
export function submittedGateSource(title: string, filename: string, agentId: string) {
  const ticket = addTicket(title);
  const commit = createCandidateCommit(filename, `${filename} candidate\n`);
  pin(ticket, commit);
  assert.strictEqual(store.claimTicket(slug, ticket.ref, agentId, {
    direct: true,
    reason: 'The submission fixture requires a local direct claim.',
  }).ok, true);
  assert.strictEqual(store.submitTicket(slug, ticket.ref, agentId, {
    commit,
    verify: 'node --test plugins/sidequest/test/submission.test.js',
  }).ok, true);
  const submitted = store.getTicket(slug, ticket.ref);
  submitted.dispatch = {
    attempts: [{ outcome: 'submitted', commit, agentId, terminalAt: new Date(Date.now() - 60_000).toISOString() }],
  };
  persist(submitted);
  return { ticket: submitted, commit };
}

export function dispatchedIsolatedReview(title: string, sourceRef: string, commit: string, agentId: string) {
  const review = store.createTicket(slug, {
    title,
    category: 'review-audit',
    files: [`lib/${title.replace(/\W+/g, '-')}.js`],
    executorVerify: 'manual: read the candidate',
  }, { ref: sourceRef, commit });
  const sessionId = `gate-review-session-${agentId}`;
  const prepared = store.prepareDispatch(slug, review.ref, { sessionId });
  const executor = prepared.ticket.dispatchExecutor;
  const worktree = path.join(SIDEQUEST_HOME, 'gate-review-worktrees', agentId);
  assert.strictEqual(store.recordDispatchLaunch(slug, review.ref, {
    token: prepared.token,
    executor,
    sessionId,
    agentName: agentId,
  }).ok, true);
  assert.strictEqual(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);

  // The delivered race: the native agent starts before its worktree exists.
  const raced = store.bindDispatchAgent(sessionId, executor, agentId, agentId, PROJECT_DIR);
  assert.strictEqual(raced.ok, false);
  assert.strictEqual(raced.reason, 'worktree_binding_unavailable');

  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  execFileSync('git', ['worktree', 'add', '--detach', worktree], { cwd: PROJECT_DIR, windowsHide: true });
  const gitDirectoryValue = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: worktree, encoding: 'utf8', windowsHide: true }).trim();
  worktreeLease.createCheckoutInstanceMarker(path.isAbsolute(gitDirectoryValue) ? gitDirectoryValue : path.resolve(worktree, gitDirectoryValue));
  assert.strictEqual(store.completeDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
  return { review, sessionId, executor, agentId, worktree };
}

export function completeIsolatedReview(review: { review: any; sessionId: string; executor: string; agentId: string; worktree: string }, bindThroughBoardCall: boolean) {
  if (bindThroughBoardCall) {
    execFileSync(process.execPath, [BIND_RUNTIME_IDENTITY], {
      input: JSON.stringify({
        session_id: review.sessionId,
        agent_id: review.agentId,
        agent_type: review.executor,
        cwd: review.worktree,
        tool_name: 'mcp__plugin_sidequest_board__done',
        tool_input: { ref: review.review.ref, by: review.agentId },
      }),
      encoding: 'utf8',
      env: { ...process.env, SIDEQUEST_HOME },
      windowsHide: true,
    });
  }
  const dispatched = store.getTicket(slug, review.review.ref);
  assert.strictEqual(store.claimTicket(slug, review.review.ref, `${review.agentId}-worker`, {
    token: dispatched.dispatchNonce,
    executor: review.executor,
  }).ok, true);
  const done = store.completeTicket(slug, review.review.ref, `${review.agentId}-worker`, { model: 'sonnet', effort: 'medium' });
  assert.strictEqual(done.ok, true, done.message);
  return (store.getTicket(slug, review.review.ref).dispatch.attempts || []).at(-1);
}

// SQ-137: the topic shards of the former submission.test.ts share this setup. Each shard runs in its
// own process, so each gets its own copy of every temp directory and env var made above.
