'use strict';

import { execFileSync } from 'node:child_process';

const { findLandedFixes, releasedIn } = require('./local');
const { planGithub, applyGithub } = require('./github');

type GitExecutor = (args: string[]) => string | null;
type GitHubExecutor = (program: string, arguments_: string[], options?: Record<string, unknown>) => unknown;
type Ticket = { id?: string; ref?: string; title?: string; status?: string; archived?: boolean | number; createdAt?: string; submission?: Record<string, unknown>; completion?: Record<string, unknown> };
type Link = { ticketId: string; ref: string; provider: string; repo: string; number: number; url?: string };

type AuditInput = Readonly<{ tickets: readonly Ticket[]; links: readonly Link[]; git: GitExecutor; gh: GitHubExecutor; repo?: string | null }>;

type AuditReport = Readonly<{
  staleBoardTickets: readonly any[];
  untrackedIssues: readonly any[];
  linkedDrift: readonly any[];
  warnings: readonly string[];
  applied: readonly any[];
}>;

function githubRepo(remote: unknown): string | null {
  const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(String(remote || '').trim());
  return match ? match[1]!.replace(/\.git$/i, '').toLowerCase() : null;
}

function gitExecutor(cwd: string): GitExecutor {
  return (args) => {
    try {
      return String(execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }));
    } catch (_) {
      return null;
    }
  };
}

function ghExecutor(): GitHubExecutor {
  return (program, arguments_, options = {}) => execFileSync(program, arguments_, options as any);
}

function auditReport(input: AuditInput, apply = false): AuditReport {
  const tickets = input.tickets.filter((ticket) => ticket && ticket.id && ticket.ref);
  const warnings: string[] = [];
  const staleEvidence = findLandedFixes(tickets, input.git);
  const titleById = new Map(tickets.map((ticket) => [ticket.id, ticket.title || '']));
  const staleBoardTickets = staleEvidence === null ? null : staleEvidence.map((item: any) => Object.freeze({ ...item, title: titleById.get(item.ticketId) || '' }));
  if (staleBoardTickets === null) warnings.push('git evidence unavailable; stale board tickets skipped.');

  const released = new Map<string, { version: string }>();
  for (const ticket of tickets) {
    const result = releasedIn(ticket, input.git);
    if (result && result.version && ticket.id) released.set(ticket.id, { version: `v${result.version}` });
    else if (result?.reason && ticket.ref) warnings.push(`${ticket.ref}: delivery commit unavailable; release status cannot be determined.`);
  }

  if (!input.repo) warnings.push('GitHub project remote unavailable; untracked issue scan skipped.');
  const plan = planGithub({ links: input.links, tickets, released, gh: input.gh, ...(input.repo ? { repo: input.repo } : {}) });
  warnings.push(...plan.warnings);
  const applied = apply ? applyGithub(plan, input.gh) : [];
  return Object.freeze({
    staleBoardTickets: Object.freeze(staleBoardTickets || []),
    untrackedIssues: plan.untrackedIssues,
    linkedDrift: plan.linkedDrift,
    warnings: Object.freeze([...new Set(warnings)]),
    applied: Object.freeze(applied),
  });
}

function auditProject(project: Readonly<{ slug: string; path: string }>, store: { listTickets: (slug: string) => Ticket[]; listExternalLinks: (slug: string, options: Record<string, never>) => Link[] }, apply = false, dependencies: Partial<Readonly<{ git: GitExecutor; gh: GitHubExecutor; remote: string | null }>> = {}): AuditReport {
  const git = dependencies.git || gitExecutor(project.path);
  let remote = dependencies.remote;
  if (remote === undefined) remote = git(['remote', 'get-url', 'origin']);
  return auditReport({
    tickets: store.listTickets(project.slug),
    links: store.listExternalLinks(project.slug, {}),
    git,
    gh: dependencies.gh || ghExecutor(),
    repo: githubRepo(remote),
  }, apply);
}

function trunc(value: unknown, max = 72): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function actions(drift: any): string {
  return (drift.actions || []).map((action: any) => action.type === 'addLabel' || action.type === 'removeLabel' ? `${action.type} ${action.label}` : action.type).join(', ');
}

function formatAudit(report: AuditReport): string {
  const sections: Array<[string, readonly any[], (item: any) => string]> = [
    ['STALE BOARD TICKETS', report.staleBoardTickets, (item) => `${item.ref} ${trunc(item.title || '')} — ${(item.commits || []).map((commit: any) => commit.sha).join(', ') || 'landed fix'}`],
    ['UNTRACKED ISSUES', report.untrackedIssues, (item) => `${item.repo}#${item.number} ${trunc(item.title || '')} — https://github.com/${item.repo}/issues/${item.number}`],
    ['LINKED DRIFT', report.linkedDrift, (item) => `${(item.refs || []).join(', ')} — https://github.com/${item.repo}/issues/${item.number}; proposed: ${actions(item)}`],
    ['WARNINGS', report.warnings, (item) => String(item)],
  ];
  const lines = sections.flatMap(([name, items, render]) => [`${name} (${items.length})`, ...items.map(render)]);
  if (report.applied.length) lines.push(`APPLIED (${report.applied.length})`, ...report.applied.map((item: any) => `${item.repo}#${item.number || 'labels'} ${item.action}: ${item.ok ? 'ok' : item.error || 'failed'}`));
  return lines.join('\n');
}

function auditSummary(report: AuditReport): string {
  const counts = [
    [report.staleBoardTickets.length, 'board tickets look already fixed'],
    [report.untrackedIssues.length, 'untracked issues'],
    [report.linkedDrift.length, 'linked issues drifting'],
  ].filter(([count]) => Number(count) > 0) as Array<[number, string]>;
  return counts.length ? `sidequest audit: ${counts.map(([count, label]) => `${count} ${label}`).join(', ')}. Run \`sidequest audit\` for detail.` : '';
}

module.exports = { auditProject, auditReport, auditSummary, formatAudit, ghExecutor, gitExecutor };
