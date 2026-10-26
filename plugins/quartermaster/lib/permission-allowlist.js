'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { resolveWindow } = require('./scan.js');
const { appendDecision } = require('./state.js');
const { fingerprintFor, normalizedCommandPrefix, ruleFor } = require('./permission-fingerprint.js');
const { streamTranscript } = require('./stream.js');

const MIN_APPROVALS = 3;
const ENABLED_SETTING = 'autoApprovePermissions';
// Matched against a command POSITION, never against the command body as text:
// `grep -n "impl Drop for TestRedirect" src/testing.rs` reported a "sighted
// destructive command" for 702 clean approvals because `Drop` fell out of the
// quoted regex as a bare word. A verb only destroys where a shell runs it.
const DESTRUCTIVE_WORD = /^(?:rm|rmdir|rd|del|erase|unlink|shred|rimraf|remove-item|ri|taskkill|kill|killall|pkill|format|mkfs|dd|diskpart|drop|truncate)$/i;
const DESTRUCTIVE_PHRASE = /\bgit\s+(?:push[^\n]*(?:\s--force(?:\b|=)|\s-f\b)|reset\s+--hard\b|clean\b[^\n]*\s-[a-z]*[fdx]|branch[^\n]*\s-D\b|rm\b)|\b(?:docker|kubectl|podman)\s+(?:rm|rmi|delete|prune|system\s+prune)\b|\bnpm\s+unpublish\b|\bfind\b[^\n]*\s-delete\b|\b(?:drop|truncate)\s+(?:table|database)\b/i;
// A wrapper runs whatever follows it, so its whole argument list is command
// positions (`sudo rm`, `timeout 30 rm`, `xargs -0 rm`).
const COMMAND_WRAPPER = /^(?:sudo|doas|env|time|timeout|nohup|nice|ionice|stdbuf|setsid|command|builtin|exec|xargs|parallel|watch)$/i;
const FIND_EXEC_FLAG = /^-(?:exec|execdir|ok|okdir)$/i;
// These read a command, a script, or SQL out of the NEXT argument, quoted or
// not, so that argument is analyzed as a command in its own right.
const INLINE_CODE_RUNNER = /^(?:sh|bash|zsh|dash|ksh|ash|fish|pwsh|powershell|cmd|node|nodejs|deno|bun|python|python2|python3|py|ruby|perl|php|psql|mysql|mariadb|sqlite|sqlite3|mongosh|redis-cli)$/i;
const INLINE_CODE_FLAG = /^(?:-c|-e|-x|--eval|--execute|--command|-command|\/c|\/k)$/i;
// Remote execution takes its command as a plain argument, with no flag to key on.
const REMOTE_EXECUTION_RUNNER = /^(?:ssh|rsh)$/i;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const NESTED_COMMAND_DEPTH = 3;

// A rule is a PREFIX wildcard, so it grants far more than the command that
// earned it: `git push origin main` would become `Bash(git push:*)`, which also
// permits `git push --force`. These never get a rule, however often approved.
const ARBITRARY_EXECUTION = /^(?:node|nodejs|deno|bun|python|python2|python3|py|ruby|perl|php|sh|bash|zsh|dash|pwsh|powershell|cmd|wsl|ssh|eval|exec|npx|pnpx|uvx|env|sudo|doas|xargs|start|call)$/i;
const NEEDS_SUBCOMMAND = /^(?:git|docker|podman|kubectl|helm|terraform|aws|gcloud|az|npm|pnpm|yarn|cargo|go|dotnet|gh|systemctl|sc|net)$/i;
const DESTRUCTIVE_FAMILY = /^(?:docker\s+\S+|podman\s+\S+|kubectl\s+\S+|npm\s+(?:publish|unpublish|version))$/i;
const NEVER_LEARN_GIT_SUBCOMMAND = /^(?:push|reset|clean|branch|rm|checkout|restore|tag|update-ref)$/i;
const CHAIN_UNSAFE_EXECUTION = /^(?:cd|source|\.|export)$/i;
const COMMAND_FRAGMENT = /^(?:&&|\|\||[;|])/;
const VERSION_PINNED_PATH = /(?:^|\/)quartermaster\/\d+\.\d+\.\d+(?:\/|$)/i;
const SESSION_SCRATCHPAD_PATH = /(?:^|\/)(?:scratchpad|claude-[^/]+)(?:\/|$)/i;
const AGENT_WORKTREE_PATH = /(?:^|\/)(?:\.claude\/)?worktrees\/[^/]+\/agent-[0-9a-f]+(?:\/|$)|(?:^|\/)\.claude\/worktrees\/agent-[0-9a-f]+(?:\/|$)/i;
const SLEEP_PREFIX = /^\s*sleep\s+\d+(?:\.\d+)?\s*;/i;

