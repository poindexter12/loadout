'use strict';
/**
 * Re-grounding behaviour: which rules each hook emits, and when a rule is
 * emitted AGAIN. The session ledger is what keeps an unchanged rule from being
 * repeated on every prompt, so most of this file is about the ledger.
 *
 * Storage is .claude/rules/*.md read straight off disk (SQ-292), so there is no
 * manifest to be stale against: a rule's identity is its filename and its
 * content hash is computed on every read. Migration out of the retired stores
 * is covered by test/migrate-rules.test.js.
 *
 * SQ-293 made live-rules native-first, which changed the baseline every test
 * here starts from: native Claude Code loads the rule files itself, so the
 * FIRST sight of a rule is silent and live-rules speaks only when it has
 * something native does not have. A session start is therefore the setup step
 * for most of these tests, because it is what records what native loaded. The
 * native-first contract itself is pinned in test/native-first.test.js.
 *
 * Run: node --test plugins/live-rules/test/re-ground.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const rules = require('../hooks/lib/rules');

const root = path.resolve(__dirname, '..');
const promptHook = path.join(root, 'hooks', 'inject-prompt-rules.js');
const editHook = path.join(root, 'hooks', 'inject-edit-rules.js');
const startHook = path.join(root, 'hooks', 'session-start-rules.js');

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-rules-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

// Seed .claude/rules with one file per rule, named 001.md, 002.md, ... so a
// test can target a specific file when it wants to simulate an edit.
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

function hook(script, projectDir, stateDir, data, env) {
  return execFileSync(process.execPath, [script], {
    cwd: projectDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, LIVE_RULES_STATE_DIR: stateDir, ...env },
    input: JSON.stringify({ cwd: projectDir, ...data }),
    encoding: 'utf8',
  });
}

function alternateDriveCase(target) {
  if (process.platform !== 'win32' || !/^[A-Za-z]:/.test(target)) return null;
  const drive = target.slice(0, 1);
  const alternate = drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase();
  return alternate + target.slice(1);
}

function windowsShortPath(target) {
  if (process.platform !== 'win32' || /[\s&|<>()^]/.test(target)) return null;
  try {
    const result = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `for %I in (${target}) do @echo %~sI`], { encoding: 'utf8' }).trim();
    return result && result.toLowerCase() !== target.toLowerCase() ? result : null;
  } catch (_) {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 *  The session ledger
 * ------------------------------------------------------------------ */

test('unchanged prompts emit no rule content once a rule is in context', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'Always' }, body: 'First version.' }]);
  hook(startHook, dir, state, { session_id: 'one', source: 'startup' });
  assert.strictEqual(hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' }), '');
  assert.strictEqual(hook(promptHook, dir, state, { session_id: 'one', prompt: 'again' }), '');
});

test('only a changed relevant rule file is re-grounded', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [
    { data: { description: 'One' }, body: 'One v1.' },
    { data: { description: 'Two' }, body: 'Two v1.' },
  ]);
  hook(startHook, dir, state, { session_id: 'one', source: 'startup' });
  fs.writeFileSync(ruleFile(dir, '001.md'), '---\ndescription: One\n---\nOne v2.\n');
  const output = hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' });
  assert.match(output, /One v2/);
  assert.doesNotMatch(output, /Two v1/);
});

test('a rule edited on disk re-grounds on the next prompt with no restart', () => {
  // The whole point of reading .claude/rules at hook time: no sync step stands
  // between editing a rule and the model being told about it.
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'Always' }, body: 'Version one.' }]);
  hook(startHook, dir, state, { session_id: 'one', source: 'startup' });
  fs.writeFileSync(ruleFile(dir, '001.md'), '---\ndescription: Always\n---\nVersion two.\n');
  assert.match(hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' }), /Version two/);
});

test('a rule file added after the session started is grounded on the next prompt', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'First' }, body: 'First body.' }]);
  hook(startHook, dir, state, { session_id: 'one', source: 'startup' });

  fs.writeFileSync(ruleFile(dir, '002.md'), '---\ndescription: Second\n---\nSecond body.\n');
  const output = hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' });
  assert.match(output, /Second body/);
  assert.doesNotMatch(output, /First body/, 'an unchanged rule is not repeated');
});

