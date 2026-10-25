---
title: Sidequest
description: Plan, track, and deliver Claude Code work from a local board.
---

Sidequest gives Claude Code a local board for planned work. It groups tickets into stories, keeps the backlog visible, and runs delegated work through a repeatable review and delivery flow. That flow works for Git codebases and filesystem snapshots of non-Git documentation trees, vaults, and research collections.

## Install

Install Sidequest for the project you are working in:

```text
/plugin marketplace add poindexter12/loadout
/plugin install sidequest@loadout --scope project
```

Reload Claude Code or start a new session after installing. Sidequest packages its executor roster with the plugin, so Claude discovers every routed executor when it loads the plugin, before SessionStart maintenance. You can also run `/quartermaster:setup` and let Quartermaster install and configure Sidequest for the project.

Sidequest is local. The dashboard runs on your machine and ticket data stays in the local Sidequest store.

## Your first workflow

1. Open the board with `/sidequest:board`, or tell Claude to show your Sidequest board.
2. Describe the outcome you want and ask Claude to plan it as Sidequest work. For example: `Plan the checkout refresh as a Sidequest story and show me the backlog.` If work belongs on a feature branch, name that branch in the request.
3. Review the proposed tickets, dependencies, and scope in the board. Adjust the plan before work starts.
4. Ask Claude to dispatch the ready tickets. Claude chooses the configured route, starts the work, and reports verification results. Dispatch freezes each ticket's intended target branch, so two concurrent feature branches get separate targets without changing the board default.
5. When a ticket is ready, ask Claude to review and integrate it if the checks pass. Larger or higher-risk work may need an extra review before integration.

Each ticket carries a check that decides whether its work is ready. Claude records that check against the final candidate and reports what passed, failed, or needs your decision. The agent-facing reference covers capture, evidence, and delivery mechanics.

### Choose the planning depth

Use the lightest planning that fits. Exact small changes and operational asks can stay lightweight. Substantial or ambiguous work starts with a visible surgical contract: the outcome, non-goals, smallest authority needed, scope, bounded oracle (the check that decides whether it worked), and review limit.

Claude asks one batched question round for consequential choices. If the approach is genuinely contested, it may offer bounded agent proposals. `Do your thing`, `use your judgment`, and similar phrases delegate decisions for the current feature or story, not for future work.

Review stays tied to the pinned contract. If two candidate fixes are rejected in the same defect chain, stop patching and replan before trying another candidate.

The board keeps the work visible while Claude and its executors handle the ticket lifecycle. A Git ticket submits a verified range; a non-Git ticket submits a verified project snapshot. Claude reports any unavailable capability or failed delivery instead of guessing around it.

### Delegation with Sidequest

Installing Sidequest unconditionally denies generic `Agent` delegation in that session, whether or not a board ticket is in progress. This includes general-purpose, exploration, code-review, and GSD agents. The only agents that remain available are the Sidequest executors returned by dispatch for a ticket.

For a one-off investigation that needs delegated work, file and dispatch a spike ticket, usually in the `codebase-exploration` category. For a small lookup, use inline `Read`, `Glob`, `Grep`, or `WebFetch` instead of delegation.

The refusal may say not to proceed to a PR, merge, publish, or ship until the ticket is filed, dispatched, and closed. That gate applies to the work you tried to delegate: it must have its own ticket and lifecycle. It does not by itself block unrelated release work already outside that delegation.

## Use the dashboard

The project rail keeps every registered board in one place, with ticket counts and status progress beside each project. The combined view is useful when you want to scan ownership, priorities, labels, stories, and routes across the whole queue.

![Sidequest dashboard with three synthetic projects and populated todo, doing, and done columns](../../../assets/screenshots/sidequest-kanban.png)

*Synthetic demo data showing three active project boards and 25 tickets.*

Select a project in the rail when you need its focused board. The columns keep that project's open and completed work visible without losing the rest of the rail.

![Acme Fulfillment synthetic board selected in the Sidequest project rail](../../../assets/screenshots/sidequest-second-project.png)

