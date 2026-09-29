import test from 'node:test';
import assert from 'node:assert/strict';

// #19: the verify validator read every `$NAME` as an environment reference, so
// a command that binds its own names (a loop variable, a `read` target, an
// assignment) was refused as `invalid_verify`. These run the shipped validator.
const store = require('../lib/store');

// Every name these commands use must be genuinely unset here, or the validator
// would accept it for the wrong reason.
const NAMES = ['p', 'line', 'cols', 'target', 'out', 'i', 'SQ_PROBE', 'later', 'HOME_DIR_X'];
for (const name of NAMES) delete process.env[name];

function unsetErrors(command: string): string[] {
  return store.verifyCommandErrors(command).filter((error: string) => /unset environment variable/.test(error));
}

test('#19 repro: a bash -c for-loop variable is not an unset environment variable', () => {
  const command = `bash -c 'set -e; test -s README.md; for p in "alpha" "beta"; do grep -qF "$p" README.md || { echo "missing: $p"; exit 1; }; done'`;
  assert.deepEqual(store.verifyCommandErrors(command), [], 'the verify from the issue is accepted whole');
  assert.equal(store.verifyCommandError(command), null);
  assert.deepEqual(store.verifyOracleErrors('command', command), [], 'the ticket verify oracle accepts it as a command');
  assert.deepEqual(unsetErrors(`bash -c 'for p; do test -n "$p"; done'`), [], 'a for loop over positional parameters binds its name too');
  assert.deepEqual(unsetErrors(`bash -c "for p in a b; do echo \\$p; done"`), [], 'an escaped $ inside double quotes reaches the inner shell, where the loop binds it');
});

test('while read binds its targets, skipping option arguments and redirections', () => {
  assert.deepEqual(unsetErrors(`bash -c 'printf "%s\\n" alpha beta | while IFS= read -r line; do grep -qF "$line" README.md || exit 1; done'`), []);
  assert.deepEqual(unsetErrors(`bash -c 'read -r -p "row: " -a cols <<< "a b" && test "\${cols}" = a'`), [], '-p consumes its prompt, -a binds the array name');
  assert.deepEqual(unsetErrors(`bash -c 'while read -r line < README.md; do test -n "$line" && break; done'`), []);
});

test('local, export, and plain assignments bind the names they assign before use', () => {
  assert.deepEqual(unsetErrors(`bash -c 'check() { local target="$1"; test -s "$target"; }; check README.md'`), [], 'local assignment inside a function');
  assert.deepEqual(unsetErrors(`bash -c 'check() { local target; target="$1"; test -s "$target"; }; check README.md'`), [], 'local declaration, assigned later');
  assert.deepEqual(unsetErrors(`bash -c 'export SQ_PROBE=README.md && test -s "$SQ_PROBE"'`), [], 'export');
  assert.deepEqual(unsetErrors(`bash -c 'out=$(git status --porcelain) && test -z "$out"'`), [], 'plain assignment from a command substitution');
  assert.deepEqual(unsetErrors(`cd . && env SQ_PROBE=README.md bash -c 'test -s "$SQ_PROBE"'`), [], 'env prefix assignment reaches the nested shell');
  assert.deepEqual(unsetErrors(`bash -c 'for ((i = 0; i < 3; i++)); do test "$i" -ge 0; done'`), [], 'arithmetic for loop');
});

test('genuinely ambient variables stay rejected', () => {
  assert.deepEqual(unsetErrors(`bash -c 'for p in a b; do test -d "$HOME_DIR_X/$p"; done'`).map((error) => error.match(/variable (\w+)/)?.[1]), ['HOME_DIR_X'], 'an unbound name next to a bound one');
  assert.deepEqual(unsetErrors(`bash -c 'test -n "$later" && later=set'`).map((error) => error.match(/variable (\w+)/)?.[1]), ['later'], 'a read before the binding is still an environment read');
  assert.deepEqual(unsetErrors(`bash -c "for p in a b; do echo $p; done"`).map((error) => error.match(/variable (\w+)/)?.[1]), ['p'], 'the outer shell expands a double-quoted $p before the inner loop exists');
  assert.deepEqual(unsetErrors(`bash -c 'echo for p in a b' && test -n "$p"`).map((error) => error.match(/variable (\w+)/)?.[1]), ['p'], 'a `for` that is only an argument binds nothing');
  assert.deepEqual(unsetErrors(`test -d "$HOME_DIR_X"`).map((error) => error.match(/variable (\w+)/)?.[1]), ['HOME_DIR_X']);
});

test('a binding covers only its own scope and the scopes nested inside it', () => {
  const unsetNames = (command: string) => unsetErrors(command).map((error) => error.match(/variable (\w+)/)?.[1]);
  assert.deepEqual(unsetNames(`grep -q 'for p in' README.md && test -n "$p"`), ['p'], 'quoted data that reads like a loop does not bind the enclosing shell');
  assert.deepEqual(unsetNames(`grep -q 'for p in' README.md && bash -c 'test -n "$p"'`), ['p'], 'nor a sibling quoted script');
  assert.deepEqual(unsetNames(`bash -c 'echo "$(p=1)" && test -n "$p"'`), ['p'], 'a command substitution runs in a subshell, so its assignment does not leak out');
  assert.deepEqual(unsetNames(`bash -c 'p=1; test "$(echo "$p")" = 1'`), [], 'a command substitution sees the names of the shell around it');
  assert.deepEqual(unsetNames(`bash -c 'test "$(( i = 2 ))" = "$i"'`), [], 'an arithmetic expansion assigns in the current shell');
});

test('positional and special parameters are never reported', () => {
  assert.deepEqual(unsetErrors(`bash -c 'test "$#" -ge 0 && test -z "$1" && echo "$@" "$9"' probe`), []);
});
