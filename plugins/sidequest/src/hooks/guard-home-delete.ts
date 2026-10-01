#!/usr/bin/env node
import './shared/sqlite-budget.js';
import os from 'node:os';
import path from 'node:path';
import { readStdin, stringField } from './shared/input.js';
import { writeDeny } from './shared/output.js';

// Stands in for a value the guard cannot know: an unexpanded variable, a command
// substitution, or another user's home. It may expand to any path, separators included.
const UNKNOWN = '\u0000';

// Braces end a command (`{ rm -rf ~; }`) except inside a `${NAME}` expansion.
function deleteArguments(command: string): string[] {
  const commands = /(?:^|[;&|{}()\n])\s*(?:[\w.-]+\s+)*(?:remove-item|rm|rmdir|rd|ri|del|erase)\b((?:\$\{[^{}\n]*\}|[^;&|{}\n])*)/gi;
  return [...command.matchAll(commands)].map((match) => match[1] || '');
}

// Shell-ish split: whitespace separates words, quotes group and are stripped, an unquoted
// `#` starts a comment, unquoted parentheses and redirections separate words, and `$( )` /
// backtick substitutions stay whole inside the word that contains them.
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote = '';
  const flush = () => {
    if (started) tokens.push(current);
    current = '';
    started = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === '$' && text[index + 1] === '(') {
      let depth = 0;
      let end = index + 1;
      for (; end < text.length; end += 1) {
        if (text[end] === '(') depth += 1;
        else if (text[end] === ')' && --depth === 0) break;
      }
      current += text.slice(index, end + 1);
      started = true;
      index = end;
      continue;
    }
    if (char === '`') {
      const end = text.indexOf('`', index + 1);
      const stop = end === -1 ? text.length : end;
      current += text.slice(index, stop + 1);
      started = true;
      index = stop;
      continue;
    }
    if (/\s/.test(char) || char === '(' || char === ')' || char === '<' || char === '>') {
      flush();
      continue;
    }
    if (char === '#' && !started) break;
    current += char;
    started = true;
  }
  flush();
  return tokens;
}

interface ParsedDelete {
  recursive: boolean;
  targets: string[];
}

function parseDeleteArguments(argumentsAfterDelete: string): ParsedDelete {
  const parsed: ParsedDelete = { recursive: false, targets: [] };
  let optionsEnded = false;
  for (const token of tokenize(argumentsAfterDelete)) {
    if (!token || token === '\\') continue;
    if (!optionsEnded && token === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith('--')) {
      // GNU getopt accepts any unambiguous prefix of --recursive.
      const name = token.toLowerCase().split('=')[0] ?? '';
      if (name.length >= 3 && '--recursive'.startsWith(name)) parsed.recursive = true;
      continue;
    }
    if (!optionsEnded && token.startsWith('-') && token.length > 1) {
      // A short-option cluster (-rf, -fR) or a PowerShell switch (-Recurse, -r, -Recurse:$true).
      const separator = token.indexOf(':');
      const name = separator === -1 ? token.slice(1) : token.slice(1, separator);
      if (/^[a-z]+$/i.test(name) && /r/i.test(name)) parsed.recursive = true;
      const value = separator === -1 ? '' : token.slice(separator + 1);
      if (value && /^(?:path|literalpath|lp|pspath)$/i.test(name)) parsed.targets.push(value);
      continue;
    }
    if (/^(?:\/[a-z?])+$/i.test(token)) {
      // cmd.exe switches: rd /s /q, del /s/q.
      if (/\/s/i.test(token)) parsed.recursive = true;
      continue;
    }
    parsed.targets.push(token);
  }
  return parsed;
}

function expandHome(target: string, home: string): string {
  return target
    .replace(/^~(?=[\\/]|$)/, () => home)
    .replace(/\$\{(?:env:)?(?:home|userprofile)\}|\$env:(?:userprofile|home)(?![\w:])|\$home(?![\w:])|%userprofile%|%homedrive%%homepath%/gi, () => home);
}