function settingsFile(projectDir) {
  return path.join(projectDir, '.claude', 'settings.local.json');
}

function readSettings(projectDir) {
  try {
    const raw = fs.readFileSync(settingsFile(projectDir), 'utf8');
    const settings = JSON.parse(raw);
    return settings && typeof settings === 'object' ? settings : {};
  } catch {
    return {};
  }
}

function permissionAutomationEnabled(projectDir) {
  return readSettings(projectDir).quartermaster?.[ENABLED_SETTING] === true;
}

function shouldSkipLearning(input) {
  const command = String(input?.command ?? '');
  return SLEEP_PREFIX.test(command)
    || AGENT_WORKTREE_PATH.test(command)
    || SESSION_SCRATCHPAD_PATH.test(command);
}

// A shell tokenizer small enough to audit: just enough quoting and operator
// awareness to tell where one simple command ends and the next begins. Words
// carry whether any of their text was quoted, because quoted text is data
// (a regex, a message, a path) unless something reads it back as code.
function tokenizeCommand(command) {
  const source = String(command ?? '');
  const tokens = [];
  let text = '';
  let quoted = false;
  let open = false;

  const endWord = () => {
    if (!open) return;
    tokens.push({ text, quoted });
    text = '';
    quoted = false;
    open = false;
  };
  const endCommand = () => {
    endWord();
    if (tokens.length && tokens[tokens.length - 1] !== null) tokens.push(null);
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') {
      const escaped = source[index + 1];
      index += 1;
      if (escaped === undefined || escaped === '\n') continue;
      text += escaped;
      open = true;
      continue;
    }
    if (character === '"' || character === "'") {
      // An unterminated quote swallows the rest of the command, exactly as the
      // shell would wait for its close.
      const close = source.indexOf(character, index + 1);
      const end = close === -1 ? source.length : close;
      text += source.slice(index + 1, end);
      quoted = true;
      open = true;
      index = end;
      continue;
    }
    if (/\s/.test(character)) {
      if (character === '\n') endCommand();
      else endWord();
      continue;
    }
    if (character === ';' || character === '&' || character === '|' || character === '`') {
      endCommand();
      continue;
    }
    if (character === '(' && text.endsWith('$')) {
      text = text.slice(0, -1);
      endCommand();
      continue;
    }
    // A brace or paren only groups commands when it stands on its own; inside a
    // word it is `-I{}`, `${VAR}`, or `name()`.
    if (!open && (character === '(' || character === ')' || character === '{' || character === '}')) {
      endCommand();
      continue;
    }
    text += character;
    open = true;
  }
  endWord();
  return tokens;
}

function simpleCommands(command) {
  const commands = [[]];
  for (const token of tokenizeCommand(command)) {
    if (token === null) commands.push([]);
    else commands[commands.length - 1].push(token);
  }
  return commands.filter((words) => words.length);
}

function executableName(word) {
  return word.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
}

// Leading `FOO=bar` assignments precede the command they decorate.
function commandBody(words) {
  let index = 0;
  while (index < words.length && !words[index].quoted && ENV_ASSIGNMENT.test(words[index].text)) index += 1;
  return words.slice(index);
}

// Quoted words are collapsed so a phrase can never be read out of one argument
// (`rg -n "docker rm" docs/`) or spliced across two.
function phraseText(words) {
  return words.map((word) => (word.quoted ? "''" : word.text)).join(' ');
}

