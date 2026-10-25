#!/usr/bin/env node
import './shared/sqlite-budget.js';
import path from 'node:path';
import { readStdin, stringField, isRecord } from './shared/input.js';
import { writeDeny } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';
import { withoutHereDocBodies } from './shared/heredocs.js';

interface IsolationExpectation {
  sharedTree: boolean;
}

function bashCommand(input: Record<string, unknown>): string {
  const toolInput = input.tool_input;
  if (!isRecord(toolInput)) return '';
  return String(toolInput.command || '');
}

function hasHereDoc(command: string): boolean {
  let quote: 'single' | 'double' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === 'single') {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === 'double') {
      if (character === '\\') index += 1;
      else if (character === '"') quote = null;
      continue;
    }
    if (character === "'") {
      quote = 'single';
      continue;
    }
    if (character === '"') {
      quote = 'double';
      continue;
    }
    if (character === '#') {
      const previous = command[index - 1];
      if (previous === undefined || /[\s;&|(]/.test(previous)) {
        const lineEnd = command.indexOf('\n', index);
        if (lineEnd < 0) return false;
        index = lineEnd;
      }
      continue;
    }
    if (character === '<' && command[index + 1] === '<' && command[index + 2] !== '<') return true;
  }
  return false;
}

// SQ-227: this guard used to refuse EVERY heredoc in an isolated worktree. That left a readonly executor (no
// Write tool) no way to write its evidence or scratch files, and it refused plain `cat <<'EOF' > $SCRATCH/x`
// writes that never touch git. What the harness cannot verify is a git invocation it cannot see the target
// of, so only a heredoc that carries one is refused: git as the PROGRAM WORD of the shell part (`git commit
// -F - <<'EOF'`), or anywhere in a heredoc body fed to a shell interpreter (`bash <<'SH'` ... `git push`).
// A path or prose that merely contains "git" or "github" is not an invocation.
const PROGRAM_START = String.raw`(?:^|[;&|\n(\x60{]|\$\()\s*`;
const COMMAND_PREFIX = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:(?:command|exec|env|sudo|nohup|time)\s+(?:-\S+\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)*`;
const GIT_PROGRAM = new RegExp(`${PROGRAM_START}${COMMAND_PREFIX}(?:\\S*/)?git(?=\\s|$|[;&|)])`, 'g');
const SHELL_PROGRAM = new RegExp(`${PROGRAM_START}${COMMAND_PREFIX}(?:\\S*/)?(?:ba|z|da|k)?sh(?=\\s|$|[;&|)])`, 'g');

function quotedAt(command: string, index: number): boolean {
  let quote = '';
  for (let cursor = 0; cursor < index; cursor += 1) {
    const character = command[cursor];
    if (character === '\\') cursor += 1;
    else if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
  }
  return Boolean(quote);
}

function programIn(text: string, pattern: RegExp, honourQuotes: boolean): boolean {
  for (const match of text.matchAll(pattern)) {
    if (!honourQuotes || !quotedAt(text, match.index || 0)) return true;
  }
  return false;
}

function carriesGitInvocation(command: string): boolean {
  const shell = withoutHereDocBodies(command);
  if (programIn(shell, GIT_PROGRAM, true)) return true;
  // A body fed to a shell is a script, and its quoting is the script's own, so scan it line by line unquoted.
  return programIn(shell, SHELL_PROGRAM, true) && programIn(command, GIT_PROGRAM, false);
}

function dispatchedInWorktree(input: Record<string, unknown>): boolean {
  try {
    const store = require(runtimeModule('store')) as {
      dispatchIsolationExpectation: (identity: unknown) => IsolationExpectation | null;
    };
    const found = store.dispatchIsolationExpectation({
      agentId: stringField(input, 'agent_id', 'agentId'),
      executor: stringField(input, 'agent_type', 'agentType', 'subagent_type'),
      sessionId: stringField(input, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || '',
      observedWorktree: stringField(input, 'cwd') || process.cwd(),
    });
    return found?.sharedTree === false;
  } catch (_) {
    return false;
  }
}

function harnessWorktreeCwd(input: Record<string, unknown>): boolean {
  const cwd = stringField(input, 'cwd') || process.cwd();
  const parts = path.resolve(cwd).split(/[\\/]+/).map((part) => part.toLowerCase());
  return parts.some((part, index) => (
    part === 'worktrees'
    && parts.slice(0, index).includes('.claude')
    && (parts[index + 1]?.startsWith('agent-') === true || parts[index + 2]?.startsWith('agent-') === true)
  ));
}

function main(): void {
  const input = readStdin();
  if (!input || stringField(input, 'tool_name') !== 'Bash') return;
  const command = bashCommand(input);
  if (!hasHereDoc(command) || !carriesGitInvocation(command)) return;
  if (!dispatchedInWorktree(input) && !harnessWorktreeCwd(input)) return;
  writeDeny('PreToolUse', 'sidequest: refusing a heredoc that carries a git invocation in an isolated worktree; the harness cannot verify that git stays inside the worktree. Run git as plain, separate commands, or Write the script to your scratchpad and run it by path. A heredoc with no git invocation is allowed.');
}

try {
  main();
} catch (_) {
  process.exit(0);
}
