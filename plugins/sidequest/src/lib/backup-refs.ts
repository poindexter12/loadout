import { execFileSync } from 'node:child_process';

// Board-owned backup refs (SQ-178). Before this, orchestrators and executors
// hand-created refs such as refs/sidequest/SQ-106-preserve to protect work
// before a risky reset or rebase. Those names shared the candidate namespace,
// nothing listed them, and nothing deleted them. Backups now live in one
// documented namespace, separate from refs/sidequest/<REF> (the pinned
// candidate), are written with a reflog so every move is auditable, and are
// pruned once their ticket is done.
export const BACKUP_REF_NAMESPACE = 'refs/sidequest-backup';
export const CANDIDATE_REF_NAMESPACE = 'refs/sidequest';

const EMPTY_OID = '0000000000000000000000000000000000000000';
const TICKET_REF_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const STAMP_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z(?:-(\d+))?$/;
// Board-owned shapes under refs/sidequest/: the pinned candidate, rejection
// quarantine refs, and experiment rounds. Anything else there is ad hoc.
const BOARD_CANDIDATE_SUFFIX_RE = /^(?:-rejected(?:-\d+)?|\/r\d+)?$/;
const BOARD_CANDIDATE_RE = /^([A-Za-z][A-Za-z0-9]*-\d+)(?:-rejected(?:-\d+)?|\/r\d+)?$/;

export type BackupRef = { gitRef: string; ticket: string; commit: string; at: string | null };
type GitOutcome = { ok: true; value: string } | { ok: false; message: string };

function errorMessage(error: unknown): string {
  const stderr = (error as { stderr?: unknown })?.stderr;
  const text = typeof stderr === 'string' ? stderr : Buffer.isBuffer(stderr) ? stderr.toString('utf8') : '';
  return (text || (error instanceof Error ? error.message : String(error))).trim();
}

function git(cwd: string, args: readonly string[]): GitOutcome {
  try {
    const value = execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, value: value.trim() };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

function usableDirectory(cwd: unknown): string | null {
  const dir = String(cwd || '').trim();
  return dir || null;
}

export function isTicketRef(value: unknown): boolean {
  return TICKET_REF_RE.test(String(value || ''));
}

export function backupStamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[-:]/g, '').replace('.', '');
}

export function backupRefName(ticketRef: string, nowMs: number, attempt = 0): string {
  return `${BACKUP_REF_NAMESPACE}/${ticketRef}/${backupStamp(nowMs)}${attempt > 0 ? `-${attempt}` : ''}`;
}

