'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-shell-syntax-test-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
const store = require('../lib/store');

// SQ-223 (baude SQ-4): a ticket's verify was set to the prose "scripts/gate.sh passes (exit 0), ...".
// It starts with a path, so the leading-word check took it as runnable, and verify-capture wrapped it
// verbatim in the shell, where the unquoted `(` is a syntax error. add/update now refuse a verify the
// shell cannot parse, instead of accepting it and failing only when an executor runs it.

const PARSEABLE = /not a parseable shell command/;
const SQ4_REPRO = 'scripts/gate.sh passes (exit 0), lint and typecheck are clean';

function commandErrors(verify: string) {
  return store.verifyOracleErrors('command', verify);
}

// The rule mirrors the POSIX shell grammar; where a POSIX shell is available, it must agree.
function shellParses(command: string) {
  const result = spawnSync('/bin/sh', ['-n', '-c', command], { encoding: 'utf8' });
  return result.status === 0;
}
const posixShell = process.platform !== 'win32' && fs.existsSync('/bin/sh');

test('SQ-223: the prose verify from baude SQ-4 is refused as unparseable', () => {
  const errors = commandErrors(SQ4_REPRO);
  assert.ok(errors.some((error: string) => PARSEABLE.test(error)), errors.join('\n'));
  assert.ok(errors.some((error: string) => /`\(`/.test(error) && /passes/.test(error)), errors.join('\n'));
  if (posixShell) assert.strictEqual(shellParses(SQ4_REPRO), false, 'the repro really is a shell syntax error');
});

test('SQ-223: update refuses an unparseable verify and keeps the previous one', () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-shell-syntax-project-')));
  const { slug } = store.ensureProject(project);
  const ticket = store.createTicket(slug, {
    title: 'unparseable verify update',
    complexity: 2,
    complexityWhy: 'fixture for the verify shell syntax refusal',
    source: 'cli',
    executorVerifyKind: 'command',
    executorVerify: 'node --version',
  });
  assert.throws(
    () => store.updateTicket(slug, ticket.ref, { executorVerifyKind: 'command', executorVerify: SQ4_REPRO, source: 'test' }),
    PARSEABLE,
  );
  assert.strictEqual(store.getTicket(slug, ticket.ref).executorVerify, 'node --version');
  assert.throws(
    () => store.createTicket(slug, { title: 'unparseable verify add', source: 'cli', executorVerifyKind: 'command', executorVerify: SQ4_REPRO }),
    PARSEABLE,
  );
});

test('SQ-223: unbalanced quotes and parentheses are refused', () => {
  for (const verify of [
    'npm run test -- --grep "unterminated',
    "node -e 'process.exit(0)",
    'npm run test)',
    '(cd plugins/sidequest && npm test',
    'npm test -- --grep `date',
    'node --test test/a.test.js (the fast one)',
  ]) {
    const errors = commandErrors(verify);
    assert.ok(errors.some((error: string) => PARSEABLE.test(error)), `${verify}: ${errors.join('\n')}`);
    if (posixShell) assert.strictEqual(shellParses(verify), false, verify);
  }
});

test('SQ-223: parentheses the shell accepts stay valid', () => {
  for (const verify of [
    '(cd plugins/sidequest && npm run typecheck)',
    'cd plugins/sidequest && (npm run build && npm test)',
    'node -e "process.exit(0)"',
    "node -e 'console.log((1 + 2))'",
    'test "$(git rev-parse --abbrev-ref HEAD)" != main',
    'test $(git status --porcelain | wc -l) -eq 0',
    'test $((1 + 2)) -eq 3',
    'find . -name "*.ts" \\( -path ./src -o -path ./test \\) -print',
    'npm test -- --grep "a (b)"',
    'npm test && (exit 0)',
    'git diff --quiet || (git status && false)',
    'diff <(git show HEAD:README.md) README.md',
  ]) {
    assert.deepStrictEqual(commandErrors(verify), [], verify);
    // Process substitution is bash, not POSIX sh, so /bin/sh may refuse it.
    if (posixShell && !verify.includes('<(')) assert.strictEqual(shellParses(verify), true, verify);
  }
});
