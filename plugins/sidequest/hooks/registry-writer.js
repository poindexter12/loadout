#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
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

// src/hooks/shared/sqlite-budget.ts
var require_sqlite_budget = __commonJS({
  "src/hooks/shared/sqlite-budget.ts"() {
    "use strict";
    var import_node_path3 = __toESM(require("node:path"));
    var SQLITE_BUSY_POLICY_KEY = /* @__PURE__ */ Symbol.for("sidequest.sqlite-busy-policy");
    var HOOK_SQLITE_BUSY_TIMEOUT_MS = 1500;
    function failOpen(error) {
      const hook = import_node_path3.default.basename(process.argv[1] || "hook", ".js");
      process.stderr.write(`sidequest: ${hook} allowed this event without its board check (fail-open, board lock busy): ${error.message}
`);
      process.exit(0);
    }
    Reflect.set(globalThis, SQLITE_BUSY_POLICY_KEY, Object.freeze({
      label: "hook",
      timeoutMs: HOOK_SQLITE_BUSY_TIMEOUT_MS,
      attempts: 1,
      onExhausted: failOpen
    }));
  }
});

// src/hooks/registry-writer.ts
var registry_writer_exports = {};
__export(registry_writer_exports, {
  SCHEMA_VERSION: () => SCHEMA_VERSION,
  breadcrumb: () => breadcrumb,
  pluginVersion: () => pluginVersion,
  registryPath: () => registryPath,
  writeBreadcrumb: () => writeBreadcrumb
});
module.exports = __toCommonJS(registry_writer_exports);
var import_sqlite_budget = __toESM(require_sqlite_budget());
var import_node_crypto = __toESM(require("node:crypto"));
var import_node_fs = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path2 = __toESM(require("node:path"));

// src/hooks/shared/paths.ts
var import_node_path = __toESM(require("node:path"));
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || import_node_path.default.join(__dirname, "..");
}

// src/hooks/registry-writer.ts
var SCHEMA_VERSION = 1;
function pluginVersion(root) {
  const parsed = JSON.parse(import_node_fs.default.readFileSync(import_node_path2.default.join(root, ".claude-plugin", "plugin.json"), "utf8"));
  if (!parsed || typeof parsed !== "object" || !("version" in parsed)) throw new Error("plugin manifest has no version");
  return String(parsed.version);
}
function registryPath(home = import_node_os.default.homedir()) {
  return import_node_path2.default.join(home, ".claude", "toolshed", "registry", "sidequest.json");
}
function futureSchema(file) {
  try {
    const value = JSON.parse(import_node_fs.default.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || !("schemaVersion" in value)) return false;
    const schemaVersion = value.schemaVersion;
    return Number.isInteger(schemaVersion) && Number(schemaVersion) > SCHEMA_VERSION;
  } catch (_) {
    return false;
  }
}
function writeAtomically(file, value) {
  import_node_fs.default.mkdirSync(import_node_path2.default.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${import_node_crypto.default.randomUUID()}.tmp`;
  try {
    import_node_fs.default.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 384 });
    import_node_fs.default.renameSync(temporary, file);
  } finally {
    try {
      import_node_fs.default.unlinkSync(temporary);
    } catch (_) {
    }
  }
}
function breadcrumb(root, version) {
  return {
    schemaVersion: SCHEMA_VERSION,
    name: "sidequest",
    version,
    root,
    capabilities: ["tickets", "dashboard"]
  };
}
function writeBreadcrumb(options = {}) {
  const root = options.root || pluginRoot();
  const home = options.home || import_node_os.default.homedir();
  const version = options.version || pluginVersion(root);
  const file = registryPath(home);
  if (futureSchema(file)) return { written: false, reason: "future-schema", file };
  writeAtomically(file, breadcrumb(root, version));
  return { written: true, file };
}
if (require.main === module) {
  try {
    writeBreadcrumb();
  } catch (_) {
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SCHEMA_VERSION,
  breadcrumb,
  pluginVersion,
  registryPath,
  writeBreadcrumb
});
