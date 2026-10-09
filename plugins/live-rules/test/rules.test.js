'use strict';
/**
 * Tests for the live-rules shared hook library (SQ-123).
 *
 * Covers parseYamlSubset (tested indirectly via splitSections, since it's an
 * internal helper not on module.exports), globToRegExp, compilePromptPattern,
 * splitSections, and selectForPrompt/selectAlways. Every case here asserts
 * behavior actually observed by running the code first (see plugins/live-rules
 * git history / ticket SQ-123 comments for cases that were deliberately left
 * out because the observed behavior looked unintended).
 *
 * Run: node --test plugins/live-rules/test/rules.test.js
 * (the directory form of `node --test` is broken on this Node v22/Windows setup)
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const rules = require('../hooks/lib/rules.js');

// parseYamlSubset has no direct export; splitSections is the public surface
// that runs frontmatter text through it and hands back the parsed `data`.
// Wrapping a single key:value block in fences gets us its `data` object.
function parseFrontmatterData(fmText) {
  const src = '---\n' + fmText + '\n---\nbody\n';
  const secs = rules.splitSections(src);
  return secs[0].data;
}

const root = path.resolve(__dirname, '..');
const promptHook = path.join(root, 'hooks', 'inject-prompt-rules.js');
const editHook = path.join(root, 'hooks', 'inject-edit-rules.js');

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-rules-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

function writeRule(projectDir, data = { description: 'Always' }, name = 'rule.md') {
  const body = 'Project rule.';
  const frontmatter = Object.entries(data)
    .map(([key, value]) => key + ': ' + (Array.isArray(value) ? JSON.stringify(value) : value))
    .join('\n');
  rules.seedRuleSet(projectDir, [{ name, content: '---\n' + frontmatter + '\n---\n' + body + '\n' }]);
}

function runHook(script, projectDir, stateDir, data) {
  return execFileSync(process.execPath, [script], {
    cwd: projectDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, LIVE_RULES_STATE_DIR: stateDir },
    input: JSON.stringify({ cwd: projectDir, ...data }),
    encoding: 'utf8',
  });
}

/* ------------------------------------------------------------------ *
 *  parseYamlSubset (via splitSections)
 * ------------------------------------------------------------------ */

test('parseYamlSubset: plain key:value scalar', () => {
  const data = parseFrontmatterData('description: hello world');
  assert.strictEqual(data.description, 'hello world');
});

test('parseYamlSubset: double-quoted value containing a colon keeps the colon literal', () => {
  const data = parseFrontmatterData('description: "foo: bar"');
  assert.strictEqual(data.description, 'foo: bar');
});

test('parseYamlSubset: single-quoted value containing a colon keeps the colon literal', () => {
  const data = parseFrontmatterData("description: 'foo: bar'");
  assert.strictEqual(data.description, 'foo: bar');
});

test('parseYamlSubset: booleans parse to real JS booleans', () => {
  const data = parseFrontmatterData('enabled: true\ndisabled: false');
  assert.strictEqual(data.enabled, true);
  assert.strictEqual(data.disabled, false);
});

test('parseYamlSubset: null/tilde parse to null', () => {
  const data = parseFrontmatterData('foo: null\nbar: ~');
  assert.strictEqual(data.foo, null);
  assert.strictEqual(data.bar, null);
});

test('parseYamlSubset: bare integer parses to a number', () => {
  const data = parseFrontmatterData('priority: 10');
  assert.strictEqual(data.priority, 10);
});

test('parseYamlSubset: inline array syntax [a, b]', () => {
  const data = parseFrontmatterData('globs: [a.js, b.js]');
  assert.deepStrictEqual(data.globs, ['a.js', 'b.js']);
});

test('parseYamlSubset: inline array preserves brace-expansion commas as one element', () => {
  const data = parseFrontmatterData('globs: ["**/*.{ts,tsx}"]');
  assert.deepStrictEqual(data.globs, ['**/*.{ts,tsx}']);
});

