'use strict';
/**
 * Move whole boards from one SIDEQUEST_HOME to another (SQ-297).
 *
 * A board is keyed by the slug of its repository path, so the slug, every ticket id, and every
 * ref survive the move unchanged: nothing is re-minted, no refs/sidequest/* pointer goes stale,
 * and a commit message naming SQ-12 still names the same ticket afterwards.
 *
 * What moves, per board:
 *   - board-owned rows: projects, tickets (comments, claims history, submissions and dispatch
 *     records live in the ticket document), stories, external_links, project_categories,
 *     project_routing_profiles;
 *   - shared rows the board references (the routing profiles it is assigned or detaches from,
 *     with their category entries) are COPIED when the destination lacks them and never removed
 *     from the source, because other boards there may use them; a destination profile with the
 *     same id is kept as is, and a different destination profile with the same name refuses the
 *     move. The legacy `categories` table is a read-only snapshot and is not carried;
 *   - this board's notifications;
 *   - files under projects/<slug>/ (assets, verification logs, evidence, plans), and dispatch
 *     token files the board's tickets name. Paths inside ticket, story and board documents that
 *     point at those moved files are rewritten to the destination home.
 *
 * What stays: existing worktrees. They are Git worktrees registered with the repository, so
 * their absolute paths stay valid where they are; dispatches after the move create new ones
 * under <destination>/worktrees/<slug>. Remove the old ones with `git worktree remove` once
 * their submissions are integrated.
 *
 * Crash safety: files are copied first, then one source write transaction re-reads the board,
 * re-checks every refusal, inserts into the destination inside its own transaction, verifies
 * per-table row counts there, and only then deletes the source rows. A crash before the
 * destination commits leaves the source untouched; a crash after it leaves the board in both
 * homes, and re-running the same move replaces the partial destination copy and finishes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, txn } from './db.js';
import { migrateIfNeeded } from './migrate.js';

const { publishLockStatus } = require('./publish.js');

type Row = Record<string, any>;

// Board-owned tables, in insert order (parents first). Deletion runs in reverse.
export const BOARD_TABLES = [
  'projects',
  'project_routing_profiles',
  'project_categories',
  'stories',
  'tickets',
  'external_links',
] as const;
export type BoardTable = typeof BOARD_TABLES[number];

const TICKET_STATUSES = ['todo', 'doing', 'awaiting-oracle', 'done'];

export interface BoardMoveBlocker {
  kind: 'claim' | 'dispatch' | 'publish-lock' | 'collision';
  ref: string | null;
  detail: string;
}

export interface BoardMovePlan {
  slug: string;
  name: string;
  path: string;
  destination: 'new' | 'replace';
  tickets: { total: number; archived: number; byStatus: Record<string, number> };
  rows: Record<BoardTable, number>;
  notifications: number;
  shared: {
    routingProfiles: { copy: string[]; kept: string[] };
    routingProfileEntries: number;
  };
  files: { from: string; to: string; count: number; bytes: number; list: string[] };
  dispatchTokens: Array<{ from: string; to: string }>;
  rewrittenPaths: number;
  gitRefs: string[];
  worktrees: { from: string; exists: boolean; rule: string };
  blockers: BoardMoveBlocker[];
  verified?: Record<BoardTable, number>;
}

export interface BoardMoveResult {
  ok: boolean;
  dryRun: boolean;
  sourceHome: string;
  destHome: string;
  boards: BoardMovePlan[];
  refused?: string;
}

interface Snapshot {
  slug: string;
  meta: any;
  rows: Record<BoardTable, Row[]>;
  notifications: any[];
  profiles: Row[];
  profileEntries: Row[];
}

function all(handle: DatabaseSync, sql: string, ...params: any[]): Row[] {
  return handle.prepare(sql).all(...params) as Row[];
}

function one(handle: DatabaseSync, sql: string, ...params: any[]): Row | undefined {
  return handle.prepare(sql).get(...params) as Row | undefined;
}

function insertRow(handle: DatabaseSync, table: string, row: Row, verb = 'INSERT'): void {
  const columns = Object.keys(row);
  handle.prepare(`${verb} INTO ${table} (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...columns.map((c) => row[c]));
}

function parse(text: any): any {
  try { return JSON.parse(String(text)); } catch { return null; }
}

function placeholders(values: unknown[]): string {
  return values.map(() => '?').join(', ');
}

function realOrResolved(dir: string): string {
  const resolved = path.resolve(dir);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function readGlobal(handle: DatabaseSync, key: string): any {
  const row = one(handle, 'SELECT data FROM globals WHERE key = ?', key);
  return row ? parse(row.data) : null;
}

function writeGlobal(handle: DatabaseSync, key: string, value: unknown): void {
  handle.prepare('INSERT INTO globals (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data').run(key, JSON.stringify(value));
}

function notificationList(handle: DatabaseSync): any[] {
  const data = readGlobal(handle, 'notifications');
  return data && Array.isArray(data.notifications) ? data.notifications : [];
}

function resolveBoard(handle: DatabaseSync, ref: string): { slug: string; meta: any } {
  const arg = String(ref || '').trim();
  const projects = all(handle, 'SELECT slug, data FROM projects ORDER BY slug')
    .map((row) => ({ slug: String(row.slug), meta: parse(row.data) || {} }));
  const bySlug = projects.find((project) => project.slug === arg);
  if (bySlug) return bySlug;
  const byName = projects.filter((project) => String(project.meta.name || project.slug).trim().toLowerCase() === arg.toLowerCase());
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new Error(`board "${arg}" matches ${byName.length} boards by name (${byName.map((p) => p.slug).join(', ')}); pass the slug or path.`);
  }
  if (path.isAbsolute(arg)) {
    const wanted = realOrResolved(arg);
    const byPath = projects.find((project) => project.meta.path && realOrResolved(project.meta.path) === wanted);
    if (byPath) return byPath;
  }
  const known = projects.map((project) => project.meta.name || project.slug).join(', ');
  throw new Error(`board "${arg}" does not match any board in the source home.${known ? ` Known: ${known}` : ''}`);
}

function snapshot(source: DatabaseSync, slug: string): Snapshot {
  const projectRow = one(source, 'SELECT * FROM projects WHERE slug = ?', slug);
  if (!projectRow) throw new Error(`board "${slug}" no longer exists in the source home.`);
  const tickets = all(source, 'SELECT * FROM tickets WHERE project = ? ORDER BY id', slug);
  const ticketIds = tickets.map((row) => String(row.id));
  const rows: Record<BoardTable, Row[]> = {
    projects: [projectRow],
    project_routing_profiles: all(source, 'SELECT * FROM project_routing_profiles WHERE project = ?', slug),
    project_categories: all(source, 'SELECT * FROM project_categories WHERE project = ? ORDER BY id', slug),
    stories: all(source, 'SELECT * FROM stories WHERE project = ? ORDER BY id', slug),
    tickets,
    external_links: ticketIds.length
      ? all(source, `SELECT * FROM external_links WHERE ticket_id IN (${placeholders(ticketIds)})`, ...ticketIds)
      : [],
  };
  const profileIds = new Set<string>();
  for (const row of rows.project_routing_profiles) profileIds.add(String(row.profile_id));
  for (const row of rows.project_categories) if (row.base_profile_id) profileIds.add(String(row.base_profile_id));
  const ids = [...profileIds];
  const profiles = ids.length ? all(source, `SELECT * FROM routing_profiles WHERE id IN (${placeholders(ids)})`, ...ids) : [];
  const profileEntries = ids.length ? all(source, `SELECT * FROM routing_profile_entries WHERE profile_id IN (${placeholders(ids)})`, ...ids) : [];
  const notifications = notificationList(source).filter((entry: any) => entry && entry.projectSlug === slug);
  return { slug, meta: parse(projectRow.data) || {}, rows, notifications, profiles, profileEntries };
}

function listFiles(root: string): { list: string[]; bytes: number } {
  const list: string[] = [];
  let bytes = 0;
  const walk = (dir: string, prefix: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.isFile() && !entry.name.endsWith('.lock')) {
        list.push(relative);
        try { bytes += fs.statSync(full).size; } catch { /* vanished */ }
      }
    }
  };
  walk(root, '');
  list.sort();
  return { list, bytes };
}