function nestedCommands(executable, args) {
  const nested = [];
  if (INLINE_CODE_RUNNER.test(executable)) {
    args.forEach((word, index) => {
      if (!word.quoted && INLINE_CODE_FLAG.test(word.text) && args[index + 1]) nested.push(args[index + 1].text);
    });
  }
  if (REMOTE_EXECUTION_RUNNER.test(executable)) {
    for (const word of args) if (word.quoted) nested.push(word.text);
  }
  return nested;
}

function destroysInCommandPosition(words, depth) {
  const body = commandBody(words);
  if (!body.length) return false;
  const [head, ...args] = body;
  const executable = executableName(head.text);
  if (DESTRUCTIVE_WORD.test(executable)) return true;
  if (DESTRUCTIVE_PHRASE.test(phraseText(body))) return true;
  if (COMMAND_WRAPPER.test(executable)
    && args.some((word) => !word.quoted && DESTRUCTIVE_WORD.test(executableName(word.text)))) return true;
  if (executable.toLowerCase() === 'find'
    && args.some((word, index) => index > 0 && !word.quoted
      && FIND_EXEC_FLAG.test(args[index - 1].text) && DESTRUCTIVE_WORD.test(executableName(word.text)))) return true;
  if (depth >= NESTED_COMMAND_DEPTH) return false;
  return nestedCommands(executable, args).some((nested) => destroysAnywhere(nested, depth + 1));
}

function destroysAnywhere(command, depth = 0) {
  return simpleCommands(command).some((words) => destroysInCommandPosition(words, depth));
}

function isDestructive(input) {
  return destroysAnywhere(String(input?.command ?? ''));
}

// The rule, not the observed command, is what gets granted, so it carries its
// own veto: anything that runs caller-supplied code, a bare tool whose
// subcommands differ wildly in blast radius, or a family with a destructive
// sibling the wildcard would cover.
function hasUnmatchedQuote(value) {
  let quote = null;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (quote === character) {
      quote = null;
    } else if (!quote && (character === '"' || character === "'")) {
      quote = character;
    }
  }
  return quote !== null;
}

function ruleTooBroadReason(fingerprint) {
  if (fingerprint === 'permission:Agent') return 'intercepted by Sidequest routing';
  const match = /^permission:Bash:(.+)$/.exec(fingerprint);
  if (!match) return null;
  const prefix = match[1];
  const [executable] = prefix.split(' ');
  if (COMMAND_FRAGMENT.test(prefix) || hasUnmatchedQuote(prefix)) return 'command fragment';
  if (CHAIN_UNSAFE_EXECUTION.test(executable) || ARBITRARY_EXECUTION.test(executable)) return 'arbitrary execution';
  if (executable === 'git' && NEVER_LEARN_GIT_SUBCOMMAND.test(prefix.slice('git '.length))) return 'ref-mutating git command';
  if (DESTRUCTIVE_FAMILY.test(prefix)) return 'wildcard would cover destructive siblings';
  if (VERSION_PINNED_PATH.test(prefix)) return 'version-pinned path';
  if (!prefix.includes(' ') && NEEDS_SUBCOMMAND.test(executable)) return 'bare tool';
  return null;
}

// The never-learn git check runs over every statement and substitution, not
// just the one a rule would be keyed on: `echo hi && git push` and
// `X=$(git push)` both condemn their fingerprint.
function runsNeverLearnGit(command) {
  // Any unquoted `git` word counts, so a wrapper (`timeout 30 git push`) cannot
  // hide it; a false positive only costs a rule, never grants one.
  return simpleCommands(command).some((words) => words.some((word, index) => {
    if (word.quoted || executableName(word.text).toLowerCase() !== 'git') return false;
    const sub = words.slice(index + 1).find((next) => !next.text.startsWith('-'));
    // The tokenizer leaves a substitution's closing paren glued on: `push)`.
    return Boolean(sub) && NEVER_LEARN_GIT_SUBCOMMAND.test(sub.text.replace(/\)+$/, ''));
  }));
}

