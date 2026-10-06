'use strict';

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import type { Baseline, SourceRevision } from './kernel';

export type SourceRevisionResolution = Readonly<{
  candidateExists: boolean;
  containsCandidate: boolean;
}>;

export type SourceRevisionCapability = (
  candidate: SourceRevision,
  baseline: Baseline,
) => SourceRevisionResolution | null | undefined;

export type SourceRevisionAdapterFacts = Readonly<{
  candidate: SourceRevision;
  dispatchBaseline: Baseline;
  baseline: SourceRevisionResolution | null;
}>;

type SourceRevisionTicket = Readonly<{
  dispatch?: Readonly<{ lifecycleAttempt?: Readonly<{ baseline?: Baseline }> }>;
  lifecycleAttempt?: Readonly<{ baseline?: Baseline }>;
  submissionRetry?: Readonly<{ baseline?: Baseline }>;
}>;

type SourceRevisionRegistration = Readonly<{
  token: symbol;
  capability: SourceRevisionCapability;
}>;

export const FILESYSTEM_SNAPSHOT_SOURCE = 'filesystem-snapshot';
const registrationsByProject = new Map<string, SourceRevisionRegistration>();
const resolvedAdapterFacts = new WeakSet<object>();

function projectKey(project: string): string {
  return String(project || '').trim().toLowerCase();
}

function baselinePurpose(value: unknown): Baseline['purpose'] | null {
  if (value === 'dispatch' || value === 'wave' || value === 'submission') return value;
  return null;
}

function snapshotPath(projectPath: string, entryPath: string): string {
  return relative(projectPath, entryPath).split(sep).join('/');
}

function updateFilesystemSnapshot(hash: ReturnType<typeof createHash>, projectPath: string, entryPath: string): void {
  const entry = lstatSync(entryPath);
  const relativePath = snapshotPath(projectPath, entryPath);
  if (entry.isDirectory()) {
    hash.update(`directory\0${relativePath}\0`);
    const children = readdirSync(entryPath).sort((left, right) => left.localeCompare(right));
    for (const child of children) updateFilesystemSnapshot(hash, projectPath, resolve(entryPath, child));
    return;
  }
  if (entry.isSymbolicLink()) {
    hash.update(`symlink\0${relativePath}\0${readlinkSync(entryPath)}\0`);
    return;
  }
  if (entry.isFile()) {
    hash.update(`file\0${relativePath}\0`);
    hash.update(readFileSync(entryPath));
    hash.update('\0');
    return;
  }
  hash.update(`other\0${relativePath}\0${entry.mode}\0${entry.size}\0`);
}

// SQ-268: a dispatch must not hold the board's machine-global write lock across a recursive read
// of every file in the project, but the snapshot it stores has to be written inside that lock to
// stay atomic with the dispatch row it describes. So the digest is measured once in a window the
// caller opens outside the lock, and the one call inside the lock is served from that measurement
// instead of walking the tree again. Keyed by resolved root, holding only the digest: `observedAt`
// stays per-call, and the window is cleared on the way out so no measurement can outlive the
// operation that took it and be mistaken for a fresh observation.
const precomputedSnapshotDigests = new Map<string, string | null>();

// null means the tree cannot be snapshotted at all, which is a refusal rather than an empty digest.
function filesystemSnapshotDigest(root: string): string | null {
  let rootExists = false;
  try {
    if (!lstatSync(root).isDirectory()) return null;
    rootExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
  }
  const hash = createHash('sha256');
  hash.update('sidequest-filesystem-snapshot-v1\0');
  try {
    if (rootExists) updateFilesystemSnapshot(hash, root, root);
    else hash.update('missing-project-root\0');
  } catch {
    return null;
  }
  return hash.digest('hex');
}

export function filesystemSnapshotRevision(projectPath: string, observedAt = new Date().toISOString()): SourceRevision | null {
  const root = resolve(String(projectPath || '').trim());
  if (!root || !Number.isFinite(Date.parse(observedAt))) return null;
  const digest = precomputedSnapshotDigests.has(root)
    ? precomputedSnapshotDigests.get(root) ?? null
    : filesystemSnapshotDigest(root);
  if (digest == null) return null;
  return Object.freeze({
    source: FILESYSTEM_SNAPSHOT_SOURCE,
    value: digest,
    observedAt: new Date(observedAt).toISOString(),
  });
}

