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
| observed_upstream_tip | 2e0f2bbc36a8fb18c628f25407f57aab56ee6914 |
| observed_fork_tip | 69d5a0a46873da07d979c7d908f8a39a3838634c |
| last_fetched | 2026-09-24 |
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
- Disposition: integrated (adapted) — verified on fork main 2026-09-19; see History
- Approach: adapt
- Rationale: add ownership resolution/gates while retaining fork-specific account isolation, PID/ancestry guards, and three-probe recovery patience. Preserve Linux discovery without `lsof`: the fork's synchronous lookup has a `/proc` fallback that upstream's proposed async lifecycle route lacks. Update the async `stopAll()` caller, refusal guidance, README, skill, and getting-started prose together. Conservative refusal may delay recovery but prevents mutation of unresolved active listeners. Do not copy upstream naming, configuration paths, or release machinery.
- Local evidence: reachable `e05f1947c4812d5cce821adff9ee526e20f8cbc9` adds three-failure patience; `17cc1939cca10a1d57fc3b88ae595f7b87aeecbe` and `b4d7d37ce226a32ef55399978b2de54099572ba0` add account isolation; `fdd7b2a2c5860987f1872546147f261447fecc35` and `407b2d87c3c45db8f1fa26f183a90debfa528be8` supply inherited PID/proxy safeguards; `197f692e2d23f4a6cb94c508b2952a2fabb4cd11` adds synchronous `/proc` discovery. Current `lib/{process-supervision,commands,runtime}.js` and `test/{gateway-process-isolation,gateway-drain,config-dir-state}.test.js` were inspected at the fork snapshot. No completed adoption evidence for the unresolved-listener invariant. Tests inspected, not run.
- Acceptance check: unknown/foreign listeners receive no signals, drain/restart requests, or replacement actions across lifecycle entry points; failed inspection remains retryable and later confirmed ownership permits recovery; same-install/sibling replacement and legacy drain still work; preserve account isolation, three-probe patience, Linux no-`lsof` discovery, and Windows probe output/cleanup. Add second-attempt recovery and unknown-owner stop coverage rather than relying only on upstream's first-refusal tests.
- Revisit: settled. Acceptance checks and implementation were verified on fork main 2026-09-19. Board ref `SQ-23` closed the same day. Reopen only if a bound-port ownership failure is observed against the integrated gates, or if a later upstream listener change adds intent this adaptation does not already satisfy.
- History: 2026-09-14: complete commit diff equals merge first-parent diff; remerge diff contains no resolution changes. Included `SQ-2602` patch fragment and documentation changes are accounted for here. Initial disposition deferred; existing supervision work is complementary, not equivalent.
  - 2026-09-14, local incident supplying independent evidence for this need: two concurrent `ensure` processes raced and SIGTERMed a supervisor that had been healthy for 16 hours, producing a user-visible `ECONNREFUSED` gap on :18765. Verbatim `lifecycle.jsonl`: `ensure-recovery-started` pid 76406 at 16:29:06.918Z and pid 76412 at 16:29:07.334Z; `ensure-supervisor-stop-requested` to supervisor 84803 at 16:29:08.154Z; two `supervisor-started` events (79693, 79747) 0.09s apart; `supervisor-exit` 79747 exitCode 1. Both ensures then reported `outcome:"failed"` while the gateway was in fact serving (`/v1/models` → HTTP 200 in 0.96ms; `doctor` → `Codex readiness: ready`). This adds a third sub-need not in the upstream intent above: the readiness signal reports failure on the losing side of the race. Reproducible against released 0.51.1 — the main checkout has no local gateway changes.
  - 2026-09-14, separately authorized implementation, NOT adoption evidence: an agent retained uncommitted changes in `.claude/worktrees/agent-a4d2bcba08bba3f9b` (branch `worktree-agent-a4d2bcba08bba3f9b`, base `82cc64a0030d5a98dbd10b041767d6acd33a2df8`, zero commits) touching `lib/{commands,process-supervision}.js`, `test/{gateway-drain,gateway-process-isolation}.test.js`, a new `test/gateway-ownership.test.js`, plus README, SKILL.md, and getting-started prose. The agent reported 67/67 gateway tests passing with no skips after correcting a fixture's 100ms discovery limit to the production default; its review did not complete before the session hit an API 429. That figure is executor testimony, **not independently re-run**, and the work is uncommitted. Remains deferred; verify on fork main before any disposition change.
  - 2026-09-19, **adoption evidence; disposition moved to integrated (adapted)**. The candidate above was committed and is now reachable from fork `main` as `5b1a5858cc1d5bab566717bf2aea52cf2c83b37b`, "fix(model-gateway): ensure lock, listener ownership, and patient readiness recheck (SQ-23)", merged via PR #10 on 2026-09-15T18:37:28Z. Verified this date: `git branch -r --contains` places it on `origin/main`, and the local checkout's `HEAD` matched `origin/main` at verification time. The retained worktree `agent-a4d2bcba08bba3f9b` is therefore superseded and is no longer the location of this work.
  - Acceptance checks, mapped to shipped code and to tests **run directly on fork main this date, not executor testimony**: `node --test test/gateway-ownership.test.js` from `plugins/model-gateway` reported 20 pass, 0 fail, 0 skipped, 0 todo (1616ms). Unknown/foreign listeners perform no mutation or control HTTP across stop, supervisor replacement, drain and restart, and startup refuses before cleanup, replacement or health HTTP (parameterized per state). Failed inspection stays retryable and later confirmed ownership permits recovery ("ownership inspection retries missing process data and can later confirm the listener"; "unknown stopAll is retryable and preserves records until an unbound retry"; "second recovery inspection {null,undefined,empty-command} does not permanently halt later recovery"). Linux no-`lsof` discovery is preserved ("Linux async discovery keeps the no-lsof /proc fallback and its deadline"). Windows probe output and cleanup are retained without detached children ("Windows discovery retains netstat/PowerShell output without detached children"; "Windows probe shutdown taskkills and waits for attached children to close"). The batch's extra requirement — second-attempt recovery and unknown-owner stop coverage rather than upstream's first-refusal tests alone — is met by the second-recovery and `genuinely foreign proxy refuses both initial and subsequent recovery attempts` cases.
  - The third local sub-need recorded above (readiness signal reporting failure on the losing side of the race) is covered by the same commit's "patient readiness recheck": `lib/commands.js` derives the reported outcome from a rechecked result rather than the racer's local view, and the ensure lock makes the loser a follower that reads the holder's outcome instead of mutating lifecycle state.
  - Not claimed: CI conclusions for `5b1a5858` were no longer retrievable via `gh run list` at verification time, so this entry rests on the directly re-run suite above rather than on recorded CI. The full model-gateway suite was not re-run here; that suite has known port/process flakiness tracked as `SQ-37` and `SQ-42`, which is why verification was scoped to the ownership contract file this entry is about.
  - Follow-on, not part of this adoption: `SQ-34` (merged `7f95ea4c`) later closed three residual races *in the ensure lock this commit introduced* — release-without-pid-check, a pid-recycle reclaim hole, and a non-atomic ensure result write. That is hardening of the adapted mechanism, not a second adoption of upstream intent.

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

