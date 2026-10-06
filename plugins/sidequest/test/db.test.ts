import './_temp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';

import type { ChangeCount, SidequestDatabase, TableName } from '../src/lib/db.js';
import type { LockHoldRecord, LockTraceRecord, LockTraceSummary, LockWaitRecord } from '../src/lib/lock-trace.js';

interface TicketData {
  id: string;
  project: string;
  status: string;
  title: string;
}

interface TicketDatabaseRow {
  id: string;
  project: string;
  ref: string;
  status: string;
  archived: number;
  ord: number;
  claim_by: null;
  data: TicketData;
}

const databaseApi = require('../lib/db.js') as {
  openDb(homeRoot: string): SidequestDatabase;
  getRow<T = unknown>(database: DatabaseSync, table: TableName, key: unknown): T | null;
  putRow(database: DatabaseSync, table: TableName, row: unknown): ChangeCount;
  deleteRow(database: DatabaseSync, table: TableName, key: unknown): boolean;
  listRows<T = unknown>(database: DatabaseSync, table: TableName, where?: Record<string, SQLInputValue>): T[];
  listRowsPage<T = unknown>(database: DatabaseSync, table: TableName, where: Record<string, SQLInputValue> | undefined, options: { limit: number; offset?: number }): T[];
  countRows(database: DatabaseSync, table: TableName, where?: Record<string, SQLInputValue>): number;
  selectRows<T>(database: DatabaseSync, sql: string, parameters?: readonly SQLInputValue[]): T[];
  prepareCached(database: DatabaseSync, sql: string): StatementSync;
  txn<T>(database: DatabaseSync, fn: () => T): T;
  SQLITE_BUSY_TIMEOUT_MS: number;
  SQLITE_BUSY_POLICY_KEY: symbol;
  CURRENT_SCHEMA_VERSION: number;
};

const { openDb, getRow, putRow, deleteRow, listRows, listRowsPage, countRows, selectRows, prepareCached, txn, SQLITE_BUSY_TIMEOUT_MS, SQLITE_BUSY_POLICY_KEY, CURRENT_SCHEMA_VERSION } = databaseApi;
const pluginRoot = path.join(__dirname, '..');

function makeDb(): { db: SidequestDatabase; homeRoot: string } {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-db-test-'));
  const db = openDb(homeRoot);
  return { db, homeRoot };
}

