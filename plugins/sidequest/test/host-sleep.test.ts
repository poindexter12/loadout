import test from 'node:test';
import assert from 'node:assert/strict';

const {
  classifyStall,
  createHostSleepReader,
  createSuspendDetector,
  defaultHostSleep,
  hostSleepOverlap,
  parsePmsetLog,
} = require('../lib/host-sleep');
const { createPulse } = require('../lib/store/pulse');
const { createClaims } = require('../lib/store/claims');
const store = require('../lib/store');

// Synthetic `pmset -g log` excerpt carrying the SQ-163 evidence (2026-09-26, PDT): the
// laptop entered Clamshell Sleep on battery and only surfaced for maintenance DarkWakes.
const SQ163_PMSET = [
  'Time stamp                Domain              Message                                                          Duration  Delay',
  '2026-09-26 11:20:14 -0700 Sleep               \tEntering Sleep state due to \'Clamshell Sleep\':TCPKeepAlive=active Using Batt (Charge:14%)\t595 secs',
  '2026-09-26 11:20:15 -0700 Assertions          \tSummary- [System: SleepServiceUp] Using Batt(Charge: 14)',
  '2026-09-26 11:30:09 -0700 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to RTC/Maintenance Using BATT (Charge:14%)\t16 secs',
  '2026-09-26 11:30:10 -0700 Wake Requests       \t[*process=powerd request=Maintenance deltaSecs=900]',
  '2026-09-26 11:30:25 -0700 Sleep               \tEntering Sleep state due to \'Maintenance Sleep\':TCPKeepAlive=active Using Batt (Charge:14%)\t935 secs',
  '2026-09-26 11:46:00 -0700 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to RTC/Maintenance Using BATT (Charge:14%)\t2 secs',
  '2026-09-26 13:22:16 -0700 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to RTC/Maintenance Using BATT (Charge:13%)\t6 secs',
  '2026-09-26 13:22:22 -0700 Sleep               \tEntering Sleep state due to \'Maintenance Sleep\':TCPKeepAlive=active Using Batt (Charge:13%)\t1023 secs',
  '2026-09-26 13:39:25 -0700 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to RTC/Maintenance Using BATT (Charge:13%)\t4 secs',
].join('\n');

const FIRST_STALL = { windowStart: '2026-09-26T18:30:12Z', windowEnd: '2026-09-26T18:46:01Z' };
const SECOND_STALL = { windowStart: '2026-09-26T20:22:19Z', windowEnd: '2026-09-26T20:39:25Z' };

function fixedHostSleep(events: any[]) {
  return {
    events: () => events,
    overlap: (windowStart: unknown, windowEnd: unknown) => hostSleepOverlap({ windowStart, windowEnd, events }),
    sleptDuring: (windowStart: unknown, windowEnd: unknown) => hostSleepOverlap({ windowStart, windowEnd, events }).sleptMs > 0,
  };
}

test('pmset rows parse into Sleep/DarkWake events and skip Wake Requests and other domains', () => {
  const events = parsePmsetLog(SQ163_PMSET);
  assert.deepEqual(events.map((event: any) => event.kind), ['Sleep', 'DarkWake', 'Sleep', 'DarkWake', 'DarkWake', 'Sleep', 'DarkWake']);
  assert.equal(events[0].at, '2026-09-26T11:20:14-07:00');
  assert.equal(new Date(events[0].atMs).toISOString(), '2026-09-26T18:20:14.000Z');
  assert.equal(events[0].durationSec, 595);
  assert.equal(events[5].durationSec, 1023);
});

test('SQ-163 first SQ-127 stall window overlapping a Clamshell maintenance sleep classifies as host_sleep', () => {
  const events = parsePmsetLog(SQ163_PMSET);
  assert.equal(classifyStall({ ...FIRST_STALL, events }), 'host_sleep');
  const overlap = hostSleepOverlap({ ...FIRST_STALL, events });
  assert.equal(overlap.sleptMs, (15 * 60 + 35) * 1000, 'asleep 11:30:25 to 11:46:00 inside the window');
  assert.deepEqual(overlap.ranges, [{ start: '2026-09-26T18:30:25.000Z', end: '2026-09-26T18:46:00.000Z' }]);
});

