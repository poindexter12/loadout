'use strict';

/**
 * Per-session ledger of what the model has already been told.
 *
 * Native Claude Code reads the same rule files live-rules does, so most rules
 * are in context before this plugin says a word. The ledger is what lets
 * live-rules keep quiet about those and speak only when it has something native
 * cannot say: a rule whose content CHANGED since it was loaded, a keyword rule
 * native never loads, or a `reground: true` rule in a session long enough that
 * the original load has scrolled far away.
 *
 * Shape on disk (all keys optional, so an older ledger still loads):
 *   seen:     { '<rule file>': '<content hash>' }  in context, at which hash
 *   said:     { '<rule file>': <turn number> }     turn it last entered context
 *   turn:     <number>                             user prompts seen this session
 *   grounded: <boolean>                            a session start was recorded
 *
 * `grounded` is the evidence that distinguishes the two reasons a global rule
 * can be missing from `seen`. Once a session start has been recorded, every
 * global rule that existed then is in `seen`, so one that is missing was added
 * afterwards: native did not read it and live-rules has to say it. Without that
 * record (SessionStart never fired for this session), missing means unknown, and
 * the safe answer is silence, because native is the carrier that is always there.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { canonicalPath } = require('./canonical-path');

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Re-ground cadence for `reground: true`, in user prompts (SQ-293).
 *
 * Turns, not elapsed time: what degrades a rule's hold on the model is the
 * context piled on top of it, and an hour of idling adds none while twenty
 * exchanges add plenty. The prompt hook is the only caller that ticks the
 * counter, so one turn is one user prompt. Twenty is roughly far enough back
 * for an instruction to stop influencing the model, and infrequent enough that
 * an opted-in rule costs its tokens about once per long session leg.
 */
const REGROUND_TURNS = 20;

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function stateRoot() {
  return process.env.LIVE_RULES_STATE_DIR || path.join(os.homedir(), '.claude', 'live-rules-state');
}

function ledgerPath(projectDir, sessionId) {
  return path.join(stateRoot(), digest(canonicalPath(projectDir)), digest(sessionId) + '.json');
}

function cleanup(root) {
  try {
    for (const project of fs.readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const dir = path.join(root, project.name);
      for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!file.isFile()) continue;
        const target = path.join(dir, file.name);
        if (Date.now() - fs.statSync(target).mtimeMs > MAX_AGE_MS) fs.unlinkSync(target);
      }
    }
  } catch (_) {
    // State is an optimization. A failed cleanup must never affect a hook.
  }
}

function asMap(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function read(projectDir, sessionId) {
  if (!sessionId) return null;
  const root = stateRoot();
  cleanup(root);
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(ledgerPath(projectDir, sessionId), 'utf8'));
  } catch (_) {
    parsed = null;
  }
  parsed = parsed && typeof parsed === 'object' ? parsed : {};
  return {
    seen: asMap(parsed.seen),
    said: asMap(parsed.said),
    turn: Number.isFinite(parsed.turn) ? parsed.turn : 0,
    grounded: parsed.grounded === true,
  };
}

