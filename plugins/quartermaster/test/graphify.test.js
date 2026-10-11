'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const {
  GRAPHIFY_FLOOR_VERSION,
  GRAPHIFY_PACKAGE,
  GRAPH_REPORT_RELATIVE_PATH,
  compareVersions,
  detectGraphify,
  findGraphifyTool,
  graphifyDoctor,
  graphifyInstallCommand,
  graphifyUpgradeCommand,
  graphifyUpgradeStep,
  meetsFloor,
  parseGraphifyVersion,
  parseUvToolList,
  probeCliSurfaces,
} = require('../bin/graphify.js');
const { execute } = require('../bin/update-loadout.js');

const GRAPHIFY_BIN = path.join(__dirname, '..', 'bin', 'graphify.js');

// Verbatim excerpt of `graphify --help` from the observed 0.8.38 install, kept faithful
// including the two lines that could produce a false positive: `--graph <path>` contains
// "path" and `check-update <path>` contains "update", so a loose probe would pass even
// after the real `path`/`update` surfaces were renamed away.
const REAL_HELP = `graphify - code knowledge graph

Usage: graphify [options] <path>

Commands:
  path "A" "B"            shortest path between two nodes in graph.json
  explain "X"             plain-language explanation of a node and its neighbors
  update <path>           re-extract code files and update the graph (no LLM needed)
  check-update <path>     report whether the graph is stale without rewriting it
  query "<question>"      BFS traversal of graph.json for a question
  hook status             check if git hooks are installed

Options:
  --graph <path>          path to graph.json
  --help                  show this help
`;

// `uv tool list` prints `<distribution> v<version>` then its executables as `- <name>`
// lines. The distribution is graphifyy with two y's; the executable is graphify.
const REAL_UV_TOOL_LIST = `ansible-core v2.21.0
- ansible
- ansible-playbook
graphifyy v0.8.38
- graphify
- graphify-mcp
llm-council v0.3.1
- llm-council
`;

/** A `run` stub keyed on the full command line, recording every call it saw. */
function fakeRun(handlers) {
  const calls = [];
  const run = (command) => {
    const key = [command.command, ...command.args].join(' ');
    calls.push(key);
    for (const [match, response] of handlers) {
      if (typeof match === 'string' ? key === match : match.test(key)) return response;
    }
    return { ok: false, output: '', error: `no stub for ${key}` };
  };
  run.calls = calls;
  return run;
}

const UV_LIST_INSTALLED = ['uv tool list', { ok: true, output: REAL_UV_TOOL_LIST }];
const UV_LIST_EMPTY = ['uv tool list', { ok: true, output: 'ansible-core v2.21.0\n- ansible\n' }];
const UV_MISSING = [/^uv /, { ok: false, output: '', error: 'spawn uv ENOENT' }];
const GRAPHIFY_VERSION_OK = ['graphify --version', { ok: true, output: 'graphify 0.8.38' }];
const GRAPHIFY_HELP_OK = ['graphify --help', { ok: true, output: REAL_HELP }];
const HOOK_STATUS_OK = ['graphify hook status', { ok: true, output: 'git hooks: installed (post-commit)' }];

function projectFixture(t, { withReport = false } = {}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-graphify-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  if (withReport) {
    fs.mkdirSync(path.join(project, path.dirname(GRAPH_REPORT_RELATIVE_PATH)), { recursive: true });
    fs.writeFileSync(path.join(project, GRAPH_REPORT_RELATIVE_PATH), '# graph report\n');
  }
  return project;
}

function collect() {
  const lines = [];
  const report = (line) => lines.push(String(line));
  report.text = () => lines.join('\n');
  return report;
}

