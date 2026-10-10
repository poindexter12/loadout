import fs from 'node:fs';
import path from 'node:path';
import { stringField, type HookInput } from './input.js';
import { runtimeModule } from './paths.js';
import { readSessionState, sessionStateFile, writeSessionState } from './session-state.js';
// The catches below treat an unreadable board as "no expectation". Board lock contention is the exception in a
// fail-closed guard, which refuses instead (a no-op in every other hook) (SQ-133).
import { refuseWhenBoardBusy } from './sqlite-budget.js';

export type DispatchPhase = 'prepared' | 'created' | 'bound' | 'claimed' | 'working' | 'submitted' | 'integrated' | 'terminal';

export interface IsolationExpectation {
  ref: string;
  projectPath: string | null;
  expectedWorktree: string | null;
  expectedGitDirectory: string | null;
  expectedCommonGitDirectory: string | null;
  expectedCheckoutInstance: string | null;
  expectedRevision: string | null;
  matchedBy: string;
  identityBound: boolean;
  dispatchBaseline: string | null;
  sanctionedRevisions: readonly string[];
  claimHeld: boolean;
  phase: DispatchPhase;
  sharedTree: boolean;
  terminal: boolean;
}

export interface CheckoutLocation {
  root: string;
  linked: boolean;
}

export function canonicalPath(value: string): string {
  const kernel = require(runtimeModule('kernel/worktree')) as { canonicalPath: (value: string) => string };
  return kernel.canonicalPath(value);
}

export function executorAgent(type: string): boolean {
  if (!type) return false;
  try {
    return require(runtimeModule('exec-names')).classify(type).kind !== 'unknown';
  } catch (_) {
    return /^sidequest-exec-/.test(type);
  }
}

