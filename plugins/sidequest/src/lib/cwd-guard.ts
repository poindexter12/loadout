/**
 * Working-directory guard (SQ-368).
 *
 * A board server inherits the Claude Code session's cwd. When that directory is
 * later deleted (a swept or removed worktree), every `process.cwd()` throws
 * ENOENT for the rest of the process's life, and restarting the server inside
 * the same session inherits the same dead path. Read-only tools keep working,
 * so the failure first shows up on dispatch.
 *
 * `ensureLiveCwd` probes the cwd and, when it is gone, moves the process to a
 * directory that still exists: CLAUDE_PROJECT_DIR when it survives, otherwise
 * the home directory. It is cheap (one syscall when healthy), so callers run it
 * at startup and again before each request, because the directory can be
 * removed while a long-lived server is running.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';

export type CwdGuardResult =
  | { ok: true; recovered: false; cwd: string }
  | { ok: true; recovered: true; cwd: string; lost: string | null; reason: string }
  | { ok: false; recovered: false; lost: string | null; reason: string };

export type CwdGuardOptions = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  log?: (line: string) => void;
};

function isDirectory(candidate: string | undefined | null): candidate is string {
  if (!candidate) return false;
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  const record = error as { code?: unknown; message?: unknown } | null;
  if (record && typeof record.code === 'string') return record.code;
  return record && typeof record.message === 'string' ? record.message : String(error);
}

export function ensureLiveCwd(options: CwdGuardOptions = {}): CwdGuardResult {
  const env = options.env || process.env;
  const log = options.log || ((line: string) => { process.stderr.write(`${line}\n`); });
  try {
    return { ok: true, recovered: false, cwd: process.cwd() };
  } catch (error) {
    const reason = errorText(error);
    // The kernel no longer has a name for the cwd; PWD is the shell's record of it.
    const lost = typeof env.PWD === 'string' && env.PWD ? env.PWD : null;
    const homedir = options.homedir || os.homedir;
    const candidates = [env.CLAUDE_PROJECT_DIR, safeHomedir(homedir)];
    for (const candidate of candidates) {
      if (!isDirectory(candidate)) continue;
      try {
        process.chdir(candidate);
        const cwd = process.cwd();
        log(`sidequest: working directory ${lost ? `"${lost}" ` : ''}no longer exists (${reason}); continuing from "${cwd}".`);
        return { ok: true, recovered: true, cwd, lost, reason };
      } catch {
        // Try the next surviving directory.
      }
    }
    log(`sidequest: working directory ${lost ? `"${lost}" ` : ''}no longer exists (${reason}) and no surviving directory could be entered. `
      + 'Restart Claude Code as a fresh process from a checkout that exists.');
    return { ok: false, recovered: false, lost, reason };
  }
}

function safeHomedir(homedir: () => string): string | null {
  try {
    return homedir();
  } catch {
    return null;
  }
}
