import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';
/**
 * SQ-223: an orchestrator amended a live dispatch's verify after the executor had
 * already read its briefing. The board re-pinned the dispatch, but nothing told
 * the executor: the wrapper invocation in its briefing still carried the old
 * base64 command, and the capture refusal only said the command "must use its
 * declared command pinned at dispatch", which read as the briefing contradicting
 * the pin. The briefing now names the amendment, and a capture of the superseded
 * command is refused with the amendment and the current wrapper invocation.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-amendment-test-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const agentsync = require('../lib/agentsync.js');
const { verifyCaptureWrapperCommand } = require('../lib/kernel/verification.js');

const PROJECT_DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-amendment-project-')));
function git(args: string[]) {
  return execFileSync('git', args, { cwd: PROJECT_DIR, encoding: 'utf8', windowsHide: true }).trim();
}
git(['init', '-b', 'main']);
git(['config', 'user.name', 'Sidequest Test']);
git(['config', 'user.email', 'sidequest-test@example.invalid']);
fs.writeFileSync(path.join(PROJECT_DIR, 'README.md'), 'amendment fixture\n');
git(['add', '.']);
git(['commit', '-m', 'base']);
const { slug } = store.ensureProject(PROJECT_DIR);
store.setCategory({
  id: 'amendment.fixture',
  name: 'Amendment fixture',
  description: 'Fixed verify amendment fixture.',
  route: { model: 'sonnet', effort: 'medium' },
  fallback: null,
  enabled: true,
});

const ORIGINAL = 'node -e "process.exit(0)" && node -e "process.exit(1)"';
const AMENDED = 'node -e "process.exit(0)"';

function amendedLiveDispatch(title: string) {
  const ticket = store.createTicket(slug, {
    title,
    complexity: 3,
    complexityWhy: 'fixture for the verify amendment notice tests, single change',
    files: ['lib/fixture.js'],
    source: 'cli',
    labels: ['direct-ok'],
    category: 'amendment.fixture',
    executorVerifyKind: 'command',
    executorVerify: ORIGINAL,
  });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `amendment-${ticket.ref}`, sharedTree: true });
  const staleBriefing = agentsync.renderTicketBriefing(prepared.ticket, prepared.token, slug, PROJECT_DIR);
  store.updateTicket(slug, ticket.ref, { executorVerifyKind: 'command', executorVerify: AMENDED, by: 'orchestrator', source: 'test' });
  return { ref: ticket.ref, token: prepared.token, staleBriefing };
}

test('SQ-223: a capture of the superseded verify names the amendment and the current wrapper', () => {
  const { ref, staleBriefing } = amendedLiveDispatch('stale briefing capture');
  const staleWrapper = verifyCaptureWrapperCommand(ORIGINAL, ref, PROJECT_DIR);
  const currentWrapper = verifyCaptureWrapperCommand(AMENDED, ref, PROJECT_DIR);
  const staleEncoded = Buffer.from(ORIGINAL, 'utf8').toString('base64');
  const currentEncoded = Buffer.from(AMENDED, 'utf8').toString('base64');
  assert.ok(staleBriefing.includes(`--base64 ${staleEncoded}`), 'the briefing read before the amendment carries the old command');
  assert.ok(staleWrapper.includes(staleEncoded));

  const refused = store.recordVerificationCapture(slug, ref, { command: ORIGINAL, preflight: true });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'verification_capture_command_mismatch');
  assert.match(refused.message, /amended after this dispatch/i);
  assert.match(refused.message, /by orchestrator/);
  assert.ok(refused.message.includes(`--base64 ${currentEncoded}`), refused.message);
  assert.ok(refused.message.includes(currentWrapper), refused.message);
  assert.doesNotMatch(refused.message, /release the claim, and re-dispatch/i, 'a synced amendment needs a rerun, not a re-dispatch');

  const accepted = store.recordVerificationCapture(slug, ref, { command: AMENDED, preflight: true });
  assert.strictEqual(accepted.ok, true);
});

test('SQ-223: an unrelated mismatch prints the wrapper invocation for the current pin', () => {
  const { ref } = amendedLiveDispatch('unrelated mismatch capture');
  const refused = store.recordVerificationCapture(slug, ref, { command: 'node --version', preflight: true });
  assert.strictEqual(refused.reason, 'verification_capture_command_mismatch');
  assert.ok(refused.message.includes(verifyCaptureWrapperCommand(AMENDED, ref, PROJECT_DIR)), refused.message);
});

test('SQ-223: a briefing rendered after an amendment says the verify changed and which command is current', () => {
  const { ref, token } = amendedLiveDispatch('amended briefing');
  const briefing = agentsync.renderTicketBriefing(store.getTicket(slug, ref), token, slug, PROJECT_DIR);
  assert.ok(briefing.includes(`--base64 ${Buffer.from(AMENDED, 'utf8').toString('base64')}`));
  assert.ok(!briefing.includes(`--base64 ${Buffer.from(ORIGINAL, 'utf8').toString('base64')}`));
  assert.match(briefing, /Verify amended after this dispatch was prepared/);
  assert.ok(briefing.includes(JSON.stringify(ORIGINAL)), 'the briefing names the superseded command');
});

test('SQ-223: a briefing with no amendment carries no amendment notice', () => {
  const ticket = store.createTicket(slug, {
    title: 'unamended briefing',
    complexity: 3,
    complexityWhy: 'fixture for the verify amendment notice tests, single change',
    files: ['lib/fixture.js'],
    source: 'cli',
    labels: ['direct-ok'],
    category: 'amendment.fixture',
    executorVerifyKind: 'command',
    executorVerify: AMENDED,
  });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `amendment-${ticket.ref}`, sharedTree: true });
  const briefing = agentsync.renderTicketBriefing(prepared.ticket, prepared.token, slug, PROJECT_DIR);
  assert.doesNotMatch(briefing, /Verify amended/);
});
