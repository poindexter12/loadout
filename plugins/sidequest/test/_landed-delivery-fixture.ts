import './_temp-cleanup.js';
'use strict';
// SQ-275: shared fixture for landed-delivery tests. Builds a bare `origin` repo and a
// clone configured as a remote-mode Sidequest board, with one ticket holding a submitted
// candidate. Exposes helpers to squash-land that candidate as a distinct delivery commit
// and to arrange the six evidence shapes the SQ-275 tests need to tell apart:
//   (a) push the delivery commit to origin/<branch>
//   (b) leave it unpushed
//   (c) force-push origin/<branch> PAST/AWAY from it after the local clone already
//       fetched it, so refs/remotes/origin/<branch> in the clone is stale-but-present
//   (d) park local <branch> (checked out) ON the delivery commit
//   (e) put the delivery commit on a non-default local branch
//   (f) make origin unreachable while local refs in the clone still hold the commit
//
// CRITICAL TRAP this fixture exists to avoid: earlier ad-hoc fixtures always parked the
// checkout AWAY from the delivery commit, so a refusal test passed even if a local-fallback
// bypass were reinstated in submissions.ts. Every refusal case built here leaves real local
// evidence (checkout HEAD, a local branch, or refs/remotes) genuinely containing the commit,
// so a refusal only proves correct behaviour when the remote's live advertisement, and
// nothing else, is what decided it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const store = require('../lib/store.js');
const db = require('../lib/db.js');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

// NOTE: the `project` column is the project SLUG, never a field on the ticket object itself
// (tickets don't carry a `project` property) — it must be passed in explicitly, matching how
// store.ts's own ticketStorageRow() builds this row.
function persist(slug: string, ticket: any) {
  const home = String(process.env.SIDEQUEST_HOME || '');
  db.putRow(db.openDb(home), 'tickets', {
    id: ticket.id,
    project: slug,
    ref: ticket.ref,
    status: ticket.status,
    archived: ticket.archived ? 1 : 0,
    ord: ticket.order,
    claim_by: ticket.claim ? ticket.claim.by : null,
    data: ticket,
  });
}

export function nodeVerify(source: string): string {
  return `"${process.execPath}" -e "${source.replace(/"/g, '\\"')}"`;
}

export interface LandedFixture {
  origin: string;
  repo: string;
  slug: string;
  ticketRef: string;
  candidate: string;
  base: string;
  branch: string;
}

