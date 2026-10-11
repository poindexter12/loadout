'use strict';

// US-7 lane B (SQ-312): the update skill is operational guidance, so the freshness split is
// observable only in its text. These assertions weld that text to the detection contract in
// hooks/lib/graph-mode.js and to the hook's subagent wording, so a rename in either place fails
// here instead of silently leaving the skill telling agents something the code no longer does.
const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const graphMode = require('../hooks/lib/graph-mode');

const root = path.resolve(__dirname, '..');
// Run as a subprocess, never required: write-map-state.js writes state for process.cwd() on load.
const stateWriterScript = path.join(root, 'scripts', 'write-map-state.js');
const updateSkill = fs.readFileSync(path.join(root, 'skills', 'update-codebase-map', 'SKILL.md'), 'utf8');
const hookSource = fs.readFileSync(path.join(root, 'hooks', 'inject-context.js'), 'utf8');

function section(skill, heading) {
  const start = skill.indexOf(heading);
  assert.notStrictEqual(start, -1, `the skill must contain "${heading}"`);
  const end = skill.indexOf('\n## ', start + heading.length);
  return skill.slice(start, end === -1 ? undefined : end);
}

test('Step 1 reads structure and names the graph-mode detection contract', () => {
  assert.match(updateSkill, /to get `gitCommit`, `mappedAt`, `structure`/);
  assert.ok(
    updateSkill.includes(`${graphMode.GRAPH_DIR_NAME}/${graphMode.GRAPH_REPORT_NAME}`),
    'the skill must detect graph mode from the same report path the hooks use',
  );
  assert.ok(
    updateSkill.includes(`structure: "${graphMode.GRAPH_STRUCTURE}"`),
    'the skill must name the same structure value the hooks accept',
  );
  for (const document of graphMode.RETIRED_DOCUMENTS) {
    assert.ok(updateSkill.includes(document), `the skill must name the retired document ${document}`);
  }
});

test('graph mode hands structural freshness to graphify and refreshes at most once', () => {
  assert.match(updateSkill, /graphify hook status/);
  // Hook installed: the report must be no older than the last commit before moving on.
  assert.match(updateSkill, /git log -1 --format=%ct/);
  assert.match(updateSkill, /date -r graphify-out\/GRAPH_REPORT\.md \+%s/);
  // No hook: one bounded refresh, in the documented spelling only.
  assert.match(updateSkill, /graphify update \./);
  assert.match(updateSkill, /re-extracts only the files that changed/);
  assert.match(updateSkill, /Run it once\. Do not loop/);
  // SQ-313 probed graphify 0.8.38: `graphify <root> --update` works but is undocumented, so the
  // skill must never teach it. The subagent prohibition keeps the `graphify ... --update` ellipsis
  // form, which is lane A's hook wording and forbids rather than instructs.
  for (const alias of [/graphify \. --update/, /graphify <root> --update/, /graphify <path> --update/]) {
    assert.doesNotMatch(updateSkill, alias, `the undocumented alias ${alias} must not appear`);
  }
  // A missing CLI is not this skill's problem to solve.
  assert.match(updateSkill, /offering the install belongs to\s+Quartermaster/);
});

test('graph mode leaves the model only the narrative question', () => {
  assert.match(updateSkill, /narrative impact only/);
  assert.match(updateSkill, /Did a \*\*convention\*\* change/);
  assert.match(updateSkill, /Did a \*\*pattern\*\* change/);
  assert.match(updateSkill, /Did an \*\*architectural boundary\*\* move/);
  assert.match(updateSkill, /Did an \*\*onboarding step\*\* change/);
  // The entry-point question is about the flow's story, never a list the graph already holds.
  assert.match(updateSkill, /not the list of routes or commands, but what the\s+important flow now does end to end/);
  assert.match(updateSkill, /is a no-op for this map in graph mode/);
});

