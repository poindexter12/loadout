'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const graphMode = require('../hooks/lib/graph-mode');
const mapDocuments = require('../hooks/lib/map-documents');
const plugin = require('../.claude-plugin/plugin.json');

function projectDirectory(args) {
  const index = args.indexOf('--project');
  if (index === -1) return process.cwd();
  if (!args[index + 1]) throw new Error('--project needs a directory path.');
  return path.resolve(args[index + 1]);
}

// US-7 / SQ-317: `--structure graphify` declares that graphify owns structure, so the retired
// structural documents being absent reads as the design rather than as drift. Only the one value
// the hooks accept is valid; anything else is a typo that would silently produce a manifest no hook
// recognizes, so refuse it loudly instead.
function structureArgument(args) {
  const index = args.indexOf('--structure');
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value) throw new Error('--structure needs a value (only "' + graphMode.GRAPH_STRUCTURE + '" is valid).');
  if (value !== graphMode.GRAPH_STRUCTURE) {
    throw new Error('--structure accepts only "' + graphMode.GRAPH_STRUCTURE + '", got "' + value + '".');
  }
  return value;
}

// Without the flag, carry the field over from the manifest on disk. A plain writer run must never
// silently demote a graph-mode map back to classic: the field is the only thing telling the hooks
// that modules.md, entry-points.md and directory-structure.md are absent on purpose. An unknown
// value is preserved too, so a newer plugin's manifest survives an older writer.
function existingStructure(statePath) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const structure = state && typeof state === 'object' && !Array.isArray(state) ? state.structure : null;
    return typeof structure === 'string' && structure ? structure : null;
  } catch (_) {
    return null;
  }
}

function documentNames(directory, relative = '') {
  const documents = [];
  for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) documents.push(...documentNames(directory, next));
    else if (entry.isFile() && mapDocuments.safeDocumentPath(next)) documents.push(next);
  }
  return documents;
}

function gitCommit(projectDir) {
  const result = childProcess.spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectDir,
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function writeMapState(projectDir, structure = null) {
  const directory = mapDocuments.mapDirectory(projectDir);
  const indexPath = path.join(directory, mapDocuments.INDEX_NAME);
  if (!fs.existsSync(indexPath)) throw new Error('Missing .claude/.codebase-info/INDEX.md.');

  const documents = documentNames(directory).filter((name) => name !== mapDocuments.INDEX_NAME).sort();
  const hashedDocuments = [mapDocuments.INDEX_NAME, ...documents];
  const hashes = Object.fromEntries(hashedDocuments.map((name) => [
    name,
    mapDocuments.hashContent(fs.readFileSync(path.join(directory, name), 'utf8')),
  ]));
  const statePath = path.join(directory, mapDocuments.STATE_NAME);
  const declaredStructure = structure || existingStructure(statePath);
  const state = {
    schemaVersion: 1,
    tool: 'codebase-mapper',
    version: plugin.version,
    mappedAt: new Date().toISOString().slice(0, 10),
    gitCommit: gitCommit(projectDir),
    ...(declaredStructure ? { structure: declaredStructure } : {}),
    documents,
    hashes,
  };
  const temporaryPath = `${statePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(temporaryPath, statePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
  return state;
}

try {
  const args = process.argv.slice(2);
  const state = writeMapState(projectDirectory(args), structureArgument(args));
  process.stdout.write(
    `Wrote map state for ${state.documents.length} document(s).` +
    (state.structure ? ` Structure: ${state.structure}.` : '') + '\n',
  );
} catch (error) {
  process.stderr.write(`codebase-mapper state write failed: ${error.message}\n`);
  process.exitCode = 1;
}

module.exports = { documentNames, existingStructure, gitCommit, projectDirectory, structureArgument, writeMapState };
