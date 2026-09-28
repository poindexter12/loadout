import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-checkpoint-test-'));
const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-checkpoint-project-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
process.env.SIDEQUEST_CLAIM_TTL_MIN = '60';

const store = require('../lib/store.js');
const mcp = require('../lib/mcp.js');
const { makeCliRunner } = require('./_helpers.js');

const { slug } = store.ensureProject(PROJECT_DIR);
const exploration = store.getCategory('codebase-exploration');
store.setCategory(Object.assign({}, exploration, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));
const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const { cliJson } = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJECT_DIR }, { cwd: PROJECT_DIR });
const COMMIT = 'abc1234def5678abc1234def5678abc1234def56';

function addRouted(title?: any) {
  return store.createTicket(slug, {
    title,
    description: 'Where: checkpoint lifecycle fixture. Contract: keep the routed executor live for review. Verify: inspect persisted board state.',
    category: 'codebase-exploration',
    files: ['lib/fixture.js'],
    source: 'cli',
  });
}

function addDirect(title?: any) {
  return store.createTicket(slug, {
    title,
    complexity: 2,
    complexityWhy: 'single checkpoint lifecycle fixture with no implementation work',
    labels: ['direct-ok'],
    files: ['lib/fixture.js'],
    source: 'cli',
  });
}

function claimRouted(ticket?: any, by?: any) {
  const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: false });
  const claimed = store.claimTicket(slug, ticket.ref, by, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    source: 'mcp',
  });
  assert.strictEqual(claimed.ok, true);
  return prepared;
}

function claimDirect(ticket?: any, by?: any) {
  const claimed = store.claimTicket(slug, ticket.ref, by, {
    direct: true,
    reason: 'The checkpoint lifecycle fixture needs a local direct claim.',
    source: 'cli',
  });
  assert.strictEqual(claimed.ok, true);
}

let requestId = 0;
async function callTool(name?: any, args?: any) {
  const response = await mcp.handleRequest({
    jsonrpc: '2.0',
    id: ++requestId,
    method: 'tools/call',
    params: { name, arguments: args || {} },
  });
  assert.ok(response && response.result);
  assert.ok(!response.result.isError, response.result.content && response.result.content[0] && response.result.content[0].text);
  return JSON.parse(response.result.content[0].text);
}

test('checkpoint creates and replaces a live review candidate without terminalizing its dispatch', () => {
  const ticket = addRouted('live checkpoint create');
  const prepared = claimRouted(ticket, 'worker-a');
  const first = store.checkpointTicket(slug, ticket.ref, 'worker-a', {
    commit: COMMIT.toUpperCase(),
    verify: 'npm test: 12 passed, 0 failed',
    ttlMinutes: 15,
    source: 'mcp',
  });

  assert.strictEqual(first.ok, true);
  assert.match(first.checkpoint.id, /^cp_[0-9a-f]{16}$/);
  assert.strictEqual(first.checkpoint.state, 'active');
  assert.strictEqual(first.checkpoint.commit, COMMIT);
  assert.match(first.comment.body, new RegExp(`Live review checkpoint ${first.checkpoint.id}`));

  const afterFirst = store.getTicket(slug, ticket.ref);
  assert.strictEqual(afterFirst.claim.by, 'worker-a');
  assert.strictEqual(afterFirst.dispatchNonce, prepared.token);
  assert.strictEqual(afterFirst.dispatch.terminalAt, null);
  assert.strictEqual(afterFirst.dispatch.outcome, 'claimed');
  assert.strictEqual(store.pulsePayload(slug, ticket.ref).checkpoint.id, first.checkpoint.id);

  const second = store.checkpointTicket(slug, ticket.ref, 'worker-a', {
    worktree: PROJECT_DIR,
    verify: 'npm test after corrections: 13 passed, 0 failed',
    source: 'mcp',
  });
  assert.strictEqual(second.ok, true);
  assert.notStrictEqual(second.checkpoint.id, first.checkpoint.id);
  assert.strictEqual(second.checkpoint.state, 'active');
  assert.strictEqual(store.getTicket(slug, ticket.ref).dispatch.terminalAt, null);

  const changes = store.changesPayload(slug, new Date(Date.parse(second.checkpoint.at) - 1).toISOString());
  const changed = changes.tickets.find((entry?: any) => entry.ref === ticket.ref);
  assert.strictEqual(changed.checkpoint.id, second.checkpoint.id);
  assert.strictEqual(changed.checkpoint.state, 'active');
});