*Synthetic demo data showing nine active Fulfillment tickets across todo, doing, and done.*

The toolbar searches refs, titles, and labels, then combines that query with priority, story, assignee, and sort controls. Active filters stay visible, so you can tell why a card is in the result.

![Sidequest board with mobile typed into search and the normal priority filter active](../../../assets/screenshots/sidequest-filtered-board.png)

*Synthetic demo data showing six mobile tickets narrowed to normal priority.*

The inbox collects comments, reminders, ticket creation, and status activity across projects. Its tabs separate work that needs you from the wider activity stream.

![Sidequest notification inbox open over a populated synthetic board](../../../assets/screenshots/sidequest-notifications.png)

*Synthetic demo data showing several unread comment notifications from different tickets.*

Open a ticket to edit its fields and read the working context in one place. The detail view keeps a scheduled reminder, dependency links, and the full comment thread beside the ticket fields.

![Sidequest ticket detail with a populated reminder, dependency link, story, and comment thread](../../../assets/screenshots/sidequest-ticket-detail.png)

*Synthetic demo data showing the Build cart summary ticket and its team discussion.*

Stories group tickets into a plan you can filter and discuss before dispatch. The toolbar story filter keeps the story list visible while you scan the combined board.

![Sidequest story filter showing synthetic stories across the combined board](../../../assets/screenshots/sidequest-stories.png)

*Synthetic demo data showing the Checkout confidence, Storefront discovery, and fulfillment story groups.*

Links show which tickets block or relate to each other. Use the dependency list to inspect the existing chain, then choose a link type and target when you add another relationship.

![Sidequest ticket links editor showing two populated dependency relationships and the add-link controls](../../../assets/screenshots/sidequest-ticket-links.png)

*Synthetic demo data showing the existing and newly added dependencies for the Build cart summary ticket.*

The lower ticket context keeps declared files, attachment previews, and the full discussion visible without putting the link picker over the comments.

![Sidequest ticket context showing affected files, three checkout attachment previews, and four complete comments](../../../assets/screenshots/sidequest-ticket-context.png)

*Synthetic demo data showing the declared checkout files, visual references, and team decisions attached to the same ticket.*

Completed work can move into the archive without disappearing. The archive view keeps the source board, priority, age, and restore action with each ticket.

![Sidequest archive containing nine synthetic tickets from three projects](../../../assets/screenshots/sidequest-archive.png)

*Synthetic demo data showing archived storefront, fulfillment, and support work.*

Settings covers routing profiles, model fallback, theme, notification preferences, and the guided tour. Open it when you need to change how the board behaves rather than the work on a ticket.

![Sidequest settings dialog showing routing, appearance, tour, and notification controls](../../../assets/screenshots/sidequest-settings.png)

*Synthetic demo data behind the Sidequest settings dialog.*

## Daily use

Ask Claude to do the board work in plain language:

- `Show me the Sidequest backlog for this project.`
- `What is ready to dispatch for the checkout story?`
- `Add a ticket for the empty-state bug and include the reproduction steps.`
- `What is blocking the checkout ticket?`
- `Review and integrate the checkout ticket if its verification passed.`

For substantial changes, Claude can turn the request into a story with linked tickets so you can see the whole plan before execution. Side issues that come up during a session can become separate tickets instead of disappearing into the current task.

Sidequest keeps ticket activity visible in the board. Ask Claude to check active work after a restart or when you need help with a ticket that was started in another session.

### Where the non-Claude models come from

Routing can send a ticket to a non-Claude model, and Sidequest finds those models in two places. If Model Gateway is installed, its published catalog is read directly. Sidequest also asks whichever endpoint `ANTHROPIC_BASE_URL` points at for its model list, the same list Claude Code reads for its own `/model` picker, so a relay you run yourself contributes models without Model Gateway being installed at all. The two sources combine: a model both of them publish keeps its Model Gateway name, so existing routes are never renamed, and an endpoint-only model is added alongside. First-party Claude models are never treated as external, so pointing the variable at the real API changes nothing about routing.

