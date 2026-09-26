import { spawnSync } from 'node:child_process';

export class GitError extends Error {
  constructor(args, result) {
    super(`git ${args.join(' ')} failed (${result.code}): ${(result.stderr || result.stdout || '').trim()}`);
    this.args = args;
    this.result = result;
  }
}

/** How long one remote probe may run before its remote counts as one that could not be checked. */
export const REMOTE_PROBE_TIMEOUT_MS = 60_000;

/** LOADOUT_RELEASE_REMOTE_TIMEOUT_MS overrides the bound; anything but a positive number keeps the default. */
export function remoteProbeTimeoutMs(environment = process.env) {
  const timeout = Number(environment.LOADOUT_RELEASE_REMOTE_TIMEOUT_MS);
  return Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : REMOTE_PROBE_TIMEOUT_MS;
}

/**
 * The verbs that read a remote. They run non-interactively and time-bounded, so a remote that
 * blocks (a blackholed host, a password or passphrase prompt) fails the probe instead of hanging it.
 */
export function probesRemote(args) {
  return args[0] === 'ls-remote' || args[0] === 'fetch';
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The environment a remote probe runs in. Git may not prompt on the terminal, and ssh runs in batch
 * mode, so it fails rather than ask for a password, a passphrase, or a host-key confirmation. The ssh
 * command is the one git would have chosen, in git's own order (GIT_SSH_COMMAND, then core.sshCommand
 * as `configuredSshCommand`, then GIT_SSH, then plain ssh) with `-o BatchMode=yes` appended, so a
 * configured key, option, or wrapper still applies.
 */
export function remoteProbeEnvironment(environment = process.env, configuredSshCommand = null) {
  const sshCommand = environment.GIT_SSH_COMMAND
    || configuredSshCommand
    || (environment.GIT_SSH ? shellQuote(environment.GIT_SSH) : 'ssh');
  return { ...environment, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: `${sshCommand} -o BatchMode=yes` };
}