function createPermissionCollector() {
  const fingerprints = new Map();
  const see = (name, input) => {
    if (name === 'Bash' && shouldSkipLearning(input)) return null;
    const fingerprint = fingerprintFor(name, input);
    if (!fingerprint) return null;
    let entry = fingerprints.get(fingerprint);
    if (!entry) {
      const vetoReason = ruleTooBroadReason(fingerprint);
      entry = {
        fingerprint,
        input,
        approvals: 0,
        denials: 0,
        destructive: Boolean(vetoReason),
        vetoReason,
        destructiveCommand: null,
      };
      fingerprints.set(fingerprint, entry);
    }
    // One destructive sighting condemns the fingerprint: `git push origin main`
    // and `git push --force` share a prefix, and the first must not earn a rule
    // that covers the second.
    if (isDestructive(input)) {
      entry.destructive = true;
      entry.destructiveCommand ??= String(input?.command ?? '');
    }
    if (name === 'Bash' && runsNeverLearnGit(input?.command)) {
      entry.destructive = true;
      entry.vetoReason ??= 'ref-mutating git command';
    }
    return entry;
  };
  return {
    onEvent(event) {
      if (event.kind !== 'tool_result') return;
      const entry = see(event.name, event.input);
      if (!entry) return;
      if (event.denial === 'user-rejected') entry.denials += 1;
      else if (!event.isError) entry.approvals += 1;
    },
    onTranscriptEnd() {},
    entries() { return [...fingerprints.values()]; },
  };
}

async function collectPermissionDecisions(options = {}) {
  const window = resolveWindow(options);
  const collector = createPermissionCollector();
  for (const source of window.files) {
    try {
      await streamTranscript(source, collector);
    } catch {
      // An active or truncated transcript cannot make the pass fail open.
    }
  }
  return { window, decisions: collector.entries() };
}

function arrayBounds(raw, start) {
  let quoted = false;
  let escaped = false;
  let depth = 0;
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (!depth) return { start, end: index };
    }
  }
  return null;
}

function appendedArrayValues(raw, bounds, values) {
  const existing = raw.slice(bounds.start + 1, bounds.end).trim();
  const propertyIndent = /(?:^|\n)([ \t]*)[^\n]*$/.exec(raw.slice(0, bounds.start))?.[1] ?? '';
  const closingIndent = /(?:^|\n)([ \t]*)$/.exec(raw.slice(0, bounds.end))?.[1] ?? propertyIndent;
  const itemIndent = `${propertyIndent}  `;
  const prefix = raw.slice(0, bounds.end);
  const trailingWhitespace = /\s*$/.exec(prefix)?.[0] ?? '';
  const comma = existing ? ',' : '';
  const inserted = `\n${values.map((value) => `${itemIndent}${JSON.stringify(value)}`).join(`,\n`)}\n${closingIndent}`;
  return `${prefix.slice(0, prefix.length - trailingWhitespace.length)}${comma}${inserted}${raw.slice(bounds.end)}`;
}

function denyCoversRule(deny, rule) {
  const pattern = String(deny ?? '');
  return pattern === rule || (pattern.endsWith('*') && rule.startsWith(pattern.slice(0, -1)));
}