export function hookSessionId(input: HookInput): string {
  return stringField(input, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || '';
}

// A linked worktree's `.git` is a file pointing back at the shared object
// store; a primary checkout's is a directory. That difference is what tells an
// agent's own isolated checkout apart from the shared one it must never claim.
export function enclosingCheckout(start: string): CheckoutLocation | null {
  let directory = canonicalPath(start);
  for (;;) {
    const gitEntry = path.join(directory, '.git');
    let stats: fs.Stats | null = null;
    try {
      stats = fs.statSync(gitEntry);
    } catch (_) {
      stats = null;
    }
    if (stats) return { root: directory, linked: stats.isFile() };
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

// SQ-303: the Edit-path guard used to learn these three facts from `git rev-parse --git-dir`,
// `--git-common-dir` and `--verify HEAD^{commit}`. Three process spawns cost ~1.1s on the contended host
// this was measured on, on EVERY write a dispatched executor makes, which is most of what pushed
// guard-worktree-isolation past its 10s hook deadline where Claude Code kills it having decided nothing.
// The reader itself is the lease kernel's, so dispatch.ts and the hooks share one implementation; null here
// means the layout did not state all three plainly and the caller should fall back to the git spawns. An
// unborn HEAD is one such case: `rev-parse --verify HEAD^{commit}` fails there and the guard refuses, so
// report the layout as unreadable rather than inventing a revision, and let the spawn produce that refusal.
export interface ObservedGitFacts {
  gitDirectory: string;
  commonGitDirectory: string;
  revision: string;
}

export function observedGitFacts(worktree: string): ObservedGitFacts | null {
  const { checkoutLayout } = require(runtimeModule('kernel/worktree')) as {
    checkoutLayout: (start: string) => { gitDirectory: string; commonGitDirectory: string; revision: string | null } | null;
  };
  const layout = checkoutLayout(worktree);
  if (!layout?.revision) return null;
  return { gitDirectory: layout.gitDirectory, commonGitDirectory: layout.commonGitDirectory, revision: layout.revision };
}

// Per-session hook state, shared by the hooks that resolve runtime identity. It holds two things the board
// would otherwise be asked for on every single tool call: whether this agent's identity binding has already
// been attempted (a WRITE transaction, and the one named at guard-worktree-isolation.ts:232), and the answer
// to an ancestry probe that is a pure function of two revisions.
interface RuntimeIdentityAgentState {
  attempted?: boolean;
  deferred?: boolean;
  executor?: string;
  agentName?: string | null;
  worktree?: string;
}
interface RuntimeIdentityState {
  agents?: Record<string, RuntimeIdentityAgentState>;
  ancestry?: Record<string, 'ancestor' | 'unrelated'>;
}

const RUNTIME_IDENTITY_STATE_PREFIX = 'runtime-identity';
const MAX_TRACKED_AGENTS = 32;
const MAX_TRACKED_ANCESTRY = 32;

function identityStateFile(sessionId: string): string {
  return sessionStateFile(RUNTIME_IDENTITY_STATE_PREFIX, sessionId);
}

function readIdentityState(sessionId: string): RuntimeIdentityState {
  return readSessionState(identityStateFile(sessionId)) as RuntimeIdentityState;
}

function writeIdentityState(sessionId: string, state: RuntimeIdentityState): void {
  try {
    writeSessionState(identityStateFile(sessionId), state as Record<string, unknown>);
  } catch (_) {
    // The cache is an optimization. Losing it costs a board call, never a decision.
  }
}

function boundedEntries<T>(entries: Record<string, T>, limit: number): Record<string, T> {
  const keys = Object.keys(entries);
  if (keys.length <= limit) return entries;
  return Object.fromEntries(keys.slice(keys.length - limit).map((key) => [key, entries[key]!]));
}

// One key per agent AND offered checkout: re-offering a different checkout is the SQ-2153/SQ-2159 retry and
// must still reach the store, while repeating the same offer is the loop this cache exists to stop.
function agentKey(agentId: string, agentName: string | null, worktree: string): string {
  return `${agentId || agentName || ''}\u0000${worktree}`;
}

// `merge-base --is-ancestor` has to stay a git spawn: reachability is not a fact on disk. It is a pure
// function of the two revisions though, and an executor's HEAD only moves when it commits, so memoizing it
// per session turns one spawn per write into one spawn per commit.
export function cachedBaselineAncestry(
  sessionId: string,
  baseline: string,
  revision: string,
  probe: () => 'ancestor' | 'unrelated' | 'unknown',
): 'ancestor' | 'unrelated' | 'unknown' {
  const key = `${baseline}\u0000${revision}`;
  if (!sessionId) return probe();
  const state = readIdentityState(sessionId);
  const cached = state.ancestry?.[key];
  if (cached === 'ancestor' || cached === 'unrelated') return cached;
  const answer = probe();
  // 'unknown' means the probe itself could not run. Caching it would freeze a transient failure into a
  // standing refusal for the rest of the session.
  if (answer === 'unknown') return answer;
  writeIdentityState(sessionId, {
    ...state,
    ancestry: boundedEntries({ ...(state.ancestry || {}), [key]: answer }, MAX_TRACKED_ANCESTRY),
  });
  return answer;
}

// `observedWorktree` is the checkout the caller is about to act in. It is only a tiebreaker: when one
// session dispatches two executors, both records carry the same session id and executor name, and
// without it the store reports two candidates and resolves to nothing at all (SQ-2189).
export function isolationExpectation(input: HookInput, agentId: string, executor: string, includeSessionFallback = true, observedWorktree = ''): IsolationExpectation | null {
  try {
    const store = require(runtimeModule('store')) as {
      dispatchIsolationExpectation: (identity: unknown) => IsolationExpectation | null;
    };
    const found = store.dispatchIsolationExpectation({ agentId, executor, sessionId: hookSessionId(input), observedWorktree });
    return agentId && !includeSessionFallback && found?.matchedBy === 'session' ? null : found;
  } catch (error) {
    refuseWhenBoardBusy(error);
    return null;
  }
}

export interface IdentityDiagnosis {
  live: number;
  session: number;
  sessionExecutor: number;
  agent: number;
  worktree: number;
}

// What the store saw when it could not resolve the caller, so a refusal can say which key failed instead
// of leaving every reader to re-derive it from dispatch records that are terminal by then (SQ-2189).
export function identityDiagnosis(input: HookInput, agentId: string, executor: string, observedWorktree: string): IdentityDiagnosis | null {
  try {
    const store = require(runtimeModule('store')) as {
      dispatchIdentityDiagnosis: (identity: unknown) => IdentityDiagnosis;
    };
    return store.dispatchIdentityDiagnosis({ agentId, executor, sessionId: hookSessionId(input), observedWorktree });
  } catch (error) {
    refuseWhenBoardBusy(error);
    return null;
  }
}

export interface UnboundClaim {
  ref: string;
  project: string;
}

export function unboundClaim(input: HookInput, executor: string, observedWorktree: string): UnboundClaim | null {
  try {
    const store = require(runtimeModule('store')) as {
      dispatchUnboundClaim: (identity: unknown) => UnboundClaim | null;
    };
    return store.dispatchUnboundClaim({
      executor,
      sessionId: hookSessionId(input),
      observedWorktree,
      agentName: stringField(input, 'agent_name', 'agentName', 'name'),
    });
  } catch (error) {
    refuseWhenBoardBusy(error);
    return null;
  }
}

// SQ-2153, SQ-2159. SubagentStart can reach the store before the worktree it
// names finished being created, and the dispatch is then left with no runtime
// identity at all. Re-offering the checkout the harness actually put this agent
// in lets the store re-check it against the completed creation facts: only the
// exact reserved target binds, and every other observed checkout stays unbound.
export function bindObservedRuntimeIdentity(input: HookInput, agentId: string, executor: string, worktree: string): void {
  try {
    const store = require(runtimeModule('store')) as {
      bindDispatchAgent: (sessionId: string, executor: string, agentId: string | null, agentName: string | null, worktree: string) => unknown;
    };
    const sessionId = hookSessionId(input);
    if (!sessionId) return;
    store.bindDispatchAgent(
      sessionId,
      executor,
      agentId,
      stringField(input, 'agent_name', 'agentName', 'name') || null,
      worktree,
    );
  } catch (error) {
    refuseWhenBoardBusy(error);
  }
}

// SQ-303. The binding above is a board WRITE, and the Edit-path guard ran it on every write whose dispatch
// still read as unbound. When a bind cannot succeed — the commonest reason being an agent the board has no
// dispatch record for at all — "still unbound" is permanent, so the guard re-attempted a write transaction
// on every single Edit for the life of that agent. That is the hot-path write the ticket names, and under
// any concurrent writer on this machine-global database it is also the hook that gets killed at 10s.
//
// The binding is genuinely once-per-agent work, so attempt it once per agent and offered checkout, and
// remember in hook state that it was attempted. Returns whether a bind ran, so a caller only pays for a
// second board read when the answer to it can have changed.
export function bindObservedRuntimeIdentityOnce(input: HookInput, agentId: string, executor: string, worktree: string): boolean {
  const sessionId = hookSessionId(input);
  if (!sessionId) return false;
  const agentName = stringField(input, 'agent_name', 'agentName', 'name') || null;
  const key = agentKey(agentId, agentName, worktree);
  const state = readIdentityState(sessionId);
  const agents = state.agents || {};
  // A deferred binding is an attempt that never reached the store, so it is owed one, not spent.
  if (agents[key]?.attempted && !agents[key]?.deferred) return false;
  writeIdentityState(sessionId, {
    ...state,
    agents: boundedEntries({ ...agents, [key]: { attempted: true, executor, agentName, worktree } }, MAX_TRACKED_AGENTS),
  });
  bindObservedRuntimeIdentity(input, agentId, executor, worktree);
  return true;
}

// SubagentStart cannot wait for the binding: `bindDispatchAgent` scans every ticket on the machine, then
// re-derives immutable worktree facts with six git spawns inside a write transaction, which on a contended
// host ran past the 10s SubagentStart deadline on every executor spawn (SQ-303). Nothing needs the binding
// before the agent's first board call or first write, and both of those paths bind, so record the offer in
// hook state and let whichever hook next reaches the store settle it.
export function deferRuntimeIdentityBinding(sessionId: string, executor: string, agentId: string | null, agentName: string | null, worktree: string): void {
  if (!sessionId) return;
  const state = readIdentityState(sessionId);
  const key = agentKey(agentId || '', agentName, worktree);
  writeIdentityState(sessionId, {
    ...state,
    agents: boundedEntries({
      ...(state.agents || {}),
      [key]: { attempted: true, deferred: true, executor, agentName, worktree },
    }, MAX_TRACKED_AGENTS),
  });
}

// The binding landed, so the offer recorded above is spent rather than owed.
export function settleRuntimeIdentityBinding(sessionId: string, agentId: string | null, agentName: string | null, worktree: string): void {
  if (!sessionId) return;
  const state = readIdentityState(sessionId);
  const key = agentKey(agentId || '', agentName, worktree);
  const existing = state.agents?.[key];
  if (!existing) return;
  writeIdentityState(sessionId, {
    ...state,
    agents: { ...(state.agents || {}), [key]: { ...existing, deferred: false } },
  });
}
