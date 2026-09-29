import './_temp-cleanup.js';
// SQ-203 (issue #20): verification_capture_command_mismatch blocked submit while the verify
// command itself passed. The wrapper kept its own dispatch-only pin lookup, so a command it
// let run could be refused by the recorder afterwards, and the CLI printed only the bare
// reason. These tests pin one comparison for both sides and a self-diagnosing refusal.
export {};

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const store = require('../lib/store.js');
const { captureSlotDirectory } = require('../lib/verify-capture.js');
const { verifyCaptureWrapperCommand } = require('../lib/kernel/verification.js');

const SIDEQUEST_DIR = path.resolve(__dirname, '..');

// The verify from issue #20: nested double quotes, a regex brace quantifier and a comma.
const ISSUE_20_COMMAND = `bash -c 'set -e; test -s README.md; grep -qF "bootstrap.sh" README.md; grep -qF "devcontainer" README.md; if grep -qE "sk-ant-oat01-[A-Za-z0-9_-]{20,}" README.md; then echo "FAIL: token-shaped string in README"; exit 1; fi; echo "PASS: README covers bootstrap and devcontainer, no token-shaped strings"'`;

function fixtureProject(prefix: string) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(project, 'README.md'), 'Run bootstrap.sh, or open the devcontainer.\n');
  fs.writeFileSync(path.join(project, 'suite.js'), `require('node:fs').writeFileSync('suite-ran', 'ran');\n`);
  fs.writeFileSync(path.join(project, '.gitignore'), 'suite-ran\n');
  execFileSync('git', ['init', '-b', 'main', '--quiet'], { cwd: project, windowsHide: true });
  execFileSync('git', ['add', '--all'], { cwd: project, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: project, windowsHide: true });
  return project;
}

function cleanup(project: string) {
  fs.rmSync(captureSlotDirectory(project), { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
}

function runWrapper(encoded: string, project: string, ticket: string): Promise<Readonly<{ status: number | null; output: string }>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SIDEQUEST_DIR, 'lib', 'verify-capture.js'), '--base64', encoded, '--project', project, '--ticket', ticket], {
      cwd: project,
      env: process.env,
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (status: number | null) => resolve(Object.freeze({ status, output })));
  });
}

function captures(slug: string, ref: string) {
  return store.getTicket(slug, ref)?.verificationCaptures || [];
}

function dispatchedTicket(project: string, title: string, executorVerify?: string) {
  const board = store.ensureProject(project);
  const ticket = store.createTicket(board.slug, {
    title,
    files: ['README.md'],
    category: 'coding.normal',
    executorVerifyKind: 'command',
    ...(executorVerify === undefined ? {} : { executorVerify }),
  });
  return { slug: board.slug, ref: ticket.ref };
}

test('the issue #20 verify round-trips from the dispatched encoding and records a passed capture', async () => {
  const project = fixtureProject('sq-203-roundtrip-');
  const { slug, ref } = dispatchedTicket(project, 'issue 20 verify round trip', ISSUE_20_COMMAND);
  store.prepareDispatch(slug, ref, { sessionId: 'sq-203-roundtrip', sharedTree: true });
  try {
    const pinned = store.getTicket(slug, ref).dispatch.verificationRequirement.command;
    assert.equal(pinned, ISSUE_20_COMMAND, 'the dispatch pins the verify byte for byte');
    // The same encoder the briefing and the SQ-185 recovery guidance use.
    const encoded = /--base64 (\S+)/.exec(verifyCaptureWrapperCommand(pinned, ref, project))?.[1] || '';
    const { status, output } = await runWrapper(encoded, project, ref);
    assert.equal(status, 0, output);
    assert.match(output, /^verify=passed exit=0$/m);
    const details = /^details=(.+)$/m.exec(output)?.[1] || '';
    assert.match(fs.readFileSync(details, 'utf8'), /PASS: README covers bootstrap and devcontainer/, 'the #20 command itself ran and passed');
    fs.rmSync(details, { force: true });
    assert.match(output, /^capture=(?!unrecorded)\S+ candidate=git:/m);
    const recorded = captures(slug, ref);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].command, ISSUE_20_COMMAND, 'the recorded command is the pin, byte for byte');
  } finally {
    cleanup(project);
  }
});

