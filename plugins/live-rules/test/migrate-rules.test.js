'use strict';
/**
 * Tests for scripts/migrate-rules.js (SQ-292): moving rules out of the two
 * retired live-rules stores into .claude/rules/*.md.
 *
 * Run: node --test plugins/live-rules/test/migrate-rules.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const rules = require('../hooks/lib/rules.js');
const migrate = require('../scripts/migrate-rules.js');

const script = path.join(__dirname, '..', 'scripts', 'migrate-rules.js');

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-rules-migrate-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

function writeAtomic(projectDir, name, content) {
  const dir = path.join(projectDir, '.claude', 'live-rules', 'rules');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
  return path.join(dir, name);
}

function readRule(projectDir, name) {
  return fs.readFileSync(path.join(projectDir, '.claude', 'rules', name), 'utf8');
}

function exists(file) {
  return fs.existsSync(file);
}

function run(projectDir, args = []) {
  return execFileSync(process.execPath, [script, '--project', projectDir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LIVE_RULES_PATH: '' },
  });
}

/* ------------------------------------------------------------------ *
 *  The atomic store
 * ------------------------------------------------------------------ */

test('moves .claude/live-rules/rules/*.md into .claude/rules/ keeping the filename', () => {
  const dir = project();
  const source = writeAtomic(dir, 'react.md', '---\ndescription: React\npaths: ["**/*.tsx"]\n---\nUse function components.\n');

  const output = run(dir);
  assert.match(output, /migrated: .*live-rules\/rules\/react\.md -> \.claude\/rules\/react\.md/);
  assert.strictEqual(exists(source), false, 'the source file is removed once the move is verified');
  assert.deepStrictEqual(rules.loadRules(dir).map((rule) => rule.id), ['react.md']);
});

test('a file whose frontmatter is already native is copied byte-for-byte', () => {
  const dir = project();
  // Comments and formatting must survive: re-rendering frontmatter that needed
  // no change would reformat the user's file for nothing.
  const content = '---\ndescription: Keep me   # trailing comment\npaths: ["**/*.ts"]\n---\n\n- One.\n- Two.\n';
  writeAtomic(dir, 'keep.md', content);

  run(dir);
  assert.strictEqual(readRule(dir, 'keep.md'), content);
});

test('globs: and dirs: are rewritten to paths:, body verbatim', () => {
  const dir = project();
  writeAtomic(dir, 'old.md', '---\ndescription: Old keys\nglobs: ["src/**/*.js"]\ndirs: ["packages/api"]\n---\nBody line one.\n\nBody line two.\n');

  run(dir);
  const migrated = readRule(dir, 'old.md');
  assert.match(migrated, /^paths: \["src\/\*\*\/\*\.js","packages\/api"\]$/m, 'both retired keys fold into paths:');
  assert.doesNotMatch(migrated, /globs:|dirs:/);
  assert.match(migrated, /Body line one\./);
  assert.match(migrated, /Body line two\./);

  const loaded = rules.loadRules(dir);
  assert.deepStrictEqual(loaded[0].paths, ['src/**/*.js', 'packages/api']);
});

test('a nested rule file is flattened to its basename', () => {
  const dir = project();
  const nested = path.join(dir, '.claude', 'live-rules', 'rules', 'group');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'nested.md'), 'Nested rule.\n');

  run(dir);
  assert.deepStrictEqual(rules.loadRules(dir).map((rule) => rule.id), ['nested.md']);
});

test('the manifest is removed', () => {
  const dir = project();
  writeAtomic(dir, 'a.md', 'Rule A.\n');
  const manifest = path.join(dir, '.claude', 'live-rules', 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ schema: 1, rules: [{ path: 'rules/a.md' }] }) + '\n');

  const output = run(dir);
  assert.strictEqual(exists(manifest), false);
  assert.match(output, /removed: .*manifest\.json/);
});

/* ------------------------------------------------------------------ *
 *  The legacy monolith
 * ------------------------------------------------------------------ */

test('the legacy monolith becomes one file per rule, in order', () => {
  const dir = project();
  const monolith = path.join(dir, '.claude', 'live-rules.md');
  fs.writeFileSync(monolith, [
    '---',
    'description: SQL Conventions',
    'globs: ["**/*.sql"]',
    '---',
    'Use lowercase keywords.',
    '---',
    'description: Commit Style',
    'prompt: ["commit"]',
    '---',
    'Imperative mood.',
  ].join('\n') + '\n');

  const output = run(dir);
  assert.match(output, /001-sql-conventions\.md/);
  assert.match(output, /002-commit-style\.md/);
  assert.strictEqual(exists(monolith), false);

  const loaded = rules.loadRules(dir);
  assert.deepStrictEqual(loaded.map((rule) => rule.id), ['001-sql-conventions.md', '002-commit-style.md']);
  assert.deepStrictEqual(loaded[0].paths, ['**/*.sql'], 'globs: became paths:');
  assert.strictEqual(loaded[0].body, 'Use lowercase keywords.');
  assert.deepStrictEqual(loaded[1].prompts, ['commit']);
});

test('a monolith rule with no description gets a numbered fallback name', () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, '.claude', 'live-rules.md'), 'Write code as poetry.\n');

  run(dir);
  assert.deepStrictEqual(rules.loadRules(dir).map((rule) => rule.id), ['001-rule.md']);
  assert.strictEqual(rules.loadRules(dir)[0].body, 'Write code as poetry.');
});

