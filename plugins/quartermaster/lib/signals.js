'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { pluginsDir } = require('./paths.js');
const { fingerprintFor } = require('./permission-fingerprint.js');

const MAX_SAMPLES = 12;
const QUOTE_CHARS = 300;
const TOP_LIMIT = 15;
const TITLE_CHARS = 120;
const ASK_CHARS = 240;
const GOAL_CHARS = 300;

// Openers that mean the previous turn went the wrong way, matched at the start of the prompt where
// a correction almost always lands, so an incidental "actually" mid-paragraph does not trip it.
const CORRECTION_OPENERS = /^\s*(?:no\b|nope\b|stop\b|wrong\b|don'?t\b|do not\b|actually\b|not (?:like )?that\b|that'?s not\b|revert\b|undo\b|never\b|please (?:don'?t|stop)\b)/i;
const CORRECTION_PHRASES = /\b(?:i (?:already )?(?:told|said|asked)|you keep|again,|why did you|i didn'?t ask|that'?s wrong|not what i)\b/i;

// A prompt that opens with a markup tag is the harness talking, not the user: a slash-command
// wrapper, piped command output, a hook's injected line. Taking one of these as the opening ask
// reports "/clear" back as what the user wanted.
const HARNESS_PROMPT = /^\s*<[a-z][a-z-]*>/i;

const CORRECTION_THEMES = [
  ['commit/git', /\b(?:commit(?:s|ted|ting)?|push(?:es|ed|ing)?|branch(?:es|ed|ing)?|merg(?:e|es|ed|ing)|rebas(?:e|es|ed|ing)|git)\b/],
  ['scope', /\b(?:scope[ds]?|only|just|don'?t touch|out of scope|stay in)\b/],
  ['style/voice', /\b(?:em dash(?:es)?|voice|tone|wording|phrasing|style|comments?)\b/],
  ['tooling', /\b(?:powershell|bash|scripts?|hooks?|plugins?|skills?|mcp)\b/],
  ['verification', /\b(?:tests?|verif(?:y|ied|ies)|check(?:s|ed)?|prov(?:e|ed|en)|run it)\b/],
];

// The one denial kind a permission rule is answerable for. Every other kind on the same
// fingerprint (`interrupted`, `user-rejected`, a routing interception) was somebody else's
// decision, so it is tallied as a denial but never attributed to the rule.
const PERMISSION_DENIAL_KIND = 'permission-rule';

// A gate refusing a call because it does not apply to this project is not developer friction.
// The known case is Sidequest's unregistered-project deny: in a project with no board, every
// dispatch attempt comes back with the same line, and the only improvement it could ever justify
// is registering a board the user deliberately does not want there. Four of those once carried a
// project over the resupply threshold on their own, so they are counted apart and weighted zero.
const NOT_APPLICABLE_GATES = [
  ['sidequest:unregistered-project', /not registered on a Sidequest board/i],
];

/** Names the not-applicable gate a refusal came from, or null when the denial is real friction. */
function notApplicableGateOf(denialReason) {
  const text = String(denialReason ?? '');
  if (!text) return null;
  for (const [gate, pattern] of NOT_APPLICABLE_GATES) if (pattern.test(text)) return gate;
  return null;
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const SUBCOMMAND_EXECUTABLES = new Set([
  'git', 'gh', 'npm', 'pnpm', 'yarn', 'npx', 'cargo', 'docker', 'kubectl', 'claude',
  'dotnet', 'pip', 'uv', 'poetry', 'terraform', 'aws', 'gcloud', 'az',
]);
const SCRIPT_RUNNERS = new Set(['node', 'python', 'python3', 'deno', 'bun', 'bash', 'sh', 'pwsh', 'powershell']);

function clip(text, limit = QUOTE_CHARS) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function themeOf(text) {
  const value = String(text).toLowerCase();
  for (const [name, pattern] of CORRECTION_THEMES) if (pattern.test(value)) return name;
  return 'general';
}

function basenameOf(token) {
  return String(token).replace(/["']/g, '').replace(/\\/g, '/').split('/').pop();
}

/**
 * Reduces a shell command to a recognizable headline ("git push", "node build.js") so the same
 * habit counts as one entry across sessions regardless of flags, paths, and arguments.
 */
function normalizeCommand(rawCommand) {
  let command = String(rawCommand ?? '').trim();
  command = command.replace(/^(?:\w+=\S+\s+)+/, '');
  // "cd <path> && <real command>" is a wrapper, not the habit itself.
  command = command.replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, '');
  const tokens = command.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const executable = basenameOf(tokens[0]).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
  const next = tokens.find((token, index) => index > 0 && !token.startsWith('-') && !/["'{(]/.test(token[0]));
  if (SCRIPT_RUNNERS.has(executable)) {
    // Inline scripts (node -e, python -c) have no script file; the runner alone is the habit.
    const script = next && /\.\w+$/.test(basenameOf(next)) ? basenameOf(next) : null;
    return script ? `${executable} ${script}` : executable;
  }
  if (SUBCOMMAND_EXECUTABLES.has(executable) && next) return `${executable} ${next.toLowerCase()}`;
  return executable;
}

// Directories that hold throwaway work, and per-session identifiers, both of which would otherwise
// rank as areas the user was working in. A scratch file is written to be deleted; its path says
// nothing about the purpose it served.
const THROWAWAY_SEGMENTS = new Set(['scratchpad', 'tmp', 'temp', 'node_modules', '__pycache__', '.venv', '.git']);
const OPAQUE_SEGMENT = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$|^[0-9a-f]{16,}$/i;

/**
 * Reduces a touched file to the area it lives in, as the two directory segments closest to it
 * ("src/ingest"). Taking the tail rather than the head keeps this meaningful for
 * absolute paths and identical across machines, where a leading drive or home directory is not.
 * Returns null for scratch space, so a session's temp directory cannot outrank its real work.
 */
function areaOf(filePath) {
  const normalized = String(filePath ?? '').replace(/\\/g, '/');
  if (!normalized.includes('/')) return null;
  const segments = normalized.split('/').filter(Boolean);
  segments.pop();
  if (segments.some((segment) => THROWAWAY_SEGMENTS.has(segment.toLowerCase()) || OPAQUE_SEGMENT.test(segment))) {
    return null;
  }
  return segments.length ? segments.slice(-2).join('/') : null;
}

function hostnameOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return null;
  }
}

function bump(map, key, sessionId) {
  if (!key) return;
  const entry = map.get(key) ?? { count: 0, sessions: new Set() };
  entry.count += 1;
  if (sessionId) entry.sessions.add(sessionId);
  map.set(key, entry);
}

function topOf(map, limit = TOP_LIMIT) {
  return [...map.entries()]
    .map(([key, entry]) => ({ name: key, count: entry.count, sessions: entry.sessions.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function countsOf(map) {
  const result = {};
  for (const [key, entry] of [...map.entries()].sort((a, b) => b[1].count - a[1].count)) {
    result[key] = entry.count;
  }
  return result;
}

function readJsonFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function squash(command) {
  return String(command ?? '').replace(/\s+/g, ' ').trim();
}

/** The hook configs one installed plugin declares: `hooks/hooks.json` plus any its manifest names. */
function hookConfigsOf(installPath) {
  const configs = [readJsonFile(path.join(installPath, 'hooks', 'hooks.json'))];
  const declared = readJsonFile(path.join(installPath, '.claude-plugin', 'plugin.json'))?.hooks;
  for (const entry of Array.isArray(declared) ? declared : [declared]) {
    if (typeof entry === 'string') configs.push(readJsonFile(path.resolve(installPath, entry)));
    else if (entry && typeof entry === 'object') configs.push(entry);
  }
  return configs
    .filter(Boolean)
    .map((config) => (config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks) ? config.hooks : config));
}

/**
 * Every command hook the installed plugins register, read from their manifests on disk. The
 * transcript keeps `${CLAUDE_PLUGIN_ROOT}` unexpanded, so the owning plugin cannot be read off the
 * command string, and the same script name is registered by more than one plugin
 * (`hooks/registry-writer.js` by both model-gateway and sidequest). Matching the whole recorded
 * command against what each plugin actually registers is the only attribution that does not guess.
 */
function readHookRegistrations(env = process.env) {
  const installed = readJsonFile(path.join(pluginsDir(env), 'installed_plugins.json'));
  const registrations = [];
  for (const [plugin, records] of Object.entries(installed?.plugins ?? {})) {
    const installPaths = new Set((Array.isArray(records) ? records : [])
      .map((record) => record?.installPath)
      .filter((installPath) => typeof installPath === 'string' && installPath));
    for (const installPath of installPaths) {
      for (const config of hookConfigsOf(installPath)) {
        for (const [event, groups] of Object.entries(config)) {
          if (!Array.isArray(groups)) continue;
          for (const group of groups) {
            for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
              if (typeof hook?.command !== 'string' || !hook.command.trim()) continue;
              const command = squash(hook.command);
              // Claude Code may record the command before or after expanding the plugin root.
              const expanded = squash(command.split('${CLAUDE_PLUGIN_ROOT}').join(installPath));
              registrations.push({
                plugin,
                event,
                matcher: typeof group.matcher === 'string' ? group.matcher : null,
                commands: new Set([command, expanded]),
                timeoutMs: Number.isFinite(hook.timeout) ? hook.timeout * 1000 : null,
              });
            }
          }
        }
      }
    }
  }
  return registrations;
}

/** True unless the registration's matcher provably excludes the recorded hook name's subject. */
function matcherAdmits(matcher, hookName) {
  if (!matcher || matcher === '*') return true;
  const separator = String(hookName ?? '').indexOf(':');
  if (separator < 0) return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(hookName.slice(separator + 1));
  } catch {
    return true;
  }
}

/**
 * Names the plugin that owns a timed-out hook, or says plainly why it cannot. `plugin` is set only
 * when exactly one installed plugin registers that command for that event; two or more is
 * `ambiguous` with every candidate listed, never a pick.
 */
function attributeHook(registrations, event) {
  if (!event.command) return { attribution: 'unrecorded', plugin: null, candidates: [] };
  const command = squash(event.command);
  let matches = registrations.filter((registration) => registration.commands.has(command)
    && (!event.hookEvent || registration.event === event.hookEvent)
    && matcherAdmits(registration.matcher, event.hookName));
  // A recorded budget that contradicts a registration's explicit timeout rules that registration
  // out, but only as a tie-break: a lone owner whose budget changed between versions is still it.
  if (new Set(matches.map((registration) => registration.plugin)).size > 1 && Number.isFinite(event.timeoutMs)) {
    const consistent = matches.filter((registration) => registration.timeoutMs === null || registration.timeoutMs === event.timeoutMs);
    if (consistent.length) matches = consistent;
  }
  const candidates = [...new Set(matches.map((registration) => registration.plugin))].sort();
  if (candidates.length === 1) return { attribution: 'plugin', plugin: candidates[0], candidates };
  if (candidates.length > 1) return { attribution: 'ambiguous', plugin: null, candidates };
  // Registered by user or project settings, or by a plugin no longer installed.
  return { attribution: 'unattributed', plugin: null, candidates };
}

function medianOf(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function hookTimeoutsOf(groups, total) {
  const hooks = [...groups.values()]
    .map((group) => ({
      plugin: group.plugin,
      attribution: group.attribution,
      ...(group.attribution === 'ambiguous' ? { candidates: group.candidates } : {}),
      command: group.command === null ? null : clip(group.command),
      hookNames: countsOf(group.hookNames),
      count: group.count,
      sessions: group.sessions.size,
      budgetsMs: [...group.budgets].sort((a, b) => a - b),
      maxDurationMs: group.maxDurationMs,
      medianDurationMs: medianOf(group.durations),
      maxOverBudgetMs: group.maxOverBudgetMs,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_LIMIT);
  return { total, hooks };
}

function emptyTally() {
  return {
    prompts: 0,
    toolCalls: 0,
    toolErrors: 0,
    denials: 0,
    denialsByFingerprint: {},
    permissionDenialsByFingerprint: {},
    // Kept so the evidence survives, never summed into friction: see NOT_APPLICABLE_GATES.
    notApplicableRefusals: 0,
    interrupts: 0,
    corrections: 0,
  };
}

/**
 * Single-pass aggregator over every streamed event. Everything it keeps is bounded: counters,
 * top-N maps, and a fixed number of clipped quotes, so the output stays safe to load into context
 * no matter how many transcripts were scanned. The one list that grows is each timed-out hook's
 * durations, one number per timeout, kept so the median is exact; only its summary is output.
 *
 * `options.env` locates the installed plugin manifests that hook timeouts are attributed against.
 */
function createSignalCollector(options = {}) {
  const env = options.env ?? process.env;
  // Read on the first timeout, not up front: most transcripts have none, and the SessionEnd hook
  // runs this collector on one transcript inside its own budget.
  let hookRegistrations = null;
  const hookAttributions = new Map();
  const hookTimeoutGroups = new Map();
  let hookTimeoutTotal = 0;
  const perSession = new Map();
  const corrections = [];
  const denialTargets = [];
  const denialsByKind = new Map();
  const denialsByTool = new Map();
  const notApplicableByGate = new Map();
  const errorsByTool = new Map();
  const hookErrorsByHook = new Map();
  const attributionPlugins = new Map();
  const attributionSkills = new Map();
  const attributionMcpServers = new Map();
  const commands = new Map();
  const webFetchDomains = new Map();
  const areas = new Map();
  const goalsByCondition = new Map();
  const totals = { interrupts: 0, apiErrors: 0, toolErrors: 0, denials: 0, notApplicable: 0, webSearches: 0 };
  let lastAction = null;

  const sessionTally = (sessionId) => {
    const entry = perSession.get(sessionId)
      ?? { ...emptyTally(), firstMs: null, lastMs: null, title: null, openingAsk: null, goal: null };
    perSession.set(sessionId, entry);
    return entry;
  };

  return {
    onEvent(event) {
      const tally = sessionTally(event.sessionId);
      if (event.timestampMs !== null) {
        if (tally.firstMs === null || event.timestampMs < tally.firstMs) tally.firstMs = event.timestampMs;
        if (tally.lastMs === null || event.timestampMs > tally.lastMs) tally.lastMs = event.timestampMs;
      }

      switch (event.kind) {
        case 'session_title':
          if (event.title && !tally.title) tally.title = clip(event.title, TITLE_CHARS);
          return;
        case 'goal': {
          if (!event.condition) return;
          const condition = clip(event.condition, GOAL_CHARS);
          // goal_status repeats every turn while a goal is open, so dedupe by condition and let a
          // single met:true win: a goal that was ever satisfied is not an unmet goal.
          if (!tally.goal) tally.goal = { condition, met: event.met === true };
          else if (event.met === true) tally.goal.met = true;
          const existing = goalsByCondition.get(condition);
          if (!existing) goalsByCondition.set(condition, { met: event.met === true, sessionId: event.sessionId });
          else if (event.met === true) existing.met = true;
          return;
        }
        case 'interrupt':
          totals.interrupts += 1;
          tally.interrupts += 1;
          return;
        case 'api_error':
          totals.apiErrors += 1;
          return;
        case 'hook_error':
          bump(hookErrorsByHook, event.hookName, event.sessionId);
          return;
        case 'hook_timeout': {
          hookTimeoutTotal += 1;
          const lookup = [event.hookEvent, event.hookName, event.command, event.timeoutMs].join('\u0000');
          let owner = hookAttributions.get(lookup);
          if (!owner) {
            if (event.command && hookRegistrations === null) hookRegistrations = readHookRegistrations(env);
            owner = attributeHook(hookRegistrations ?? [], event);
            hookAttributions.set(lookup, owner);
          }
          // Keyed on owner plus command, so one plugin's slow hook is one row however many events
          // it runs at, and two plugins' identically named scripts are never merged into one.
          const key = event.command
            ? `${owner.attribution}\u0000${owner.plugin ?? owner.candidates.join(',')}\u0000${squash(event.command)}`
            : `unrecorded\u0000${event.hookName}`;
          const group = hookTimeoutGroups.get(key) ?? {
            ...owner,
            command: event.command ? squash(event.command) : null,
            hookNames: new Map(),
            count: 0,
            sessions: new Set(),
            budgets: new Set(),
            durations: [],
            maxDurationMs: null,
            maxOverBudgetMs: null,
          };
          hookTimeoutGroups.set(key, group);
          group.count += 1;
          if (event.sessionId) group.sessions.add(event.sessionId);
          bump(group.hookNames, event.hookName, event.sessionId);
          if (Number.isFinite(event.timeoutMs)) group.budgets.add(event.timeoutMs);
          if (Number.isFinite(event.durationMs)) {
            group.durations.push(event.durationMs);
            group.maxDurationMs = Math.max(group.maxDurationMs ?? event.durationMs, event.durationMs);
            if (Number.isFinite(event.timeoutMs)) {
              const over = event.durationMs - event.timeoutMs;
              group.maxOverBudgetMs = Math.max(group.maxOverBudgetMs ?? over, over);
            }
          }
          return;
        }
        case 'tool_use': {
          tally.toolCalls += 1;
          lastAction = { name: event.name, target: event.input?.file_path ?? event.input?.command ?? null };
          bump(attributionPlugins, event.attributionPlugin, event.sessionId);
          bump(attributionSkills, event.attributionSkill, event.sessionId);
          bump(attributionMcpServers, event.attributionMcpServer, event.sessionId);
          bump(areas, areaOf(event.input?.file_path), event.sessionId);
          if (SHELL_TOOLS.has(event.name)) bump(commands, normalizeCommand(event.input?.command), event.sessionId);
          if (event.name === 'WebSearch') totals.webSearches += 1;
          if (event.name === 'WebFetch') bump(webFetchDomains, hostnameOf(event.input?.url), event.sessionId);
          return;
        }
        case 'tool_result': {
          // Weighed before anything is counted: a refusal from a gate this project never opted into
          // is neither a denial nor a tool error. Counting it as either advances the resupply
          // threshold and aims the round at machinery the user does not want here.
          const gate = event.denial ? notApplicableGateOf(event.denialReason) : null;
          if (gate) {
            totals.notApplicable += 1;
            tally.notApplicableRefusals += 1;
            bump(notApplicableByGate, gate, event.sessionId);
            return;
          }
          if (event.isError) {
            totals.toolErrors += 1;
            tally.toolErrors += 1;
            bump(errorsByTool, event.name ?? 'unknown', event.sessionId);
          }
          if (event.denial) {
            totals.denials += 1;
            tally.denials += 1;
            const fingerprint = fingerprintFor(event.name, event.input);
            if (fingerprint) {
              tally.denialsByFingerprint[fingerprint] = (tally.denialsByFingerprint[fingerprint] ?? 0) + 1;
              // Kept apart from the total so a verdict about a permission rule can be drawn from
              // the denials that rule actually caused, rather than from everything that happened
              // to share its fingerprint.
              if (event.denial === PERMISSION_DENIAL_KIND) {
                tally.permissionDenialsByFingerprint[fingerprint] = (tally.permissionDenialsByFingerprint[fingerprint] ?? 0) + 1;
              }
            }
            bump(denialsByKind, event.denial, event.sessionId);
            bump(denialsByTool, event.name ?? 'unknown', event.sessionId);
            if (denialTargets.length < MAX_SAMPLES) {
              denialTargets.push({
                tool: event.name ?? 'unknown',
                kind: event.denial,
                target: clip(event.input?.command ?? event.input?.file_path ?? '', 160),
                sessionId: event.sessionId,
              });
            }
          }
          return;
        }
        case 'user_prompt': {
          const text = String(event.text ?? '');
          if (text.startsWith('[Request interrupted')) {
            totals.interrupts += 1;
            tally.interrupts += 1;
            return;
          }
          tally.prompts += 1;
          // The opening ask is the fallback when a session has no title: it is what the user came
          // in wanting, before any of the work reshaped it.
          if (!tally.openingAsk && !HARNESS_PROMPT.test(text)) tally.openingAsk = clip(text, ASK_CHARS);
          if (!CORRECTION_OPENERS.test(text) && !CORRECTION_PHRASES.test(text)) return;
          tally.corrections += 1;
          if (corrections.length < MAX_SAMPLES * 3) {
            corrections.push({
              quote: clip(text),
              theme: themeOf(text),
              after: lastAction ? clip(`${lastAction.name} ${lastAction.target ?? ''}`, 120) : null,
              sessionId: event.sessionId,
            });
          }
          return;
        }
        default:
      }
    },

    onTranscriptEnd() {},

    finish() {
      const byTheme = new Map();
      for (const correction of corrections) bump(byTheme, correction.theme, correction.sessionId);

      const sessions = [...perSession.entries()]
        .map(([sessionId, tally]) => ({
          sessionId,
          startedAt: tally.firstMs ? new Date(tally.firstMs).toISOString() : null,
          minutes: tally.firstMs && tally.lastMs ? Math.round((tally.lastMs - tally.firstMs) / 60000) : null,
          prompts: tally.prompts,
          toolCalls: tally.toolCalls,
          toolErrors: tally.toolErrors,
          denials: tally.denials,
          denialsByFingerprint: tally.denialsByFingerprint,
          permissionDenialsByFingerprint: tally.permissionDenialsByFingerprint,
          notApplicableRefusals: tally.notApplicableRefusals,
          interrupts: tally.interrupts,
          corrections: tally.corrections,
          title: tally.title,
          openingAsk: tally.openingAsk,
          goal: tally.goal,
          // A session nobody typed into twice was almost certainly spawned by a hook or a harness.
          // Its title states that machinery's purpose, not the user's, and there are often many
          // more of them than real sessions, so counting titles without this flag would report the
          // automation back to the user as their own goal.
          humanDriven: tally.prompts >= 2,
        }))
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));

      const goals = [...goalsByCondition.entries()]
        .map(([condition, entry]) => ({ condition, met: entry.met, sessionId: entry.sessionId }));

      return {
        purpose: {
          goals: {
            set: goals.length,
            met: goals.filter((goal) => goal.met).length,
            samples: goals.slice(0, MAX_SAMPLES),
          },
          areasTop: topOf(areas, 12),
        },
        friction: {
          interrupts: totals.interrupts,
          apiErrors: totals.apiErrors,
          corrections: {
            count: corrections.length,
            byTheme: countsOf(byTheme),
            samples: corrections.slice(0, MAX_SAMPLES),
          },
          denials: {
            total: totals.denials,
            byKind: countsOf(denialsByKind),
            byTool: countsOf(denialsByTool),
            targets: denialTargets,
            // Refusals from gates that do not apply to this project, excluded from every count
            // above and from the resupply threshold. Reported so the evidence stays visible
            // without weighing on the round.
            notApplicable: { total: totals.notApplicable, byGate: countsOf(notApplicableByGate) },
          },
          toolErrors: { total: totals.toolErrors, byTool: topOf(errorsByTool, 10) },
          hookErrors: countsOf(hookErrorsByHook),
          // Grouped by owning plugin and command, with how far over budget each ran, so a count of
          // timeouts says which hook to look at and whether its budget or its work is the problem.
          hookTimeouts: hookTimeoutsOf(hookTimeoutGroups, hookTimeoutTotal),
        },
        attribution: {
          plugins: countsOf(attributionPlugins),
          skills: countsOf(attributionSkills),
          mcpServers: countsOf(attributionMcpServers),
        },
        habits: {
          commandsTop: topOf(commands),
          webSearches: totals.webSearches,
          webFetchDomainsTop: topOf(webFetchDomains, 10),
        },
        sessions,
      };
    },
  };
}

/** One-transcript tally for the SessionEnd hook: same collector, reduced to flat counters. */
function tallyFromSignals(signals) {
  const tally = emptyTally();
  for (const session of signals.sessions) {
    tally.prompts += session.prompts;
    tally.toolCalls += session.toolCalls;
    tally.toolErrors += session.toolErrors;
    tally.denials += session.denials;
    for (const [fingerprint, count] of Object.entries(session.denialsByFingerprint ?? {})) {
      tally.denialsByFingerprint[fingerprint] = (tally.denialsByFingerprint[fingerprint] ?? 0) + count;
    }
    for (const [fingerprint, count] of Object.entries(session.permissionDenialsByFingerprint ?? {})) {
      tally.permissionDenialsByFingerprint[fingerprint] = (tally.permissionDenialsByFingerprint[fingerprint] ?? 0) + count;
    }
    tally.notApplicableRefusals += session.notApplicableRefusals ?? 0;
    tally.interrupts += session.interrupts;
    tally.corrections += session.corrections;
  }
  return tally;
}

module.exports = {
  attributeHook,
  clip,
  createSignalCollector,
  emptyTally,
  normalizeCommand,
  readHookRegistrations,
  tallyFromSignals,
  themeOf,
};