test('a command the recorder would refuse is refused before it runs, naming both commands (legacy pin)', async () => {
  const project = fixtureProject('sq-203-legacy-pin-');
  // No dispatch: the recorder falls back to the ticket verify, which the wrapper never read.
  const { slug, ref } = dispatchedTicket(project, 'legacy pin divergence', 'node suite.js');
  try {
    const { status, output } = await runWrapper(Buffer.from('node suite.js --other').toString('base64'), project, ref);
    assert.equal(status, 2, output);
    assert.equal(fs.existsSync(path.join(project, 'suite-ran')), false, 'a command the recorder refuses never runs');
    assert.match(output, /verify=failed_check exit=2/);
    assert.match(output, /Pinned command: \\"node suite\.js\\"/);
    assert.match(output, /Captured command: \\"node suite\.js --other\\"/);
    assert.match(output, /capture=unrecorded reason=verification_capture_command_mismatch/);
    assert.deepEqual(captures(slug, ref), [], 'a genuinely different command is still refused');
  } finally {
    cleanup(project);
  }
});

test('a recorder refusal after the run prints its detail, not just the reason', async () => {
  const project = fixtureProject('sq-203-no-pin-');
  const { slug, ref } = dispatchedTicket(project, 'no pinned command');
  try {
    const { status, output } = await runWrapper(Buffer.from('node suite.js').toString('base64'), project, ref);
    assert.equal(status, 2, output);
    assert.match(output, /^verify=passed exit=0/m, 'with no pinned command the run is not preflighted away');
    assert.match(output, /^capture=unrecorded reason=verification_capture_command_mismatch$/m);
    assert.match(output, /^capture-detail=".*No command verifier is pinned for this ticket/m);
    assert.deepEqual(captures(slug, ref), []);
  } finally {
    cleanup(project);
  }
});

test('the recorder preflight is read-only, trims like the recorder, and refuses a different command', () => {
  const project = fixtureProject('sq-203-preflight-');
  const { slug, ref } = dispatchedTicket(project, 'read-only preflight', ISSUE_20_COMMAND);
  store.prepareDispatch(slug, ref, { sessionId: 'sq-203-preflight', sharedTree: true });
  try {
    const accepted = store.recordVerificationCapture(slug, ref, { command: ` ${ISSUE_20_COMMAND}\n`, preflight: true });
    assert.deepEqual({ ok: accepted.ok, preflight: accepted.preflight, command: accepted.command }, { ok: true, preflight: true, command: ISSUE_20_COMMAND });
    const refused = store.recordVerificationCapture(slug, ref, { command: ISSUE_20_COMMAND.replace('{20,}', '{20}'), preflight: true });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'verification_capture_command_mismatch');
    assert.equal(refused.pinnedCommand, ISSUE_20_COMMAND);
    assert.deepEqual(captures(slug, ref), [], 'a preflight writes no capture');
  } finally {
    cleanup(project);
  }
});

test('the mismatch message is bounded and pinpoints the first differing character with escapes visible', () => {
  const project = fixtureProject('sq-203-bounded-');
  const pinned = `node suite.js ${'a'.repeat(900)} end`;
  const { slug, ref } = dispatchedTicket(project, 'bounded mismatch message', pinned);
  store.prepareDispatch(slug, ref, { sessionId: 'sq-203-bounded', sharedTree: true });
  try {
    // A no-break space where the pin has a space, then a long tail.
    const captured = `${pinned.replace(/ end$/, ' end')} ${'z'.repeat(6000)}`;
    const refused = store.recordVerificationCapture(slug, ref, { command: captured, preflight: true });
    assert.equal(refused.reason, 'verification_capture_command_mismatch');
    const message = String(refused.message || '');
    assert.ok(message.length < 4000, `message is bounded (${message.length} characters)`);
    assert.match(message, new RegExp(`First difference at character ${pinned.length - 4} \\(pinned ${pinned.length} characters, captured ${captured.length}\\)`));
    assert.match(message, /pinned \.\.\."a+ end" vs captured \.\.\."a+\\u00a0end z+"\.\.\./);
    assert.match(message, /\(\+\d+ more characters\)/);
    assert.ok(!message.includes(' '), 'the invisible character is escaped, never printed raw');
  } finally {
    cleanup(project);
  }
});
