'use strict';

// Compaction outcomes from Claude Code transcripts (SQ-192).
//
// Privacy boundary. This module is the plugin's only transcript reader, and it runs
// only when token-usage-report is explicitly asked for it (--compaction or
// --transcripts). The hooks and the SDK adapter still never read transcripts, and
// nothing here writes to the observability store, the spool, or any sink.
//
// It interprets `system` records alone:
//   - `compact_boundary`: trigger and token counts from compactMetadata.
//   - `fast-jev-compaction:` outcome notices: "kept N/M messages ... (X% reduction ...)"
//     and "fallback to built-in summary (...)".
// Every other record is dropped as soon as its type is known. The result holds
// numbers, fixed enums, and session/agent ids taken from file names: no message text,
// no tool names (jev "decisions:" lines are ignored), and no fallback error bodies.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JEV_PREFIX = 'fast-jev-compaction: ';
const LINE_MARKERS = Object.freeze(['"compact_boundary"', JEV_PREFIX]);
const TRIGGERS = Object.freeze(['auto', 'manual']);
const FALLBACK_REASONS = Object.freeze(['below_minimum', 'request_failed', 'other']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
const MAX_WALK_DEPTH = 3;

const KEPT_PATTERN = /^fast-jev-compaction: kept (\d+)\/(\d+) messages\b[^(]*\((\d+(?:\.\d+)?)% reduction\b/;
const FALLBACK_PATTERN = /^fast-jev-compaction: fallback\b/;
const BELOW_MINIMUM_PATTERN = /\(below (\d+(?:\.\d+)?)% minimum: (\d+(?:\.\d+)?)% reduction\b/;
const REQUEST_FAILED_PATTERN = /\(Jev request failed(?: \((\d{3})\))?/;

function round1(value) {
  return Math.round(value * 10) / 10;
}

function nonNegative(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function parseJevOutcome(content) {
  if (typeof content !== 'string' || !content.startsWith(JEV_PREFIX)) return null;
  const kept = KEPT_PATTERN.exec(content);
  if (kept) {
    return {
      kind: 'replacement',
      messages_kept: Number(kept[1]),
      messages_total: Number(kept[2]),
      reduction_percent: Number(kept[3]),
    };
  }
  if (!FALLBACK_PATTERN.test(content)) return null;
  const below = BELOW_MINIMUM_PATTERN.exec(content);
  if (below) {
    return { kind: 'fallback', reason: 'below_minimum', minimum_percent: Number(below[1]), reduction_percent: Number(below[2]), status_code: null };
  }
  const failed = REQUEST_FAILED_PATTERN.exec(content);
  if (failed) {
    return { kind: 'fallback', reason: 'request_failed', minimum_percent: null, reduction_percent: null, status_code: failed[1] ? Number(failed[1]) : null };
  }
  return { kind: 'fallback', reason: 'other', minimum_percent: null, reduction_percent: null, status_code: null };
}

function parseCompactBoundary(record) {
  if (!record || record.type !== 'system' || record.subtype !== 'compact_boundary') return null;
  const metadata = record.compactMetadata && typeof record.compactMetadata === 'object' ? record.compactMetadata : {};
  const pre = nonNegative(metadata.preTokens);
  const post = nonNegative(metadata.postTokens);
  return {
    trigger: TRIGGERS.includes(metadata.trigger) ? metadata.trigger : 'other',
    pre_tokens: pre,
    post_tokens: post,
    duration_ms: nonNegative(metadata.durationMs),
    reduction_percent: pre && post !== null && post <= pre ? round1(((pre - post) / pre) * 100) : null,
  };
}

function parseWindowBound(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${label} timestamp: ${value}`);
  return parsed;
}

function inWindow(timestamp, window) {
  if (window.since === null && window.until === null) return true;
  const at = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(at)) return false;
  if (window.since !== null && at < window.since) return false;
  if (window.until !== null && at >= window.until) return false;
  return true;
}

// window: { since, until } as epoch milliseconds or null (already validated).
function scanTranscript(text, window = { since: null, until: null }) {
  const events = { boundaries: [], replacements: [], fallbacks: [] };
  if (typeof text !== 'string' || !LINE_MARKERS.some((marker) => text.includes(marker))) return events;
  for (const line of text.split('\n')) {
    if (!LINE_MARKERS.some((marker) => line.includes(marker))) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || record.type !== 'system' || !inWindow(record.timestamp, window)) continue;
    if (record.subtype === 'compact_boundary') {
      events.boundaries.push(parseCompactBoundary(record));
      continue;
    }
    const outcome = parseJevOutcome(record.content);
    if (outcome?.kind === 'replacement') events.replacements.push(outcome);
    else if (outcome?.kind === 'fallback') events.fallbacks.push(outcome);
  }
  return events;
}

function mean(values) {
  return values.length ? round1(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function summarizeEvents(events) {
  const compactions = { total: events.boundaries.length, auto: 0, manual: 0, other: 0 };
  for (const boundary of events.boundaries) compactions[boundary.trigger] += 1;
  const preTokens = events.boundaries.map((boundary) => boundary.pre_tokens).filter((value) => value !== null);
  const boundaryReductions = events.boundaries.map((boundary) => boundary.reduction_percent).filter((value) => value !== null);
  const reductions = events.replacements.map((outcome) => outcome.reduction_percent);
  const fallbackReasons = Object.fromEntries(FALLBACK_REASONS.map((reason) => [reason, 0]));
  for (const outcome of events.fallbacks) fallbackReasons[outcome.reason] += 1;
  const outcomes = events.replacements.length + events.fallbacks.length;
  return {
    compactions,
    pre_tokens_max: preTokens.length ? Math.max(...preTokens) : null,
    pre_tokens_mean: mean(preTokens),
    boundary_reduction_percent_mean: mean(boundaryReductions),
    jev: {
      replacements: events.replacements.length,
      fallbacks: events.fallbacks.length,
      fallback_rate: outcomes ? Math.round((events.fallbacks.length / outcomes) * 1000) / 1000 : null,
      fallback_reasons: fallbackReasons,
      reduction_percent_mean: mean(reductions),
      reduction_percent_min: reductions.length ? Math.min(...reductions) : null,
      reduction_percent_max: reductions.length ? Math.max(...reductions) : null,
      messages_kept: events.replacements.reduce((sum, outcome) => sum + outcome.messages_kept, 0),
      messages_total: events.replacements.reduce((sum, outcome) => sum + outcome.messages_total, 0),
    },
  };
}

function hasEvents(events) {
  return events.boundaries.length + events.replacements.length + events.fallbacks.length > 0;
}

function listTranscriptFiles(directory, depth = 0, files = []) {
  if (depth > MAX_WALK_DEPTH) return files;
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    // Dirent type checks do not follow symlinks, so a linked file or directory is skipped.
    if (entry.isDirectory()) listTranscriptFiles(full, depth + 1, files);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full);
  }
  return files;
}

// Main sessions are <dir>/<session>.jsonl; subagents are <dir>/<session>/subagents/agent-<id>.jsonl.
function transcriptIdentity(transcriptDir, file) {
  const parts = path.relative(transcriptDir, file).split(path.sep);
  const stem = path.basename(file, '.jsonl');
  if (parts.length === 3 && parts[1] === 'subagents') {
    const agentId = stem.startsWith('agent-') ? stem.slice('agent-'.length) : stem;
    return { session_id: SAFE_ID.test(parts[0]) ? parts[0] : null, agent_id: SAFE_ID.test(agentId) ? agentId : null, kind: 'subagent' };
  }
  return { session_id: SAFE_ID.test(stem) ? stem : null, agent_id: null, kind: parts.length === 1 ? 'main' : 'other' };
}

function compareRows(left, right) {
  return String(left.session_id).localeCompare(String(right.session_id))
    || (left.agent_id === null ? -1 : 0) - (right.agent_id === null ? -1 : 0)
    || String(left.agent_id).localeCompare(String(right.agent_id));
}

function readCompactionOutcomes(options = {}) {
  const window = {
    since: parseWindowBound(options.since, '--since'),
    until: parseWindowBound(options.until, '--until'),
  };
  const transcriptDir = typeof options.transcriptDir === 'string' && options.transcriptDir ? path.resolve(options.transcriptDir) : null;
  if (!transcriptDir) return { available: false, reason: 'no transcript directory given' };
  let stat;
  try {
    stat = fs.statSync(transcriptDir);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) return { available: false, reason: `transcript directory not found: ${transcriptDir}` };

  const files = listTranscriptFiles(transcriptDir).sort();
  const transcripts = [];
  const all = { boundaries: [], replacements: [], fallbacks: [] };
  let unreadable = 0;
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      unreadable += 1;
      continue;
    }
    const events = scanTranscript(text, window);
    if (!hasEvents(events)) continue;
    for (const key of Object.keys(all)) all[key].push(...events[key]);
    transcripts.push({ ...transcriptIdentity(transcriptDir, file), ...summarizeEvents(events) });
  }
  transcripts.sort(compareRows);
  return {
    available: true,
    source: {
      transcript_dir: transcriptDir,
      files_scanned: files.length - unreadable,
      files_unreadable: unreadable,
      files_with_compaction: transcripts.length,
      window: { since: options.since || null, until: options.until || null },
    },
    transcripts,
    totals: { transcripts: transcripts.length, ...summarizeEvents(all) },
  };
}

// Claude Code stores a project's transcripts under <config>/projects/<cwd with every
// non-alphanumeric character replaced by '-'>. Very long paths are shortened by
// Claude Code itself; pass --transcripts for those.
function defaultTranscriptDir(projectPath, env = process.env, homedir = os.homedir()) {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(homedir, '.claude');
  return path.join(configDir, 'projects', path.resolve(projectPath).replace(/[^A-Za-z0-9]/g, '-'));
}

module.exports = {
  FALLBACK_REASONS,
  defaultTranscriptDir,
  parseCompactBoundary,
  parseJevOutcome,
  readCompactionOutcomes,
  scanTranscript,
  summarizeEvents,
};
