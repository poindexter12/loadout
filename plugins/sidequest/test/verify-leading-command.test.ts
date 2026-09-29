'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('../lib/store');

// poindexter12/loadout#23: the leading word of a command verify used to be looked up in a fixed tool
// allowlist, so `docker build ... && docker run ...` was refused as "not runnable" while
// `cd . && docker ...` passed. The rule is now typed: any executable name or path is runnable, and
// prose is still refused.

const RUNNABLE = /must start with a runnable command/;
const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');

function commandErrors(verify: string) {
  // `add` and `update` validate a command verify through this same entry point.
  return store.verifyOracleErrors('command', verify);
}

test('a verify that starts with docker is runnable (issue #23 repro)', () => {
  const repro = 'docker build -f docker/Dockerfile -t img:test . && docker run --rm img:test true';
  assert.deepStrictEqual(commandErrors(repro), []);
  assert.deepStrictEqual(store.verifyCommandErrors(repro), []);
  assert.strictEqual(store.verifyCommandError(repro), null);
});

test('a verify that starts with podman is runnable', () => {
  assert.deepStrictEqual(commandErrors('podman build -t img:test . && podman run --rm img:test true'), []);
});

test('any executable name is runnable, not only a fixed list of tools', () => {
  for (const verify of [
    'docker compose -f compose.test.yml run --rm app npm test',
    'kubectl apply --dry-run=client -f deploy/',
    'terraform -chdir=infra validate',
    'shellcheck scripts/release.sh',
    'ansible-playbook --syntax-check site.yml',
    'R CMD check .',
    '"docker" build .',
  ]) {
    assert.deepStrictEqual(commandErrors(verify), [], verify);
  }
});

test('path forms and the cd prefix stay runnable', () => {
  for (const verify of [
    './scripts/check.sh --strict',
    'bin/verify',
    '/usr/bin/env node --test',
    '"./tools/run tests.sh"',
    'cd . && docker build .',
    '(cd plugins/sidequest && npm run typecheck)',
    'npm run test',
  ]) {
    assert.deepStrictEqual(commandErrors(verify), [], verify);
  }
});

test('prose is still refused and the refusal names the word it read as prose', () => {
  const prose: Array<[string, string]> = [
    ['Read the rendered page source and confirm the required points.', 'Read'],
    ['confirm the dashboard renders without errors', 'confirm'],
    ['Run the unit tests and confirm they pass', 'Run'],
    ['Make sure the build passes', 'Make'],
    ['Tests pass', 'Tests'],
    ['Docker build succeeds', 'Docker'],
  ];
  for (const [verify, word] of prose) {
    const errors = commandErrors(verify);
    assert.strictEqual(errors.length, 1, `${verify}: ${errors.join(' | ')}`);
    assert.match(errors[0], RUNNABLE, verify);
    assert.ok(errors[0].includes(`\`${word}\` reads as prose, not an executable name or path.`), `${verify}: ${errors[0]}`);
  }
});

test('a leading flag or operator is not an executable name', () => {
  const flag = commandErrors('--rm img:test true');
  assert.strictEqual(flag.length, 1);
  assert.match(flag[0], RUNNABLE);

  const operator = commandErrors('&& docker run --rm img:test true');
  assert.strictEqual(operator.length, 1);
  assert.match(operator[0], RUNNABLE);
  assert.ok(!operator[0].includes('``'), operator[0]);
});

test('the refusal no longer implies an allowlist of tools', () => {
  const [message] = commandErrors('Run the suite');
  assert.match(message, /Any executable works, such as `npm run test`, `docker build \.`, `\.\/scripts\/check\.sh`, or `cd <repo-relative-dir> && <command>`\./);
  assert.match(message, /manual: <what you checked>/);
});

test('placeholders, multi-line commands and empty verifies keep their existing handling', () => {
  const placeholder = commandErrors('docker run <image>');
  assert.strictEqual(placeholder.length, 1);
  assert.match(placeholder[0], /unresolved placeholder/);

  const multiline = commandErrors('docker build .\ndocker run --rm img:test true');
  assert.strictEqual(multiline.length, 1);
  assert.match(multiline[0], /one runnable command line/);

  assert.deepStrictEqual(commandErrors(''), []);
  assert.deepStrictEqual(commandErrors('   '), []);
});

test('the add command accepts a docker verify and refuses a prose one', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-leading-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-leading-project-'));
  try {
    const env = Object.assign({}, process.env, { SIDEQUEST_HOME: home, CLAUDE_PROJECT_DIR: project });
    const run = (args: string[]) => spawnSync(process.execPath, [BIN, ...args, '--json'], { encoding: 'utf8', env });
    const repro = 'docker build -f docker/Dockerfile -t img:test . && docker run --rm img:test true';

    const added = run(['add', '-t', 'docker verify', '--unclassified', '--verify', repro]);
    assert.strictEqual(added.status, 0, added.stderr + added.stdout);
    assert.strictEqual(JSON.parse(added.stdout).ticket.executorVerify, repro);

    const prose = run(['add', '-t', 'prose verify', '--unclassified', '--verify', 'Run the docker image and confirm it starts']);
    assert.strictEqual(prose.status, 1);
    assert.match(prose.stderr + prose.stdout, RUNNABLE);
    assert.match(prose.stderr + prose.stdout, /`Run` reads as prose/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});
