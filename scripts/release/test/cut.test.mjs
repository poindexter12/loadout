// Behaviour of a cut, against a real repository. What the engine writes, what it refuses, and what
// it leaves alone are all statements about a tree, so they are tested against one.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import * as cutModule from '../cut.mjs';
import { assertGitHubReleasePublished, assertParentCiPassed, cut, defaultSuiteRunner } from '../cut.mjs';
import { createGit, spawnRunner } from '../lib/git.mjs';
import { readValue } from '../lib/jsonedit.mjs';
import { makeGitRepo } from './realrepo.mjs';

const PLUGINS = { 'codex-gateway': '0.33.4', sidequest: '3.6.17', toolbelt: '0.63.6' };

// An annotated tag stamped with an explicit tagger. The environment outranks any configured
// identity, so the tagger is exactly this one wherever the suite runs.
function tagAs(context, { name, email }, tag, target) {
  const result = spawnSync('git', ['tag', '-a', tag, '-m', `${tag} by ${name}`, target], {
    cwd: context.root,
    encoding: 'utf8',
    env: { ...process.env, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
  });
  assert.equal(result.status, 0, result.stderr);
}

const failingSuite = (suite) => ({ code: 1, command: suite.command });

// A second remote this clone can read: an empty bare repository beside origin.
function addRemote(context, name) {
  const dir = path.join(context.base, `${name}.git`);
  const result = spawnSync('git', ['init', '-q', '--bare', '-b', 'main', dir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  context.git('remote', 'add', name, dir);
  return dir;
}

async function rejection(promise) {
  let failure;
  await assert.rejects(promise, (error) => {
    failure = error;
    return true;
  });
  return failure;
}

// A commit made directly in origin on top of `parent`, so this clone has never seen it: the remote
// moved on without a fetch. Origin's main is left pointing at it.
function commitOnOrigin(context, parent, message) {
  const commit = context.originGit(
    '-c', 'user.name=someone else', '-c', 'user.email=someone@else.example',
    'commit-tree', `${parent}^{tree}`, '-p', parent, '-m', message,
  );
  context.originGit('update-ref', 'refs/heads/main', commit);
  return commit;
}

// Real git, except that every command `fails` matches exits 128 as if the remote were unreachable.
function gitFailing(context, fails) {
  const real = spawnRunner(context.root);
  return createGit({
    cwd: context.root,
    run: (args) => (fails(args) ? { code: 128, stdout: '', stderr: `forced failure: git ${args.join(' ')}` } : real(args)),
  });
}

// A probe gets PROBE_TIMEOUT_MS; a blocking host holds on for SSH_BLOCK_MS; a cut that refuses
// within PROBE_DEADLINE_MS did not wait for the block to end.
const PROBE_TIMEOUT_MS = 1000;
const PROBE_DEADLINE_MS = 15_000;
const SSH_BLOCK_MS = 30_000;
const BLOCKING_ORIGIN = 'ssh://blocking.invalid/origin.git';

// A stand-in for ssh, named ssh so git treats it as OpenSSH. It logs each call's arguments and the
// GIT_TERMINAL_PROMPT it saw. A call to blocking.invalid never answers: it holds the connection
// open, as a blackholed host or a password prompt would, until git goes away (its stdin closes) or
// SSH_BLOCK_MS pass. Any other host is served by running the requested git command locally, so
// ssh://<host><path> reaches the repository at <path>.
function fakeSsh(context) {
  const dir = path.join(context.base, 'fake-ssh');
  mkdirSync(dir);
  const log = path.join(dir, 'calls.jsonl');
  const script = path.join(dir, 'ssh.mjs');
  writeFileSync(script, [
    "import { spawnSync } from 'node:child_process';",
    "import { appendFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, prompt: process.env.GIT_TERMINAL_PROMPT ?? null }) + '\\n');`,
    "if (args.some((arg) => arg.includes('blocking.invalid'))) {",
    `  setTimeout(() => process.exit(255), ${SSH_BLOCK_MS});`,
    "  process.stdin.on('end', () => process.exit(255)).resume();",
    '} else {',
    "  process.exit(spawnSync('sh', ['-c', args[args.length - 1]], { stdio: 'inherit' }).status ?? 255);",
    '}',
    '',
  ].join('\n'));
  const ssh = path.join(dir, 'ssh');
  writeFileSync(ssh, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o755 });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { ssh, calls };
}

// Sets (or, for undefined, clears) process variables until the test ends, the way an operator's
// shell would hand them to the cut's git.
function useEnvironment(t, entries) {
  for (const [name, value] of Object.entries(entries)) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

// The operator's own ssh command is the fake, so every ssh remote this test names goes through it.
function sshThroughFake(t, context) {
  const fake = fakeSsh(context);
  useEnvironment(t, { GIT_SSH_COMMAND: `'${fake.ssh}' -o ServerAliveInterval=7`, GIT_SSH: undefined });
  return fake;
}

// Real git with probes bounded at PROBE_TIMEOUT_MS, except that each command `blocks` matches asks
// a host that never answers in place of origin. `blocked` records which of them ran.
function gitBlocking(context, blocks, blocked = []) {
  const real = spawnRunner(context.root, { remoteTimeoutMs: PROBE_TIMEOUT_MS });
  return createGit({
    cwd: context.root,
    run: (args) => {
      if (!blocks(args)) return real(args);
      blocked.push(args.join(' '));
      return real(args.map((arg) => (arg === 'origin' ? BLOCKING_ORIGIN : arg)));
    },
  });
}

function assertBatchProbes(calls, label) {
  assert.ok(calls.length > 0, `${label}: the probes went through ssh`);
  for (const { args, prompt } of calls) {
    assert.equal(prompt, '0', `${label}: terminal prompts are off for ${args.join(' ')}`);
    const batch = args.findIndex((arg, index) => arg === 'BatchMode=yes' && args[index - 1] === '-o');
    assert.ok(batch > 0, `${label}: ssh runs in batch mode for ${args.join(' ')}`);
  }
}

function stubLock(events) {
  return {
    acquire: async () => {
      events.push('acquire');
      return { ok: true };
    },
    release: async () => {
      events.push('release');
      return { ok: true };
    },
  };
}

/**
 * Cuts with a committer date one minute past `attempt`. A retry in the same second as the attempt
 * rebuilds a byte-identical release commit, so without this a fast runner cannot tell a recreated
 * tag from one that never moved.
 */
async function cutAfter(context, attempt, options) {
  const later = `${Number(context.git('log', '-1', '--format=%ct', attempt)) + 60} +0000`;
  const saved = { author: process.env.GIT_AUTHOR_DATE, committer: process.env.GIT_COMMITTER_DATE };
  process.env.GIT_AUTHOR_DATE = later;
  process.env.GIT_COMMITTER_DATE = later;
  try {
    return await cut(options);
  } finally {
    for (const [key, value] of [['GIT_AUTHOR_DATE', saved.author], ['GIT_COMMITTER_DATE', saved.committer]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function releaseSubjects(context) {
  return context.git('log', '--all', '--format=%s').split('\n').filter((subject) => /^release v/.test(subject));
}

function setup(t, options = {}) {
  const repo = makeGitRepo({ plugins: PLUGINS, ...options });
  t.after(repo.cleanup);
  const suites = [];
  return {
    ...repo,
    suites,
    runSuite: (suite) => {
      suites.push(suite.plugin);
      return { code: 0, command: suite.command };
    },
    read: (relative) => readFileSync(path.join(repo.root, relative), 'utf8'),
    exists: (relative) => existsSync(path.join(repo.root, relative)),
    version: (name) => readValue(readFileSync(path.join(repo.root, `plugins/${name}/.claude-plugin/plugin.json`), 'utf8'), ['version']),
    entryVersion: (name) => JSON.parse(readFileSync(path.join(repo.root, '.claude-plugin/marketplace.json'), 'utf8'))
      .plugins.find((entry) => entry.name === name).version,
    marketplaceVersion: () => JSON.parse(readFileSync(path.join(repo.root, '.claude-plugin/marketplace.json'), 'utf8')).version,
  };
}

test('a normal cut moves three version fields and nothing else', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  context.writeFragment('SQ-2', { plugins: ['sidequest'], bump: 'minor' });
  context.writeFragment('SQ-3', { plugins: ['toolbelt'], bump: 'patch' });
  context.commit('integrate');

  const result = await cut({ repoRoot: context.root, runSuite: context.runSuite, log: () => {} });

  assert.equal(result.status, 'cut');
  assert.equal(context.version('sidequest'), '3.7.0', 'the highest level wins');
  assert.equal(context.entryVersion('sidequest'), '3.7.0');
  assert.equal(context.version('toolbelt'), '0.63.7');
  assert.equal(context.entryVersion('toolbelt'), '0.63.7');
  assert.equal(context.marketplaceVersion(), '3.208.0');
  assert.equal(context.version('codex-gateway'), '0.33.4', 'an untouched plugin never moves');
  assert.equal(context.entryVersion('codex-gateway'), '0.33.4');
  assert.deepEqual(context.suites, ['sidequest', 'toolbelt'], 'only the changed plugins are verified');
});

test('the release commit contains exactly what the cut generated', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'minor' });
  context.writeFragment('SQ-2', { plugins: ['toolbelt'], bump: 'patch' });
  context.commit('integrate');

  const result = await cut({ repoRoot: context.root, skipTests: true, log: () => {} });

  assert.equal(result.message, 'release v3.208.0: sidequest 3.7.0, toolbelt 0.63.7 (SQ-1, SQ-2)');
  assert.deepEqual(context.git('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort(), [
    '.claude-plugin/marketplace.json',
    '.release/unreleased/SQ-1.md',
    '.release/unreleased/SQ-2.md',
    'CHANGELOG.md',
    'plugins/sidequest/.claude-plugin/plugin.json',
    'plugins/sidequest/CHANGELOG.md',
    'plugins/toolbelt/.claude-plugin/plugin.json',
    'plugins/toolbelt/CHANGELOG.md',
  ]);
  assert.deepEqual(context.git('tag', '--list').split('\n').sort(), ['sidequest-v3.7.0', 'toolbelt-v0.63.7', 'v3.208.0']);
  for (const tag of result.plan.tags) {
    assert.equal(context.git('rev-list', '-n', '1', `refs/tags/${tag}`), result.commit);
  }
});

test('a cut generates the changelogs and consumes the fragments it used', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'minor' });
  context.writeFragment('SQ-2', { plugins: ['toolbelt'], bump: 'patch', hold: true });
  context.commit('integrate');

  const result = await cut({ repoRoot: context.root, skipTests: true, log: () => {} });

  const changelog = context.read('CHANGELOG.md');
  assert.match(changelog, /^## v3\.208\.0 \(\d{4}-\d{2}-\d{2}\)$/m);
  assert.match(changelog, /### sidequest 3\.6\.17 → 3\.7\.0/);
  assert.doesNotMatch(changelog, /SQ-2/, 'a held fragment is not in the changelog');
  assert.match(context.read('plugins/sidequest/CHANGELOG.md'), /^## 3\.7\.0 \(\d{4}-\d{2}-\d{2}\)$/m);
  assert.equal(context.exists('plugins/toolbelt/CHANGELOG.md'), false, 'untouched plugins get no changelog');

  assert.equal(context.exists('.release/unreleased/SQ-1.md'), false, 'consumed');
  assert.equal(context.exists('.release/unreleased/SQ-2.md'), true, 'held fragments survive the cut');
  assert.deepEqual(result.consumed, ['.release/unreleased/SQ-1.md']);
});

test('rerunning the same cut releases nothing', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  context.commit('integrate');

  await cut({ repoRoot: context.root, skipTests: true, log: () => {} });
  const before = context.read('CHANGELOG.md');

  const again = await cut({ repoRoot: context.root, skipTests: true, log: () => {} });
  assert.equal(again.status, 'nothing-to-release');
  assert.equal(context.version('sidequest'), '3.6.18', 'the second run does not double-bump');
  assert.equal(context.marketplaceVersion(), '3.208.0');
  assert.equal(context.read('CHANGELOG.md'), before);
});

test('a queued copy of an already-released fragment cannot ship twice', async (t) => {
  const context = setup(t, {
    changelog: '# Changelog\n\n## v3.207.0 (2026-07-24)\n\n### sidequest 3.6.16 → 3.6.17\n\n#### Fixes\n- SQ-1 title (SQ-1)\n',
  });
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  context.commit('integrate');

  const result = await cut({ repoRoot: context.root, skipTests: true, log: () => {} });
  assert.equal(result.status, 'nothing-to-release');
  assert.equal(context.version('sidequest'), '3.6.17');
});

test('a dry run writes nothing and moves no ref', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'minor' });
  const integration = context.commit('integrate');

  const result = await cut({ repoRoot: context.root, dryRun: true, log: () => {} });

  assert.equal(result.status, 'dry-run');
  assert.equal(result.plan.plugins[0].to, '3.7.0');
  assert.equal(context.version('sidequest'), '3.6.17');
  assert.equal(context.exists('.release/unreleased/SQ-1.md'), true);
  assert.equal(context.exists('CHANGELOG.md'), false);
  assert.equal(context.git('rev-parse', 'HEAD'), integration, 'HEAD did not move');
  assert.equal(context.git('tag', '--list'), '', 'no tag was created');
});

