'use strict';
/**
 * live-rules - one-shot migration into the native rule store (SQ-292)
 *
 *   node scripts/migrate-rules.js --project <dir> [--dry-run]
 *
 * Moves rules out of the two retired live-rules stores and into
 * .claude/rules/*.md, which is where native Claude Code reads project rules and
 * where live-rules now reads them too:
 *
 *   .claude/live-rules/rules/<name>.md  ->  .claude/rules/<name>.md
 *   .claude/live-rules.md (monolith)    ->  .claude/rules/NNN-<slug>.md, one per rule
 *
 * It also rewrites the retired scope keys (`globs:`, `dirs:`) to native's
 * `paths:`, deletes the manifest the old store needed, and adds
 * `.claude/rules/*.local.md` to .gitignore so personal rules stay out of git.
 *
 * Safety properties, in the order they matter:
 *   - Refuses on any name collision, having written nothing. Two rules that
 *     would land on one filename is a question for a human, not something to
 *     resolve by overwriting.
 *   - Writes and verifies the new store BEFORE deleting any source. A crash
 *     leaves both stores intact and a re-run finishes the job.
 *   - Idempotent: a destination that already holds byte-identical content is
 *     left alone, so re-running is a no-op rather than a second migration.
 *   - Single-writer, via the same lock the old store used.
 */

const fs = require('node:fs');
const path = require('node:path');
const rules = require('../hooks/lib/rules');
const { withLock } = require('../hooks/lib/migration-lock');

/* ------------------------------------------------------------------ *
 *  Planning
 * ------------------------------------------------------------------ */

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

// `paths:` is native's key. A file still carrying globs:/dirs: has to be
// rewritten or native would load it with no scope at all.
function needsScopeRewrite(data) {
  return ['globs', 'glob', 'dirs', 'dir'].some(
    (key) => data[key] != null && data[key] !== '' && !(Array.isArray(data[key]) && !data[key].length)
  );
}

/**
 * The content to write for one migrated file. A file whose frontmatter is
 * already native keeps its bytes exactly: re-rendering it would reformat
 * frontmatter and drop comments for no reason. Only a file with a retired scope
 * key is rebuilt, and then the body is still copied verbatim.
 */
function migratedContent(content) {
  const parsed = rules.parseRuleFile(content);
  if (!needsScopeRewrite(parsed.data)) return content;
  const rule = rules.buildRule('migrating', parsed.data, parsed.body);
  return rules.renderRuleFile(rules.ruleFileFrontmatter(rule), parsed.body);
}

function planAtomicStore(projectDir, plan) {
  const sourceDir = path.join(rules.getLegacyAtomicDir(projectDir), 'rules');
  for (const file of rules.collectMarkdownFiles(sourceDir)) {
    let content;
    try {
      content = fs.readFileSync(file.abs, 'utf8');
    } catch (error) {
      plan.errors.push('cannot read ' + rules.displayPath(projectDir, file.abs) + ': ' + error.message);
      continue;
    }
    plan.items.push({
      name: file.name,
      content: migratedContent(content),
      source: file.abs,
      from: rules.displayPath(projectDir, file.abs),
    });
  }
}

function planMonolith(projectDir, plan) {
  const file = rules.getLegacyRulesFile(projectDir);
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return; // no monolith in this project
  }
  plan.monolith = file;
  const sections = rules.splitSections(content);
  let index = 0;
  for (const section of sections) {
    if (!String(section.body || '').trim()) continue; // a bodyless rule says nothing
    index++;
    const rule = rules.buildRule('migrating', section.data, section.body);
    const slug = slugify(rule.description) || 'rule';
    // The NNN- prefix preserves the monolith's order, which is the tiebreak
    // between rules of equal priority.
    plan.items.push({
      name: String(index).padStart(3, '0') + '-' + slug + '.md',
      content: rules.renderRuleFile(rules.ruleFileFrontmatter(rule), section.body),
      from: rules.displayPath(projectDir, file) + ' (rule ' + index + ')',
    });
  }
}