### UP-004: The recursive-delete guard should judge the target path, not how it is spelled

- Upstream: no upstream fix for this need. The defect is present at upstream tip `2e0f2bbc36a8fb18c628f25407f57aab56ee6914` (v3.578.0). A related upstream change to the same hook, `983d470e726a34fdb88725c6074a656e30768b6c` (2026-09-14, "Fix home delete recursion flag parsing": the recursive flag must be a whole argument, and quotes are stripped first), is **not** in fork main and lies beyond `reviewed_through`, so it is unreviewed here and only noted.
- Reviewed: 2026-09-24; fork snapshot: `69d5a0a46873da07d979c7d908f8a39a3838634c`. This entry is fork-originated (board `SQ-121`), not the result of a batch review, and it does not move the cursor.
- Intent / need: `plugins/sidequest/src/hooks/guard-home-delete.ts` decides with two mechanisms that disagree. Absolute paths get a resolve-then-root/ancestor check. `~`, `$HOME` and `%USERPROFILE%` hit a blanket regex (upstream `:25`) that returns protected for any tilde path. The command splitter (`:8`) includes `\n` in its separator class, so a line inside a quoted ssh payload is scanned as a local command, while the same command written inline is not matched at all. As a result, `ssh host 'rm -rf ~'` (a real remote profile-root wipe) is allowed, and harmless `~/subdir` deletes are denied with refusal text that wrongly says the target is the profile or `.claude` root.
- Local applicability: the need exists in both trees. The probe below was run on 2026-09-24 against upstream's built `hooks/guard-home-delete.js` at the tip, with payloads piped as JSON: DENY `rm -rf ~/mainsail`; allow `rm -rf $HOME/mainsail` (same path, absolute); DENY `~`; DENY `~/.claude`; allow `ssh host 'rm -rf ~/mainsail'`; **allow** `ssh host 'rm -rf ~'`; DENY multi-line `ssh host '\nrm -rf ~/mainsail\n'`; allow `echo 'rm -rf ~'`. Fork verdicts match the peer session's report in `SQ-121`. Neither tree has a test for this guard.
- Disposition: deferred
- Approach: independent
- Rationale: upstream offers no implementation of this need to copy. The fork fix (SQ-121) expands tilde, `$HOME` and `%USERPROFILE%` into the existing root/ancestor check, scans remote payloads consistently and fails closed only on a remote profile-root target, parses shell structure instead of scanning text, and adds a table test. Consider `983d470e`'s flag-parsing intent when that range is reviewed; it is compatible, but not required for this need.
- Local evidence: none yet. `SQ-121` is dispatched with a candidate not yet submitted.
- Acceptance check: on fork main, `test/guard-home-delete.test.ts` covers every row above. `~/sub` and its absolute spelling get the same verdict (allow); `~`, `~/.claude` and remote `~` are denied with accurate refusal text; inline and multi-line ssh payloads agree; a delete literal passed as data to a non-shell program does not trigger.
- Revisit: when `SQ-121` lands on fork main (move to adapted with its commit and test run). Also consider reporting the defect upstream; this ledger does not file upstream issues.
- History: 2026-09-24: recorded from the SQ-121 handoff. Fetched upstream main without tags and probed its built hook. The upstream defect is confirmed present. Initial disposition deferred.

