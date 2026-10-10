'use strict';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type LeaseIdentity = Readonly<{ status: 'bound'; agentId?: string; dispatchRef?: string } | { status: 'unknown' }>;
export type LeaseLiveness = Readonly<{ status: 'live'; evidence: string } | { status: 'terminal'; evidence: string } | { status: 'unknown' }>;
export type LeasePhase = 'prepared' | 'created' | 'bound' | 'claimed' | 'working' | 'submitted' | 'integrated' | 'terminal';
export type WorktreeProvisioning = 'host' | 'sidequest-copy' | 'sidequest-link' | 'unknown';
export type BaselineAncestry = 'ancestor' | 'unrelated' | 'unknown';
export type WorktreeLeaseFacts = Readonly<{
  repository: string;
  gitDirectory: string;
  commonGitDirectory: string;
  dispatchRef: string | null;
  dispatchBaseline: string | null;
  // Revisions the board itself authored for this dispatch, while its claim is still held. A commit the
  // lifecycle sanctioned is not drift away from the baseline, so it must not revoke the lease that
  // authorized it (SQ-2182).
  sanctionedRevisions?: readonly string[];
  // Whether the dispatch baseline is reachable from the observed revision. Three states rather than a
  // boolean because "we read the ancestry and it is unrelated" and "we could not read it" must not
  // collapse into one falsy value: only 'ancestor' permits a write, and 'unknown' keeps refusing.
  baselineAncestry?: BaselineAncestry;
  // Whether the claim that authorized this worktree is still held. Ancestry is a plain git fact and knows
  // nothing about the lifecycle, so the gate that keeps authority following the claim lives here.
  claimHeld?: boolean;
  observedRevision: string | null;
  observedWorktree: string | null;
  boundRevision?: string | null;
  boundWorktree?: string | null;
  boundGitDirectory?: string | null;
  boundCommonGitDirectory?: string | null;
  boundCheckoutInstance?: string | null;
  identity: LeaseIdentity;
  phase: LeasePhase;
  locked: boolean;
  liveness: LeaseLiveness;
  provisioning: WorktreeProvisioning;
}>;
export type WorktreeLease = Readonly<WorktreeLeaseFacts & {
  canonicalRepository: string;
  canonicalGitDirectory: string;
  canonicalCommonGitDirectory: string;
  canonicalWorktree: string | null;
  canonicalBoundWorktree: string | null;
  canonicalBoundGitDirectory: string | null;
  canonicalBoundCommonGitDirectory: string | null;
  observedCheckoutInstance: string | null;
}>;
export type LeaseDecision = Readonly<{ allowed: boolean; reason: string }>;
export type LegacyWorktreeCleanupFacts = Readonly<{
  registered: boolean;
  clean: boolean;
  oldEnough: boolean;
  settled: boolean;
}>;

const CHECKOUT_INSTANCE_MARKER = 'sidequest-checkout-instance';

