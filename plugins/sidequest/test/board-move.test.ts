import './_temp-cleanup.js';
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

// SQ-297: move whole boards between two SIDEQUEST_HOMEs.
const SOURCE = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-board-move-src-'));
const DEST = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-board-move-dst-'));
process.env.SIDEQUEST_HOME = SOURCE;
const store = require('../lib/store.js');
const db = require('../lib/db.js');
const { moveBoards } = require('../lib/board-move.js');
const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const { execFileSync } = require('child_process');
const commitScope = require('../lib/commit-scope.js');

// Same route override the integrate fixtures use, set before any move so the copied profile
// carries it into the destination.
const exploration = store.getCategory('codebase-exploration');
store.setCategory(Object.assign({}, exploration, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));

function git(args: string[], cwd: string) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

const MOVED_PATH = path.join(os.tmpdir(), 'sq-board-move-test', 'moved');
const STAYS_PATH = path.join(os.tmpdir(), 'sq-board-move-test', 'stays');
const BLOCKED_PATH = path.join(os.tmpdir(), 'sq-board-move-test', 'blocked');

function runCli(home: string, args: string[], cwd: string) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: fs.existsSync(cwd) ? cwd : undefined,
    env: Object.assign({}, process.env, { SIDEQUEST_HOME: home, CLAUDE_PROJECT_DIR: cwd }),
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function setTicketData(slug: string, ref: string, patch: Record<string, unknown>, claimBy: string | null = null) {
  const handle = db.openDb(SOURCE);
  try {
    const row: any = handle.prepare('SELECT id, data FROM tickets WHERE project = ? AND ref = ?').get(slug, ref);
    const data = Object.assign(JSON.parse(row.data), patch);
    handle.prepare('UPDATE tickets SET data = ?, claim_by = ? WHERE id = ?').run(JSON.stringify(data), claimBy, row.id);
  } finally {
    handle.close();
  }
}

const moved = store.ensureProject(MOVED_PATH, 'Moved Board');
const stays = store.ensureProject(STAYS_PATH, 'Stays Board');
const blocked = store.ensureProject(BLOCKED_PATH, 'Blocked Board');
const open = store.createTicket(moved.slug, { title: 'open ticket' });
const released = store.createTicket(moved.slug, { title: 'released ticket' });
const submitted = store.createTicket(moved.slug, { title: 'submitted ticket' });
const finished = store.createTicket(moved.slug, { title: 'done ticket' });
store.updateTicket(moved.slug, finished.ref, { status: 'done' });
store.addComment(moved.slug, open.ref, { by: 'tester', body: 'a comment that must travel' });
const assetDir = path.join(SOURCE, 'projects', moved.slug, 'assets');
fs.mkdirSync(assetDir, { recursive: true });
const assetFile = path.join(assetDir, 'shot.png');
fs.writeFileSync(assetFile, 'png-bytes');
setTicketData(moved.slug, released.ref, { claimHistory: [{ by: 'old-exec', releasedAt: '2026-10-01T00:00:00Z' }], images: [assetFile] });
setTicketData(moved.slug, submitted.ref, { submission: { commit: 'abc1234', by: 'exec-2', worktree: '/tmp/wt' }, status: 'doing' });
store.createTicket(stays.slug, { title: 'stays behind' });
const claimed = store.createTicket(blocked.slug, { title: 'claimed ticket' });
setTicketData(blocked.slug, claimed.ref, { claim: { by: 'exec-live', at: '2026-10-25T00:00:00Z' } }, 'exec-live');

test('dry run lists exactly what moves and changes nothing', async () => {
  const res = await moveBoards({ sourceHome: SOURCE, destHome: DEST, boards: ['Moved Board'], dryRun: true });
  assert.strictEqual(res.ok, true, res.refused);
  assert.strictEqual(res.boards.length, 1, "the result carries one plan for the named board");
  const plan = res.boards[0];
  assert.strictEqual(plan.slug, moved.slug);
  assert.strictEqual(plan.rows.tickets, 4);
  assert.strictEqual(plan.files.count, 1);
  assert.deepStrictEqual(plan.files.list, ['assets/shot.png']);
  assert.ok(plan.rewrittenPaths >= 1, 'the asset path inside the ticket is planned for rewrite');
  assert.strictEqual(fs.existsSync(path.join(DEST, 'sidequest.db')), false, 'a dry run never creates the destination');
  assert.ok(store.readMeta(moved.slug), 'source still holds the board');
});