function holdWriteLock(homeRoot: string, durationMs: number): Promise<ReturnType<typeof spawn>> {
  const databasePath = path.join(homeRoot, 'sidequest.db');
  const childProcess = spawn(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(${JSON.stringify(databasePath)});
    database.exec('BEGIN IMMEDIATE');
    process.stdout.write('locked');
    setTimeout(() => {
      database.exec('COMMIT');
      database.close();
    }, ${durationMs});
  `], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return new Promise((resolve, reject) => {
    childProcess.once('error', reject);
    childProcess.stdout.once('data', () => resolve(childProcess));
    childProcess.stderr.once('data', (data) => reject(new Error(String(data))));
  });
}

function waitForProcessExit(childProcess: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    childProcess.once('error', reject);
    childProcess.once('close', (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`write lock process exited with ${code}`));
    });
  });
}

function ticket(id: string, project: string, status: string, ord: number): TicketDatabaseRow {
  return {
    id,
    project,
    ref: `SQ-${id}`,
    status,
    archived: 0,
    ord,
    claim_by: null,
    data: { id, project, status, title: `${status} ticket` },
  };
}

test('schema v7 stores project category provenance by project and id', () => {
  const { db } = makeDb();
  putRow(db, 'projects', { slug: 'one', data: { slug: 'one' } });
  putRow(db, 'projects', { slug: 'two', data: { slug: 'two' } });
  putRow(db, 'project_categories', { project: 'one', id: 'local', kind: 'ADD', base_profile_id: null, base_data: null, data: { id: 'local' } });
  putRow(db, 'project_categories', { project: 'two', id: 'local', kind: 'OVERRIDE', base_profile_id: 'coding', base_data: { id: 'local', name: 'Base' }, data: { name: 'Other' } });

  assert.deepStrictEqual(getRow(db, 'project_categories', { project: 'one', id: 'local' }), { id: 'local' });
  assert.deepStrictEqual(listRows(db, 'project_categories', { project: 'two' }), [{ name: 'Other' }]);
  const provenance = db.prepare('SELECT base_profile_id, base_data FROM project_categories WHERE project = ? AND id = ?').get('two', 'local');
  assert.equal(provenance?.base_profile_id, 'coding');
  assert.deepEqual(JSON.parse(String(provenance?.base_data)), { id: 'local', name: 'Base' });
  assert.strictEqual(deleteRow(db, 'project_categories', { project: 'one', id: 'local' }), true);
  assert.strictEqual(getRow(db, 'project_categories', { project: 'one', id: 'local' }), null);
  db.close();
});

test('putRow and getRow round-trip ticket data', () => {
  const { db } = makeDb();
  const row = ticket('tk_1', 'loadout', 'todo', 1);

  putRow(db, 'tickets', row);

  assert.deepStrictEqual(getRow(db, 'tickets', 'tk_1'), row.data);
  db.close();
});

test('listRows filters ticket data by project and status', () => {
  const { db } = makeDb();
  const expected = ticket('tk_1', 'loadout', 'todo', 1);
  putRow(db, 'tickets', expected);
  putRow(db, 'tickets', ticket('tk_2', 'loadout', 'doing', 2));
  putRow(db, 'tickets', ticket('tk_3', 'other', 'todo', 3));

  assert.deepStrictEqual(listRows(db, 'tickets', { project: 'loadout', status: 'todo' }), [expected.data]);
  db.close();
});

test('targeted row helpers cache statements, count filters, page in order, and project compact columns', () => {
  const { db } = makeDb();
  putRow(db, 'tickets', ticket('tk_1', 'loadout', 'todo', 2));
  putRow(db, 'tickets', ticket('tk_2', 'loadout', 'todo', 1));
  putRow(db, 'tickets', ticket('tk_3', 'other', 'todo', 3));

  assert.strictEqual(prepareCached(db, 'SELECT id FROM tickets'), prepareCached(db, 'SELECT id FROM tickets'));
  assert.strictEqual(countRows(db, 'tickets', { project: 'loadout', status: 'todo' }), 2);
  assert.deepStrictEqual(listRowsPage<TicketData>(db, 'tickets', { project: 'loadout' }, { limit: 1 }), [ticket('tk_2', 'loadout', 'todo', 1).data]);
  const compactRows = selectRows<{ id: string; project: string }>(
    db,
    'SELECT id, project FROM tickets WHERE project = ? ORDER BY ord',
    ['loadout'],
  );
  assert.deepStrictEqual(
    compactRows.map((row) => ({ ...row })),
    [{ id: 'tk_2', project: 'loadout' }, { id: 'tk_1', project: 'loadout' }],
  );
  db.close();
});

test('deleteRow removes a row', () => {
  const { db } = makeDb();
  putRow(db, 'tickets', ticket('tk_1', 'loadout', 'todo', 1));

  assert.strictEqual(deleteRow(db, 'tickets', 'tk_1'), true);
  assert.strictEqual(getRow(db, 'tickets', 'tk_1'), null);
  db.close();
});

test('txn rolls back when its callback throws', () => {
  const { db } = makeDb();

  assert.throws(() => txn(db, () => {
    putRow(db, 'tickets', ticket('tk_1', 'loadout', 'todo', 1));
    throw new Error('stop');
  }), /stop/);

  assert.strictEqual(getRow(db, 'tickets', 'tk_1'), null);
  db.close();
});

test('txn refuses Promise-returning callbacks and rolls back their synchronous writes', () => {
  const { db } = makeDb();

  assert.throws(() => txn(db, async () => {
    putRow(db, 'tickets', ticket('tk_1', 'loadout', 'todo', 1));
  }), /must be synchronous/);

  assert.strictEqual(getRow(db, 'tickets', 'tk_1'), null);
  db.close();
});

test('openDb enables WAL and configures a busy timeout', () => {
  const { db } = makeDb();

  assert.strictEqual(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
  assert.strictEqual(db.prepare('PRAGMA busy_timeout').get()?.timeout, SQLITE_BUSY_TIMEOUT_MS);
  db.close();
});

test('txn waits for a concurrent writer to release its lock', async () => {
  const { db, homeRoot } = makeDb();
  const childProcess = await holdWriteLock(homeRoot, 250);
  const startedAt = Date.now();

  txn(db, () => putRow(db, 'globals', { key: 'after-lock', data: {} }));

  assert.ok(Date.now() - startedAt >= 200, 'transaction must wait for the active writer');
  await waitForProcessExit(childProcess);
  db.close();
});

test('txn retries a busy mutation after the lock timeout expires', async () => {
  const { db, homeRoot } = makeDb();
  db.exec('PRAGMA busy_timeout=50');
  const childProcess = await holdWriteLock(homeRoot, 250);

  txn(db, () => putRow(db, 'globals', { key: 'after-retry', data: {} }));

  assert.deepStrictEqual(getRow(db, 'globals', 'after-retry'), {});
  await waitForProcessExit(childProcess);
  db.close();
});

test('txn retries a busy mutation raised by its callback', () => {
  const { db } = makeDb();
  let attempts = 0;

  assert.strictEqual(txn(db, () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    return 'committed';
  }), 'committed');
  assert.strictEqual(attempts, 2);
  db.close();
});

test('txn does not retry genuine constraint errors', () => {
  const { db } = makeDb();
  const startedAt = Date.now();

  assert.throws(() => txn(db, () => {
    db.prepare('INSERT INTO projects (slug, data) VALUES (?, ?)').run('duplicate', '{}');
    db.prepare('INSERT INTO projects (slug, data) VALUES (?, ?)').run('duplicate', '{}');
  }), /UNIQUE constraint failed: projects\.slug/);
  assert.ok(Date.now() - startedAt < 500, 'constraint errors must fail immediately');
  db.close();
});

test('txn reports a timed-out SQLite lock with retry diagnostics', async () => {
  const { db, homeRoot } = makeDb();
  const childProcess = await holdWriteLock(homeRoot, SQLITE_BUSY_TIMEOUT_MS * 4);

  try {
    assert.throws(
      () => txn(db, () => putRow(db, 'globals', { key: 'blocked', data: {} })),
      /Sidequest database stayed locked while writing transaction.*after 3 attempts.*SQLite does not expose the locking process or claim identity/i,
    );
  } finally {
    childProcess.kill();
    await waitForProcessExit(childProcess);
    db.close();
  }
});

// SQ-125: a hook shares the machine-global board with every writer, and Claude Code kills it at 10s. Any write
// statement (even an INSERT OR IGNORE that changes nothing) takes SQLite's write lock, so a held writer is the
// probe: a store open that issues no write statement completes under it, one that writes blocks.
function childBusyPolicy(timeoutMs: number): string {
  return `Reflect.set(globalThis, Symbol.for('sidequest.sqlite-busy-policy'), {
    label: 'test', timeoutMs: ${timeoutMs}, attempts: 1,
    onExhausted: (error) => { process.stderr.write(error.message); process.exit(7); },
  });`;
}

test('openDb on a current schema issues no write statement, so it opens under a held write lock (SQ-125)', async () => {
  const { db: first, homeRoot } = makeDb();
  first.close();
  const childProcess = await holdWriteLock(homeRoot, 30_000);
  const exhausted: Error[] = [];
  Reflect.set(globalThis, SQLITE_BUSY_POLICY_KEY, { label: 'test', timeoutMs: 100, attempts: 1, onExhausted: (error: Error) => exhausted.push(error) });
  let reopened: SidequestDatabase | undefined;
  try {
    const startedAt = Date.now();
    reopened = openDb(homeRoot);
    assert.ok(Date.now() - startedAt < 1_000, 'a no-op open must not wait on the held writer');
    assert.strictEqual(exhausted.length, 0, 'a no-op open must never exhaust the lock budget');
    assert.strictEqual(reopened.prepare('PRAGMA busy_timeout').get()?.timeout, 100, 'openDb applies the installed lock budget');
    assert.deepStrictEqual(listRows(reopened, 'tickets'), []);

    // The same held lock does refuse a real write: one short attempt, then the policy's exhaustion hook.
    const writer = reopened;
    assert.throws(
      () => txn(writer, () => putRow(writer, 'globals', { key: 'blocked', data: {} })),
      /stayed locked while writing transaction.*after 1 attempt, each waiting up to 100ms \(test lock budget\)/,
    );
    assert.strictEqual(exhausted.length, 1, 'the exhaustion hook runs once, before the busy error is thrown');
  } finally {
    Reflect.deleteProperty(globalThis, SQLITE_BUSY_POLICY_KEY);
    childProcess.kill();
    await waitForProcessExit(childProcess);
    reopened?.close();
  }
});

test('opening the store on an initialized home completes read-only under a held write lock (SQ-125)', async () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-db-test-'));
  const env = { ...process.env, SIDEQUEST_HOME: homeRoot };
  const openStore = `
    const store = require(${JSON.stringify(path.join(pluginRoot, 'lib', 'store.js'))});
    store.listProjects({ all: true });
    process.stdout.write('opened');
  `;
  const seeded = spawnSync(process.execPath, ['-e', openStore], { env, encoding: 'utf8', timeout: 30_000 });
  assert.strictEqual(seeded.status, 0, seeded.stderr);
  const seededDb = openDb(homeRoot);
  const entries = selectRows<{ entries: number }>(seededDb, 'SELECT COUNT(*) AS entries FROM routing_profile_entries')[0]?.entries ?? 0;
  seededDb.close();
  assert.ok(entries > 0, 'the first store open seeds this home, so the reopen below exercises the seed refresh as a no-op');

  const childProcess = await holdWriteLock(homeRoot, 30_000);
  try {
    const startedAt = Date.now();
    const reopened = spawnSync(process.execPath, ['-e', `${childBusyPolicy(200)}\n${openStore}`], { env, encoding: 'utf8', timeout: 15_000 });
    const elapsedMs = Date.now() - startedAt;
    assert.strictEqual(reopened.status, 0, `store open wrote under the held lock: ${reopened.stderr}`);
    assert.strictEqual(reopened.stdout, 'opened');
    assert.ok(elapsedMs < 5_000, `store open took ${elapsedMs}ms under the held lock`);
  } finally {
    childProcess.kill();
    await waitForProcessExit(childProcess);
  }
});

test('the hook lock budget fails open inside 3s when a hook must write under a held lock (SQ-125)', async () => {
  const { db: first, homeRoot } = makeDb();
  first.close();
  const childProcess = await holdWriteLock(homeRoot, 30_000);
  try {
    const hookWrite = `
      require('./src/hooks/shared/sqlite-budget.ts');
      const startedAt = Date.now();
      process.on('exit', () => process.stderr.write('\\nelapsed=' + (Date.now() - startedAt)));
      const db = require('./lib/db.js');
      const handle = db.openDb(${JSON.stringify(homeRoot)});
      db.txn(handle, () => db.putRow(handle, 'globals', { key: 'hook-write', data: {} }));
      process.stdout.write('wrote');
    `;
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', hookWrite], { cwd: pluginRoot, encoding: 'utf8', timeout: 15_000 });
    const processMs = Date.now() - startedAt;
    assert.strictEqual(result.status, 0, `a busy hook must allow (exit 0): ${result.stderr}`);
    assert.strictEqual(result.stdout, '', 'the hook stops at the busy write');
    assert.match(result.stderr, /allowed this event without its board check \(fail-open, board lock busy\): .*after 1 attempt, each waiting up to 1500ms \(hook lock budget\)/);
    const budgetMs = Number(/elapsed=(\d+)/.exec(result.stderr)?.[1]);
    assert.ok(budgetMs >= 1_000 && budgetMs < 3_000, `the busy wait took ${budgetMs}ms; the hook budget is one 1.5s wait`);
    assert.ok(processMs < 10_000, `the whole hook process took ${processMs}ms, past Claude Code's 10s hook timeout`);
  } finally {
    childProcess.kill();
    await waitForProcessExit(childProcess);
  }
});