test('.release/HOLD stops a normal window and --force overrides it', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  context.write('.release/HOLD', 'waiting on the docs ticket\n');
  context.commit('integrate under a hold');

  const held = await cut({ repoRoot: context.root, skipTests: true, log: () => {} });
  assert.equal(held.status, 'held');
  assert.equal(held.reason, 'waiting on the docs ticket');
  assert.equal(context.version('sidequest'), '3.6.17');

  const forced = await cut({ repoRoot: context.root, skipTests: true, force: true, log: () => {} });
  assert.equal(forced.status, 'cut');
  assert.equal(context.version('sidequest'), '3.6.18');
});

test('local tags from an unpublished attempt explain how to recover', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const integration = context.commit('integrate');
  // Annotated and stamped by this clone's identity, exactly as a cut makes its tags.
  context.git('tag', '-a', 'v3.208.0', '-m', 'v3.208.0', integration);
  context.git('tag', '-a', 'sidequest-v3.6.18', '-m', 'sidequest-v3.6.18', integration);

  await assert.rejects(
    () => cut({ repoRoot: context.root, skipTests: true, log: () => {} }),
    /local tags are leftovers from an unpublished attempt: v3\.208\.0, sidequest-v3\.6\.18\. origin has none of them.*git tag -d v3\.208\.0 sidequest-v3\.6\.18 and retry, or pass --force/s,
  );
  assert.equal(context.version('sidequest'), '3.6.17');
  assert.equal(context.git('rev-list', '-n', '1', 'refs/tags/v3.208.0'), integration, 'the existing tag did not move');

  const forced = await cut({ repoRoot: context.root, skipTests: true, force: true, log: () => {} });
  assert.equal(forced.status, 'cut');
  for (const tag of forced.plan.tags) {
    assert.equal(context.git('rev-list', '-n', '1', `refs/tags/${tag}`), forced.commit, `${tag} moved to the new release commit`);
  }
});

test('a local-only tag another remote fetched is named as foreign, with the tagOpt fix instead of the leftover advice', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const integration = context.commit('integrate');
  context.git('remote', 'add', 'upstream', path.join(context.base, 'never-contacted.git'));
  tagAs(context, { name: 'Kenny Vaneetvelde', email: 'kenny@upstream.example' }, 'v3.208.0', integration);
  context.git('tag', 'sidequest-v3.6.18', integration);

  let failure;
  await assert.rejects(
    () => cut({ repoRoot: context.root, skipTests: true, log: () => {} }),
    (error) => {
      failure = error;
      return true;
    },
  );

  assert.match(failure.message, /not made by this clone's release identity/);
  assert.match(failure.message, /v3\.208\.0 \(tagged by Kenny Vaneetvelde <kenny@upstream\.example>\)/);
  assert.match(failure.message, /sidequest-v3\.6\.18 \(lightweight, no tagger\)/);
  assert.match(failure.message, /git tag -d v3\.208\.0 sidequest-v3\.6\.18/);
  assert.match(failure.message, /git config remote\.upstream\.tagOpt --no-tags/);
  assert.doesNotMatch(failure.message, /remote\.origin\.tagOpt/, 'the publish remote keeps its tags');
  assert.doesNotMatch(failure.message, /leftovers from an unpublished attempt/);
  assert.equal(context.version('sidequest'), '3.6.17');
  assert.equal(context.git('tag', '--list'), 'sidequest-v3.6.18\nv3.208.0', 'classifying deletes nothing');
});

test('loadout.releaseTagger makes another identity count as this fork\'s release tagger', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const integration = context.commit('integrate');
  tagAs(context, { name: 'Former Maintainer', email: 'former@fork.example' }, 'v3.208.0', integration);

  await assert.rejects(
    () => cut({ repoRoot: context.root, skipTests: true, log: () => {} }),
    /v3\.208\.0 \(tagged by Former Maintainer <former@fork\.example>\)/,
  );

  context.git('config', '--add', 'loadout.releaseTagger', 'former@fork.example');
  await assert.rejects(
    () => cut({ repoRoot: context.root, skipTests: true, log: () => {} }),
    /local tags are leftovers from an unpublished attempt: v3\.208\.0/,
  );
});

test('this fork\'s local-only tag on a commit the remote already has is pushed, not deleted', async (t) => {
  const context = setup(t);
  const published = context.originGit('rev-parse', 'main');
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  context.commit('integrate');
  context.git('tag', '-a', 'v3.208.0', '-m', 'v3.208.0', published);

  let failure;
  await assert.rejects(
    () => cut({ repoRoot: context.root, skipTests: true, log: () => {} }),
    (error) => {
      failure = error;
      return true;
    },
  );

  assert.match(failure.message, /mark commits origin\/main already contains, but never reached origin: v3\.208\.0/);
  assert.match(failure.message, /git push --atomic origin refs\/tags\/v3\.208\.0:refs\/tags\/v3\.208\.0/);
  assert.doesNotMatch(failure.message, /leftovers from an unpublished attempt/);
  assert.equal(context.git('rev-list', '-n', '1', 'refs/tags/v3.208.0'), published, 'the tag did not move');
});