test('checkpoint TTL is bounded and expiry is surfaced as a derived change', () => {
  const ticket = addDirect('checkpoint expiry');
  claimDirect(ticket, 'expiry-worker');
  assert.throws(() => store.checkpointTicket(slug, ticket.ref, 'expiry-worker', {
    commit: COMMIT,
    verify: 'passed',
    ttlMinutes: store.MAX_CHECKPOINT_TTL_MIN + 1,
  }), /checkpoint TTL/);

  const checkpointAt = Date.now() - 2 * 60 * 1000;
  const created = store.checkpointTicket(slug, ticket.ref, 'expiry-worker', {
    commit: COMMIT,
    verify: 'node --test: 1 passed, 0 failed',
    ttlMinutes: 1,
    now: checkpointAt,
  });
  assert.strictEqual(store.checkpointProjection(created.ticket, checkpointAt + 30_000).state, 'active');
  assert.strictEqual(store.checkpointProjection(store.getTicket(slug, ticket.ref)).state, 'expired');

  const changes = store.changesPayload(slug, new Date(checkpointAt + 30_000).toISOString());
  const expired = changes.tickets.find((entry?: any) => entry.ref === ticket.ref);
  assert.ok(expired);
  assert.strictEqual(expired.checkpoint.state, 'expired');
  assert.strictEqual(expired.checkpoint.expiresAt, created.checkpoint.expiresAt);
  assert.ok(Date.parse(expired.updatedAt) < checkpointAt + 30_000);
});

test('release and redispatch preserve checkpoint evidence for recovery', () => {
  const ticket = addRouted('checkpoint recovery');
  claimRouted(ticket, 'worker-before-crash');
  const created = store.checkpointTicket(slug, ticket.ref, 'worker-before-crash', {
    worktree: PROJECT_DIR,
    verify: 'npm run test:full: passed',
    ttlMinutes: 30,
  });

  const released = store.releaseTicket(slug, ticket.ref, 'worker-before-crash', { status: 'todo', source: 'mcp' });
  assert.strictEqual(released.ok, true);
  let recoveredTicket = store.getTicket(slug, ticket.ref);
  assert.strictEqual(recoveredTicket.checkpoint.id, created.checkpoint.id);
  assert.strictEqual(store.checkpointProjection(recoveredTicket).state, 'recoverable');

  const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: false });
  const claimed = store.claimTicket(slug, ticket.ref, 'replacement-worker', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    source: 'mcp',
  });
  assert.strictEqual(claimed.ok, true);
  recoveredTicket = store.getTicket(slug, ticket.ref);
  assert.strictEqual(store.checkpointProjection(recoveredTicket).state, 'resumed');

  const briefing = store.readDispatchBriefing(slug, ticket.ref, prepared.token);
  assert.strictEqual(briefing.ok, true);
  assert.strictEqual(briefing.ticket.checkpoint.id, created.checkpoint.id);
  assert.ok(briefing.ticket.comments.some((comment?: any) => comment.body.includes(`Live review checkpoint ${created.checkpoint.id}`)));
});

test('submit remains terminal after a live review checkpoint', () => {
  const ticket = addRouted('checkpoint submit terminal');
  claimRouted(ticket, 'submit-worker');
  const checkpoint = store.checkpointTicket(slug, ticket.ref, 'submit-worker', {
    commit: COMMIT,
    verify: 'npm run test:full: passed',
  });
  assert.strictEqual(checkpoint.ok, true);
  assert.strictEqual(store.getTicket(slug, ticket.ref).dispatch.terminalAt, null);

  const submitted = store.submitTicket(slug, ticket.ref, 'submit-worker', { commit: COMMIT, verify: 'npm run test:full' });
  assert.strictEqual(submitted.ok, true);
  const after = store.getTicket(slug, ticket.ref);
  assert.strictEqual(after.claim, null);
  assert.strictEqual(after.dispatchNonce, null);
  assert.ok(after.dispatch.terminalAt);
  assert.strictEqual(after.dispatch.outcome, 'submitted');
  assert.strictEqual(store.checkpointProjection(after).state, 'submitted');
});