test('every hook registered with a 10s timeout installs the hook lock budget, and WorktreeCreate keeps the server budget (SQ-125)', () => {
  type HookEntry = { command: string; timeout?: number };
  const registered = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8')) as { hooks: Record<string, { hooks: HookEntry[] }[]> };
  const budgeted = new Set<string>();
  const exempt = new Set<string>();
  for (const groups of Object.values(registered.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        const name = /hooks\/([\w-]+)\.js/.exec(hook.command)?.[1];
        if (!name) continue;
        assert.ok(typeof hook.timeout === 'number', `${name} must declare a timeout`);
        (hook.timeout <= 10 ? budgeted : exempt).add(name);
      }
    }
  }
  const bundle = (name: string) => fs.readFileSync(path.join(pluginRoot, 'hooks', `${name}.js`), 'utf8');
  assert.ok(budgeted.size >= 20, `expected the 10s hooks, found ${budgeted.size}`);
  for (const name of budgeted) assert.match(bundle(name), /fail-open, board lock busy/, `${name} must install the hook lock budget`);
  assert.deepStrictEqual([...exempt], ['worktree-create']);
  assert.doesNotMatch(bundle('worktree-create'), /sidequest\.sqlite-busy-policy/);
  // SQ-133: exactly the security guards switch the budget to fail closed at load; every other hook, including
  // guard-home-delete, keeps failing open.
  const failClosed = [...budgeted].filter((name) => /^failClosedOnBoardBusy\(\);$/m.test(bundle(name))).sort();
  assert.deepStrictEqual(failClosed, ['force-exec-bypass', 'guard-destructive-git', 'guard-shared-checkout-git', 'guard-worktree-isolation']);
  for (const name of failClosed) assert.match(bundle(name), /fail-closed, board lock busy/, `${name} must carry the fail-closed refusal`);
  assert.ok(budgeted.has('guard-home-delete'));
  assert.doesNotMatch(bundle('guard-home-delete'), /fail-closed/, 'guard-home-delete stays fail-open');
});

