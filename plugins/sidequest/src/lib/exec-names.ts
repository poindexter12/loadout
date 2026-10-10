export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'] as const);
export type Effort = (typeof EFFORTS)[number];

export const CLAUDE_PREFIX = 'sidequest-exec-';
export const DISPATCH_PREFIX = 'sidequest-exec-dispatch-';
export const READ_ONLY_CLAUDE_PREFIX = 'sidequest-exec-readonly-';
export const READ_ONLY_DISPATCH_PREFIX = 'sidequest-exec-dispatch-readonly-';
// Runtime per-(model, effort) codex executors (SQ-300). These pin the PUBLISHED
// model id in `model:` frontmatter and the effort in `effort:` frontmatter, so
// neither half needs the route marker. They are written at runtime into the user
// agent directory (external models are discovered at runtime, so they cannot be
// bundled at build time) and are therefore deliberately absent from
// BUNDLED_AGENT_NAMES: a user-scoped definition is never namespaced `sidequest:`.
export const CODEX_PIN_PREFIX = 'sidequest-exec-codex-';
export const READ_ONLY_CODEX_PIN_PREFIX = 'sidequest-exec-codex-readonly-';
export const TICKET_PREFIX = 'sidequest-sq-';
export const LEGACY_TICKET_PREFIX = 'sidequest-ticket-';
export const DIAGNOSTIC_PROBE_NAME = 'sidequest-diagnostic-probe';

export type ExecutorKind = 'codex_dispatch' | 'claude_builtin' | 'read_only_codex_dispatch' | 'read_only_claude_builtin' | 'ticket' | 'legacy_ticket' | 'unknown';
export interface ExecutorClassification {
  kind: ExecutorKind;
  effort: Effort | null;
}

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value);
}

// Claude Code validates the Agent `name` parameter against
// /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, so 64 is a hard ceiling. The launch names
// below stay far shorter: the native agent list truncates, and a name only earns
// its place there by being readable at a glance.
export const AGENT_NAME_MAX_LENGTH = 64;
const LAUNCH_SLUG_MAX_WORDS = 3;
const LAUNCH_SLUG_MAX_LENGTH = 24;
const ROUTE_MODEL_TOKEN_MAX_LENGTH = 24;

// Filler words spend the slug budget without distinguishing one ticket from
// another, so they are dropped before the budget is counted.
const LAUNCH_SLUG_FILLER = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'in', 'into', 'is', 'it',
  'its', 'of', 'on', 'or', 'over', 'per', 'that', 'the', 'their', 'then', 'this', 'to', 'under',
  'via', 'when', 'while', 'with', 'without',
]);

