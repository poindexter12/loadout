import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// SQ-213: a ';' inside the target or assertion field of a
// [sidequest:negative-control] marker broke the whole-line match (the gate
// used `[^;]+` for those fields), so a target or assertion naming a quoted
// test like `parses "a;b"` was rejected as malformed/missing evidence even
// though the marker reported a genuine non-zero failure. The fix makes the
// field regex tolerant of ';' inside target/assertion by matching the
// remainder up to the LAST "; assertion=" and the LAST "; " before the
// trailing "<command> failed=<n>", which is the real field boundary for the
// documented single-line format.

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-negative-control-marker-home-'));
const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-negative-control-marker-project-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;

const store = require('../lib/store.js');

function git(arguments_: string[]) {
  return execFileSync('git', arguments_, { cwd: PROJECT_DIR, encoding: 'utf8', windowsHide: true }).trim();
}

git(['init', '-b', 'main']);
git(['config', 'user.name', 'Sidequest Test']);
git(['config', 'user.email', 'sidequest-test@example.invalid']);
fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
fs.mkdirSync(path.join(PROJECT_DIR, 'test'), { recursive: true });
fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'module.exports = 1;\n');
fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'fixture.test.js'), 'module.exports = 1;\n');
git(['add', '.']);
git(['commit', '-m', 'base']);

const { slug } = store.ensureProject(PROJECT_DIR);
const codingNormal = store.getCategory('coding.normal');
store.setCategory(Object.assign({}, codingNormal, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));

function createClaimedMixedChangeTicket(by: string, files: string[] = ['lib/fixture.js', 'test/fixture.test.js']) {
  const ticket = store.createTicket(slug, {
    title: 'negative control marker fixture',
    description: 'Where: negative-control marker fixture. Contract: accept a target or assertion field containing a semicolon. Verify: inspect completion.',
    category: 'coding.normal',
    files,
    source: 'test',
  });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: true, sessionId: `${ticket.ref}-session` });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId: `${ticket.ref}-session`,
    agentName: prepared.ticket.dispatch.launchName,
    source: 'test',
  }).ok, true);
  assert.equal(store.claimTicket(slug, ticket.ref, by, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId: `${ticket.ref}-session`,
    source: 'test',
  }).ok, true);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'module.exports = 2;\n');
  return ticket;
}

function resetFixtureTree() {
  git(['checkout', '--', 'lib/fixture.js', 'test/fixture.test.js']);
}

test('negative control marker whose target contains a semicolon is accepted', () => {
  const matchingTestName = 'parses "a;b" without truncating the target field';
  const by = 'sq-213-target-semicolon';
  const ticket = createClaimedMixedChangeTicket(by);
  fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'fixture.test.js'), `test('${matchingTestName}', () => {});\n`);

  const control = [
    `[sidequest:negative-control] target=lib/fixture.js:1 parses "a;b" branch; assertion=${matchingTestName}; npm run test:files test/fixture.test.js failed=1`,
    `[sidequest:negative-control-test] failed ${matchingTestName}`,
  ].join('\n');
  const recorded = store.addComment(slug, ticket.ref, { by, body: control, source: 'mcp' });
  assert.equal(recorded.ok, true, recorded.message);

  const completion = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete] passed: fixture verification passed.',
    source: 'mcp',
  });
  assert.equal(completion.ok, true, completion.message);
});

test('negative control marker whose assertion contains a semicolon is accepted', () => {
  resetFixtureTree();
  const matchingTestName = 'reports "x;y" as the failing assertion';
  const by = 'sq-213-assertion-semicolon';
  const ticket = createClaimedMixedChangeTicket(by);
  fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'fixture.test.js'), `test('${matchingTestName}', () => {});\n`);

  const control = [
    `[sidequest:negative-control] target=lib/fixture.js:1; assertion=${matchingTestName} expects "x;y"; npm run test:files test/fixture.test.js failed=1`,
    `[sidequest:negative-control-test] failed ${matchingTestName}`,
  ].join('\n');
  const recorded = store.addComment(slug, ticket.ref, { by, body: control, source: 'mcp' });
  assert.equal(recorded.ok, true, recorded.message);

  const completion = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete] passed: fixture verification passed.',
    source: 'mcp',
  });
  assert.equal(completion.ok, true, completion.message);
});

test('negative control marker still requires both target and assertion fields', () => {
  resetFixtureTree();
  const matchingTestName = 'still needs a target and an assertion';
  const by = 'sq-213-missing-fields';
  const ticket = createClaimedMixedChangeTicket(by);
  fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'fixture.test.js'), `test('${matchingTestName}', () => {});\n`);

  const control = `[sidequest:negative-control] target=; assertion=; npm run test:files test/fixture.test.js failed=1`;
  assert.equal(store.addComment(slug, ticket.ref, { by, body: control, source: 'mcp' }).ok, true);

  const refusal = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete] passed: fixture verification passed.',
    source: 'mcp',
  });
  assert.equal(refusal.ok, false);
  assert.equal(refusal.reason, 'negative_control_evidence_required', refusal.message);
});
