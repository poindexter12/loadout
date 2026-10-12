import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-negative-control-thread-home-'));
const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-negative-control-thread-project-'));
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
    title: 'negative control thread fixture',
    description: 'Where: negative-control fixture. Contract: accept matching markers from the claim holder. Verify: inspect completion.',
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

const matchingTestName = 'sibling ensure retires dead records without deleting replacement worker and proxy records';
const firstControl = `[sidequest:negative-control] target=plugins/model-gateway/lib/process-supervision.js proxy ownership branch; assertion=pidRecordLines in ${matchingTestName}; node --test --test-timeout=120000 --test-name-pattern="sibling ensure retires" test/gateway-process-isolation.test.js failed=1. Disabling proxy ownership added a live proxy retirement line, then the branch was restored.\n[sidequest:negative-control-test] failed ${matchingTestName}`;
const secondControl = '[sidequest:negative-control] target=plugins/model-gateway/lib/process-supervision.js retirement wording; assertion=retired reused guardian message in ensure and stop discard a stale guardian PID without killing its reused process; node --test --test-timeout=120000 --test-name-pattern="ensure and stop discard" test/gateway-process-isolation.test.js failed=1. Restored the explicit retirement wording afterward.\n[sidequest:negative-control-test] failed ensure and stop discard a stale guardian PID without killing its reused process';
const standaloneMarker = `[sidequest:negative-control-test] failed ${matchingTestName}`;
// Written as `${fixtureTestDefinition}(...)` rather than the literal word
// "test(" so this fixture-authoring line is never mistaken by diff-based
// test-name extraction for a real `test(...)` definition in this file.
const fixtureTestDefinition = 'test';

test('negative controls collect claim-holder test markers across the whole thread', () => {
  const by = 'sq-2483-a2e99bb20c82';
  const ticket = createClaimedMixedChangeTicket(by);
  fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'fixture.test.js'), `${fixtureTestDefinition}('${matchingTestName}', () => {});\n`);

  for (const body of [firstControl, secondControl, standaloneMarker]) {
    assert.equal(store.addComment(slug, ticket.ref, { by, body, source: 'mcp' }).ok, true);
  }

  const completion = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete] passed: fixture verification passed.',
    source: 'mcp',
  });
  assert.equal(completion.ok, true, completion.message);

  const unreportedTestName = 'another changed assertion still needs negative-control evidence';
  fs.appendFileSync(path.join(PROJECT_DIR, 'test', 'fixture.test.js'), `${fixtureTestDefinition}('${unreportedTestName}', () => {});\n`);
  const refusal = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete] passed: fixture verification passed.',
    source: 'mcp',
  });
  assert.equal(refusal.reason, 'negative_control_test_required');
  assert.match(refusal.message, new RegExp(unreportedTestName));
  assert.match(refusal.message, new RegExp(standaloneMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const prefixedMarker = `[sidequest:negative-control-test] failed   pidRecordLines in ${unreportedTestName}`;
  assert.equal(store.addComment(slug, ticket.ref, { by, body: prefixedMarker, source: 'mcp' }).ok, true);
  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete] passed: fixture verification passed.',
    source: 'mcp',
  }).ok, true);
});

test('negative control ignores prose that denies an import or collection problem', () => {
  git(['checkout', '--', 'lib/fixture.js', 'test/fixture.test.js']);
  const by = 'sq-181-negation-prose';
  const ticket = createClaimedMixedChangeTicket(by);
  fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'fixture.test.js'), `${fixtureTestDefinition}('${matchingTestName}', () => {});\n`);

  // Same repro as the SQ-175 thread: the executor's marker line reports a
  // genuine assertion failure, and a separate prose line explicitly denies
  // it was an import/collection error. That denial must not be keyword
  // matched as a reported import/collection error.
  const negatedProseControl = [
    `[sidequest:negative-control] target=lib/fixture.js:1; assertion=${matchingTestName}; npm run test:files test/fixture.test.js failed=1`,
    'None of these is an import or collection error, they are genuine assertion failures on the changed value.',
    `[sidequest:negative-control-test] failed ${matchingTestName}`,
  ].join('\n');
  assert.equal(store.addComment(slug, ticket.ref, { by, body: negatedProseControl, source: 'mcp' }).ok, true);

  const completion = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete] passed: fixture verification passed.',
    source: 'mcp',
  });
  assert.equal(completion.ok, true, completion.message);
});