test('--force recreates a leftover tag with -f but creates every other planned tag without it', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const integration = context.commit('integrate');
  context.git('tag', '-a', 'v3.208.0', '-m', 'v3.208.0', integration);
  const calls = [];
  const git = createGit({ cwd: context.root, onCommand: (entry) => calls.push(entry.args.join(' ')) });

  const result = await cut({ repoRoot: context.root, git, skipTests: true, force: true, log: () => {} });

  assert.equal(result.status, 'cut');
  const tagCalls = calls.filter((call) => call.startsWith('tag ') && call.includes(' -a '));
  assert.deepEqual(tagCalls.map((call) => call.split(' -m ')[0]), ['tag -f -a v3.208.0', 'tag -a sidequest-v3.6.18']);
  for (const tag of result.plan.tags) assert.equal(context.git('rev-list', '-n', '1', `refs/tags/${tag}`), result.commit);
});

test('--force refuses a foreign local tag and leaves it, and this clone\'s leftover beside it, exactly where they were', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const integration = context.commit('integrate');
  // Readable, so this clone's own tag beside the foreign one is provably a leftover.
  addRemote(context, 'upstream');
  tagAs(context, { name: 'Kenny Vaneetvelde', email: 'kenny@upstream.example' }, 'v3.208.0', integration);
  context.git('tag', '-a', 'sidequest-v3.6.18', '-m', 'sidequest-v3.6.18', integration);
  const foreignTag = context.git('rev-parse', 'refs/tags/v3.208.0');
  const leftoverTag = context.git('rev-parse', 'refs/tags/sidequest-v3.6.18');
  let failure;

  await assert.rejects(
    () => cut({ repoRoot: context.root, skipTests: true, force: true, log: () => {} }),
    (error) => {
      failure = error;
      return true;
    },
  );

  assert.match(failure.message, /--force recreates only this clone's own leftover local tags.*It does not override these, and nothing was changed:/s);
  assert.match(failure.message, /v3\.208\.0 \(tagged by Kenny Vaneetvelde <kenny@upstream\.example>\)/);
  assert.match(failure.message, /which --force would recreate once the tags above are resolved: sidequest-v3\.6\.18/);
  assert.equal(context.git('rev-parse', 'refs/tags/v3.208.0'), foreignTag, 'the foreign tag object, tagger and target, is untouched');
  assert.equal(context.git('rev-parse', 'refs/tags/sidequest-v3.6.18'), leftoverTag, 'a leftover is not recreated while a foreign tag blocks');
  assert.equal(context.git('rev-parse', 'HEAD'), integration);
  assert.deepEqual(releaseSubjects(context), []);
  assert.equal(context.version('sidequest'), '3.6.17');
});

test('--force refuses this clone\'s tag on a commit the remote has since built on, fetching what the clone never saw', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const integration = context.commit('integrate');
  context.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
  context.git('tag', '-a', 'v3.208.0', '-m', 'v3.208.0', integration);
  const ourTag = context.git('rev-parse', 'refs/tags/v3.208.0');
  // origin/main now contains the tagged commit through a commit this clone does not have, so only
  // a fetch can tell that the tag marks a published commit rather than a leftover.
  const remoteTip = commitOnOrigin(context, integration, 'built on the integration commit');
  const trackingBefore = context.git('rev-parse', 'refs/remotes/origin/main');
  let failure;

  await assert.rejects(
    () => cut({ repoRoot: context.root, skipTests: true, force: true, log: () => {} }),
    (error) => {
      failure = error;
      return true;
    },
  );

  assert.match(failure.message, /--force recreates only this clone's own leftover local tags/);
  assert.match(failure.message, /mark commits origin\/main already contains, but never reached origin: v3\.208\.0/);
  assert.doesNotMatch(failure.message, /leftovers from an unpublished attempt/);
  assert.equal(context.git('rev-parse', 'refs/tags/v3.208.0'), ourTag, 'the tag did not move');
  assert.equal(context.git('rev-parse', 'HEAD'), integration);
  assert.deepEqual(releaseSubjects(context), []);
  assert.equal(context.git('rev-parse', 'refs/remotes/origin/main'), trackingBefore, 'the reachability fetch moved no ref');
  assert.equal(context.git('cat-file', '-t', remoteTip), 'commit', 'the fetch brought in the commit the clone had never seen');
});

test('--force refuses this clone\'s tag when the remote branch cannot be checked', async (t) => {
  const failures = {
    'the branch cannot be read': (args) => args[0] === 'ls-remote' && args.includes('--exit-code'),
    'the branch cannot be fetched': (args) => args[0] === 'fetch',
  };
  for (const [label, fails] of Object.entries(failures)) {
    const context = setup(t);
    context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
    const integration = context.commit('integrate');
    context.git('tag', '-a', 'v3.208.0', '-m', 'v3.208.0', integration);
    const ourTag = context.git('rev-parse', 'refs/tags/v3.208.0');
    // The remote moved to a commit this clone lacks, so answering needs a fetch as well as a read.
    commitOnOrigin(context, context.originGit('rev-parse', 'main'), 'unrelated work');

    await assert.rejects(
      () => cut({ repoRoot: context.root, git: gitFailing(context, fails), skipTests: true, force: true, log: () => {} }),
      /could not tell whether origin\/main already contains the commits these local release tags mark: v3\.208\.0/,
      label,
    );
    assert.equal(context.git('rev-parse', 'refs/tags/v3.208.0'), ourTag, `${label}: the tag did not move`);
    assert.deepEqual(releaseSubjects(context), [], label);
  }
});

// Tagger identity names a person, not a clone: the same maintainer's other clone stamps the same
// name and email. So each case below uses a tag made by this clone's own identity, which the
// SQ-141 classifier took as proof of a leftover, and only remote evidence can tell it apart.
test('--force refuses a same-identity tag a second remote already has, and leaves it unmoved', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const integration = context.commit('integrate');
  addRemote(context, 'mirror');
  context.git('tag', '-a', 'v3.208.0', '-m', 'v3.208.0', integration);
  context.git('push', '-q', 'mirror', 'refs/tags/v3.208.0');
  const tagObject = context.git('rev-parse', 'refs/tags/v3.208.0');
  assert.equal(context.git('for-each-ref', '--contains', integration, 'refs/remotes/'), '', 'no remote-tracking ref contains the commit, so only the tag listing can tell');

  const failure = await rejection(cut({ repoRoot: context.root, skipTests: true, force: true, log: () => {} }));

  assert.match(failure.message, /--force recreates only this clone's own leftover local tags.*nothing was changed:/s);
  assert.match(failure.message, /these local release tags already exist on another configured remote, so they were published from somewhere and are not leftovers: v3\.208\.0 \(on mirror\)/);
  assert.doesNotMatch(failure.message, /leftovers from an unpublished attempt/);
  assert.equal(context.git('rev-parse', 'refs/tags/v3.208.0'), tagObject, 'the tag object, tagger and target, is untouched');
  assert.equal(context.git('rev-parse', 'HEAD'), integration);
  assert.deepEqual(releaseSubjects(context), []);
  assert.equal(context.version('sidequest'), '3.6.17');
});

test('--force refuses a same-identity tag whose commit a second remote\'s tracking branch contains', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const integration = context.commit('integrate');
  addRemote(context, 'mirror');
  // The mirror's branch was built on the tagged commit, so the commit is reachable, not the tip.
  const child = context.git('commit-tree', `${integration}^{tree}`, '-p', integration, '-m', 'built on the tagged commit');
  context.git('push', '-q', 'mirror', `${child}:refs/heads/feature`);
  assert.equal(context.git('rev-parse', 'refs/remotes/mirror/feature'), child, 'the push left a remote-tracking branch');
  context.git('tag', '-a', 'v3.208.0', '-m', 'v3.208.0', integration);
  assert.equal(context.git('ls-remote', '--tags', 'mirror'), '', 'no remote has the tag itself, so only reachability can tell');
  const tagObject = context.git('rev-parse', 'refs/tags/v3.208.0');

  const failure = await rejection(cut({ repoRoot: context.root, skipTests: true, force: true, log: () => {} }));

  assert.match(failure.message, /--force recreates only this clone's own leftover local tags/);
  assert.match(failure.message, /these local release tags mark commits a remote-tracking branch already contains, so no unpublished attempt left them: v3\.208\.0 \(in mirror\/feature\)/);
  assert.doesNotMatch(failure.message, /leftovers from an unpublished attempt: /);
  assert.equal(context.git('rev-parse', 'refs/tags/v3.208.0'), tagObject, 'the tag did not move');
  assert.equal(context.git('rev-parse', 'HEAD'), integration);
  assert.deepEqual(releaseSubjects(context), []);
});