test('renaming a rule to .md.off stops it being grounded', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'Always' }, body: 'Disable me.' }]);
  // A summarizing compaction is the one path that re-states a global rule, so
  // it is also the way to show the rule still exists before it is disabled.
  assert.match(hook(startHook, dir, state, { session_id: 'one', source: 'compact' }), /Disable me/);

  fs.renameSync(ruleFile(dir, '001.md'), ruleFile(dir, '001.md.off'));
  assert.strictEqual(hook(startHook, dir, state, { session_id: 'two', source: 'compact' }), '', 'a fresh session sees no rules at all');
});

test('CRLF rule files hash the same as their LF form, so a line-ending change alone does not re-ground', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'Always', priority: 95 }, body: 'Rule body.' }]);
  const target = ruleFile(dir, '001.md');
  hook(startHook, dir, state, { session_id: 'one', source: 'startup' });

  fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(/\n/g, '\r\n'));
  assert.strictEqual(hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' }), '');
});

test('session ledgers are isolated across concurrent session ids', () => {
  // A keyword rule is the one kind live-rules always delivers itself, so it is
  // what shows each session keeping its own record of what it has been told.
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'Deploys', paths: [rules.NEVER_MATCH_PATH], prompt: ['deploy'] }, body: 'Rule.' }]);
  assert.match(hook(promptHook, dir, state, { session_id: 'first', prompt: 'deploy' }), /Rule/);
  assert.match(hook(promptHook, dir, state, { session_id: 'second', prompt: 'deploy' }), /Rule/);
  assert.strictEqual(hook(promptHook, dir, state, { session_id: 'first', prompt: 'deploy' }), '');
});

test('startup, resume and clear record the rules native loaded without saying them', () => {
  // SQ-293: native reads .claude/rules itself when a context begins, so
  // emitting there would say every global rule twice.
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'Always' }, body: 'Rule.' }]);
  for (const source of ['startup', 'resume', 'clear']) {
    assert.strictEqual(hook(startHook, dir, state, { session_id: 'one-' + source, source }), '');
    assert.strictEqual(hook(promptHook, dir, state, { session_id: 'one-' + source, prompt: 'hello' }), '');
  }
});

test('a summarizing compaction re-grounds the rules once, because nothing else puts them back', () => {
  // The summary replaced the transcript and no component re-reads the rule
  // files at that boundary, so this is live-rules' job alone.
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'Always' }, body: 'Rule.' }]);
  hook(startHook, dir, state, { session_id: 'one', source: 'startup' });

  const output = hook(startHook, dir, state, { session_id: 'one', source: 'compact' });
  assert.match(output, /SessionStart \(compact\)/);
  assert.match(output, /Rule/);
  assert.strictEqual(hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' }), '', 'and not again on the next prompt');
});

/* ------------------------------------------------------------------ *
 *  SQ-197: replacement compaction
 * ------------------------------------------------------------------ */

// sidequest's PostCompact hook marks a replacement compaction (no summary generated) at
// SIDEQUEST_HOME/replacement-compactions/<encoded session id>.json. This plugin peeks at that
// same path (duplicated formula, not imported) to skip full rule re-injection on
// SessionStart(compact). Only sidequest deletes the marker, so it must be removed by hand here to
// simulate the "marker already consumed" (normal, summarized compaction) case.
function writeReplacementMarker(sidequestHome, sessionId, ageMs = 0) {
  const markerDir = path.join(sidequestHome, 'replacement-compactions');
  fs.mkdirSync(markerDir, { recursive: true });
  const file = path.join(markerDir, encodeURIComponent(sessionId) + '.json');
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString() }));
  if (ageMs) {
    const past = (Date.now() - ageMs) / 1000;
    fs.utimesSync(file, past, past);
  }
  return file;
}