If a routing profile offers fewer models than you expect, ask Claude to check model readiness. It will say which source answered, so you can tell "Model Gateway reports its backend as down" apart from "the endpoint never answered".

A model going unready does not repoint your routes. A gateway restart, or a catalog Sidequest cannot refresh, makes a model temporarily unlistable, but a category already routed to it stays routed to it: a dispatch in that window is refused with the readiness message rather than quietly handed to a Claude model. A profile only gains a non-Claude route, never loses one, so once the gateway publishes a model the route sticks until you change it. Restart the gateway and retry, or edit the category if you want it to run on Claude.

## Deliver through pull requests

By default, Sidequest uses local delivery: integrating a wave advances the board's integration branch in your checkout. Local mode remains the default and its behavior is unchanged. From Sidequest 5.10.0, repositories that require every change to arrive through review can opt into PR delivery with the board's `deliveryChannel` setting:

```json
{ "deliveryChannel": { "mode": "pr" } }
```

The PR channel defaults to `mode: "local"` when it is omitted. Its remote defaults to `origin`, and its base branch defaults to the board's `integrationBranch` (normally `main`). Set `remote` or `target` only when the repository uses different names. The CLI shorthand is:

```text
sidequest board-config --delivery-channel pr
```

Do not confuse `deliveryChannel` with `delivery`. The latter remains the git strategy used to apply a wave (`merge`, `replay`, or `apply`); the channel decides whether the result lands locally or through a pull request. Agents configure the channel through the `board_config` MCP tool.

With PR delivery, the flow is:

1. Run `integrate`. Sidequest fetches the configured remote, assembles the wave from the target branch in a temporary worktree, pushes `sidequest/wave/<wave-id>`, opens one pull request for the wave, and enables auto-merge.
2. The pull request runs CI. The aggregate `test-gate` check is the wave gate. The tickets remain awaiting merge rather than being marked delivered.
3. Run `integrate` again after the PR merges. Sidequest reconciles the PR, verifies the merge commit reached the target branch, and closes the participating tickets. `sidequest watch` or ticket pulse can alert you when the PR becomes merged or fails, with guidance to run `integrate` to close it.

If `integrate` is interrupted while opening the PR, for example the process is killed after the push or after auto-merge was enabled, just run `integrate` again. Sidequest records the open before it pushes, so the rerun picks up the branch or PR it already made instead of refusing it. A branch or PR that does not match that record still refuses, and Sidequest never force-pushes over it.

Before enabling PR delivery, the repository must have GitHub auto-merge enabled, a ruleset requiring the aggregate `test-gate` check, and an authenticated `gh` CLI with permission to fetch, push, open PRs, and enable auto-merge. Auto-merge is a GitHub request, not proof that the PR landed. If it appears green but does not merge, explicitly merge the PR when policy allows and confirm that the target branch actually moved before running `integrate` again.

PR delivery never silently falls back to a local merge. Common outcomes are:

- `wave_ci_failed`: CI failed. Inspect the named failing checks and the PR, fix or rework the candidate, then retry integration as appropriate.
- `wave_pr_closed_unmerged`: the PR was closed without merging. Reopen or replace it according to your repository policy, then re-integrate the wave or assemble a new one.
- `pr_delivery_unavailable`: Sidequest could not use `gh`, the configured remote, or GitHub authentication. Install or authenticate `gh`, fix the remote or permissions, and retry; it does not switch to local delivery.
- `wave_merge_unreachable`: GitHub reports a merge, but the merge commit is not yet reachable from the configured target branch. Wait for the remote to catch up, then run `integrate` again.

Optional destination settings can be supplied together:

```text
sidequest board-config --delivery-channel pr --delivery-remote upstream --delivery-target release/next
```

`sidequest board-config --delivery-channel none` clears the channel and returns the board to local delivery. Local mode documentation and behavior stay as they were.

## Keep GitHub issues aligned

Link a GitHub issue to its execution ticket when that issue should follow the delivery lifecycle. Agents use the `issue_link` MCP tool; the CLI equivalent is:

```text
sidequest issue link SQ-123 https://github.com/owner/repo/issues/42
```

Use `sidequest issue list SQ-123` to see the links and `sidequest issue unlink SQ-123 <url|#N>` to remove one. A link is explicit: Sidequest never treats a ticket title, a comment, or a `TRACKS` convention as permission to change an issue.

`sidequest audit` is report-only by default. It summarizes four things: board tickets whose fix looks landed, open GitHub issues with no ticket, linked issues whose state or labels differ from the board, and any unavailable GitHub or Git evidence. `sidequest audit --apply` performs only the proposed actions for **linked** issues. It never changes unlinked issues, creates tickets, or closes board tickets.

For a linked issue, todo tickets leave it open with no Sidequest status label. Doing, awaiting-oracle, and pending-submission work is open with `status:in-progress`; done but unreleased work is open with `status:in-testing`. When every linked ticket is released, Sidequest removes those status labels, posts one release marker comment, and closes the issue. Applying the same audit again is safe: existing labels and release comments are not duplicated.

### Mirror bugs and features automatically

Hand-linking covers issues that already exist. The issue mirror runs the other direction: it files a GitHub issue for board tickets that users would want to see, so the issue list reflects the product work without exposing internal fix-ups, reviews, explorations, or planning tickets.

It is off until you configure a filter:

```text
sidequest board-config --issue-mirror '{"enabled":true,"labels":["bug","feature"]}'
```

The filter takes `labels`, `categories`, and `stories`; a ticket mirrors when it matches any of them. Categories are opt-in by name, and review, audit, research, lookup, exploration, planning, and grooming categories never match unless you list that exact category yourself. Turn the mirror back off with `--issue-mirror off`.

A mirrored ticket gets an issue on the project's origin repo, and Sidequest records it as an ordinary link, exactly as `issue link` would. From that point the lifecycle above owns it: status labels, the release marker, and close-on-done. There is no second sync path, and a ticket you linked by hand is never mirrored on top of.

Ticket labels map to repository labels (`bug` to `bug`, `feature` to `enhancement` by default, overridable with `labelMap`). Sidequest only sends a label the repository already defines.

The issue is a rewrite, not a copy. Sidequest publishes an allow-list of two fields, the title and the description, so a field added to tickets later cannot start leaking. Both are scrubbed of board refs, board slugs, absolute paths, hostnames, session and worktree ids, tokens, cost figures, and other projects' names. If a rendering still trips the detector after scrubbing, Sidequest skips that ticket and warns instead of publishing it.

Mirroring obeys the same `--apply` rule as everything else. `sidequest audit` plans from board state alone, costs no extra GitHub call, and prints `would create issue for SQ-123 ...`. Only `sidequest audit --apply` creates anything. Review a dry run before you first enable the filter: every matching open ticket is mirrored on the next apply, so a broad filter on a long-running board files a lot of issues at once.

SessionStart runs the audit in report-only mode with a short background budget. When it finds something, the session context contains one summary line such as `sidequest audit: 2 untracked issues. Run sidequest audit for detail.` It stays quiet when every count is zero and never blocks startup. A release cut with `--push` runs `sidequest audit --apply` after publishing its tag; `--dry-run` runs the report mode only. Audit failures are warnings and never roll back a release cut.

## Split boards by account

Every board lives in the database of one Sidequest home. When `SIDEQUEST_HOME` is unset, the home follows `CLAUDE_CONFIG_DIR`: a session started with `CLAUDE_CONFIG_DIR=~/.work/claude` uses `~/.work/claude/sidequest`, and a session started with `~/.personal/claude` uses `~/.personal/claude/sidequest`. Boards created while every session shared one home stay in that home until you move them.

`sidequest move-board` moves whole boards from one home to another:

```bash
# See exactly what would move. Nothing is written, and the destination is not created.
sidequest move-board my-repo other-repo --from-home ~/.work/claude/sidequest --to-home ~/.personal/claude/sidequest --dry-run

# Move them.
sidequest move-board my-repo other-repo --from-home ~/.work/claude/sidequest --to-home ~/.personal/claude/sidequest
```