test('--force still recreates a genuine leftover from an unpublished attempt when every remote answers without it', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const integration = context.commit('integrate');
  addRemote(context, 'mirror');
  // The mirror carries the integration commit, but never the release commit built on it.
  context.git('push', '-q', 'mirror', 'HEAD:refs/heads/main');

  // A real attempt: its suite fails, --keep-on-failure keeps the window, and the operator resets
  // the commit away but keeps the tags, the half of the undo that is easy to forget.
  await assert.rejects(
    () => cut({ repoRoot: context.root, keepOnFailure: true, runSuite: failingSuite, log: () => {} }),
    /release suites failed/,
  );
  const attempt = context.git('rev-parse', 'HEAD');
  assert.notEqual(attempt, integration);
  context.git('reset', '-q', '--hard', integration);
  assert.equal(context.git('rev-list', '-n', '1', 'refs/tags/v3.208.0'), attempt, 'the attempt left its tag behind');

  const result = await cutAfter(context, attempt, { repoRoot: context.root, skipTests: true, force: true, log: () => {} });

  assert.equal(result.status, 'cut');
  assert.notEqual(result.commit, attempt);
  for (const tag of result.plan.tags) {
    assert.equal(context.git('rev-list', '-n', '1', `refs/tags/${tag}`), result.commit, `${tag} was recreated at the new release commit`);
  }
});

test('--force refuses a same-identity tag when any remote, or the remote-tracking refs, cannot be checked', async (t) => {
  const cases = {
    'a configured remote does not answer': {
      prepare: (context) => context.git('remote', 'add', 'mirror', path.join(context.base, 'never-created.git')),
      fails: () => false,
      doubt: /v3\.208\.0 \(mirror could not be listed\)/,
    },
    'the remote-tracking refs cannot be searched': {
      prepare: () => {},
      fails: (args) => args[0] === 'for-each-ref' && args.includes('--contains'),
      doubt: /v3\.208\.0 \(the remote-tracking refs could not be searched\)/,
    },
    'the configured remotes cannot be listed': {
      prepare: () => {},
      fails: (args) => args.length === 1 && args[0] === 'remote',
      doubt: /v3\.208\.0 \(the configured remotes could not be listed\)/,
    },
  };
  for (const [label, { prepare, fails, doubt }] of Object.entries(cases)) {
    const context = setup(t);
    context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
    const integration = context.commit('integrate');
    prepare(context);
    context.git('tag', '-a', 'v3.208.0', '-m', 'v3.208.0', integration);
    const tagObject = context.git('rev-parse', 'refs/tags/v3.208.0');

    const failure = await rejection(
      cut({ repoRoot: context.root, git: gitFailing(context, fails), skipTests: true, force: true, log: () => {} }),
    );

    assert.match(failure.message, /could not prove these local release tags unpublished, so they are not treated as leftovers/, label);
    assert.match(failure.message, doubt, label);
    assert.doesNotMatch(failure.message, /leftovers from an unpublished attempt: /, label);
    assert.equal(context.git('rev-parse', 'refs/tags/v3.208.0'), tagObject, `${label}: the tag did not move`);
    assert.deepEqual(releaseSubjects(context), [], label);
  }
});

test('a remote probe keeps the operator\'s ssh command, adds BatchMode, and turns off terminal prompts', async (t) => {
  const cases = {
    'GIT_SSH_COMMAND': (context, fake) => ({
      environment: { GIT_SSH_COMMAND: `'${fake.ssh}' -o ServerAliveInterval=7`, GIT_SSH: undefined },
      kept: 'ServerAliveInterval=7',
    }),
    'core.sshCommand, which outranks GIT_SSH as it does in git': (context, fake) => {
      context.git('config', 'core.sshCommand', `'${fake.ssh}' -o ServerAliveInterval=9`);
      return { environment: { GIT_SSH_COMMAND: undefined, GIT_SSH: path.join(context.base, 'no-such-ssh') }, kept: 'ServerAliveInterval=9' };
    },
    'GIT_SSH': (context, fake) => ({ environment: { GIT_SSH_COMMAND: undefined, GIT_SSH: fake.ssh }, kept: null }),
  };
  for (const [label, prepare] of Object.entries(cases)) {
    const context = setup(t);
    const fake = fakeSsh(context);
    const { environment, kept } = prepare(context, fake);
    useEnvironment(t, environment);
    context.git('remote', 'set-url', 'origin', `ssh://served.invalid${context.origin}`);
    const git = createGit({ cwd: context.root });

    git.remoteTags('origin');
    assert.equal(git.remoteBranchTip('origin', 'main'), context.originGit('rev-parse', 'main'), `${label}: the remote answered`);
    assert.equal(git.fetchBranch('origin', 'main'), true, `${label}: the fetch went through`);

    const calls = fake.calls();
    assertBatchProbes(calls, label);
    if (kept) assert.ok(calls.every(({ args }) => args.includes(kept)), `${label}: ${kept} is kept`);
  }
});

test('--force refuses within the probe deadline, and leaves the tag unmoved, when a remote probe never answers', async (t) => {
  const cases = {
    'a second remote never answers its tag listing': {
      prepare: (context) => context.git('remote', 'add', 'mirror', 'ssh://blocking.invalid/mirror.git'),
      blocks: () => false,
      probe: null,
      refusal: /could not prove these local release tags unpublished[^]*v3\.208\.0 \(mirror could not be listed\)/,
    },
    'origin never answers its tag listing': {
      prepare: () => {},
      blocks: (args) => args[0] === 'ls-remote' && args.includes('--tags'),
      probe: 'ls-remote --tags origin',
      refusal: /git ls-remote --tags origin failed \(124\): no answer within 1000ms, so the remote could not be checked/,
    },
    'origin never answers for its publish branch': {
      prepare: () => {},
      blocks: (args) => args[0] === 'ls-remote' && args.includes('--exit-code'),
      probe: 'ls-remote --exit-code origin refs/heads/main',
      refusal: /could not tell whether origin\/main already contains the commits these local release tags mark: v3\.208\.0/,
    },
    'origin never answers the fetch of its publish branch': {
      // The remote moved to a commit this clone lacks, so answering needs a fetch as well as a read.
      prepare: (context) => commitOnOrigin(context, context.originGit('rev-parse', 'main'), 'unrelated work'),
      blocks: (args) => args[0] === 'fetch',
      probe: 'fetch',
      refusal: /could not tell whether origin\/main already contains the commits these local release tags mark: v3\.208\.0/,
    },
  };
  for (const [label, { prepare, blocks, probe, refusal }] of Object.entries(cases)) {
    const context = setup(t);
    const fake = sshThroughFake(t, context);
    context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
    const integration = context.commit('integrate');
    prepare(context);
    context.git('tag', '-a', 'v3.208.0', '-m', 'v3.208.0', integration);
    const tagObject = context.git('rev-parse', 'refs/tags/v3.208.0');
    const blocked = [];

    const started = Date.now();
    const failure = await rejection(
      cut({ repoRoot: context.root, git: gitBlocking(context, blocks, blocked), skipTests: true, force: true, log: () => {} }),
    );
    const elapsed = Date.now() - started;

    assert.ok(elapsed < PROBE_DEADLINE_MS, `${label}: refused after ${elapsed}ms, not within ${PROBE_DEADLINE_MS}ms`);
    if (probe) assert.ok(blocked.some((command) => command.startsWith(probe)), `${label}: ${probe} asked the host that never answers`);
    assert.ok(fake.calls().some(({ args }) => args.includes('blocking.invalid')), `${label}: the blocking host was asked`);
    assert.match(failure.message, refusal, label);
    assert.doesNotMatch(failure.message, /leftovers from an unpublished attempt: /, label);
    assert.equal(context.git('rev-parse', 'refs/tags/v3.208.0'), tagObject, `${label}: the tag did not move`);
    assert.deepEqual(releaseSubjects(context), [], label);
  }
});

test('--force still recreates a genuine leftover when every remote answers over ssh in batch mode', async (t) => {
  const context = setup(t);
  const fake = sshThroughFake(t, context);
  context.git('remote', 'set-url', 'origin', `ssh://served.invalid${context.origin}`);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const integration = context.commit('integrate');
  addRemote(context, 'mirror');
  context.git('push', '-q', 'mirror', 'HEAD:refs/heads/main');
  await assert.rejects(
    () => cut({ repoRoot: context.root, keepOnFailure: true, runSuite: failingSuite, log: () => {} }),
    /release suites failed/,
  );
  const attempt = context.git('rev-parse', 'HEAD');
  context.git('reset', '-q', '--hard', integration);

  const result = await cutAfter(context, attempt, { repoRoot: context.root, skipTests: true, force: true, log: () => {} });

  assert.equal(result.status, 'cut');
  assert.notEqual(result.commit, attempt);
  for (const tag of result.plan.tags) {
    assert.equal(context.git('rev-list', '-n', '1', `refs/tags/${tag}`), result.commit, `${tag} was recreated at the new release commit`);
  }
  const calls = fake.calls();
  assertBatchProbes(calls, 'origin over ssh');
  assert.ok(calls.every(({ args }) => args.includes('ServerAliveInterval=7')), 'the operator\'s own ssh options are kept');
});

