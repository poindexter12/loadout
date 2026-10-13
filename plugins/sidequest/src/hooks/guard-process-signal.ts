#!/usr/bin/env node
import './shared/sqlite-budget.js';
import { readStdin, stringField, isRecord } from './shared/input.js';
import { writeDeny } from './shared/output.js';
import { withoutHereDocBodies } from './shared/heredocs.js';

// SQ-224: on 2026-09-28 an executor clearing what it took to be its own stuck `cargo test` killed a
// different ticket's verify run in another worktree. No in-plugin code path did it: lib/ports/process.js
// only ever terminates the group it spawned itself. The kill came from the agent's own shell, and the
// mechanism is selection, not the signal. `pkill -f cargo`, `killall node`, `pgrep | xargs kill` and
// `taskkill /IM` all name their targets by command line or image name, and parallel executors on one host
// run byte-identical test commands, so such a signal reaches every worktree by construction.
//
// So this guard denies the SELECTION and never the signal: a kill by a pid or job spec this shell owns
// (`kill "$pid"`, `kill %1`, `kill $!`) is own-attempt by construction and stays allowed, as does a
// read-only `pgrep` or `ps`. A literal `kill 48213` also stays allowed, because nothing a 10s text guard
// can read distinguishes a pid this attempt spawned from one it read out of someone else's `ps` output;
// that case is covered by the "Sibling liveness" rule in the executor instructions instead.

// Leading words that read as "now run the real command": skipped so `sudo pkill -f x` is still a pkill.
const WRAPPERS = new Set([
  'sudo', 'doas', 'command', 'builtin', 'env', 'exec', 'nohup', 'setsid', 'stdbuf', 'nice', 'ionice',
  'time', 'timeout', 'if', 'then', 'else', 'elif', 'while', 'until', 'do', '!',
]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'busybox', 'pwsh', 'powershell', 'cmd']);
const KILL_VERBS = new Set(['kill', 'pkill', 'killall', 'killall5', 'taskkill', 'stop-process', 'spps']);
// A selector answers "which pids match this text", which is the opposite of "which pids do I own".
const SELECTOR = /(?:^|[^\w.-])(?:pgrep|pidof|ps|lsof|get-process|gps)(?:\s|$)/i;
// Short options that consume the next token, so `xargs -n 1 kill` finds `kill` and not `1`.
const XARGS_VALUE_FLAGS = new Set(['-a', '-d', '-E', '-e', '-I', '-i', '-L', '-l', '-n', '-P', '-s']);
const SUBSTITUTIONS = /\$\(([\s\S]*?)\)|`([\s\S]*?)`/g;

function reasonFor(label: string): string {
  return `sidequest: blocked ${label}. It picks its targets by pattern or by search rather than by ownership, so on this host it reaches other worktrees: a sibling executor's test or build command line is byte-identical to yours, and exactly this killed another ticket's verify run (SQ-224). Signal only a process this attempt started, by a pid or job spec this shell owns (\`kill "$pid"\`, \`kill %1\`). A verify run that overruns its budget is terminated by the verify wrapper itself, which kills the process group it spawned. A task you started is stopped with TaskStop. Another ticket's run is never yours to stop. Read-only \`pgrep\`/\`ps\` stays allowed if you only need to look.`;
}

function basename(token: string): string {
  const name = (token.replace(/\\/g, '/').split('/').pop() || '').toLowerCase();
  return name.replace(/\.(?:exe|cmd|bat|ps1)$/, '');
}

// Shell-ish split into command segments: whitespace separates words, quotes group and are stripped,
// `;`/`&`/`|`/newline/parens/braces end a segment, and a `$( )` or backtick substitution stays whole
// inside its word so the segment can still be asked where its targets came from.
function segmentsOf(command: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let current = '';
  let started = false;
  const flushToken = (): void => {
    if (started) tokens.push(current);
    current = '';
    started = false;
  };
  const flushSegment = (): void => {
    flushToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? '';
    if (char === '\\') {
      current += command[index + 1] ?? '';
      started = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = command.indexOf(char, index + 1);
      const stop = end === -1 ? command.length : end;
      current += command.slice(index + 1, stop);
      started = true;
      index = stop;
      continue;
    }
    if (char === '$' && command[index + 1] === '(') {
      let depth = 0;
      let end = index + 1;
      for (; end < command.length; end += 1) {
        if (command[end] === '(') depth += 1;
        else if (command[end] === ')' && --depth === 0) break;
      }
      current += command.slice(index, Math.min(end + 1, command.length));
      started = true;
      index = end;
      continue;
    }
    if (char === '`') {
      const end = command.indexOf('`', index + 1);
      const stop = end === -1 ? command.length : end;
      current += command.slice(index, stop + 1);
      started = true;
      index = stop;
      continue;
    }
    if (char === '#' && !started) {
      const lineEnd = command.indexOf('\n', index);
      if (lineEnd === -1) break;
      index = lineEnd - 1;
      continue;
    }
    if (';&|\n(){}'.includes(char)) {
      flushSegment();
      continue;
    }
    if (char === '<' || char === '>' || /\s/.test(char)) {
      flushToken();
      continue;
    }
    current += char;
    started = true;
  }
  flushSegment();
  return segments;
}

