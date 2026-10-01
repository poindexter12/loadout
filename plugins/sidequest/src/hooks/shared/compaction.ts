import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSidequestHome } from '../../lib/claude-home.js';
import { isSubagent } from './input.js';
import { runtimeModule } from './paths.js';

const CLOSED_TICKETS_THRESHOLD = 3;
const TRANSCRIPT_BYTES_THRESHOLD = 3 * 1024 * 1024;
const RETRY_MULTIPLIER = 2;

interface CompactionState {
  resetAt: string;
  ticketBaselineAt: string;
  transcriptBytes: number;
  suggestedAt?: string;
  // SQ-195: set at PostCompact. The engine re-appends jev's kept history to the transcript JSONL
  // (530KB-1.0MB observed) sometime between PostCompact and the first Stop, so the transcript
  // byte count recorded at PostCompact time undercounts what the transcript will actually be once
  // the session resumes. While this flag is set, the transcript baseline is not yet trustworthy:
  // the first Stop after a compaction consumes it, records the post-reappend size as the real
  // baseline, and skips the suggestion for that turn. Real growth measured after that baseline is
  // established still counts normally.
  baselinePending?: boolean;
}

interface Store {
  nearestRepoRoot: (start: string) => string;
  findProject: (start: string) => { ok: boolean; slug?: string; meta?: { path?: string } };
  listTickets: (slug: string) => any[];
  claimReclaimable: (ticket: any) => boolean;
}

function disabledValue(value: unknown): boolean {
  return ['0', 'false', 'no', 'off'].includes(String(value || '').trim().toLowerCase());
}

export function compactionSuggestionsEnabled(): boolean {
  return !disabledValue(process.env.SIDEQUEST_COMPACTION_SUGGESTIONS);
}

export function isPrimarySession(input: Record<string, unknown>): boolean {
  return !isSubagent(input);
}

function stateDirectory(): string {
  const home = resolveSidequestHome();
  return path.join(home, 'compaction-suggestions');
}

function stateFile(sessionId: string): string {
  return path.join(stateDirectory(), `${encodeURIComponent(sessionId)}.json`);
}

function transcriptBytes(transcriptPath: unknown): number {
  try {
    return fs.statSync(String(transcriptPath || '')).size;
  } catch (_) {
    return 0;
  }
}

function readState(sessionId: string, currentBytes: number): CompactionState {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(sessionId), 'utf8')) as CompactionState;
    if (parsed && Number.isFinite(parsed.transcriptBytes) && Number.isFinite(Date.parse(parsed.resetAt))) {
      return { ...parsed, ticketBaselineAt: parsed.ticketBaselineAt || parsed.resetAt };
    }
  } catch (_) {}
  const now = new Date().toISOString();
  return { resetAt: now, ticketBaselineAt: now, transcriptBytes: currentBytes };
}

function writeState(sessionId: string, state: CompactionState): boolean {
  try {
    fs.mkdirSync(stateDirectory(), { recursive: true });
    fs.writeFileSync(stateFile(sessionId), JSON.stringify(state));
    return true;
  } catch (_) {
    return false;
  }
}

export function initializeCompactionState(sessionId: string, transcriptPath: unknown): void {
  if (!sessionId || !compactionSuggestionsEnabled()) return;
  const file = stateFile(sessionId);
  if (fs.existsSync(file)) return;
  const now = new Date().toISOString();
  writeState(sessionId, { resetAt: now, ticketBaselineAt: now, transcriptBytes: transcriptBytes(transcriptPath) });
}

export function resetCompactionState(sessionId: string, transcriptPath: unknown): void {
  if (!sessionId) return;
  const now = new Date().toISOString();
  writeState(sessionId, {
    resetAt: now,
    ticketBaselineAt: now,
    transcriptBytes: transcriptBytes(transcriptPath),
    baselinePending: true,
  });
}

