'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { legacyDataDir, resolveDefaultDataDir } = require('../lib/observability/data-dir.js');

function temporaryHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-data-dir-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('OBSERVABILITY_HOME overrides the data dir verbatim, without migration', (t) => {
  const home = temporaryHome(t);
  const override = path.join(home, 'elsewhere');
  const legacy = path.join(home, 'appdata', 'Eigenwise', 'Workbench');
  fs.mkdirSync(legacy, { recursive: true });
  const resolved = resolveDefaultDataDir({ OBSERVABILITY_HOME: override, LOCALAPPDATA: path.join(home, 'appdata') }, home);
  assert.equal(resolved, override);
  assert.equal(fs.existsSync(legacy), true);
});

test('resolves ~/.claude/observability when no legacy directory exists', (t) => {
  const home = temporaryHome(t);
  const resolved = resolveDefaultDataDir({ LOCALAPPDATA: path.join(home, 'appdata') }, home);
  assert.equal(resolved, path.join(home, '.claude', 'observability'));
});

test('migrates a legacy Eigenwise/Workbench directory into ~/.claude/observability once', (t) => {
  const home = temporaryHome(t);
  const environment = { LOCALAPPDATA: path.join(home, 'appdata') };
  const legacy = legacyDataDir(environment);
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'observability.db'), 'db-bytes');

  const target = path.join(home, '.claude', 'observability');
  assert.equal(resolveDefaultDataDir(environment, home), target);
  assert.equal(fs.readFileSync(path.join(target, 'observability.db'), 'utf8'), 'db-bytes');
  assert.equal(fs.existsSync(legacy), false);

  // Second resolve is a no-op even if a stale legacy directory reappears.
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'stale.txt'), 'stale');
  assert.equal(resolveDefaultDataDir(environment, home), target);
  assert.equal(fs.existsSync(path.join(target, 'stale.txt')), false);
});
