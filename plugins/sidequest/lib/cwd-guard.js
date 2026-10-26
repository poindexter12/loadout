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
var cwd_guard_exports = {};
__export(cwd_guard_exports, {
  ensureLiveCwd: () => ensureLiveCwd
});
module.exports = __toCommonJS(cwd_guard_exports);
var fs = __toESM(require("node:fs"));
var os = __toESM(require("node:os"));
function isDirectory(candidate) {
  if (!candidate) return false;
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
function errorText(error) {
  const record = error;
  if (record && typeof record.code === "string") return record.code;
  return record && typeof record.message === "string" ? record.message : String(error);
}
function ensureLiveCwd(options = {}) {
  const env = options.env || process.env;
  const log = options.log || ((line) => {
    process.stderr.write(`${line}
`);
  });
  try {
    return { ok: true, recovered: false, cwd: process.cwd() };
  } catch (error) {
    const reason = errorText(error);
    const lost = typeof env.PWD === "string" && env.PWD ? env.PWD : null;
    const homedir = options.homedir || os.homedir;
    const candidates = [env.CLAUDE_PROJECT_DIR, safeHomedir(homedir)];
    for (const candidate of candidates) {
      if (!isDirectory(candidate)) continue;
      try {
        process.chdir(candidate);
        const cwd = process.cwd();
        log(`sidequest: working directory ${lost ? `"${lost}" ` : ""}no longer exists (${reason}); continuing from "${cwd}".`);
        return { ok: true, recovered: true, cwd, lost, reason };
      } catch {
      }
    }
    log(`sidequest: working directory ${lost ? `"${lost}" ` : ""}no longer exists (${reason}) and no surviving directory could be entered. Restart Claude Code as a fresh process from a checkout that exists.`);
    return { ok: false, recovered: false, lost, reason };
  }
}
function safeHomedir(homedir) {
  try {
    return homedir();
  } catch {
    return null;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ensureLiveCwd
});
