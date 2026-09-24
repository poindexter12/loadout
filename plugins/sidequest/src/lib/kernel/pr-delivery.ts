'use strict';

import type { Diagnostic } from './index.js';

// PR delivery (US-3) config and integration-state vocabulary. The board config
// key is `deliveryChannel`; the older `delivery` key stays the git method
// ("merge" | "replay" | "apply") and is not touched here.
export type DeliveryChannelMode = 'local' | 'pr';
export type DeliveryChannel = Readonly<{ mode: DeliveryChannelMode; remote?: string; target?: string }>;
export type ResolvedDeliveryChannel = Readonly<{ mode: DeliveryChannelMode; remote: string; target: string }>;
export type WavePullRequest = Readonly<{ number: number; url: string; branch: string; headSha: string; base: string; openedAt: string }>;

export const DELIVERY_CHANNEL_MODES: readonly DeliveryChannelMode[] = Object.freeze(['local', 'pr'] as const);
export const DEFAULT_DELIVERY_CHANNEL_MODE: DeliveryChannelMode = 'local';
export const DEFAULT_DELIVERY_REMOTE = 'origin';
export const AWAITING_MERGE_OUTCOME = 'awaiting-merge';
export const WAVE_BRANCH_PREFIX = 'sidequest/wave/';

const DELIVERY_CHANNEL_KEYS = new Set(['mode', 'remote', 'target']);
const REF_COMPONENT_MAX = 200;
const PR_URL_MAX = 2048;
const FULL_OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/;

function diagnostic(code: string, message: string): Diagnostic {
  return Object.freeze({ code, message, actionable: true });
}

// One path segment that is safe both as a Git ref component and as a command
// argument: it can never be read as an option because it cannot start with "-".
export function isSafeRefComponent(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > REF_COMPONENT_MAX) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) return false;
  return !value.includes('..') && !value.endsWith('.') && !value.endsWith('.lock');
}

// A branch name Git accepts that also cannot be mistaken for a command option.
export function isSafeBranchName(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > REF_COMPONENT_MAX) return false;
  if (value.startsWith('-') || value === '@' || value.startsWith('/') || value.endsWith('/') || value.endsWith('.')) return false;
  if (value.includes('//') || value.includes('/.') || value.endsWith('.lock') || value.includes('..') || value.includes('@{')) return false;
  return !/[\s~^:?*\[\\]/.test(value) && !CONTROL_CHARACTER_RE.test(value);
}

export function waveBranchName(waveId: unknown): string | Diagnostic {
  const id = typeof waveId === 'string' ? waveId.trim() : '';
  if (!isSafeRefComponent(id)) {
    return diagnostic('invalid_wave_id', `Wave id ${JSON.stringify(waveId)} cannot name a PR branch: use letters, digits, ".", "_" or "-", starting with a letter or digit.`);
  }
  return `${WAVE_BRANCH_PREFIX}${id}`;
}

// Validates the stored or requested `deliveryChannel` object. It keeps only
// the keys the caller actually set, so an unset target keeps following the
// board's integrationBranch.
export function normalizeDeliveryChannel(value: unknown): DeliveryChannel | Diagnostic {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return diagnostic('invalid_delivery_channel', 'deliveryChannel must be an object { mode: "local" | "pr", remote?: string, target?: string }.');
  }
  const input = value as Record<string, unknown>;
  const unknownKeys = Object.keys(input).filter((key) => !DELIVERY_CHANNEL_KEYS.has(key));
  if (unknownKeys.length) {
    return diagnostic('invalid_delivery_channel', `deliveryChannel does not accept ${unknownKeys.map((key) => JSON.stringify(key)).join(', ')}; allowed keys are mode, remote, and target.`);
  }
  const mode = typeof input.mode === 'string' ? input.mode.trim().toLowerCase() : '';
  if (!(DELIVERY_CHANNEL_MODES as readonly string[]).includes(mode)) {
    return diagnostic('invalid_delivery_channel', `deliveryChannel.mode must be "local" or "pr"; got ${JSON.stringify(input.mode ?? null)}.`);
  }
  const normalized: { mode: DeliveryChannelMode; remote?: string; target?: string } = { mode: mode as DeliveryChannelMode };
  if (input.remote != null) {
    const remote = typeof input.remote === 'string' ? input.remote.trim() : '';
    if (!isSafeRefComponent(remote)) {
      return diagnostic('invalid_delivery_channel', `deliveryChannel.remote must be a Git remote name of letters, digits, ".", "_" or "-", starting with a letter or digit; got ${JSON.stringify(input.remote)}.`);
    }
    normalized.remote = remote;
  }
  if (input.target != null) {
    const target = typeof input.target === 'string' ? input.target.trim() : '';
    if (!isSafeBranchName(target)) {
      return diagnostic('invalid_delivery_channel', `deliveryChannel.target must be a valid Git branch name that does not start with "-"; got ${JSON.stringify(input.target)}.`);
    }
    normalized.target = target;
  }
  return Object.freeze(normalized);
}