test('the pinned package name is the graphifyy distribution, not the graphify executable', () => {
  // `graphify` is not a PyPI project (404); installing that name fails outright.
  assert.equal(GRAPHIFY_PACKAGE, 'graphifyy');
  assert.deepEqual(graphifyInstallCommand().args, ['tool', 'install', 'graphifyy']);
  assert.deepEqual(graphifyUpgradeCommand().args, ['tool', 'upgrade', 'graphifyy']);
  // The upgrade follows the distribution name uv actually recorded, so an upstream rename
  // does not leave the updater upgrading a package that no longer exists.
  assert.deepEqual(graphifyUpgradeCommand('graphify-ng').args, ['tool', 'upgrade', 'graphify-ng']);
});

test('parseUvToolList reads distributions and their executables from real output', () => {
  const tools = parseUvToolList(REAL_UV_TOOL_LIST);
  assert.deepEqual(tools.map((tool) => tool.name), ['ansible-core', 'graphifyy', 'llm-council']);
  const graphify = tools.find((tool) => tool.name === 'graphifyy');
  assert.equal(graphify.version, '0.8.38');
  assert.deepEqual(graphify.executables, ['graphify', 'graphify-mcp']);
  assert.deepEqual(parseUvToolList(''), []);
});

test('findGraphifyTool matches the distribution name or the executable it provides', () => {
  assert.equal(findGraphifyTool(parseUvToolList(REAL_UV_TOOL_LIST)).name, 'graphifyy');
  // A renamed distribution is still found through its graphify executable.
  const renamed = [{ name: 'graphify-ng', version: '1.0.0', executables: ['graphify'] }];
  assert.equal(findGraphifyTool(renamed).name, 'graphify-ng');
  assert.equal(findGraphifyTool([{ name: 'ansible-core', version: '2.21.0', executables: ['ansible'] }]), null);
});

test('version comparison is numeric, so 0.8.9 is below the 0.8.38 floor', () => {
  // String comparison would wrongly rank 0.8.9 above 0.8.38.
  assert.equal(compareVersions('0.8.9', '0.8.38'), -1);
  assert.equal(compareVersions('0.8.38', '0.8.38'), 0);
  assert.equal(compareVersions('0.9.0', '0.8.38'), 1);
  assert.equal(compareVersions('v0.8.38', '0.8.38'), 0);
  assert.equal(meetsFloor('0.8.38'), true);
  assert.equal(meetsFloor('0.8.37'), false);
  assert.equal(meetsFloor(null), false);
  assert.equal(GRAPHIFY_FLOOR_VERSION, '0.8.38');
  assert.equal(parseGraphifyVersion('graphify 0.8.38'), '0.8.38');
});

test('detectGraphify reports uv missing, graphify absent, and graphify installed', () => {
  const noUv = detectGraphify({ run: fakeRun([UV_MISSING]) });
  assert.equal(noUv.uvAvailable, false);
  assert.equal(noUv.installed, false);
  assert.match(noUv.reason, /ENOENT/);

  const absent = detectGraphify({ run: fakeRun([UV_LIST_EMPTY]) });
  assert.equal(absent.uvAvailable, true);
  assert.equal(absent.installed, false);
  assert.equal(absent.version, null);

  const installed = detectGraphify({ run: fakeRun([UV_LIST_INSTALLED, GRAPHIFY_VERSION_OK]) });
  assert.equal(installed.installed, true);
  assert.equal(installed.package, 'graphifyy');
  assert.equal(installed.version, '0.8.38');
  assert.equal(installed.executableAvailable, true);
});

test('detectGraphify falls back to the uv-recorded version when the executable is off PATH', () => {
  const run = fakeRun([UV_LIST_INSTALLED, ['graphify --version', { ok: false, output: '', error: 'spawn graphify ENOENT' }]]);
  const detected = detectGraphify({ run });
  assert.equal(detected.installed, true);
  assert.equal(detected.version, '0.8.38');
  assert.equal(detected.executableAvailable, false);
});

test('probeCliSurfaces passes on the real 0.8.38 help text', () => {
  const probe = probeCliSurfaces({ run: fakeRun([GRAPHIFY_HELP_OK]), version: '0.8.38' });
  assert.equal(probe.ok, true);
  assert.deepEqual(probe.missing, []);
  assert.deepEqual(probe.present, ['query', 'explain', 'path', 'hook status', 'update']);
  // `--help` documents `update <path>` and never prints `--update`, so the probe records
  // the documented spelling it matched rather than the undocumented alias.
  assert.equal(probe.spellings.update, 'update');
});

