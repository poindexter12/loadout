'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

function readSkill(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'skills', name, 'SKILL.md'), 'utf8');
}

function readReference(skill, name) {
  return fs.readFileSync(path.join(__dirname, '..', 'skills', skill, 'references', name + '.md'), 'utf8');
}

/** Every Markdown file under skills/, as [repo-relative path, contents] pairs. */
function allSkillProse(dir = path.join(__dirname, '..', 'skills'), out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) allSkillProse(full, out);
    else if (entry.name.endsWith('.md')) out.push([path.relative(path.join(__dirname, '..'), full), fs.readFileSync(full, 'utf8')]);
  }
  return out;
}

function fixture(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-seeds-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HOME: path.join(project, 'home'),
    USERPROFILE: path.join(project, 'home'),
    CLAUDE_CONFIG_DIR: path.join(project, 'config'),
    CLAUDE_PROJECT_DIR: project,
    QUARTERMASTER_STATE_DIR: path.join(project, 'quartermaster-state'),
    LIVE_RULES_STATE_DIR: path.join(project, 'live-rules-state'),
  };
  delete env.LIVE_RULES_PATH;
  return { project, env };
}

function runHook(plugin, script, fixture, input = {}) {
  return execFileSync(process.execPath, [path.join(__dirname, '..', '..', plugin, 'hooks', script)], {
    cwd: fixture.project,
    env: fixture.env,
    input: JSON.stringify({ cwd: fixture.project, session_id: 'seed-contract', ...input }),
    encoding: 'utf8',
  });
}

function assertReuseOrder(text) {
  assert.match(text.replace(/\s+/g, ' '), /project (?:code|tests and commands).*native platform features.*standard library.*installed dependencies/i);
}

function assertApprovalSplit(text) {
  const normalized = text.replace(/\s+/g, ' ');
  assert.match(normalized, /current user approval or explicit standing permission/);
  assert.match(normalized, /(?:before|without).*mining|(?:run|running).*min(?:e|ing)|min(?:e|ing).*without/i);
  assert.match(normalized, /round approval does not authorize unrelated edits/i);
  assert.match(normalized, /per-item approval/);
  assert.match(normalized, /explicit standing permission covers (?:that exact class|that class)/);
}


test('documents namespaced Quartermaster commands and Live Rules deduplication', () => {
  const doctor = readSkill('loadout-doctor');
  const setup = readSkill('setup');

  assert.match(doctor, /`\/quartermaster:update-loadout`, then `\/reload-plugins`/);
  assert.doesNotMatch(doctor, /`\/update-loadout`/);
  assert.match(setup, /injects it again when its content changes mid-session/);
  assert.match(setup, /Unchanged rules do not repeat on every prompt or edit/);
  assert.doesNotMatch(setup, /every prompt for the always-on ones/);
  // live-rules adds timing to native storage; it must not be sold as the store itself.
  assert.match(setup, /It owns no storage/);
  assert.doesNotMatch(setup, /`live-rules` holds project rules/);
});

test('setup, resupply, and references agree on reuse and consent rather than build-first work', () => {
  const setup = readSkill('setup');
  const resupply = readSkill('resupply');
  const self = readReference('setup', 'self-improvement');
  const routing = readReference('resupply', 'routing');
  const digest = readReference('setup', 'clean-code-principles');
  for (const text of [setup, resupply, self, routing]) {
    assertReuseOrder(text);
    assertApprovalSplit(text);
    assert.doesNotMatch(text, /Build the measurement first|The fix is a \*\*measurement built as a skill\*\*|building that instrument is the most/);
  }
  assert.ok(resupply.indexOf('Before mining or starting the round') < resupply.indexOf('### 1. Mine'));
  assert.match(resupply, /seed, hook\s+nudge, or natural pause is only a reason to offer one/);
  assert.match(resupply, /nothing to build here/);
  assert.match(resupply, /Raw transcripts are never loaded into model context/);
  assert.match(resupply, /unless explicit standing permission covers that exact\s+class of change/);
  assertReuseOrder(digest);
  assert.match(digest, /without skipping project-required tests or release gates/);
  assert.match(digest, /solo work retains all required verification/);
  assert.doesNotMatch(digest, /Leave every file a little cleaner|Refactor first, then change|Keep units small/);
  for (const text of [setup, resupply, digest]) {
    for (const safeguard of ['security', 'trust-boundary', 'data-loss', 'accessibility']) {
      assert.ok(text.includes(safeguard), `guidance preserves ${safeguard}`);
    }
  }
  assert.match(setup, /not approval to migrate or overwrite/);
  assert.match(self, /Preserve existing rules/);
  assert.match(readReference('setup', 'rule-templates'), /Seed `\.claude\/rules\/` only when it holds no rule files yet/);
});

