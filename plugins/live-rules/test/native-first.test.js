'use strict';
/**
 * Native-first behaviour (SQ-293).
 *
 * Native Claude Code reads .claude/rules/*.md itself, so anything it loads is
 * already in context and live-rules saying it again is pure duplication. These
 * tests pin the four things that follow:
 *
 *   1. no double-say. A rule native loads is never emitted by live-rules while
 *      its content is unchanged.
 *   2. a changed rule is emitted, once. That is the one thing native cannot
 *      notice: it has no idea the file it read has since been edited.
 *   3. a keyword rule is live-rules' alone to deliver, and the sentinel that
 *      keeps it out of native's global load matches no real path.
 *   4. `reground: true` re-says a rule on a cadence, and is off by default.
 *
 * Run: node --test plugins/live-rules/test/native-first.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const rules = require('../hooks/lib/rules');
const ledger = require('../hooks/lib/session-ledger');

const root = path.resolve(__dirname, '..');
const promptHook = path.join(root, 'hooks', 'inject-prompt-rules.js');
const editHook = path.join(root, 'hooks', 'inject-edit-rules.js');
const startHook = path.join(root, 'hooks', 'session-start-rules.js');

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-rules-nf-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

function seed(projectDir, files) {
  rules.seedRuleSet(
    projectDir,
    files.map(({ data, body }) => ({
      content:
        '---\n' +
        Object.entries(data)
          .map(([key, value]) => key + ': ' + (Array.isArray(value) ? JSON.stringify(value) : value))
          .join('\n') +
        '\n---\n' + body + '\n',
    }))
  );
}

function ruleFile(projectDir, name) {
  return path.join(projectDir, '.claude', 'rules', name);
}

function write(projectDir, name, frontmatter, body) {
  fs.writeFileSync(ruleFile(projectDir, name), '---\n' + frontmatter + '\n---\n' + body + '\n');
}

// ledgerPath() reads the state root from the environment, which only the hook
// child processes have set. Point it at the test's state dir for the duration
// of the call so nothing ever resolves to the real ~/.claude state.
function ledgerFile(projectDir, stateDir, sessionId) {
  const previous = process.env.LIVE_RULES_STATE_DIR;
  process.env.LIVE_RULES_STATE_DIR = stateDir;
  try {
    return ledger.ledgerPath(projectDir, sessionId);
  } finally {
    if (previous === undefined) delete process.env.LIVE_RULES_STATE_DIR;
    else process.env.LIVE_RULES_STATE_DIR = previous;
  }
}

function hook(script, projectDir, stateDir, data, env) {
  return execFileSync(process.execPath, [script], {
    cwd: projectDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, LIVE_RULES_STATE_DIR: stateDir, ...env },
    input: JSON.stringify({ cwd: projectDir, ...data }),
    encoding: 'utf8',
  });
}

/* ------------------------------------------------------------------ *
 *  1. No double-say
 * ------------------------------------------------------------------ */

test('a global rule native loads at session start is never emitted by live-rules', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'Always' }, body: 'NATIVE_LOADS_THIS.' }]);

  // Native read the file when the context began. Every hook must stay quiet
  // about it: SessionStart, and then every prompt for the rest of the session.
  assert.strictEqual(hook(startHook, dir, state, { session_id: 'one', source: 'startup' }), '');
  assert.strictEqual(hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' }), '');
  assert.strictEqual(hook(promptHook, dir, state, { session_id: 'one', prompt: 'again' }), '');
  assert.strictEqual(hook(promptHook, dir, state, { session_id: 'one', prompt: 'and again' }), '');
});

test('SessionStart records the hashes it stayed silent about', () => {
  // Silence is only safe if it still leaves live-rules able to detect a later
  // change, which means the hashes have to be on disk even though nothing was
  // emitted.
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'Always' }, body: 'Recorded.' }]);
  assert.strictEqual(hook(startHook, dir, state, { session_id: 'one', source: 'startup' }), '');

  const stored = JSON.parse(fs.readFileSync(ledgerFile(dir, state, 'one'), 'utf8'));
  assert.deepStrictEqual(Object.keys(stored.seen), ['.claude/rules/001.md']);
  assert.match(stored.seen['.claude/rules/001.md'], /^[0-9a-f]{8,}$/);
  assert.strictEqual(stored.grounded, true);
});

test('a path rule is silent on the touch that makes native load it', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'TypeScript', paths: ['src/**/*.ts'] }, body: 'NATIVE_LOADS_ON_TOUCH.' }]);
  const touch = { session_id: 'one', tool_input: { file_path: 'src/a.ts' } };

  assert.strictEqual(hook(editHook, dir, state, touch), '', 'first match is native\'s job');
  assert.strictEqual(hook(editHook, dir, state, touch), '', 'and it stays said');
});

