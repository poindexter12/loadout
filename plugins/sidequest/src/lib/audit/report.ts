'use strict';

import { execFileSync } from 'node:child_process';
import os from 'node:os';

const { deliveryCommit, findLandedFixes, releasedIn } = require('./local');
const { planGithub, applyGithub } = require('./github');
const { planIssueMirror, applyIssueMirror } = require('./mirror');

const AUDIT_COMMAND_TIMEOUT_MS = 15_000;
const AUDIT_COMMAND_MAX_BUFFER = 16 * 1024 * 1024;

type GitExecutor = ((args: string[]) => string | null) & { lastError?: string };
type GitHubExecutor = ((program: string, arguments_: string[], options?: Record<string, unknown>) => unknown) & { lastError?: string };
type Ticket = { id?: string; ref?: string; title?: string; status?: string; archived?: boolean | number; createdAt?: string; submission?: Record<string, unknown>; completion?: Record<string, unknown> };
type Link = { ticketId: string; ref: string; provider: string; repo: string; number: number; url?: string };

type LinkWriter = (ticketId: string, record: Readonly<{ provider: string; repo: string; number: number; url: string }>) => unknown;

type AuditInput = Readonly<{
  tickets: readonly Ticket[];
  links: readonly Link[];
  git: GitExecutor;
  gh: GitHubExecutor;
  repo?: string | null;
  issueMirror?: any;
  mirrorContext?: Readonly<{ hostname?: string; foreignProjects?: readonly string[] }>;
  link?: LinkWriter;
}>;

type AuditReport = Readonly<{
  staleBoardTickets: readonly any[];
  untrackedIssues: readonly any[];
  linkedDrift: readonly any[];
  issueMirror: readonly any[];
  warnings: readonly string[];
  applied: readonly any[];
  evidenceUnavailable: boolean;
}>;

function errorText(error: unknown): string {
  const value = error as { message?: unknown; code?: unknown };
  const message = String(value?.message || error || 'command failed').replace(/\s+/g, ' ').trim();
  const code = value?.code ? ` (${String(value.code)})` : '';
  return `${message}${code}`;
}

function githubRepo(remote: unknown): string | null {
  const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(String(remote || '').trim());
  return match ? match[1]!.replace(/\.git$/i, '').toLowerCase() : null;
}