test('a replacement-compaction marker collapses SessionStart(compact) to a short note', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  const sidequestHome = fs.mkdtempSync(path.join(os.tmpdir(), 'live-rules-sq197-'));
  seed(dir, [{ data: { description: 'Always' }, body: 'Rule.' }]);
  hook(startHook, dir, state, { session_id: 'one', source: 'startup' }, { SIDEQUEST_HOME: sidequestHome });

  const markerFile = writeReplacementMarker(sidequestHome, 'one');
  const noteOutput = hook(startHook, dir, state, { session_id: 'one', source: 'compact' }, { SIDEQUEST_HOME: sidequestHome });
  const note = JSON.parse(noteOutput).hookSpecificOutput.additionalContext;
  assert.match(note, /history retained across a replacement compaction/);
  assert.doesNotMatch(note, /SessionStart \(compact\)/);
  assert.ok(Buffer.byteLength(note, 'utf8') <= 200, `expected <=200 bytes, got ${Buffer.byteLength(note, 'utf8')}`);

  // No marker (already consumed by sidequest, or a normal summarized compaction) keeps today's
  // full re-grounding.
  fs.rmSync(markerFile, { force: true });
  const full = hook(startHook, dir, state, { session_id: 'one', source: 'compact' }, { SIDEQUEST_HOME: sidequestHome });
  assert.match(full, /SessionStart \(compact\)/);
  assert.match(full, /Rule/);

  // A marker older than the bound never suppresses re-grounding on a later, unrelated compaction.
  writeReplacementMarker(sidequestHome, 'one', 5 * 60 * 1000);
  const staleMarker = hook(startHook, dir, state, { session_id: 'one', source: 'compact' }, { SIDEQUEST_HOME: sidequestHome });
  assert.match(staleMarker, /SessionStart \(compact\)/);
});

/* ------------------------------------------------------------------ *
 *  Path scoping
 * ------------------------------------------------------------------ */

test('path-scoped rules stay silent on the touch that makes native load them', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'TypeScript', paths: ['src/**/*.ts'] }, body: 'Use strict types.' }]);
  const data = { session_id: 'one', tool_input: { file_path: 'src/a.ts' } };
  assert.strictEqual(hook(editHook, dir, state, data), '');
  assert.strictEqual(hook(editHook, dir, state, data), '');
  assert.strictEqual(hook(editHook, dir, state, { session_id: 'one', tool_input: { file_path: 'other/a.ts' } }), '');
});

// Which paths a rule scopes is a question about the matcher, so it is asserted
// against the matcher. Going through the edit hook would only show the
// native-first ledger decision on top of it, which is covered elsewhere.
test('a comma-separated paths scalar scopes every pattern it names', () => {
  const dir = project();
  seed(dir, [{ data: { description: 'Two trees', paths: 'src/**/*.ts, docs/**/*.md' }, body: 'Scoped rule.' }]);
  const [rule] = rules.loadRules(dir);
  assert.deepStrictEqual(rule.paths, ['src/**/*.ts', 'docs/**/*.md']);

  const scopes = (file) => rules.selectForEdit([rule], file).length === 1;
  assert.ok(scopes('src/a.ts'));
  assert.ok(scopes('docs/guide.md'));
  assert.ok(!scopes('src/a.js'));
});

test('a rule still using the retired globs: key keeps its scope and warns on stderr', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'Legacy key', globs: ['src/**/*.js'] }, body: 'Still scoped.' }]);
  const [rule] = rules.loadRules(dir);
  assert.deepStrictEqual(rule.paths, ['src/**/*.js'], 'the rule is not silently unscoped');

  const result = require('node:child_process').spawnSync(process.execPath, [editHook], {
    cwd: dir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, LIVE_RULES_STATE_DIR: state },
    input: JSON.stringify({ cwd: dir, session_id: 'one', tool_input: { file_path: 'src/a.js' } }),
    encoding: 'utf8',
  });
  assert.match(result.stderr, /globs.*deprecated; rename it to paths:/);
  assert.strictEqual(result.status, 0, 'a deprecation never breaks an edit');
});

test('scoped hooks match paths with a different Windows drive-letter case', (testContext) => {
  const dir = project();
  const alternate = alternateDriveCase(dir);
  if (!alternate) {
    testContext.skip('Windows drive-letter paths are required');
    return;
  }

  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'rule.js'), '');
  seed(dir, [{ data: { description: 'Source rule', paths: ['src/**/*.js', 'src'] }, body: 'Use source rules.' }]);

  // Native-first means first sight is silent, so each hook is observed on the
  // second sight, after the rule changed. That still proves the alternate-cased
  // path matched: if it did not, the rule would never be selected and both
  // calls would be empty.
  const changed = (script, data) => {
    hook(script, dir, state, data);
    fs.writeFileSync(ruleFile(dir, '001.md'),
      '---\ndescription: Source rule\npaths: ["src/**/*.js", "src"]\n---\nUse source rules v2 ' + data.session_id + '.\n');
    return hook(script, dir, state, data);
  };

  assert.match(changed(editHook, {
    session_id: 'edit',
    tool_input: { file_path: path.join(alternate, 'src', 'rule.js') },
  }), /Use source rules v2 edit/);
  assert.match(changed(promptHook, {
    session_id: 'prompt',
    cwd: path.join(alternate, 'src'),
    prompt: 'hello',
  }), /Use source rules v2 prompt/);
});

