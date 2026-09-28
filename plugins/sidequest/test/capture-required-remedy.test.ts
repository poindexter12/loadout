import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

// SQ-185: after context compaction an executor lost the dispatched verify-capture wrapper
// invocation entirely, and neither the verification_capture_required refusal, the CLI help, nor
// the launcher printed it — recovery needed orchestrator help to rebuild it from
// capturedVerifyCommand() in lib/agentsync.js. These regression tests pin the refusal message
// (built at commandVerificationResult, code 'verification_capture_required') to include that same
// wrapper invocation, resolved from the running plugin's own path rather than a hardcoded version
// directory, so a resumed executor recovers on its own.

const verification = require('../src/lib/kernel/verification.ts');
const { commandVerificationResult, verifyCaptureWrapperCommand } = verification;

const EXPECTED_SCRIPT_PATH = path.join(__dirname, '..', 'src', 'lib', 'verify-capture.js');

test('verifyCaptureWrapperCommand resolves the script path from its own module location, not a hardcoded version dir', () => {
  const wrapper = verifyCaptureWrapperCommand('npm test', 'SQ-9', '/repo/project');
  assert.match(wrapper, /^node "/);
  assert.ok(wrapper.includes(JSON.stringify(EXPECTED_SCRIPT_PATH).slice(1, -1)) || wrapper.includes(EXPECTED_SCRIPT_PATH), wrapper);
  assert.ok(!/plugins[\\/]cache[\\/]loadout[\\/]sidequest[\\/]\d+\.\d+\.\d+/.test(wrapper), 'must not hardcode a versioned plugin cache directory');
});

test('verifyCaptureWrapperCommand pre-encodes the pinned verify command as base64', () => {
  const command = 'cd plugins/sidequest && npm run typecheck && npm run test:files -- test/foo.test.ts';
  const wrapper = verifyCaptureWrapperCommand(command, 'SQ-9', '/repo/project');
  const encoded = Buffer.from(command, 'utf8').toString('base64');
  assert.ok(wrapper.includes(`--base64 ${encoded}`), wrapper);
});

test('verifyCaptureWrapperCommand includes --project and --ticket only when both are known', () => {
  const withProject = verifyCaptureWrapperCommand('npm test', 'SQ-9', '/repo/project');
  assert.match(withProject, /--project "\/repo\/project"/);
  assert.match(withProject, /--ticket "SQ-9"/);

  const withoutProject = verifyCaptureWrapperCommand('npm test', 'SQ-9');
  assert.ok(!withoutProject.includes('--project'), withoutProject);
  assert.ok(!withoutProject.includes('--ticket'), withoutProject);
});

test('verifyCaptureWrapperCommand returns empty string for an empty command', () => {
  assert.strictEqual(verifyCaptureWrapperCommand('', 'SQ-9', '/repo/project'), '');
});

function baseArgs(overrides: Partial<{ command: string; captures: unknown[]; ticket: string; project: string }> = {}) {
  const command = overrides.command ?? 'npm test';
  const requirement = { kind: 'command', command, evidenceContract: command };
  const candidate = { source: 'git', value: 'a'.repeat(40) };
  const captures = overrides.captures ?? [];
  const ticket = overrides.ticket ?? 'SQ-9';
  return { requirement, command, candidate, captures, ticket };
}

test('verification_capture_required refusal includes the exact wrapper invocation when the project is known', () => {
  const { requirement, command, candidate, captures, ticket } = baseArgs();
  const verdict = commandVerificationResult(requirement, command, captures, ticket, candidate, 'n1', {}, '/repo/project');
  assert.strictEqual(verdict.diagnostic.code, 'verification_capture_required');
  const expectedWrapper = verifyCaptureWrapperCommand(command, ticket, '/repo/project');
  assert.ok(verdict.diagnostic.message.includes(expectedWrapper), verdict.diagnostic.message);
  assert.ok(verdict.diagnostic.message.includes('--project "/repo/project"'), verdict.diagnostic.message);
  assert.ok(verdict.diagnostic.message.includes('--ticket "SQ-9"'), verdict.diagnostic.message);
  assert.ok(verdict.result.evidence.includes(expectedWrapper), verdict.result.evidence);
});

test('verification_capture_required refusal still hands back a recoverable command and clear binding guidance when the project is not threaded through', () => {
  const { requirement, command, candidate, captures, ticket } = baseArgs();
  const verdict = commandVerificationResult(requirement, command, captures, ticket, candidate, 'n1', {});
  assert.strictEqual(verdict.diagnostic.code, 'verification_capture_required');
  assert.match(verdict.diagnostic.message, /^No completed passed verification capture exists/);
  assert.ok(verdict.diagnostic.message.includes('node "'), verdict.diagnostic.message);
  assert.ok(verdict.diagnostic.message.includes(`--base64 ${Buffer.from(command, 'utf8').toString('base64')}`), verdict.diagnostic.message);
  assert.ok(verdict.diagnostic.message.includes('Bind it to this ticket and attempt by adding --project'), verdict.diagnostic.message);
  assert.ok(verdict.diagnostic.message.includes('--ticket "SQ-9"'), verdict.diagnostic.message);
});

test('verification_capture_required refusal still names the SQ-179 waiver gate alongside the recovery command', () => {
  const { requirement, command, candidate, captures, ticket } = baseArgs();
  const verdict = commandVerificationResult(requirement, command, captures, ticket, candidate, 'n1', {}, '/repo/project');
  assert.match(verdict.diagnostic.message, /capture-waiver/);
});

test('a completed passing capture still resolves before any recovery guidance is needed', () => {
  const command = 'npm test';
  const requirement = { kind: 'command', command, evidenceContract: command };
  const candidate = { source: 'git', value: 'a'.repeat(40) };
  const captures = [{ id: 'green', ticket: 'SQ-9', command, status: 'passed', candidate, dispatchNonce: 'n1', exitCode: 0 }];
  const verdict = commandVerificationResult(requirement, command, captures, 'SQ-9', candidate, 'n1', {}, '/repo/project');
  assert.strictEqual(verdict.diagnostic, undefined);
  assert.strictEqual(verdict.result.status, 'passed');
});