function buildPlan(projectDir) {
  const plan = { items: [], errors: [], monolith: null, destinationDir: rules.getRulesDir(projectDir) };
  planAtomicStore(projectDir, plan);
  planMonolith(projectDir, plan);

  // Collision check, before anything is written.
  const claimed = new Map();
  for (const item of plan.items) {
    if (claimed.has(item.name)) {
      plan.errors.push(
        'name collision: "' + item.name + '" would be written by both ' +
        claimed.get(item.name) + ' and ' + item.from
      );
      continue;
    }
    claimed.set(item.name, item.from);

    const destination = path.join(plan.destinationDir, item.name);
    let existing = null;
    try {
      existing = fs.readFileSync(destination, 'utf8');
    } catch (_) {
      /* nothing there yet */
    }
    if (existing == null) {
      item.action = 'write';
    } else if (existing === item.content) {
      item.action = 'skip'; // already migrated; re-running must not touch it
    } else {
      plan.errors.push(
        'name collision: ' + rules.RULES_DIR.replace(/\\/g, '/') + '/' + item.name +
        ' already exists with different content (source: ' + item.from + ')'
      );
    }
  }
  return plan;
}

/* ------------------------------------------------------------------ *
 *  Verification: the new store must say what the old one said
 * ------------------------------------------------------------------ */

function comparable(rule) {
  return JSON.stringify({
    description: rule.description,
    paths: rule.paths.slice().sort(),
    prompts: rule.prompts.slice().sort(),
    includes: rule.includes.slice().sort(),
    priority: rule.priority,
    body: rule.body,
  });
}

/**
 * Every rule the plan intended must be loadable from the new store with its
 * meaning intact. This is what makes deleting the sources afterwards safe: a
 * frontmatter rewrite that lost a scope key is caught here, before the only
 * other copy of that rule is removed.
 */
