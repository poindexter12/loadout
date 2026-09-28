import './_temp-cleanup.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const { runVerifyCapture, runCapturedVerification, recordCapture, shellCommand, captureSlotDirectory, acquireCaptureSlot, fullSuiteCaptureTimeoutMilliseconds, captureBudget, captureBudgetClass, captureHardMaximumMilliseconds, runBudgetedCapture } = require('../lib/verify-capture.js');
const store = require('../lib/store.js');
const SIDEQUEST_DIR = path.resolve(__dirname, '..');

function deleteLog(capture: { logPath: string }) {
  fs.rmSync(capture.logPath, { force: true });
}

function nodeCommand(scriptPath: string, argument: string) {
  return `"${process.execPath}" "${scriptPath}" "${argument}"`;
}

function runCaptureProcess(command: string, project: string, ticket: string): Promise<Readonly<{ status: number | null; output: string }>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SIDEQUEST_DIR, 'lib', 'verify-capture.js'), '--base64', Buffer.from(command).toString('base64'), '--project', project, '--ticket', ticket], {
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

// SQ-58 scaled the identical wait in hooks.test.ts and this copy was never reached. 100
// attempts at 20ms is a fixed 2000ms deadline for a spawned child to write a sentinel, and
// SQ-62's 29-minute full-suite measurement failed exactly here: at concurrency 8 on a
// 10-core machine holding ~2.2 workers of real capacity, a node spawn plus a file write does
// not reliably land inside 2 seconds. The deadline has to scale with the workers competing
// for the machine, which is what SQ-58 established.
const WAIT_FOR_FILE_PER_TEST_WORKER_MS = 2_000;

function testWorkerConcurrency(): number {
  const argument = process.execArgv.find((value: string) => value.startsWith('--test-concurrency='));
  const requested = Number(argument?.slice('--test-concurrency='.length));
  return Number.isInteger(requested) && requested > 0 ? requested : os.availableParallelism();
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + WAIT_FOR_FILE_PER_TEST_WORKER_MS * testWorkerConcurrency();
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function readRecordedCaptures(project: string, ticket: string) {
  const reader = `const store = require(${JSON.stringify(path.join(SIDEQUEST_DIR, 'lib', 'store.js'))}); const target = store.findProject(process.argv.at(-2)); console.log(JSON.stringify(store.getTicket(target.slug, process.argv.at(-1)).verificationCaptures));`;
  return JSON.parse(execFileSync(process.execPath, ['--eval', reader, project, ticket], { encoding: 'utf8', env: process.env, windowsHide: true }));
}

test('full-suite capture uses the capacity phase budget plus ordinary setup allowance', () => {
  const originalOverride = process.env.SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS;
  process.env.SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS = '5000000';
  try {
    assert.equal(fullSuiteCaptureTimeoutMilliseconds(8, 0, ''), 1_320_000);
    assert.equal(fullSuiteCaptureTimeoutMilliseconds(10, 27, ''), 3_000_000);
    assert.equal(fullSuiteCaptureTimeoutMilliseconds(8, 0, '5000000'), 5_600_000);
    assert.equal(fullSuiteCaptureTimeoutMilliseconds(8, 0, '1'), 1_320_000);
  } finally {
    if (originalOverride === undefined) delete process.env.SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS;
    else process.env.SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS = originalOverride;
  }
});

// SQ-169: only `npm run test:full` got a capacity-derived budget, so a scoped `node --test`
// verify (SQ-45's `node --test scripts/release/test`, SQ-128's 1047s run) died at a fixed
// 600000ms however often it was retried.
test('SQ-169: any node --test command or npm test script is classified for the extended budget', () => {
  const testSuites = [
    'node --test scripts/release/test',
    'cd plugins/sidequest && npm run typecheck && node --import tsx --import ./test/_sidequest-test-home.ts --test test/hooks.test.ts',
    '/usr/local/bin/node --test test/a.test.js',
    `"${process.execPath}" --test test`,
    'npm test',
    'npm t',
    'npm run test',
    'npm run test:files -- test/verify-capture.test.ts',
    'npm --prefix plugins/sidequest test',
    'npm run lint && npm test',
  ];
  for (const command of testSuites) assert.equal(captureBudgetClass(command), 'test-suite', command);
  assert.equal(captureBudgetClass('npm run test:full'), 'full-suite');
  assert.equal(captureBudgetClass('cd plugins/sidequest && npm run test:full'), 'full-suite');
  for (const command of ['npm run check', 'npm run typecheck', 'node scripts/build.mjs', 'node --test-reporter=spec x.js', 'git diff --check']) {
    assert.equal(captureBudgetClass(command), 'command', command);
  }
});

test('SQ-169: a test-suite capture gets the capacity budget; other commands keep the setup allowance', () => {
  const quiet = captureBudget('node --test scripts/release/test', 8, 0, '');
  assert.equal(quiet.budgetClass, 'test-suite');
  assert.equal(quiet.timeoutMilliseconds, 1_320_000);
  assert.equal(quiet.setupAllowanceMilliseconds, 600_000);
  assert.equal(quiet.phaseBudgetMilliseconds, 720_000);
  const loaded = captureBudget('node --test scripts/release/test', 10, 27, '');
  assert.equal(loaded.timeoutMilliseconds, 3_000_000);
  assert.ok(loaded.timeoutMilliseconds > 1_047_000, 'the loaded budget covers the 1047s scoped run SQ-128 measured');
  assert.equal(loaded.loadAverage, 27);
  assert.equal(loaded.availableParallelism, 10);
  const plain = captureBudget('npm run check', 10, 27, '');
  assert.deepEqual({ budgetClass: plain.budgetClass, timeout: plain.timeoutMilliseconds, phase: plain.phaseBudgetMilliseconds }, { budgetClass: 'command', timeout: 600_000, phase: 0 });
  const widened = captureBudget('npm run check', 10, 27, '1200000');
  assert.equal(widened.timeoutMilliseconds, 1_800_000);
  assert.equal(widened.overrideMilliseconds, 1_200_000);
  assert.match(widened.notice, /SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS raised the phase budget from a measured 0ms to 1200000ms/);
  assert.match(captureBudget('node --test x', 8, 0, 'abc').notice, /is not a positive whole number of milliseconds/);
  assert.match(captureBudget('node --test x', 8, 0, '1').notice, /cannot shorten the measured 720000ms phase budget/);
  assert.equal(captureBudget('node --test x', 8, 0, '1').timeoutMilliseconds, 1_320_000);
});

test('SQ-169: the widen-only override is bounded by a hard maximum so a hung run cannot hold the slot forever', () => {
  // Base returned 1_000_599_999 here: setup allowance plus whatever the override asked for.
  assert.equal(fullSuiteCaptureTimeoutMilliseconds(8, 0, '999999999'), 7_200_000);
  assert.equal(captureHardMaximumMilliseconds, 7_200_000);
  const clamped = captureBudget('npm run test:full', 8, 0, '999999999');
  assert.equal(clamped.timeoutMilliseconds, 7_200_000);
  assert.equal(clamped.clampedToHardMaximum, true);
  assert.match(clamped.notice, /above the 7200000ms hard maximum, so the capture stops at 7200000ms/);
  const underMaximum = captureBudget('npm run test:full', 8, 0, '6600000');
  assert.equal(underMaximum.timeoutMilliseconds, 7_200_000);
  assert.equal(underMaximum.clampedToHardMaximum, false);
  assert.equal(captureBudget('node --test x', 8, 0, '999999999').timeoutMilliseconds, 7_200_000);
});

test('SQ-169: a capture budget timeout reports elapsed time, the budget, the load and the lever', { skip: process.platform === 'win32' }, async () => {
  const measured = captureBudget('node --test scripts/release/test', 8, 0, '');
  const atMaximum = captureBudget('npm run test:full', 8, 0, '999999999');
  const cases = [
    { budget: Object.freeze({ ...measured, timeoutMilliseconds: 1500 }), lever: /rerun the same wrapper with SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS=<milliseconds> above 720000 in its environment/ },
    { budget: Object.freeze({ ...atMaximum, timeoutMilliseconds: 1500 }), lever: /already at the 7200000ms hard maximum, so no override can raise it: ask the orchestrator to re-pin a narrower verify command/ },
  ];
  for (const { budget, lever } of cases) {
    const capture = await runBudgetedCapture('printf partial-output; sleep 30', process.cwd(), budget);
    try {
      assert.deepStrictEqual({ status: capture.status, exitCode: capture.exitCode }, { status: 'timeout', exitCode: 2 });
      assert.ok(capture.elapsedMilliseconds >= 1500, `elapsed ${capture.elapsedMilliseconds}ms`);
      assert.match(capture.reason, new RegExp(`^capture_budget_exceeded: the verify command ran ${capture.elapsedMilliseconds}ms and was stopped at its 1500ms capture budget\\. This is a budget verdict, not a test failure`));
      assert.match(capture.reason, new RegExp(`${budget.budgetClass} class`));
      assert.match(capture.reason, new RegExp(`600000ms setup allowance \\+ ${budget.phaseBudgetMilliseconds}ms phase budget`));
      assert.match(capture.reason, /capped at the 7200000ms hard maximum; derived at 8 available cores and a 1-minute load average of 0\.00 \(8\.00 effective test workers\)/);
      assert.match(capture.reason, /the load average was \d+\.\d\d at the deadline/);
      assert.match(capture.reason, lever);
      assert.match(capture.reason, /Verification timed out after 1500ms; partial output captured\./, 'the process port reason is kept');
      assert.equal(capture.evidence, capture.reason);
      assert.equal(capture.budget, budget);
      const log = fs.readFileSync(capture.logPath, 'utf8');
      assert.match(log, /partial-output/);
      assert.match(log, new RegExp(`\\[sidequest\\] Verification capture budget: 1500ms, ${budget.budgetClass} class .* Elapsed ${capture.elapsedMilliseconds}ms\\.`));
    } finally {
      deleteLog(capture);
    }
  }
});

test('SQ-169: an npm test capture runs under the extended budget and carries it on the result', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-169-npm-test-'));
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { test: 'node ok.js' } }));
  fs.writeFileSync(path.join(project, 'ok.js'), 'process.stdout.write("scoped-tests-ok\\n");\n');
  try {
    const { capture, recorded } = await runCapturedVerification('npm test', null, project);
    assert.equal(capture.status, 'passed', capture.evidence);
    assert.equal(recorded, null);
    assert.equal(capture.budget?.budgetClass, 'test-suite');
    assert.ok(capture.budget.timeoutMilliseconds > 600_000, `budget ${capture.budget.timeoutMilliseconds}ms`);
    assert.ok(Number.isInteger(capture.elapsedMilliseconds) && capture.elapsedMilliseconds >= 0);
    const log = fs.readFileSync(capture.logPath, 'utf8');
    assert.match(log, /scoped-tests-ok/);
    assert.match(log, new RegExp(`\\[sidequest\\] Verification capture budget: ${capture.budget.timeoutMilliseconds}ms, test-suite class`));
    deleteLog(capture);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('SQ-169: a full-suite capture that exceeds its budget is stopped, reported, and releases the slot', { skip: process.platform === 'win32' }, async () => {
  const started = 'suite-started';
  const project = captureFixtureProject('sq-169-full-suite-budget-', `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'started'); setTimeout(() => {}, 10000);\n`);
  const boardProject = store.ensureProject(project);
  const ticket = store.createTicket(boardProject.slug, {
    title: 'full-suite capture stops at its budget',
    executorVerifyKind: 'command',
    executorVerify: 'npm run test:full',
  });
  const announced: string[] = [];
  try {
    const { capture } = await runCapturedVerification('npm run test:full', { project, ticket: ticket.ref }, project, fs, {
      resolveBudget: (command: string) => Object.freeze({ ...captureBudget(command, 8, 0, ''), timeoutMilliseconds: 1500 }),
      announce: (line: string) => announced.push(line),
    });
    assert.equal(capture.status, 'timeout', capture.evidence);
    assert.equal(capture.budget?.budgetClass, 'full-suite');
    assert.equal(capture.queuePosition, 1);
    assert.match(capture.reason, /^capture_budget_exceeded: the verify command ran \d+ms and was stopped at its 1500ms capture budget\./);
    assert.match(capture.reason, /full-suite class \(the npm run test:full suite, serialized per host\)/);
    assert.match(announced.join('\n'), /^verify-capture: capture budget 1500ms, full-suite class/);
    assert.equal(fs.existsSync(path.join(captureSlotDirectory(project), 'active')), false, 'the per-host slot is released after a budget timeout');
    fs.rmSync(capture.logPath, { force: true });
  } finally {
    fs.rmSync(captureSlotDirectory(project), { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('SQ-169: the wrapper announces the budget before the run and reports it after', () => {
  const environment = { ...process.env };
  delete environment.SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS;
  const command = `"${process.execPath}" -e "process.exit(0)"`;
  const result = require('node:child_process').spawnSync(process.execPath, [path.join(SIDEQUEST_DIR, 'lib', 'verify-capture.js'), '--base64', Buffer.from(command).toString('base64')], {
    encoding: 'utf8',
    env: environment,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /^verify-capture: capture budget 600000ms, command class \(not a recognized test runner/m);
  assert.match(result.stdout, /^capture-budget class=command budgetMs=600000 elapsedMs=\d+ setupMs=600000 phaseMs=0 measuredPhaseMs=0 hardMaxMs=7200000 cores=\d+ load=\d+\.\d\d effectiveWorkers=\d+\.\d\d$/m);
  const details = /^details=(.*)$/m.exec(result.stdout)?.[1];
  if (details) fs.rmSync(details, { force: true });
});

test('full-suite capture serializes sibling captures and records the queue wait', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-capture-slot-'));
  const started = path.join(project, 'started');
  const observedSiblingCaptures = path.join(project, 'observed-sibling-captures');
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { 'test:full': 'node blocker.js' } }));
  fs.writeFileSync(path.join(project, 'blocker.js'), `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(started)}, 'started'); fs.appendFileSync(${JSON.stringify(observedSiblingCaptures)}, process.env.SIDEQUEST_FULL_SUITE_SIBLING_CAPTURE_COUNT + '\\n'); setTimeout(() => {}, 700);`);
  execFileSync('git', ['init', '-b', 'main', '--quiet'], { cwd: project, windowsHide: true });
  execFileSync('git', ['add', '--all'], { cwd: project, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: project, windowsHide: true });
  const boardProject = store.ensureProject(project);
  const ticket = store.createTicket(boardProject.slug, {
    title: 'serialize full-suite verification captures',
    executorVerifyKind: 'command',
    executorVerify: 'npm run test:full',
  });

  try {
    const first = runCaptureProcess('npm run test:full', project, ticket.ref);
    await waitForFile(started);
    const second = runCaptureProcess('npm run test:full', project, ticket.ref);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(firstResult.status, 0, firstResult.output);
    assert.equal(secondResult.status, 0, secondResult.output);
    assert.deepEqual(fs.readFileSync(observedSiblingCaptures, 'utf8').trim().split(/\r?\n/).sort(), ['0', '1']);
    assert.match(secondResult.output, /waiting for 1 sibling capture to finish \(queue position 2\)/);
    const captures = readRecordedCaptures(project, ticket.ref);
    const waitedCapture = captures.find((capture: { queuePosition?: number }) => capture.queuePosition === 2);
    assert.ok(waitedCapture, 'the second capture records its slot queue position');
    assert.equal(waitedCapture.queuePosition, 2);
    assert.ok(Number.isInteger(waitedCapture.waitedForSlotMs) && waitedCapture.waitedForSlotMs > 0, `waited ${waitedCapture.waitedForSlotMs}ms`);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('SQ-179: a recorded failed_suite capture names the orchestrator capture waiver; a passing capture does not', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-capture-waiver-'));
  fs.writeFileSync(path.join(project, 'check.js'), 'process.exit(Number(process.argv[2]));');
  execFileSync('git', ['init', '-b', 'main', '--quiet'], { cwd: project, windowsHide: true });
  execFileSync('git', ['add', '--all'], { cwd: project, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: project, windowsHide: true });
  const boardProject = store.ensureProject(project);
  const failing = nodeCommand(path.join(project, 'check.js'), '1');
  const passing = nodeCommand(path.join(project, 'check.js'), '0');
  const failTicket = store.createTicket(boardProject.slug, { title: 'load-only capture failure', executorVerifyKind: 'command', executorVerify: failing });
  const passTicket = store.createTicket(boardProject.slug, { title: 'passing capture', executorVerifyKind: 'command', executorVerify: passing });
  const logs: string[] = [];

  try {
    const failed = await runCaptureProcess(failing, project, failTicket.ref);
    logs.push(/^details=(.*)$/m.exec(failed.output)?.[1] || '');
    const recorded = readRecordedCaptures(project, failTicket.ref).at(-1);
    assert.deepEqual({ status: recorded.status, exitCode: recorded.exitCode }, { status: 'failed_suite', exitCode: 1 }, failed.output);
    assert.match(failed.output, /^capture-waiver: if this failed_suite came only from host load and reruns keep failing, do not hand-edit refs\/sidequest;/m);
    assert.ok(failed.output.includes(`"[sidequest:capture-waiver] capture=${recorded.id} signature=failed_suite:exit-1 authority=<who>; <reason and evidence>" on ${failTicket.ref}, then resubmit this same candidate.`), failed.output);

    const passed = await runCaptureProcess(passing, project, passTicket.ref);
    logs.push(/^details=(.*)$/m.exec(passed.output)?.[1] || '');
    assert.equal(passed.status, 0, passed.output);
    assert.match(passed.output, /^capture=\S+ candidate=git:/m);
    assert.doesNotMatch(passed.output, /capture-waiver/);
  } finally {
    for (const log of logs.filter(Boolean)) fs.rmSync(log, { force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('full-suite capture reaps a dead active lease before acquiring', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-capture-dead-active-'));
  const slotDirectory = captureSlotDirectory(project);
  const activeDirectory = path.join(slotDirectory, 'active');
  fs.mkdirSync(activeDirectory, { recursive: true });
  fs.writeFileSync(path.join(activeDirectory, 'owner.json'), JSON.stringify({ pid: 12345, startedAt: 1 }));

  try {
    const slot = await acquireCaptureSlot(project, 100, fs, { isAlive: () => false });
    assert.ok('release' in slot, 'a dead active lease does not block acquisition');
    if ('release' in slot) assert.equal(await slot.release(), null);
  } finally {
    fs.rmSync(slotDirectory, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('full-suite capture reaps a dead queued waiter ahead of itself', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-capture-dead-waiter-'));
  const slotDirectory = captureSlotDirectory(project);
  const deadWaiter = path.join(slotDirectory, 'waiting', '000000000000000-12345-dead.json');
  fs.mkdirSync(path.dirname(deadWaiter), { recursive: true });
  fs.writeFileSync(deadWaiter, JSON.stringify({ pid: 12345, startedAt: 1 }));

  try {
    const slot = await acquireCaptureSlot(project, 100, fs, { isAlive: () => false });
    assert.ok('release' in slot, 'a dead waiter does not retain queue priority');
    assert.equal(fs.existsSync(deadWaiter), false, 'the dead waiter is removed');
    if ('release' in slot) assert.equal(await slot.release(), null);
  } finally {
    fs.rmSync(slotDirectory, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('full-suite capture never reaps a live lease', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-capture-live-active-'));
  const slotDirectory = captureSlotDirectory(project);
  const activeDirectory = path.join(slotDirectory, 'active');
  const ownerPath = path.join(activeDirectory, 'owner.json');
  fs.mkdirSync(activeDirectory, { recursive: true });
  fs.writeFileSync(ownerPath, JSON.stringify({ pid: 12345, startedAt: 1 }));

  try {
    const slot = await acquireCaptureSlot(project, 0, fs, { isAlive: () => true });
    assert.ok('reason' in slot, 'a live lease keeps the caller queued');
    assert.equal(fs.existsSync(activeDirectory), true, 'the live active lease remains');
    assert.equal(fs.readFileSync(ownerPath, 'utf8'), JSON.stringify({ pid: 12345, startedAt: 1 }));
  } finally {
    fs.rmSync(slotDirectory, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('full-suite capture retries EPERM while a sibling releases its slot', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-capture-eperm-'));
  const observedSiblingCaptures = path.join(project, 'observed-sibling-captures');
  const slotDirectory = captureSlotDirectory(project);
  const activeDirectory = path.join(slotDirectory, 'active');
  const siblingTombstoneDirectory = `${activeDirectory}.sibling-release`;
  let releaseTimer: NodeJS.Timeout | undefined;

  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { 'test:full': 'node blocker.js' } }));
  fs.writeFileSync(path.join(project, 'blocker.js'), `require('node:fs').writeFileSync(${JSON.stringify(observedSiblingCaptures)}, process.env.SIDEQUEST_FULL_SUITE_SIBLING_CAPTURE_COUNT);`);
  execFileSync('git', ['init', '-b', 'main', '--quiet'], { cwd: project, windowsHide: true });
  execFileSync('git', ['add', '--all'], { cwd: project, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: project, windowsHide: true });
  const boardProject = store.ensureProject(project);
  const ticket = store.createTicket(boardProject.slug, {
    title: 'retry full-suite capture while a sibling releases',
    executorVerifyKind: 'command',
    executorVerify: 'npm run test:full',
  });
  fs.mkdirSync(activeDirectory, { recursive: true });

  let activeMkdirAttempts = 0;
  const fileSystem = Object.create(fs);
  fileSystem.mkdirSync = (directory: string, options?: unknown) => {
    if (directory === activeDirectory) {
      activeMkdirAttempts += 1;
      if (activeMkdirAttempts === 1) throw Object.assign(new Error('active directory is changing'), { code: 'EPERM' });
    }
    return fs.mkdirSync(directory, options);
  };

  try {
    releaseTimer = setTimeout(() => {
      fs.renameSync(activeDirectory, siblingTombstoneDirectory);
      fs.rmSync(siblingTombstoneDirectory, { recursive: true, force: true });
    }, 50);
    const { capture, recorded } = await runCapturedVerification('npm run test:full', { project, ticket: ticket.ref }, project, fileSystem);

    assert.deepEqual({ status: capture.status, exitCode: capture.exitCode }, { status: 'passed', exitCode: 0 });
    assert.equal(activeMkdirAttempts, 2);
    assert.equal(capture.queuePosition, 2);
    assert.ok(capture.waitedForSlotMs >= 50, `waited ${capture.waitedForSlotMs}ms`);
    assert.equal(fs.readFileSync(observedSiblingCaptures, 'utf8'), '1');
    assert.ok(recorded?.ok, recorded?.reason);
    const recordedWait = readRecordedCaptures(project, ticket.ref).find((entry: { queuePosition?: number }) => entry.queuePosition === 2);
    assert.ok(recordedWait, 'the EPERM-retried capture records its slot queue position');
  } finally {
    if (releaseTimer) clearTimeout(releaseTimer);
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(slotDirectory, { recursive: true, force: true });
  }
});

test('verify capture runs generated POSIX scripts through the host shell', () => {
  const shell = shellCommand('verify-script.sh', 'linux');
  assert.deepStrictEqual(shell.arguments, ['verify-script.sh']);
});

test('verify capture executes through the shared process port and preserves result classes', async () => {
  const passed = await runVerifyCapture('cd . && echo verify-capture-ran');
  try {
    assert.deepStrictEqual({ status: passed.status, exitCode: passed.exitCode }, { status: 'passed', exitCode: 0 });
    assert.match(fs.readFileSync(passed.logPath, 'utf8'), /verify-capture-ran/);
  } finally {
    deleteLog(passed);
  }

  const failed = await runVerifyCapture('exit 7');
  try {
    assert.deepStrictEqual({ status: failed.status, exitCode: failed.exitCode }, { status: 'failed_suite', exitCode: 7 });
  } finally {
    deleteLog(failed);
  }

  const missingCommand = `sidequest-missing-command-${process.pid}-${Date.now()}`;
  const unavailableCommand = await runVerifyCapture(missingCommand);
  try {
    assert.equal(unavailableCommand.status, 'toolchain_missing');
    assert.notEqual(unavailableCommand.exitCode, 0);
    assert.match(unavailableCommand.reason || '', new RegExp(missingCommand));
  } finally {
    deleteLog(unavailableCommand);
  }

  const shellEnvironment = process.platform === 'win32' ? 'ComSpec' : 'SHELL';
  const originalShell = process.env[shellEnvironment];
  const originalPath = process.env.PATH;
  const originalPathAlias = process.env.Path;
  const originalProgramFiles = [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']];
  const missingShell = path.join(os.tmpdir(), 'sidequest-missing-capture-shell');
  process.env[shellEnvironment] = missingShell;
  if (process.platform === 'win32') {
    process.env.ProgramW6432 = missingShell;
    process.env.ProgramFiles = missingShell;
    process.env['ProgramFiles(x86)'] = missingShell;
    process.env.Path = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    process.env.PATH = process.env.Path;
  }
  try {
    const unavailable = await runVerifyCapture('echo unreachable');
    try {
      assert.equal(unavailable.status, 'could_not_run');
      assert.equal(unavailable.exitCode, 2);
    } finally {
      deleteLog(unavailable);
    }
    if (process.platform === 'win32') {
      process.env.ComSpec = originalShell || 'cmd.exe';
      const syntaxFailure = await runVerifyCapture('cd . && ! grep -q zzz README.md', SIDEQUEST_DIR);
      try {
        assert.deepStrictEqual({ status: syntaxFailure.status, exitCode: syntaxFailure.exitCode }, { status: 'could_not_run', exitCode: 1 });
        assert.match(syntaxFailure.reason || '', /could not parse POSIX syntax/);
        assert.match(syntaxFailure.shell || '', /Command Prompt/i);
      } finally {
        deleteLog(syntaxFailure);
      }
    }
  } finally {
    if (originalShell === undefined) delete process.env[shellEnvironment];
    else process.env[shellEnvironment] = originalShell;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalPathAlias === undefined) delete process.env.Path;
    else process.env.Path = originalPathAlias;
    for (const [name, value] of [['ProgramW6432', originalProgramFiles[0]], ['ProgramFiles', originalProgramFiles[1]], ['ProgramFiles(x86)', originalProgramFiles[2]]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('verify capture returns after a Windows batch command', { skip: process.platform !== 'win32' }, async () => {
  const capture = await runVerifyCapture('npm --version');
  try {
    assert.deepStrictEqual({ status: capture.status, exitCode: capture.exitCode }, { status: 'passed', exitCode: 0 });
    assert.match(fs.readFileSync(capture.logPath, 'utf8'), /\d+\.\d+\.\d+/);
  } finally {
    deleteLog(capture);
  }
});

test('verify capture runs POSIX syntax through a POSIX shell on Windows', { skip: process.platform !== 'win32' }, async () => {
  const capture = await runVerifyCapture('cd . && ! grep -q zzz README.md', SIDEQUEST_DIR);
  try {
    assert.deepStrictEqual({ status: capture.status, exitCode: capture.exitCode }, { status: 'passed', exitCode: 0 });
    assert.match(capture.shell || '', /POSIX shell/i);
    assert.match(fs.readFileSync(capture.logPath, 'utf8'), /__SIDEQUEST_VERIFY_EXIT__=0/);
  } finally {
    deleteLog(capture);
  }
});

test('verify capture returns a timeout with partial output', async () => {
  const slowCommand = process.platform === 'win32'
    ? 'echo partial-output && ping -n 30 127.0.0.1'
    : 'printf partial-output; sleep 30';
  // The child has to get its first write through the pipe before the deadline kills it, so this bound is
  // racing process startup, not measuring anything. At 100ms the echo lost that race under full-gate load
  // and the log came back empty on unchanged code, the same way the tuned bounds in SQ-2179 and SQ-2191
  // did. Two seconds is still nowhere near the 30s the command would otherwise run for, so the timeout
  // path is exactly as covered as before.
  const timeoutMilliseconds = 2000;
  const capture = await runVerifyCapture(slowCommand, process.cwd(), timeoutMilliseconds);
  try {
    assert.deepStrictEqual(
      { status: capture.status, exitCode: capture.exitCode },
      { status: 'timeout', exitCode: 2 },
    );
    assert.ok(
      capture.reason.startsWith(`Verification timed out after ${timeoutMilliseconds}ms; partial output captured.`),
      capture.reason,
    );
    assert.match(fs.readFileSync(capture.logPath, 'utf8'), /partial-output/);
  } finally {
    deleteLog(capture);
  }
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

// SQ-124: spawnSync's timeout only signalled the shell, so a verify command's own children (per-file
// `node --test` runners in the field) kept running and starved the next verification. Both the executor
// capture path and the merged-tree integration path (store/submissions.ts) reach runProcessVerification,
// so each entry point is exercised with a long-sleeping grandchild that must not survive the timeout.
test('verify timeout kills the whole process tree, not just the shell', { skip: process.platform === 'win32' }, async () => {
  const { runProcessVerification } = require('../lib/ports/process.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidequest-verify-tree-'));
  const entryPoints: Record<string, (command: string) => Promise<{ status: string; reason?: string; evidence?: string; logPath: string }>> = {
    'executor verify capture': (command) => runVerifyCapture(command, directory, 1500),
    'integration verify port': async (command) => runProcessVerification(
      { kind: 'command', command, evidenceContract: 'command output' },
      { cwd: directory, timeoutMilliseconds: 1500, logPath: path.join(directory, 'integration-verify.log') },
    ),
  };
  const survivors: number[] = [];
  try {
    for (const [label, run] of Object.entries(entryPoints)) {
      const pidFile = path.join(directory, `${label.replace(/\s+/g, '-')}.pid`);
      const result = await run(`sh -c 'sleep 300 & echo $! > "${pidFile}"; wait'`);
      const grandchild = Number(fs.readFileSync(pidFile, 'utf8').trim());
      assert.ok(Number.isInteger(grandchild) && grandchild > 1, `${label}: grandchild pid recorded`);
      const alive = processAlive(grandchild);
      if (alive) survivors.push(grandchild);
      assert.equal(result.status, 'timeout', label);
      assert.equal(alive, false, `${label}: grandchild ${grandchild} survived the verification timeout`);
      assert.match(result.reason ?? result.evidence ?? '', /Killed process group \d+ \(SIGTERM[^)]*\); no descendants survived\./, label);
      assert.match(fs.readFileSync(result.logPath, 'utf8'), /\[sidequest\] Verification timed out\. Killed process group \d+ /, `${label}: log records the tree kill`);
      fs.rmSync(result.logPath, { force: true });
    }
  } finally {
    for (const pid of survivors) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('verify capture preserves quoted absolute paths in verify commands', async () => {
  const scriptPath = path.join(os.tmpdir(), `sidequest quoted ${Date.now()}.js`);
  fs.writeFileSync(scriptPath, 'process.stdout.write(process.argv[2] + \'\\n\');\n', 'utf8');
  const capture = await runVerifyCapture(nodeCommand(scriptPath, scriptPath));
  try {
    assert.deepStrictEqual({ status: capture.status, exitCode: capture.exitCode }, { status: 'passed', exitCode: 0 });
    assert.match(fs.readFileSync(capture.logPath, 'utf8'), new RegExp(scriptPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    fs.rmSync(scriptPath, { force: true });
    deleteLog(capture);
  }
});

// SQ-70 / issue #18: a re-dispatched executor inherits the worktree a retired
// agent left behind, and the capture it records at the very end of the run must
// still find the board the ticket was dispatched from.
function captureFixtureProject(prefix: string, suiteBody: string) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { 'test:full': 'node suite.js' } }));
  fs.writeFileSync(path.join(project, 'suite.js'), suiteBody);
  execFileSync('git', ['init', '-b', 'main', '--quiet'], { cwd: project, windowsHide: true });
  execFileSync('git', ['add', '--all'], { cwd: project, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: project, windowsHide: true });
  return project;
}

function syntheticPassedCapture(command: string) {
  return Object.freeze({ command, status: 'passed', logPath: null, exitCode: 0, shell: 'test' });
}

test('verification capture refuses a mismatched pinned command before spawning the suite', async () => {
  const project = captureFixtureProject('sq-capture-command-preflight-', `const fs = require('node:fs'); fs.writeFileSync('suite-ran', 'unexpected');`);
  const boardProject = store.ensureProject(project);
  const ticket = store.createTicket(boardProject.slug, {
    title: 'refuse mismatched command before running the suite',
    files: ['suite.js'],
    category: 'coding.normal',
    executorVerifyKind: 'command',
    executorVerify: 'npm run test:full',
  });
  store.prepareDispatch(boardProject.slug, ticket.ref, {
    sessionId: 'mismatched-command-preflight',
    sharedTree: true,
  });

  try {
    const capturedCommand = 'npm run test:full --unexpected';
    const { capture, recorded } = await runCapturedVerification(capturedCommand, { project, ticket: ticket.ref }, project);
    assert.deepEqual({ status: capture.status, exitCode: capture.exitCode }, { status: 'failed_check', exitCode: 2 });
    assert.match(capture.reason || '', /matched verbatim and expected to run from the worktree root/);
    assert.match(capture.reason || '', /Pinned command: "npm run test:full"/);
    assert.match(capture.reason || '', /Captured command: "npm run test:full --unexpected"/);
    assert.equal(fs.existsSync(path.join(project, 'suite-ran')), false, 'the mismatched command never spawns the suite');
    assert.equal(recorded?.reason, 'verification_capture_command_mismatch');
    assert.match(recorded?.message || '', /matched verbatim and expected to run from the worktree root/);
    assert.match(recorded?.message || '', /Pinned command: "npm run test:full"/);
    assert.match(recorded?.message || '', /Captured command: "npm run test:full --unexpected"/);
  } finally {
    fs.rmSync(captureSlotDirectory(project), { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('verification capture resolves a stale worktree --project back to the ticket registered board', async () => {
  const project = captureFixtureProject('sq-capture-inherited-project-', 'process.exit(0);\n');
  const worktreeParent = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-capture-inherited-worktrees-'));
  const agentWorktree = path.join(worktreeParent, 'agent-a340a4f9a8a0e4a15');
  const observedSlot = path.join(worktreeParent, 'observed-slot');
  execFileSync('git', ['worktree', 'add', '--detach', '--quiet', agentWorktree, 'HEAD'], { cwd: project, windowsHide: true });
  const registeredActiveSlot = path.join(captureSlotDirectory(project), 'active');
  fs.writeFileSync(path.join(agentWorktree, 'suite.js'), `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(observedSlot)}, String(fs.existsSync(${JSON.stringify(registeredActiveSlot)})));\n`);
  const boardProject = store.ensureProject(project);
  const ticket = store.createTicket(boardProject.slug, {
    title: 'resolve the board from the ticket, not the inherited worktree',
    executorVerifyKind: 'command',
    executorVerify: 'npm run test:full',
  });

  try {
    // The inherited worktree hashes to its own slot namespace, so the assertion
    // below is load-bearing rather than incidentally true.
    assert.notEqual(captureSlotDirectory(agentWorktree), captureSlotDirectory(project));
    // The executor's --project carries the worktree it stands in, not the board path.
    const { capture, recorded } = await runCapturedVerification('npm run test:full', { project: agentWorktree, ticket: ticket.ref }, agentWorktree);
    try {
      assert.equal(capture.status, 'passed', capture.evidence);
      assert.equal(recorded?.ok, true, recorded?.reason);
      assert.equal(recorded?.capture?.candidate.source, 'git');
      assert.equal(fs.readFileSync(observedSlot, 'utf8'), 'true', 'the full-suite slot is held in the registered project namespace');
      const recordedCaptures = store.getTicket(boardProject.slug, ticket.ref).verificationCaptures;
      assert.ok(recordedCaptures.some((entry: { id: string }) => entry.id === recorded?.capture?.id), 'the capture lands on the ticket registered board');
    } finally {
      fs.rmSync(capture.logPath, { force: true });
    }
  } finally {
    fs.rmSync(captureSlotDirectory(project), { recursive: true, force: true });
    fs.rmSync(worktreeParent, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

// SQ-162 fixture: a board project whose ticket was dispatched to an isolated
// linked worktree, the shape `isolation: worktree` executors run under.
function isolatedCaptureFixture(prefix: string, options: { bind?: boolean } = {}) {
  const suite = `require('node:fs').writeFileSync('suite-ran', process.cwd());\n`;
  const project = captureFixtureProject(prefix, suite);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { 'test:full': 'node suite.js', check: 'node suite.js' } }));
  execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '-am', 'check script'], { cwd: project, windowsHide: true });
  const worktreeParent = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}worktrees-`));
  const worktree = path.join(worktreeParent, 'agent-isolated');
  execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'agent-isolated', worktree, 'HEAD'], { cwd: project, windowsHide: true });
  fs.appendFileSync(path.join(worktree, 'suite.js'), '// candidate change\n');
  execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '-am', 'candidate'], { cwd: worktree, windowsHide: true });
  const git = (cwd: string, args: string[]) => String(execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })).trim();
  const boardProject = store.ensureProject(project);
  const created = store.createTicket(boardProject.slug, {
    title: 'capture binds to the dispatched isolated worktree',
    files: ['suite.js'],
    category: 'coding.normal',
    executorVerifyKind: 'command',
    executorVerify: 'npm run check',
  });
  const sessionId = `${prefix}session-${Date.now()}`;
  const prepared = store.prepareDispatch(boardProject.slug, created.ref, { sessionId, sharedTree: false });
  assert.equal(store.recordDispatchLaunch(boardProject.slug, created.ref, { sessionId, token: prepared.token, executor: prepared.ticket.dispatchExecutor }).ok, true);
  if (options.bind !== false) assert.equal(store.bindDispatchWorktreeCreation(boardProject.slug, sessionId, worktree).ok, true);
  const ticket = store.getTicket(boardProject.slug, created.ref);
  if (options.bind !== false) assert.equal(fs.realpathSync(ticket.dispatch.worktree), fs.realpathSync(worktree), 'the fixture ticket is bound to its isolated worktree');
  const cleanup = () => {
    fs.rmSync(captureSlotDirectory(project), { recursive: true, force: true });
    fs.rmSync(worktreeParent, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  };
  return { project, worktree, ticket, prepared, slug: boardProject.slug, base: git(project, ['rev-parse', 'HEAD']), candidate: git(worktree, ['rev-parse', 'HEAD']), cleanup };
}

test('SQ-162: a capture requested from the canonical checkout runs in and records the dispatched worktree', async () => {
  const fixture = isolatedCaptureFixture('sq-162-canonical-cwd-');
  try {
    assert.notEqual(fixture.base, fixture.candidate, 'the fixture candidate differs from the canonical HEAD');
    // SQ-81 shape: the executor shell stood in the shared checkout.
    const { capture, recorded } = await runCapturedVerification('npm run check', { project: fixture.project, ticket: fixture.ticket.ref }, fixture.project);
    assert.equal(capture.status, 'passed', capture.evidence);
    assert.equal(recorded?.ok, true, recorded?.reason);
    assert.deepEqual(recorded?.capture?.candidate, { source: 'git', value: fixture.candidate });
    assert.equal(fs.realpathSync(recorded?.capture?.worktree), fs.realpathSync(fixture.worktree));
    assert.equal(fs.realpathSync(fs.readFileSync(path.join(fixture.worktree, 'suite-ran'), 'utf8')), fs.realpathSync(fixture.worktree), 'the verify command ran with the worktree as cwd');
    assert.equal(fs.existsSync(path.join(fixture.project, 'suite-ran')), false, 'nothing ran in the canonical checkout');
    fs.rmSync(capture.logPath, { force: true });
  } finally {
    fixture.cleanup();
  }
});

test('SQ-162: a capture requested from the dispatched linked worktree records its HEAD (SQ-134 shape)', async () => {
  const fixture = isolatedCaptureFixture('sq-162-linked-cwd-');
  try {
    const { capture, recorded } = await runCapturedVerification('npm run check', { project: fixture.project, ticket: fixture.ticket.ref }, fixture.worktree);
    assert.equal(capture.status, 'passed', capture.evidence);
    assert.equal(recorded?.ok, true, recorded?.reason);
    assert.deepEqual(recorded?.capture?.candidate, { source: 'git', value: fixture.candidate });
    assert.equal(fs.realpathSync(fs.readFileSync(path.join(fixture.worktree, 'suite-ran'), 'utf8')), fs.realpathSync(fixture.worktree));
    fs.rmSync(capture.logPath, { force: true });
  } finally {
    fixture.cleanup();
  }
});

test('SQ-162: a capture whose worktree HEAD is not the code that would run is refused before spawning', async () => {
  const fixture = isolatedCaptureFixture('sq-162-uncommitted-');
  try {
    // SQ-158 shape: the candidate edit is still uncommitted, so HEAD names a commit without it.
    fs.appendFileSync(path.join(fixture.worktree, 'suite.js'), '// uncommitted candidate edit\n');
    const { capture, recorded } = await runCapturedVerification('npm run check', { project: fixture.project, ticket: fixture.ticket.ref }, fixture.worktree);
    assert.deepEqual({ status: capture.status, exitCode: capture.exitCode }, { status: 'failed_check', exitCode: 2 });
    assert.deepEqual(capture.failureIdentities, ['failed_check:verification-capture-uncommitted-candidate']);
    assert.match(capture.reason || '', /^capture_candidate_uncommitted: /);
    assert.match(capture.reason || '', new RegExp(`bind to HEAD ${fixture.candidate}`));
    assert.match(capture.reason || '', /Uncommitted: suite\.js/);
    assert.equal(fs.existsSync(path.join(fixture.worktree, 'suite-ran')), false, 'the refused capture never spawned the verify command');
    // Refused before any process ran, so no wall-clock deadline was spent (asserted structurally, since timing is load-dependent).
    assert.equal(capture.logPath, null, "the refusal spawned no verify process and wrote no log");
    assert.equal(recorded?.ok, false);
    assert.equal(recorded?.reason, 'capture_candidate_uncommitted');
    assert.equal((store.getTicket(fixture.slug, fixture.ticket.ref).verificationCaptures || []).length, 0, 'no capture binds the wrong commit');
  } finally {
    fixture.cleanup();
  }
});

test('SQ-162: a capture whose dispatched worktree is gone is refused and names the worktree', async () => {
  const fixture = isolatedCaptureFixture('sq-162-missing-worktree-');
  try {
    execFileSync('git', ['worktree', 'remove', '--force', fixture.worktree], { cwd: fixture.project, windowsHide: true });
    const { capture, recorded } = await runCapturedVerification('npm run check', { project: fixture.project, ticket: fixture.ticket.ref }, fixture.project);
    assert.deepEqual({ status: capture.status, exitCode: capture.exitCode }, { status: 'could_not_run', exitCode: 2 });
    assert.match(capture.reason || '', /^capture_worktree_unavailable: /);
    assert.ok((capture.reason || '').includes(JSON.stringify(fixture.ticket.dispatch.worktree)), capture.reason);
    assert.equal(fs.existsSync(path.join(fixture.project, 'suite-ran')), false, 'the canonical checkout is never verified in its place');
    assert.equal(recorded?.reason, 'capture_worktree_unavailable');
  } finally {
    fixture.cleanup();
  }
});

test('SQ-162: an isolated dispatch with no bound worktree refuses instead of verifying the caller checkout', async () => {
  const fixture = isolatedCaptureFixture('sq-162-unbound-', { bind: false });
  try {
    assert.equal(fixture.ticket.dispatch.sharedTree, false);
    assert.equal(fixture.ticket.dispatch.worktree || '', '', 'the fixture dispatch is isolated but unbound');
    const { capture, recorded } = await runCapturedVerification('npm run check', { project: fixture.project, ticket: fixture.ticket.ref }, fixture.project);
    assert.deepEqual({ status: capture.status, exitCode: capture.exitCode, logPath: capture.logPath }, { status: 'could_not_run', exitCode: 2, logPath: null });
    assert.deepEqual(capture.failureIdentities, ['could_not_run:verification-capture-worktree-unavailable']);
    assert.match(capture.reason || '', /^capture_worktree_unavailable: .* no worktree is bound to it/);
    assert.equal(fs.existsSync(path.join(fixture.project, 'suite-ran')), false, 'the canonical checkout is never verified in its place');
    assert.equal(recorded?.ok, false);
    assert.equal(recorded?.reason, 'capture_worktree_unavailable');
    assert.equal((store.getTicket(fixture.slug, fixture.ticket.ref).verificationCaptures || []).length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('SQ-162: a capture whose HEAD moves while the command runs is not recorded against either commit', async () => {
  const fixture = isolatedCaptureFixture('sq-162-moved-head-');
  try {
    // The verify command itself commits, so HEAD after the run is not the commit the capture was bound to.
    fs.writeFileSync(path.join(fixture.worktree, 'suite.js'), `require('node:child_process').execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'moved during capture']);\n`);
    execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '-am', 'candidate that moves HEAD'], { cwd: fixture.worktree, windowsHide: true });
    const bound = String(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.worktree, encoding: 'utf8' })).trim();
    const { capture, recorded } = await runCapturedVerification('npm run check', { project: fixture.project, ticket: fixture.ticket.ref }, fixture.project);
    const moved = String(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.worktree, encoding: 'utf8' })).trim();
    assert.notEqual(moved, bound, 'the command moved HEAD');
    assert.equal(capture.status, 'passed', capture.evidence);
    assert.equal(recorded?.ok, false);
    assert.match(recorded?.reason || '', new RegExp(`^capture_candidate_moved: .*bound to HEAD ${bound}.*HEAD there is ${moved}`));
    assert.equal((store.getTicket(fixture.slug, fixture.ticket.ref).verificationCaptures || []).length, 0, 'neither commit is certified');
    fs.rmSync(capture.logPath, { force: true });
  } finally {
    fixture.cleanup();
  }
});

test('SQ-162: a terminal dispatch no longer binds, so a later capture runs where it is started', async () => {
  const fixture = isolatedCaptureFixture('sq-162-terminal-');
  try {
    const by = 'sq-162-terminal-worker';
    const claimed = store.claimTicket(fixture.slug, fixture.ticket.ref, by, { token: fixture.prepared.token, executor: fixture.prepared.ticket.dispatchExecutor });
    assert.equal(claimed.ok, true, claimed.message || claimed.reason);
    const released = store.releaseTicket(fixture.slug, fixture.ticket.ref, by, { status: 'todo', source: 'mcp' });
    assert.equal(released.ok, true, released.message || released.reason);
    assert.ok(released.ticket.dispatch.terminalAt, 'the dispatch is terminal');
    // A dirty worktree would refuse a live isolated capture; a terminal dispatch never consults it.
    fs.appendFileSync(path.join(fixture.worktree, 'suite.js'), '// left behind\n');
    const { capture, recorded } = await runCapturedVerification('npm run check', { project: fixture.project, ticket: fixture.ticket.ref }, fixture.project);
    assert.equal(capture.status, 'passed', capture.evidence);
    assert.equal(recorded?.ok, true, recorded?.reason);
    assert.deepEqual(recorded?.capture?.candidate, { source: 'git', value: fixture.base });
    assert.equal(fs.realpathSync(fs.readFileSync(path.join(fixture.project, 'suite-ran'), 'utf8')), fs.realpathSync(fixture.project));
    assert.equal(fs.existsSync(path.join(fixture.worktree, 'suite-ran')), false);
    fs.rmSync(capture.logPath, { force: true });
  } finally {
    fixture.cleanup();
  }
});

test('verification capture names the dead checkout when a retired agent worktree has no HEAD', () => {
  const project = captureFixtureProject('sq-capture-retired-project-', 'process.exit(0);\n');
  const worktreeParent = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-capture-retired-worktrees-'));
  const agentWorktree = path.join(worktreeParent, 'agent-retired');
  execFileSync('git', ['worktree', 'add', '--detach', '--quiet', agentWorktree, 'HEAD'], { cwd: project, windowsHide: true });
  const boardProject = store.ensureProject(project);
  const ticket = store.createTicket(boardProject.slug, {
    title: 'name the dead checkout a retired agent left behind',
    executorVerifyKind: 'command',
    executorVerify: 'npm run test:full',
  });

  try {
    // Retiring the agent prunes the worktree registration and leaves the directory.
    fs.rmSync(path.join(project, '.git', 'worktrees', 'agent-retired'), { recursive: true, force: true });
    const recorded = recordCapture({ project: agentWorktree, ticket: ticket.ref }, syntheticPassedCapture('npm run test:full'), agentWorktree);
    assert.equal(recorded.ok, false);
    // The board still resolved — the failure is the checkout, and the message says so.
    assert.match(recorded.reason, /^verified_revision_unavailable: git resolved no HEAD commit in the verified checkout /);
    assert.ok(recorded.reason.includes(JSON.stringify(path.resolve(agentWorktree))), recorded.reason);
    assert.ok(recorded.reason.includes(JSON.stringify(boardProject.slug)), recorded.reason);
    assert.match(recorded.reason, /retired agent's leftover worktree/);

    // An unregistered, non-repository cwd is the same class of failure.
    const stranger = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-capture-stranger-cwd-'));
    try {
      const strayCwd = recordCapture({ project, ticket: ticket.ref }, syntheticPassedCapture('npm run test:full'), stranger);
      assert.equal(strayCwd.ok, false);
      assert.ok(strayCwd.reason.includes(JSON.stringify(path.resolve(stranger))), strayCwd.reason);
    } finally {
      fs.rmSync(stranger, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(worktreeParent, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('verification capture names the unresolved project and the --project source', () => {
  const unregistered = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-capture-unregistered-'));
  try {
    const recorded = recordCapture({ project: unregistered, ticket: 'SQ-404' }, syntheticPassedCapture('npm run test:full'), unregistered);
    assert.equal(recorded.ok, false);
    assert.match(recorded.reason, /^project_not_found: no registered board matched the --project argument for SQ-404\./);
    assert.ok(recorded.reason.includes(JSON.stringify(unregistered)), recorded.reason);
    assert.match(recorded.reason, /resolves the board from the dispatched ticket's registered project path, not from the working directory/);
  } finally {
    fs.rmSync(unregistered, { recursive: true, force: true });
  }
});