function stampTime(stamp: string): string | null {
  const match = STAMP_RE.exec(stamp);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms] = match;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`;
}

function parseBackupRef(gitRef: string, commit: string): BackupRef | null {
  const prefix = `${BACKUP_REF_NAMESPACE}/`;
  if (!gitRef.startsWith(prefix)) return null;
  const [ticket, stamp, ...rest] = gitRef.slice(prefix.length).split('/');
  if (!ticket || !stamp || rest.length) return null;
  return { gitRef, ticket, commit, at: stampTime(stamp) };
}

function forEachRef(cwd: string, pattern: string): { ok: true; refs: Array<{ name: string; oid: string }> } | { ok: false; message: string } {
  const listed = git(cwd, ['for-each-ref', '--format=%(refname)%00%(objectname)', pattern]);
  if (!listed.ok) return listed;
  const refs = listed.value.split('\n').filter(Boolean).map((line) => {
    const [name = '', oid = ''] = line.split('\u0000');
    return { name, oid };
  });
  return { ok: true, refs };
}

// Pin `commit` at refs/sidequest-backup/<REF>/<UTC stamp>. Creation is
// compare-and-swap against an absent ref, so a backup is never overwritten;
// a same-millisecond collision takes the next numeric suffix instead.
export function writeBackupRef(cwd: unknown, ticketRef: unknown, commit: unknown, options: { now?: number; reason?: string } = {}) {
  const root = usableDirectory(cwd);
  const ref = String(ticketRef || '').trim();
  if (!root) return { ok: false as const, reason: 'no_repository', message: 'no project or worktree path to write the backup ref in' };
  if (!isTicketRef(ref)) return { ok: false as const, reason: 'invalid_ticket_ref', message: `"${ref}" is not a ticket ref` };
  const resolved = git(root, ['rev-parse', '--verify', '--quiet', `${String(commit || '').trim()}^{commit}`]);
  if (!resolved.ok || !resolved.value) {
    return { ok: false as const, reason: 'missing_commit', message: `commit ${String(commit || '')} is not present in ${root}` };
  }
  const nowMs = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const message = options.reason || `sidequest backup ${ref}`;
  let lastError = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const gitRef = backupRefName(ref, nowMs, attempt);
    const created = git(root, ['update-ref', '--create-reflog', '-m', message, gitRef, resolved.value, EMPTY_OID]);
    if (created.ok) return { ok: true as const, gitRef, commit: resolved.value };
    lastError = created.message;
  }
  return { ok: false as const, reason: 'git_error', message: lastError };
}

export function listBackupRefs(cwd: unknown, ticketRef?: unknown) {
  const root = usableDirectory(cwd);
  if (!root) return { ok: false as const, reason: 'no_repository', backups: [] as BackupRef[] };
  const ref = ticketRef == null ? '' : String(ticketRef).trim();
  const listed = forEachRef(root, ref ? `${BACKUP_REF_NAMESPACE}/${ref}/` : `${BACKUP_REF_NAMESPACE}/`);
  if (!listed.ok) return { ok: false as const, reason: 'git_error', message: listed.message, backups: [] as BackupRef[] };
  const backups = listed.refs
    .map((entry) => parseBackupRef(entry.name, entry.oid))
    .filter((entry): entry is BackupRef => Boolean(entry && (!ref || entry.ticket === ref)))
    .sort((a, b) => a.gitRef.localeCompare(b.gitRef));
  return { ok: true as const, backups };
}

// Refs under refs/sidequest/ that no board operation writes (for example a
// hand-made refs/sidequest/SQ-106-preserve). They are not candidates; the
// submission's recorded gitRef is. `knownRefs` excludes refs a ticket records.
export function unrecognizedCandidateRefs(cwd: unknown, ticketRef?: unknown, knownRefs: unknown[] = []) {
  const root = usableDirectory(cwd);
  if (!root) return [] as Array<{ gitRef: string; commit: string }>;
  const ref = ticketRef == null ? '' : String(ticketRef).trim();
  const listed = forEachRef(root, `${CANDIDATE_REF_NAMESPACE}/`);
  if (!listed.ok) return [];
  const known = new Set(knownRefs.map((value) => String(value || '').trim()).filter(Boolean));
  const prefix = `${CANDIDATE_REF_NAMESPACE}/`;
  return listed.refs.filter((entry) => {
    if (known.has(entry.name)) return false;
    const rest = entry.name.slice(prefix.length);
    if (ref) {
      if (!rest.startsWith(`${ref}-`) && !rest.startsWith(`${ref}/`)) return false;
      return !BOARD_CANDIDATE_SUFFIX_RE.test(rest.slice(ref.length));
    }
    return !BOARD_CANDIDATE_RE.test(rest);
  }).map((entry) => ({ gitRef: entry.name, commit: entry.oid }));
}

// Delete every backup whose ticket `isDone` reports done. The delete is a
// compare-and-swap against the listed commit so a concurrent rewrite survives.
export function pruneBackupRefs(cwd: unknown, isDone: (ticketRef: string) => boolean) {
  const listed = listBackupRefs(cwd);
  const pruned: string[] = [];
  const failures: Array<{ gitRef: string; message: string }> = [];
  if (!listed.ok) return { ok: false as const, reason: listed.reason, pruned, failures };
  const root = String(cwd).trim();
  const decided = new Map<string, boolean>();
  for (const backup of listed.backups) {
    if (!decided.has(backup.ticket)) {
      let done = false;
      try { done = isDone(backup.ticket) === true; } catch (_) { done = false; }
      decided.set(backup.ticket, done);
    }
    if (!decided.get(backup.ticket)) continue;
    const removed = git(root, ['update-ref', '-m', `sidequest prune ${backup.ticket} done`, '-d', backup.gitRef, backup.commit]);
    if (removed.ok) pruned.push(backup.gitRef);
    else failures.push({ gitRef: backup.gitRef, message: removed.message });
  }
  return { ok: failures.length === 0, pruned, failures };
}

// Per-ticket read surface for list/pulse. Null when there is nothing to show,
// so boards without backups keep their existing payload shape.
export function ticketRefSurface(cwd: unknown, ticket: any) {
  const ref = String(ticket?.ref || '').trim();
  if (!ref || !usableDirectory(cwd)) return null;
  const backups = listBackupRefs(cwd, ref).backups;
  // A submit may name its own gitRef; the recorded one is board-owned.
  const known = [ticket?.submission?.gitRef, ticket?.checkpoint?.gitRef];
  const unrecognized = unrecognizedCandidateRefs(cwd, ref, known);
  if (!backups.length && !unrecognized.length) return null;
  return {
    ...(backups.length ? { backupRefs: backups } : {}),
    ...(unrecognized.length ? {
      unrecognizedRefs: unrecognized,
      unrecognizedRefsHint: `These refs under ${CANDIDATE_REF_NAMESPACE}/ were not written by the board and are not ${ref}'s candidate. Back up through checkpoint (${BACKUP_REF_NAMESPACE}/${ref}/<stamp>); delete ad hoc refs once their commits are safe.`,
    } : {}),
  };
}

// Board-wide read surface for list: backup counts per ticket plus ad hoc refs.
export function boardRefSurface(cwd: unknown) {
  if (!usableDirectory(cwd)) return null;
  const counts = new Map<string, number>();
  for (const backup of listBackupRefs(cwd).backups) counts.set(backup.ticket, (counts.get(backup.ticket) || 0) + 1);
  const unrecognized = unrecognizedCandidateRefs(cwd);
  if (!counts.size && !unrecognized.length) return null;
  return {
    ...(counts.size ? { backupRefs: Array.from(counts, ([ticket, count]) => ({ ticket, count })) } : {}),
    ...(unrecognized.length ? { unrecognizedRefs: unrecognized.map((entry) => entry.gitRef) } : {}),
  };
}
