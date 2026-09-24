"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var pr_delivery_exports = {};
__export(pr_delivery_exports, {
  AWAITING_MERGE_OUTCOME: () => AWAITING_MERGE_OUTCOME,
  DEFAULT_DELIVERY_CHANNEL_MODE: () => DEFAULT_DELIVERY_CHANNEL_MODE,
  DEFAULT_DELIVERY_REMOTE: () => DEFAULT_DELIVERY_REMOTE,
  DELIVERY_CHANNEL_MODES: () => DELIVERY_CHANNEL_MODES,
  WAVE_BRANCH_PREFIX: () => WAVE_BRANCH_PREFIX,
  isSafeBranchName: () => isSafeBranchName,
  isSafeRefComponent: () => isSafeRefComponent,
  normalizeDeliveryChannel: () => normalizeDeliveryChannel,
  resolveDeliveryChannel: () => resolveDeliveryChannel,
  validateWavePullRequest: () => validateWavePullRequest,
  waveBranchName: () => waveBranchName
});
module.exports = __toCommonJS(pr_delivery_exports);
const DELIVERY_CHANNEL_MODES = Object.freeze(["local", "pr"]);
const DEFAULT_DELIVERY_CHANNEL_MODE = "local";
const DEFAULT_DELIVERY_REMOTE = "origin";
const AWAITING_MERGE_OUTCOME = "awaiting-merge";
const WAVE_BRANCH_PREFIX = "sidequest/wave/";
const DELIVERY_CHANNEL_KEYS = /* @__PURE__ */ new Set(["mode", "remote", "target"]);
const REF_COMPONENT_MAX = 200;
const PR_URL_MAX = 2048;
const FULL_OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/;
function diagnostic(code, message) {
  return Object.freeze({ code, message, actionable: true });
}
function isSafeRefComponent(value) {
  if (typeof value !== "string" || !value || value.length > REF_COMPONENT_MAX) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) return false;
  return !value.includes("..") && !value.endsWith(".") && !value.endsWith(".lock");
}
function isSafeBranchName(value) {
  if (typeof value !== "string" || !value || value.length > REF_COMPONENT_MAX) return false;
  if (value.startsWith("-") || value === "@" || value.startsWith("/") || value.endsWith("/") || value.endsWith(".")) return false;
  if (value.includes("//") || value.includes("/.") || value.endsWith(".lock") || value.includes("..") || value.includes("@{")) return false;
  return !/[\s~^:?*\[\\]/.test(value) && !CONTROL_CHARACTER_RE.test(value);
}
function waveBranchName(waveId) {
  const id = typeof waveId === "string" ? waveId.trim() : "";
  if (!isSafeRefComponent(id)) {
    return diagnostic("invalid_wave_id", `Wave id ${JSON.stringify(waveId)} cannot name a PR branch: use letters, digits, ".", "_" or "-", starting with a letter or digit.`);
  }
  return `${WAVE_BRANCH_PREFIX}${id}`;
}
function normalizeDeliveryChannel(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return diagnostic("invalid_delivery_channel", 'deliveryChannel must be an object { mode: "local" | "pr", remote?: string, target?: string }.');
  }
  const input = value;
  const unknownKeys = Object.keys(input).filter((key) => !DELIVERY_CHANNEL_KEYS.has(key));
  if (unknownKeys.length) {
    return diagnostic("invalid_delivery_channel", `deliveryChannel does not accept ${unknownKeys.map((key) => JSON.stringify(key)).join(", ")}; allowed keys are mode, remote, and target.`);
  }
  const mode = typeof input.mode === "string" ? input.mode.trim().toLowerCase() : "";
  if (!DELIVERY_CHANNEL_MODES.includes(mode)) {
    return diagnostic("invalid_delivery_channel", `deliveryChannel.mode must be "local" or "pr"; got ${JSON.stringify(input.mode ?? null)}.`);
  }
  const normalized = { mode };
  if (input.remote != null) {
    const remote = typeof input.remote === "string" ? input.remote.trim() : "";
    if (!isSafeRefComponent(remote)) {
      return diagnostic("invalid_delivery_channel", `deliveryChannel.remote must be a Git remote name of letters, digits, ".", "_" or "-", starting with a letter or digit; got ${JSON.stringify(input.remote)}.`);
    }
    normalized.remote = remote;
  }
  if (input.target != null) {
    const target = typeof input.target === "string" ? input.target.trim() : "";
    if (!isSafeBranchName(target)) {
      return diagnostic("invalid_delivery_channel", `deliveryChannel.target must be a valid Git branch name that does not start with "-"; got ${JSON.stringify(input.target)}.`);
    }
    normalized.target = target;
  }
  return Object.freeze(normalized);
}
function resolveDeliveryChannel(channel, integrationBranch) {
  return Object.freeze({
    mode: channel?.mode || DEFAULT_DELIVERY_CHANNEL_MODE,
    remote: channel?.remote || DEFAULT_DELIVERY_REMOTE,
    target: channel?.target || integrationBranch
  });
}
function pullRequestUrl(value, number) {
  if (typeof value !== "string" || !value || value.length > PR_URL_MAX || /\s/.test(value) || CONTROL_CHARACTER_RE.test(value)) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  return parsed.pathname.replace(/\/+$/, "").endsWith(`/pull/${number}`) ? value : null;
}
function validateWavePullRequest(waveId, pr) {
  const branch = waveBranchName(waveId);
  if (typeof branch !== "string") return branch;
  if (!pr || typeof pr !== "object" || Array.isArray(pr)) {
    return diagnostic("invalid_wave_pr", "A wave PR record must be an object { number, url, branch, headSha, base, openedAt }.");
  }
  const input = pr;
  const number = input.number;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    return diagnostic("invalid_wave_pr", `Wave PR number must be a positive integer; got ${JSON.stringify(number ?? null)}.`);
  }
  const url = pullRequestUrl(input.url, number);
  if (!url) {
    return diagnostic("invalid_wave_pr", `Wave PR url must be an https pull request URL ending in /pull/${number}; got ${JSON.stringify(input.url ?? null)}.`);
  }
  if (input.branch !== branch) {
    return diagnostic("invalid_wave_pr", `Wave PR branch must be ${JSON.stringify(branch)}; got ${JSON.stringify(input.branch ?? null)}.`);
  }
  const headSha = typeof input.headSha === "string" ? input.headSha.trim().toLowerCase() : "";
  if (!FULL_OBJECT_ID_RE.test(headSha)) {
    return diagnostic("invalid_wave_pr", `Wave PR headSha must be a full commit id; got ${JSON.stringify(input.headSha ?? null)}.`);
  }
  if (!isSafeBranchName(input.base)) {
    return diagnostic("invalid_wave_pr", `Wave PR base must be a valid Git branch name that does not start with "-"; got ${JSON.stringify(input.base ?? null)}.`);
  }
  const openedAtMs = typeof input.openedAt === "string" ? Date.parse(input.openedAt) : NaN;
  if (!Number.isFinite(openedAtMs)) {
    return diagnostic("invalid_wave_pr", `Wave PR openedAt must be an ISO timestamp; got ${JSON.stringify(input.openedAt ?? null)}.`);
  }
  return Object.freeze({ number, url, branch, headSha, base: input.base, openedAt: new Date(openedAtMs).toISOString() });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AWAITING_MERGE_OUTCOME,
  DEFAULT_DELIVERY_CHANNEL_MODE,
  DEFAULT_DELIVERY_REMOTE,
  DELIVERY_CHANNEL_MODES,
  WAVE_BRANCH_PREFIX,
  isSafeBranchName,
  isSafeRefComponent,
  normalizeDeliveryChannel,
  resolveDeliveryChannel,
  validateWavePullRequest,
  waveBranchName
});
