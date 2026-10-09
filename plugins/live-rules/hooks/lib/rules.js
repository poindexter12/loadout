'use strict';
/**
 * live-rules - shared hook library
 *
 * Pure Node stdlib, no external dependencies, cross-platform. Loaded by both
 * hook entry scripts. Every function is written to fail soft: a malformed rule
 * file degrades to "skip that rule", never to a thrown error that could break a
 * prompt or an edit. The entry scripts wrap everything in try/catch and exit 0.
 *
 * STORAGE (SQ-292): rules are native Claude Code rule files. One rule per file
 * in .claude/rules/*.md, read directly at hook time. There is no manifest, no
 * sync step and no writer lock: the files on disk are the only source of truth
 * and their content hashes are computed on every read.
 *
 *   .claude/rules/react.md         a project rule, native loads it too
 *   .claude/rules/react.local.md   personal to this clone, gitignored
 *   .claude/rules/react.md.off     disabled; neither native nor live-rules read it
 *
 * Only *.md is read, which is what makes disable-by-rename work: native
 * discovers .md and nothing else, so renaming to .md.off hides a rule from both
 * readers at once. A .local.md file is a rule like any other here.
 *
 * Scanning is NON-RECURSIVE: only the top level of .claude/rules/ is read.
 * Native is recursive, so a rule in a subdirectory loads natively but is never
 * re-grounded by live-rules. That is a timing difference, never a suppression.
 *
 * File format: optional YAML frontmatter, then the rule body.
 *
 *   ---
 *   description: React component conventions   # human title for the rule
 *   paths: ["**\/*.tsx", "**\/*.jsx"]          # scope (native's key) -> PreToolUse
 *   prompt: ["deploy", "/migrat(e|ion)/i"]     # keyword -> UserPromptSubmit
 *   priority: 10                               # higher injects first (default 0)
 *   reground: true                             # opt in to a periodic re-say
 *   ---
 *   - Prefer function components.
 *   - No inline styles; use CSS modules.
 *
 * `paths:` is native's scope key and takes a YAML list or a comma-separated
 * scalar. `globs:` and `dirs:` are accepted as deprecated aliases for it (one
 * stderr notice per process) because native ignores them, so a rule still
 * carrying them would load unscoped. There is no `enabled:` key: native ignores
 * unknown keys, so a rule disabled in frontmatter would still load natively.
 * Disabling is a rename to .md.off.
 *
 * Scope is inferred from which fields are present. A rule that declares neither
 * paths nor prompt is "always-on" and injected on every prompt.
 *
 * NATIVE FIRST (SQ-293). Native Claude Code reads the same files, so every rule
 * it loads is already in context and live-rules must not say it a second time.
 * live-rules therefore contributes timing only:
 *   - a rule native loads (no `paths:`, or a `paths:` rule whose file is being
 *     touched right now) is recorded in the session ledger and NOT emitted;
 *     it is emitted later only when its content hash has changed since.
 *   - a keyword (`prompt:`) rule is the one kind native cannot deliver on
 *     demand, so it is emitted on a keyword match. Native would load a
 *     `paths:`-less file globally, so a keyword-only rule carries the
 *     NEVER_MATCH_PATH sentinel below as its `paths:` value.
 *   - `reground: true` opts a rule into a periodic re-say; see session-ledger.js
 *     for the cadence. Default off.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Stay safely under Claude Code's 10,000-char cap on injected context; the
// header plus the system-reminder wrapping eat into that budget too.
const CONTEXT_CAP = 9000;

/* ------------------------------------------------------------------ *
 *  Input / environment
 * ------------------------------------------------------------------ */

function readStdin() {
  // Hook input arrives as a single JSON object on stdin.
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch (_) {
    return {};
  }
}

function getProjectDir(data) {
  return (
    process.env.CLAUDE_PROJECT_DIR ||
    (data && typeof data.cwd === 'string' && data.cwd) ||
    process.cwd()
  );
}

/* ------------------------------------------------------------------ *
 *  Minimal YAML-subset frontmatter parser
 *  Supports: scalars (string/bool/number/null), inline arrays [a, b],
 *  block arrays (- item), quoted strings, and "# comments". Not full YAML.
 * ------------------------------------------------------------------ */