test('parseYamlSubset: block array syntax (indented "- item" lines)', () => {
  const data = parseFrontmatterData('dirs:\n  - packages/api\n  - packages/web');
  assert.deepStrictEqual(data.dirs, ['packages/api', 'packages/web']);
});

test('parseYamlSubset: a malformed line (no "key:" shape) is ignored, not thrown', () => {
  assert.doesNotThrow(() => {
    const data = parseFrontmatterData('not a valid line at all\ndescription: ok');
    assert.strictEqual(data.description, 'ok');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(data, 'not a valid line at all'), false);
  });
});

/* ------------------------------------------------------------------ *
 *  globToRegExp
 * ------------------------------------------------------------------ */

test('globToRegExp: "**" matches any depth, including zero directories', () => {
  const re = rules.globToRegExp('**/*.tsx');
  assert.ok(re.test('a.tsx'), 'zero directories should match');
  assert.ok(re.test('x/y/a.tsx'), 'nested directories should match');
});

test('globToRegExp: a single "*" stays within one path segment', () => {
  const re = rules.globToRegExp('src/*.js');
  assert.ok(re.test('src/a.js'));
  assert.strictEqual(re.test('src/a/b.js'), false, '* must not cross a "/"');
});

test('globToRegExp: "?" matches exactly one non-slash character', () => {
  const re = rules.globToRegExp('a?.js');
  assert.ok(re.test('ab.js'));
  assert.strictEqual(re.test('a.js'), false, '? requires exactly one character, not zero');
  assert.strictEqual(re.test('a/.js'), false, '? must not match a path separator');
});

test('globToRegExp: literal "." is escaped, so "a.b" does not match "aXb"', () => {
  const re = rules.globToRegExp('a.b');
  assert.strictEqual(re.test('aXb'), false);
  assert.ok(re.test('a.b'));
});

test('globToRegExp: a pattern containing "/" is anchored to the full relative path', () => {
  const re = rules.globToRegExp('src/*.js');
  assert.strictEqual(re.test('notsrc/x.js'), false);
  assert.strictEqual(re.test('deep/src/x.js'), false, 'a "/"-bearing pattern is not basename-matched at depth');
});

test('globToRegExp: a trailing "/**" also matches the bare prefix itself', () => {
  const re = rules.globToRegExp('a/b/**');
  assert.ok(re.test('a/b'), 'bare "a/b" should match per the "zero directories" rule');
  assert.ok(re.test('a/b/c'));
  assert.strictEqual(re.test('a/bc'), false, 'must not match a sibling that merely shares the prefix text');
});

test('globToRegExp: backslashes in the glob are normalized to forward slashes', () => {
  const re = rules.globToRegExp('src\\*.js');
  assert.ok(re.test('src/a.js'), 'a Windows-style backslash glob should still match a forward-slash path');
});

test('globToRegExp: brace expansion "{a,b}" compiles to an alternation', () => {
  const re = rules.globToRegExp('**/*.{ts,tsx}');
  assert.ok(re.test('x/a.tsx'));
  assert.ok(re.test('a.ts'));
  assert.strictEqual(re.test('x/a.js'), false);
});

/* ------------------------------------------------------------------ *
 *  compilePromptPattern
 * ------------------------------------------------------------------ */

test('compilePromptPattern: a plain literal (no slashes) is not treated as regex syntax', () => {
  assert.strictEqual(rules.compilePromptPattern('deploy'), null);
});

test('compilePromptPattern: "/pattern/i" compiles to a case-insensitive RegExp', () => {
  const re = rules.compilePromptPattern('/deploy/i');
  assert.ok(re instanceof RegExp);
  assert.ok(re.test('DEPLOY'));
  assert.ok(re.test('deploy'));
});

test('compilePromptPattern: "/pattern/" with no flags is case-sensitive', () => {
  const re = rules.compilePromptPattern('/deploy/');
  assert.ok(re instanceof RegExp);
  assert.strictEqual(re.test('DEPLOY'), false);
  assert.ok(re.test('deploy'));
});

