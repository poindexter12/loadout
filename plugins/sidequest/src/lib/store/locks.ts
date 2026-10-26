'use strict';

function createLocks(dependencies: any) {
  const { fs, path, ticketsDir, transaction, inTransaction } = dependencies;

  function ticketLockPath(slug?: any, id?: any) {
    return path.join(ticketsDir(slug), '.' + path.basename(String(id)) + '.lock');
  }

  const lockSleep = new Int32Array(new SharedArrayBuffer(4));

  function busyWait(ms?: any) {
    Atomics.wait(lockSleep, 0, 0, ms);
  }

  function testClaimLockDelayMs() {
    const delay = Number(process.env.SIDEQUEST_TEST_CLAIM_LOCK_DELAY_MS);
    return Number.isInteger(delay) && delay > 0 ? delay : 0;
  }

  function newLockOwnerToken() {
    return `${process.pid}-${Date.now()}-${process.hrtime.bigint()}-${Math.random().toString(36).slice(2)}`;
  }

  function readLockOwner(lockPath?: any) {
    try {
      const content = fs.readFileSync(lockPath, 'utf8').trim();
      const parsed = JSON.parse(content);
      const pid = Number(parsed?.pid);
      const token = typeof parsed?.token === 'string' ? parsed.token : null;
      return Number.isInteger(pid) && pid > 0 ? { pid, token } : null;
    } catch (_: any) {
      return null;
    }
  }

  function lockOwnerIsAlive(owner?: any) {
    if (!owner || !Number.isInteger(owner.pid) || owner.pid < 1) return null;
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error: any) {
      return error?.code === 'EPERM';
    }
  }

  function lockCanBeReclaimed(lockPath?: any) {
    const owner = readLockOwner(lockPath);
    const ownerIsAlive = lockOwnerIsAlive(owner);
    if (ownerIsAlive != null) return !ownerIsAlive;
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs > 30000;
    } catch (_: any) {
      return true;
    }
  }

  function ownerTokenValue(ownerToken?: any) {
    if (typeof ownerToken === 'string') return ownerToken;
    return typeof ownerToken?.token === 'string' ? ownerToken.token : null;
  }

  function lockOwnerMatches(lockPath?: any, ownerToken?: any) {
    const owner = readLockOwner(lockPath);
    return ownerTokenValue(ownerToken) != null && owner?.token === ownerTokenValue(ownerToken);
  }

  function acquireLock(lockPath?: any, options: any = {}) {
    const STALE_LOCK_MS = 30000;
    const RETRY_MS = 10;
    const MAX_ATTEMPTS = options.wait === false ? 2 : STALE_LOCK_MS / RETRY_MS;
    const ownerToken = newLockOwnerToken();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const fd = fs.openSync(lockPath, 'wx');
        try {
          fs.writeSync(fd, JSON.stringify({ pid: process.pid, token: ownerToken }));
        } catch (_: any) {
          fs.closeSync(fd);
          try { fs.unlinkSync(lockPath); } catch (_: any) { /* ignore */ }
          return false;
        }
        fs.closeSync(fd);
        return { token: ownerToken, refresh: () => refreshLock(lockPath, ownerToken) };
      } catch (error: any) {
        if (!error || error.code !== 'EEXIST') return false;
        if (lockCanBeReclaimed(lockPath)) {
          try {
            fs.unlinkSync(lockPath);
          } catch (_: any) {
            /* ignore */
          }
          continue;
        }
        busyWait(RETRY_MS);
      }
    }
    return false;
  }

  function refreshLock(lockPath?: any, ownerToken?: any) {
    if (!lockOwnerMatches(lockPath, ownerToken)) return { ok: false, reason: 'lock_owner_lost' };
    try {
      const now = new Date();
      fs.utimesSync(lockPath, now, now);
      return { ok: true };
    } catch (_: any) {
      return { ok: false, reason: 'lock_owner_lost' };
    }
  }

  function releaseLock(lockPath?: any, ownerToken?: any) {
    const RETRY_MS = 5;
    for (let attempt = 0; attempt < 1000; attempt++) {
      if (!lockOwnerMatches(lockPath, ownerToken)) return { ok: false, reason: 'lock_owner_lost' };
      try {
        fs.unlinkSync(lockPath);
        return { ok: true };
      } catch (error: any) {
        if (!error || !['EACCES', 'EBUSY', 'EPERM'].includes(error.code)) return { ok: false, reason: 'lock_owner_lost' };
        busyWait(RETRY_MS);
      }
    }
    return { ok: false, reason: 'lock_owner_lost' };
  }

  // Lock ordering (SQ-273). Two locks guard a ticket write and they are not the same kind of thing:
  //
  //   1. the per-ticket FILE lock (`ticketLockPath`), cheap and scoped to one ticket on one board;
  //   2. the board TRANSACTION (`BEGIN IMMEDIATE` on the one SQLite file), machine-global: while it
  //      is held, every board write on the host, for every project and every session, waits.
  //
  // The single ordering is: ticket file lock(s) FIRST, transaction SECOND, never the reverse. A
  // process that holds the transaction and then waits for a ticket file lock holds the whole
  // machine's write lock for as long as that file lock's owner keeps it, and deadlocks outright
  // against an owner that is itself waiting to enter the transaction (only the 30s file-lock
  // timeout or the busy timeout breaks it). That stopped being a theoretical window once
  // `prepareDispatch` began holding its ticket's file lock across a multi-second unlocked plan.
  //
  // So acquiring a ticket file lock is refused while this process has a transaction open, and
  // several ticket locks are taken together (sorted, before the transaction) by `withTicketLocks`
  // rather than by nesting `withTicketLock`, whose inner acquisition would run inside the outer
  // transaction. Same-ticket re-entry is not supported either: a file lock is not reentrant, so a
  // second acquisition of a lock this process already owns waits out the full 30s and reports busy.
  function lockOrderViolation(slug?: any, id?: any) {
    const error: any = new Error(`ticket lock order violation: the file lock for ${String(slug)}/${String(id)} was requested while a board transaction is open. Take ticket file locks before entering the transaction (withTicketLocks for several), never inside it.`);
    error.code = 'SIDEQUEST_LOCK_ORDER';
    return error;
  }

  function transactionIsOpen() {
    return typeof inTransaction === 'function' && inTransaction() === true;
  }

  // Acquire several ticket file locks in one canonical (sorted, de-duplicated) order, so two callers
  // asking for an overlapping set can never each hold one and wait for the other. All or nothing:
  // a refusal releases whatever was already taken. Returns the held leases, or null on contention.
  function acquireTicketLocks(slug?: any, ids?: any) {
    const ordered = [...new Set((Array.isArray(ids) ? ids : [ids]).map((id: any) => String(id)))].sort();
    if (transactionIsOpen()) throw lockOrderViolation(slug, ordered.join(','));
    const held: Array<{ path: string; token: any }> = [];
    for (const id of ordered) {
      const lockPath = ticketLockPath(slug, id);
      const token = acquireLock(lockPath);
      if (!token) {
        releaseTicketLocks(held);
        return null;
      }
      held.push({ path: lockPath, token });
    }
    return held;
  }

  function releaseTicketLocks(held?: any) {
    if (!Array.isArray(held)) return;
    for (let index = held.length - 1; index >= 0; index -= 1) releaseLock(held[index].path, held[index].token);
  }

  // The ticket file lock alone, with NO transaction. This is what lets a caller keep same-ticket
  // serialisation across a long unlocked phase (Git, a whole-tree read) and enter the machine-global
  // transaction only briefly inside it, via `transaction`.
  function withTicketFileLocks(slug?: any, ids?: any, fn?: any) {
    const held = acquireTicketLocks(slug, ids);
    if (!held) return { ok: false, reason: 'busy' };
    try {
      return fn();
    } finally {
      releaseTicketLocks(held);
    }
  }

  function withTicketFileLock(slug?: any, id?: any, fn?: any) {
    return withTicketFileLocks(slug, [id], fn);
  }

  // Several tickets' file locks, then one transaction: the replacement for nesting withTicketLock.
  function withTicketLocks(slug?: any, ids?: any, fn?: any) {
    return withTicketFileLocks(slug, ids, () => transaction(fn));
  }

  // Unchanged contract for every existing caller: file lock, then transaction, both released on
  // return, `{ ok: false, reason: 'busy' }` when the file lock cannot be had.
  function withTicketLock(slug?: any, id?: any, fn?: any) {
    return withTicketFileLocks(slug, [id], () => transaction(fn));
  }

  return {
    acquireLock,
    acquireTicketLocks,
    busyWait,
    refreshLock,
    releaseLock,
    releaseTicketLocks,
    testClaimLockDelayMs,
    ticketLockPath,
    withTicketFileLock,
    withTicketLock,
    withTicketLocks,
  };
}

module.exports = { createLocks };