function fromProcessSearch(token: string): boolean {
  return [...token.matchAll(SUBSTITUTIONS)].some((match) => SELECTOR.test(match[1] ?? match[2] ?? ''));
}

interface Invocation {
  head: string;
  rest: string[];
}

function invocationOf(tokens: string[]): Invocation | null {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] ?? '';
    if (/^[A-Za-z_]\w*=/.test(token)) {
      index += 1;
      continue;
    }
    if (WRAPPERS.has(basename(token))) {
      index += 1;
      // The wrapper's own options, and `timeout 600`-style durations, are not the command.
      while (index < tokens.length && /^(?:-|[\d.]+[smhd]?$)/.test(tokens[index] ?? '')) index += 1;
      continue;
    }
    return { head: basename(token), rest: tokens.slice(index + 1) };
  }
  return null;
}

function xargsCommand(rest: string[]): string {
  let index = 0;
  while (index < rest.length) {
    const token = rest[index] ?? '';
    if (!token.startsWith('-')) break;
    index += 1;
    if (XARGS_VALUE_FLAGS.has(token)) index += 1;
  }
  return basename(rest[index] ?? '');
}

// Stop-Process selects by name, by piped process object, or by an id this shell named. Only the last
// is ownership; a bare `Get-Process node | Stop-Process` has no target of its own at all.
function powershellStopSelectsByName(rest: string[]): boolean {
  if (rest.some((token) => /^-(?:n(?:a(?:me?)?)?|processname|pn)(?::|$)/i.test(token))) return true;
  return !rest.some((token) => /^-(?:id|i|inputobject)(?::|$)/i.test(token) || /^\$/.test(token) || /^\d+$/.test(token));
}

function denialFor(command: string, depth = 0): string | null {
  const segments = segmentsOf(command);
  let searchedTargets = false;
  let signals = false;
  for (const tokens of segments) {
    // `pids=$(pgrep -f cargo)` selects the same way a `pkill` does; the signal just lands one
    // segment later. The assignment is a whole segment of its own, so this runs before the head.
    if (tokens.some((token) => /^[A-Za-z_]\w*=/.test(token) && fromProcessSearch(token))) searchedTargets = true;
    const invocation = invocationOf(tokens);
    if (!invocation) continue;
    const { head, rest } = invocation;
    if (head === 'pkill') return 'a pattern-selected kill (pkill)';
    if (head === 'killall' || head === 'killall5') return 'a name-selected kill (killall)';
    if (head === 'taskkill' && rest.some((token) => /^[-/](?:im|fi)(?:[:=]|$)/i.test(token))) {
      return 'an image-name kill (taskkill /IM)';
    }
    if ((head === 'stop-process' || head === 'spps') && powershellStopSelectsByName(rest)) {
      return 'a name-selected or pipeline-fed kill (Stop-Process)';
    }
    if (head === 'xargs' && KILL_VERBS.has(xargsCommand(rest))) {
      return 'a kill fed through xargs (xargs kill)';
    }
    if (KILL_VERBS.has(head)) {
      signals = true;
      if (rest.some(fromProcessSearch)) return 'a kill whose target came from a process search';
    }
    if (head === 'for' && tokens.some(fromProcessSearch)) searchedTargets = true;
    if (SHELLS.has(head) && depth < 3) {
      for (let index = 0; index < rest.length; index += 1) {
        if (!/^(?:-c|-command|\/c|\/k)$/i.test(rest[index] ?? '')) continue;
        const nested = denialFor(rest[index + 1] ?? '', depth + 1);
        if (nested) return nested;
      }
    }
  }
  return searchedTargets && signals ? 'a kill whose target came from a process search' : null;
}

function main(): void {
  const input = readStdin();
  if (!input || !['Bash', 'PowerShell'].includes(stringField(input, 'tool_name'))) return;
  const toolInput = input.tool_input;
  const command = isRecord(toolInput) ? String(toolInput.command || '') : '';
  if (!command) return;
  // A heredoc body is data the shell writes, not commands it runs: documenting `pkill` is not killing.
  const label = denialFor(withoutHereDocBodies(command));
  if (!label) return;
  writeDeny('PreToolUse', reasonFor(label));
}

try {
  main();
} catch (_) {
  process.exit(0);
}
