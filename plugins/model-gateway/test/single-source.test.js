'use strict';

// SQ-35: lib/commands.js used to carry private copies of request-worker.js's
// readiness helpers, shim health probe and dispatch-route parsing, plus its own
// STATE/route-log constants "in lockstep" with runtime.js. The copies drifted
// (a stale 2-arg upstreamErrorMessage, a dead DispatchSessionRouteCache that the
// tests exercised instead of the live one). These assertions pin one owner for
// each, so a reintroduced copy fails here instead of drifting silently.

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const commands = require(path.join(__dirname, '..', 'bin', 'model-gateway.js'));
const worker = require('../lib/request-worker.js');
const runtime = require('../lib/runtime.js');

const WORKER_OWNED = [
  'DispatchSessionRouteCache', 'dispatchModelFromRawBody', 'dispatchRouteFromMessages', 'servingShimVersion',
  'setUpstreamBlocked', 'clearUpstreamBlocked', 'noteCodexRequestSuccess', 'hasOpenAiRejectionEvidence',
  'noteCodexUpstreamRejection',
];

test('commands.js re-exports the request-worker copy, not a private duplicate', () => {
  for (const name of WORKER_OWNED) {
    assert.equal(typeof worker[name], 'function', `request-worker.js must export ${name}`);
    assert.strictEqual(commands[name], worker[name], `${name} must be the request-worker.js function itself`);
  }
});

test('runtime.js is the one owner of the state-path constants commands.js exports', () => {
  for (const name of ['WIRING_CONFIG_PATH', 'CODEX_UPSTREAM_BLOCK_PATH', 'PLUGIN_VERSION', 'MIN_PROXY_VERSION']) {
    assert.ok(runtime[name], `runtime.js must export ${name}`);
    assert.strictEqual(commands[name], runtime[name], `${name} must come from runtime.js`);
  }
});

test('commands.js no longer declares the shim request-path copies', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'commands.js'), 'utf8');
  for (const decl of [
    'class DispatchSessionRouteCache', 'function upstreamErrorMessage(', 'function sseErrorFrame(',
    'function buildRouteTelemetry(', 'function isCompactionRequest(', 'function readUpstreamBlocked(',
    'function fetchShimHealth(', 'const REQUEST_ROUTE_LOG_PATH =', 'const STATE =',
  ]) {
    assert.ok(!src.includes(decl), `lib/commands.js must not redeclare: ${decl}`);
  }
  // The catalog write/read shells run only from the CLI; the worker's copy was never called.
  const workerSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'request-worker.js'), 'utf8');
  for (const decl of ['function writeCatalog(', 'function writeCatalogFile(', 'function catalogCommand(', 'function readCatalog(']) {
    assert.ok(!workerSrc.includes(decl), `lib/request-worker.js must not redeclare: ${decl}`);
  }
});