test('both stores migrate in one pass', () => {
  const dir = project();
  writeAtomic(dir, 'atomic.md', 'Atomic rule.\n');
  fs.writeFileSync(path.join(dir, '.claude', 'live-rules.md'), '---\ndescription: Legacy One\n---\nLegacy body.\n');

  run(dir);
  assert.deepStrictEqual(rules.loadRules(dir).map((rule) => rule.id), ['001-legacy-one.md', 'atomic.md']);
});

/* ------------------------------------------------------------------ *
 *  Idempotence and collisions
 * ------------------------------------------------------------------ */

test('running twice is a no-op the second time', () => {
  const dir = project();
  writeAtomic(dir, 'a.md', '---\nglobs: ["*.ts"]\n---\nRule A.\n');
  fs.writeFileSync(path.join(dir, '.claude', 'live-rules.md'), '---\ndescription: Legacy\n---\nLegacy body.\n');

  run(dir);
  const after = rules.loadRules(dir).map((rule) => ({ id: rule.id, hash: rule.hash }));

  const second = run(dir);
  assert.match(second, /nothing to migrate/);
  assert.deepStrictEqual(rules.loadRules(dir).map((rule) => ({ id: rule.id, hash: rule.hash })), after);
});

test('a destination that already holds identical content is skipped, not rewritten', () => {
  const dir = project();
  const content = 'Shared rule.\n';
  writeAtomic(dir, 'same.md', content);
  fs.mkdirSync(path.join(dir, '.claude', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'rules', 'same.md'), content);

  const output = run(dir);
  assert.match(output, /already migrated: .*same\.md/);
  assert.strictEqual(readRule(dir, 'same.md'), content);
  assert.strictEqual(exists(path.join(dir, '.claude', 'live-rules', 'rules', 'same.md')), false);
});

test('refuses when a destination exists with different content, and writes nothing', () => {
  const dir = project();
  const source = writeAtomic(dir, 'clash.md', 'From the old store.\n');
  fs.mkdirSync(path.join(dir, '.claude', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'rules', 'clash.md'), 'Already here, different.\n');

  assert.throws(() => run(dir), /name collision/);
  assert.strictEqual(readRule(dir, 'clash.md'), 'Already here, different.\n', 'the existing file is untouched');
  assert.strictEqual(exists(source), true, 'the source is left in place for the user to resolve');
});

test('refuses when two sources would land on the same filename', () => {
  const dir = project();
  writeAtomic(dir, 'dup.md', 'Top level.\n');
  const nested = path.join(dir, '.claude', 'live-rules', 'rules', 'group');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'dup.md'), 'Nested, different body.\n');

  assert.throws(() => run(dir), /name collision/);
  assert.strictEqual(exists(path.join(dir, '.claude', 'rules', 'dup.md')), false, 'nothing is written on a refusal');
});

test('--dry-run reports the plan and changes nothing', () => {
  const dir = project();
  const source = writeAtomic(dir, 'a.md', 'Rule A.\n');

  const output = run(dir, ['--dry-run']);
  assert.match(output, /would migrate: .*a\.md -> \.claude\/rules\/a\.md/);
  assert.strictEqual(exists(source), true);
  assert.strictEqual(exists(path.join(dir, '.claude', 'rules', 'a.md')), false);
});

/* ------------------------------------------------------------------ *
 *  .gitignore
 * ------------------------------------------------------------------ */

test('appends the local-rule ignore entry when absent', () => {
  const dir = project();
  writeAtomic(dir, 'a.md', 'Rule A.\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');

  const output = run(dir);
  const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.match(gitignore, /^\.claude\/rules\/\*\.local\.md$/m);
  assert.match(gitignore, /^node_modules\/$/m, 'existing entries survive');
  assert.match(output, /added \.claude\/rules\/\*\.local\.md to \.gitignore/);
});

test('does not duplicate the ignore entry on a second run', () => {
  const dir = project();
  writeAtomic(dir, 'a.md', 'Rule A.\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), migrate.GITIGNORE_ENTRY + '\n');

  run(dir);
  const lines = fs
    .readFileSync(path.join(dir, '.gitignore'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() === migrate.GITIGNORE_ENTRY);
  assert.strictEqual(lines.length, 1);
});

test('a project with no .gitignore does not get one invented', () => {
  const dir = project();
  writeAtomic(dir, 'a.md', 'Rule A.\n');

  run(dir);
  assert.strictEqual(exists(path.join(dir, '.gitignore')), false);
});

/* ------------------------------------------------------------------ *
 *  Nothing to do
 * ------------------------------------------------------------------ */

test('a project with no retired store reports nothing to migrate and exits 0', () => {
  const dir = project();
  const output = run(dir);
  assert.match(output, /nothing to migrate/);
});

test('the migration lock makes a concurrent run back off instead of racing', () => {
  const dir = project();
  writeAtomic(dir, 'a.md', 'Rule A.\n');
  const lock = path.join(dir, '.claude', 'rules-migration.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() }) + '\n');

  const result = migrate.migrateProject(dir, {});
  assert.deepStrictEqual(result.errors, ['another live-rules migration is already running']);
  assert.strictEqual(exists(path.join(dir, '.claude', 'rules', 'a.md')), false);
});
