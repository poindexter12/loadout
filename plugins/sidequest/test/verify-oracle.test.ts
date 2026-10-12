import './_temp-cleanup.js';
import './_gateway-catalog-freshness.js';
import './_sidequest-install-fixture.js';
'use strict';

/**
 * SQ-319: a ticket must not be storable with `executorVerifyKind: command` and no
 * command. `verifyCommandErrors` passes an empty string and `classifyVerificationKind`
 * keeps the declared kind, so that pairing used to be accepted; dispatch then pinned a
 * DERIVED requirement (usually the whole plugin suite) that no submission could match
 * against the ticket's own empty command. Observed on SQ-300: three hours of full suite
 * and two negative controls before the empty field was found by hand in the DB.
 *
 * Run: npm run test:files test/verify-oracle.test.ts
 */

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-oracle-empty-home-'));

// The derivation case has to actually dispatch, and dispatch refuses without a resolvable
// route, so this mirrors dispatch-lifecycle.test.ts's catalog fixture.
const DISCOVERY = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-oracle-catalog-'));
fs.mkdirSync(path.join(DISCOVERY, 'model-gateway'), { recursive: true });
fs.writeFileSync(path.join(DISCOVERY, 'model-gateway', 'catalog.json'), JSON.stringify({
  schemaVersion: 3,
  updatedAt: new Date().toISOString(),
  source: 'model-gateway',
  codexReadiness: { ready: true, state: 'ready', message: 'Codex readiness confirms the local gateway is ready.' },
  models: [
    { slug: 'codex-gpt-5-6-sol', id: 'claude-gpt-5.6-sol[1m]', label: 'GPT-5.6 Sol' },
    { slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra[1m]', label: 'GPT-5.6 Terra' },
  ],
}));
process.env.SIDEQUEST_DISCOVERY_DIRS = DISCOVERY;

const store = require('../lib/store.js');

// A real package.json, because the authoring check refuses an `npm run <script>` verify
// whose script the project does not actually define.
function project(label: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-oracle-empty-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'sq319-fixture', version: '0.0.0', scripts: { test: 'node --version', 'test:files': 'node --version' } }),
  );
  return store.ensureProject(root, label).slug;
}

test('createTicket refuses an explicit command kind with no command, naming the field', () => {
  const slug = project('empty command add');

  for (const executorVerify of [undefined, '', '   ', '\t\n ']) {
    assert.throws(
      () => store.createTicket(slug, {
        title: 'empty command under kind command',
        executorVerifyKind: 'command',
        ...(executorVerify === undefined ? {} : { executorVerify }),
      }),
      (error: Error) => {
        // The refusal has to name the field the caller passed, which is the whole
        // point: SQ-300's orchestrator could not see which field was empty.
        assert.match(error.message, /executorVerifyKind: command requires a runnable executorVerify command/);
        assert.match(error.message, /executorVerify is empty/);
        // and say why it matters, rather than only that it is disallowed.
        assert.match(error.message, /replaced at dispatch by a derived requirement/);
        return true;
      },
      `executorVerify ${JSON.stringify(executorVerify)} must be refused under kind command`,
    );
  }

  // Mixed case and padding are the same declaration, not an escape hatch.
  assert.throws(
    () => store.createTicket(slug, { title: 'padded kind', executorVerifyKind: '  CoMmAnD  ', executorVerify: '' }),
    /executorVerifyKind: command requires a runnable executorVerify command/,
  );
});

test('an omitted verify kind still files a ticket with no command', () => {
  const slug = project('omitted kind stays legal');

  // The kind DEFAULTS to `command`, so refusing every empty command would break the
  // ordinary flow of filing a ticket before its verifier is known. Only an explicit
  // `command` declaration is refused.
  const filed = store.createTicket(slug, { title: 'verify not decided yet' });
  assert.equal(filed.executorVerify, '');
  assert.equal(filed.executorVerifyKind, 'command');

  // A non-command kind needs no command either.
  const manual = store.createTicket(slug, { title: 'manual check', executorVerifyKind: 'manual' });
  assert.equal(manual.executorVerifyKind, 'manual');
});

test('updateTicket refuses clearing the command while the kind stays command', () => {
  const slug = project('empty command update');
  const ticket = store.createTicket(slug, {
    title: 'has a real command',
    executorVerifyKind: 'command',
    executorVerify: 'npm run test',
  });

  // Clearing the command leaves exactly the SQ-300 state, so it is refused the same way.
  assert.throws(
    () => store.updateTicket(slug, ticket.ref, { executorVerify: '' }),
    /executorVerifyKind: command requires a runnable executorVerify command/,
  );
  assert.throws(
    () => store.updateTicket(slug, ticket.ref, { executorVerify: '   ' }),
    /executorVerifyKind: command requires a runnable executorVerify command/,
  );

  // The refusal must not have written anything.
  assert.equal(store.getTicket(slug, ticket.ref).executorVerify, 'npm run test');

  // Declaring a kind that needs no command is the documented way out, and still works.
  const moved = store.updateTicket(slug, ticket.ref, { executorVerify: 'manual: read the rendered page', executorVerifyKind: 'manual' });
  assert.equal(moved.executorVerifyKind, 'manual');

  // Re-pinning a real command is unaffected.
  const repinned = store.updateTicket(slug, ticket.ref, { executorVerify: 'npm run test:files test/mcp.test.ts', executorVerifyKind: 'command' });
  assert.equal(repinned.executorVerify, 'npm run test:files test/mcp.test.ts');
});