test('probeCliSurfaces accepts either spelling of the update surface', () => {
  const aliasOnly = REAL_HELP.replace(/^  update <path>.*$/m, '  --update                re-extract and update the graph');
  const probe = probeCliSurfaces({ run: fakeRun([['graphify --help', { ok: true, output: aliasOnly }]]), version: '0.8.38' });
  assert.equal(probe.ok, true);
  assert.equal(probe.spellings.update, '--update');
});

test('probeCliSurfaces fails loudly when a surface the mapper depends on is renamed', () => {
  // `--graph <path>` and `check-update <path>` both survive, so a loose probe would still
  // pass here. This asserts the renamed surfaces are reported missing anyway.
  const renamed = REAL_HELP
    .replace(/^  path "A" "B".*$/m, '  route "A" "B"           shortest route between two nodes')
    .replace(/^  query "<question>".*$/m, '  ask "<question>"        BFS traversal for a question')
    .replace(/^  update <path>.*$/m, '  reindex <path>          re-extract code files');
  const probe = probeCliSurfaces({ run: fakeRun([['graphify --help', { ok: true, output: renamed }]]), version: '0.8.38' });
  assert.equal(probe.ok, false);
  assert.deepEqual(probe.missing, ['query', 'path', 'update']);
});

test('probeCliSurfaces fails when the installed version is below the floor', () => {
  const probe = probeCliSurfaces({ run: fakeRun([GRAPHIFY_HELP_OK]), version: '0.8.12' });
  assert.equal(probe.ok, false);
  assert.equal(probe.floorOk, false);
  assert.deepEqual(probe.missing, []);
});

test('probeCliSurfaces reports when it could not run at all, never as healthy', () => {
  const probe = probeCliSurfaces({ run: fakeRun([['graphify --help', { ok: false, output: '', error: 'spawn graphify ENOENT' }]]), version: '0.8.38' });
  assert.equal(probe.ok, false);
  assert.equal(probe.ran, false);
});

test('doctor reports a missing graphify as opt-in, not as a fault', (t) => {
  const result = graphifyDoctor({ projectPath: projectFixture(t), run: fakeRun([UV_LIST_EMPTY]) });
  assert.equal(result.ok, true, 'an absent opt-in tool is not a doctor failure');
  assert.match(result.rows.join('\n'), /not installed \(opt-in\)/);
  assert.match(result.rows.join('\n'), /graph mode: off/);
});

test('doctor reports a missing uv without offering to install it', (t) => {
  const result = graphifyDoctor({ projectPath: projectFixture(t), run: fakeRun([UV_MISSING]) });
  assert.equal(result.ok, true);
  const text = result.rows.join('\n');
  assert.match(text, /uv is not available/);
  assert.match(text, /docs\.astral\.sh\/uv/);
  assert.doesNotMatch(text, /uv tool install/, 'a read-only doctor never prints an install it would run');
});

test('doctor reports version, graph mode, hook status, and a passing probe', (t) => {
  const run = fakeRun([UV_LIST_INSTALLED, GRAPHIFY_VERSION_OK, GRAPHIFY_HELP_OK, HOOK_STATUS_OK]);
  const result = graphifyDoctor({ projectPath: projectFixture(t, { withReport: true }), run });
  assert.equal(result.ok, true);
  const text = result.rows.join('\n');
  assert.match(text, /graphify: 0\.8\.38 installed as uv tool graphifyy \(floor 0\.8\.38\)/);
  assert.match(text, /graph mode: on/);
  assert.match(text, /graphify hook status: git hooks: installed \(post-commit\)/);
  assert.match(text, /CLI surface probe: ok, all 5 pinned surfaces present/);
  // hook status is read in the project being inspected, and nothing is written.
  assert.ok(run.calls.includes('graphify hook status'));
});