test('--force refuses a planned tag that already exists on the remote, before the lock or any build', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const integration = context.commit('integrate');
  context.git('tag', 'v3.208.0', integration);
  context.git('push', '-q', 'origin', 'refs/tags/v3.208.0');
  context.git('tag', '-d', 'v3.208.0');
  const before = context.remoteRefs();
  const events = [];

  await assert.rejects(
    () => cut({ repoRoot: context.root, push: true, publishLock: stubLock(events), skipTests: true, force: true, log: () => {} }),
    /these tags already exist on origin: v3\.208\.0\..*--force does not change this: the cut never force-pushes/s,
  );

  assert.deepEqual(events, [], 'refused before the publish lock was taken');
  assert.equal(context.git('rev-parse', 'HEAD'), integration);
  assert.equal(context.git('tag', '--list'), '');
  assert.deepEqual(releaseSubjects(context), []);
  assert.equal(context.exists('.release/unreleased/SQ-1.md'), true);
  assert.deepEqual(context.remoteRefs(), before);
});

test('a plugin whose manifest and marketplace entry disagree blocks the cut', async (t) => {
  const context = setup(t);
  const manifestPath = path.join(context.root, 'plugins/sidequest/.claude-plugin/plugin.json');
  writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace('3.6.17', '3.6.12'));
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  context.commit('integrate with drifted versions');

  await assert.rejects(
    () => cut({ repoRoot: context.root, skipTests: true, log: () => {} }),
    /version mismatch.*marketplace\.json says 3\.6\.17.*says 3\.6\.12/s,
  );
});

test('a hotfix releases only its tickets and leaves the rest unreleased', async (t) => {
  const context = setup(t);
  context.onBranch('dev');
  context.write('plugins/toolbelt/urgent.js', '// urgent\n');
  const fixSha = context.commit('the urgent fix');
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'minor', commit: fixSha });
  context.writeFragment('SQ-2', { plugins: ['toolbelt'], bump: 'minor', commit: fixSha });
  const devSha = context.commit('note both tickets');
  context.onBranch('main');

  const result = await cut({
    repoRoot: context.root,
    mode: 'hotfix',
    tickets: ['SQ-2'],
    sha: devSha,
    skipTests: true,
    log: () => {},
  });

  assert.equal(result.status, 'cut');
  assert.equal(context.version('toolbelt'), '0.64.0');
  assert.equal(context.version('sidequest'), '3.6.17', 'the unreleased ticket stays unreleased');
  assert.equal(context.marketplaceVersion(), '3.207.1', 'a hotfix patches the counter');
  assert.deepEqual(result.plan.tags, ['v3.207.1', 'toolbelt-v0.64.0']);
  assert.match(context.read('CHANGELOG.md'), /Hotfix release cut from `main`/);
  assert.equal(context.exists('plugins/toolbelt/urgent.js'), true, 'the fix was cherry-picked');
});

test('a hotfix skips a cherry-pick that the publish branch already contains', async (t) => {
  const context = setup(t);
  context.write('plugins/toolbelt/already.js', '// already on main\n');
  const fixSha = context.commit('a fix that is already on main');
  context.onBranch('dev');
  context.git('merge', '-q', 'main');
  context.writeFragment('SQ-2', { plugins: ['toolbelt'], bump: 'patch', commit: fixSha });
  const devSha = context.commit('note it');
  context.onBranch('main');

  const result = await cut({ repoRoot: context.root, mode: 'hotfix', tickets: ['SQ-2'], sha: devSha, skipTests: true, log: () => {} });

  assert.equal(result.status, 'cut');
  assert.equal(context.version('toolbelt'), '0.63.7');
  assert.equal(
    context.git('log', '--format=%s', '-n', '2').split('\n')[1],
    'a fix that is already on main',
    'the release commit sits straight on the fix, with no duplicate cherry-pick',
  );
});

test('the cut refuses a dirty tree and the wrong branch', async (t) => {
  const dirty = setup(t);
  dirty.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  dirty.commit('integrate');
  writeFileSync(path.join(dirty.root, 'plugins/sidequest/index.js'), '// edited\n');
  await assert.rejects(() => cut({ repoRoot: dirty.root, skipTests: true, log: () => {} }), /uncommitted changes/);

  const wrongBranch = setup(t);
  wrongBranch.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  wrongBranch.commit('integrate');
  wrongBranch.onBranch('dev');
  wrongBranch.git('merge', '-q', 'main');
  await assert.rejects(() => cut({ repoRoot: wrongBranch.root, skipTests: true, log: () => {} }), /cutting from "dev"/);
});

test('a failing suite rolls the unpublished release back, leaving no release commit or tags', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const originalHead = context.commit('integrate');
  const before = context.remoteRefs();
  let failure;

  await assert.rejects(
    () => cut({
      repoRoot: context.root,
      push: true,
      log: () => {},
      runSuite: failingSuite,
    }),
    (error) => {
      failure = error;
      return /release suites failed, nothing was published/.test(error.message);
    },
  );

  assert.match(failure.message, new RegExp(`Rolled back the unpublished release: HEAD is back at ${originalHead} \\(git reset --hard\\)`));
  assert.doesNotMatch(failure.message, /git reset --hard [0-9a-f]{40}\n|git tag -d/, 'no manual undo is left to run');
  assert.equal(failure.rollback.status, 'rolled-back');
  assert.deepEqual(failure.rollback.deletedTags, ['v3.208.0', 'sidequest-v3.6.18']);
  assert.equal(context.git('rev-parse', 'HEAD'), originalHead);
  assert.deepEqual(releaseSubjects(context), [], 'no ref reaches a release commit');
  assert.equal(context.git('tag', '--list'), '', 'no local release tags remain');
  assert.equal(context.git('status', '--porcelain', '--untracked-files=no'), '', 'the tracked tree is the original head again');
  assert.equal(context.version('sidequest'), '3.6.17');
  assert.equal(context.exists('.release/unreleased/SQ-1.md'), true, 'the fragment is queued again');
  assert.deepEqual(context.remoteRefs(), before);
});

test('--keep-on-failure keeps a failed unpublished release and prints the recovery commands', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const originalHead = context.commit('integrate');
  const before = context.remoteRefs();
  let failure;

  await assert.rejects(
    () => cut({
      repoRoot: context.root,
      push: true,
      keepOnFailure: true,
      log: () => {},
      runSuite: failingSuite,
    }),
    (error) => {
      failure = error;
      return /release suites failed, nothing was published/.test(error.message);
    },
  );

  assert.equal(failure.rollback.status, 'kept');
  assert.match(failure.message, new RegExp(`git reset --hard ${originalHead}`));
  assert.match(failure.message, /git tag -d v3\.208\.0 sidequest-v3\.6\.18/);
  assert.match(failure.message, /A reset does not delete local tags/);
  assert.notEqual(context.git('rev-parse', 'HEAD'), originalHead, 'the release commit is kept');
  assert.equal(context.git('tag', '--list'), 'sidequest-v3.6.18\nv3.208.0', 'the release tags are kept');
  assert.deepEqual(context.remoteRefs(), before);
});

test('a rollback after an --allow-dirty start resets with --keep, so the operator\'s edits survive', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const originalHead = context.commit('integrate');
  writeFileSync(path.join(context.root, 'plugins/toolbelt/index.js'), '// operator edit, not part of the release\n');
  let failure;

  await assert.rejects(
    () => cut({ repoRoot: context.root, allowDirty: true, log: () => {}, runSuite: failingSuite }),
    (error) => {
      failure = error;
      return true;
    },
  );

  assert.equal(failure.rollback.status, 'rolled-back');
  assert.equal(failure.rollback.resetMode, '--keep');
  assert.equal(context.git('rev-parse', 'HEAD'), originalHead);
  assert.equal(context.git('tag', '--list'), '');
  assert.equal(context.read('plugins/toolbelt/index.js'), '// operator edit, not part of the release\n');
});

