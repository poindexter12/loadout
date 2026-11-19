import './_temp-cleanup.js';
'use strict';
/**
 * SQ-407: groomClose must close a ticket whose work landed on the target in a form other than
 * the pinned candidate commit itself, instead of forcing a false "abandoned":
 *   - rebase or cherry-pick: every candidate patch is on the target's landed history
 *     (patch_equivalent), found without naming anything;
 *   - fold or landing-then-later-edits: the candidate's diff is present in the named
 *     landingCommits (landed_diff_equivalent);
 *   - attested: the orchestrator's last resort over named landing commits, recorded as attested,
 *     never verified and never abandoned.
 * Each guardrail has its own refusal: landings must be reachable from the remote's live tip
 * (SQ-275), must touch a candidate path, an attestation must name them, a reverted landing proves
 * nothing, live claims still refuse, and merged-tree verification still runs.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-equivalent-landing-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const mcp = require('../lib/mcp.js');
const {
  nodeVerify,
  makeLandedFixture,
  patchTicket,
  originTip,
} = require('./_landed-delivery-fixture.js');

// Verifies only where the candidate content exists, so a delivery verified anywhere that lacks
// feature.txt fails loudly instead of passing by accident.
const CONTENT_VERIFY = nodeVerify("process.exit(require('fs').existsSync('feature.txt') ? 0 : 1)");

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitFiles(repo: string, files: Record<string, string | null>, message: string): string {
  for (const [file, contents] of Object.entries(files)) {
    if (contents === null) git(repo, ['rm', '-q', file]);
    else {
      fs.writeFileSync(path.join(repo, file), contents);
      git(repo, ['add', file]);
    }
  }
  git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

function pushMain(fixture: any) {
  git(fixture.repo, ['push', 'origin', 'main']);
}

function advanceMain(fixture: any) {
  git(fixture.repo, ['checkout', 'main']);
  return commitFiles(fixture.repo, { 'other.txt': 'unrelated main work\n' }, 'unrelated main work');
}

function groom(fixture: any, opts: any = {}) {
  return store.completeTicketAsControlPlane(fixture.slug, fixture.ticketRef, Object.assign({
    purpose: 'grooming',
    by: 'groomer',
    reason: 'the work landed on main outside the board',
  }, opts));
}

function deliverClose(fixture: any, opts: any) {
  return store.completeTicketAsControlPlane(fixture.slug, fixture.ticketRef, Object.assign({
    purpose: 'delivery',
    by: 'groomer',
    reason: 'shipped outside the board',
  }, opts));
}

function ticketOf(fixture: any) {
  return store.getTicket(fixture.slug, fixture.ticketRef);
}

function assertStillPending(fixture: any) {
  const ticket = ticketOf(fixture);
  assert.notStrictEqual(ticket.status, 'done', 'a refused closure leaves the ticket open');
  assert.ok(!ticket.submission.integration || !['verified', 'attested', 'abandoned', 'delivered'].includes(ticket.submission.integration.outcome),
    'a refused closure records no delivery outcome');
}

function isAncestor(repo: string, ancestor: string, descendant: string) {
  try {
    git(repo, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (_) {
    return false;
  }
}

async function callTool(name: string, args: any) {
  const resp = await mcp.handleRequest({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } });
  assert.ok(resp && resp.result && !resp.result.isError, `tool ${name} errored: ${resp?.result?.content?.[0]?.text}`);
  return JSON.parse(resp.result.content[0].text);
}

test('SQ-407: a candidate rebased onto the target closes as patch_equivalent without naming its landing', () => {
  const fixture = makeLandedFixture('rebased', CONTENT_VERIFY, { sharedFile: true });
  const candidateCommits = ticketOf(fixture).submission.commits;
  assert.strictEqual(candidateCommits.length, 2, 'fixture: a two-commit candidate, so every commit must match');
  advanceMain(fixture);
  git(fixture.repo, ['cherry-pick', ...candidateCommits]);
  const rebased = [git(fixture.repo, ['rev-parse', 'HEAD~1']), git(fixture.repo, ['rev-parse', 'HEAD'])];
  pushMain(fixture);
  assert.ok(!isAncestor(fixture.repo, fixture.candidate, originTip(fixture)), 'fixture: the pinned candidate itself never landed');

  const closed = groom(fixture);
  assert.strictEqual(closed.ok, true, JSON.stringify({ reason: closed.reason, message: closed.message }));

  const ticket = ticketOf(fixture);
  assert.strictEqual(ticket.status, 'done');
  const integration = ticket.submission.integration;
  assert.strictEqual(integration.outcome, 'verified');
  assert.strictEqual(integration.contentEvidence, 'patch_equivalent');
  assert.strictEqual(integration.deliveryIdentity.kind, 'patch-equivalent');
  assert.strictEqual(integration.deliveryIdentity.evidence, 'patch_equivalent');
  assert.deepStrictEqual(integration.landingCommits, rebased);
  assert.deepStrictEqual(integration.deliveryIdentity.equivalentPatches, [
    { candidate: candidateCommits[0], landed: rebased[0] },
    { candidate: candidateCommits[1], landed: rebased[1] },
  ]);
  assert.strictEqual(integration.contentCommit, rebased[1], 'verified at the newest landing commit');
  assert.strictEqual(integration.verify.status, 'passed', 'merged-tree verification still ran');
});

test('SQ-407 guardrail: integrate keeps its exact-content contract; only groomClose reaches the equivalence routes', () => {
  // The same rebased shape groomClose proves above. integrate calls recordDeliveredSubmission
  // without equivalentLanding, so naming the unreachable candidate stays delivery_not_reachable
  // (SQ-2169) and the relaxation cannot widen integrate's delivery contract.
  const fixture = makeLandedFixture('integrate-stays-exact', CONTENT_VERIFY, { sharedFile: true });
  const candidateCommits = ticketOf(fixture).submission.commits;
  advanceMain(fixture);
  git(fixture.repo, ['cherry-pick', ...candidateCommits]);
  const rebasedTip = git(fixture.repo, ['rev-parse', 'HEAD']);
  pushMain(fixture);
  const target = store.integrationTarget(fixture.slug);

  const exact = store.recordDeliveredSubmission(fixture.slug, fixture.ticketRef, {
    target,
    deliveryCommit: fixture.candidate,
    reason: 'integrate names the pinned candidate',
  });
  assert.strictEqual(exact.ok, false, 'integrate does not accept a patch-equivalent landing');
  assert.strictEqual(exact.reason, 'delivery_not_reachable');
  assert.match(exact.message, /close the ticket with groomClose/, 'integrate points at the closure that proves equivalence');
  assertStillPending(fixture);

  const named = store.recordDeliveredSubmission(fixture.slug, fixture.ticketRef, {
    target,
    deliveryCommit: fixture.candidate,
    landingCommits: [rebasedTip],
    reason: 'integrate names landing commits',
  });
  assert.strictEqual(named.ok, false);
  assert.strictEqual(named.reason, 'landing_commits_unsupported');
  assertStillPending(fixture);

  const attested = store.recordDeliveredSubmission(fixture.slug, fixture.ticketRef, {
    target,
    deliveryCommit: fixture.candidate,
    deliveryMethod: 'attested',
    landingCommits: [rebasedTip],
    reason: 'integrate attests a landing',
  });
  assert.strictEqual(attested.ok, false);
  assert.strictEqual(attested.reason, 'invalid_delivery_method', 'attested is a groomClose method only');
  assertStillPending(fixture);

  const closed = groom(fixture);
  assert.strictEqual(closed.ok, true, JSON.stringify({ reason: closed.reason, message: closed.message }));
  assert.strictEqual(ticketOf(fixture).submission.integration.contentEvidence, 'patch_equivalent');
});

test('SQ-407: a cherry-pick later edited on the target still closes as patch_equivalent at the landing commit', () => {
  const fixture = makeLandedFixture('picked-then-edited', CONTENT_VERIFY);
  advanceMain(fixture);
  git(fixture.repo, ['cherry-pick', fixture.candidate]);
  const picked = git(fixture.repo, ['rev-parse', 'HEAD']);
  commitFiles(fixture.repo, { 'feature.txt': 'candidate content\nedited after landing\n' }, 'later edit of the landed work');
  pushMain(fixture);

  const closed = groom(fixture);
  assert.strictEqual(closed.ok, true, JSON.stringify({ reason: closed.reason, message: closed.message }));
  const integration = ticketOf(fixture).submission.integration;
  assert.strictEqual(integration.deliveryIdentity.kind, 'patch-equivalent');
  assert.deepStrictEqual(integration.landingCommits, [picked]);
  assert.strictEqual(integration.contentCommit, picked);
  assert.strictEqual(integration.outcome, 'verified');
});

test('SQ-407: a whitespace-variant landing is not patch_equivalent, and the refusal offers the equivalence routes before abandonment', () => {
  const fixture = makeLandedFixture('whitespace-variant', CONTENT_VERIFY);
  advanceMain(fixture);
  const variant = commitFiles(fixture.repo, { 'feature.txt': 'candidate  content\n' }, 'landed with different whitespace');
  pushMain(fixture);

  const refused = groom(fixture);
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'delivery_not_reachable');
  const message = String(refused.message);
  assert.ok(message.includes(variant), 'the refusal names the landed commit that touches the candidate paths');
  assert.match(message, /landingCommits/);
  assert.match(message, /deliveryMethod "attested"/);
  const equivalence = message.indexOf('landingCommits');
  const abandon = message.indexOf('--abandon-submission');
  assert.ok(abandon > equivalence && equivalence >= 0, 'the equivalence and attested routes come before --abandon-submission');
  assertStillPending(fixture);
});

test('SQ-407: a candidate folded into a larger landing closes as landed_diff_equivalent when the landing is named', () => {
  const fixture = makeLandedFixture('folded', CONTENT_VERIFY);
  git(fixture.repo, ['checkout', 'main']);
  const fold = commitFiles(fixture.repo, { 'feature.txt': 'candidate content\n', 'other.txt': 'folded alongside\n' }, 'fold several tickets');
  pushMain(fixture);

  const unnamed = groom(fixture);
  assert.strictEqual(unnamed.ok, false, 'a fold is not patch-equivalent, so it must be named');
  assert.ok(String(unnamed.message).includes(fold), 'the refusal names the fold as a candidate landing');
  assertStillPending(fixture);

  const closed = groom(fixture, { landingCommits: [fold.slice(0, 12)] });
  assert.strictEqual(closed.ok, true, JSON.stringify({ reason: closed.reason, message: closed.message }));
  const ticket = ticketOf(fixture);
  assert.strictEqual(ticket.status, 'done');
  const integration = ticket.submission.integration;
  assert.strictEqual(integration.outcome, 'verified');
  assert.strictEqual(integration.contentEvidence, 'landed_diff_equivalent');
  assert.strictEqual(integration.deliveryIdentity.kind, 'landed-diff-equivalent');
  assert.deepStrictEqual(integration.landingCommits, [fold], 'an abbreviated landing commit is recorded resolved');
  assert.strictEqual(integration.contentCommit, fold);
  assert.strictEqual(integration.verify.status, 'passed');
});

test('SQ-407: work that landed and was then edited closes as landed_diff_equivalent at the commit that carried it', () => {
  const fixture = makeLandedFixture('landed-then-edited', CONTENT_VERIFY);
  git(fixture.repo, ['checkout', 'main']);
  const landing = commitFiles(fixture.repo, { 'feature.txt': 'candidate content\n', 'other.txt': 'folded alongside\n' }, 'fold the candidate');
  const edit = commitFiles(fixture.repo, { 'feature.txt': 'candidate content\nedited after landing\n' }, 'later edit of the landed work');
  pushMain(fixture);

  const closed = groom(fixture, { landingCommits: [landing, edit] });
  assert.strictEqual(closed.ok, true, JSON.stringify({ reason: closed.reason, message: closed.message }));
  const integration = ticketOf(fixture).submission.integration;
  assert.strictEqual(integration.deliveryIdentity.kind, 'landed-diff-equivalent');
  assert.deepStrictEqual(integration.landingCommits, [landing, edit]);
  assert.strictEqual(integration.deliveryIdentity.landingCommit, landing, 'the carrier is the landing, not the later edit');
  assert.strictEqual(integration.verify.status, 'passed');
});

test('SQ-407: attested delivery over a reworded landing is recorded attested, never verified or abandoned', () => {
  const fixture = makeLandedFixture('attested', CONTENT_VERIFY);
  git(fixture.repo, ['checkout', 'main']);
  const reworded = commitFiles(fixture.repo, { 'feature.txt': 'candidate content, reworded on landing\n' }, 'reworded landing');
  pushMain(fixture);

  const unproven = groom(fixture, { landingCommits: [reworded] });
  assert.strictEqual(unproven.ok, false);
  assert.strictEqual(unproven.reason, 'landed_equivalence_unproven', 'a named landing the board cannot prove is refused, not accepted');
  assert.match(String(unproven.message), /deliveryMethod "attested"/);
  assertStillPending(fixture);

  const reason = 'Reworded on landing in PR #12; reviewed by the orchestrator against the candidate.';
  const closed = groom(fixture, { deliveryMethod: 'attested', landingCommits: [reworded], reason });
  assert.strictEqual(closed.ok, true, JSON.stringify({ reason: closed.reason, message: closed.message }));
  const ticket = ticketOf(fixture);
  assert.strictEqual(ticket.status, 'done');
  const integration = ticket.submission.integration;
  assert.strictEqual(integration.outcome, 'attested');
  assert.notStrictEqual(integration.outcome, 'abandoned');
  assert.strictEqual(integration.verifiedAt, undefined, 'an attested delivery carries no verifiedAt');
  assert.ok(integration.attestedAt, 'an attested delivery records when it was attested');
  assert.strictEqual(integration.attestation, reason);
  assert.strictEqual(integration.contentEvidence, 'attested');
  assert.strictEqual(integration.deliveryIdentity.kind, 'attested');
  assert.strictEqual(integration.deliveryIdentity.method, 'attested');
  assert.deepStrictEqual(integration.landingCommits, [reworded]);
  assert.strictEqual(integration.verify.status, 'passed', 'merged-tree verification still ran at the landing');
});

test('SQ-407: an attested delivery through MCP groomClose accepts landingCommits and the attested method', async () => {
  const fixture = makeLandedFixture('attested-mcp', CONTENT_VERIFY);
  git(fixture.repo, ['checkout', 'main']);
  const reworded = commitFiles(fixture.repo, { 'feature.txt': 'candidate content, reworded through MCP\n' }, 'reworded landing');
  pushMain(fixture);

  const closed = await callTool('groomClose', {
    project: fixture.slug,
    ref: fixture.ticketRef,
    by: 'groomer',
    reason: 'Reworded on landing; attested by the orchestrator.',
    deliveryMethod: 'attested',
    landingCommits: [reworded],
  });
  assert.strictEqual(closed.ok, true, JSON.stringify({ reason: closed.reason, message: closed.message }));
  assert.strictEqual(ticketOf(fixture).submission.integration.outcome, 'attested');
});

test('SQ-407: CLI groom-close passes --landing-commit (comma-split) and --delivery-method attested to the store', () => {
  const fixture = makeLandedFixture('attested-cli', CONTENT_VERIFY);
  git(fixture.repo, ['checkout', 'main']);
  const first = commitFiles(fixture.repo, { 'feature.txt': 'candidate content, reworded through the CLI\n' }, 'reworded landing');
  const second = commitFiles(fixture.repo, { 'feature.txt': 'candidate content, reworded again\n' }, 'second landing edit');
  pushMain(fixture);
  const pluginRoot = path.resolve(__dirname, '..');
  const cli = (extra: string[]) => {
    const result = spawnSync(process.execPath, [path.join(pluginRoot, 'bin', 'sidequest.js'), 'groom-close', fixture.ticketRef,
      '--landing-commit', `${first},${second}`, '--by', 'groomer', '--json', '--project', fixture.repo, ...extra], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: fixture.repo, CLAUDE_PLUGIN_ROOT: pluginRoot },
    });
    return { status: result.status, out: JSON.parse(result.stdout || '{}'), stderr: result.stderr };
  };

  const unproven = cli(['--reason', 'Reworded on landing; not yet attested.']);
  assert.notStrictEqual(unproven.status, 0, unproven.stderr);
  assert.strictEqual(unproven.out.reason, 'landed_equivalence_unproven', 'the named landing reached the equivalence routes');
  assertStillPending(fixture);

  const closed = cli(['--delivery-method', 'attested', '--reason', 'Reworded on landing; attested by the orchestrator.']);
  assert.strictEqual(closed.status, 0, JSON.stringify({ reason: closed.out.reason, message: closed.out.message, stderr: closed.stderr }));
  const integration = ticketOf(fixture).submission.integration;
  assert.strictEqual(integration.outcome, 'attested');
  assert.deepStrictEqual(integration.landingCommits, [first, second], 'both comma-split landing commits are recorded');
});

test('SQ-407 guardrail: landing commits present only on this machine are refused on a remote-mode board (SQ-275)', () => {
  const fixture = makeLandedFixture('local-only', CONTENT_VERIFY);
  advanceMain(fixture);
  pushMain(fixture);
  git(fixture.repo, ['cherry-pick', fixture.candidate]);
  const localPick = git(fixture.repo, ['rev-parse', 'HEAD']);
  assert.ok(!isAncestor(fixture.repo, localPick, originTip(fixture)), 'fixture: the pick is local only');

  const unnamed = groom(fixture);
  assert.strictEqual(unnamed.ok, false, 'a local-only rebase is never patch-equivalent landing');
  assert.strictEqual(unnamed.reason, 'delivery_not_reachable');

  for (const opts of [{ landingCommits: [localPick] }, { deliveryMethod: 'attested', landingCommits: [localPick] }]) {
    const refused = groom(fixture, opts);
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.reason, 'landing_commit_not_reachable', JSON.stringify(opts));
    assert.deepStrictEqual(refused.landingCommits, [localPick]);
  }
  assertStillPending(fixture);
});

test('SQ-407 guardrail: landing commits that touch none of the candidate paths are refused, attested or not', () => {
  const fixture = makeLandedFixture('unrelated', CONTENT_VERIFY);
  const unrelated = advanceMain(fixture);
  pushMain(fixture);

  for (const opts of [{ landingCommits: [unrelated] }, { deliveryMethod: 'attested', landingCommits: [unrelated] }]) {
    const refused = groom(fixture, opts);
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.reason, 'landing_commits_unrelated', JSON.stringify(opts));
  }
  assertStillPending(fixture);
});

test('SQ-407 guardrail: an attested delivery must name its landing commits, and they must be commit hashes', () => {
  const fixture = makeLandedFixture('attested-unnamed', CONTENT_VERIFY);
  git(fixture.repo, ['checkout', 'main']);
  commitFiles(fixture.repo, { 'feature.txt': 'candidate content, reworded\n' }, 'reworded landing');
  pushMain(fixture);

  const unnamed = groom(fixture, { deliveryMethod: 'attested' });
  assert.strictEqual(unnamed.ok, false);
  assert.strictEqual(unnamed.reason, 'landing_commits_required');
  assert.strictEqual(groom(fixture, { deliveryMethod: 'attested', landingCommits: ['not-a-commit'] }).reason, 'landing_commit_invalid');
  assert.strictEqual(groom(fixture, { deliveryMethod: 'attested', landingCommits: ['0123456789abcdef'] }).reason, 'landing_commit_unknown');
  assertStillPending(fixture);
});

test('SQ-407 guardrail: a landing reverted on the target proves nothing', () => {
  const fixture = makeLandedFixture('reverted', CONTENT_VERIFY);
  advanceMain(fixture);
  git(fixture.repo, ['cherry-pick', fixture.candidate]);
  const picked = git(fixture.repo, ['rev-parse', 'HEAD']);
  git(fixture.repo, ['revert', '--no-edit', picked]);
  const revert = git(fixture.repo, ['rev-parse', 'HEAD']);
  pushMain(fixture);

  const refused = groom(fixture);
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'delivery_reverted');
  assert.strictEqual(refused.landingCommit, picked);
  assert.strictEqual(refused.revertCommit, revert);
  assertStillPending(fixture);
});

test('SQ-407 guardrail: merged-tree verification still runs for an attested delivery and a failure refuses it', () => {
  const fixture = makeLandedFixture('attested-verify-fails', CONTENT_VERIFY);
  git(fixture.repo, ['checkout', 'main']);
  commitFiles(fixture.repo, { 'feature.txt': 'candidate content, reworded\n' }, 'reworded landing');
  const removal = commitFiles(fixture.repo, { 'feature.txt': null }, 'remove the landed file again');
  pushMain(fixture);

  const refused = groom(fixture, { deliveryMethod: 'attested', landingCommits: [removal] });
  assert.strictEqual(refused.ok, false, 'verification at the landing fails, so the attestation is refused');
  assert.match(String(refused.reason), /_recorded_delivery$/);
  assert.notStrictEqual(ticketOf(fixture).status, 'done');
});

test('SQ-407 guardrail: live claims still refuse, an unknown method is refused, and an executor cannot done released work', () => {
  const fixture = makeLandedFixture('guardrails', CONTENT_VERIFY);
  git(fixture.repo, ['checkout', 'main']);
  const reworded = commitFiles(fixture.repo, { 'feature.txt': 'candidate content, reworded\n' }, 'reworded landing');
  pushMain(fixture);

  const invalid = deliverClose(fixture, { deliveryCommit: reworded, deliveryMethod: 'vouched' });
  assert.strictEqual(invalid.ok, false);
  assert.strictEqual(invalid.reason, 'invalid_delivery_method');
  assert.match(String(invalid.message), /reset, working-tree, manual, or attested/);

  // A released executor leaves routed dispatch history behind; with it, done stays refused.
  patchTicket(fixture, (ticket: any) => {
    ticket.dispatch = { outcome: 'released', terminalAt: new Date().toISOString(), nonce: 'sq-407-released-dispatch' };
  });
  assert.throws(
    () => store.updateTicket(fixture.slug, fixture.ticketRef, { status: 'done' }),
    /pending submission|routed dispatch history/,
    'released repo work cannot be marked done outside the integration lifecycle',
  );
  let executorDone: any;
  try {
    executorDone = store.completeTicket(fixture.slug, fixture.ticketRef, 'guardrails-worker', { model: 'opus', effort: 'high' });
  } catch (error: any) {
    executorDone = { ok: false, reason: String(error && error.message) };
  }
  assert.strictEqual(executorDone.ok, false, `the executor cannot done its released repo work: ${JSON.stringify(executorDone && executorDone.reason)}`);
  assert.notStrictEqual(ticketOf(fixture).status, 'done');
  patchTicket(fixture, (ticket: any) => {
    ticket.dispatch = null;
  });

  patchTicket(fixture, (ticket: any) => {
    ticket.claim = { by: 'live-executor', at: new Date().toISOString() };
  });
  const delivery = deliverClose(fixture, { deliveryCommit: reworded, deliveryMethod: 'attested', landingCommits: [reworded] });
  assert.strictEqual(delivery.ok, false);
  assert.strictEqual(delivery.reason, 'active_dispatch');
  patchTicket(fixture, (ticket: any) => {
    ticket.dispatchNonce = 'sq-407-live-dispatch';
  });
  const grooming = groom(fixture, { deliveryMethod: 'attested', landingCommits: [reworded] });
  assert.strictEqual(grooming.ok, false);
  assert.strictEqual(grooming.reason, 'active_dispatch');
  assertStillPending(fixture);
});
