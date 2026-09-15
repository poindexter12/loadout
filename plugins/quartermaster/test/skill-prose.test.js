'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const rules = require('../../live-rules/hooks/lib/rules.js');

function readSkill(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'skills', name, 'SKILL.md'), 'utf8');
}

function readReference(skill, name) {
  return fs.readFileSync(path.join(__dirname, '..', 'skills', skill, 'references', name + '.md'), 'utf8');
}

function seedBlocks(name) {
  const blocks = [...readReference('setup', name).matchAll(/```markdown\n([\s\S]*?)\n```/g)].map((match) => match[1] + '\n');
  assert.ok(blocks.length, `${name} must contain seed rules`);
  return blocks;
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
  assert.match(setup, /injects a rule again only when it newly matches or its content\/hash changes/);
  assert.match(setup, /Unchanged rules do not repeat on every prompt or edit/);
  assert.doesNotMatch(setup, /every prompt for the always-on ones/);
});

test('seed catalog parses as atomic rules and preserves required gates and safeguards', (t) => {
  const f = fixture(t);
  const blocks = [...seedBlocks('rule-templates'), ...seedBlocks('self-improvement')];
  rules.writeAtomicRuleSet(f.project, blocks.map((content) => ({ content })));
  const loaded = rules.loadRuleSet(f.project);
  assert.equal(loaded.stale, false);
  assert.equal(loaded.rules.length, blocks.length);
  const bodies = loaded.rules.map((rule) => rule.body).join('\n');
  assertReuseOrder(bodies);
  for (const safeguard of ['security checks', 'trust-boundary validation', 'data-loss protections', 'accessibility safeguards']) {
    assert.ok(bodies.includes(safeguard), `seeded safeguards include ${safeguard}`);
  }
  assert.match(bodies, /Focused checks do not replace project-required tests or release gates/);
  assert.match(bodies, /If an integration owner\s+is assigned/);
  assert.match(bodies, /When working solo, complete all required verification/);
  assert.match(bodies, /uv run pytest.*uv run ruff check/);
  assert.match(bodies, /PRUNES the\s+whole shared/);
  assert.match(bodies, /never skip hooks/);
  assert.match(bodies, /leave unrelated cleanup\s+alone unless separately approved/i);
  assert.match(bodies, /propose unrelated dead-link repairs separately/);
  assert.match(bodies, /Remove commented-out code only when the requested\s+change makes it obsolete/);
  assert.doesNotMatch(bodies, /methods ~5|classes ~100|≤4 params|Leave each file cleaner|Build the measurement first|For a deeper periodic pass, run|Delete commented-out code|Fix dead links when found/);
  for (const rule of loaded.rules) {
    assert.doesNotMatch(rule.body, /quartermaster\.js["`]?\s+mine/, `${rule.description} must not seed a mining command`);
    if (/resupply/i.test(rule.body)) assertApprovalSplit(rule.body);
  }
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
  assert.match(readReference('setup', 'rule-templates'), /only when that destination does not exist/);
});

test('self-improvement and routing describe path/hash deduplication, not per-prompt repetition', () => {
  for (const text of [readReference('setup', 'self-improvement'), readReference('resupply', 'routing')]) {
    assert.match(text, /path.*(?:content hash|content\/hash)/);
    assert.match(text, /Unchanged rules do not repeat\s+on every prompt or edit/);
    assert.doesNotMatch(text, /re-injected every prompt|re-injects it on every prompt|on every prompt so it doesn't get forgotten/);
  }
});

test('real seed re-grounds once, updates on content change, and leaves an existing workspace intact', (t) => {
  const f = fixture(t);
  const ruleDir = path.join(f.project, '.claude', 'live-rules', 'rules');
  const rulePath = path.join(ruleDir, 'self-improvement.md');
  const manifestPath = path.join(ruleDir, '..', 'manifest.json');
  const seed = seedBlocks('self-improvement')[0];
  fs.mkdirSync(ruleDir, { recursive: true });
  fs.writeFileSync(rulePath, seed);
  rules.syncAtomicRuleSet(f.project);
  const manifest = fs.readFileSync(manifestPath, 'utf8');

  const start = runHook('live-rules', 'session-start-rules.js', f, { source: 'startup' });
  assertApprovalSplit(JSON.parse(start).hookSpecificOutput.additionalContext);
  assert.equal(runHook('live-rules', 'inject-prompt-rules.js', f, { prompt: 'continue' }), '');
  assert.equal(runHook('quartermaster', 'session-start-nudge.js', f, { source: 'startup' }), '');
  assert.equal(fs.readFileSync(rulePath, 'utf8'), seed);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifest);
  assert.equal(fs.existsSync(f.env.QUARTERMASTER_STATE_DIR), false, 'seeding must not run resupply or record a mining round');
  assert.throws(() => rules.writeAtomicRuleSet(f.project, [{ content: seed }]), /already exists/);
  assert.equal(fs.readFileSync(rulePath, 'utf8'), seed);

  fs.appendFileSync(rulePath, '\nKeep the project-specific addition.\n');
  assert.match(runHook('live-rules', 'inject-prompt-rules.js', f, { prompt: 'continue' }), /Keep the project-specific addition/);
  assert.equal(runHook('live-rules', 'inject-prompt-rules.js', f, { prompt: 'continue' }), '');
  assert.match(runHook('live-rules', 'session-start-rules.js', f, { source: 'compact' }), /Keep the project-specific addition/);
  assert.equal(runHook('live-rules', 'inject-prompt-rules.js', f, { prompt: 'continue' }), '');
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
