'use strict';

// SQ-428: a Sidequest worktree is a fresh `git worktree add`, and node_modules is gitignored, so
// the worktree has no installed dependencies unless the board configures `worktreeSetup` or
// `worktreeDependencyPaths`. Only a named-suite verifier carries its own `npm ci`, and only for the
// one plugin it resolves; a pinned command verifier installs nothing. Running such a command
// anyway fails inside the package's scripts (`tsx: not found`, `vitest: command not found`,
// `Cannot find type definition file for 'node'`), which reads like a code defect and costs a
// rework round. This preflight finds the packages a verify command runs scripts in, and reports
// the ones whose dependencies are not installed, so the caller can refuse before running.

const fs = require('node:fs') as typeof import('node:fs');
const path = require('node:path') as typeof import('node:path');

export type PackageManager = 'npm' | 'pnpm' | 'yarn';

export type MissingDependencyPackage = Readonly<{
  directory: string;
  relativeDirectory: string;
  manager: PackageManager;
  installCommand: string;
}>;

const SCRIPT_SUBCOMMANDS: Readonly<Record<PackageManager, ReadonlySet<string>>> = Object.freeze({
  npm: new Set(['run', 'run-script', 'rum', 'urn', 'test', 'tst', 't', 'start', 'stop', 'restart', 'exec', 'x']),
  pnpm: new Set(['run', 'test', 't', 'start', 'exec']),
  yarn: new Set(['run', 'test', 'start', 'exec']),
});

