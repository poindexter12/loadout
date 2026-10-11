'use strict';

// US-7 lane B: the map-codebase skill has to be able to build a map in graph mode, where graphify
// owns structure. The skill is operational guidance, so most of this contract is observable only in
// its prose — but the one command it tells an agent to run is executed here against lane A's
// detection module, so the two halves cannot drift apart silently.
const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const documents = require('../hooks/lib/map-documents');
const graphMode = require('../hooks/lib/graph-mode');

const root = path.resolve(__dirname, '..');
const skillDirectory = path.join(root, 'skills', 'map-codebase');
const skill = fs.readFileSync(path.join(skillDirectory, 'SKILL.md'), 'utf8');
const templates = fs.readFileSync(path.join(skillDirectory, 'references', 'document-templates.md'), 'utf8');

function literal(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('Step 0b detects graph mode from the CLI and from the exact path the hooks read', () => {
  assert.match(skill, /command -v graphify/);
  assert.match(skill, new RegExp(`${literal(graphMode.GRAPH_DIR_NAME)}/${literal(graphMode.GRAPH_REPORT_NAME)}`));
  // Naming the shared module is what stops the skill and the hooks disagreeing about detection.
  assert.match(skill, /hooks\/lib\/graph-mode\.js/);
  assert.match(skill, /that file,\s*and only that file, puts a project in \*\*graph mode\*\*/i);
});

test('graph mode is opt-in: no CLI means classic mode and a quartermaster pointer, not an error', () => {
  assert.match(skill, /graphify is not installed; quartermaster setup can install it\./);
  assert.match(skill, /Graph mode is \*\*opt-in\*\*/);
  assert.match(skill, /with no CLI and no report\s*this skill behaves exactly as it did before/);
});

test('the first build is offered rather than assumed, with both halves of its cost stated', () => {
  assert.match(skill, /Ask first; never build a graph unprompted/);
  // The honest cost: free for code, real tokens for a docs tree, nothing for a code-only repo.
  assert.match(skill, /AST only : deterministic, free/);
  assert.match(skill, /runs on \*this session's LLM\*/);
  assert.match(skill, /large `docs\/` tree costs real tokens/);
  assert.match(skill, /code-only corpus skips that pass entirely/);

  // The post-commit rebuild is the freshness mechanism, and it costs nothing.
  assert.match(skill, /`graphify hook install`/);
  assert.match(skill, /post-commit\/post-checkout rebuild that is\s*deterministic and uses \*\*no LLM\*\*/);
  assert.match(skill, /`graphify hook status`/);
});

test('`graphify claude install` is forbidden by name, under the never-touch-CLAUDE.md rule', () => {
  assert.match(skill, /\*\*Never run `graphify claude install`\.\*\*/);
  assert.match(skill, /writes a graphify section into `CLAUDE\.md`/);
  // The standing guideline must say so too, not only the first-build section.
  const guideline = skill.slice(skill.indexOf('- **Never touch `CLAUDE.md`.**'));
  assert.match(guideline, /\*\*never run `graphify claude install`\*\*/);
  assert.match(guideline, /competing PreToolUse hook/);
});

test('graph mode retires exactly the three structural documents lane A names', () => {
  for (const name of graphMode.RETIRED_DOCUMENTS) {
    assert.match(skill, new RegExp(`do not write \`${literal(name)}\``, 'i'), `${name} must not be written in graph mode`);
    assert.match(templates, new RegExp(`## ${literal(name)}\\n\\n\\*\\*Classic mode only\\.\\*\\*`), `${name} template is classic mode only`);
  }
  // dependencies.md comes from manifests, so graphify never replaces it.
  assert.match(skill, /\*\*Unchanged\.\*\* `dependencies\.md` comes from package manifests/);
  assert.match(skill, /`dependencies\.md` is read out of package manifests, not out of the\s*AST/);
});

test('Step 4 traces flows through the graph instead of walking the tree by hand', () => {
  assert.match(skill, /graphify query "how does a user request reach the database"/);
  assert.match(skill, /graphify path "UserController" "users"/);
  assert.match(skill, /graphify explain "UserService"/);
  assert.match(skill, /rather than walking the tree by hand/);
  // The graph is the durable copy; a transcription of it is the stale duplicate.
  assert.match(skill, /Do not paste graph output into a document/);
});

test('Step 8 records the graph structure marker and the graphify-out commit policy', () => {
  assert.match(skill, new RegExp(`structure: "${literal(graphMode.GRAPH_STRUCTURE)}"`));
  assert.match(skill, /re-add the field after \*\*every\*\* later run of it/);

  // US-7 decision 5 (baude precedent): report and graph tracked, everything else local.
  assert.match(skill, /^\/graphify-out\/\*$/m);
  assert.match(skill, /^!\/graphify-out\/GRAPH_REPORT\.md$/m);
  assert.match(skill, /^!\/graphify-out\/graph\.json$/m);
  assert.match(skill, /html, the extraction cache, and the manifest are large,\s*fully rebuildable/);
  // The existing .codebase-info negation guidance is still there, next to it.
  assert.match(skill, /!\.claude\/\.codebase-info\/\*\*/);
});

test("the Step 8 one-liner yields a manifest lane A reads as graphify-owned structure", () => {
  const command = /^node -e "const f='\.claude\/\.codebase-info\/\.map-state\.json'.*$/m.exec(skill);
  assert.ok(command, 'Step 8 must give an exact command for recording the structure field');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-mapper-map-skill-'));
  const mapDirectory = path.join(directory, '.claude', '.codebase-info');
  fs.mkdirSync(mapDirectory, { recursive: true });
  // A map built in graph mode: narrative documents only, none of the retired three.
  fs.writeFileSync(path.join(mapDirectory, 'INDEX.md'), '# Codebase Map\n\n## Structure\n');
  fs.writeFileSync(path.join(mapDirectory, 'architecture.md'), '# Architecture\n\nOne.\n');
  childProcess.execFileSync(process.execPath, [path.join(root, 'scripts', 'write-map-state.js'), '--project', directory], { encoding: 'utf8' });

  const readState = () => JSON.parse(fs.readFileSync(path.join(mapDirectory, documents.STATE_NAME), 'utf8'));
  // The bundled writer knows nothing about graph mode: the field is the one-liner's work.
  assert.strictEqual(graphMode.stateDeclaresGraphStructure(readState()), false);

  childProcess.execSync(command[0], { cwd: directory, encoding: 'utf8' });

  const state = readState();
  assert.strictEqual(state.structure, graphMode.GRAPH_STRUCTURE);
  assert.strictEqual(graphMode.stateDeclaresGraphStructure(state), true);
  // The retired documents are absent from the manifest because they were never written,
  // and the result is a clean, non-stale map rather than drift.
  for (const name of graphMode.RETIRED_DOCUMENTS) {
    assert.ok(!state.documents.includes(name), `${name} must stay out of documents`);
    assert.ok(!Object.prototype.hasOwnProperty.call(state.hashes, name), `${name} must stay out of hashes`);
  }
  assert.deepStrictEqual(documents.loadMap(directory).state, { migratable: false, stale: false });
  // The writer's own fields survive the edit.
  assert.strictEqual(state.tool, 'codebase-mapper');
  assert.deepStrictEqual(state.documents, ['architecture.md']);

  fs.rmSync(directory, { recursive: true, force: true });
});

test('the INDEX template gains a compact Structure section that routes structure questions', () => {
  const structure = templates.slice(templates.indexOf('\n## Structure\n'), templates.indexOf('\n## How to use this map\n'));
  assert.ok(structure.length > 0, 'the INDEX template must define a Structure section');
  assert.match(structure, new RegExp(`${literal(graphMode.GRAPH_DIR_NAME)}/${literal(graphMode.GRAPH_REPORT_NAME)}`));
  assert.match(structure, /graphify-out\/graph\.json/);
  assert.match(structure, /graphify query "<question>"/);
  assert.match(structure, /graphify explain "<node>"/);
  assert.match(structure, /graphify path "<from>" "<to>"/);
  assert.match(structure, /\*\*Structure questions go to the graph, convention questions go to these docs\.\*\*/);

  // Graph mode only, and it replaces the three retired rows rather than joining them.
  assert.match(templates, /The \*\*Structure\*\* section below is graph mode only/);
  assert.match(templates, /drop the three \*classic mode only\* rows from the document table/);
  for (const name of graphMode.RETIRED_DOCUMENTS) {
    assert.match(templates, new RegExp(`\\[${literal(name)}\\]\\(\\./${literal(name)}\\)[^\\n]*classic mode only`), `${name} row is marked classic mode only`);
  }
  // The same one-line rule is in the skill, so the author knows why the section exists.
  assert.match(skill, /\*\*structure questions go to the graph, convention questions go to\s*these docs\.\*\*/i);
});

test('the Sidequest writer ticket carries the graph-mode rules', () => {
  const handoff = skill.indexOf('In graph mode, the ticket instructions must carry the graph-mode rules from Step 0b');
  assert.notStrictEqual(handoff, -1, 'the handoff must pass the graph-mode rules to the writer');
  // It belongs to the Step 0 handoff section, not to a later step.
  assert.ok(handoff < skill.indexOf('\n### Step 1 '));

  const paragraph = skill.slice(handoff, skill.indexOf('\n\n', handoff));
  assert.match(paragraph, /`graphify query\|explain\|path` as its structural input/);
  assert.match(paragraph, new RegExp(`structure: "${literal(graphMode.GRAPH_STRUCTURE)}"`));
  assert.match(paragraph, /never builds or refreshes a graph, never runs `graphify hook install`,\s*and never runs `graphify claude install`/);
  for (const name of graphMode.RETIRED_DOCUMENTS) {
    assert.match(paragraph, new RegExp(literal(name)), `${name} is named to the writer`);
  }
});

test('graph mode additions reach the success criteria', () => {
  const criteria = skill.slice(skill.indexOf('## Success criteria'));
  assert.match(criteria, /In graph mode, additionally:/);
  assert.match(criteria, new RegExp(`\`\\.map-state\\.json\` records \`structure: "${literal(graphMode.GRAPH_STRUCTURE)}"\``));
  assert.match(criteria, /`CLAUDE\.md` left untouched, and `graphify claude install` never run/);
  assert.match(criteria, /carries the \*\*Structure\*\* section/);
  for (const name of graphMode.RETIRED_DOCUMENTS) {
    assert.match(criteria, new RegExp(literal(name)), `${name} is named in the graph-mode criteria`);
  }
});