A board can be named by its slug, its display name, or its repository path. `--from-home` defaults to the current home. Add `--json` for the full plan.

What moves: the board's tickets with their comments, claim history, submissions and dispatch records, its stories, links, categories, board config and notifications, and everything under `projects/<slug>/` (assets, plans, verification logs). Dispatch token files the tickets name move too, and paths inside the board that pointed at those files are rewritten to the destination. Routing profiles the board uses are copied when the destination lacks them and stay in the source for the boards still there. Ticket ids and refs do not change, so `refs/sidequest/<ref>` pointers in the repository stay valid and new tickets continue the ref sequence.

What stays: existing worktrees. They are registered with Git at their current paths and keep working where they are, so a submission parked before the move integrates from the destination home. New dispatches create worktrees under the destination home. Remove the old ones with `git worktree remove` once their work is integrated.

The move refuses, and names the cause, while any board it moves has a claimed ticket, a launched or bound dispatch, or a held publish lock. It also refuses when the destination already holds a board with the same slug that has tickets the source does not, or a different routing profile with the same name. A destination copy that is empty or left by an interrupted move is replaced. The destination database is created when absent. The source rows are deleted only after the destination copy commits and its per-table row counts match, so a crash at any point leaves the board in at least one home, and running the same move again finishes it.

### Remove a global SIDEQUEST_HOME pin afterwards

A shell profile that exports `SIDEQUEST_HOME` pins every account to one home and overrides the per-account default. Once each board sits in the home for its account:

1. Move the boards that belong to the other account, as above.
2. Delete the `export SIDEQUEST_HOME=...` line from your shell profile, or any `env` block that sets it.
3. Start a new shell and a new Claude Code session for each account. Run `sidequest projects` in each and check it lists only that account's boards.

Keep the old home until the second account has used its boards for a while. Its database still holds every board you did not move.

## If something stops working

**The board does not open.** Reload Claude Code after installing Sidequest, then ask Claude to open the board again. If the browser still does not open, ask Claude to start the Sidequest dashboard and report its local URL.

**Claude reports an older loaded Sidequest after an upgrade.** Reload plugins or start a new session to pick up the current connection and packaged executor roster. Unknown versions, schema changes, and incompatible older loaded versions refuse dispatch until reload.

**Claude says an executor is missing.** Update Sidequest, reload plugins in the affected session, and ask Claude to dispatch again. Do not create replacement agents or disable the dispatch guard. Executors for an external model are registered when that model is first routed, because which external models exist is only known once the gateway reports them, and a session that was already running has not loaded the new one yet. Claude is told when a dispatch registered one, so it can reload before it spawns. These definitions go in your Claude Code agent directory, the same place your own agents live; a separate Sidequest storage location, if you have set one, holds board state only and is never read for them.

**A ticket will not dispatch.** Ask Claude to diagnose the ticket. Common causes are an incomplete work description, a blocked dependency, or an unavailable configured route. Claude reports the specific recovery instead of silently changing the work's route.

**An executor died the moment it started, and the ticket will not take a replacement.** This is what a failed model request looks like: the executor is told to use a model its endpoint rejects, so it never gets as far as its first action. Sidequest normally learns an executor finished from the executor itself, and an executor that died this early never reports anything, so the board protects the attempt for an hour in case the work is merely slow to start. Claude no longer has to wait that hour: your session tells it that the task failed, and because that report names the same task Sidequest recorded when it started, Claude can retire the dead attempt straight away and dispatch a replacement. Ask Claude to diagnose the ticket and it reports whether it retired the attempt on that evidence or is still waiting out the hour. If the model itself is what failed, fix the route or the endpoint first, or the replacement dies the same way.

**A read-only ticket cannot start in a new repository.** Claude reports the checkout choice and keeps the ticket read-only. You do not need to commit notes or change board settings.

**A worktree-isolated executor cannot write.** Ask Claude to redispatch if the recorded checkout is missing or does not match the assigned checkout.

