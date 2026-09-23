"use strict";
var import_node_child_process = require("node:child_process");
const { findLandedFixes, releasedIn } = require("./local");
const { planGithub, applyGithub } = require("./github");
const AUDIT_COMMAND_TIMEOUT_MS = 15e3;
function githubRepo(remote) {
  const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(String(remote || "").trim());
  return match ? match[1].replace(/\.git$/i, "").toLowerCase() : null;
}
function gitExecutor(cwd, execute = import_node_child_process.execFileSync) {
  return (args) => {
    try {
      return String(execute("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: AUDIT_COMMAND_TIMEOUT_MS, killSignal: "SIGKILL" }));
    } catch (_) {
      return null;
    }
  };
}
function ghExecutor(execute = import_node_child_process.execFileSync) {
  return (program, arguments_, options = {}) => execute(program, arguments_, { ...options, timeout: AUDIT_COMMAND_TIMEOUT_MS, killSignal: "SIGKILL" });
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
  const plan = planGithub({ links: input.links, tickets, released, gh: input.gh, ...input.repo ? { repo: input.repo } : {} });
  warnings.push(...plan.warnings);
  const applied = apply ? applyGithub(plan, input.gh) : [];
  return Object.freeze({
    staleBoardTickets: Object.freeze(staleBoardTickets || []),
    untrackedIssues: plan.untrackedIssues,
    linkedDrift: plan.linkedDrift,
    warnings: Object.freeze([...new Set(warnings)]),
    applied: Object.freeze(applied)
  });
}
function auditProject(project, store, apply = false, dependencies = {}) {
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
function auditSummary(report) {
  const counts = [
    [report.staleBoardTickets.length, "board tickets look already fixed"],
    [report.untrackedIssues.length, "untracked issues"],
    [report.linkedDrift.length, "linked issues drifting"]
  ].filter(([count]) => Number(count) > 0);
  return counts.length ? `sidequest audit: ${counts.map(([count, label]) => `${count} ${label}`).join(", ")}. Run \`sidequest audit\` for detail.` : "";
}
module.exports = { auditProject, auditReport, auditSummary, formatAudit, ghExecutor, gitExecutor };
