import './_temp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';

import type { ChangeCount, NewerSchemaError, SchemaMigrationRecord, SidequestDatabase, TableName } from '../src/lib/db.js';

// #22: every session on the machine shares one board database, so a newer sidequest migrating it strands every
// session that still has an older one loaded. These tests stand in for that older session by moving a board one
// schema past what the loaded code supports (a schema-N+1 fixture) and checking what the stranded session is told.

const db = require('../lib/db.js') as {
  CURRENT_SCHEMA_VERSION: number;
  SCHEMA_MIGRATED_BY_KEY: string;
  NEWER_SCHEMA_ERROR_CODE: string;
  openDb(homeRoot: string): SidequestDatabase;
  loadedPluginVersion(): string | null;
  schemaMigrationRecord(database: DatabaseSync): SchemaMigrationRecord | null;
  getRow<T = unknown>(database: DatabaseSync, table: TableName, key: unknown): T | null;
  putRow(database: DatabaseSync, table: TableName, row: unknown): ChangeCount;
  deleteRow(database: DatabaseSync, table: TableName, key: unknown): boolean;
  txn<T>(database: DatabaseSync, fn: () => T): T;
};
const { DatabaseSync: RawDatabase } = require('node:sqlite') as typeof import('node:sqlite');

const PLUGIN_ROOT = path.join(__dirname, '..');
const MANIFEST_VERSION = (JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')) as { version: string }).version;
const CURRENT = db.CURRENT_SCHEMA_VERSION;
const NEXT = CURRENT + 1;
const MIGRATOR = { version: '99.1.0', schemaVersion: NEXT, migratedAt: '2026-09-28T12:00:00.000Z' };
// Literals, not the module's exports: a newer version writes this key and an older one reads it, so the name and
// the error code are a contract across versions that no single build may rename.
const MIGRATED_BY_KEY = 'schema_migrated_by';
const NEWER_SCHEMA_CODE = 'SIDEQUEST_SCHEMA_NEWER';

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sq-schema-newer-'));
}

function dbPath(homeRoot: string): string {
  return path.join(homeRoot, 'sidequest.db');
}

// A second connection, as the newer sidequest process would hold: it moves the board without going through the
// loaded code at all.
function withRawBoard<T>(homeRoot: string, work: (raw: DatabaseSync) => T): T {
  const raw = new RawDatabase(dbPath(homeRoot));
  try {
    return work(raw);
  } finally {
    raw.close();
  }
}

function metaValue(raw: DatabaseSync, key: string): unknown {
  const row = raw.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? JSON.parse(row.value as string) : undefined;
}

