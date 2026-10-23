'use strict';

// Filtered, sanitized ticket -> GitHub issue mirror.
//
// Two rules decide everything here, and both are enforced in code rather than
// left to the caller:
//
// 1. Default deny on FIELDS. The issue is rendered from MIRRORED_FIELDS only.
//    A field added to a ticket later cannot start being published by accident,
//    which is the failure mode a whole-record scrubber has and an allow-list
//    does not.
// 2. Default deny on CONTENT. Whatever those two fields carry is still run
//    through REDACTION_CLASSES, and a rendering that still trips a class after
//    redaction is dropped rather than published.
//
// The board holds real local paths, session ids, costs and other projects'
// names across every board on the machine. A public issue tracker is the same
// exposure as a committed screenshot, so it gets the same treatment.

export type GhExecutor = ((program: string, arguments_: string[], options?: Record<string, unknown>) => unknown) & { lastError?: string };

export type MirrorTicket = Readonly<{
  id: string;
  ref: string;
  title?: string;
  description?: string;
  status?: string;
  archived?: boolean | number;
  labels?: readonly string[];
  category?: unknown;
  categoryId?: string;
  storyId?: string | null;
}>;

type MirrorLink = Readonly<{ ticketId: string; provider: string }>;

export type IssueMirrorConfig = Readonly<{
  enabled: boolean;
  labels: readonly string[];
  categories: readonly string[];
  stories: readonly string[];
  labelMap: Readonly<Record<string, string>>;
}>;

/** Everything the sanitizer needs that cannot be derived from the ticket itself. */
export type MirrorContext = Readonly<{ hostname?: string; foreignProjects?: readonly string[] }>;

export type MirrorCreation = Readonly<{ ticketId: string; ref: string; repo: string; title: string; body: string; labels: readonly string[] }>;
export type MirrorSkip = Readonly<{ ticketId: string; ref: string; reason: string }>;
export type IssueMirrorPlan = Readonly<{ creations: readonly MirrorCreation[]; skipped: readonly MirrorSkip[]; warnings: readonly string[] }>;
export type MirrorApplyResult = Readonly<{ repo: string; number: number; action: string; ok: boolean; ref?: string; url?: string; error?: string }>;

/** The only ticket fields that may ever reach GitHub. Default deny: adding a field here is a deliberate act. */
export const MIRRORED_FIELDS = Object.freeze(['title', 'description'] as const);

export const REDACTED = '[redacted]';
const TITLE_MAX = 200;
const BODY_MAX = 60_000;

/**
 * Categories whose work is internal by nature. A ticket in one of these never
 * mirrors on a label match alone; the board has to name the category outright.
 */
const INTERNAL_CATEGORY_PATTERN = /(^|[.\-_])(review|audit|investigation|research|lookup|recon|explore|exploration|plan|planning|grooming|groom|readonly|read-only|triage|chore|infra|release)([.\-_]|$)/i;

type RedactionRule = Readonly<{ id: string; pattern: RegExp }>;

/**
 * Each entry is a published deny class. Order matters: the narrow identity
 * patterns run before the generic board-ref one so `sq-98-exec-ab12` is redacted
 * as a claim owner rather than leaving `-exec-ab12` behind.
 */