test('a ticket whose verify is derived says so in pulse and names the derived command', () => {
  // A ticket with no verify of its own still dispatches: `verificationRequirement` falls
  // through to the plugin's named suite. That substitution was invisible, which is how
  // SQ-300's executor ended up running a full suite its ticket never asked for.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-oracle-derived-'));
  fs.mkdirSync(path.join(root, 'plugins', 'sq319-suite', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'sq319-root', version: '0.0.0' }));
  fs.writeFileSync(
    path.join(root, 'plugins', 'sq319-suite', 'package.json'),
    JSON.stringify({ name: 'sq319-suite', version: '0.0.0', scripts: { 'test:full': 'node --version' } }),
  );
  fs.writeFileSync(path.join(root, 'plugins', 'sq319-suite', 'src', 'thing.ts'), 'export const thing = 1;\n');
  // Dispatch reads a source revision, so the fixture has to be a real repository.
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'SQ-319 Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'seed derived-verify fixture'], { cwd: root });
  const slug = store.ensureProject(root, 'derived verify').slug;
  store.setCategory({
    id: 'sq319.derived',
    name: 'SQ-319 derived verify',
    route: { model: 'sonnet', effort: 'high' },
    fallback: null,
    enabled: true,
  });

  const ticket = store.createTicket(slug, {
    title: 'no verify of its own',
    category: 'sq319.derived',
    files: ['plugins/sq319-suite/src/thing.ts'],
    source: 'test',
  });
  const prepared = store.prepareDispatch(slug, ticket.ref);
  const requirement = prepared.ticket.dispatch.verificationRequirement;

  // The requirement really is the derived suite, not anything the ticket recorded.
  assert.equal(requirement.kind, 'suite');
  assert.match(requirement.command, /npm run test:full/);

  const derivation = prepared.ticket.dispatch.verificationDerivation;
  assert.ok(derivation, 'a derived requirement must record that it was derived');
  assert.equal(derivation.command, requirement.command);
  assert.equal(derivation.suite, 'sq319-suite');
  // The stored kind normalizes an omitted kind to `command`, so the reason must not claim
  // the author declared one; it states only what is actually known.
  assert.match(derivation.reason, /records no executorVerify of its own/);
  assert.equal(derivation.declaredKind, 'command');

  // The dispatch result is the surface the executor itself reads, so the notice has to be
  // there too, not only on the ticket it leaves behind.
  const dispatchWarning = (prepared.warnings || []).find((entry: string) => /DERIVED/.test(entry));
  assert.ok(
    dispatchWarning,
    `the dispatch result must announce the derivation, got ${JSON.stringify(prepared.warnings || [])}`,
  );
  assert.ok(
    dispatchWarning.includes(JSON.stringify(requirement.command)),
    'the dispatch result must name the exact derived command',
  );

  // pulse has to carry it, structured and in `warnings` -- the latter because the default
  // compact pulse keeps only four dispatch fields but passes warnings through.
  const pulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(pulse.dispatch.verificationDerivation.command, requirement.command);
  const warning = (pulse.warnings || []).find((entry: string) => /DERIVED/.test(entry));
  assert.ok(warning, `pulse warnings must announce the derivation, got ${JSON.stringify(pulse.warnings || [])}`);
  assert.ok(warning.includes(JSON.stringify(requirement.command)), 'the warning must quote the exact derived command');

  // Re-pinning a real command clears the notice rather than leaving it describing a
  // superseded gate.
  store.updateTicket(slug, ticket.ref, {
    executorVerify: 'cd plugins/sq319-suite && npm run test:full',
    executorVerifyKind: 'command',
  });
  const repinned = store.pulsePayload(slug, ticket.ref);
  assert.equal(repinned.dispatch.verificationDerivation, null);
  assert.ok(!(repinned.warnings || []).some((entry: string) => /DERIVED/.test(entry)));
});

test('a more specific oracle refusal still wins over the empty-command refusal', () => {
  const slug = project('oracle precedence');

  // kind `attestation` with no artifact is an attestation defect, not a missing command:
  // telling the caller to supply a command they never asked for would be misleading.
  assert.throws(
    () => store.createTicket(slug, { title: 'attestation without artifact', executorVerifyKind: 'attestation' }),
    /verifyKind: attestation requires attestationArtifact/,
  );
});