test('self-improvement describes path/hash deduplication, not per-prompt repetition', () => {
  const text = readReference('setup', 'self-improvement');
  assert.match(text, /path.*(?:content hash|content\/hash)/);
  assert.match(text, /Unchanged rules do not repeat\s+on every prompt or edit/);
  assert.doesNotMatch(text, /re-injected every prompt|re-injects it on every prompt|on every prompt so it doesn't get forgotten/);
});

test('routing picks a rule destination by who the rule is true for, not by what is installed', () => {
  const routing = readReference('resupply', 'routing');
  const section = routing.slice(routing.indexOf('## 7.'), routing.indexOf('## 8.'));
  assert.ok(section, 'routing.md keeps a rule-destination section');

  // All three destinations, and the choice is independent of live-rules being present.
  assert.match(section, /`\.claude\/rules\/<theme-slug>\.md`/);
  assert.match(section, /`\.claude\/rules\/<theme-slug>\.local\.md`/);
  assert.match(section, /`~\/\.claude\/rules\/<theme-slug>\.md`/);
  assert.match(section.replace(/\s+/g, ' '), /whether or\s*not live-rules is installed/i);
  assert.match(section.replace(/\s+/g, ' '), /changes when a rule is said, never where it is stored/);

  // The old framing made the three-way choice conditional on the plugin and sold
  // its cadence as the reason to prefer it.
  assert.doesNotMatch(section, /If the live-rules plugin is installed[\s\S]*?\n- Else:/);
  assert.doesNotMatch(section, /path\/content hash changes|manifest/i);
});

test('quartermaster routes personal themes out of the repo and names the native rule store', () => {
  const setup = readSkill('setup');
  const routing = readReference('resupply', 'routing');
  const templates = readReference('setup', 'rule-templates');
  const self = readReference('setup', 'self-improvement');

  // Cross-project correction themes are the user's, so they go to the user's tree.
  for (const [label, text] of [['setup', setup], ['routing', routing], ['rule-templates', templates]]) {
    assert.match(text, /~\/\.claude\/rules/, `${label} names ~/.claude/rules as a destination`);
  }
  assert.match(setup.replace(/\s+/g, ' '), /cross-project correction theme[\s\S]*?`~\/\.claude\/rules\/<name>\.md`/i);
  assert.match(setup.replace(/\s+/g, ' '), /project-derived rule[\s\S]*?`\.claude\/rules\/<name>\.md`/i);
  assert.match(setup, /never into the repo/);
  assert.match(routing.replace(/\s+/g, ' '), /Response format and length, voice, tone, punctuation, and cross-project workflow habits are always this row/);

  // Project-derived starter rules go to the native project directory.
  assert.match(templates, /Write each selected rule to its own `\.claude\/rules\/<stable-name>\.md` file/);
  assert.match(setup, /one rule per file under `\.claude\/rules\/\*\.md`/);

  // The self-improvement sentinel is still one exact path, at the new location.
  assert.match(self, /exactly\s+`\.claude\/rules\/self-improvement\.md`/);
  assert.match(self, /only when the exact\s+`\.claude\/rules\/self-improvement\.md` path is absent/);
  assert.doesNotMatch(self, /enabled/);

  // Nothing anywhere in the skill text points at the retired store or its index.
  for (const [file, text] of allSkillProse()) {
    assert.doesNotMatch(text, /live-rules\/rules/, `${file} must not name the retired rule store`);
    assert.doesNotMatch(text, /manifest\.json/, `${file} must not name a rule manifest`);
    assert.doesNotMatch(text, /^(?:globs|dirs):/m, `${file} must use the native paths: scope key`);
  }

  // Template bodies follow the project's conventions, not the user's voice.
  assert.doesNotMatch(templates, /user's stated voice/);
  assert.match(templates, /Adapt each body to the project's own conventions/);
  assert.match(templates, /cite the project's own editorial guideline file as its source/);
  assert.match(templates, /<editorial-guidelines-path>/);
});

test('unseeded fallback offers reuse with the same two approval boundaries, without mining', (t) => {
  const f = fixture(t);
  const result = runHook('quartermaster', 'session-start-nudge.js', f, { source: 'startup' });
  const context = JSON.parse(result).hookSpecificOutput.additionalContext;
  assertReuseOrder(context);
  assertApprovalSplit(context);
  assert.match(context, /offer a focused optimization round/);
  assert.match(context, /missing check need not become a new measurement skill/);
  assert.equal(fs.existsSync(f.env.QUARTERMASTER_STATE_DIR), false);
  assert.equal(fs.existsSync(path.join(f.project, '.claude')), false);
});

test('graphify prose keeps the opt-in gate and the two names the obvious guess gets wrong (SQ-313)', () => {
  const setup = readSkill('setup');
  const update = readSkill('update-loadout');
  const doctor = readSkill('loadout-doctor');
  const { GRAPHIFY_FLOOR_VERSION, GRAPHIFY_PACKAGE, REQUIRED_CLI_SURFACES } = require('../bin/graphify.js');

  // Setup gates on uv and never installs either tool silently.
  assert.match(setup, /check `uv` first/);
  assert.match(setup, /uv tool install graphifyy/);
  assert.match(setup, /Never install `uv`\s+yourself, and never install graphify without the user's yes/);
  assert.match(setup, /docs\.astral\.sh\/uv\/getting-started\/installation/);
  assert.match(setup, /plugin:graphify/, 'the choice is recorded like every other workspace piece');
  // Offered only alongside codebase-mapper, as its optional layer.
  assert.ok(setup.indexOf('offer **graphify**') > setup.indexOf('`codebase-mapper` keeps a set of small docs'));

  // The updater upgrades but never installs.
  assert.match(update, /never installs graphify/);
  assert.match(update, /never installs `uv`/);
  assert.match(update, /`--check` reports the installed version and does not upgrade/);
  assert.match(update, /`--dry-run` prints the upgrade\s+command without running it/);

  // The doctor is read-only and names the floor and every pinned surface, so the prose
  // cannot drift from the enum in bin/graphify.js.
  assert.match(doctor, /read-only/);
  assert.match(doctor, /not installed \(opt-in\)/);
  assert.match(doctor, /graphify-out\/GRAPH_REPORT\.md/);
  assert.match(doctor, /graphify hook status/);
  assert.ok(doctor.includes(GRAPHIFY_FLOOR_VERSION), `doctor prose names the ${GRAPHIFY_FLOOR_VERSION} floor`);
  for (const { surface } of REQUIRED_CLI_SURFACES) {
    assert.ok(doctor.includes(surface), `doctor prose names the pinned ${surface} surface`);
  }

  // The distribution name is the one mistake that makes an install fail outright, so every
  // skill that names a package names this one, and none of them says `install graphify`.
  for (const [file, text] of [['setup', setup], ['update-loadout', update], ['loadout-doctor', doctor]]) {
    if (/uv tool (install|upgrade)/.test(text)) {
      assert.ok(text.includes(GRAPHIFY_PACKAGE), `${file} names the ${GRAPHIFY_PACKAGE} distribution`);
    }
    assert.doesNotMatch(text, /uv tool install graphify\b(?!y)/, `${file} must not print an install of the nonexistent graphify package`);
  }
});
