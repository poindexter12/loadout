# Upstream decision ledger

Use `/upstream-check` in this repository to maintain this file. The procedure lives in `.claude/skills/upstream-check/SKILL.md`. Keep this ledger in git with the fork, not in session memory.

## Policy

Upstream is a source of useful intent, not a target architecture. Track the problem an update solves and whether Loadout needs that outcome. Copying code is one option; adaptation or an independent implementation can meet the same need. Different implementations do not imply a missing feature.

Tracking is useful for now, not a permanent commitment. As the fork diverges, pause or retire it when reviewing upstream costs more than the applicable changes are worth. Preserve this history if tracking stops. Do not treat the backlog as an obligation to catch up.

## State

| Field | Value |
| --- | --- |
| tracking | active |
| upstream_remote | upstream |
| upstream_url | git@github.com:Eigenwise/eigenwise-toolshed.git |
| upstream_branch | main |
| fork_remote | origin |
| fork_url | git@github.com:poindexter12/loadout.git |
| fork_branch | main |
| integration_baseline | a2e44fb353388b4c958015b50cf73c8a8cb8fb55 |
| reviewed_through | a314af2338a933d58609b29ffe26f33d1e572a5e |
| observed_upstream_tip | 8ca47bb0273ce1752bcfa8fa6eab7efa221ce992 |
| observed_fork_tip | 82cc64a0030d5a98dbd10b041767d6acd33a2df8 |
| last_fetched | 2026-09-14 |
| last_reviewed | 2026-09-14 |

`tracking` is `active`, `paused`, or `retired`. Paused/retired checks do not fetch or review until explicitly resumed. Record transitions and their reasons under History.

`integration_baseline` is the original known shared commit, retained for provenance. `reviewed_through` is the end of contiguous accounted-for upstream ancestry, not the latest adoption. `observed_*` are fetched snapshots, not review checkpoints. Store full SHAs and ISO dates; completed batches pin both SHAs so later branch movement cannot change their meaning.

## Bootstrap evidence

Initialized on 2026-09-14, without a retrospective semantic audit:

- `git merge-base origin/main upstream/main` returned `a2e44fb353388b4c958015b50cf73c8a8cb8fb55`, upstream's 2026-09-09 v3.536.0 release commit.
- Fork merge `ce86d9142d7bd81f2074438460a13d7d3132a90b` brought in upstream, followed by PR #1 merge `802dcdbdf8300b6af5707065151bb80299fb3e3a`.
- The reviewed cursor starts at this inherited baseline only. It does **not** assert that every inherited behavior survives subsequent fork changes.
- At the observed tips above, `git rev-list --count origin/main..upstream/main` was **449**. This is an ancestry count, not 449 missing features. Nothing after the baseline has yet been semantically classified in this ledger.
- Older session notes are not imported as decisions: they lack per-change evidence. Later fork work may already satisfy some upstream needs; establish that during review.

## Dispositions

| Disposition | Meaning and required evidence |
| --- | --- |
| integrated | The upstream implementation is present on fork main. Cite upstream SHA(s), reachable local commit(s), and current behavior/test evidence; ancestry or patch equivalence alone is not enough. |
| adapted | The same need is already met on fork main through a modified port or an independent/different solution. Cite local commit(s), relevant behavior/tests, and explain the equivalence and intentional differences. |
| skipped | Deliberately not needed or not worth adopting. Record applicability evidence and the decision rationale; include a revisit condition if circumstances could change. |
| deferred | Intent was reviewed, but adoption, applicability, evidence, or a user decision remains open. Record what is known, proposed approach, blocker, and concrete revisit condition. A planned implementation is not completed adoption. |

Unreviewed commits have no disposition. Never turn unread backlog into `deferred`. Copy/adapt/independent are **proposed approaches**, not completion statuses. Recheck deferred entries even after the reviewed cursor passes them. Reopen settled decisions only when new evidence changes their rationale, preserving dated history.

## Completed batches

Append one row only when every commit in the range has a disposition, including merges and metadata. Use `START..END` (start excluded, end included); a grouped entry can cover multiple commits. No gaps may be hidden by advancing the cursor.

| Date | Upstream range (full SHAs) | Pinned fork SHA | Entry IDs covering the entire range |
| --- | --- | --- | --- |
| 2026-09-14 | `a2e44fb353388b4c958015b50cf73c8a8cb8fb55..a314af2338a933d58609b29ffe26f33d1e572a5e` | `82cc64a0030d5a98dbd10b041767d6acd33a2df8` | UP-001, UP-002, UP-003 |

