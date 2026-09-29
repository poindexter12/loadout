import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';

import { DEFAULT_CATEGORIES, ROUTING_PROFILE_SEED_REVISION, starterRoutingProfilesFor } from './category-defaults.js';
import { discoverExternalModels, providerReadiness } from './discovery.js';

const originalEmitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  if (warning === 'SQLite is an experimental feature and might change at any time' && args[0] === 'ExperimentalWarning') {
    return;
  }
  Reflect.apply(originalEmitWarning, process, [warning, ...args]);
}) as typeof process.emitWarning;

let DatabaseSyncConstructor: typeof import('node:sqlite').DatabaseSync;
try {
  ({ DatabaseSync: DatabaseSyncConstructor } = require('node:sqlite') as typeof import('node:sqlite'));
} finally {
  process.emitWarning = originalEmitWarning;
}

// Bump this for ANY schema script change, including a new CREATE ... IF NOT EXISTS: openDb skips the whole
// script when the stored version is current, so an unversioned addition never reaches an existing board (SQ-125).
// openDb records which plugin version ran a migration (recordSchemaMigration), so an older session can name it (#22).
export const CURRENT_SCHEMA_VERSION = 8;
// Board writers normally finish in milliseconds; fifteen-second SQLite waits avoid failing on ordinary handoffs without hiding a wedged writer forever.
export const SQLITE_BUSY_TIMEOUT_MS = 15_000;
const SQLITE_BUSY_RETRY_ATTEMPTS = 3;
const SQLITE_BUSY_RETRY_DELAYS_MS = [50, 100] as const;
const busySleep = new Int32Array(new SharedArrayBuffer(4));

// The board database is machine-global, so a process with a short external deadline cannot afford the
// server's lock budget: 3 attempts of 15s outlast Claude Code's 10s hook timeout, and a hook killed at the
// deadline has neither allowed nor refused anything (SQ-125). Such a process installs its own budget under
// this global key before anything opens the board. It is a process global rather than an import so a
// bundled hook can install it without loading this module, and so it never leaks into child processes.
export const SQLITE_BUSY_POLICY_KEY = Symbol.for('sidequest.sqlite-busy-policy');

export interface SqliteBusyPolicy {
  /** Names the budget in lock diagnostics, e.g. `hook`. */
  readonly label: string;
  /** SQLite busy_timeout for each attempt. */
  readonly timeoutMs: number;
  /** Total attempts, including the first. */
  readonly attempts: number;
  /** Runs once the budget is spent, before the lock error is thrown. A hook uses it to fail open. */
  readonly onExhausted?: (error: Error) => void;
}

const SERVER_SQLITE_BUSY_POLICY: SqliteBusyPolicy = Object.freeze({
  label: 'server',
  timeoutMs: SQLITE_BUSY_TIMEOUT_MS,
  attempts: SQLITE_BUSY_RETRY_ATTEMPTS,
});

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function sqliteBusyPolicy(): SqliteBusyPolicy {
  const installed: unknown = Reflect.get(globalThis, SQLITE_BUSY_POLICY_KEY);
  if (!isRecord(installed) || !positiveInteger(installed.timeoutMs) || !positiveInteger(installed.attempts)) {
    return SERVER_SQLITE_BUSY_POLICY;
  }
  return installed as unknown as SqliteBusyPolicy;
}

// Pre-v5 default text; the v5 migration only refreshes rows the user never customized.
const OLD_CODEBASE_EXPLORATION = {
  description: 'Locate and explain how an unfamiliar code path, feature, or convention works. The deliverable is a grounded map of existing code, not an implementation or a design recommendation.',
  contract: 'Read before concluding; cite files and symbols, with no edits.',
} as const;
const V5_CODEBASE_EXPLORATION_CONTRACT = 'Read before concluding; cite files and symbols. Do not edit project source. A ticket may explicitly name one bounded documentation artifact directory as its only write scope.';

const LEGACY_RUNTIME: Readonly<Record<string, string>> = {
  'grade-1': 'haiku',
  'grade-2': 'sonnet',
  'grade-3': 'opus',
  'grade-4': 'fable',
  haiku: 'haiku',
  sonnet: 'sonnet',
  opus: 'opus',
  fable: 'fable',
};
const ROUTING_FALLBACK_DEFAULT = { model: 'sonnet', effort: 'high' } as const;

function capabilityModels() {
  return discoverExternalModels().filter((model) => providerReadiness(model.provider)?.ready === true);
}

interface TableSpec {
  key: string | readonly string[];
  columns: readonly string[];
  jsonColumns?: readonly string[];
  payload?: 'data' | 'value';
  orderBy?: string;
}

const TABLES = {
  projects: { key: 'slug', columns: ['slug', 'data'], jsonColumns: ['data'], payload: 'data' },
  tickets: { key: 'id', columns: ['id', 'project', 'ref', 'status', 'archived', 'ord', 'claim_by', 'data'], jsonColumns: ['data'], payload: 'data', orderBy: 'ord' },
  stories: { key: 'id', columns: ['id', 'project', 'data'], jsonColumns: ['data'], payload: 'data' },
  categories: { key: 'id', columns: ['id', 'data'], jsonColumns: ['data'], payload: 'data' },
  routing_profiles: { key: 'id', columns: ['id', 'name', 'description', 'source', 'seed_key', 'seed_revision', 'revision', 'created_at', 'updated_at', 'retired_at'] },
  routing_profile_entries: { key: ['profile_id', 'category_id'], columns: ['profile_id', 'category_id', 'data', 'position', 'updated_at'], jsonColumns: ['data'], orderBy: 'position, category_id' },
  project_routing_profiles: { key: 'project', columns: ['project', 'profile_id', 'assigned_at', 'assigned_by'] },
  routing_profile_settings: { key: 'singleton', columns: ['singleton', 'new_project_profile_id'] },
  project_categories: { key: ['project', 'id'], columns: ['project', 'id', 'kind', 'base_profile_id', 'base_data', 'data'], jsonColumns: ['base_data', 'data'], payload: 'data' },
  globals: { key: 'key', columns: ['key', 'data'], jsonColumns: ['data'], payload: 'data' },
  meta: { key: 'key', columns: ['key', 'value'], jsonColumns: ['value'], payload: 'value' },
} as const satisfies Record<string, TableSpec>;

