"use strict";
const { execFileSync } = require("node:child_process");
const PMSET_ROW = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})\s+(Sleep|DarkWake|Wake)\b\s*(.*)$/;
function parsePmsetLog(text) {
  const events = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const match = PMSET_ROW.exec(rawLine.trim());
    if (!match) continue;
    const [, day, time, sign, hours, minutes, kind, rest] = match;
    if (kind === "Wake" && /^Requests\b/i.test(rest || "")) continue;
    const at = `${day}T${time}${sign}${hours}:${minutes}`;
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) continue;
    const duration = /(\d+)\s+secs?\s*$/i.exec(rest || "");
    events.push({ at, atMs, kind, durationSec: duration ? Number(duration[1]) : null });
  }
  return events.sort((left, right) => left.atMs - right.atMs);
}
function sleepIntervals(events) {
  const ordered = (Array.isArray(events) ? events : []).filter((event) => event && Number.isFinite(event.atMs)).slice().sort((left, right) => left.atMs - right.atMs);
  const intervals = [];
  ordered.forEach((event, index) => {
    if (event.kind !== "Sleep") return;
    const wake = ordered.slice(index + 1).find((next) => next.kind === "DarkWake" || next.kind === "Wake");
    const endMs = wake ? wake.atMs : Number.isFinite(event.durationSec) && Number(event.durationSec) > 0 ? event.atMs + Number(event.durationSec) * 1e3 : Number.POSITIVE_INFINITY;
    if (endMs > event.atMs) intervals.push({ startMs: event.atMs, endMs });
  });
  return intervals;
}
function toMs(value) {
  if (typeof value === "number") return value;
  return Date.parse(String(value ?? ""));
}
function hostSleepOverlap(window) {
  const startMs = toMs(window?.windowStart);
  const endMs = toMs(window?.windowEnd);
  const ranges = [];
  let sleptMs = 0;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return { sleptMs, ranges };
  for (const interval of sleepIntervals(window.events)) {
    const overlapStart = Math.max(startMs, interval.startMs);
    const overlapEnd = Math.min(endMs, interval.endMs);
    if (overlapEnd <= overlapStart) continue;
    sleptMs += overlapEnd - overlapStart;
    ranges.push({
      start: new Date(interval.startMs).toISOString(),
      end: Number.isFinite(interval.endMs) ? new Date(interval.endMs).toISOString() : null
    });
  }
  return { sleptMs, ranges };
}
function classifyStall(window) {
  return hostSleepOverlap(window).sleptMs > 0 ? "host_sleep" : "genuine_stall";
}
function createSuspendDetector(options = {}) {
  const wallNow = options.wallNow || (() => Date.now());
  const monotonicNow = options.monotonicNow || (() => performance.now());
  const thresholdMs = Number.isFinite(options.thresholdMs) ? Number(options.thresholdMs) : 3e4;
  const retain = Number.isFinite(options.retain) ? Number(options.retain) : 64;
  let previous = { wall: wallNow(), mono: monotonicNow() };
  const detected = [];
  function sample() {
    const current = { wall: wallNow(), mono: monotonicNow() };
    const gapMs = current.wall - previous.wall - (current.mono - previous.mono);
    if (gapMs > thresholdMs) {
      const sleepAt = current.wall - gapMs;
      detected.push(
        { at: new Date(sleepAt).toISOString(), atMs: sleepAt, kind: "Sleep", durationSec: Math.round(gapMs / 1e3) },
        { at: new Date(current.wall).toISOString(), atMs: current.wall, kind: "Wake", durationSec: null }
      );
      while (detected.length > retain * 2) detected.shift();
    }
    previous = current;
    return detected.slice();
  }
  return { sample, events: () => detected.slice() };
}
const DETECTION_OFF = /^(?:0|off|false|no)$/i;
function createHostSleepReader(options = {}) {
  const platform = options.platform || process.platform;
  const execFile = options.execFile || execFileSync;
  const env = options.env || process.env;
  const cacheMs = Number.isFinite(options.cacheMs) ? Number(options.cacheMs) : 5 * 6e4;
  const now = options.now || (() => Date.now());
  const detector = options.detector || (platform === "darwin" ? null : createSuspendDetector());
  let cached = null;
  function events() {
    if (DETECTION_OFF.test(String(env.SIDEQUEST_HOST_SLEEP_DETECTION || ""))) return [];
    if (platform !== "darwin") {
      try {
        return detector ? detector.sample() : [];
      } catch (_error) {
        return [];
      }
    }
    const atMs = now();
    if (cached && atMs - cached.atMs < cacheMs) return cached.events;
    let parsed = [];
    try {
      parsed = parsePmsetLog(execFile("pmset", ["-g", "log"], {
        encoding: "utf8",
        timeout: 1e4,
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true
      }));
    } catch (_error) {
      parsed = [];
    }
    cached = { atMs, events: parsed };
    return parsed;
  }
  function overlap(windowStart, windowEnd) {
    return hostSleepOverlap({ windowStart, windowEnd, events: events() });
  }
  return {
    events,
    overlap,
    sleptDuring: (windowStart, windowEnd) => overlap(windowStart, windowEnd).sleptMs > 0
  };
}
const HOST_SLEEP_GUIDANCE = "claim kept resumable; do not change model routes or repoint categories; SendMessage the same executor to continue once the host is awake, and keep long unattended runs awake (caffeinate -is, or AC power with the lid open)";
function describeSleepRanges(ranges) {
  return ranges.map((range) => `${range.start}..${range.end || "still asleep"}`).join(", ");
}
const SILENCE_STATES = /* @__PURE__ */ new Set(["dead", "stalled", "unknown"]);
function reclassifyLivenessForHostSleep(liveness, context) {
  if (!liveness || !context?.silenceDerived || !SILENCE_STATES.has(liveness.state)) return liveness;
  if (typeof context.overlap !== "function") return liveness;
  let found;
  try {
    found = context.overlap(context.windowStart, context.windowEnd);
  } catch (_error) {
    return liveness;
  }
  if (!found || !(found.sleptMs > 0)) return liveness;
  return {
    state: "host_sleep",
    evidence: `host slept ${Math.round(found.sleptMs / 1e3)}s inside the silent window (${describeSleepRanges(found.ranges)}), so the silence is not an executor or route failure (was ${liveness.state}: ${liveness.evidence}); ${HOST_SLEEP_GUIDANCE}`
  };
}
let defaultReader = null;
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
  sleepIntervals
};