test('--allow-dirty refuses an edit to a manifest the release writes, before anything changes, so the edit survives', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const originalHead = context.commit('integrate');
  const manifestPath = 'plugins/sidequest/.claude-plugin/plugin.json';
  const edited = `${JSON.stringify({ name: 'sidequest', version: '3.6.17', license: 'MIT', description: 'operator edit, not part of the release' }, null, 2)}\n`;
  context.write(manifestPath, edited);
  const refusal = /--allow-dirty only tolerates changes outside the release, but these paths the release writes or removes have local changes: plugins\/sidequest\/\.claude-plugin\/plugin\.json\..*nothing was changed/s;
  let suiteRuns = 0;
  let failure;

  // A failing suite is what used to lose the edit: the release commit swept it in, and the
  // rollback's reset took it away with the commit.
  await assert.rejects(
    () => cut({
      repoRoot: context.root,
      allowDirty: true,
      log: () => {},
      runSuite: (suite) => {
        suiteRuns += 1;
        return failingSuite(suite);
      },
    }),
    (error) => {
      failure = error;
      return true;
    },
  );

  assert.equal(context.read(manifestPath), edited, 'the operator\'s edit survives');
  assert.equal(context.git('rev-parse', 'HEAD'), originalHead);
  assert.match(failure.message, refusal);
  assert.equal(failure.rollback, undefined, 'refused before a release commit existed, so nothing needed rolling back');
  assert.equal(suiteRuns, 0, 'refused before any suite ran');
  assert.equal(context.git('tag', '--list'), '');
  assert.deepEqual(releaseSubjects(context), []);
  assert.equal(context.exists('.release/unreleased/SQ-1.md'), true, 'the fragment is still queued');
  await assert.rejects(
    () => cut({ repoRoot: context.root, allowDirty: true, dryRun: true, log: () => {} }),
    refusal,
    'a dry run refuses exactly where a real cut would',
  );
  assert.equal(context.read(manifestPath), edited);
});

test('--allow-dirty refuses a local change to any path a cut writes or removes, and leaves the change in place', async (t) => {
  const reference = setup(t);
  reference.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  reference.commit('integrate');
  const result = await cut({ repoRoot: reference.root, skipTests: true, log: () => {} });
  const releasePaths = [...new Set([...result.touched, ...result.consumed])].sort();
  assert.deepEqual(releasePaths, [
    '.claude-plugin/marketplace.json',
    '.release/unreleased/SQ-1.md',
    'CHANGELOG.md',
    'plugins/sidequest/.claude-plugin/plugin.json',
    'plugins/sidequest/CHANGELOG.md',
  ], 'every path the release commit adds');

  const changes = releasePaths.map((relative) => ({ relative, kind: 'edit' }));
  changes.push({ relative: '.release/unreleased/SQ-1.md', kind: 'delete' });
  for (const { relative, kind } of changes) {
    const label = `${kind} ${relative}`;
    const context = setup(t);
    context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
    const originalHead = context.commit('integrate');
    let expected = null;
    if (kind === 'delete') {
      rmSync(path.join(context.root, relative));
    } else {
      // Tracked paths get an unstaged edit; paths the release creates get an untracked file.
      expected = context.exists(relative) ? `${context.read(relative)}\n` : '# operator notes\n';
      context.write(relative, expected);
    }
    const escaped = relative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    await assert.rejects(
      () => cut({ repoRoot: context.root, allowDirty: true, skipTests: true, log: () => {} }),
      new RegExp(`these paths the release writes or removes have local changes: ${escaped}\\.`),
      label,
    );
    if (expected === null) assert.equal(context.exists(relative), false, `${label}: the deletion is kept`);
    else assert.equal(context.read(relative), expected, `${label}: the change is kept`);
    assert.equal(context.git('rev-parse', 'HEAD'), originalHead, label);
    assert.equal(context.git('tag', '--list'), '', label);
    assert.deepEqual(releaseSubjects(context), [], label);
  }
});

test('a failed cut is not rolled back once the remote contains the release commit, even after building on it', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const originalHead = context.commit('integrate');
  let release = null;
  let remoteTip = null;
  let failure;

  await assert.rejects(
    () => cut({
      repoRoot: context.root,
      log: () => {},
      runSuite: (suite) => {
        if (release === null) {
          // While the suites run, someone else publishes the release commit and builds on it, so
          // the remote branch contains the commit without pointing at it.
          release = context.git('rev-parse', 'HEAD');
          context.git('push', '-q', 'origin', `${release}:refs/heads/main`);
          remoteTip = commitOnOrigin(context, release, 'built on the release');
        }
        return failingSuite(suite);
      },
    }),
    (error) => {
      failure = error;
      return /release suites failed/.test(error.message);
    },
  );

  assert.notEqual(release, originalHead);
  assert.equal(failure.rollback.status, 'skipped');
  assert.equal(failure.rollback.reason, 'the remote already carries a release ref');
  assert.match(failure.message, /Not rolled back automatically: the remote already carries a release ref/);
  assert.equal(context.git('rev-parse', 'HEAD'), release, 'the release commit the remote built on is not reset away');
  assert.equal(context.git('tag', '--list'), 'sidequest-v3.6.18\nv3.208.0', 'no tag was deleted');
  assert.equal(context.originGit('rev-parse', 'main'), remoteTip);
});

test('a failed cut is still rolled back when the remote moved on without the release commit', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const originalHead = context.commit('integrate');
  let remoteTip = null;
  let failure;

  await assert.rejects(
    () => cut({
      repoRoot: context.root,
      log: () => {},
      runSuite: (suite) => {
        remoteTip ??= commitOnOrigin(context, context.originGit('rev-parse', 'main'), 'unrelated work');
        return failingSuite(suite);
      },
    }),
    (error) => {
      failure = error;
      return /release suites failed/.test(error.message);
    },
  );

  assert.equal(failure.rollback.status, 'rolled-back');
  assert.equal(context.git('rev-parse', 'HEAD'), originalHead);
  assert.equal(context.git('tag', '--list'), '');
  assert.equal(context.originGit('rev-parse', 'main'), remoteTip);
});

test('a failed cut is not rolled back, and stops within the probe deadline, when the remote check never answers', async (t) => {
  const cases = {
    'origin never answers its tag listing': (args) => args[0] === 'ls-remote' && args.includes('--tags'),
    'origin never answers for its publish branch': (args) => args[0] === 'ls-remote' && args.includes('--exit-code'),
    'origin never answers the fetch of its publish branch': (args) => args[0] === 'fetch',
  };
  for (const [label, blocks] of Object.entries(cases)) {
    const context = setup(t);
    sshThroughFake(t, context);
    context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
    const originalHead = context.commit('integrate');
    // The remote moved to a commit this clone lacks, so answering needs a fetch as well as a read.
    commitOnOrigin(context, context.originGit('rev-parse', 'main'), 'unrelated work');
    // Only the rollback check blocks: the checks before the build answer as usual.
    let suitesRan = false;
    const blocked = [];
    const runSuite = (suite) => {
      suitesRan = true;
      return failingSuite(suite);
    };

    const started = Date.now();
    const failure = await rejection(
      cut({ repoRoot: context.root, git: gitBlocking(context, (args) => suitesRan && blocks(args), blocked), log: () => {}, runSuite }),
    );
    const elapsed = Date.now() - started;

    assert.match(failure.message, /release suites failed/, label);
    assert.ok(elapsed < PROBE_DEADLINE_MS, `${label}: stopped after ${elapsed}ms, not within ${PROBE_DEADLINE_MS}ms`);
    assert.equal(blocked.length, 1, `${label}: the rollback check asked the host that never answers once`);
    assert.equal(failure.rollback.status, 'skipped', label);
    assert.equal(failure.rollback.reason, 'the remote could not be checked', label);
    assert.match(failure.message, /Not rolled back automatically: the remote could not be checked/, label);
    const release = context.git('rev-parse', 'HEAD');
    assert.notEqual(release, originalHead, `${label}: the release commit is kept`);
    assert.equal(context.git('rev-list', '-n', '1', 'refs/tags/v3.208.0'), release, `${label}: the tag stays on the release commit`);
    assert.equal(context.git('tag', '--list'), 'sidequest-v3.6.18\nv3.208.0', `${label}: no tag was deleted`);
  }
});

test('a failed cut is not rolled back when the remote branch cannot be read or fetched', async (t) => {
  const failures = {
    'the branch cannot be read': (args) => args[0] === 'ls-remote' && args.includes('--exit-code'),
    'the branch cannot be fetched': (args) => args[0] === 'fetch',
  };
  for (const [label, fails] of Object.entries(failures)) {
    const context = setup(t);
    context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
    const originalHead = context.commit('integrate');
    // The remote moved to a commit this clone lacks, so answering needs a fetch as well as a read.
    commitOnOrigin(context, context.originGit('rev-parse', 'main'), 'unrelated work');
    let failure;

    await assert.rejects(
      () => cut({ repoRoot: context.root, git: gitFailing(context, fails), log: () => {}, runSuite: failingSuite }),
      (error) => {
        failure = error;
        return /release suites failed/.test(error.message);
      },
    );

    assert.equal(failure.rollback.status, 'skipped', label);
    assert.equal(failure.rollback.reason, 'the remote could not be checked', label);
    assert.match(failure.message, /Not rolled back automatically: the remote could not be checked/, label);
    // An unanswered remote proves nothing about it, so the window is not called local.
    assert.doesNotMatch(failure.message, /The release commit and tags are local only/, label);
    const release = context.git('rev-parse', 'HEAD');
    assert.match(
      failure.message,
      new RegExp(`Could not confirm that the release commit and tags are local only, because origin could not be checked\\. Confirm origin has neither ${release} on main nor the tags v3\\.208\\.0, sidequest-v3\\.6\\.18, then undo the local window:`),
      label,
    );
    assert.match(failure.message, new RegExp(`git reset --hard ${originalHead}\\n  git tag -d v3\\.208\\.0 sidequest-v3\\.6\\.18`), `${label}: the undo commands are still given`);
    assert.notEqual(context.git('rev-parse', 'HEAD'), originalHead, `${label}: the release commit is kept`);
    assert.equal(context.git('tag', '--list'), 'sidequest-v3.6.18\nv3.208.0', `${label}: no tag was deleted`);
  }
});

