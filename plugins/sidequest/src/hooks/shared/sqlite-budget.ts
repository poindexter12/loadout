// Imported first, for its side effect, by every hook registered with a 10s timeout (SQ-125).
//
// The board database is machine-global. Under the server's lock budget (three waits of 15s) any long writer
// on the machine holds a hook past Claude Code's 10s deadline, where it is killed having neither allowed nor
// refused anything. Under this budget a hook waits once, briefly, then fails open: it exits 0, which allows the
// event and adds no context, and says why on stderr. lib/db.js reads the policy from this global key whenever it
// opens or retries, so installing it loads nothing, and a child process the hook spawns keeps the server budget.
// WorktreeCreate has a 120s deadline and its own setup budget, so it deliberately does not import this.

import path from 'node:path';

const SQLITE_BUSY_POLICY_KEY = Symbol.for('sidequest.sqlite-busy-policy');

// One wait, then out: 1.5s plus node startup and the hook's own work stays well inside the 10s timeout.
const HOOK_SQLITE_BUSY_TIMEOUT_MS = 1_500;

function failOpen(error: Error): never {
  const hook = path.basename(process.argv[1] || 'hook', '.js');
  process.stderr.write(`sidequest: ${hook} allowed this event without its board check (fail-open, board lock busy): ${error.message}\n`);
  process.exit(0);
}

Reflect.set(globalThis, SQLITE_BUSY_POLICY_KEY, Object.freeze({
  label: 'hook',
  timeoutMs: HOOK_SQLITE_BUSY_TIMEOUT_MS,
  attempts: 1,
  onExhausted: failOpen,
}));
