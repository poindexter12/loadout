#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const USAGE = `Usage: node scripts/test/flake-rate.mjs [options]

Runs a plugin's node:test suite N times on the current tree and reports per-test failure counts
and distinct failure signatures, so a CI red can be classified as flake vs defect by rerun evidence
instead of judgement.

Limits (read before trusting the output):
  - This measures this machine, or this CI runner, right now. A different machine, a busier one, or
    a different Node version can show a different rate.
  - A 0/N clean result BOUNDS the flake rate observed in this run; it does NOT prove the suite is
    deterministic. Absence of failure across N runs is evidence, not proof.

  --plugin <name>       Plugin under plugins/<name>/test (default: model-gateway)
  --runs <n>            Number of times to run the suite (default: 10)
  --glob <pattern>      Test file glob passed to node --test (default: test/*.test.js)
  --run-timeout <ms>    Per-run kill timeout in milliseconds (default: 300000)
  --repo <dir>          Repository root (defaults to this script's repo)
  --json                Print the full machine-readable report instead of the human summary
  --quiet               Suppress the "run i/N" progress line
  --help, -h            Show this help`;

class UsageError extends Error {}

function repoRoot() {
  // scripts/test/flake-rate.mjs is two directories below the repo root.
  return path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

// --- TAP parsing -----------------------------------------------------------
//
// node --test --test-reporter=tap emits a flat stream regardless of how many files were
// passed: one continuous "ok N - name" / "not ok N - name" sequence, a "1..N" plan line, and
// one final "# tests/# pass/# fail/..." summary block. A failing test's diagnostic is a YAML
// block delimited by "---" / "..." following its result line; this is a line-based reader for
// the handful of fields we care about (error, code, name, failureType), not a full YAML parser.

function readSummary(lines, startIndex) {
  const summary = {};
  for (let j = startIndex; j < Math.min(lines.length, startIndex + 10); j++) {
    const m = /^# (tests|pass|fail|cancelled|skipped|todo|duration_ms)\s+([\d.]+)/.exec(lines[j]);
    if (m) summary[m[1]] = Number(m[2]);
  }
  return summary;
}

function readDiagnosticBlock(lines, fromIndex) {
  let j = fromIndex;
  while (j < lines.length && !/^\s*---\s*$/.test(lines[j])) {
    if (/^\s*(not ok|ok)\s+\d+\s+-/.test(lines[j])) return [];
    j++;
  }
  if (j >= lines.length) return [];
  const blockStart = j + 1;
  let k = blockStart;
  while (k < lines.length && !/^\s*\.\.\.\s*$/.test(lines[k])) k++;
  return lines.slice(blockStart, k);
}

function stripQuotes(value) {
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1);
  }
  return value;
}

function extractFailureInfo(block) {
  let code = null;
  let errorName = null;
  let failureType = null;
  let message = null;

  for (let i = 0; i < block.length; i++) {
    const line = block[i];
    let m;
    if ((m = /^\s*code:\s*'?([\w.]+)'?\s*$/.exec(line))) { code = m[1]; continue; }
    if ((m = /^\s*name:\s*'?([\w. ]+?)'?\s*$/.exec(line))) { errorName = m[1]; continue; }
    if ((m = /^\s*failureType:\s*'?([\w.]+)'?\s*$/.exec(line))) { failureType = m[1]; continue; }
    if ((m = /^\s*error:\s*(.*)$/.exec(line))) {
      const rest = m[1].trim();
      if (rest === '|-' || rest === '|' || rest === '>-' || rest === '>') {
        const baseIndent = /^(\s*)/.exec(line)[1].length;
        const msgLines = [];
        let j = i + 1;
        while (j < block.length) {
          const l = block[j];
          if (l.trim() === '') { msgLines.push(''); j++; continue; }
          const lIndent = /^(\s*)/.exec(l)[1].length;
          if (lIndent <= baseIndent) break;
          msgLines.push(l.slice(baseIndent + 2));
          j++;
        }
        message = msgLines.join('\n').trim();
      } else {
        message = stripQuotes(rest);
      }
    }
  }

  const firstLine = (message ?? '').split('\n').find((l) => l.trim() !== '') ?? '';
  const signature = [code ?? errorName ?? failureType ?? 'Error', firstLine].filter(Boolean).join(': ').slice(0, 200);

  return { code, errorName, failureType, message: message ?? '', signature };
}

export function parseTap(output) {
  const lines = output.split('\n');
  const failures = [];
  let pass = 0;
  let fail = 0;
  let summary = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^# tests \d+/.test(line)) {
      summary = readSummary(lines, i);
      continue;
    }
    const testMatch = /^(\s*)(not ok|ok)\s+\d+\s+-\s+(.*)$/.exec(line);
    if (!testMatch) continue;
    const [, , status, rawName] = testMatch;
    const name = rawName.replace(/\s+#\s+(SKIP|TODO).*$/i, '').trim();
    if (status === 'ok') {
      pass++;
      continue;
    }
    fail++;
    const block = readDiagnosticBlock(lines, i + 1);
    failures.push({ name, ...extractFailureInfo(block) });
  }

  return { failures, observedPass: pass, observedFail: fail, summary };
}

// --- Running the suite -------------------------------------------------------

function runOnce({ cwd, glob, timeout, index }) {
  const start = Date.now();
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', glob], {
    cwd,
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: 256 * 1024 * 1024,
  });
  const durationMs = Date.now() - start;

  const timedOut = result.error?.code === 'ETIMEDOUT'
    || (result.status === null && result.signal === 'SIGKILL' && durationMs >= timeout - 50);

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const parsed = parseTap(stdout);
  const crashed = !timedOut && result.status !== 0 && parsed.summary === null;

  const failures = [...parsed.failures];
  if (timedOut) {
    failures.push({
      name: '<process>',
      signature: `timeout: run exceeded ${timeout}ms and was killed`,
      message: `run exceeded ${timeout}ms`,
    });
  } else if (crashed) {
    const stderrTail = stderr.trim().split('\n').filter(Boolean).slice(-5).join(' | ');
    failures.push({
      name: '<process>',
      signature: `process-crash: exit=${result.status ?? 'null'} signal=${result.signal ?? 'none'} ${stderrTail}`.slice(0, 200),
      message: stderr.trim(),
    });
  } else if (result.error) {
    failures.push({
      name: '<process>',
      signature: `spawn-error: ${result.error.message}`.slice(0, 200),
      message: String(result.error.message),
    });
  }

  return {
    index,
    exitCode: result.status,
    signal: result.signal,
    durationMs,
    timedOut,
    crashed,
    summary: parsed.summary,
    observedPass: parsed.observedPass,
    observedFail: parsed.observedFail,
    failures,
  };
}

function buildReport({ plugin, glob, runs, cwd, runTimeout, results }) {
  const perTestFailureCounts = new Map();
  const signatureMap = new Map();
  let cleanRuns = 0;
  let crashedRuns = 0;
  let timedOutRuns = 0;

  for (const r of results) {
    if (r.timedOut) timedOutRuns++;
    if (r.crashed) crashedRuns++;
    if (!r.timedOut && !r.crashed && r.failures.length === 0 && r.exitCode === 0) cleanRuns++;

    for (const f of r.failures) {
      perTestFailureCounts.set(f.name, (perTestFailureCounts.get(f.name) ?? 0) + 1);
      if (!signatureMap.has(f.signature)) {
        signatureMap.set(f.signature, { signature: f.signature, count: 0, tests: new Set(), runs: new Set() });
      }
      const entry = signatureMap.get(f.signature);
      entry.count++;
      entry.tests.add(f.name);
      entry.runs.add(r.index);
    }
  }

  const signatures = [...signatureMap.values()]
    .map((e) => ({ signature: e.signature, count: e.count, tests: [...e.tests], runs: [...e.runs].sort((a, b) => a - b) }))
    .sort((a, b) => b.count - a.count);

  const perTestFailures = [...perTestFailureCounts.entries()]
    .map(([name, count]) => ({ name, failures: count, runs }))
    .sort((a, b) => b.failures - a.failures);

  return {
    plugin,
    glob,
    runs,
    cwd,
    runTimeoutMs: runTimeout,
    cleanRuns,
    failingRuns: runs - cleanRuns,
    crashedRuns,
    timedOutRuns,
    perTestFailures,
    signatures,
    perRun: results.map((r) => ({
      index: r.index,
      exitCode: r.exitCode,
      signal: r.signal,
      durationMs: r.durationMs,
      timedOut: r.timedOut,
      crashed: r.crashed,
      tests: r.summary?.tests ?? null,
      pass: r.summary?.pass ?? null,
      fail: r.summary?.fail ?? null,
      failingTests: r.failures.map((f) => f.name),
    })),
    limits: [
      'This measures this machine/CI runner only, right now; a different machine, load, or Node version can show a different rate.',
      `A ${cleanRuns}/${runs} clean result bounds the flake rate observed in this run; it does not prove the suite is deterministic.`,
    ],
  };
}

function printHumanReport(report) {
  console.log(`flake-rate: plugin=${report.plugin} glob="${report.glob}" runs=${report.runs}`);
  console.log(`cwd: ${report.cwd}`);
  console.log('');
  for (const r of report.perRun) {
    const status = r.timedOut ? 'TIMEOUT' : r.crashed ? 'CRASH' : (r.fail ?? 0) > 0 ? 'FAIL' : 'PASS';
    console.log(`  run ${r.index}: ${status}  tests=${r.tests ?? '?'} pass=${r.pass ?? '?'} fail=${r.fail ?? '?'} exit=${r.exitCode ?? 'null'} duration=${(r.durationMs / 1000).toFixed(1)}s`);
    for (const name of r.failingTests) console.log(`      not ok: ${name}`);
  }
  console.log('');
  console.log(`clean runs: ${report.cleanRuns}/${report.runs}  (failing=${report.failingRuns} crashed=${report.crashedRuns} timedOut=${report.timedOutRuns})`);
  console.log('');
  if (report.perTestFailures.length === 0) {
    console.log('per-test failure counts: none observed');
  } else {
    console.log('per-test failure counts:');
    for (const t of report.perTestFailures) console.log(`  ${t.failures}/${t.runs}  ${t.name}`);
  }
  console.log('');
  if (report.signatures.length === 0) {
    console.log('distinct failure signatures: none observed');
  } else {
    console.log('distinct failure signatures:');
    for (const s of report.signatures) {
      console.log(`  x${s.count}  ${s.signature}`);
      console.log(`        tests: ${s.tests.join(', ')}`);
      console.log(`        runs: ${s.runs.join(', ')}`);
    }
  }
  console.log('');
  for (const l of report.limits) console.log(`limit: ${l}`);
}

export async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      plugin: { type: 'string', default: 'model-gateway' },
      runs: { type: 'string', default: '10' },
      glob: { type: 'string', default: 'test/*.test.js' },
      'run-timeout': { type: 'string', default: '300000' },
      repo: { type: 'string' },
      json: { type: 'boolean' },
      quiet: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const runs = Number.parseInt(values.runs, 10);
  if (!Number.isInteger(runs) || runs < 1) throw new UsageError(`--runs must be a positive integer, got "${values.runs}"`);

  const runTimeout = Number.parseInt(values['run-timeout'], 10);
  if (!Number.isInteger(runTimeout) || runTimeout < 1000) {
    throw new UsageError(`--run-timeout must be a positive integer (ms), got "${values['run-timeout']}"`);
  }

  const root = path.resolve(values.repo ?? repoRoot());
  const pluginDir = path.join(root, 'plugins', values.plugin);
  if (!existsSync(pluginDir)) throw new UsageError(`no such plugin directory: ${pluginDir}`);
  const testDir = path.join(pluginDir, 'test');
  if (!existsSync(testDir)) throw new UsageError(`no test directory under ${pluginDir}`);

  const results = [];
  for (let i = 1; i <= runs; i++) {
    if (!values.quiet) console.log(`[flake-rate] run ${i}/${runs}...`);
    results.push(runOnce({ cwd: pluginDir, glob: values.glob, timeout: runTimeout, index: i }));
  }

  const report = buildReport({ plugin: values.plugin, glob: values.glob, runs, cwd: pluginDir, runTimeout, results });

  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
  }

  return 0;
}

if (isMain()) {
  try {
    process.exitCode = (await main(process.argv.slice(2))) ?? 0;
  } catch (error) {
    process.exitCode = error instanceof UsageError ? 2 : 1;
    console.error(`flake-rate.mjs: ${error.message}`);
  }
}
