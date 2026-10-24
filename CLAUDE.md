# Loadout — project rules

## Documentation stays current, and an agent owns that

Most of what this repo ships is read by agents, not by people. An orchestrator or executor mid-run never opens the docs site; it learns what is true from tool schemas, refusal messages, briefings, skill text, and live-rules. So a change has two audiences, and they are not equally expensive to get wrong.

1. **Agent-facing surfaces** (MCP tool schemas and descriptions, refusal and guidance strings, briefing text, agent/skill definitions, CLI help, live-rules): these are the contract. An agent acts on them immediately, so drift here costs a dispatch every time it is hit. Update them IN the same change, never as a follow-up ticket. If a behavior changed and the string that tells an agent about it did not, the change is not done. When a value is enumerated in code, that enum is the source of truth and every surface repeating it must be checked against it.

2. **Generated pages** (`docs/src/content/docs/reference/`): built by `docs/scripts/generate-reference.mjs` from plugin manifests, SKILL.md frontmatter, hooks.json, and the marketplace file. NEVER hand-edit these — they regenerate on every docs deploy, and the deploy workflow triggers on plugin manifest/skill/hook changes, so they cannot drift. If a generated page is wrong, fix the generator or the source manifest.

3. **Prose pages** (getting started, setup guides, observability, architecture): written for a human reading about the system, not for an agent operating it. These are maintained BY THE AI AGENT working the change: any ticket that alters observable behavior — a new or renamed skill, a changed setup flow, new config, a new dashboard section, changed CLI surface — updates the affected page(s) under `docs/src/content/docs/` in the same story, or files a linked `docs-writing` ticket on the board before the ship closes. A behavior change whose docs ticket doesn't exist is not done. Stale prose is a correctness bug, but it is not an outage; do not let it outrank a drifting agent-facing surface.

When shipping (orchestrator publish flow), the integration checklist includes: "does this change what an agent is told, or what a human reads? → agent-facing strings updated in this change, prose docs updated or docs ticket filed."

## Upstream tracking

Use the project-local `/upstream-check` skill (`.claude/skills/upstream-check/SKILL.md`) and `.upstream/ledger.md` for upstream comparisons. Review the intent and local need, not just patch differences; an independent solution can satisfy the same requirement. Record adoption evidence in the ledger when implementing a tracked change, but mark it integrated/adapted only once verified on fork main. Tracking is optional and may be paused or retired as the fork diverges; preserve the ledger and honor its tracking mode.

## Release guidance

Conditional release and manifest rules live in `.claude/rules/`. They are injected for matching manifest edits and release-related prompts.

## Screenshots

Documentation screenshots come ONLY from the committed pipeline (`docs/screenshots/`, `npm run screenshots`), which renders isolated, synthetically-seeded instances. Never screenshot live boards or dashboards for docs — real project names, session ids, and costs must never appear in committed imagery. Ad-hoc verification captures are gitignored (`/*.png`, `.playwright-mcp/`); keep them out of commits.

## File writes

Use the Write and Edit tools for file changes rather than `cat >` or `cat >>` redirection: shell redirection is not allowlisted here, and allowlisting it would auto-approve writes to any path.

## Context is not a reason to stop

Autocompact is on. A long session summarizes itself and keeps going, so running low on context is a normal condition, not a blocker and not an event worth narrating.

Do not stop work, wind down, or offer to hand off because context is running out. Do not ask whether to write a handoff — if a handoff is wanted it will be asked for, by name or with `/remember`. Context-usage warnings in tool output are for your own pacing: keep exploration tight and prefer reading summary lines over dumping whole files, then carry on with the task.

Keep working until the work is done, the user redirects, or something genuinely blocks it — a failing check, a missing credential, a decision only the user can make. Those are worth surfacing. Remaining tokens are not.

## Platform support

Windows is abandoned as a supported platform (decision 2026-09-15).

Windows CI was removed from the test matrix 2026-09-15 (PR #11); the matrix is ubuntu-only.

The `WIN` code paths in model-gateway (`lib/process-supervision.js`: taskkill, PowerShell CIM queries, netstat parsing) are unmaintained and unverified — do not write Windows fixes or Windows tests.

Deleting the dead `WIN` branches and Windows-simulation tests is a welcome follow-up ticket, not required now.
