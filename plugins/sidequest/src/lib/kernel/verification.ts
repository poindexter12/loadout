'use strict';

import type { Diagnostic } from './index.js';

export const VERIFICATION_KINDS = ['suite', 'command', 'document', 'link', 'schema', 'manual', 'attestation', 'review', 'custom'] as const;
export type VerificationKind = (typeof VERIFICATION_KINDS)[number];

export const VERIFICATION_STATUSES = ['passed', 'failed_suite', 'toolchain_missing', 'could_not_run', 'timeout', 'manual', 'attestation', 'skipped', 'failed_check'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export type VerificationSuite = Readonly<{
  name: string;
  cwd: string;
  setup?: string | null;
  command: string;
}>;

export type VerificationRequirement = Readonly<{
  kind: VerificationKind;
  evidenceContract: string;
  command?: string;
  suite?: VerificationSuite;
  artifact?: string;
}>;

export type VerificationWaiver = Readonly<{
  authority: string;
  reason: string;
  affectedGate: string;
  scope?: string;
  expiresAt?: string;
}>;

export type VerificationResult = Readonly<{
  kind: VerificationKind | string;
  status: VerificationStatus;
  evidence: string;
  command?: string | null;
  logPath?: string | null;
  exitCode?: number | null;
  shell?: string | null;
  timeoutMilliseconds?: number;
  outputTail?: string | null;
  failureIdentities?: readonly string[];
  waiver?: VerificationWaiver;
  diagnostics?: readonly Diagnostic[];
}>;

export type CompletedVerificationCapture = Readonly<{
  id: string;
  ticket: string;
  command: string;
  status: VerificationStatus;
  candidate: Readonly<{ source: string; value: string }>;
  completedAt: string;
  worktree?: string;
  logPath?: string | null;
  exitCode?: number | null;
  shell?: string | null;
  waitedForSlotMs?: number;
  queuePosition?: number;
  dispatchNonce: string;
}>;

type VerificationCandidate = Readonly<{ source: string; value: string }>;

type RequirementInput = Readonly<{
  kind?: string;
  evidence?: string;
  command?: string;
  artifact?: string;
  suite?: Readonly<{ name?: string; cwd?: string; setup?: string | null; command?: string }> | null;
}>;

type Capture = Readonly<{
  status: string;
  reason?: string;
  command?: string;
  logPath?: string;
  exitCode?: number | null;
}>;

function nonEmpty(value: unknown): string {
  return String(value || '').trim();
}

function requiredKind(value: string): VerificationKind {
  return (VERIFICATION_KINDS as readonly string[]).includes(value) ? value as VerificationKind : 'custom';
}

export function classifyVerificationKind(verify: unknown, declaredKind?: unknown): VerificationKind {
  if (/^manual:\s+/i.test(nonEmpty(verify))) return 'manual';
  return requiredKind(nonEmpty(declaredKind || 'command').toLowerCase());
}

function suiteFrom(input: RequirementInput): VerificationSuite | undefined {
  if (!input.suite) return undefined;
  const name = nonEmpty(input.suite.name);
  const cwd = nonEmpty(input.suite.cwd);
  const command = nonEmpty(input.suite.command);
  return name && cwd && command
    ? Object.freeze({ name, cwd, setup: input.suite.setup || null, command })
    : undefined;
}

function suiteCommand(suite: VerificationSuite): string {
  return `cd ${suite.cwd} && ${[suite.setup, suite.command].filter(Boolean).join(' && ')}`;
}

export function validationDiagnostic(code: string, message: string): Diagnostic {
  return Object.freeze({ code, message, actionable: true });
}

export function verificationRequirement(input: RequirementInput): VerificationRequirement {
  const kind = classifyVerificationKind(input.evidence || input.command, input.kind);
  const evidence = nonEmpty(input.evidence);
  const command = nonEmpty(input.command || (kind === 'command' ? evidence : ''));
  const suite = suiteFrom(input);
  if (kind === 'attestation') {
    const artifact = nonEmpty(input.artifact);
    return Object.freeze({ kind, artifact, evidenceContract: `attestation evidence for ${artifact}` });
  }
  if (kind === 'review') return Object.freeze({ kind, evidenceContract: evidence || 'independent review findings' });
  if (kind === 'manual') return Object.freeze({ kind, evidenceContract: evidence.replace(/^manual:\s*/i, '') || 'manual verification evidence' });
  if (kind === 'suite' || (!command && suite)) {
    if (!suite) return Object.freeze({ kind: 'suite', ...(command ? { command } : {}), evidenceContract: evidence || 'named suite output' });
    return Object.freeze({ kind: 'suite', suite, command: suiteCommand(suite), evidenceContract: `suite ${suite.name} output` });
  }
  if (['document', 'link', 'schema', 'custom'].includes(kind)) {
    return Object.freeze({ kind, evidenceContract: evidence || `${kind} verification evidence` });
  }
  return Object.freeze({ kind: 'command', command: command || undefined, evidenceContract: command || 'command output' });
}

export function verificationWaiverDiagnostic(waiver: VerificationWaiver): Diagnostic {
  return validationDiagnostic('verification_waived', `Verification gate ${waiver.affectedGate} waived by ${waiver.authority}: ${waiver.reason}`);
}

export function validateVerificationWaiver(value: unknown, now = new Date()): VerificationWaiver | Diagnostic {
  if (!value || typeof value !== 'object') return validationDiagnostic('verification_waiver_required', 'Skipping required verification requires a human waiver with authority, reason, affectedGate, and bounded scope or expiry.');
  const waiver = value as Record<string, unknown>;
  const authority = nonEmpty(waiver.authority);
  const reason = nonEmpty(waiver.reason);
  const affectedGate = nonEmpty(waiver.affectedGate);
  const scope = nonEmpty(waiver.scope);
  const expiresAt = nonEmpty(waiver.expiresAt);
  if (!authority || !reason || !affectedGate || (!scope && !expiresAt)) {
    return validationDiagnostic('verification_waiver_incomplete', 'A verification waiver requires authority, reason, affectedGate, and either scope or expiresAt.');
  }
  if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now.getTime())) {
    return validationDiagnostic('verification_waiver_expired', 'A verification waiver expiry must be a future ISO timestamp.');
  }
  return Object.freeze({ authority, reason, affectedGate, ...(scope ? { scope } : {}), ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}) });
}

