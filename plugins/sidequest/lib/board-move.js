"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all2) => {
  for (var name in all2)
    __defProp(target, name, { get: all2[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var board_move_exports = {};
__export(board_move_exports, {
  BOARD_TABLES: () => BOARD_TABLES,
  describeBlockers: () => describeBlockers,
  moveBoards: () => moveBoards
});
module.exports = __toCommonJS(board_move_exports);
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var import_node_child_process = require("node:child_process");
var import_db = require("./db.js");
var import_migrate = require("./migrate.js");
const { publishLockStatus } = require("./publish.js");
const BOARD_TABLES = [
  "projects",
  "project_routing_profiles",
  "project_categories",
  "stories",
  "tickets",
  "external_links"
];
const TICKET_STATUSES = ["todo", "doing", "awaiting-oracle", "done"];
function all(handle, sql, ...params) {
  return handle.prepare(sql).all(...params);
}
function one(handle, sql, ...params) {
  return handle.prepare(sql).get(...params);
}
function insertRow(handle, table, row, verb = "INSERT") {
  const columns = Object.keys(row);
  handle.prepare(`${verb} INTO ${table} (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...columns.map((c) => row[c]));
}
function parse(text) {
  try {
    return JSON.parse(String(text));
  } catch {
    return null;
  }
}
function placeholders(values) {
  return values.map(() => "?").join(", ");
}
function realOrResolved(dir) {
  const resolved = import_node_path.default.resolve(dir);
  try {
    return import_node_fs.default.realpathSync(resolved);
  } catch {
    return resolved;
  }
}
function readGlobal(handle, key) {
  const row = one(handle, "SELECT data FROM globals WHERE key = ?", key);
  return row ? parse(row.data) : null;
}
function writeGlobal(handle, key, value) {
  handle.prepare("INSERT INTO globals (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data").run(key, JSON.stringify(value));
}
function notificationList(handle) {
  const data = readGlobal(handle, "notifications");
  return data && Array.isArray(data.notifications) ? data.notifications : [];
}
function resolveBoard(handle, ref) {
  const arg = String(ref || "").trim();
  const projects = all(handle, "SELECT slug, data FROM projects ORDER BY slug").map((row) => ({ slug: String(row.slug), meta: parse(row.data) || {} }));
  const bySlug = projects.find((project) => project.slug === arg);
  if (bySlug) return bySlug;
  const byName = projects.filter((project) => String(project.meta.name || project.slug).trim().toLowerCase() === arg.toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(`board "${arg}" matches ${byName.length} boards by name (${byName.map((p) => p.slug).join(", ")}); pass the slug or path.`);
  }
  if (import_node_path.default.isAbsolute(arg)) {
    const wanted = realOrResolved(arg);
    const byPath = projects.find((project) => project.meta.path && realOrResolved(project.meta.path) === wanted);
    if (byPath) return byPath;
  }
  const known = projects.map((project) => project.meta.name || project.slug).join(", ");
  throw new Error(`board "${arg}" does not match any board in the source home.${known ? ` Known: ${known}` : ""}`);
}
function snapshot(source, slug) {
  const projectRow = one(source, "SELECT * FROM projects WHERE slug = ?", slug);
  if (!projectRow) throw new Error(`board "${slug}" no longer exists in the source home.`);
  const tickets = all(source, "SELECT * FROM tickets WHERE project = ? ORDER BY id", slug);
  const ticketIds = tickets.map((row) => String(row.id));
  const rows = {
    projects: [projectRow],
    project_routing_profiles: all(source, "SELECT * FROM project_routing_profiles WHERE project = ?", slug),
    project_categories: all(source, "SELECT * FROM project_categories WHERE project = ? ORDER BY id", slug),
    stories: all(source, "SELECT * FROM stories WHERE project = ? ORDER BY id", slug),
    tickets,
    external_links: ticketIds.length ? all(source, `SELECT * FROM external_links WHERE ticket_id IN (${placeholders(ticketIds)})`, ...ticketIds) : []
  };
  const profileIds = /* @__PURE__ */ new Set();
  for (const row of rows.project_routing_profiles) profileIds.add(String(row.profile_id));
  for (const row of rows.project_categories) if (row.base_profile_id) profileIds.add(String(row.base_profile_id));
  const ids = [...profileIds];
  const profiles = ids.length ? all(source, `SELECT * FROM routing_profiles WHERE id IN (${placeholders(ids)})`, ...ids) : [];
  const profileEntries = ids.length ? all(source, `SELECT * FROM routing_profile_entries WHERE profile_id IN (${placeholders(ids)})`, ...ids) : [];
  const notifications = notificationList(source).filter((entry) => entry && entry.projectSlug === slug);
  return { slug, meta: parse(projectRow.data) || {}, rows, notifications, profiles, profileEntries };
}
function listFiles(root) {
  const list = [];
  let bytes = 0;
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = import_node_fs.default.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = import_node_path.default.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.isFile() && !entry.name.endsWith(".lock")) {
        list.push(relative);
        try {
          bytes += import_node_fs.default.statSync(full).size;
        } catch {
        }
      }
    }
  };
  walk(root, "");
  list.sort();
  return { list, bytes };
}
function gitRefs(repo, refs) {
  if (!repo || !import_node_fs.default.existsSync(repo)) return [];
  try {
    const out = (0, import_node_child_process.execFileSync)("git", ["for-each-ref", "--format=%(refname)", "refs/sidequest/"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").map((line) => line.trim()).filter((name) => name && refs.has(name.slice("refs/sidequest/".length).toUpperCase())).sort();
  } catch {
    return [];
  }
}
function pathRewriter(sourceHome, destHome, slug) {
  const homes = [.../* @__PURE__ */ new Set([import_node_path.default.resolve(sourceHome), realOrResolved(sourceHome)])];
  const destination = import_node_path.default.resolve(destHome);
  const prefixes = [];
  for (const home of homes) {
    prefixes.push({ from: import_node_path.default.join(home, "projects", slug), to: import_node_path.default.join(destination, "projects", slug), exact: true });
    prefixes.push({ from: import_node_path.default.join(home, "dispatch-tokens") + import_node_path.default.sep, to: import_node_path.default.join(destination, "dispatch-tokens") + import_node_path.default.sep, exact: false });
  }
  const swap = (text) => {
    for (const prefix of prefixes) {
      if (prefix.exact) {
        if (text === prefix.from) return prefix.to;
        if (text.startsWith(prefix.from + import_node_path.default.sep)) return prefix.to + text.slice(prefix.from.length);
      } else if (text.startsWith(prefix.from)) {
        return prefix.to + text.slice(prefix.from.length);
      }
    }
    return null;
  };
  return {
    rewrite(value) {
      let count = 0;
      const walk = (node) => {
        if (typeof node === "string") {
          const swapped = swap(node);
          if (swapped === null) return node;
          count += 1;
          return swapped;
        }
        if (Array.isArray(node)) return node.map(walk);
        if (node && typeof node === "object") {
          const out = {};
          for (const [key, child] of Object.entries(node)) out[key] = walk(child);
          return out;
        }
        return node;
      };
      return { value: walk(value), count };
    }
  };
}
function rewriteRows(rows, rewriter) {
  let count = 0;
  const out = rows.map((row) => {
    if (typeof row.data !== "string") return row;
    const parsed = parse(row.data);
    if (parsed === null) return row;
    const result = rewriter.rewrite(parsed);
    if (!result.count) return row;
    count += result.count;
    return { ...row, data: JSON.stringify(result.value) };
  });
  return { rows: out, count };
}
function ticketLabel(row) {
  return String(row.ref || row.id);
}
function blockersFor(snap) {
  const blockers = [];
  for (const row of snap.rows.tickets) {
    const ticket = parse(row.data) || {};
    const claimBy = ticket.claim?.by || row.claim_by;
    if (claimBy) {
      blockers.push({
        kind: "claim",
        ref: ticketLabel(row),
        detail: `${ticketLabel(row)} is claimed by "${claimBy}"${ticket.claim?.at ? ` since ${ticket.claim.at}` : ""}; release it (or sweep a dead claim) before moving the board`
      });
    }
    const dispatch = ticket.dispatch && typeof ticket.dispatch === "object" ? ticket.dispatch : null;
    if (dispatch && !dispatch.terminalAt && (dispatch.launchedAt || dispatch.boundAt)) {
      const state = dispatch.boundAt ? `bound at ${dispatch.boundAt}` : `launched at ${dispatch.launchedAt}`;
      blockers.push({
        kind: "dispatch",
        ref: ticketLabel(row),
        detail: `${ticketLabel(row)} has a live dispatch ${dispatch.agentName || dispatch.agentId || "(unnamed)"} ${state}; let it finish or release it first`
      });
    }
  }
  return blockers;
}
async function publishLockBlocker(meta) {
  const repo = String(meta?.path || "");
  if (!repo || !import_node_fs.default.existsSync(repo)) return null;
  let status;
  try {
    status = await publishLockStatus(repo);
  } catch {
    return null;
  }
  if (!status?.locked || status.stale) return null;
  const holder = status.holder || {};
  const who = holder.by || holder.sessionId || (holder.pid ? `pid ${holder.pid}` : "an unknown holder");
  return { kind: "publish-lock", ref: null, detail: `publish lock ${status.file} is held by ${who}${holder.at ? ` since ${holder.at}` : ""}` };
}
function destinationState(dest, snap) {
  if (!dest) return { destination: "new", blockers: [] };
  const blockers = [];
  const sourceTickets = new Set(snap.rows.tickets.map((row) => String(row.id)));
  const sourceStories = new Set(snap.rows.stories.map((row) => String(row.id)));
  const existing = one(dest, "SELECT slug FROM projects WHERE slug = ?", snap.slug);
  if (existing) {
    const foreignTickets = all(dest, "SELECT id, ref FROM tickets WHERE project = ?", snap.slug).filter((row) => !sourceTickets.has(String(row.id)));
    const foreignStories = all(dest, "SELECT id FROM stories WHERE project = ?", snap.slug).filter((row) => !sourceStories.has(String(row.id)));
    if (foreignTickets.length || foreignStories.length) {
      blockers.push({
        kind: "collision",
        ref: null,
        detail: `the destination already holds board ${snap.slug} with ${foreignTickets.length} ticket(s) and ${foreignStories.length} story(ies) the source does not (${foreignTickets.slice(0, 10).map(ticketLabel).join(", ") || "stories only"}); merging two live copies of one board would collide refs, so move or remove that copy first`
      });
    }
  }
  const ticketIds = [...sourceTickets];
  if (ticketIds.length) {
    for (const row of all(dest, `SELECT id, ref, project FROM tickets WHERE id IN (${placeholders(ticketIds)}) AND project != ?`, ...ticketIds, snap.slug)) {
      blockers.push({ kind: "collision", ref: ticketLabel(row), detail: `ticket id ${row.id} already exists in the destination on board ${row.project}` });
    }
  }
  const storyIds = [...sourceStories];
  if (storyIds.length) {
    for (const row of all(dest, `SELECT id, project FROM stories WHERE id IN (${placeholders(storyIds)}) AND project != ?`, ...storyIds, snap.slug)) {
      blockers.push({ kind: "collision", ref: null, detail: `story id ${row.id} already exists in the destination on board ${row.project}` });
    }
  }
  for (const profile of snap.profiles) {
    if (one(dest, "SELECT 1 AS present FROM routing_profiles WHERE id = ?", profile.id)) continue;
    const clash = one(dest, "SELECT id FROM routing_profiles WHERE lower(name) = lower(?) OR (seed_key IS NOT NULL AND seed_key = ?)", profile.name, profile.seed_key ?? null);
    if (clash) {
      blockers.push({
        kind: "collision",
        ref: null,
        detail: `routing profile "${profile.name}" (${profile.id}) would be copied, but the destination already has a different profile ${clash.id} with that name or seed; rename one of them first`
      });
    }
  }
  return { destination: existing ? "replace" : "new", blockers };
}
function sharedPlan(dest, snap) {
  const has = (table, id) => Boolean(dest && one(dest, `SELECT 1 AS present FROM ${table} WHERE id = ?`, id));
  const profiles = { copy: [], kept: [] };
  for (const row of snap.profiles) (has("routing_profiles", String(row.id)) ? profiles.kept : profiles.copy).push(String(row.id));
  const copied = new Set(profiles.copy);
  return {
    routingProfiles: profiles,
    routingProfileEntries: snap.profileEntries.filter((row) => copied.has(String(row.profile_id))).length
  };
}
function buildPlan(sourceHome, destHome, dest, snap) {
  const byStatus = Object.fromEntries(TICKET_STATUSES.map((status) => [status, 0]));
  let archived = 0;
  for (const row of snap.rows.tickets) {
    if (Number(row.archived)) archived += 1;
    const status = String(row.status || "todo");
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  const rows = Object.fromEntries(BOARD_TABLES.map((table) => [table, snap.rows[table].length]));
  const projectFrom = import_node_path.default.join(import_node_path.default.resolve(sourceHome), "projects", snap.slug);
  const projectTo = import_node_path.default.join(import_node_path.default.resolve(destHome), "projects", snap.slug);
  const files = listFiles(projectFrom);
  const rewriter = pathRewriter(sourceHome, destHome, snap.slug);
  const rewrittenPaths = ["projects", "stories", "tickets"].reduce((sum, table) => sum + rewriteRows(snap.rows[table], rewriter).count, 0);
  const dispatchTokens = [];
  for (const row of snap.rows.tickets) {
    const tokenFile = parse(row.data)?.dispatch?.tokenFile;
    if (typeof tokenFile !== "string" || !import_node_fs.default.existsSync(tokenFile)) continue;
    const moved = rewriter.rewrite(tokenFile);
    if (moved.count) dispatchTokens.push({ from: tokenFile, to: moved.value });
  }
  const refs = new Set(snap.rows.tickets.map((row) => String(row.ref || "").toUpperCase()).filter(Boolean));
  const worktreesFrom = import_node_path.default.join(import_node_path.default.resolve(sourceHome), "worktrees", snap.slug);
  const { destination, blockers } = destinationState(dest, snap);
  return {
    slug: snap.slug,
    name: String(snap.meta.name || snap.slug),
    path: String(snap.meta.path || ""),
    destination,
    tickets: { total: snap.rows.tickets.length, archived, byStatus },
    rows,
    notifications: snap.notifications.length,
    shared: sharedPlan(dest, snap),
    files: { from: projectFrom, to: projectTo, count: files.list.length, bytes: files.bytes, list: files.list },
    dispatchTokens,
    rewrittenPaths,
    gitRefs: gitRefs(String(snap.meta.path || ""), refs),
    worktrees: {
      from: worktreesFrom,
      exists: import_node_fs.default.existsSync(worktreesFrom),
      rule: `existing worktrees stay at ${worktreesFrom} (their Git registration is unchanged); new dispatches create worktrees under ${import_node_path.default.join(import_node_path.default.resolve(destHome), "worktrees", snap.slug)}`
    },
    blockers: [...blockersFor(snap), ...blockers]
  };
}
function copyFiles(plan) {
  if (!import_node_fs.default.existsSync(plan.files.from)) return;
  import_node_fs.default.mkdirSync(plan.files.to, { recursive: true });
  import_node_fs.default.cpSync(plan.files.from, plan.files.to, {
    recursive: true,
    force: true,
    filter: (source) => !source.endsWith(".lock")
  });
}
function verifyFiles(plan) {
  const missing = plan.files.list.filter((relative) => !import_node_fs.default.existsSync(import_node_path.default.join(plan.files.to, ...relative.split("/"))));
  if (missing.length) {
    throw new Error(`file copy did not verify: ${missing.length} file(s) missing under ${plan.files.to} (${missing.slice(0, 5).join(", ")})`);
  }
}
function copyTokens(plan) {
  for (const token of plan.dispatchTokens) {
    import_node_fs.default.mkdirSync(import_node_path.default.dirname(token.to), { recursive: true, mode: 448 });
    import_node_fs.default.copyFileSync(token.from, token.to);
    try {
      import_node_fs.default.chmodSync(token.to, 384);
    } catch {
    }
  }
}
function insertBoard(dest, snap, plan, rewriter) {
  const copied = new Set(plan.shared.routingProfiles.copy);
  for (const row of snap.profiles) if (copied.has(String(row.id))) insertRow(dest, "routing_profiles", row);
  for (const row of snap.profileEntries) if (copied.has(String(row.profile_id))) insertRow(dest, "routing_profile_entries", row);
  let destinationSeq = 0;
  let destinationStorySeq = 0;
  if (plan.destination === "replace") {
    const previous = parse(one(dest, "SELECT data FROM projects WHERE slug = ?", snap.slug)?.data) || {};
    destinationSeq = Number(previous.seq) || 0;
    destinationStorySeq = Number(previous.storySeq) || 0;
    deleteBoard(dest, snap.slug);
  }
  for (const table of BOARD_TABLES) {
    let rows = snap.rows[table];
    if (table === "projects" || table === "stories" || table === "tickets") rows = rewriteRows(rows, rewriter).rows;
    if (table === "projects" && (destinationSeq || destinationStorySeq)) {
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
    const present = new Set(list.map((entry) => entry?.id));
    for (const entry of snap.notifications) if (!present.has(entry.id)) list.push(entry);
    writeGlobal(dest, "notifications", { notifications: list });
  }
  return countBoard(dest, snap);
}
function countBoard(handle, snap) {
  const count = (sql, ...params) => Number(one(handle, sql, ...params)?.n || 0);
  const ticketIds = snap.rows.tickets.map((row) => String(row.id));
  return {
    projects: count("SELECT COUNT(*) AS n FROM projects WHERE slug = ?", snap.slug),
    project_routing_profiles: count("SELECT COUNT(*) AS n FROM project_routing_profiles WHERE project = ?", snap.slug),
    project_categories: count("SELECT COUNT(*) AS n FROM project_categories WHERE project = ?", snap.slug),
    stories: count("SELECT COUNT(*) AS n FROM stories WHERE project = ?", snap.slug),
    tickets: count("SELECT COUNT(*) AS n FROM tickets WHERE project = ?", snap.slug),
    external_links: ticketIds.length ? count(`SELECT COUNT(*) AS n FROM external_links WHERE ticket_id IN (${placeholders(ticketIds)})`, ...ticketIds) : 0
  };
}
function deleteBoard(handle, slug) {
  const ticketIds = all(handle, "SELECT id FROM tickets WHERE project = ?", slug).map((row) => String(row.id));
  if (ticketIds.length) handle.prepare(`DELETE FROM external_links WHERE ticket_id IN (${placeholders(ticketIds)})`).run(...ticketIds);
  handle.prepare("DELETE FROM tickets WHERE project = ?").run(slug);
  handle.prepare("DELETE FROM stories WHERE project = ?").run(slug);
  handle.prepare("DELETE FROM project_categories WHERE project = ?").run(slug);
  handle.prepare("DELETE FROM project_routing_profiles WHERE project = ?").run(slug);
  handle.prepare("DELETE FROM projects WHERE slug = ?").run(slug);
}
function removeFromSource(source, slug) {
  deleteBoard(source, slug);
  const list = notificationList(source);
  const kept = list.filter((entry) => !entry || entry.projectSlug !== slug);
  if (kept.length !== list.length) writeGlobal(source, "notifications", { notifications: kept });
  source.prepare("DELETE FROM globals WHERE key = ?").run(`worktree-gc-candidate-cursor:${slug}`);
}
function sameCounts(a, b) {
  return BOARD_TABLES.every((table) => a[table] === b[table]);
}
function openHome(home) {
  const handle = (0, import_db.openDb)(home);
  (0, import_migrate.migrateIfNeeded)(handle, home);
  return handle;
}
function describeBlockers(plan) {
  return plan.blockers.map((blocker) => `${blocker.kind}: ${blocker.detail}`).join("; ");
}
async function moveBoards(options) {
  const sourceHome = import_node_path.default.resolve(String(options.sourceHome || ""));
  const destHome = import_node_path.default.resolve(String(options.destHome || ""));
  const dryRun = Boolean(options.dryRun);
  if (!options.destHome) throw new Error("pass --to-home <dir>: the SIDEQUEST_HOME to move the board(s) into.");
  if (!options.boards?.length) throw new Error("pass at least one board slug, display name, or registered path.");
  if (realOrResolved(sourceHome) === realOrResolved(destHome)) {
    throw new Error(`source and destination are the same home (${realOrResolved(sourceHome)}); nothing to move.`);
  }
  if (!import_node_fs.default.existsSync(import_node_path.default.join(sourceHome, "sidequest.db"))) throw new Error(`no board database at ${import_node_path.default.join(sourceHome, "sidequest.db")}.`);
  const source = openHome(sourceHome);
  const destDbExists = import_node_fs.default.existsSync(import_node_path.default.join(destHome, "sidequest.db"));
  let dest = dryRun && !destDbExists ? null : openHome(destHome);
  try {
    const resolved = [];
    for (const ref of options.boards) {
      const board = resolveBoard(source, ref);
      if (!resolved.some((entry) => entry.slug === board.slug)) resolved.push(board);
    }
    const plans = [];
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
        refused: blocked.map((plan) => `${plan.name} (${plan.slug}): ${describeBlockers(plan)}`).join(" | ")
      };
    }
    if (dryRun) return { ok: true, dryRun, sourceHome, destHome, boards: plans };
    const moved = [];
    for (const planned of plans) {
      copyFiles(planned);
      copyTokens(planned);
      const destination = dest;
      const finalPlan = (0, import_db.txn)(source, () => {
        const snap = snapshot(source, planned.slug);
        const plan = buildPlan(sourceHome, destHome, destination, snap);
        if (plan.blockers.length) throw new Error(`refusing to move ${plan.name} (${plan.slug}): ${describeBlockers(plan)}`);
        verifyFiles(plan);
        const rewriter = pathRewriter(sourceHome, destHome, snap.slug);
        plan.verified = (0, import_db.txn)(destination, () => {
          const counts = insertBoard(destination, snap, plan, rewriter);
          if (!sameCounts(counts, plan.rows)) {
            throw new Error(`destination row counts did not verify for ${plan.slug}: expected ${JSON.stringify(plan.rows)}, found ${JSON.stringify(counts)}`);
          }
          return counts;
        });
        removeFromSource(source, snap.slug);
        return plan;
      });
      copyFiles(finalPlan);
      verifyFiles(finalPlan);
      import_node_fs.default.rmSync(finalPlan.files.from, { recursive: true, force: true });
      for (const token of finalPlan.dispatchTokens) import_node_fs.default.rmSync(token.from, { force: true });
      moved.push(finalPlan);
    }
    return { ok: true, dryRun, sourceHome, destHome, boards: moved };
  } finally {
    try {
      source.close();
    } catch {
    }
    try {
      dest?.close();
    } catch {
    }
    dest = null;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BOARD_TABLES,
  describeBlockers,
  moveBoards
});
