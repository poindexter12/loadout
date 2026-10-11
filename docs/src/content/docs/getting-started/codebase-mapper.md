---
title: Codebase Mapper
description: Give Claude a current map of your project so sessions can get oriented quickly.
---

Codebase Mapper creates a project map that helps Claude understand where things live, how the main pieces fit together, and where to start when you ask for work. It works with existing and new projects.

## Install

Run these in Claude Code:

```text
/plugin marketplace add poindexter12/loadout
/plugin install codebase-mapper@loadout --scope project
```

Then ask Claude:

> Map this codebase for future sessions.

Claude reads the project, creates the useful map documents under `.claude/.codebase-info/`, and records their state. It leaves `CLAUDE.md` alone. Outside an explicit no-commit instruction, the mapping skill commits the generated documents and `.map-state.json` so the map is available to future sessions.

Codebase Mapper has one optional companion, [graphify](https://pypi.org/project/graphifyy/), which extracts a queryable graph of your code and takes over the structural half of the map. It is opt-in and it is not a prerequisite: with graphify absent, the mapper behaves exactly as it always has and says once that graphify is not installed. Installing it belongs to `/quartermaster:setup`, which offers it only when you take `codebase-mapper`, and only as a separate second yes. Quartermaster then owns its upgrades and health checks. See [Graph mode](#graph-mode) for what changes when it is present.

## Daily use

After code changes, the installed Mapper hook tells Claude to assess whether the map needs work and to run `update-codebase-map` immediately when it does. It does not wait for a separate approval.

The assessment has a few paths:

- **Genuine no-op:** no documented behavior, structure, interface, dependency, or convention changed, so the map and state stay untouched.
- **Incremental update:** only affected documents are edited, the document list and `.map-state.json` are refreshed, and the map is committed outside shared-tree artifact mode.
- **Larger remap:** a larger structural drift can use an optional Sidequest artifact handoff when its live contract is available. The shared-tree artifact writer leaves `.claude/.codebase-info/` in the working tree for the invoking parent session to verify and commit.
- **Standalone fallback:** when Sidequest is absent or its artifact contract is unavailable, Mapper completes the work inline. Standalone Codebase Mapper does not require Sidequest.

If you explicitly say not to commit, the skill leaves verified map changes in the working tree and tells you what still needs review or committing. You can also ask directly:

> Update the codebase map for the changes in this session.

The map is available automatically when a session starts. Dispatched Sidequest executors and general-purpose subagents get it too, so delegated work starts oriented as well.

## Graph mode

When graphify has built a graph for a project, the mapper runs in **graph mode** and the work splits in two. graphify owns the structure of the code: the module layout, where execution starts, the file tree, and who calls whom. It reads that out of the code itself, deterministically and without a model. The mapper keeps the half a graph cannot produce: conventions, patterns, why a boundary exists, how a request actually flows end to end, and where a newcomer should start reading. Structure questions go to the graph, convention questions go to the map documents.

That split is the point. A hand-written copy of the module list is a second source of truth that goes stale the first time someone moves a file.

### How graph mode is detected

A project is in graph mode when `graphify-out/GRAPH_REPORT.md` exists at the project root. Nothing else turns it on, and nothing assumes it: the mapper's skills and its hooks read that same path, so they cannot disagree. The `map-codebase` skill offers a first build only when the `graphify` CLI is on `PATH`, and asks before building. Hooks never build a graph or install anything.

Sessions in a graph-mode project are told to answer structural questions by running `graphify query "<question>"`, `graphify explain "<node>"`, or `graphify path "<from>" "<to>"` instead of reading map documents for them.

### What the map stops writing

Three documents are retired in graph mode, because the graph is the better answer to all three:

- `directory-structure.md`
- `modules.md`
- `entry-points.md`

They are not written, and an existing copy is deleted rather than left to drift. Everything else in the document set stays as it is. `dependencies.md` in particular stays, since it comes from your package manifests rather than from the code's syntax tree. `INDEX.md` gains a structure section pointing at the graph and its three read-only commands, so a session that needs structure knows where to go.

### Freshness has two owners

- **The graph** is kept current by graphify's own git hook, which the mapper offers once at build time (`graphify hook install`). It rebuilds after a commit or checkout, deterministically, with no model involved. `graphify hook status` reports whether it is installed.
- **The narrative documents** are kept current by the mapper's `.map-state.json` hash manifest and the post-change assessment described under [Daily use](#daily-use), exactly as in classic mode.

The manifest records `structure: "graphify"` so the hook knows the three retired documents are missing on purpose rather than lost. If no git hook is installed, the update skill refreshes the graph once itself with the documented `graphify update <root>` form, and tells you that installing the hook would have made that unnecessary.

### What gets committed

The graph outputs are partly tracked. In graph mode the mapper settles `.gitignore` so that two files travel with the repo and the rest do not:

```text
/graphify-out/*
!/graphify-out/GRAPH_REPORT.md
!/graphify-out/graph.json
```

`GRAPH_REPORT.md` and `graph.json` are exactly what the read-only commands consume, so a clone without them has no graph to ask. The generated HTML, the extraction cache, and the manifest are large, fully rebuildable, and churn on every commit, so they stay local.

### Subagents query, they never refresh

Dispatched executors and general-purpose subagents are told they are in graph mode and may run `graphify query`, `graphify explain`, and `graphify path` freely, since those only read. They must never refresh the graph and never update the narrative documents. Parallel work that each refreshed the same outputs would race; instead the git hook or the main session refreshes the graph, and the main session refreshes the map once after the parallel work integrates. A subagent that notices staleness reports it rather than fixing it.

### Converting a map that predates the graph

If a project already has a map and then gets a graph, the map still carries its own structural documents and they now duplicate the graph. The update skill notices this (a graph report exists, the manifest has no `structure` field), says so, and converts the map once: it moves any judgement worth keeping out of the retired documents into `architecture.md`, deletes the three, rewrites `INDEX.md` to send structural questions to the graph, and marks the map as graph-backed in `.map-state.json`. It is a one-time step, and afterwards every run reads the mode straight off the manifest. The exact commands live in the `update-codebase-map` skill; you only need to ask for the map to be updated.

## If the map needs attention

- **There is no map yet:** Ask Claude to map the codebase. It will create the initial map.
- **The map is stale:** Ask Claude to update it after the latest changes, or let the post-change assessment handle it.
- **A section is missing or wrong:** Name the area or behavior you want checked, then ask Claude to update the map.
- **Your team does not see the map:** Check whether an explicit no-commit instruction left it uncommitted, then review and commit `.claude/.codebase-info/`.

See the generated [Codebase Mapper reference](../../reference/codebase-mapper/) for the agent-facing skill details.