Batch 1 pinned observed upstream tip: `8ca47bb0273ce1752bcfa8fa6eab7efa221ce992`. All **8 commits** across **3 first-parent merges** were reviewed, including side-branch commits, merge resolutions, and release metadata. No pre-existing deferred entries needed revisiting. All three needs have remaining gaps and proposed adaptations, so all remain deferred; none is claimed adopted. Tests were read, not executed.

At these pinned tips, the remaining unreviewed range is `a314af2338a933d58609b29ffe26f33d1e572a5e..8ca47bb0273ce1752bcfa8fa6eab7efa221ce992`: **441 commits**, including **181 first-parent commits**. These are ancestry counts, not missing features. The smaller batch kept review bounded despite large individual changes.

## Partial batches

None. If review stops early, list the intended range, pinned fork SHA, and completed entry IDs with their exact covered SHAs here. Keep the cursor unchanged until coverage is complete; reuse these entries on the next run.

## Decisions

Use stable sequential IDs (`UP-001`, etc.), distinct from ticket numbers. Add entries below using this template:

```markdown
### UP-NNN: Outcome or need, not just the commit title

- Upstream: full SHA(s), plus issue/PR links when useful
- Reviewed: YYYY-MM-DD; fork snapshot: full SHA
- Intent / need: original problem, affected behavior, intended outcome; distinguish inference
- Local applicability: need exists / already met / not applicable / uncertain, with evidence
- Disposition: integrated | adapted | skipped | deferred (choose one)
- Approach: copy / adapt / independent / no action / undecided (choose one)
- Rationale: why this outcome and approach fit Loadout; dependencies and trade-offs
- Local evidence: reachable commit(s), paths/tests, verification result; or explicitly none
- Acceptance check: observable proof that the need is met, including intentional differences
- Revisit: specific trigger/blocker or none; link a ticket only if one exists
- History: dated disposition changes with evidence; retain earlier rationale
```

### UP-001: Seed reuse-first rules without encouraging unsolicited work

- Upstream: `a65de042d4b2d8e9308b2372503adb4e5d8fd069`, `3fae9ac57ed79c3efa772d70e1de010faed73f92`, `d1913ac6b1e9fba63f6277d6a07f6583bc0a063d`.
- Reviewed: 2026-09-14; fork snapshot: `82cc64a0030d5a98dbd10b041767d6acd33a2df8`.
- Intent / need: replace build-first instrumentation, arbitrary unit-size targets, automatic cleanup, and repeated broad testing with tracing actual behavior, reusing existing capabilities, the smallest evidenced change, focused checks, and explicit resupply approval. Correct the seeded self-improvement reference's claim that unchanged rules repeat every prompt. Preserve security, data-loss, trust-boundary, and accessibility safeguards.
- Local applicability: partially met, with remaining agent-facing drift. Resupply routing already prefers improving existing capabilities, and its entry point/hooks require round approval and separately scoped changes. However, `plugins/quartermaster/skills/setup/references/{rule-templates,clean-code-principles,self-improvement}.md` still contains build/cleanup/size prescriptions and a self-improvement rule directing resupply without restating approval. The SessionStart hook suppresses its fallback capability charter when the seeded rule exists. Setup correctly describes deduplication; the self-improvement reference does not.
- Disposition: deferred
- Approach: adapt
- Rationale: update the conflicting seed guidance without replacing Loadout naming, existing user rules, or project-required gates. Clarify that offering a round differs from permission to run it; do not copy upstream's ambiguous phrase gating the offer itself. The integration-owner testing policy needs a solo-work fallback. No new hook/service is needed. Updating templates does not update already-seeded workspaces; any refresh requires approval. If adapting the Ponytail-derived text, retain upstream's MIT notice and attribution, and resolve notice propagation into generated workspaces; the upstream notice names the source but supplies no source revision, so provenance is not independently verified. No present fork license violation is inferred.
- Local evidence: reachable `fad0d8a403d949f89db7151e792f7efd210e4ce7` added capability improvement; `45d009c82fe7499845390e522ed056bf8dadff33` added approval boundaries; `3bfcbd83bbb2fdf6857b2a06970694451ec36d44` added changed-rule re-grounding. Current `plugins/quartermaster/skills/resupply/{SKILL.md,references/routing.md}`, `hooks/session-start-nudge.js`, `test/{skill-prose,session-start-nudge}.test.js`, and `plugins/live-rules/hooks/lib/session-ledger.js` support these partial protections. No completed adoption evidence for the remaining seed changes. Tests inspected, not run.
- Acceptance check: adequate existing capabilities lead to reuse rather than parallel implementations; generated rules preserve safeguards, project gates, and existing files without arbitrary quotas or unrelated cleanup; no resupply mining without current/standing round approval, and no unrelated edits under round permission; seeded/fallback guidance agrees on consent and deduplication; required notices accompany derived text.
- Revisit: next authorized Quartermaster seed/resupply change, or observed unsolicited work/duplicate capability creation from seeded rules. Settle testing-policy scope and notice propagation before implementation; verify on fork main before closing.
- History: 2026-09-14: reviewed all three commits and first-parent merge diff; remerge diff contains no resolution changes. The `SQ-2590` patch fragment is grouped metadata, not adoption evidence; do not transplant its identifier or version machinery. Initial disposition deferred.
  - 2026-09-14, separately authorized implementation: background agent retained uncommitted guidance, hook, test, and prose changes in `.claude/worktrees/agent-a5a082059278cc84b` (branch `worktree-agent-a5a082059278cc84b`, base `82cc64a0030d5a98dbd10b041767d6acd33a2df8`). Agent reports independently authored wording rather than copied Ponytail prose, conditional integration-owner guidance with solo/project-gate safeguards, five added contract/runtime tests, and focused skill-review corrections. `git diff --check` passed in the agent's worktree. Tests were **not run**: the worktree guard refused disposable-HOME invocations; no bypass or live-root fallback was used. Blockers: approved isolated-test mechanism, passing relevant checks, assigned board ref/matching release fragment, and verification on fork main. Still deferred; this worktree is not adoption evidence.

