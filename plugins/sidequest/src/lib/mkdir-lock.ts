// A small cross-process mutex built on directory renames, shared by the hooks and the MCP
// server. It started life inside the Stop hook's reconciliation reminder (one per-session
// state file); the question log (SQ-415) needs the same thing for its appends, so it lives
// here now and both import it.
//
// Algorithm. A contender creates a private candidate directory `<lock>.<pid>-<uuid>`, writes
// one `owner-<pid>-<uuid>` file holding its pid inside it, then renames the candidate onto
// `<lock>`. A rename onto a missing or empty directory succeeds atomically; onto a directory
// that still holds another owner's file it fails, so exactly one contender publishes at a
// time. Release removes the owner file and then the directory. A waiter that finds the
// published owner's pid dead (ESRCH) removes that one owner file and the directory, then
// retries. Removing by owner-file name means a second stale cleaner that lost the race can
// never delete a live replacement generation: its stale owner file is already gone, and
// rmdir refuses the replacement's non-empty directory.
//
// It is deliberately NOT the board lock (store/locks.ts and the SQLite transaction). Callers
// that must never queue behind board work, such as question-log I/O, take this instead.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MKDIR_LOCK_WAIT_MS = 500;
export const MKDIR_LOCK_RETRY_MS = 5;

const waitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

// Names of environment variables (not paths) that let a test freeze a contender at a known
// point. Each caller picks its own names so one suite's gates never stall another's lock.
export interface MkdirLockTestGates {
  acquiredMarker?: string;
  holdGate?: string;
  staleMarker?: string;
  staleGate?: string;
  staleCleanedMarker?: string;
}

export interface MkdirLockOptions {
  waitMs?: number;
  retryMs?: number;
  testGates?: MkdirLockTestGates;
}

export type MkdirLockResult<T> = { acquired: true; value: T } | { acquired: false };

export function sleepSync(ms: number): void {
  Atomics.wait(waitBuffer, 0, 0, Math.max(0, ms));
}

function lockOwnerFile(lockDirectory: string): string | null {
  try {
    const owners = fs.readdirSync(lockDirectory).filter((name) => name.startsWith('owner-'));
    const [ownerName] = owners;
    return owners.length === 1 && ownerName ? path.join(lockDirectory, ownerName) : null;
  } catch (_) {
    return null;
  }
}

function lockOwnerAlive(ownerFile: string): boolean {
  try {
    const owner = Number(fs.readFileSync(ownerFile, 'utf8').trim());
    if (!Number.isInteger(owner) || owner <= 0) return true;
    try {
      process.kill(owner, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

function waitForTestGate(markerVariable: string | undefined, gateVariable: string | undefined, retryMs: number): void {
  const marker = markerVariable ? process.env[markerVariable] : undefined;
  if (marker) fs.writeFileSync(marker, `${process.pid}\n`);
  const gate = gateVariable ? process.env[gateVariable] : undefined;
  while (gate && fs.existsSync(gate)) sleepSync(retryMs);
}

function removeStaleLock(lockDirectory: string, ownerFile: string): boolean {
  try {
    fs.rmSync(ownerFile, { force: true });
    fs.rmdirSync(lockDirectory);
    return true;
  } catch (_) {
    return false;
  }
}

// Returns the published owner file on success, null when the wait budget ran out. Creating
// the lock's parent directory can throw (EACCES and the like); that propagates.
export function acquireMkdirLock(lockDirectory: string, options: MkdirLockOptions = {}): string | null {
  const waitMs = options.waitMs ?? MKDIR_LOCK_WAIT_MS;
  const retryMs = options.retryMs ?? MKDIR_LOCK_RETRY_MS;
  const gates = options.testGates || {};
  const generation = `${process.pid}-${crypto.randomUUID()}`;
  const ownerName = `owner-${generation}`;
  const candidateDirectory = `${lockDirectory}.${generation}`;
  const publishedOwnerFile = path.join(lockDirectory, ownerName);
  const deadline = Date.now() + waitMs;
  fs.mkdirSync(path.dirname(lockDirectory), { recursive: true });
  try {
    fs.mkdirSync(candidateDirectory);
    fs.writeFileSync(path.join(candidateDirectory, ownerName), `${process.pid}\n`);
    while (true) {
      try {
        fs.renameSync(candidateDirectory, lockDirectory);
        waitForTestGate(gates.acquiredMarker, gates.holdGate, retryMs);
        return publishedOwnerFile;
      } catch (_) {
        const ownerFile = lockOwnerFile(lockDirectory);
        if (ownerFile && !lockOwnerAlive(ownerFile)) {
          waitForTestGate(gates.staleMarker, gates.staleGate, retryMs);
          removeStaleLock(lockDirectory, ownerFile);
          const cleanedMarker = gates.staleCleanedMarker ? process.env[gates.staleCleanedMarker] : undefined;
          if (cleanedMarker) fs.writeFileSync(cleanedMarker, `${process.pid}\n`);
          continue;
        }
        if (Date.now() >= deadline) return null;
        sleepSync(retryMs);
      }
    }
  } finally {
    try {
      fs.rmSync(candidateDirectory, { recursive: true, force: true });
    } catch (_) {}
  }
}

export function releaseMkdirLock(ownerFile: string): void {
  try {
    fs.rmSync(ownerFile, { force: true });
    fs.rmdirSync(path.dirname(ownerFile));
  } catch (_) {}
}

// Runs fn while holding the lock. A timed-out wait returns { acquired: false } without
// calling fn; an exception from fn propagates after the lock is released.
export function withMkdirLock<T>(lockDirectory: string, fn: () => T, options: MkdirLockOptions = {}): MkdirLockResult<T> {
  const ownerFile = acquireMkdirLock(lockDirectory, options);
  if (!ownerFile) return { acquired: false };
  try {
    return { acquired: true, value: fn() };
  } finally {
    releaseMkdirLock(ownerFile);
  }
}