test('a live claim refuses the move and names the claim', async () => {
  const res = await moveBoards({ sourceHome: SOURCE, destHome: DEST, boards: [blocked.slug] });
  assert.strictEqual(res.ok, false);
  assert.match(res.refused, new RegExp(`${claimed.ref} is claimed by "exec-live"`));
  const cli = runCli(SOURCE, ['move-board', blocked.slug, '--to-home', DEST], BLOCKED_PATH);
  assert.notStrictEqual(cli.status, 0);
  assert.match(cli.stderr + cli.stdout, new RegExp(`claim ${claimed.ref}`));
  assert.ok(store.readMeta(blocked.slug), 'refused board stays in the source');
});

test('move carries tickets, comments, files and state; source no longer lists it', async () => {
  const dry = await moveBoards({ sourceHome: SOURCE, destHome: DEST, boards: [moved.slug], dryRun: true });
  const res = await moveBoards({ sourceHome: SOURCE, destHome: DEST, boards: [moved.slug] });
  assert.strictEqual(res.ok, true, res.refused);
  assert.strictEqual(res.boards.length, 1, "the result carries one plan for the named board");
  const plan = res.boards[0];
  assert.deepStrictEqual(plan.verified, dry.boards[0].rows, 'verified destination counts equal the dry-run plan');
  assert.deepStrictEqual(plan.files.list, dry.boards[0].files.list);

  const destAsset = path.join(DEST, 'projects', moved.slug, 'assets', 'shot.png');
  assert.strictEqual(fs.readFileSync(destAsset, 'utf8'), 'png-bytes');
  assert.strictEqual(fs.existsSync(path.join(SOURCE, 'projects', moved.slug)), false);

  const srcProjects = JSON.parse(runCli(SOURCE, ['projects', '--json'], STAYS_PATH).stdout);
  const srcSlugs = (srcProjects.projects || srcProjects).map((p: any) => p.slug);
  assert.ok(!srcSlugs.includes(moved.slug), 'source no longer lists the moved board');
  assert.ok(srcSlugs.includes(stays.slug));

  const destProjects = JSON.parse(runCli(DEST, ['projects', '--json'], MOVED_PATH).stdout);
  assert.deepStrictEqual((destProjects.projects || destProjects).map((p: any) => p.slug), [moved.slug]);

  const list = runCli(DEST, ['list', '--json'], MOVED_PATH);
  assert.strictEqual(list.status, 0, list.stderr);
  const refs = JSON.stringify(JSON.parse(list.stdout));
  for (const ticket of [open, released, submitted]) assert.ok(refs.includes(ticket.ref), `${ticket.ref} listed from the destination`);

  const comments = runCli(DEST, ['comments', open.ref, '--json'], MOVED_PATH);
  assert.strictEqual(comments.status, 0, comments.stderr);
  assert.match(comments.stdout, /a comment that must travel/);

  const pulse = runCli(DEST, ['pulse', submitted.ref, '--json'], MOVED_PATH);
  assert.strictEqual(pulse.status, 0, pulse.stderr);

  const handle = db.openDb(DEST);
  try {
    const rel: any = JSON.parse((handle.prepare('SELECT data FROM tickets WHERE ref = ? AND project = ?').get(released.ref, moved.slug) as any).data);
    assert.deepStrictEqual(rel.images, [destAsset], 'asset path rewritten to the destination home');
    assert.strictEqual(rel.claimHistory[0].by, 'old-exec');
    const sub: any = JSON.parse((handle.prepare('SELECT data FROM tickets WHERE ref = ? AND project = ?').get(submitted.ref, moved.slug) as any).data);
    assert.strictEqual(sub.submission.commit, 'abc1234', 'parked submission travels intact');
    assert.ok(handle.prepare("SELECT 1 FROM routing_profiles WHERE id = 'coding'").get(), 'assigned routing profile copied');
  } finally {
    handle.close();
  }
  const srcHandle = db.openDb(SOURCE);
  try {
    assert.ok(srcHandle.prepare("SELECT 1 FROM routing_profiles WHERE id = 'coding'").get(), 'shared profile stays in the source');
    assert.strictEqual(Number((srcHandle.prepare('SELECT COUNT(*) AS n FROM tickets WHERE project = ?').get(moved.slug) as any).n), 0);
  } finally {
    srcHandle.close();
  }
});

