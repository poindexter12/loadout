"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var mirror_exports = {};
__export(mirror_exports, {
  MIRRORED_FIELDS: () => MIRRORED_FIELDS,
  REDACTED: () => REDACTED,
  REDACTION_CLASSES: () => REDACTION_CLASSES,
  applyIssueMirror: () => applyIssueMirror,
  defaultIssueMirror: () => defaultIssueMirror,
  mirrorMatches: () => mirrorMatches,
  planIssueMirror: () => planIssueMirror,
  redactionClassesFor: () => redactionClassesFor,
  renderMirrorIssue: () => renderMirrorIssue,
  sanitizeText: () => sanitizeText
});
module.exports = __toCommonJS(mirror_exports);
const MIRRORED_FIELDS = Object.freeze(["title", "description"]);
const REDACTED = "[redacted]";
const TITLE_MAX = 200;
const BODY_MAX = 6e4;
const INTERNAL_CATEGORY_PATTERN = /(^|[.\-_])(review|audit|investigation|research|lookup|recon|explore|exploration|plan|planning|grooming|groom|readonly|read-only|triage|chore|infra|release)([.\-_]|$)/i;
const STATIC_RULES = Object.freeze([
  Object.freeze({ id: "home-path", pattern: /(?:\$HOME|~)\/[^\s"'`)\]]*/g }),
  Object.freeze({ id: "absolute-path", pattern: /(?:[A-Za-z]:[\\/][^\s"'`)\]]*)|(?:(?<![\w.:~])\/[A-Za-z0-9._-]+\/[A-Za-z0-9._\-/]*)/g }),
  Object.freeze({ id: "session-id", pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi }),
  Object.freeze({ id: "dispatch-token", pattern: /\b(?:token|tokenfile|token-file|secret|api[_-]?key|bearer)\b\s*[:=]?\s*\S+/gi }),
  Object.freeze({ id: "opaque-identifier", pattern: /\b[0-9a-f]{24,}\b/gi }),
  Object.freeze({ id: "cost", pattern: /(?:\$\s?\d[\d,]*(?:\.\d+)?)|(?:\b\d[\d,.]*\s?(?:USD|usd)\b)|(?:\b[\d,.]+[kKmM]?\s?tokens?\b)|(?:\b(?:cost|spend|usage|budget)\b\s*[:=]\s*\S+)/g }),
  Object.freeze({ id: "hostname", pattern: /\b[A-Za-z0-9][A-Za-z0-9-]*\.(?:local|lan|internal|home\.arpa)\b/gi }),
  Object.freeze({ id: "claim-owner", pattern: /\b(?:(?:sq|us)-\d+-[A-Za-z0-9][A-Za-z0-9-]*)|(?:(?:orchestrator|executor|agent|worktree-agent)-[0-9a-z]{6,})|(?:sidequest-exec-[a-z0-9-]+)\b/gi }),
  Object.freeze({ id: "board-slug", pattern: /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)*-[0-9a-f]{8}\b/g }),
  Object.freeze({ id: "board-ref", pattern: /\b(?:SQ|US)-\d+\b/gi })
]);
const REDACTION_CLASSES = Object.freeze([...STATIC_RULES.map((rule) => rule.id), "machine-hostname", "foreign-project"]);
function literalRule(id, values) {
  const terms = [...new Set(values.map((value) => String(value || "").trim()).filter((value) => value.length >= 3))].sort((left, right) => right.length - left.length).map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return terms.length ? Object.freeze({ id, pattern: new RegExp(`(?<![\\w-])(?:${terms.join("|")})(?![\\w-])`, "gi") }) : null;
}
function rulesFor(context) {
  const extra = [];
  const hostname = String(context?.hostname || "").trim();
  const hostRule = hostname ? literalRule("machine-hostname", [hostname, hostname.split(".")[0] || ""]) : null;
  if (hostRule) extra.push(hostRule);
  const foreignRule = literalRule("foreign-project", context?.foreignProjects || []);
  if (foreignRule) extra.push(foreignRule);
  return [...STATIC_RULES, ...extra];
}
function protectUrls(text) {
  const urls = [];
  const masked = text.replace(/https?:\/\/[^\s<>"'`)\]]+/g, (url) => {
    urls.push(url);
    return `\0URL${urls.length - 1}\0`;
  });
  return { text: masked, restore: (value) => value.replace(/\u0000URL(\d+)\u0000/g, (_match, index) => urls[Number(index)] || "") };
}
function redactionClassesFor(text, context) {
  const { text: masked } = protectUrls(String(text || ""));
  return Object.freeze(rulesFor(context).filter((rule) => {
    rule.pattern.lastIndex = 0;
    return rule.pattern.test(masked);
  }).map((rule) => rule.id));
}
function sanitizeText(text, context) {
  const { text: masked, restore } = protectUrls(String(text || ""));
  let value = masked;
  for (const rule of rulesFor(context)) {
    rule.pattern.lastIndex = 0;
    value = value.replace(rule.pattern, REDACTED);
  }
  return restore(value).replace(new RegExp(`(?:${REDACTED.replace(/[[\]]/g, "\\$&")})(?:\\s*${REDACTED.replace(/[[\]]/g, "\\$&")})+`, "g"), REDACTED).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
function defaultIssueMirror() {
  return Object.freeze({ enabled: false, labels: Object.freeze([]), categories: Object.freeze([]), stories: Object.freeze([]), labelMap: Object.freeze({ bug: "bug", feature: "enhancement" }) });
}
function categoryId(ticket) {
  const value = ticket.category;
  if (value == null) return String(ticket.categoryId || "");
  if (typeof value === "object") return String(ticket.categoryId || value.id || "");
  return String(value);
}
function ticketLabels(ticket) {
  return Array.isArray(ticket.labels) ? ticket.labels.map((label) => String(label || "").trim().toLowerCase()).filter(Boolean) : [];
}
function mirrorMatches(ticket, config) {
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
function githubLabels(ticket, config) {
  const map = new Map(Object.entries(config.labelMap || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return [...new Set(ticketLabels(ticket).map((label) => map.get(label)).filter((label) => Boolean(label)))].sort();
}
function renderMirrorIssue(ticket, config, context) {
  const title = sanitizeText(String(ticket.title || ""), context).slice(0, TITLE_MAX).trim();
  if (!title || title === REDACTED) return { reason: "title is empty after sanitization" };
  if (title.includes(REDACTED)) return { reason: "title contains sanitized content" };
  const description = sanitizeText(String(ticket.description || ""), context).slice(0, BODY_MAX).trim();
  const body = description || title;
  const residue = [.../* @__PURE__ */ new Set([...redactionClassesFor(title, context), ...redactionClassesFor(body.replace(/\[redacted\]/g, ""), context)])];
  if (residue.length) return { reason: `sanitized rendering still matches ${residue.join(", ")}` };
  return { title, body, labels: Object.freeze(githubLabels(ticket, config)) };
}
function planIssueMirror({ tickets, links, config, repo, context }) {
  const empty = Object.freeze({ creations: Object.freeze([]), skipped: Object.freeze([]), warnings: Object.freeze([]) });
  if (!config || !config.enabled) return empty;
  if (!repo) return Object.freeze({ creations: Object.freeze([]), skipped: Object.freeze([]), warnings: Object.freeze(["issue mirror is on but the project has no GitHub origin repo; no issues were planned."]) });
  const alreadyLinked = new Set(links.filter((link) => link.provider === "github").map((link) => String(link.ticketId)));
  const creations = [];
  const skipped = [];
  const warnings = [];
  for (const ticket of tickets) {
    if (!ticket?.id || !ticket.ref || alreadyLinked.has(String(ticket.id)) || !mirrorMatches(ticket, config)) continue;
    const rendered = renderMirrorIssue(ticket, config, context);
    if ("reason" in rendered) {
      skipped.push(Object.freeze({ ticketId: String(ticket.id), ref: String(ticket.ref), reason: rendered.reason }));
      warnings.push(`${ticket.ref}: issue mirror skipped; ${rendered.reason}.`);
      continue;
    }
    creations.push(Object.freeze({ ticketId: String(ticket.id), ref: String(ticket.ref), repo, title: rendered.title, body: rendered.body, labels: rendered.labels }));
  }
  return Object.freeze({ creations: Object.freeze(creations), skipped: Object.freeze(skipped), warnings: Object.freeze(warnings) });
}
function existingLabels(gh, repo) {
  try {
    const output = gh("gh", ["label", "list", "--repo", repo, "--limit", "1000", "--json", "name"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const payload = JSON.parse(String(output).trim());
    return new Set(Array.isArray(payload) ? payload.map((label) => String(label?.name || "")) : []);
  } catch (_error) {
    return /* @__PURE__ */ new Set();
  }
}
function issueNumber(url) {
  const match = /\/issues\/(\d+)\/?$/.exec(url.trim());
  return match ? Number(match[1]) : 0;
}
function applyIssueMirror(plan, gh, link) {
  if (!plan || !plan.creations.length || typeof link !== "function") return Object.freeze([]);
  const results = [];
  const labelCache = /* @__PURE__ */ new Map();
  for (const creation of plan.creations) {
    if (!labelCache.has(creation.repo)) labelCache.set(creation.repo, existingLabels(gh, creation.repo));
    const usable = creation.labels.filter((label) => labelCache.get(creation.repo).has(label));
    const arguments_ = ["issue", "create", "--repo", creation.repo, "--title", creation.title, "--body", creation.body];
    for (const label of usable) arguments_.push("--label", label);
    let url = "";
    try {
      url = String(gh("gh", arguments_, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true })).trim().split(/\s+/).filter((value) => value.startsWith("http")).at(-1) || "";
    } catch (error) {
      results.push(Object.freeze({ repo: creation.repo, number: 0, action: "createIssue", ok: false, ref: creation.ref, error: String(error?.message || "gh command failed").replace(/\s+/g, " ").trim() }));
      continue;
    }
    const number = issueNumber(url);
    if (!number) {
      results.push(Object.freeze({ repo: creation.repo, number: 0, action: "createIssue", ok: false, ref: creation.ref, error: "gh issue create returned no issue URL" }));
      continue;
    }
    try {
      link(creation.ticketId, { provider: "github", repo: creation.repo, number, url });
    } catch (error) {
      results.push(Object.freeze({ repo: creation.repo, number, action: "linkIssue", ok: false, ref: creation.ref, url, error: String(error?.message || "link failed").replace(/\s+/g, " ").trim() }));
      continue;
    }
    results.push(Object.freeze({ repo: creation.repo, number, action: "createIssue", ok: true, ref: creation.ref, url }));
  }
  return Object.freeze(results);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MIRRORED_FIELDS,
  REDACTED,
  REDACTION_CLASSES,
  applyIssueMirror,
  defaultIssueMirror,
  mirrorMatches,
  planIssueMirror,
  redactionClassesFor,
  renderMirrorIssue,
  sanitizeText
});