// Defaults: mode local, remote origin, target = the board's integration branch.
export function resolveDeliveryChannel(channel: DeliveryChannel | null | undefined, integrationBranch: string): ResolvedDeliveryChannel {
  return Object.freeze({
    mode: channel?.mode || DEFAULT_DELIVERY_CHANNEL_MODE,
    remote: channel?.remote || DEFAULT_DELIVERY_REMOTE,
    target: channel?.target || integrationBranch,
  });
}

function pullRequestUrl(value: unknown, number: number): string | null {
  if (typeof value !== 'string' || !value || value.length > PR_URL_MAX || /\s/.test(value) || CONTROL_CHARACTER_RE.test(value)) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (_) {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  return parsed.pathname.replace(/\/+$/, '').endsWith(`/pull/${number}`) ? value : null;
}

// The integration record's `pr` for one wave. The branch is always the wave's
// own branch, so a record can never point a wave at another wave's PR.
export function validateWavePullRequest(waveId: unknown, pr: unknown): WavePullRequest | Diagnostic {
  const branch = waveBranchName(waveId);
  if (typeof branch !== 'string') return branch;
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) {
    return diagnostic('invalid_wave_pr', 'A wave PR record must be an object { number, url, branch, headSha, base, openedAt }.');
  }
  const input = pr as Record<string, unknown>;
  const number = input.number;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) {
    return diagnostic('invalid_wave_pr', `Wave PR number must be a positive integer; got ${JSON.stringify(number ?? null)}.`);
  }
  const url = pullRequestUrl(input.url, number);
  if (!url) {
    return diagnostic('invalid_wave_pr', `Wave PR url must be an https pull request URL ending in /pull/${number}; got ${JSON.stringify(input.url ?? null)}.`);
  }
  if (input.branch !== branch) {
    return diagnostic('invalid_wave_pr', `Wave PR branch must be ${JSON.stringify(branch)}; got ${JSON.stringify(input.branch ?? null)}.`);
  }
  const headSha = typeof input.headSha === 'string' ? input.headSha.trim().toLowerCase() : '';
  if (!FULL_OBJECT_ID_RE.test(headSha)) {
    return diagnostic('invalid_wave_pr', `Wave PR headSha must be a full commit id; got ${JSON.stringify(input.headSha ?? null)}.`);
  }
  if (!isSafeBranchName(input.base)) {
    return diagnostic('invalid_wave_pr', `Wave PR base must be a valid Git branch name that does not start with "-"; got ${JSON.stringify(input.base ?? null)}.`);
  }
  const openedAtMs = typeof input.openedAt === 'string' ? Date.parse(input.openedAt) : NaN;
  if (!Number.isFinite(openedAtMs)) {
    return diagnostic('invalid_wave_pr', `Wave PR openedAt must be an ISO timestamp; got ${JSON.stringify(input.openedAt ?? null)}.`);
  }
  return Object.freeze({ number, url, branch, headSha, base: input.base, openedAt: new Date(openedAtMs).toISOString() });
}
