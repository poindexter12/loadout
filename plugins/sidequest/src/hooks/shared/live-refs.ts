// Shared by two runtimes: the classic Stop hook (Node) writes the live-refs file, and the
// session.compact function-hook module (hooks/fn/compaction.js, no Node) reads it. Keep this file
// free of node:* imports, since the module bundle is platform neutral and cannot resolve them.

/** Leads every recovery pin; both the module and PreCompact skip a pin that is already there. */
export const COMPACTION_RECOVERY_MARKER = 'sidequest compaction recovery v1';

/**
 * The `compactionGuard` plugin option (plugin.json userConfig).
 * - `off`: the module registers no hooks and the Stop hook writes nothing.
 * - `auto`: the module acts only once a trace shows a non-core compaction plugin beneath it.
 * - `on`: the module always pins and restores.
 */
export type CompactionGuardMode = 'off' | 'auto' | 'on';

/**
 * Off by default. `auto` changes no behaviour without a compaction plugin, but it is not free:
 * a transcript round trip through the hooks host on every compaction, a turn.complete dispatch
 * on every turn, and a board read in every Stop.
 */
export const COMPACTION_GUARD_DEFAULT: CompactionGuardMode = 'off';

export function compactionGuardMode(value: unknown): CompactionGuardMode {
  const mode = String(value ?? '').trim().toLowerCase();
  return mode === 'auto' || mode === 'on' || mode === 'off' ? mode : COMPACTION_GUARD_DEFAULT;
}

export const LIVE_REFS_VERSION = 1;

export interface LiveRefs {
  version: typeof LIVE_REFS_VERSION;
  /** The session the Stop hook wrote this for. */
  session: string;
  /** ISO time of the write. */
  at: string;
  /** The PreCompact recovery pin for this board, or '' when nothing is live. */
  pin: string;
  /**
   * Refs the board has closed (done or archived); their dispatch and briefing results are let go.
   * A ref absent here stays protected, including one dispatched after this file was written.
   */
  closed: string[];
}

function trimSlashes(value: string): string {
  return value.replace(/[\\/]+$/, '');
}

/** The central board store: SIDEQUEST_HOME when set, else <home>/.claude/sidequest. */
export function sidequestHome(sidequestHomeEnv: string | undefined, homeEnv: string | undefined): string {
  const explicit = String(sidequestHomeEnv || '').trim();
  if (explicit) return trimSlashes(explicit);
  const home = trimSlashes(String(homeEnv || '').trim());
  return home ? `${home}/.claude/sidequest` : '';
}

export function liveRefsPath(home: string, sessionId: string): string {
  return `${trimSlashes(home)}/live-refs/${encodeURIComponent(sessionId)}.json`;
}

export function serializeLiveRefs(session: string, pin: string, closed: readonly string[], at = new Date().toISOString()): string {
  const file: LiveRefs = { version: LIVE_REFS_VERSION, session, at, pin, closed: [...new Set(closed)].sort() };
  return `${JSON.stringify(file)}\n`;
}

/** Null for anything that is not a well-formed v1 file, so a reader never trusts a partial write. */
export function parseLiveRefs(text: string): LiveRefs | null {
  try {
    const parsed = JSON.parse(text) as Partial<LiveRefs> | null;
    if (!parsed || parsed.version !== LIVE_REFS_VERSION || !Array.isArray(parsed.closed)) return null;
    return {
      version: LIVE_REFS_VERSION,
      session: typeof parsed.session === 'string' ? parsed.session : '',
      at: typeof parsed.at === 'string' ? parsed.at : '',
      pin: typeof parsed.pin === 'string' ? parsed.pin : '',
      closed: parsed.closed.filter((ref): ref is string => typeof ref === 'string' && ref.length > 0),
    };
  } catch (_) {
    return null;
  }
}
