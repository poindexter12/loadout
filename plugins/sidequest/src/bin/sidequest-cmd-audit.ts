'use strict';

const { auditProject, formatAudit } = require('../lib/audit/report');
const { resolveProject } = require('./sidequest-cmd-shared');
const store = require('../lib/store');

async function cmdAudit(opts: any) {
  const project = await resolveProject(opts);
  const report = auditProject(project, store, Boolean(opts.apply));
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatAudit(report));
  }
  if (report.evidenceUnavailable) process.exitCode = 2;
  return report;
}

module.exports = { cmdAudit };
