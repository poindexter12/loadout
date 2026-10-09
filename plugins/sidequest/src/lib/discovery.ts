import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveClaudeHome } from './claude-home.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

interface CatalogSource {
  source: string;
  relPath: string;
  schemas: ReadonlySet<number>;
}

interface CatalogData {
  schemaVersion?: unknown;
  schema?: unknown;
  updatedAt?: unknown;
  models?: unknown;
  providers?: unknown;
  codexReadiness?: unknown;
}

interface CatalogModel {
  slug?: unknown;
  id?: unknown;
  label?: unknown;
  provider?: unknown;
}

export interface ExternalModel {
  slug: string;
  id: string;
  label: string;
  provider: string;
  source: string;
}

export interface ProviderReadiness {
  provider: string;
  ready: boolean;
  state: string;
  message: string;
}

export const CATALOG_SOURCES: readonly CatalogSource[] = [
  { source: 'model-gateway', relPath: path.join('model-gateway', 'catalog.json'), schemas: new Set([2, 3, 4]) },
];

function discoveryRoots(): string[] {
  const override = process.env.SIDEQUEST_DISCOVERY_DIRS;
  if (override?.trim()) {
    return override.split(',').map((value) => value.trim()).filter(Boolean).map((value) => path.resolve(value));
  }
  return [resolveClaudeHome()];
}

