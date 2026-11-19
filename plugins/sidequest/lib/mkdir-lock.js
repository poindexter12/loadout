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
var mkdir_lock_exports = {};
__export(mkdir_lock_exports, {
  MKDIR_LOCK_RETRY_MS: () => MKDIR_LOCK_RETRY_MS,
  MKDIR_LOCK_WAIT_MS: () => MKDIR_LOCK_WAIT_MS,
  acquireMkdirLock: () => acquireMkdirLock,
  releaseMkdirLock: () => releaseMkdirLock,
  sleepSync: () => sleepSync,
  withMkdirLock: () => withMkdirLock
});
module.exports = __toCommonJS(mkdir_lock_exports);
var import_node_crypto = __toESM(require("node:crypto"));
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
const MKDIR_LOCK_WAIT_MS = 500;
const MKDIR_LOCK_RETRY_MS = 5;
const waitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
function sleepSync(ms) {
  Atomics.wait(waitBuffer, 0, 0, Math.max(0, ms));
}
function lockOwnerFile(lockDirectory) {
  try {
    const owners = import_node_fs.default.readdirSync(lockDirectory).filter((name) => name.startsWith("owner-"));
    const [ownerName] = owners;
    return owners.length === 1 && ownerName ? import_node_path.default.join(lockDirectory, ownerName) : null;
  } catch (_) {
    return null;
  }
}
function lockOwnerAlive(ownerFile) {
  try {
    const owner = Number(import_node_fs.default.readFileSync(ownerFile, "utf8").trim());
    if (!Number.isInteger(owner) || owner <= 0) return true;
    try {
      process.kill(owner, 0);
      return true;
    } catch (error) {
      return error.code !== "ESRCH";
    }
  } catch (error) {
    return error.code !== "ENOENT";
  }
}
function waitForTestGate(markerVariable, gateVariable, retryMs) {
  const marker = markerVariable ? process.env[markerVariable] : void 0;
  if (marker) import_node_fs.default.writeFileSync(marker, `${process.pid}
`);
  const gate = gateVariable ? process.env[gateVariable] : void 0;
  while (gate && import_node_fs.default.existsSync(gate)) sleepSync(retryMs);
}
function removeStaleLock(lockDirectory, ownerFile) {
  try {
    import_node_fs.default.rmSync(ownerFile, { force: true });
    import_node_fs.default.rmdirSync(lockDirectory);
    return true;
  } catch (_) {
    return false;
  }
}
function acquireMkdirLock(lockDirectory, options = {}) {
  const waitMs = options.waitMs ?? MKDIR_LOCK_WAIT_MS;
  const retryMs = options.retryMs ?? MKDIR_LOCK_RETRY_MS;
  const gates = options.testGates || {};
  const generation = `${process.pid}-${import_node_crypto.default.randomUUID()}`;
  const ownerName = `owner-${generation}`;
  const candidateDirectory = `${lockDirectory}.${generation}`;
  const publishedOwnerFile = import_node_path.default.join(lockDirectory, ownerName);
  const deadline = Date.now() + waitMs;
  import_node_fs.default.mkdirSync(import_node_path.default.dirname(lockDirectory), { recursive: true });
  try {
    import_node_fs.default.mkdirSync(candidateDirectory);
    import_node_fs.default.writeFileSync(import_node_path.default.join(candidateDirectory, ownerName), `${process.pid}
`);
    while (true) {
      try {
        import_node_fs.default.renameSync(candidateDirectory, lockDirectory);
        waitForTestGate(gates.acquiredMarker, gates.holdGate, retryMs);
        return publishedOwnerFile;
      } catch (_) {
        const ownerFile = lockOwnerFile(lockDirectory);
        if (ownerFile && !lockOwnerAlive(ownerFile)) {
          waitForTestGate(gates.staleMarker, gates.staleGate, retryMs);
          removeStaleLock(lockDirectory, ownerFile);
          const cleanedMarker = gates.staleCleanedMarker ? process.env[gates.staleCleanedMarker] : void 0;
          if (cleanedMarker) import_node_fs.default.writeFileSync(cleanedMarker, `${process.pid}
`);
          continue;
        }
        if (Date.now() >= deadline) return null;
        sleepSync(retryMs);
      }
    }
  } finally {
    try {
      import_node_fs.default.rmSync(candidateDirectory, { recursive: true, force: true });
    } catch (_) {
    }
  }
}
function releaseMkdirLock(ownerFile) {
  try {
    import_node_fs.default.rmSync(ownerFile, { force: true });
    import_node_fs.default.rmdirSync(import_node_path.default.dirname(ownerFile));
  } catch (_) {
  }
}
function withMkdirLock(lockDirectory, fn, options = {}) {
  const ownerFile = acquireMkdirLock(lockDirectory, options);
  if (!ownerFile) return { acquired: false };
  try {
    return { acquired: true, value: fn() };
  } finally {
    releaseMkdirLock(ownerFile);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MKDIR_LOCK_RETRY_MS,
  MKDIR_LOCK_WAIT_MS,
  acquireMkdirLock,
  releaseMkdirLock,
  sleepSync,
  withMkdirLock
});