### UP-002: Confirm listener ownership before lifecycle mutation

- Upstream: `93783ccca1992348d55696d5f5408201350290a8`, `a67e7e83bfe837891dddeae6a4d0af42841b9fca`.
- Reviewed: 2026-09-14; fork snapshot: `82cc64a0030d5a98dbd10b041767d6acd33a2df8`.
- Intent / need: distinguish unknown, unowned, same-install, and foreign-install listeners; require positive ownership before startup cleanup, stop, supervisor replacement, worker restart, or drain. Preserve unresolved listeners, use bounded asynchronous inspection/retry, keep inspection failures retryable, and retain Windows probe output by avoiding detached discovery processes.
- Local applicability: need exists. In `plugins/model-gateway/lib/process-supervision.js`, `foreignPortOwner()` returns null when PID discovery fails, allowing `stopShimWithDrain()` / `restartWorkerWithDrain()` to send control requests to an unconfirmed bound listener. Startup (`lib/commands.js`) and stop lack the same upfront ownership invariant, although individual PID kill guards remain. Proxy recovery can permanently halt after null process inspection rather than retry later. Account-specific state/sockets and consecutive health-failure thresholds address different conditions; configurable TCP ports still have shared defaults.
- Disposition: deferred
- Approach: adapt
- Rationale: add ownership resolution/gates while retaining fork-specific account isolation, PID/ancestry guards, and three-probe recovery patience. Preserve Linux discovery without `lsof`: the fork's synchronous lookup has a `/proc` fallback that upstream's proposed async lifecycle route lacks. Update the async `stopAll()` caller, refusal guidance, README, skill, and getting-started prose together. Conservative refusal may delay recovery but prevents mutation of unresolved active listeners. Do not copy upstream naming, configuration paths, or release machinery.
- Local evidence: reachable `e05f1947c4812d5cce821adff9ee526e20f8cbc9` adds three-failure patience; `17cc1939cca10a1d57fc3b88ae595f7b87aeecbe` and `b4d7d37ce226a32ef55399978b2de54099572ba0` add account isolation; `fdd7b2a2c5860987f1872546147f261447fecc35` and `407b2d87c3c45db8f1fa26f183a90debfa528be8` supply inherited PID/proxy safeguards; `197f692e2d23f4a6cb94c508b2952a2fabb4cd11` adds synchronous `/proc` discovery. Current `lib/{process-supervision,commands,runtime}.js` and `test/{gateway-process-isolation,gateway-drain,config-dir-state}.test.js` were inspected at the fork snapshot. No completed adoption evidence for the unresolved-listener invariant. Tests inspected, not run.
- Acceptance check: unknown/foreign listeners receive no signals, drain/restart requests, or replacement actions across lifecycle entry points; failed inspection remains retryable and later confirmed ownership permits recovery; same-install/sibling replacement and legacy drain still work; preserve account isolation, three-probe patience, Linux no-`lsof` discovery, and Windows probe output/cleanup. Add second-attempt recovery and unknown-owner stop coverage rather than relying only on upstream's first-refusal tests.
- Revisit: next authorized gateway lifecycle change, or observed bound-port ownership failure; close only after isolated acceptance checks and implementation are verified on fork main. Tracked on the board as `SQ-23`.
- History: 2026-09-14: complete commit diff equals merge first-parent diff; remerge diff contains no resolution changes. Included `SQ-2602` patch fragment and documentation changes are accounted for here. Initial disposition deferred; existing supervision work is complementary, not equivalent.
  - 2026-09-14, local incident supplying independent evidence for this need: two concurrent `ensure` processes raced and SIGTERMed a supervisor that had been healthy for 16 hours, producing a user-visible `ECONNREFUSED` gap on :18765. Verbatim `lifecycle.jsonl`: `ensure-recovery-started` pid 76406 at 16:29:06.918Z and pid 76412 at 16:29:07.334Z; `ensure-supervisor-stop-requested` to supervisor 84803 at 16:29:08.154Z; two `supervisor-started` events (79693, 79747) 0.09s apart; `supervisor-exit` 79747 exitCode 1. Both ensures then reported `outcome:"failed"` while the gateway was in fact serving (`/v1/models` → HTTP 200 in 0.96ms; `doctor` → `Codex readiness: ready`). This adds a third sub-need not in the upstream intent above: the readiness signal reports failure on the losing side of the race. Reproducible against released 0.51.1 — the main checkout has no local gateway changes.
  - 2026-09-14, separately authorized implementation, NOT adoption evidence: an agent retained uncommitted changes in `.claude/worktrees/agent-a4d2bcba08bba3f9b` (branch `worktree-agent-a4d2bcba08bba3f9b`, base `82cc64a0030d5a98dbd10b041767d6acd33a2df8`, zero commits) touching `lib/{commands,process-supervision}.js`, `test/{gateway-drain,gateway-process-isolation}.test.js`, a new `test/gateway-ownership.test.js`, plus README, SKILL.md, and getting-started prose. The agent reported 67/67 gateway tests passing with no skips after correcting a fixture's 100ms discovery limit to the production default; its review did not complete before the session hit an API 429. That figure is executor testimony, **not independently re-run**, and the work is uncommitted. Remains deferred; verify on fork main before any disposition change.