test('a submission parked in the source integrates from the destination home after the move', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-board-move-repo-'));
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.name', 'Sidequest Test'], repo);
  git(['config', 'user.email', 'sidequest-test@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'move fixture\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/*\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'base'], repo);
  const executor = path.join(repo, '.claude', 'worktrees', 'agent-move1');
  git(['worktree', 'add', '-b', 'worktree-agent-move1', executor, 'main'], repo);
  fs.writeFileSync(path.join(executor, 'feature.txt'), 'executor work\n');
  git(['add', 'feature.txt'], executor);
  git(['commit', '-m', 'feature'], executor);
  const candidate = git(['rev-parse', 'HEAD'], executor);

  const { slug } = store.ensureProject(repo, 'Integrate Board');
  const ticket = store.createTicket(slug, {
    title: 'parked submission',
    category: 'codebase-exploration',
    description: 'A submission parked before the move, integrated after it.',
    files: ['feature.txt'],
  });
  const gitRef = `refs/sidequest/${ticket.ref}`;
  git(['update-ref', gitRef, candidate], executor);
  const target = store.integrationTarget(slug);
  const range = commitScope.submissionRange(executor, { commit: candidate, gitRef, upstream: target.upstream, integrationBranch: target.branch });
  assert.strictEqual(range.ok, true, JSON.stringify(range));
  assert.strictEqual(store.claimTicket(slug, ticket.ref, 'move-worker', { direct: true, reason: 'The move fixture requires a local direct claim.' }).ok, true);
  assert.strictEqual(store.submitTicket(slug, ticket.ref, 'move-worker', { commit: candidate, gitRef, range, worktree: executor }).ok, true);

  const res = await moveBoards({ sourceHome: SOURCE, destHome: DEST, boards: [repo] });
  assert.strictEqual(res.ok, true, res.refused);
  assert.strictEqual(res.boards.length, 1, "the result carries one plan for the moved board");
  assert.deepStrictEqual(res.boards[0].gitRefs, [gitRef], 'the refs/sidequest pointer is reported and stays valid');

  const result = runCli(DEST, ['integrate', ticket.ref, '--by', 'orchestrator', '--json'], repo);
  assert.strictEqual(result.status, 0, result.stderr + result.stdout);
  assert.strictEqual(JSON.parse(result.stdout).ok, true);
  assert.strictEqual(git(['show', 'main:feature.txt'], repo), 'executor work');
  const pulse = JSON.parse(runCli(DEST, ['pulse', ticket.ref, '--json'], repo).stdout);
  assert.strictEqual(JSON.stringify(pulse).includes('"done"'), true, 'integrated ticket is done in the destination');
});

test('new tickets on the moved board continue the ref sequence without collisions', () => {
  const res = runCli(DEST, ['add', '-t', 'after the move', '--unclassified', '--json'], MOVED_PATH);
  assert.strictEqual(res.status, 0, res.stderr);
  const added = JSON.parse(res.stdout);
  assert.strictEqual(added.project, moved.slug, 'the new ticket lands on the moved board');
  const ref = added.ticket.ref;
  const movedRefs = [open.ref, released.ref, submitted.ref, finished.ref];
  assert.ok(!movedRefs.includes(ref), `${ref} does not reuse a moved ref`);
  const number = (value: string) => Number(String(value).replace(/\D+/g, ''));
  assert.ok(number(ref) > Math.max(...movedRefs.map(number)), `${ref} continues after ${movedRefs.join(', ')}`);
  const listed = JSON.stringify(JSON.parse(runCli(DEST, ['list', '--json'], MOVED_PATH).stdout));
  for (const movedRef of movedRefs.slice(0, 3)) assert.ok(listed.includes(movedRef), `${movedRef} still listed beside ${ref}`);
});
