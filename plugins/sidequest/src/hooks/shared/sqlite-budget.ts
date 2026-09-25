// Imported first, for its side effect, by every hook registered with a 10s timeout (SQ-125).
//
// The board database is machine-global. Under the server's lock budget (three waits of 15s) any long writer
// on the machine holds a hook past Claude Code's 10s deadline, where it is killed having neither allowed nor
// refused anything. Under this budget a hook waits once, briefly, then fails open: it exits 0, which allows the
// event and adds no context, and says why on stderr. lib/db.js reads the policy from this global key whenever it
// opens or retries, so installing it loads nothing, and a child process the hook spawns keeps the server budget.
// WorktreeCreate has a 120s deadline and its own setup budget, so it deliberately does not import this.
//
// Failing open is right for a hook whose board check only adds guidance. It is wrong for a security guard: a
// guard that allows whenever the board is contended can be bypassed by holding the lock. Those guards call
// failClosedOnBoardBusy() once at load, which keeps the same short budget but refuses the call instead (SQ-133).

import fs from 'node:fs';
import path from 'node:path';

const SQLITE_BUSY_POLICY_KEY = Symbol.for('sidequest.sqlite-busy-policy');

// One wait, then out: 1.5s plus node startup and the hook's own work stays well inside the 10s timeout.
const HOOK_SQLITE_BUSY_TIMEOUT_MS = 1_500;

let failClosedEvent: string | null = null;

function hookName(): string {
  return path.basename(process.argv[1] || 'hook', '.js');
}

function installBudget(onExhausted: (error: Error) => never): void {
  Reflect.set(globalThis, SQLITE_BUSY_POLICY_KEY, Object.freeze({
    label: 'hook',
    timeoutMs: HOOK_SQLITE_BUSY_TIMEOUT_MS,
    attempts: 1,
    onExhausted,
  }));
}

function writeStderr(text: string): void {
  try {
    fs.writeSync(2, text);
  } catch (_) {
    // Diagnostics only; the decision itself is already on stdout or in the exit code.
  }
}

function failOpen(error: Error): never {
  writeStderr(`sidequest: ${hookName()} allowed this event without its board check (fail-open, board lock busy): ${error.message}\n`);
  process.exit(0);
}

function failClosed(error: Error): never {
  const hook = hookName();
  const reason = `sidequest: ${hook} refused this call because of board lock contention: another process holds the Sidequest board database lock, so this security guard could not finish its board check, and it refuses rather than allow the call unchecked. The call did not run. Retry the same call in a few seconds; if it keeps failing, a long-running Sidequest writer is holding the board lock.`;
  // Written synchronously: this runs from inside a board read, and exit must not race a buffered pipe write.
  let denied = false;
  try {
    fs.writeSync(1, JSON.stringify({
      hookSpecificOutput: {
        hookEventName: failClosedEvent || 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
    denied = true;
  } catch (_) {
    // Fall through to the blocking exit code below, which refuses the call just as firmly.
  }
  writeStderr(`${denied ? '' : `${reason}\n`}sidequest: ${hook} refused this event without its board check (fail-closed, board lock busy): ${error.message}\n`);
  process.exit(denied ? 0 : 2);
}

function boardBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = Reflect.get(error, 'code');
  const errcode = Reflect.get(error, 'errcode');
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || errcode === 5 || errcode === 6) return true;
  if (/database (?:table )?is (?:locked|busy)/i.test(error.message)) return true;
  return boardBusy(Reflect.get(error, 'cause'));
}

installBudget(failOpen);

/**
 * Switch this hook to fail closed when the board lock budget runs out: it writes this hook's own deny, which
 * names board lock contention and asks for a retry, then exits. The deny runs from inside the board read, so no
 * try/catch in the guard can swallow it and fall open. Call it once, at load, from security guards only.
 */
export function failClosedOnBoardBusy(hookEventName = 'PreToolUse'): void {
  failClosedEvent = hookEventName;
  installBudget(failClosed);
}

/**
 * For a guard's last-resort catch: a lock error that reached it without passing through the budget (a statement
 * outside lib/db's retry helpers) is still board lock contention, so a fail-closed guard refuses it too.
 */
export function refuseWhenBoardBusy(error: unknown): void {
  if (failClosedEvent && boardBusy(error)) failClosed(error as Error);
}
