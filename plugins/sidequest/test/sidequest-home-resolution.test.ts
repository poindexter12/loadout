import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import './_temp-cleanup.js';

import { sidequestHome as neutralSidequestHome } from '../src/hooks/shared/live-refs.js';

// SQ-222: a session running with CLAUDE_CONFIG_DIR pointed at one account's tree
// (~/.poindexter/claude) created its executor worktrees, dispatch tokens, and launcher
// under ~/.claude/sidequest, which on a multi-account machine is a symlink into ANOTHER
// account's tree. With SIDEQUEST_HOME unset, the central store must root at
// $CLAUDE_CONFIG_DIR/sidequest, falling back to ~/.claude/sidequest only when no
// config dir is set.

const pluginRoot = path.resolve(__dirname, '..');

function probe(env: Record<string, string | undefined>) {
  const script = [
    "const store = require('./lib/store');",
    "const worktrees = require('./lib/worktrees');",
    'const project = process.env.SQ222_PROJECT;',
    'process.stdout.write(JSON.stringify({',
    '  homeRoot: store.homeRoot(),',
    '  worktreeRoot: worktrees.worktreeRoot(project),',
    "  agentWorktree: worktrees.agentWorktreePath(project, 'probe'),",
    '}));',
  ].join('\n');
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete childEnv[key];
  const result = spawnSync(process.execPath, ['-e', script], { cwd: pluginRoot, encoding: 'utf8', env: childEnv as NodeJS.ProcessEnv });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout) as { homeRoot: string; worktreeRoot: string; agentWorktree: string };
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

test('SQ-222: with SIDEQUEST_HOME unset, the store and executor worktrees root under CLAUDE_CONFIG_DIR, not ~/.claude', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-222-home-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-222-config-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-222-project-'));
  try {
    const resolved = probe({ SIDEQUEST_HOME: undefined, HOME: fakeHome, USERPROFILE: fakeHome, CLAUDE_CONFIG_DIR: configDir, SQ222_PROJECT: project });
    const expectedHome = path.join(configDir, 'sidequest');
    assert.strictEqual(resolved.homeRoot, expectedHome, 'store.homeRoot() ignored CLAUDE_CONFIG_DIR');
    assert.ok(isInside(resolved.worktreeRoot, expectedHome), `worktree root ${resolved.worktreeRoot} is not under ${expectedHome}`);
    assert.ok(isInside(resolved.agentWorktree, expectedHome), `agent worktree ${resolved.agentWorktree} is not under ${expectedHome}`);
    assert.ok(!fs.existsSync(path.join(fakeHome, '.claude', 'sidequest')), 'resolution wrote under ~/.claude/sidequest');
  } finally {
    for (const directory of [fakeHome, configDir, project]) fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SQ-222: SIDEQUEST_HOME still outranks CLAUDE_CONFIG_DIR, and ~/.claude/sidequest remains the no-config default', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-222-home-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-222-config-'));
  const explicit = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-222-explicit-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-222-project-'));
  try {
    const pinned = probe({ SIDEQUEST_HOME: explicit, HOME: fakeHome, USERPROFILE: fakeHome, CLAUDE_CONFIG_DIR: configDir, SQ222_PROJECT: project });
    assert.strictEqual(pinned.homeRoot, explicit);
    assert.ok(isInside(pinned.worktreeRoot, explicit), `worktree root ${pinned.worktreeRoot} is not under ${explicit}`);

    const fallback = probe({ SIDEQUEST_HOME: undefined, HOME: fakeHome, USERPROFILE: fakeHome, CLAUDE_CONFIG_DIR: undefined, SQ222_PROJECT: project });
    assert.strictEqual(fallback.homeRoot, path.join(fakeHome, '.claude', 'sidequest'));
  } finally {
    for (const directory of [fakeHome, configDir, explicit, project]) fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SQ-222: the node-free function-hook resolver honors CLAUDE_CONFIG_DIR below SIDEQUEST_HOME', () => {
  assert.strictEqual(neutralSidequestHome('/pinned/sq/', '/home/u', '/home/u/.poindexter/claude'), '/pinned/sq');
  assert.strictEqual(neutralSidequestHome('', '/home/u', '/home/u/.poindexter/claude/'), '/home/u/.poindexter/claude/sidequest');
  assert.strictEqual(neutralSidequestHome(undefined, '/home/u', undefined), '/home/u/.claude/sidequest');
  assert.strictEqual(neutralSidequestHome(undefined, undefined, undefined), '');
});

test('SQ-222: no source site hardcodes ~/.claude/sidequest outside the shared resolver', () => {
  const sourceRoot = path.join(pluginRoot, 'src');
  const allowed = new Set([path.join('lib', 'claude-home.ts'), path.join('hooks', 'shared', 'live-refs.ts')]);
  const offenders: string[] = [];
  const pattern = /['"]\.claude['"]\s*,\s*['"]sidequest['"]|['"`][^'"`\n]*\/\.claude\/sidequest/;
  function walk(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts')) {
        const relative = path.relative(sourceRoot, full);
        if (allowed.has(relative)) continue;
        fs.readFileSync(full, 'utf8').split('\n').forEach((line, index) => {
          const code = line.replace(/\/\/.*$/, '');
          if (/^\s*\*/.test(code)) return;
          if (pattern.test(code)) offenders.push(`${relative}:${index + 1}`);
        });
      }
    }
  }
  walk(sourceRoot);
  assert.deepStrictEqual(offenders, [], `hardcoded ~/.claude/sidequest sites bypass CLAUDE_CONFIG_DIR: ${offenders.join(', ')}`);
});