function gitExecutor(cwd: string, execute: typeof execFileSync = execFileSync): GitExecutor {
  const git = ((args: string[]) => {
    try {
      return String(execute('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: AUDIT_COMMAND_TIMEOUT_MS, maxBuffer: AUDIT_COMMAND_MAX_BUFFER, killSignal: 'SIGKILL' }));
    } catch (error: unknown) {
      git.lastError = errorText(error);
      return null;
    }
  }) as GitExecutor;
  return git;
}

function ghExecutor(execute: typeof execFileSync = execFileSync): GitHubExecutor {
  const gh = ((program: string, arguments_: string[], options = {}) => {
    try {
      return execute(program, arguments_, { ...options, timeout: AUDIT_COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL' } as any);
    } catch (error: unknown) {
      gh.lastError = errorText(error);
      throw error;
    }
  }) as GitHubExecutor;
  return gh;
}

function evidenceError(executor: { lastError?: string }, fallback: string) {
  return executor.lastError || fallback;
}

function auditReport(input: AuditInput, apply = false): AuditReport {
  const tickets = input.tickets.filter((ticket) => ticket && ticket.id && ticket.ref);
  const warnings: string[] = [];
  let evidenceUnavailable = false;
  const staleEvidence = findLandedFixes(tickets, input.git);
  const titleById = new Map(tickets.map((ticket) => [ticket.id, ticket.title || '']));
  const staleBoardTickets = staleEvidence === null ? null : staleEvidence.map((item: any) => Object.freeze({ ...item, title: titleById.get(item.ticketId) || '' }));
  if (staleBoardTickets === null) {
    evidenceUnavailable = true;
    warnings.push(`git evidence unavailable; stale board tickets skipped: ${evidenceError(input.git, 'git command failed')}.`);
  }

  const linkedTicketIds = new Set(input.links.filter((link) => link.provider === 'github').map((link) => link.ticketId));
  const released = new Map<string, { version: string }>();
  const releaseByCommit = new Map<string, any>();
  for (const ticket of tickets) {
    if (ticket.status !== 'done' || !linkedTicketIds.has(String(ticket.id))) continue;
    const commit = deliveryCommit(ticket as any);
    const result = commit && releaseByCommit.has(commit)
      ? releaseByCommit.get(commit)
      : releasedIn(ticket as any, input.git);
    if (commit) releaseByCommit.set(commit, result);
    if (result && result.version && ticket.id) released.set(String(ticket.id), { version: `v${result.version}` });
    else if (result?.reason === 'delivery_commit_unavailable' && ticket.ref) warnings.push(`${ticket.ref}: delivery commit unavailable; release status cannot be determined.`);
    else if (result?.reason === 'git_evidence_unavailable') {
      evidenceUnavailable = true;
      warnings.push(`${ticket.ref}: git evidence unavailable; release status cannot be determined: ${evidenceError(input.git, 'git command failed')}.`);
    }
  }

  if (!input.repo) {
    evidenceUnavailable = true;
    warnings.push(`GitHub project remote unavailable; untracked issue scan skipped: ${evidenceError(input.git, 'origin remote unavailable')}.`);
  }
  const plan = planGithub({ links: input.links, tickets, released, gh: input.gh, ...(input.repo ? { repo: input.repo } : {}) });
  if (plan.evidenceUnavailable) evidenceUnavailable = true;
  warnings.push(...plan.warnings);
  const applied = apply ? [...applyGithub(plan, input.gh)] : [];

  // The mirror plans from board state alone, so a dry run (SessionStart, plain
  // `sidequest audit`) costs no extra GitHub call. Applying creates the issue
  // and records an ordinary external link; the linked-issue sync above owns it
  // from the next run onward, so there is no second sync path.
  const mirror = planIssueMirror({ tickets, links: input.links, config: input.issueMirror, repo: input.repo || null, context: input.mirrorContext });
  warnings.push(...mirror.warnings);
  if (apply && mirror.creations.length && typeof input.link === 'function') applied.push(...applyIssueMirror(mirror, input.gh, input.link));
  else if (apply && mirror.creations.length) warnings.push('issue mirror has creations but no link writer; no issues were created.');

  return Object.freeze({
    staleBoardTickets: Object.freeze(staleBoardTickets || []),
    untrackedIssues: plan.untrackedIssues,
    linkedDrift: plan.linkedDrift,
    issueMirror: apply ? Object.freeze([]) : mirror.creations,
    warnings: Object.freeze([...new Set(warnings)]),
    applied: Object.freeze(applied),
    evidenceUnavailable,
  });
}

function githubRepoFromGh(gh: GitHubExecutor, cwd: string): string | null {
  try {
    const name = String(gh('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })).trim();
    return /^[^/\s]+\/[^/\s]+$/.test(name) ? name.toLowerCase() : null;
  } catch (error: unknown) {
    if (!gh.lastError) gh.lastError = errorText(error);
    return null;
  }
}

/** Other boards on this machine are the single likeliest leak into a public issue, so they are named and denied. */
function foreignProjectNames(store: any, slug: string): string[] {
  try {
    const projects = typeof store.listProjects === 'function' ? store.listProjects({ all: true }) : [];
    return (Array.isArray(projects) ? projects : [])
      .filter((project: any) => project && project.slug && project.slug !== slug)
      .flatMap((project: any) => [String(project.slug || ''), String(project.name || '')])
      .filter(Boolean);
  } catch (_error: unknown) {
    return [];
  }
}

function auditProject(project: Readonly<{ slug: string; path?: string; meta?: { path?: string } }>, store: { listTickets: (slug: string) => Ticket[]; listExternalLinks: (slug: string, options: Record<string, never>) => Link[]; boardConfig?: (slug: string) => any; addExternalLink?: (slug: string, idOrRef: string, link: any) => unknown; listProjects?: (options: any) => any[] }, apply = false, dependencies: Partial<Readonly<{ git: GitExecutor; gh: GitHubExecutor; remote: string | null }>> = {}): AuditReport {
  const projectPath = project.path || project.meta?.path;
  if (!projectPath) throw new Error(`audit project ${project.slug} has no filesystem path`);
  const git = dependencies.git || gitExecutor(projectPath);
  const gh = dependencies.gh || ghExecutor();
  let remote = dependencies.remote;
  if (remote === undefined) remote = git(['remote', 'get-url', 'origin']);
  const repo = githubRepo(remote) || (remote ? githubRepoFromGh(gh, projectPath) : null);
  let issueMirror: any = null;
  try { issueMirror = typeof store.boardConfig === 'function' ? store.boardConfig(project.slug)?.issueMirror : null; } catch (_error: unknown) { issueMirror = null; }
  return auditReport({
    tickets: store.listTickets(project.slug),
    links: store.listExternalLinks(project.slug, {}),
    git,
    gh,
    repo,
    issueMirror,
    mirrorContext: { hostname: os.hostname(), foreignProjects: foreignProjectNames(store, project.slug) },
    ...(typeof store.addExternalLink === 'function' ? { link: (ticketId: string, record: any) => store.addExternalLink!(project.slug, ticketId, record) } : {}),
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
    // The dry run prints the exact sanitized title and the body it would post, so
    // a human can read the first mirror before it reaches a public tracker.
    ['ISSUE MIRROR', report.issueMirror || [], (item) => `would create issue for ${item.ref} in ${item.repo}: ${JSON.stringify(item.title)}${item.labels.length ? ` [${item.labels.join(', ')}]` : ''}\n  body: ${item.body.split('\n').join('\n  ')}`],
    ['WARNINGS', report.warnings, (item) => String(item)],
  ];
  const lines = sections.flatMap(([name, items, render]) => [`${name} (${items.length})`, ...items.map(render)]);
  if (report.applied.length) lines.push(`APPLIED (${report.applied.length})`, ...report.applied.map((item: any) => `${item.repo}#${item.number || 'labels'} ${item.action}: ${item.ok ? 'ok' : item.error || 'failed'}`));
  return lines.join('\n');
}

function auditSummary(report: AuditReport): string {
  const counts = [
    [report.staleBoardTickets.length, 'board tickets have subject-tagged main commits plus delivery evidence'],
    [report.untrackedIssues.length, 'untracked issues'],
    [report.linkedDrift.length, 'linked issues drifting'],
    [(report.issueMirror || []).length, 'tickets would be mirrored to new issues'],
  ].filter(([count]) => Number(count) > 0) as Array<[number, string]>;
  return counts.length ? `sidequest audit: ${counts.map(([count, label]) => `${count} ${label}`).join(', ')}. Run \`sidequest audit\` for detail.` : '';
}

module.exports = { auditProject, auditReport, auditSummary, formatAudit, ghExecutor, gitExecutor };
