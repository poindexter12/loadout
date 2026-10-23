"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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
var import_node_child_process = require("node:child_process");
var import_node_os = __toESM(require("node:os"));
const { deliveryCommit, findLandedFixes, releasedIn } = require("./local");
const { planGithub, applyGithub } = require("./github");
const { planIssueMirror, applyIssueMirror } = require("./mirror");
const AUDIT_COMMAND_TIMEOUT_MS = 15e3;
const AUDIT_COMMAND_MAX_BUFFER = 16 * 1024 * 1024;
function errorText(error) {
  const value = error;
  const message = String(value?.message || error || "command failed").replace(/\s+/g, " ").trim();
  const code = value?.code ? ` (${String(value.code)})` : "";
  return `${message}${code}`;
}
function githubRepo(remote) {
  const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(String(remote || "").trim());
  return match ? match[1].replace(/\.git$/i, "").toLowerCase() : null;
}
function gitExecutor(cwd, execute = import_node_child_process.execFileSync) {
  const git = ((args) => {
    try {
      return String(execute("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: AUDIT_COMMAND_TIMEOUT_MS, maxBuffer: AUDIT_COMMAND_MAX_BUFFER, killSignal: "SIGKILL" }));
    } catch (error) {
      git.lastError = errorText(error);
      return null;
    }
  });
  return git;
}
function ghExecutor(execute = import_node_child_process.execFileSync) {
  const gh = ((program, arguments_, options = {}) => {
    try {
      return execute(program, arguments_, { ...options, timeout: AUDIT_COMMAND_TIMEOUT_MS, killSignal: "SIGKILL" });
    } catch (error) {
      gh.lastError = errorText(error);
      throw error;
    }
  });
  return gh;
}
function evidenceError(executor, fallback) {
  return executor.lastError || fallback;
}
function auditReport(input, apply = false) {
  const tickets = input.tickets.filter((ticket) => ticket && ticket.id && ticket.ref);
  const warnings = [];
  let evidenceUnavailable = false;
  const staleEvidence = findLandedFixes(tickets, input.git);
  const titleById = new Map(tickets.map((ticket) => [ticket.id, ticket.title || ""]));
  const staleBoardTickets = staleEvidence === null ? null : staleEvidence.map((item) => Object.freeze({ ...item, title: titleById.get(item.ticketId) || "" }));
  if (staleBoardTickets === null) {
    evidenceUnavailable = true;
    warnings.push(`git evidence unavailable; stale board tickets skipped: ${evidenceError(input.git, "git command failed")}.`);
  }
  const linkedTicketIds = new Set(input.links.filter((link) => link.provider === "github").map((link) => link.ticketId));
  const released = /* @__PURE__ */ new Map();
  const releaseByCommit = /* @__PURE__ */ new Map();
  for (const ticket of tickets) {
    if (ticket.status !== "done" || !linkedTicketIds.has(String(ticket.id))) continue;
    const commit = deliveryCommit(ticket);
    const result = commit && releaseByCommit.has(commit) ? releaseByCommit.get(commit) : releasedIn(ticket, input.git);
    if (commit) releaseByCommit.set(commit, result);
    if (result && result.version && ticket.id) released.set(String(ticket.id), { version: `v${result.version}` });
    else if (result?.reason === "delivery_commit_unavailable" && ticket.ref) warnings.push(`${ticket.ref}: delivery commit unavailable; release status cannot be determined.`);
    else if (result?.reason === "git_evidence_unavailable") {
      evidenceUnavailable = true;
      warnings.push(`${ticket.ref}: git evidence unavailable; release status cannot be determined: ${evidenceError(input.git, "git command failed")}.`);
    }
  }
  if (!input.repo) {
    evidenceUnavailable = true;
    warnings.push(`GitHub project remote unavailable; untracked issue scan skipped: ${evidenceError(input.git, "origin remote unavailable")}.`);
  }
  const plan = planGithub({ links: input.links, tickets, released, gh: input.gh, ...input.repo ? { repo: input.repo } : {} });
  if (plan.evidenceUnavailable) evidenceUnavailable = true;
  warnings.push(...plan.warnings);
  const applied = apply ? [...applyGithub(plan, input.gh)] : [];
  const mirror = planIssueMirror({ tickets, links: input.links, config: input.issueMirror, repo: input.repo || null, context: input.mirrorContext });
  warnings.push(...mirror.warnings);
  if (apply && mirror.creations.length && typeof input.link === "function") applied.push(...applyIssueMirror(mirror, input.gh, input.link));
  else if (apply && mirror.creations.length) warnings.push("issue mirror has creations but no link writer; no issues were created.");
  return Object.freeze({
    staleBoardTickets: Object.freeze(staleBoardTickets || []),
    untrackedIssues: plan.untrackedIssues,
    linkedDrift: plan.linkedDrift,
    issueMirror: apply ? Object.freeze([]) : mirror.creations,
    warnings: Object.freeze([...new Set(warnings)]),
    applied: Object.freeze(applied),
    evidenceUnavailable
  });
}
function githubRepoFromGh(gh, cwd) {
  try {
    const name = String(gh("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true })).trim();
    return /^[^/\s]+\/[^/\s]+$/.test(name) ? name.toLowerCase() : null;
  } catch (error) {
    if (!gh.lastError) gh.lastError = errorText(error);
    return null;
  }
}
function foreignProjectNames(store, slug) {
  try {
    const projects = typeof store.listProjects === "function" ? store.listProjects({ all: true }) : [];
    return (Array.isArray(projects) ? projects : []).filter((project) => project && project.slug && project.slug !== slug).flatMap((project) => [String(project.slug || ""), String(project.name || "")]).filter(Boolean);
  } catch (_error) {
    return [];
  }
}
function auditProject(project, store, apply = false, dependencies = {}) {
  const projectPath = project.path || project.meta?.path;
  if (!projectPath) throw new Error(`audit project ${project.slug} has no filesystem path`);
  const git = dependencies.git || gitExecutor(projectPath);
  const gh = dependencies.gh || ghExecutor();
  let remote = dependencies.remote;
  if (remote === void 0) remote = git(["remote", "get-url", "origin"]);
  const repo = githubRepo(remote) || (remote ? githubRepoFromGh(gh, projectPath) : null);
  let issueMirror = null;
  try {
    issueMirror = typeof store.boardConfig === "function" ? store.boardConfig(project.slug)?.issueMirror : null;
  } catch (_error) {
    issueMirror = null;
  }
  return auditReport({
    tickets: store.listTickets(project.slug),
    links: store.listExternalLinks(project.slug, {}),
    git,
    gh,
    repo,
    issueMirror,
    mirrorContext: { hostname: import_node_os.default.hostname(), foreignProjects: foreignProjectNames(store, project.slug) },
    ...typeof store.addExternalLink === "function" ? { link: (ticketId, record) => store.addExternalLink(project.slug, ticketId, record) } : {}
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
    // The dry run prints the exact sanitized title and the body it would post, so
    // a human can read the first mirror before it reaches a public tracker.
    ["ISSUE MIRROR", report.issueMirror || [], (item) => `would create issue for ${item.ref} in ${item.repo}: ${JSON.stringify(item.title)}${item.labels.length ? ` [${item.labels.join(", ")}]` : ""}
  body: ${item.body.split("\n").join("\n  ")}`],
    ["WARNINGS", report.warnings, (item) => String(item)]
  ];
  const lines = sections.flatMap(([name, items, render]) => [`${name} (${items.length})`, ...items.map(render)]);
  if (report.applied.length) lines.push(`APPLIED (${report.applied.length})`, ...report.applied.map((item) => `${item.repo}#${item.number || "labels"} ${item.action}: ${item.ok ? "ok" : item.error || "failed"}`));
  return lines.join("\n");
}
function auditSummary(report) {
  const counts = [
    [report.staleBoardTickets.length, "board tickets have subject-tagged main commits plus delivery evidence"],
    [report.untrackedIssues.length, "untracked issues"],
    [report.linkedDrift.length, "linked issues drifting"],
    [(report.issueMirror || []).length, "tickets would be mirrored to new issues"]
  ].filter(([count]) => Number(count) > 0);
  return counts.length ? `sidequest audit: ${counts.map(([count, label]) => `${count} ${label}`).join(", ")}. Run \`sidequest audit\` for detail.` : "";
}
module.exports = { auditProject, auditReport, auditSummary, formatAudit, ghExecutor, gitExecutor };
