import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const rules = require('../../plugins/live-rules/hooks/lib/rules.js');
const { ticketObservation: adapterTicketObservation } = require('../../plugins/observability/lib/observability/adapters/sidequest.js');
const { projectMetadata } = require('../../plugins/observability/hooks/observability.js');
const { normalizeObservation } = require('../../plugins/observability/lib/observability/ingest.js');
const { openObservabilityStore } = require('../../plugins/observability/lib/observability/store.js');
const { ticketObservation: nativeTicketObservation } = require('../../plugins/sidequest/lib/telemetry.js');

const PROJECT_DIR = process.platform === 'win32' ? 'C:\\workspace\\canonical-project' : '/workspace/canonical-project';
const NOW = new Date('2026-07-20T12:00:00.000Z');

function readReference(skill, name) {
  return fs.readFileSync(path.join(root, 'plugins', 'quartermaster', 'skills', skill, 'references', `${name}.md`), 'utf8');
}

function seedBlocks(name) {
  const blocks = [...readReference('setup', name).matchAll(/```markdown\n([\s\S]*?)\n```/g)].map((match) => `${match[1]}\n`);
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

function runHook(plugin, script, testFixture, input = {}) {
  return execFileSync(process.execPath, [path.join(root, 'plugins', plugin, 'hooks', script)], {
    cwd: testFixture.project,
    env: testFixture.env,
    input: JSON.stringify({ cwd: testFixture.project, session_id: 'seed-contract', ...input }),
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

test('Quartermaster seed catalogs preserve Live Rules one-rule-per-file and re-grounding behavior', (t) => {
  const testFixture = fixture(t);
  const blocks = [...seedBlocks('rule-templates'), ...seedBlocks('self-improvement')];
  rules.seedRuleSet(testFixture.project, blocks.map((content) => ({ content })));
  const loaded = rules.loadRuleSet(testFixture.project);
  assert.equal(loaded.notice, '', 'a freshly seeded project has nothing in a retired store');
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

  const ruleDir = path.join(testFixture.project, '.claude', 'rules');
  const rulePath = path.join(ruleDir, 'self-improvement.md');
  const seed = seedBlocks('self-improvement')[0];
  fs.rmSync(path.join(testFixture.project, '.claude'), { recursive: true, force: true });
  fs.mkdirSync(ruleDir, { recursive: true });
  fs.writeFileSync(rulePath, seed);
  // Transitional: Quartermaster's nudge still probes the pre-SQ-292 store
  // (quartermaster/hooks/session-start-nudge.js:41) to decide it has nothing to
  // say. SQ-292 moved live-rules to .claude/rules but may not touch
  // quartermaster; SQ-289 repoints that detector. Seed the legacy marker so the
  // silence assertion below holds either way, and DELETE this block once the
  // detector reads .claude/rules.
  const legacyMarker = path.join(testFixture.project, '.claude', 'live-rules', 'rules', 'self-improvement.md');
  fs.mkdirSync(path.dirname(legacyMarker), { recursive: true });
  fs.writeFileSync(legacyMarker, seed);

  const start = runHook('live-rules', 'session-start-rules.js', testFixture, { source: 'startup' });
  assertApprovalSplit(JSON.parse(start).hookSpecificOutput.additionalContext);
  assert.equal(runHook('live-rules', 'inject-prompt-rules.js', testFixture, { prompt: 'continue' }), '');
  assert.equal(runHook('quartermaster', 'session-start-nudge.js', testFixture, { source: 'startup' }), '');
  // The hooks only ever read .claude/rules; nothing writes back to a rule file.
  assert.equal(fs.readFileSync(rulePath, 'utf8'), seed);
  assert.equal(fs.existsSync(testFixture.env.QUARTERMASTER_STATE_DIR), false, 'seeding must not run resupply or record a mining round');
  assert.throws(() => rules.seedRuleSet(testFixture.project, [{ content: seed }]), /already exists/);
  assert.equal(fs.readFileSync(rulePath, 'utf8'), seed);

  fs.appendFileSync(rulePath, '\nKeep the project-specific addition.\n');
  assert.match(runHook('live-rules', 'inject-prompt-rules.js', testFixture, { prompt: 'continue' }), /Keep the project-specific addition/);
  assert.equal(runHook('live-rules', 'inject-prompt-rules.js', testFixture, { prompt: 'continue' }), '');
  assert.match(runHook('live-rules', 'session-start-rules.js', testFixture, { source: 'compact' }), /Keep the project-specific addition/);
  assert.equal(runHook('live-rules', 'inject-prompt-rules.js', testFixture, { prompt: 'continue' }), '');
});

test('native Sidequest telemetry joins the canonical Observability project after ingest', () => {
  const projectId = projectMetadata(PROJECT_DIR).project_id;
  const ticket = {
    ref: 'SQ-587',
    status: 'doing',
    updatedAt: NOW.toISOString(),
    category: { id: 'coding.normal', route: { model: 'gpt-5.6-terra', effort: 'high', backend: 'codex' } },
    model: 'gpt-5.6-terra',
    effort: 'high',
    exec: { backend: 'codex', runsModel: 'gpt-5.6-terra', agent: 'sidequest-exec-dispatch-high' },
    dispatch: { id: 'dispatch-canonical', taskId: 'task-canonical', sessionId: 'session-canonical', agentId: 'agent-canonical', executor: 'sidequest-exec-dispatch-high' },
    claim: { by: 'worker-canonical', sessionId: 'session-canonical' },
  };
  const adapter = adapterTicketObservation(ticket, { projectId });
  const native = nativeTicketObservation({ slug: 'canonical-project', path: PROJECT_DIR }, ticket);
  assert.equal(normalizeObservation(native).accepted, true);

  const store = openObservabilityStore(':memory:', { outboxEnabled: false });
  try {
    assert.equal(store.ingest(adapter).accepted, true);
    assert.equal(store.ingest(native).accepted, true);
    const rows = store.database.prepare(`
      SELECT project_id FROM observation
      WHERE event_name = 'sidequest.ticket'
      ORDER BY source_schema
    `).all();
    assert.deepEqual(rows.map(({ project_id: value }) => value), [projectId, projectId]);
  } finally {
    store.close();
  }
});