**An executor cannot write in another repository you approved.** Declared files only name paths inside the project, so a checkout of a different repository (for example a branch worktree you approved for a related change) has no write lease. Ask Claude to grant that checkout's absolute root on the ticket with `update` and `externalWorktrees`. The executor can then write under exactly that root while it holds its claim. The board never commits there, a grant can never point inside the project, and an executor cannot grant one to itself.

**Work looks stuck in doing.** Ask Claude to inspect the ticket's current status and executor activity. Sidequest keeps the intended integration branch that was frozen at dispatch, even if you later change branches or the board default. For two feature branches, name the intended target on each ticket instead of changing that board-wide default between dispatches.

**Executors stall or die with `[Request interrupted by user]` while the laptop lid is closed.** A Mac in Clamshell Sleep on battery runs nothing except seconds-long maintenance wakes, so a model request that starts in one wake cannot finish before the next sleep, and Claude Code's stream watchdog later records the interruption. That is not a model or gateway problem. Sidequest checks the macOS power log (`pmset -g log`; on other systems, a jump between the wall clock and the monotonic clock) and reports such a ticket as `host_sleep` instead of dead or stalled. It keeps the claim so the same executor can resume, and Claude is told not to change model routes because of it. For long unattended runs, keep the machine awake: run the session under `caffeinate -is`, or stay on AC power with the lid open.

**A ticketed helper is refused while writing verification evidence.** Only the ticket's active owner and helpers admitted through that owner's recorded identity can write the ticket's exact board-owned evidence directory. Helpers cannot use another ticket's folder or a lookalike path. Ask Claude to inspect the ticket binding, not to request repository scope.

**Two executors' temporary files collide.** Claude Code gives every executor its orchestrating session's scratchpad, so executors running side by side share one directory. Each executor's briefing names a subdirectory of its own, `<project>-<ticket>-d<launch>`, and tells it to keep every temporary file there and leave the scratchpad root alone. A generic file such as `negative-control.js` at the scratchpad root means an executor ignored that rule; ask Claude to check the affected worktrees for a source file that was swapped out for a control and not restored.

**Stale agent worktrees keep accumulating.** Ask Claude to inspect local worktree storage and clean up entries it can safely remove. The generated reference has the lifecycle and recovery details.

**A ticket contract forbids commits.** Ask Claude to declare working-tree delivery before dispatch. After verification, the declared edits stay uncommitted and unpushed in the shared checkout for your normal team handoff. Ticket closure records that handoff; it does not replace your project's commit, review, or push process.

**A verify command keeps timing out on a busy machine.** Each captured verify run has a time budget: a fixed setup allowance, plus extra time for test-suite commands (`npm run test:full`, any `node --test` run, or any `npm test` script) that grows with how loaded the machine is. A run that hits the budget reports `capture_budget_exceeded` along with how long it ran, the budget and the load. That means it ran out of time, not that a test failed. Ask Claude to rerun the capture with `SIDEQUEST_FULL_SUITE_PHASE_BUDGET_MS` set higher. That setting only ever adds time, and every capture still stops at a two-hour hard limit, so a hung run cannot block other verifications forever. If a run needs more than that, ask Claude to pin a narrower verify command for the ticket. Only a ticket-bound capture of `npm run test:full` waits its turn for the per-host capture slot. A suite run straight from a shell, or through the wrapper without a ticket, does not, so its load lands on whatever capture is running beside it. Sidequest's own test waits widen with that load rather than failing under it, but other projects' suites may not, so avoid running ad-hoc full suites beside a pinned verification.

**A verify run takes longer than ten minutes.** Claude Code stops a single shell command after ten minutes, which is shorter than a slow suite can need on a loaded machine (a Rust crate run beside another executor took about eleven). Executors therefore start the captured verify with `--detach`: the run moves into its own process group, keeps its own time budget, and cannot be stopped by that ten-minute limit. The executor waits on it for up to nine minutes at a time. If it is still going, the wrapper prints `verify=running` with a `--resume` command, and the executor reruns that command until the final verdict arrives. The capture is recorded exactly as an attached run would be.

