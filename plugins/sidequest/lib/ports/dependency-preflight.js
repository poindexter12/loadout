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
var dependency_preflight_exports = {};
__export(dependency_preflight_exports, {
  commandProvisionsDependencies: () => commandProvisionsDependencies,
  dependenciesNotInstalledEvidence: () => dependenciesNotInstalledEvidence,
  packagesMissingDependencies: () => packagesMissingDependencies
});
module.exports = __toCommonJS(dependency_preflight_exports);
const fs = require("node:fs");
const path = require("node:path");
const SCRIPT_SUBCOMMANDS = Object.freeze({
  npm: /* @__PURE__ */ new Set(["run", "run-script", "rum", "urn", "test", "tst", "t", "start", "stop", "restart", "exec", "x"]),
  pnpm: /* @__PURE__ */ new Set(["run", "test", "t", "start", "exec"]),
  yarn: /* @__PURE__ */ new Set(["run", "test", "start", "exec"])
});
const INSTALL_SUBCOMMANDS = Object.freeze({
  npm: /* @__PURE__ */ new Set(["ci", "clean-install", "install-clean", "isntall", "install", "i", "in", "ins", "inst", "insta", "instal", "add", "install-test", "it", "install-ci-test", "cit"]),
  pnpm: /* @__PURE__ */ new Set(["install", "i", "add"]),
  yarn: /* @__PURE__ */ new Set(["install", "add"])
});
const DIRECTORY_OPTIONS = Object.freeze({
  npm: /* @__PURE__ */ new Set(["--prefix", "-C"]),
  pnpm: /* @__PURE__ */ new Set(["--dir", "-C"]),
  yarn: /* @__PURE__ */ new Set(["--cwd"])
});
function segments(command) {
  const result = [];
  let current = [];
  let word = "";
  let inWord = false;
  let literal = true;
  let quote = null;
  const endWord = () => {
    if (inWord) current.push(Object.freeze({ value: word, literal }));
    word = "";
    inWord = false;
    literal = true;
  };
  const endSegment = () => {
    endWord();
    if (current.length) result.push(current);
    current = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command.charAt(index);
    if (quote) {
      if (character === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && (character === "$" || character === "`")) literal = false;
      word += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      inWord = true;
      continue;
    }
    if (character === "\\" && index + 1 < command.length) {
      word += command.charAt(index + 1);
      inWord = true;
      index += 1;
      continue;
    }
    if (character === "&" || character === "|" || character === ";" || character === "\n" || character === "(" || character === ")") {
      endSegment();
      continue;
    }
    if (/\s/.test(character)) {
      endWord();
      continue;
    }
    if ("$`*?[~<>{}".includes(character)) literal = false;
    word += character;
    inWord = true;
  }
  endSegment();
  return result;
}
function managerOf(token) {
  if (!token?.literal) return null;
  const name = path.basename(token.value);
  return name === "npm" || name === "pnpm" || name === "yarn" ? name : null;
}
function invocation(words) {
  let start = 0;
  for (let assignment = words[start]; assignment?.literal && /^[A-Za-z_][A-Za-z0-9_]*=/.test(assignment.value); assignment = words[start]) start += 1;
  const manager = managerOf(words[start]);
  if (!manager) return null;
  let subcommand = null;
  let directory = null;
  for (let index = start + 1; index < words.length; index += 1) {
    const word = words[index];
    if (!word) continue;
    const equals = word.value.indexOf("=");
    const optionName = equals > 0 ? word.value.slice(0, equals) : word.value;
    if (DIRECTORY_OPTIONS[manager].has(optionName)) {
      const valueToken = equals > 0 ? word : words[index + 1];
      const value = equals > 0 ? word.value.slice(equals + 1) : valueToken?.value;
      directory = valueToken?.literal && value ? value : void 0;
      if (equals <= 0) index += 1;
      continue;
    }
    if (word.value.startsWith("-")) continue;
    if (subcommand === null) subcommand = word.value;
  }
  return Object.freeze({ manager, subcommand, directory });
}
function installs(call) {
  if (call.manager === "yarn" && call.subcommand === null) return true;
  return call.subcommand !== null && INSTALL_SUBCOMMANDS[call.manager].has(call.subcommand);
}
function runsScripts(call) {
  return call.subcommand !== null && SCRIPT_SUBCOMMANDS[call.manager].has(call.subcommand);
}
function commandProvisionsDependencies(command) {
  return segments(String(command || "")).some((words) => {
    const call = invocation(words);
    return call ? installs(call) : false;
  });
}
function readManifest(directory) {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  } catch {
    return null;
  }
}
function nearestPackageDirectory(start) {
  let directory = start;
  for (; ; ) {
    if (fs.existsSync(path.join(directory, "package.json"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
function declaresDependencies(manifest) {
  return ["dependencies", "devDependencies", "optionalDependencies"].some((field) => manifest && typeof manifest[field] === "object" && manifest[field] && Object.keys(manifest[field]).length > 0);
}
function installedAt(directory) {
  if (fs.existsSync(path.join(directory, ".pnp.cjs")) || fs.existsSync(path.join(directory, ".pnp.js"))) return true;
  try {
    return fs.readdirSync(path.join(directory, "node_modules")).length > 0;
  } catch {
    return false;
  }
}
function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}
function dependenciesInstalled(packageDirectory, root) {
  if (!isInside(root, packageDirectory)) return installedAt(packageDirectory);
  let directory = packageDirectory;
  for (; ; ) {
    if (installedAt(directory)) return true;
    if (directory === root) return false;
    directory = path.dirname(directory);
  }
}
function installCommand(manager, packageDirectory, relativeDirectory) {
  const target = relativeDirectory === "." ? "" : relativeDirectory;
  const quoted = /[\s"'$`\\]/.test(target) ? JSON.stringify(target) : target;
  if (manager === "pnpm") return `pnpm${target ? ` --dir ${quoted}` : ""} install --frozen-lockfile`;
  if (manager === "yarn") return `yarn${target ? ` --cwd ${quoted}` : ""} install --frozen-lockfile`;
  const locked = fs.existsSync(path.join(packageDirectory, "package-lock.json")) || fs.existsSync(path.join(packageDirectory, "npm-shrinkwrap.json"));
  return `npm${target ? ` --prefix ${quoted}` : ""} ${locked ? "ci" : "install"}`;
}
function packagesMissingDependencies(command, cwd) {
  const text = String(command || "");
  if (!text.trim() || commandProvisionsDependencies(text)) return [];
  const root = path.resolve(cwd);
  let directory = root;
  const missing = /* @__PURE__ */ new Map();
  for (const words of segments(text)) {
    if (words[0]?.literal && words[0].value === "cd") {
      const target = words[1];
      directory = directory && target?.literal && target.value && target.value !== "-" ? path.resolve(directory, target.value) : null;
      continue;
    }
    const call = invocation(words);
    if (!call || !runsScripts(call) || call.directory === void 0) continue;
    const base = call.directory === null ? directory : directory && path.resolve(directory, call.directory);
    if (!base) continue;
    const packageDirectory = call.directory === null ? nearestPackageDirectory(base) : base;
    if (!packageDirectory || missing.has(packageDirectory)) continue;
    const manifest = readManifest(packageDirectory);
    if (!declaresDependencies(manifest) || dependenciesInstalled(packageDirectory, root)) continue;
    const relativeDirectory = path.relative(root, packageDirectory).split(path.sep).join("/") || ".";
    missing.set(packageDirectory, Object.freeze({
      directory: packageDirectory,
      relativeDirectory,
      manager: call.manager,
      installCommand: installCommand(call.manager, packageDirectory, relativeDirectory)
    }));
  }
  return [...missing.values()];
}
function dependenciesNotInstalledEvidence(command, missing) {
  const packages = missing.map((entry) => entry.relativeDirectory).join(", ");
  const installs2 = missing.map((entry) => entry.installCommand).join(" && ");
  return `Dependencies are not installed: ${packages} declares dependencies but has no node_modules, so ${JSON.stringify(command)} was not run and no candidate was judged. Sidequest creates worktrees without node_modules unless the board configures worktreeSetup or worktreeDependencyPaths (board_config). Install them in this worktree with \`${installs2}\` (node_modules is gitignored, so the tree stays clean), then rerun this verification.`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  commandProvisionsDependencies,
  dependenciesNotInstalledEvidence,
  packagesMissingDependencies
});