test('SQ-163 second SQ-127 stall window (1023 s maintenance sleep) classifies as host_sleep', () => {
  const events = parsePmsetLog(SQ163_PMSET);
  assert.equal(classifyStall({ ...SECOND_STALL, events }), 'host_sleep');
  assert.equal(hostSleepOverlap({ ...SECOND_STALL, events }).sleptMs, 1023 * 1000);
});

test('a stall window with no sleep entries, or only sleep outside it, is still a genuine stall', () => {
  assert.equal(classifyStall({ ...FIRST_STALL, events: [] }), 'genuine_stall');
  const elsewhere = parsePmsetLog([
    '2026-09-26 09:00:00 -0700 Sleep               \tEntering Sleep state due to \'Idle Sleep\' Using AC (Charge:100%)\t1800 secs',
    '2026-09-26 09:30:00 -0700 Wake                \tWake from Deep Idle [CDNPB] : due to UserActivity Assertion Using AC (Charge:100%)',
    '2026-09-26 14:00:00 -0700 Sleep               \tEntering Sleep state due to \'Idle Sleep\' Using AC (Charge:100%)',
  ].join('\n'));
  assert.equal(elsewhere.length, 3);
  assert.equal(classifyStall({ ...FIRST_STALL, events: elsewhere }), 'genuine_stall');
  assert.equal(classifyStall({ ...SECOND_STALL, events: elsewhere }), 'genuine_stall');
  assert.equal(classifyStall({ ...FIRST_STALL, events: parsePmsetLog('2026-09-26 11:35:00 -0700 Assertions  \tPID 1 Created\n') }), 'genuine_stall');
});

test('readers never throw: pmset failure, non-darwin, and detection off all fall back to genuine_stall', () => {
  let pmsetCalls = 0;
  const failing = createHostSleepReader({ platform: 'darwin', env: {}, execFile: () => { pmsetCalls += 1; throw new Error('pmset: not found'); } });
  assert.deepEqual(failing.events(), []);
  assert.equal(failing.sleptDuring(FIRST_STALL.windowStart, FIRST_STALL.windowEnd), false);
  assert.equal(classifyStall({ ...FIRST_STALL, events: failing.events() }), 'genuine_stall');
  assert.equal(pmsetCalls, 1, 'a failed read is cached rather than retried per ticket');

  const off = createHostSleepReader({ platform: 'darwin', env: { SIDEQUEST_HOST_SLEEP_DETECTION: '0' }, execFile: () => { throw new Error('must not run'); } });
  assert.deepEqual(off.events(), []);

  const darwin = createHostSleepReader({ platform: 'darwin', env: {}, execFile: (program: string, args: string[]) => {
    assert.equal(program, 'pmset');
    assert.deepEqual(args, ['-g', 'log']);
    return SQ163_PMSET;
  } });
  assert.equal(darwin.sleptDuring(FIRST_STALL.windowStart, FIRST_STALL.windowEnd), true);

  const linux = createHostSleepReader({ platform: 'linux', env: {}, detector: { sample: () => { throw new Error('clock'); }, events: () => [] } });
  assert.deepEqual(linux.events(), []);

  assert.deepEqual(defaultHostSleep().events(), [], 'the test home turns real host detection off for every suite');
});

test('off darwin a wall-clock jump the monotonic clock never saw is recorded as a sleep', () => {
  let wall = Date.parse('2026-09-26T18:00:00Z');
  let mono = 1_000;
  const detector = createSuspendDetector({ wallNow: () => wall, monotonicNow: () => mono, thresholdMs: 30_000 });
  wall += 5_000; mono += 5_000;
  assert.deepEqual(detector.sample(), [], 'clocks agree: no suspend');
  wall += 20 * 60_000; mono += 10_000;
  const events = detector.sample();
  assert.deepEqual(events.map((event: any) => event.kind), ['Sleep', 'Wake']);
  assert.equal(classifyStall({ windowStart: '2026-09-26T18:00:05Z', windowEnd: new Date(wall).toISOString(), events }), 'host_sleep');
});

test('a watchdog death during host sleep is host_sleep, never a terminal-agent or route failure', () => {
  const slept = { hostSleptDuring: () => true };
  const awake = { hostSleptDuring: () => false };
  assert.equal(store.classifyDispatchFailure('[Request interrupted by user]', slept), 'host_sleep');
  assert.equal(store.classifyDispatchFailure('[Request interrupted by user]', awake), 'unknown');
  assert.equal(store.classifyDispatchFailure('[Request interrupted by user]'), 'unknown');
  assert.equal(store.classifyDispatchFailure('Stream idle timeout - partial response received', slept), 'host_sleep');
  assert.equal(store.classifyDispatchFailure('', slept), 'host_sleep');
  assert.equal(store.classifyDispatchFailure('', awake), 'process_death');
  assert.equal(store.classifyDispatchFailure('prompt is too long', slept), 'context_overflow', 'a non-watchdog failure keeps its own shape');
});