test('a long-lived store handle re-flags a read-only seed another connection stores unflagged after open (SQ-133)', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-db-test-'));
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const store = require(${JSON.stringify(path.join(pluginRoot, 'lib', 'store.js'))});
    store.listProjects({ all: true });
    const { DEFAULT_CATEGORIES } = require(${JSON.stringify(path.join(pluginRoot, 'lib', 'category-defaults.js'))});
    const readonlySeeds = new Set(DEFAULT_CATEGORIES.filter((category) => category.readonly === true).map((category) => category.id));
    const other = new DatabaseSync(${JSON.stringify(path.join(homeRoot, 'sidequest.db'))});
    const row = other.prepare('SELECT profile_id, category_id, data FROM routing_profile_entries').all()
      .find((entry) => readonlySeeds.has(entry.category_id) && JSON.parse(entry.data).readonly === true);
    if (!row) throw new Error('the seeded home has no read-only routing entry to unflag');
    const category = JSON.parse(row.data);
    delete category.readonly;
    other.prepare('UPDATE routing_profile_entries SET data = ? WHERE profile_id = ? AND category_id = ?')
      .run(JSON.stringify(category), row.profile_id, row.category_id);
    store.listProjects({ all: true });
    const after = JSON.parse(other.prepare('SELECT data FROM routing_profile_entries WHERE profile_id = ? AND category_id = ?')
      .get(row.profile_id, row.category_id).data);
    other.close();
    process.stdout.write(JSON.stringify({ category: row.category_id, readonly: after.readonly === true }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, SIDEQUEST_HOME: homeRoot }, encoding: 'utf8', timeout: 30_000 });
  assert.strictEqual(result.status, 0, result.stderr);
  const outcome = JSON.parse(result.stdout) as { category: string; readonly: boolean };
  assert.strictEqual(outcome.readonly, true, `${outcome.category} stayed unflagged: the open handle never rechecked the seeds after another connection's commit`);
});

// SQ-133: an edit to the schema script that ships without a CURRENT_SCHEMA_VERSION bump never reaches an existing
// board, because openDb only runs upgradeSchema when the stored version is behind. Pin the script to the version.
const UPGRADE_SCHEMA_SHA256: Record<number, string> = {
  8: 'aef1dea45fdba795fce06057977fbfc87ef4da5f8dca7a8817a59a89558602b5',
};