### UP-003: Close declared uncommitted deliverables with typed verification evidence

- Upstream: `023b3657ddc3348be546dbcb07abb1baf75ee26f`, `29cb570579279a3379f21720ad3968ca9149191f`, `a314af2338a933d58609b29ffe26f33d1e572a5e`.
- Reviewed: 2026-09-14; fork snapshot: `82cc64a0030d5a98dbd10b041767d6acd33a2df8`.
- Intent / need: allow explicitly declared shared-checkout working-tree deliverables to close without a commit when their pinned verifier is legitimately commandless. Add MCP `done.verify` and CLI `done --verify`, recording evidence under `completion.workingTree.verification` alongside the final candidate and changed paths. Document/link/schema/custom evidence is narrative; manual/attestation retain distinct semantics. Command/suite checks still require exact-command, candidate, and dispatch-attempt captures; review is refused because executor testimony lacks independent reviewer provenance.
- Local applicability: need exists. Both `plugins/sidequest/src/lib/store/submissions.ts` and shipped `lib/store/submissions.js` reject all commandless working-tree requirements with `working_tree_verification_capture_required`. MCP/CLI done handlers do not forward evidence, and briefings require captures universally. The declared working-tree delivery foundation is present, but this closeout option is not.
- Disposition: deferred
- Approach: adapt
- Rationale: reuse existing verifier classification and completion machinery rather than rewrite it. Decide explicitly which kinds may accept executor-supplied narrative: document/link/schema/custom mark nonblank text as passed, not independently proven truth. Commandless verification does not grant permission to run commands, change permissions, commit/push, or widen scope, and does not make dispatch/candidate inspection process-free. A prohibited pinned command cannot be replaced with narrative at closeout. Keep ordinary repository, artifact, and clean external-deliverable routes distinct. Update TS and shipped JS, tool schemas, handlers, CLI help, briefings, executor template/generated definitions, invocation guidance, and prose together. Fix capture-only wording upstream left in `src/lib/mcp-tickets.ts`, `src/lib/store.ts`, and `scripts/_exec-template.md`; avoid incidental descriptor shortening merely for parity.
- Local evidence: reachable `493486a4f9bf9a4a6311193b2037da091d73e7b3` supplies working-tree delivery; `7d66ff7f838c51b118aa546771e501c54c694a73` verifier classification; `6423a5dfcec9c4722f0884b22ddbf3859215869c` dirty-baseline handling; `fcdb6d96ff1b695160ff4042a32450fe1fb456a4` external-deliverable gates. Current `plugins/sidequest/src/lib/{store/submissions,store,mcp-lifecycle}.ts`, `src/bin/sidequest-cmd-execution.ts`, corresponding shipped JS, and `test/artifact-lifecycle.test.ts` were inspected at the fork snapshot. These foundations are not completed adoption evidence. Tests inspected, not run.
- Acceptance check: commandless done records final scoped paths, candidate identity, and typed evidence without committing/submitting; blank/malformed required evidence refuses without losing ownership; manual/attestation statuses survive and malformed attestation fails; narrative cannot bypass missing/stale command/suite capture; review provenance, scope, inherited dirt, ordinary submission restrictions, and permission boundaries remain intact. Cover every advertised commandless kind and denied-execution behavior, not only upstream's document-path additions. Every agent-facing surface must describe the same boundary.
- Revisit: next declared no-commit deliverable with legitimate commandless verification, or a dispatch hitting the capture-only dead end. Confirm acceptance of executor-supplied evidence for the selected kind before implementation; verify on fork main before closing.
- History: 2026-09-14: reviewed all three commits, full first-parent diff, tests, and contract surfaces. Remerge diff contains no resolution changes; first-parent patch matches the feature plus release fragment. `SQ-2594` requests a Sidequest minor release but adds no independent behavior or manifest bump; use fork-local release metadata if implemented. Initial disposition deferred.