function appendRulesToSettings(projectDir, rules) {
  const file = settingsFile(projectDir);
  const additions = [...new Set(rules)].filter(Boolean);
  if (!additions.length) return [];
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ permissions: { allow: additions } }, null, 2)}\n`, 'utf8');
    return additions;
  }
  const raw = fs.readFileSync(file, 'utf8');
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch {
    throw new Error(`cannot update invalid JSON in ${file}`);
  }
  const existing = Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : [];
  const denies = Array.isArray(settings.permissions?.deny) ? settings.permissions.deny : [];
  const newRules = additions.filter((rule) => !existing.includes(rule) && !denies.some((deny) => denyCoversRule(deny, rule)));
  if (!newRules.length) return [];

  const allowMatch = /"allow"\s*:\s*\[/.exec(raw);
  if (allowMatch) {
    const start = allowMatch.index + allowMatch[0].lastIndexOf('[');
    const bounds = arrayBounds(raw, start);
    if (bounds) {
      fs.writeFileSync(file, appendedArrayValues(raw, bounds, newRules), 'utf8');
      return newRules;
    }
  }

  const rootEnd = raw.lastIndexOf('}');
  if (rootEnd < 0) throw new Error(`cannot update invalid JSON in ${file}`);
  const rootHasContent = raw.slice(0, rootEnd).replace(/[\s{]/g, '').length > 0;
  const indent = /(?:^|\n)([ \t]*)\}/.exec(raw.slice(0, rootEnd + 1))?.[1] ?? '';
  const propertyIndent = `${indent}  `;
  const property = `"permissions": {\n${propertyIndent}  "allow": ${JSON.stringify(newRules)}\n${propertyIndent}}`;
  const addition = `${rootHasContent ? ',' : ''}\n${propertyIndent}${property}\n${indent}`;
  fs.writeFileSync(file, `${raw.slice(0, rootEnd)}${addition}${raw.slice(rootEnd)}`, 'utf8');
  return newRules;
}

function enablePermissionAutomation(projectDir) {
  const file = settingsFile(projectDir);
  const settings = readSettings(projectDir);
  if (settings.quartermaster?.[ENABLED_SETTING] === true) return false;
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ quartermaster: { [ENABLED_SETTING]: true } }, null, 2)}\n`, 'utf8');
    return true;
  }
  const raw = fs.readFileSync(file, 'utf8');
  const rootEnd = raw.lastIndexOf('}');
  if (rootEnd < 0) throw new Error(`cannot update invalid JSON in ${file}`);
  const rootHasContent = raw.slice(0, rootEnd).replace(/[\s{]/g, '').length > 0;
  const indent = /(?:^|\n)([ \t]*)\}/.exec(raw.slice(0, rootEnd + 1))?.[1] ?? '';
  const propertyIndent = `${indent}  `;
  const addition = `${rootHasContent ? ',' : ''}\n${propertyIndent}"quartermaster": { "${ENABLED_SETTING}": true }\n${indent}`;
  fs.writeFileSync(file, `${raw.slice(0, rootEnd)}${addition}${raw.slice(rootEnd)}`, 'utf8');
  return true;
}

async function applyPermissionAllowlist(options = {}) {
  const projectDir = path.resolve(options.projectPath ?? process.cwd());
  const collected = await collectPermissionDecisions({ ...options, projectPath: projectDir });
  const eligible = collected.decisions.filter((entry) => entry.approvals >= MIN_APPROVALS && entry.denials === 0);
  const blocked = eligible.filter((entry) => entry.destructive);
  // Writing permission rules is the opt-in itself, so a caller that has not
  // enabled the marker only ever gets the report. Without this, `quartermaster
  // allowlist` silently granted permissions in any project it was run in.
  if (!permissionAutomationEnabled(projectDir)) {
    return { projectDir, additions: [], blocked, eligible, applied: false, scanned: collected.window.files.length };
  }
  const added = appendRulesToSettings(projectDir, eligible.filter((entry) => !entry.destructive).map((entry) => ruleFor(entry.fingerprint)));
  const addedRules = new Set(added);
  const additions = eligible.filter((entry) => addedRules.has(ruleFor(entry.fingerprint)));
  for (const entry of additions) {
    appendDecision({
      projectDir,
      kind: 'permission',
      title: `allow ${ruleFor(entry.fingerprint)}`,
      fingerprint: entry.fingerprint,
      status: 'applied',
      signal: 'denials',
      detail: `auto-approved after ${entry.approvals} approvals`,
      approvals: entry.approvals,
    }, options.env);
  }
  return { projectDir, additions, blocked, eligible, applied: true, scanned: collected.window.files.length };
}

module.exports = {
  ENABLED_SETTING,
  MIN_APPROVALS,
  appendRulesToSettings,
  applyPermissionAllowlist,
  collectPermissionDecisions,
  commandBody,
  enablePermissionAutomation,
  fingerprintFor,
  hasUnmatchedQuote,
  isDestructive,
  normalizedCommandPrefix,
  permissionAutomationEnabled,
  ruleFor,
  runsNeverLearnGit,
  settingsFile,
  simpleCommands,
};