test('a failed push is never rolled back, whichever push failed', async (t) => {
  for (const failingPush of [1, 2]) {
    const context = setup(t);
    context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
    const originalHead = context.commit('integrate');
    const real = spawnRunner(context.root);
    let pushes = 0;
    const git = createGit({
      cwd: context.root,
      run: (args) => {
        if (args[0] !== 'push') return real(args);
        pushes += 1;
        return pushes === failingPush ? { code: 1, stdout: '', stderr: 'forced push failure' } : real(args);
      },
    });
    let failure;

    await assert.rejects(
      () => cut({ repoRoot: context.root, git, push: true, skipTests: true, log: () => {} }),
      (error) => {
        failure = error;
        return /forced push failure/.test(error.message);
      },
    );

    assert.equal(failure.rollback.status, 'skipped', `push ${failingPush}`);
    const releaseCommit = context.git('rev-parse', 'HEAD');
    assert.notEqual(releaseCommit, originalHead, `push ${failingPush}: the release commit is untouched`);
    assert.equal(context.git('tag', '--list'), 'sidequest-v3.6.18\nv3.208.0', `push ${failingPush}: the local tags are untouched`);
    if (failingPush === 1) {
      assert.match(failure.message, /The push to origin did not complete, so nothing was rolled back automatically/);
      assert.match(failure.message, /Confirm origin has neither .* on main nor the tags v3\.208\.0, sidequest-v3\.6\.18/);
    } else {
      assert.match(failure.message, /The marketplace commit and tag v3\.208\.0 are already published/);
      assert.equal(context.remoteRefs()['refs/heads/main'], releaseCommit);
    }
  }
});

test('the rollback decision refuses every case but an unpushed failure at the release commit', () => {
  const { failureRecovery } = cutModule;
  for (const pushStarted of [false, true, undefined]) {
    for (const keepOnFailure of [false, true]) {
      for (const headIsReleaseCommit of [false, true]) {
        for (const remoteCarriesRelease of [false, true, null]) {
          const inputs = { pushStarted, keepOnFailure, headIsReleaseCommit, remoteCarriesRelease };
          const { action } = failureRecovery(inputs);
          const expected = pushStarted !== false ? 'instructions'
            : keepOnFailure ? 'keep'
              : headIsReleaseCommit && remoteCarriesRelease === false ? 'rollback' : 'instructions';
          assert.equal(action, expected, JSON.stringify(inputs));
        }
      }
    }
  }
});

test('a push that leaves a planned tag off the remote fails loudly and names it', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  context.commit('integrate');
  const real = spawnRunner(context.root);
  // The plugin-tag push reports success without sending anything, as the v3.537.0 tags did.
  const git = createGit({
    cwd: context.root,
    run: (args) => (args[0] === 'push' && args.some((arg) => arg.startsWith('refs/tags/sidequest-'))
      ? { code: 0, stdout: '', stderr: '' }
      : real(args)),
  });
  let failure;

  await assert.rejects(
    () => cut({ repoRoot: context.root, git, push: true, skipTests: true, log: () => {} }),
    (error) => {
      failure = error;
      return true;
    },
  );

  assert.match(failure.message, /the push reported success but these release tags do not resolve on origin: sidequest-v3\.6\.18\./);
  assert.match(failure.message, /git push --atomic origin refs\/tags\/sidequest-v3\.6\.18:refs\/tags\/sidequest-v3\.6\.18/);
  assert.equal(failure.rollback.status, 'skipped', 'a published release is never rolled back');
  assert.equal(context.git('tag', '--list'), 'sidequest-v3.6.18\nv3.208.0');
  assert.ok(context.remoteRefs()['refs/tags/v3.208.0'], 'the marketplace tag did land');
});

test('a failed Test workflow refuses before suites or release mutations', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const localParent = context.commit('integrate');
  const remoteParent = context.originGit('rev-parse', 'main');
  const before = context.remoteRefs();
  let checkedCommit = null;
  let suiteRuns = 0;
  const failedTestRun = () => ({
    status: 0,
    stdout: JSON.stringify([{ headSha: localParent, conclusion: 'failure' }]),
    stderr: '',
  });

  assert.throws(
    () => assertParentCiPassed(context.root, localParent, failedTestRun),
    /Test workflow for .* concluded failure; refusing to publish/,
  );
  await assert.rejects(
    () => cut({
      repoRoot: context.root,
      log: () => {},
      runSuite: () => {
        suiteRuns += 1;
        return { code: 0, command: 'should not run' };
      },
      assertParentCiPassed: (repoRoot, commit, suites) => {
        checkedCommit = commit;
        assert.deepEqual(suites, [{
          plugin: 'sidequest',
          cwd: 'plugins/sidequest',
          setup: null,
          command: 'node --test --test-timeout=120000 "test/*.test.js"',
        }]);
        return assertParentCiPassed(repoRoot, commit, failedTestRun, suites);
      },
    }),
    /Test workflow for .* concluded failure; refusing to publish/,
  );
  assert.equal(checkedCommit, localParent, 'CI is asserted on the pinned commit the release is built from');
  assert.notEqual(checkedCommit, remoteParent, 'not on whatever the remote head happens to be');
  assert.equal(suiteRuns, 0, 'a CI refusal skips release suites');
  assert.equal(context.git('rev-parse', 'HEAD'), localParent, 'no release commit exists');
  assert.equal(context.exists('.release/unreleased/SQ-1.md'), true, 'the fragment is still queued');
  assert.equal(context.git('tag', '--list'), '', 'no release tags were created');
  assert.deepEqual(context.remoteRefs(), before);
});

test('a successful GitHub Release workflow defers to the daily cap', async () => {
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'release') return { status: 1, stdout: '', stderr: 'release not found' };
    return {
      status: 0,
      stdout: JSON.stringify([{ headSha: 'release-commit', conclusion: 'success' }]),
      stderr: '',
    };
  };

  const release = await assertGitHubReleasePublished('/repo', 'v3.208.0', 'release-commit', {
    runner,
    sleep: async () => {},
    now: () => 0,
  });

  assert.deepEqual(release, {
    tag: 'v3.208.0',
    status: 'deferred',
    message: 'GitHub Release deferred by the daily cap; the scheduled publish will cover this tag.',
  });
  assert.deepEqual(calls, [
    ['gh', 'release', 'view', 'v3.208.0'],
    ['gh', 'run', 'list', '--workflow', 'Publish GitHub Release', '--commit', 'release-commit', '--status', 'completed', '--limit', '1', '--json', 'conclusion,headSha'],
    ['gh', 'release', 'view', 'v3.208.0'],
  ]);
});

test('a failed GitHub Release workflow still fails the cut', async () => {
  const runner = (command, args) => {
    if (args[0] === 'release') return { status: 1, stdout: '', stderr: 'release not found' };
    return {
      status: 0,
      stdout: JSON.stringify([{ headSha: 'release-commit', conclusion: 'failure' }]),
      stderr: '',
    };
  };

  await assert.rejects(
    () => assertGitHubReleasePublished('/repo', 'v3.208.0', 'release-commit', { runner, now: () => 0 }),
    /Publish GitHub Release for v3\.208\.0 concluded failure; GitHub Release was not published/,
  );
});

test('a cut succeeds and reports a deferred GitHub Release', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  context.commit('integrate');
  const logs = [];
  const git = {
    ...createGit({ cwd: context.root }),
    remoteUrl: () => 'git@github.com:poindexter12/loadout.git',
  };
  const deferredRelease = {
    tag: 'v3.208.0',
    status: 'deferred',
    message: 'GitHub Release deferred by the daily cap; the scheduled publish will cover this tag.',
  };

  const result = await cut({
    repoRoot: context.root,
    git,
    push: true,
    skipTests: true,
    log: (message) => logs.push(message),
    publishLock: { acquire: async () => ({ ok: true }), release: async () => ({ ok: true }) },
    assertParentCiPassed: (repoRoot, commit) => ({ commit, conclusion: 'success' }),
    assertGitHubReleasePublished: async (repoRoot, tag, commit) => ({ ...deferredRelease, tag }),
  });

  assert.equal(result.status, 'cut');
  assert.equal(result.pushed, true);
  assert.deepEqual(result.githubRelease, deferredRelease);
  assert.ok(logs.includes(deferredRelease.message));
});