function readJsonSafe(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

interface CachedCatalog {
  fingerprint: string | null;
  data: unknown;
}

const catalogCache = new Map<string, CachedCatalog>();

function catalogFileFingerprint(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function readCatalogSafe(file: string): unknown {
  const resolvedFile = path.resolve(file);
  const fingerprint = catalogFileFingerprint(resolvedFile);
  const cached = catalogCache.get(resolvedFile);
  if (cached?.fingerprint === fingerprint) return cached.data;
  const data = readJsonSafe(resolvedFile);
  catalogCache.set(resolvedFile, { fingerprint, data });
  return data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function versionParts(version: unknown): [number, number, number] | null {
  const match = typeof version === 'string' && version.match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isNewerVersion(candidate: [number, number, number], current: [number, number, number]): boolean {
  for (const index of [0, 1, 2] as const) {
    if (candidate[index] !== current[index]) return candidate[index] > current[index];
  }
  return false;
}

function newestGatewayCatalogCommand(): string | null {
  if (process.env.SIDEQUEST_DISCOVERY_DIRS?.trim()) return null;
  const registry = readJsonSafe(path.join(resolveClaudeHome(), 'plugins', 'installed_plugins.json'));
  if (!isRecord(registry) || !isRecord(registry.plugins)) return null;
  const entries = registry.plugins['model-gateway@loadout'];
  if (!Array.isArray(entries)) return null;
  let newest: { command: string; version: [number, number, number] } | null = null;
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.installPath !== 'string') continue;
    const version = versionParts(entry.version);
    const command = path.join(entry.installPath, 'bin', 'model-gateway.js');
    if (!version || !fs.existsSync(command) || (newest && !isNewerVersion(version, newest.version))) continue;
    newest = { command, version };
  }
  return newest?.command ?? null;
}

// model-gateway budgets 3s for its shim health probe and 3s for /v1/models;
// reserve the remaining time for Node startup and load-related scheduling headroom.
const GATEWAY_REFRESH_TIMEOUT_MS = 10 * 1000;

function gatewayRefreshSucceeded(command: string): boolean {
  try {
    return spawnSync(process.execPath, [command, 'catalog', '--refresh', '--json'], {
      encoding: 'utf8', timeout: GATEWAY_REFRESH_TIMEOUT_MS, windowsHide: true,
    }).status === 0;
  } catch {
    return false;
  }
}

export const CATALOG_STALE_MS = 5 * 60 * 1000;
// A refresh that fails is retried soon rather than pinned for the whole catalog window, but not on every call:
// a gateway that is down would otherwise spawn a child process per route resolution.
const REFRESH_RETRY_MS = 30 * 1000;

const gatewayRefreshAttempts = new Map<string, { at: number; refreshed: boolean }>();

// Run the refresh for its side effect and re-read the file, which is the authority. Parsing the gateway CLI's
// stdout made this return null the moment that CLI printed a diagnostic line ahead of the JSON, so the refresh
// silently did nothing in the exact case it exists for (SQ-2208). Its exit code is not the authority either: it
// exits 0 printing the stored catalog when the proxy is down, so an attempt only counts as a refresh when the
// file it left behind is current. Attempts are remembered per catalog file, so readiness and model listing
// share one child process rather than spawning one each.
function refreshGatewayCatalog(catalogPath: string): CatalogData | null {
  const attempt = gatewayRefreshAttempts.get(catalogPath);
  const window = attempt?.refreshed ? CATALOG_STALE_MS : REFRESH_RETRY_MS;
  if (!attempt || Date.now() - attempt.at > window) {
    const command = newestGatewayCatalogCommand();
    const written = command !== null && gatewayRefreshSucceeded(command) ? readCatalogSafe(catalogPath) : null;
    gatewayRefreshAttempts.set(catalogPath, { at: Date.now(), refreshed: catalogWithinFreshnessWindow(written) });
    return isRecord(written) ? written as CatalogData : null;
  }
  const catalog = attempt.refreshed ? readCatalogSafe(catalogPath) : null;
  return isRecord(catalog) ? catalog as CatalogData : null;
}

function catalogWithinFreshnessWindow(data: unknown): boolean {
  if (!isRecord(data) || typeof data.updatedAt !== 'string') return false;
  const age = Date.now() - Date.parse(data.updatedAt);
  return Number.isFinite(age) && age >= 0 && age <= CATALOG_STALE_MS;
}

// ------------------------------------------------------- ANTHROPIC_BASE_URL
//
// catalog.json only exists when model-gateway is installed locally, which made
// every external model on this board a model-gateway model by construction. The
// endpoint Claude Code already talks to can answer the same question directly:
// `GET /v1/models` on the effective ANTHROPIC_BASE_URL, which is exactly what
// Claude Code reads for its own picker under
// CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1. Any relay that serves that
// route now contributes models, with or without the plugin (SQ-298).
//
// This source is ADDITIVE, not a replacement. Catalog rows keep their own
// naming and readiness, and an id present in both sources is named by the
// catalog. The reason is not caution for its own sake: the board's persisted
// routes pin SLUGS, and a slug this file derived differently from the one
// catalog.json published would silently repoint every stored route on the
// board at once. The catalog wins on naming wherever it exists, so an existing
// install sees byte-identical slugs and only gains rows it never had.
export const HTTP_MODEL_SOURCE = 'anthropic-base-url';

// Only the process environment. Claude Code applies a settings `env` block to
// the session environment, so a hook or the board MCP server inherits the
// effective value without this file re-implementing the settings precedence
// walk (which it could not do correctly anyway: it has no project path). A bare
// CLI run outside such a session sees whatever its shell exports.
function effectiveAnthropicBaseUrl(): string | null {
  const raw = process.env.ANTHROPIC_BASE_URL;
  const trimmed = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
  return /^https?:\/\/[^\s/]+/.test(trimmed) ? trimmed : null;
}

// Discovery is synchronous — routing and the hooks call it inline — and Node has
// no synchronous fetch, so the probe runs in a child process exactly like the
// gateway catalog refresh above. The 3s budget is the one discovery.ts has always
// given a /v1/models read.
const MODELS_PROBE_TIMEOUT_MS = 3 * 1000;
const MODELS_PROBE_SCRIPT = "const u=process.argv[1];fetch(u,{headers:{accept:'application/json'}})"
  + ".then((r)=>r.ok?r.text():Promise.reject(new Error('status '+r.status)))"
  + '.then((t)=>{process.stdout.write(t);},()=>{process.exitCode=1;});';

// Only the first page is read. has_more paging exists in the Anthropic shape but
// no relay this talks to has ever needed it, and a synchronous probe must stay
// inside one bounded child process.
function fetchModelRows(baseUrl: string): unknown[] | null {
  try {
    const probe = spawnSync(process.execPath, ['-e', MODELS_PROBE_SCRIPT, `${baseUrl}/v1/models`], {
      encoding: 'utf8', timeout: MODELS_PROBE_TIMEOUT_MS, windowsHide: true,
    });
    if (probe.status !== 0 || !probe.stdout) return null;
    const parsed = JSON.parse(probe.stdout) as unknown;
    const data = isRecord(parsed) ? parsed.data : null;
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

// A first-party Claude model is NOT an external model. Without this an
// ANTHROPIC_BASE_URL pointed at the real API (or at model-gateway's
// RC-compatibility mode, which legitimately sets the base URL to
// http://api.anthropic.com and redirects it through the hosts file) would
// register claude-opus-*/claude-sonnet-* as external routes shadowing the Claude
// ladder. Matching on the family segment rather than the host is what keeps
// compat mode working.
// Two families, because Anthropic has used two id shapes: the family-first form
// (claude-opus-4-5-20260514, sonnet) and the legacy version-first form
// (claude-3-5-sonnet-20241022, claude-3-opus-20240229). Matching only the first
// would let every legacy id through as an external model the moment
// ANTHROPIC_BASE_URL named the real API.
const CLAUDE_FIRST_PARTY_RE = /^(?:claude-)?(?:opus|sonnet|haiku|fable|instant)(?:[-.]|$)|^claude-\d/;
// The virtual dispatch id model-gateway advertises for marker-resolved routing.
// It is a routing sentinel, not a model anything may be routed to directly.
const VIRTUAL_DISPATCH_IDS = new Set(['claude-codex-auto']);

// Faithful port of model-gateway's catalog slugFor()/modelCatalogDetails()
// (plugins/model-gateway/lib/catalog.js). It is duplicated rather than imported
// because sidequest must derive these with the plugin absent, which is the whole
// point of this source. Drift here renames routes, so
// 'HTTP rows derive the slugs catalog.json publishes' pins the pairs in
// test/discovery.test.ts against the real published ids.
function providerDetails(id: string): { provider: string; base: string } {
  const bare = id.replace(/^claude-(?:codex-)?/, '').replace(/\[1m\]$/, '');
  if (/^gpt-/.test(bare)) return { provider: 'codex', base: bare };
  if (/^grok-/.test(bare)) return { provider: 'grok', base: bare };
  if (/^gemini-/.test(bare)) return { provider: 'antigravity', base: bare };
  // Anything else is a relay serving its own roster. One namespace keeps those
  // slugs collision-free against the three known families.
  return { provider: 'relay', base: bare };
}

function slugFor(provider: string, base: string, used: Set<string>): string {
  const providerPrefix = `${provider}-`;
  const providerBase = base.startsWith(providerPrefix) ? base.slice(providerPrefix.length) : base;
  let s = (providerPrefix + providerBase).toLowerCase()
    .replace(/\[1m\]$/, '')
    .replace(/\./g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!/^[a-z0-9]/.test(s)) s = `x${s}`;
  if (s.length > 32) {
    const hash = crypto.createHash('sha1').update(s).digest('hex').slice(0, 6);
    s = `${s.slice(0, 32 - 1 - hash.length)}-${hash}`;
  }
  let unique = s;
  let n = 2;
  while (used.has(unique)) {
    const suffix = `-${n}`;
    unique = s.slice(0, Math.max(1, 32 - suffix.length)) + suffix;
    n++;
  }
  used.add(unique);
  return unique;
}

function httpModelFromRow(raw: unknown, used: Set<string>): ExternalModel | null {
  if (!isRecord(raw)) return null;
  // model-gateway stamps type:"model"; a leaner relay may omit it. Reject only a
  // row that declares itself something else.
  if (typeof raw.type === 'string' && raw.type !== 'model') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id || VIRTUAL_DISPATCH_IDS.has(id) || CLAUDE_FIRST_PARTY_RE.test(id)) return null;
  const { provider, base } = providerDetails(id);
  if (!base || !SLUG_RE.test(provider)) return null;
  const slug = slugFor(provider, base, used);
  if (!SLUG_RE.test(slug)) return null;
  const displayName = typeof raw.display_name === 'string' ? raw.display_name.trim() : '';
  return { slug, id, label: displayName || slug, provider, source: HTTP_MODEL_SOURCE };
}

// Cached per base URL on the same windows the catalog refresh uses: a served
// answer is trusted for the catalog window, a failure is retried sooner but not
// on every call, so a relay that is down costs one child process per retry
// window rather than one per route resolution.
let httpModelCache: { baseUrl: string; at: number; models: ExternalModel[] | null } | null = null;

function httpExternalModels(): ExternalModel[] {
  const baseUrl = effectiveAnthropicBaseUrl();
  if (!baseUrl) return [];
  const cached = httpModelCache && httpModelCache.baseUrl === baseUrl ? httpModelCache : null;
  const window = cached?.models ? CATALOG_STALE_MS : REFRESH_RETRY_MS;
  if (cached && Date.now() - cached.at <= window) return cached.models ?? [];
  const rows = fetchModelRows(baseUrl);
  const used = new Set<string>();
  const models = rows
    ? rows.map((row) => httpModelFromRow(row, used)).filter((model): model is ExternalModel => model !== null)
    : null;
  httpModelCache = { baseUrl, at: Date.now(), models };
  return models ?? [];
}

// Readiness for a provider whose rows came off the endpoint. There is no
// credential or proxy to probe here: the endpoint answered and listed the model,
// which is the whole of what this source can attest. Stating the source in the
// message is what makes a board able to tell the two apart.
function httpProviderReadiness(provider: string): ProviderReadiness | null {
  const baseUrl = effectiveAnthropicBaseUrl();
  if (!baseUrl) return null;
  const served = httpExternalModels().filter((model) => model.provider === provider);
  if (!served.length) return null;
  return {
    provider,
    ready: true,
    state: 'endpoint',
    message: `ANTHROPIC_BASE_URL ${baseUrl} served ${served.length} ${provider} model${served.length === 1 ? '' : 's'} from GET /v1/models.`,
  };
}

export function catalogStateFingerprint(): string {
  const catalogs = discoveryRoots().flatMap((root) => CATALOG_SOURCES.map(({ relPath }) => {
    const catalogPath = path.resolve(root, relPath);
    const freshness = catalogWithinFreshnessWindow(readCatalogSafe(catalogPath)) ? 'fresh' : 'stale';
    return `${catalogPath}:${catalogFileFingerprint(catalogPath) ?? 'missing'}:${freshness}`;
  }));
  // The endpoint identity, never the probe timestamp: a downstream routing cache
  // must notice the base URL changing without churning every few seconds.
  return [...catalogs, `${HTTP_MODEL_SOURCE}:${effectiveAnthropicBaseUrl() ?? 'unset'}`].join('|');
}

function usableCatalog(data: unknown, schemas: ReadonlySet<number>): CatalogData | null {
  if (!isRecord(data) || !catalogWithinFreshnessWindow(data)) return null;
  const catalog = data as CatalogData;
  const schema = catalog.schemaVersion ?? catalog.schema;
  return typeof schema === 'number' && schemas.has(schema) && Array.isArray(catalog.models) ? catalog : null;
}

function catalogSchema(catalog: CatalogData): number {
  return (catalog.schemaVersion ?? catalog.schema) as number;
}

function validateReadiness(raw: unknown): Omit<ProviderReadiness, 'provider'> | null {
  if (!isRecord(raw) || typeof raw.ready !== 'boolean') return null;
  const state = typeof raw.state === 'string' ? raw.state.trim() : '';
  const message = typeof raw.message === 'string' ? raw.message.trim() : '';
  return state && message ? { ready: raw.ready, state, message } : null;
}

function catalogProviderReadiness(catalog: CatalogData, provider: string): ProviderReadiness | null {
  const schema = catalogSchema(catalog);
  const readiness = schema >= 4
    ? isRecord(catalog.providers) && validateReadiness(catalog.providers[provider])
    : provider === 'codex' && validateReadiness(catalog.codexReadiness);
  return readiness ? { provider, ...readiness } : null;
}

export function providerReadiness(provider: string): ProviderReadiness | null {
  for (const root of discoveryRoots()) {
    for (const { relPath, schemas } of CATALOG_SOURCES) {
      const catalogPath = path.join(root, relPath);
      const storedCatalog = readCatalogSafe(catalogPath);
      let catalog = usableCatalog(storedCatalog, schemas);
      let readiness = catalog && catalogProviderReadiness(catalog, provider);
      if (provider === 'codex' && isRecord(storedCatalog) && (!catalog || !readiness?.ready)) {
        const refreshedCatalog = usableCatalog(refreshGatewayCatalog(catalogPath), schemas);
        if (refreshedCatalog) {
          catalog = refreshedCatalog;
          readiness = catalogProviderReadiness(catalog, provider);
        }
      }
      if (readiness) return readiness;
    }
  }
  // Only where the catalog is silent. An installed gateway reporting its own
  // backend as proxy-down is a stronger statement than "the endpoint listed a
  // row", so the catalog keeps the last word wherever it has one.
  return httpProviderReadiness(provider);
}

// Nothing writes the catalog on its own, so once the stored one ages past CATALOG_STALE_MS every model in it
// disappeared from the board while the gateway was perfectly healthy, and stayed gone until some unrelated
// command happened to rewrite the file. Readiness already refreshed itself; the model list has to too, or a
// board routing to Codex categories stops dispatching for no stated reason (SQ-2208).
function currentCatalog(catalogPath: string, schemas: ReadonlySet<number>): CatalogData | null {
  const storedCatalog = readCatalogSafe(catalogPath);
  const usable = usableCatalog(storedCatalog, schemas);
  if (usable || !isRecord(storedCatalog)) return usable;
  return usableCatalog(refreshGatewayCatalog(catalogPath), schemas);
}

function validateEntry(raw: unknown, source: string, schema: number): ExternalModel | null {
  if (!isRecord(raw)) return null;
  const model = raw as CatalogModel;
  const slug = typeof model.slug === 'string' ? model.slug.trim().toLowerCase() : '';
  if (!SLUG_RE.test(slug)) return null;
  const id = typeof model.id === 'string' ? model.id.trim() : '';
  if (!id) return null;
  const provider = schema >= 4
    ? typeof model.provider === 'string' && model.provider === model.provider.toLowerCase() && SLUG_RE.test(model.provider) ? model.provider : ''
    : 'codex';
  if (!provider) return null;
  const label = typeof model.label === 'string' && model.label.trim() ? model.label.trim() : slug;
  return { slug, id, label, provider, source };
}

export function configuredExternalModelProvider(slug: string): string | null {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!SLUG_RE.test(normalizedSlug)) return null;
  for (const root of discoveryRoots()) {
    for (const { source, relPath, schemas } of CATALOG_SOURCES) {
      const catalog = currentCatalog(path.join(root, relPath), schemas);
      if (!catalog) continue;
      for (const raw of catalog.models as unknown[]) {
        const entry = validateEntry(raw, source, catalogSchema(catalog));
        if (entry?.slug === normalizedSlug) return entry.provider;
      }
    }
  }
  for (const model of httpExternalModels()) {
    if (model.slug === normalizedSlug) return model.provider;
  }
  return null;
}

export function discoverExternalModels(): ExternalModel[] {
  const out: ExternalModel[] = [];
  const seen = new Set<string>();
  for (const root of discoveryRoots()) {
    for (const { source, relPath, schemas } of CATALOG_SOURCES) {
      const catalog = currentCatalog(path.join(root, relPath), schemas);
      if (!catalog) continue;
      for (const raw of catalog.models as unknown[]) {
        const entry = validateEntry(raw, source, catalogSchema(catalog));
        const readiness = entry && catalogProviderReadiness(catalog, entry.provider);
        const key = entry && readiness?.ready && `${entry.source}:${entry.slug}`;
        if (!entry || !key || seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
      }
    }
  }
  // Endpoint rows come last and never displace a catalog row: an id or slug the
  // catalog already named keeps that name, so an existing install's persisted
  // routes are untouched and only genuinely new rows are added.
  const namedIds = new Set(out.map((model) => model.id));
  const namedSlugs = new Set(out.map((model) => model.slug));
  const readinessByProvider = new Map<string, boolean>();
  for (const model of httpExternalModels()) {
    if (namedIds.has(model.id) || namedSlugs.has(model.slug)) continue;
    if (!readinessByProvider.has(model.provider)) {
      readinessByProvider.set(model.provider, providerReadiness(model.provider)?.ready === true);
    }
    if (!readinessByProvider.get(model.provider)) continue;
    namedIds.add(model.id);
    namedSlugs.add(model.slug);
    out.push(model);
  }
  return out;
}
