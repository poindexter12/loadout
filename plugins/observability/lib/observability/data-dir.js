'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Observability state (SQLite database, sink config, hook spool, logs, pid
// files) lives under ~/.claude/observability, beside the other Loadout plugin
// stores (sidequest keeps ~/.claude/sidequest). OBSERVABILITY_HOME overrides
// the location wholesale and is used verbatim, with no migration.
function legacyDataDir(environment = process.env) {
  const base = environment.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'Eigenwise', 'Workbench');
}

// Migration is a single atomic rename so concurrent hook processes cannot
// interleave a partial copy; when the rename cannot happen (for example the
// legacy directory sits on another device) the legacy directory stays in use.
function resolveDefaultDataDir(environment = process.env, home = os.homedir()) {
  if (environment.OBSERVABILITY_HOME) return environment.OBSERVABILITY_HOME;
  const target = path.join(home, '.claude', 'observability');
  if (fs.existsSync(target)) return target;
  const legacy = legacyDataDir(environment);
  if (!fs.existsSync(legacy)) return target;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(legacy, target);
    return target;
  } catch {
    return fs.existsSync(target) ? target : legacy;
  }
}

function defaultDataDir(environment = process.env) {
  return resolveDefaultDataDir(environment);
}

module.exports = { defaultDataDir, legacyDataDir, resolveDefaultDataDir };