## Open items

- [UP-001](#up-001-seed-reuse-first-rules-without-encouraging-unsolicited-work): uncommitted implementation retained in `.claude/worktrees/agent-a5a082059278cc84b`; tests blocked by disposable-HOME guard denial. Needs approved isolated testing, assigned board ref/release fragment, and fork-main verification.
- [UP-003](#up-003-close-declared-uncommitted-deliverables-with-typed-verification-evidence): commandless working-tree closeout; proposed adaptation, pending acceptance of executor-supplied evidence for the relevant verifier kind.
- [UP-004](#up-004-the-recursive-delete-guard-should-judge-the-target-path-not-how-it-is-spelled): fork-originated guard fix `SQ-121`, in flight; upstream still carries the defect at `2e0f2bbc`.

Maintain links here to every deferred decision; remove an item when its decision is settled, not the decision itself.

## History

- 2026-09-14: Initialized active tracking at the verified shared baseline. Fetched upstream and fork tips, but performed no intent review. Tracking is deliberately temporary and may be paused or retired as Loadout diverges.
- 2026-09-14: With permission to extend the untracked bootstrap ledger, fetched only the configured main branches without tags; both observed tips were unchanged. Verified reviewed/previously observed upstream ancestry and completed Batch 1 after exact-SHA coverage validation. Recorded UP-001 through UP-003 as deferred adaptations, with no implementation or adoption claim. Tracking remains active and useful for selective safety/contract fixes, especially UP-002; the review cost argues for bounded batches, not treating the backlog as an obligation.
- 2026-09-14, closeout: no fetch, no review, no cursor movement — checkpoints and dispositions are unchanged. Recorded local incident evidence against UP-002 from a live gateway failure the same day, assigned it board ref `SQ-23`, and noted both retained agent worktrees (`agent-a5a082059278cc84b` for UP-001, `agent-a4d2bcba08bba3f9b` for UP-002) as uncommitted candidates rather than adoption. Both hold working-tree state only, with zero commits, and are lost if pruned. All three entries remain deferred.
- 2026-09-17, tag hygiene (`SQ-28` part a): no review, no cursor movement — checkpoints and dispositions are unchanged. Set `remote.upstream.tagOpt = --no-tags`, because a plain `git fetch upstream` was importing upstream's release tags into the fork clone, where they occupied the exact tag names the fork's next release needed (`v3.541.0`, `sidequest-v5.1.2`, `quartermaster-v0.9.0` were all already present). Deleted the 73 imported upstream tags. This is clone-local only: none of them existed on `origin`, and the fork's published namespace was never affected. `/upstream-check` is unaffected because this ledger tracks upstream by SHA (`observed_upstream_tip`), never by tag.
  - Classification evidence, which contradicts the heuristic `SQ-28` was filed with. Reachability from fork `main` does **not** identify a foreign tag. Upstream tags cut before the fork point (`v3.536.0`, `sidequest-v5.0.41`) are reachable from fork `main`, and seven of the fork's own tags were reachable but absent from `origin`. The reliable discriminator is the annotated tag's **tagger identity** (`Joe Seymour` = fork; `Eigenwise` and `Kenny Vaneetvelde` = upstream) combined with presence on `origin`.
  - Separately discovered and repaired: the fork's entire `v3.537.0` release — the marketplace tag plus all six plugin tags (`codebase-mapper-v2.16.0`, `live-rules-v2.11.0`, `model-gateway-v0.51.0`, `observability-v0.8.0`, `quartermaster-v0.8.0`, `sidequest-v5.1.0`) — had been cut locally on 2026-09-10 but never pushed. The release commit was on `origin/main`; only the tags were missing. All seven are now pushed. Local and `origin` tag namespaces are exactly in sync.
- 2026-09-19, UP-002 settled: no fetch, no review, no cursor movement — the upstream checkpoint is unchanged. Moved UP-002 from deferred to **integrated (adapted)** and removed it from Open items, on the evidence recorded under that entry: the previously-uncommitted candidate is now `5b1a5858` on `origin/main` (PR #10, merged 2026-09-15), and its acceptance checks were re-run directly here rather than accepted as executor testimony (`node --test test/gateway-ownership.test.js`, 20 pass / 0 fail / 0 skipped). This is the first entry in this ledger to move a disposition off deferred; the standard applied was the one CLAUDE.md sets — verified on fork main, not merely present in a worktree. UP-001 and UP-003 remain deferred and untouched. Note for future closeouts: the 2026-09-14 closeout recorded both retained worktrees as "lost if pruned", and UP-002's did in fact get committed while its ledger entry still described it as uncommitted, so a disposition can go stale without any upstream movement at all. Re-check retained-worktree claims against `main` before trusting them.
- 2026-09-24, UP-004 recorded: fetched upstream main without tags (new observed tip `2e0f2bbc`, fork tip `69d5a0a4`), with no batch review and no cursor movement. A fork-originated defect (`SQ-121`, guard-home-delete) was checked against upstream's built hook at the tip and is present there unchanged. Noted, without reviewing it, the unmerged upstream flag-parsing fix `983d470e` to the same hook. `SQ-115` (another fork-found Sidequest defect reported present upstream at v3.571.0) has no entry yet.
- 2026-09-25, tag hygiene follow-up (`SQ-28` parts b-d, candidate pending fork-main integration, not integrated): no fetch, no review, no cursor movement. `scripts/release/cut.mjs` now classifies a local-only clashing tag by its annotated tagger against the clone's release identity (committer ident plus `loadout.releaseTagger` config values), not by reachability, matching the 2026-09-17 evidence above. A foreign tag gets `git tag -d` plus `remote.<name>.tagOpt --no-tags` advice. The same change checks Test CI on the pinned sha (`--trust-ci`), rolls back unpublished failures (`--keep-on-failure` opts out), and verifies every planned tag resolved on the remote after the pushes. The 2026-09-17 ops stay as recorded; nothing was re-run.
