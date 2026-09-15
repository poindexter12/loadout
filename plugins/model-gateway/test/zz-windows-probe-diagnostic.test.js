'use strict';

// TEMPORARY DIAGNOSTIC — remove before merge.
//
// SQ-23: on the Windows CI leg, resolvePortOwner returns { state: 'unknown' }
// with a PID already in hand, which means netstat found the listener but
// processInfoAsync came back falsy. Three causes are indistinguishable from
// the refusal string: the powershell.exe probe timed out inside the shared
// 2000ms budget, it exited non-zero, or its CIM JSON did not parse. This test
// measures each one directly so a single CI run settles it.

const net = require('node:net');
const test = require('node:test');
const { spawn } = require('node:child_process');
const {
  processInfoAsync, processOwningPortAsync, resolvePortOwner, portListening,
} = require('../lib/process-supervision.js');

const WINDOWS = process.platform === 'win32';

function timed(label, promise) {
  const started = Date.now();
  return promise.then(
    (value) => ({ label, ms: Date.now() - started, value }),
    (error) => ({ label, ms: Date.now() - started, error: String(error) }),
  );
}

function rawPowershell(pid) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress`,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => resolve({ ms: Date.now() - started, spawnError: String(error) }));
    child.once('close', (status) => resolve({
      ms: Date.now() - started, status, stdout: stdout.trim(), stderr: stderr.trim(),
    }));
  });
}

test('DIAGNOSTIC: Windows port-ownership probe timings', { skip: !WINDOWS && 'windows only' }, async (t) => {
  const server = net.createServer(() => {});
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const report = {};

  // 1. Raw powershell cold start against our own PID — the dominant cost.
  const cold = await rawPowershell(process.pid);
  report.powershellCold = {
    ms: cold.ms,
    status: cold.status,
    spawnError: cold.spawnError,
    stderr: cold.stderr?.slice(0, 300),
    stdoutLength: cold.stdout?.length,
    parsed: (() => { try { return Boolean(JSON.parse(cold.stdout || 'null')?.ProcessId); } catch { return 'PARSE_FAILED'; } })(),
    commandLinePresent: (() => { try { return Boolean(JSON.parse(cold.stdout || 'null')?.CommandLine); } catch { return 'PARSE_FAILED'; } })(),
    commandLineSample: (() => { try { return String(JSON.parse(cold.stdout || 'null')?.CommandLine || '').slice(0, 200); } catch { return null; } })(),
  };

  // 2. Second run — warm, to separate cold-start cost from query cost.
  const warm = await rawPowershell(process.pid);
  report.powershellWarm = { ms: warm.ms, status: warm.status };

  // 3. The pieces resolvePortOwner actually calls, each under the real default budget.
  report.portListening = await timed('portListening', Promise.resolve(portListening(port, 2000)));
  report.processOwningPortAsync = await timed('netstat', processOwningPortAsync(port));
  const ownerPid = report.processOwningPortAsync.value;
  report.processInfoAsync = await timed('processInfoAsync', processInfoAsync(ownerPid || process.pid));
  report.processInfoAsyncValue = report.processInfoAsync.value === undefined
    ? 'UNDEFINED (timed out)'
    : report.processInfoAsync.value === null ? 'NULL (non-zero exit or parse fail)' : 'OK';
  delete report.processInfoAsync.value;

  // 4. The whole thing, default budget, then with a generous budget.
  report.resolveDefault = await timed('resolve@default', resolvePortOwner(port));
  report.resolveGenerous = await timed('resolve@15s', resolvePortOwner(port, { timeout: 15000 }));

  console.log('SQ23_DIAGNOSTIC_JSON_BEGIN');
  console.log(JSON.stringify(report, null, 2));
  console.log('SQ23_DIAGNOSTIC_JSON_END');
});
