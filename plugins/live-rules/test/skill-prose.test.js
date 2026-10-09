'use strict';
/**
 * Skill prose contract (SQ-295).
 *
 * The skills are agent-facing: an executor acts on what `add-rule` and
 * `manage-rules` say, immediately, without reading the hooks. So the text is a
 * contract with the shipped code, and drift costs a dispatch every time it is
 * hit. These tests pin the three things that can drift silently:
 *
 *   1. the retired store is never named. `.claude/live-rules/rules/`, a rule
 *      `manifest.json`, and `sync-atomic-rules.js` are all gone (SQ-292), so a
 *      skill still telling an agent to write there or run that script would
 *      send it to a path that does not exist.
 *   2. the never-match sentinel is quoted EXACTLY as the hook library exports
 *      it. `add-rule` writes this string into rule files and nobody types it
 *      from memory, so a typo in the prose is a keyword rule that Claude Code
 *      loads globally instead.
 *   3. the three-way destination routing and disable-by-rename survive. Both
 *      are decisions (story US-6 log #1, contract "Routing"), not phrasing.
 *
 * Run: node --test plugins/live-rules/test/skill-prose.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const PLUGIN_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(PLUGIN_ROOT, '..', '..');
const SKILLS_DIR = path.join(PLUGIN_ROOT, 'skills');

const rules = require(path.join(PLUGIN_ROOT, 'hooks', 'lib', 'rules.js'));

function read(...parts) {
  return fs.readFileSync(path.join(...parts), 'utf8');
}

function readSkill(name) {
  return read(SKILLS_DIR, name, 'SKILL.md');
}

function readReference(skill, name) {
  return read(SKILLS_DIR, skill, 'references', name + '.md');
}

/** Every Markdown file under skills/, as [plugin-relative path, contents] pairs. */
function allSkillProse(dir = SKILLS_DIR, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) allSkillProse(full, out);
    else if (entry.name.endsWith('.md')) {
      out.push([path.relative(PLUGIN_ROOT, full).replace(/\\/g, '/'), fs.readFileSync(full, 'utf8')]);
    }
  }
  return out;
}

const flat = (text) => text.replace(/\s+/g, ' ');

test('skill prose never names the retired rule store, its manifest, or its sync script', () => {
  const prose = allSkillProse();
  assert.ok(prose.length >= 3, 'found the skill markdown files');

  for (const [file, text] of prose) {
    assert.doesNotMatch(text, /live-rules\/rules/, `${file} must not name the retired rule store`);
    assert.doesNotMatch(text, /manifest\.json/, `${file} must not name a rule manifest`);
    assert.doesNotMatch(text, /sync-atomic-rules/, `${file} must not name the deleted sync script`);
    // A rule file is written from this prose, so a retired scope key at the
    // start of a line is a frontmatter example an agent would copy.
    assert.doesNotMatch(text, /^(?:globs|dirs):/m, `${file} must use the native paths: scope key in examples`);
    assert.doesNotMatch(text, /^enabled:/m, `${file} must not show an enabled: key; disabling is a rename`);
  }
});

test('every skill file that names the rule store names the native directory', () => {
  for (const [file, text] of allSkillProse()) {
    assert.match(text, /\.claude\/rules\//, `${file} names .claude/rules/ as the store`);
  }
});

test('add-rule quotes the never-match sentinel exactly as the hooks export it', () => {
  const sentinel = rules.NEVER_MATCH_PATH;
  assert.equal(sentinel, '.live-rules-never-match/**', 'sentinel value is the one SQ-293 pinned');

  const skill = readSkill('add-rule');
  const format = readReference('add-rule', 'rule-format');
  const examples = readReference('add-rule', 'example-rules');

  for (const [label, text] of [['SKILL.md', skill], ['rule-format.md', format], ['example-rules.md', examples]]) {
    assert.ok(text.includes(sentinel), `add-rule ${label} quotes the exported sentinel verbatim`);
  }

  // The reason, not just the string: without a paths: scope native loads the
  // file globally, which is exactly what a keyword rule must not do.
  assert.match(flat(skill), /no real path scope must carry this exact value/);
  assert.match(flat(skill), /loads it as a global rule/);
  assert.match(flat(skill), /do not invent\s*a? ?variant|Write it verbatim/i);

  // Every keyword example carries it, or an agent copies a broken rule.
  const keywordBlocks = examples
    .split(/^```markdown$/m)
    .slice(1)
    .map((block) => block.split(/^```$/m)[0])
    .filter((block) => /^prompt:/m.test(block));
  assert.ok(keywordBlocks.length >= 2, 'example-rules keeps keyword examples');
  for (const block of keywordBlocks) {
    const hasRealPaths = /^paths:/m.test(block) && !block.includes(sentinel);
    assert.ok(
      block.includes(sentinel) || hasRealPaths,
      'a prompt: example either carries the sentinel or a real paths: scope'
    );
  }
});

