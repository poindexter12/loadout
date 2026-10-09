'use strict';
/**
 * Pinned conformance table for `paths:` matching (SQ-292).
 *
 * `paths:` is native Claude Code's scope key, so live-rules and native read the
 * same field out of the same file and each decide for themselves which files it
 * covers. Where the two disagree, a rule is still delivered by native; what
 * changes is whether live-rules re-grounds it at edit time. So a disagreement
 * costs salience, never correctness, which is why these semantics are pinned
 * here as a table rather than inferred at runtime.
 *
 * Where native's behavior is known, this table follows it: comma-separated
 * scalars split into several patterns. Where native's behavior is not verified
 * from its implementation, the chosen behavior is recorded in the table with a
 * reason, and in the US-6 story log as a DECISION. The two deliberate choices:
 *
 *   1. DOTFILES MATCH. A leading dot is an ordinary character, so `*.md`
 *      matches `.hidden.md` and `**` descends into `.claude/`. Minimatch-family
 *      globbers exclude dotfiles unless asked; this repo's rules are mostly
 *      ABOUT dotfile trees (.claude/, .github/, .release/), so excluding them
 *      would silently scope those rules to nothing.
 *   2. SLASH-FREE PATTERNS MATCH THE BASENAME AT ANY DEPTH, gitignore-style:
 *      `*.sql` covers `db/migrations/001.sql`. A pattern containing a slash is
 *      anchored to the repo-relative path instead. Without this, the single
 *      most common rule a user writes (`paths: *.ts`) would match only files in
 *      the repo root.
 *
 * Run: node --test plugins/live-rules/test/matcher-conformance.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const rules = require('../hooks/lib/rules.js');

/* ------------------------------------------------------------------ *
 *  How a `paths:` frontmatter value becomes a list of patterns
 * ------------------------------------------------------------------ */

// [frontmatter value, expected pattern list, why]
const SPLIT_TABLE = [
  ['src/**/*.ts', ['src/**/*.ts'], 'a single scalar is one pattern'],
  [
    'src/**/*.ts, test/**/*.ts',
    ['src/**/*.ts', 'test/**/*.ts'],
    'native splits a comma-separated scalar; whitespace around the comma is trimmed',
  ],
  ['a.ts,b.ts', ['a.ts', 'b.ts'], 'no whitespace is required around the comma'],
  [
    '**/*.{ts,tsx}',
    ['**/*.{ts,tsx}'],
    'a comma INSIDE brace expansion is part of the pattern, not a separator',
  ],
  [
    'src/**/*.{js,jsx}, test/**/*.ts',
    ['src/**/*.{js,jsx}', 'test/**/*.ts'],
    'brace commas and separator commas coexist in one scalar',
  ],
  [['a.ts', 'b.ts'], ['a.ts', 'b.ts'], 'a YAML list is already split and passes through'],
  [
    ['**/*.{ts,tsx}'],
    ['**/*.{ts,tsx}'],
    'a list element is never comma-split, so brace expansion survives',
  ],
  ['  a.ts ,, b.ts  ', ['a.ts', 'b.ts'], 'empty entries from a stray comma are dropped'],
  ['', [], 'an empty value is no scope at all, which makes the rule always-on'],
];

for (const [value, expected, why] of SPLIT_TABLE) {
  test('paths split: ' + JSON.stringify(value) + ' -> ' + JSON.stringify(expected) + ' (' + why + ')', () => {
    assert.deepStrictEqual(rules.toPatternList(value), expected);
    // The same split must hold through buildRule, which is what the hooks use.
    assert.deepStrictEqual(rules.buildRule('t.md', { paths: value }, 'Body.').paths, expected);
  });
}

/* ------------------------------------------------------------------ *
 *  Which files a single `paths:` pattern covers
 * ------------------------------------------------------------------ */