function verifyMigration(projectDir, plan) {
  const loaded = new Map();
  for (const rule of rules.loadRules(projectDir)) loaded.set(rule.id, rule);
  const problems = [];
  for (const item of plan.items) {
    const parsed = rules.parseRuleFile(item.content);
    const expected = rules.buildRule(item.name, parsed.data, parsed.body);
    const actual = loaded.get(item.name);
    if (!actual) {
      problems.push(item.name + ' is not readable from the new store');
    } else if (comparable(expected) !== comparable(actual)) {
      problems.push(item.name + ' does not match its source rule after migration');
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 *  Source cleanup + .gitignore
 * ------------------------------------------------------------------ */

function removeIfEmpty(directory) {
  try {
    if (!fs.readdirSync(directory).length) fs.rmdirSync(directory);
  } catch (_) {
    /* non-empty or gone: leave it */
  }
}

function cleanUpSources(projectDir, plan, report) {
  for (const item of plan.items) {
    if (!item.source) continue;
    try {
      fs.unlinkSync(item.source);
    } catch (_) {
      report.warnings.push('could not remove ' + rules.displayPath(projectDir, item.source));
    }
  }

  const legacyDir = rules.getLegacyAtomicDir(projectDir);
  const manifest = path.join(legacyDir, 'manifest.json');
  try {
    fs.unlinkSync(manifest);
    report.removed.push(rules.displayPath(projectDir, manifest));
  } catch (_) {
    /* no manifest, which is the normal case after this release */
  }
  // Prune the retired tree, deepest first, only while it is empty.
  const rulesDir = path.join(legacyDir, 'rules');
  for (const dir of rules
    .collectMarkdownFiles(rulesDir)
    .map((file) => path.dirname(file.abs))
    .concat([rulesDir, legacyDir])) {
    removeIfEmpty(dir);
  }
  removeIfEmpty(rulesDir);
  removeIfEmpty(legacyDir);

  if (plan.monolith) {
    try {
      fs.unlinkSync(plan.monolith);
      report.removed.push(rules.displayPath(projectDir, plan.monolith));
    } catch (_) {
      report.warnings.push('could not remove ' + rules.displayPath(projectDir, plan.monolith));
    }
  }
}

const GITIGNORE_ENTRY = '.claude/rules/*.local.md';

// A *.local.md rule is personal to one clone, so it must not be committed.
// Appended only when absent, and never when the project has no .gitignore to
// append to (creating one in a non-git directory would be presumptuous).
function ensureGitignore(projectDir, report) {
  const file = path.join(projectDir, '.gitignore');
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return;
  }
  const present = content
    .split(/\r?\n/)
    .some((line) => line.trim().replace(/^\/+/, '') === GITIGNORE_ENTRY);
  if (present) return;
  const separator = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  try {
    fs.appendFileSync(file, separator + '\n# live-rules: personal rules, not shared\n' + GITIGNORE_ENTRY + '\n');
    report.gitignore = true;
  } catch (_) {
    report.warnings.push('could not append ' + GITIGNORE_ENTRY + ' to .gitignore');
  }
}

/* ------------------------------------------------------------------ *
 *  Migration
 * ------------------------------------------------------------------ */

function migrate(projectDir, options) {
  options = options || {};
  const plan = buildPlan(projectDir);
  const report = { migrated: [], skipped: [], removed: [], warnings: [], errors: plan.errors, gitignore: false };

  if (plan.errors.length) return report;
  if (!plan.items.length) {
    // Nothing in a retired store. Still worth adding the ignore entry: a
    // project may have started on the native store directly.
    if (!options.dryRun) ensureGitignore(projectDir, report);
    return report;
  }
  if (options.dryRun) {
    for (const item of plan.items) {
      (item.action === 'skip' ? report.skipped : report.migrated).push(item.from + ' -> ' + rules.RULES_DIR.replace(/\\/g, '/') + '/' + item.name);
    }
    return report;
  }

  const written = [];
  try {
    fs.mkdirSync(plan.destinationDir, { recursive: true });
    for (const item of plan.items) {
      const destination = path.join(plan.destinationDir, item.name);
      if (item.action === 'skip') {
        report.skipped.push(item.from + ' -> ' + rules.RULES_DIR.replace(/\\/g, '/') + '/' + item.name);
        continue;
      }
      fs.writeFileSync(destination, item.content);
      written.push(destination);
      report.migrated.push(item.from + ' -> ' + rules.RULES_DIR.replace(/\\/g, '/') + '/' + item.name);
    }

    const problems = verifyMigration(projectDir, plan);
    if (problems.length) throw new Error(problems.join('; '));
  } catch (error) {
    // Roll back only the files this run created; a pre-existing identical file
    // was never touched and must survive.
    for (const file of written) {
      try {
        fs.unlinkSync(file);
      } catch (_) {
        /* best effort */
      }
    }
    report.migrated = [];
    report.errors.push('migration verification failed, nothing was moved: ' + error.message);
    return report;
  }

  cleanUpSources(projectDir, plan, report);
  ensureGitignore(projectDir, report);
  return report;
}

function migrateProject(projectDir, options) {
  const claudeDir = path.join(projectDir, '.claude');
  try {
    fs.mkdirSync(claudeDir, { recursive: true });
  } catch (_) {
    /* migrate() surfaces the real failure */
  }
  const lockPath = path.join(claudeDir, 'rules-migration.lock');
  return withLock(
    lockPath,
    { migrated: [], skipped: [], removed: [], warnings: [], gitignore: false, errors: ['another live-rules migration is already running'] },
    () => migrate(projectDir, options)
  );
}

/* ------------------------------------------------------------------ *
 *  CLI
 * ------------------------------------------------------------------ */

function projectDirectory(args) {
  const index = args.indexOf('--project');
  if (index === -1) return process.cwd();
  if (!args[index + 1]) throw new Error('--project needs a directory path.');
  return path.resolve(args[index + 1]);
}

function report(result, dryRun) {
  const prefix = dryRun ? 'would migrate' : 'migrated';
  if (result.errors.length) {
    for (const error of result.errors) process.stderr.write('live-rules migrate failed: ' + error + '\n');
    process.exitCode = 1;
    return;
  }
  for (const line of result.migrated) process.stdout.write(prefix + ': ' + line + '\n');
  for (const line of result.skipped) process.stdout.write('already migrated: ' + line + '\n');
  for (const line of result.removed) process.stdout.write('removed: ' + line + '\n');
  if (result.gitignore) process.stdout.write('added ' + GITIGNORE_ENTRY + ' to .gitignore\n');
  for (const line of result.warnings) process.stderr.write('live-rules migrate warning: ' + line + '\n');
  if (!result.migrated.length && !result.skipped.length) {
    process.stdout.write('No rules found in a retired live-rules store; nothing to migrate.\n');
  }
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    report(migrateProject(projectDirectory(args), { dryRun }), dryRun);
  } catch (error) {
    process.stderr.write('live-rules migrate failed: ' + error.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = { migrateProject, buildPlan, slugify, GITIGNORE_ENTRY };