test('the retired structural documents leave the graph-mode doc set and the manifest', () => {
  assert.match(updateSkill, /In graph mode, drop the three retired rows/);
  assert.match(updateSkill, /never recreate a retired document/i);
  // The rebuilt manifest cannot mention them, which is what keeps the map from reading stale.
  assert.match(updateSkill, /`documents` and `hashes` never mention them/);
});

test('the subagent rule repeats the hook wording verbatim and still bans map updates', () => {
  const forbidden = /NEVER run `graphify \.\.\. --update`/;
  assert.match(hookSource, forbidden, 'lane A hook text is the source of this wording');
  assert.match(updateSkill, forbidden, 'the skill must forbid the same thing in the same words');
  assert.match(updateSkill, /If you are a subagent/);
  assert.match(updateSkill, /the main session refreshes the map\s+once/);
});

test('the one-time conversion is announced, bounded to the three documents, and rehashes state', () => {
  const conversion = section(updateSkill, '## Converting an existing map to graph mode');
  for (const document of graphMode.RETIRED_DOCUMENTS) {
    assert.ok(conversion.includes(document), `the conversion must delete ${document}`);
  }
  assert.match(conversion, /dependencies\.md` included/);
  assert.match(conversion, /Rewrite `INDEX\.md`'s structure section/);
  assert.match(conversion, /map-codebase/);
  assert.ok(conversion.includes(`structure: "${graphMode.GRAPH_STRUCTURE}"`));
  assert.match(conversion, /write-map-state\.js/);
  assert.match(conversion, /one-time/);
  assert.match(conversion, /Do not convert silently/);
  assert.match(conversion, /do not convert twice/);
  // Only a project that actually has a graph converts.
  assert.ok(conversion.includes(`${graphMode.GRAPH_DIR_NAME}/${graphMode.GRAPH_REPORT_NAME}`));
});

test('classic mode is unchanged when structure is unset and no graph report exists', () => {
  assert.match(updateSkill, /classic mode, nothing to decide/);
  assert.match(updateSkill, /behaves exactly as it always has/);
  // The pre-graph-mode detection commands and the CLAUDE.md rule survive untouched.
  assert.match(updateSkill, /git diff --stat <gitCommit>\.\.HEAD/);
  assert.match(updateSkill, /find \. -type f -newer \.claude\/\.codebase-info\/INDEX\.md/);
  assert.match(updateSkill, /\*\*Never touch `CLAUDE\.md`\.\*\*/);
});

test('the bundled state writer drops structure, which is why the skill re-applies it', () => {
  // Pins the premise of the skill's extra step. If write-map-state.js is ever taught to carry
  // `structure` over, this fails and the skill's re-apply step should go with it.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-mapper-update-skill-'));
  const mapDirectory = path.join(directory, '.claude', '.codebase-info');
  fs.mkdirSync(mapDirectory, { recursive: true });
  fs.writeFileSync(path.join(mapDirectory, 'INDEX.md'), '# Example map\n');
  fs.writeFileSync(path.join(mapDirectory, 'architecture.md'), '# Architecture\n');
  fs.writeFileSync(
    path.join(mapDirectory, '.map-state.json'),
    JSON.stringify({ schemaVersion: 1, structure: graphMode.GRAPH_STRUCTURE, documents: ['architecture.md'], hashes: {} }, null, 2) + '\n',
  );

  childProcess.execFileSync(process.execPath, [stateWriterScript, '--project', directory], { encoding: 'utf8' });
  const state = JSON.parse(fs.readFileSync(path.join(mapDirectory, '.map-state.json'), 'utf8'));
  assert.ok(!Object.prototype.hasOwnProperty.call(state, 'structure'));
  assert.deepStrictEqual(state.documents, ['architecture.md']);
  for (const document of graphMode.RETIRED_DOCUMENTS) {
    assert.ok(!Object.prototype.hasOwnProperty.call(state.hashes, document));
  }

  assert.match(updateSkill, /does not carry `structure` over, so re-apply it immediately after/);
  assert.match(updateSkill, /s\.structure='graphify'/);
  fs.rmSync(directory, { recursive: true, force: true });
});