export type TableName = keyof typeof TABLES;
export type ChangeCount = number | bigint;
export type SidequestDatabase = DatabaseSync & { __sidequestSchemaVersion: number };

export interface ProjectRow<T = unknown> {
  slug: string;
  data: T;
}

export interface TicketRow<T = unknown> {
  id: string;
  project: string;
  ref: string | null;
  status: string | null;
  archived: number;
  ord: number;
  claim_by: string | null;
  data: T;
}

export interface StoryRow<T = unknown> {
  id: string;
  project: string;
  data: T;
}

export interface CategoryRow<T = unknown> {
  id: string;
  data: T;
}

export interface RoutingProfileRow {
  id: string;
  name: string;
  description: string;
  source: 'seed' | 'migrated' | 'user';
  seed_key: string | null;
  seed_revision: number | null;
  revision: number;
  created_at: string;
  updated_at: string;
  retired_at: string | null;
}

export interface RoutingProfileEntryRow<T = unknown> {
  profile_id: string;
  category_id: string;
  data: T;
  position: number;
  updated_at: string;
}

export interface ProjectRoutingProfileRow {
  project: string;
  profile_id: string;
  assigned_at: string;
  assigned_by: string | null;
}

export interface RoutingProfileSettingsRow {
  singleton: number;
  new_project_profile_id: string;
}

export interface ProjectCategoryRow<T = unknown> {
  project: string;
  id: string;
  kind: string;
  base_profile_id?: string | null;
  base_data?: T | null;
  data: T;
}

export interface GlobalRow<T = unknown> {
  key: string;
  data: T;
}

export interface MetaRow<T = unknown> {
  key: string;
  value: T;
}

export interface DatabaseTableRowMap {
  projects: ProjectRow;
  tickets: TicketRow;
  stories: StoryRow;
  categories: CategoryRow;
  routing_profiles: RoutingProfileRow;
  routing_profile_entries: RoutingProfileEntryRow;
  project_routing_profiles: ProjectRoutingProfileRow;
  routing_profile_settings: RoutingProfileSettingsRow;
  project_categories: ProjectCategoryRow;
  globals: GlobalRow;
  meta: MetaRow;
}

export interface DatabaseTableKeyMap {
  projects: string;
  tickets: string;
  stories: string;
  categories: string;
  routing_profiles: string;
  routing_profile_entries: { profile_id: string; category_id: string };
  project_routing_profiles: string;
  routing_profile_settings: number;
  project_categories: { project: string; id: string };
  globals: string;
  meta: string;
}

export type RowFilter<T extends TableName> = Partial<Record<(typeof TABLES)[T]['columns'][number], SQLInputValue>>;

export interface PageOptions {
  limit: number;
  offset?: number;
}

const statementCaches = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = Reflect.get(error, 'code');
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true;
  if (/database is (?:locked|busy)/i.test(error.message)) return true;
  return isSqliteBusy(Reflect.get(error, 'cause'));
}

function sqliteBusyError(operation: string, startedAt: number, cause: unknown, policy: SqliteBusyPolicy): Error {
  const elapsedMs = Date.now() - startedAt;
  const originalMessage = cause instanceof Error ? cause.message : String(cause);
  const attempts = `${policy.attempts} attempt${policy.attempts === 1 ? '' : 's'}`;
  const budget = policy === SERVER_SQLITE_BUSY_POLICY ? '' : ` (${policy.label} lock budget)`;
  return new Error(
    `Sidequest database stayed locked while ${operation} for ${elapsedMs}ms after ${attempts}, each waiting up to ${policy.timeoutMs}ms${budget}. SQLite does not expose the locking process or claim identity. Check active Sidequest writers, then retry. Original SQLite error: ${originalMessage}`,
    { cause },
  );
}