test('compilePromptPattern: an invalid regex body fails soft to null, not a throw', () => {
  assert.doesNotThrow(() => {
    assert.strictEqual(rules.compilePromptPattern('/[/i'), null);
    assert.strictEqual(rules.compilePromptPattern('/(unclosed/'), null);
  });
});

/* ------------------------------------------------------------------ *
 *  splitSections
 * ------------------------------------------------------------------ */

test('splitSections: a multi-rule file parses into one section per fenced rule', () => {
  const text = [
    '---',
    'description: Rule One',
    'globs: ["*.tsx"]',
    '---',
    'Body one.',
    '---',
    'description: Rule Two',
    'dirs: ["packages/api"]',
    '---',
    'Body two.',
  ].join('\n');
  const secs = rules.splitSections(text);
  assert.strictEqual(secs.length, 2);
  assert.strictEqual(secs[0].data.description, 'Rule One');
  assert.strictEqual(secs[0].body, 'Body one.');
  assert.strictEqual(secs[1].data.description, 'Rule Two');
  assert.strictEqual(secs[1].body, 'Body two.');
});

test('splitSections: garbage frontmatter in one section does not throw and does not corrupt sibling sections', () => {
  // NOTE: garbage frontmatter does NOT remove/skip the section (it still shows
  // up in the returned array, just with an empty `data: {}` since none of its
  // lines match the "key: value" shape). Observed behavior, asserted as-is.
  const text = [
    '---',
    '@@@ not yaml at all ###',
    '???',
    '---',
    'Body for garbage section.',
    '---',
    'description: Good Rule',
    '---',
    'Body for good section.',
  ].join('\n');
  let secs;
  assert.doesNotThrow(() => {
    secs = rules.splitSections(text);
  });
  assert.strictEqual(secs.length, 2);
  assert.deepStrictEqual(secs[0].data, {});
  assert.strictEqual(secs[0].body, 'Body for garbage section.');
  assert.strictEqual(secs[1].data.description, 'Good Rule');
});

test('splitSections: a file with fewer than two fences falls back to one whole-file rule', () => {
  const secs = rules.splitSections('Just write code as poetry.');
  assert.strictEqual(secs.length, 1);
  assert.deepStrictEqual(secs[0].data, {});
  assert.strictEqual(secs[0].body, 'Just write code as poetry.');
});

test('splitSections: a blank/whitespace-only file yields no rules', () => {
  assert.deepStrictEqual(rules.splitSections('   \n  \n'), []);
});

/* ------------------------------------------------------------------ *
 *  selectForPrompt / selectAlways
 * ------------------------------------------------------------------ */

test('selectForPrompt: an always-on rule (no scope fields) is always selected', () => {
  const alwaysRule = rules.buildRule('always.md', { description: 'Always Rule' }, 'Body always.');
  assert.ok(rules.isAlways(alwaysRule));
  const sel = rules.selectForPrompt([alwaysRule], { promptText: 'anything at all', cwdRel: null });
  assert.strictEqual(sel.length, 1);
  assert.strictEqual(sel[0].rule.id, 'always.md');
  assert.strictEqual(sel[0].label, 'always');
});

test('selectForPrompt: a prompt-keyword rule selects only when its pattern matches the prompt text', () => {
  const promptRule = rules.buildRule('prompt.md', { description: 'Prompt Rule', prompt: ['deploy'] }, 'Body.');
  const matching = rules.selectForPrompt([promptRule], { promptText: 'please deploy now', cwdRel: null });
  assert.strictEqual(matching.length, 1);
  assert.strictEqual(matching[0].label, 'prompt:deploy');

  const nonMatching = rules.selectForPrompt([promptRule], { promptText: 'hello world', cwdRel: null });
  assert.strictEqual(nonMatching.length, 0);
});

