'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  CACHE_MAX_AGE_MS,
  cacheFile,
  cacheIsCurrent,
  readCache,
  refreshCache,
} = require('../hooks/marketplace-freshness-cache.js');

function environmentFor(home) {
  return { CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
}

test('writes the freshness cache under CLAUDE_CONFIG_DIR rather than the home tree', async (t) => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-freshness-home-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-freshness-config-'));
  const originalHomedir = os.homedir;
  t.after(() => {
    os.homedir = originalHomedir;
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });
  os.homedir = () => fakeHome;
  const environment = { CLAUDE_CONFIG_DIR: configDir };

  await refreshCache({
    environment,
    now: 1_000,
    requestManifest: async () => ({ plugins: [] }),
  });

  assert.equal(cacheFile(environment), path.join(configDir, 'loadout', 'marketplace-freshness.json'));
  assert.ok(fs.existsSync(cacheFile(environment)));
  assert.equal(fs.existsSync(path.join(fakeHome, '.claude', 'loadout', 'marketplace-freshness.json')), false);
});

test('refreshes a stale cache with the remote marketplace manifest', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-freshness-'));
  try {
    const manifest = { plugins: [{ name: 'sidequest', version: '4.35.0' }] };
    const cache = await refreshCache({
      environment: environmentFor(home),
      now: 1_000,
      requestManifest: async () => manifest,
    });
    assert.deepEqual(cache.manifest, manifest);
    assert.deepEqual(readCache(fs, environmentFor(home)).manifest, manifest);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('keeps a current cache without another remote request', async () => {
  const cache = {
    checkedAt: new Date(1_000).toISOString(),
    manifest: { plugins: [] },
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-freshness-'));
  try {
    const result = await refreshCache({
      environment: environmentFor(home),
      now: 1_001,
      requestManifest: async () => { throw new Error('must not request'); },
      fileSystem: {
        ...fs,
        readFileSync: () => JSON.stringify(cache),
      },
    });
    assert.deepEqual(result, cache);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('records a failed remote request as unavailable for the cache lifetime', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-freshness-'));
  try {
    const cache = await refreshCache({
      environment: environmentFor(home),
      now: 1_000,
      requestManifest: async () => { throw new Error('offline'); },
    });
    assert.equal(cache.unavailable, true);
    assert.equal(cache.manifest, undefined);
    assert.equal(cacheIsCurrent(cache, 1_000 + CACHE_MAX_AGE_MS - 1), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
