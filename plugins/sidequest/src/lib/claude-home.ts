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
