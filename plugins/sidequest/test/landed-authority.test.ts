import './_temp-cleanup.js';
'use strict';
/**
 * SQ-275: unit tests for landed-authority.ts's exports against tiny real git repos, plus a
 * structural assertion that the module stays isolated: no imports beyond node builtins, and
 * no mention of the local-ref concepts (refs/remotes, isAncestorCommit, targetBranchMergedIntoHead)
 * that belong to CHECKOUT STATE, not landedness, per the module's own header comment.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const landedAuthority = require('../lib/store/landed-authority.js');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function makeRepoPair(label: string): { origin: string; repo: string; base: string } {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), `sq-la-origin-${label}-`));
  execFileSync('git', ['init', '-b', 'main', '--bare', origin], { encoding: 'utf8', windowsHide: true });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `sq-la-repo-${label}-`));
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Sidequest Test']);
  git(repo, ['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'landed-authority unit fixture\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'base']);
  git(repo, ['remote', 'add', 'origin', origin]);
  git(repo, ['push', '-u', 'origin', 'main']);
  const base = git(repo, ['rev-parse', 'HEAD']);
  return { origin, repo, base };
}

test('SQ-275: landedRemoteFromTarget identifies a remote-mode target and rejects a local one', () => {
  assert.deepStrictEqual(
    landedAuthority.landedRemoteFromTarget({ mode: 'remote', upstream: 'origin/main', branch: 'main' }),
    { remote: 'origin', branch: 'main' },
  );
  // The remote branch comes from the upstream, never from the local branch name, so the consulted
  // ref is always the one the recorded git:<upstream> source names.
  assert.deepStrictEqual(
    landedAuthority.landedRemoteFromTarget({ mode: 'remote', upstream: 'origin/main', branch: 'feature-local' }),
    { remote: 'origin', branch: 'main' },
  );
  assert.deepStrictEqual(
    landedAuthority.landedRemoteFromTarget({ mode: 'remote', upstream: 'refs/remotes/origin/release/1.0', branch: 'release/1.0' }),
    { remote: 'origin', branch: 'release/1.0' },
  );
  assert.strictEqual(landedAuthority.landedRemoteFromTarget({ mode: 'local', upstream: 'main', branch: 'main' }), null);
  assert.strictEqual(landedAuthority.landedRemoteFromTarget({ branch: 'main', upstream: 'main' }), null);
  assert.strictEqual(landedAuthority.landedRemoteFromTarget({ branch: 'main', upstream: 'refs/heads/main' }), null);
  assert.strictEqual(landedAuthority.landedRemoteFromTarget(null), null);
});

test('SQ-275: proveLandedOnRemote reports landed true when the commit is the advertised tip', () => {
  const { origin, repo, base } = makeRepoPair('landed-true');
  const proof = landedAuthority.proveLandedOnRemote({ repo, remote: 'origin', branch: 'main', commit: base });
  assert.strictEqual(proof.ok, true);
  assert.strictEqual(proof.landed, true);
  assert.strictEqual(proof.tip, base);
  assert.strictEqual(proof.source, 'git:origin/main');
});

test('SQ-275: proveLandedOnRemote reports landed true when the commit is an ancestor of the advertised tip', () => {
  const { origin, repo, base } = makeRepoPair('landed-ancestor');
  fs.writeFileSync(path.join(repo, 'more.txt'), 'more\n');
  git(repo, ['add', 'more.txt']);
  git(repo, ['commit', '-m', 'advance']);
  git(repo, ['push', 'origin', 'main']);
  const tip = git(repo, ['rev-parse', 'HEAD']);

  const proof = landedAuthority.proveLandedOnRemote({ repo, remote: 'origin', branch: 'main', commit: base });
  assert.strictEqual(proof.ok, true);
  assert.strictEqual(proof.landed, true);
  assert.strictEqual(proof.tip, tip);
});

test('SQ-275: proveLandedOnRemote reports landed false when the commit is not an ancestor of the advertised tip', () => {
  const { origin, repo, base } = makeRepoPair('not-landed');
  // A sibling commit never pushed: origin/main stays at base, which does not contain it.
  git(repo, ['checkout', '-b', 'side']);
  fs.writeFileSync(path.join(repo, 'side.txt'), 'side\n');
  git(repo, ['add', 'side.txt']);
  git(repo, ['commit', '-m', 'side commit']);
  const sideCommit = git(repo, ['rev-parse', 'HEAD']);

  const proof = landedAuthority.proveLandedOnRemote({ repo, remote: 'origin', branch: 'main', commit: sideCommit });
  assert.strictEqual(proof.ok, true);
  assert.strictEqual(proof.landed, false);
  assert.strictEqual(proof.tip, base);
});

test('SQ-275: proveLandedOnRemote reports landed false (tip null) when the branch is absent on the remote', () => {
  const { origin, repo, base } = makeRepoPair('branch-absent');
  const proof = landedAuthority.proveLandedOnRemote({ repo, remote: 'origin', branch: 'does-not-exist', commit: base });
  assert.strictEqual(proof.ok, true);
  assert.strictEqual(proof.landed, false);
  assert.strictEqual(proof.tip, null);
});

test('SQ-275: proveLandedOnRemote refuses with landed_remote_unavailable when the remote cannot be contacted', () => {
  const { repo, base } = makeRepoPair('unreachable');
  execFileSync('git', ['remote', 'set-url', 'origin', path.join(os.tmpdir(), 'sq-la-does-not-exist')], { cwd: repo, encoding: 'utf8' });
  const proof = landedAuthority.proveLandedOnRemote({ repo, remote: 'origin', branch: 'main', commit: base });
  assert.strictEqual(proof.ok, false);
  assert.strictEqual(proof.reason, 'landed_remote_unavailable');
  assert.strictEqual(proof.remote, 'origin');
  assert.strictEqual(proof.branch, 'main');
  assert.ok(proof.detail && proof.detail.length > 0);
});

test('SQ-275: landed-authority.ts imports nothing beyond node builtins and names no local-ref concept', () => {
  const sourcePath = path.resolve(__dirname, '../src/lib/store/landed-authority.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');

  const importSpecifiers: string[] = [];
  const importRe = /^\s*import[^;]*?from\s+['"]([^'"]+)['"]/gm;
  let importMatch: RegExpExecArray | null;
  while ((importMatch = importRe.exec(source)) !== null) {
    const specifier = importMatch[1];
    if (specifier !== undefined) {
      importSpecifiers.push(specifier);
    }
  }
  assert.ok(importSpecifiers.length > 0, 'expected at least one import (node:child_process) to check');
  for (const specifier of importSpecifiers) {
    assert.ok(
      specifier.startsWith('node:') || ['assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'os', 'path', 'stream', 'util'].includes(specifier),
      `import "${specifier}" is not a node builtin; landed-authority.ts must import nothing from the store`,
    );
  }

  // The header comment and the refusal message deliberately NAME these local-ref concepts in
  // prose, to document (and tell the caller) that they are never consulted -- that is correct
  // and not a leak. What must never happen is the module actually REACHING for one: issuing a
  // git command against refs/remotes, or calling the checkout-state helpers that belong to
  // submissions.ts. So check real usage, not every textual mention.
  const commentStripped = source
    .split('\n')
    .filter((line: string) => !line.trim().startsWith('//'))
    .join('\n');
  assert.doesNotMatch(
    commentStripped,
    /isAncestorCommit\(/,
    'must never call the checkout-state ancestor helper',
  );
  assert.doesNotMatch(
    commentStripped,
    /targetBranchMergedIntoHead\(/,
    'must never call the checkout-state check that belongs to submissions.ts',
  );

  const gitCallArgs: string[] = [];
  const gitCallRe = /git\(repo,\s*\[[^\]]*\]\)/g;
  let gitCallMatch: RegExpExecArray | null;
  while ((gitCallMatch = gitCallRe.exec(source)) !== null) {
    gitCallArgs.push(gitCallMatch[0]);
  }
  assert.ok(gitCallArgs.length > 0, 'expected at least one git(repo, [...]) call to inspect');
  for (const call of gitCallArgs) {
    assert.doesNotMatch(call, /refs\/remotes/, `git call must never argue a local remote-tracking ref: ${call}`);
  }
});
