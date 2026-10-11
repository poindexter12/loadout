'use strict';

// US-7 decision 2: graph mode is DETECTED, never assumed and never created here. A project is in
// graph mode exactly when graphify has already written its report at <projectDir>/graphify-out/
// GRAPH_REPORT.md. Hooks only read: they never run graphify, never install it, and never build or
// refresh a graph. The map-codebase / update-codebase-map skills share this module so the hook and
// the skills can never disagree about which projects are in graph mode.
const fs = require('node:fs');
const path = require('node:path');

const GRAPH_DIR_NAME = 'graphify-out';
const GRAPH_REPORT_NAME = 'GRAPH_REPORT.md';

// US-7 decision 3: in graph mode graphify owns structure, so these three narrative documents are
// retired from the mapper's doc set. Everything else (dependencies.md included) stays LLM-authored.
const RETIRED_DOCUMENTS = Object.freeze(['modules.md', 'entry-points.md', 'directory-structure.md']);

// The value of .map-state.json's optional `structure` field that marks a state manifest as
// covering narrative documents only (US-7 decision 4: the freshness split).
const GRAPH_STRUCTURE = 'graphify';

function graphReportPath(projectDir) {
  return path.join(String(projectDir || ''), GRAPH_DIR_NAME, GRAPH_REPORT_NAME);
}

function isGraphMode(projectDir) {
  if (!projectDir) return false;
  try {
    return fs.statSync(graphReportPath(projectDir)).isFile();
  } catch (_) {
    return false;
  }
}

// True when a .map-state.json manifest declares that structure lives in graphify, so the retired
// documents being absent is expected rather than drift.
function stateDeclaresGraphStructure(state) {
  return Boolean(state) && typeof state === 'object' && !Array.isArray(state) && state.structure === GRAPH_STRUCTURE;
}

module.exports = {
  GRAPH_DIR_NAME,
  GRAPH_REPORT_NAME,
  GRAPH_STRUCTURE,
  RETIRED_DOCUMENTS,
  graphReportPath,
  isGraphMode,
  stateDeclaresGraphStructure,
};