**Submit keeps refusing work whose captures failed only because the machine was overloaded.** When captured verify runs of the exact candidate keep timing out or failing the suite because of host load, not because of the change, the `verification_capture_required` refusal names a waiver. Do not hand-edit `refs/sidequest` refs to get past it. Ask the orchestrating Claude session to post the waiver comment the refusal prints, `[sidequest:capture-waiver] capture=<id> signature=<status[:exit-N]> authority=<who>; <reason>`, with its own recorded `by` identity, and resubmit the same candidate. A waiver covers one timed-out or failed-suite capture of that candidate, verify command and dispatch attempt, and its signature must match the recorded failure. The executor that did the work cannot waive its own capture, and the `authority=` field does not override the comment's recorded author. The submission is recorded as skipped with the waiver attached, and integration still runs the verify command.

**Every submit comes back `executor_verify_mismatch`.** The refusal prints `Expected command:` followed by the exact command the submission had to reproduce, so compare it against what the executor actually ran: the two have to match byte for byte, and a reformatted or retyped equivalent does not count. The usual cause is a gate the ticket never chose, because a ticket recording no verify command of its own has one derived for it. If the expected command is not the one you want, ask Claude to pin it on the ticket, then dispatch again.

**An executor ran a much bigger test suite than the ticket asked for.** A ticket that records no verify command of its own does not dispatch without a gate; Sidequest derives one from the ticket's files, which for a plugin ticket is that plugin's whole suite. That is no longer silent: the dispatch result warns that the requirement was derived rather than taken from the ticket, and names the command it pinned, and the same notice appears in the ticket's pulse. Ask Claude to pin the narrower command you actually want before dispatching, which clears the notice.

**A pinned `node --test` command is refused for missing a loader or a preload.** A bare `node --test <files>` only works where the package it belongs to can load those files on its own. Where the tests are TypeScript and the package is not `"type": "module"`, Node strips the types, reads the files as CommonJS and loads no tests at all, which reports as a test failure seconds after it starts. The same bare form also drops any `--import` preload the package's own test script carries, and such a preload is often what points a suite's state at a sandbox instead of your real files. So the refusal names the package's own test script and the `npm run <script> -- <files>` form to record instead. Pin that, rather than reaching for the raw command.

**A submitted ticket is not integrated.** Ask Claude to inspect the submission and complete the review and integration step. Do not start the same ticket again while a submitted result is waiting.

**A wave left out submitted work.** Ask Claude to inspect the assembled wave and its declared participant set. Active or accepted pending candidates with overlapping scope belong in the wave. Review-rejected candidates stay visible for later supersession and do not block an accepted repair wave.

**A submission sat so long it can no longer be integrated.** Ask Claude to check whether the requested behavior already reached the intended branch. If it did, Claude records that evidence; if it did not, the work needs a fresh ticket against current source.

**The board feels slow, or hooks stall, when many projects are busy at once.** Every project shares one board database, and a database file takes one writer at a time, so a long write in one project can make another project's hooks wait. Sidequest can measure that instead of guessing. Set `SIDEQUEST_LOCK_TRACE=1` for the sessions you want measured and it appends one JSON line per board write to `lock-trace.jsonl` beside the board database, recording which board operation it was, how long it waited, whether it was ever actually blocked, and how long it held the lock. Then ask Claude to summarise the trace, or run `node <sidequest plugin>/lib/lock-trace.js` yourself, which breaks the counts, the median and worst waits, and how many writes gave up waiting down by the board function that held the lock, so a slow stretch points at something you can act on rather than just at the database. Leave the setting unset the rest of the time: tracing is off by default and writes nothing, which keeps it off the path of every hook in every session.

See the [generated Sidequest reference](../../reference/sidequest/) for agent-facing tool and configuration details, or the [Sidequest plugin README](https://github.com/poindexter12/loadout/tree/main/plugins/sidequest) for the project landing page.