function upgradeSchemaFingerprint(): string {
  const source = fs.readFileSync(path.join(pluginRoot, 'src', 'lib', 'db.ts'), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('\nfunction upgradeSchema(');
  assert.ok(start >= 0, 'upgradeSchema() was not found in src/lib/db.ts');
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'the end of upgradeSchema() was not found in src/lib/db.ts');
  const normalized = source.slice(start + 1, end + 2)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|--)/.test(line))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

test('the upgradeSchema script is pinned to CURRENT_SCHEMA_VERSION (SQ-133)', () => {
  const actual = upgradeSchemaFingerprint();
  const pinned = UPGRADE_SCHEMA_SHA256[CURRENT_SCHEMA_VERSION];
  assert.ok(pinned, `no upgradeSchema hash is pinned for schema version ${CURRENT_SCHEMA_VERSION}. After adding that version's migration step, pin UPGRADE_SCHEMA_SHA256[${CURRENT_SCHEMA_VERSION}] = '${actual}' in test/db.test.ts.`);
  assert.strictEqual(actual, pinned, [
    `upgradeSchema in src/lib/db.ts changed without a schema version bump (CURRENT_SCHEMA_VERSION is still ${CURRENT_SCHEMA_VERSION}).`,
    'An existing board at that version never reruns upgradeSchema, so the edit would not reach it.',
    `Bump CURRENT_SCHEMA_VERSION to ${CURRENT_SCHEMA_VERSION + 1}, add a migration step that brings version ${CURRENT_SCHEMA_VERSION} boards forward, then pin UPGRADE_SCHEMA_SHA256[${CURRENT_SCHEMA_VERSION + 1}] = '${actual}'.`,
    `Re-pin version ${CURRENT_SCHEMA_VERSION} instead only when the edit cannot change any database it runs on (comments and whitespace are already ignored).`,
  ].join('\n'));
});

