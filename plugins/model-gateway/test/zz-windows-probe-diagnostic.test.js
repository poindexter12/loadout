'use strict';

// TEMPORARY DIAGNOSTIC — remove before merge.
//
// SQ-23 round 2. Round 1 disproved the timeout theory: powershell.exe returns
// in ~545ms with exit 0 and a readable CommandLine, and resolvePortOwner still
// answers 'unknown' in ~1s even with a 15s budget. So inspection succeeds and
// the loop is taking the `if (!installRoot) continue` branch instead.
//
// This run starts a REAL shim through the same harness the failing tests use
// and dumps the listener's raw command line alongside every derived value, so
// the exact point where install-root resolution breaks on Windows is visible.

const test = require('node:test');
const path = require('node:path');
const {
  processInfoAsync, processOwningPortAsync, resolvePortOwner,
} = require('../lib/process-supervision.js');
const { gatewayTestEnvironment, startGateway } = require('./support.js');

const WINDOWS = process.platform === 'win32';
const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');

test('DIAGNOSTIC: real shim listener ownership resolution', { skip: !WINDOWS && 'windows only' }, async (t) => {
  const environment = gatewayTestEnvironment(t);
  const shim = await startGateway(t, 'serve-shim', environment);

  const report = { shimPort: shim.port, childPid: shim.child.pid };

  const ownerPid = await processOwningPortAsync(shim.port);
  report.netstatPid = ownerPid;
  report.netstatPidMatchesChild = ownerPid === shim.child.pid;

  const info = await processInfoAsync(ownerPid);
  report.processInfo = info === undefined ? 'UNDEFINED' : info === null ? 'NULL' : {
    pid: info.pid,
    parentPid: info.parentPid,
    startedAt: info.startedAt,
    command: info.command,
    commandLength: String(info.command || '').length,
  };

  // The exact expression resolvePortOwner runs, reproduced verbatim so a null
  // here pins the failure to install-root parsing rather than inspection.
  const { gatewayInstallRootFromCommand } = (() => {
    const supervision = require('../lib/process-supervision.js');
    return { gatewayInstallRootFromCommand: supervision.gatewayInstallRootFromCommand || null };
  })();
  report.gatewayInstallRootFromCommandExported = Boolean(gatewayInstallRootFromCommand);
  if (gatewayInstallRootFromCommand && info) {
    report.derivedInstallRoot = gatewayInstallRootFromCommand(info.command);
  }

  report.expectedCliPath = CLI;
  report.expectedInstallRoot = path.resolve(path.join(CLI, '..', '..'));

  // Also try the parent, in case the listening socket is held by a child the
  // shim spawned rather than the shim process the harness returned.
  if (info?.parentPid) {
    const parent = await processInfoAsync(info.parentPid);
    report.parentCommand = parent?.command ?? String(parent);
  }

  report.resolved = await resolvePortOwner(shim.port, { timeout: 15000 });

  console.log('SQ23_DIAGNOSTIC_JSON_BEGIN');
  console.log(JSON.stringify(report, null, 2));
  console.log('SQ23_DIAGNOSTIC_JSON_END');
});
