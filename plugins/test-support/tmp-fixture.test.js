'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { tmpFixture } = require('./tmp-fixture.js');

test('tmpFixture creates and returns a canonical temporary directory', (t) => {
  const directory = tmpFixture('test-support-tmp-fixture-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  assert.ok(fs.statSync(directory).isDirectory());
  assert.equal(directory, fs.realpathSync(directory));
});

// The macOS default (`os.tmpdir()` reporting `/var`, child processes reporting
// `/private/var`) is what this helper exists for, but asserting canonicality alone
// cannot fail on a platform whose temporary root happens not to be a symlink. Point
// the temporary root at a symlink explicitly so the regression is observable
// everywhere `fs.symlinkSync` works.
test('tmpFixture resolves a symlinked temporary root to its real location', {
  skip: process.platform === 'win32' ? 'directory symlinks need elevation on Windows' : false,
}, (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'test-support-tmp-root-')));
  const realRoot = path.join(root, 'real');
  const linkedRoot = path.join(root, 'linked');
  fs.mkdirSync(realRoot);
  fs.symlinkSync(realRoot, linkedRoot, 'dir');

  const previousTmpdir = Object.hasOwn(process.env, 'TMPDIR') ? process.env.TMPDIR : undefined;
  process.env.TMPDIR = linkedRoot;
  t.after(() => {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.equal(os.tmpdir(), linkedRoot, 'expected os.tmpdir() to follow TMPDIR');

  const directory = tmpFixture('test-support-tmp-fixture-');

  assert.ok(fs.statSync(directory).isDirectory());
  assert.ok(
    directory.startsWith(realRoot + path.sep),
    `expected ${directory} under the real root ${realRoot}`,
  );
  assert.ok(
    !directory.startsWith(linkedRoot + path.sep),
    `expected ${directory} not to retain the symlinked root ${linkedRoot}`,
  );
});
