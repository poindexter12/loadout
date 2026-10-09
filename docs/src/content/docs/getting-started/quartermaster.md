---
title: Quartermaster setup
description: Set up workspaces, keep Loadout plugins current, and find missing capabilities after real work.
---

Quartermaster helps with project setup, Loadout maintenance, workspace health, and the next capability your work is missing. Its local scripts read transcript files and emit a bounded summary. The active model sees that summary when the setup or resupply skill reads it, not the raw transcripts.

## Install

Install Quartermaster in the project you want to set up. This example uses project scope:

```text
/plugin marketplace add poindexter12/loadout
/plugin install quartermaster@loadout --scope project
```

Activate it with `/reload-plugins` or start a new Claude Code session.

## Set up a workspace

From the project directory, run:

> /quartermaster:setup

Setup reads the project, mines recent session history across your projects, asks a few setup questions, and proposes a plan covering Loadout plugins, stack plugins, starter rules, and permission entries. You approve each item before it installs or writes anything.

Starter rules teach agents to trace actual behavior and reuse project code, native platform features, the standard library, and installed dependencies before adding tools. They keep changes scoped, without automatic cleanup or arbitrary function/class size quotas. Focused checks supplement project-required tests and release gates; they do not replace them. An assigned integration owner can split verification responsibilities, while solo work retains all required verification. Security, trust-boundary, data-loss, and accessibility safeguards still apply.

Existing workspace rules are preserved. Updating Quartermaster changes its templates, not rules already seeded into your project; any refresh needs an approved diff.

Setup installs the approved plugins and writes the approved project files, then pauses at the activation boundary. Run `/reload-plugins`, or restart Claude Code when the change affects the process environment, and tell Claude `continue`. Setup verifies the selected plugins and project configuration after that boundary.

When setup wires Model Gateway or Sidequest routing, Quartermaster can offer the optional `325000` `autoCompactWindow` setting for a consistent Codex compaction point. Setup asks before writing it. If user or project settings already has a value, it reports which one wins and preserves that value.

If you choose telemetry, Claude hands the setup to Observability and tells you when a restart is needed. You can also decline and continue without it.

## Keep a workspace current

Tell Claude what you want to do:

> Update my Loadout plugins.

> Check whether this workspace and its Loadout plugins are healthy.

Or run the maintenance skills directly:

> /quartermaster:update-loadout

> /quartermaster:loadout-doctor

The requested updater reads Claude Code's installed-plugin registry and updates every active Loadout install at its recorded user, project, or local scope and project path. It can update installs in other recorded projects, not only the project where you invoked it. Third-party plugins and marketplaces are left alone.

Freshness hooks are advisory. They report cached availability and loaded-version mismatches, and they point to `/quartermaster:update-loadout`; they do not install, restart, or replace the requested updater. Marketplace auto-update is optional and must be enabled for the Loadout marketplace in Claude Code. An open session still needs `/reload-plugins` after plugin code changes. Restart Claude Code when process-level gateway wiring or model discovery changed.

The health check is read-only. It identifies stale installs, dead `enabledPlugins` entries, and Model Gateway startup-check results when that plugin is present. It also reports managed Observability storage limits without running a repair. Run the updater when you want installs changed.

## The in-the-moment loop

Quartermaster's SessionStart hook supplies a short improvement charter when `.claude/rules/self-improvement.md` is absent. An approved setup seeds a project-specific rule at that exact path instead, which suppresses the charter. Both forms favor existing capabilities and offer improvements rather than automatically building tools or starting resupply.

Live Rules re-grounds applicable rules at SessionStart and tracks their path/content hashes per session. Later prompts or edits inject newly matching or changed rules, not unchanged rules repeatedly. Missing session IDs or an unavailable ledger can cause repeated grounding.

## Where rules go

Setup and resupply write rules to one of three places, and which one depends only on who the rule is true for. Claude Code reads all three natively, so the choice survives uninstalling any plugin.

| The rule is true of | Where it goes | In the repo |
| --- | --- | --- |
| this project, for anyone who clones it | `.claude/rules/<name>.md` | yes, commit it |
| this project, for you only | `.claude/rules/<name>.local.md` | no, as long as `.gitignore` carries `.claude/rules/*.local.md` |
| you, in every project | `~/.claude/rules/<name>.md` | no, it lives in your config tree |

Starter rules derived from the project itself, meaning its stack, tooling, docs, and stated conventions, land in the first row. Correction themes that your history shows you repeating across more than one project, such as response format and length, voice, tone, punctuation, and workflow habits, land in the third: they are true of you rather than of this repository, so Quartermaster writes them to `~/.claude/rules/` and never into the project. A theme with evidence from one project only is treated as a project rule until a second project repeats it. Promoting a personal rule to a shared one is a rename.

## Resupply an existing workspace

After real work has accumulated, run it directly or accept Quartermaster's offer of a focused optimization round:

> /quartermaster:resupply

An offer is not permission to run the round. Resupply, including transcript mining, starts only after current user approval or explicit standing permission for these rounds. Running the command directly requests a round. Round approval does not authorize unrelated edits: each recommendation needs per-item approval unless explicit standing permission covers that exact class of change.

The miner reads local transcript files and emits a bounded aggregate. The active model can see the aggregate, which may include:

- session titles clipped to 120 characters;
- opening asks clipped to 240 characters;
- explicit goals, whether each goal was met, and bounded goal samples;
- the two directory segments nearest touched files, with scratch and opaque paths removed;
- counts for prompts, tool calls, errors, denials, interrupts, and corrections;
- repeated command names, plugin, skill, and MCP attribution, and fetched hostnames; and
- short correction or denial evidence quotes clipped to 300 characters.

Raw transcript files are never loaded into model context, and the resupply skill is forbidden from opening them. The default pass mines the current project. Setup explicitly requests the all-projects summary, while resupply only uses `--all-projects` for a global pass.

The skill checks for missing measurements, manual work, existing capabilities that underperform, knowledge being re-derived, and setup friction. It searches existing checks and workflows before proposing new machinery, then ranks findings by value and strength of evidence, not just that search order. It proposes at most seven findings one at a time with evidence and an exact change. A rejected recommendation is recorded and does not return; an accepted one is checked in a later pass.

## How the loop closes

A SessionEnd hook tallies each session locally in one streamed pass. Once enough unreviewed sessions or friction accumulates, the SessionStart nudge records that an offer is due and a Stop hook holds one real pause open for Claude to offer a focused optimization round. It blocks once per session, ignores its own continuation, and uses a separate 24-hour cross-session offer cooldown. Declining the whole round resets the evidence window until new sessions or friction accumulate. Applied recommendations record their targets, and later checks compare the signal before and after. Recommendations still need separate approval unless standing permission covers their exact class.

## What it stores

Tallies and decisions live under `quartermaster-state/` in your active Claude config tree — `CLAUDE_CONFIG_DIR` when it is set, otherwise `~/.claude` — or wherever `QUARTERMASTER_STATE_DIR` points: per-session counters and a decision ledger with fingerprints. The bounded aggregate is the model-facing summary for setup and resupply. Raw transcripts are not loaded into model context, and the resupply skill must not open them. Transcript-derived text in the aggregate is clipped, and scratch directories are dropped from path areas.

The [generated Quartermaster reference](../../reference/quartermaster/) contains the agent-facing skill and command details. See [contributing](../../contributing/) for maintainer workflows and the separate [support page](https://poindexter12.github.io/loadout/support/) for ways to help.