// A quote only opens a quoted scalar at a token boundary (start, or after
// whitespace / "[" / ","), matching YAML flow-scalar semantics. That way a lone
// apostrophe inside an unquoted value ("don't") stays literal instead of
// swallowing the rest of the line.
function isQuoteBoundary(prev) {
  return prev === '' || prev === ' ' || prev === '\t' || prev === '[' || prev === ',';
}

function stripComment(s) {
  let quote = null;
  for (let j = 0; j < s.length; j++) {
    const ch = s[j];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if ((ch === '"' || ch === "'") && isQuoteBoundary(j === 0 ? '' : s[j - 1])) {
      quote = ch;
    } else if (ch === '#' && (j === 0 || /\s/.test(s[j - 1]))) {
      return s.slice(0, j);
    }
  }
  return s;
}

function parseScalar(v) {
  v = String(v).trim();
  if (v === '') return '';
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    return v.slice(1, -1);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function parseInlineArray(v) {
  const inner = v.replace(/^\[/, '').replace(/\][ \t]*$/, '');
  if (inner.trim() === '') return [];
  const parts = [];
  let cur = '';
  let quote = null; // active quote char inside a quoted element
  let depth = 0; // brace depth, so commas inside "{ts,tsx}" do not split
  for (let j = 0; j < inner.length; j++) {
    const ch = inner[j];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if ((ch === '"' || ch === "'") && isQuoteBoundary(j === 0 ? '' : inner[j - 1])) {
      quote = ch;
      cur += ch;
    } else if (ch === '{') {
      depth++;
      cur += ch;
    } else if (ch === '}') {
      if (depth > 0) depth--;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts.map(parseScalar).filter((p) => p !== '' && p != null);
}

function parseYamlSubset(src) {
  const lines = src.split(/\r?\n/);
  const data = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    i++;
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const rest = stripComment(m[2]).trim();
    if (rest === '') {
      // A block list may follow on indented "- item" lines.
      const items = [];
      while (i < lines.length && /^[ \t]+-[ \t]+/.test(lines[i])) {
        items.push(parseScalar(stripComment(lines[i].replace(/^[ \t]+-[ \t]+/, '')).trim()));
        i++;
      }
      data[key] = items.length ? items : '';
    } else if (rest.startsWith('[')) {
      data[key] = parseInlineArray(rest);
    } else {
      data[key] = parseScalar(rest);
    }
  }
  return data;
}

/* ------------------------------------------------------------------ *
 *  Glob matching (pure Node, gitignore-style anchoring)
 * ------------------------------------------------------------------ */

const _globCache = new Map();

function escapeLiteral(s) {
  // Escape every regex metacharacter so glob literals (especially ".") stay literal.
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(glob) {
  // Strip a leading "./" or "/": paths are matched repo-relative, so a leading
  // slash is just the gitignore "anchor at root" idiom and is a no-op here.
  glob = String(glob).replace(/\\/g, '/').replace(/^\.?\//, '');
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // "**" -> any depth, including zero directories
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else if (re.endsWith('/')) {
          re = re.slice(0, -1) + '(?:/.*)?'; // "a/b/**" also matches bare "a/b"
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*'; // "*" stays within a single path segment
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
      } else {
        re += '(?:' + glob.slice(i + 1, end).split(',').map(escapeLiteral).join('|') + ')';
        i = end;
      }
    } else {
      re += escapeLiteral(c);
    }
  }
  return new RegExp('^' + re + '$');
}

function compiledGlob(glob) {
  let re = _globCache.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    _globCache.set(glob, re);
  }
  return re;
}

function normPath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.?\//, '');
}

/**
 * gitignore-style match: a pattern with no "/" matches the basename at any
 * depth (so "*.sql" matches "db/x.sql"); a pattern containing "/" is anchored
 * to the repo-relative path.
 *
 * Dotfiles are NOT excluded: "*" matches a leading dot, so "*.md" matches
 * ".hidden.md". See test/matcher-conformance.test.js for the pinned table.
 */
function ruleGlobMatches(glob, relPath) {
  const p = normPath(relPath);
  if (compiledGlob(glob).test(p)) return true;
  if (!String(glob).includes('/')) {
    const base = p.split('/').pop();
    if (compiledGlob(glob).test(base)) return true;
  }
  return false;
}

function normalizeDir(d) {
  return normPath(d).replace(/\/+$/, '');
}

