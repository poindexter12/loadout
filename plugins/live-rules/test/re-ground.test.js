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

test('unchanged prompts emit no rule content after the first grounding', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'Always' }, body: 'First version.' }]);
  assert.match(hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' }), /First version/);
  assert.strictEqual(hook(promptHook, dir, state, { session_id: 'one', prompt: 'again' }), '');
});

test('only a changed relevant rule file is re-grounded', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [
    { data: { description: 'One' }, body: 'One v1.' },
    { data: { description: 'Two' }, body: 'Two v1.' },
  ]);
  hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' });
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
  assert.match(hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' }), /Version one/);
  fs.writeFileSync(ruleFile(dir, '001.md'), '---\ndescription: Always\n---\nVersion two.\n');
  assert.match(hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' }), /Version two/);
});

test('a rule file added after the session started is grounded on the next prompt', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'First' }, body: 'First body.' }]);
  hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' });

  fs.writeFileSync(ruleFile(dir, '002.md'), '---\ndescription: Second\n---\nSecond body.\n');
  const output = hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' });
  assert.match(output, /Second body/);
  assert.doesNotMatch(output, /First body/, 'an unchanged rule is not repeated');
});

test('renaming a rule to .md.off stops it being grounded', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'Always' }, body: 'Disable me.' }]);
  assert.match(hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' }), /Disable me/);

  fs.renameSync(ruleFile(dir, '001.md'), ruleFile(dir, '001.md.off'));
  assert.strictEqual(hook(promptHook, dir, state, { session_id: 'two', prompt: 'hello' }), '', 'a fresh session sees no rules at all');
});

test('CRLF rule files hash the same as their LF form, so a line-ending change alone does not re-ground', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'Always', priority: 95 }, body: 'Rule body.' }]);
  const target = ruleFile(dir, '001.md');
  assert.match(hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' }), /Rule body/);

  fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(/\n/g, '\r\n'));
  assert.strictEqual(hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' }), '');
});

test('session ledgers are isolated across concurrent session ids', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'Always' }, body: 'Rule.' }]);
  assert.match(hook(promptHook, dir, state, { session_id: 'first', prompt: 'hello' }), /Rule/);
  assert.match(hook(promptHook, dir, state, { session_id: 'second', prompt: 'hello' }), /Rule/);
  assert.strictEqual(hook(promptHook, dir, state, { session_id: 'first', prompt: 'hello' }), '');
});

test('startup, resume, compact, and clear rehydrate current prompt rules once', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'Always' }, body: 'Rule.' }]);
  for (const source of ['startup', 'resume', 'compact', 'clear']) {
    const output = hook(startHook, dir, state, { session_id: 'one', source });
    assert.match(output, new RegExp('SessionStart \\(' + source + '\\)'));
    assert.match(output, /Rule/);
    assert.strictEqual(hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' }), '');
  }
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

test('path-scoped rules ground once when their edited path first applies', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'TypeScript', paths: ['src/**/*.ts'] }, body: 'Use strict types.' }]);
  const data = { session_id: 'one', tool_input: { file_path: 'src/a.ts' } };
  assert.match(hook(editHook, dir, state, data), /Use strict types/);
  assert.strictEqual(hook(editHook, dir, state, data), '');
  assert.strictEqual(hook(editHook, dir, state, { session_id: 'one', tool_input: { file_path: 'other/a.ts' } }), '');
});

test('a comma-separated paths scalar scopes every pattern it names through the edit hook', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'Two trees', paths: 'src/**/*.ts, docs/**/*.md' }, body: 'Scoped rule.' }]);
  assert.match(hook(editHook, dir, state, { session_id: 'a', tool_input: { file_path: 'src/a.ts' } }), /Scoped rule/);
  assert.match(hook(editHook, dir, state, { session_id: 'b', tool_input: { file_path: 'docs/guide.md' } }), /Scoped rule/);
  assert.strictEqual(hook(editHook, dir, state, { session_id: 'c', tool_input: { file_path: 'src/a.js' } }), '');
});

test('a rule still using the retired globs: key keeps its scope and warns on stderr', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  seed(dir, [{ data: { description: 'Legacy key', globs: ['src/**/*.js'] }, body: 'Still scoped.' }]);
  const result = require('node:child_process').spawnSync(process.execPath, [editHook], {
    cwd: dir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, LIVE_RULES_STATE_DIR: state },
    input: JSON.stringify({ cwd: dir, session_id: 'one', tool_input: { file_path: 'src/a.js' } }),
    encoding: 'utf8',
  });
  assert.match(result.stdout, /Still scoped/, 'the rule is not silently unscoped');
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

  assert.match(hook(editHook, dir, state, {
    session_id: 'edit',
    tool_input: { file_path: path.join(alternate, 'src', 'rule.js') },
  }), /Use source rules/);
  assert.match(hook(promptHook, dir, state, {
    session_id: 'prompt',
    cwd: path.join(alternate, 'src'),
    prompt: 'hello',
  }), /Use source rules/);
  assert.match(hook(startHook, dir, state, {
    session_id: 'start',
    cwd: path.join(alternate, 'src'),
    source: 'startup',
  }), /Use source rules/);
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

  assert.match(hook(editHook, dir, state, {
    session_id: 'short-path',
    tool_input: { file_path: path.join(shortDir, 'src', 'rule.js') },
  }), /Use source rules/);
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
  assert.match(hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' }), /Ledger rule/);
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

  const context = JSON.parse(hook(startHook, dir, state, { session_id: 'one', source: 'startup' })).hookSpecificOutput.additionalContext;
  assert.match(context, /are NOT in effect/);
  assert.match(context, /Moved rule body/, 'the migrated rules are still grounded');
});

test('no rules and no retired store is completely silent on every hook', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  assert.strictEqual(hook(startHook, dir, state, { session_id: 'one', source: 'startup' }), '');
  assert.strictEqual(hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' }), '');
  assert.strictEqual(hook(editHook, dir, state, { session_id: 'one', tool_input: { file_path: 'a.ts' } }), '');
});