test('requiring db.js emits no SQLite ExperimentalWarning', () => {
  const dbPath = path.join(__dirname, '..', 'lib', 'db.js');
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(dbPath)})`], { encoding: 'utf8' });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /ExperimentalWarning/);
  assert.doesNotMatch(result.stderr, /ExperimentalWarning/);
});

// --- Write-lock contention tracing (SQ-262) ------------------------------------------------------
//
// The board DB is one file shared by every project and SQLite's write lock is file-granular, so US-4
// has to decide whether to split it per project. These tests pin the measurement that decision rests
// on: that it is off by default, that it separates waiting from holding, that nesting is visible rather
// than double-counted, and above all that a spent hook lock budget is recorded durably before the
// exhaustion hook (which may process.exit()) gets control.

const lockTraceApi = require('../lib/lock-trace.js') as {
  LOCK_TRACE_ENV: string;
  LOCK_TRACE_FILENAME: string;
  lockTraceEnabled(): boolean;
  lockTracePath(): string | null;
  defaultLockTracePath(env?: NodeJS.ProcessEnv): string;
  flushLockTrace(): void;
  resetLockTrace(): void;
  readLockTraceRecords(file: string): { records: LockTraceRecord[]; skipped: number };
  summarizeLockTrace(records: readonly LockTraceRecord[]): LockTraceSummary;
  formatLockTraceReport(summary: LockTraceSummary, options: { file: string; skipped?: number }): string;
};

function newTraceFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-lock-trace-')), 'trace.jsonl');
}

/**
 * Everything recorded so far, treating an absent file as "nothing was recorded". Tracing only creates
 * the file when it has something to append, so a test that asserts on records has to be able to fail on
 * the missing record rather than crash on the missing file. readLockTraceRecords itself keeps throwing,
 * which is what lets the report CLI tell a user there is no trace to read.
 */
function recordedIn(traceFile: string): LockTraceRecord[] {
  return fs.existsSync(traceFile) ? lockTraceApi.readLockTraceRecords(traceFile).records : [];
}

/** Run `work` with tracing pointed at `traceFile`, then hand back everything it recorded. */
function withLockTrace(traceFile: string, work: () => void): LockTraceRecord[] {
  process.env[lockTraceApi.LOCK_TRACE_ENV] = traceFile;
  lockTraceApi.resetLockTrace();
  try {
    work();
    lockTraceApi.flushLockTrace();
    return recordedIn(traceFile);
  } finally {
    delete process.env[lockTraceApi.LOCK_TRACE_ENV];
    lockTraceApi.resetLockTrace();
  }
}

const waitsFor = (records: readonly LockTraceRecord[], operation: string): LockWaitRecord[] =>
  records.filter((record): record is LockWaitRecord => record.kind === 'wait' && record.operation === operation);
const holdsIn = (records: readonly LockTraceRecord[]): LockHoldRecord[] =>
  records.filter((record): record is LockHoldRecord => record.kind === 'hold');

test('lock tracing is off unless its env var says otherwise, and writes nothing when off (SQ-262)', () => {
  const { db, homeRoot } = makeDb();
  const previous = process.env[lockTraceApi.LOCK_TRACE_ENV];
  // _sidequest-test-home.ts pins SIDEQUEST_HOME to a sandbox so no test can reach the real board.
  // This test overrides it to check where tracing resolves its default path, so put it back exactly.
  const previousHome = process.env.SIDEQUEST_HOME;
  delete process.env[lockTraceApi.LOCK_TRACE_ENV];
  lockTraceApi.resetLockTrace();
  try {
    assert.strictEqual(lockTraceApi.lockTraceEnabled(), false, 'the gate must default to off: db.ts is on the hot path of every hook in every session');
    assert.strictEqual(lockTraceApi.lockTracePath(), null);

    // A full read/write cycle under the default configuration must leave no trace artefact anywhere
    // tracing would choose to write: not beside the board database, and not at the default path.
    txn(db, () => putRow(db, 'globals', { key: 'untraced', data: { n: 1 } }));
    getRow(db, 'globals', 'untraced');
    lockTraceApi.flushLockTrace();

    assert.strictEqual(fs.existsSync(path.join(homeRoot, lockTraceApi.LOCK_TRACE_FILENAME)), false, 'tracing wrote beside the board database while disabled');
    assert.strictEqual(fs.existsSync(lockTraceApi.defaultLockTracePath({ ...process.env, SIDEQUEST_HOME: homeRoot })), false);

    // A falsey word is still off, so SIDEQUEST_LOCK_TRACE=0 turns an enabled shell back off.
    process.env[lockTraceApi.LOCK_TRACE_ENV] = '0';
    lockTraceApi.resetLockTrace();
    assert.strictEqual(lockTraceApi.lockTraceEnabled(), false);

    // Switched on without a path, records go to a sibling of sidequest.db, never into it: a measurement
    // written through the lock being measured would both perturb and deadlock the thing under test.
    process.env.SIDEQUEST_HOME = homeRoot;
    process.env[lockTraceApi.LOCK_TRACE_ENV] = '1';
    lockTraceApi.resetLockTrace();
    assert.strictEqual(lockTraceApi.lockTracePath(), path.join(homeRoot, lockTraceApi.LOCK_TRACE_FILENAME));
    assert.notStrictEqual(lockTraceApi.lockTracePath(), path.join(homeRoot, 'sidequest.db'));
  } finally {
    if (previousHome === undefined) delete process.env.SIDEQUEST_HOME;
    else process.env.SIDEQUEST_HOME = previousHome;
    if (previous === undefined) delete process.env[lockTraceApi.LOCK_TRACE_ENV];
    else process.env[lockTraceApi.LOCK_TRACE_ENV] = previous;
    lockTraceApi.resetLockTrace();
    db.close();
  }
});

test('a traced transaction records its wait, its hold, and its nested statements separately (SQ-262)', () => {
  const { db } = makeDb();
  const traceFile = newTraceFile();
  let records: LockTraceRecord[];
  try {
    records = withLockTrace(traceFile, () => {
      txn(db, () => {
        putRow(db, 'globals', { key: 'traced-a', data: { n: 1 } });
        putRow(db, 'globals', { key: 'traced-b', data: { n: 2 } });
      });
      getRow(db, 'globals', 'traced-a');
    });
  } finally {
    db.close();
  }

  const transactions = waitsFor(records, 'writing transaction');
  assert.strictEqual(transactions.length, 1, 'the transaction should produce exactly one wait record');
  const transaction = transactions[0]!;
  assert.strictEqual(transaction.depth, 0, 'the transaction is the outermost retry frame');
  assert.strictEqual(transaction.attempts, 1);
  assert.strictEqual(transaction.blocked, false, 'an uncontended write must be distinguishable from one that waited');
  assert.strictEqual(transaction.outcome, 'clear');
  assert.ok(Number.isFinite(transaction.waitMs) && transaction.waitMs >= 0, `waitMs should be a monotonic elapsed measurement, got ${transaction.waitMs}`);

  // Attribution: the pid and the policy label are what tell a starved hook apart from a server write.
  for (const record of records) {
    assert.strictEqual(record.pid, process.pid);
    assert.strictEqual(record.policy, 'server', 'this process runs under the default server lock policy');
    assert.match(String(record.project), /\S/, 'every record carries the project slug in scope');
  }

  // Nesting is explicit, so a reader never adds a child's wait into its parent's.
  const nested = waitsFor(records, 'writing globals');
  assert.strictEqual(nested.length, 2, 'both writes inside the transaction should be recorded');
  for (const write of nested) assert.ok(write.depth >= 1, `a statement inside the transaction must be marked nested, got depth ${write.depth}`);
  assert.ok(waitsFor(records, 'reading globals').some((read) => read.depth === 0), 'the read outside the transaction is its own outermost frame');

  // One hold per BEGIN IMMEDIATE, measured from after that statement to after COMMIT, so it can never
  // exceed the wait that encloses it.
  const holds = holdsIn(records).filter((hold) => hold.operation === 'writing transaction');
  assert.strictEqual(holds.length, 1);
  const hold = holds[0]!;
  assert.strictEqual(hold.outcome, 'commit');
  assert.strictEqual(hold.depth, 0, 'the hold is attributed to the frame that owns BEGIN IMMEDIATE, not to its children');
  assert.ok(hold.holdMs >= 0 && hold.holdMs <= transaction.waitMs + 1, `hold ${hold.holdMs}ms should sit inside its wait ${transaction.waitMs}ms`);
  assert.strictEqual(holdsIn(records).some((record) => record.operation === 'reading globals'), false, 'a read takes no write lock, so it has no hold');
});

test('a rolled-back transaction still records how long it held the write lock (SQ-262)', () => {
  const { db } = makeDb();
  const traceFile = newTraceFile();
  let records: LockTraceRecord[];
  try {
    records = withLockTrace(traceFile, () => {
      assert.throws(() => txn(db, () => {
        putRow(db, 'globals', { key: 'rolled-back', data: { n: 1 } });
        throw new Error('abandon this transaction');
      }), /abandon this transaction/);
    });
  } finally {
    db.close();
  }

  const holds = holdsIn(records);
  assert.strictEqual(holds.length, 1);
  assert.strictEqual(holds[0]!.outcome, 'rollback', 'the lock is held until ROLLBACK returns, so a failed transaction is still contention');
  assert.ok(holds[0]!.holdMs >= 0);
  // The failure was not a lock error, so the retry frame settled as failed rather than exhausted.
  const transaction = waitsFor(records, 'writing transaction')[0];
  assert.strictEqual(transaction?.outcome, 'failed');
  assert.strictEqual(transaction?.blocked, false, 'an ordinary error is not lock contention');
});

test('a wait that retried past a busy error is distinguishable from one that never blocked (SQ-262)', () => {
  const { db } = makeDb();
  const traceFile = newTraceFile();
  let records: LockTraceRecord[];
  try {
    records = withLockTrace(traceFile, () => {
      txn(db, () => putRow(db, 'globals', { key: 'clear', data: { n: 1 } }));
      let attempts = 0;
      const outcome = txn(db, () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        putRow(db, 'globals', { key: 'retried', data: { n: 2 } });
        return 'committed';
      });
      assert.strictEqual(outcome, 'committed');
      assert.strictEqual(attempts, 2);
    });
  } finally {
    db.close();
  }

  const transactions = waitsFor(records, 'writing transaction');
  assert.strictEqual(transactions.length, 2);
  const [clear, retried] = transactions as [LockWaitRecord, LockWaitRecord];

  assert.strictEqual(clear.blocked, false);
  assert.strictEqual(clear.attempts, 1);
  assert.strictEqual(retried.blocked, true, 'a wait that saw SQLITE_BUSY must be flagged, which is the whole blocked tally US-4 reads');
  assert.strictEqual(retried.attempts, 2);
  assert.strictEqual(retried.outcome, 'clear', 'it recovered on the retry, so the wait succeeded despite blocking');

  // The retry sleeps through busySleep's Atomics.wait, which blocks the thread synchronously. A wall
  // clock could report that as anything; a monotonic clock reports at least the delay that elapsed.
  assert.ok(retried.waitMs >= 45, `the 50ms busy backoff should show up in the measured wait, got ${retried.waitMs}ms`);
  assert.ok(retried.waitMs > clear.waitMs, `a wait that blocked (${retried.waitMs}ms) must read longer than one that did not (${clear.waitMs}ms)`);

  // Two BEGIN IMMEDIATEs were taken for the one retried frame: the rolled-back attempt and the commit.
  const holds = holdsIn(records).filter((hold) => hold.operation === 'writing transaction');
  assert.deepStrictEqual(holds.map((hold) => hold.outcome), ['commit', 'rollback', 'commit']);
});

test('a spent hook lock budget is traced, and reaches the file before the exhaustion hook runs (SQ-262)', async () => {
  const { db, homeRoot } = makeDb();
  // The connection pragma is what actually bounds one attempt; the policy bounds how many attempts.
  db.exec('PRAGMA busy_timeout=50');
  const childProcess = await holdWriteLock(homeRoot, 30_000);
  const traceFile = newTraceFile();
  const seenInsideHook: LockWaitRecord[] = [];
  const exhaustedErrors: Error[] = [];

  process.env[lockTraceApi.LOCK_TRACE_ENV] = traceFile;
  lockTraceApi.resetLockTrace();
  Reflect.set(globalThis, SQLITE_BUSY_POLICY_KEY, {
    label: 'hook',
    timeoutMs: 100,
    attempts: 1,
    onExhausted: (error: Error) => {
      exhaustedErrors.push(error);
      // A hook fails open from here by exiting the process, so anything not already on disk is lost.
      for (const record of recordedIn(traceFile)) {
        if (record.kind === 'wait' && record.outcome === 'exhausted') seenInsideHook.push(record);
      }
    },
  });

  try {
    assert.throws(() => txn(db, () => putRow(db, 'globals', { key: 'starved', data: {} })), /stayed locked/);
    assert.strictEqual(exhaustedErrors.length, 1, 'the budget should have been spent');

    assert.strictEqual(seenInsideHook.length, 1, 'the exhausted wait must be durable before onExhausted gets control, because that hook may never return');
    const exhausted = seenInsideHook[0]!;
    assert.strictEqual(exhausted.operation, 'writing transaction');
    assert.strictEqual(exhausted.policy, 'hook', 'the policy label is what separates a starved hook from a server write');
    assert.strictEqual(exhausted.blocked, true);
    assert.strictEqual(exhausted.attempts, 1);
    assert.strictEqual(exhausted.depth, 0);
    assert.strictEqual(exhausted.pid, process.pid);
    assert.ok(exhausted.waitMs >= 40, `the wait should cover the 50ms busy timeout, got ${exhausted.waitMs}ms`);

    // BEGIN IMMEDIATE never succeeded, so there is nothing to report as held.
    assert.deepStrictEqual(holdsIn(recordedIn(traceFile)), []);
  } finally {
    Reflect.deleteProperty(globalThis, SQLITE_BUSY_POLICY_KEY);
    delete process.env[lockTraceApi.LOCK_TRACE_ENV];
    lockTraceApi.resetLockTrace();
    childProcess.kill();
    await waitForProcessExit(childProcess);
    db.close();
  }
});

test('the lock-trace report summarises waits, holds, and blocking per operation and policy (SQ-262)', () => {
  const { db } = makeDb();
  const traceFile = newTraceFile();
  try {
    withLockTrace(traceFile, () => {
      txn(db, () => putRow(db, 'globals', { key: 'reported', data: { n: 1 } }));
      let attempts = 0;
      txn(db, () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        return 'ok';
      });
      getRow(db, 'globals', 'reported');
    });
  } finally {
    db.close();
  }

  // A foreign line must be counted, not thrown: every board process on the machine appends here.
  fs.appendFileSync(traceFile, 'not json at all\n');
  const parsed = lockTraceApi.readLockTraceRecords(traceFile);
  assert.strictEqual(parsed.skipped, 1);

  const summary = lockTraceApi.summarizeLockTrace(parsed.records);
  assert.strictEqual(summary.blocked, 1, 'exactly one wait saw SQLITE_BUSY');
  assert.strictEqual(summary.exhausted, 0);
  assert.ok(summary.nested > 0, 'the summary separates nested waits so wait time is never summed');
  assert.ok(summary.holds >= 3, `three BEGIN IMMEDIATEs were taken, got ${summary.holds}`);
  assert.ok(summary.maxHoldMs > 0);
  assert.ok(summary.p50WaitMs <= summary.p95WaitMs && summary.p95WaitMs <= summary.maxWaitMs, `percentiles should be ordered, got ${summary.p50WaitMs}/${summary.p95WaitMs}/${summary.maxWaitMs}`);
  assert.deepStrictEqual(summary.pids, [process.pid]);

  const transaction = summary.byOperation.find((row) => row.key === 'writing transaction');
  assert.ok(transaction, `no per-operation row for the transactions: ${summary.byOperation.map((row) => row.key).join(', ')}`);
  assert.strictEqual(transaction.waits, 2);
  assert.strictEqual(transaction.blocked, 1);
  assert.strictEqual(transaction.rollbacks, 1);
  assert.ok(transaction.maxWaitMs >= 45, 'the per-operation max must carry the real blocked wait');

  assert.deepStrictEqual(summary.byPolicy.map((row) => row.key), ['server'], 'this run only used the server policy');
  assert.strictEqual(summary.byPolicy[0]!.blocked, 1);

  const report = lockTraceApi.formatLockTraceReport(summary, { file: traceFile, skipped: parsed.skipped });
  for (const expected of ['writing transaction', 'blocked:', 'budget exhausted:', 'max hold ms', 'unparsed lines: 1', 'policy']) {
    assert.ok(report.includes(expected), `the report is the only thing making the raw log usable, but it omits ${expected}:\n${report}`);
  }

  // The report has to be runnable, not just callable: this is how US-4 actually reads a collected log.
  const cliPath = path.join(pluginRoot, 'lib', 'lock-trace.js');
  const cli = spawnSync(process.execPath, [cliPath, traceFile], { encoding: 'utf8', timeout: 30_000 });
  assert.strictEqual(cli.status, 0, cli.stderr);
  assert.ok(cli.stdout.includes('writing transaction'), cli.stdout);
  assert.ok(cli.stdout.includes('blocked: 1 wait hit SQLITE_BUSY at least once'), cli.stdout);

  const json = spawnSync(process.execPath, [cliPath, traceFile, '--json'], { encoding: 'utf8', timeout: 30_000 });
  assert.strictEqual(json.status, 0, json.stderr);
  const decoded = JSON.parse(json.stdout) as LockTraceSummary & { file: string; skipped: number };
  assert.strictEqual(decoded.blocked, 1);
  assert.strictEqual(decoded.skipped, 1);
  assert.ok(decoded.byOperation.some((row) => row.key === 'writing transaction'));

  const missing = spawnSync(process.execPath, [cliPath, path.join(path.dirname(traceFile), 'absent.jsonl')], { encoding: 'utf8', timeout: 30_000 });
  assert.strictEqual(missing.status, 2, 'a missing trace is a usage problem, not a crash');
  assert.match(missing.stderr, /SIDEQUEST_LOCK_TRACE/, 'the failure should say how to collect a trace');
});
