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
var github_pr_exports = {};
__export(github_pr_exports, {
  PrDeliveryUnavailableError: () => PrDeliveryUnavailableError,
  createGhPrPort: () => createGhPrPort
});
module.exports = __toCommonJS(github_pr_exports);
const { execFileSync } = require("node:child_process");
class PrDeliveryUnavailableError extends Error {
  cause;
  constructor(cause) {
    super(`PR delivery unavailable: ${cause}`);
    this.name = "PrDeliveryUnavailableError";
    this.cause = cause;
  }
}
const FAILURE_STATES = /* @__PURE__ */ new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ERROR"]);
const PENDING_STATES = /* @__PURE__ */ new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED", "ACTION_REQUIRED"]);
function defaultExecutor(program, arguments_, options) {
  return execFileSync(program, arguments_, { ...options, windowsHide: true });
}
function errorCause(error) {
  return String(error?.message || error || "gh command failed").replace(/\s+/g, " ").trim();
}
function unavailable(exec, error) {
  const cause = exec.lastError || errorCause(error);
  if (!exec.lastError) exec.lastError = cause;
  return new PrDeliveryUnavailableError(cause);
}
function command(exec, cwd, arguments_, input) {
  try {
    const output = exec("gh", arguments_, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      ...input === void 0 ? {} : { input }
    });
    return String(output ?? "").trim();
  } catch (error) {
    throw unavailable(exec, error);
  }
}
function invalidResponse(exec, description) {
  throw unavailable(exec, `invalid gh ${description} response`);
}
function createdPr(exec, output) {
  const url = output.match(/https?:\/\/[^\s"'<>]+/)?.[0];
  const number = url && /\/pull\/(\d+)(?:[/?#]|$)/.exec(url)?.[1];
  if (!url || !number) return invalidResponse(exec, "pr create");
  return Object.freeze({ number: Number(number), url });
}
function stringValue(value) {
  return typeof value === "string" && value.trim() ? value : null;
}
function commitOid(value) {
  if (typeof value === "string") return stringValue(value);
  if (!value || typeof value !== "object") return null;
  return stringValue(value.oid);
}
function checkName(entry) {
  return stringValue(entry.name) || stringValue(entry.context) || stringValue(entry.workflowName);
}
function rollupState(entries, prState) {
  if (!entries.length) return Object.freeze({ checks: prState === "OPEN" ? "pending" : "success", failingChecks: [] });
  const failingChecks = entries.filter((entry) => [entry.conclusion, entry.state, entry.status].some((value) => FAILURE_STATES.has(String(value || "").toUpperCase()))).map(checkName).filter((name) => name !== null);
  if (failingChecks.length || entries.some((entry) => [entry.conclusion, entry.state, entry.status].some((value) => FAILURE_STATES.has(String(value || "").toUpperCase())))) {
    return Object.freeze({ checks: "failure", failingChecks: [...new Set(failingChecks)] });
  }
  if (entries.some((entry) => [entry.conclusion, entry.state, entry.status].some((value) => PENDING_STATES.has(String(value || "").toUpperCase())))) {
    return Object.freeze({ checks: "pending", failingChecks: [] });
  }
  return Object.freeze({ checks: "success", failingChecks: [] });
}
function statusFromPayload(exec, payload) {
  if (!payload || typeof payload !== "object") return invalidResponse(exec, "pr view");
  const value = payload;
  const number = Number(value.number);
  const url = stringValue(value.url);
  const headSha = stringValue(value.headRefOid);
  const state = String(value.state || "").toUpperCase();
  if (!Number.isInteger(number) || number < 1 || !url || !headSha || state !== "OPEN" && state !== "MERGED" && state !== "CLOSED") return invalidResponse(exec, "pr view");
  const rollup = Array.isArray(value.statusCheckRollup) ? value.statusCheckRollup.filter((entry) => Boolean(entry) && typeof entry === "object") : [];
  return Object.freeze({ number, url, state, headSha, mergeCommit: commitOid(value.mergeCommit), ...rollupState(rollup, state) });
}
function createGhPrPort(exec = defaultExecutor) {
  return Object.freeze({
    async createPr({ cwd, head, base, title, body }) {
      return createdPr(exec, command(exec, cwd, ["pr", "create", "--base", base, "--head", head, "--title", title, "--body-file", "-"], body));
    },
    async enableAutoMerge({ cwd, number }) {
      command(exec, cwd, ["pr", "merge", String(number), "--auto", "--merge"]);
    },
    async viewPr({ cwd, number }) {
      const output = command(exec, cwd, ["pr", "view", String(number), "--json", "number,url,state,headRefOid,mergeCommit,statusCheckRollup"]);
      try {
        return statusFromPayload(exec, JSON.parse(output));
      } catch (error) {
        if (error instanceof PrDeliveryUnavailableError) throw error;
        throw unavailable(exec, error);
      }
    }
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PrDeliveryUnavailableError,
  createGhPrPort
});
