import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { buildFragment, main } from '../note.mjs';
import { releasedRefTitles } from '../lib/changelog.mjs';
import { UsageError } from '../lib/cli.mjs';
import { parseFragment } from '../lib/fragments.mjs';
import { readManifest } from '../lib/manifests.mjs';
import { diskSource } from '../lib/treesource.mjs';
import { makeRepo } from './helpers.mjs';

const PLUGINS = { 'codex-gateway': '0.33.4', sidequest: '3.6.49', toolbelt: '0.63.11' };

function setup(t, options = {}) {
  const repo = makeRepo({ plugins: PLUGINS, ...options });
  t.after(repo.cleanup);
  return { root: repo.root, manifest: readManifest(diskSource(repo.root), repo.root) };
}

test('a fragment is written in the format the reader accepts', (t) => {
  const { manifest } = setup(t);
  const { text, file, fragment } = buildFragment({
    manifest,
    input: { ref: 'SQ-843', title: 'Build the release engine', plugins: ['sidequest'], bump: 'minor', commit: 'c7b2702' },
  });

  assert.equal(file, '.release/unreleased/SQ-843.md');
  assert.equal(fragment.ref, 'SQ-843');
  assert.deepEqual(fragment.plugins, [{ name: 'sidequest', level: 'minor' }]);
  assert.match(text, /^ref: SQ-843$/m);
  assert.match(text, /^bump: minor$/m);
  assert.match(text, /^plugins: \[sidequest\]$/m);
  assert.deepEqual(parseFragment(file, text, { knownPlugins: manifest.plugins }).plugins, fragment.plugins);
});

test('plugins are inferred from the paths a ticket changed', (t) => {
  const { manifest } = setup(t);
  const { fragment } = buildFragment({
    manifest,
    input: {
      ref: 'SQ-1',
      title: 't',
      bump: 'patch',
      changed: [
        'plugins/sidequest/src/lib/board.ts',
        'plugins/sidequest/test/board.test.ts',
        'plugins\\toolbelt\\hooks\\freshness.js',
        'plugins/test-support/index.js',
        'docs/src/content/docs/x.md',
      ],
    },
  });
  assert.deepEqual(fragment.plugins.map((entry) => entry.name), ['sidequest', 'toolbelt'], 'unpublished plugins are not released');
});

test('a per-plugin level beats the fragment default', (t) => {
  const { manifest } = setup(t);
  const { fragment } = buildFragment({
    manifest,
    input: { ref: 'SQ-1', title: 't', plugins: ['sidequest', 'toolbelt'], bump: 'patch', levels: { sidequest: 'minor' } },
  });
  assert.deepEqual(fragment.plugins, [
    { name: 'sidequest', level: 'minor' },
    { name: 'toolbelt', level: 'patch' },
  ]);
});

test('a fragment with nothing to release is refused, not invented', (t) => {
  const { manifest } = setup(t);
  const cases = [
    [{ title: 't', plugins: ['sidequest'], bump: 'patch' }, /board ref is required/],
    [{ ref: 'SQ-1', title: 't', bump: 'patch', changed: ['docs/x.md'] }, /no plugins for SQ-1/],
    [{ ref: 'SQ-1', title: 't', plugins: ['sidequest'] }, /no bump level for sidequest/],
    [{ ref: 'SQ-1', plugins: ['sidequest'], bump: 'patch' }, /no title for SQ-1/],
    [{ ref: 'SQ-1', title: 't', plugins: ['ghost'], bump: 'patch' }, /not published/],
  ];
  for (const [input, pattern] of cases) {
    assert.throws(() => buildFragment({ manifest, input }), pattern, JSON.stringify(input));
  }
});

// One shipped window, written the way the renderer writes it: SQ-21 under two different titles
// (the repo's own history), SQ-1812 under one, and a ref in another prefix.
const SHIPPED = [
  '# Changelog',
  '',
  '## v4.0.0 (2026-07-25)',
  '',
  '### Fixes',
  '',
  '- Rename the gateway models (SQ-21) [`cd759f1`](https://example.test/c/cd759f1)',
  '- Retire Codegraph (SQ-1812)',
  '- Teach the story log to fold (US-7)',
  '',
  '## v3.539.0 (2026-07-20)',
  '',
  '### Fixes',
  '',
  '- Accept the Codex model ids (SQ-21)',
  '',
].join('\n');

function titlesFor(changelog = SHIPPED) {
  return releasedRefTitles(changelog);
}

test('a ref the changelog already shipped cannot be reused for different work', (t) => {
  const { manifest } = setup(t);
  const input = { ref: 'SQ-21', title: 'Totally unrelated new work reusing a shipped ref', plugins: ['sidequest'], bump: 'patch' };

  // T1/T5: SQ-21 shipped twice under two titles, and the refusal names both of them plus the
  // title being written, so the reader can see which work already owns the ref.
  let error = null;
  try {
    buildFragment({ manifest, input, releasedTitles: titlesFor() });
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error, 'reusing a shipped ref must be refused');
  // A UsageError is what runCli turns into exit 2, so this is the exit code as well as the type.
  assert.equal(error instanceof UsageError, true, 'a reused ref is a usage error, not a crash');
  assert.match(error.message, /already shipped in CHANGELOG\.md/);
  assert.match(error.message, /"Accept the Codex model ids"/);
  assert.match(error.message, /"Rename the gateway models"/);
  assert.match(error.message, /"Totally unrelated new work reusing a shipped ref"/);
  assert.match(error.message, /--allow-shipped-ref/, 'the refusal names its own override');

  // T6: the check is prefix-agnostic, because the ref grammar is.
  assert.throws(
    () => buildFragment({
      manifest,
      input: { ref: 'US-7', title: 'Different work', plugins: ['sidequest'], bump: 'patch' },
      releasedTitles: titlesFor(),
    }),
    /US-7 already shipped/,
  );
});

