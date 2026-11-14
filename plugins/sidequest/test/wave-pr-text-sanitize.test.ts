import test from 'node:test';
import assert from 'node:assert/strict';

// SQ-398: the wave PR title and body must never carry a local absolute path,
// whatever character it is glued to. PR_LOCAL_PATH_RE used to require the path
// to start the text or follow whitespace, a quote or a paren, so a title like
// `fix: preserve=/Users/alice/private` published the path to a public repo.
// These are pure text builders, and what they return is exactly what
// `gh pr create` is handed, so they are tested directly.
const { githubText, wavePullRequestText } = require('../src/lib/store/submissions');

// Deliberately empty: with no project root to split on, the regex is the only
// thing that can remove a path, so every leak case below pins the regex.
const NO_REPO = '';
const REPO_ROOT = '/Users/alice/Code/loadout';

// Each case is a path glued to a preceding character the old pattern refused.
const LEAKS: Array<{ label: string; input: string; secrets: string[] }> = [
  { label: 'after =', input: 'fix: preserve=/Users/alice/private', secrets: ['/Users/alice', 'alice'] },
  { label: 'after :', input: 'fix: note:/Users/alice/private/key.txt', secrets: ['/Users/alice', 'key.txt'] },
  { label: 'after ,', input: 'chore: tidy,/Users/alice/private/cache', secrets: ['/Users/alice', 'cache'] },
  { label: 'after [', input: 'fix: [/Users/alice/private/key] rotation', secrets: ['/Users/alice', 'alice'] },
  { label: 'after |', input: 'fix: pipe|/Users/alice/private/key', secrets: ['/Users/alice', 'alice'] },
  { label: 'after <', input: 'fix: angle</Users/alice/private/key>', secrets: ['/Users/alice', 'alice'] },
  { label: 'tilde home path', input: 'docs: write ~/Documents/private/notes.md', secrets: ['~/Documents', 'Documents'] },
  { label: 'start of text', input: '/Users/alice/private/x needs care', secrets: ['/Users/alice', 'alice'] },
  { label: 'windows drive after =', input: 'chore: drive=C:\\Users\\alice\\private\\key.txt', secrets: ['C:\\Users', 'alice'] },
];

for (const leak of LEAKS) {
  test(`githubText strips a local path ${leak.label}`, () => {
    const out = githubText(leak.input, NO_REPO);
    assert.ok(out.includes('[path]'), `expected a [path] placeholder, got ${JSON.stringify(out)}`);
    for (const secret of leak.secrets) {
      assert.ok(!out.includes(secret), `expected ${JSON.stringify(secret)} to be stripped, got ${JSON.stringify(out)}`);
    }
  });
}

// Things that merely look like paths. Sanitizing is not licence to mangle them.
const SURVIVORS: string[] = [
  'docs: see https://example.com/a/b for details',
  'docs: see http://example.com/a/b/c',
  'fix: guard plugins/sidequest/src/lib/store/submissions.ts',
  'feat(sidequest): add a thing',
  'feat(sidequest/store): nested conventional scope',
  'chore: bump 1/2 of the deps on 2026/11/13',
];

for (const survivor of SURVIVORS) {
  test(`githubText leaves non-local text unchanged: ${survivor}`, () => {
    assert.equal(githubText(survivor, NO_REPO), survivor);
  });
}

// A dotted relative path survives as a path. The space before its leading dot
// is eaten by the long-standing "no space before punctuation" collapse, which
// is unrelated to path stripping, so this case is asserted on the paths.
test('githubText leaves dotted relative paths intact', () => {
  const out = githubText('docs: relative ./scripts/build.mjs and ../other/file.ts', NO_REPO);
  assert.ok(out.includes('./scripts/build.mjs'), `mangled a relative path: ${JSON.stringify(out)}`);
  assert.ok(out.includes('../other/file.ts'), `mangled a parent-relative path: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('[path]'), `wrongly stripped a relative path: ${JSON.stringify(out)}`);
});

test('githubText still collapses a path under the project root', () => {
  const out = githubText(`fix: touch ${REPO_ROOT}/plugins/sidequest/src/x.ts`, REPO_ROOT);
  assert.equal(out, 'fix: touch [path]');
});

test('the wave PR title and body carry no glued local path', () => {
  const tickets = [
    { title: 'fix: preserve=/Users/alice/private/key.txt in the cache' },
    { title: 'chore: move ~/Documents/private/notes.md out of the tree' },
  ];
  const { title, body } = wavePullRequestText(NO_REPO, tickets);
  for (const text of [title, body]) {
    assert.ok(!text.includes('/Users/alice'), `leaked a posix path: ${JSON.stringify(text)}`);
    assert.ok(!text.includes('~/Documents'), `leaked a home path: ${JSON.stringify(text)}`);
    assert.ok(!text.includes('alice'), `leaked a user name: ${JSON.stringify(text)}`);
  }
  assert.ok(title.startsWith('fix: preserve=[path]'), `unexpected title ${JSON.stringify(title)}`);
  assert.ok(body.includes('- chore: move [path]'), `unexpected body ${JSON.stringify(body)}`);
});

test('the wave PR body keeps a URL intact', () => {
  const { body } = wavePullRequestText(NO_REPO, [{ title: 'docs: link https://example.com/a/b' }]);
  assert.ok(body.includes('docs: link https://example.com/a/b'), `mangled a URL: ${JSON.stringify(body)}`);
});
