'use strict';

const assert = require('node:assert');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const writeMapState = path.join(root, 'scripts', 'write-map-state.js');

function fixtureProject() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-mapper-state-'));
  const mapDir = path.join(projectDir, '.claude', '.codebase-info');
  fs.mkdirSync(mapDir, { recursive: true });
  fs.writeFileSync(path.join(mapDir, 'INDEX.md'), '# Example map\n');
  fs.writeFileSync(path.join(mapDir, 'architecture.md'), '# Architecture\n');
  fs.writeFileSync(path.join(mapDir, 'obsolete.md'), '# Obsolete\n');
  return { projectDir, mapDir };
}

function writeState(projectDir, ...extraArgs) {
  return childProcess.execFileSync(process.execPath, [writeMapState, '--project', projectDir, ...extraArgs], { encoding: 'utf8' });
}

function writeStateFailure(projectDir, ...extraArgs) {
  const result = childProcess.spawnSync(process.execPath, [writeMapState, '--project', projectDir, ...extraArgs], { encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

function readState(mapDir) {
  return JSON.parse(fs.readFileSync(path.join(mapDir, '.map-state.json'), 'utf8'));
}

function documentHash(mapDir, name) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(mapDir, name), 'utf8').replace(/\r/g, '')).digest('hex');
}

function assertStateMatchesDocuments(mapDir) {
  const state = JSON.parse(fs.readFileSync(path.join(mapDir, '.map-state.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(state.hashes).sort(), ['INDEX.md', ...state.documents].sort());
  for (const name of Object.keys(state.hashes)) assert.strictEqual(state.hashes[name], documentHash(mapDir, name));
  return state;
}

test('write-map-state discovers added and removed documents before atomically replacing state', () => {
  const { projectDir, mapDir } = fixtureProject();
  assert.match(writeState(projectDir), /Wrote map state for 2 document\(s\)\./);
  const firstState = assertStateMatchesDocuments(mapDir);
  assert.strictEqual(firstState.gitCommit, null);
  assert.deepStrictEqual(firstState.documents, ['architecture.md', 'obsolete.md']);

  fs.unlinkSync(path.join(mapDir, 'obsolete.md'));
  fs.writeFileSync(path.join(mapDir, 'modules.md'), '# Modules\n');
  assert.match(writeState(projectDir), /Wrote map state for 2 document\(s\)\./);
  const secondState = assertStateMatchesDocuments(mapDir);
  assert.deepStrictEqual(secondState.documents, ['architecture.md', 'modules.md']);
  assert.ok(!Object.hasOwn(secondState.hashes, 'obsolete.md'));
  assert.strictEqual(secondState.schemaVersion, 1);
  assert.strictEqual(secondState.tool, 'codebase-mapper');
});

// SQ-317: graph mode used to be a two-step (writer, then a node -e re-apply of `structure`) because
// the writer rebuilt the state object and dropped the field. `--structure graphify` makes it one
// step, and a plain run now carries an existing declaration over instead of silently demoting a
// graph-mode map to classic.
test('--structure graphify records the field, and a later plain run preserves it', () => {
  const { projectDir, mapDir } = fixtureProject();

  assert.match(writeState(projectDir, '--structure', 'graphify'), /Structure: graphify\./);
  const declared = assertStateMatchesDocuments(mapDir);
  assert.strictEqual(declared.structure, 'graphify');

  // The refresh a later session runs has no flag, and must not demote the map.
  writeState(projectDir);
  assert.strictEqual(readState(mapDir).structure, 'graphify');

  // An unknown value a newer plugin wrote survives an older writer too.
  fs.writeFileSync(
    path.join(mapDir, '.map-state.json'),
    JSON.stringify({ ...readState(mapDir), structure: 'future-owner' }, null, 2) + '\n',
  );
  writeState(projectDir);
  assert.strictEqual(readState(mapDir).structure, 'future-owner');
});

test('a classic map stays structure-free, and a corrupt manifest is not a blocker', () => {
  const { projectDir, mapDir } = fixtureProject();

  assert.doesNotMatch(writeState(projectDir), /Structure:/);
  assert.ok(!Object.hasOwn(readState(mapDir), 'structure'));

  // A non-string, non-object or unreadable prior field is ignored rather than copied through.
  for (const prior of ['not json at all', JSON.stringify({ structure: 7 }), JSON.stringify(['graphify'])]) {
    fs.writeFileSync(path.join(mapDir, '.map-state.json'), prior);
    writeState(projectDir);
    assert.ok(!Object.hasOwn(readState(mapDir), 'structure'), `prior manifest ${prior} must not set structure`);
  }
});

test('--structure refuses any other value loudly and leaves the manifest untouched', () => {
  const { projectDir, mapDir } = fixtureProject();
  writeState(projectDir, '--structure', 'graphify');
  const before = fs.readFileSync(path.join(mapDir, '.map-state.json'), 'utf8');

  const typo = writeStateFailure(projectDir, '--structure', 'graphyfy');
  assert.strictEqual(typo.status, 1);
  assert.match(typo.stderr, /--structure accepts only "graphify", got "graphyfy"\./);

  const missing = writeStateFailure(projectDir, '--structure');
  assert.strictEqual(missing.status, 1);
  assert.match(missing.stderr, /--structure needs a value \(only "graphify" is valid\)\./);

  assert.strictEqual(fs.readFileSync(path.join(mapDir, '.map-state.json'), 'utf8'), before);
});

test('write-map-state records the current commit in a git project', () => {
  const { projectDir, mapDir } = fixtureProject();
  const git = (args) => childProcess.execFileSync('git', args, { cwd: projectDir, encoding: 'utf8', windowsHide: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Map test']);
  git(['config', 'user.email', 'map-test@example.test']);
  git(['add', '.']);
  git(['commit', '-m', 'Map fixture']);
  const commit = git(['rev-parse', 'HEAD']).trim();

  writeState(projectDir);
  assert.strictEqual(assertStateMatchesDocuments(mapDir).gitCommit, commit);
});