test('selectForPrompt: a directory-style paths rule selects only when cwdRel is inside that directory', () => {
  const dirRule = rules.buildRule('dir.md', { description: 'Dir Rule', paths: ['packages/api'] }, 'Body.');
  const inside = rules.selectForPrompt([dirRule], { promptText: 'hello', cwdRel: 'packages/api/src' });
  assert.strictEqual(inside.length, 1);
  assert.strictEqual(inside[0].label, 'cwd:packages/api');

  const outside = rules.selectForPrompt([dirRule], { promptText: 'hello', cwdRel: 'packages/web' });
  assert.strictEqual(outside.length, 0);
});

test('selectForPrompt: a wildcard paths rule never selects on cwd alone', () => {
  // Collapsing the retired `dirs:` key into `paths:` must not widen what the
  // prompt hook emits: a file pattern stays a file pattern.
  const fileRule = rules.buildRule('files.md', { paths: ['packages/api/**/*.ts'] }, 'Body.');
  const sel = rules.selectForPrompt([fileRule], { promptText: 'hello', cwdRel: 'packages/api/src' });
  assert.strictEqual(sel.length, 0);
});

test('buildRule: the retired dirs:/globs: keys fold into paths:', () => {
  const fromDirs = rules.buildRule('a.md', { dirs: ['packages/api'] }, 'Body.');
  assert.deepStrictEqual(fromDirs.paths, ['packages/api']);

  const fromGlobs = rules.buildRule('b.md', { globs: ['src/**/*.js'] }, 'Body.');
  assert.deepStrictEqual(fromGlobs.paths, ['src/**/*.js']);

  // A file carrying both keys keeps both scopes rather than losing one.
  const both = rules.buildRule('c.md', { paths: ['a.ts'], globs: ['b.js'], dirs: ['pkg'] }, 'Body.');
  assert.deepStrictEqual(both.paths, ['a.ts', 'b.js', 'pkg']);
});

test('buildRule: enabled: false is ignored, because disabling is a rename to .md.off', () => {
  // Native Claude Code ignores unknown frontmatter keys, so a rule "disabled"
  // in frontmatter would still load natively. Honoring it here would have
  // live-rules silently disagree with what the model was already given.
  const rule = rules.buildRule('disabled.md', { description: 'Disabled', enabled: false }, 'Body.');
  assert.ok(rules.isAlways(rule));
  const sel = rules.selectForPrompt([rule], { promptText: 'anything', cwdRel: null });
  assert.strictEqual(sel.length, 1);
  assert.strictEqual(rules.selectAlways([rule]).length, 1);
});

test('selectAlways: returns only always-on rules', () => {
  const alwaysRule = rules.buildRule('always.md', { description: 'Always Rule' }, 'Body.');
  const promptRule = rules.buildRule('prompt.md', { description: 'Prompt Rule', prompt: ['deploy'] }, 'Body.');
  const pathRule = rules.buildRule('paths.md', { description: 'Path Rule', paths: ['*.ts'] }, 'Body.');

  const sel = rules.selectAlways([alwaysRule, promptRule, pathRule]);
  assert.strictEqual(sel.length, 1);
  assert.strictEqual(sel[0].rule.id, 'always.md');
});

/* ------------------------------------------------------------------ *
 *  Storage: .claude/rules/*.md (SQ-292)
 * ------------------------------------------------------------------ */

test('rules report .claude/rules as their source', () => {
  const dir = project();
  writeRule(dir);
  const output = runHook(promptHook, dir, path.join(dir, 'state'), { session_id: 'prompt', prompt: 'hello' });
  assert.match(output, /Source: \.claude\/rules/);

  const editDir = project();
  writeRule(editDir, { description: 'Edit', paths: ['src/**/*.js'] });
  const editOutput = runHook(editHook, editDir, path.join(editDir, 'state'), { session_id: 'edit', tool_input: { file_path: 'src/a.js' } });
  assert.match(editOutput, /Source: \.claude\/rules/);
});