function gitRefs(repo: string, refs: Set<string>): string[] {
  if (!repo || !fs.existsSync(repo)) return [];
  try {
    const out = execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/sidequest/'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').map((line) => line.trim()).filter((name) => name && refs.has(name.slice('refs/sidequest/'.length).toUpperCase())).sort();
  } catch {
    return [];
  }
}

interface Rewriter {
  rewrite(value: any): { value: any; count: number };
}

function pathRewriter(sourceHome: string, destHome: string, slug: string): Rewriter {
  const homes = [...new Set([path.resolve(sourceHome), realOrResolved(sourceHome)])];
  const destination = path.resolve(destHome);
  const prefixes: Array<{ from: string; to: string; exact: boolean }> = [];
  for (const home of homes) {
    prefixes.push({ from: path.join(home, 'projects', slug), to: path.join(destination, 'projects', slug), exact: true });
    prefixes.push({ from: path.join(home, 'dispatch-tokens') + path.sep, to: path.join(destination, 'dispatch-tokens') + path.sep, exact: false });
  }
  const swap = (text: string): string | null => {
    for (const prefix of prefixes) {
      if (prefix.exact) {
        if (text === prefix.from) return prefix.to;
        if (text.startsWith(prefix.from + path.sep)) return prefix.to + text.slice(prefix.from.length);
      } else if (text.startsWith(prefix.from)) {
        return prefix.to + text.slice(prefix.from.length);
      }
    }
    return null;
  };
  return {
    rewrite(value: any) {
      let count = 0;
      const walk = (node: any): any => {
        if (typeof node === 'string') {
          const swapped = swap(node);
          if (swapped === null) return node;
          count += 1;
          return swapped;
        }
        if (Array.isArray(node)) return node.map(walk);
        if (node && typeof node === 'object') {
          const out: Row = {};
          for (const [key, child] of Object.entries(node)) out[key] = walk(child);
          return out;
        }
        return node;
      };
      return { value: walk(value), count };
    },
  };
}