test('add-rule routes a rule by who it is true for, across all three layers', () => {
  const skill = readSkill('add-rule');
  const format = readReference('add-rule', 'rule-format');

  for (const [label, text] of [['SKILL.md', skill], ['rule-format.md', format]]) {
    assert.match(text, /`\.claude\/rules\/<name>\.md`/, `${label} names the committed project rule`);
    assert.match(text, /`\.claude\/rules\/<name>\.local\.md`/, `${label} names the local project rule`);
    assert.match(text, /`~\/\.claude\/rules\/<name>\.md`/, `${label} names the user's own rule file`);
  }

  // The question is asked, and it is about the rule, not about what is installed.
  assert.match(flat(skill), /ask one short question when the answer is not\s*obvious/i);
  assert.match(flat(skill), /who the rule is true for/);

  // Style and cross-project habits are never project rules, and the skill says where they go.
  for (const [label, text] of [['SKILL.md', skill], ['rule-format.md', format]]) {
    assert.match(
      flat(text),
      /[Rr]esponse (?:format and length|style)[^.]*voice, tone,\s*punctuation, and cross-project workflow/,
      `${label} names the personal-everywhere categories`
    );
    assert.match(text, /never project rules/, `${label} says they are never project rules`);
  }
  assert.match(flat(skill), /never write\s*them into the repo/);

  // live-rules owns no personal store; it must not promise to write one.
  assert.match(skill, /never writes or reads `~\/\.claude\/rules\/`/);

  // A .local.md destination is only safe with the ignore line.
  assert.match(flat(skill), /`\.claude\/rules\/\*\.local\.md` line in `\.gitignore`/);
  assert.match(flat(skill), /Promoting it later is a rename to\s*`<name>\.md`/);
});

test('manage-rules inspects the files directly and toggles by rename', () => {
  const skill = readSkill('manage-rules');

  // Inspection is a directory read; there is no generated artifact to reconcile.
  assert.match(flat(skill), /no manifest, no index, and no\s*sync step/);
  assert.match(flat(skill), /List `\.claude\/rules\/` and read every top-level `\*\.md` file/);

  // Disable, enable, promote: three renames, spelled out.
  assert.match(skill, /`<name>\.md`\s*->\s*\.claude\/rules\/<name>\.md\.off|<name>\.md\.off/);
  assert.match(flat(skill), /Disabling is a rename, not a frontmatter edit/);
  assert.match(flat(skill), /enable:\s*\.claude\/rules\/<name>\.md\.off\s*->\s*\.claude\/rules\/<name>\.md/);
  assert.match(flat(skill), /\.claude\/rules\/<name>\.local\.md\s*->\s*\.claude\/rules\/<name>\.md/);
  assert.match(flat(skill), /Never write `enabled: false` into frontmatter/);

  // Manifest recovery was the old audit's first move. The concept has to be
  // gone, not just the filename: there is no generated artifact to rebuild, so
  // "recovery problem", "stale manifest" and "run sync" are all dead advice.
  assert.doesNotMatch(skill, /recovery problem|recover manifest|stale (?:atomic )?manifest|run sync/i);

  // It still has to flag the one keyword-rule mistake that silently misfires.
  assert.ok(skill.includes(rules.NEVER_MATCH_PATH), 'audit names the sentinel it checks for');
});

