"use strict";
const { defaultHostSleep } = require("../host-sleep.js");
const questionLog = require("./question-log.js");
const PARK_STATUS = "awaiting-user";
const PARK_MODES = ["held", "released"];
const PARK_PREVIEW_CHARS = 120;
function parkRefKey(ref) {
  return String(ref || "").trim().toUpperCase();
}
function parkQuestionStates(slug, ref, opts) {
  const key = parkRefKey(ref);
  if (!slug || !key) return [];
  try {
    const fold = questionLog.readQuestionLog(questionLog.questionLogDir(String(slug)));
    const pool = opts?.includeRecent ? { ...fold.recent || {}, ...fold.open || {} } : fold.open || {};
    return Object.values(pool).filter((state) => state && parkRefKey(state.ref) === key).sort((left, right) => String(left.asked?.at).localeCompare(String(right.asked?.at)) || String(left.qid).localeCompare(String(right.qid)));
  } catch (_error) {
    return [];
  }
}
function openBlockingQuestions(states) {
  return (Array.isArray(states) ? states : []).filter((state) => state && state.state === "open" && state.asked?.blocking !== false);
}
function heldParkQuestions(states, claim) {
  const claimedMs = Date.parse(claim && claim.at);
  return openBlockingQuestions(states).filter((state) => {
    if (state.asked?.origin === "filing") return false;
    if (!Array.isArray(state.sent) || !state.sent.length) return false;
    const askedMs = Date.parse(state.asked?.at);
    return !Number.isFinite(claimedMs) || !Number.isFinite(askedMs) || askedMs >= claimedMs;
  });
}
function parkFirstLine(text, max = PARK_PREVIEW_CHARS) {
  const line = String(text || "").split(/\r?\n/).map((part) => part.trim()).find(Boolean) || "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
function parkQuestionLine(state) {
  const header = state?.asked?.header ? `[${state.asked.header}] ` : "";
  return `- ${state?.seq || "?"} \`${state?.qid}\`: ${header}${parkFirstLine(state?.asked?.text)}`;
}
function parkCommentBody(ref, mode, states, detail) {
  const lines = (Array.isArray(states) ? states : []).map(parkQuestionLine);
  const stage = mode === "held" ? "Parked **awaiting-user** (held): the claim and worktree stay with the executor, and the answer resumes it." : "Parked **awaiting-user** (released): the claim is given up, and answering makes the ticket dispatchable with the decisions packet.";
  const why = String(detail || "").trim();
  return [`⏸️ ${stage}${why ? ` ${why}` : ""}`, ...lines.length ? ["Open questions:", ...lines] : []].join("\n");
}
function unparkCommentBody(ref, toStatus, states, detail) {
  const lines = (Array.isArray(states) ? states : []).map((state) => {
    const answer = state?.answered;
    const outcome = state?.state === "declined" || answer?.declined ? "declined" : answer ? `answered \`${answer.aid}\`${answer.preview || answer.text ? `: ${parkFirstLine(answer.preview || answer.text)}` : ""}` : state?.state || "closed";
    return `- ${state?.seq || "?"} \`${state?.qid}\`: ${outcome}`;
  });
  const why = String(detail || "").trim();
  const head = toStatus === "doing" ? `▶️ Unparked to **doing**: the held executor resumes in its own worktree.${why ? ` ${why}` : ""}` : `▶️ Unparked to **todo**: the next dispatch carries the decisions packet.${why ? ` ${why}` : ""}`;
  return [head, ...lines].join("\n");
}
function createClaims(dependencies) {
  const {
    hostSleep: injectedHostSleep,
    completionTreeCheck,
    dispatchDelta,
    dispatchState,
    isolatedDispatchWorktreeMissing,
    getTicket,
    putTicket,
    withTicketLock,
    resumeHeldPark
  } = dependencies;
  const DEFAULT_CLAIM_IDLE_MIN = 60;
  const DEFAULT_CLAIM_ABANDON_MIN = 24 * 60;
  const DEFAULT_PREPARED_DISPATCH_TTL_HOURS = 6;
  const VERIFY_START_COMMENT = "[sidequest:verify-start] ";
  const VERIFY_COMPLETE_COMMENT = "[sidequest:verify-complete]";
  const VERIFY_COMPLETE_STATUSES = /* @__PURE__ */ new Set(["passed", "failed_suite", "toolchain_missing", "could_not_run", "timeout", "manual", "attestation", "skipped", "failed_check"]);
  const VERIFY_COMPLETE_STATUS_ALIASES = /* @__PURE__ */ new Map([
    ["failed", "failed_suite"],
    ["failed-suite", "failed_suite"],
    ["toolchain-missing", "toolchain_missing"],
    ["could-not-run", "could_not_run"],
    ["failed-check", "failed_check"]
  ]);
  const NEGATIVE_CONTROL_COMMENT = "[sidequest:negative-control] ";
  const RELEASE_KINDS = /* @__PURE__ */ new Set(["handback", "oracle", "question"]);
  function technicalBlockerRelease(args) {
    const reason = String(args?.reason || "").trim();
    const oracle = String(args?.oracle || "").trim();
    const releaseKind = String(args?.releaseKind || "").trim();
    const command = String(args?.command || "").trim();
    const outputTail = String(args?.outputTail || "").trim();
    const exitCode = typeof args?.exitCode === "number" ? args.exitCode : typeof args?.exitCode === "string" && /^-?\d+$/.test(args.exitCode.trim()) ? Number(args.exitCode) : Number.NaN;
    if (releaseKind === "technical_blocker") {
      if (!reason || !command || !Number.isInteger(exitCode) || exitCode === 0 || !outputTail) {
        return {
          ok: false,
          reason: "technical_blocker_evidence_required",
          message: "release: technical_blocker requires a non-empty reason and command, a non-zero integer exitCode, and a non-empty outputTail. Capture the failed command result, then release again with all four fields."
        };
      }
      return { ok: true, releaseKind, evidence: { kind: releaseKind, command, exitCode, outputTail } };
    }
    if (releaseKind === "contradiction") {
      if (!reason || !command || !outputTail || args?.exitCode != null && !Number.isInteger(exitCode)) {
        return {
          ok: false,
          reason: "contradiction_evidence_required",
          message: "release: contradiction requires a non-empty reason and command, a non-empty outputTail, and an integer exitCode when supplied. Capture the verbatim probe and its output, then release again with all required fields."
        };
      }
      return { ok: true, releaseKind, evidence: { kind: releaseKind, command, ...Number.isInteger(exitCode) ? { exitCode } : {}, outputTail } };
    }
    if (!reason && !oracle && !releaseKind) return { ok: true, releaseKind: null, evidence: null };
    if (!releaseKind && oracle) return { ok: true, releaseKind: null, evidence: null };
    if (releaseKind === "oracle") {
      if (!oracle) {
        return {
          ok: false,
          reason: "oracle_ask_required",
          message: "release: oracle requires a non-empty oracle ask that states what the human must judge. Park the ticket and exit instead of holding its claim for a verdict."
        };
      }
      return { ok: true, releaseKind, evidence: null };
    }
    if (RELEASE_KINDS.has(releaseKind)) return { ok: true, releaseKind, evidence: null };
    return {
      ok: false,
      reason: "release_kind_required",
      message: 'release: choose kind "technical_blocker" for a failed command, "contradiction" for an absent target with probe evidence, "oracle" to park for a human verdict, "question" to park awaiting-user on an open blocking question you asked, or "handback" for another non-technical release. Technical blockers need command, exitCode, and outputTail; contradictions need command and outputTail.'
    };
  }
  function releaseCommentBody(reason, evidence) {
    const releaseReason = String(reason || "").trim();
    if (!evidence) return `Released: ${releaseReason}`;
    const exitCode = evidence.exitCode == null ? "" : `
Exit code: ${evidence.exitCode}`;
    const evidenceLabel = evidence.kind === "contradiction" ? "Contradiction evidence" : "Technical blocker evidence";
    return `Released: ${releaseReason}
${evidenceLabel}:
Command: ${evidence.command}${exitCode}
Output tail:
${evidence.outputTail}`;
  }
  function preparedDispatchTtlMs() {
    const hours = Number(process.env.SIDEQUEST_PREPARED_DISPATCH_TTL_HOURS);
    return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_PREPARED_DISPATCH_TTL_HOURS) * 60 * 60 * 1e3;
  }
  function envMinutesMs(fallbackMinutes, ...names) {
    for (const name of names) {
      const raw = process.env[name];
      if (raw == null || String(raw).trim() === "") continue;
      const minutes = Number(raw);
      if (Number.isFinite(minutes) && minutes > 0) return minutes * 60 * 1e3;
    }
    return fallbackMinutes * 60 * 1e3;
  }
  function claimIdleMs() {
    return envMinutesMs(DEFAULT_CLAIM_IDLE_MIN, "SIDEQUEST_CLAIM_IDLE_MIN", "SIDEQUEST_CLAIM_TTL_MIN");
  }
  function claimAbandonMs() {
    return envMinutesMs(DEFAULT_CLAIM_ABANDON_MIN, "SIDEQUEST_CLAIM_ABANDON_MIN");
  }
  function claimActivityMs(ticket) {
    const claim = ticket && ticket.claim;
    if (!claim || !claim.by) return Number.NaN;
    let latest = Number.NaN;
    const consider = (value) => {
      const ms = Date.parse(value);
      if (Number.isFinite(ms) && (!Number.isFinite(latest) || ms > latest)) latest = ms;
    };
    consider(claim.at);
    consider(claim.activeAt);
    consider(claimVerification(ticket)?.startedAt);
    for (const comment of Array.isArray(ticket.comments) ? ticket.comments : []) {
      if (comment && comment.by === claim.by) consider(comment.at);
    }
    return latest;
  }
  function claimIdleAge(ticket, now) {
    const latest = claimActivityMs(ticket);
    return Number.isFinite(latest) ? Math.max(0, now - latest) : Number.POSITIVE_INFINITY;
  }
  function claimVerification(ticket) {
    const claim = ticket?.claim;
    const verification = claim?.verification;
    if (!claim?.by || !verification || verification.by !== claim.by) return null;
    const startedAt = String(verification.startedAt || "");
    const command = String(verification.command || "").trim();
    if (!Number.isFinite(Date.parse(startedAt)) || !command) return null;
    return { startedAt, command };
  }
  function claimMaySubmit(ticket) {
    if (claimVerification(ticket)) return true;
    const claim = ticket?.claim;
    if (!claim?.by) return false;
    let latestEvent = null;
    for (const comment of Array.isArray(ticket.comments) ? ticket.comments : []) {
      if (comment?.by !== claim.by) continue;
      const event = verificationComment(comment.body);
      if (event) latestEvent = event;
    }
    return latestEvent?.kind === "complete" && (latestEvent.status === "passed" || !latestEvent.status && !latestEvent.noOp);
  }
  function verificationComment(body) {
    const text = String(body || "");
    if (text.startsWith(VERIFY_START_COMMENT)) {
      const command = text.slice(VERIFY_START_COMMENT.length).trim();
      return command ? { kind: "start", command } : null;
    }
    if (text.startsWith(NEGATIVE_CONTROL_COMMENT)) return { kind: "negative-control" };
    if (!text.startsWith(VERIFY_COMPLETE_COMMENT)) return null;
    const completion = text.slice(VERIFY_COMPLETE_COMMENT.length);
    const statusMatch = completion.match(/^\s*([^\s:]+)/);
    const matchedStatus = statusMatch?.[1];
    if (!matchedStatus) return { kind: "complete", noOp: false };
    const status = VERIFY_COMPLETE_STATUS_ALIASES.get(matchedStatus) || matchedStatus;
    if (status === "no-op") return { kind: "complete", noOp: true };
    if (VERIFY_COMPLETE_STATUSES.has(status)) return { kind: "complete", noOp: false, status };
    return { kind: "complete", noOp: false };
  }
  function verificationCompletionCheck(slug, ticket, comment) {
    const event = verificationComment(comment?.body);
    if (!event || event.kind !== "complete") return { ok: true };
    return completionTreeCheck(slug, ticket, { explicitNoOp: event.noOp });
  }
  function recordClaimVerification(ticket, comment) {
    const claim = ticket?.claim;
    if (!claim?.by || comment?.by !== claim.by) return;
    const event = verificationComment(comment.body);
    if (!event) return;
    const dispatch = dispatchState(ticket);
    if (event.kind === "start") {
      claim.verification = { by: claim.by, startedAt: comment.at, command: event.command };
      delete claim.noOp;
      if (dispatch) delete dispatch.verifyStopAt;
      return;
    }
    if (event.kind !== "complete") return;
    if (event.noOp) claim.noOp = { by: claim.by, at: comment.at };
    else delete claim.noOp;
    if (claimVerification(ticket)) delete claim.verification;
    if (dispatch) delete dispatch.verifyStopAt;
  }
  function hasNoOpReleaseProof(slug, ticket, by) {
    const claim = ticket?.claim;
    if (!claim?.by || claim.by !== by || claim.noOp?.by !== by) return false;
    const completion = completionTreeCheck(slug, ticket, { explicitNoOp: true });
    return completion.ok && completion.applicable === true && completion.noOp === true;
  }
  function observedStop(dispatch, claim) {
    if (!dispatch || !["died", "stopped_claimed"].includes(dispatch.outcome) || !dispatch.terminalAt) return false;
    const stoppedMs = Date.parse(dispatch.terminalAt);
    const claimedMs = Date.parse(claim && claim.at);
    if (!Number.isFinite(stoppedMs)) return false;
    return !Number.isFinite(claimedMs) || stoppedMs >= claimedMs;
  }
  function missingIsolatedWorktree(dispatch) {
    try {
      return isolatedDispatchWorktreeMissing(dispatch);
    } catch (_) {
      return false;
    }
  }
  function claimReleaseBlocker(slug, ticket) {
    const dispatch = dispatchState(ticket);
    if (!dispatch || dispatch.sharedTree !== true) return null;
    const delta = dispatchDelta(slug, ticket);
    if (!delta.ok) {
      return {
        kind: "shared_tree_state_unavailable",
        reason: "the shared checkout could not be inspected for uncommitted changes"
      };
    }
    if (!delta.working.length) return null;
    return {
      kind: "dirty_shared_tree",
      paths: delta.working,
      newlyChangedPaths: delta.working,
      preExistingPaths: delta.preExisting || [],
      baselineRecorded: delta.baselineRecorded === true,
      reason: "the shared checkout has paths changed after this dispatch baseline"
    };
  }
  function claimReleaseVerdict(ticket, now) {
    const claim = ticket && ticket.claim;
    if (!claim || !claim.by) return null;
    const atMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const idleMs = claimIdleAge(ticket, atMs);
    const dispatch = dispatchState(ticket);
    const verification = claimVerification(ticket);
    const idleBeyond = (thresholdMs) => {
      if (!(idleMs > thresholdMs)) return false;
      const latest = claimActivityMs(ticket);
      if (!Number.isFinite(latest)) return true;
      try {
        const slept = (injectedHostSleep || defaultHostSleep()).overlap(latest, atMs).sleptMs;
        return idleMs - (Number.isFinite(slept) ? slept : 0) > thresholdMs;
      } catch (_error) {
        return true;
      }
    };
    if (observedStop(dispatch, claim)) {
      return { kind: "observed_stop", idleMs, at: dispatch.terminalAt, reason: "its executor has a durable died outcome while still holding the claim" };
    }
    if (missingIsolatedWorktree(dispatch)) {
      return { kind: "missing_worktree", idleMs, reason: "its isolated executor worktree no longer exists" };
    }
    if (verification) {
      if (idleBeyond(claimAbandonMs())) {
        return { kind: "abandoned_verifying", idleMs, at: verification.startedAt, reason: "its verification marker never completed past the unobserved-death backstop" };
      }
      return null;
    }
    const heldPark = ticket.status === PARK_STATUS && ticket.park?.mode === "held";
    if (dispatch || heldPark) {
      if (idleBeyond(claimAbandonMs())) {
        return { kind: "abandoned", idleMs, reason: heldPark ? "the held awaiting-user park passed the 24 h abandon backstop" : "no board activity from the claim holder past the unobserved-death backstop" };
      }
      return null;
    }
    if (idleBeyond(claimIdleMs())) {
      return { kind: "idle", idleMs, reason: "no board activity from the claim holder and no executor dispatch exists" };
    }
    if (idleBeyond(claimAbandonMs())) {
      return { kind: "abandoned", idleMs, reason: "no board activity from the claim holder past the unobserved-death backstop" };
    }
    return null;
  }
  function claimReclaimable(ticket, now) {
    return Boolean(claimReleaseVerdict(ticket, now));
  }
  function autoReleasedClaimMessage(ref, release) {
    const when = release && release.at ? ` at ${release.at}` : "";
    const why = release && (release.reason || release.kind) || "the claim sweep released it";
    return `${ref}'s claim was auto-released${when}: ${why}. Its dispatch token went with it, so this closeout cannot be recorded. Your commits are safe — do NOT discard, reset, or redo the work. Recovery: have the orchestrator run \`sidequest dispatch ${ref}\`, claim with that fresh token and executor, then hand in the SAME commit. After a terminal dispatch, deliver verified landed work through \`sidequest groomClose ${ref} --by <integrator> --deliveryCommit <sha>\`.`;
  }
  function claimIdleLabel(idleMs) {
    return Number.isFinite(idleMs) ? `${Math.round(Number(idleMs) / 6e4)}m` : "an unknown time";
  }
  function claimReleaseNote(ticket, verdict) {
    const by = ticket && ticket.claim && ticket.claim.by;
    const idle = claimIdleLabel(verdict && verdict.idleMs);
    if (verdict.kind === "observed_stop") {
      return `↩️ Auto-released to **todo**: its executor had a recorded terminal Agent failure while holding the claim (at ${verdict.at}, was claimed by \`${by}\`). It is back in the ready pool; re-dispatch to continue the work.`;
    }
    if (verdict.kind === "abandoned_verifying") {
      return `↩️ Auto-released to **todo**: verification from \`${by}\` never completed for ${idle}, past the unobserved-death backstop.`;
    }
    if (verdict.kind === "missing_worktree") {
      return `↩️ Auto-released to **todo**: the isolated executor worktree for \`${by}\` no longer exists.`;
    }
    if (verdict.kind === "idle") {
      return `↩️ Auto-released to **todo**: no board activity from \`${by}\` for ${idle}, and this claim has no executor dispatch.`;
    }
    return `↩️ Auto-released to **todo**: no board activity from \`${by}\` for ${idle}, past the unobserved-death backstop (nothing ever reported that executor stopping).`;
  }
  function touchClaimActivity(ticket, by, now) {
    const claim = ticket && ticket.claim;
    if (!claim || !claim.by || by != null && claim.by !== by) return false;
    claim.activeAt = now || (/* @__PURE__ */ new Date()).toISOString();
    if (by != null && ticket.status === PARK_STATUS && ticket.park?.mode === "held" && typeof resumeHeldPark === "function") {
      resumeHeldPark(ticket, by, claim.activeAt);
    }
    return true;
  }
  function touchClaim(slug, idOrRef, by) {
    const found = getTicket(slug, idOrRef);
    if (!found) return { ok: false, reason: "not_found" };
    return withTicketLock(slug, found.id, () => {
      const t = getTicket(slug, found.id);
      if (!t) return { ok: false, reason: "not_found" };
      if (!touchClaimActivity(t, by)) return { ok: false, reason: "not_owner", ticket: t };
      putTicket(slug, t);
      return { ok: true, ticket: t };
    });
  }
  return {
    DEFAULT_CLAIM_ABANDON_MIN,
    DEFAULT_CLAIM_IDLE_MIN,
    DEFAULT_PREPARED_DISPATCH_TTL_HOURS,
    autoReleasedClaimMessage,
    claimAbandonMs,
    claimActivityMs,
    claimIdleAge,
    claimIdleMs,
    claimMaySubmit,
    claimReclaimable,
    claimReleaseBlocker,
    claimReleaseNote,
    claimReleaseVerdict,
    claimVerification,
    hasNoOpReleaseProof,
    missingIsolatedWorktree,
    observedStop,
    preparedDispatchTtlMs,
    recordClaimVerification,
    releaseCommentBody,
    technicalBlockerRelease,
    touchClaim,
    touchClaimActivity,
    verificationComment,
    verificationCompletionCheck
  };
}
module.exports = {
  PARK_MODES,
  PARK_STATUS,
  createClaims,
  heldParkQuestions,
  openBlockingQuestions,
  parkCommentBody,
  parkQuestionStates,
  unparkCommentBody
};