// SQ-197: a "replacement" compaction (PostCompact's compact_summary === '') means the host kept
// the transcript's non-tool messages verbatim rather than summarizing them, so any prior
// SessionStart re-grounding (this plugin's board context, plus codebase-mapper's map and
// live-rules' rule set) is still sitting in history. Re-emitting it in full duplicates that
// content every replacement compaction. This marker lets the SessionStart(compact) hooks in all
// three plugins detect that case and emit a short note instead.
//
// The path formula and the age-bounded peek below are duplicated (not imported) in
// codebase-mapper's inject-context.js and live-rules' session-start-rules.js — plugins don't import
// each other's code — so they must stay exactly in sync there. The path takes SIDEQUEST_HOME (any
// subprocess in the session can read this env var, regardless of which plugin defines it) first,
// then CLAUDE_CONFIG_DIR-rooted, never a bare hardcoded ~/.claude (multi-account setups point
// CLAUDE_CONFIG_DIR elsewhere; see claude-home.ts).
function replacementMarkerHome(): string {
  const sidequestHome = String(process.env.SIDEQUEST_HOME || '').trim();
  if (sidequestHome) return sidequestHome;
  const configDir = String(process.env.CLAUDE_CONFIG_DIR || '').trim();
  return path.join(configDir || path.join(os.homedir(), '.claude'), 'sidequest');
}

function replacementMarkerFile(sessionId: string): string {
  return path.join(replacementMarkerHome(), 'replacement-compactions', `${encodeURIComponent(sessionId)}.json`);
}

// SQ-200: Claude Code runs one event's hooks in parallel, so all three SessionStart(compact)
// readers race each other. None of them may delete the marker on read, or whichever reader runs
// first silently decides what the other two see. Every reader peeks with the same 2-minute age
// bound, measured from the marker's mtime (the predicate codebase-mapper and live-rules duplicate as
// REPLACEMENT_MARKER_MAX_AGE_MS), so a marker a crashed or skipped PostCompact left behind cannot
// suppress a later re-grounding.

// PostCompact, in sidequest (the only one of the three plugins with a PostCompact hook), is the
// marker's single writer and its only deleter. It runs on every compaction: it first removes any
// marker an earlier compaction left, so a summarized compaction inside the age bound cannot inherit
// it, then writes a fresh timestamped marker only when this compaction was a replacement.
export function recordReplacementCompaction(sessionId: string, replacement: boolean): void {
  if (!sessionId) return;
  const file = replacementMarkerFile(sessionId);
  try {
    fs.rmSync(file, { force: true });
  } catch (_) {
    // An unremovable marker still ages out of every reader's bound.
  }
  if (!replacement) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString() }));
  } catch (_) {
    // A missed marker only costs one skipped short-circuit; the full re-grounding still runs.
  }
}

// A non-destructive peek, identical in all three plugins. The bound lives inside the function so
// esbuild does not copy an unused constant into every hook bundle that imports this module.
export function isReplacementCompaction(sessionId: string): boolean {
  if (!sessionId) return false;
  const REPLACEMENT_MARKER_MAX_AGE_MS = 2 * 60 * 1000;
  try {
    const stat = fs.statSync(replacementMarkerFile(sessionId));
    return Date.now() - stat.mtimeMs <= REPLACEMENT_MARKER_MAX_AGE_MS;
  } catch (_) {
    return false;
  }
}