export function verificationAccepted(result: VerificationResult): boolean {
  if (result.status === 'passed' || result.status === 'manual' || result.status === 'attestation') return true;
  if (result.status !== 'skipped') return false;
  return !('code' in validateVerificationWaiver(result.waiver));
}

export function verificationOutcome(result: VerificationResult): string {
  return verificationAccepted(result) ? 'verified' : `verification_${String(result.status).replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
}

export function verificationFailureDiagnostic(result: VerificationResult): Diagnostic | null {
  if (verificationAccepted(result)) return null;
  const identities = result.failureIdentities?.length ? ` Failures: ${result.failureIdentities.join(', ')}.` : '';
  return validationDiagnostic(`verification_${String(result.status).replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`, `Required ${result.kind} verification returned ${result.status}.${identities}`);
}

// SQ-179: the one sanctioned way out of verification_capture_required when a capture of the
// exact candidate failed only from host load (a capture-budget timeout, or a port/process race
// while other suites ran) and reruns keep failing. Before this the only observed escape was an
// orchestrator hand-pointing refs/sidequest/<ref> with git update-ref, outside the board. A
// waiver is an orchestrator comment line on the ticket, so the thread is its audit record:
//   [sidequest:capture-waiver] capture=<id> signature=<status[:exit-N]> authority=<who>; <reason>
// It binds one recorded capture of this candidate, pinned command, and dispatch attempt; only a
// timeout or failed_suite capture qualifies; the signature must name that capture's failure
// exactly; the claim holder and the submitter cannot author it. Integration verification still
// runs the pinned command on the integrated tree, so the waiver lifts only the submit gate.
export const CAPTURE_WAIVER_MARKER = '[sidequest:capture-waiver]';
export const CAPTURE_WAIVER_GATE = 'verification_capture_required';
export const LOAD_ONLY_CAPTURE_STATUSES: readonly VerificationStatus[] = Object.freeze(['timeout', 'failed_suite'] as VerificationStatus[]);
const CAPTURE_WAIVER_REASON_MIN = 20;
const CAPTURE_WAIVER_LINE = /^\[sidequest:capture-waiver\]\s+capture=(\S+)\s+signature=(\S+)\s+authority=([^;]+);\s*(.*)$/i;

export type CaptureWaiverComment = Readonly<{ by?: unknown; body?: unknown; id?: unknown }>;
export type CaptureWaiverOptions = Readonly<{ comments?: readonly CaptureWaiverComment[]; excludedAuthors?: readonly string[] }>;
type CaptureWaiverMarker = Readonly<{ captureId: string; signature: string; authority: string; reason: string; by: string }>;

export function captureFailureSignature(capture: Readonly<{ status: string; exitCode?: number | null }>): string {
  return capture.exitCode == null ? String(capture.status) : `${capture.status}:exit-${capture.exitCode}`;
}

export function captureWaiverMarkers(comments: readonly CaptureWaiverComment[] = []) {
  const markers: CaptureWaiverMarker[] = [];
  const malformed: string[] = [];
  for (const comment of comments) {
    const by = String(comment?.by || '').trim();
    for (const rawLine of String(comment?.body || '').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.toLowerCase().startsWith(CAPTURE_WAIVER_MARKER)) continue;
      const match = line.match(CAPTURE_WAIVER_LINE);
      const reason = String(match?.[4] || '').trim();
      if (!match || reason.length < CAPTURE_WAIVER_REASON_MIN) {
        malformed.push(`malformed waiver by ${by || '<unknown>'} (needs capture=, signature=, authority=, and a reason of at least ${CAPTURE_WAIVER_REASON_MIN} characters after ";")`);
        continue;
      }
      markers.push(Object.freeze({ captureId: String(match[1]), signature: String(match[2]), authority: String(match[3]).trim(), reason, by }));
    }
  }
  return { markers, malformed };
}

function captureWaiverGuidance(ticket: string, eligible: readonly CompletedVerificationCapture[], rejected: readonly string[]): string {
  const latest = eligible[eligible.length - 1];
  const capture = latest ? latest.id : '<id>';
  const signature = latest ? captureFailureSignature(latest) : '<status[:exit-N]>';
  return [
    ' If captures fail only from host load (a timeout at the capture budget, or a port or process race while other suites run) and reruns keep failing, do not hand-edit refs/sidequest or retarget the submission.',
    ` Keep the claim, comment the capture id, failure signature, and log evidence, and ask the orchestrator to post "${CAPTURE_WAIVER_MARKER} capture=${capture} signature=${signature} authority=<who>; <reason and evidence>" on ${ticket}, then resubmit this same candidate.`,
    latest ? ` The latest waivable capture is ${capture} (${signature}).` : ' No timeout or failed_suite capture of this candidate, command, and dispatch attempt is recorded yet, so there is nothing to waive.',
    ' A waiver binds one timeout or failed_suite capture of this candidate, command, and dispatch attempt; the claim holder or submitter cannot author it; integration verification still runs.',
    rejected.length ? ` Ignored capture waivers: ${rejected.join('; ')}.` : '',
  ].join('');
}

export function commandVerificationResult(requirement: VerificationRequirement, evidence: string, captures: readonly CompletedVerificationCapture[], ticket: string, candidate: VerificationCandidate, dispatchNonce: string, waiverOptions: CaptureWaiverOptions = {}) {
  const command = requirement.command || '';
  if (evidence !== command) {
    const message = 'verification must match the declared executor verify command and the prepared command verifier; executors cannot replace the required command.';
    return Object.freeze({
      result: Object.freeze({ kind: requirement.kind, status: 'failed_check' as const, evidence: message, command, failureIdentities: Object.freeze(['verification:evidence-mismatch']) }),
      expectedEvidence: command,
      diagnostic: Object.freeze({ code: 'executor_verify_mismatch', message, retryable: true }),
    });
  }
  const sameIdentity = (capture: CompletedVerificationCapture) => capture.ticket === ticket
    && capture.command === command
    && capture.candidate.source === candidate.source
    && capture.candidate.value === candidate.value
    && capture.dispatchNonce === dispatchNonce;
  const completedCapture = captures.find((capture) => sameIdentity(capture) && capture.status === 'passed');
  if (!completedCapture) {
    const eligible = captures.filter((capture) => sameIdentity(capture) && LOAD_ONLY_CAPTURE_STATUSES.includes(capture.status));
    const excluded = new Set((waiverOptions.excludedAuthors || []).map((author) => String(author || '').trim()).filter(Boolean));
    const { markers, malformed } = captureWaiverMarkers(waiverOptions.comments);
    const rejected = [...malformed];
    for (const marker of markers.slice().reverse()) {
      const waived = eligible.find((capture) => capture.id === marker.captureId);
      if (!marker.by || excluded.has(marker.by)) {
        rejected.push(`capture ${marker.captureId} waiver by ${marker.by || '<unknown>'} (the claim holder or submitter cannot waive its own capture)`);
      } else if (!waived) {
        rejected.push(`capture ${marker.captureId} waiver by ${marker.by} (not a timeout or failed_suite capture of this candidate, command, and dispatch attempt)`);
      } else if (marker.signature !== captureFailureSignature(waived)) {
        rejected.push(`capture ${marker.captureId} waiver by ${marker.by} (signature ${marker.signature} does not match the recorded ${captureFailureSignature(waived)})`);
      } else {
        const signature = captureFailureSignature(waived);
        const waiver: VerificationWaiver = Object.freeze({
          authority: marker.authority,
          reason: marker.reason,
          affectedGate: CAPTURE_WAIVER_GATE,
          scope: `load-only capture ${waived.id} (${signature}) of ${candidate.source}:${candidate.value}, dispatch attempt ${dispatchNonce || '<none>'}, waived by ${marker.by}`,
        });
        return Object.freeze({
          result: Object.freeze({
            kind: requirement.kind,
            status: 'skipped' as const,
            evidence: command, // admission matches evidence to the pinned command; the reason lives in waiver
            command,
            logPath: waived.logPath || null,
            exitCode: waived.exitCode ?? null,
            waiver,
            diagnostics: Object.freeze([verificationWaiverDiagnostic(waiver)]),
          }),
          expectedEvidence: command,
        });
      }
    }
    const message = `No completed passed verification capture exists for ${ticket}, dispatch attempt ${dispatchNonce || '<none>'}, ${candidate.source}:${candidate.value}, and declared command ${JSON.stringify(command)}. Run ${JSON.stringify(command)} through the dispatched verify-capture wrapper again after finalizing that candidate, then resubmit.${captureWaiverGuidance(ticket, eligible, rejected)}`;
    return Object.freeze({
      result: Object.freeze({ kind: requirement.kind, status: 'failed_check' as const, evidence: message, command, failureIdentities: Object.freeze(['verification:capture-required']) }),
      expectedEvidence: null,
      diagnostic: Object.freeze({ code: 'verification_capture_required', message, retryable: true }),
    });
  }
  return Object.freeze({
    result: Object.freeze({
      kind: requirement.kind,
      status: 'passed' as const,
      evidence: command,
      command,
      logPath: completedCapture.logPath || null,
      exitCode: completedCapture.exitCode ?? null,
    }),
    expectedEvidence: command,
  });
}

export function captureVerificationResult(requirement: VerificationRequirement, capture: Capture): VerificationResult {
  if (capture.status === 'passed') {
    return Object.freeze({ kind: requirement.kind, status: 'passed', evidence: requirement.evidenceContract, command: capture.command || requirement.command || null, logPath: capture.logPath || null });
  }
  const status: VerificationStatus = capture.status === 'failed_suite'
    ? 'failed_suite'
    : capture.status === 'timeout'
      ? 'timeout'
      : capture.status === 'toolchain_missing'
        ? 'toolchain_missing'
        : 'could_not_run';
  const identity = capture.exitCode == null ? status : `${status}:exit-${capture.exitCode}`;
  return Object.freeze({ kind: requirement.kind, status, evidence: String(capture.reason || ''), command: capture.command || requirement.command || null, logPath: capture.logPath || null, failureIdentities: Object.freeze([identity]) });
}
