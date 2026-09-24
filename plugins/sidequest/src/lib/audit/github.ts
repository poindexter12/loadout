'use strict';

/** GitHub is intentionally injected: planning and applying must be testable offline. */
export type GhExecutor = ((program: string, arguments_: string[], options?: Record<string, unknown>) => unknown) & { lastError?: string };
/** @deprecated Use GhExecutor for new GitHub ports. */
export type GitHubExecutor = GhExecutor;

type Link = Readonly<{ ticketId: string; ref: string; provider: string; repo: string; number: number }>;
type Ticket = Readonly<{ id: string; ref: string; status: string; submission?: { integratedAt?: string | null } | null }>;
type Release = Readonly<{ version: string }> | null;
type Issue = Readonly<{ number: number; state: string; labels: readonly string[]; title?: string }>;
type IssueAction = Readonly<{ type: 'addLabel' | 'removeLabel'; label: string }> | Readonly<{ type: 'comment'; body: string; marker: string }> | Readonly<{ type: 'close' }> | Readonly<{ type: 'reopen' }>;

type Drift = Readonly<{
  repo: string;
  number: number;
  ticketIds: readonly string[];
  refs: readonly string[];
  current: Readonly<{ state: string; labels: readonly string[] }>;
  desired: Readonly<{ state: string; labels: readonly string[] }>;
  actions: readonly IssueAction[];
}>;

export type GitHubPlan = Readonly<{
  linkedDrift: readonly Drift[];
  untrackedIssues: readonly (Issue & { repo: string })[];
  warnings: readonly string[];
  evidenceUnavailable: boolean;
}>;

function command(gh: GitHubExecutor, arguments_: string[]): string | null {
  try {
    const output = gh('gh', arguments_, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return String(output).trim();
  } catch (error: unknown) {
    if (!gh.lastError) gh.lastError = String((error as { message?: unknown })?.message || error || 'gh command failed').replace(/\s+/g, ' ').trim();
    return null;
  }
}

function jsonCommand(gh: GitHubExecutor, arguments_: string[]): unknown | null {
  const output = command(gh, arguments_);
  if (output == null) return null;
  try { return JSON.parse(output); } catch (_error: unknown) { return null; }
}

function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return [...new Set(labels.map((label) => typeof label === 'string' ? label : String((label as { name?: unknown })?.name || '')).filter(Boolean))].sort();
}

function normalizedIssue(value: unknown): Issue | null {
  if (!value || typeof value !== 'object') return null;
  const issue = value as { number?: unknown; state?: unknown; labels?: unknown; title?: unknown };
  const number = Number(issue.number);
  if (!Number.isInteger(number) || number < 1) return null;
  const state = String(issue.state || '').toUpperCase();
  if (state !== 'OPEN' && state !== 'CLOSED') return null;
  return Object.freeze({ number, state, labels: labelNames(issue.labels), ...(typeof issue.title === 'string' ? { title: issue.title } : {}) });
}

function releaseFor(released: ReadonlyMap<string, Release> | Record<string, Release> | undefined, ticketId: string): Release {
  if (!released) return null;
  if (released instanceof Map) return released.get(ticketId) || null;
  return (released as Record<string, Release>)[ticketId] || null;
}

function versionParts(version: string): number[] {
  const match = /v?(\d+(?:\.\d+)*)/i.exec(version);
  return match ? match[1]!.split('.').map(Number) : [];
}

function latestVersion(values: readonly string[]): string {
  return [...values].sort((left, right) => {
    const leftParts = versionParts(left); const rightParts = versionParts(right);
    const length = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < length; index += 1) {
      const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
      if (difference) return difference;
    }
    return left.localeCompare(right);
  }).at(-1) || '';
}

function ticketRank(ticket: Ticket, released: Release): number {
  if (released) return 3;
  if (ticket.submission && !ticket.submission.integratedAt) return 1;
  if (ticket.status === 'done') return 2;
  if (ticket.status === 'doing' || ticket.status === 'awaiting-oracle') return 1;
  return 0;
}

function desiredFor(tickets: readonly Ticket[], released: ReadonlyMap<string, Release> | Record<string, Release> | undefined, currentLabels: readonly string[]): { state: string; labels: string[]; releasedVersion: string | null } {
  const releases = tickets.map((ticket) => releaseFor(released, ticket.id));
  const allReleased = releases.length > 0 && releases.every(Boolean);
  const rank = Math.min(...tickets.map((ticket, index) => ticketRank(ticket, releases[index] || null)));
  const status = allReleased ? null : rank === 2 ? 'status:in-testing' : rank === 1 ? 'status:in-progress' : null;
  const labels = currentLabels.filter((label) => !label.startsWith('status:'));
  if (status) labels.push(status);
  return { state: allReleased ? 'CLOSED' : 'OPEN', labels: [...new Set(labels)].sort(), releasedVersion: allReleased ? latestVersion(releases.map((release) => release!.version)) : null };
}