function slugTokens(value: unknown): string[] {
  return String(value == null ? '' : value)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

export function refSlug(ref: unknown): string {
  return slugTokens(ref).join('-');
}

export function titleSlug(title: unknown): string {
  const tokens = slugTokens(title);
  const meaningful = tokens.filter((token) => !LAUNCH_SLUG_FILLER.has(token));
  const chosen = (meaningful.length ? meaningful : tokens).slice(0, LAUNCH_SLUG_MAX_WORDS);
  let slug = '';
  for (const token of chosen) {
    const next = slug ? `${slug}-${token}` : token;
    if (next.length > LAUNCH_SLUG_MAX_LENGTH) break;
    slug = next;
  }
  if (!slug && chosen.length) slug = String(chosen[0]).slice(0, LAUNCH_SLUG_MAX_LENGTH);
  return slug;
}

function routeModelToken(resolvedExec: unknown): string {
  if (!resolvedExec || typeof resolvedExec !== 'object') return '';
  const exec = resolvedExec as Record<string, unknown>;
  const isClaude = exec.backend === 'claude';
  const value = isClaude
    ? String(exec.runsModel || exec.dispatchModel || '')
    : String(exec.runsLabel || exec.dispatchModel || exec.runsModel || '');
  const tokens = slugTokens(value).filter((token) => !isClaude || token !== 'claude');
  const token = isClaude ? tokens.join('-') : tokens.at(-1) || '';
  return token.slice(0, ROUTE_MODEL_TOKEN_MAX_LENGTH);
}

/**
 * The name a Sidequest launch carries in Claude Code's native agent list.
 * Deterministic from board state alone: ticket ref, title, resolved execution
 * route, and dispatch sequence. Sequence 1 is unsuffixed; a redispatch counts up
 * (`sq-843-release-engine-terra-high-2`) so it never shadows a live sibling.
 */
export function dispatchLaunchName(ref: unknown, title?: unknown, resolvedExec?: unknown, effort?: unknown, sequence?: unknown): string {
  const base = refSlug(ref) || 'sidequest';
  const model = routeModelToken(resolvedExec);
  const routeEffort = isEffort(effort) ? effort : '';
  const route = [model, routeEffort].filter(Boolean);
  const seq = Number(sequence);
  const suffix = Number.isInteger(seq) && seq > 1 ? `-${seq}` : '';
  const fixedName = [base, ...route].join('-') + suffix;
  const availableTitleLength = AGENT_NAME_MAX_LENGTH - fixedName.length - 1;
  const slug = titleSlug(title).slice(0, Math.max(availableTitleLength, 0)).replace(/-+$/, '');
  return slug ? [base, slug, ...route].join('-') + suffix : fixedName;
}

// Codex dispatch executors are effort-collapsed: the gateway resolves BOTH model and
// effort from the [sidequest-route model=... effort=...] marker in the briefing and
// overwrites the request's output_config.effort, so a per-effort definition ladder on
// this side carried five copies of dead frontmatter (verified on the wire 2026-08-02:
// a def pinned to effort low produced effort=xhigh when the marker said so). Claude
// executors keep the per-effort ladder because the Agent tool has no effort parameter,
// leaving frontmatter as the only carrier.
export const DISPATCH_NAME = 'sidequest-exec-dispatch';
export const READ_ONLY_DISPATCH_NAME = 'sidequest-exec-dispatch-readonly';

export function stableClaudeName(effort: Effort): string {
  return `${CLAUDE_PREFIX}${effort}`;
}

export function stableDispatchName(_effort?: Effort): string {
  return DISPATCH_NAME;
}

export function stableReadOnlyClaudeName(effort: Effort): string {
  return `${READ_ONLY_CLAUDE_PREFIX}${effort}`;
}

export function stableReadOnlyDispatchName(_effort?: Effort): string {
  return READ_ONLY_DISPATCH_NAME;
}

// A pin token must be a single name-safe segment, and must not open with the
// `readonly-` segment the read-only family uses, or a write-capable name would
// land inside the read-only namespace and classify as read-only. Both ends must
// be alphanumeric: a trailing hyphen would make `<token>-<effort>` carry a double
// separator, which dispatchPinToken never produces and which only obscures where
// the token ends.
const PIN_TOKEN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function assertPinToken(token: unknown): string {
  const safe = String(token == null ? '' : token);
  if (!PIN_TOKEN_RE.test(safe)) throw new Error(`dispatch pin token is not name-safe: ${token}`);
  if (safe === 'readonly' || safe.startsWith('readonly-')) throw new Error(`dispatch pin token collides with the read-only namespace: ${token}`);
  return safe;
}

/**
 * The name token for a published external model id. Derived from the PUBLISHED
 * id (`claude-gpt-5.6-terra[1m]` -> `gpt-5-6-terra-1m`) rather than the board
 * slug, so the definition name tracks the thing actually pinned in its
 * frontmatter. Returns '' when there is no usable id.
 *
 * Every non-alphanumeric run folds to one `-`, INCLUDING a context-window
 * suffix. Dropping `[1m]` the way dispatchModelFor does would be wrong here: the
 * marker names a model, but this names a FILE, and a gateway that publishes both
 * `claude-gpt-5.6-terra` and `claude-gpt-5.6-terra[1m]` would then collapse two
 * distinct routes onto one pin, so whichever synced last would silently answer
 * for both.
 */
export function dispatchPinToken(apiModel: unknown): string {
  return String(apiModel == null ? '' : apiModel)
    .toLowerCase()
    .replace(/^claude-(?:codex-)?/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function stablePinnedDispatchName(token: unknown, effort: Effort): string {
  if (!isEffort(effort)) throw new Error(`dispatch pin effort is invalid: ${effort}`);
  return `${CODEX_PIN_PREFIX}${assertPinToken(token)}-${effort}`;
}

export function stableReadOnlyPinnedDispatchName(token: unknown, effort: Effort): string {
  if (!isEffort(effort)) throw new Error(`dispatch pin effort is invalid: ${effort}`);
  return `${READ_ONLY_CODEX_PIN_PREFIX}${assertPinToken(token)}-${effort}`;
}

function pinClassification(remainder: string, kind: ExecutorKind): ExecutorClassification {
  const split = remainder.lastIndexOf('-');
  if (split <= 0) return { kind: 'ticket', effort: null };
  const effort = remainder.slice(split + 1);
  const token = remainder.slice(0, split);
  if (!isEffort(effort) || !PIN_TOKEN_RE.test(token)) return { kind: 'ticket', effort: null };
  return { kind, effort };
}

const BUNDLED_AGENT_NAMES = new Set([
  DISPATCH_NAME,
  READ_ONLY_DISPATCH_NAME,
  DIAGNOSTIC_PROBE_NAME,
  ...EFFORTS.map(stableClaudeName),
  ...EFFORTS.map(stableReadOnlyClaudeName),
]);
const PLUGIN_NAMESPACE = 'sidequest:';

export function canonicalExecutorName(name: string): string {
  if (!name.startsWith(PLUGIN_NAMESPACE)) return name;
  const unqualifiedName = name.slice(PLUGIN_NAMESPACE.length);
  return BUNDLED_AGENT_NAMES.has(unqualifiedName) ? unqualifiedName : name;
}

export function bundledAgentType(name: string): string {
  const canonicalName = canonicalExecutorName(name);
  return BUNDLED_AGENT_NAMES.has(canonicalName) ? `${PLUGIN_NAMESPACE}${canonicalName}` : name;
}

export function isReadOnlyExecutor(name: unknown): boolean {
  const kind = classify(name).kind;
  return kind === 'read_only_codex_dispatch' || kind === 'read_only_claude_builtin';
}

export function classify(value: unknown): ExecutorClassification {
  if (typeof value !== 'string' || !value) return { kind: 'unknown', effort: null };
  const name = canonicalExecutorName(value);

  // The collapsed names carry no effort; the dispatch marker does. Checked before the
  // prefix rules because READ_ONLY_DISPATCH_NAME is a proper prefix-collision with
  // DISPATCH_PREFIX ('...dispatch-readonly' starts with '...dispatch-').
  if (name === READ_ONLY_DISPATCH_NAME) return { kind: 'read_only_codex_dispatch', effort: null };
  if (name === DISPATCH_NAME) return { kind: 'codex_dispatch', effort: null };
  if (name === DIAGNOSTIC_PROBE_NAME) return { kind: 'unknown', effort: null };

  // Runtime published-id pins (SQ-300) carry BOTH halves in frontmatter, so their
  // names carry the effort too. Checked before the generic CLAUDE_PREFIX rule,
  // which would otherwise swallow them as 'ticket' and have force-exec-bypass deny
  // the spawn as "invalid or retired". Read-only first: its prefix collides with
  // the write-capable one.
  if (name.startsWith(READ_ONLY_CODEX_PIN_PREFIX)) {
    return pinClassification(name.slice(READ_ONLY_CODEX_PIN_PREFIX.length), 'read_only_codex_dispatch');
  }
  if (name.startsWith(CODEX_PIN_PREFIX)) {
    return pinClassification(name.slice(CODEX_PIN_PREFIX.length), 'codex_dispatch');
  }

  // Pre-collapse records still name per-effort executors; classifying them keeps old
  // dispatch records readable so the board can heal by redispatch instead of erroring.
  if (name.startsWith(READ_ONLY_DISPATCH_PREFIX)) {
    const effort = name.slice(READ_ONLY_DISPATCH_PREFIX.length);
    if (isEffort(effort)) return { kind: 'read_only_codex_dispatch', effort };
    return { kind: 'ticket', effort: null };
  }
  if (name.startsWith(READ_ONLY_CLAUDE_PREFIX)) {
    const effort = name.slice(READ_ONLY_CLAUDE_PREFIX.length);
    if (isEffort(effort)) return { kind: 'read_only_claude_builtin', effort };
    return { kind: 'ticket', effort: null };
  }
  if (name.startsWith(DISPATCH_PREFIX)) {
    const effort = name.slice(DISPATCH_PREFIX.length);
    if (isEffort(effort)) return { kind: 'codex_dispatch', effort };
    return { kind: 'ticket', effort: null };
  }
  if (name.startsWith(CLAUDE_PREFIX)) {
    const effort = name.slice(CLAUDE_PREFIX.length);
    if (isEffort(effort)) return { kind: 'claude_builtin', effort };
    return { kind: 'ticket', effort: null };
  }
  if (name.startsWith(TICKET_PREFIX)) return { kind: 'ticket', effort: null };
  if (name.startsWith(LEGACY_TICKET_PREFIX)) return { kind: 'legacy_ticket', effort: null };
  return { kind: 'unknown', effort: null };
}
