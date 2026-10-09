"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var discovery_exports = {};
__export(discovery_exports, {
  CATALOG_SOURCES: () => CATALOG_SOURCES,
  CATALOG_STALE_MS: () => CATALOG_STALE_MS,
  HTTP_MODEL_SOURCE: () => HTTP_MODEL_SOURCE,
  catalogStateFingerprint: () => catalogStateFingerprint,
  configuredExternalModelProvider: () => configuredExternalModelProvider,
  discoverExternalModels: () => discoverExternalModels,
  providerReadiness: () => providerReadiness
});
module.exports = __toCommonJS(discovery_exports);
var import_node_child_process = require("node:child_process");
var import_node_crypto = __toESM(require("node:crypto"));
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var import_claude_home = require("./claude-home.js");
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const CATALOG_SOURCES = [
  { source: "model-gateway", relPath: import_node_path.default.join("model-gateway", "catalog.json"), schemas: /* @__PURE__ */ new Set([2, 3, 4]) }
];
function discoveryRoots() {
  const override = process.env.SIDEQUEST_DISCOVERY_DIRS;
  if (override?.trim()) {
    return override.split(",").map((value) => value.trim()).filter(Boolean).map((value) => import_node_path.default.resolve(value));
  }
  return [(0, import_claude_home.resolveClaudeHome)()];
}
function readJsonSafe(file) {
  try {
    return JSON.parse(import_node_fs.default.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
const catalogCache = /* @__PURE__ */ new Map();
function catalogFileFingerprint(file) {
  try {
    const stat = import_node_fs.default.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}
function readCatalogSafe(file) {
  const resolvedFile = import_node_path.default.resolve(file);
  const fingerprint = catalogFileFingerprint(resolvedFile);
  const cached = catalogCache.get(resolvedFile);
  if (cached?.fingerprint === fingerprint) return cached.data;
  const data = readJsonSafe(resolvedFile);
  catalogCache.set(resolvedFile, { fingerprint, data });
  return data;
}
function isRecord(value) {
  return value !== null && typeof value === "object";
}
function versionParts(version) {
  const match = typeof version === "string" && version.match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
function isNewerVersion(candidate, current) {
  for (const index of [0, 1, 2]) {
    if (candidate[index] !== current[index]) return candidate[index] > current[index];
  }
  return false;
}
function newestGatewayCatalogCommand() {
  if (process.env.SIDEQUEST_DISCOVERY_DIRS?.trim()) return null;
  const registry = readJsonSafe(import_node_path.default.join((0, import_claude_home.resolveClaudeHome)(), "plugins", "installed_plugins.json"));
  if (!isRecord(registry) || !isRecord(registry.plugins)) return null;
  const entries = registry.plugins["model-gateway@loadout"];
  if (!Array.isArray(entries)) return null;
  let newest = null;
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.installPath !== "string") continue;
    const version = versionParts(entry.version);
    const command = import_node_path.default.join(entry.installPath, "bin", "model-gateway.js");
    if (!version || !import_node_fs.default.existsSync(command) || newest && !isNewerVersion(version, newest.version)) continue;
    newest = { command, version };
  }
  return newest?.command ?? null;
}
const GATEWAY_REFRESH_TIMEOUT_MS = 10 * 1e3;
function gatewayRefreshSucceeded(command) {
  try {
    return (0, import_node_child_process.spawnSync)(process.execPath, [command, "catalog", "--refresh", "--json"], {
      encoding: "utf8",
      timeout: GATEWAY_REFRESH_TIMEOUT_MS,
      windowsHide: true
    }).status === 0;
  } catch {
    return false;
  }
}
const CATALOG_STALE_MS = 5 * 60 * 1e3;
const REFRESH_RETRY_MS = 30 * 1e3;
const gatewayRefreshAttempts = /* @__PURE__ */ new Map();
function refreshGatewayCatalog(catalogPath) {
  const attempt = gatewayRefreshAttempts.get(catalogPath);
  const window = attempt?.refreshed ? CATALOG_STALE_MS : REFRESH_RETRY_MS;
  if (!attempt || Date.now() - attempt.at > window) {
    const command = newestGatewayCatalogCommand();
    const written = command !== null && gatewayRefreshSucceeded(command) ? readCatalogSafe(catalogPath) : null;
    gatewayRefreshAttempts.set(catalogPath, { at: Date.now(), refreshed: catalogWithinFreshnessWindow(written) });
    return isRecord(written) ? written : null;
  }
  const catalog = attempt.refreshed ? readCatalogSafe(catalogPath) : null;
  return isRecord(catalog) ? catalog : null;
}
function catalogWithinFreshnessWindow(data) {
  if (!isRecord(data) || typeof data.updatedAt !== "string") return false;
  const age = Date.now() - Date.parse(data.updatedAt);
  return Number.isFinite(age) && age >= 0 && age <= CATALOG_STALE_MS;
}
const HTTP_MODEL_SOURCE = "anthropic-base-url";
function effectiveAnthropicBaseUrl() {
  const raw = process.env.ANTHROPIC_BASE_URL;
  const trimmed = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
  return /^https?:\/\/[^\s/]+/.test(trimmed) ? trimmed : null;
}
const MODELS_PROBE_TIMEOUT_MS = 3 * 1e3;
const MODELS_PROBE_SCRIPT = "const u=process.argv[1];fetch(u,{headers:{accept:'application/json'}}).then((r)=>r.ok?r.text():Promise.reject(new Error('status '+r.status))).then((t)=>{process.stdout.write(t);},()=>{process.exitCode=1;});";
function fetchModelRows(baseUrl) {
  try {
    const probe = (0, import_node_child_process.spawnSync)(process.execPath, ["-e", MODELS_PROBE_SCRIPT, `${baseUrl}/v1/models`], {
      encoding: "utf8",
      timeout: MODELS_PROBE_TIMEOUT_MS,
      windowsHide: true
    });
    if (probe.status !== 0 || !probe.stdout) return null;
    const parsed = JSON.parse(probe.stdout);
    const data = isRecord(parsed) ? parsed.data : null;
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}
const CLAUDE_FIRST_PARTY_RE = /^(?:claude-)?(?:opus|sonnet|haiku|fable|instant)(?:[-.]|$)|^claude-\d/;
const VIRTUAL_DISPATCH_IDS = /* @__PURE__ */ new Set(["claude-codex-auto"]);
function providerDetails(id) {
  const bare = id.replace(/^claude-(?:codex-)?/, "").replace(/\[1m\]$/, "");
  if (/^gpt-/.test(bare)) return { provider: "codex", base: bare };
  if (/^grok-/.test(bare)) return { provider: "grok", base: bare };
  if (/^gemini-/.test(bare)) return { provider: "antigravity", base: bare };
  return { provider: "relay", base: bare };
}
function slugFor(provider, base, used) {
  const providerPrefix = `${provider}-`;
  const providerBase = base.startsWith(providerPrefix) ? base.slice(providerPrefix.length) : base;
  let s = (providerPrefix + providerBase).toLowerCase().replace(/\[1m\]$/, "").replace(/\./g, "-").replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z0-9]/.test(s)) s = `x${s}`;
  if (s.length > 32) {
    const hash = import_node_crypto.default.createHash("sha1").update(s).digest("hex").slice(0, 6);
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
function httpModelFromRow(raw, used) {
  if (!isRecord(raw)) return null;
  if (typeof raw.type === "string" && raw.type !== "model") return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id || VIRTUAL_DISPATCH_IDS.has(id) || CLAUDE_FIRST_PARTY_RE.test(id)) return null;
  const { provider, base } = providerDetails(id);
  if (!base || !SLUG_RE.test(provider)) return null;
  const slug = slugFor(provider, base, used);
  if (!SLUG_RE.test(slug)) return null;
  const displayName = typeof raw.display_name === "string" ? raw.display_name.trim() : "";
  return { slug, id, label: displayName || slug, provider, source: HTTP_MODEL_SOURCE };
}
let httpModelCache = null;
function httpExternalModels() {
  const baseUrl = effectiveAnthropicBaseUrl();
  if (!baseUrl) return [];
  const cached = httpModelCache && httpModelCache.baseUrl === baseUrl ? httpModelCache : null;
  const window = cached?.models ? CATALOG_STALE_MS : REFRESH_RETRY_MS;
  if (cached && Date.now() - cached.at <= window) return cached.models ?? [];
  const rows = fetchModelRows(baseUrl);
  const used = /* @__PURE__ */ new Set();
  const models = rows ? rows.map((row) => httpModelFromRow(row, used)).filter((model) => model !== null) : null;
  httpModelCache = { baseUrl, at: Date.now(), models };
  return models ?? [];
}
function httpProviderReadiness(provider) {
  const baseUrl = effectiveAnthropicBaseUrl();
  if (!baseUrl) return null;
  const served = httpExternalModels().filter((model) => model.provider === provider);
  if (!served.length) return null;
  return {
    provider,
    ready: true,
    state: "endpoint",
    message: `ANTHROPIC_BASE_URL ${baseUrl} served ${served.length} ${provider} model${served.length === 1 ? "" : "s"} from GET /v1/models.`
  };
}
function catalogStateFingerprint() {
  const catalogs = discoveryRoots().flatMap((root) => CATALOG_SOURCES.map(({ relPath }) => {
    const catalogPath = import_node_path.default.resolve(root, relPath);
    const freshness = catalogWithinFreshnessWindow(readCatalogSafe(catalogPath)) ? "fresh" : "stale";
    return `${catalogPath}:${catalogFileFingerprint(catalogPath) ?? "missing"}:${freshness}`;
  }));
  return [...catalogs, `${HTTP_MODEL_SOURCE}:${effectiveAnthropicBaseUrl() ?? "unset"}`].join("|");
}
function usableCatalog(data, schemas) {
  if (!isRecord(data) || !catalogWithinFreshnessWindow(data)) return null;
  const catalog = data;
  const schema = catalog.schemaVersion ?? catalog.schema;
  return typeof schema === "number" && schemas.has(schema) && Array.isArray(catalog.models) ? catalog : null;
}
function catalogSchema(catalog) {
  return catalog.schemaVersion ?? catalog.schema;
}
function validateReadiness(raw) {
  if (!isRecord(raw) || typeof raw.ready !== "boolean") return null;
  const state = typeof raw.state === "string" ? raw.state.trim() : "";
  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  return state && message ? { ready: raw.ready, state, message } : null;
}
function catalogProviderReadiness(catalog, provider) {
  const schema = catalogSchema(catalog);
  const readiness = schema >= 4 ? isRecord(catalog.providers) && validateReadiness(catalog.providers[provider]) : provider === "codex" && validateReadiness(catalog.codexReadiness);
  return readiness ? { provider, ...readiness } : null;
}
function providerReadiness(provider) {
  for (const root of discoveryRoots()) {
    for (const { relPath, schemas } of CATALOG_SOURCES) {
      const catalogPath = import_node_path.default.join(root, relPath);
      const storedCatalog = readCatalogSafe(catalogPath);
      let catalog = usableCatalog(storedCatalog, schemas);
      let readiness = catalog && catalogProviderReadiness(catalog, provider);
      if (provider === "codex" && isRecord(storedCatalog) && (!catalog || !readiness?.ready)) {
        const refreshedCatalog = usableCatalog(refreshGatewayCatalog(catalogPath), schemas);
        if (refreshedCatalog) {
          catalog = refreshedCatalog;
          readiness = catalogProviderReadiness(catalog, provider);
        }
      }
      if (readiness) return readiness;
    }
  }
  return httpProviderReadiness(provider);
}
function currentCatalog(catalogPath, schemas) {
  const storedCatalog = readCatalogSafe(catalogPath);
  const usable = usableCatalog(storedCatalog, schemas);
  if (usable || !isRecord(storedCatalog)) return usable;
  return usableCatalog(refreshGatewayCatalog(catalogPath), schemas);
}
function validateEntry(raw, source, schema) {
  if (!isRecord(raw)) return null;
  const model = raw;
  const slug = typeof model.slug === "string" ? model.slug.trim().toLowerCase() : "";
  if (!SLUG_RE.test(slug)) return null;
  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (!id) return null;
  const provider = schema >= 4 ? typeof model.provider === "string" && model.provider === model.provider.toLowerCase() && SLUG_RE.test(model.provider) ? model.provider : "" : "codex";
  if (!provider) return null;
  const label = typeof model.label === "string" && model.label.trim() ? model.label.trim() : slug;
  return { slug, id, label, provider, source };
}
function configuredExternalModelProvider(slug) {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!SLUG_RE.test(normalizedSlug)) return null;
  for (const root of discoveryRoots()) {
    for (const { source, relPath, schemas } of CATALOG_SOURCES) {
      const catalog = currentCatalog(import_node_path.default.join(root, relPath), schemas);
      if (!catalog) continue;
      for (const raw of catalog.models) {
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
function discoverExternalModels() {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const root of discoveryRoots()) {
    for (const { source, relPath, schemas } of CATALOG_SOURCES) {
      const catalog = currentCatalog(import_node_path.default.join(root, relPath), schemas);
      if (!catalog) continue;
      for (const raw of catalog.models) {
        const entry = validateEntry(raw, source, catalogSchema(catalog));
        const readiness = entry && catalogProviderReadiness(catalog, entry.provider);
        const key = entry && readiness?.ready && `${entry.source}:${entry.slug}`;
        if (!entry || !key || seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
      }
    }
  }
  const namedIds = new Set(out.map((model) => model.id));
  const namedSlugs = new Set(out.map((model) => model.slug));
  const readinessByProvider = /* @__PURE__ */ new Map();
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CATALOG_SOURCES,
  CATALOG_STALE_MS,
  HTTP_MODEL_SOURCE,
  catalogStateFingerprint,
  configuredExternalModelProvider,
  discoverExternalModels,
  providerReadiness
});