function retryWhenSqliteBusy<T>(operation: string, work: () => T): T {
  const policy = sqliteBusyPolicy();
  const startedAt = Date.now();
  for (let attempt = 0; attempt < policy.attempts; attempt += 1) {
    try {
      return work();
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
      if (attempt === policy.attempts - 1) {
        const exhausted = sqliteBusyError(operation, startedAt, error, policy);
        policy.onExhausted?.(exhausted);
        throw exhausted;
      }
      Atomics.wait(busySleep, 0, 0, SQLITE_BUSY_RETRY_DELAYS_MS[attempt] ?? SQLITE_BUSY_RETRY_DELAYS_MS.at(-1));
    }
  }
  throw new Error(`SQLite busy retry exhausted without an error while ${operation}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tableSpec(table: TableName): TableSpec {
  const spec: TableSpec | undefined = TABLES[table];
  if (!spec) throw new Error(`Unknown database table: ${table}`);
  return spec;
}

function keyColumns(spec: TableSpec): readonly string[] {
  return typeof spec.key === 'string' ? [spec.key] : spec.key;
}

function keyValues(spec: TableSpec, key: unknown): SQLInputValue[] {
  const columns = keyColumns(spec);
  if (columns.length === 1) return [key as SQLInputValue];
  if (!isRecord(key)) throw new Error(`Composite key for ${columns.join(', ')} requires an object.`);
  return columns.map((column) => key[column] as SQLInputValue);
}

function keyWhere(spec: TableSpec): string {
  return keyColumns(spec).map((column) => `${column} = ?`).join(' AND ');
}

function payloadColumn(spec: TableSpec): 'data' | 'value' | null {
  return spec.payload ?? null;
}

function parsePayload(row: Record<string, SQLOutputValue>, column: string): unknown {
  return JSON.parse(row[column] as string) as unknown;
}

function parseTableRow(spec: TableSpec, row: Record<string, SQLOutputValue>): unknown {
  const payload = payloadColumn(spec);
  if (payload) return parsePayload(row, payload);
  const parsed: Record<string, unknown> = {};
  for (const column of spec.columns) {
    const value = row[column];
    parsed[column] = spec.jsonColumns?.includes(column) && value != null
      ? JSON.parse(value as string) as unknown
      : value;
  }
  return parsed;
}

function encodeColumn(spec: TableSpec, column: string, value: unknown): SQLInputValue {
  if (value === undefined) return null;
  if (spec.jsonColumns?.includes(column)) return JSON.stringify(value) ?? null;
  return value as SQLInputValue;
}

function filtersFor<T extends TableName>(table: T, whereObj?: RowFilter<T>): Array<[string, SQLInputValue]> {
  const spec = tableSpec(table);
  const filters = Object.entries(whereObj ?? {}) as Array<[string, SQLInputValue]>;
  for (const [column] of filters) {
    if (!spec.columns.includes(column)) throw new Error(`Unknown ${table} column: ${column}`);
  }
  return filters;
}

function whereClause(filters: ReadonlyArray<readonly [string, SQLInputValue]>): string {
  return filters.length ? ` WHERE ${filters.map(([column]) => `${column} = ?`).join(' AND ')}` : '';
}

function parseStoredRecord(value: SQLOutputValue | undefined): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function prepareCached(database: DatabaseSync, sql: string): StatementSync {
  let cache = statementCaches.get(database);
  if (!cache) {
    cache = new Map<string, StatementSync>();
    statementCaches.set(database, cache);
  }
  let statement = cache.get(sql);
  if (!statement) {
    statement = database.prepare(sql);
    cache.set(sql, statement);
  }
  return statement;
}

export function selectRows<T = Record<string, SQLOutputValue>>(
  database: DatabaseSync,
  sql: string,
  parameters: readonly SQLInputValue[] = [],
): T[] {
  return retryWhenSqliteBusy('reading rows', () => prepareCached(database, sql).all(...parameters) as T[]);
}

export function selectRow<T = Record<string, SQLOutputValue>>(
  database: DatabaseSync,
  sql: string,
  parameters: readonly SQLInputValue[] = [],
): T | null {
  return retryWhenSqliteBusy('reading a row', () => (prepareCached(database, sql).get(...parameters) as T | undefined) ?? null);
}

function normalizedCategory(category: Record<string, unknown>): Record<string, unknown> {
  const route = isRecord(category.route) ? category.route : {};
  const fallback = isRecord(category.fallback) ? category.fallback : null;
  const normalizedRoute = {
    model: String(route.model ?? '').trim().toLowerCase(),
    effort: String(route.effort ?? '').trim().toLowerCase(),
  };
  const normalizedFallback = fallback ? {
    model: String(fallback.model ?? '').trim().toLowerCase(),
    effort: String(fallback.effort ?? '').trim().toLowerCase(),
  } : null;
  return {
    id: String(category.id ?? '').trim().toLowerCase(),
    name: String(category.name ?? category.id ?? '').trim(),
    description: String(category.description ?? '').trim(),
    route: normalizedRoute,
    fallback: normalizedFallback
      && (normalizedFallback.model !== normalizedRoute.model || normalizedFallback.effort !== normalizedRoute.effort)
      ? normalizedFallback
      : null,
    contract: String(category.contract ?? '').trim(),
    artifactRoots: Array.isArray(category.artifactRoots) ? category.artifactRoots.map(String) : [],
    enabled: category.enabled !== false,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function categoryDigest(categories: readonly Record<string, unknown>[]): string {
  const normalized = categories.map(normalizedCategory).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return crypto.createHash('sha256').update(stableJson(normalized)).digest('hex');
}

function categoryRows(database: DatabaseSync): Record<string, unknown>[] {
  return retryWhenSqliteBusy('reading categories', () => prepareCached(database, 'SELECT data FROM categories ORDER BY id').all())
    .map((row) => {
      try {
        const parsed = JSON.parse(row.data as string) as unknown;
        return isRecord(parsed) ? parsed : null;
      } catch {
        return null;
      }
    })
    .filter((category): category is Record<string, unknown> => category !== null);
}

function validateGeneral(profileId: string, categories: readonly Record<string, unknown>[]): void {
  const general = categories.find((category) => String(category.id).trim().toLowerCase() === 'general');
  if (!general || general.enabled === false) throw new Error(`Routing profile "${profileId}" requires an enabled general category.`);
}

function applyCategoryRows(
  baseCategories: readonly Record<string, unknown>[],
  rows: readonly { id: string; kind: string; data: Record<string, unknown> }[],
): Record<string, unknown>[] {
  const categories = new Map(baseCategories.map((category) => [String(category.id).trim().toLowerCase(), category]));
  for (const row of rows) {
    const base = categories.get(row.id);
    if (row.kind === 'ADD' && !base) categories.set(row.id, row.data);
    else if (row.kind === 'OVERRIDE' && base) categories.set(row.id, { ...base, ...row.data, id: row.id });
    else if (row.kind === 'DETACH') categories.set(row.id, row.data);
    else if (row.kind === 'DISABLE' && row.id !== 'general') categories.delete(row.id);
  }
  return [...categories.values()];
}

// The board database is shared by every session on the machine, so the first process running a newer sidequest
// migrates it out from under sessions that still have an older one loaded (#22). Each migration step records which
// plugin version moved the board, so the older session's refusal can name it rather than fail opaquely.
export const SCHEMA_MIGRATED_BY_KEY = 'schema_migrated_by';
export const NEWER_SCHEMA_ERROR_CODE = 'SIDEQUEST_SCHEMA_NEWER';

export interface SchemaMigrationRecord {
  /** Sidequest version whose code ran the migration; null when its manifest was unreadable. */
  version: string | null;
  /** The schema version that migration step left the board at. */
  schemaVersion: number;
  migratedAt: string | null;
}

export type NewerSchemaError = Error & {
  code: typeof NEWER_SCHEMA_ERROR_CODE;
  schemaVersion: number;
  supportedSchemaVersion: number;
  loadedVersion: string | null;
  migratedBy: SchemaMigrationRecord | null;
};

function readLoadedPluginVersion(): string | null {
  if (typeof __dirname !== 'string') return null;
  // Built lib/db.js sits one level under the plugin root; src/lib/db.ts run through tsx sits two.
  for (const manifestPath of [
    path.join(__dirname, '..', '.claude-plugin', 'plugin.json'),
    path.join(__dirname, '..', '..', '.claude-plugin', 'plugin.json'),
  ]) {
    try {
      const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (isRecord(manifest) && manifest.name === 'sidequest' && typeof manifest.version === 'string' && manifest.version.trim()) {
        return manifest.version.trim();
      }
    } catch {
      // Try the next layout; an unreadable manifest only costs the refusal its version detail.
    }
  }
  return null;
}

// Read once at load, not at refusal time: an update can delete this version's plugin cache directory while the
// session that loaded it is still running, and that session is exactly the one that needs the answer.
const LOADED_PLUGIN_VERSION = readLoadedPluginVersion();

/** The sidequest version whose code this process loaded, or null when its manifest was unreadable. */
export function loadedPluginVersion(): string | null {
  return LOADED_PLUGIN_VERSION;
}

// openDb runs this right after upgradeSchema, never on an already-current open (that stays write-free, SQ-125). It
// stays outside upgradeSchema because the record is informational: a board already at the current schema has no
// need of it, so it is not a schema change that must reach existing boards (SQ-133). The record carries the schema it
// was written for, so if a crash lands between the last step and this write, a later refusal says "not recorded"
// rather than naming the previous migrator.
function recordSchemaMigration(database: DatabaseSync): void {
  const record: SchemaMigrationRecord = { version: LOADED_PLUGIN_VERSION, schemaVersion: CURRENT_SCHEMA_VERSION, migratedAt: new Date().toISOString() };
  txn(database, () => {
    prepareCached(database, 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(SCHEMA_MIGRATED_BY_KEY, JSON.stringify(record));
  });
}

function isNewerSchemaError(error: unknown): error is NewerSchemaError {
  return error instanceof Error && (error as Partial<NewerSchemaError>).code === NEWER_SCHEMA_ERROR_CODE;
}

/** The recorded migrator of this board, or null when none was recorded or the record is unreadable. */
export function schemaMigrationRecord(database: DatabaseSync): SchemaMigrationRecord | null {
  try {
    const row = prepareCached(database, 'SELECT value FROM meta WHERE key = ?').get(SCHEMA_MIGRATED_BY_KEY);
    if (!row) return null;
    const parsed: unknown = JSON.parse(row.value as string);
    if (!isRecord(parsed) || typeof parsed.schemaVersion !== 'number' || !Number.isInteger(parsed.schemaVersion)) return null;
    return {
      version: typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : null,
      schemaVersion: parsed.schemaVersion,
      migratedAt: typeof parsed.migratedAt === 'string' && parsed.migratedAt ? parsed.migratedAt : null,
    };
  } catch {
    // The refusal is the answer; a missing or unreadable record must never replace it with a different error.
    return null;
  }
}

// upgradeSchema's own check (a migrator that raced this open) passes no handle; openDb re-raises it with one.
function newerSchemaError(
  schemaVersion: number,
  database?: DatabaseSync,
  refusing: 'refusing to open the board' | 'refusing write' = 'refusing to open the board',
): NewerSchemaError {
  const record = database ? schemaMigrationRecord(database) : null;
  // A record written for another schema version (an older migration, or a newer one that crashed before recording)
  // would name the wrong migrator.
  const migratedBy = record && record.schemaVersion === schemaVersion ? record : null;
  const loaded = LOADED_PLUGIN_VERSION ? `sidequest ${LOADED_PLUGIN_VERSION}` : 'a sidequest version whose manifest was unreadable';
  const migrator = migratedBy?.version
    ? `sidequest ${migratedBy.version} migrated the shared board database to schema ${schemaVersion}${migratedBy.migratedAt ? ` at ${migratedBy.migratedAt}` : ''}`
    : `a newer sidequest migrated the shared board database to schema ${schemaVersion} (the migrating version was not recorded)`;
  const error = new Error(
    `Sidequest database schema ${schemaVersion} is newer than supported schema ${CURRENT_SCHEMA_VERSION}; ${refusing}. `
    + `This session has ${loaded} loaded, and ${migrator}. `
    + 'Run /reload-plugins (or restart Claude Code) to load the newer sidequest, then retry: this call changed nothing on the board.',
  );
  return Object.assign(error, {
    code: NEWER_SCHEMA_ERROR_CODE,
    schemaVersion,
    supportedSchemaVersion: CURRENT_SCHEMA_VERSION,
    loadedVersion: LOADED_PLUGIN_VERSION,
    migratedBy,
  } as const);
}

// Pure reads: a WAL reader never waits on the write lock, so this answers even while a long writer holds it.
function storedSchemaVersion(database: DatabaseSync): number | null {
  if (!prepareCached(database, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()) return null;
  const row = prepareCached(database, "SELECT value FROM meta WHERE key = 'schema_version'").get();
  return row ? Number(JSON.parse(row.value as string)) : null;
}

export function openDb(homeRoot: string): SidequestDatabase {
  fs.mkdirSync(homeRoot, { recursive: true });
  const { timeoutMs } = sqliteBusyPolicy();
  const database = new DatabaseSyncConstructor(path.join(homeRoot, 'sidequest.db'), { timeout: timeoutMs });
  try {
    // Already-WAL databases answer this without the write lock; only a fresh file has to convert.
    retryWhenSqliteBusy('enabling WAL mode', () => database.exec('PRAGMA journal_mode=WAL'));
    database.exec(`PRAGMA busy_timeout=${timeoutMs}`);
    // Every hook process opens the board, so a current schema must open without a single write statement: any
    // DML, even an INSERT OR IGNORE that changes nothing, takes the machine-global write lock and queues this
    // open behind whatever long writer holds it (SQ-125). Only a missing or older schema reaches the DDL.
    const storedVersion = retryWhenSqliteBusy('reading the schema version', () => storedSchemaVersion(database));
    if (storedVersion !== null && storedVersion > CURRENT_SCHEMA_VERSION) throw newerSchemaError(storedVersion, database);
    if (storedVersion !== CURRENT_SCHEMA_VERSION) {
      upgradeSchema(database);
      recordSchemaMigration(database);
    }
  } catch (error) {
    const refusal = isNewerSchemaError(error) && !error.migratedBy ? newerSchemaError(error.schemaVersion, database) : error;
    // The store retries openDb on every call, so a refused open must not leave its handle behind each time.
    try {
      database.close();
    } catch {
      // Preserve the open error.
    }
    throw refusal;
  }
  database.exec('PRAGMA foreign_keys=ON');
  const sidequestDatabase = database as SidequestDatabase;
  sidequestDatabase.__sidequestSchemaVersion = CURRENT_SCHEMA_VERSION;
  return sidequestDatabase;
}

function upgradeSchema(database: DatabaseSync): void {
  retryWhenSqliteBusy('initializing database schema', () => database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      slug TEXT PRIMARY KEY,
      data TEXT
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      project TEXT,
      ref TEXT,
      status TEXT,
      archived INTEGER,
      ord REAL,
      claim_by TEXT,
      data TEXT
    );
    CREATE INDEX IF NOT EXISTS tickets_project_status_idx ON tickets(project, status);
    CREATE INDEX IF NOT EXISTS tickets_project_archived_idx ON tickets(project, archived);
    CREATE INDEX IF NOT EXISTS tickets_project_ord_idx ON tickets(project, ord);
    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      project TEXT,
      data TEXT
    );
    CREATE INDEX IF NOT EXISTS stories_project_idx ON stories(project);
    CREATE TABLE IF NOT EXISTS external_links (
      ticket_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(ticket_id, provider, repo, number)
    );
    CREATE INDEX IF NOT EXISTS external_links_provider_repo_number_idx ON external_links(provider, repo, number);
    CREATE TABLE IF NOT EXISTS globals (
      key TEXT PRIMARY KEY,
      data TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');
  `));

  const schemaRow = prepareCached(database, "SELECT value FROM meta WHERE key = 'schema_version'").get();
  let schemaVersion = Number(schemaRow && JSON.parse(schemaRow.value as string));
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) schemaVersion = 1;
  if (schemaVersion < 2) {
    txn(database, () => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS categories (
          id TEXT PRIMARY KEY,
          data TEXT
        )
      `);
      for (const category of DEFAULT_CATEGORIES) {
        prepareCached(database, 'INSERT OR IGNORE INTO categories (id, data) VALUES (?, ?)').run(category.id, JSON.stringify(category));
      }
      prepareCached(database, "UPDATE meta SET value = ? WHERE key = 'schema_version'").run(JSON.stringify(2));
    });
    schemaVersion = 2;
  }
  if (schemaVersion > CURRENT_SCHEMA_VERSION) throw newerSchemaError(schemaVersion);
  if (schemaVersion < 3) {
    txn(database, () => {
      const prefsRow = prepareCached(database, "SELECT data FROM globals WHERE key = 'model-prefs'").get();
      const prefs = parseStoredRecord(prefsRow?.data);
      const discovered = discoverExternalModels();
      const byKey = new Map(discovered.map((entry) => [`${entry.source}:${entry.slug}`, entry]));
      const bySlug = new Map(discovered.map((entry) => [entry.slug, entry]));
      const rows = prepareCached(database, 'SELECT id, data FROM categories').all();
      for (const row of rows) {
        const category = parseStoredRecord(row.data);
        const seeded = DEFAULT_CATEGORIES.find((entry) => entry.id === row.id);
        if (seeded && JSON.stringify(category) === JSON.stringify(seeded)) continue;
        const route = isRecord(category.route) ? category.route : null;
        const oldModel = String(route?.model ?? '').trim().toLowerCase();
        const runtime = LEGACY_RUNTIME[oldModel];
        if (!runtime || !route) continue;
        const tierBackend = isRecord(prefs.tierBackend) ? prefs.tierBackend : null;
        const configured = tierBackend?.[oldModel] ?? tierBackend?.[runtime];
        const selected = typeof configured === 'string' ? configured.trim().toLowerCase() : 'claude';
        const entry = byKey.get(selected) ?? bySlug.get(selected);
        const model = selected !== 'claude' && !LEGACY_RUNTIME[selected] && entry ? entry.slug : runtime;
        const effort = route.effort;
        category.route = { model, effort };
        category.fallback = { model: runtime, effort };
        prepareCached(database, 'UPDATE categories SET data = ? WHERE id = ?')
          .run(JSON.stringify(category) as string, row.id as SQLInputValue);
      }
      prepareCached(database, "DELETE FROM globals WHERE key = 'model-prefs'").run();
      const fallbackRow = prepareCached(database, "SELECT data FROM globals WHERE key = 'routing-fallback'").get();
      let validFallback = false;
      try {
        const fallback = fallbackRow && JSON.parse(fallbackRow.data as string) as unknown;
        validFallback = isRecord(fallback) && typeof fallback.model === 'string' && typeof fallback.effort === 'string';
      } catch {
        validFallback = false;
      }
      if (!validFallback) {
        prepareCached(database, "INSERT INTO globals (key, data) VALUES ('routing-fallback', ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data")
          .run(JSON.stringify(ROUTING_FALLBACK_DEFAULT));
      }
      prepareCached(database, "UPDATE meta SET value = ? WHERE key = 'schema_version'").run(JSON.stringify(3));
    });
    schemaVersion = 3;
  }
  if (schemaVersion < 4) {
    txn(database, () => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS project_categories (
          project TEXT,
          id TEXT,
          kind TEXT,
          data TEXT,
          PRIMARY KEY (project, id)
        );
        CREATE INDEX IF NOT EXISTS project_categories_project_idx ON project_categories(project);
      `);
      prepareCached(database, "UPDATE meta SET value = ? WHERE key = 'schema_version'").run(JSON.stringify(4));
    });
    schemaVersion = 4;
  }
  if (schemaVersion < 5) {
    txn(database, () => {
      const row = prepareCached(database, "SELECT data FROM categories WHERE id = 'codebase-exploration'").get();
      let category: Record<string, unknown> | null = null;
      try {
        const parsed = row ? JSON.parse(row.data as string) as unknown : null;
        category = isRecord(parsed) ? parsed : null;
      } catch {
        category = null;
      }
      if (category
        && category.description === OLD_CODEBASE_EXPLORATION.description
        && category.contract === OLD_CODEBASE_EXPLORATION.contract) {
        const next = DEFAULT_CATEGORIES.find((entry) => entry.id === 'codebase-exploration');
        if (next) {
          category.description = next.description;
          category.contract = next.contract;
          prepareCached(database, "UPDATE categories SET data = ? WHERE id = 'codebase-exploration'").run(JSON.stringify(category));
        }
      }
      prepareCached(database, "UPDATE meta SET value = ? WHERE key = 'schema_version'").run(JSON.stringify(5));
    });
    schemaVersion = 5;
  }
  if (schemaVersion < 6) {
    txn(database, () => {
      const row = prepareCached(database, "SELECT data FROM categories WHERE id = 'codebase-exploration'").get();
      let category: Record<string, unknown> | null = null;
      try {
        const parsed = row ? JSON.parse(row.data as string) as unknown : null;
        category = isRecord(parsed) ? parsed : null;
      } catch {
        category = null;
      }
      if (category
        && (category.contract === V5_CODEBASE_EXPLORATION_CONTRACT
          || category.contract === DEFAULT_CATEGORIES.find((entry) => entry.id === 'codebase-exploration')?.contract)
        && !Object.hasOwn(category, 'artifactRoots')) {
        const next = DEFAULT_CATEGORIES.find((entry) => entry.id === 'codebase-exploration');
        if (next) {
          category.contract = next.contract;
          category.artifactRoots = 'artifactRoots' in next ? next.artifactRoots : [];
          prepareCached(database, "UPDATE categories SET data = ? WHERE id = 'codebase-exploration'").run(JSON.stringify(category));
        }
      }
      prepareCached(database, "UPDATE meta SET value = ? WHERE key = 'schema_version'").run(JSON.stringify(6));
    });
    schemaVersion = 6;
  }
  if (schemaVersion < 7) {
    txn(database, () => {
      const migratedAt = new Date().toISOString();
      const legacyCategories = categoryRows(database);
      validateGeneral('coding', legacyCategories);
      // Deleted boards can leave orphan layer rows behind; v7's FK to projects
      // rejects them, so migrate only rows whose board still exists.
      const orphanRowCount = Number(prepareCached(database, `
        SELECT COUNT(*) AS count FROM project_categories pc
        LEFT JOIN projects p ON p.slug = pc.project
        WHERE p.slug IS NULL
      `).get()?.count ?? 0);
      if (orphanRowCount > 0) {
        console.warn(`sidequest: schema v7 migration dropping ${orphanRowCount} category row(s) left behind by deleted boards`);
      }
      const legacyProjectRows = prepareCached(database, `
        SELECT pc.project, pc.id, pc.kind, pc.data FROM project_categories pc
        JOIN projects p ON p.slug = pc.project
        ORDER BY pc.project, pc.id
      `).all()
        .map((row) => {
          let data: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(row.data as string) as unknown;
            if (isRecord(parsed)) data = parsed;
          } catch {
            data = {};
          }
          return { project: String(row.project), id: String(row.id), kind: String(row.kind), data };
        });
      const beforeDigests = new Map<string, string>();
      for (const row of prepareCached(database, 'SELECT slug FROM projects ORDER BY slug').all()) {
        const project = String(row.slug);
        const localRows = legacyProjectRows.filter((entry) => entry.project === project);
        beforeDigests.set(project, categoryDigest(applyCategoryRows(legacyCategories, localRows)));
      }

      database.exec(`
        CREATE TABLE routing_profiles (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL CHECK (source IN ('seed','migrated','user')),
          seed_key TEXT,
          seed_revision INTEGER,
          revision INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          retired_at TEXT
        );
        CREATE UNIQUE INDEX routing_profiles_name_ci ON routing_profiles(lower(name));
        CREATE UNIQUE INDEX routing_profiles_seed_key_idx ON routing_profiles(seed_key)
          WHERE seed_key IS NOT NULL;

        CREATE TABLE routing_profile_entries (
          profile_id TEXT NOT NULL,
          category_id TEXT NOT NULL,
          data TEXT NOT NULL,
          position REAL NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (profile_id, category_id),
          FOREIGN KEY (profile_id) REFERENCES routing_profiles(id) ON DELETE RESTRICT
        );
        CREATE INDEX routing_profile_entries_profile_idx
          ON routing_profile_entries(profile_id, position, category_id);

        CREATE TABLE project_routing_profiles (
          project TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL,
          assigned_at TEXT NOT NULL,
          assigned_by TEXT,
          FOREIGN KEY (project) REFERENCES projects(slug) ON DELETE CASCADE,
          FOREIGN KEY (profile_id) REFERENCES routing_profiles(id) ON DELETE RESTRICT
        );
        CREATE INDEX project_routing_profiles_profile_idx
          ON project_routing_profiles(profile_id, project);

        CREATE TABLE routing_profile_settings (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          new_project_profile_id TEXT NOT NULL,
          FOREIGN KEY (new_project_profile_id) REFERENCES routing_profiles(id) ON DELETE RESTRICT
        );

        CREATE TABLE project_categories_v7 (
          project TEXT NOT NULL,
          id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('ADD','OVERRIDE','DETACH','DISABLE')),
          base_profile_id TEXT,
          base_data TEXT,
          data TEXT NOT NULL,
          PRIMARY KEY (project, id),
          FOREIGN KEY (project) REFERENCES projects(slug) ON DELETE CASCADE
        );
        CREATE INDEX project_categories_v7_project_idx ON project_categories_v7(project);
      `);

      const starterProfiles = starterRoutingProfilesFor(capabilityModels());
      const codingSeed = starterProfiles.find((profile) => profile.id === 'coding');
      if (!codingSeed) throw new Error('The coding routing profile seed is missing.');
      const codingMatchesSeed = categoryDigest(legacyCategories) === categoryDigest(DEFAULT_CATEGORIES as unknown as Record<string, unknown>[]);
      const codingCategories = codingMatchesSeed
        ? DEFAULT_CATEGORIES as unknown as Record<string, unknown>[]
        : legacyCategories;
      prepareCached(database, `
        INSERT INTO routing_profiles
          (id, name, description, source, seed_key, seed_revision, revision, created_at, updated_at, retired_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)
      `).run(
        codingSeed.id,
        codingSeed.name,
        codingSeed.description,
        codingMatchesSeed ? 'seed' : 'migrated',
        codingMatchesSeed ? codingSeed.id : null,
        codingMatchesSeed ? ROUTING_PROFILE_SEED_REVISION : null,
        migratedAt,
        migratedAt,
      );
      codingCategories.forEach((category, position) => {
        const id = String(category.id).trim().toLowerCase();
        prepareCached(database, `
          INSERT INTO routing_profile_entries (profile_id, category_id, data, position, updated_at)
          VALUES ('coding', ?, ?, ?, ?)
        `).run(id, JSON.stringify(category), position, migratedAt);
      });

      for (const profile of starterProfiles) {
        if (profile.id === 'coding') continue;
        validateGeneral(profile.id, profile.categories as unknown as Record<string, unknown>[]);
        prepareCached(database, `
          INSERT INTO routing_profiles
            (id, name, description, source, seed_key, seed_revision, revision, created_at, updated_at, retired_at)
          VALUES (?, ?, ?, 'seed', ?, ?, 1, ?, ?, NULL)
        `).run(profile.id, profile.name, profile.description, profile.id, ROUTING_PROFILE_SEED_REVISION, migratedAt, migratedAt);
        profile.categories.forEach((category, position) => {
          prepareCached(database, `
            INSERT INTO routing_profile_entries (profile_id, category_id, data, position, updated_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(profile.id, category.id, JSON.stringify(category), position, migratedAt);
        });
      }

      prepareCached(database, `
        INSERT INTO project_routing_profiles (project, profile_id, assigned_at, assigned_by)
        SELECT slug, 'coding', ?, 'schema-v7' FROM projects
      `).run(migratedAt);
      prepareCached(database, `
        INSERT INTO routing_profile_settings (singleton, new_project_profile_id) VALUES (1, 'coding')
      `).run();

      const codingById = new Map(codingCategories.map((category) => [String(category.id).trim().toLowerCase(), category]));
      for (const row of legacyProjectRows) {
        const based = ['OVERRIDE', 'DETACH', 'DISABLE'].includes(row.kind);
        const baseData = row.kind === 'OVERRIDE' ? codingById.get(row.id) ?? null : null;
        prepareCached(database, `
          INSERT INTO project_categories_v7 (project, id, kind, base_profile_id, base_data, data)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(row.project, row.id, row.kind, based ? 'coding' : null, baseData ? JSON.stringify(baseData) : null, JSON.stringify(row.data));
      }

      const profileCounts = prepareCached(database, `
        SELECT p.id, COUNT(e.category_id) AS count
        FROM routing_profiles p LEFT JOIN routing_profile_entries e ON e.profile_id = p.id
        GROUP BY p.id
      `).all();
      if (profileCounts.some((row) => Number(row.count) < 1)) throw new Error('Every routing profile must contain at least one category.');
      const missingPointers = prepareCached(database, `
        SELECT COUNT(*) AS count FROM projects p
        LEFT JOIN project_routing_profiles rp ON rp.project = p.slug
        WHERE rp.project IS NULL
      `).get();
      if (Number(missingPointers?.count ?? 0) !== 0) throw new Error('Every board must point at a routing profile.');
      if (legacyProjectRows.length !== Number(prepareCached(database, 'SELECT COUNT(*) AS count FROM project_categories_v7').get()?.count ?? 0)) {
        throw new Error('Project category migration row count mismatch.');
      }
      for (const [project, beforeDigest] of beforeDigests) {
        const localRows = legacyProjectRows.filter((entry) => entry.project === project);
        const afterDigest = categoryDigest(applyCategoryRows(codingCategories, localRows));
        if (afterDigest !== beforeDigest) throw new Error(`Effective routing taxonomy changed while migrating ${project}.`);
      }

      database.exec(`
        DROP TABLE project_categories;
        ALTER TABLE project_categories_v7 RENAME TO project_categories;
        DROP INDEX project_categories_v7_project_idx;
        CREATE INDEX project_categories_project_idx ON project_categories(project);
        CREATE TRIGGER categories_legacy_read_only_insert BEFORE INSERT ON categories
          BEGIN SELECT RAISE(ABORT, 'categories is a read-only legacy snapshot'); END;
        CREATE TRIGGER categories_legacy_read_only_update BEFORE UPDATE ON categories
          BEGIN SELECT RAISE(ABORT, 'categories is a read-only legacy snapshot'); END;
        CREATE TRIGGER categories_legacy_read_only_delete BEFORE DELETE ON categories
          BEGIN SELECT RAISE(ABORT, 'categories is a read-only legacy snapshot'); END;
      `);
      prepareCached(database, "UPDATE meta SET value = ? WHERE key = 'schema_version'").run(JSON.stringify(7));
    });
    schemaVersion = 7;
  }
  if (schemaVersion < 8) {
    txn(database, () => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS external_links (
          ticket_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          repo TEXT NOT NULL,
          number INTEGER NOT NULL,
          url TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(ticket_id, provider, repo, number)
        );
        CREATE INDEX IF NOT EXISTS external_links_provider_repo_number_idx ON external_links(provider, repo, number);
      `);
      prepareCached(database, "UPDATE meta SET value = ? WHERE key = 'schema_version'").run(JSON.stringify(8));
    });
    schemaVersion = 8;
  }
}

export function getRow<T = unknown, N extends TableName = TableName>(
  database: DatabaseSync,
  table: N,
  key: DatabaseTableKeyMap[N],
): T | null {
  const spec = tableSpec(table);
  const payload = payloadColumn(spec);
  const selection = payload ?? spec.columns.join(', ');
  const row = retryWhenSqliteBusy(`reading ${table}`, () => prepareCached(database, `SELECT ${selection} FROM ${table} WHERE ${keyWhere(spec)}`).get(...keyValues(spec, key)));
  return row ? parseTableRow(spec, row) as T : null;
}

export function assertWritable(database: DatabaseSync): void {
  const row = retryWhenSqliteBusy('checking schema version', () => prepareCached(database, "SELECT value FROM meta WHERE key = 'schema_version'").get());
  const version = Number(row && JSON.parse(row.value as string));
  if (version > CURRENT_SCHEMA_VERSION) throw newerSchemaError(version, database, 'refusing write');
}

export function putRow<N extends TableName>(database: DatabaseSync, table: N, rowObject: DatabaseTableRowMap[N]): ChangeCount {
  assertWritable(database);
  const spec = tableSpec(table);
  const object = rowObject as unknown as Record<string, unknown>;
  const values = spec.columns.map((column) => encodeColumn(spec, column, object[column]));
  const assignments = spec.columns
    .filter((column) => !keyColumns(spec).includes(column))
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');
  const placeholders = spec.columns.map(() => '?').join(', ');
  return retryWhenSqliteBusy(`writing ${table}`, () => prepareCached(database, `
    INSERT INTO ${table} (${spec.columns.join(', ')}) VALUES (${placeholders})
    ON CONFLICT(${keyColumns(spec).join(', ')}) DO UPDATE SET ${assignments}
  `).run(...values).changes);
}

export function deleteRow<N extends TableName>(database: DatabaseSync, table: N, key: DatabaseTableKeyMap[N]): boolean {
  assertWritable(database);
  return retryWhenSqliteBusy(`deleting from ${table}`, () => prepareCached(database, `DELETE FROM ${table} WHERE ${keyWhere(tableSpec(table))}`).run(...keyValues(tableSpec(table), key)).changes !== 0);
}

export function listRows<T = unknown, N extends TableName = TableName>(
  database: DatabaseSync,
  table: N,
  whereObj?: RowFilter<N>,
): T[] {
  const spec = tableSpec(table);
  const payload = payloadColumn(spec);
  const selection = payload ?? spec.columns.join(', ');
  const filters = filtersFor(table, whereObj);
  const orderBy = spec.orderBy ? ` ORDER BY ${spec.orderBy}` : '';
  const rows = retryWhenSqliteBusy(`listing ${table}`, () => prepareCached(database, `SELECT ${selection} FROM ${table}${whereClause(filters)}${orderBy}`)
    .all(...filters.map(([, value]) => value)));
  return rows.map((row) => parseTableRow(spec, row) as T);
}

export function listRowsPage<T = unknown, N extends TableName = TableName>(
  database: DatabaseSync,
  table: N,
  whereObj: RowFilter<N> | undefined,
  options: PageOptions,
): T[] {
  if (!Number.isInteger(options.limit) || options.limit < 0) throw new RangeError('Page limit must be a non-negative integer.');
  const offset = options.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) throw new RangeError('Page offset must be a non-negative integer.');
  const spec = tableSpec(table);
  const payload = payloadColumn(spec);
  const selection = payload ?? spec.columns.join(', ');
  const filters = filtersFor(table, whereObj);
  const orderBy = spec.orderBy ? ` ORDER BY ${spec.orderBy}` : '';
  const rows = retryWhenSqliteBusy(`listing ${table} page`, () => prepareCached(database, `SELECT ${selection} FROM ${table}${whereClause(filters)}${orderBy} LIMIT ? OFFSET ?`)
    .all(...filters.map(([, value]) => value), options.limit, offset));
  return rows.map((row) => parseTableRow(spec, row) as T);
}

export function countRows<N extends TableName>(database: DatabaseSync, table: N, whereObj?: RowFilter<N>): number {
  const filters = filtersFor(table, whereObj);
  const row = retryWhenSqliteBusy(`counting ${table}`, () => prepareCached(database, `SELECT COUNT(*) AS count FROM ${table}${whereClause(filters)}`)
    .get(...filters.map(([, value]) => value)));
  return Number(row?.count ?? 0);
}

export function hasRow<N extends TableName>(database: DatabaseSync, table: N, key: DatabaseTableKeyMap[N]): boolean {
  const spec = tableSpec(table);
  return retryWhenSqliteBusy(`checking ${table}`, () => prepareCached(database, `SELECT 1 FROM ${table} WHERE ${keyWhere(spec)} LIMIT 1`).get(...keyValues(spec, key)) !== undefined);
}

export function txn<T>(database: DatabaseSync, fn: () => T): T {
  const row = retryWhenSqliteBusy('checking schema version before a transaction', () => prepareCached(database, "SELECT value FROM meta WHERE key = 'schema_version'").get());
  if (row) assertWritable(database);
  return retryWhenSqliteBusy('writing transaction', () => {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      if (isRecord(result) && typeof result.then === 'function') {
        throw new TypeError('SQLite transaction callbacks must be synchronous.');
      }
      database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Preserve the operation error if a rollback is no longer possible.
      }
      throw error;
    }
  });
}