test('skills describe native-first cadence, not injection on every match', () => {
  const texts = [
    ['add-rule/SKILL.md', readSkill('add-rule')],
    ['add-rule/references/rule-format.md', readReference('add-rule', 'rule-format')],
    ['manage-rules/SKILL.md', readSkill('manage-rules')],
  ];

  for (const [label, text] of texts) {
    // Native loads it; live-rules adds timing. Both halves must be present.
    assert.match(text, /natively|Claude Code loads/, `${label} credits native loading`);
    assert.match(flat(text), /content hash (?:has )?chang|re-?ground/i, `${label} explains change-triggered re-grounding`);
  }

  // reground: is documented with its real cadence, and as off by default.
  const format = readReference('add-rule', 'rule-format');
  assert.match(format, /`reground`/);
  assert.match(flat(format), /once every 20 user prompts/);
  assert.match(flat(format), /Off by default/i);
  assert.match(flat(readSkill('add-rule')), /reground: true\s+# optional; re-say this rule every 20 prompts/);

  // Subagent reach differs by carrier, which changes what an agent can rely on.
  for (const [label, text] of [['add-rule/SKILL.md', readSkill('add-rule')], ['add-rule/references/rule-format.md', format]]) {
    assert.match(flat(text), /subagent/i, `${label} says what reaches subagents`);
  }
  assert.match(flat(format), /does not reach subagents/);
});

test('README and marketplace description name native storage and no manifest', () => {
  const readme = read(PLUGIN_ROOT, 'README.md');
  assert.doesNotMatch(readme, /live-rules\/rules/);
  assert.doesNotMatch(readme, /manifest\.json/);
  assert.doesNotMatch(readme, /sync-atomic-rules/);
  assert.match(readme, /`\.claude\/rules\/`/);
  assert.match(flat(readme), /No manifest, no index, and no sync step|no manifest, no index, and no sync step/);
  assert.match(flat(readme), /owns no storage/i);
  assert.ok(readme.includes(rules.NEVER_MATCH_PATH), 'README quotes the sentinel verbatim');
  assert.match(readme, /`<name>\.md\.off`/);

  const marketplace = JSON.parse(read(REPO_ROOT, '.claude-plugin', 'marketplace.json'));
  const entry = marketplace.plugins.find((plugin) => plugin.name === 'live-rules');
  assert.ok(entry, 'marketplace lists live-rules');
  assert.doesNotMatch(entry.description, /live-rules\/rules/);
  assert.doesNotMatch(entry.description, /generated manifest|Atomic project rules/);
  assert.match(entry.description, /\.claude\/rules/);
  assert.match(entry.description, /No manifest and no sync step/);
});

test('the getting-started page teaches the three layers, rename-to-disable, and migration', () => {
  const page = read(REPO_ROOT, 'docs', 'src', 'content', 'docs', 'getting-started', 'live-rules.md');

  assert.doesNotMatch(page, /live-rules\/rules/);
  assert.doesNotMatch(page, /sync-atomic-rules/);
  // The retired store is named once, in the migration section, and only there.
  assert.match(page, /## Migrating an older project/);

  for (const destination of [
    /`\.claude\/rules\/<name>\.md`/,
    /`\.claude\/rules\/<name>\.local\.md`/,
    /`~\/\.claude\/rules\/<name>\.md`/,
  ]) {
    assert.match(page, destination, 'page documents all three rule layers');
  }
  assert.match(flat(page), /who the rule is true for/);
  assert.match(flat(page), /`\.claude\/rules\/\*\.local\.md` line in `\.gitignore`/);

  // Disable is a rename, with the real command and the reason the old key is gone.
  assert.match(page, /mv \.claude\/rules\/[\w-]+\.md \.claude\/rules\/[\w-]+\.md\.off/);
  assert.match(flat(page), /There is no `enabled:` frontmatter key/);

  // Migration command, as an agent or a reader would run it.
  assert.match(page, /migrate-rules\.js --project \. --dry-run/);

  // Native loading reaches subagents; keyword re-grounding does not.
  assert.match(flat(page), /Both reach subagents that way/);
  assert.match(flat(page), /keyword rules do \*\*not\*\* reach subagents/i);
  assert.ok(page.includes(rules.NEVER_MATCH_PATH), 'page quotes the sentinel verbatim');
});