const INSTALL_SUBCOMMANDS: Readonly<Record<PackageManager, ReadonlySet<string>>> = Object.freeze({
  npm: new Set(['ci', 'clean-install', 'install-clean', 'isntall', 'install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'add', 'install-test', 'it', 'install-ci-test', 'cit']),
  pnpm: new Set(['install', 'i', 'add']),
  yarn: new Set(['install', 'add']),
});

// npm, pnpm and yarn options that take a separate value argument and change the package directory.
const DIRECTORY_OPTIONS: Readonly<Record<PackageManager, ReadonlySet<string>>> = Object.freeze({
  npm: new Set(['--prefix', '-C']),
  pnpm: new Set(['--dir', '-C']),
  yarn: new Set(['--cwd']),
});

type Token = Readonly<{ value: string; literal: boolean }>;

// Split a shell command into simple-command segments of words. Quotes are honoured; any word
// that carries an expansion ($, `, ~, globs) is marked non-literal so it is never treated as a
// path. Anything the tokenizer cannot follow just yields fewer recognised segments, which only
// ever makes the preflight more permissive, never a false refusal.
function segments(command: string): Token[][] {
  const result: Token[][] = [];
  let current: Token[] = [];
  let word = '';
  let inWord = false;
  let literal = true;
  let quote: '"' | "'" | null = null;
  const endWord = () => {
    if (inWord) current.push(Object.freeze({ value: word, literal }));
    word = '';
    inWord = false;
    literal = true;
  };
  const endSegment = () => {
    endWord();
    if (current.length) result.push(current);
    current = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command.charAt(index);
    if (quote) {
      if (character === quote) { quote = null; continue; }
      if (quote === '"' && (character === '$' || character === '`')) literal = false;
      word += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; inWord = true; continue; }
    if (character === '\\' && index + 1 < command.length) { word += command.charAt(index + 1); inWord = true; index += 1; continue; }
    if (character === '&' || character === '|' || character === ';' || character === '\n' || character === '(' || character === ')') {
      endSegment();
      continue;
    }
    if (/\s/.test(character)) { endWord(); continue; }
    if ('$`*?[~<>{}'.includes(character)) literal = false;
    word += character;
    inWord = true;
  }
  endSegment();
  return result;
}

function managerOf(token: Token | undefined): PackageManager | null {
  if (!token?.literal) return null;
  const name = path.basename(token.value);
  return name === 'npm' || name === 'pnpm' || name === 'yarn' ? name : null;
}

type Invocation = Readonly<{ manager: PackageManager; subcommand: string | null; directory: string | null | undefined }>;

// directory: string when a directory option names one, null when absent, undefined when present
// but not a literal path (so the target cannot be known).
function invocation(words: Token[]): Invocation | null {
  let start = 0;
  for (let assignment = words[start]; assignment?.literal && /^[A-Za-z_][A-Za-z0-9_]*=/.test(assignment.value); assignment = words[start]) start += 1;
  const manager = managerOf(words[start]);
  if (!manager) return null;
  let subcommand: string | null = null;
  let directory: string | null | undefined = null;
  for (let index = start + 1; index < words.length; index += 1) {
    const word = words[index];
    if (!word) continue;
    const equals = word.value.indexOf('=');
    const optionName = equals > 0 ? word.value.slice(0, equals) : word.value;
    if (DIRECTORY_OPTIONS[manager].has(optionName)) {
      const valueToken = equals > 0 ? word : words[index + 1];
      const value = equals > 0 ? word.value.slice(equals + 1) : valueToken?.value;
      directory = valueToken?.literal && value ? value : undefined;
      if (equals <= 0) index += 1;
      continue;
    }
    if (word.value.startsWith('-')) continue;
    if (subcommand === null) subcommand = word.value;
  }
  return Object.freeze({ manager, subcommand, directory });
}

function installs(call: Invocation): boolean {
  // A bare `yarn` installs.
  if (call.manager === 'yarn' && call.subcommand === null) return true;
  return call.subcommand !== null && INSTALL_SUBCOMMANDS[call.manager].has(call.subcommand);
}

function runsScripts(call: Invocation): boolean {
  return call.subcommand !== null && SCRIPT_SUBCOMMANDS[call.manager].has(call.subcommand);
}

// True when the command installs dependencies itself (for example a named suite's
// `cd plugins/x && npm ci && npm run test:full`). The preflight then stays out of the way.
export function commandProvisionsDependencies(command: string): boolean {
  return segments(String(command || '')).some((words) => {
    const call = invocation(words);
    return call ? installs(call) : false;
  });
}

function readManifest(directory: string): any {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function nearestPackageDirectory(start: string): string | null {
  let directory = start;
  for (;;) {
    if (fs.existsSync(path.join(directory, 'package.json'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function declaresDependencies(manifest: any): boolean {
  return ['dependencies', 'devDependencies', 'optionalDependencies']
    .some((field) => manifest && typeof manifest[field] === 'object' && manifest[field] && Object.keys(manifest[field]).length > 0);
}

function installedAt(directory: string): boolean {
  if (fs.existsSync(path.join(directory, '.pnp.cjs')) || fs.existsSync(path.join(directory, '.pnp.js'))) return true;
  try {
    return fs.readdirSync(path.join(directory, 'node_modules')).length > 0;
  } catch {
    return false;
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

// Node resolves from the package directory upward, so a hoisted install at a workspace root
// counts. The walk stops at the verification directory so an unrelated node_modules higher up
// the filesystem never vouches for a worktree.
function dependenciesInstalled(packageDirectory: string, root: string): boolean {
  if (!isInside(root, packageDirectory)) return installedAt(packageDirectory);
  let directory = packageDirectory;
  for (;;) {
    if (installedAt(directory)) return true;
    if (directory === root) return false;
    directory = path.dirname(directory);
  }
}

function installCommand(manager: PackageManager, packageDirectory: string, relativeDirectory: string): string {
  const target = relativeDirectory === '.' ? '' : relativeDirectory;
  const quoted = /[\s"'$`\\]/.test(target) ? JSON.stringify(target) : target;
  if (manager === 'pnpm') return `pnpm${target ? ` --dir ${quoted}` : ''} install --frozen-lockfile`;
  if (manager === 'yarn') return `yarn${target ? ` --cwd ${quoted}` : ''} install --frozen-lockfile`;
  const locked = fs.existsSync(path.join(packageDirectory, 'package-lock.json')) || fs.existsSync(path.join(packageDirectory, 'npm-shrinkwrap.json'));
  return `npm${target ? ` --prefix ${quoted}` : ''} ${locked ? 'ci' : 'install'}`;
}

// The packages a verify command runs scripts in whose declared dependencies are not installed.
// Empty when every targeted package is installed, when the command installs dependencies itself,
// or when no targeted package can be determined.
export function packagesMissingDependencies(command: string, cwd: string): MissingDependencyPackage[] {
  const text = String(command || '');
  if (!text.trim() || commandProvisionsDependencies(text)) return [];
  const root = path.resolve(cwd);
  let directory: string | null = root;
  const missing = new Map<string, MissingDependencyPackage>();
  for (const words of segments(text)) {
    if (words[0]?.literal && words[0].value === 'cd') {
      const target = words[1];
      directory = directory && target?.literal && target.value && target.value !== '-' ? path.resolve(directory, target.value) : null;
      continue;
    }
    const call = invocation(words);
    if (!call || !runsScripts(call) || call.directory === undefined) continue;
    const base = call.directory === null ? directory : directory && path.resolve(directory, call.directory);
    if (!base) continue;
    const packageDirectory = call.directory === null ? nearestPackageDirectory(base) : base;
    if (!packageDirectory || missing.has(packageDirectory)) continue;
    const manifest = readManifest(packageDirectory);
    if (!declaresDependencies(manifest) || dependenciesInstalled(packageDirectory, root)) continue;
    const relativeDirectory = path.relative(root, packageDirectory).split(path.sep).join('/') || '.';
    missing.set(packageDirectory, Object.freeze({
      directory: packageDirectory,
      relativeDirectory,
      manager: call.manager,
      installCommand: installCommand(call.manager, packageDirectory, relativeDirectory),
    }));
  }
  return [...missing.values()];
}

// Agent-facing: the refusal an executor or orchestrator reads instead of a test failure.
export function dependenciesNotInstalledEvidence(command: string, missing: readonly MissingDependencyPackage[]): string {
  const packages = missing.map((entry) => entry.relativeDirectory).join(', ');
  const installs = missing.map((entry) => entry.installCommand).join(' && ');
  return `Dependencies are not installed: ${packages} declares dependencies but has no node_modules, so ${JSON.stringify(command)} was not run and no candidate was judged. `
    + 'Sidequest creates worktrees without node_modules unless the board configures worktreeSetup or worktreeDependencyPaths (board_config). '
    + `Install them in this worktree with \`${installs}\` (node_modules is gitignored, so the tree stays clean), then rerun this verification.`;
}
