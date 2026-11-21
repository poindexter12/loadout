'use strict';

// SQ-428: an executor worktree is created without node_modules, so a pinned verifier such as
// `npm --prefix plugins/sidequest run typecheck` used to run and fail inside the package's
// scripts (`tsx: not found`, `vitest: command not found`), which read like a code defect. The
// shared process port now refuses before running with a toolchain_missing "Dependencies are not
// installed" verdict that names the package and the install command.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runProcessVerification } = require('../lib/ports/process.js');
const { runVerifyCapture } = require('../lib/verify-capture.js');

// Loaded lazily so the behavioural tests above it still run (and fail on their assertions)
// against a build that predates the preflight module.
function preflight() {
  return require('../lib/ports/dependency-preflight.js');
}

const requirement = Object.freeze({ kind: 'command', command: 'unused', evidenceContract: 'command output' });

function fixtureRoot(t: any): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-428-deps-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// A package whose script would write a marker file if it ran. It declares a dependency, as every
// real plugin package here does, and has a lockfile so the suggested install is `npm ci`.
function writePackage(root: string, relative: string, options: { dependencies?: boolean; installed?: boolean } = {}): string {
  const directory = path.join(root, relative);
  fs.mkdirSync(directory, { recursive: true });
  const dependencies = options.dependencies !== false;
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    name: path.basename(directory),
    private: true,
    scripts: { check: "node -e \"require('fs').writeFileSync('ran', '1')\"", test: "node -e \"require('fs').writeFileSync('ran', '1')\"" },
    ...(dependencies ? { devDependencies: { 'sq-428-dependency': '1.0.0' } } : {}),
  }));
  fs.writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify({ name: path.basename(directory), lockfileVersion: 3, packages: {} }));
  if (options.installed) {
    fs.mkdirSync(path.join(directory, 'node_modules', 'sq-428-dependency'), { recursive: true });
  }
  return directory;
}

function removeLog(result: any) {
  if (result?.logPath) fs.rmSync(result.logPath, { force: true });
}

test('SQ-428 a verifier whose package has no installed dependencies is refused as toolchain_missing before it runs', (t: any) => {
  const root = fixtureRoot(t);
  const directory = writePackage(root, 'plugins/widget');
  const command = 'npm --prefix plugins/widget run check';
  const result = runProcessVerification({ ...requirement, command }, { cwd: root });
  t.after(() => removeLog(result));
  assert.strictEqual(result.status, 'toolchain_missing');
  assert.deepStrictEqual([...result.failureIdentities], ['toolchain_missing:dependencies-not-installed']);
  assert.match(result.evidence, /Dependencies are not installed: plugins\/widget declares dependencies but has no node_modules/);
  assert.match(result.evidence, /no candidate was judged/);
  assert.match(result.evidence, /`npm --prefix plugins\/widget ci`/);
  assert.match(result.evidence, /worktreeSetup or worktreeDependencyPaths/);
  assert.strictEqual(fs.existsSync(path.join(directory, 'ran')), false, 'the script must not run');
  assert.match(fs.readFileSync(result.logPath, 'utf8'), /Dependencies are not installed/);
});

test('SQ-428 the verify-capture wrapper reports the dependency refusal as its reason', async (t: any) => {
  const root = fixtureRoot(t);
  writePackage(root, 'plugins/widget/dashboard');
  const capture = await runVerifyCapture('npm --prefix plugins/widget/dashboard test', root);
  t.after(() => removeLog(capture));
  assert.strictEqual(capture.status, 'toolchain_missing');
  assert.match(String(capture.reason), /Dependencies are not installed: plugins\/widget\/dashboard/);
});

test('SQ-428 an installed package runs normally', (t: any) => {
  const root = fixtureRoot(t);
  const directory = writePackage(root, 'plugins/widget', { installed: true });
  const result = runProcessVerification({ ...requirement, command: 'npm --prefix plugins/widget run check' }, { cwd: root });
  t.after(() => removeLog(result));
  assert.strictEqual(result.status, 'passed');
  assert.strictEqual(fs.existsSync(path.join(directory, 'ran')), true);
});

