#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { applyChangelogs, readRepoChangelog, releasedFragmentFingerprints, REPO_CHANGELOG } from './lib/changelog.mjs';
import { createGit } from './lib/git.mjs';
import { fragmentFile, fragmentFingerprint, HOLD_FILE, isHeld, readFragments } from './lib/fragments.mjs';
import { applyVersions, checkManifest, readManifest } from './lib/manifests.mjs';
import { resolveInRepo } from './lib/paths.mjs';
import { buildPlan, formatPlan, planCommitMessage, planRefspecs } from './lib/plan.mjs';
import { createSuiteResolver } from './lib/suites.mjs';
import { commitSource, diskSource } from './lib/treesource.mjs';
import { repoRootFrom, runCli, splitList, UsageError } from './lib/cli.mjs';

const require = createRequire(import.meta.url);
const { acquirePublishLock, releasePublishLock } = require('../../plugins/sidequest/lib/publish.js');

const USAGE = `Usage: node scripts/release/cut.mjs [options]

Builds a release window in the working tree and stops just short of publishing it. Everything is
local until --push. Publishing atomically pairs the verified release commit with the marketplace
tag, then pushes the plugin tags separately.

  --sha <rev>              Pin the window to this commit (default HEAD). Every input is read from it
  --mode <normal|hotfix>   Window kind (default normal)
  --tickets <a,b>          Refs to release in a hotfix, each named once
  --date <YYYY-MM-DD>      Release date (defaults to the pinned commit's date)
  --publish-branch <name>  Branch the release lands on (default main)
  --remote <name>          Remote to publish to (default origin)
  --dry-run                Plan only: no file writes, no git mutations
  --push                   Acquire the publish lock and run the atomic push
  --skip-tests             Do not run the changed plugins' suites
  --no-merge               The tree is already prepared; skip the fast-forward merge
  --no-branch-check        Allow cutting from a branch other than --publish-branch
  --allow-dirty            Tolerate unstaged or untracked files (staged changes are never allowed)
  --force                  Override .release/HOLD, held fragments, and existing tags
  --ci-override <reason>   Proceed after a failed or missing Test workflow, recording why
  --trust-ci               When the Test workflow passed on the pinned commit itself, record a failing
                           local suite as a warning instead of aborting (normal windows only)
  --keep-on-failure        On a failure before anything is pushed, keep the release commit and tags
                           and print the undo commands instead of rolling the window back
  --json                   Machine-readable result
  --repo <dir>             Repository root (defaults to this script's repo)`;

// Anything that lets a suite authenticate to a remote, or reconfigure git underneath the engine,
// is removed before the suite runs. The engine still re-verifies every ref afterwards, because
// stripping credentials is a reduction in reach, not a proof.
const GITHUB_RELEASE_WORKFLOW = 'Publish GitHub Release';
const GITHUB_RELEASE_DEFERRED_MESSAGE = 'GitHub Release deferred by the daily cap; the scheduled publish will cover this tag.';
const GITHUB_RELEASE_POLL_INTERVAL_MS = 2_000;
const GITHUB_RELEASE_TIMEOUT_MS = 10 * 60 * 1_000;
const RELEASE_AUDIT_TIMEOUT_MS = 60 * 1_000;

const SUITE_CREDENTIAL_DENYLIST = [
  'GITHUB_TOKEN', 'GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'RELEASE_TOKEN', 'GITHUB_ACTIONS_TOKEN',
  'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'NPM_CONFIG__AUTH', 'NPM_CONFIG__AUTHTOKEN',
  'GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_AUTH_SOCK', 'GIT_SSH', 'GIT_SSH_COMMAND',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'GITLAB_TOKEN', 'CI_JOB_TOKEN',
];

// A suite run from inside Claude Code inherits a real session and agent identity,
// and CI has neither. Sidequest reads exactly these when a claim binds an isolated
// dispatch, so leaving them set let a test that never passed --session bind off the
// developer's own session and go green locally while CI refused unbound_dispatch.
// A test that needs an identity sets its own.
const SUITE_RUNTIME_IDENTITY_DENYLIST = [
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'SIDEQUEST_SESSION', 'SIDEQUEST_AGENT',
];

function releaseLockOwner() {
  return process.env.SIDEQUEST_AGENT
    || process.env.CLAUDE_CODE_SESSION_ID
    || process.env.CLAUDE_SESSION_ID
    || `release-cut-${process.pid}`;
}

function releaseSessionId() {
  return process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || process.env.SIDEQUEST_SESSION || null;
}

function createPublishLock(repoRoot) {
  const options = { by: releaseLockOwner(), sessionId: releaseSessionId() };
  return {
    acquire: () => acquirePublishLock(repoRoot, options),
    release: () => releasePublishLock(repoRoot, options),
  };
}

function publishLockRefusal(result) {
  const holder = result.holder ?? {};
  const owner = holder.by || holder.sessionId || 'another publisher';
  return `publish lock is held by "${owner}". Wait for it to release, or use sidequest publish lock --steal only after confirming the holder is dead.`;
}

function publishLockReleaseFailure(result) {
  const holder = result?.holder ?? {};
  const owner = holder.by || holder.sessionId || 'another publisher';
  return `could not release the publish lock owned by "${owner}". Release it with sidequest publish unlock after confirming the published refs.`;
}

