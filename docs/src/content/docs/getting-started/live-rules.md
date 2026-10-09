---
title: Live Rules setup
description: Add project rules that Claude Code injects when they apply.
---

Live Rules keeps project instructions in front of Claude Code when they apply to a prompt or edit. Use it for conventions, guardrails, and reminders that should follow the project instead of relying on memory.

## Install

Run these in Claude Code from the project where the rules should live:

```text
/plugin marketplace add poindexter12/loadout
/plugin install live-rules@loadout --scope project
```

Reload plugins or start a new Claude Code session. If you use Quartermaster to set up a workspace, it can install and configure Live Rules as part of that setup.

## Where rules live

Rules are native Claude Code rule files: one rule per Markdown file in `.claude/rules/`. Claude Code reads that directory on its own, with or without this plugin, so the files are the whole store. There is no manifest, no index, and no sync step to run.

There are three layers, and which one a rule belongs in is a question about **who the rule is true for**:

| File | True for | Committed |
|------|----------|-----------|
| `.claude/rules/<name>.md` | this repo, for anyone who clones it | yes |
| `.claude/rules/<name>.local.md` | this repo, for you only | no, gitignored |
| `~/.claude/rules/<name>.md` | you, in every project | not in this repo at all |

Claude Code loads all three. Live Rules reads only the project directory, and never touches `~/.claude/rules/`.

A `.local.md` file is an ordinary rule to Claude Code; the `.local` in the name matters only because a `.claude/rules/*.local.md` line in `.gitignore` keeps it out of the repo. Check that line is there before you write one. Promoting a personal project rule to a team rule is a rename to `<name>.md`.

Response format and length, voice, tone, punctuation, and cross-project workflow habits go in `~/.claude/rules/`. They are about you, not about the project, and the repo is the one place such a rule would not follow you.

## Add your first rule

From the project directory, tell Claude what should happen and when:

> Add a rule that runs the linter before every commit.

Claude writes one Markdown file to the destination that matches who the rule is true for, and asks which one when that is not obvious. A rule file is frontmatter plus a body:

```markdown
---
description: Commit checks
paths: ["**/*.ts"]
---
- Run `npm test` before committing.
- Never commit directly to main; branch first.
```

`paths:` is Claude Code's own scope key. It takes a glob list or a comma-separated string, and a bare directory name such as `packages/api` selects everything under it, so it covers what the retired `globs:` and `dirs:` keys used to split. Saving the file is the whole operation.

## What Live Rules adds

Claude Code already loads these files, so Live Rules never says a rule twice. It contributes timing:

- A **global** rule (no `paths:`) is loaded natively at session start. A **`paths:`** rule is loaded natively on the first read or edit of a matching file. Both reach subagents that way, and Live Rules stays silent for both, because the rule is already in context.
- Live Rules **re-grounds a rule once its content changes**, so editing a rule takes effect on the next prompt or relevant edit with no restart. A rule you add mid-session is said once, since Claude Code never read it. A summarizing compaction re-grounds everything, because nothing re-reads the rule files at that boundary.
- A **keyword** rule (`prompt:`) is the one kind Claude Code cannot trigger on demand, so Live Rules delivers it when a prompt matches. Keyword rules carry the reserved never-match scope `paths: [".live-rules-never-match/**"]`, which stops Claude Code loading them globally instead. This delivery path is the prompt hook, so keyword rules do **not** reach subagents the way natively loaded rules do.
- `reground: true` opts one rule into a periodic re-say, once every twenty prompts, for something that keeps slipping in a long session. Off by default.

## Turning a rule off

Rename it:

```sh
mv .claude/rules/strict-lint.md .claude/rules/strict-lint.md.off
```

Claude Code and Live Rules both discover only `*.md`, so the rename hides the rule from both at once and keeps the content for later. Rename it back to switch it on again.

There is no `enabled:` frontmatter key. Claude Code ignores unknown keys, so a rule marked disabled in its frontmatter would still be loaded. Ask Claude to disable a rule and it does the rename for you.

## Migrating an older project

A project set up before Live Rules 2.13 keeps its rules in `.claude/live-rules/` with a generated manifest, or in a single `.claude/live-rules.md` file. Move it over once:

```sh
node plugins/live-rules/scripts/migrate-rules.js --project . --dry-run
node plugins/live-rules/scripts/migrate-rules.js --project .
```

Run the dry run first to see what it would do. The migration moves the rule files into `.claude/rules/`, rewrites `globs:`/`dirs:` to `paths:`, splits a legacy single file into one file per rule, adds the `.claude/rules/*.local.md` line to an existing `.gitignore`, and removes the retired store once the new one verifies. It refuses on a filename collision having written nothing, and it is idempotent, so re-running it is a no-op. Review and commit the resulting files so your team gets the same rules.

## Daily use

Tell Claude what you need:

> List and audit the live rules in this project.

> Which rules are active when you edit `src/api/client.ts`?

> Disable the strict lint rule for now.

> Promote my local test-command rule to a project rule.

Use `add-rule` when the instruction itself needs to change. Use `manage-rules` to list, audit, explain, disable, enable, or promote rules. Live Rules does not edit `CLAUDE.md`.

## If something stops working

- **A rule does not appear:** ask Claude to explain which rules are active for that prompt or file. It may be scoped to a different trigger, or Claude Code may already have loaded it, in which case Live Rules deliberately stays quiet rather than repeating it.
- **A rule is not re-said after you edit it:** re-grounding keys off the content hash, so a whitespace-only edit is still a change, but a rule in a **subdirectory** of `.claude/rules/` is never re-grounded. Live Rules scans only the top level. Move it up.
- **A disabled rule still applies:** check it was renamed to `.md.off` and not marked `enabled: false` in frontmatter, which does nothing.
- **A keyword rule fires on every session instead of on the keyword:** it is missing the never-match `paths:` sentinel, so Claude Code is loading it as a global rule. Ask Claude to audit the rules.
- **A personal rule got committed:** confirm `.gitignore` carries `.claude/rules/*.local.md`. Without that line a `.local.md` file is an ordinary tracked file.
- **No rules appear at all:** check whether the project still has a `.claude/live-rules/` directory or a `.claude/live-rules.md` file and run the migration above.
- **Rules worked earlier but stopped after installing or updating the plugin:** reload plugins or start a new session so Claude loads the current hooks.

The [generated Live Rules reference](../../reference/live-rules/) contains the agent-facing format and hook details.
