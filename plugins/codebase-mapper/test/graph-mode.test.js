'use strict';

// US-7 lane A: the hooks must recognise a project where graphify owns structure and change what
// they tell agents, while a project without a graph report keeps today's behaviour byte for byte.
const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const documents = require('../hooks/lib/map-documents');
const graphMode = require('../hooks/lib/graph-mode');

const root = path.resolve(__dirname, '..');
const startHook = path.join(root, 'hooks', 'inject-context.js');

// Captured from the pre-change hook (git archive HEAD of hooks/, same fixture as project()), so a
// drift in the non-graph-mode context — a stray space, a reordered sentence — fails here.
const BASE_SESSIONSTART_CONTEXT = "<CODEBASE_MAP>\nThis repository has a maintained codebase map in .claude/.codebase-info/.\n\nBefore anything else in your first reply, and before starting the task, output exactly one acknowledgment line: \"Codebase map: read <doc(s)>\" after actually reading only relevant map document(s) from .claude/.codebase-info/, or \"Codebase map: no read needed - <reason>\" if the request needs no codebase knowledge. This is mandatory; do not silently skip it. Never re-read a document already read this session unless this hook names it as changed.\n\nAfter code changes, list modified files and assess the map. If it needs updating, announce \"Documentation check complete. Running /codebase-mapper:update-codebase-map to update documentation.\" That announcement is not the action: invoke Skill `codebase-mapper:update-codebase-map` before ending the turn, then proceed immediately without waiting for a reply. Otherwise end with \"Documentation check complete. No documentation updates needed because [reason].\" Decide. Do not ask the user whether to update the map or run this skill.\n</CODEBASE_MAP>\n\n=== CODEBASE MAP RE-GROUNDED AFTER SESSIONSTART (startup) ===\n\n--- .claude/.codebase-info/INDEX.md ---\n# Example map\n\nRead focused docs as needed.\n";
const BASE_SUBAGENTSTART_CONTEXT = "<CODEBASE_MAP>\nThis repository has a maintained codebase map in .claude/.codebase-info/.\n\nBefore anything else in your first reply, and before starting the task, output exactly one acknowledgment line: \"Codebase map: read <doc(s)>\" after actually reading only relevant map document(s) from .claude/.codebase-info/, or \"Codebase map: no read needed - <reason>\" if the request needs no codebase knowledge. This is mandatory; do not silently skip it. Never re-read a document already read this session unless this hook names it as changed.\n\nYou are a subagent: NEVER update the codebase map or run update-codebase-map, even if it is reported stale. If your changes make it stale, say so in your final report; the main session refreshes the map once, after all parallel work integrates.\n</CODEBASE_MAP>\n\n=== CODEBASE MAP RE-GROUNDED AFTER SESSIONSTART (startup) ===\n\n--- .claude/.codebase-info/INDEX.md ---\n# Example map\n\nRead focused docs as needed.\n";

