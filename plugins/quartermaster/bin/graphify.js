#!/usr/bin/env node
'use strict';

// graphify is the structural layer codebase-mapper can lean on, and the first non-node
// runtime any Loadout plugin touches: a `uv tool` Python install. Quartermaster owns its
// lifecycle, and it is strictly opt-in — codebase-mapper works unchanged without it.
//
// This file is the ONE place that pins the graphify contract: the distribution name, the
// executable name, the version floor, and the CLI surfaces the mapper depends on. A skill
// that hardcodes any of these instead is how an upstream rename turns into a silent
// failure inside a subagent. The surface probe here exists so that rename fails loudly in
// `/quartermaster:loadout-doctor` instead (US-7 decision 6).

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// The PyPI distribution is `graphifyy` with two y's; it installs an executable called
// `graphify` (plus `graphify-mcp`). `graphify` is NOT a PyPI project — installing that
// name fails with 404 — so the two names are deliberately separate constants here.
const GRAPHIFY_PACKAGE = 'graphifyy';
const GRAPHIFY_EXECUTABLE = 'graphify';

// Observed floor. The five surfaces below all exist at this version.
const GRAPHIFY_FLOOR_VERSION = '0.8.38';

// Graph mode is detected, never assumed: a project is in graph mode when this file exists
// at its root (US-7 decision 2). Nothing here ever builds or installs it.
const GRAPH_REPORT_RELATIVE_PATH = path.join('graphify-out', 'GRAPH_REPORT.md');

// The surfaces codebase-mapper invokes, matched against `graphify --help`. `update` is the
// documented spelling (`update <path>`); `graphify <root> --update` is an accepted but
// undocumented alias that `--help` never prints, so either spelling satisfies the probe
// and the probe reports which one it found.
const REQUIRED_CLI_SURFACES = [
  { surface: 'query', pattern: /^\s*query\b/m },
  { surface: 'explain', pattern: /^\s*explain\b/m },
  { surface: 'path', pattern: /^\s*path\b/m },
  { surface: 'hook status', pattern: /^\s*hook\s+status\b/m },
  { surface: 'update', pattern: /^\s*update\b/m, alias: /--update\b/, aliasLabel: '--update' },
];

const UV_INSTALL_DOCS = 'https://docs.astral.sh/uv/getting-started/installation/';

function commandText(command) {
  return [command.command, ...command.args].map((part) => JSON.stringify(part)).join(' ');
}

function defaultRun(command) {
  const result = childProcess.spawnSync(command.command, command.args, {
    cwd: command.cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });

  return {
    ok: result.status === 0 && !result.error,
    output: [result.stdout, result.stderr].filter(Boolean).join('').trim(),
    error: result.error?.message,
  };
}

function uvToolListCommand() {
  return { command: 'uv', args: ['tool', 'list'], label: 'uv tool list' };
}

function graphifyInstallCommand(pkg = GRAPHIFY_PACKAGE) {
  return { command: 'uv', args: ['tool', 'install', pkg], label: `install ${pkg}` };
}

function graphifyUpgradeCommand(pkg = GRAPHIFY_PACKAGE) {
  return { command: 'uv', args: ['tool', 'upgrade', pkg], label: `graphify upgrade (${pkg})` };
}

function graphifyVersionCommand() {
  return { command: GRAPHIFY_EXECUTABLE, args: ['--version'], label: 'graphify --version' };
}

function graphifyHelpCommand(args = []) {
  return { command: GRAPHIFY_EXECUTABLE, args: [...args, '--help'], label: `graphify ${[...args, '--help'].join(' ')}` };
}

function graphifyHookStatusCommand(projectPath) {
  return { command: GRAPHIFY_EXECUTABLE, args: ['hook', 'status'], cwd: projectPath, label: 'graphify hook status' };
}

/**
 * `uv tool list` prints one `<package> v<version>` line per tool, each followed by its
 * executables as `- <name>` lines.
 */
function parseUvToolList(output) {
  const tools = [];
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const tool = /^(\S+)\s+v(\S+)\s*$/.exec(line);
    if (tool) {
      tools.push({ name: tool[1], version: tool[2], executables: [] });
      continue;
    }
    const executable = /^\s*-\s+(\S+)\s*$/.exec(line);
    if (executable && tools.length > 0) tools.at(-1).executables.push(executable[1]);
  }
  return tools;
}

/**
 * Find graphify by the distribution name OR by the executable it provides, so an upstream
 * rename of the distribution is still detected — and so the upgrade targets the name uv
 * actually recorded rather than a name hardcoded here.
 */
function findGraphifyTool(tools) {
  return tools.find((tool) => tool.name === GRAPHIFY_PACKAGE)
    ?? tools.find((tool) => tool.executables.includes(GRAPHIFY_EXECUTABLE))
    ?? null;
}