test('edit rules match a short Windows path when the project root is long', (testContext) => {
  const dir = project();
  const shortDir = windowsShortPath(dir);
  if (!shortDir) {
    testContext.skip('This volume has no distinct 8.3 path');
    return;
  }

  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'rule.js'), '');
  seed(dir, [{ data: { description: 'Source rule', paths: ['src/**/*.js'] }, body: 'Use source rules.' }]);

  const data = { session_id: 'short-path', tool_input: { file_path: path.join(shortDir, 'src', 'rule.js') } };
  hook(editHook, dir, state, data); // first sight is native's; this records it
  fs.writeFileSync(ruleFile(dir, '001.md'),
    '---\ndescription: Source rule\npaths: ["src/**/*.js"]\n---\nUse source rules v2.\n');
  assert.match(hook(editHook, dir, state, data), /Use source rules v2/);
});

test('a Windows project alias keeps the existing session ledger', (testContext) => {
  const dir = project();
  const alternate = alternateDriveCase(dir);
  if (!alternate) {
    testContext.skip('Windows drive-letter paths are required');
    return;
  }

  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'Always' }, body: 'Ledger rule.' }]);
  assert.match(hook(startHook, dir, state, { session_id: 'one', source: 'compact' }), /Ledger rule/);
  assert.strictEqual(hook(promptHook, dir, state, { session_id: 'one', prompt: 'again' }, { CLAUDE_PROJECT_DIR: alternate }), '');
});

/* ------------------------------------------------------------------ *
 *  Retired stores
 * ------------------------------------------------------------------ */

test('SessionStart tells a project whose rules are still in the retired atomic store how to migrate', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(dir, '.claude', 'live-rules', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'live-rules', 'rules', 'old.md'), 'Old rule body.\n');

  const output = hook(startHook, dir, state, { session_id: 'one', source: 'startup' });
  const context = JSON.parse(output).hookSpecificOutput.additionalContext;
  assert.match(context, /now reads \.claude\/rules\/\*\.md/);
  assert.match(context, /migrate-rules\.js/);
  assert.doesNotMatch(context, /Old rule body/, 'a retired store is not read, only reported');
});

test('SessionStart reports a retired monolith the same way', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  fs.writeFileSync(path.join(dir, '.claude', 'live-rules.md'), 'Legacy rule.\n');

  const context = JSON.parse(hook(startHook, dir, state, { session_id: 'one', source: 'startup' })).hookSpecificOutput.additionalContext;
  assert.match(context, /live-rules\.md.*are NOT in effect/s);
});

test('the prompt and edit hooks stay silent about a retired store, so the nudge is not repeated', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  fs.writeFileSync(path.join(dir, '.claude', 'live-rules.md'), 'Legacy rule.\n');

  assert.strictEqual(hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' }), '');
  assert.strictEqual(hook(editHook, dir, state, { session_id: 'one', tool_input: { file_path: 'a.ts' } }), '');
});

test('a half-migrated project is grounded from the new store and still warned about the old one', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'Moved' }, body: 'Moved rule body.' }]);
  fs.mkdirSync(path.join(dir, '.claude', 'live-rules', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'live-rules', 'rules', 'left.md'), 'Left behind.\n');

  // At startup the notice is the only thing worth saying: native has already
  // read the migrated rule, and the retired store is reported, never read.
  const startup = JSON.parse(hook(startHook, dir, state, { session_id: 'one', source: 'startup' })).hookSpecificOutput.additionalContext;
  assert.match(startup, /are NOT in effect/);
  assert.doesNotMatch(startup, /Moved rule body/);
  assert.doesNotMatch(startup, /Left behind/);

  const compact = JSON.parse(hook(startHook, dir, state, { session_id: 'one', source: 'compact' })).hookSpecificOutput.additionalContext;
  assert.match(compact, /are NOT in effect/);
  assert.match(compact, /Moved rule body/, 'the migrated rules are still grounded');
});

test('no rules and no retired store is completely silent on every hook', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  assert.strictEqual(hook(startHook, dir, state, { session_id: 'one', source: 'startup' }), '');
  assert.strictEqual(hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' }), '');
  assert.strictEqual(hook(editHook, dir, state, { session_id: 'one', tool_input: { file_path: 'a.ts' } }), '');
});
