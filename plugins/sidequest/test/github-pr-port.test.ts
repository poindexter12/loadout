import test from 'node:test';
import assert from 'node:assert/strict';

const { createGhPrPort, PrDeliveryUnavailableError } = require('../src/lib/ports/github-pr');

type Call = { program: string; arguments_: string[]; options?: Record<string, unknown> };

function fakeGh(responses: Record<string, unknown>, calls: Call[] = []) {
  return (program: string, arguments_: string[], options?: Record<string, unknown>) => {
    calls.push({ program, arguments_, options });
    const response = responses[arguments_.join(' ')];
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error(`unexpected gh ${arguments_.join(' ')}`);
    return typeof response === 'string' ? response : JSON.stringify(response);
  };
}

const create = 'pr create --base main --head sidequest/wave/SQ-104 --title feat: PR delivery --body-file -';
const view = 'pr view 42 --json number,url,state,headRefOid,mergeCommit,statusCheckRollup';

test('creates a PR with argv arguments and sends its body through stdin', async () => {
  const calls: Call[] = [];
  const port = createGhPrPort(fakeGh({ [create]: 'https://github.com/owner/repo/pull/42\n' }, calls));

  const result = await port.createPr({ cwd: '/repo', base: 'main', head: 'sidequest/wave/SQ-104', title: 'feat: PR delivery', body: 'Ticket title\n' });

  assert.deepEqual(result, { number: 42, url: 'https://github.com/owner/repo/pull/42' });
  assert.deepEqual(calls[0]?.arguments_, ['pr', 'create', '--base', 'main', '--head', 'sidequest/wave/SQ-104', '--title', 'feat: PR delivery', '--body-file', '-']);
  assert.equal(calls[0]?.program, 'gh');
  assert.equal(calls[0]?.options?.cwd, '/repo');
  assert.equal(calls[0]?.options?.input, 'Ticket title\n');
  assert.equal(calls[0]?.options?.stdio instanceof Array, true);
});

test('enables merge-commit auto-merge with argv arguments', async () => {
  const calls: Call[] = [];
  const port = createGhPrPort(fakeGh({ 'pr merge 42 --auto --merge': '' }, calls));

  await port.enableAutoMerge({ cwd: '/repo', number: 42 });

  assert.deepEqual(calls[0]?.arguments_, ['pr', 'merge', '42', '--auto', '--merge']);
  assert.equal(calls[0]?.options?.input, undefined);
});

test('maps check rollups with failure precedence and names failing checks', async () => {
  const port = createGhPrPort(fakeGh({ [view]: {
    number: 42,
    url: 'https://github.com/owner/repo/pull/42',
    state: 'OPEN',
    headRefOid: 'abc123',
    mergeCommit: null,
    statusCheckRollup: [
      { name: 'test-gate', conclusion: 'FAILURE' },
      { context: 'queued-job', state: 'PENDING' },
      { name: 'cancelled-job', conclusion: 'CANCELLED' },
    ],
  } }));

  const status = await port.viewPr({ cwd: '/repo', number: 42 });

  assert.equal(status.checks, 'failure');
  assert.deepEqual(status.failingChecks, ['test-gate', 'cancelled-job']);
  assert.equal(status.headSha, 'abc123');
});

test('maps pending checks and documents state-aware empty rollups', async () => {
  const openPort = createGhPrPort(fakeGh({ [view]: {
    number: 42, url: 'https://github.com/owner/repo/pull/42', state: 'OPEN', headRefOid: 'open', mergeCommit: null, statusCheckRollup: [],
  } }));
  const mergedPort = createGhPrPort(fakeGh({ [view]: {
    number: 42, url: 'https://github.com/owner/repo/pull/42', state: 'MERGED', headRefOid: 'merged', mergeCommit: { oid: 'merge-sha' }, statusCheckRollup: [],
  } }));
  const pendingPort = createGhPrPort(fakeGh({ [view]: {
    number: 42, url: 'https://github.com/owner/repo/pull/42', state: 'OPEN', headRefOid: 'pending', mergeCommit: null, statusCheckRollup: [{ name: 'test-gate', status: 'IN_PROGRESS' }],
  } }));

  assert.equal((await openPort.viewPr({ cwd: '/repo', number: 42 })).checks, 'pending');
  const merged = await mergedPort.viewPr({ cwd: '/repo', number: 42 });
  assert.equal(merged.checks, 'success');
  assert.equal(merged.mergeCommit, 'merge-sha');
  assert.equal((await pendingPort.viewPr({ cwd: '/repo', number: 42 })).checks, 'pending');
});

test('normalizes unavailable gh, authentication, and remote failures to typed delivery errors', async () => {
  const unavailableCreate = 'pr create --base main --head head --title title --body-file -';
  for (const cause of ['spawn gh ENOENT', 'gh: not authenticated', 'no git remotes configured']) {
    const port = createGhPrPort(fakeGh({ [unavailableCreate]: new Error(cause) }));
    await assert.rejects(
      () => port.createPr({ cwd: '/repo', base: 'main', head: 'head', title: 'title', body: 'body' }),
      (error: unknown) => error instanceof PrDeliveryUnavailableError && (error as { cause?: unknown }).cause === cause,
    );
  }
});