function compareVersions(left, right) {
  const parse = (value) => String(value ?? '')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function meetsFloor(version, floor = GRAPHIFY_FLOOR_VERSION) {
  return Boolean(version) && compareVersions(version, floor) >= 0;
}

function parseGraphifyVersion(output) {
  const match = /(\d+\.\d+(?:\.\d+)?[\w.+-]*)/.exec(String(output ?? ''));
  return match ? match[1] : null;
}

/**
 * Is graphify present as a uv tool, and at what version? Read-only: `uv tool list` and
 * `graphify --version` change nothing.
 */
function detectGraphify({ run = defaultRun } = {}) {
  const list = run(uvToolListCommand());
  if (!list.ok) {
    return {
      uvAvailable: false,
      installed: false,
      package: GRAPHIFY_PACKAGE,
      version: null,
      reason: list.error ?? 'uv tool list exited unsuccessfully',
    };
  }

  const tool = findGraphifyTool(parseUvToolList(list.output));
  if (!tool) {
    return { uvAvailable: true, installed: false, package: GRAPHIFY_PACKAGE, version: null };
  }

  // Prefer the executable's own answer; fall back to the version uv recorded when the
  // entry exists but its executable is not reachable on PATH.
  const reported = run(graphifyVersionCommand());
  const version = (reported.ok && parseGraphifyVersion(reported.output)) || tool.version;
  return {
    uvAvailable: true,
    installed: true,
    package: tool.name,
    version,
    recordedVersion: tool.version,
    executableAvailable: reported.ok,
  };
}

/**
 * Check that every CLI surface the mapper depends on still exists, and that the version
 * clears the floor. An upstream rename has to fail here, loudly, rather than inside a
 * skill at the moment a subagent needs it.
 */
function probeCliSurfaces({ run = defaultRun, floor = GRAPHIFY_FLOOR_VERSION, version = null } = {}) {
  const top = run(graphifyHelpCommand());
  if (!top.ok) {
    return {
      ok: false,
      ran: false,
      floor,
      version,
      floorOk: meetsFloor(version, floor),
      present: [],
      missing: REQUIRED_CLI_SURFACES.map((entry) => entry.surface),
      reason: top.error ?? 'graphify --help exited unsuccessfully',
    };
  }

  const present = [];
  const missing = [];
  const spellings = {};
  for (const { surface, pattern, alias, aliasLabel } of REQUIRED_CLI_SURFACES) {
    const documented = pattern.test(top.output);
    const aliased = Boolean(alias) && alias.test(top.output);
    if (documented || aliased) {
      present.push(surface);
      spellings[surface] = [documented ? surface : null, aliased ? aliasLabel : null].filter(Boolean).join(' or ');
    } else missing.push(surface);
  }

  const floorOk = meetsFloor(version, floor);
  return { ok: missing.length === 0 && floorOk, ran: true, floor, version, floorOk, present, missing, spellings };
}

function graphReportState(projectPath) {
  const file = path.join(projectPath, GRAPH_REPORT_RELATIVE_PATH);
  return { path: file, present: fs.existsSync(file) };
}

/**
 * Read-only doctor rows. `ok` is false only when the pinned CLI surface contract is
 * broken, which is the one finding that means a skill is about to fail silently. A
 * missing install is not a fault: graphify is opt-in.
 */
function graphifyDoctor({ projectPath = process.cwd(), run = defaultRun } = {}) {
  const rows = [];
  const detected = detectGraphify({ run });
  const report = graphReportState(projectPath);

  if (!detected.uvAvailable) {
    rows.push(`graphify: cannot tell, uv is not available (${detected.reason}). graphify ships as an opt-in uv tool; install uv first: ${UV_INSTALL_DOCS}`);
    rows.push(`graph mode: ${report.present ? 'on' : 'off'} (${report.present ? 'found' : 'no'} ${GRAPH_REPORT_RELATIVE_PATH})`);
    return { ok: true, rows, detected, graphReport: report, hookStatus: null, surfaces: null };
  }

  if (!detected.installed) {
    rows.push('graphify: not installed (opt-in). codebase-mapper works without it; /quartermaster:setup offers the install.');
    rows.push(`graph mode: ${report.present ? 'on' : 'off'} (${report.present ? 'found' : 'no'} ${GRAPH_REPORT_RELATIVE_PATH})`);
    return { ok: true, rows, detected, graphReport: report, hookStatus: null, surfaces: null };
  }

  rows.push(`graphify: ${detected.version} installed as uv tool ${detected.package} (floor ${GRAPHIFY_FLOOR_VERSION})`);
  if (!detected.executableAvailable) {
    rows.push(`graphify: uv records ${detected.package} ${detected.recordedVersion} but the ${GRAPHIFY_EXECUTABLE} executable did not run. Its uv tool bin directory is probably not on PATH.`);
  }
  rows.push(`graph mode: ${report.present ? 'on' : 'off'} (${report.present ? 'found' : 'no'} ${GRAPH_REPORT_RELATIVE_PATH})`);

  const hook = run(graphifyHookStatusCommand(projectPath));
  rows.push(`graphify hook status: ${hook.output || hook.error || (hook.ok ? 'no output' : 'could not run')}`);

  const surfaces = probeCliSurfaces({ run, version: detected.version });
  if (!surfaces.ran) {
    rows.push(`CLI surface probe: could not run graphify --help (${surfaces.reason}). Treat the pinned surfaces as unverified, not healthy.`);
  } else if (surfaces.ok) {
    rows.push(`CLI surface probe: ok, all ${surfaces.present.length} pinned surfaces present (${surfaces.present.join(', ')}).`);
  } else {
    if (surfaces.missing.length > 0) {
      rows.push(`CLI surface probe: FAILED, graphify --help no longer offers ${surfaces.missing.join(', ')}. codebase-mapper depends on ${REQUIRED_CLI_SURFACES.map((entry) => entry.surface).join(', ')}; an upstream rename breaks the mapper's graph mode. Pin or downgrade graphify, or update the surfaces in quartermaster/bin/graphify.js.`);
    }
    if (!surfaces.floorOk) {
      rows.push(`CLI surface probe: FAILED, graphify ${detected.version ?? 'unknown'} is below the ${GRAPHIFY_FLOOR_VERSION} floor codebase-mapper needs. Run /quartermaster:update-loadout to upgrade it.`);
    }
  }

  return { ok: surfaces.ran && surfaces.ok, rows, detected, graphReport: report, hookStatus: hook, surfaces };
}

/**
 * The update-loadout step. Upgrades graphify only when it is already installed: this
 * updater never installs it, because graphify is opt-in and setup owns that choice.
 * Continues after failure the way every other updater step does.
 */
function graphifyUpgradeStep({ options = {}, run = defaultRun, report = console.log, execute }) {
  const detected = detectGraphify({ run });

  if (!detected.uvAvailable) {
    report(`graphify: skipped, uv is not available (${detected.reason}). graphify ships as an opt-in uv tool and this updater never installs uv. See ${UV_INSTALL_DOCS}`);
    return { ok: true, status: 'uv-missing', version: null, failures: [] };
  }

  if (!detected.installed) {
    report('graphify: not installed (opt-in). This updater only upgrades graphify when it is already present; /quartermaster:setup offers the install.');
    return { ok: true, status: 'absent', version: null, failures: [] };
  }

  if (options.check) {
    report(`graphify: installed ${detected.version} as uv tool ${detected.package}. Check mode reports the installed version and does not upgrade it.`);
    return { ok: true, status: 'checked', version: detected.version, failures: [] };
  }

  const command = graphifyUpgradeCommand(detected.package);
  if (!execute(command, options, run, report)) {
    report(`graphify upgrade failed. The installed ${detected.version} is unchanged; the rest of this update continued.`);
    return { ok: false, status: 'failed', version: detected.version, failures: [command.label] };
  }

  return {
    ok: true,
    status: options.dryRun ? 'dry-run' : 'upgraded',
    version: detected.version,
    failures: [],
  };
}

function usage() {
  return `Usage: node graphify.js <doctor|check> [--project <dir>]

Read-only reporting for the opt-in graphify structural layer. Never installs,
upgrades, builds, or writes anything.

  doctor   Report the installed version, graph mode, hook status, and the pinned
           CLI surface probe. Exits 1 when the pinned surface contract is broken.
  check    Report the installed version only.
  --project  Project directory to inspect (default: the current directory)
  --json     Emit the raw report as JSON instead of rows`;
}

function parseArgs(argv) {
  const options = { command: null, project: process.cwd(), json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      options.project = argv[index + 1];
      index += 1;
    } else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (!options.command) options.command = arg;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.project === undefined) throw new Error('--project requires a directory');
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  if (options.help || !options.command) {
    console.log(usage());
    return;
  }

  if (options.command === 'check') {
    const detected = detectGraphify({});
    if (options.json) console.log(JSON.stringify(detected, null, 2));
    else if (!detected.uvAvailable) console.log(`graphify: cannot tell, uv is not available (${detected.reason})`);
    else if (!detected.installed) console.log('graphify: not installed (opt-in)');
    else console.log(`graphify: ${detected.version} installed as uv tool ${detected.package}`);
    return;
  }

  if (options.command !== 'doctor') {
    console.error(`Unknown command: ${options.command}`);
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const result = graphifyDoctor({ projectPath: options.project });
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else for (const row of result.rows) console.log(row);
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  GRAPHIFY_PACKAGE,
  GRAPHIFY_EXECUTABLE,
  GRAPHIFY_FLOOR_VERSION,
  GRAPH_REPORT_RELATIVE_PATH,
  REQUIRED_CLI_SURFACES,
  UV_INSTALL_DOCS,
  commandText,
  compareVersions,
  detectGraphify,
  findGraphifyTool,
  graphReportState,
  graphifyDoctor,
  graphifyHelpCommand,
  graphifyHookStatusCommand,
  graphifyInstallCommand,
  graphifyUpgradeCommand,
  graphifyUpgradeStep,
  graphifyVersionCommand,
  meetsFloor,
  parseArgs,
  parseGraphifyVersion,
  parseUvToolList,
  probeCliSurfaces,
  usage,
  uvToolListCommand,
};
