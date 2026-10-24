#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
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

// src/lib/audit/local.ts
var require_local = __commonJS({
  "src/lib/audit/local.ts"(exports2, module2) {
    "use strict";
    function execute(git, args) {
      try {
        return git(args);
      } catch (_error) {
        return null;
      }
    }
    function mainRef(git) {
      if (execute(git, ["rev-parse", "--verify", "origin/main"]) !== null) return "origin/main";
      if (execute(git, ["rev-parse", "--verify", "main"]) !== null) return "main";
      return null;
    }
    function escapeRegex(value) {
      return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    function refPattern(ref) {
      return new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegex(ref)}(?![A-Za-z0-9_-])`);
    }
    function commitsFromLog(log) {
      return log.split("").flatMap((record) => {
        if (!record.trim()) return [];
        const [sha, date, subject, ...body] = record.trim().split("");
        if (!sha || !date || subject === void 0) return [];
        return [{ sha, date, subject, body: body.join("") }];
      });
    }
    function changelogVersionFor(changelog, ref) {
      let version = null;
      const matchesRef = refPattern(ref);
      for (const line of changelog.split(/\r?\n/)) {
        const heading = /^##\s+(v[^\s(]+)/.exec(line);
        if (heading) {
          version = heading[1] || null;
          continue;
        }
        if (version && matchesRef.test(line)) return version;
      }
      return null;
    }
    function deliveryCommit(ticket) {
      const values = [ticket.submission?.integration?.deliveryCommit, ticket.completion?.delivery?.commit];
      return values.map((value) => String(value || "").trim()).find(Boolean) || null;
    }
    function findLandedFixes(tickets, git) {
      const candidates = tickets.filter((ticket) => !ticket.archived && (ticket.status === "todo" || ticket.status === "doing") && ticket.id && ticket.ref);
      if (!candidates.length) return [];
      const main2 = mainRef(git);
      if (!main2) return null;
      const log = execute(git, ["log", main2, "--format=%H%x1f%aI%x1f%s%x1f%B%x1e"]);
      const fragments = execute(git, ["ls-tree", "-r", "--name-only", main2, "--", ".release/unreleased"]);
      const changelog = execute(git, ["show", `${main2}:CHANGELOG.md`]);
      if (log === null || fragments === null || changelog === null) return null;
      const fragmentPaths = new Set(fragments.split(/\r?\n/).filter(Boolean));
      const commits = commitsFromLog(log);
      return candidates.flatMap((ticket) => {
        const createdAt = new Date(String(ticket.createdAt || "")).valueOf();
        if (!Number.isFinite(createdAt)) return [];
        const matchesRef = refPattern(String(ticket.ref));
        const fragment = fragmentPaths.has(`.release/unreleased/${ticket.ref}.md`);
        const changelogVersion = changelogVersionFor(changelog, String(ticket.ref));
        const matchedCommits = commits.filter((commit) => new Date(commit.date).valueOf() > createdAt && matchesRef.test(commit.subject)).map(({ sha, subject, date }) => ({ sha, subject, date }));
        if (!matchedCommits.length || !fragment && !changelogVersion) return [];
        return [{
          ticketId: String(ticket.id),
          ref: String(ticket.ref),
          status: String(ticket.status),
          commits: matchedCommits,
          fragment,
          changelogVersion
        }];
      });
    }
    function releasedIn(ticket, git) {
      if (ticket.status !== "done") return null;
      const commit = deliveryCommit(ticket);
      if (!commit) return { version: null, tag: null, reason: "delivery_commit_unavailable" };
      const tags = execute(git, ["tag", "--contains", commit, "--list", "v*", "--sort=creatordate"]);
      if (tags === null) return { version: null, tag: null, reason: "git_evidence_unavailable" };
      const tag = tags.split(/\r?\n/).find(Boolean);
      return tag ? { version: tag.slice(1), tag } : null;
    }
    module2.exports = { deliveryCommit, findLandedFixes, releasedIn };
  }
});

// src/lib/audit/github.ts
var github_exports = {};
__export(github_exports, {
  applyGithub: () => applyGithub,
  planGithub: () => planGithub
});
function command(gh, arguments_) {
  try {
    const output = gh("gh", arguments_, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    return String(output).trim();
  } catch (error) {
    if (!gh.lastError) gh.lastError = String(error?.message || error || "gh command failed").replace(/\s+/g, " ").trim();
    return null;
  }
}
function jsonCommand(gh, arguments_) {
  const output = command(gh, arguments_);
  if (output == null) return null;
  try {
    return JSON.parse(output);
  } catch (_error) {
    return null;
  }
}
function labelNames(labels) {
  if (!Array.isArray(labels)) return [];
  return [...new Set(labels.map((label) => typeof label === "string" ? label : String(label?.name || "")).filter(Boolean))].sort();
}
function normalizedIssue(value) {
  if (!value || typeof value !== "object") return null;
  const issue = value;
  const number = Number(issue.number);
  if (!Number.isInteger(number) || number < 1) return null;
  const state = String(issue.state || "").toUpperCase();
  if (state !== "OPEN" && state !== "CLOSED") return null;
  return Object.freeze({ number, state, labels: labelNames(issue.labels), ...typeof issue.title === "string" ? { title: issue.title } : {} });
}
function releaseFor(released, ticketId) {
  if (!released) return null;
  if (released instanceof Map) return released.get(ticketId) || null;
  return released[ticketId] || null;
}
function versionParts(version) {
  const match = /v?(\d+(?:\.\d+)*)/i.exec(version);
  return match ? match[1].split(".").map(Number) : [];
}
function latestVersion(values) {
  return [...values].sort((left, right) => {
    const leftParts = versionParts(left);
    const rightParts = versionParts(right);
    const length = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < length; index += 1) {
      const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
      if (difference) return difference;
    }
    return left.localeCompare(right);
  }).at(-1) || "";
}
function ticketRank(ticket, released) {
  if (released) return 3;
  if (ticket.submission && !ticket.submission.integratedAt) return 1;
  if (ticket.status === "done") return 2;
  if (ticket.status === "doing" || ticket.status === "awaiting-oracle") return 1;
  return 0;
}
function desiredFor(tickets, released, currentLabels) {
  const releases = tickets.map((ticket) => releaseFor(released, ticket.id));
  const allReleased = releases.length > 0 && releases.every(Boolean);
  const rank = Math.min(...tickets.map((ticket, index) => ticketRank(ticket, releases[index] || null)));
  const status = allReleased ? null : rank === 2 ? "status:in-testing" : rank === 1 ? "status:in-progress" : null;
  const labels = currentLabels.filter((label) => !label.startsWith("status:"));
  if (status) labels.push(status);
  return { state: allReleased ? "CLOSED" : "OPEN", labels: [...new Set(labels)].sort(), releasedVersion: allReleased ? latestVersion(releases.map((release) => release.version)) : null };
}
function releaseComment(ticketIds, refs, version) {
  const marker = `<!-- sidequest:released ticket=${ticketIds.join(",")} version=${version} -->`;
  return {
    marker,
    body: `Fixed in ${version} (${refs.join(", ")}).

${marker}`
  };
}
function planGithub({ links, tickets, released, gh, repo: projectRepo }) {
  const ticketById = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const linksByIssue = /* @__PURE__ */ new Map();
  for (const link of links) {
    if (link.provider !== "github" || !ticketById.has(link.ticketId)) continue;
    const key = `${link.repo}#${link.number}`;
    linksByIssue.set(key, [...linksByIssue.get(key) || [], link]);
  }
  const repos = [...new Set([...linksByIssue.values()].flat().map((link) => link.repo).concat(typeof projectRepo === "string" && projectRepo.trim() ? [projectRepo.trim().toLowerCase()] : []))].sort();
  const issuesByRepo = /* @__PURE__ */ new Map();
  const warnings = [];
  let evidenceUnavailable = false;
  for (const repo of repos) {
    const payload = jsonCommand(gh, ["issue", "list", "--repo", repo, "--state", "all", "--limit", "1000", "--json", "number,state,labels,title"]);
    if (!Array.isArray(payload)) {
      evidenceUnavailable = true;
      warnings.push(`gh unavailable for ${repo}; GitHub sections skipped: ${gh.lastError || "invalid GitHub response"}.`);
      continue;
    }
    issuesByRepo.set(repo, payload.map(normalizedIssue).filter((issue) => issue !== null));
  }
  if (repos.length && !issuesByRepo.size) return Object.freeze({ linkedDrift: [], untrackedIssues: [], warnings: Object.freeze(["gh not authenticated; GitHub sections skipped.", ...warnings]), evidenceUnavailable });
  const linkedDrift = [];
  const untrackedIssues = [];
  for (const repo of repos) {
    const issues = issuesByRepo.get(repo);
    if (!issues) continue;
    for (const issue of issues) {
      const linked = linksByIssue.get(`${repo}#${issue.number}`) || [];
      if (!linked.length) {
        if (issue.state === "OPEN") untrackedIssues.push(Object.freeze({ ...issue, repo }));
        continue;
      }
      const linkedTickets = [...new Map(linked.map((link) => [link.ticketId, ticketById.get(link.ticketId)])).values()];
      const ticketIds = linkedTickets.map((ticket) => ticket.id).sort();
      const refs = linkedTickets.map((ticket) => ticket.ref).sort();
      const desired = desiredFor(linkedTickets, released, issue.labels);
      const actions = [];
      for (const label of desired.labels.filter((label2) => !issue.labels.includes(label2))) actions.push(Object.freeze({ type: "addLabel", label }));
      for (const label of issue.labels.filter((label2) => label2.startsWith("status:") && !desired.labels.includes(label2))) actions.push(Object.freeze({ type: "removeLabel", label }));
      if (desired.state === "CLOSED") {
        const comment = releaseComment(ticketIds, refs, desired.releasedVersion);
        if (!commentsContain(gh, repo, issue.number, comment.marker)) actions.push(Object.freeze({ type: "comment", ...comment }));
        if (issue.state !== desired.state) actions.push(Object.freeze({ type: "close" }));
      }
      if (issue.state !== desired.state && desired.state === "OPEN") actions.push(Object.freeze({ type: "reopen" }));
      if (actions.length) linkedDrift.push(Object.freeze({ repo, number: issue.number, ticketIds: Object.freeze(ticketIds), refs: Object.freeze(refs), current: Object.freeze({ state: issue.state, labels: Object.freeze([...issue.labels]) }), desired: Object.freeze({ state: desired.state, labels: Object.freeze(desired.labels) }), actions: Object.freeze(actions) }));
    }
  }
  return Object.freeze({ linkedDrift: Object.freeze(linkedDrift), untrackedIssues: Object.freeze(untrackedIssues), warnings: Object.freeze(warnings), evidenceUnavailable });
}
function paginatedArrays(output) {
  try {
    const payload = JSON.parse(output);
    return Array.isArray(payload) ? payload : null;
  } catch (_error) {
    const values = [];
    let offset = 0;
    while (offset < output.length) {
      while (/\s/.test(output[offset] || "")) offset += 1;
      if (output[offset] !== "[") return null;
      let depth = 0;
      let quoted = false;
      let escaped = false;
      let end = offset;
      for (; end < output.length; end += 1) {
        const character = output[end];
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') quoted = false;
          continue;
        }
        if (character === '"') quoted = true;
        else if (character === "[") depth += 1;
        else if (character === "]") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (depth !== 0) return null;
      try {
        const page = JSON.parse(output.slice(offset, end + 1));
        if (!Array.isArray(page)) return null;
        values.push(...page);
      } catch (_error2) {
        return null;
      }
      offset = end + 1;
    }
    return values;
  }
}
function commentsContain(gh, repo, number, marker) {
  const output = command(gh, ["api", `repos/${repo}/issues/${number}/comments`, "--paginate"]);
  const comments = output === null ? null : paginatedArrays(output);
  if (comments === null) return null;
  return comments.some((comment) => String(comment?.body || "").includes(marker));
}
function applyGithub(plan, gh) {
  if (!plan || !Array.isArray(plan.linkedDrift) || !plan.linkedDrift.length) return [];
  const results = [];
  const labelsToCreate = /* @__PURE__ */ new Map();
  for (const drift of plan.linkedDrift) for (const action of drift.actions) if (action.type === "addLabel" && (action.label === "status:in-progress" || action.label === "status:in-testing")) (labelsToCreate.get(drift.repo) || labelsToCreate.set(drift.repo, /* @__PURE__ */ new Set()).get(drift.repo)).add(action.label);
  for (const [repo, labels] of labelsToCreate) {
    const existing = jsonCommand(gh, ["label", "list", "--repo", repo, "--limit", "1000", "--json", "name"]);
    const names = new Set(Array.isArray(existing) ? existing.map((label) => String(label?.name || "")) : []);
    for (const label of labels) {
      if (names.has(label)) continue;
      const output = command(gh, ["label", "create", label, "--repo", repo, "--color", "0E8A16"]);
      results.push(Object.freeze({ repo, number: 0, action: `createLabel:${label}`, ok: output !== null, ...output === null ? { error: "gh command failed" } : {} }));
    }
  }
  for (const drift of plan.linkedDrift) {
    let commentReady = true;
    for (const action of drift.actions) {
      if (action.type === "addLabel" || action.type === "removeLabel") {
        const flag = action.type === "addLabel" ? "--add-label" : "--remove-label";
        const output = command(gh, ["issue", "edit", String(drift.number), "--repo", drift.repo, flag, action.label]);
        results.push(Object.freeze({ repo: drift.repo, number: drift.number, action: action.type, ok: output !== null, ...output === null ? { error: "gh command failed" } : {} }));
      } else if (action.type === "comment") {
        const present = commentsContain(gh, drift.repo, drift.number, action.marker);
        if (present === null) {
          commentReady = false;
          results.push(Object.freeze({ repo: drift.repo, number: drift.number, action: "comment", ok: false, error: "could not list issue comments" }));
        } else if (present) {
          results.push(Object.freeze({ repo: drift.repo, number: drift.number, action: "comment", ok: true, skipped: true }));
        } else {
          const output = command(gh, ["issue", "comment", String(drift.number), "--repo", drift.repo, "--body", action.body]);
          commentReady = output !== null;
          results.push(Object.freeze({ repo: drift.repo, number: drift.number, action: "comment", ok: commentReady, ...commentReady ? {} : { error: "gh command failed" } }));
        }
      } else if (action.type === "close") {
        if (!commentReady) results.push(Object.freeze({ repo: drift.repo, number: drift.number, action: "close", ok: false, skipped: true, error: "comment failed" }));
        else {
          const output = command(gh, ["issue", "close", String(drift.number), "--repo", drift.repo]);
          results.push(Object.freeze({ repo: drift.repo, number: drift.number, action: "close", ok: output !== null, ...output === null ? { error: "gh command failed" } : {} }));
        }
      } else {
        const output = command(gh, ["issue", "reopen", String(drift.number), "--repo", drift.repo]);
        results.push(Object.freeze({ repo: drift.repo, number: drift.number, action: "reopen", ok: output !== null, ...output === null ? { error: "gh command failed" } : {} }));
      }
    }
  }
  return Object.freeze(results);
}
var init_github = __esm({
  "src/lib/audit/github.ts"() {
    "use strict";
  }
});

// src/lib/audit/mirror.ts
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
var MIRRORED_FIELDS, REDACTED, TITLE_MAX, BODY_MAX, INTERNAL_CATEGORY_PATTERN, STATIC_RULES, REDACTION_CLASSES;
var init_mirror = __esm({
  "src/lib/audit/mirror.ts"() {
    "use strict";
    MIRRORED_FIELDS = Object.freeze(["title", "description"]);
    REDACTED = "[redacted]";
    TITLE_MAX = 200;
    BODY_MAX = 6e4;
    INTERNAL_CATEGORY_PATTERN = /(^|[.\-_])(review|audit|investigation|research|lookup|recon|explore|exploration|plan|planning|grooming|groom|readonly|read-only|triage|chore|infra|release)([.\-_]|$)/i;
    STATIC_RULES = Object.freeze([
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
    REDACTION_CLASSES = Object.freeze([...STATIC_RULES.map((rule) => rule.id), "machine-hostname", "foreign-project"]);
  }
});

// src/lib/audit/report.ts
var require_report = __commonJS({
  "src/lib/audit/report.ts"(exports2, module2) {
    "use strict";
    var import_node_child_process2 = require("node:child_process");
    var import_node_os2 = __toESM(require("node:os"));
    var { deliveryCommit, findLandedFixes, releasedIn } = require_local();
    var { planGithub: planGithub2, applyGithub: applyGithub2 } = (init_github(), __toCommonJS(github_exports));
    var { planIssueMirror: planIssueMirror2, applyIssueMirror: applyIssueMirror2 } = (init_mirror(), __toCommonJS(mirror_exports));
    var AUDIT_COMMAND_TIMEOUT_MS = 15e3;
    var AUDIT_COMMAND_MAX_BUFFER = 16 * 1024 * 1024;
    function errorText(error) {
      const value = error;
      const message = String(value?.message || error || "command failed").replace(/\s+/g, " ").trim();
      const code = value?.code ? ` (${String(value.code)})` : "";
      return `${message}${code}`;
    }
    function githubRepo(remote) {
      const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(String(remote || "").trim());
      return match ? match[1].replace(/\.git$/i, "").toLowerCase() : null;
    }
    function gitExecutor(cwd, execute = import_node_child_process2.execFileSync) {
      const git = ((args) => {
        try {
          return String(execute("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: AUDIT_COMMAND_TIMEOUT_MS, maxBuffer: AUDIT_COMMAND_MAX_BUFFER, killSignal: "SIGKILL" }));
        } catch (error) {
          git.lastError = errorText(error);
          return null;
        }
      });
      return git;
    }
    function ghExecutor(execute = import_node_child_process2.execFileSync) {
      const gh = ((program, arguments_, options = {}) => {
        try {
          return execute(program, arguments_, { ...options, timeout: AUDIT_COMMAND_TIMEOUT_MS, killSignal: "SIGKILL" });
        } catch (error) {
          gh.lastError = errorText(error);
          throw error;
        }
      });
      return gh;
    }
    function evidenceError(executor, fallback) {
      return executor.lastError || fallback;
    }
    function auditReport(input, apply = false) {
      const tickets = input.tickets.filter((ticket) => ticket && ticket.id && ticket.ref);
      const warnings = [];
      let evidenceUnavailable = false;
      const staleEvidence = findLandedFixes(tickets, input.git);
      const titleById = new Map(tickets.map((ticket) => [ticket.id, ticket.title || ""]));
      const staleBoardTickets = staleEvidence === null ? null : staleEvidence.map((item) => Object.freeze({ ...item, title: titleById.get(item.ticketId) || "" }));
      if (staleBoardTickets === null) {
        evidenceUnavailable = true;
        warnings.push(`git evidence unavailable; stale board tickets skipped: ${evidenceError(input.git, "git command failed")}.`);
      }
      const linkedTicketIds = new Set(input.links.filter((link) => link.provider === "github").map((link) => link.ticketId));
      const released = /* @__PURE__ */ new Map();
      const releaseByCommit = /* @__PURE__ */ new Map();
      for (const ticket of tickets) {
        if (ticket.status !== "done" || !linkedTicketIds.has(String(ticket.id))) continue;
        const commit = deliveryCommit(ticket);
        const result = commit && releaseByCommit.has(commit) ? releaseByCommit.get(commit) : releasedIn(ticket, input.git);
        if (commit) releaseByCommit.set(commit, result);
        if (result && result.version && ticket.id) released.set(String(ticket.id), { version: `v${result.version}` });
        else if (result?.reason === "delivery_commit_unavailable" && ticket.ref) warnings.push(`${ticket.ref}: delivery commit unavailable; release status cannot be determined.`);
        else if (result?.reason === "git_evidence_unavailable") {
          evidenceUnavailable = true;
          warnings.push(`${ticket.ref}: git evidence unavailable; release status cannot be determined: ${evidenceError(input.git, "git command failed")}.`);
        }
      }
      if (!input.repo) {
        evidenceUnavailable = true;
        warnings.push(`GitHub project remote unavailable; untracked issue scan skipped: ${evidenceError(input.git, "origin remote unavailable")}.`);
      }
      const plan = planGithub2({ links: input.links, tickets, released, gh: input.gh, ...input.repo ? { repo: input.repo } : {} });
      if (plan.evidenceUnavailable) evidenceUnavailable = true;
      warnings.push(...plan.warnings);
      const applied = apply ? [...applyGithub2(plan, input.gh)] : [];
      const mirror = planIssueMirror2({ tickets, links: input.links, config: input.issueMirror, repo: input.repo || null, context: input.mirrorContext });
      warnings.push(...mirror.warnings);
      if (apply && mirror.creations.length && typeof input.link === "function") applied.push(...applyIssueMirror2(mirror, input.gh, input.link));
      else if (apply && mirror.creations.length) warnings.push("issue mirror has creations but no link writer; no issues were created.");
      return Object.freeze({
        staleBoardTickets: Object.freeze(staleBoardTickets || []),
        untrackedIssues: plan.untrackedIssues,
        linkedDrift: plan.linkedDrift,
        issueMirror: apply ? Object.freeze([]) : mirror.creations,
        warnings: Object.freeze([...new Set(warnings)]),
        applied: Object.freeze(applied),
        evidenceUnavailable
      });
    }
    function githubRepoFromGh(gh, cwd) {
      try {
        const name = String(gh("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true })).trim();
        return /^[^/\s]+\/[^/\s]+$/.test(name) ? name.toLowerCase() : null;
      } catch (error) {
        if (!gh.lastError) gh.lastError = errorText(error);
        return null;
      }
    }
    function foreignProjectNames(store, slug) {
      try {
        const projects = typeof store.listProjects === "function" ? store.listProjects({ all: true }) : [];
        return (Array.isArray(projects) ? projects : []).filter((project) => project && project.slug && project.slug !== slug).flatMap((project) => [String(project.slug || ""), String(project.name || "")]).filter(Boolean);
      } catch (_error) {
        return [];
      }
    }
    function auditProject2(project, store, apply = false, dependencies = {}) {
      const projectPath = project.path || project.meta?.path;
      if (!projectPath) throw new Error(`audit project ${project.slug} has no filesystem path`);
      const git = dependencies.git || gitExecutor(projectPath);
      const gh = dependencies.gh || ghExecutor();
      let remote = dependencies.remote;
      if (remote === void 0) remote = git(["remote", "get-url", "origin"]);
      const repo = githubRepo(remote) || (remote ? githubRepoFromGh(gh, projectPath) : null);
      let issueMirror = null;
      try {
        issueMirror = typeof store.boardConfig === "function" ? store.boardConfig(project.slug)?.issueMirror : null;
      } catch (_error) {
        issueMirror = null;
      }
      return auditReport({
        tickets: store.listTickets(project.slug),
        links: store.listExternalLinks(project.slug, {}),
        git,
        gh,
        repo,
        issueMirror,
        mirrorContext: { hostname: import_node_os2.default.hostname(), foreignProjects: foreignProjectNames(store, project.slug) },
        ...typeof store.addExternalLink === "function" ? { link: (ticketId, record) => store.addExternalLink(project.slug, ticketId, record) } : {}
      }, apply);
    }
    function trunc(value, max = 72) {
      const text = String(value || "").replace(/\s+/g, " ").trim();
      return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
    }
    function actions(drift) {
      return (drift.actions || []).map((action) => action.type === "addLabel" || action.type === "removeLabel" ? `${action.type} ${action.label}` : action.type).join(", ");
    }
    function formatAudit(report) {
      const sections = [
        ["STALE BOARD TICKETS", report.staleBoardTickets, (item) => `${item.ref} ${trunc(item.title || "")} — ${(item.commits || []).map((commit) => commit.sha).join(", ") || "landed fix"}`],
        ["UNTRACKED ISSUES", report.untrackedIssues, (item) => `${item.repo}#${item.number} ${trunc(item.title || "")} — https://github.com/${item.repo}/issues/${item.number}`],
        ["LINKED DRIFT", report.linkedDrift, (item) => `${(item.refs || []).join(", ")} — https://github.com/${item.repo}/issues/${item.number}; proposed: ${actions(item)}`],
        // The dry run prints the exact sanitized title and the body it would post, so
        // a human can read the first mirror before it reaches a public tracker.
        ["ISSUE MIRROR", report.issueMirror || [], (item) => `would create issue for ${item.ref} in ${item.repo}: ${JSON.stringify(item.title)}${item.labels.length ? ` [${item.labels.join(", ")}]` : ""}
  body: ${item.body.split("\n").join("\n  ")}`],
        ["WARNINGS", report.warnings, (item) => String(item)]
      ];
      const lines = sections.flatMap(([name, items, render]) => [`${name} (${items.length})`, ...items.map(render)]);
      if (report.applied.length) lines.push(`APPLIED (${report.applied.length})`, ...report.applied.map((item) => `${item.repo}#${item.number || "labels"} ${item.action}: ${item.ok ? "ok" : item.error || "failed"}`));
      return lines.join("\n");
    }
    function auditSummary2(report) {
      const counts = [
        [report.staleBoardTickets.length, "board tickets have subject-tagged main commits plus delivery evidence"],
        [report.untrackedIssues.length, "untracked issues"],
        [report.linkedDrift.length, "linked issues drifting"],
        [(report.issueMirror || []).length, "tickets would be mirrored to new issues"]
      ].filter(([count]) => Number(count) > 0);
      return counts.length ? `sidequest audit: ${counts.map(([count, label]) => `${count} ${label}`).join(", ")}. Run \`sidequest audit\` for detail.` : "";
    }
    module2.exports = { auditProject: auditProject2, auditReport, auditSummary: auditSummary2, formatAudit, ghExecutor, gitExecutor };
  }
});

// src/hooks/audit-report.ts
var import_node_path4 = __toESM(require("node:path"));

// src/hooks/shared/paths.ts
var import_node_path = __toESM(require("node:path"));
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || import_node_path.default.join(__dirname, "..");
}
function runtimeModule(name) {
  return import_node_path.default.join(pluginRoot(), "lib", `${name}.js`);
}

// src/hooks/shared/audit-handoff.ts
var import_node_child_process = require("node:child_process");
var import_node_crypto = __toESM(require("node:crypto"));
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path3 = __toESM(require("node:path"));

// src/lib/claude-home.ts
var import_node_os = __toESM(require("node:os"));
var import_node_path2 = __toESM(require("node:path"));
function resolveSidequestHome(env = process.env) {
  const explicit = String(env.SIDEQUEST_HOME || "").trim();
  if (explicit) return import_node_path2.default.resolve(explicit);
  const configDir = String(env.CLAUDE_CONFIG_DIR || "").trim();
  return import_node_path2.default.join(configDir ? import_node_path2.default.resolve(configDir) : import_node_path2.default.join(import_node_os.default.homedir(), ".claude"), "sidequest");
}

// src/hooks/shared/input.ts
var import_node_fs = __toESM(require("node:fs"));

// src/lib/exec-names.ts
var EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
var CLAUDE_PREFIX = "sidequest-exec-";
var READ_ONLY_CLAUDE_PREFIX = "sidequest-exec-readonly-";
var DIAGNOSTIC_PROBE_NAME = "sidequest-diagnostic-probe";
var DISPATCH_NAME = "sidequest-exec-dispatch";
var READ_ONLY_DISPATCH_NAME = "sidequest-exec-dispatch-readonly";
function stableClaudeName(effort) {
  return `${CLAUDE_PREFIX}${effort}`;
}
function stableReadOnlyClaudeName(effort) {
  return `${READ_ONLY_CLAUDE_PREFIX}${effort}`;
}
var BUNDLED_AGENT_NAMES = /* @__PURE__ */ new Set([
  DISPATCH_NAME,
  READ_ONLY_DISPATCH_NAME,
  DIAGNOSTIC_PROBE_NAME,
  ...EFFORTS.map(stableClaudeName),
  ...EFFORTS.map(stableReadOnlyClaudeName)
]);

// src/hooks/shared/audit-handoff.ts
function stateDirectory() {
  const home = resolveSidequestHome();
  return import_node_path3.default.join(home, "audit-reports");
}
function auditReportFile(cwd) {
  const key = import_node_crypto.default.createHash("sha1").update(import_node_path3.default.resolve(cwd || ".")).digest("hex").slice(0, 16);
  return import_node_path3.default.join(stateDirectory(), `${key}.json`);
}
function writeAuditHandoffReport(cwd, report) {
  try {
    import_node_fs2.default.mkdirSync(stateDirectory(), { recursive: true });
    import_node_fs2.default.writeFileSync(auditReportFile(cwd), JSON.stringify({ summary: String(report.summary || ""), finishedAt: (/* @__PURE__ */ new Date()).toISOString() }));
  } catch (_) {
  }
}

// src/hooks/audit-report.ts
var { auditProject, auditSummary } = require_report();
function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : "";
}
function main() {
  const cwd = import_node_path4.default.resolve(argument("--cwd") || process.cwd());
  try {
    const store = require(runtimeModule("store"));
    const found = store.findProject(store.nearestRepoRoot(cwd));
    if (!found.ok || !found.slug || !found.meta?.path) return writeAuditHandoffReport(cwd, {});
    const report = auditProject({ slug: found.slug, path: found.meta.path }, store);
    writeAuditHandoffReport(cwd, { summary: auditSummary(report) });
  } catch (_) {
    writeAuditHandoffReport(cwd, {});
  }
}
main();
