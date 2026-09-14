---
title: Contributing to the docs
description: Maintainer workflow for changing plugin source and site documentation.
---

## Maintainer overview

Keep each change in the documentation surface that owns it. There are three classes.

### Agent-facing contract

MCP tool schemas and descriptions, refusal and guidance strings, agent and skill definitions, CLI help, and live rules tell agents what the system does. Update these surfaces with the code change in the same story. When a value is enumerated in code, treat that enum as the source of truth and update every surface that repeats it.

### Generated reference

Pages under `docs/src/content/docs/reference/` are generated from plugin metadata, skill frontmatter, hook registries, bin file inventories, and marketplace metadata. Change the source input or `docs/scripts/generate-reference.mjs`, then regenerate with `npm run generate`. Never hand-edit a generated page.

### Human prose

Setup, observability, architecture, contributing, and release pages are maintained by hand. Update the affected page in the same story when a user or maintainer workflow changes. If the prose needs a larger follow-up, file a linked `docs-writing` ticket before the story ships.

Keep user actions in the [getting started guide](../getting-started/) or the relevant plugin guide. Keep implementation boundaries and release mechanics on the maintainer pages.

## Review upstream changes

In a checkout of Loadout, run the project-local `/upstream-check` skill to compare upstream's intent against the fork's needs. The skill is defined in `.claude/skills/upstream-check/SKILL.md`, not distributed as a plugin. If it is not listed after pulling the file, restart the session in this checkout.

```text
/upstream-check
/upstream-check status
/upstream-check pause
/upstream-check resume
/upstream-check retire
```

The default review fetches the configured upstream and fork main branches, pins their SHAs, and reviews a bounded batch plus outstanding deferred decisions. It asks what problem upstream solves, whether Loadout has that need, and whether copying, adapting, or independently implementing the outcome makes sense. Patch differences alone do not establish a gap.

Decisions live in the git-tracked `.upstream/ledger.md`, together with their rationale, upstream SHAs, local evidence, and revisit conditions. Its disposition definitions are authoritative. A proposed implementation stays deferred until verified on fork main. The reviewed checkpoint means every change through that point has been accounted for, not that every change was adopted. A fetched tip is not a reviewed checkpoint.

`status` reads the saved snapshot without fetching or writing. The review command only updates the ledger; it does not merge, cherry-pick, implement, create tickets, commit, or push. Ship any selected implementation separately and link its evidence back to the ledger. Keep unfinished reviews as partial batches without moving the checkpoint past unreviewed changes.

Tracking is temporary and optional. Use `pause` or `retire` when the upkeep no longer pays for itself as the fork diverges. Both retain the ledger and stop fetch/review work until an explicit `resume`; record the reason for each transition rather than deleting the history.

## Build the site

From `docs/`, install dependencies and build:

```text
npm ci
npm run build
```

The build regenerates the reference pages before Astro checks and builds the site. Run `npm run screenshots` when a committed documentation screenshot needs updating. The screenshot pipeline uses synthetic fixtures and isolated local services.

For plugin-specific contracts, read that plugin's `README.md` before changing a guide. Source changes and documentation changes should land together when the user-visible workflow changes.

See [release process](../release-process/) for publishing changes.