## Open items

- [UP-001](#up-001-seed-reuse-first-rules-without-encouraging-unsolicited-work): uncommitted implementation retained in `.claude/worktrees/agent-a5a082059278cc84b`; tests blocked by disposable-HOME guard denial. Needs approved isolated testing, assigned board ref/release fragment, and fork-main verification.
- [UP-002](#up-002-confirm-listener-ownership-before-lifecycle-mutation): positive listener-ownership gates; proposed adaptation preserving fork isolation, recovery patience, and Linux discovery. Highest-priority gap in this batch, now with local incident evidence and an uncommitted candidate implementation in `.claude/worktrees/agent-a4d2bcba08bba3f9b`. Board ref `SQ-23`.
- [UP-003](#up-003-close-declared-uncommitted-deliverables-with-typed-verification-evidence): commandless working-tree closeout; proposed adaptation, pending acceptance of executor-supplied evidence for the relevant verifier kind.

Maintain links here to every deferred decision; remove an item when its decision is settled, not the decision itself.

## History

- 2026-09-14: Initialized active tracking at the verified shared baseline. Fetched upstream and fork tips, but performed no intent review. Tracking is deliberately temporary and may be paused or retired as Loadout diverges.
- 2026-09-14: With permission to extend the untracked bootstrap ledger, fetched only the configured main branches without tags; both observed tips were unchanged. Verified reviewed/previously observed upstream ancestry and completed Batch 1 after exact-SHA coverage validation. Recorded UP-001 through UP-003 as deferred adaptations, with no implementation or adoption claim. Tracking remains active and useful for selective safety/contract fixes, especially UP-002; the review cost argues for bounded batches, not treating the backlog as an obligation.
- 2026-09-14, closeout: no fetch, no review, no cursor movement — checkpoints and dispositions are unchanged. Recorded local incident evidence against UP-002 from a live gateway failure the same day, assigned it board ref `SQ-23`, and noted both retained agent worktrees (`agent-a5a082059278cc84b` for UP-001, `agent-a4d2bcba08bba3f9b` for UP-002) as uncommitted candidates rather than adoption. Both hold working-tree state only, with zero commits, and are lost if pruned. All three entries remain deferred.