// One ticket, one submitted candidate commit sitting on its OWN branch (never on `main`),
// against a clone of a bare `origin`. `main` starts out at the pre-candidate base, so no
// landing has happened yet until a test calls `landDelivery`.
export function makeLandedFixture(label: string, verify: string = nodeVerify('process.exit(0)')): LandedFixture {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), `sq-landed-origin-${label}-`));
  execFileSync('git', ['init', '-b', 'main', '--bare', origin], { encoding: 'utf8', windowsHide: true });

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `sq-landed-repo-${label}-`));
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Sidequest Test']);
  git(repo, ['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'landed delivery fixture\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/*\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'base']);
  git(repo, ['remote', 'add', 'origin', origin]);
  git(repo, ['push', '-u', 'origin', 'main']);
  const base = git(repo, ['rev-parse', 'HEAD']);

  const { slug } = store.ensureProject(repo);
  const ticket = store.createTicket(slug, {
    title: `${label} landed delivery fixture`,
    complexity: 2,
    complexityWhy: 'single-file fixture candidate for the SQ-275 landed-authority tests',
    files: ['feature.txt'],
    source: 'cli',
    labels: ['direct-ok'],
  });

  git(repo, ['checkout', '-b', `candidate/${ticket.ref}`]);
  fs.writeFileSync(path.join(repo, 'feature.txt'), 'candidate content\n');
  git(repo, ['add', 'feature.txt']);
  git(repo, ['commit', '-m', `${ticket.ref} candidate`]);
  const candidate = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['update-ref', `refs/sidequest/${ticket.ref}`, candidate]);
  git(repo, ['checkout', 'main']);

  const claimed = store.claimTicket(slug, ticket.ref, `${label}-worker`, {
    direct: true,
    reason: 'The landed-delivery fixture requires a local direct claim.',
  });
  if (!claimed.ok) throw new Error(`fixture claim failed: ${JSON.stringify(claimed)}`);
  const submitted = store.submitTicket(slug, ticket.ref, `${label}-worker`, { commit: candidate, verify });
  if (!submitted.ok) throw new Error(`fixture submit failed: ${JSON.stringify(submitted)}`);

  const fresh = store.getTicket(slug, ticket.ref);
  Object.assign(fresh.submission, {
    base,
    upstream: 'origin/main',
    upstreamCommit: base,
    commits: [candidate],
    changedPaths: ['feature.txt'],
  });
  persist(slug, fresh);

  return { origin, repo, slug, ticketRef: ticket.ref, candidate, base, branch: 'main' };
}

// Squash-lands the fixture's candidate onto `branch` (default the fixture's own branch,
// `main`), starting from the CURRENT tip of that branch, producing a brand-new commit with
// the same content but a different hash than `candidate` — the shape a real squash merge
// produces. Leaves the checkout on `branch` at the new delivery commit. Does not push.
export function landDelivery(fixture: LandedFixture, opts: { branch?: string; from?: string } = {}): string {
  const branch = opts.branch || fixture.branch;
  const from = opts.from || 'main';
  try {
    git(fixture.repo, ['rev-parse', '--verify', `refs/heads/${branch}`]);
    git(fixture.repo, ['checkout', '-f', branch]);
  } catch (_) {
    git(fixture.repo, ['checkout', '-f', '-B', branch, from]);
  }
  git(fixture.repo, ['merge', '--squash', fixture.candidate]);
  git(fixture.repo, ['commit', '-m', `${fixture.ticketRef} squash landed`]);
  return git(fixture.repo, ['rev-parse', 'HEAD']);
}

// (a)/(b): push (or don't) the delivery commit as the live tip of origin/<branch>.
export function pushDelivery(fixture: LandedFixture, commit: string, branch: string = fixture.branch) {
  git(fixture.repo, ['push', 'origin', `${commit}:refs/heads/${branch}`]);
}

export function fetchOrigin(fixture: LandedFixture) {
  git(fixture.repo, ['fetch', 'origin']);
}

// (c): move the LIVE origin branch away from (or past) a commit using a throwaway second
// clone, so the fixture's own clone never re-fetches and its refs/remotes/origin/<branch>
// stays exactly where it was (stale, but genuinely present) while the remote has moved on.
export function forceOriginAway(fixture: LandedFixture, branch: string = fixture.branch) {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-landed-origin-mover-'));
  execFileSync('git', ['clone', fixture.origin, other], { encoding: 'utf8', windowsHide: true });
  git(other, ['config', 'user.name', 'Sidequest Test']);
  git(other, ['config', 'user.email', 'sidequest-test@example.invalid']);
  // Diverge from the delivery commit entirely: branch from the fixture's PRE-candidate base
  // (a sibling history, not a descendant of the delivery commit) and force-push that over
  // origin/main. A commit built on top of the current origin tip would still have the
  // delivery commit as an ancestor (still "landed"); this must genuinely lose it.
  git(other, ['checkout', '-B', branch, fixture.base]);
  fs.writeFileSync(path.join(other, 'elsewhere.txt'), `diverged ${Date.now()}\n`);
  git(other, ['add', 'elsewhere.txt']);
  git(other, ['commit', '-m', 'origin diverged away from the delivery commit']);
  git(other, ['push', '--force', 'origin', branch]);
  fs.rmSync(other, { recursive: true, force: true });
}

// (f): origin becomes unreachable while the clone's own local refs (checkout, branches,
// refs/remotes) are left exactly as they were.
export function makeOriginUnreachable(fixture: LandedFixture) {
  git(fixture.repo, ['remote', 'set-url', 'origin', path.join(os.tmpdir(), 'sq-landed-origin-does-not-exist')]);
}

export function originTip(fixture: LandedFixture, branch: string = fixture.branch): string {
  return git(fixture.origin, ['rev-parse', branch]);
}

export function remoteTrackingTip(fixture: LandedFixture, branch: string = fixture.branch): string {
  return git(fixture.repo, ['rev-parse', `refs/remotes/origin/${branch}`]);
}

export function checkoutStatus(fixture: LandedFixture): string {
  return git(fixture.repo, ['status', '--porcelain']);
}

export function checkoutHead(fixture: LandedFixture): string {
  return git(fixture.repo, ['rev-parse', 'HEAD']);
}

export function worktreeList(fixture: LandedFixture): string {
  return git(fixture.repo, ['worktree', 'list', '--porcelain']);
}

// (group) Adds a SECOND ticket to the fixture's existing repo/origin, with its own candidate
// commit on its own branch, claimed and submitted the same way makeLandedFixture's first
// ticket was. Used by the group-delivery tests: two tickets, one shared squash-landed commit.
export function addTicket(fixture: LandedFixture, label: string): { ref: string; candidate: string } {
  const slug = fixture.slug;
  const ticket = store.createTicket(slug, {
    title: `${label} second landed delivery fixture ticket`,
    complexity: 2,
    complexityWhy: 'second single-file fixture candidate for the SQ-275 group landed-authority tests',
    files: [`feature-${label}.txt`],
    source: 'cli',
    labels: ['direct-ok'],
  });

  git(fixture.repo, ['checkout', 'main']);
  git(fixture.repo, ['checkout', '-b', `candidate/${ticket.ref}`]);
  const filename = `feature-${label}.txt`;
  fs.writeFileSync(path.join(fixture.repo, filename), `candidate content for ${ticket.ref}\n`);
  git(fixture.repo, ['add', filename]);
  git(fixture.repo, ['commit', '-m', `${ticket.ref} candidate`]);
  const candidate = git(fixture.repo, ['rev-parse', 'HEAD']);
  git(fixture.repo, ['update-ref', `refs/sidequest/${ticket.ref}`, candidate]);
  git(fixture.repo, ['checkout', 'main']);

  const claimed = store.claimTicket(slug, ticket.ref, `${label}-worker`, {
    direct: true,
    reason: 'The landed-delivery group fixture requires a local direct claim.',
  });
  if (!claimed.ok) throw new Error(`fixture claim failed: ${JSON.stringify(claimed)}`);
  const submitted = store.submitTicket(slug, ticket.ref, `${label}-worker`, { commit: candidate, verify: nodeVerify('process.exit(0)') });
  if (!submitted.ok) throw new Error(`fixture submit failed: ${JSON.stringify(submitted)}`);

  const fresh = store.getTicket(slug, ticket.ref);
  Object.assign(fresh.submission, {
    base: fixture.base,
    upstream: 'origin/main',
    upstreamCommit: fixture.base,
    commits: [candidate],
    changedPaths: [filename],
  });
  persist(slug, fresh);

  return { ref: ticket.ref, candidate };
}

// (group) Squash-lands MULTIPLE candidate commits onto `branch` as ONE combined commit, the
// shape a group/wave squash-merge produces when several tickets land together.
export function landDeliveryMulti(fixture: LandedFixture, candidates: string[], opts: { branch?: string; from?: string } = {}): string {
  const branch = opts.branch || fixture.branch;
  const from = opts.from || 'main';
  try {
    git(fixture.repo, ['rev-parse', '--verify', `refs/heads/${branch}`]);
    git(fixture.repo, ['checkout', '-f', branch]);
  } catch (_) {
    git(fixture.repo, ['checkout', '-f', '-B', branch, from]);
  }
  for (const candidate of candidates) {
    git(fixture.repo, ['merge', '--squash', candidate]);
  }
  git(fixture.repo, ['commit', '-m', 'group squash landed']);
  return git(fixture.repo, ['rev-parse', 'HEAD']);
}

module.exports = {
  nodeVerify,
  makeLandedFixture,
  landDelivery,
  pushDelivery,
  fetchOrigin,
  forceOriginAway,
  makeOriginUnreachable,
  originTip,
  remoteTrackingTip,
  checkoutStatus,
  checkoutHead,
  worktreeList,
  addTicket,
  landDeliveryMulti,
};