test('a cwd-scoped path rule is silent at prompt time too', () => {
  // Native loads a `paths:` rule when a matching file is touched, so live-rules
  // pre-announcing it from the cwd would be the same double-say one step early.
  const dir = project();
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(dir, 'packages', 'api'), { recursive: true });
  seed(dir, [{ data: { description: 'API', paths: ['packages/api'] }, body: 'CWD_SCOPED.' }]);

  const cwd = path.join(dir, 'packages', 'api');
  assert.strictEqual(hook(promptHook, dir, state, { session_id: 'one', cwd, prompt: 'hello' }), '');
});

/* ------------------------------------------------------------------ *
 *  2. A changed rule is emitted once
 * ------------------------------------------------------------------ */

test('editing a rule file emits it once, then falls silent again', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'Always' }, body: 'Version one.' }]);
  hook(startHook, dir, state, { session_id: 'one', source: 'startup' });

  // What native put in context is now stale, and live-rules is the only thing
  // that can see that.
  write(dir, '001.md', 'description: Always', 'Version two.');
  const emitted = hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' });
  assert.match(emitted, /Version two/);
  assert.doesNotMatch(emitted, /Version one/);

  assert.strictEqual(hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' }), '', 'once, not every prompt');
});

test('a changed path rule is emitted on the next touch of a matching file', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'TypeScript', paths: ['src/**/*.ts'] }, body: 'Use strict types.' }]);
  const touch = { session_id: 'one', tool_input: { file_path: 'src/a.ts' } };
  assert.strictEqual(hook(editHook, dir, state, touch), '');

  write(dir, '001.md', 'description: TypeScript\npaths: ["src/**/*.ts"]', 'Use stricter types.');
  const emitted = hook(editHook, dir, state, touch);
  assert.match(emitted, /Use stricter types/);
  assert.match(emitted, /changed since it was loaded/, 'the header says why this is being said');
  assert.strictEqual(hook(editHook, dir, state, touch), '');
});

test('a global rule added after the session started is emitted, because native never read it', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'First' }, body: 'First body.' }]);
  hook(startHook, dir, state, { session_id: 'one', source: 'startup' });

  write(dir, '002.md', 'description: Second', 'Second body.');
  const emitted = hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' });
  assert.match(emitted, /Second body/, 'adding a rule takes effect without a restart');
  assert.doesNotMatch(emitted, /First body/, 'and says nothing about the rule native already has');
});

test('without a recorded session start, a global rule stays silent rather than risk a double-say', () => {
  // The prompt hook cannot tell "added just now" from "native loaded it at
  // startup" unless a session start was recorded. Unknown resolves to silence,
  // because native is the carrier that is always present.
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'Always' }, body: 'Unknowable.' }]);
  assert.strictEqual(hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' }), '');
});

/* ------------------------------------------------------------------ *
 *  3. Keyword rules and the never-match sentinel
 * ------------------------------------------------------------------ */

test('the never-match sentinel matches no path, at any depth, in any form', () => {
  const sentinel = rules.NEVER_MATCH_PATH;
  const candidates = [
    'src/index.ts',
    'README.md',
    '.claude/rules/001.md',
    '.claude/live-rules/rules/old.md',
    'live-rules-never-match/x.ts',
    '.live-rules-never-match',
    // Even a real file at the reserved path is refused: the sentinel is
    // recognised by value, not merely improbable.
    '.live-rules-never-match/x.ts',
    '.live-rules-never-match/deep/x.ts',
  ];
  for (const candidate of candidates) {
    assert.strictEqual(rules.pathPatternMatchesFile(sentinel, candidate), false, candidate);
  }
  for (const dir of ['', '.', 'src', '.live-rules-never-match']) {
    assert.strictEqual(rules.pathPatternMatchesDir(sentinel, dir), false, dir);
  }
  assert.ok(rules.isNeverMatchPath(sentinel));
  assert.ok(rules.isNeverMatchPath('.live-rules-never-match\\**'), 'Windows separators still recognised');
  assert.ok(!rules.isNeverMatchPath('src/**'));
});

