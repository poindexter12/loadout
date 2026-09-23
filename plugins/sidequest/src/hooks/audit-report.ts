#!/usr/bin/env node
import path from 'node:path';
import { runtimeModule } from './shared/paths.js';
import { writeAuditHandoffReport } from './shared/audit-handoff.js';

const { auditProject, auditSummary } = require('../lib/audit/report.js');

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
}

function main(): void {
  const cwd = path.resolve(argument('--cwd') || process.cwd());
  try {
    const store = require(runtimeModule('store')) as {
      nearestRepoRoot: (value: string) => string;
      findProject: (value: string) => { ok: boolean; slug?: string; meta?: { path?: string } };
      listTickets: (slug: string) => any[];
      listExternalLinks: (slug: string, options: Record<string, never>) => any[];
    };
    const found = store.findProject(store.nearestRepoRoot(cwd));
    if (!found.ok || !found.slug || !found.meta?.path) return writeAuditHandoffReport(cwd, {});
    const report = auditProject({ slug: found.slug, path: found.meta.path }, store);
    writeAuditHandoffReport(cwd, { summary: auditSummary(report) });
  } catch (_) {
    // The handoff is advisory. Keep its report quiet rather than fail SessionStart.
    writeAuditHandoffReport(cwd, {});
  }
}

main();