test('loadRules: only *.md is read, so a .md.off rename disables a rule', () => {
  const dir = project();
  const rulesDir = path.join(dir, '.claude', 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(path.join(rulesDir, 'on.md'), 'Active rule.\n');
  fs.writeFileSync(path.join(rulesDir, 'off.md.off'), 'Disabled rule.\n');

  const loaded = rules.loadRules(dir);
  assert.deepStrictEqual(loaded.map((rule) => rule.id), ['on.md']);
});

test('loadRules: a .local.md file is a rule like any other', () => {
  const dir = project();
  const rulesDir = path.join(dir, '.claude', 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(path.join(rulesDir, 'personal.local.md'), 'Personal rule.\n');

  const loaded = rules.loadRules(dir);
  assert.deepStrictEqual(loaded.map((rule) => rule.id), ['personal.local.md']);
  assert.strictEqual(loaded[0].body, 'Personal rule.');
});

test('loadRules: content hashes are computed from the file, so an edit changes the hash', () => {
  const dir = project();
  const file = path.join(dir, '.claude', 'rules', 'a.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'First body.\n');
  const first = rules.loadRules(dir)[0].hash;

  fs.writeFileSync(file, 'Second body.\n');
  const second = rules.loadRules(dir)[0].hash;
  assert.notStrictEqual(first, second);
  assert.strictEqual(rules.loadRules(dir)[0].hash, second, 'a re-read of unchanged content is stable');
});

test('parseRuleFile: a bare "---" in the body is body text, not a second rule', () => {
  // The retired monolith split on every fence, so a horizontal rule silently
  // truncated a rule. One rule per file removes that trap.
  const parsed = rules.parseRuleFile('---\ndescription: One\n---\nIntro.\n\n---\n\nMore body.\n');
  assert.strictEqual(parsed.data.description, 'One');
  assert.match(parsed.body, /Intro\./);
  assert.match(parsed.body, /More body\./);
});

test('parseRuleFile: a file with no frontmatter is one rule whose body is the whole file', () => {
  const parsed = rules.parseRuleFile('Write code as poetry.\n');
  assert.deepStrictEqual(parsed.data, {});
  assert.match(parsed.body, /Write code as poetry\./);
});

test('loadRuleSet: a project whose rules are still in a retired store gets a migration notice', () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, '.claude', 'live-rules', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'live-rules', 'rules', 'old.md'), 'Old rule.\n');

  const ruleSet = rules.loadRuleSet(dir);
  assert.strictEqual(ruleSet.rules.length, 0, 'a retired store is not read');
  assert.match(ruleSet.notice, /now reads \.claude\/rules\/\*\.md/);
  assert.match(ruleSet.notice, /migrate-rules\.js/);
});

test('loadRuleSet: the notice also fires for a half-migrated project', () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, '.claude', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'rules', 'new.md'), 'New rule.\n');
  fs.mkdirSync(path.join(dir, '.claude', 'live-rules', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'live-rules', 'rules', 'left-behind.md'), 'Left behind.\n');

  const ruleSet = rules.loadRuleSet(dir);
  assert.strictEqual(ruleSet.rules.length, 1);
  assert.match(ruleSet.notice, /are NOT in effect/);
});

test('loadRuleSet: an empty retired directory stays silent', () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, '.claude', 'live-rules', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'rules', 'new.md'), 'New rule.\n');

  assert.strictEqual(rules.loadRuleSet(dir).notice, '');
});

test('the prompt hook is silent for a project with no rules at all', () => {
  const dir = project();
  const output = runHook(promptHook, dir, path.join(dir, 'state'), { session_id: 'empty', prompt: 'hello' });
  assert.strictEqual(output, '');
});

test('seedRuleSet refuses to overwrite a project that already holds rule files', () => {
  const dir = project();
  writeRule(dir);
  assert.throws(
    () => rules.seedRuleSet(dir, [{ name: 'other.md', content: 'Another rule.\n' }]),
    /already exists/
  );
});