function releaseComment(ticketIds: readonly string[], refs: readonly string[], version: string): { body: string; marker: string } {
  const marker = `<!-- sidequest:released ticket=${ticketIds.join(',')} version=${version} -->`;
  return {
    marker,
    body: `Fixed in ${version} (${refs.join(', ')}).\n\n${marker}`,
  };
}

/** Produces a report-only plan. It never executes a mutating GitHub command. */
export function planGithub({ links, tickets, released, gh, repo: projectRepo }: Readonly<{ links: readonly Link[]; tickets: readonly Ticket[]; released?: ReadonlyMap<string, Release> | Record<string, Release>; gh: GitHubExecutor; repo?: string }>): GitHubPlan {
  const ticketById = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const linksByIssue = new Map<string, Link[]>();
  for (const link of links) {
    if (link.provider !== 'github' || !ticketById.has(link.ticketId)) continue;
    const key = `${link.repo}#${link.number}`;
    linksByIssue.set(key, [...(linksByIssue.get(key) || []), link]);
  }
  const repos = [...new Set([...linksByIssue.values()].flat().map((link) => link.repo).concat(typeof projectRepo === 'string' && projectRepo.trim() ? [projectRepo.trim().toLowerCase()] : []))].sort();
  const issuesByRepo = new Map<string, Issue[]>();
  const warnings: string[] = [];
  let evidenceUnavailable = false;
  for (const repo of repos) {
    const payload = jsonCommand(gh, ['issue', 'list', '--repo', repo, '--state', 'all', '--limit', '1000', '--json', 'number,state,labels,title']);
    if (!Array.isArray(payload)) {
      evidenceUnavailable = true;
      warnings.push(`gh unavailable for ${repo}; GitHub sections skipped: ${gh.lastError || 'invalid GitHub response'}.`);
      continue;
    }
    issuesByRepo.set(repo, payload.map(normalizedIssue).filter((issue): issue is Issue => issue !== null));
  }
  if (repos.length && !issuesByRepo.size) return Object.freeze({ linkedDrift: [], untrackedIssues: [], warnings: Object.freeze(['gh not authenticated; GitHub sections skipped.', ...warnings]), evidenceUnavailable });

  const linkedDrift: Drift[] = [];
  const untrackedIssues: (Issue & { repo: string })[] = [];
  for (const repo of repos) {
    const issues = issuesByRepo.get(repo);
    if (!issues) continue;
    for (const issue of issues) {
      const linked = linksByIssue.get(`${repo}#${issue.number}`) || [];
      if (!linked.length) {
        if (issue.state === 'OPEN') untrackedIssues.push(Object.freeze({ ...issue, repo }));
        continue;
      }
      const linkedTickets = [...new Map(linked.map((link) => [link.ticketId, ticketById.get(link.ticketId)!])).values()];
      const ticketIds = linkedTickets.map((ticket) => ticket.id).sort();
      const refs = linkedTickets.map((ticket) => ticket.ref).sort();
      const desired = desiredFor(linkedTickets, released, issue.labels);
      const actions: IssueAction[] = [];
      for (const label of desired.labels.filter((label) => !issue.labels.includes(label))) actions.push(Object.freeze({ type: 'addLabel', label }));
      for (const label of issue.labels.filter((label) => label.startsWith('status:') && !desired.labels.includes(label))) actions.push(Object.freeze({ type: 'removeLabel', label }));
      if (desired.state === 'CLOSED') {
        const comment = releaseComment(ticketIds, refs, desired.releasedVersion!);
        if (!commentsContain(gh, repo, issue.number, comment.marker)) actions.push(Object.freeze({ type: 'comment', ...comment }));
        if (issue.state !== desired.state) actions.push(Object.freeze({ type: 'close' }));
      }
      if (issue.state !== desired.state && desired.state === 'OPEN') actions.push(Object.freeze({ type: 'reopen' }));
      if (actions.length) linkedDrift.push(Object.freeze({ repo, number: issue.number, ticketIds: Object.freeze(ticketIds), refs: Object.freeze(refs), current: Object.freeze({ state: issue.state, labels: Object.freeze([...issue.labels]) }), desired: Object.freeze({ state: desired.state, labels: Object.freeze(desired.labels) }), actions: Object.freeze(actions) }));
    }
  }
  return Object.freeze({ linkedDrift: Object.freeze(linkedDrift), untrackedIssues: Object.freeze(untrackedIssues), warnings: Object.freeze(warnings), evidenceUnavailable });
}

