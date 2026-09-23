'use strict';

const { auditProject, formatAudit } = require('../lib/audit/report');
const { resolveProject } = require('./sidequest-cmd-shared');
const store = require('../lib/store');

async function cmdAudit(opts: any) {
  const project = await resolveProject(opts);
  const report = auditProject(project, store, Boolean(opts.apply));
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  console.log(formatAudit(report));
  return report;
}

module.exports = { cmdAudit };