test('negative control ignores same-line prose that denies an import or collection problem', () => {
  git(['checkout', '--', 'lib/fixture.js', 'test/fixture.test.js']);
  const by = 'sq-181-negation-sameline';
  const ticket = createClaimedMixedChangeTicket(by);
  fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'fixture.test.js'), `${fixtureTestDefinition}('${matchingTestName}', () => {});\n`);

  const sameLineNegationControl = [
    `[sidequest:negative-control] target=lib/fixture.js:1; assertion=${matchingTestName}; npm run test:files test/fixture.test.js failed=1 (this is not an import error or a collection error, just an assertion failure)`,
    `[sidequest:negative-control-test] failed ${matchingTestName}`,
  ].join('\n');
  assert.equal(store.addComment(slug, ticket.ref, { by, body: sameLineNegationControl, source: 'mcp' }).ok, true);

  const completion = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete] passed: fixture verification passed.',
    source: 'mcp',
  });
  assert.equal(completion.ok, true, completion.message);
});

test('negative control test names unescape source string literals instead of demanding literal backslashes', () => {
  const by = 'sq-2485-c47a1dbe9f03';
  const ticket = createClaimedMixedChangeTicket(by);
  const fixtureTestDefinition = 'test';
  // The runner prints this name unescaped: `the gateway's wrapped proxy retries once`.
  // In source, the apostrophe must be backslash-escaped to stay inside the single-quoted
  // string literal, so the file on disk literally contains `gateway\'s`.
  const printedTestName = "the gateway's wrapped proxy retries once";
  fs.writeFileSync(
    path.join(PROJECT_DIR, 'test', 'fixture.test.js'),
    `${fixtureTestDefinition}('the gateway\\'s wrapped proxy retries once', () => {});\n`,
  );
  assert.match(
    fs.readFileSync(path.join(PROJECT_DIR, 'test', 'fixture.test.js'), 'utf8'),
    /gateway\\'s/,
  );

  const escapedQuoteControl = `[sidequest:negative-control] target=lib/fixture.js escaped-quote branch; assertion=printed name in ${printedTestName}; node --test test/fixture.test.js failed=1. Restored afterward.\n[sidequest:negative-control-test] failed ${printedTestName}`;
  assert.equal(store.addComment(slug, ticket.ref, { by, body: escapedQuoteControl, source: 'mcp' }).ok, true);

  const completion = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete] passed: fixture verification passed.',
    source: 'mcp',
  });
  assert.equal(completion.ok, true, completion.message);
});

function resetFixtureTree() {
  git(['checkout', '--', 'lib/fixture.js', 'test/fixture.test.js']);
}