function setMeta(raw: DatabaseSync, key: string, value: unknown): void {
  raw.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

function deleteMeta(raw: DatabaseSync, key: string): void {
  raw.prepare('DELETE FROM meta WHERE key = ?').run(key);
}

// Builds a current board, then has a "newer sidequest" move it to schema N+1 and record (or not) who did it.
function newerBoard(record: unknown): string {
  const homeRoot = makeHome();
  db.openDb(homeRoot).close();
  withRawBoard(homeRoot, (raw) => {
    raw.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(JSON.stringify(NEXT));
    if (record === undefined) deleteMeta(raw, MIGRATED_BY_KEY);
    else setMeta(raw, MIGRATED_BY_KEY, record);
  });
  return homeRoot;
}

function assertIncludes(message: string, fragment: string, label = ''): void {
  assert.ok(message.includes(fragment), `${label ? `${label}: ` : ''}expected ${JSON.stringify(fragment)} in: ${message}`);
}

function refusal(work: () => unknown): NewerSchemaError {
  let caught: unknown;
  assert.throws(() => {
    try {
      work();
    } catch (error) {
      caught = error;
      throw error;
    }
  });
  assert.ok(caught instanceof Error, 'the refusal must be an Error');
  return caught as NewerSchemaError;
}

test('the loaded plugin version is read from this plugin\'s own manifest, and the cross-version names are pinned', () => {
  assert.equal(db.SCHEMA_MIGRATED_BY_KEY, MIGRATED_BY_KEY);
  assert.equal(db.NEWER_SCHEMA_ERROR_CODE, NEWER_SCHEMA_CODE);
  assert.equal(db.loadedPluginVersion(), MANIFEST_VERSION);
});

test('a migration records the plugin version that ran it, with the schema it left the board at', () => {
  // A fresh board is migrated from nothing; a schema-7 board takes only the step to the current schema.
  const fresh = makeHome();
  const legacy = makeHome();
  withRawBoard(legacy, (raw) => raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('schema_version', '7');"));
  for (const homeRoot of [fresh, legacy]) {
    const before = Date.now();
    const database = db.openDb(homeRoot);
    try {
      assert.equal(db.getRow(database, 'meta', 'schema_version'), CURRENT);
      const record = db.schemaMigrationRecord(database);
      assert.ok(record, `${homeRoot}: a migration must leave a ${MIGRATED_BY_KEY} record`);
      assert.equal(record.version, MANIFEST_VERSION);
      assert.equal(record.schemaVersion, CURRENT);
      assert.ok(record.migratedAt && Date.parse(record.migratedAt) >= before - 1000, `migratedAt ${record.migratedAt} must be the migration time`);
      assert.deepEqual(db.getRow(database, 'meta', MIGRATED_BY_KEY), record);
    } finally {
      database.close();
    }
  }
});

test('opening an already-current board leaves the migration record alone', () => {
  // SQ-125: a current open is write-free, so it must not restamp the record either.
  const homeRoot = makeHome();
  db.openDb(homeRoot).close();
  const sentinel = { version: '0.0.1-sentinel', schemaVersion: CURRENT, migratedAt: '2000-01-01T00:00:00.000Z' };
  withRawBoard(homeRoot, (raw) => setMeta(raw, MIGRATED_BY_KEY, sentinel));
  db.openDb(homeRoot).close();
  assert.deepEqual(withRawBoard(homeRoot, (raw) => metaValue(raw, MIGRATED_BY_KEY)), sentinel);
});

test('an older session refuses to open a schema N+1 board, naming /reload-plugins, its loaded version, and the migrator', () => {
  const homeRoot = newerBoard(MIGRATOR);
  const error = refusal(() => db.openDb(homeRoot));
  assertIncludes(error.message, `Sidequest database schema ${NEXT} is newer than supported schema ${CURRENT}; refusing to open the board.`);
  assertIncludes(error.message, `This session has sidequest ${MANIFEST_VERSION} loaded`);
  assertIncludes(error.message, `sidequest 99.1.0 migrated the shared board database to schema ${NEXT} at 2026-09-28T12:00:00.000Z`);
  assertIncludes(error.message, 'Run /reload-plugins (or restart Claude Code)');
  assert.equal(error.code, NEWER_SCHEMA_CODE);
  assert.equal(error.schemaVersion, NEXT);
  assert.equal(error.supportedSchemaVersion, CURRENT);
  assert.equal(error.loadedVersion, MANIFEST_VERSION);
  assert.deepEqual(error.migratedBy, MIGRATOR);

  // The refused open wrote nothing: the newer board and its record are exactly as the newer process left them.
  withRawBoard(homeRoot, (raw) => {
    assert.equal(metaValue(raw, 'schema_version'), NEXT);
    assert.deepEqual(metaValue(raw, MIGRATED_BY_KEY), MIGRATOR);
  });
  // Every retry gets the same answer rather than a different, opaque failure.
  assert.equal(refusal(() => db.openDb(homeRoot)).message, error.message);
});

test('a missing, stale, or unreadable migration record is never attributed to a version', () => {
  const cases: Array<[string, unknown]> = [
    ['missing', undefined],
    // Left by the step to the current schema: it names who moved the board to N, not to N+1.
    ['stale', { version: '5.0.0', schemaVersion: CURRENT, migratedAt: '2026-01-01T00:00:00.000Z' }],
    ['unreadable', 'not a record'],
    ['versionless', { version: null, schemaVersion: NEXT, migratedAt: '2026-09-28T12:00:00.000Z' }],
  ];
  for (const [label, record] of cases) {
    const error = refusal(() => db.openDb(newerBoard(record)));
    assertIncludes(error.message, `a newer sidequest migrated the shared board database to schema ${NEXT} (the migrating version was not recorded)`, label);
    assertIncludes(error.message, 'Run /reload-plugins');
    assert.ok(!error.message.includes('5.0.0'), `${label}: a stale record must not be named: ${error.message}`);
    assert.equal(error.code, NEWER_SCHEMA_CODE, label);
    if (label === 'versionless') assert.equal(error.migratedBy?.version, null, label);
    else assert.equal(error.migratedBy, null, label);
  }
});

test('an open older session refuses every write after a newer process migrates the board under it', () => {
  const homeRoot = makeHome();
  const database = db.openDb(homeRoot);
  try {
    withRawBoard(homeRoot, (raw) => {
      raw.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(JSON.stringify(NEXT));
      setMeta(raw, MIGRATED_BY_KEY, MIGRATOR);
    });
    const writes: Array<[string, () => unknown]> = [
      ['putRow', () => db.putRow(database, 'globals', { key: 'stranded-write', data: true })],
      ['deleteRow', () => db.deleteRow(database, 'globals', 'stranded-write')],
      ['txn', () => db.txn(database, () => db.putRow(database, 'globals', { key: 'stranded-txn', data: true }))],
    ];
    for (const [label, write] of writes) {
      const error = refusal(write);
      assertIncludes(error.message, `Sidequest database schema ${NEXT} is newer than supported schema ${CURRENT}; refusing write.`);
      assertIncludes(error.message, `This session has sidequest ${MANIFEST_VERSION} loaded`);
      assertIncludes(error.message, `sidequest 99.1.0 migrated the shared board database to schema ${NEXT}`);
      assertIncludes(error.message, 'Run /reload-plugins (or restart Claude Code) to load the newer sidequest, then retry');
      assert.equal(error.code, NEWER_SCHEMA_CODE, label);
    }
  } finally {
    database.close();
  }
  withRawBoard(homeRoot, (raw) => {
    assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM globals WHERE key IN ('stranded-write', 'stranded-txn')").get()?.count, 0);
  });
});

test('a session whose manifest is gone still refuses with /reload-plugins and records no version it cannot name', () => {
  // An update can delete the loaded version's cache directory. Load the built db module from a directory that has
  // every sibling module but no .claude-plugin manifest above it.
  const orphanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-schema-newer-orphan-'));
  const orphanLib = path.join(orphanRoot, 'plugin', 'lib');
  fs.mkdirSync(orphanLib, { recursive: true });
  const realLib = path.join(PLUGIN_ROOT, 'lib');
  for (const entry of fs.readdirSync(realLib)) {
    if (entry !== 'db.js') fs.symlinkSync(path.join(realLib, entry), path.join(orphanLib, entry));
  }
  const newerHome = newerBoard(MIGRATOR);
  const freshHome = makeHome();
  const script = String.raw`
    const fs = require('node:fs');
    const path = require('node:path');
    const Module = require('node:module');
    const filename = ${JSON.stringify(path.join(orphanLib, 'db.js'))};
    const orphan = new Module(filename);
    orphan.filename = filename;
    orphan.paths = Module._nodeModulePaths(path.dirname(filename));
    orphan._compile(fs.readFileSync(${JSON.stringify(path.join(realLib, 'db.js'))}, 'utf8'), filename);
    const out = { loaded: orphan.exports.loadedPluginVersion() };
    try {
      orphan.exports.openDb(${JSON.stringify(newerHome)});
    } catch (error) {
      out.message = error.message;
      out.loadedVersion = error.loadedVersion;
    }
    const fresh = orphan.exports.openDb(${JSON.stringify(freshHome)});
    out.record = orphan.exports.schemaMigrationRecord(fresh);
    fresh.close();
    process.stdout.write(JSON.stringify(out));
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout) as { loaded: string | null; message?: string; loadedVersion?: string | null; record: SchemaMigrationRecord };
  assert.equal(out.loaded, null);
  assert.ok(out.message, 'the orphaned session must still refuse the newer board');
  assertIncludes(out.message, `schema ${NEXT} is newer than supported schema ${CURRENT}; refusing to open the board.`);
  assertIncludes(out.message, 'This session has a sidequest version whose manifest was unreadable loaded');
  assertIncludes(out.message, 'sidequest 99.1.0 migrated the shared board database');
  assertIncludes(out.message, 'Run /reload-plugins');
  assert.equal(out.loadedVersion, null);
  assert.equal(out.record.version, null);
  assert.equal(out.record.schemaVersion, CURRENT);
});
