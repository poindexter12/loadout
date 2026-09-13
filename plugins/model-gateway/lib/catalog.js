'use strict';

// ------------------------------------------------------------ model catalog
//
// sidequest (same marketplace) auto-discovers Codex models by reading this
// file: $CLAUDE_CONFIG_DIR/model-gateway/catalog.json. Shape is a frozen contract
// (see plugins/sidequest/lib/discovery.js) — don't change it casually.
//
// This module is the single definition of the catalog row/readiness shape.
// commands.js (CLI) and request-worker.js (shim) each used to carry a private
// copy, and the copies drifted: in each file some copies were unreachable dead
// code while the other file's live copy kept getting fixed. Unifying them is
// therefore NOT behaviour-neutral — the surviving definitions are the
// Antigravity-aware ones the worker had, so the CLI catalog path now emits
// `antigravity` model rows and an `antigravity` provider-readiness entry it
// previously dropped on the floor. That is intended: the CLI was silently
// under-reporting a backend the shim has served for several releases.
//
// The write/read shells around this (writeCatalog, readCatalog, catalogCommand)
// genuinely differ per host — the CLI writes the discovery cache alongside the
// catalog and reads the shim's model objects, the worker reads bare ids off its
// own SHIM_PORT — so they deliberately stay in their own files.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const grokBackend = require('./grok-backend.js');
const { codexBaseFromId } = require('./pins.js');
const {
  DISPATCH_MODEL_ID, GEMINI_PREFIX, GROK_PREFIX, PLUGIN_VERSION, PREFIX, STATE,
  codexContextWindow, gatewayAdvertisedWindow, gatewayClientModelId, resolveGatewayModelPolicy,
} = require('./runtime.js');

const CATALOG_PATH = path.join(STATE, 'catalog.json');
const CATALOG_STALE_MS = 5 * 60 * 1000;
const CATALOG_SCHEMA_VERSION = 4;

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function catalogReadiness(readiness) {
  return {
    ready: readiness.ready,
    state: readiness.state,
    message: readiness.message,
    checks: readiness.checks,
    upstreamBlocked: readiness.upstreamBlocked,
  };
}

function providerReadiness(readiness) {
  return {
    ready: Boolean(readiness?.ready),
    state: typeof readiness?.state === 'string' ? readiness.state : 'unavailable',
    message: typeof readiness?.message === 'string' ? readiness.message : 'Readiness is unavailable.',
  };
}

// Claude Code's own model picker sometimes maps a gateway-prefixed
// id (like claude-gpt-5.6-terra) to a Claude family name — it renders
// "Fable 5" for a Terra run. Nothing we return here overrides that (verified:
// the response model field is "gpt-5.6-terra" and the model self-reports GPT-5,
// so the RUN is correct — only the card label lies). Native subagent model
// display isn't a supported feature (anthropics/claude-code#24094, not planned).
// The sidequest agent NAME (sidequest-exec-codex-gpt-5-6-terra-*) carries the
// true runtime, so don't chase the badge by editing display_name — it's a dead
// end. See SQ-202.
function displayName(id, backend = 'codex') {
  if (backend === 'grok') return id.replace(/^grok-/, 'Grok ').replace(/-/g, ' ');
  if (backend === 'antigravity') return id.replace(/^gemini-/, 'Gemini ').replace(/\[1m\]$/, '') + ' (Antigravity)';
  return id.replace(/^gpt-/, 'GPT-').replace(/\[1m\]$/, '') + ' (Codex)';
}

function gatewayModel(id, backend = 'codex') {
  const policy = id === 'auto' ? null : resolveGatewayModelPolicy(id);
  if (id !== 'auto' && policy?.backend !== backend) return null;
  return {
    id: id === 'auto' ? DISPATCH_MODEL_ID : gatewayClientModelId(id),
    display_name: id === 'auto' ? 'Sidequest Dispatch (Codex)' : displayName(id, backend),
    type: 'model',
    max_input_tokens: gatewayAdvertisedWindow(id) || codexContextWindow(id),
  };
}

// Slugs keep the `codex-` backend name and so survive the id rename byte for
// byte: the board's route table pins slugs, and re-slugging would break every
// persisted route at once.
//
// Provider + base, dots→dashes, kept inside ^[a-z0-9][a-z0-9-]{1,31}$; on
// collision (or an over-length base) fall back to a short deterministic hash
// so the slug stays unique without depending on iteration order.
function slugFor(provider, base, used) {
  const providerPrefix = `${provider}-`;
  const providerBase = base.startsWith(providerPrefix) ? base.slice(providerPrefix.length) : base;
  let s = (providerPrefix + providerBase).toLowerCase()
    .replace(/\[1m\]$/, '')
    .replace(/\./g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!/^[a-z0-9]/.test(s)) s = 'x' + s;
  if (s.length > 32) {
    const hash = crypto.createHash('sha1').update(s).digest('hex').slice(0, 6);
    s = s.slice(0, 32 - 1 - hash.length) + '-' + hash;
  }
  let unique = s;
  let n = 2;
  while (used.has(unique)) {
    const suffix = '-' + n;
    unique = s.slice(0, Math.max(1, 32 - suffix.length)) + suffix;
    n++;
  }
  used.add(unique);
  return unique;
}

