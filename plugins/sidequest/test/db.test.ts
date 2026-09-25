import './_temp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';

import type { ChangeCount, SidequestDatabase, TableName } from '../src/lib/db.js';

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
};

const { openDb, getRow, putRow, deleteRow, listRows, listRowsPage, countRows, selectRows, prepareCached, txn, SQLITE_BUSY_TIMEOUT_MS, SQLITE_BUSY_POLICY_KEY } = databaseApi;
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
});

test('requiring db.js emits no SQLite ExperimentalWarning', () => {
  const dbPath = path.join(__dirname, '..', 'lib', 'db.js');
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(dbPath)})`], { encoding: 'utf8' });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /ExperimentalWarning/);
  assert.doesNotMatch(result.stderr, /ExperimentalWarning/);
});