function project({ graph = false, retiredOnDisk = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-mapper-graph-'));
  const mapDirectory = path.join(directory, '.claude', '.codebase-info');
  fs.mkdirSync(mapDirectory, { recursive: true });
  fs.writeFileSync(path.join(mapDirectory, 'INDEX.md'), '# Example map\n\nRead focused docs as needed.\n');
  fs.writeFileSync(path.join(mapDirectory, 'architecture.md'), '# Architecture\n\nVersion one.\n');
  if (retiredOnDisk) fs.writeFileSync(path.join(mapDirectory, 'modules.md'), '# Modules\n\nVersion one.\n');
  writeState(directory);
  if (graph) writeGraphReport(directory);
  return directory;
}

function mapDirectory(projectDir) {
  return path.join(projectDir, '.claude', '.codebase-info');
}

function writeState(projectDir, extra = {}) {
  const map = documents.loadMap(projectDir);
  writeRawState(projectDir, {
    tool: 'codebase-mapper',
    version: '2.2.0',
    documents: map.documents.filter((entry) => entry.relative !== 'INDEX.md').map((entry) => entry.relative),
    hashes: documents.mapHashes(map.documents),
    ...extra,
  });
}

function writeRawState(projectDir, state) {
  fs.writeFileSync(path.join(mapDirectory(projectDir), documents.STATE_NAME), JSON.stringify(state, null, 2) + '\n');
}

function writeGraphReport(projectDir) {
  const file = graphMode.graphReportPath(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# Graph report\n\n12 modules, 3 entry points.\n');
  return file;
}

function hook(projectDir, data) {
  // inject-context.js prefers CLAUDE_PROJECT_DIR over data.cwd, so an inherited value would point
  // every fixture at the real repo instead of the temp project built above.
  const { CLAUDE_PROJECT_DIR: _ignored, ...ambient } = process.env;
  return childProcess.execFileSync(process.execPath, [startHook], {
    cwd: projectDir,
    env: {
      ...ambient,
      CODEBASE_MAPPER_STATE_DIR: path.join(projectDir, 'state'),
    },
    input: JSON.stringify({ cwd: projectDir, ...data }),
    encoding: 'utf8',
  });
}

function text(output) {
  return JSON.parse(output).hookSpecificOutput.additionalContext;
}

function sessionStart(projectDir, data = {}) {
  return text(hook(projectDir, { session_id: 'main', source: 'startup', ...data }));
}

function subagentStart(projectDir, data = {}) {
  return text(hook(projectDir, {
    session_id: 'sub', source: 'startup', hook_event_name: 'SubagentStart', agent_type: 'sidequest-exec-dispatch', ...data,
  }));
}

test('a project without a graph report is injected exactly the pre-graph-mode context', () => {
  const directory = project();
  assert.strictEqual(sessionStart(directory), BASE_SESSIONSTART_CONTEXT);
  assert.strictEqual(subagentStart(directory), BASE_SUBAGENTSTART_CONTEXT);
  assert.doesNotMatch(sessionStart(directory, { session_id: 'again' }), /graphify/);
});

test('graph mode points SessionStart at graphify for structure, after the unchanged acknowledgment line', () => {
  const directory = project({ graph: true });
  const context = sessionStart(directory);

  assert.match(context, /This project is in graph mode/);
  assert.match(context, /lives in graphify-out\//);
  assert.match(context, /graphify query "<question>"/);
  assert.match(context, /graphify explain "<node>"/);
  assert.match(context, /graphify path "<from>" "<to>"/);
  assert.match(context, /rather than by reading map documents/);
  assert.match(context, /narrative documents in \.claude\/\.codebase-info\/ remain the source for conventions, patterns and onboarding/);

  // The acknowledgment line wording is unchanged, and the new paragraph sits between it and the
  // maintenance paragraph rather than displacing either.
  assert.match(context, /Codebase map: read <doc\(s\)>/);
  assert.match(context, /Codebase map: no read needed - <reason>/);
  assert.ok(context.indexOf('Before anything else in your first reply') < context.indexOf('This project is in graph mode'));
  assert.ok(context.indexOf('This project is in graph mode') < context.indexOf('After code changes, list modified files'));
  assert.match(context, /Running \/codebase-mapper:update-codebase-map/);

  // The main session owns refreshes, so it is never told not to run one.
  assert.doesNotMatch(context, /--update/);
});

test('a subagent in graph mode keeps the never-update rule and is also forbidden to refresh the graph', () => {
  const directory = project({ graph: true });
  const context = subagentStart(directory);

  assert.match(context, /NEVER update the codebase map/);
  assert.match(context, /main session refreshes the map once/);
  assert.match(context, /This project is in graph mode/);
  // SQ-317: the documented refresh is named first, and the undocumented alias SQ-313 found is still
  // forbidden by name, because both spellings work at graphify 0.8.38 and a subagent must run neither.
  assert.match(context, /NEVER run `graphify update <root>` or its undocumented alias `graphify \.\.\. --update`/);
  assert.match(context, /post-commit hook or the main session refreshes the graph/);
  assert.doesNotMatch(context, /Running \/codebase-mapper:update-codebase-map/);
  assert.match(context, /Codebase map: read <doc\(s\)>/);
});

test('graph mode is detected from graphify-out/GRAPH_REPORT.md alone, and re-injected on compact', () => {
  const directory = project();
  assert.strictEqual(graphMode.isGraphMode(directory), false);
  assert.strictEqual(graphMode.isGraphMode(''), false);

  // The output directory without the report is not graph mode: graphify may be mid-build, and the
  // hooks never build it themselves.
  fs.mkdirSync(path.join(directory, graphMode.GRAPH_DIR_NAME), { recursive: true });
  assert.strictEqual(graphMode.isGraphMode(directory), false);
  assert.doesNotMatch(sessionStart(directory), /graph mode/);

  // A directory where the report should be is not a report either.
  fs.mkdirSync(graphMode.graphReportPath(directory), { recursive: true });
  assert.strictEqual(graphMode.isGraphMode(directory), false);
  fs.rmSync(graphMode.graphReportPath(directory), { recursive: true, force: true });

  writeGraphReport(directory);
  assert.strictEqual(graphMode.isGraphMode(directory), true);
  const compact = sessionStart(directory, { session_id: 'compact-one', source: 'compact' });
  assert.match(compact, /SESSIONSTART \(compact\)/);
  assert.match(compact, /This project is in graph mode/);
});

test('a graphify structure manifest expects the retired structural documents to be gone', () => {
  const directory = project({ graph: true, retiredOnDisk: false });
  const hashes = documents.mapHashes(documents.loadMap(directory).documents);

  // A manifest written before the conversion still lists the three retired documents, which are
  // now absent from disk. With structure: "graphify" that is by design, not drift.
  const listed = {
    tool: 'codebase-mapper',
    version: '2.2.0',
    documents: ['architecture.md', ...graphMode.RETIRED_DOCUMENTS].sort(),
    hashes: { ...hashes, 'modules.md': 'a'.repeat(64), 'entry-points.md': 'b'.repeat(64), 'directory-structure.md': 'c'.repeat(64) },
  };
  writeRawState(directory, { ...listed, structure: graphMode.GRAPH_STRUCTURE });
  assert.deepStrictEqual(documents.loadMap(directory).state, { migratable: false, stale: false });

  // Today's behaviour without the field: the same manifest is stale.
  writeRawState(directory, listed);
  assert.strictEqual(documents.loadMap(directory).state.stale, true);

  // A manifest that simply omits them is clean either way.
  writeRawState(directory, {
    tool: 'codebase-mapper', version: '2.2.0', structure: graphMode.GRAPH_STRUCTURE, documents: ['architecture.md'], hashes,
  });
  assert.strictEqual(documents.loadMap(directory).state.stale, false);

  // A retired document left on disk and unhashed is tolerated too, so a half-cleaned conversion
  // never nags; the narrative documents are still compared.
  fs.writeFileSync(path.join(mapDirectory(directory), 'modules.md'), '# Modules\n\nLeftover.\n');
  assert.strictEqual(documents.loadMap(directory).state.stale, false);
});

test('a graphify structure manifest still reports narrative drift and still needs a hash manifest', () => {
  const directory = project({ graph: true, retiredOnDisk: false });
  writeState(directory, { structure: graphMode.GRAPH_STRUCTURE });
  assert.strictEqual(documents.loadMap(directory).state.stale, false);

  fs.writeFileSync(path.join(mapDirectory(directory), 'architecture.md'), '# Architecture\n\nVersion two.\n');
  assert.strictEqual(documents.loadMap(directory).state.stale, true);
  assert.match(sessionStart(directory), /hash manifest is stale/);

  // A new narrative document missing from the manifest is still drift.
  writeState(directory, { structure: graphMode.GRAPH_STRUCTURE });
  fs.writeFileSync(path.join(mapDirectory(directory), 'conventions.md'), '# Conventions\n\nNew.\n');
  assert.strictEqual(documents.loadMap(directory).state.stale, true);

  // The field does not excuse a manifest with no hashes: that is still a migration, not graph mode.
  writeRawState(directory, { tool: 'codebase-mapper', structure: graphMode.GRAPH_STRUCTURE, documents: ['architecture.md'] });
  assert.strictEqual(documents.loadMap(directory).state.migratable, true);
});

test('migration preserves the structure field while rebuilding the hash manifest', () => {
  const directory = project({ graph: true, retiredOnDisk: false });
  writeRawState(directory, { tool: 'codebase-mapper', structure: graphMode.GRAPH_STRUCTURE, documents: ['architecture.md'] });

  assert.strictEqual(documents.migrateLegacyMap(directory), true);
  const migrated = JSON.parse(fs.readFileSync(path.join(mapDirectory(directory), documents.STATE_NAME), 'utf8'));
  assert.strictEqual(migrated.structure, graphMode.GRAPH_STRUCTURE);
  assert.strictEqual(migrated.schemaVersion, 1);
  assert.strictEqual(documents.loadMap(directory).state.stale, false);
});
