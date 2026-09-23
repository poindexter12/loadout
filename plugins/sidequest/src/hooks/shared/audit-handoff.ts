import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringField, type HookInput } from './input.js';
import { pluginRoot } from './paths.js';

const DEFAULT_AUDIT_DEADLINE_MS = 2500;
export const AUDIT_DEFERRAL_NOTICE = 'sidequest: audit report exceeded its SessionStart budget and is still running in the background.';
export const AUDIT_FAILED_NOTICE = 'sidequest: audit report could not run; run `sidequest audit` for detail.';

type AuditHandoffReport = Readonly<{ summary?: string }>;

export function auditDeadlineMs(): number {
  const raw = Number(process.env.SIDEQUEST_AUDIT_DEADLINE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_AUDIT_DEADLINE_MS;
}

function stateDirectory(): string {
  const home = String(process.env.SIDEQUEST_HOME || '').trim() || path.join(os.homedir(), '.claude', 'sidequest');
  return path.join(home, 'audit-reports');
}

export function auditReportFile(cwd: string): string {
  const key = crypto.createHash('sha1').update(path.resolve(cwd || '.')).digest('hex').slice(0, 16);
  return path.join(stateDirectory(), `${key}.json`);
}

export function writeAuditHandoffReport(cwd: string, report: AuditHandoffReport): void {
  try {
    fs.mkdirSync(stateDirectory(), { recursive: true });
    fs.writeFileSync(auditReportFile(cwd), JSON.stringify({ summary: String(report.summary || ''), finishedAt: new Date().toISOString() }));
  } catch (_) {
    // Audit is advisory and must never fail SessionStart.
  }
}

function drainAuditHandoffReport(cwd: string): string | null {
  const file = auditReportFile(cwd);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as AuditHandoffReport;
    fs.rmSync(file, { force: true });
    return String(parsed.summary || '');
  } catch (_) {
    return null;
  }
}

function auditCwd(data: HookInput): string {
  return stringField(data, 'cwd', 'project_dir', 'projectDir') || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/** Runs report-only audit in a detached child so SessionStart never waits unbounded. */
export async function runAuditHandoff(data: HookInput): Promise<string[]> {
  const cwd = auditCwd(data);
  const carried = drainAuditHandoffReport(cwd);
  const notices = carried ? [carried] : [];
  let child;
  try {
    child = spawn(process.execPath, [
      path.join(pluginRoot(), 'hooks', 'audit-report.js'),
      '--cwd', cwd,
    ], { detached: true, stdio: 'ignore', windowsHide: true });
  } catch (_) {
    return [...notices, AUDIT_FAILED_NOTICE];
  }

  const budget = auditDeadlineMs();
  const outcome = await new Promise<'exited' | 'deferred' | 'failed'>((resolve) => {
    if (budget === 0) return resolve('deferred');
    const timer = setTimeout(() => resolve('deferred'), budget);
    child.once('exit', () => { clearTimeout(timer); resolve('exited'); });
    child.once('error', () => { clearTimeout(timer); resolve('failed'); });
  });
  if (outcome === 'failed') return [...notices, AUDIT_FAILED_NOTICE];
  if (outcome === 'deferred') {
    child.unref();
    return [...notices, `${AUDIT_DEFERRAL_NOTICE} Progress at the ${budget}ms budget; the detached report will be surfaced on the next session start.`];
  }
  const summary = drainAuditHandoffReport(cwd);
  return summary ? [...notices, summary] : notices;
}
