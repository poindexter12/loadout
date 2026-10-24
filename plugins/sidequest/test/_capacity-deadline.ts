// SQ-74: the in-test wait shared by tests that poll for a spawned child's side effect. SQ-58
// scaled these deadlines with the test worker count; this also scales them with the load the
// host is under, through the same effective-worker model the full-suite capture budget uses
// (lib/verify-capture.js capacityScaledDeadlineMilliseconds). The load is re-read on every
// poll: a sibling suite that starts mid-wait extends the deadline, and load that falls never
// shortens it, so a wait can only gain time, never lose it.
import os from 'node:os';

const { capacityScaledDeadlineMilliseconds } = require('../lib/verify-capture.js') as {
  capacityScaledDeadlineMilliseconds(perTestWorkerMilliseconds: number, testWorkers: number, availableParallelism?: number, loadAverage?: number): number;
};

export function testWorkerConcurrency(execArgv: readonly string[] = process.execArgv, availableParallelism = os.availableParallelism()): number {
  const argument = execArgv.find((value) => value.startsWith('--test-concurrency='));
  const requested = Number(argument?.slice('--test-concurrency='.length));
  return Number.isInteger(requested) && requested > 0 ? requested : availableParallelism;
}

export type CapacityWaitOptions = Readonly<{
  perTestWorkerMilliseconds: number;
  floorMilliseconds?: number;
  pollMilliseconds?: number;
  testWorkers?: number;
  availableParallelism?: number;
  // Test seams: the load reading, the clock and the pause between polls.
  sampleLoad?: () => number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}>;

export type CapacityWaitResult = Readonly<{
  ready: boolean;
  waitedMilliseconds: number;
  deadlineMilliseconds: number;
  loadAverage: number;
}>;

export function capacityWaitDeadlineMilliseconds(options: CapacityWaitOptions, loadAverage: number): number {
  const testWorkers = options.testWorkers ?? testWorkerConcurrency();
  const availableParallelism = options.availableParallelism ?? os.availableParallelism();
  const scaled = capacityScaledDeadlineMilliseconds(options.perTestWorkerMilliseconds, testWorkers, availableParallelism, loadAverage);
  return Math.max(options.floorMilliseconds ?? 0, scaled);
}

export async function waitForCapacity(isReady: () => boolean, options: CapacityWaitOptions): Promise<CapacityWaitResult> {
  const sampleLoad = options.sampleLoad ?? (() => os.loadavg()[0] || 0);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const pollMilliseconds = options.pollMilliseconds ?? 20;
  const startedAt = now();
  let loadAverage = sampleLoad();
  let deadlineMilliseconds = capacityWaitDeadlineMilliseconds(options, loadAverage);
  for (;;) {
    if (isReady()) return Object.freeze({ ready: true, waitedMilliseconds: now() - startedAt, deadlineMilliseconds, loadAverage });
    const sampled = sampleLoad();
    const deadline = capacityWaitDeadlineMilliseconds(options, sampled);
    if (deadline > deadlineMilliseconds) {
      deadlineMilliseconds = deadline;
      loadAverage = sampled;
    }
    const waitedMilliseconds = now() - startedAt;
    if (waitedMilliseconds >= deadlineMilliseconds) return Object.freeze({ ready: false, waitedMilliseconds, deadlineMilliseconds, loadAverage });
    await sleep(pollMilliseconds);
  }
}

export function capacityWaitTimeoutMessage(target: string, result: CapacityWaitResult): string {
  return `Timed out waiting for ${target} after ${result.waitedMilliseconds}ms: capacity-scaled deadline ${result.deadlineMilliseconds}ms at a 1-minute load average of ${result.loadAverage.toFixed(2)} on ${os.availableParallelism()} cores with ${testWorkerConcurrency()} test workers.`;
}