function markUnknown(target: string): string {
  let result = '';
  for (let index = 0; index < target.length; index += 1) {
    const char = target[index] ?? '';
    const next = target[index + 1] || '';
    if (index === 0 && char === '~') {
      // ~user, ~+, ~-: a home or directory the guard cannot resolve.
      const end = target.slice(1).search(/[\\/]/);
      result += UNKNOWN;
      index = end === -1 ? target.length : end;
      continue;
    }
    if (char === '$' && next === '(') {
      let depth = 0;
      let end = index + 1;
      for (; end < target.length; end += 1) {
        if (target[end] === '(') depth += 1;
        else if (target[end] === ')' && --depth === 0) break;
      }
      result += UNKNOWN;
      index = end;
      continue;
    }
    if (char === '$' && next === '{') {
      const end = target.indexOf('}', index);
      result += UNKNOWN;
      index = end === -1 ? target.length : end;
      continue;
    }
    if (char === '$' && /[a-z_]/i.test(next)) {
      const match = /^\$(?:env:)?\w+/i.exec(target.slice(index));
      result += UNKNOWN;
      index += (match ? match[0].length : 1) - 1;
      continue;
    }
    if (char === '$' && /[0-9@*#?!$-]/.test(next)) {
      result += UNKNOWN;
      index += 1;
      continue;
    }
    if (char === '`') {
      const end = target.indexOf('`', index + 1);
      result += UNKNOWN;
      index = end === -1 ? target.length : end;
      continue;
    }
    if (char === '%') {
      const match = /^%[a-z_][\w()]*%/i.exec(target.slice(index));
      if (match) {
        result += UNKNOWN;
        index += match[0].length - 1;
        continue;
      }
    }
    result += char;
  }
  return result;
}

function slashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function trimTrailingSlashes(value: string): string {
  const trimmed = value.replace(/\/+$/, '');
  return trimmed || '/';
}

// Every path a recursive delete must not reach: the filesystem root, each ancestor of the
// home directory, the home directory, and home/.claude.
function protectedPaths(home: string): string[] {
  const paths = [path.join(home, '.claude')];
  for (let current = home; ; current = path.dirname(current)) {
    paths.push(current);
    if (path.dirname(current) === current) break;
  }
  return paths.map((value) => trimTrailingSlashes(slashes(value)).toLowerCase());
}

// A glob matches within one path component; an unknown value may span components.
function patternFor(target: string): RegExp {
  let source = '';
  for (let index = 0; index < target.length; index += 1) {
    const char = target[index] ?? '';
    if (char === UNKNOWN) source += '.*';
    else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '[') {
      const end = target.indexOf(']', index + 1);
      if (end === -1) source += '\\[';
      else {
        source += '[^/]';
        index = end;
      }
    } else source += char.replace(/[.+^${}()|\\\]]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'i');
}

function isProtectedTarget(rawTarget: string): boolean {
  const home = path.resolve(os.homedir());
  const marked = markUnknown(expandHome(rawTarget, home));
  if (!marked) return false;
  let candidate: string;
  if (marked.includes(UNKNOWN)) {
    const normalized = slashes(marked);
    // `$x/..` can climb anywhere, and a target led by an unknown value can be any path.
    if (normalized.split('/').some((part) => part === '.' || part === '..')) return true;
    if (!normalized.startsWith(UNKNOWN) && !path.isAbsolute(normalized.split(UNKNOWN)[0] || '.')) return false;
    candidate = trimTrailingSlashes(normalized);
  } else {
    const normalized = path.sep === '/' ? slashes(marked) : marked;
    if (!path.isAbsolute(normalized)) return false;
    const resolved = path.resolve(normalized);
    if (path.parse(resolved).root === resolved) return true;
    candidate = trimTrailingSlashes(slashes(resolved));
    const globAt = candidate.search(/[*?[]/);
    if (globAt !== -1) {
      const globDirectory = candidate.slice(0, candidate.lastIndexOf('/', globAt) + 1);
      if (path.parse(path.resolve(globDirectory)).root === path.resolve(globDirectory)) return true;
    }
  }
  const pattern = patternFor(candidate);
  return protectedPaths(home).some((protectedPath) => pattern.test(protectedPath));
}

function hasProtectedRecursiveDelete(command: string): boolean {
  return deleteArguments(command).some((argumentsAfterDelete) => {
    const parsed = parseDeleteArguments(argumentsAfterDelete);
    return parsed.recursive && parsed.targets.some(isProtectedTarget);
  });
}

function main(): void {
  const input = readStdin();
  if (!input || !['Bash', 'PowerShell'].includes(stringField(input, 'tool_name'))) return;
  const toolInput = input.tool_input;
  const command = toolInput !== null && typeof toolInput === 'object' && !Array.isArray(toolInput)
    ? String((toolInput as Record<string, unknown>).command || '')
    : '';
  if (!hasProtectedRecursiveDelete(command)) return;
  writeDeny('PreToolUse', 'sidequest: blocked a recursive delete aimed at the user profile or .claude root. Use a specific project or scratchpad path instead.');
}

try {
  main();
} catch (_) {
  process.exit(0);
}
