'use strict';

// Host sleep is not an executor or model-route failure (SQ-163/SQ-164). A laptop in
// Clamshell Sleep on battery only runs executors during seconds-long maintenance
// DarkWakes, so a model request sent in one DarkWake cannot finish before the next
// sleep, and Claude Code's wall-clock stream watchdog then fires in a later DarkWake
// and records "[Request interrupted by user]". Every wall-clock silence measure in
// Sidequest (claim idle, bound-never-claimed, board quiet) reads that sleep as an
// executor that went silent. This module answers one question for those paths: did
// the host sleep inside a given window? Classification is pure; reading the host is
// injectable, unprivileged, and never throws.

const { execFileSync } = require('node:child_process');

type SleepEventKind = 'Sleep' | 'DarkWake' | 'Wake';

type HostSleepEvent = {
  at: string;
  atMs: number;
  kind: SleepEventKind;
  durationSec: number | null;
};

type SleepInterval = { startMs: number; endMs: number };

// `pmset -g log` rows: `2026-09-26 11:20:14 -0700 Sleep  <message>  <n> secs`.
// "Wake Requests" rows share the Wake prefix and are scheduling records, not wakes.
const PMSET_ROW = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})\s+(Sleep|DarkWake|Wake)\b\s*(.*)$/;

function parsePmsetLog(text?: unknown): HostSleepEvent[] {
  const events: HostSleepEvent[] = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const match = PMSET_ROW.exec(rawLine.trim());
    if (!match) continue;
    const [, day, time, sign, hours, minutes, kind, rest] = match;
    if (kind === 'Wake' && /^Requests\b/i.test(rest || '')) continue;
    const at = `${day}T${time}${sign}${hours}:${minutes}`;
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) continue;
    const duration = /(\d+)\s+secs?\s*$/i.exec(rest || '');
    events.push({ at, atMs, kind: kind as SleepEventKind, durationSec: duration ? Number(duration[1]) : null });
  }
  return events.sort((left, right) => left.atMs - right.atMs);
}

// A Sleep row opens an asleep interval that the next DarkWake or Wake closes. When the
// log ends before any wake, pmset's own duration column bounds it, and with neither the
// host is still asleep as far as this log knows, so the interval stays open.
function sleepIntervals(events?: HostSleepEvent[]): SleepInterval[] {
  const ordered = (Array.isArray(events) ? events : [])
    .filter((event) => event && Number.isFinite(event.atMs))
    .slice().sort((left, right) => left.atMs - right.atMs);
  const intervals: SleepInterval[] = [];
  ordered.forEach((event, index) => {
    if (event.kind !== 'Sleep') return;
    const wake = ordered.slice(index + 1).find((next) => next.kind === 'DarkWake' || next.kind === 'Wake');
    const endMs = wake ? wake.atMs
      : Number.isFinite(event.durationSec) && Number(event.durationSec) > 0 ? event.atMs + Number(event.durationSec) * 1000
        : Number.POSITIVE_INFINITY;
    if (endMs > event.atMs) intervals.push({ startMs: event.atMs, endMs });
  });
  return intervals;
}

function toMs(value: unknown) {
  if (typeof value === 'number') return value;
  return Date.parse(String(value ?? ''));
}

function hostSleepOverlap(window: { windowStart?: unknown; windowEnd?: unknown; events?: HostSleepEvent[] }) {
  const startMs = toMs(window?.windowStart);
  const endMs = toMs(window?.windowEnd);
  const ranges: { start: string; end: string | null }[] = [];
  let sleptMs = 0;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return { sleptMs, ranges };
  for (const interval of sleepIntervals(window.events)) {
    const overlapStart = Math.max(startMs, interval.startMs);
    const overlapEnd = Math.min(endMs, interval.endMs);
    if (overlapEnd <= overlapStart) continue;
    sleptMs += overlapEnd - overlapStart;
    ranges.push({
      start: new Date(interval.startMs).toISOString(),
      end: Number.isFinite(interval.endMs) ? new Date(interval.endMs).toISOString() : null,
    });
  }
  return { sleptMs, ranges };
}

// 'host_sleep' when any asleep interval overlaps the silent window; otherwise the
// silence is a genuine stall and the usual executor/route triage applies.
function classifyStall(window: { windowStart?: unknown; windowEnd?: unknown; events?: HostSleepEvent[] }) {
  return hostSleepOverlap(window).sleptMs > 0 ? 'host_sleep' : 'genuine_stall';
}

