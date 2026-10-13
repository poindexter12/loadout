import './_temp-cleanup.js';
'use strict';
/**
 * Ref minting against release history (SQ-32).
 *
 * A board ref and a release-fragment ref are two minters over one number space, and the counter
 * used to be a bare `meta.seq + 1` that knew nothing about either. v3.539.0 shipped fragment
 * refs SQ-21..SQ-25 that no board ticket ever owned, and this repo's board counter sits far
 * below the highest ref CHANGELOG.md already names, so minting blind eventually hands out a ref
 * that is already shipped history.
 *
 * These drive `createProjects` through its injected seam rather than the assembled store,
 * because `nextSeq` is a function of an exact `meta.seq` and `meta.refPrefix` and no public API
 * sets either. `fs` and `path` are the real ones, so the changelog and fragment scans under test
 * are the real scans.
 *
 * Run: cd plugins/sidequest && npm run test:files -- test/ref-mint.test.ts
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { createProjects, refPrefixOf } = require('../lib/store/projects.js');

const SLUG = 'board';

// Just enough store to run nextSeq: one in-memory project row standing in for the table.
function harness(meta: any) {
  let row = meta;
  const projects = createProjects({
    acquireLock: () => 'token',
    releaseLock: () => {},
    transaction: (fn: any) => fn(),
    projectDir: () => os.tmpdir(),
    residentCache: () => ({ metadata: new Map() }),
    cloneCached: (value: any) => (value ? JSON.parse(JSON.stringify(value)) : value),
    database: () => ({}),
    db: { getRow: () => row },
    putProject: (_slug: any, next: any) => { row = next; },
    fs,
    path,
  });
  return { projects, meta: () => row };
}

function repo(t: any, files: { changelog?: string; fragments?: string[] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-refmint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  if (typeof files.changelog === 'string') fs.writeFileSync(path.join(root, 'CHANGELOG.md'), files.changelog);
  if (files.fragments) {
    fs.mkdirSync(path.join(root, '.release', 'unreleased'), { recursive: true });
    for (const name of files.fragments) fs.writeFileSync(path.join(root, '.release', 'unreleased', name), '');
  }
  return root;
}

test('a mint steps over a ref the changelog already shipped', (t?: any) => {
  const root = repo(t, {
    changelog: '- Lean default board reads (SQ-1)\n- Fix the Bash path guard (SQ-2) [`cd759f1`](https://e.test/c)\n',
  });
  const { projects, meta } = harness({ path: root, seq: 0 });

  assert.strictEqual(projects.nextSeq(SLUG), 3, 'SQ-1 and SQ-2 are shipped, so the first mint is SQ-3');
  assert.strictEqual(meta().seq, 3, 'the skipped numbers are persisted, not re-walked on the next mint');
  assert.strictEqual(projects.nextSeq(SLUG), 4);
});

test('a mint steps over a ref sitting in the unreleased fragment queue', (t?: any) => {
  const root = repo(t, { fragments: ['SQ-1.md', 'SQ-2.md', 'US-1.md', 'notes.md'] });
  const { projects } = harness({ path: root, seq: 0 });

  // A queued fragment has not shipped yet, but its ref is spoken for: the cut will render it.
  assert.strictEqual(projects.nextSeq(SLUG), 3);
});

test('a shipped ref far above the counter does not drag the counter up to it', (t?: any) => {
  const root = repo(t, { changelog: '- Something old (SQ-900)\n' });

  // The decision on this ticket: skip forward at the mint, never floor to the maximum released
  // ref. Flooring here would jump the counter to 901 and abandon 894 refs that are free.
  assert.strictEqual(harness({ path: root, seq: 5 }).projects.nextSeq(SLUG), 6);

  // The skip only costs anything once the counter actually reaches the taken number.
  assert.strictEqual(harness({ path: root, seq: 899 }).projects.nextSeq(SLUG), 901);
});

test('only this board prefix counts toward the numbers a mint skips', (t?: any) => {
  const root = repo(t, {
    changelog: '- A story (US-5000)\n- Another board (ABC-5000)\n- Lowercase (sq-5000)\n',
    fragments: ['US-5001.md', 'ABC-5001.md'],
  });

  // An SQ board is not inflated by refs in another namespace, and an ABC board is not inflated
  // by SQ refs. Each board only steps over its own prefix.
  assert.strictEqual(harness({ path: root, seq: 4999 }).projects.nextSeq(SLUG), 5000);
  assert.strictEqual(harness({ path: root, seq: 4999, refPrefix: 'ABC' }).projects.nextSeq(SLUG), 5002);
  assert.strictEqual(harness({ path: root, seq: 4999, refPrefix: 'US' }).projects.nextSeq(SLUG), 5002);
});

test('a board that is not a release repo mints from its own counter and never throws', (t?: any) => {
  // Most boards are not repos at all, and a board that is one may have neither file.
  assert.strictEqual(harness({ seq: 7 }).projects.nextSeq(SLUG), 8, 'no meta.path');
  assert.strictEqual(harness({ path: 12345, seq: 7 }).projects.nextSeq(SLUG), 8, 'meta.path is not a string');
  assert.strictEqual(
    harness({ path: path.join(os.tmpdir(), 'sq-refmint-absent-dir'), seq: 7 }).projects.nextSeq(SLUG),
    8,
    'meta.path does not exist',
  );
  assert.strictEqual(harness({ path: repo(t), seq: 7 }).projects.nextSeq(SLUG), 8, 'a repo with neither file');

  // An unreadable changelog must degrade exactly like a missing one. A directory in its place is
  // the cheap way to make the read throw.
  const blocked = repo(t);
  fs.mkdirSync(path.join(blocked, 'CHANGELOG.md'));
  assert.strictEqual(harness({ path: blocked, seq: 7 }).projects.nextSeq(SLUG), 8, 'unreadable changelog');

  // A seq that is missing or the wrong type still starts at 1 rather than NaN.
  assert.strictEqual(harness({}).projects.nextSeq(SLUG), 1);
  assert.strictEqual(harness({ seq: 'nonsense' }).projects.nextSeq(SLUG), 1);
});

test('the counter only ever rises, even if release history shrinks', (t?: any) => {
  const root = repo(t, { changelog: '- Shipped (SQ-1)\n- Shipped (SQ-2)\n' });
  const { projects, meta } = harness({ path: root, seq: 0 });

  assert.strictEqual(projects.nextSeq(SLUG), 3);
  fs.rmSync(path.join(root, 'CHANGELOG.md'));

  // SQ-1 and SQ-2 are no longer named anywhere, but they were handed out: the counter does not
  // reel back and re-mint them.
  assert.strictEqual(projects.nextSeq(SLUG), 4);
  assert.strictEqual(meta().seq, 4);
});

test('a board with no refPrefix is grandfathered to SQ', () => {
  // Every board filed before this change has no refPrefix at all, so an absent, blank or
  // malformed value has to keep minting SQ-n. tickets.ts builds the ref through this same
  // helper, so a prefix it would reject must not reach a ref either.
  assert.strictEqual(refPrefixOf(undefined), 'SQ');
  assert.strictEqual(refPrefixOf(null), 'SQ');
  assert.strictEqual(refPrefixOf({}), 'SQ');
  assert.strictEqual(refPrefixOf({ refPrefix: '' }), 'SQ');
  assert.strictEqual(refPrefixOf({ refPrefix: '   ' }), 'SQ');
  assert.strictEqual(refPrefixOf({ refPrefix: 42 }), 'SQ');
  assert.strictEqual(refPrefixOf({ refPrefix: 'has space' }), 'SQ');
  assert.strictEqual(refPrefixOf({ refPrefix: '1ST' }), 'SQ', 'a ref prefix starts with a letter');
  assert.strictEqual(refPrefixOf({ refPrefix: 'A-B' }), 'SQ', 'the hyphen separates the number');

  assert.strictEqual(refPrefixOf({ refPrefix: 'ABC' }), 'ABC');
  assert.strictEqual(refPrefixOf({ refPrefix: 'abc' }), 'ABC', 'refs are uppercase');
  assert.strictEqual(refPrefixOf({ refPrefix: ' zz9 ' }), 'ZZ9');
});
