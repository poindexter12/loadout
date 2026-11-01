import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import './_temp-cleanup.js';

import {
  isPlanningDepthWarningsFixturePath,
  planningDepthWarningsFixtureParent,
} from './_fixture-provenance.js';
import {
  sandboxOwnedEnvironmentVariables,
  scrubInheritedSidequestEnvironment,
} from './_sidequest-test-env.js';

const pluginRoot = path.resolve(__dirname, '..');
const planningWarningsTest = path.join(pluginRoot, 'test', 'planning-depth-warnings.test.ts');
const testHomePreload = pathToFileURL(path.join(pluginRoot, 'test', '_sidequest-test-home.ts')).href;
const fixtureBoardPath = path.join(planningDepthWarningsFixtureParent, 'board');

function runPlanningWarningsSuite(sidequestHome: string, preloads: string[] = []) {
  return spawnSync(process.execPath, ['--import', 'tsx', ...preloads.flatMap((preload) => ['--import', preload]), '--test', planningWarningsTest], {
    cwd: pluginRoot,
    encoding: 'utf8',
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, SIDEQUEST_HOME: sidequestHome },
  });
}

function registerProject(sidequestHome: string, projectPath: string, projectName: string) {
  const result = spawnSync(process.execPath, ['-e', "require('./lib/store').ensureProject(process.env.SQ1976_PROJECT_PATH, process.env.SQ1976_PROJECT_NAME)"], {
    cwd: pluginRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      SIDEQUEST_HOME: sidequestHome,
      SQ1976_PROJECT_PATH: projectPath,
      SQ1976_PROJECT_NAME: projectName,
    },
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
}

function fixtureRegistrations(sidequestHome: string) {
  const database = new DatabaseSync(path.join(sidequestHome, 'sidequest.db'));
  const registrations = database.prepare("SELECT json_extract(data, '$.path') AS path FROM projects ORDER BY path").all() as Array<{ path: string }>;
  database.close();
  return registrations
    .filter(({ path: projectPath }) => isPlanningDepthWarningsFixturePath(projectPath))
    .map(({ path: projectPath }) => ({ path: projectPath }));
}

function registryBytes(directory: string) {
  const files = new Map<string, string>();
  function collect(currentDirectory: string, relativeDirectory = '') {
    for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = path.join(relativeDirectory, entry.name);
      const fullPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) collect(fullPath, relativePath);
      else if (entry.isFile()) files.set(relativePath, fs.readFileSync(fullPath).toString('base64'));
    }
  }
  collect(directory);
  return files;
}

test('test runner creates a Sidequest home before store imports', () => {
  assert.match(path.basename(String(process.env.SIDEQUEST_HOME)), /^sq-test-home-/);
});

test('SQ-389: the scrub removes every inherited SIDEQUEST_* knob and keeps the ones the sandbox owns', () => {
  const environment: Record<string, string | undefined> = {
    PATH: '/usr/bin',
    SIDEQUEST_HOME: '/live/home',
    SIDEQUEST_AGENTS_DIR: '/live/agents',
    SIDEQUEST_HOST_SLEEP_DETECTION: '0',
    SIDEQUEST_CLAUDE_HOME: '/live/claude',
    SIDEQUEST_DISCOVERY_DIRS: '/live/discovery',
    SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS: '5400000',
    SIDEQUEST_COMPACTION_POLICY: 'pin',
    SIDEQUEST_CLAIM_TTL_MIN: '5',
  };
  assert.deepStrictEqual(scrubInheritedSidequestEnvironment(environment), [
    'SIDEQUEST_CLAIM_TTL_MIN',
    'SIDEQUEST_COMPACTION_POLICY',
    'SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS',
  ]);
  assert.deepStrictEqual(Object.keys(environment).sort(), ['PATH', ...[...sandboxOwnedEnvironmentVariables].sort()]);
  assert.deepStrictEqual(scrubInheritedSidequestEnvironment(environment), []);
});

// SQ-389: the leak this exists to catch was an operator's widened release budget reaching the
// verify-capture the SQ-225 test spawns with `env: process.env`. Probing the preload's own
// process environment is the same inheritance the code under test sees, one spawn instead of
// a whole capture.
test('SQ-389: a process loaded through the test-home preload inherits no SIDEQUEST_* tuning override', () => {
  const inheritedClaudeHome = path.join(os.tmpdir(), 'sq-389-claude-home');
  const inheritedDiscoveryDirectory = path.join(os.tmpdir(), 'sq-389-discovery');
  const probe = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      testHomePreload,
      '-e',
      'process.stdout.write("SQ389:" + JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("SIDEQUEST_")))) + "\\n");',
    ],
    {
      cwd: pluginRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_TEST_CONTEXT: undefined,
        SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS: '5400000',
        SIDEQUEST_FULL_SUITE_SIBLING_CAPTURE_COUNT: '3',
        SIDEQUEST_CLAIM_TTL_MIN: '7',
        SIDEQUEST_CLAUDE_HOME: inheritedClaudeHome,
        SIDEQUEST_DISCOVERY_DIRS: inheritedDiscoveryDirectory,
      },
    },
  );
  assert.strictEqual(probe.status, 0, probe.stderr || probe.stdout);
  const reported = /^SQ389:(.*)$/m.exec(probe.stdout);
  assert.ok(reported, probe.stdout);
  const reportedEnvironment = String(reported[1]);
  const observed = JSON.parse(reportedEnvironment) as Record<string, string>;

  for (const leaked of ['SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS', 'SIDEQUEST_FULL_SUITE_SIBLING_CAPTURE_COUNT', 'SIDEQUEST_CLAIM_TTL_MIN']) {
    assert.ok(!(leaked in observed), `${leaked} reached the code under test: ${reportedEnvironment}`);
  }
  // The sandbox's own pins have to survive the scrub, or the suite loses its isolation.
  assert.match(path.basename(String(observed.SIDEQUEST_HOME)), /^sq-test-home-/);
  assert.match(path.basename(String(observed.SIDEQUEST_AGENTS_DIR)), /^sq-test-agents-/);
  assert.strictEqual(observed.SIDEQUEST_HOST_SLEEP_DETECTION, '0');
  assert.strictEqual(observed.SIDEQUEST_CLAUDE_HOME, inheritedClaudeHome);
  assert.strictEqual(observed.SIDEQUEST_DISCOVERY_DIRS, inheritedDiscoveryDirectory);
});

test('a test process without test-home preload registers a planning fixture, while the isolated suite preserves a live-registry sentinel', () => {
  const legacyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-1976-legacy-home-'));
  const liveHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-1976-live-home-'));
  const sentinelProject = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-1976-sentinel-project-'));

  try {
    registerProject(legacyHome, fixtureBoardPath, 'board');
    assert.deepStrictEqual(fixtureRegistrations(legacyHome), [{ path: fixtureBoardPath }]);

    registerProject(liveHome, sentinelProject, 'sentinel');
    const before = registryBytes(liveHome);
    const isolatedRun = runPlanningWarningsSuite(liveHome, [testHomePreload]);
    assert.strictEqual(isolatedRun.status, 0, isolatedRun.stderr || isolatedRun.stdout);
    assert.match(isolatedRun.stdout + isolatedRun.stderr, /complexity 4\+ add warns for empty executor context and file scope/);
    assert.deepStrictEqual(registryBytes(liveHome), before);
  } finally {
    for (const directory of [legacyHome, liveHome, sentinelProject]) {
      try {
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch {
        // _temp-cleanup retries Windows file locks after the test process exits.
      }
    }
  }
});