// Off darwin there is no unprivileged sleep log, but a suspend shows up as wall-clock
// time that the monotonic clock never saw (both mach_absolute_time and CLOCK_MONOTONIC
// stop while the host is suspended). Each sample compares the two since the previous
// sample; a gap beyond the threshold becomes a synthetic Sleep/Wake pair spanning the
// sampled interval, which is coarse but never invents sleep the clocks did not show.
function createSuspendDetector(options: { wallNow?: () => number; monotonicNow?: () => number; thresholdMs?: number; retain?: number } = {}) {
  const wallNow = options.wallNow || (() => Date.now());
  const monotonicNow = options.monotonicNow || (() => performance.now());
  const thresholdMs = Number.isFinite(options.thresholdMs) ? Number(options.thresholdMs) : 30_000;
  const retain = Number.isFinite(options.retain) ? Number(options.retain) : 64;
  let previous = { wall: wallNow(), mono: monotonicNow() };
  const detected: HostSleepEvent[] = [];
  function sample() {
    const current = { wall: wallNow(), mono: monotonicNow() };
    const gapMs = (current.wall - previous.wall) - (current.mono - previous.mono);
    if (gapMs > thresholdMs) {
      const sleepAt = current.wall - gapMs;
      detected.push(
        { at: new Date(sleepAt).toISOString(), atMs: sleepAt, kind: 'Sleep', durationSec: Math.round(gapMs / 1000) },
        { at: new Date(current.wall).toISOString(), atMs: current.wall, kind: 'Wake', durationSec: null },
      );
      while (detected.length > retain * 2) detected.shift();
    }
    previous = current;
    return detected.slice();
  }
  return { sample, events: () => detected.slice() };
}

const DETECTION_OFF = /^(?:0|off|false|no)$/i;

// Reads host sleep events, cached briefly so a `changes` read over many tickets runs
// pmset once. Disabled with SIDEQUEST_HOST_SLEEP_DETECTION=0, which the test home sets
// so a developer laptop's real sleep history never leaks into fixture timing.
function createHostSleepReader(options: { platform?: string; execFile?: any; env?: NodeJS.ProcessEnv; cacheMs?: number; now?: () => number; detector?: ReturnType<typeof createSuspendDetector> } = {}) {
  const platform = options.platform || process.platform;
  const execFile = options.execFile || execFileSync;
  const env = options.env || process.env;
  const cacheMs = Number.isFinite(options.cacheMs) ? Number(options.cacheMs) : 5 * 60_000;
  const now = options.now || (() => Date.now());
  const detector = options.detector || (platform === 'darwin' ? null : createSuspendDetector());
  let cached: { atMs: number; events: HostSleepEvent[] } | null = null;
  function events(): HostSleepEvent[] {
    if (DETECTION_OFF.test(String(env.SIDEQUEST_HOST_SLEEP_DETECTION || ''))) return [];
    if (platform !== 'darwin') {
      try { return detector ? detector.sample() : []; } catch (_error: unknown) { return []; }
    }
    const atMs = now();
    if (cached && atMs - cached.atMs < cacheMs) return cached.events;
    let parsed: HostSleepEvent[] = [];
    try {
      parsed = parsePmsetLog(execFile('pmset', ['-g', 'log'], {
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }));
    } catch (_error: unknown) {
      parsed = [];
    }
    cached = { atMs, events: parsed };
    return parsed;
  }
  function overlap(windowStart: unknown, windowEnd: unknown) {
    return hostSleepOverlap({ windowStart, windowEnd, events: events() });
  }
  return {
    events,
    overlap,
    sleptDuring: (windowStart: unknown, windowEnd: unknown) => overlap(windowStart, windowEnd).sleptMs > 0,
  };
}

const HOST_SLEEP_GUIDANCE = 'claim kept resumable; do not change model routes or repoint categories; SendMessage the same executor to continue once the host is awake, and keep long unattended runs awake (caffeinate -is, or AC power with the lid open)';

function describeSleepRanges(ranges: { start: string; end: string | null }[]) {
  return ranges.map((range) => `${range.start}..${range.end || 'still asleep'}`).join(', ');
}

// Liveness states that wall-clock silence alone produced. A recorded death keeps its
// state unless its own failure shape already says host_sleep.
const SILENCE_STATES = new Set(['dead', 'stalled', 'unknown']);

function reclassifyLivenessForHostSleep(liveness: { state: string; evidence: string }, context: { silenceDerived?: boolean; windowStart?: unknown; windowEnd?: unknown; overlap?: (start: unknown, end: unknown) => { sleptMs: number; ranges: { start: string; end: string | null }[] } }) {
  if (!liveness || !context?.silenceDerived || !SILENCE_STATES.has(liveness.state)) return liveness;
  if (typeof context.overlap !== 'function') return liveness;
  let found: { sleptMs: number; ranges: { start: string; end: string | null }[] };
  try {
    found = context.overlap(context.windowStart, context.windowEnd);
  } catch (_error: unknown) {
    return liveness;
  }
  if (!found || !(found.sleptMs > 0)) return liveness;
  return {
    state: 'host_sleep',
    evidence: `host slept ${Math.round(found.sleptMs / 1000)}s inside the silent window (${describeSleepRanges(found.ranges)}), so the silence is not an executor or route failure (was ${liveness.state}: ${liveness.evidence}); ${HOST_SLEEP_GUIDANCE}`,
  };
}

let defaultReader: ReturnType<typeof createHostSleepReader> | null = null;

function defaultHostSleep() {
  if (!defaultReader) defaultReader = createHostSleepReader();
  return defaultReader;
}

module.exports = {
  HOST_SLEEP_GUIDANCE,
  classifyStall,
  createHostSleepReader,
  createSuspendDetector,
  defaultHostSleep,
  hostSleepOverlap,
  parsePmsetLog,
  reclassifyLivenessForHostSleep,
  sleepIntervals,
};