test('a keyword rule carrying the sentinel is scoped away from native but still fires on its keyword', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{
    data: { description: 'Deploys', paths: [rules.NEVER_MATCH_PATH], prompt: ['deploy'] },
    body: 'KEYWORD_ONLY.',
  }]);

  // Native would load a `paths:`-less file globally; the sentinel keeps it out
  // of that load, so live-rules is the only thing that can deliver it.
  assert.strictEqual(hook(startHook, dir, state, { session_id: 'one', source: 'startup' }), '');
  assert.strictEqual(hook(editHook, dir, state, { session_id: 'one', tool_input: { file_path: 'src/a.ts' } }), '');
  assert.strictEqual(hook(promptHook, dir, state, { session_id: 'one', prompt: 'unrelated' }), '');

  assert.match(hook(promptHook, dir, state, { session_id: 'one', prompt: 'time to deploy' }), /KEYWORD_ONLY/);
});

test('a keyword rule is not repeated while it is still in context at the same hash', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{
    data: { description: 'Deploys', paths: [rules.NEVER_MATCH_PATH], prompt: ['deploy'] },
    body: 'KEYWORD_ONLY.',
  }]);
  assert.match(hook(promptHook, dir, state, { session_id: 'one', prompt: 'deploy now' }), /KEYWORD_ONLY/);
  assert.strictEqual(hook(promptHook, dir, state, { session_id: 'one', prompt: 'deploy again' }), '');

  // Changing it puts a stale copy in context, which is worth saying.
  write(dir, '001.md', 'description: Deploys\npaths: ["' + rules.NEVER_MATCH_PATH + '"]\nprompt: ["deploy"]', 'KEYWORD_V2.');
  assert.match(hook(promptHook, dir, state, { session_id: 'one', prompt: 'deploy once more' }), /KEYWORD_V2/);
});

test('a keyword rule reaches a session that never recorded a session start', () => {
  // The one carrier that does not depend on the ledger: nothing else can
  // deliver these, so silence would lose them outright.
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{
    data: { description: 'Deploys', paths: [rules.NEVER_MATCH_PATH], prompt: ['deploy'] },
    body: 'KEYWORD_ONLY.',
  }]);
  assert.match(hook(promptHook, dir, state, { session_id: 'fresh', prompt: 'deploy' }), /KEYWORD_ONLY/);
});

test('a keyword rule is emitted with no session id at all, when no ledger can exist', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [
    { data: { description: 'Deploys', paths: [rules.NEVER_MATCH_PATH], prompt: ['deploy'] }, body: 'KEYWORD_ONLY.' },
    { data: { description: 'Always' }, body: 'GLOBAL_RULE.' },
  ]);
  const output = hook(promptHook, dir, state, { prompt: 'deploy' });
  assert.match(output, /KEYWORD_ONLY/);
  assert.doesNotMatch(output, /GLOBAL_RULE/, 'an unledgered session still must not double-say a global rule');
});

/* ------------------------------------------------------------------ *
 *  4. reground: true
 * ------------------------------------------------------------------ */

test('reground is off by default: an unchanged rule is never re-said', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'Always' }, body: 'Quiet rule.' }]);
  hook(startHook, dir, state, { session_id: 'one', source: 'startup' });

  for (let turn = 0; turn < ledger.REGROUND_TURNS + 2; turn++) {
    assert.strictEqual(hook(promptHook, dir, state, { session_id: 'one', prompt: 'turn ' + turn }), '');
  }
});

test('reground: true re-says a rule once the cadence comes due, then waits again', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'Always', reground: 'true' }, body: 'REGROUNDED.' }]);
  hook(startHook, dir, state, { session_id: 'one', source: 'startup' });

  const says = [];
  for (let turn = 1; turn <= ledger.REGROUND_TURNS * 2; turn++) {
    if (hook(promptHook, dir, state, { session_id: 'one', prompt: 'turn ' + turn })) says.push(turn);
  }
  assert.deepStrictEqual(says, [ledger.REGROUND_TURNS, ledger.REGROUND_TURNS * 2],
    'said on the cadence, and the clock restarts from each saying');
});

test('reground survives a frontmatter round-trip, and is absent when off', () => {
  const on = rules.buildRule('a', { description: 'On', reground: true }, 'Body.');
  const off = rules.buildRule('b', { description: 'Off' }, 'Body.');
  assert.strictEqual(on.reground, true);
  assert.strictEqual(off.reground, false);

  const rendered = rules.renderRuleFile(rules.ruleFileFrontmatter(on), on.body);
  assert.match(rendered, /^reground: true$/m);
  assert.strictEqual(rules.buildRule('a', rules.parseRuleFile(rendered).data, '').reground, true);

  assert.doesNotMatch(rules.renderRuleFile(rules.ruleFileFrontmatter(off), off.body), /reground/,
    'the default is not written into every rule file');
});