const STATIC_RULES: readonly RedactionRule[] = Object.freeze([
  Object.freeze({ id: 'home-path', pattern: /(?:\$HOME|~)\/[^\s"'`)\]]*/g }),
  Object.freeze({ id: 'absolute-path', pattern: /(?:[A-Za-z]:[\\/][^\s"'`)\]]*)|(?:(?<![\w.:~])\/[A-Za-z0-9._-]+\/[A-Za-z0-9._\-/]*)/g }),
  Object.freeze({ id: 'session-id', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi }),
  Object.freeze({ id: 'dispatch-token', pattern: /\b(?:token|tokenfile|token-file|secret|api[_-]?key|bearer)\b\s*[:=]?\s*\S+/gi }),
  Object.freeze({ id: 'opaque-identifier', pattern: /\b[0-9a-f]{24,}\b/gi }),
  Object.freeze({ id: 'cost', pattern: /(?:\$\s?\d[\d,]*(?:\.\d+)?)|(?:\b\d[\d,.]*\s?(?:USD|usd)\b)|(?:\b[\d,.]+[kKmM]?\s?tokens?\b)|(?:\b(?:cost|spend|usage|budget)\b\s*[:=]\s*\S+)/g }),
  Object.freeze({ id: 'hostname', pattern: /\b[A-Za-z0-9][A-Za-z0-9-]*\.(?:local|lan|internal|home\.arpa)\b/gi }),
  Object.freeze({ id: 'claim-owner', pattern: /\b(?:(?:sq|us)-\d+-[A-Za-z0-9][A-Za-z0-9-]*)|(?:(?:orchestrator|executor|agent|worktree-agent)-[0-9a-z]{6,})|(?:sidequest-exec-[a-z0-9-]+)\b/gi }),
  Object.freeze({ id: 'board-slug', pattern: /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)*-[0-9a-f]{8}\b/g }),
  Object.freeze({ id: 'board-ref', pattern: /\b(?:SQ|US)-\d+\b/gi }),
]);

/** The deny classes this module enforces, in the order they are applied. */
export const REDACTION_CLASSES: readonly string[] = Object.freeze([...STATIC_RULES.map((rule) => rule.id), 'machine-hostname', 'foreign-project']);

function literalRule(id: string, values: readonly string[]): RedactionRule | null {
  const terms = [...new Set(values.map((value) => String(value || '').trim()).filter((value) => value.length >= 3))]
    .sort((left, right) => right.length - left.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return terms.length ? Object.freeze({ id, pattern: new RegExp(`(?<![\\w-])(?:${terms.join('|')})(?![\\w-])`, 'gi') }) : null;
}

function rulesFor(context: MirrorContext | undefined): readonly RedactionRule[] {
  const extra: RedactionRule[] = [];
  const hostname = String(context?.hostname || '').trim();
  const hostRule = hostname ? literalRule('machine-hostname', [hostname, hostname.split('.')[0] || '']) : null;
  if (hostRule) extra.push(hostRule);
  const foreignRule = literalRule('foreign-project', context?.foreignProjects || []);
  if (foreignRule) extra.push(foreignRule);
  return [...STATIC_RULES, ...extra];
}

/** Keeps public links intact while the deny classes run over everything around them. */
function protectUrls(text: string): { text: string; restore: (value: string) => string } {
  const urls: string[] = [];
  const masked = text.replace(/https?:\/\/[^\s<>"'`)\]]+/g, (url) => {
    urls.push(url);
    return `\u0000URL${urls.length - 1}\u0000`;
  });
  return { text: masked, restore: (value: string) => value.replace(/\u0000URL(\d+)\u0000/g, (_match, index) => urls[Number(index)] || '') };
}

/** Deny classes that fire on this text. Exported so a caller can prove a class is reachable. */
export function redactionClassesFor(text: string, context?: MirrorContext): readonly string[] {
  const { text: masked } = protectUrls(String(text || ''));
  return Object.freeze(rulesFor(context).filter((rule) => { rule.pattern.lastIndex = 0; return rule.pattern.test(masked); }).map((rule) => rule.id));
}

/** Applies every deny class. Public http(s) links survive; everything a class matches does not. */
export function sanitizeText(text: string, context?: MirrorContext): string {
  const { text: masked, restore } = protectUrls(String(text || ''));
  let value = masked;
  for (const rule of rulesFor(context)) {
    rule.pattern.lastIndex = 0;
    value = value.replace(rule.pattern, REDACTED);
  }
  return restore(value).replace(new RegExp(`(?:${REDACTED.replace(/[[\]]/g, '\\$&')})(?:\\s*${REDACTED.replace(/[[\]]/g, '\\$&')})+`, 'g'), REDACTED).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export function defaultIssueMirror(): IssueMirrorConfig {
  return Object.freeze({ enabled: false, labels: Object.freeze([]), categories: Object.freeze([]), stories: Object.freeze([]), labelMap: Object.freeze({ bug: 'bug', feature: 'enhancement' }) });
}

function categoryId(ticket: MirrorTicket): string {
  const value = ticket.category;
  if (value == null) return String(ticket.categoryId || '');
  if (typeof value === 'object') return String(ticket.categoryId || (value as { id?: unknown }).id || '');
  return String(value);
}

function ticketLabels(ticket: MirrorTicket): string[] {
  return Array.isArray(ticket.labels) ? ticket.labels.map((label) => String(label || '').trim().toLowerCase()).filter(Boolean) : [];
}

/** Filter decision for one ticket. Internal categories need an explicit listing, never a label alone. */
export function mirrorMatches(ticket: MirrorTicket, config: IssueMirrorConfig): boolean {
  if (!config.enabled) return false;
  if (ticket.archived) return false;
  const category = categoryId(ticket).toLowerCase();
  const categories = config.categories.map((value) => String(value).toLowerCase());
  if (category && categories.includes(category)) return true;
  if (category && INTERNAL_CATEGORY_PATTERN.test(category)) return false;
  const labels = ticketLabels(ticket);
  if (config.labels.some((label) => labels.includes(String(label).toLowerCase()))) return true;
  return Boolean(ticket.storyId) && config.stories.includes(String(ticket.storyId));
}

function githubLabels(ticket: MirrorTicket, config: IssueMirrorConfig): string[] {
  const map = new Map(Object.entries(config.labelMap || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return [...new Set(ticketLabels(ticket).map((label) => map.get(label)).filter((label): label is string => Boolean(label)))].sort();
}

/**
 * Renders the issue from MIRRORED_FIELDS only, then refuses its own output if
 * any deny class still fires. Returns a reason instead of a rendering when the
 * ticket cannot be published safely.
 */
export function renderMirrorIssue(ticket: MirrorTicket, config: IssueMirrorConfig, context?: MirrorContext): { title: string; body: string; labels: readonly string[] } | { reason: string } {
  const title = sanitizeText(String(ticket.title || ''), context).slice(0, TITLE_MAX).trim();
  if (!title || title === REDACTED) return { reason: 'title is empty after sanitization' };
  if (title.includes(REDACTED)) return { reason: 'title contains sanitized content' };
  const description = sanitizeText(String(ticket.description || ''), context).slice(0, BODY_MAX).trim();
  const body = description || title;
  const residue = [...new Set([...redactionClassesFor(title, context), ...redactionClassesFor(body.replace(/\[redacted\]/g, ''), context)])];
  if (residue.length) return { reason: `sanitized rendering still matches ${residue.join(', ')}` };
  return { title, body, labels: Object.freeze(githubLabels(ticket, config)) };
}

/** Report-only. Never runs a GitHub command, so the SessionStart handoff costs nothing extra. */
export function planIssueMirror({ tickets, links, config, repo, context }: Readonly<{ tickets: readonly MirrorTicket[]; links: readonly MirrorLink[]; config?: IssueMirrorConfig | null; repo?: string | null; context?: MirrorContext }>): IssueMirrorPlan {
  const empty = Object.freeze({ creations: Object.freeze([]), skipped: Object.freeze([]), warnings: Object.freeze([]) }) as IssueMirrorPlan;
  if (!config || !config.enabled) return empty;
  if (!repo) return Object.freeze({ creations: Object.freeze([]), skipped: Object.freeze([]), warnings: Object.freeze(['issue mirror is on but the project has no GitHub origin repo; no issues were planned.']) });
  const alreadyLinked = new Set(links.filter((link) => link.provider === 'github').map((link) => String(link.ticketId)));
  const creations: MirrorCreation[] = [];
  const skipped: MirrorSkip[] = [];
  const warnings: string[] = [];
  for (const ticket of tickets) {
    if (!ticket?.id || !ticket.ref || alreadyLinked.has(String(ticket.id)) || !mirrorMatches(ticket, config)) continue;
    const rendered = renderMirrorIssue(ticket, config, context);
    if ('reason' in rendered) {
      skipped.push(Object.freeze({ ticketId: String(ticket.id), ref: String(ticket.ref), reason: rendered.reason }));
      warnings.push(`${ticket.ref}: issue mirror skipped; ${rendered.reason}.`);
      continue;
    }
    creations.push(Object.freeze({ ticketId: String(ticket.id), ref: String(ticket.ref), repo, title: rendered.title, body: rendered.body, labels: rendered.labels }));
  }
  return Object.freeze({ creations: Object.freeze(creations), skipped: Object.freeze(skipped), warnings: Object.freeze(warnings) });
}

function existingLabels(gh: GhExecutor, repo: string): Set<string> {
  try {
    const output = gh('gh', ['label', 'list', '--repo', repo, '--limit', '1000', '--json', 'name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const payload = JSON.parse(String(output).trim());
    return new Set(Array.isArray(payload) ? payload.map((label) => String((label as { name?: unknown })?.name || '')) : []);
  } catch (_error: unknown) {
    return new Set();
  }
}

function issueNumber(url: string): number {
  const match = /\/issues\/(\d+)\/?$/.exec(url.trim());
  return match ? Number(match[1]) : 0;
}

/**
 * Creates the planned issues and records each as an ordinary external link, so
 * the existing linked-issue sync owns status labels, close-on-done and the
 * released-in note from the next run onward. There is no second sync path.
 */
export function applyIssueMirror(plan: IssueMirrorPlan | null | undefined, gh: GhExecutor, link: (ticketId: string, record: Readonly<{ provider: string; repo: string; number: number; url: string }>) => unknown): readonly MirrorApplyResult[] {
  if (!plan || !plan.creations.length || typeof link !== 'function') return Object.freeze([]);
  const results: MirrorApplyResult[] = [];
  const labelCache = new Map<string, Set<string>>();
  for (const creation of plan.creations) {
    if (!labelCache.has(creation.repo)) labelCache.set(creation.repo, existingLabels(gh, creation.repo));
    const usable = creation.labels.filter((label) => labelCache.get(creation.repo)!.has(label));
    const arguments_ = ['issue', 'create', '--repo', creation.repo, '--title', creation.title, '--body', creation.body];
    for (const label of usable) arguments_.push('--label', label);
    let url = '';
    try {
      url = String(gh('gh', arguments_, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })).trim().split(/\s+/).filter((value) => value.startsWith('http')).at(-1) || '';
    } catch (error: unknown) {
      results.push(Object.freeze({ repo: creation.repo, number: 0, action: 'createIssue', ok: false, ref: creation.ref, error: String((error as { message?: unknown })?.message || 'gh command failed').replace(/\s+/g, ' ').trim() }));
      continue;
    }
    const number = issueNumber(url);
    if (!number) {
      results.push(Object.freeze({ repo: creation.repo, number: 0, action: 'createIssue', ok: false, ref: creation.ref, error: 'gh issue create returned no issue URL' }));
      continue;
    }
    try {
      link(creation.ticketId, { provider: 'github', repo: creation.repo, number, url });
    } catch (error: unknown) {
      results.push(Object.freeze({ repo: creation.repo, number, action: 'linkIssue', ok: false, ref: creation.ref, url, error: String((error as { message?: unknown })?.message || 'link failed').replace(/\s+/g, ' ').trim() }));
      continue;
    }
    results.push(Object.freeze({ repo: creation.repo, number, action: 'createIssue', ok: true, ref: creation.ref, url }));
  }
  return Object.freeze(results);
}
