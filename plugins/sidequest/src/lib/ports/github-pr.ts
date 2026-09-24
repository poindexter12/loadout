'use strict';

import type { GhExecutor } from '../audit/github.js';

const { execFileSync } = require('node:child_process') as typeof import('node:child_process');

export type PrCheckState = 'pending' | 'success' | 'failure';

export interface PrStatus {
  number: number;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  headSha: string;
  mergeCommit: string | null;
  checks: PrCheckState;
  failingChecks: string[];
}

export interface GitHubPrPort {
  createPr(o: { cwd: string; head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  enableAutoMerge(o: { cwd: string; number: number }): Promise<void>;
  viewPr(o: { cwd: string; number: number }): Promise<PrStatus>;
}

/** Indicates that PR delivery cannot use the local gh installation. */
export class PrDeliveryUnavailableError extends Error {
  readonly cause: string;

  constructor(cause: string) {
    super(`PR delivery unavailable: ${cause}`);
    this.name = 'PrDeliveryUnavailableError';
    this.cause = cause;
  }
}

const FAILURE_STATES = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ERROR']);
const PENDING_STATES = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED', 'ACTION_REQUIRED']);

type GhPrPayload = Readonly<{
  number?: unknown;
  url?: unknown;
  state?: unknown;
  headRefOid?: unknown;
  mergeCommit?: unknown;
  statusCheckRollup?: unknown;
}>;

type RollupEntry = Readonly<{ name?: unknown; context?: unknown; workflowName?: unknown; conclusion?: unknown; state?: unknown; status?: unknown }>;

function defaultExecutor(program: string, arguments_: string[], options?: Record<string, unknown>): unknown {
  return execFileSync(program, arguments_, { ...options, windowsHide: true } as import('node:child_process').ExecFileSyncOptions);
}

function errorCause(error: unknown): string {
  return String((error as { message?: unknown })?.message || error || 'gh command failed').replace(/\s+/g, ' ').trim();
}

function unavailable(exec: GhExecutor, error: unknown): PrDeliveryUnavailableError {
  const cause = exec.lastError || errorCause(error);
  if (!exec.lastError) exec.lastError = cause;
  return new PrDeliveryUnavailableError(cause);
}

function command(exec: GhExecutor, cwd: string, arguments_: string[], input?: string): string {
  try {
    const output = exec('gh', arguments_, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(input === undefined ? {} : { input }),
    });
    return String(output ?? '').trim();
  } catch (error: unknown) {
    throw unavailable(exec, error);
  }
}

function invalidResponse(exec: GhExecutor, description: string): never {
  throw unavailable(exec, `invalid gh ${description} response`);
}

function createdPr(exec: GhExecutor, output: string): { number: number; url: string } {
  const url = output.match(/https?:\/\/[^\s"'<>]+/)?.[0];
  const number = url && /\/pull\/(\d+)(?:[/?#]|$)/.exec(url)?.[1];
  if (!url || !number) return invalidResponse(exec, 'pr create');
  return Object.freeze({ number: Number(number), url });
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function commitOid(value: unknown): string | null {
  if (typeof value === 'string') return stringValue(value);
  if (!value || typeof value !== 'object') return null;
  return stringValue((value as { oid?: unknown }).oid);
}

function checkName(entry: RollupEntry): string | null {
  return stringValue(entry.name) || stringValue(entry.context) || stringValue(entry.workflowName);
}

function rollupState(entries: readonly RollupEntry[], prState: PrStatus['state']): Pick<PrStatus, 'checks' | 'failingChecks'> {
  if (!entries.length) return Object.freeze({ checks: prState === 'OPEN' ? 'pending' : 'success', failingChecks: [] });
  const failingChecks = entries
    .filter((entry) => [entry.conclusion, entry.state, entry.status].some((value) => FAILURE_STATES.has(String(value || '').toUpperCase())))
    .map(checkName)
    .filter((name): name is string => name !== null);
  if (failingChecks.length || entries.some((entry) => [entry.conclusion, entry.state, entry.status].some((value) => FAILURE_STATES.has(String(value || '').toUpperCase())))) {
    return Object.freeze({ checks: 'failure', failingChecks: [...new Set(failingChecks)] });
  }
  if (entries.some((entry) => [entry.conclusion, entry.state, entry.status].some((value) => PENDING_STATES.has(String(value || '').toUpperCase())))) {
    return Object.freeze({ checks: 'pending', failingChecks: [] });
  }
  return Object.freeze({ checks: 'success', failingChecks: [] });
}

function statusFromPayload(exec: GhExecutor, payload: unknown): PrStatus {
  if (!payload || typeof payload !== 'object') return invalidResponse(exec, 'pr view');
  const value = payload as GhPrPayload;
  const number = Number(value.number);
  const url = stringValue(value.url);
  const headSha = stringValue(value.headRefOid);
  const state = String(value.state || '').toUpperCase();
  if (!Number.isInteger(number) || number < 1 || !url || !headSha || (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED')) return invalidResponse(exec, 'pr view');
  const rollup = Array.isArray(value.statusCheckRollup) ? value.statusCheckRollup.filter((entry): entry is RollupEntry => Boolean(entry) && typeof entry === 'object') : [];
  return Object.freeze({ number, url, state, headSha, mergeCommit: commitOid(value.mergeCommit), ...rollupState(rollup, state) });
}

export function createGhPrPort(exec: GhExecutor = defaultExecutor as GhExecutor): GitHubPrPort {
  return Object.freeze({
    async createPr({ cwd, head, base, title, body }: Parameters<GitHubPrPort['createPr']>[0]) {
      return createdPr(exec, command(exec, cwd, ['pr', 'create', '--base', base, '--head', head, '--title', title, '--body-file', '-'], body));
    },
    async enableAutoMerge({ cwd, number }: Parameters<GitHubPrPort['enableAutoMerge']>[0]) {
      command(exec, cwd, ['pr', 'merge', String(number), '--auto', '--merge']);
    },
    async viewPr({ cwd, number }: Parameters<GitHubPrPort['viewPr']>[0]) {
      const output = command(exec, cwd, ['pr', 'view', String(number), '--json', 'number,url,state,headRefOid,mergeCommit,statusCheckRollup']);
      try {
        return statusFromPayload(exec, JSON.parse(output));
      } catch (error: unknown) {
        if (error instanceof PrDeliveryUnavailableError) throw error;
        throw unavailable(exec, error);
      }
    },
  });
}
