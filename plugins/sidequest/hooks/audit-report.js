#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
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

// src/lib/audit/local.ts
var require_local = __commonJS({
  "src/lib/audit/local.ts"(exports2, module2) {
    "use strict";
    function execute(git, args) {
      try {
        return git(args);
      } catch (_error) {
        return null;
      }
    }
    function mainRef(git) {
      if (execute(git, ["rev-parse", "--verify", "origin/main"]) !== null) return "origin/main";
      if (execute(git, ["rev-parse", "--verify", "main"]) !== null) return "main";
      return null;
    }
    function escapeRegex(value) {
      return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    function refPattern(ref) {
      return new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegex(ref)}(?![A-Za-z0-9_-])`);
    }
    function commitsFromLog(log) {
      return log.split("").flatMap((record) => {
        if (!record.trim()) return [];
        const [sha, date, subject, ...body] = record.split("");
        if (!sha || !date || subject === void 0) return [];
        return [{ sha, date, subject, body: body.join("") }];
      });
    }
    function changelogVersionFor(changelog, ref) {
      let version = null;
      const matchesRef = refPattern(ref);
      for (const line of changelog.split(/\r?\n/)) {
        const heading = /^##\s+(v[^\s(]+)/.exec(line);
        if (heading) {
          version = heading[1] || null;
          continue;
        }
        if (version && matchesRef.test(line)) return version;
      }
      return null;
    }
    function deliveryCommit(ticket) {
      const values = [ticket.submission?.integration?.deliveryCommit, ticket.completion?.delivery?.commit];
      return values.map((value) => String(value || "").trim()).find(Boolean) || null;
    }
    function findLandedFixes(tickets, git) {
      const candidates = tickets.filter((ticket) => !ticket.archived && (ticket.status === "todo" || ticket.status === "doing") && ticket.id && ticket.ref);
      if (!candidates.length) return [];
      const main2 = mainRef(git);
      if (!main2) return null;
      const log = execute(git, ["log", main2, "--format=%H%x1f%aI%x1f%s%x1f%B%x1e"]);
      const fragments = execute(git, ["ls-tree", "-r", "--name-only", main2, "--", ".release/unreleased"]);
      const changelog = execute(git, ["show", `${main2}:CHANGELOG.md`]);
      if (log === null || fragments === null || changelog === null) return null;
      const fragmentPaths = new Set(fragments.split(/\r?\n/).filter(Boolean));
      const commits = commitsFromLog(log);
      return candidates.flatMap((ticket) => {
        const createdAt = new Date(String(ticket.createdAt || "")).valueOf();
        if (!Number.isFinite(createdAt)) return [];
        const matchesRef = refPattern(String(ticket.ref));
        const matchedCommits = commits.filter((commit) => new Date(commit.date).valueOf() > createdAt && matchesRef.test(`${commit.subject}
${commit.body || ""}`)).map(({ sha, subject, date }) => ({ sha, subject, date }));
        if (!matchedCommits.length) return [];
        return [{
          ticketId: String(ticket.id),
          ref: String(ticket.ref),
          status: String(ticket.status),
          commits: matchedCommits,
          fragment: fragmentPaths.has(`.release/unreleased/${ticket.ref}.md`),
          changelogVersion: changelogVersionFor(changelog, String(ticket.ref))
        }];
      });
    }
    function releasedIn(ticket, git) {
      if (ticket.status !== "done") return null;
      const commit = deliveryCommit(ticket);
      if (!commit) return { version: null, tag: null, reason: "delivery_commit_unavailable" };
      const tags = execute(git, ["tag", "--list", "v*", "--sort=creatordate"]);
      if (tags === null) return null;
      for (const tag of tags.split(/\r?\n/).filter(Boolean)) {
        if (execute(git, ["merge-base", "--is-ancestor", commit, tag]) !== null) {
          return { version: tag.slice(1), tag };
        }
      }
      return null;
    }
    module2.exports = { findLandedFixes, releasedIn };
  }
});

// src/lib/audit/github.ts
var github_exports = {};
__export(github_exports, {
  applyGithub: () => applyGithub,
  planGithub: () => planGithub
});
function command(gh, arguments_) {
  try {
    const output = gh("gh", arguments_, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    return String(output).trim();
  } catch (_error) {
    return null;
  }
}
function jsonCommand(gh, arguments_) {
  const output = command(gh, arguments_);
  if (output == null) return null;
  try {
    return JSON.parse(output);
  } catch (_error) {
    return null;
  }
}
function labelNames(labels) {
  if (!Array.isArray(labels)) return [];
  return [...new Set(labels.map((label) => typeof label === "string" ? label : String(label?.name || "")).filter(Boolean))].sort();
}
function normalizedIssue(value) {
  if (!value || typeof value !== "object") return null;
  const issue = value;
  const number = Number(issue.number);
  if (!Number.isInteger(number) || number < 1) return null;
  const state = String(issue.state || "").toUpperCase();
  if (state !== "OPEN" && state !== "CLOSED") return null;
  return Object.freeze({ number, state, labels: labelNames(issue.labels), ...typeof issue.title === "string" ? { title: issue.title } : {} });
}
function releaseFor(released, ticketId) {
  if (!released) return null;
  if (released instanceof Map) return released.get(ticketId) || null;
  return released[ticketId] || null;
}
function versionParts(version) {
  const match = /v?(\d+(?:\.\d+)*)/i.exec(version);
  return match ? match[1].split(".").map(Number) : [];
}
function latestVersion(values) {
  return [...values].sort((left, right) => {
    const leftParts = versionParts(left);
    const rightParts = versionParts(right);
    const length = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < length; index += 1) {
      const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
      if (difference) return difference;
    }
    return left.localeCompare(right);
  }).at(-1) || "";
}
function ticketRank(ticket, released) {
  if (released) return 3;
  if (ticket.submission && !ticket.submission.integratedAt) return 1;
  if (ticket.status === "done") return 2;
  if (ticket.status === "doing" || ticket.status === "awaiting-oracle") return 1;
  return 0;
}
function desiredFor(tickets, released, currentLabels) {
  const releases = tickets.map((ticket) => releaseFor(released, ticket.id));
  const allReleased = releases.length > 0 && releases.every(Boolean);
  const rank = Math.min(...tickets.map((ticket, index) => ticketRank(ticket, releases[index] || null)));
  const status = allReleased ? null : rank === 2 ? "status:in-testing" : rank === 1 ? "status:in-progress" : null;
  const labels = currentLabels.filter((label) => !label.startsWith("status:"));
  if (status) labels.push(status);
  return { state: allReleased ? "CLOSED" : "OPEN", labels: [...new Set(labels)].sort(), releasedVersion: allReleased ? latestVersion(releases.map((release) => release.version)) : null };
}
function releaseComment(ticketIds, refs, version) {
  const marker = `<!-- sidequest:released ticket=${ticketIds.join(",")} version=${version} -->`;
  return {
    marker,
    body: `Fixed in ${version} (${refs.join(", ")}).

${marker}`
  };
}
function planGithub({ links, tickets, released, gh, repo: projectRepo }) {
  const ticketById = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const linksByIssue = /* @__PURE__ */ new Map();
  for (const link of links) {
    if (link.provider !== "github" || !ticketById.has(link.ticketId)) continue;
    const key = `${link.repo}#${link.number}`;
    linksByIssue.set(key, [...linksByIssue.get(key) || [], link]);
  }
  const repos = [...new Set([...linksByIssue.values()].flat().map((link) => link.repo).concat(typeof projectRepo === "string" && projectRepo.trim() ? [projectRepo.trim().toLowerCase()] : []))].sort();
  const issuesByRepo = /* @__PURE__ */ new Map();
  const warnings = [];
  for (const repo of repos) {
    const payload = jsonCommand(gh, ["issue", "list", "--repo", repo, "--state", "all", "--limit", "1000", "--json", "number,state,labels,title"]);
    if (!Array.isArray(payload)) {
      warnings.push(`gh unavailable for ${repo}; GitHub sections skipped.`);
      continue;
    }
    issuesByRepo.set(repo, payload.map(normalizedIssue).filter((issue) => issue !== null));
  }
  if (repos.length && !issuesByRepo.size) return Object.freeze({ linkedDrift: [], untrackedIssues: [], warnings: Object.freeze(["gh not authenticated; GitHub sections skipped.", ...warnings]) });
  const linkedDrift = [];
  const untrackedIssues = [];
  for (const repo of repos) {
    const issues = issuesByRepo.get(repo);
    if (!issues) continue;
    for (const issue of issues) {
      const linked = linksByIssue.get(`${repo}#${issue.number}`) || [];
      if (!linked.length) {
        if (issue.state === "OPEN") untrackedIssues.push(Object.freeze({ ...issue, repo }));
        continue;
      }
      const linkedTickets = [...new Map(linked.map((link) => [link.ticketId, ticketById.get(link.ticketId)])).values()];
      const ticketIds = linkedTickets.map((ticket) => ticket.id).sort();
      const refs = linkedTickets.map((ticket) => ticket.ref).sort();
      const desired = desiredFor(linkedTickets, released, issue.labels);
      const actions = [];
      for (const label of desired.labels.filter((label2) => !issue.labels.includes(label2))) actions.push(Object.freeze({ type: "addLabel", label }));
      for (const label of issue.labels.filter((label2) => label2.startsWith("status:") && !desired.labels.includes(label2))) actions.push(Object.freeze({ type: "removeLabel", label }));
      if (desired.state === "CLOSED") {
        const comment = releaseComment(ticketIds, refs, desired.releasedVersion);
        if (!commentsContain(gh, repo, issue.number, comment.marker)) actions.push(Object.freeze({ type: "comment", ...comment }));
        if (issue.state !== desired.state) actions.push(Object.freeze({ type: "close" }));
      }
      if (issue.state !== desired.state && desired.state === "OPEN") actions.push(Object.freeze({ type: "reopen" }));
      if (actions.length) linkedDrift.push(Object.freeze({ repo, number: issue.number, ticketIds: Object.freeze(ticketIds), refs: Object.freeze(refs), current: Object.freeze({ state: issue.state, labels: Object.freeze([...issue.labels]) }), desired: Object.freeze({ state: desired.state, labels: Object.freeze(desired.labels) }), actions: Object.freeze(actions) }));
    }
  }
  return Object.freeze({ linkedDrift: Object.freeze(linkedDrift), untrackedIssues: Object.freeze(untrackedIssues), warnings: Object.freeze(warnings) });
}
function paginatedArrays(output) {
  try {
    const payload = JSON.parse(output);
    return Array.isArray(payload) ? payload : null;
  } catch (_error) {
    const values = [];
    let offset = 0;
    while (offset < output.length) {
      while (/\s/.test(output[offset] || "")) offset += 1;
      if (output[offset] !== "[") return null;
      let depth = 0;
      let quoted = false;
      let escaped = false;
      let end = offset;
      for (; end < output.length; end += 1) {
        const character = output[end];
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') quoted = false;
          continue;
        }
        if (character === '"') quoted = true;
        else if (character === "[") depth += 1;
        else if (character === "]") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (depth !== 0) return null;
      try {
        const page = JSON.parse(output.slice(offset, end + 1));
        if (!Array.isArray(page)) return null;
        values.push(...page);
      } catch (_error2) {
        return null;
      }
      offset = end + 1;
    }
    return values;
  }
}
function commentsContain(gh, repo, number, marker) {
  const output = command(gh, ["api", `repos/${repo}/issues/${number}/comments`, "--paginate"]);
  const comments = output === null ? null : paginatedArrays(output);
  if (comments === null) return null;
  return comments.some((comment) => String(comment?.body || "").includes(marker));
}
function applyGithub(plan, gh) {
  if (!plan || !Array.isArray(plan.linkedDrift) || !plan.linkedDrift.length) return [];
  const results = [];
  const labelsToCreate = /* @__PURE__ */ new Map();
  for (const drift of plan.linkedDrift) for (const action of drift.actions) if (action.type === "addLabel" && (action.label === "status:in-progress" || action.label === "status:in-testing")) (labelsToCreate.get(drift.repo) || labelsToCreate.set(drift.repo, /* @__PURE__ */ new Set()).get(drift.repo)).add(action.label);
  for (const [repo, labels] of labelsToCreate) {
    const existing = jsonCommand(gh, ["label", "list", "--repo", repo, "--limit", "1000", "--json", "name"]);
    const names = new Set(Array.isArray(existing) ? existing.map((label) => String(label?.name || "")) : []);
    for (const label of labels) {
      if (names.has(label)) continue;
      const output = command(gh, ["label", "create", label, "--repo", repo, "--color", "0E8A16"]);
      results.push(Object.freeze({ repo, number: 0, action: `createLabel:${label}`, ok: output !== null, ...output === null ? { error: "gh command failed" } : {} }));
    }
  }
  for (const drift of plan.linkedDrift) {
    let commentReady = true;
    for (const action of drift.actions) {
      if (action.type === "addLabel" || action.type === "removeLabel") {
        const flag = action.type === "addLabel" ? "--add-label" : "--remove-label";
        const output = command(gh, ["issue", "edit", String(drift.number), "--repo", drift.repo, flag, action.label]);
        results.push(Object.freeze({ repo: drift.repo, number: drift.number, action: action.type, ok: output !== null, ...output === null ? { error: "gh command failed" } : {} }));
      } else if (action.type === "comment") {
        const present = commentsContain(gh, drift.repo, drift.number, action.marker);
        if (present === null) {
          commentReady = false;
          results.push(Object.freeze({ repo: drift.repo, number: drift.number, action: "comment", ok: false, error: "could not list issue comments" }));
        } else if (present) {
          results.push(Object.freeze({ repo: drift.repo, number: drift.number, action: "comment", ok: true, skipped: true }));
        } else {
          const output = command(gh, ["issue", "comment", String(drift.number), "--repo", drift.repo, "--body", action.body]);
          commentReady = output !== null;
          results.push(Object.freeze({ repo: drift.repo, number: drift.number, action: "comment", ok: commentReady, ...commentReady ? {} : { error: "gh command failed" } }));
        }
      } else if (action.type === "close") {
        if (!commentReady) results.push(Object.freeze({ repo: drift.repo, number: drift.number, action: "close", ok: false, skipped: true, error: "comment failed" }));
        else {
          const output = command(gh, ["issue", "close", String(drift.number), "--repo", drift.repo]);
          results.push(Object.freeze({ repo: drift.repo, number: drift.number, action: "close", ok: output !== null, ...output === null ? { error: "gh command failed" } : {} }));
        }
      } else {
        const output = command(gh, ["issue", "reopen", String(drift.number), "--repo", drift.repo]);
        results.push(Object.freeze({ repo: drift.repo, number: drift.number, action: "reopen", ok: output !== null, ...output === null ? { error: "gh command failed" } : {} }));
      }
    }
  }
  return Object.freeze(results);
}
var init_github = __esm({
  "src/lib/audit/github.ts"() {
    "use strict";
  }
});

// src/lib/audit/report.ts
var require_report = __commonJS({
  "src/lib/audit/report.ts"(exports2, module2) {
    "use strict";
    var import_node_child_process2 = require("node:child_process");
    var { findLandedFixes, releasedIn } = require_local();
    var { planGithub: planGithub2, applyGithub: applyGithub2 } = (init_github(), __toCommonJS(github_exports));
    function githubRepo(remote) {
      const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(String(remote || "").trim());
      return match ? match[1].replace(/\.git$/i, "").toLowerCase() : null;
    }
    function gitExecutor(cwd) {
      return (args) => {
        try {
          return String((0, import_node_child_process2.execFileSync)("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }));
        } catch (_) {
          return null;
        }
      };
    }
    function ghExecutor() {
      return (program, arguments_, options = {}) => (0, import_node_child_process2.execFileSync)(program, arguments_, options);
    }
    function auditReport(input, apply = false) {
      const tickets = input.tickets.filter((ticket) => ticket && ticket.id && ticket.ref);
      const warnings = [];
      const staleEvidence = findLandedFixes(tickets, input.git);
      const titleById = new Map(tickets.map((ticket) => [ticket.id, ticket.title || ""]));
      const staleBoardTickets = staleEvidence === null ? null : staleEvidence.map((item) => Object.freeze({ ...item, title: titleById.get(item.ticketId) || "" }));
      if (staleBoardTickets === null) warnings.push("git evidence unavailable; stale board tickets skipped.");
      const released = /* @__PURE__ */ new Map();
      for (const ticket of tickets) {
        const result = releasedIn(ticket, input.git);
        if (result && result.version && ticket.id) released.set(ticket.id, { version: `v${result.version}` });
        else if (result?.reason && ticket.ref) warnings.push(`${ticket.ref}: delivery commit unavailable; release status cannot be determined.`);
      }
      if (!input.repo) warnings.push("GitHub project remote unavailable; untracked issue scan skipped.");
      const plan = planGithub2({ links: input.links, tickets, released, gh: input.gh, ...input.repo ? { repo: input.repo } : {} });
      warnings.push(...plan.warnings);
      const applied = apply ? applyGithub2(plan, input.gh) : [];
      return Object.freeze({
        staleBoardTickets: Object.freeze(staleBoardTickets || []),
        untrackedIssues: plan.untrackedIssues,
        linkedDrift: plan.linkedDrift,
        warnings: Object.freeze([...new Set(warnings)]),
        applied: Object.freeze(applied)
      });
    }
    function auditProject2(project, store, apply = false, dependencies = {}) {
      const git = dependencies.git || gitExecutor(project.path);
      let remote = dependencies.remote;
      if (remote === void 0) remote = git(["remote", "get-url", "origin"]);
      return auditReport({
        tickets: store.listTickets(project.slug),
        links: store.listExternalLinks(project.slug, {}),
        git,
        gh: dependencies.gh || ghExecutor(),
        repo: githubRepo(remote)
      }, apply);
    }
    function trunc(value, max = 72) {
      const text = String(value || "").replace(/\s+/g, " ").trim();
      return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
    }
    function actions(drift) {
      return (drift.actions || []).map((action) => action.type === "addLabel" || action.type === "removeLabel" ? `${action.type} ${action.label}` : action.type).join(", ");
    }
    function formatAudit(report) {
      const sections = [
        ["STALE BOARD TICKETS", report.staleBoardTickets, (item) => `${item.ref} ${trunc(item.title || "")} — ${(item.commits || []).map((commit) => commit.sha).join(", ") || "landed fix"}`],
        ["UNTRACKED ISSUES", report.untrackedIssues, (item) => `${item.repo}#${item.number} ${trunc(item.title || "")} — https://github.com/${item.repo}/issues/${item.number}`],
        ["LINKED DRIFT", report.linkedDrift, (item) => `${(item.refs || []).join(", ")} — https://github.com/${item.repo}/issues/${item.number}; proposed: ${actions(item)}`],
        ["WARNINGS", report.warnings, (item) => String(item)]
      ];
      const lines = sections.flatMap(([name, items, render]) => [`${name} (${items.length})`, ...items.map(render)]);
      if (report.applied.length) lines.push(`APPLIED (${report.applied.length})`, ...report.applied.map((item) => `${item.repo}#${item.number || "labels"} ${item.action}: ${item.ok ? "ok" : item.error || "failed"}`));
      return lines.join("\n");
    }
    function auditSummary2(report) {
      const counts = [
        [report.staleBoardTickets.length, "board tickets look already fixed"],
        [report.untrackedIssues.length, "untracked issues"],
        [report.linkedDrift.length, "linked issues drifting"]
      ].filter(([count]) => Number(count) > 0);
      return counts.length ? `sidequest audit: ${counts.map(([count, label]) => `${count} ${label}`).join(", ")}. Run \`sidequest audit\` for detail.` : "";
    }
    module2.exports = { auditProject: auditProject2, auditReport, auditSummary: auditSummary2, formatAudit, ghExecutor, gitExecutor };
  }
});

// src/hooks/audit-report.ts
var import_node_path3 = __toESM(require("node:path"));

// src/hooks/shared/paths.ts
var import_node_path = __toESM(require("node:path"));
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || import_node_path.default.join(__dirname, "..");
}
function runtimeModule(name) {
  return import_node_path.default.join(pluginRoot(), "lib", `${name}.js`);
}

// src/hooks/shared/audit-handoff.ts
var import_node_child_process = require("node:child_process");
var import_node_crypto = __toESM(require("node:crypto"));
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path2 = __toESM(require("node:path"));

// src/hooks/shared/input.ts
var import_node_fs = __toESM(require("node:fs"));

// src/lib/exec-names.ts
var EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
var CLAUDE_PREFIX = "sidequest-exec-";
var READ_ONLY_CLAUDE_PREFIX = "sidequest-exec-readonly-";
var DIAGNOSTIC_PROBE_NAME = "sidequest-diagnostic-probe";
var DISPATCH_NAME = "sidequest-exec-dispatch";
var READ_ONLY_DISPATCH_NAME = "sidequest-exec-dispatch-readonly";
function stableClaudeName(effort) {
  return `${CLAUDE_PREFIX}${effort}`;
}
function stableReadOnlyClaudeName(effort) {
  return `${READ_ONLY_CLAUDE_PREFIX}${effort}`;
}
var BUNDLED_AGENT_NAMES = /* @__PURE__ */ new Set([
  DISPATCH_NAME,
  READ_ONLY_DISPATCH_NAME,
  DIAGNOSTIC_PROBE_NAME,
  ...EFFORTS.map(stableClaudeName),
  ...EFFORTS.map(stableReadOnlyClaudeName)
]);

// src/hooks/shared/audit-handoff.ts
function stateDirectory() {
  const home = String(process.env.SIDEQUEST_HOME || "").trim() || import_node_path2.default.join(import_node_os.default.homedir(), ".claude", "sidequest");
  return import_node_path2.default.join(home, "audit-reports");
}
function auditReportFile(cwd) {
  const key = import_node_crypto.default.createHash("sha1").update(import_node_path2.default.resolve(cwd || ".")).digest("hex").slice(0, 16);
  return import_node_path2.default.join(stateDirectory(), `${key}.json`);
}
function writeAuditHandoffReport(cwd, report) {
  try {
    import_node_fs2.default.mkdirSync(stateDirectory(), { recursive: true });
    import_node_fs2.default.writeFileSync(auditReportFile(cwd), JSON.stringify({ summary: String(report.summary || ""), finishedAt: (/* @__PURE__ */ new Date()).toISOString() }));
  } catch (_) {
  }
}

// src/hooks/audit-report.ts
var { auditProject, auditSummary } = require_report();
function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : "";
}
function main() {
  const cwd = import_node_path3.default.resolve(argument("--cwd") || process.cwd());
  try {
    const store = require(runtimeModule("store"));
    const found = store.findProject(store.nearestRepoRoot(cwd));
    if (!found.ok || !found.slug || !found.meta?.path) return writeAuditHandoffReport(cwd, {});
    const report = auditProject({ slug: found.slug, path: found.meta.path }, store);
    writeAuditHandoffReport(cwd, { summary: auditSummary(report) });
  } catch (_) {
    writeAuditHandoffReport(cwd, {});
  }
}
main();