// [pattern, repo-relative path, matches?, why]
const MATCH_TABLE = [
  // --- slash-free patterns: basename at any depth (gitignore-style) ---
  ['*.sql', 'schema.sql', true, 'root-level basename match'],
  ['*.sql', 'db/migrations/001.sql', true, 'slash-free pattern matches the basename at any depth'],
  ['*.sql', 'db/migrations/001.sql.bak', false, 'the basename must match the whole pattern'],
  ['Makefile', 'build/Makefile', true, 'a slash-free literal matches that filename at any depth'],
  ['*.ts', 'src/a.tsx', false, 'the extension is matched exactly, not as a prefix'],

  // --- patterns containing a slash: anchored to the repo-relative path ---
  ['src/*.js', 'src/a.js', true, 'anchored match at the declared depth'],
  ['src/*.js', 'src/nested/a.js', false, 'a single * does not cross a path separator'],
  ['src/*.js', 'deep/src/a.js', false, 'a slash-bearing pattern is NOT basename-matched at depth'],
  ['src/**/*.js', 'src/nested/deep/a.js', true, '** spans any number of directories'],
  ['src/**/*.js', 'src/a.js', true, '** also spans zero directories'],
  ['/src/*.js', 'src/a.js', true, 'a leading slash is the gitignore root anchor and is a no-op here'],
  ['./src/*.js', 'src/a.js', true, 'a leading "./" is stripped the same way'],
  ['src\\*.js', 'src/a.js', true, 'a Windows-style backslash pattern matches a forward-slash path'],

  // --- brace expansion ---
  ['**/*.{ts,tsx}', 'src/a.tsx', true, 'brace alternation, nested'],
  ['**/*.{ts,tsx}', 'a.ts', true, 'brace alternation, repo root'],
  ['**/*.{ts,tsx}', 'a.js', false, 'an extension outside the alternation does not match'],

  // --- dotfiles: DECISION, a leading dot is an ordinary character ---
  ['*.md', '.hidden.md', true, 'DECISION: * matches a leading dot'],
  ['*', '.env', true, 'DECISION: a bare * matches a dotfile'],
  ['.claude/**', '.claude/rules/a.md', true, 'a dotted directory is matched literally'],
  ['**/*.yml', '.github/workflows/test.yml', true, 'DECISION: ** descends into a dotted directory'],
  ['**/*.md', '.claude/rules/a.md', true, 'the common case this decision exists for'],

  // --- directory-style patterns: no metacharacters, or a trailing slash ---
  ['packages/api', 'packages/api/src/a.ts', true, 'a metacharacter-free pattern scopes the whole subtree'],
  ['packages/api', 'packages/api', true, 'and the directory path itself'],
  ['packages/api/', 'packages/api/src/a.ts', true, 'a trailing slash is explicitly directory-style'],
  ['packages/api', 'packages/apix/a.ts', false, 'a sibling sharing the prefix text is not inside it'],
  ['packages/api', 'packages/web/a.ts', false, 'an unrelated sibling does not match'],
  ['src', 'src/deep/nested/a.ts', true, 'a single-segment directory still scopes its whole subtree'],
  [
    'packages/*/src',
    'packages/api/src/a.ts',
    false,
    'a pattern with a metacharacter is a file pattern, so it is not treated as a directory prefix',
  ],
];

for (const [pattern, file, expected, why] of MATCH_TABLE) {
  test(
    'paths match: "' + pattern + '" vs "' + file + '" -> ' + expected + ' (' + why + ')',
    () => {
      assert.strictEqual(rules.pathPatternMatchesFile(pattern, file), expected);
      // selectForEdit is the only consumer of this predicate, so pin it there too.
      const rule = rules.buildRule('t.md', { paths: [pattern] }, 'Body.');
      assert.strictEqual(rules.selectForEdit([rule], file).length, expected ? 1 : 0);
    }
  );
}

/* ------------------------------------------------------------------ *
 *  Which patterns can select on the session's working directory
 * ------------------------------------------------------------------ */

// Only directory-style patterns select on cwd. This is what stops the retired
// `dirs:` key from widening the prompt hook when it folded into `paths:`.
const CWD_TABLE = [
  ['packages/api', 'packages/api/src', true, 'cwd inside a directory-style pattern'],
  ['packages/api', 'packages/api', true, 'cwd is the directory itself'],
  ['packages/api/', 'packages/api/src', true, 'trailing slash is directory-style'],
  ['packages/api', 'packages/web', false, 'cwd in a sibling directory'],
  ['packages/api', '', false, 'the repo root is not inside a named subdirectory'],
  ['packages/api/**/*.ts', 'packages/api/src', false, 'a file pattern never selects on cwd'],
  ['*.ts', 'src', false, 'a slash-free file pattern never selects on cwd'],
  ['', 'anywhere/at/all', true, 'an empty pattern is the repo root, which contains every cwd'],
];

for (const [pattern, cwdRel, expected, why] of CWD_TABLE) {
  test('cwd match: "' + pattern + '" vs cwd "' + cwdRel + '" -> ' + expected + ' (' + why + ')', () => {
    assert.strictEqual(rules.pathPatternMatchesDir(pattern, cwdRel), expected);
  });
}

/* ------------------------------------------------------------------ *
 *  The split and the match compose
 * ------------------------------------------------------------------ */

test('a comma-separated scalar scopes every pattern it names', () => {
  const rule = rules.buildRule('t.md', { paths: 'src/**/*.ts, docs/**/*.md' }, 'Body.');
  assert.strictEqual(rules.selectForEdit([rule], 'src/a.ts').length, 1);
  assert.strictEqual(rules.selectForEdit([rule], 'docs/guide.md').length, 1);
  assert.strictEqual(rules.selectForEdit([rule], 'src/a.js').length, 0);
});

test('the matched pattern is reported as the label, so the model is told why a rule applied', () => {
  const rule = rules.buildRule('t.md', { paths: 'a/**/*.ts, b/**/*.ts' }, 'Body.');
  assert.strictEqual(rules.selectForEdit([rule], 'b/x.ts')[0].label, 'b/**/*.ts');
});

test('a rule with no paths and no prompt is always-on, not scoped to nothing', () => {
  const rule = rules.buildRule('t.md', { description: 'Global' }, 'Body.');
  assert.ok(rules.isAlways(rule));
  // An always-on rule is carried by the prompt hook, never by the edit hook.
  assert.strictEqual(rules.selectForEdit([rule], 'anything.ts').length, 0);
  assert.strictEqual(rules.selectForPrompt([rule], { promptText: '', cwdRel: '' }).length, 1);
});
