#!/usr/bin/env node
import './shared/sqlite-budget.js';
import { readStdin, stringField } from './shared/input.js';
import { writeContext } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';
import { deferRuntimeIdentityBinding, settleRuntimeIdentityBinding } from './shared/runtime-identity.js';
import { DIAGNOSTIC_PROBE_NAME } from '../lib/exec-names.js';
import { diagnosticWorktreeWarning } from './diagnostic-worktree-warning.js';

type ExecutorKind = 'codex_dispatch' | 'claude_builtin' | 'read_only_codex_dispatch' | 'read_only_claude_builtin' | 'legacy_ticket' | 'ticket' | 'unknown';
interface ExecutorClassification {
  kind: ExecutorKind;
  effort: string | null;
}

function fallbackClassify(type: string): ExecutorClassification {
  const readOnlyDispatch = /^sidequest-exec-dispatch-readonly(?:-(low|medium|high|xhigh|max))?$/.exec(type);
  if (readOnlyDispatch) return { kind: 'read_only_codex_dispatch', effort: readOnlyDispatch[1] || null };
  const readOnlyBuiltin = /^sidequest-exec-readonly-(low|medium|high|xhigh|max)$/.exec(type);
  if (readOnlyBuiltin) return { kind: 'read_only_claude_builtin', effort: readOnlyBuiltin[1] || null };
  const dispatch = /^sidequest-exec-dispatch(?:-(low|medium|high|xhigh|max))?$/.exec(type);
  if (dispatch) return { kind: 'codex_dispatch', effort: dispatch[1] || null };
  const builtin = /^sidequest-exec-(low|medium|high|xhigh|max)$/.exec(type);
  if (builtin) return { kind: 'claude_builtin', effort: builtin[1] || null };
  if (type === DIAGNOSTIC_PROBE_NAME) return { kind: 'unknown', effort: null };
  if (/^sidequest-ticket-/.test(type)) return { kind: 'legacy_ticket', effort: null };
  if (/^sidequest-(?:sq-|exec-)/.test(type)) return { kind: 'ticket', effort: null };
  return { kind: 'unknown', effort: null };
}

function classifyExecutor(type: string): ExecutorClassification {
  try {
    return require(runtimeModule('exec-names')).classify(type) as ExecutorClassification;
  } catch (_) {
    return fallbackClassify(type);
  }
}

function main(): void {
  const data = readStdin();
  if (!data) return;
  const sessionId = stringField(data, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
  const executor = stringField(data, 'agent_type', 'agentType', 'subagent_type');
  const agentId = stringField(data, 'agent_id', 'agentId');
  const agentName = stringField(data, 'agent_name', 'agentName', 'name');
  if (!sessionId || !executor || (!agentId && !agentName)) return;
  const classification = classifyExecutor(executor);
  if (classification.kind === 'unknown') return;
  const worktree = stringField(data, 'cwd', 'project_dir', 'projectDir');
  // SQ-303: this binding overran SubagentStart's 10s deadline on every executor spawn, because it re-derived
  // immutable worktree facts with six git spawns inside its write transaction. Those facts now come off disk
  // (src/lib/kernel/worktree.ts, checkoutLayout), which is what makes an inline bind affordable again.
  //
  // What remains unbounded is the lock. The hook SQLite budget already caps that at one 1.5s wait and then
  // fails open (SQ-125), but failing open exits this process, so a binding lost to a busy board used to be
  // lost silently. Record the offer in hook state BEFORE attempting it and clear it on success: whatever
  // ends this process early — an exhausted budget, or Claude Code killing the hook at its deadline — leaves
  // the offer on disk for the next hook that reaches the store. Nothing reads the binding before the agent's
  // first board call or first write, and both of those paths bind.
  deferRuntimeIdentityBinding(sessionId, executor, agentId || null, agentName || null, worktree || '');
  try {
    const store = require(runtimeModule('store')) as {
      bindDispatchAgent: (sessionId: string, executor: string, agentId: string | null, agentName: string | null, worktree: string | null) => unknown;
    };
    store.bindDispatchAgent(sessionId, executor, agentId || null, agentName || null, worktree || null);
    // Reaching the store spends the offer, whatever it answered. A refusal is an answer — an agent the
    // board holds no dispatch for will be refused every time — and treating that as still owed would put
    // the write back on the Edit path for exactly the agents this was meant to keep it off.
    settleRuntimeIdentityBinding(sessionId, agentId || null, agentName || null, worktree || '');
  } catch (_) {
    // The store was never reached, so the offer stays owed. The next hook that gets there settles it.
  }
  const warning = diagnosticWorktreeWarning(data);
  if (warning) writeContext('SubagentStart', warning);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