function pulseWith(hostSleep: any) {
  return createPulse({
    checkpointProjection: () => null,
    claimIdleMs: () => 60 * 60_000,
    claimPulse: () => null,
    dispatchState: (ticket: any) => ticket.dispatch || null,
    hostSleep,
    listTickets: () => [],
    oracleProjection: () => null,
    storyContractDriftWarnings: () => [],
    storyDecisionLogWarnings: () => [],
  });
}

test('pulse liveness reports host_sleep, not dead or stalled, when the silent window overlaps host sleep', () => {
  const events = parsePmsetLog(SQ163_PMSET);
  const now = Date.parse('2026-09-26T20:39:30Z');
  const quietSince = Date.parse('2026-09-26T19:20:00Z');
  const ticket = { ref: 'SQ-127', status: 'doing', claim: { by: 'exec' }, comments: [] };
  const dispatch = { outcome: 'launched', boundAt: '2026-09-26T19:00:00Z', claimedAt: '2026-09-26T19:01:00Z' };
  const reclaimableClaim = { by: 'exec', reclaimable: 'abandoned', boardQuietMs: now - quietSince };

  const slept = pulseWith(fixedHostSleep(events)).livenessPulse(ticket, dispatch, reclaimableClaim, null, now);
  assert.equal(slept.state, 'host_sleep');
  assert.match(slept.evidence, /do not change model routes/);
  assert.match(slept.evidence, /caffeinate -is/);

  const awake = pulseWith(fixedHostSleep([])).livenessPulse(ticket, dispatch, reclaimableClaim, null, now);
  assert.equal(awake.state, 'dead', 'without sleep the reclaimable claim still reads dead');

  const neverClaimed = { outcome: 'launched', boundAt: '2026-09-26T20:22:19Z' };
  const unclaimedTicket = { ref: 'SQ-45', status: 'todo', comments: [] };
  assert.equal(pulseWith(fixedHostSleep([])).livenessPulse(unclaimedTicket, neverClaimed, null, null, now).state, 'stalled');
  assert.equal(pulseWith(fixedHostSleep(events)).livenessPulse(unclaimedTicket, neverClaimed, null, null, now).state, 'host_sleep');

  const hostSleepDeath = { outcome: 'died', terminalAt: '2026-09-26T20:39:25Z', terminalSource: 'subagent-stop', failureShape: 'host_sleep' };
  const otherDeath = { ...hostSleepDeath, failureShape: 'agent_terminal' };
  const death = { at: hostSleepDeath.terminalAt, source: 'subagent-stop' };
  assert.equal(pulseWith(fixedHostSleep(events)).livenessPulse(ticket, hostSleepDeath, null, death, now).state, 'host_sleep');
  assert.equal(pulseWith(fixedHostSleep(events)).livenessPulse(ticket, otherDeath, null, death, now).state, 'dead');
});

test('claim backstops count only awake time, so a sleeping executor is never swept as idle', () => {
  const claims = createClaims({
    dispatchState: () => null,
    isolatedDispatchWorktreeMissing: () => false,
    hostSleep: fixedHostSleep(parsePmsetLog([
      '2026-09-26 11:20:14 -0700 Sleep               \tEntering Sleep state due to \'Clamshell Sleep\' Using Batt (Charge:14%)',
      '2026-09-26 13:39:25 -0700 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to RTC/Maintenance Using BATT (Charge:13%)\t4 secs',
    ].join('\n'))),
  });
  const ticket = { claim: { by: 'exec', at: '2026-09-26T18:15:00Z' }, comments: [] };
  assert.equal(claims.claimReleaseVerdict(ticket, Date.parse('2026-09-26T20:40:00Z')), null, '2h25m wall, under 10 minutes awake');
  const awakeClaims = createClaims({ dispatchState: () => null, isolatedDispatchWorktreeMissing: () => false, hostSleep: fixedHostSleep([]) });
  assert.equal(awakeClaims.claimReleaseVerdict(ticket, Date.parse('2026-09-26T20:40:00Z'))?.kind, 'idle');
});