test('SQ-428 dependencyPreflight:false runs the command regardless', (t: any) => {
  const root = fixtureRoot(t);
  const directory = writePackage(root, 'plugins/widget');
  const result = runProcessVerification({ ...requirement, command: 'npm --prefix plugins/widget run check' }, { cwd: root, dependencyPreflight: false });
  t.after(() => removeLog(result));
  assert.strictEqual(result.status, 'passed');
  assert.strictEqual(fs.existsSync(path.join(directory, 'ran')), true);
});

test('SQ-428 preflight resolves the package a command targets', (t: any) => {
  const root = fixtureRoot(t);
  writePackage(root, 'plugins/widget');
  writePackage(root, 'plugins/widget/dashboard');
  writePackage(root, 'plugins/plain', { dependencies: false });
  const missing = (command: string) => preflight().packagesMissingDependencies(command, root).map((entry: any) => entry.relativeDirectory);

  assert.deepStrictEqual(missing('npm --prefix plugins/widget run typecheck && npm --prefix plugins/widget run build:check'), ['plugins/widget']);
  assert.deepStrictEqual(missing('npm --prefix=plugins/widget/dashboard test'), ['plugins/widget/dashboard']);
  assert.deepStrictEqual(missing('cd plugins/widget && npm test'), ['plugins/widget']);
  assert.deepStrictEqual(missing('npm run check 2>&1 | tail -5'), []);
  assert.deepStrictEqual(missing('cd plugins/widget/dashboard && npm run check'), ['plugins/widget/dashboard']);
  assert.deepStrictEqual(missing('npm --prefix plugins/widget run check && npm --prefix plugins/widget/dashboard test'), ['plugins/widget', 'plugins/widget/dashboard']);
  assert.deepStrictEqual(missing('pnpm --dir plugins/widget test'), ['plugins/widget']);
  assert.deepStrictEqual(missing('yarn --cwd plugins/widget run check'), ['plugins/widget']);

  // Not refused: no declared dependencies, no package script, a non-literal target, or a command
  // that installs dependencies itself (a named suite's `npm ci`).
  assert.deepStrictEqual(missing('npm --prefix plugins/plain run check'), []);
  assert.deepStrictEqual(missing('node --test plugins/widget/test/*.test.js'), []);
  assert.deepStrictEqual(missing('npm --prefix "$PLUGIN" test'), []);
  assert.deepStrictEqual(missing('cd plugins/widget && npm ci && npm run test:full'), []);
  assert.strictEqual(preflight().commandProvisionsDependencies('npm --prefix plugins/widget install && npm --prefix plugins/widget test'), true);
  assert.strictEqual(preflight().commandProvisionsDependencies('npm --prefix plugins/widget test'), false);
});

test('SQ-428 a hoisted install at the verification root satisfies a nested package', (t: any) => {
  const root = fixtureRoot(t);
  writePackage(root, 'packages/app');
  fs.mkdirSync(path.join(root, 'node_modules', 'sq-428-dependency'), { recursive: true });
  assert.deepStrictEqual(preflight().packagesMissingDependencies('npm --prefix packages/app test', root), []);
});

test('SQ-428 the suggested install matches the package manager and lockfile', (t: any) => {
  const root = fixtureRoot(t);
  const directory = writePackage(root, 'plugins/widget');
  fs.rmSync(path.join(directory, 'package-lock.json'));
  const [npmEntry] = preflight().packagesMissingDependencies('npm --prefix plugins/widget test', root);
  assert.strictEqual(npmEntry.installCommand, 'npm --prefix plugins/widget install');
  const [pnpmEntry] = preflight().packagesMissingDependencies('pnpm -C plugins/widget test', root);
  assert.strictEqual(pnpmEntry.installCommand, 'pnpm --dir plugins/widget install --frozen-lockfile');
});
