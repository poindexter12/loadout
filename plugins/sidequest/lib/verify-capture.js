"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { defaultVerificationTimeoutMilliseconds, runProcessVerification, shellCommand } = require("./ports/process.js");
const captureSlotTimeoutMilliseconds = 30 * 60 * 1e3;
const captureSlotRetryMilliseconds = 50;
const captureSlotOperationRetryLimit = 20;
const captureSlotContentionErrorCodes = /* @__PURE__ */ new Set(["EEXIST", "EPERM", "EBUSY", "ENOTEMPTY"]);
const minimumTestConcurrency = 2;
const maximumTestConcurrency = 8;
const baselineTestPhaseDurationMilliseconds = 48e4;
const testPhaseBudgetSafetyFactor = 1.5;
const maximumTestPhaseTimeoutMilliseconds = 24e5;
const minimumEffectiveTestWorkers = 0.5;
const phaseBudgetOverrideVariable = "SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS";
function fullSuiteCaptureTimeoutMilliseconds(availableParallelism = os.availableParallelism(), loadAverage = os.loadavg()[0] || 0, rawOverride = process.env[phaseBudgetOverrideVariable]) {
  const testConcurrency = Math.min(maximumTestConcurrency, Math.max(minimumTestConcurrency, availableParallelism));
  const otherRunnableThreads = typeof loadAverage === "number" && Number.isFinite(loadAverage) && loadAverage > 0 ? loadAverage : 0;
  const effectiveTestWorkers = Math.min(
    testConcurrency,
    Math.max(minimumEffectiveTestWorkers, availableParallelism * testConcurrency / (testConcurrency + otherRunnableThreads))
  );
  const measuredPhaseTimeoutMilliseconds = Math.min(
    maximumTestPhaseTimeoutMilliseconds,
    Math.round(baselineTestPhaseDurationMilliseconds * maximumTestConcurrency / effectiveTestWorkers * testPhaseBudgetSafetyFactor)
  );
  const requested = typeof rawOverride === "string" && /^\d+$/.test(rawOverride.trim()) ? Number(rawOverride.trim()) : 0;
  const phaseTimeoutMilliseconds = requested > measuredPhaseTimeoutMilliseconds ? requested : measuredPhaseTimeoutMilliseconds;
  return defaultVerificationTimeoutMilliseconds + phaseTimeoutMilliseconds;
}
function captureRequirement(command) {
  return Object.freeze({ kind: "command", command, evidenceContract: "command output" });
}
async function runVerifyCapture(command, cwd = process.cwd(), timeoutMilliseconds, environment) {
  const result = runProcessVerification(captureRequirement(command), {
    cwd,
    ...timeoutMilliseconds === void 0 ? {} : { timeoutMilliseconds },
    ...environment === void 0 ? {} : { environment }
  });
  return Object.freeze({
    ...result,
    exitCode: result.exitCode ?? null,
    ...result.status === "passed" ? {} : { reason: result.evidence }
  });
}
function isFullSuiteCommand(command) {
  return /(?:^|[\s&;()])npm\s+run\s+test:full(?:\s|$)/.test(command);
}
function captureSlotDirectory(project) {
  const projectKey = path.resolve(project).toLocaleLowerCase();
  const projectHash = createHash("sha256").update(projectKey).digest("hex");
  return path.join(os.tmpdir(), "sidequest-verify-capture-slots", projectHash);
}
function captureSlotWaiterPath(slotDirectory, fileSystem = fs) {
  const waitingDirectory = path.join(slotDirectory, "waiting");
  fileSystem.mkdirSync(waitingDirectory, { recursive: true });
  return path.join(waitingDirectory, `${Date.now().toString().padStart(15, "0")}-${process.pid}-${randomUUID()}.json`);
}
function queuedWaiters(slotDirectory, fileSystem = fs) {
  try {
    return fileSystem.readdirSync(path.join(slotDirectory, "waiting")).sort();
  } catch {
    return [];
  }
}
function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function captureSlotErrorCode(error) {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : String(error);
}
function captureSlotOperationFailure(operation, slotPath, attempts, error) {
  const errorCode = captureSlotErrorCode(error);
  return Object.freeze({
    reason: `Verification capture could not ${operation} slot path ${JSON.stringify(slotPath)} after ${attempts} retries; last errno ${errorCode}.`,
    errorCode
  });
}
async function retryCaptureSlotOperation(operation, slotPath, execute) {
  for (let attempts = 1; attempts <= captureSlotOperationRetryLimit; attempts += 1) {
    try {
      execute();
      return null;
    } catch (error) {
      const errorCode = captureSlotErrorCode(error);
      if (!captureSlotContentionErrorCodes.has(errorCode) || attempts === captureSlotOperationRetryLimit) {
        return captureSlotOperationFailure(operation, slotPath, attempts, error);
      }
      await wait(captureSlotRetryMilliseconds);
    }
  }
  throw new Error("Capture slot operation retry loop completed unexpectedly.");
}
async function releaseCaptureSlot(activeDirectory, fileSystem) {
  const tombstoneDirectory = `${activeDirectory}.released-${process.pid}-${randomUUID()}`;
  const renameFailure = await retryCaptureSlotOperation("rename", activeDirectory, () => fileSystem.renameSync(activeDirectory, tombstoneDirectory));
  if (renameFailure) {
    if (renameFailure.errorCode === "ENOENT") return null;
    return renameFailure;
  }
  return retryCaptureSlotOperation("remove", tombstoneDirectory, () => fileSystem.rmSync(tombstoneDirectory, { recursive: true, force: true }));
}
async function acquireCaptureSlot(project, timeoutMilliseconds = captureSlotTimeoutMilliseconds, fileSystem = fs) {
  const slotDirectory = captureSlotDirectory(project);
  const activeDirectory = path.join(slotDirectory, "active");
  const startedAt = Date.now();
  const waiterPath = captureSlotWaiterPath(slotDirectory, fileSystem);
  const waiterName = path.basename(waiterPath);
  fileSystem.writeFileSync(waiterPath, "", { encoding: "utf8", flag: "wx" });
  let waitingAnnounced = false;
  let queuePosition = 1;
  let acquireContentionAttempts = 0;
  for (; ; ) {
    const waiterIndex = queuedWaiters(slotDirectory, fileSystem).indexOf(waiterName);
    const active = fileSystem.existsSync(activeDirectory);
    queuePosition = Math.max(queuePosition, waiterIndex + (active ? 2 : 1));
    if (!active && waiterIndex === 0) {
      let acquired = false;
      try {
        fileSystem.mkdirSync(activeDirectory);
        acquired = true;
      } catch (error) {
        const errorCode = captureSlotErrorCode(error);
        if (!captureSlotContentionErrorCodes.has(errorCode)) {
          fileSystem.rmSync(waiterPath, { force: true });
          return captureSlotOperationFailure("create", activeDirectory, 1, error);
        }
        acquireContentionAttempts += 1;
        if (acquireContentionAttempts === captureSlotOperationRetryLimit) {
          fileSystem.rmSync(waiterPath, { force: true });
          return captureSlotOperationFailure("create", activeDirectory, acquireContentionAttempts, error);
        }
      }
      if (acquired) {
        fileSystem.rmSync(waiterPath, { force: true });
        return Object.freeze({
          waitedForSlotMs: Date.now() - startedAt,
          queuePosition,
          release: () => releaseCaptureSlot(activeDirectory, fileSystem)
        });
      }
    }
    if (!waitingAnnounced) {
      const siblingCount = queuePosition - 1;
      process.stdout.write(`verify-capture: waiting for ${siblingCount} sibling capture${siblingCount === 1 ? "" : "s"} to finish (queue position ${queuePosition}).
`);
      waitingAnnounced = true;
    }
    const waitedForSlotMs = Date.now() - startedAt;
    if (waitedForSlotMs >= timeoutMilliseconds) {
      fileSystem.rmSync(waiterPath, { force: true });
      return Object.freeze({
        waitedForSlotMs,
        queuePosition,
        reason: `Verification capture waited ${waitedForSlotMs}ms for the per-host full-suite slot at queue position ${queuePosition}; sibling capture contention exceeded the ${timeoutMilliseconds}ms limit.`
      });
    }
    await wait(captureSlotRetryMilliseconds);
  }
}
function captureSlotTimeout(command, slot) {
  return Object.freeze({
    kind: "command",
    status: "timeout",
    evidence: slot.reason,
    command,
    logPath: null,
    exitCode: 2,
    outputTail: null,
    failureIdentities: Object.freeze(["timeout:capture-slot-contention"]),
    reason: slot.reason,
    waitedForSlotMs: slot.waitedForSlotMs,
    queuePosition: slot.queuePosition
  });
}
function captureSlotCouldNotRun(command, slot) {
  return Object.freeze({
    kind: "command",
    status: "could_not_run",
    evidence: slot.reason,
    command,
    logPath: null,
    exitCode: 2,
    outputTail: null,
    failureIdentities: Object.freeze(["could_not_run:capture-slot"]),
    reason: slot.reason
  });
}
async function runFullSuiteCapture(command, project, cwd, fileSystem = fs) {
  let slot;
  try {
    slot = await acquireCaptureSlot(project, captureSlotTimeoutMilliseconds, fileSystem);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return captureSlotCouldNotRun(command, Object.freeze({
      reason: `Verification capture could not acquire its per-host full-suite slot: ${reason}`,
      errorCode: captureSlotErrorCode(error)
    }));
  }
  if ("reason" in slot) {
    return "waitedForSlotMs" in slot ? captureSlotTimeout(command, slot) : captureSlotCouldNotRun(command, slot);
  }
  let capture;
  let releaseFailure = null;
  try {
    capture = await runVerifyCapture(command, cwd, fullSuiteCaptureTimeoutMilliseconds(), {
      ...process.env,
      SIDEQUEST_FULL_SUITE_SIBLING_CAPTURE_COUNT: String(slot.queuePosition - 1)
    });
  } finally {
    releaseFailure = await slot.release();
  }
  if (releaseFailure) return captureSlotCouldNotRun(command, releaseFailure);
  return Object.freeze({
    ...capture,
    waitedForSlotMs: slot.waitedForSlotMs,
    queuePosition: slot.queuePosition
  });
}
function captureTarget(args) {
  const projectIndex = args.indexOf("--project");
  const ticketIndex = args.indexOf("--ticket");
  const project = projectIndex >= 0 ? String(args[projectIndex + 1] || "").trim() : "";
  const ticket = ticketIndex >= 0 ? String(args[ticketIndex + 1] || "").trim() : "";
  return project && ticket ? Object.freeze({ project, ticket }) : null;
}
function resolveCaptureProject(target) {
  const store = require("./store.js");
  const requested = String(target.project || "").trim();
  const candidates = [requested];
  let repositoryRoot = "";
  try {
    repositoryRoot = String(store.nearestRepoRoot(requested) || "").trim();
  } catch (_) {
    repositoryRoot = "";
  }
  if (repositoryRoot && repositoryRoot !== requested) candidates.push(repositoryRoot);
  const attempts = [];
  for (const candidate of candidates) {
    const found = store.findProject(candidate);
    if (found.ok && found.slug) {
      return Object.freeze({
        ok: true,
        project: Object.freeze({ slug: found.slug, path: String(found.meta?.path || "").trim() || path.resolve(candidate) })
      });
    }
    attempts.push(`${JSON.stringify(candidate)} (${found.reason || "not_found"})`);
  }
  return Object.freeze({
    ok: false,
    reason: `project_not_found: no registered board matched the --project argument for ${target.ticket}. Tried ${attempts.join(", then its repository root ")}. Verification capture resolves the board from the dispatched ticket's registered project path, not from the working directory, so a stale worktree path here means the dispatch named an unregistered project.`
  });
}
function captureProject(target) {
  const resolution = resolveCaptureProject(target);
  return resolution.ok ? resolution.project : null;
}
function captureWorkingDirectory(target, cwd, project) {
  if (!project) return cwd;
  const store = require("./store.js");
  const ticket = store.getTicket(project.slug, target.ticket);
  return store.workingTreeDeliveryCandidate(project.slug, ticket) ? project.path : cwd;
}
function pinnedCaptureCommand(target, project) {
  if (!project) return null;
  try {
    const store = require("./store.js");
    const ticket = store.getTicket(project.slug, target.ticket);
    const requirement = ticket?.dispatch?.verificationRequirement || ticket?.dispatch?.lifecycleAttempt?.verificationRequirement || ticket?.lifecycleAttempt?.verificationRequirement;
    const command = typeof requirement?.command === "string" ? requirement.command.trim() : "";
    return command ? Object.freeze({ ticket, command }) : null;
  } catch (_) {
    return null;
  }
}
function preflightCapture(command, target, project) {
  const pinned = pinnedCaptureCommand(target, project);
  if (!pinned || command.trim() === pinned.command) return null;
  const store = require("./store.js");
  const reason = store.captureCommandMismatchMessage(pinned.ticket, pinned.command, command);
  return Object.freeze({
    kind: "command",
    status: "failed_check",
    evidence: reason,
    command,
    logPath: null,
    exitCode: 2,
    outputTail: null,
    failureIdentities: Object.freeze(["failed_check:verification-capture-command-mismatch"]),
    reason
  });
}
async function runCapturedVerification(command, target, cwd = process.cwd(), fileSystem = fs) {
  const resolution = target ? resolveCaptureProject(target) : null;
  const project = resolution?.ok ? resolution.project : null;
  const preflight = target ? preflightCapture(command, target, project) : null;
  const captureCwd = target && !preflight ? captureWorkingDirectory(target, cwd, project) : cwd;
  const capture = preflight || (target && isFullSuiteCommand(command) ? await runFullSuiteCapture(command, project?.path || target.project, captureCwd, fileSystem) : await runVerifyCapture(command, captureCwd));
  const recorded = target ? recordCapture(target, capture, captureCwd, resolution) : null;
  return Object.freeze({ capture, recorded });
}
function verifiedRevision(cwd) {
  try {
    const value = String(execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      // git's own "fatal: not a git repository" on a dead worktree used to land
      // on the wrapper's stderr, competing with the reason the caller is given.
      stdio: ["ignore", "pipe", "ignore"]
    })).trim().toLowerCase();
    return value ? Object.freeze({ source: "git", value }) : null;
  } catch (_) {
    return null;
  }
}
function recordCapture(target, capture, cwd, resolved) {
  const store = require("./store.js");
  const resolution = resolved || resolveCaptureProject(target);
  if (!resolution.ok) return { ok: false, reason: resolution.reason };
  const project = resolution.project;
  const ticket = store.getTicket(project.slug, target.ticket);
  const workingTreeCandidate = store.workingTreeDeliveryCandidate(project.slug, ticket);
  const candidate = workingTreeCandidate?.candidate || verifiedRevision(cwd);
  if (!candidate) {
    return {
      ok: false,
      reason: `verified_revision_unavailable: git resolved no HEAD commit in the verified checkout ${JSON.stringify(path.resolve(cwd))} for ${target.ticket} on board ${JSON.stringify(project.slug)}. That checkout is not a live Git worktree, which is what a retired agent's leftover worktree looks like once its registration is pruned; rerun the verify wrapper from the worktree this dispatch owns.`
    };
  }
  return store.recordVerificationCapture(project.slug, target.ticket, {
    command: capture.command || "",
    status: capture.status,
    candidate,
    completedAt: (/* @__PURE__ */ new Date()).toISOString(),
    worktree: cwd,
    logPath: capture.logPath,
    exitCode: capture.exitCode,
    shell: capture.shell,
    ...capture.waitedForSlotMs === void 0 ? {} : { waitedForSlotMs: capture.waitedForSlotMs },
    ...capture.queuePosition === void 0 ? {} : { queuePosition: capture.queuePosition }
  });
}
function report(capture, recorded) {
  const reason = capture.reason ? ` reason=${JSON.stringify(capture.reason)}` : "";
  process.stdout.write(`verify=${capture.status} exit=${capture.exitCode ?? 2}${reason}
`);
  process.stdout.write(`shell=${capture.shell || ""}
`);
  process.stdout.write(`details=${capture.logPath || ""}
`);
  if (capture.waitedForSlotMs !== void 0) {
    process.stdout.write(`capture-slot waitedForSlotMs=${capture.waitedForSlotMs} queuePosition=${capture.queuePosition || 1}
`);
  }
  if (recorded?.ok && recorded.capture) {
    process.stdout.write(`capture=${recorded.capture.id} candidate=${recorded.capture.candidate.source}:${recorded.capture.candidate.value}
`);
  } else if (recorded) {
    process.stdout.write(`capture=unrecorded reason=${recorded.reason || "unknown"}
`);
  }
}
async function main() {
  const args = process.argv.slice(2);
  const encoded = args[0] === "--base64" ? args[1] : "";
  const command = encoded ? Buffer.from(encoded, "base64").toString("utf8").trim() : "";
  if (!command) {
    process.stderr.write("Usage: node verify-capture.js --base64 <base64 verify command> [--project <path> --ticket <ref>]\n");
    process.exitCode = 2;
    return;
  }
  const target = captureTarget(args);
  const { capture, recorded } = await runCapturedVerification(command, target);
  report(capture, recorded);
  process.exitCode = capture.exitCode === 0 && (!target || recorded?.ok) ? 0 : 2;
}
module.exports = { runVerifyCapture, runCapturedVerification, shellCommand, captureTarget, captureProject, resolveCaptureProject, captureSlotDirectory, isFullSuiteCommand, fullSuiteCaptureTimeoutMilliseconds, recordCapture, verifiedRevision };
if (require.main === module) void main();