function pathInDir(relPath, dir) {
  const p = normPath(relPath);
  const d = normalizeDir(dir);
  if (d === '' || d === '.') return true;
  return p === d || p.startsWith(d + '/');
}

/**
 * A `paths:` entry is "directory-style" when it names a directory rather than a
 * file pattern: it ends in "/", or it carries no glob metacharacter at all.
 * Those are the entries that can select on the session's cwd, which is how the
 * retired `dirs:` key behaved. A wildcard pattern ("src/**\/*.ts") stays a file
 * pattern and never selects on cwd, so collapsing dirs into paths did not widen
 * what the prompt hook emits.
 */
function isDirectoryStylePattern(pattern) {
  const raw = String(pattern).replace(/\\/g, '/');
  if (raw.endsWith('/')) return true;
  return !/[*?{]/.test(raw);
}

/**
 * The never-match `paths:` sentinel (SQ-293).
 *
 * A keyword (`prompt:`) rule has a problem native cannot express: native scopes
 * a rule by `paths:` only, so a rule file with no `paths:` is loaded globally,
 * at every session start, which is exactly what a keyword rule must not do. The
 * fix is to give such a rule a `paths:` value that is real enough for native to
 * honour as a scope but can never match anything:
 *
 *   - it is reserved. `.live-rules-never-match/` is a directory name this plugin
 *     owns and never creates, so no file in a repo is ever inside it. Native can
 *     only load a path rule when a tool touches a matching file, so the rule
 *     stays out of native's hands.
 *   - it is recognised. The two matchers below short-circuit on this exact
 *     string, so live-rules will not match it either, even if a path that looks
 *     like it somehow exists.
 *
 * The rejected alternative was a second store: keep keyword rules in a separate
 * directory native does not read. It needs no sentinel, but it splits the rule
 * set in two, so `add-rule`, the migration, the audit skill and the user all
 * have to know which half a rule lives in, and a rule that gains or loses a
 * keyword has to move file. One reserved string in frontmatter is the smaller
 * surface, and it keeps every rule in one directory the user can read.
 */
const NEVER_MATCH_PATH = '.live-rules-never-match/**';

/** Is this `paths:` entry the never-match sentinel? */
function isNeverMatchPath(pattern) {
  return String(pattern).replace(/\\/g, '/').trim() === NEVER_MATCH_PATH;
}

/**
 * Does a `paths:` entry apply to this repo-relative file?
 *
 * Three ways, in order: the glob matches the whole path; a slash-free pattern
 * matches the basename at any depth; or a directory-style pattern contains the
 * file. The last is what keeps a migrated `dirs: packages/api` scoping every
 * file beneath it.
 */
function pathPatternMatchesFile(pattern, relPath) {
  if (isNeverMatchPath(pattern)) return false;
  if (ruleGlobMatches(pattern, relPath)) return true;
  if (isDirectoryStylePattern(pattern)) {
    const base = normalizeDir(pattern);
    if (base === '' || base === '.') return true;
    if (compiledGlob(base + '/**').test(normPath(relPath))) return true;
  }
  return false;
}

/** Does a directory-style `paths:` entry contain the session's cwd? */
function pathPatternMatchesDir(pattern, cwdRel) {
  if (isNeverMatchPath(pattern)) return false;
  if (!isDirectoryStylePattern(pattern)) return false;
  return pathInDir(cwdRel, normalizeDir(pattern));
}

/* ------------------------------------------------------------------ *
 *  Prompt-keyword matching: literal substring (case-insensitive) or /regex/flags
 * ------------------------------------------------------------------ */

function compilePromptPattern(p) {
  const m = /^\/(.+)\/([a-z]*)$/.exec(String(p));
  if (!m) return null;
  try {
    return new RegExp(m[1], m[2] || '');
  } catch (_) {
    return null;
  }
}

function promptMatches(pattern, text) {
  if (!text) return false;
  const re = compilePromptPattern(pattern);
  if (re) return re.test(text);
  return text.toLowerCase().includes(String(pattern).toLowerCase());
}

/* ------------------------------------------------------------------ *
 *  Rule loading
 * ------------------------------------------------------------------ */

function toArray(v) {
  if (v == null || v === '') return [];
  return (Array.isArray(v) ? v : [v]).map(String).map((s) => s.trim()).filter(Boolean);
}

/**
 * Split a comma-separated scalar the way native splits `paths:`, without
 * breaking brace expansion: commas inside "{ts,tsx}" are part of the pattern.
 * A YAML list is already split, so its elements pass through untouched.
 */
function splitPatternScalar(value) {
  const text = String(value);
  const parts = [];
  let cur = '';
  let depth = 0;
  for (const ch of text) {
    if (ch === '{') {
      depth++;
      cur += ch;
    } else if (ch === '}') {
      if (depth > 0) depth--;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

// `paths:` only. Prompt selectors and includes keep toArray: a keyword or a
// /regex{1,2}/ may legitimately contain a comma.
function toPatternList(v) {
  if (v == null || v === '') return [];
  const raw = Array.isArray(v) ? v : splitPatternScalar(v);
  return raw.map(String).map((s) => s.trim()).filter(Boolean);
}

const DEPRECATED_SCOPE_KEYS = ['globs', 'glob', 'dirs', 'dir'];
let _deprecationNoticed = false;

// One stderr line per process, not per rule file: a project that still carries
// globs:/dirs: everywhere should get one notice, not fifty.
function noteDeprecatedScopeKeys(keys) {
  if (_deprecationNoticed || !keys.length) return;
  _deprecationNoticed = true;
  try {
    process.stderr.write(
      'live-rules: ' + keys.join('/') + ' in rule frontmatter is deprecated; rename it to paths: ' +
      '(native Claude Code reads paths: and ignores the old keys). ' +
      'Run: node "<plugin>/scripts/migrate-rules.js" --project <dir>\n'
    );
  } catch (_) {
    /* a hook must never fail because stderr is closed */
  }
}

function buildRule(id, data, body) {
  data = data || {};
  const deprecated = DEPRECATED_SCOPE_KEYS.filter((key) => toArray(data[key]).length > 0);
  noteDeprecatedScopeKeys(deprecated);

  // paths: is native's key; globs:/dirs: fold into it so an un-migrated rule
  // keeps its scope instead of silently becoming global.
  let paths = toPatternList(data.paths);
  for (const key of DEPRECATED_SCOPE_KEYS) paths = paths.concat(toPatternList(data[key]));

  const prompts = toArray(data.prompt)
    .concat(toArray(data.prompts))
    .concat(toArray(data.keywords));

  const includes = toArray(data.include).concat(toArray(data.includes));

  let priority = 0;
  if (typeof data.priority === 'number' && Number.isFinite(data.priority)) {
    priority = data.priority;
  } else if (data.priority != null && /^-?\d+(\.\d+)?$/.test(String(data.priority).trim())) {
    priority = Number(data.priority);
  }

  return {
    id,
    description: data.description != null ? String(data.description).trim() : '',
    paths,
    prompts,
    includes,
    priority,
    // Opt in to a periodic re-say in a long session. Default off: a rule native
    // has already loaded is in context, and saying it again costs tokens.
    reground: data.reground === true || String(data.reground).trim() === 'true',
    body: String(body || '').trim(),
  };
}

function isAlways(rule) {
  return rule.paths.length === 0 && rule.prompts.length === 0;
}

/* ------------------------------------------------------------------ *
 *  Store locations
 * ------------------------------------------------------------------ */

// The native rule directory. This is the only store live-rules reads.
const RULES_DIR = path.join('.claude', 'rules');

// Retired stores, read only by scripts/migrate-rules.js.
const LEGACY_ATOMIC_DIR = path.join('.claude', 'live-rules');
const LEGACY_MONOLITH_FILE = path.join('.claude', 'live-rules.md');

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function getRulesDir(projectDir) {
  return path.join(projectDir, RULES_DIR);
}

function getLegacyAtomicDir(projectDir) {
  return path.join(projectDir, LEGACY_ATOMIC_DIR);
}

// The retired single-file store. LIVE_RULES_PATH used to relocate it, so
// migration still honors the override when it looks for something to convert.
function getLegacyRulesFile(projectDir) {
  const env = process.env.LIVE_RULES_PATH;
  const raw = env && String(env).trim() ? expandHome(String(env).trim()) : LEGACY_MONOLITH_FILE;
  return path.isAbsolute(raw) ? raw : path.join(projectDir, raw);
}

// Resolve an `include:` target to an absolute path: project-relative by default,
// but absolute and "~"-relative paths are honored.
function resolveIncludePath(projectDir, p) {
  const raw = expandHome(String(p).trim());
  return path.isAbsolute(raw) ? raw : path.join(projectDir, raw);
}

// A short, readable form of a path for headers: repo-relative with forward
// slashes when the target is inside the project, otherwise the full path.
function displayPath(projectDir, file) {
  try {
    const rel = path.relative(projectDir, file).replace(/\\/g, '/');
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  } catch (_) {
    /* fall through */
  }
  return String(file).replace(/\\/g, '/');
}

function hashContent(content) {
  return crypto.createHash('sha256').update(String(content).replace(/\r/g, '')).digest('hex');
}

/* ------------------------------------------------------------------ *
 *  File parsing
 * ------------------------------------------------------------------ */

function isFence(line) {
  return line.replace(/^﻿/, '').trim() === '---';
}

/**
 * Split a multi-rule document into rule sections. Only the retired monolith
 * held more than one rule per file, so this is now used by migration (and kept
 * exported because its parsing rules are pinned by tests).
 *
 * Each rule is a frontmatter block (between two "---" fences) followed by its
 * body, which runs up to the next opening fence. The "---" lines pair up as
 * open/close, open/close, ... Content before the first fence is ignored, and a
 * dangling unmatched fence at the end is skipped.
 *
 * Fallback: a document with fewer than two "---" fences is one global rule whose
 * body is the whole text. So a plain "Write code as poetry." just works.
 */
function splitSections(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const fences = [];
  for (let i = 0; i < lines.length; i++) {
    if (isFence(lines[i])) fences.push(i);
  }
  if (fences.length < 2) {
    // No fenced frontmatter: the entire text is a single global rule. Empty
    // text -> no rule (keeps the hooks silent on a blank rule file).
    return String(text).trim() ? [{ data: {}, body: String(text) }] : [];
  }
  const sections = [];
  for (let k = 0; k + 1 < fences.length; k += 2) {
    const open = fences[k];
    const close = fences[k + 1];
    const next = k + 2 < fences.length ? fences[k + 2] : lines.length;
    const fmSrc = lines.slice(open + 1, close).join('\n');
    const body = lines.slice(close + 1, next).join('\n');
    let data = {};
    try {
      data = parseYamlSubset(fmSrc);
    } catch (_) {
      data = {};
    }
    sections.push({ data, body });
  }
  return sections;
}

/**
 * Parse ONE native rule file: leading frontmatter if the file opens with a
 * "---" fence, and everything after the closing fence as the body. Unlike
 * splitSections, a later bare "---" in the body is body text, which is what
 * native does and means a horizontal rule no longer silently drops a rule.
 */
function parseRuleFile(content) {
  const lines = String(content).replace(/^﻿/, '').split(/\r?\n/);
  let first = 0;
  while (first < lines.length && lines[first].trim() === '') first++;
  if (first >= lines.length || !isFence(lines[first])) {
    return { data: {}, body: String(content) };
  }
  for (let i = first + 1; i < lines.length; i++) {
    if (!isFence(lines[i])) continue;
    let data = {};
    try {
      data = parseYamlSubset(lines.slice(first + 1, i).join('\n'));
    } catch (_) {
      data = {};
    }
    return { data, body: lines.slice(i + 1).join('\n') };
  }
  // An unterminated frontmatter fence: treat the whole file as a body rather
  // than dropping the rule.
  return { data: {}, body: String(content) };
}

/** Rule files in .claude/rules, top level only, *.md only, name-sorted. */
function listRuleFiles(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const names = entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
  const files = [];
  for (const name of names) {
    try {
      files.push({ name, content: fs.readFileSync(path.join(directory, name), 'utf8') });
    } catch (_) {
      /* unreadable file -> skip that rule, never throw */
    }
  }
  return files;
}

function enrichRule(rule, sourcePath, content) {
  rule.sourcePath = sourcePath;
  rule.hash = hashContent(content);
  return rule;
}

function loadRules(projectDir) {
  const directory = getRulesDir(projectDir);
  const rules = [];
  for (const file of listRuleFiles(directory)) {
    try {
      const parsed = parseRuleFile(file.content);
      if (!String(parsed.body || '').trim()) continue; // a bodyless rule says nothing
      rules.push(
        enrichRule(
          buildRule(file.name, parsed.data, parsed.body),
          RULES_DIR.replace(/\\/g, '/') + '/' + file.name,
          file.content
        )
      );
    } catch (_) {
      /* skip malformed rule file */
    }
  }
  return rules;
}

/** Every *.md under a directory, at any depth, repo-relative-ish and sorted. */
function collectMarkdownFiles(directory, prefix) {
  prefix = prefix || '';
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const out = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    const abs = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMarkdownFiles(abs, rel));
    } else if (entry.name.endsWith('.md')) {
      out.push({ rel, abs, name: entry.name });
    }
  }
  return out;
}

/** The retired stores that still hold rule files, for the migration nudge. */
function pendingLegacyStores(projectDir) {
  const stores = [];
  try {
    const atomic = path.join(getLegacyAtomicDir(projectDir), 'rules');
    // Only a store that still holds rule files counts: after migration the
    // directory may survive empty, and an empty directory must stay silent.
    if (collectMarkdownFiles(atomic).length) {
      stores.push({ kind: 'atomic', dir: atomic, display: displayPath(projectDir, atomic) });
    }
  } catch (_) {
    /* ignore */
  }
  try {
    const legacyFile = getLegacyRulesFile(projectDir);
    if (fs.existsSync(legacyFile)) {
      stores.push({ kind: 'monolith', file: legacyFile, display: displayPath(projectDir, legacyFile) });
    }
  } catch (_) {
    /* ignore */
  }
  return stores;
}

/**
 * A one-line nudge when a project still has rules in a retired store. Without
 * it the storage move would look like "my rules stopped working", silently. It
 * fires even when .claude/rules already has rules, because a half-migrated
 * project is exactly the case where the rules left behind go unnoticed.
 */
function legacyStoreNotice(projectDir) {
  const stores = pendingLegacyStores(projectDir);
  if (!stores.length) return '';
  return (
    'live-rules now reads ' + RULES_DIR.replace(/\\/g, '/') + '/*.md. Rules are still in ' +
    stores.map((store) => store.display).join(' and ') + ' and are NOT in effect. Migrate them with: ' +
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/migrate-rules.js" --project "${CLAUDE_PROJECT_DIR}"'
  );
}

function loadRuleSet(projectDir) {
  return {
    rules: loadRules(projectDir),
    source: getRulesDir(projectDir),
    notice: legacyStoreNotice(projectDir),
  };
}

/* ------------------------------------------------------------------ *
 *  Rendering a rule file (migration, and the seeding helper below)
 * ------------------------------------------------------------------ */

function renderRuleFile(data, body) {
  const lines = [];
  for (const key of ['description', 'paths', 'prompt', 'priority', 'reground', 'include']) {
    if (data[key] == null || data[key] === '') continue;
    if (Array.isArray(data[key]) && data[key].length === 0) continue;
    const value = Array.isArray(data[key]) ? JSON.stringify(data[key]) : String(data[key]);
    lines.push(key + ': ' + value);
  }
  return lines.length
    ? '---\n' + lines.join('\n') + '\n---\n' + String(body || '').trim() + '\n'
    : String(body || '').trim() + '\n';
}

function ruleFileFrontmatter(rule) {
  return {
    description: rule.description,
    paths: rule.paths,
    prompt: rule.prompts,
    priority: rule.priority,
    // '' rather than false so renderRuleFile omits the key entirely: the
    // default is off, and writing `reground: false` into every rule file would
    // be noise in a file a human reads.
    reground: rule.reground ? true : '',
    include: rule.includes,
  };
}

/**
 * Seed a fresh rule set into .claude/rules, written to a temp directory and
 * renamed into place so a crash never leaves half a rule set behind. Refuses
 * when the project already has rule files: seeding is for a new project, and
 * silently merging into someone's existing rules is not a safe default.
 *
 * Kept exported under the old name as well (`writeAtomicRuleSet`) because
 * plugins/sidequest/test/hooks.test.ts seeds its SQ-200 fixture through it.
 */
function seedRuleSet(projectDir, ruleFiles) {
  const destination = getRulesDir(projectDir);
  if (listRuleFiles(destination).length) {
    throw new Error(displayPath(projectDir, destination) + ' already exists and holds rule files');
  }
  const files = ruleFiles.map((item, index) => ({
    name: item.name || String(index + 1).padStart(3, '0') + '.md',
    content: item.content,
  }));
  const temp = destination + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  try {
    fs.mkdirSync(temp, { recursive: true });
    for (const file of files) fs.writeFileSync(path.join(temp, file.name), file.content);
    if (fs.existsSync(destination)) {
      // The directory exists but holds no rule files: fill it in place.
      for (const file of files) fs.renameSync(path.join(temp, file.name), path.join(destination, file.name));
      fs.rmSync(temp, { recursive: true, force: true });
    } else {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(temp, destination);
    }
    return files.map((file) => RULES_DIR.replace(/\\/g, '/') + '/' + file.name);
  } catch (error) {
    try {
      fs.rmSync(temp, { recursive: true, force: true });
    } catch (_) {
      /* best effort */
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 *  Selection
 * ------------------------------------------------------------------ */

function sortSelected(selected) {
  return selected.sort((a, b) => {
    if (b.rule.priority !== a.rule.priority) return b.rule.priority - a.rule.priority;
    return a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0;
  });
}

function truncLabel(s) {
  s = String(s);
  return s.length > 28 ? s.slice(0, 27) + '...' : s;
}

/*
 * Every selection carries `carrier`: HOW native Claude Code gets this same rule
 * into context, which is what lets the session ledger stay quiet instead of
 * saying a rule twice (see session-ledger.js reconcile()).
 *
 *   'session'  no `paths:`, so native reads the file when the context begins.
 *              If such a rule is NOT in the ledger after a session start was
 *              recorded, it did not exist then, so native cannot have it and
 *              live-rules must say it.
 *   'touch'    a `paths:` rule. Native loads it the moment a tool touches a
 *              matching file, so on first sight native is acquiring it right
 *              now and live-rules must not pre-empt it: the contract's "never
 *              inject on first match".
 *   'none'     a keyword match. Native scopes by `paths:` only and these rules
 *              carry NEVER_MATCH_PATH, so native never loads them at all and
 *              live-rules is their only delivery path.
 */
const CARRIER_SESSION = 'session';
const CARRIER_TOUCH = 'touch';
const CARRIER_NONE = 'none';

// UserPromptSubmit: always-on rules, prompt-keyword matches, and directory-style
// path rules whose directory contains the session cwd.
function selectForPrompt(rules, ctx) {
  const out = [];
  for (const rule of rules) {
    if (isAlways(rule)) {
      out.push({ rule, label: 'always', carrier: CARRIER_SESSION });
      continue;
    }
    let label = null;
    let carrier = CARRIER_NONE;
    for (const p of rule.prompts) {
      if (promptMatches(p, ctx.promptText)) {
        label = 'prompt:' + truncLabel(p);
        break;
      }
    }
    if (!label && ctx.cwdRel != null) {
      for (const p of rule.paths) {
        if (pathPatternMatchesDir(p, ctx.cwdRel)) {
          label = 'cwd:' + normalizeDir(p);
          carrier = CARRIER_TOUCH;
          break;
        }
      }
    }
    if (label) out.push({ rule, label, carrier });
  }
  return sortSelected(out);
}

// PreToolUse: path rules that apply to the edited file. Always-on rules are
// skipped here (the prompt hook already carries them).
function selectForEdit(rules, relPath) {
  const out = [];
  for (const rule of rules) {
    if (isAlways(rule)) continue;
    let label = null;
    for (const p of rule.paths) {
      if (pathPatternMatchesFile(p, relPath)) {
        label = p;
        break;
      }
    }
    if (label) out.push({ rule, label, carrier: CARRIER_TOUCH });
  }
  return sortSelected(out);
}

// SessionStart: always-on rules only, once per session. Used as a fallback
// delivery path so these rules reach the model even if UserPromptSubmit's
// wiring is stale (see hooks/session-start-rules.js for why that happens).
function selectAlways(rules) {
  const out = [];
  for (const rule of rules) {
    if (!isAlways(rule)) continue;
    out.push({ rule, label: 'always', carrier: CARRIER_SESSION });
  }
  return sortSelected(out);
}

/* ------------------------------------------------------------------ *
 *  Includes: resolve each selected rule's `include:` files to live content
 * ------------------------------------------------------------------ */

/**
 * For every selected rule that declares `include:`, read the live contents of
 * each target file and stash them on the entry as `entry.includes`. A rule with
 * no `include:` is passed through untouched. A rule that declares includes but
 * whose files ALL fail to read is dropped from the selection, so a "consult the
 * map" rule stays silent when there is no map (codebase-mapper parity). Reads are
 * fail-soft: an unreadable file is simply skipped, never thrown.
 */
function attachIncludes(selected, projectDir) {
  const out = [];
  for (const entry of selected) {
    const paths = (entry.rule && entry.rule.includes) || [];
    if (!paths.length) {
      out.push(entry);
      continue;
    }
    const resolved = [];
    for (const p of paths) {
      try {
        const abs = resolveIncludePath(projectDir, p);
        const content = fs.readFileSync(abs, 'utf8');
        resolved.push({ display: displayPath(projectDir, abs), content: content.trim() });
      } catch (_) {
        /* missing/unreadable include -> skip this file */
      }
    }
    if (!resolved.length) continue; // all includes missing -> drop the rule
    entry.includes = resolved;
    entry.rule.hash = hashContent(entry.rule.hash + ' ' + resolved.map((file) => file.display + ' ' + file.content).join(' '));
    out.push(entry);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  Rendering + output
 * ------------------------------------------------------------------ */

function renderRules(selected, header) {
  const TRUNC = '\n(rule body truncated to fit the context limit; see your rule file)\n';
  let out = header + '\n';
  let included = 0;
  for (let k = 0; k < selected.length; k++) {
    const { rule, label, includes } = selected[k];
    const title = rule.description || rule.id;
    const body = rule.body ? '\n' + rule.body : '';
    let inc = '';
    if (includes && includes.length) {
      for (const f of includes) {
        inc += '\n--- included: ' + f.display + ' ---\n' + f.content + '\n';
      }
    }
    const block = '\n[' + label + '] ' + title + body + inc + '\n';

    if (out.length + block.length > CONTEXT_CAP) {
      const remaining = selected.length - k;
      if (included > 0) {
        // Some full rules already fit; stop and note how many are held back.
        out +=
          '\n(' +
          remaining +
          ' more matching rule(s) not shown to stay within the context limit; see your rule files.)\n';
      } else {
        // The highest-priority rule alone overflows: truncate its body so the
        // emitted string still honors the cap rather than spilling whole.
        const budget = CONTEXT_CAP - out.length - TRUNC.length;
        if (budget > 0) out += block.slice(0, budget) + TRUNC;
        if (remaining > 1 && out.length + 80 < CONTEXT_CAP) {
          out += '(' + (remaining - 1) + ' more matching rule(s) not shown; see your rule files.)\n';
        }
      }
      break;
    }
    out += block;
    included++;
  }
  return out;
}

function emit(eventName, context) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: eventName, additionalContext: context },
    })
  );
}

module.exports = {
  CONTEXT_CAP,
  RULES_DIR,
  LEGACY_ATOMIC_DIR,
  LEGACY_MONOLITH_FILE,
  NEVER_MATCH_PATH,
  isNeverMatchPath,
  CARRIER_SESSION,
  CARRIER_TOUCH,
  CARRIER_NONE,
  readStdin,
  getProjectDir,
  globToRegExp,
  ruleGlobMatches,
  pathInDir,
  isDirectoryStylePattern,
  pathPatternMatchesFile,
  pathPatternMatchesDir,
  promptMatches,
  compilePromptPattern,
  toPatternList,
  buildRule,
  isAlways,
  getRulesDir,
  getLegacyAtomicDir,
  getLegacyRulesFile,
  hashContent,
  loadRuleSet,
  loadRules,
  legacyStoreNotice,
  resolveIncludePath,
  displayPath,
  splitSections,
  parseRuleFile,
  listRuleFiles,
  collectMarkdownFiles,
  pendingLegacyStores,
  renderRuleFile,
  ruleFileFrontmatter,
  seedRuleSet,
  // Back-compat alias: plugins/sidequest/test/hooks.test.ts seeds through this name.
  writeAtomicRuleSet: seedRuleSet,
  selectForPrompt,
  selectForEdit,
  selectAlways,
  attachIncludes,
  renderRules,
  emit,
};
