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
var landed_authority_exports = {};
__export(landed_authority_exports, {
  landedRemoteFromTarget: () => landedRemoteFromTarget,
  landedRemoteUnavailableMessage: () => landedRemoteUnavailableMessage,
  proveLandedOnRemote: () => proveLandedOnRemote
});
module.exports = __toCommonJS(landed_authority_exports);
var import_node_child_process = require("node:child_process");
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
function git(repo, args) {
  return (0, import_node_child_process.execFileSync)("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: 12e4,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
function errorDetail(error) {
  const text = String(error?.stderr || error?.message || error || "").trim();
  return text.split(/\r?\n/).filter(Boolean).slice(-1)[0] || "git exited without detail";
}
function landedRemoteFromTarget(target) {
  const localBranch = String(target?.branch || "").trim();
  let upstream = String(target?.upstream || "").trim();
  if (!upstream || target?.mode === "local") return null;
  if (upstream.startsWith("refs/remotes/")) upstream = upstream.slice("refs/remotes/".length);
  else if (upstream.startsWith("refs/")) return null;
  if (upstream === localBranch) return null;
  const slash = upstream.indexOf("/");
  if (slash <= 0 || slash === upstream.length - 1) return null;
  return { remote: upstream.slice(0, slash), branch: upstream.slice(slash + 1) };
}
function landedRemoteUnavailableMessage(ref, remote, branch, detail) {
  return `${ref} reconciliation refused: remote ${remote} could not be contacted to read the live refs/heads/${branch} tip (${detail}). Landedness is decided only by the remote's live advertisement; there is no local fallback, so refs/remotes/${remote}/${branch}, the checkout's HEAD, and local branches are never consulted. Restore network access to ${remote} and record the delivery again.`;
}
function proveLandedOnRemote(input) {
  const { repo, remote, branch } = input;
  const commit = String(input.commit || "").toLowerCase();
  const observedAt = (/* @__PURE__ */ new Date()).toISOString();
  const source = `git:${remote}/${branch}`;
  let advertisement;
  try {
    advertisement = git(repo, ["ls-remote", "--heads", "--", remote, `refs/heads/${branch}`]);
  } catch (error) {
    return { ok: false, reason: "landed_remote_unavailable", remote, branch, detail: errorDetail(error) };
  }
  const line = advertisement.split(/\r?\n/).find((entry) => entry.split(/\s+/)[1] === `refs/heads/${branch}`);
  const tip = line ? String(line.split(/\s+/)[0] || "").toLowerCase() : null;
  if (!tip || !SHA_RE.test(tip)) return { ok: true, landed: false, remote, branch, tip: null, source, observedAt };
  if (tip === commit) return { ok: true, landed: true, remote, branch, tip, source, observedAt };
  try {
    git(repo, ["cat-file", "-e", `${tip}^{commit}`]);
  } catch (_) {
    try {
      const url = git(repo, ["remote", "get-url", "--", remote]);
      git(repo, ["fetch", "--no-write-fetch-head", "--no-tags", "--quiet", "--", url, tip]);
    } catch (error) {
      return { ok: false, reason: "landed_remote_unavailable", remote, branch, detail: `advertised tip ${tip} could not be fetched: ${errorDetail(error)}` };
    }
  }
  try {
    git(repo, ["merge-base", "--is-ancestor", commit, tip]);
    return { ok: true, landed: true, remote, branch, tip, source, observedAt };
  } catch (error) {
    if (error?.status === 1) return { ok: true, landed: false, remote, branch, tip, source, observedAt };
    return { ok: false, reason: "landed_remote_unavailable", remote, branch, detail: errorDetail(error) };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  landedRemoteFromTarget,
  landedRemoteUnavailableMessage,
  proveLandedOnRemote
});