test('doctor fails loudly and names the renamed surface', (t) => {
  const renamed = REAL_HELP.replace(/^  explain "X".*$/m, '  describe "X"            plain-language explanation');
  const run = fakeRun([UV_LIST_INSTALLED, GRAPHIFY_VERSION_OK, ['graphify --help', { ok: true, output: renamed }], HOOK_STATUS_OK]);
  const result = graphifyDoctor({ projectPath: projectFixture(t), run });
  assert.equal(result.ok, false);
  const text = result.rows.join('\n');
  assert.match(text, /CLI surface probe: FAILED/);
  assert.match(text, /no longer offers explain/);
});

test('doctor fails when the install is below the floor the mapper needs', (t) => {
  const run = fakeRun([
    ['uv tool list', { ok: true, output: 'graphifyy v0.8.12\n- graphify\n' }],
    ['graphify --version', { ok: true, output: 'graphify 0.8.12' }],
    GRAPHIFY_HELP_OK,
    HOOK_STATUS_OK,
  ]);
  const result = graphifyDoctor({ projectPath: projectFixture(t), run });
  assert.equal(result.ok, false);
  assert.match(result.rows.join('\n'), /0\.8\.12 is below the 0\.8\.38 floor/);
});

test('the upgrade step never installs graphify when it is absent', () => {
  const run = fakeRun([UV_LIST_EMPTY]);
  const report = collect();
  const result = graphifyUpgradeStep({ options: {}, run, report, execute });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'absent');
  assert.deepEqual(result.failures, []);
  assert.match(report.text(), /not installed \(opt-in\)/);
  assert.ok(!run.calls.some((call) => call.includes('tool install')), 'the updater must never install an opt-in tool');
  assert.ok(!run.calls.some((call) => call.includes('tool upgrade')));
});

test('the upgrade step skips when uv is absent and never installs uv', () => {
  const run = fakeRun([UV_MISSING]);
  const report = collect();
  const result = graphifyUpgradeStep({ options: {}, run, report, execute });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'uv-missing');
  assert.match(report.text(), /never installs uv/);
  assert.equal(run.calls.length, 1);
});

test('--check reports the installed version without changing it', () => {
  const run = fakeRun([UV_LIST_INSTALLED, GRAPHIFY_VERSION_OK]);
  const report = collect();
  const result = graphifyUpgradeStep({ options: { check: true }, run, report, execute });
  assert.equal(result.status, 'checked');
  assert.equal(result.version, '0.8.38');
  assert.match(report.text(), /installed 0\.8\.38 as uv tool graphifyy/);
  assert.ok(!run.calls.some((call) => call.includes('tool upgrade')), '--check must not upgrade');
});

test('--dry-run prints the upgrade command without running it', () => {
  const run = fakeRun([UV_LIST_INSTALLED, GRAPHIFY_VERSION_OK]);
  const report = collect();
  const result = graphifyUpgradeStep({ options: { dryRun: true }, run, report, execute });
  assert.equal(result.status, 'dry-run');
  assert.match(report.text(), /"uv" "tool" "upgrade" "graphifyy"/);
  assert.ok(!run.calls.some((call) => call.includes('tool upgrade')), '--dry-run must not upgrade');
});

test('the upgrade step runs the upgrade and surfaces its output', () => {
  const run = fakeRun([UV_LIST_INSTALLED, GRAPHIFY_VERSION_OK, ['uv tool upgrade graphifyy', { ok: true, output: 'Updated graphifyy v0.8.38 -> v0.9.0' }]]);
  const report = collect();
  const result = graphifyUpgradeStep({ options: {}, run, report, execute });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'upgraded');
  assert.match(report.text(), /Updated graphifyy v0\.8\.38 -> v0\.9\.0/);
});

test('a failed upgrade is reported as a failure and does not stop the run', () => {
  const run = fakeRun([UV_LIST_INSTALLED, GRAPHIFY_VERSION_OK, ['uv tool upgrade graphifyy', { ok: false, output: 'error: resolution failed', error: 'exit 1' }]]);
  const report = collect();
  const result = graphifyUpgradeStep({ options: {}, run, report, execute });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, ['graphify upgrade (graphifyy)']);
  const text = report.text();
  assert.match(text, /error: resolution failed/);
  assert.match(text, /the rest of this update continued/);
});

