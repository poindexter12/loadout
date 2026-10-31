// Every SIDEQUEST_* variable in a developer's or a release runner's shell is an operator knob
// that changes runtime behavior, and the suites here spawn the code under test with their own
// `process.env`. SQ-389: the v4.15.0 cut ran as
// `SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS=5400000 node scripts/release/cut.mjs`, which is the
// documented way to get a cut through a loaded machine, and that override rode straight into
// every verify-capture the suite spawned. The SQ-225 detached-capture test read back a
// 6000000ms budget where it asserts 600000ms, so widening the budget failed the cut and
// leaving it unset failed the cut on time. Either way no release could be cut while the
// machine was busy.
//
// The sweep is by prefix with an allowlist rather than a list of known-bad names: naming one
// variable only fixes the leak until the next knob is added. Only the variables the sandbox
// itself owns survive, so an operator setting anything else cannot reach the code under test.
// A test that wants an override sets it explicitly on the environment it hands its child.
export const sandboxOwnedEnvironmentVariables: readonly string[] = [
  // Pinned by _sidequest-test-home.ts (the board sandbox and the agent-definition target).
  'SIDEQUEST_HOME',
  'SIDEQUEST_AGENTS_DIR',
  'SIDEQUEST_HOST_SLEEP_DETECTION',
  // Pinned by scripts/test-full.mjs for the functional phase it spawns.
  'SIDEQUEST_CLAUDE_HOME',
  'SIDEQUEST_DISCOVERY_DIRS',
];

export function isSandboxOwnedEnvironmentVariable(name: string): boolean {
  return sandboxOwnedEnvironmentVariables.includes(name);
}

// Deletes every inherited SIDEQUEST_* variable the sandbox does not own, in place, and returns
// the names it removed (sorted) so a caller can assert on them.
export function scrubInheritedSidequestEnvironment(
  environment: Record<string, string | undefined> = process.env,
): string[] {
  const scrubbed: string[] = [];
  for (const name of Object.keys(environment)) {
    if (!name.startsWith('SIDEQUEST_') || isSandboxOwnedEnvironmentVariable(name)) continue;
    delete environment[name];
    scrubbed.push(name);
  }
  return scrubbed.sort();
}