function paginatedArrays(output: string): unknown[] | null {
  try {
    const payload = JSON.parse(output);
    return Array.isArray(payload) ? payload : null;
  } catch (_error: unknown) {
    const values: unknown[] = [];
    let offset = 0;
    while (offset < output.length) {
      while (/\s/.test(output[offset] || '')) offset += 1;
      if (output[offset] !== '[') return null;
      let depth = 0;
      let quoted = false;
      let escaped = false;
      let end = offset;
      for (; end < output.length; end += 1) {
        const character = output[end]!;
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') quoted = false;
          continue;
        }
        if (character === '"') quoted = true;
        else if (character === '[') depth += 1;
        else if (character === ']') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (depth !== 0) return null;
      try {
        const page = JSON.parse(output.slice(offset, end + 1));
        if (!Array.isArray(page)) return null;
        values.push(...page);
      } catch (_error: unknown) { return null; }
      offset = end + 1;
    }
    return values;
  }
}

function commentsContain(gh: GitHubExecutor, repo: string, number: number, marker: string): boolean | null {
  const output = command(gh, ['api', `repos/${repo}/issues/${number}/comments`, '--paginate']);
  const comments = output === null ? null : paginatedArrays(output);
  if (comments === null) return null;
  return comments.some((comment) => String((comment as { body?: unknown })?.body || '').includes(marker));
}

export type GitHubApplyResult = Readonly<{ repo: string; number: number; action: string; ok: boolean; skipped?: boolean; error?: string }>;

/** Executes only actions already present in a plan. Comment failure prevents closing that issue. */
export function applyGithub(plan: GitHubPlan | null | undefined, gh: GitHubExecutor): readonly GitHubApplyResult[] {
  if (!plan || !Array.isArray(plan.linkedDrift) || !plan.linkedDrift.length) return [];
  const results: GitHubApplyResult[] = [];
  const labelsToCreate = new Map<string, Set<string>>();
  for (const drift of plan.linkedDrift) for (const action of drift.actions) if (action.type === 'addLabel' && (action.label === 'status:in-progress' || action.label === 'status:in-testing')) (labelsToCreate.get(drift.repo) || labelsToCreate.set(drift.repo, new Set()).get(drift.repo)!).add(action.label);
  for (const [repo, labels] of labelsToCreate) {
    const existing = jsonCommand(gh, ['label', 'list', '--repo', repo, '--limit', '1000', '--json', 'name']);
    const names = new Set(Array.isArray(existing) ? existing.map((label) => String((label as { name?: unknown })?.name || '')) : []);
    for (const label of labels) {
      if (names.has(label)) continue;
      const output = command(gh, ['label', 'create', label, '--repo', repo, '--color', '0E8A16']);
      results.push(Object.freeze({ repo, number: 0, action: `createLabel:${label}`, ok: output !== null, ...(output === null ? { error: 'gh command failed' } : {}) }));
    }
  }
  for (const drift of plan.linkedDrift) {
    let commentReady = true;
    for (const action of drift.actions) {
      if (action.type === 'addLabel' || action.type === 'removeLabel') {
        const flag = action.type === 'addLabel' ? '--add-label' : '--remove-label';
        const output = command(gh, ['issue', 'edit', String(drift.number), '--repo', drift.repo, flag, action.label]);
        results.push(Object.freeze({ repo: drift.repo, number: drift.number, action: action.type, ok: output !== null, ...(output === null ? { error: 'gh command failed' } : {}) }));
      } else if (action.type === 'comment') {
        const present = commentsContain(gh, drift.repo, drift.number, action.marker);
        if (present === null) {
          commentReady = false;
          results.push(Object.freeze({ repo: drift.repo, number: drift.number, action: 'comment', ok: false, error: 'could not list issue comments' }));
        } else if (present) {
          results.push(Object.freeze({ repo: drift.repo, number: drift.number, action: 'comment', ok: true, skipped: true }));
        } else {
          const output = command(gh, ['issue', 'comment', String(drift.number), '--repo', drift.repo, '--body', action.body]);
          commentReady = output !== null;
          results.push(Object.freeze({ repo: drift.repo, number: drift.number, action: 'comment', ok: commentReady, ...(commentReady ? {} : { error: 'gh command failed' }) }));
        }
      } else if (action.type === 'close') {
        if (!commentReady) results.push(Object.freeze({ repo: drift.repo, number: drift.number, action: 'close', ok: false, skipped: true, error: 'comment failed' }));
        else {
          const output = command(gh, ['issue', 'close', String(drift.number), '--repo', drift.repo]);
          results.push(Object.freeze({ repo: drift.repo, number: drift.number, action: 'close', ok: output !== null, ...(output === null ? { error: 'gh command failed' } : {}) }));
        }
      } else {
        const output = command(gh, ['issue', 'reopen', String(drift.number), '--repo', drift.repo]);
        results.push(Object.freeze({ repo: drift.repo, number: drift.number, action: 'reopen', ok: output !== null, ...(output === null ? { error: 'gh command failed' } : {}) }));
      }
    }
  }
  return Object.freeze(results);
}