// "gpt-5.6-sol" -> "GPT-5.6 Sol", "gpt-5.3-codex-spark" -> "GPT-5.3 Codex Spark"
function labelFor(base) {
  const rest = base.replace(/^gpt-/, '');
  const m = rest.match(/^(\d+(?:\.\d+)?)(?:-(.+))?$/);
  if (!m) return 'GPT-' + rest.replace(/-/g, ' ');
  const [, ver, suffix] = m;
  const suffixLabel = suffix
    ? ' ' + suffix.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
    : '';
  return `GPT-${ver}${suffixLabel}`;
}

// `base` is the BACKEND id, family segment included (`grok-4.5`, `gemini-3-pro`),
// which is why the branches match on the full provider prefix but slice only
// PREFIX back off. Slicing the matched prefix instead would strip the family
// segment and leave displayName() nothing to recognise — `claude-grok-4.5[1m]`
// would label as "4.5" rather than "Grok 4.5", and slugFor() re-adds the
// provider prefix itself, so nothing downstream wants it gone.
function modelCatalogDetails(id) {
  const codexBase = codexBaseFromId(id);
  if (codexBase && codexBase !== 'auto') {
    return { provider: 'codex', base: codexBase, label: labelFor(codexBase) };
  }
  if (typeof id === 'string' && id.startsWith(GROK_PREFIX)) {
    const base = id.slice(PREFIX.length).replace(/\[1m\]$/, '');
    return { provider: 'grok', base, label: displayName(base, 'grok') };
  }
  if (typeof id === 'string' && id.startsWith(GEMINI_PREFIX)) {
    const base = id.slice(PREFIX.length).replace(/\[1m\]$/, '');
    return { provider: 'antigravity', base, label: displayName(base, 'antigravity') };
  }
  return null;
}

function unavailableProviderReadiness(provider) {
  return {
    ready: false,
    state: 'unavailable',
    message: `${provider} readiness is unavailable.`,
  };
}

function getGrokReadiness({ readAuth = grokBackend.readGrokAuth } = {}) {
  try {
    readAuth();
    return {
      ready: true,
      state: 'ready',
      message: 'Grok CLI auth is present.',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Grok CLI auth is unavailable. Run `grok` and log in again.';
    return {
      ready: false,
      state: /invalid/i.test(message) ? 'auth-invalid' : 'auth-missing',
      message,
    };
  }
}

function providerCatalogReadiness(provider, readiness) {
  const source = readiness?.[provider] ?? (provider === 'codex' ? readiness : null);
  if (source) return providerReadiness(source);
  if (provider === 'grok') return getGrokReadiness();
  // Antigravity has no local credential to probe: the proxy authenticates
  // per-request against the added Google account, so a static "ready" with the
  // instruction attached beats reporting a backend that works as unavailable.
  if (provider === 'antigravity') {
    return {
      ready: true,
      state: 'ready',
      message: 'Antigravity proxy readiness is checked per-request; run it with an added Google account.',
    };
  }
  return unavailableProviderReadiness(provider);
}

function buildCatalog(ids, readiness = null) {
  const used = new Set();
  const models = ids
    .map((id) => ({ id, details: modelCatalogDetails(id) }))
    .filter(({ details }) => details)
    .map(({ id, details }) => ({
      slug: slugFor(details.provider, details.base, used),
      // gatewayClientModelId is the picker id for EVERY provider, not just
      // Codex: it is what re-attaches the `[1m]` long-context suffix, so a
      // provider-conditional id here silently published unselectable rows.
      id: gatewayClientModelId(id),
      label: details.label,
      provider: details.provider,
    }));
  const providers = Object.fromEntries(
    [...new Set(models.map((model) => model.provider))].map((provider) => [provider, providerCatalogReadiness(provider, readiness)]),
  );
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    source: 'model-gateway',
    updatedAt: new Date().toISOString(),
    writtenBy: PLUGIN_VERSION,
    providers,
    codexReadiness: providers.codex ?? null,
    models,
  };
}

module.exports = {
  CATALOG_PATH,
  CATALOG_SCHEMA_VERSION,
  CATALOG_STALE_MS,
  buildCatalog,
  catalogReadiness,
  displayName,
  gatewayModel,
  getGrokReadiness,
  labelFor,
  modelCatalogDetails,
  providerCatalogReadiness,
  providerReadiness,
  readJsonFile,
  slugFor,
  unavailableProviderReadiness,
};