function rewriteRows(rows: Row[], rewriter: Rewriter): { rows: Row[]; count: number } {
  let count = 0;
  const out = rows.map((row) => {
    if (typeof row.data !== 'string') return row;
    const parsed = parse(row.data);
    if (parsed === null) return row;
    const result = rewriter.rewrite(parsed);
    if (!result.count) return row;
    count += result.count;
    return { ...row, data: JSON.stringify(result.value) };
  });
  return { rows: out, count };
}

function ticketLabel(row: Row): string {
  return String(row.ref || row.id);
}

function blockersFor(snap: Snapshot): BoardMoveBlocker[] {
  const blockers: BoardMoveBlocker[] = [];
  for (const row of snap.rows.tickets) {
    const ticket = parse(row.data) || {};
    const claimBy = ticket.claim?.by || row.claim_by;
    if (claimBy) {
      blockers.push({
        kind: 'claim',
        ref: ticketLabel(row),
        detail: `${ticketLabel(row)} is claimed by "${claimBy}"${ticket.claim?.at ? ` since ${ticket.claim.at}` : ''}; release it (or sweep a dead claim) before moving the board`,
      });
    }
    const dispatch = ticket.dispatch && typeof ticket.dispatch === 'object' ? ticket.dispatch : null;
    if (dispatch && !dispatch.terminalAt && (dispatch.launchedAt || dispatch.boundAt)) {
      const state = dispatch.boundAt ? `bound at ${dispatch.boundAt}` : `launched at ${dispatch.launchedAt}`;
      blockers.push({
        kind: 'dispatch',
        ref: ticketLabel(row),
        detail: `${ticketLabel(row)} has a live dispatch ${dispatch.agentName || dispatch.agentId || '(unnamed)'} ${state}; let it finish or release it first`,
      });
    }
  }
  return blockers;
}

async function publishLockBlocker(meta: any): Promise<BoardMoveBlocker | null> {
  const repo = String(meta?.path || '');
  if (!repo || !fs.existsSync(repo)) return null;
  let status: any;
  try { status = await publishLockStatus(repo); } catch { return null; }
  if (!status?.locked || status.stale) return null;
  const holder = status.holder || {};
  const who = holder.by || holder.sessionId || (holder.pid ? `pid ${holder.pid}` : 'an unknown holder');
  return { kind: 'publish-lock', ref: null, detail: `publish lock ${status.file} is held by ${who}${holder.at ? ` since ${holder.at}` : ''}` };
}