function commitBaseFile(relativePath: string, content: string) {
  fs.mkdirSync(path.dirname(path.join(PROJECT_DIR, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, relativePath), content);
  git(['add', '--', relativePath]);
  git(['commit', '-m', `base ${relativePath}`, '--', relativePath]);
}

const genuineControl = (assertion: string) => `[sidequest:negative-control] target=lib/fixture.js:1; assertion=${assertion}; npm run test:files test/fixture.test.js failed=10`;

test('SQ-323: a changed bash test file does not turn quoted fixture data in a function body into required test names', () => {
  resetFixtureTree();
  // Mirrors iarx-com/github-terraform tests/verify.sh check_repo_survey_fail_closed:
  // the jq regex filter and quoted repo names are DATA inside a bash function,
  // never test definitions. Written through fixtureTestDefinition so this
  // authoring line is not itself mistaken for a JS test(...) definition.
  const baseSuite = [
    '#!/usr/bin/env bash',
    'check_repo_survey_fail_closed() {',
    '  local out',
    '  out=$(survey --repos alpha,bravo,charlie,delta,echo,foxtrot)',
    `  echo "$out" | jq -e '[.[] | select(.name | ${fixtureTestDefinition}("^(bravo|charlie|delta|echo|foxtrot)$"))] | length == 5'`,
    `  echo "$out" | jq -e '.[] | select(.name == "bravo")'`,
    '}',
    '',
    'ver_026() {',
    '  check_repo_survey_fail_closed',
    '}',
    '',
  ].join('\n');
  commitBaseFile('test/verify.sh', baseSuite);
  const by = 'sq-323-bash-fixture-data';
  const ticket = createClaimedMixedChangeTicket(by, ['lib/fixture.js', 'test/verify.sh']);
  fs.writeFileSync(
    path.join(PROJECT_DIR, 'test', 'verify.sh'),
    baseSuite.replace('  check_repo_survey_fail_closed\n}', '  check_repo_survey_fail_closed\n  echo ver_026 done\n}')
      + 'ver_027() {\n  echo "types catalog"\n}\n',
  );

  assert.equal(store.addComment(slug, ticket.ref, { by, body: genuineControl('ver_027 types catalog'), source: 'mcp' }).ok, true);
  const completion = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete] passed: fixture verification passed.',
    source: 'mcp',
  });
  assert.equal(completion.ok, true, completion.message);
  git(['checkout', '--', 'test/verify.sh']);
});

test('SQ-323: a regex literal .test() call inside a changed JS test body is data, not a test definition', () => {
  resetFixtureTree();
  const realName = 'survey refuses unknown repos';
  const by = 'sq-323-js-regex-call';
  const ticket = createClaimedMixedChangeTicket(by);
  fs.writeFileSync(
    path.join(PROJECT_DIR, 'test', 'fixture.test.js'),
    `${fixtureTestDefinition}('${realName}', () => {\n  assert.ok(/^(bravo|charlie)$/.${fixtureTestDefinition}('bravo'));\n});\n`,
  );
  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: `${genuineControl(realName)}\n[sidequest:negative-control-test] failed ${realName}`,
    source: 'mcp',
  }).ok, true);
  const completion = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete] passed: fixture verification passed.',
    source: 'mcp',
  });
  assert.equal(completion.ok, true, completion.message);
});

test('SQ-323: the refusal quotes each required test name and an unaffected <name> because <reason> marker clears it', () => {
  resetFixtureTree();
  const firstName = 'retries, then gives up';
  const secondName = 'reports the survey | summary';
  const by = 'sq-323-unaffected-marker';
  const ticket = createClaimedMixedChangeTicket(by);
  fs.writeFileSync(
    path.join(PROJECT_DIR, 'test', 'fixture.test.js'),
    `${fixtureTestDefinition}('${firstName}', () => {});\n${fixtureTestDefinition}('${secondName}', () => {});\n`,
  );
  assert.equal(store.addComment(slug, ticket.ref, { by, body: genuineControl('fixture value'), source: 'mcp' }).ok, true);

  const refusal = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete] passed: fixture verification passed.',
    source: 'mcp',
  });
  assert.equal(refusal.reason, 'negative_control_test_required');
  // Each name is quoted, so a name holding a comma or a pipe stays one name.
  assert.ok(refusal.message.includes(JSON.stringify(firstName)), refusal.message);
  assert.ok(refusal.message.includes(JSON.stringify(secondName)), refusal.message);

  // The consolidated comment form the SQ-13 executor used.
  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: [
      `[sidequest:negative-control-test] unaffected ${firstName} because the reverted branch is never reached by this test`,
      `[sidequest:negative-control-test] unaffected "${secondName}" because it only formats output the revert does not touch`,
    ].join('\n'),
    source: 'mcp',
  }).ok, true);
  const completion = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete] passed: fixture verification passed.',
    source: 'mcp',
  });
  assert.equal(completion.ok, true, completion.message);
});