function completionAt(ticket: any): number {
  const values = [ticket?.submission?.integratedAt, ticket?.completion?.at, ticket?.updatedAt];
  for (const value of values) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

function versionFor(ticket: any): string {
  const text = Array.isArray(ticket?.comments) ? ticket.comments.map((comment: any) => String(comment?.body || '')).join('\n') : '';
  const matched = text.match(/\b(?:sidequest|release)\s+v?(\d+\.\d+\.\d+)\b/i);
  if (matched?.[1]) return `v${matched[1]}`;
  const commit = String(ticket?.submission?.commit || '').trim();
  return commit ? commit.slice(0, 10) : 'closed';
}

function recentlyClosed(tickets: any[], resetAt: string): any[] {
  const since = Date.parse(resetAt);
  return tickets.filter((ticket) => ticket?.status === 'done' && completionAt(ticket) >= since);
}

function closedAfter(tickets: any[], baselineAt: string): any[] {
  const since = Date.parse(baselineAt);
  return tickets.filter((ticket) => ticket?.status === 'done' && completionAt(ticket) > since);
}

function activeBoardWork(tickets: any[], liveClaimRefs: Set<string>): boolean {
  return tickets.some((ticket) => {
    if (ticket?.status === 'doing' && liveClaimRefs.has(ticket.ref)) return true;
    return Boolean(ticket?.dispatch && !ticket.dispatch.terminalAt);
  });
}

function projectFor(cwd: string): { slug: string; path: string } | null {
  try {
    const store = require(runtimeModule('store')) as Store;
    const found = store.findProject(store.nearestRepoRoot(cwd));
    if (!found.ok || !found.slug || !found.meta?.path) return null;
    return { slug: found.slug, path: found.meta.path };
  } catch (_) {
    return null;
  }
}

async function publishLockHeld(repoPath: string): Promise<boolean> {
  try {
    const publish = require(runtimeModule('publish')) as { publishLockStatus: (path: string) => Promise<{ locked?: boolean }> };
    return Boolean((await publish.publishLockStatus(repoPath)).locked);
  } catch (_) {
    return false;
  }
}

function byteLabel(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function compactedRefs(tickets: any[]): string {
  return tickets.slice(0, 5).map((ticket) => `${ticket.ref} (${versionFor(ticket)})`).join(', ') + (tickets.length > 5 ? `, +${tickets.length - 5} more` : '');
}

export async function compactionSuggestion(input: Record<string, unknown>): Promise<string | null> {
  if (!compactionSuggestionsEnabled() || !isPrimarySession(input)) return null;
  const sessionId = String(input.session_id || input.sessionId || process.env.CLAUDE_CODE_SESSION_ID || '').trim();
  if (!sessionId) return null;

  const currentBytes = transcriptBytes(input.transcript_path || input.transcriptPath);
  const state = readState(sessionId, currentBytes);

  // SQ-195: the transcript baseline recorded at PostCompact predates the engine's re-append of
  // jev's kept history, so it undercounts the transcript's real post-compaction size. The first
  // Stop after a compaction just re-baselines against the current (post-reappend) size instead of
  // treating that reappend as growth; it never suggests on this turn.
  if (state.baselinePending) {
    state.baselinePending = false;
    state.transcriptBytes = currentBytes;
    writeState(sessionId, state);
    return null;
  }

  const project = projectFor(String(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()));
  if (!project) return null;

  try {
    const store = require(runtimeModule('store')) as Store;
    const tickets = store.listTickets(project.slug);
    const liveClaimRefs = new Set(tickets
      .filter((ticket) => ticket.claim?.by && !store.claimReclaimable(ticket) && ticket.ref)
      .map((ticket) => String(ticket.ref)));
    if (activeBoardWork(tickets, liveClaimRefs) || await publishLockHeld(project.path)) return null;

    const closed = recentlyClosed(tickets, state.resetAt);
    const newlyClosed = closedAfter(tickets, state.ticketBaselineAt);
    const growth = Math.max(0, currentBytes - state.transcriptBytes);
    const multiplier = state.suggestedAt ? RETRY_MULTIPLIER : 1;
    const enoughClosed = newlyClosed.length >= CLOSED_TICKETS_THRESHOLD * multiplier;
    const enoughTranscript = growth >= TRANSCRIPT_BYTES_THRESHOLD * multiplier;
    if (!enoughClosed && !enoughTranscript) return null;

    const now = new Date().toISOString();
    state.suggestedAt = now;
    state.ticketBaselineAt = now;
    state.transcriptBytes = currentBytes;
    if (!writeState(sessionId, state)) return null;
    const accumulated = [
      closed.length ? `Closed/shipped: ${compactedRefs(closed)}.` : '',
      growth ? `Transcript growth: ${byteLabel(growth)}.` : '',
    ].filter(Boolean).join(' ');
    return [
      'sidequest: compaction is safe at this boundary.',
      accumulated,
      'Safe to lose: completed-ticket screenshots, CI output, superseded dispatch chatter.',
      'Keep: open ticket specs, board decisions, and pending submission details. Run /compact when ready.',
    ].join('\n');
  } catch (_) {
    return null;
  }
}