function checkoutInstanceDigest(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function checkoutInstanceIdentity(gitDirectory: string): string | null {
  try {
    const token = fs.readFileSync(path.join(gitDirectory, CHECKOUT_INSTANCE_MARKER), 'utf8').trim();
    return /^[a-f0-9]{64}$/.test(token) ? checkoutInstanceDigest(token) : null;
  } catch {
    return null;
  }
}

export function createCheckoutInstanceMarker(gitDirectory: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(gitDirectory, CHECKOUT_INSTANCE_MARKER), `${token}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return checkoutInstanceDigest(token);
}

function platformPath(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

export function canonicalPath(value: string): string {
  const gitBashDrive = process.platform === 'win32' ? /^\/([a-zA-Z])(?=\/|$)/.exec(value) : null;
  const resolved = path.resolve(gitBashDrive ? `${gitBashDrive[1]}:${value.slice(2)}` : value);
  const missing: string[] = [];
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return platformPath(resolved);
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    return platformPath(path.join(fs.realpathSync.native(existing), ...missing));
  } catch {
    return platformPath(resolved);
  }
}

export function sameCanonicalPath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

// SQ-303. Four facts about a checkout that the codebase used to learn by spawning `git rev-parse`:
// `--show-toplevel`, `--git-dir`, `--git-common-dir` and `--verify HEAD^{commit}`. The spawns are the
// expensive part by a wide margin — on a contended host each costs ~370ms, so the six that
// `immutableWorktreeFacts` made cost ~2.2s inside a board write transaction, and the three the Edit-path
// guard made cost ~1.1s on every write an executor performed. Both hooks have 10s before Claude Code kills
// them and discards the decision, and both were hitting it.
//
// All four are files in git's documented on-disk layout, so read them. This returns null for any layout it
// will not state plainly — no `.git` to find, a pointer file it cannot parse, a ref it cannot resolve — and
// every caller falls back to the spawns, so an unusual repository loses the speed rather than the answer.
// `revision` is separately nullable: an unborn HEAD has no commit, which is a real state and not a failure
// to read one.
export type CheckoutLayout = Readonly<{
  root: string;
  gitDirectory: string;
  commonGitDirectory: string;
  revision: string | null;
}>;

const REVISION_PATTERN = /^[0-9a-f]{40,64}$/i;

function readTrimmedFile(file: string): string | null {
  try {
    const contents = fs.readFileSync(file, 'utf8').trim();
    return contents || null;
  } catch {
    return null;
  }
}

// `git rev-parse --show-toplevel` resolves a path inside a checkout to that checkout's root, so a candidate
// naming a subdirectory normalizes the same way it always did.
//
// The existence check is load-bearing, not defensive. `rev-parse` runs with the candidate as its working
// directory and fails outright when that directory is gone, which is how a removed worktree reads as "no
// facts". Walking up from a path that does not exist would instead keep climbing to whatever checkout
// encloses it — for a worktree under the repository, the shared checkout itself — and report ITS identity
// as the candidate's. That is the SQ-2189 failure this code exists to prevent, so stop where git stops.
function enclosingCheckoutRoot(start: string): string | null {
  let current = path.resolve(start);
  try {
    if (!fs.statSync(current).isDirectory()) return null;
  } catch {
    return null;
  }
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// A primary checkout's `.git` is a directory and is its own common dir. A linked worktree's `.git` is a
// file naming its per-worktree git dir, and that dir's `commondir` names the shared one.
function gitDirectoryOf(root: string): string | null {
  const entry = path.join(root, '.git');
  let stats: fs.Stats;
  try {
    stats = fs.statSync(entry);
  } catch {
    return null;
  }
  if (stats.isDirectory()) return entry;
  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readTrimmedFile(entry) || '')?.[1];
  if (!pointer) return null;
  return path.isAbsolute(pointer) ? pointer : path.resolve(root, pointer);
}

// A linked worktree keeps HEAD and its other per-worktree refs in its own git dir and shares `refs/heads`
// through the common dir. Git resolves a ref in that order, so this does too, with packed-refs last.
function resolveRefRevision(gitDirectory: string, commonGitDirectory: string, ref: string): string | null {
  const segments = ref.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  const bases = gitDirectory === commonGitDirectory ? [gitDirectory] : [gitDirectory, commonGitDirectory];
  for (const base of bases) {
    const loose = readTrimmedFile(path.join(base, ...segments));
    if (loose && REVISION_PATTERN.test(loose)) return loose;
  }
  const packed = readTrimmedFile(path.join(commonGitDirectory, 'packed-refs'));
  for (const line of packed ? packed.split(/\r?\n/) : []) {
    const entry = /^([0-9a-f]{40,64})\s+(\S+)$/i.exec(line.trim());
    if (entry && entry[2] === ref) return entry[1]!;
  }
  return null;
}

function headRevision(gitDirectory: string, commonGitDirectory: string): string | null {
  const head = readTrimmedFile(path.join(gitDirectory, 'HEAD'));
  if (!head) return null;
  if (REVISION_PATTERN.test(head)) return head;
  const ref = /^ref:\s*(.+?)\s*$/.exec(head)?.[1];
  return ref ? resolveRefRevision(gitDirectory, commonGitDirectory, ref) : null;
}

export function checkoutLayout(start: string): CheckoutLayout | null {
  const root = enclosingCheckoutRoot(start);
  if (!root) return null;
  const gitDirectory = gitDirectoryOf(root);
  if (!gitDirectory) return null;
  const pointer = readTrimmedFile(path.join(gitDirectory, 'commondir'));
  const commonGitDirectory = pointer
    ? (path.isAbsolute(pointer) ? pointer : path.resolve(gitDirectory, pointer))
    : gitDirectory;
  return { root, gitDirectory, commonGitDirectory, revision: headRevision(gitDirectory, commonGitDirectory) };
}

export function createWorktreeLease(facts: WorktreeLeaseFacts): WorktreeLease {
  return Object.freeze({
    ...facts,
    identity: Object.freeze({ ...facts.identity }),
    liveness: Object.freeze({ ...facts.liveness }),
    sanctionedRevisions: Object.freeze((facts.sanctionedRevisions || []).map((revision) => String(revision).toLowerCase())),
    baselineAncestry: facts.baselineAncestry || 'unknown',
    claimHeld: Boolean(facts.claimHeld),
    canonicalRepository: canonicalPath(facts.repository),
    canonicalGitDirectory: canonicalPath(facts.gitDirectory),
    canonicalCommonGitDirectory: canonicalPath(facts.commonGitDirectory),
    canonicalWorktree: facts.observedWorktree ? canonicalPath(facts.observedWorktree) : null,
    canonicalBoundWorktree: facts.boundWorktree ? canonicalPath(facts.boundWorktree) : null,
    canonicalBoundGitDirectory: facts.boundGitDirectory ? canonicalPath(facts.boundGitDirectory) : null,
    canonicalBoundCommonGitDirectory: facts.boundCommonGitDirectory ? canonicalPath(facts.boundCommonGitDirectory) : null,
    observedCheckoutInstance: checkoutInstanceIdentity(facts.gitDirectory),
  });
}

function denied(reason: string): LeaseDecision {
  return Object.freeze({ allowed: false, reason });
}

function allowed(reason: string): LeaseDecision {
  return Object.freeze({ allowed: true, reason });
}

function unknownIdentityDecision(operation: string): LeaseDecision {
  return denied(`${operation} requires a bound worktree identity.`);
}

function sanctionedRevision(lease: WorktreeLease, revision: string | null): boolean {
  return Boolean(revision && (lease.sanctionedRevisions || []).includes(revision.toLowerCase()));
}

// A refusal delivered through a hook has a hard byte budget, and full hashes are 40 bytes each of the
// least actionable content in the sentence. Twelve is past any collision an executor will meet, and the
// full value is one rev-parse away.
function shortRevision(revision: string | null): string {
  return String(revision || '').slice(0, 12);
}

function revisionIsBaseline(lease: WorktreeLease): boolean {
  return !lease.dispatchBaseline || !lease.observedRevision || lease.dispatchBaseline === lease.observedRevision;
}

// Scope is named as a non-cause on purpose: the refusal read like a permission problem and sent executors
// to request access they already held (SQ-2182). The cause clause leads, ahead of the hashes, because the
// hook budget truncates the tail and the meaning must be what survives.
function unsanctionedRevisionRefusal(lease: WorktreeLease, cause: string): LeaseDecision {
  return denied(
    `${cause}; not a scope decision `
    + `(baseline ${shortRevision(lease.dispatchBaseline)}, observed ${shortRevision(lease.observedRevision)}).`,
  );
}

// Creation demands the exact baseline, and deliberately does not accept a descendant the way a write does.
// Submission ranges are computed against this baseline (see sameBaseline in kernel/submission.ts), so a
// worktree created even one commit ahead of it would attribute a commit this executor never wrote to this
// ticket.
function creationBaselineDecision(lease: WorktreeLease): LeaseDecision | null {
  if (revisionIsBaseline(lease)) return null;
  if (sanctionedRevision(lease, lease.observedRevision)) return null;
  return unsanctionedRevisionRefusal(lease, 'this revision is not the dispatch baseline and was not sanctioned by the board for this claim');
}

// A write needs the worktree to be on the history this dispatch started from, not frozen at its first
// commit. Two ways to be on it. A revision the board itself authored while the claim was held is
// sanctioned outright: before that, the first board commit permanently revoked the write lease, and submit
// then demanded a release fragment the executor was mechanically forbidden to create (SQ-2182). A revision
// that merely descends from the baseline is equally not drift, and refusing it contradicted the
// synchronization step in the executor's own briefing, which defines a correct worktree as one where
// `git merge-base --is-ancestor <baseCommit> HEAD` passes. A raw `git commit` in an isolated worktree
// reached the same dead end as the sanctioned one did, by a route no guard covered (SQ-2193).
function writeBaselineDecision(lease: WorktreeLease): LeaseDecision | null {
  if (revisionIsBaseline(lease)) return null;
  // Both routes off the baseline require the authorizing claim to still be held. The sanctioned list
  // carries that gate itself, since the store returns none without a live claim; ancestry is a plain git
  // fact, so its gate has to be stated here.
  if (sanctionedRevision(lease, lease.observedRevision)) return null;
  if (lease.baselineAncestry === 'ancestor' && lease.claimHeld) return null;
  return unsanctionedRevisionRefusal(lease, writeBaselineCause(lease));
}

function writeBaselineCause(lease: WorktreeLease): string {
  if (lease.baselineAncestry === 'unrelated') {
    return 'HEAD does not descend from the dispatch baseline, so this worktree left the history the board dispatched';
  }
  if (lease.baselineAncestry === 'ancestor') {
    return 'the claim that authorized this worktree is no longer held, so commits made under it no longer carry a write lease';
  }
  return 'this revision was not sanctioned by the board for this claim and its descent from the dispatch baseline could not be read';
}

function boundRevisionDecision(lease: WorktreeLease): LeaseDecision | null {
  if (!lease.boundRevision || !lease.observedRevision || lease.boundRevision === lease.observedRevision) return null;
  return denied(`bound worktree revision ${lease.boundRevision} differs from observed worktree revision ${lease.observedRevision}.`);
}

function repositoryDecision(lease: WorktreeLease): LeaseDecision | null {
  if (lease.canonicalCommonGitDirectory !== canonicalPath(path.join(lease.canonicalRepository, '.git'))) {
    return denied('The observed worktree does not share the dispatch repository Git directory.');
  }
  if (lease.canonicalBoundWorktree && lease.canonicalBoundWorktree !== lease.canonicalWorktree) {
    return denied('The observed worktree differs from the dispatch-bound worktree.');
  }
  if (lease.canonicalBoundGitDirectory && lease.canonicalBoundGitDirectory !== lease.canonicalGitDirectory) {
    return denied('The observed worktree Git directory differs from the dispatch-bound Git directory.');
  }
  if (lease.canonicalBoundCommonGitDirectory && lease.canonicalBoundCommonGitDirectory !== lease.canonicalCommonGitDirectory) {
    return denied('The observed common Git directory differs from the dispatch-bound common Git directory.');
  }
  return null;
}

function checkoutInstanceDecision(lease: WorktreeLease): LeaseDecision | null {
  if (lease.canonicalGitDirectory === lease.canonicalCommonGitDirectory) return null;
  if (!lease.boundCheckoutInstance) return denied('The dispatch-bound checkout instance is unavailable.');
  if (!lease.observedCheckoutInstance) return denied('The observed checkout instance is unavailable.');
  return lease.boundCheckoutInstance === lease.observedCheckoutInstance
    ? null
    : denied('The observed checkout instance differs from the dispatch-bound checkout instance.');
}

export function worktreeCreateDecision(lease: WorktreeLease): LeaseDecision {
  if (lease.identity.status === 'unknown') return unknownIdentityDecision('Creation');
  if (lease.phase !== 'prepared') return denied('Creation requires a prepared worktree lease.');
  if (!lease.dispatchRef) return denied('Creation requires a dispatch binding.');
  if (!lease.canonicalWorktree || !lease.canonicalBoundWorktree) return denied('Creation requires a bound worktree target.');
  return repositoryDecision(lease) || creationBaselineDecision(lease) || allowed('the prepared dispatch owns the bound worktree target.');
}

export function worktreeWriteDecision(lease: WorktreeLease, target: string): LeaseDecision {
  if (lease.identity.status === 'unknown') return unknownIdentityDecision('A write');
  if (!lease.canonicalWorktree) return denied('A write requires an observed worktree.');
  if (!lease.canonicalBoundWorktree) return denied('A write requires an immutable worktree binding.');
  const repository = repositoryDecision(lease);
  if (repository) return repository;
  const checkoutInstance = checkoutInstanceDecision(lease);
  if (checkoutInstance) return checkoutInstance;
  const baseline = writeBaselineDecision(lease);
  if (baseline) return baseline;
  const relative = path.relative(lease.canonicalWorktree, canonicalPath(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
    ? allowed('target belongs to the bound worktree.')
    : denied('target is outside the bound worktree.');
}

export function worktreeResumeDecision(lease: WorktreeLease): LeaseDecision {
  if (lease.identity.status === 'unknown') return unknownIdentityDecision('Resume');
  if (!lease.canonicalWorktree) return denied('Resume requires an observed worktree.');
  return repositoryDecision(lease) || checkoutInstanceDecision(lease) || boundRevisionDecision(lease) || allowed('the bound worktree matches its release-time identity.');
}

export function worktreeCleanupDecision(lease: WorktreeLease, registeredWorktrees: readonly string[]): LeaseDecision {
  if (lease.identity.status === 'unknown') return unknownIdentityDecision('Cleanup');
  if (!lease.canonicalWorktree) return denied('Cleanup requires an observed worktree.');
  const repository = repositoryDecision(lease);
  if (repository) return repository;
  const checkoutInstance = checkoutInstanceDecision(lease);
  if (checkoutInstance) return checkoutInstance;
  if (!registeredWorktrees.some((registered) => sameCanonicalPath(registered, lease.canonicalWorktree!))) return denied('Cleanup requires a canonical registered worktree.');
  if (lease.phase !== 'terminal' && lease.phase !== 'integrated') return denied('Cleanup requires a terminal lease phase.');
  if (lease.locked) return denied('Cleanup refuses a locked worktree.');
  if (lease.liveness.status !== 'terminal') return denied('Cleanup requires proven terminal liveness.');
  if (lease.provisioning === 'unknown') return denied('Cleanup refuses an unknown provisioning strategy.');
  return allowed('the terminal bound worktree is safe to clean.');
}

export function legacyWorktreeCleanupDecision(facts: LegacyWorktreeCleanupFacts): LeaseDecision {
  if (!facts.registered) return denied('Legacy cleanup requires a canonical registered worktree.');
  if (!facts.clean) return denied('Legacy cleanup refuses uncommitted changes.');
  if (!facts.oldEnough) return denied('Legacy cleanup requires the minimum age.');
  if (!facts.settled) return denied('Legacy cleanup requires a reachable or patch-equivalent revision.');
  return allowed('the registered legacy worktree is clean, settled, and old enough.');
}

export function isCanonicalRegisteredWorktree(lease: WorktreeLease, registeredWorktrees: readonly string[]): boolean {
  return Boolean(lease.canonicalWorktree) && registeredWorktrees.some((registered) => sameCanonicalPath(registered, lease.canonicalWorktree!));
}