function configuredSshCommand(cwd, env) {
  const result = spawnSync('git', ['config', '--get', 'core.sshCommand'], { cwd, env, encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

/**
 * Runs git in `cwd`. A remote probe (see probesRemote) runs in remoteProbeEnvironment and is killed
 * after `remoteTimeoutMs`; the timeout comes back as a failed command, exit 124, so every caller
 * treats that remote as one it could not check, never as an answer.
 */
export function spawnRunner(cwd, { env = process.env, remoteTimeoutMs = remoteProbeTimeoutMs(env) } = {}) {
  return (args) => {
    const probe = probesRemote(args);
    const options = { cwd, env, encoding: 'utf8', windowsHide: true };
    if (probe) {
      options.env = remoteProbeEnvironment(env, env.GIT_SSH_COMMAND ? null : configuredSshCommand(cwd, env));
      options.timeout = remoteTimeoutMs;
      options.killSignal = 'SIGKILL';
    }
    const result = spawnSync('git', args, options);
    if (probe && result.error?.code === 'ETIMEDOUT') {
      return { code: 124, stdout: '', stderr: `no answer within ${remoteTimeoutMs}ms, so the remote could not be checked`, timedOut: true };
    }
    if (result.error) throw result.error;
    return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
}

/** The only git verb that can change a remote. Everything else is local or read-only. */
export function mutatesRemote(args) {
  return args[0] === 'push';
}

export function createGit({ cwd, run = spawnRunner(cwd), dryRun = false, onCommand = null } = {}) {
  const history = [];

  const invoke = (args, { allowFail = false, skipOnDryRun = false } = {}) => {
    const entry = { args: [...args], mutatesRemote: mutatesRemote(args), skipped: false };
    if (dryRun && skipOnDryRun) {
      entry.skipped = true;
      history.push(entry);
      onCommand?.(entry);
      return { code: 0, stdout: '', stderr: '', skipped: true };
    }
    history.push(entry);
    onCommand?.(entry);
    const result = run(args);
    entry.code = result.code;
    if (result.code !== 0 && !allowFail) throw new GitError(args, result);
    return result;
  };

  const capture = (args) => invoke(args).stdout.trim();

  return {
    cwd,
    history,
    dryRun,
    invoke,
    capture,

    revParse: (rev) => capture(['rev-parse', '--verify', `${rev}^{commit}`]),
    currentBranch: () => capture(['rev-parse', '--abbrev-ref', 'HEAD']),
    isClean: () => capture(['status', '--porcelain']) === '',
    commitDate: (rev) => capture(['show', '-s', '--format=%cs', rev]),
    showFile: (rev, file) => {
      const result = invoke(['show', `${rev}:${file}`], { allowFail: true });
      return result.code === 0 ? result.stdout : null;
    },
    listFiles: (rev, directory) => {
      const result = invoke(['ls-tree', '--name-only', rev, `${directory}/`], { allowFail: true });
      return result.code === 0 ? result.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : [];
    },
    isAncestor: (ancestor, descendant) => invoke(['merge-base', '--is-ancestor', ancestor, descendant], { allowFail: true }).code === 0,
    /**
     * Whether `tip` contains `commit`: true or false when git can tell, null when it cannot (an
     * object is missing from the local store, or git failed). Callers treat null as unsafe.
     */
    containsCommit: (tip, commit) => {
      const { code } = invoke(['merge-base', '--is-ancestor', commit, tip], { allowFail: true });
      if (code === 0) return true;
      return code === 1 ? false : null;
    },
    localTags: () => capture(['tag', '--list']).split('\n').map((line) => line.trim()).filter(Boolean),
    remoteTags: (remote) =>
      capture(['ls-remote', '--tags', remote])
        .split('\n')
        .map((line) => line.split('\t')[1] ?? '')
        .map((ref) => ref.replace(/^refs\/tags\//, '').replace(/\^\{\}$/, ''))
        .filter(Boolean),
    /**
     * The commit a remote branch points at, read from the remote itself. Null means the remote
     * answered and has no such branch; a remote that cannot be read throws, so "absent" is never a
     * guess.
     */
    remoteBranchTip: (remote, branch) => {
      const ref = `refs/heads/${branch}`;
      const args = ['ls-remote', '--exit-code', remote, ref];
      const result = invoke(args, { allowFail: true });
      // --exit-code reports "no matching ref" as exit 2; any other failure is a remote that did not answer.
      if (result.code === 2) return null;
      if (result.code !== 0) throw new GitError(args, result);
      const line = result.stdout.split('\n').find((candidate) => candidate.trim().split(/\s+/)[1] === ref);
      return line ? line.trim().split(/\s+/)[0] : null;
    },
    /**
     * Brings a remote branch's commits into the local object store without moving any ref or
     * writing FETCH_HEAD, so a reachability question about the remote can be answered locally.
     * Returns whether the fetch succeeded.
     */
    fetchBranch: (remote, branch) =>
      invoke(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--refmap=', remote, `refs/heads/${branch}`], { allowFail: true }).code === 0,
    remoteUrl: (remote) => capture(['remote', 'get-url', remote]),
    /** Every configured remote's name. Throws when git cannot list them. */
    remotes: () => capture(['remote']).split('\n').map((line) => line.trim()).filter(Boolean),
    /**
     * The remote-tracking refs (`refs/remotes/...`, full names) whose history contains `commit`.
     * Null when git cannot answer, for example because the commit is not in the local store;
     * callers treat null as unsafe, never as "none".
     */
    remoteTrackingRefsContaining: (commit) => {
      const result = invoke(['for-each-ref', '--format=%(refname)', '--contains', commit, 'refs/remotes/'], { allowFail: true });
      if (result.code !== 0) return null;
      return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    },

    stagedFiles: () => capture(['diff', '--cached', '--name-only']).split('\n').map((line) => line.trim()).filter(Boolean),
    /**
     * Which of `paths` have any local change: staged, unstaged, or untracked. Each path is matched
     * literally, never as a glob.
     */
    changedPaths: (paths) => {
      if (paths.length === 0) return [];
      const literal = paths.map((file) => `:(literal)${file}`);
      const { stdout } = invoke(['status', '--porcelain', '-z', '--untracked-files=all', '--', ...literal]);
      const entries = stdout.split('\0');
      const changed = [];
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry.length < 4) continue;
        changed.push(entry.slice(3));
        // With -z a rename or copy is followed by its source path, which is not an entry of its own.
        if (entry[0] === 'R' || entry[0] === 'C') index += 1;
      }
      return changed;
    },
    tagTarget: (tag) => {
      const result = invoke(['rev-list', '-n', '1', `refs/tags/${tag}`], { allowFail: true });
      return result.code === 0 ? result.stdout.trim() : null;
    },

    mergeFastForward: (rev) => invoke(['merge', '--ff-only', rev], { skipOnDryRun: true }),
    cherryPick: (rev) => invoke(['cherry-pick', '-x', rev], { skipOnDryRun: true }),
    add: (paths) => invoke(['add', '--', ...paths], { skipOnDryRun: true }),
    commit: (message) => invoke(['commit', '-m', message], { skipOnDryRun: true }),
    tag: (name, message, { force = false } = {}) => invoke(['tag', ...(force ? ['-f'] : []), '-a', name, '-m', message], { skipOnDryRun: true }),
    pushAtomic: (remote, refspecs) => invoke(['push', '--atomic', remote, ...refspecs], { skipOnDryRun: true }),
  };
}