export function suiteEnvironment(base = process.env) {
  const env = { ...base };
  for (const name of SUITE_CREDENTIAL_DENYLIST) delete env[name];
  for (const name of SUITE_RUNTIME_IDENTITY_DENYLIST) delete env[name];
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_CONFIG_')) delete env[name];
  }
  delete env.GIT_HTTP_EXTRAHEADER;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_CONFIG_SYSTEM = env.GIT_CONFIG_GLOBAL;
  env.npm_config_ignore_scripts = base.npm_config_ignore_scripts ?? '';
  return env;
}

export function defaultSuiteRunner(repoRoot, { log = console.log, tag = 'release' } = {}) {
  return (suite) => {
    const command = suite.setup ? `${suite.setup} && ${suite.command}` : suite.command;
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const logRelative = path.join('.release', 'logs', `${tag}-${suite.plugin}-${timestamp}.log`);
    const logPath = resolveInRepo(repoRoot, logRelative, `suite log for "${suite.plugin}"`);
    log(`running ${suite.plugin}: ${command}`);
    const result = spawnSync(command, {
      cwd: resolveInRepo(repoRoot, suite.cwd, `suite directory for "${suite.plugin}"`),
      shell: true,
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true,
      env: suiteEnvironment(),
      encoding: 'utf8',
    });
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    mkdirSync(path.dirname(logPath), { recursive: true });
    writeFileSync(logPath, stdout + stderr);
    return { code: result.status ?? 1, command, logPath: logRelative };
  };
}

function releaseAuditTimeoutMs(environment = process.env) {
  const timeout = Number(environment.SIDEQUEST_RELEASE_AUDIT_TIMEOUT_MS);
  return Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : RELEASE_AUDIT_TIMEOUT_MS;
}

export function runSidequestAudit(repoRoot, { apply = false } = {}) {
  const timeout = releaseAuditTimeoutMs();
  const cli = path.join(repoRoot, 'plugins', 'sidequest', 'bin', 'sidequest.js');
  const result = spawnSync(process.execPath, [cli, 'audit', '--project', repoRoot, ...(apply ? ['--apply'] : [])], {
    cwd: repoRoot,
    stdio: 'inherit',
    windowsHide: true,
    timeout,
    killSignal: 'SIGKILL',
  });
  const error = result.error?.code === 'ETIMEDOUT'
    ? `timed out after ${timeout}ms`
    : result.error?.message || (result.status === 0 ? '' : `exited ${result.status ?? 'unknown'}`);
  return { ok: result.status === 0 && !result.error, error };
}

function auditWarning(log, error) {
  log(`warning: sidequest audit failed after release activity: ${error || 'unknown failure'}`);
}

