#!/usr/bin/env node
import { failClosedOnBoardBusy, refuseWhenBoardBusy } from './shared/sqlite-budget.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readStdin, stringField, isRecord } from './shared/input.js';
import { writeDeny } from './shared/output.js';
import { executorAgent, isolationExpectation } from './shared/runtime-identity.js';

// An isolation guard: refuse under board lock contention rather than allow a shared-checkout write unchecked (SQ-133).
failClosedOnBoardBusy();

const MUTATING_SUBCOMMANDS = new Set([
  'add', 'am', 'apply', 'branch', 'checkout', 'cherry-pick', 'clean', 'commit', 'merge', 'mv',
  'rebase', 'reset', 'restore', 'revert', 'rm', 'sparse-checkout', 'stash', 'switch', 'tag',
  'update-ref', 'worktree',
]);

function commandText(input: Record<string, unknown>): string {
  const toolInput = input.tool_input;
  return isRecord(toolInput) ? String(toolInput.command || '') : '';
}

function canonicalPath(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch (_) {
    return path.resolve(value);
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = canonicalPath(left);
  const normalizedRight = canonicalPath(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

// `git` only names a git invocation when it is the PROGRAM WORD at a command boundary. A shared-checkout
// path that merely appears as an argument is not a git target: `--project <checkout>`, a directory whose
// name contains `github`, `git fetch <checkout>`, or a quoted note that happens to read like a command.
// Refusing those was the SQ-128/SQ-227 defect, so the boundary and the quote check are the rule, not a
// substring search for either `git` or the project path.
const GIT_INVOCATION = /(?:^|[;&|\n]\s*|\$\(\s*)git\s+(?:-C\s+("[^"]+"|'[^']+'|\S+)\s+)?([a-z-]+)/gi;
const CD_PREFIX = /(?:^|[;&|\n]|\$\()\s*cd\s+("[^"]+"|'[^']+'|\S+)/gi;

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '');
}

// Shared with guard-shared-tree-commit: a match inside a quoted argument is text, not a command.
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

// Every git invocation in the command is checked, because the first one can be read-only while a later one
// mutates (`cd <checkout> && git status && git reset --hard`). The directory an invocation acts on comes
// from its own `-C`, else the nearest preceding unquoted `cd`, else the tool's cwd.
function gitInvocations(command: string): Array<{ target: string; subcommand: string }> {
  const invocations: Array<{ target: string; subcommand: string }> = [];
  for (const match of command.matchAll(GIT_INVOCATION)) {
    const index = match.index || 0;
    if (!match[2] || quotedAt(command, index)) continue;
    const before = command.slice(0, index);
    const cd = Array.from(before.matchAll(CD_PREFIX)).filter((entry) => !quotedAt(command, entry.index || 0)).at(-1);
    const target = match[1] ? unquote(match[1]) : cd?.[1] ? unquote(cd[1]) : '.';
    invocations.push({ target, subcommand: match[2].toLowerCase() });
  }
  return invocations;
}

function targetRoot(target: string, cwd: string): string {
  const directory = path.resolve(cwd || '.', target);
  try {
    return canonicalPath(execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
  } catch (_) {
    return canonicalPath(directory);
  }
}

function refusal(): string {
  return 'sidequest: refusing a mutating git command against the shared checkout from an isolated worktree. Read-only git commands such as log, diff, show, rev-parse, and ls-files are allowed for review; make repository changes only in the assigned worktree. Passing that checkout path as an ordinary argument, such as --project <path> or git fetch <path>, is not refused.';
}

function main(): void {
  const input = readStdin();
  if (!input || !['Bash', 'PowerShell'].includes(stringField(input, 'tool_name'))) return;
  const agentId = stringField(input, 'agent_id', 'agentId');
  const executor = stringField(input, 'agent_type', 'agentType', 'subagent_type');
  if (!agentId || !executorAgent(executor)) return;
  // Decide from the command first: only a mutating git command needs the board, so board lock contention can
  // never refuse a read-only one.
  const invocations = gitInvocations(commandText(input)).filter((entry) => MUTATING_SUBCOMMANDS.has(entry.subcommand));
  if (!invocations.length) return;
  const found = isolationExpectation(input, agentId, executor, false);
  if (!found || found.sharedTree || found.terminal || !found.projectPath) return;
  const cwd = stringField(input, 'cwd');
  for (const invocation of invocations) {
    if (samePath(targetRoot(invocation.target, cwd), found.projectPath)) {
      writeDeny('PreToolUse', refusal());
      return;
    }
  }
}

try {
  main();
} catch (error) {
  refuseWhenBoardBusy(error);
  process.exit(0);
}
