'use strict';

type GitExecutor = (args: string[]) => string | null;

type Ticket = {
  id?: string;
  ref?: string;
  status?: string;
  archived?: boolean | number;
  createdAt?: string;
  submission?: { integration?: { deliveryCommit?: string } };
  completion?: { delivery?: { commit?: string } };
};

type CommitEvidence = { sha: string; subject: string; date: string };
type LoggedCommit = CommitEvidence & { body: string };
type ReleaseResult = { version: string | null; tag: string | null; reason?: 'delivery_commit_unavailable' | 'git_evidence_unavailable' };

type LandedFix = {
  ticketId: string;
  ref: string;
  status: string;
  commits: CommitEvidence[];
  fragment: boolean;
  changelogVersion: string | null;
};

function execute(git: GitExecutor, args: string[]) {
  try {
    return git(args);
  } catch (_error: unknown) {
    return null;
  }
}

function mainRef(git: GitExecutor) {
  if (execute(git, ['rev-parse', '--verify', 'origin/main']) !== null) return 'origin/main';
  if (execute(git, ['rev-parse', '--verify', 'main']) !== null) return 'main';
  return null;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function refPattern(ref: string) {
  return new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegex(ref)}(?![A-Za-z0-9_-])`);
}

function commitsFromLog(log: string): LoggedCommit[] {
  return log.split('\x1e').flatMap((record) => {
    if (!record.trim()) return [];
    const [sha, date, subject, ...body] = record.trim().split('\x1f');
    if (!sha || !date || subject === undefined) return [];
    return [{ sha, date, subject, body: body.join('\x1f') }];
  });
}

function changelogVersionFor(changelog: string, ref: string) {
  let version: string | null = null;
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

function deliveryCommit(ticket: Ticket) {
  const values = [ticket.submission?.integration?.deliveryCommit, ticket.completion?.delivery?.commit];
  return values.map((value) => String(value || '').trim()).find(Boolean) || null;
}

/**
 * Finds active tickets whose ref appears in a newer commit on the integration branch.
 * The executor returns stdout, or null when a git operation cannot be inspected.
 */
function findLandedFixes(tickets: Ticket[], git: GitExecutor): LandedFix[] | null {
  const candidates = tickets.filter((ticket) => !ticket.archived && (ticket.status === 'todo' || ticket.status === 'doing') && ticket.id && ticket.ref);
  if (!candidates.length) return [];

  const main = mainRef(git);
  if (!main) return null;
  const log = execute(git, ['log', main, '--format=%H%x1f%aI%x1f%s%x1f%B%x1e']);
  const fragments = execute(git, ['ls-tree', '-r', '--name-only', main, '--', '.release/unreleased']);
  const changelog = execute(git, ['show', `${main}:CHANGELOG.md`]);
  if (log === null || fragments === null || changelog === null) return null;

  const fragmentPaths = new Set(fragments.split(/\r?\n/).filter(Boolean));
  const commits = commitsFromLog(log);
  return candidates.flatMap((ticket) => {
    const createdAt = new Date(String(ticket.createdAt || '')).valueOf();
    if (!Number.isFinite(createdAt)) return [];
    const matchesRef = refPattern(String(ticket.ref));
    const matchedCommits = commits
      .filter((commit) => new Date(commit.date).valueOf() > createdAt && matchesRef.test(`${commit.subject}\n${commit.body || ''}`))
      .map(({ sha, subject, date }) => ({ sha, subject, date }));
    if (!matchedCommits.length) return [];
    return [{
      ticketId: String(ticket.id),
      ref: String(ticket.ref),
      status: String(ticket.status),
      commits: matchedCommits,
      fragment: fragmentPaths.has(`.release/unreleased/${ticket.ref}.md`),
      changelogVersion: changelogVersionFor(changelog, String(ticket.ref)),
    }];
  });
}

/** Reports the first release tag containing a done ticket's recorded delivery commit. */
function releasedIn(ticket: Ticket, git: GitExecutor): ReleaseResult | null {
  if (ticket.status !== 'done') return null;
  const commit = deliveryCommit(ticket);
  if (!commit) return { version: null, tag: null, reason: 'delivery_commit_unavailable' };

  const tags = execute(git, ['tag', '--contains', commit, '--list', 'v*', '--sort=creatordate']);
  if (tags === null) return { version: null, tag: null, reason: 'git_evidence_unavailable' };
  const tag = tags.split(/\r?\n/).find(Boolean);
  return tag ? { version: tag.slice(1), tag } : null;
}

module.exports = { deliveryCommit, findLandedFixes, releasedIn };