test('a local cut prints the passing CI verdict on the pinned commit with its push command', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const pinned = context.commit('integrate');
  const remoteParent = context.originGit('rev-parse', 'main');
  const logs = [];

  const result = await cut({
    repoRoot: context.root,
    skipTests: true,
    log: (message) => logs.push(message),
    assertParentCiPassed: (repoRoot, commit) => {
      assert.equal(commit, pinned);
      assert.notEqual(commit, remoteParent);
      return { commit, conclusion: 'success' };
    },
  });

  assert.deepEqual(result.ci, { status: 'passed', commit: pinned, conclusion: 'success' });
  assert.ok(logs.includes(`Test CI on the pinned commit ${pinned} passed.`));
  for (const command of result.pushCommands) assert.ok(logs.includes(`  ${command}`));
});

test('a CI override records its reason for a local cut', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const pinned = context.commit('integrate');
  const logs = [];

  const result = await cut({
    repoRoot: context.root,
    skipTests: true,
    ciOverrideReason: 'SQ-1349 repairs the failed Test workflow',
    log: (message) => logs.push(message),
    assertParentCiPassed: (repoRoot, commit) => assertParentCiPassed(repoRoot, commit, () => ({
      status: 0,
      stdout: JSON.stringify([{ headSha: pinned, conclusion: 'failure' }]),
      stderr: '',
    })),
  });

  assert.deepEqual(result.ci, {
    status: 'overridden',
    commit: pinned,
    reason: 'SQ-1349 repairs the failed Test workflow',
    error: `Test workflow for ${pinned} concluded failure; refusing to publish. Retry with --ci-override "<reason>" only when the release fixes that CI failure.`,
  });
  assert.ok(logs.includes(`Test CI on the pinned commit ${pinned} was overridden: SQ-1349 repairs the failed Test workflow`));
});

test('--trust-ci records a failing local suite as a warning when CI passed on the pinned commit', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const pinned = context.commit('integrate');
  const logs = [];

  const result = await cut({
    repoRoot: context.root,
    trustCi: true,
    log: (message) => logs.push(message),
    runSuite: failingSuite,
    assertParentCiPassed: (repoRoot, commit) => ({ commit, conclusion: 'success' }),
  });

  assert.equal(result.status, 'cut');
  assert.deepEqual(result.ci, { status: 'passed', commit: pinned, conclusion: 'success' });
  assert.equal(result.suiteWarnings.length, 1);
  assert.match(result.suiteWarnings[0], new RegExp(`the Test workflow passed on ${pinned} and --trust-ci accepts that verdict`));
  assert.match(result.suiteWarnings[0], /exited 1/);
  assert.ok(logs.includes(`warning: ${result.suiteWarnings[0]}`));
  assert.equal(context.version('sidequest'), '3.6.18');
});

test('--trust-ci refuses without a CI verdict, beside --ci-override, and in a hotfix', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const pinned = context.commit('integrate');

  await assert.rejects(
    () => cut({ repoRoot: context.root, trustCi: true, log: () => {}, runSuite: failingSuite }),
    /--trust-ci needs a passing Test workflow on the pinned commit/,
  );
  assert.equal(context.git('rev-parse', 'HEAD'), pinned, 'no release commit exists');
  assert.equal(context.git('tag', '--list'), '', 'no release tags were created');

  await assert.rejects(
    () => cut({ repoRoot: context.root, trustCi: true, ciOverrideReason: 'x', log: () => {} }),
    /--trust-ci and --ci-override contradict each other/,
  );
  await assert.rejects(
    () => cut({ repoRoot: context.root, trustCi: true, mode: 'hotfix', tickets: ['SQ-1'], log: () => {} }),
    /--trust-ci applies to normal windows only/,
  );
  assert.equal(context.git('rev-parse', 'HEAD'), pinned);
});

test('--trust-ci and --keep-on-failure parse to cut options that default off', () => {
  const { parseCutArgs } = cutModule;
  const on = parseCutArgs(['--trust-ci', '--keep-on-failure', '--repo', '/tmp/x']).options;
  assert.equal(on.trustCi, true);
  assert.equal(on.keepOnFailure, true);
  const off = parseCutArgs(['--repo', '/tmp/x']).options;
  assert.equal(off.trustCi, false);
  assert.equal(off.keepOnFailure, false);
});

test('a missing Test workflow run offers a committed container baseline and every planned suite', (t) => {
  const context = setup(t);
  const parent = context.originGit('rev-parse', 'main');
  const suites = [
    { plugin: 'sidequest', cwd: 'plugins/sidequest', setup: 'npm ci', command: 'npm run test:full' },
    { plugin: 'toolbelt', cwd: 'plugins/toolbelt', setup: 'npm ci', command: 'npm test' },
  ];
  let failure;

  assert.throws(
    () => assertParentCiPassed(context.root, parent, () => ({ status: 0, stdout: '[]', stderr: '' }), suites),
    (error) => {
      failure = error;
      return /no completed Test workflow run found/.test(error.message);
    },
  );

  const initialized = failure.message.indexOf('git init -q');
  const baseline = failure.message.indexOf('git -c user.email=ci@local -c user.name=ci commit -q -m baseline');
  const suitesStart = failure.message.indexOf('(cd "plugins/sidequest"; npm ci; npm run test:full)');
  assert.ok(initialized < baseline && baseline < suitesStart);
  assert.match(failure.message, /\(cd "plugins\/toolbelt"; npm ci; npm test\)/);
});

test('a failing default suite writes its output and names the log', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  context.commit('integrate');
  const runner = defaultSuiteRunner(context.root, { log: () => {}, tag: 'v-test' });
  let failure;

  await assert.rejects(
    () => cut({
      repoRoot: context.root,
      log: () => {},
      runSuite: (suite) => runner({
        ...suite,
        cwd: 'plugins/sidequest',
        setup: null,
        command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('suite stdout'); process.stderr.write('suite stderr'); process.exit(1)"`,
      }),
    }),
    (error) => {
      failure = error;
      return /release suites failed, nothing was published/.test(error.message);
    },
  );

  const match = failure.message.match(/log: (\.release.*\.log)/);
  assert.ok(match, `the failure names the suite log: ${failure.message}`);
  assert.equal(context.read(match[1]), 'suite stdoutsuite stderr');
});

test('a timed-out post-publish audit warns without rolling back the cut', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  context.write('plugins/sidequest/bin/sidequest.js', 'setTimeout(() => {}, 1_000);\n');
  context.commit('integrate');
  const logs = [];
  const git = { ...createGit({ cwd: context.root }), remoteUrl: () => 'git@github.com:poindexter12/loadout.git' };
  const previousTimeout = process.env.SIDEQUEST_RELEASE_AUDIT_TIMEOUT_MS;
  process.env.SIDEQUEST_RELEASE_AUDIT_TIMEOUT_MS = '50';
  t.after(() => {
    if (previousTimeout === undefined) delete process.env.SIDEQUEST_RELEASE_AUDIT_TIMEOUT_MS;
    else process.env.SIDEQUEST_RELEASE_AUDIT_TIMEOUT_MS = previousTimeout;
  });

  const result = await cut({
    repoRoot: context.root,
    git,
    push: true,
    skipTests: true,
    log: (message) => logs.push(message),
    publishLock: { acquire: async () => ({ ok: true }), release: async () => ({ ok: true }) },
    assertParentCiPassed: () => ({ conclusion: 'success' }),
    assertGitHubReleasePublished: async (repoRoot, tag) => ({ tag, status: 'published' }),
  });

  assert.equal(result.status, 'cut');
  assert.equal(result.pushed, true);
  assert.equal(result.audit.ok, false);
  assert.equal(context.exists('.release/unreleased/SQ-1.md'), false, 'the published cut remains committed');
  assert.ok(logs.some((line) => /sidequest audit failed.*timed out after 50ms/.test(line)));
});

test('a failed post-publish audit warns without failing the release cut', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  context.commit('integrate');
  const logs = [];
  const git = { ...createGit({ cwd: context.root }), remoteUrl: () => 'git@github.com:poindexter12/loadout.git' };
  const result = await cut({
    repoRoot: context.root,
    git,
    push: true,
    skipTests: true,
    log: (message) => logs.push(message),
    publishLock: { acquire: async () => ({ ok: true }), release: async () => ({ ok: true }) },
    assertParentCiPassed: () => ({ conclusion: 'success' }),
    assertGitHubReleasePublished: async (repoRoot, tag) => ({ tag, status: 'published' }),
    auditRunner: async () => { throw new Error('audit stub failed'); },
  });
  assert.equal(result.status, 'cut');
  assert.equal(result.pushed, true);
  assert.equal(result.audit.ok, false);
  assert.ok(logs.some((line) => /sidequest audit failed.*audit stub failed/.test(line)));
});

test('a dry-run cut invokes report-only audit mode', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  context.commit('integrate');
  const calls = [];
  await cut({ repoRoot: context.root, dryRun: true, log: () => {}, auditRunner: async (root, options) => { calls.push({ root, options }); return { ok: true }; } });
  assert.deepEqual(calls, [{ root: context.root, options: { apply: false } }]);
});
