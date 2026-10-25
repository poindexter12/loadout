import './_temp-cleanup.js';
// SQ-335: the verify-command precheck split a `node --test` invocation on whitespace and on `|` without
// honouring quotes, so `--test-skip-pattern="two words|other"` had its second word and each regex
// alternative read as test-file operands and refused with a false "matches no files". The precheck must
// read shell words, and still refuse a genuinely empty operand glob.
export {};

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store.js');

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq335-'));
  fs.mkdirSync(path.join(root, 'pkg', 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pkg', 'package.json'), JSON.stringify({ name: 'pkg', type: 'commonjs' }));
  fs.writeFileSync(path.join(root, 'pkg', 'test', 'a.test.js'), "require('node:test')('a', () => {});\n");
  return root;
}

const error = (root: string, executorVerify: string) => store.dispatchVerifyCommandError({ executorVerify }, root);

test('a double-quoted skip pattern containing spaces and alternation is one flag value, not operands', () => {
  const root = project();
  assert.strictEqual(
    error(root, 'cd pkg && node --test --test-skip-pattern="isolated ensure preserves a foreign serve-shim|sibling ensure retires dead records" "test/*.test.js"'),
    null,
  );
});

test('a space-free regex alternation inside quotes is not a pipe', () => {
  const root = project();
  assert.strictEqual(
    error(root, 'cd pkg && node --test --test-skip-pattern="isolated.ensure|sibling.ensure.retires.dead.records" "test/*.test.js"'),
    null,
  );
});

test('single quotes and a separate flag value word are honoured the same way', () => {
  const root = project();
  assert.strictEqual(error(root, "cd pkg && node --test --test-skip-pattern 'a b|c d' 'test/*.test.js'"), null);
  assert.strictEqual(error(root, 'cd pkg && node --test --test-name-pattern=one\\ two test/a.test.js'), null);
});

test('a real pipe after the node command ends its operands', () => {
  const root = project();
  assert.strictEqual(error(root, 'cd pkg && node --test "test/*.test.js" | tee missing-output.log'), null);
});

test('an operand glob that matches nothing is still refused beside a quoted pattern', () => {
  const root = project();
  const refusal = error(root, 'cd pkg && node --test --test-skip-pattern="a b|c" "missing/*.test.js"');
  assert.match(String(refusal), /`node --test missing\/\*\.test\.js` matches no files under pkg/);
});