function write(projectDir, sessionId, ledger) {
  if (!sessionId) return;
  try {
    const target = ledgerPath(projectDir, sessionId);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = target + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    const payload = {
      seen: ledger.seen,
      said: ledger.said,
      turn: ledger.turn,
      grounded: ledger.grounded === true,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(temp, JSON.stringify(payload) + '\n');
    fs.renameSync(temp, target);
  } catch (_) {
    // A missing ledger only causes a later re-grounding.
  }
}

/**
 * Record a selection as already in context without emitting any of it.
 *
 * This is what a genuine session start does: native has just read every rule
 * file itself, so the content is in context and the only thing live-rules owes
 * the ledger is the hashes it will compare against later. Hashes are forced to
 * the current file contents, because what native just loaded IS the current
 * file, whatever the ledger believed a moment ago.
 */
function record(projectDir, sessionId, selected) {
  const ledger = read(projectDir, sessionId);
  if (!ledger) return;
  for (const entry of selected) {
    ledger.seen[entry.rule.sourcePath] = entry.rule.hash;
    ledger.said[entry.rule.sourcePath] = ledger.turn;
  }
  ledger.grounded = true;
  write(projectDir, sessionId, ledger);
}

/**
 * Decide which of a selection to actually say, and record the rest (SQ-293).
 *
 * Each entry carries `carrier`, which says how native gets that rule (see
 * rules.js). Per entry:
 *
 *   not in the ledger  -> depends on the carrier.
 *                         'touch'   native is loading it on this very tool
 *                                   call, so record and stay silent.
 *                         'none'    nothing else carries it, so emit.
 *                         'session' native read it when the context began, so
 *                                   stay silent - unless a session start was
 *                                   already recorded, which means this rule
 *                                   appeared after it and native has not seen
 *                                   it. Then emit.
 *   hash differs       -> the file was edited after it was loaded. What is in
 *                         context is stale and only live-rules knows, so emit.
 *   hash matches       -> already in context. Silent, unless the rule asked for
 *                         re-grounding and REGROUND_TURNS have passed.
 *
 * options.reset  wipe the ledger first (a compaction replaced the context, so
 *                nothing can be assumed to still be in it).
 * options.turn   count this call as a user turn, which is what drives the
 *                `reground:` cadence. Only the prompt hook passes it.
 */
function reconcile(projectDir, sessionId, selected, options) {
  const opts = options || {};
  const ledger = read(projectDir, sessionId);
  if (!ledger) {
    // No session id, so no ledger, so "is this already in context?" cannot be
    // answered. Emit only what native never carries: guessing wrong the other
    // way means saying a rule the model can already see.
    return selected.filter((entry) => entry.carrier === 'none');
  }
  if (opts.reset) {
    ledger.seen = {};
    ledger.said = {};
  }
  if (opts.turn) ledger.turn += 1;

  const emit = [];
  for (const entry of selected) {
    const key = entry.rule.sourcePath;
    const known = ledger.seen[key];
    const first = known === undefined;
    const lastSaid = ledger.said[key];

    let say;
    if (first) {
      if (entry.carrier === 'none') say = true;
      else if (entry.carrier === 'session') say = ledger.grounded === true;
      else say = false;
    } else if (known !== entry.rule.hash) say = true;
    else if (entry.rule.reground && opts.turn) {
      say = ledger.turn - (Number.isFinite(lastSaid) ? lastSaid : ledger.turn) >= REGROUND_TURNS;
    } else say = false;

    ledger.seen[key] = entry.rule.hash;
    if (say || first) ledger.said[key] = ledger.turn;
    if (say) emit.push(entry);
  }
  write(projectDir, sessionId, ledger);
  return emit;
}

/**
 * Pre-SQ-293 behaviour: emit everything not already in context at this hash.
 *
 * Still the right call for the one case where native is NOT re-reading the rule
 * files and nothing of the old context survives: a summarising compaction. See
 * hooks/session-start-rules.js.
 */
function changed(projectDir, sessionId, selected, reset) {
  const ledger = read(projectDir, sessionId);
  if (!ledger) return selected;
  if (reset) {
    ledger.seen = {};
    ledger.said = {};
  }
  const fresh = selected.filter((entry) => ledger.seen[entry.rule.sourcePath] !== entry.rule.hash);
  for (const entry of fresh) {
    ledger.seen[entry.rule.sourcePath] = entry.rule.hash;
    ledger.said[entry.rule.sourcePath] = ledger.turn;
  }
  // live-rules has just put the whole set in context itself, which grounds the
  // session as surely as native reading the files does.
  ledger.grounded = true;
  write(projectDir, sessionId, ledger);
  return fresh;
}

module.exports = { changed, record, reconcile, REGROUND_TURNS, ledgerPath, stateRoot };