async function runReleaseAudit(repoRoot, apply, log, auditRunner) {
  try {
    const result = await auditRunner(repoRoot, { apply });
    if (!result?.ok) auditWarning(log, result?.error);
    return result;
  } catch (error) {
    auditWarning(log, error instanceof Error ? error.message : String(error));
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function assertNoStaleTags(git, plan, { remote, force }) {
  const localTags = new Set(git.localTags());
  const remoteTags = new Set(git.remoteTags(remote));
  const remoteClashes = plan.tags.filter((tag) => remoteTags.has(tag));
  const localOnlyClashes = plan.tags.filter((tag) => localTags.has(tag) && !remoteTags.has(tag));
  if (remoteClashes.length === 0 && localOnlyClashes.length === 0) return;
  if (force) return;
  if (remoteClashes.length > 0) {
    throw new Error(
      `these tags already exist on ${remote}: ${remoteClashes.join(', ')}. ` +
      'Cut a new window instead of moving a published tag; --force only when you are deliberately repairing the remote state.',
    );
  }
  throw new Error(localTagClashMessage(git, plan, localOnlyClashes, remote));
}

/**
 * The identities a cut from this clone stamps on its tags. `git tag -a` records the committer
 * identity, which `git var` resolves exactly as the tag command would; `loadout.releaseTagger`
 * (repeatable, a name or an email) adds any other identity whose tags are this fork's releases.
 */
function releaseTaggers(git) {
  const names = new Set();
  const emails = new Set();
  const addIdentity = (value) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (trimmed.includes('@')) emails.add(trimmed.replace(/^<|>$/g, '').toLowerCase());
    else names.add(trimmed);
  };
  const ident = git.invoke(['var', 'GIT_COMMITTER_IDENT'], { allowFail: true });
  const match = ident.code === 0 ? /^(.*?)\s*<([^>]*)>/.exec(ident.stdout.trim()) : null;
  if (match) {
    addIdentity(match[1]);
    addIdentity(match[2]);
  }
  const configured = git.invoke(['config', '--get-all', 'loadout.releaseTagger'], { allowFail: true });
  if (configured.code === 0) configured.stdout.split('\n').forEach(addIdentity);
  return { names, emails };
}

function tagTagger(git, tag) {
  const ref = `refs/tags/${tag}`;
  const result = git.invoke(['for-each-ref', '--format=%(refname)%09%(objecttype)%09%(taggername)%09%(taggeremail)', ref], { allowFail: true });
  const line = result.code === 0 ? result.stdout.split('\n').find((candidate) => candidate.startsWith(`${ref}\t`)) : undefined;
  const [, type = '', name = '', email = ''] = (line ?? '').split('\t');
  return { annotated: type === 'tag', name: name.trim(), email: email.trim().replace(/^<|>$/g, '').toLowerCase() };
}

/**
 * Reachability cannot tell whose a tag is: an upstream tag fetched through another remote marks a
 * commit this fork contains too. So a local-only clash is classified by its tagger first. Only a
 * tag this clone's release identity made (always annotated, since a cut never makes lightweight
 * tags) is ours, and only ours are split by whether the publish branch already contains them.
 */
function classifyLocalTagClashes(git, plan, tags, remote) {
  const taggers = releaseTaggers(git);
  let remoteHead = null;
  try {
    remoteHead = git.remoteBranchHead(remote, plan.publishBranch);
  } catch (_) {
    remoteHead = null;
  }
  const clashes = { foreign: [], unpushed: [], leftover: [] };
  for (const tag of tags) {
    const tagger = tagTagger(git, tag);
    const ours = tagger.annotated && (taggers.names.has(tagger.name) || taggers.emails.has(tagger.email));
    if (!ours) {
      clashes.foreign.push({ tag, ...tagger });
      continue;
    }
    const target = git.tagTarget(tag);
    if (remoteHead && target && git.isAncestor(target, remoteHead)) clashes.unpushed.push(tag);
    else clashes.leftover.push(tag);
  }
  return clashes;
}

function localTagClashMessage(git, plan, tags, remote) {
  const clashes = classifyLocalTagClashes(git, plan, tags, remote);
  const parts = [];
  if (clashes.foreign.length > 0) {
    const named = clashes.foreign.map(({ tag, annotated, name, email }) => (annotated
      ? `${tag} (tagged by ${name || 'an unnamed tagger'}${email ? ` <${email}>` : ''})`
      : `${tag} (lightweight, no tagger)`));
    let otherRemotes = [];
    try {
      otherRemotes = git.capture(['remote']).split('\n').map((name) => name.trim()).filter((name) => name && name !== remote);
    } catch (_) {
      otherRemotes = [];
    }
    const tagOpt = (otherRemotes.length > 0 ? otherRemotes : ['<remote>'])
      .map((name) => `git config remote.${name}.tagOpt --no-tags`)
      .join(' and ');
    parts.push(
      `these local tags were not made by this clone's release identity, so they came from another remote's fetch, not from a cut: ${named.join(', ')}. ` +
      `Delete them with git tag -d ${clashes.foreign.map(({ tag }) => tag).join(' ')}, then stop fetches bringing them back with ${tagOpt}. ` +
      'If one is in fact this fork\'s, add its tagger with git config --add loadout.releaseTagger "<name or email>" and retry.',
    );
  }
  if (clashes.unpushed.length > 0) {
    const refspecs = clashes.unpushed.map((tag) => `refs/tags/${tag}:refs/tags/${tag}`);
    parts.push(
      `these local release tags mark commits ${remote}/${plan.publishBranch} already contains, but never reached ${remote}: ${clashes.unpushed.join(', ')}. ` +
      `Push them with ${pushCommand(remote, refspecs)} instead of deleting them; this window then needs a version those tags do not already name.`,
    );
  }
  if (clashes.leftover.length > 0) {
    parts.push(
      `these local tags are leftovers from an unpublished attempt: ${clashes.leftover.join(', ')}. ` +
      `Verify they are absent from ${remote}, delete the local tags, then retry; --force only if you know the tags are safe to reuse.`,
    );
  }
  return parts.join('\n');
}

/**
 * What a failure after the release commit exists does to the local window. Rolling back is only
 * safe while nothing can have reached the remote, so any push attempt, a remote that already
 * carries a release ref (or could not be checked), or a HEAD that is no longer the release commit
 * leaves the window for a human. --keep-on-failure opts out of the rollback entirely.
 */
export function failureRecovery({ pushStarted, keepOnFailure, headIsReleaseCommit, remoteCarriesRelease }) {
  if (pushStarted !== false) return { action: 'instructions', reason: 'a push to the remote already started' };
  if (keepOnFailure) return { action: 'keep', reason: '--keep-on-failure kept the failed window' };
  if (headIsReleaseCommit !== true) return { action: 'instructions', reason: 'HEAD is no longer the release commit' };
  if (remoteCarriesRelease !== false) {
    return {
      action: 'instructions',
      reason: remoteCarriesRelease === true ? 'the remote already carries a release ref' : 'the remote could not be checked',
    };
  }
  return { action: 'rollback', reason: 'nothing was pushed' };
}

function remoteCarriesRelease(git, plan, remote, commit) {
  let published;
  try {
    published = new Set(git.remoteTags(remote));
  } catch (_) {
    return null;
  }
  if (plan.tags.some((tag) => published.has(tag))) return true;
  try {
    return git.remoteBranchHead(remote, plan.publishBranch) === commit;
  } catch (_) {
    // The tag listing just succeeded, so the remote answers; it has no such branch.
    return false;
  }
}

function rollBackUnpublished(git, plan, { basePin, commit, trackedCleanAtStart }) {
  // --hard only when the cut started from clean tracked files. Under --allow-dirty, --keep refuses
  // rather than discard an operator's edits to a file the release commit changed.
  const resetMode = trackedCleanAtStart ? '--hard' : '--keep';
  git.invoke(['reset', resetMode, basePin]);
  const head = git.revParse('HEAD');
  if (head !== basePin) throw new Error(`HEAD is at ${head} after git reset ${resetMode}, not ${basePin}`);
  const deleted = [];
  const left = [];
  for (const tag of plan.tags) {
    const target = git.tagTarget(tag);
    if (target === commit) {
      git.invoke(['tag', '-d', tag]);
      deleted.push(tag);
    } else if (target !== null) {
      left.push(tag);
    }
  }
  const survivors = deleted.filter((tag) => git.tagTarget(tag) !== null);
  if (survivors.length > 0) throw new Error(`local tags ${survivors.join(', ')} still exist after git tag -d`);
  return { resetMode, deleted, left };
}

function recoverFromFailure(git, plan, context) {
  const { remote, basePin, commit, pushStarted, marketplacePublished, keepOnFailure, trackedCleanAtStart } = context;
  let headIsReleaseCommit = false;
  try {
    headIsReleaseCommit = git.revParse('HEAD') === commit;
  } catch (_) {
    headIsReleaseCommit = false;
  }
  const needsRemoteCheck = !pushStarted && !keepOnFailure && headIsReleaseCommit;
  const decision = failureRecovery({
    pushStarted,
    keepOnFailure,
    headIsReleaseCommit,
    remoteCarriesRelease: needsRemoteCheck ? remoteCarriesRelease(git, plan, remote, commit) : null,
  });
  const instructions = releaseRecoveryInstructions(plan, basePin, remote, marketplacePublished);

  if (decision.action === 'rollback') {
    try {
      const { resetMode, deleted, left } = rollBackUnpublished(git, plan, { basePin, commit, trackedCleanAtStart });
      const leftNote = left.length > 0 ? `; left ${left.join(', ')} because they no longer point at the release commit` : '';
      return {
        rollback: { status: 'rolled-back', reason: decision.reason, head: basePin, resetMode, deletedTags: deleted, leftTags: left },
        message: [
          `Rolled back the unpublished release: HEAD is back at ${basePin} (git reset ${resetMode}) and local tags ${deleted.join(', ') || '(none)'} are deleted${leftNote}.`,
          `Nothing reached ${remote}. Fix the failure and cut again; pass --keep-on-failure to keep a failed window for inspection.`,
        ].join('\n'),
      };
    } catch (error) {
      return {
        rollback: { status: 'failed', reason: error.message },
        message: `Automatic rollback stopped: ${error.message}. Nothing was pushed; finish the undo by hand.\n${instructions}`,
      };
    }
  }
  if (decision.action === 'keep') {
    return {
      rollback: { status: 'kept', reason: decision.reason },
      message: `--keep-on-failure left the release commit ${commit} and its tags in place.\n${instructions}`,
    };
  }
  if (pushStarted && !marketplacePublished) {
    return {
      rollback: { status: 'skipped', reason: decision.reason },
      message: [
        `The push to ${remote} did not complete, so nothing was rolled back automatically.`,
        `Confirm ${remote} has neither ${commit} on ${plan.publishBranch} nor the tags ${plan.tags.join(', ')}, then undo the local window:`,
        `  git reset --hard ${basePin}`,
        `  git tag -d ${plan.tags.join(' ')}`,
      ].join('\n'),
    };
  }
  return {
    rollback: { status: 'skipped', reason: decision.reason },
    message: marketplacePublished ? instructions : `Not rolled back automatically: ${decision.reason}.\n${instructions}`,
  };
}

/**
 * A push that exits 0 has still been known to leave tags behind, so every planned tag has to
 * resolve on the remote before the cut calls itself published.
 */
function assertTagsPublished(git, plan, remote) {
  const published = new Set(git.remoteTags(remote));
  const missing = plan.tags.filter((tag) => !published.has(tag));
  if (missing.length > 0) {
    const refspecs = missing.map((tag) => `refs/tags/${tag}:refs/tags/${tag}`);
    throw new Error(
      `the push reported success but these release tags do not resolve on ${remote}: ${missing.join(', ')}. ` +
      `Publish them with ${pushCommand(remote, refspecs)} before the next window is cut.`,
    );
  }
}

function releaseRecoveryInstructions(plan, originalHead, remote, marketplacePublished) {
  if (marketplacePublished) {
    return [
      `The marketplace commit and tag ${plan.tag} are already published.`,
      `Inspect ${plan.pluginTags.join(', ')} on the remote, then publish any missing plugin tags with:`,
      `  ${pushCommand(remote, pluginTagRefspecs(plan))}`,
    ].join('\n');
  }
  return [
    'The release commit and tags are local only. To undo this local window:',
    `  git reset --hard ${originalHead}`,
    `  git tag -d ${plan.tags.join(' ')}`,
    'A reset does not delete local tags, so run both commands before retrying.',
  ].join('\n');
}

function marketplaceRefspecs(plan, commit) {
  const sha = commit ?? plan.commit ?? '<release-sha>';
  return [
    `${sha}:refs/heads/${plan.publishBranch}`,
    `refs/tags/${plan.tag}:refs/tags/${plan.tag}`,
  ];
}

function pluginTagRefspecs(plan) {
  return plan.pluginTags.map((tag) => `refs/tags/${tag}:refs/tags/${tag}`);
}

function pushCommand(remote, refspecs) {
  return ['git', 'push', '--atomic', remote, ...refspecs].join(' ');
}

function publishCommands(plan, { remote, commit }) {
  const commands = [pushCommand(remote, marketplaceRefspecs(plan, commit))];
  const pluginRefs = pluginTagRefspecs(plan);
  if (pluginRefs.length > 0) commands.push(pushCommand(remote, pluginRefs));
  return commands;
}

function quoteForSh(command) {
  return `'${command.replaceAll("'", "'\"'\"'")}'`;
}

function containerTestCommand(commit, suites) {
  const suiteCommands = suites.map((suite) => {
    const commands = [suite.setup, suite.command].filter(Boolean).join('; ');
    return `(cd ${JSON.stringify(suite.cwd)}; ${commands})`;
  }).join('; ');
  const commands = `set -eu; mkdir repo; tar -x -C repo; cd repo; git init -q; git -c user.email=ci@local -c user.name=ci add -A; git -c user.email=ci@local -c user.name=ci commit -q -m baseline; ${suiteCommands}`;
  return `git archive ${commit} | docker run -i --rm node:22 sh -c ${quoteForSh(commands)}`;
}

export function assertParentCiPassed(repoRoot, commit, runner = spawnSync, suites = []) {
  const result = runner('gh', [
    'run', 'list', '--workflow', 'Test', '--commit', commit, '--status', 'completed', '--limit', '1', '--json', 'conclusion,headSha',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw new Error(`cannot check Test workflow for ${commit}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || '').trim();
    throw new Error(`cannot check Test workflow for ${commit}${detail ? `: ${detail}` : ''}`);
  }
  let runs;
  try {
    runs = JSON.parse(result.stdout || '[]');
  } catch (_) {
    throw new Error(`cannot read Test workflow status for ${commit}: gh returned invalid JSON`);
  }
  const run = Array.isArray(runs) && runs.find((candidate) => candidate?.headSha === commit);
  if (!run) {
    throw new Error(
      `no completed Test workflow run found for ${commit}; refusing to publish. ` +
      `If Docker is available, run ${containerTestCommand(commit, suites)} before retrying with --ci-override "<reason>".`,
    );
  }
  if (run.conclusion !== 'success') {
    throw new Error(
      `Test workflow for ${commit} concluded ${run.conclusion || 'without a conclusion'}; refusing to publish. ` +
      'Retry with --ci-override "<reason>" only when the release fixes that CI failure.',
    );
  }
  return { commit, conclusion: run.conclusion };
}

function isGitHubRemote(remoteUrl) {
  return /(?:^|[@/:])github\.com(?::|\/|$)/i.test(remoteUrl);
}

export async function assertGitHubReleasePublished(
  repoRoot,
  tag,
  commit,
  {
    runner = spawnSync,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now = Date.now,
    timeoutMs = GITHUB_RELEASE_TIMEOUT_MS,
  } = {},
) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const release = runner('gh', ['release', 'view', tag], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (release.error) throw new Error(`cannot check GitHub Release ${tag}: ${release.error.message}`);
    if (release.status === 0) return { tag, status: 'published' };

    const workflow = runner('gh', [
      'run', 'list', '--workflow', GITHUB_RELEASE_WORKFLOW, '--commit', commit,
      '--status', 'completed', '--limit', '1', '--json', 'conclusion,headSha',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (workflow.error) throw new Error(`cannot check ${GITHUB_RELEASE_WORKFLOW} for ${tag}: ${workflow.error.message}`);
    if (workflow.status !== 0) {
      const detail = String(workflow.stderr || '').trim();
      throw new Error(`cannot check ${GITHUB_RELEASE_WORKFLOW} for ${tag}${detail ? `: ${detail}` : ''}`);
    }
    let runs;
    try {
      runs = JSON.parse(workflow.stdout || '[]');
    } catch (_) {
      throw new Error(`cannot read ${GITHUB_RELEASE_WORKFLOW} status for ${tag}: gh returned invalid JSON`);
    }
    const run = Array.isArray(runs) && runs.find((candidate) => candidate?.headSha === commit);
    if (run?.conclusion === 'success') {
      const completedRelease = runner('gh', ['release', 'view', tag], {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true,
      });
      if (completedRelease.error) throw new Error(`cannot check GitHub Release ${tag}: ${completedRelease.error.message}`);
      if (completedRelease.status === 0) return { tag, status: 'published' };
      return { tag, status: 'deferred', message: GITHUB_RELEASE_DEFERRED_MESSAGE };
    }
    if (run?.conclusion) {
      throw new Error(`${GITHUB_RELEASE_WORKFLOW} for ${tag} concluded ${run.conclusion}; GitHub Release was not published`);
    }
    if (now() >= deadline) {
      throw new Error(`GitHub Release ${tag} was not found within ${Math.round(timeoutMs / 60_000)} minutes after publish`);
    }
    await sleep(GITHUB_RELEASE_POLL_INTERVAL_MS);
  }
}
/**
 * The release commit and its tags are the verified artefact. Suites run arbitrary repository code,
 * so nothing they could have done to the local refs is allowed to reach the remote.
 */
function assertReleaseIntact(git, plan, commit) {
  const head = git.revParse('HEAD');
  if (head !== commit) {
    throw new Error(`HEAD moved from the verified release commit ${commit} to ${head} while the suites ran; nothing was published`);
  }
  const staged = git.stagedFiles();
  if (staged.length > 0) {
    throw new Error(`the suites left staged changes (${staged.slice(0, 5).join(', ')}); the verified release commit is no longer what the tree says, nothing was published`);
  }
  for (const tag of plan.tags) {
    const target = git.tagTarget(tag);
    if (target !== commit) {
      throw new Error(`tag ${tag} points at ${target ?? 'nothing'} instead of the verified release commit ${commit}; nothing was published`);
    }
  }
}

/**
 * Builds the whole release locally, then atomically publishes its commit and marketplace tag.
 * Plugin tags follow in a separate atomic update, so the tag that triggers the GitHub Release
 * workflow never shares a push with more than three tags. Everything before that stays local.
 */
export async function cut(options = {}) {
  const {
    repoRoot,
    mode = 'normal',
    tickets = null,
    sha = null,
    date = null,
    publishBranch = 'main',
    remote = 'origin',
    dryRun = false,
    push = false,
    skipTests = false,
    noMerge = false,
    branchCheck = true,
    allowDirty = false,
    force = false,
    ciOverrideReason = null,
    trustCi = false,
    keepOnFailure = false,
    log = console.log,
    auditRunner = runSidequestAudit,
  } = options;

  if (!repoRoot) throw new UsageError('cut() needs a repoRoot');
  if (trustCi && ciOverrideReason) {
    throw new UsageError('--trust-ci and --ci-override contradict each other: --trust-ci relies on a Test workflow that passed, --ci-override proceeds without one');
  }
  if (trustCi && mode === 'hotfix') {
    throw new UsageError('--trust-ci applies to normal windows only: a hotfix releases cherry-picks, not the pinned commit the Test workflow ran on');
  }
  const git = options.git ?? createGit({ cwd: repoRoot, dryRun });
  // Every push this cut makes is recorded from here on; the failure path treats any of them as
  // proof the remote may have changed, whatever the in-memory flags say.
  const historyStart = git.history?.length ?? 0;

  const loadManifest = (source) => {
    const loaded = readManifest(source, repoRoot);
    const errors = checkManifest(loaded);
    if (errors.length > 0) {
      throw new Error(`manifest versions are inconsistent, refusing to cut:\n  ${errors.join('\n  ')}`);
    }
    return loaded;
  };

  const pinned = git.revParse(sha ?? 'HEAD');
  const basePin = git.revParse('HEAD');

  // A staged file would ride along in the release commit no matter which paths the engine adds,
  // so the index has to be empty even when the caller tolerates a dirty tree.
  const staged = git.stagedFiles();
  if (staged.length > 0) {
    throw new Error(`the index has staged changes (${staged.slice(0, 5).join(', ')}); a release commit may only contain what the cut generated`);
  }
  if (!allowDirty && !git.isClean()) {
    throw new Error('the working tree has uncommitted changes; cut from a clean checkout or pass --allow-dirty');
  }
  const trackedCleanAtStart = !allowDirty || git.capture(['status', '--porcelain', '--untracked-files=no']) === '';
  if (branchCheck) {
    const branch = git.currentBranch();
    if (branch !== publishBranch) {
      throw new Error(`cutting from "${branch}" but the release lands on "${publishBranch}"; check out ${publishBranch} or pass --no-branch-check`);
    }
  }

  const windowSource = commitSource(git, pinned);
  const baseSource = mode === 'hotfix' ? commitSource(git, basePin) : windowSource;

  if (mode === 'normal' && !force) {
    const reason = isHeld(windowSource) ?? isHeld(diskSource(repoRoot));
    if (reason !== null) {
      log(`release held by ${HOLD_FILE}: ${reason}`);
      return { status: 'held', reason, plan: null };
    }
  }

  if (mode === 'hotfix' && (!tickets || tickets.length === 0)) {
    throw new UsageError('--mode hotfix needs --tickets SQ-x[,SQ-y]');
  }

  // A normal window is only what a fast-forward would produce. If the pin does not already contain
  // the publish branch, no plan built from it describes the cut that would follow.
  if (mode === 'normal' && pinned !== basePin && !git.isAncestor(basePin, pinned)) {
    throw new Error(`${publishBranch} (${basePin}) is not an ancestor of the pin ${pinned}, so this window could not fast-forward; choose a pin descended from ${publishBranch}`);
  }

  const manifest = loadManifest(baseSource);
  const released = releasedFragmentFingerprints(readRepoChangelog(baseSource));
  const { fragments, errors } = readFragments(windowSource, { knownPlugins: manifest.plugins });
  if (errors.length > 0) throw new Error(`invalid release fragments:\n  ${errors.map((error) => error.message).join('\n  ')}`);

  const plan = buildPlan({
    fragments,
    manifest,
    mode,
    tickets,
    released,
    force,
    date: date ?? git.commitDate(pinned),
    sha: pinned,
    base: basePin,
    publishBranch,
    suiteResolver: createSuiteResolver(repoRoot),
  });

  if (!plan.releasable) {
    log('nothing to release: no selected fragments in .release/unreleased/');
    return { status: 'nothing-to-release', plan };
  }

  assertNoStaleTags(git, plan, { remote, force });

  const githubRemote = !dryRun && isGitHubRemote(git.remoteUrl(remote));
  let ci = null;
  if (!dryRun && (options.assertParentCiPassed || githubRemote)) {
    // CI is asserted on the commit this window releases. The remote branch head is a different
    // commit whenever the pin is ahead of it, and its verdict says nothing about the pin.
    const assertCiPassed = options.assertParentCiPassed
      ?? ((repoRoot, commit, suites) => assertParentCiPassed(repoRoot, commit, spawnSync, suites));
    try {
      const result = assertCiPassed(repoRoot, pinned, plan.suites);
      ci = { status: 'passed', commit: pinned, conclusion: result?.conclusion ?? 'success' };
    } catch (error) {
      if (!ciOverrideReason) throw error;
      ci = { status: 'overridden', commit: pinned, reason: ciOverrideReason, error: error.message };
    }
  }
  const ciTrusted = trustCi && ci?.status === 'passed' && ci.commit === pinned;
  if (trustCi && !dryRun && !ciTrusted) {
    throw new Error(
      `--trust-ci needs a passing Test workflow on the pinned commit ${pinned}, but none was checked ` +
      `(the remote is not on GitHub and no CI check was supplied); nothing was changed. Run the suites, or drop --trust-ci.`,
    );
  }

  if (dryRun) {
    const pushCommands = publishCommands(plan, { remote, commit: null });
    log(formatPlan(plan).replace(/^publish:.*$/m, `publish:     ${pushCommands.join('\n             ')}`));
    const audit = await runReleaseAudit(repoRoot, false, log, auditRunner);
    return { status: 'dry-run', plan, pushCommands, audit };
  }

  let publishLock = null;
  let publishLockAcquired = false;
  try {
    if (push) {
      publishLock = options.publishLock ?? createPublishLock(repoRoot);
      const acquired = await publishLock.acquire();
      if (!acquired?.ok) throw new Error(publishLockRefusal(acquired ?? {}));
      publishLockAcquired = true;
    }

    // The plan was read from the pin, so the tree the writes land on has to BE the pin.
    if (mode === 'normal') {
      if (!noMerge && pinned !== basePin) git.mergeFastForward(pinned);
      const head = git.revParse('HEAD');
      if (head !== pinned) {
        throw new Error(`the working tree is at ${head} but the window was planned from ${pinned}; refusing to release a tree nobody planned`);
      }
    }

    if (mode === 'hotfix') {
      for (const fragment of plan.selected) {
        if (!fragment.commit) throw new Error(`${fragment.ref} has no "commit" field, so a hotfix cannot cherry-pick it`);
        if (git.isAncestor(fragment.commit, 'HEAD')) continue;
        git.cherryPick(fragment.commit);
      }
    }

    // The tree changed under the plan (merge or cherry-picks), so re-check the two things the plan
    // assumed about it before writing anything.
    const disk = diskSource(repoRoot);
    const current = loadManifest(disk);
    const moved = plan.plugins.filter((plugin) => current.plugins.get(plugin.name)?.version !== plugin.from);
    if (moved.length > 0) {
      throw new Error(
        `plugin versions moved after the plan was built: ${moved.map((plugin) => plugin.name).join(', ')}. ` +
        'Only a cut may write a version, so those commits must not be released this way.',
      );
    }
    const releasedNow = releasedFragmentFingerprints(readRepoChangelog(disk));
    const alreadyOut = plan.selected.filter((fragment) => releasedNow.has(fragmentFingerprint(fragment)));
    if (alreadyOut.length > 0) {
      throw new Error(`${alreadyOut.map((fragment) => fragment.ref).join(', ')} became released while this cut was building; nothing was published`);
    }

    const touched = [
      ...applyVersions(repoRoot, current, { plugins: plan.plugins, marketplaceVersion: plan.marketplace.to }),
      ...applyChangelogs(repoRoot, plan),
    ];

    const consumed = [];
    for (const fragment of plan.selected) {
      const relative = fragmentFile(fragment.ref);
      const absolute = resolveInRepo(repoRoot, relative, `fragment for ${fragment.ref}`);
      if (existsSync(absolute)) {
        rmSync(absolute);
        consumed.push(relative);
      }
    }

    const message = planCommitMessage(plan);
    git.add([...new Set([...touched, ...consumed])].sort());
    git.commit(message);
    const commit = git.revParse('HEAD');
    git.tag(plan.tag, message, { force });
    for (const plugin of plan.plugins) {
      git.tag(`${plugin.name}-v${plugin.to}`, `${plugin.name} ${plugin.to} (${plan.tag})`, { force });
    }
    plan.commit = commit;

    let marketplacePublished = false;
    // Set before the first push is attempted, never after: a push that throws may still have
    // reached the remote, so from this point on nothing is rolled back automatically.
    let pushStarted = false;
    try {
      const failures = [];
      const runSuite = options.runSuite ?? defaultSuiteRunner(repoRoot, { log, tag: plan.tag });
      if (!skipTests) {
        for (const suite of plan.suites) {
          const result = runSuite(suite);
          if (result.code !== 0) {
            const logNotice = result.logPath ? ` (log: ${result.logPath})` : '';
            failures.push(`${suite.plugin}: ${result.command} exited ${result.code}${logNotice}`);
          }
        }
      }
      const suiteWarnings = [];
      if (failures.length > 0 && !ciTrusted) {
        throw new Error(
          `release suites failed, nothing was published:\n  ${failures.join('\n  ')}`,
        );
      }
      for (const failure of failures) {
        const warning = `release suite failed locally, but the Test workflow passed on ${pinned} and --trust-ci accepts that verdict: ${failure}`;
        suiteWarnings.push(warning);
        log(`warning: ${warning}`);
      }
      assertReleaseIntact(git, plan, commit);

      const refspecs = planRefspecs(plan, commit);
      const marketplacePush = marketplaceRefspecs(plan, commit);
      const pluginPush = pluginTagRefspecs(plan);
      const pushCommands = publishCommands(plan, { remote, commit });
      let pushed = false;
      let githubRelease = null;
      let audit = null;
      if (push) {
        pushStarted = true;
        git.pushAtomic(remote, marketplacePush);
        marketplacePublished = true;
        if (pluginPush.length > 0) git.pushAtomic(remote, pluginPush);
        assertTagsPublished(git, plan, remote);
        if (githubRemote) {
          const assertReleasePublished = options.assertGitHubReleasePublished
            ?? ((repoRoot, tag, releaseCommit) => assertGitHubReleasePublished(repoRoot, tag, releaseCommit));
          githubRelease = await assertReleasePublished(repoRoot, plan.tag, commit);
          if (githubRelease.status === 'deferred') log(githubRelease.message);
        }
        pushed = true;
        log(`published ${plan.tag} (${commit})`);
        audit = await runReleaseAudit(repoRoot, true, log, auditRunner);
      } else {
        log(`built ${plan.tag} locally as ${commit}; publish it with:`);
        if (ci?.status === 'passed') {
          log(`Test CI on the pinned commit ${ci.commit} passed.`);
        } else if (ci?.status === 'overridden') {
          log(`Test CI on the pinned commit ${ci.commit} was overridden: ${ci.reason}`);
        }
        for (const command of pushCommands) log(`  ${command}`);
      }

      return {
        status: 'cut', plan, commit, message, pushed, refspecs, marketplacePush, pluginPush,
        pushCommands, touched, consumed, ci, suiteWarnings, githubRelease, audit,
      };
    } catch (error) {
      const pushSeen = pushStarted || (git.history ?? []).slice(historyStart).some((entry) => entry.mutatesRemote);
      const recovery = recoverFromFailure(git, plan, {
        remote,
        basePin,
        commit,
        pushStarted: pushSeen,
        marketplacePublished,
        keepOnFailure,
        trackedCleanAtStart,
      });
      const failure = new Error(`${error.message}\n${recovery.message}`, { cause: error });
      failure.rollback = recovery.rollback;
      throw failure;
    }
  } finally {
    if (publishLockAcquired) {
      const released = await publishLock.release();
      if (!released?.ok) throw new Error(publishLockReleaseFailure(released));
    }
  }
}

/** Maps the command line onto cut() options; `help` and `json` stay with the caller. */
export function parseCutArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      sha: { type: 'string' },
      mode: { type: 'string' },
      tickets: { type: 'string' },
      date: { type: 'string' },
      'publish-branch': { type: 'string' },
      remote: { type: 'string' },
      'dry-run': { type: 'boolean' },
      push: { type: 'boolean' },
      'skip-tests': { type: 'boolean' },
      'no-merge': { type: 'boolean' },
      'no-branch-check': { type: 'boolean' },
      'allow-dirty': { type: 'boolean' },
      force: { type: 'boolean' },
      'ci-override': { type: 'string' },
      'trust-ci': { type: 'boolean' },
      'keep-on-failure': { type: 'boolean' },
      json: { type: 'boolean' },
      repo: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  return {
    help: values.help === true,
    json: values.json === true,
    options: {
      repoRoot: path.resolve(values.repo ?? repoRootFrom(import.meta.url)),
      mode: values.mode ?? 'normal',
      tickets: splitList(values.tickets),
      sha: values.sha ?? null,
      date: values.date ?? null,
      publishBranch: values['publish-branch'] ?? 'main',
      remote: values.remote ?? 'origin',
      dryRun: values['dry-run'] === true,
      push: values.push === true,
      skipTests: values['skip-tests'] === true,
      noMerge: values['no-merge'] === true,
      branchCheck: values['no-branch-check'] !== true,
      allowDirty: values['allow-dirty'] === true,
      force: values.force === true,
      ciOverrideReason: values['ci-override'] ?? null,
      trustCi: values['trust-ci'] === true,
      keepOnFailure: values['keep-on-failure'] === true,
    },
  };
}

export async function main(argv) {
  const { help, json, options } = parseCutArgs(argv);
  if (help) {
    console.log(USAGE);
    return 0;
  }

  const result = await cut({ ...options, log: json ? () => {} : console.log });

  if (json) {
    console.log(JSON.stringify({
      status: result.status,
      commit: result.commit ?? null,
      pushed: result.pushed ?? false,
      pushCommand: result.pushCommand ?? null,
      refspecs: result.refspecs ?? [],
      ci: result.ci ?? null,
      suiteWarnings: result.suiteWarnings ?? [],
      githubRelease: result.githubRelease ?? null,
      touched: result.touched ?? [],
      consumed: result.consumed ?? [],
      plan: result.plan,
      changelog: REPO_CHANGELOG,
    }, null, 2));
  }
  return 0;
}

await runCli(import.meta.url, main);