function destinationState(dest: DatabaseSync | null, snap: Snapshot): { destination: 'new' | 'replace'; blockers: BoardMoveBlocker[] } {
  if (!dest) return { destination: 'new', blockers: [] };
  const blockers: BoardMoveBlocker[] = [];
  const sourceTickets = new Set(snap.rows.tickets.map((row) => String(row.id)));
  const sourceStories = new Set(snap.rows.stories.map((row) => String(row.id)));
  const existing = one(dest, 'SELECT slug FROM projects WHERE slug = ?', snap.slug);
  if (existing) {
    // Only a destination copy of THIS board's own rows may be replaced: an empty board a session
    // auto-created there, or a partial copy left by an interrupted move. A destination board that
    // has tickets or stories the source does not hold has been worked in, and replacing it would
    // drop that work.
    const foreignTickets = all(dest, 'SELECT id, ref FROM tickets WHERE project = ?', snap.slug).filter((row) => !sourceTickets.has(String(row.id)));
    const foreignStories = all(dest, 'SELECT id FROM stories WHERE project = ?', snap.slug).filter((row) => !sourceStories.has(String(row.id)));
    if (foreignTickets.length || foreignStories.length) {
      blockers.push({
        kind: 'collision',
        ref: null,
        detail: `the destination already holds board ${snap.slug} with ${foreignTickets.length} ticket(s) and ${foreignStories.length} story(ies) the source does not (${foreignTickets.slice(0, 10).map(ticketLabel).join(', ') || 'stories only'}); merging two live copies of one board would collide refs, so move or remove that copy first`,
      });
    }
  }
  const ticketIds = [...sourceTickets];
  if (ticketIds.length) {
    for (const row of all(dest, `SELECT id, ref, project FROM tickets WHERE id IN (${placeholders(ticketIds)}) AND project != ?`, ...ticketIds, snap.slug)) {
      blockers.push({ kind: 'collision', ref: ticketLabel(row), detail: `ticket id ${row.id} already exists in the destination on board ${row.project}` });
    }
  }
  const storyIds = [...sourceStories];
  if (storyIds.length) {
    for (const row of all(dest, `SELECT id, project FROM stories WHERE id IN (${placeholders(storyIds)}) AND project != ?`, ...storyIds, snap.slug)) {
      blockers.push({ kind: 'collision', ref: null, detail: `story id ${row.id} already exists in the destination on board ${row.project}` });
    }
  }
  for (const profile of snap.profiles) {
    if (one(dest, 'SELECT 1 AS present FROM routing_profiles WHERE id = ?', profile.id)) continue;
    const clash = one(dest, 'SELECT id FROM routing_profiles WHERE lower(name) = lower(?) OR (seed_key IS NOT NULL AND seed_key = ?)', profile.name, profile.seed_key ?? null);
    if (clash) {
      blockers.push({
        kind: 'collision',
        ref: null,
        detail: `routing profile "${profile.name}" (${profile.id}) would be copied, but the destination already has a different profile ${clash.id} with that name or seed; rename one of them first`,
      });
    }
  }
  return { destination: existing ? 'replace' : 'new', blockers };
}

function sharedPlan(dest: DatabaseSync | null, snap: Snapshot) {
  const has = (table: string, id: string) => Boolean(dest && one(dest, `SELECT 1 AS present FROM ${table} WHERE id = ?`, id));
  const profiles = { copy: [] as string[], kept: [] as string[] };
  for (const row of snap.profiles) (has('routing_profiles', String(row.id)) ? profiles.kept : profiles.copy).push(String(row.id));
  const copied = new Set(profiles.copy);
  return {
    routingProfiles: profiles,
    routingProfileEntries: snap.profileEntries.filter((row) => copied.has(String(row.profile_id))).length,
  };
}

