// SQ-275: the ONLY authority on whether a delivery commit has landed on a remote target branch.
//
// Two questions must never be conflated:
//   - checkout state ("is the local working position acceptable for recording a delivery?")
//     is answered from local refs, in submissions.ts (targetBranchMergedIntoHead).
//   - landedness ("is this commit on the remote target branch right now?") is answered here,
//     and only from a freshly obtained remote advertisement.
//
// The separation is structural: this module imports nothing from the store, takes no checkout,
// HEAD, local branch, or refs/remotes input, and never names a local ref in a git invocation.
// The only revision it reasons about is the tip SHA the remote advertised moments ago. Objects
// for that tip are fetched by SHA from the remote URL with --no-write-fetch-head, which writes
// objects only: no FETCH_HEAD, no refs, no opportunistic remote-tracking update. There is no
// degraded mode: an unreachable remote is a refusal, never a fallback to local evidence.
import { execFileSync } from 'node:child_process';

export interface LandedRemote {
  remote: string;
  branch: string;
}

export interface LandedProofInput extends LandedRemote {
  repo: string;
  commit: string;
}

export type LandedProof =
  | { ok: true; landed: boolean; remote: string; branch: string; tip: string | null; source: string; observedAt: string }
  | { ok: false; reason: 'landed_remote_unavailable'; remote: string; branch: string; detail: string };

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeout: 120_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function errorDetail(error: any): string {
  const text = String(error?.stderr || error?.message || error || '').trim();
  return text.split(/\r?\n/).filter(Boolean).slice(-1)[0] || 'git exited without detail';
}

// The remote a target delivers to, or null when the target is a local integration line with no
// remote at all (local-mode boards). `origin/main` and `refs/remotes/origin/main` both name a
// remote; `main` and `refs/heads/main` are local lines.
export function landedRemoteFromTarget(target: { mode?: string; upstream?: string; branch?: string } | null | undefined): LandedRemote | null {
  const branch = String(target?.branch || '').trim();
  let upstream = String(target?.upstream || '').trim();
  if (!branch || !upstream || target?.mode === 'local') return null;
  if (upstream.startsWith('refs/remotes/')) upstream = upstream.slice('refs/remotes/'.length);
  else if (upstream.startsWith('refs/')) return null;
  if (upstream === branch) return null;
  const slash = upstream.indexOf('/');
  if (slash <= 0) return null;
  return { remote: upstream.slice(0, slash), branch };
}

export function landedRemoteUnavailableMessage(ref: string, remote: string, branch: string, detail: string): string {
  return `${ref} reconciliation refused: remote ${remote} could not be contacted to read the live refs/heads/${branch} tip (${detail}). Landedness is decided only by the remote's live advertisement; there is no local fallback, so refs/remotes/${remote}/${branch}, the checkout's HEAD, and local branches are never consulted. Restore network access to ${remote} and record the delivery again.`;
}

export function proveLandedOnRemote(input: LandedProofInput): LandedProof {
  const { repo, remote, branch } = input;
  const commit = String(input.commit || '').toLowerCase();
  const observedAt = new Date().toISOString();
  const source = `git:${remote}/${branch}`;
  let advertisement: string;
  try {
    advertisement = git(repo, ['ls-remote', '--heads', '--', remote, `refs/heads/${branch}`]);
  } catch (error) {
    return { ok: false, reason: 'landed_remote_unavailable', remote, branch, detail: errorDetail(error) };
  }
  const line = advertisement.split(/\r?\n/).find((entry) => entry.split(/\s+/)[1] === `refs/heads/${branch}`);
  const tip = line ? String(line.split(/\s+/)[0] || '').toLowerCase() : null;
  if (!tip || !SHA_RE.test(tip)) return { ok: true, landed: false, remote, branch, tip: null, source, observedAt };
  if (tip === commit) return { ok: true, landed: true, remote, branch, tip, source, observedAt };
  try {
    git(repo, ['cat-file', '-e', `${tip}^{commit}`]);
  } catch (_) {
    try {
      const url = git(repo, ['remote', 'get-url', '--', remote]);
      git(repo, ['fetch', '--no-write-fetch-head', '--no-tags', '--quiet', '--', url, tip]);
    } catch (error) {
      return { ok: false, reason: 'landed_remote_unavailable', remote, branch, detail: `advertised tip ${tip} could not be fetched: ${errorDetail(error)}` };
    }
  }
  try {
    git(repo, ['merge-base', '--is-ancestor', commit, tip]);
    return { ok: true, landed: true, remote, branch, tip, source, observedAt };
  } catch (error: any) {
    if (error?.status === 1) return { ok: true, landed: false, remote, branch, tip, source, observedAt };
    return { ok: false, reason: 'landed_remote_unavailable', remote, branch, detail: errorDetail(error) };
  }
}
