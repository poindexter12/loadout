import os from 'node:os';
import path from 'node:path';

// The Claude Code config tree ("claude home") holding plugins/, settings, and
// installed_plugins.json. Resolution order: an explicit caller override, the
// SIDEQUEST_CLAUDE_HOME escape hatch (kept above CLAUDE_CONFIG_DIR so tests and
// operators can pin a tree regardless of the host session's account), the host
// session's CLAUDE_CONFIG_DIR, then the ~/.claude default. Multi-account setups
// point CLAUDE_CONFIG_DIR away from ~/.claude, so skipping it reads a different
// account's tree (SQ-27).
export function resolveClaudeHome(explicit?: string | null): string {
  return explicit
    || process.env.SIDEQUEST_CLAUDE_HOME
    || process.env.CLAUDE_CONFIG_DIR
    || path.join(os.homedir(), '.claude');
}

// The central Sidequest store (board database, dispatch tokens, launcher, executor
// worktrees). Resolution order: SIDEQUEST_HOME, then <CLAUDE_CONFIG_DIR>/sidequest,
// then ~/.claude/sidequest. A multi-account machine often keeps ~/.claude as a
// back-compat symlink into ONE account's tree, so a session running under another
// account's CLAUDE_CONFIG_DIR must never fall through to the bare ~/.claude path, or
// its board and worktrees land in the other account (SQ-222). SIDEQUEST_CLAUDE_HOME
// is deliberately not consulted: it pins the plugin tree for tests, not the store.
// Every node-side caller goes through here; the node-free function-hook twin is
// sidequestHome() in src/hooks/shared/live-refs.ts and must keep the same order.
export function resolveSidequestHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(env.SIDEQUEST_HOME || '').trim();
  if (explicit) return path.resolve(explicit);
  const configDir = String(env.CLAUDE_CONFIG_DIR || '').trim();
  return path.join(configDir ? path.resolve(configDir) : path.join(os.homedir(), '.claude'), 'sidequest');
}