function buildPlan(sourceHome: string, destHome: string, dest: DatabaseSync | null, snap: Snapshot): BoardMovePlan {
  const byStatus: Record<string, number> = Object.fromEntries(TICKET_STATUSES.map((status) => [status, 0]));
  let archived = 0;
  for (const row of snap.rows.tickets) {
    if (Number(row.archived)) archived += 1;
    const status = String(row.status || 'todo');
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  const rows = Object.fromEntries(BOARD_TABLES.map((table) => [table, snap.rows[table].length])) as Record<BoardTable, number>;
  const projectFrom = path.join(path.resolve(sourceHome), 'projects', snap.slug);
  const projectTo = path.join(path.resolve(destHome), 'projects', snap.slug);
  const files = listFiles(projectFrom);
  const rewriter = pathRewriter(sourceHome, destHome, snap.slug);
  const rewrittenPaths = (['projects', 'stories', 'tickets'] as const)
    .reduce((sum, table) => sum + rewriteRows(snap.rows[table], rewriter).count, 0);
  const dispatchTokens: Array<{ from: string; to: string }> = [];
  for (const row of snap.rows.tickets) {
    const tokenFile = parse(row.data)?.dispatch?.tokenFile;
    if (typeof tokenFile !== 'string' || !fs.existsSync(tokenFile)) continue;
    const moved = rewriter.rewrite(tokenFile);
    if (moved.count) dispatchTokens.push({ from: tokenFile, to: moved.value });
  }
  const refs = new Set(snap.rows.tickets.map((row) => String(row.ref || '').toUpperCase()).filter(Boolean));
  const worktreesFrom = path.join(path.resolve(sourceHome), 'worktrees', snap.slug);
  const { destination, blockers } = destinationState(dest, snap);
  return {
    slug: snap.slug,
    name: String(snap.meta.name || snap.slug),
    path: String(snap.meta.path || ''),
    destination,
    tickets: { total: snap.rows.tickets.length, archived, byStatus },
    rows,
    notifications: snap.notifications.length,
    shared: sharedPlan(dest, snap),
    files: { from: projectFrom, to: projectTo, count: files.list.length, bytes: files.bytes, list: files.list },
    dispatchTokens,
    rewrittenPaths,
    gitRefs: gitRefs(String(snap.meta.path || ''), refs),
    worktrees: {
      from: worktreesFrom,
      exists: fs.existsSync(worktreesFrom),
      rule: `existing worktrees stay at ${worktreesFrom} (their Git registration is unchanged); new dispatches create worktrees under ${path.join(path.resolve(destHome), 'worktrees', snap.slug)}`,
    },
    blockers: [...blockersFor(snap), ...blockers],
  };
}

function copyFiles(plan: BoardMovePlan): void {
  if (!fs.existsSync(plan.files.from)) return;
  fs.mkdirSync(plan.files.to, { recursive: true });
  fs.cpSync(plan.files.from, plan.files.to, {
    recursive: true,
    force: true,
    filter: (source) => !source.endsWith('.lock'),
  });
}

function verifyFiles(plan: BoardMovePlan): void {
  const missing = plan.files.list.filter((relative) => !fs.existsSync(path.join(plan.files.to, ...relative.split('/'))));
  if (missing.length) {
    throw new Error(`file copy did not verify: ${missing.length} file(s) missing under ${plan.files.to} (${missing.slice(0, 5).join(', ')})`);
  }
}

function copyTokens(plan: BoardMovePlan): void {
  for (const token of plan.dispatchTokens) {
    fs.mkdirSync(path.dirname(token.to), { recursive: true, mode: 0o700 });
    fs.copyFileSync(token.from, token.to);
    try { fs.chmodSync(token.to, 0o600); } catch { /* best effort on filesystems without modes */ }
  }
}

function insertBoard(dest: DatabaseSync, snap: Snapshot, plan: BoardMovePlan, rewriter: Rewriter): Record<BoardTable, number> {
  const copied = new Set(plan.shared.routingProfiles.copy);
  for (const row of snap.profiles) if (copied.has(String(row.id))) insertRow(dest, 'routing_profiles', row);
  for (const row of snap.profileEntries) if (copied.has(String(row.profile_id))) insertRow(dest, 'routing_profile_entries', row);

  // A replace clears this board's previous destination copy first, so the destination ends up
  // exactly equal to the source rather than a union of two snapshots.
  let destinationSeq = 0;
  let destinationStorySeq = 0;
  if (plan.destination === 'replace') {
    const previous = parse(one(dest, 'SELECT data FROM projects WHERE slug = ?', snap.slug)?.data) || {};
    destinationSeq = Number(previous.seq) || 0;
    destinationStorySeq = Number(previous.storySeq) || 0;
    deleteBoard(dest, snap.slug);
  }
  for (const table of BOARD_TABLES) {
    let rows = snap.rows[table];
    if (table === 'projects' || table === 'stories' || table === 'tickets') rows = rewriteRows(rows, rewriter).rows;
    if (table === 'projects' && (destinationSeq || destinationStorySeq)) {
      rows = rows.map((row) => {
        const meta = parse(row.data) || {};
        meta.seq = Math.max(Number(meta.seq) || 0, destinationSeq);
        meta.storySeq = Math.max(Number(meta.storySeq) || 0, destinationStorySeq);
        return { ...row, data: JSON.stringify(meta) };
      });
    }
    for (const row of rows) insertRow(dest, table, row);
  }
  if (snap.notifications.length) {
    const list = notificationList(dest);
    const present = new Set(list.map((entry: any) => entry?.id));
    for (const entry of snap.notifications) if (!present.has(entry.id)) list.push(entry);
    writeGlobal(dest, 'notifications', { notifications: list });
  }
  return countBoard(dest, snap);
}

function countBoard(handle: DatabaseSync, snap: Snapshot): Record<BoardTable, number> {
  const count = (sql: string, ...params: any[]) => Number(one(handle, sql, ...params)?.n || 0);
  const ticketIds = snap.rows.tickets.map((row) => String(row.id));
  return {
    projects: count('SELECT COUNT(*) AS n FROM projects WHERE slug = ?', snap.slug),
    project_routing_profiles: count('SELECT COUNT(*) AS n FROM project_routing_profiles WHERE project = ?', snap.slug),
    project_categories: count('SELECT COUNT(*) AS n FROM project_categories WHERE project = ?', snap.slug),
    stories: count('SELECT COUNT(*) AS n FROM stories WHERE project = ?', snap.slug),
    tickets: count('SELECT COUNT(*) AS n FROM tickets WHERE project = ?', snap.slug),
    external_links: ticketIds.length
      ? count(`SELECT COUNT(*) AS n FROM external_links WHERE ticket_id IN (${placeholders(ticketIds)})`, ...ticketIds)
      : 0,
  };
}

function deleteBoard(handle: DatabaseSync, slug: string): void {
  const ticketIds = all(handle, 'SELECT id FROM tickets WHERE project = ?', slug).map((row) => String(row.id));
  if (ticketIds.length) handle.prepare(`DELETE FROM external_links WHERE ticket_id IN (${placeholders(ticketIds)})`).run(...ticketIds);
  handle.prepare('DELETE FROM tickets WHERE project = ?').run(slug);
  handle.prepare('DELETE FROM stories WHERE project = ?').run(slug);
  handle.prepare('DELETE FROM project_categories WHERE project = ?').run(slug);
  handle.prepare('DELETE FROM project_routing_profiles WHERE project = ?').run(slug);
  handle.prepare('DELETE FROM projects WHERE slug = ?').run(slug);
}

function removeFromSource(source: DatabaseSync, slug: string): void {
  deleteBoard(source, slug);
  const list = notificationList(source);
  const kept = list.filter((entry: any) => !entry || entry.projectSlug !== slug);
  if (kept.length !== list.length) writeGlobal(source, 'notifications', { notifications: kept });
  // A sweep cursor names a worktree under the source home's root, which the destination's sweeper
  // never walks, so it is dropped rather than carried.
  source.prepare('DELETE FROM globals WHERE key = ?').run(`worktree-gc-candidate-cursor:${slug}`);
}

function sameCounts(a: Record<BoardTable, number>, b: Record<BoardTable, number>): boolean {
  return BOARD_TABLES.every((table) => a[table] === b[table]);
}

function openHome(home: string): DatabaseSync {
  const handle = openDb(home);
  migrateIfNeeded(handle, home);
  return handle;
}

export function describeBlockers(plan: BoardMovePlan): string {
  return plan.blockers.map((blocker) => `${blocker.kind}: ${blocker.detail}`).join('; ');
}

/**
 * Plan (dryRun) or perform a move of `boards` from `sourceHome` to `destHome`. Refusals are
 * reported per board in `blockers`; when any board is blocked nothing moves and `ok` is false.
 * Boards move one at a time, each in its own verified transaction pair.
 */
export async function moveBoards(options: { sourceHome: string; destHome: string; boards: string[]; dryRun?: boolean }): Promise<BoardMoveResult> {
  const sourceHome = path.resolve(String(options.sourceHome || ''));
  const destHome = path.resolve(String(options.destHome || ''));
  const dryRun = Boolean(options.dryRun);
  if (!options.destHome) throw new Error('pass --to-home <dir>: the SIDEQUEST_HOME to move the board(s) into.');
  if (!options.boards?.length) throw new Error('pass at least one board slug, display name, or registered path.');
  if (realOrResolved(sourceHome) === realOrResolved(destHome)) {
    throw new Error(`source and destination are the same home (${realOrResolved(sourceHome)}); nothing to move.`);
  }
  if (!fs.existsSync(path.join(sourceHome, 'sidequest.db'))) throw new Error(`no board database at ${path.join(sourceHome, 'sidequest.db')}.`);

  const source = openHome(sourceHome);
  const destDbExists = fs.existsSync(path.join(destHome, 'sidequest.db'));
  // A dry run never creates the destination: an absent database plans as empty.
  let dest: DatabaseSync | null = dryRun && !destDbExists ? null : openHome(destHome);
  try {
    const resolved: Array<{ slug: string; meta: any }> = [];
    for (const ref of options.boards) {
      const board = resolveBoard(source, ref);
      if (!resolved.some((entry) => entry.slug === board.slug)) resolved.push(board);
    }
    const plans: BoardMovePlan[] = [];
    for (const board of resolved) {
      const plan = buildPlan(sourceHome, destHome, dest, snapshot(source, board.slug));
      const lock = await publishLockBlocker(board.meta);
      if (lock) plan.blockers.push(lock);
      plans.push(plan);
    }
    const blocked = plans.filter((plan) => plan.blockers.length);
    if (blocked.length) {
      return {
        ok: false,
        dryRun,
        sourceHome,
        destHome,
        boards: plans,
        refused: blocked.map((plan) => `${plan.name} (${plan.slug}): ${describeBlockers(plan)}`).join(' | '),
      };
    }
    if (dryRun) return { ok: true, dryRun, sourceHome, destHome, boards: plans };

    const moved: BoardMovePlan[] = [];
    for (const planned of plans) {
      copyFiles(planned);
      copyTokens(planned);
      const destination = dest!;
      const finalPlan = txn(source, () => {
        // Re-read under the source write lock: the plan above ran without it, and a claim or
        // dispatch could have landed since. Anything moved is exactly what this snapshot holds.
        const snap = snapshot(source, planned.slug);
        const plan = buildPlan(sourceHome, destHome, destination, snap);
        if (plan.blockers.length) throw new Error(`refusing to move ${plan.name} (${plan.slug}): ${describeBlockers(plan)}`);
        verifyFiles(plan);
        const rewriter = pathRewriter(sourceHome, destHome, snap.slug);
        plan.verified = txn(destination, () => {
          const counts = insertBoard(destination, snap, plan, rewriter);
          if (!sameCounts(counts, plan.rows)) {
            throw new Error(`destination row counts did not verify for ${plan.slug}: expected ${JSON.stringify(plan.rows)}, found ${JSON.stringify(counts)}`);
          }
          return counts;
        });
        removeFromSource(source, snap.slug);
        return plan;
      });
      // Re-copy after the commit so a file written between the first copy and the lock still
      // lands, then retire the source copies.
      copyFiles(finalPlan);
      verifyFiles(finalPlan);
      fs.rmSync(finalPlan.files.from, { recursive: true, force: true });
      for (const token of finalPlan.dispatchTokens) fs.rmSync(token.from, { force: true });
      moved.push(finalPlan);
    }
    return { ok: true, dryRun, sourceHome, destHome, boards: moved };
  } finally {
    try { source.close(); } catch { /* already closed */ }
    try { dest?.close(); } catch { /* already closed */ }
    dest = null;
  }
}