test('CLI and MCP expose the checkpoint operation and compact pulse state', async () => {
  const cliTicket = addDirect('CLI checkpoint');
  claimDirect(cliTicket, 'cli-worker');
  const cli = cliJson([
    'checkpoint', cliTicket.ref,
    '--project', PROJECT_DIR,
    '--by', 'cli-worker',
    '--worktree', PROJECT_DIR,
    '--verify', 'node --test: 2 passed, 0 failed',
    '--ttl-minutes', '10',
    '--json',
  ]);
  assert.strictEqual(cli.ok, true);
  assert.strictEqual(cli.checkpoint.state, 'active');
  assert.strictEqual(cli.checkpoint.ttlMinutes, 10);

  const mcpTicket = addDirect('MCP checkpoint');
  claimDirect(mcpTicket, 'mcp-worker');
  const result = await callTool('checkpoint', {
    ref: mcpTicket.ref,
    project: PROJECT_DIR,
    by: 'mcp-worker',
    commit: COMMIT,
    verify: 'node --test: 3 passed, 0 failed',
    ttlMinutes: 20,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.checkpoint.state, 'active');

  const pulse = await callTool('pulse', { ref: mcpTicket.ref, project: PROJECT_DIR });
  assert.strictEqual(pulse.checkpoint.id, result.checkpoint.id);
  assert.strictEqual(pulse.checkpoint.state, 'active');
});

// SQ-178: backups get one board-owned namespace, a reflog, a read surface, and
// pruning at done, instead of hand-made refs/sidequest/<REF>-preserve refs.
const backupRefs = require('../lib/backup-refs.js');
const { execFileSync } = require('node:child_process');

function gitIn(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function backupRepo(): { repo: string; commit: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-checkpoint-backup-repo-'));
  gitIn(repo, ['init', '-q']);
  gitIn(repo, ['config', 'user.email', 'fixture@example.invalid']);
  gitIn(repo, ['config', 'user.name', 'Fixture']);
  gitIn(repo, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'file.txt'), 'backup fixture\n');
  gitIn(repo, ['add', 'file.txt']);
  gitIn(repo, ['commit', '-q', '-m', 'fixture']);
  return { repo, commit: gitIn(repo, ['rev-parse', 'HEAD']) };
}

test('commit checkpoint pins a reflogged backup under refs/sidequest-backup and surfaces ad hoc refs', async () => {
  const { repo, commit } = backupRepo();
  const ticket = addDirect('Backup checkpoint');
  claimDirect(ticket, 'backup-worker');
  const result = await callTool('checkpoint', {
    ref: ticket.ref,
    project: PROJECT_DIR,
    by: 'backup-worker',
    commit: commit.slice(0, 12),
    worktree: repo,
    verify: 'git log -1: fixture commit present',
  });
  assert.strictEqual(result.ok, true);
  const backupRef = result.checkpoint.backupRef;
  assert.match(backupRef, new RegExp(`^refs/sidequest-backup/${ticket.ref}/\\d{8}T\\d{9}Z$`));
  assert.strictEqual(gitIn(repo, ['rev-parse', backupRef]), commit);
  // Board ref writes carry a reflog so every move is auditable.
  assert.match(gitIn(repo, ['reflog', 'show', '--format=%gs', backupRef]), new RegExp(`sidequest checkpoint ${ticket.ref}`));
  const stored = store.getTicket(slug, ticket.ref);
  assert.ok(stored.comments.some((comment?: any) => comment.body.includes(`Backup: ${backupRef}`)));

  // A second backup in the same millisecond never overwrites the first.
  const now = Date.parse('2026-09-28T10:15:00.123Z');
  const first = backupRefs.writeBackupRef(repo, ticket.ref, commit, { now });
  const second = backupRefs.writeBackupRef(repo, ticket.ref, commit, { now });
  assert.strictEqual(first.gitRef, `refs/sidequest-backup/${ticket.ref}/20260928T101500123Z`);
  assert.strictEqual(second.gitRef, `${first.gitRef}-1`);

  // An improvised ref in the candidate namespace is reported, board shapes are not.
  gitIn(repo, ['update-ref', `refs/sidequest/${ticket.ref}-preserve`, commit]);
  gitIn(repo, ['update-ref', `refs/sidequest/${ticket.ref}`, commit]);
  const surface = backupRefs.ticketRefSurface(repo, stored);
  assert.deepStrictEqual(surface.backupRefs.map((entry: any) => entry.gitRef).sort(), [backupRef, first.gitRef, second.gitRef].sort());
  assert.strictEqual(surface.backupRefs.find((entry: any) => entry.gitRef === first.gitRef).at, '2026-09-28T10:15:00.123Z');
  assert.deepStrictEqual(surface.unrecognizedRefs.map((entry: any) => entry.gitRef), [`refs/sidequest/${ticket.ref}-preserve`]);
  const board = backupRefs.boardRefSurface(repo);
  assert.deepStrictEqual(board.backupRefs, [{ ticket: ticket.ref, count: 3 }]);
  assert.deepStrictEqual(board.unrecognizedRefs, [`refs/sidequest/${ticket.ref}-preserve`]);

  // A checkpoint without a resolvable commit still records, and says why no backup exists.
  const noRepo = await callTool('checkpoint', {
    ref: ticket.ref, project: PROJECT_DIR, by: 'backup-worker', commit: COMMIT, verify: 'fixture',
  });
  assert.strictEqual(noRepo.ok, true);
  assert.strictEqual(noRepo.checkpoint.backupRef, undefined);
  assert.match(noRepo.checkpoint.backupError, /^missing_commit/);
});

test('pruning removes only done tickets\' backups and list/pulse surface the rest', async () => {
  const { repo, commit } = backupRepo();
  const repoProject = store.ensureProject(repo);
  const live = store.createTicket(repoProject.slug, {
    title: 'Live backup', complexity: 2, complexityWhy: 'backup prune fixture', labels: ['direct-ok'], files: ['file.txt'], source: 'cli',
  });
  const finished = store.createTicket(repoProject.slug, {
    title: 'Done backup', complexity: 2, complexityWhy: 'backup prune fixture', labels: ['direct-ok'], files: ['file.txt'], source: 'cli',
  });
  const liveBackup = backupRefs.writeBackupRef(repo, live.ref, commit);
  const doneBackup = backupRefs.writeBackupRef(repo, finished.ref, commit);
  assert.strictEqual(liveBackup.ok, true);
  assert.strictEqual(doneBackup.ok, true);

  const pulse = await callTool('pulse', { ref: live.ref, project: repo });
  assert.deepStrictEqual(pulse.backupRefs.map((entry: any) => entry.gitRef), [liveBackup.gitRef]);
  const listed = await callTool('list', { project: repo, all: true });
  assert.deepStrictEqual(listed.backupRefs.map((entry: any) => entry.ticket).sort(), [finished.ref, live.ref].sort());
  const single = await callTool('list', { project: repo, ref: finished.ref });
  assert.deepStrictEqual(single.backupRefs.map((entry: any) => entry.gitRef), [doneBackup.gitRef]);

  const pruned = backupRefs.pruneBackupRefs(repo, (ref: string) => ref === finished.ref);
  assert.deepStrictEqual(pruned.pruned, [doneBackup.gitRef]);
  assert.deepStrictEqual(backupRefs.listBackupRefs(repo).backups.map((entry: any) => entry.gitRef), [liveBackup.gitRef]);
  const after = await callTool('pulse', { ref: finished.ref, project: repo });
  assert.strictEqual(after.backupRefs, undefined);

  // The done closure prunes board-wide: groom-closing the live ticket removes its backup.
  const closed = await callTool('groomClose', { ref: live.ref, project: repo, by: 'orchestrator', reason: 'backup prune fixture closes without delivery' });
  assert.strictEqual(closed.ok, true, JSON.stringify(closed));
  assert.deepStrictEqual(closed.backupRefsPruned, [liveBackup.gitRef]);
  assert.deepStrictEqual(backupRefs.listBackupRefs(repo).backups, []);
});