test('re-noting shipped work under its own title is still allowed', (t) => {
  const { manifest } = setup(t);
  const releasedTitles = titlesFor();

  // T2: an amend flow renders the same title again, which the cut then dedups by fingerprint.
  const amended = buildFragment({
    manifest,
    releasedTitles,
    input: { ref: 'SQ-1812', title: 'Retire Codegraph', plugins: ['sidequest'], bump: 'patch' },
  });
  assert.equal(amended.fragment.ref, 'SQ-1812');

  // T3: a ref that never shipped is untouched by any of this.
  assert.equal(
    buildFragment({
      manifest,
      releasedTitles,
      input: { ref: 'SQ-9001', title: 'Brand new work', plugins: ['sidequest'], bump: 'patch' },
    }).fragment.ref,
    'SQ-9001',
  );

  // T7: the override is explicit, and only the flag sets it.
  assert.equal(
    buildFragment({
      manifest,
      releasedTitles,
      input: { ref: 'SQ-21', title: 'Deliberate reuse', plugins: ['sidequest'], bump: 'patch', allowShippedRef: true },
    }).fragment.ref,
    'SQ-21',
  );

  // No changelog in hand means no check: the caller gets the old behavior, not a crash.
  assert.equal(
    buildFragment({
      manifest,
      input: { ref: 'SQ-21', title: 'Unrelated', plugins: ['sidequest'], bump: 'patch' },
    }).fragment.ref,
    'SQ-21',
  );
});

test('the CLI reads the repo changelog, so a dry run refuses a reused ref too', async (t) => {
  const context = setup(t, { changelog: SHIPPED });
  t.mock.method(console, 'log', () => {});

  // T4: the original defect was exactly this command exiting 0 on a shipped ref.
  await assert.rejects(
    () => main(['SQ-21', '--title', 'Unrelated work', '--plugins', 'sidequest', '--bump', 'patch', '--dry-run', '--repo', context.root]),
    /SQ-21 already shipped in CHANGELOG\.md/,
  );
  assert.equal(existsSync(path.join(context.root, '.release/unreleased/SQ-21.md')), false);

  assert.equal(
    await main(['SQ-21', '--title', 'Unrelated work', '--plugins', 'sidequest', '--bump', 'patch', '--allow-shipped-ref', '--repo', context.root]),
    0,
    '--allow-shipped-ref writes the fragment the refusal was holding back',
  );
  assert.equal(existsSync(path.join(context.root, '.release/unreleased/SQ-21.md')), true);

  // A repo with no changelog at all still notes fragments.
  const bare = setup(t);
  assert.equal(await main(['SQ-21', '--title', 'Unrelated work', '--plugins', 'sidequest', '--bump', 'patch', '--repo', bare.root]), 0);
});

test('a board export supplies the fields and the CLI overrides them', async (t) => {
  const context = setup(t);
  t.mock.method(console, 'log', () => {});

  const exportPath = path.join(context.root, 'ticket.json');
  writeFileSync(exportPath, JSON.stringify({
    ref: 'SQ-834',
    title: 'Harden shared-tree recovery',
    categoryId: 'coding.normal',
    submission: { commit: 'fdfdb8f3c049e962652970899998538bfcb882d2' },
    changedPaths: ['plugins/sidequest/src/lib/publish.ts'],
  }));

  assert.equal(await main(['--from-json', exportPath, '--bump', 'patch', '--repo', context.root]), 0);

  const written = readFileSync(path.join(context.root, '.release/unreleased/SQ-834.md'), 'utf8');
  const fragment = parseFragment('.release/unreleased/SQ-834.md', written, { knownPlugins: context.manifest.plugins });
  assert.equal(fragment.title, 'Harden shared-tree recovery');
  assert.equal(fragment.commit, 'fdfdb8f3c049e962652970899998538bfcb882d2');
  assert.equal(fragment.category, 'coding.normal');
  assert.deepEqual(fragment.plugins, [{ name: 'sidequest', level: 'patch' }]);

  await assert.rejects(
    () => main(['--from-json', exportPath, '--bump', 'patch', '--repo', context.root]),
    /already exists/,
  );
  assert.equal(await main(['--from-json', exportPath, '--bump', 'minor', '--repo', context.root, '--force']), 0);
  assert.match(readFileSync(path.join(context.root, '.release/unreleased/SQ-834.md'), 'utf8'), /^bump: minor$/m);
});

test('a dry run prints the fragment and writes nothing', async (t) => {
  const context = setup(t);
  const printed = [];
  t.mock.method(console, 'log', (line) => printed.push(line));

  await main(['SQ-9', '--title', 'A title', '--plugins', 'toolbelt', '--bump', 'patch', '--dry-run', '--repo', context.root]);

  assert.equal(existsSync(path.join(context.root, '.release/unreleased/SQ-9.md')), false);
  assert.match(printed.join('\n'), /^ref: SQ-9$/m);
});

test('a held fragment records that it is held', (t) => {
  const { manifest } = setup(t);
  const { text } = buildFragment({
    manifest,
    input: { ref: 'SQ-1', title: 't', plugins: ['sidequest'], bump: 'patch', hold: true, body: 'Waiting on the docs.' },
  });
  assert.match(text, /^hold: true$/m);
  assert.match(text, /Waiting on the docs\./);
});
