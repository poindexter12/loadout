"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var agent_foreground_exports = {};
__export(agent_foreground_exports, {
  BUILTIN_FOREGROUND_AGENT_TYPES: () => BUILTIN_FOREGROUND_AGENT_TYPES,
  FOREGROUND_SETTINGS_FIELD: () => FOREGROUND_SETTINGS_FIELD,
  FOREGROUND_SETTINGS_NAMESPACE: () => FOREGROUND_SETTINGS_NAMESPACE,
  foregroundSettingsCandidates: () => foregroundSettingsCandidates,
  isForegroundAgentType: () => isForegroundAgentType,
  readForegroundAgents: () => readForegroundAgents,
  resolveForegroundAgents: () => resolveForegroundAgents
});
module.exports = __toCommonJS(agent_foreground_exports);
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var import_claude_home = require("./claude-home.js");
const BUILTIN_FOREGROUND_AGENT_TYPES = Object.freeze(["Explore", "claude-code-guide", "statusline-setup"]);
const FOREGROUND_SETTINGS_NAMESPACE = "sidequest";
const FOREGROUND_SETTINGS_FIELD = "foregroundAgents";
function readForegroundAgents(settingsPath) {
  let parsed;
  try {
    parsed = JSON.parse(import_node_fs.default.readFileSync(settingsPath, "utf8"));
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const namespace = parsed[FOREGROUND_SETTINGS_NAMESPACE];
  if (!namespace || typeof namespace !== "object" || Array.isArray(namespace)) return null;
  const list = namespace[FOREGROUND_SETTINGS_FIELD];
  if (!Array.isArray(list)) return null;
  return [...new Set(list.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))];
}
function foregroundSettingsCandidates(options = {}) {
  const candidates = [];
  const projectDir = String(options.projectDir || "").trim();
  if (projectDir) {
    candidates.push({ source: "project-local", path: import_node_path.default.join(projectDir, ".claude", "settings.local.json") });
    candidates.push({ source: "project", path: import_node_path.default.join(projectDir, ".claude", "settings.json") });
  }
  candidates.push({ source: "user", path: import_node_path.default.join((0, import_claude_home.resolveClaudeHome)(options.claudeHome), "settings.json") });
  return candidates;
}
function resolveForegroundAgents(options = {}) {
  for (const candidate of foregroundSettingsCandidates(options)) {
    const types = readForegroundAgents(candidate.path);
    if (types) return { types, source: candidate.source, path: candidate.path };
  }
  return { types: [], source: "none", path: null };
}
function isForegroundAgentType(type, resolution) {
  return BUILTIN_FOREGROUND_AGENT_TYPES.includes(type) || resolution.types.includes(type);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BUILTIN_FOREGROUND_AGENT_TYPES,
  FOREGROUND_SETTINGS_FIELD,
  FOREGROUND_SETTINGS_NAMESPACE,
  foregroundSettingsCandidates,
  isForegroundAgentType,
  readForegroundAgents,
  resolveForegroundAgents
});
