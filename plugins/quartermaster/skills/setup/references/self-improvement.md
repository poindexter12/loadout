# The self-improvement loop

Use a global live rule to notice useful improvements during the requested work, not to start
unrequested work. Offer `/quartermaster:resupply` for a deeper review when the evidence warrants it.
An offer needs no round approval; running the round, including transcript mining, does.

## Install this atomic rule

For an approved new setup, derive a project-specific rule at
`.claude/live-rules/rules/self-improvement.md`, global scope, `priority: 40`. Include its path,
SHA-256 hash, and frontmatter metadata in `.claude/live-rules/manifest.json` as described in
`rule-templates.md`. Preserve existing rules; do not refresh them from this template without approval.

```markdown
---
description: Self-improvement within the approved scope
priority: 40
---
- Notice repeated manual work, missing checks, re-derived knowledge, and unclear conventions while
  doing the requested work. These are leads to discuss, not permission to build or edit anything.
- Check project code, native platform features, the standard library, and installed dependencies,
  plugins, and skills before proposing another capability. Reuse what works; improve an existing
  capability when evidence shows a gap. A missing check need not become a new measurement skill.
- Keep improvements within the approved scope. Show the proposed change and get per-item approval
  unless explicit standing permission covers that exact class of change. Leave unrelated cleanup alone.
- At a useful pause, offer `/quartermaster:resupply`. Before running the round or mining transcripts,
  require current user approval or explicit standing permission for these rounds. Round approval
  does not authorize unrelated edits; recommendations still need their own approval as above.
- If existing capabilities suffice, say so when reviewing them. Do not invent an improvement quota.
```

## Injection and fallback

Live Rules tracks each rule's path and content hash per session. SessionStart re-grounds applicable
rules; later prompts and edits inject newly matching or changed rules. Unchanged rules do not repeat
on every prompt or edit when the session ledger is available. Without a session id or usable ledger,
repeated grounding is possible.

Quartermaster's SessionStart hook supplies a condensed charter only when the exact
`.claude/live-rules/rules/self-improvement.md` path is absent. Its presence suppresses that fallback;
the hook does not inspect whether the seeded rule is enabled. Both forms offer improvements without
authorizing them. Seeding content adds no new background process or hook.

## Choose the smallest useful response

| Evidence from the work | Check before proposing a change |
| --- | --- |
| A claim cannot be verified | Existing tests, validation commands, benchmarks, or native tooling; name their limits |
| A repeated manual workflow | Project scripts and installed plugins or skills; improve the existing workflow if possible |
| Knowledge keeps being re-derived | The relevant codebase-map entry or `CLAUDE.md` section |
| A convention is repeatedly clarified | Existing project rules and the narrowest applicable scope |

A new instrument is an option only when existing checks cannot answer the actual question. Explain
that gap and propose a reproducible check with its limitations. Do not turn a single inconvenience
into a permanent tool by default. Required project verification remains required whether or not a
resupply round is approved.

## The deeper round

Point users to `/quartermaster:resupply` in the setup handover. An explicit invocation requests a
round; a seed, hook nudge, or natural pause only suggests offering one. After current or explicit
standing round approval, resupply mines a bounded aggregate, reads the user's goals, checks past
decisions, and proposes evidenced changes. The round is not blanket permission to install plugins,
edit rules, or change settings. Follow the skill's per-item approval and recording steps.