/**
 * Runs `operation` with this project's whole-tree digest already measured, so a
 * `filesystemSnapshotRevision` call made inside it costs a map lookup rather than a recursive read
 * of every file. Measuring costs exactly what the walk costs, so only open a window around work
 * that would otherwise walk the tree while holding something another caller wants. A nested window
 * restores the one enclosing it, and no window survives the call that opened it.
 */
export function withPrecomputedFilesystemSnapshot<T>(projectPath: string, operation: () => T): T {
  const root = resolve(String(projectPath || '').trim());
  const hadPrevious = precomputedSnapshotDigests.has(root);
  const previous = precomputedSnapshotDigests.get(root) ?? null;
  precomputedSnapshotDigests.set(root, filesystemSnapshotDigest(root));
  try {
    return operation();
  } finally {
    if (hadPrevious) precomputedSnapshotDigests.set(root, previous);
    else precomputedSnapshotDigests.delete(root);
  }
}

export function filesystemSnapshotCapability(
  projectPath: string,
  hasPersistedBaseline: (baseline: Baseline) => boolean,
): SourceRevisionCapability {
  return (candidate, baseline) => {
    if (candidate.source !== FILESYSTEM_SNAPSHOT_SOURCE) return null;
    const current = filesystemSnapshotRevision(projectPath, candidate.observedAt);
    return Object.freeze({
      candidateExists: current?.value === candidate.value,
      containsCandidate: baseline.revision.source === FILESYSTEM_SNAPSHOT_SOURCE && hasPersistedBaseline(baseline),
    });
  };
}

export function sourceRevision(value: SourceRevision | undefined): SourceRevision | null {
  const source = String(value?.source || '').trim();
  const revisionValue = String(value?.value || '').trim();
  const observedAt = String(value?.observedAt || '').trim();
  if (!source || !revisionValue || !Number.isFinite(Date.parse(observedAt))) return null;
  return Object.freeze({ source, value: revisionValue, observedAt: new Date(observedAt).toISOString() });
}

function immutableBaseline(value: Baseline | undefined): Baseline | null {
  const revision = sourceRevision(value?.revision);
  const purpose = baselinePurpose(value?.purpose);
  if (!revision || !purpose) return null;
  return Object.freeze({ revision, purpose });
}

export function sourceRevisionBaseline(ticket: SourceRevisionTicket | null | undefined): Baseline | null {
  return immutableBaseline(
    ticket?.submissionRetry?.baseline
    || ticket?.lifecycleAttempt?.baseline
    || ticket?.dispatch?.lifecycleAttempt?.baseline,
  );
}

export function registerSourceRevisionCapability(
  project: string,
  capability: SourceRevisionCapability,
): () => void {
  const key = projectKey(project);
  if (!key) throw new Error('source revision capability requires a project');
  if (typeof capability !== 'function') throw new Error('source revision capability must be a function');
  const token = Symbol(key);
  registrationsByProject.set(key, Object.freeze({ token, capability }));
  return () => {
    if (registrationsByProject.get(key)?.token === token) registrationsByProject.delete(key);
  };
}

export function sourceRevisionAdapterFacts(
  project: string,
  candidate: SourceRevision | null | undefined,
  baseline: Baseline | null | undefined,
  persistedCapability?: SourceRevisionCapability | null,
): SourceRevisionAdapterFacts | null {
  const pinnedCandidate = sourceRevision(candidate || undefined);
  const pinnedBaseline = immutableBaseline(baseline || undefined);
  if (!pinnedCandidate || !pinnedBaseline) return null;
  const capability = registrationsByProject.get(projectKey(project))?.capability || persistedCapability;
  let resolution: SourceRevisionResolution | null = null;
  if (capability) {
    try {
      const reported = capability(pinnedCandidate, pinnedBaseline);
      if (reported && typeof reported.candidateExists === 'boolean' && typeof reported.containsCandidate === 'boolean') {
        resolution = Object.freeze({
          candidateExists: reported.candidateExists,
          containsCandidate: reported.containsCandidate,
        });
      }
    } catch {
      resolution = null;
    }
  }
  const facts = Object.freeze({
    candidate: pinnedCandidate,
    dispatchBaseline: pinnedBaseline,
    baseline: resolution,
  });
  resolvedAdapterFacts.add(facts);
  return facts;
}

export function isSourceRevisionAdapterFacts(value: unknown): value is SourceRevisionAdapterFacts {
  return Boolean(value && typeof value === 'object' && resolvedAdapterFacts.has(value));
}
