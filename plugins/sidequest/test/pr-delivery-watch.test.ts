import test from 'node:test';
import assert from 'node:assert/strict';

const { createBoardWatch } = require('../lib/store/pulse');

test('watch reports a failed awaiting-merge PR once with failing checks', async () => {
  const lines: string[] = [];
  const recorded: any[] = [];
  const statuses = [
    { number: 42, state: 'OPEN', checks: 'failure', failingChecks: ['test-gate'] },
    { number: 42, state: 'OPEN', checks: 'failure', failingChecks: ['lint'] },
  ];
  const boardWatch = createBoardWatch({
    board: 'board-a',
    changesPayload: () => ({ project: 'board-a', serverTime: new Date().toISOString(), tickets: [] }),
    awaitingMergeWavesProvider: async () => ({
      waves: [{ participants: ['SQ-1'], status: statuses.shift(), recorded: false }],
      recordState: (_wave: unknown, observed: any) => recorded.push(observed),
    }),
    writeLine: (line: string) => lines.push(line),
  });

  await boardWatch.poll();
  await boardWatch.poll();

  assert.deepEqual(lines, ['PR #42 failed: test-gate']);
  assert.deepEqual(recorded.map((observed: any) => observed.checks), ['failure', 'failure']);
});