// --- end to end, with uv and graphify stubbed on PATH ---

function stubPath(t, { helpDrop = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-graphify-path-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const help = helpDrop ? REAL_HELP.replace(helpDrop, '') : REAL_HELP;
  const write = (name, body) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    fs.chmodSync(file, 0o755);
  };

  write('uv', `#!/bin/sh
if [ "$1" = "tool" ] && [ "$2" = "list" ]; then
  printf '%s' '${REAL_UV_TOOL_LIST}'
  exit 0
fi
if [ "$1" = "tool" ] && [ "$2" = "upgrade" ]; then
  echo "Updated $3"
  exit 0
fi
echo "stub uv: unexpected $*" >&2
exit 1
`);

  write('graphify', `#!/bin/sh
if [ "$1" = "--version" ]; then echo "graphify 0.8.38"; exit 0; fi
if [ "$1" = "--help" ]; then printf '%s' '${help}'; exit 0; fi
if [ "$1" = "hook" ] && [ "$2" = "status" ]; then echo "git hooks: not installed"; exit 0; fi
echo "stub graphify: unexpected $*" >&2
exit 1
`);

  return dir;
}

function runDoctorCli(t, { project, stubDir, expectFailure = false }) {
  try {
    const stdout = execFileSync(process.execPath, [GRAPHIFY_BIN, 'doctor', '--project', project], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${stubDir}${path.delimiter}${process.env.PATH}` },
    });
    assert.ok(!expectFailure, `expected a non-zero exit, got success:\n${stdout}`);
    return { status: 0, stdout };
  } catch (error) {
    assert.ok(expectFailure, `expected success, got exit ${error.status}:\n${error.stdout}${error.stderr}`);
    return { status: error.status, stdout: String(error.stdout ?? '') };
  }
}

test('the doctor CLI passes end to end against stubbed uv and graphify on PATH', (t) => {
  const { stdout } = runDoctorCli(t, { project: projectFixture(t, { withReport: true }), stubDir: stubPath(t) });
  assert.match(stdout, /graphify: 0\.8\.38 installed as uv tool graphifyy/);
  assert.match(stdout, /graph mode: on/);
  assert.match(stdout, /graphify hook status: git hooks: not installed/);
  assert.match(stdout, /CLI surface probe: ok, all 5 pinned surfaces present/);
});

test('the doctor CLI exits non-zero end to end when a pinned surface disappears', (t) => {
  // Drop the `query` line from the stub's help: the mapper's query surface is gone.
  const stubDir = stubPath(t, { helpDrop: /^  query "<question>".*\n/m });
  const { status, stdout } = runDoctorCli(t, { project: projectFixture(t), stubDir, expectFailure: true });
  assert.equal(status, 1, 'a renamed upstream surface must fail loudly in the doctor');
  assert.match(stdout, /CLI surface probe: FAILED/);
  assert.match(stdout, /no longer offers query/);
});

test('the doctor CLI reports graph mode off without a graph report, and still exits zero', (t) => {
  const { stdout } = runDoctorCli(t, { project: projectFixture(t), stubDir: stubPath(t) });
  assert.match(stdout, /graph mode: off/);
  assert.match(stdout, new RegExp(GRAPH_REPORT_RELATIVE_PATH.replace(/[\\/]/g, '[\\\\/]')));
});

test('the check CLI reports the installed version only', (t) => {
  const stubDir = stubPath(t);
  const stdout = execFileSync(process.execPath, [GRAPHIFY_BIN, 'check'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${stubDir}${path.delimiter}${process.env.PATH}` },
  });
  assert.match(stdout, /graphify: 0\.8\.38 installed as uv tool graphifyy/);
  assert.doesNotMatch(stdout, /CLI surface probe/);
});
