---
name: manage-rules
description: >-
  Inspect, audit, enable, or disable project live-rules. Use to list rules, check active instructions,
  explain an injected rule, promote a personal rule, or audit the project's rule files.
---

# Manage Rules

Read, audit, and toggle live rules without changing what a rule says. For authoring or editing rule
content, use the `add-rule` skill. The full format is documented in
`../add-rule/references/rule-format.md`.

Rules are native Claude Code rule files: one rule per Markdown file in `.claude/rules/`. Claude Code
reads that directory itself, so the files are the whole store. There is no manifest, no index, and no
sync step, and nothing to recover: inspect the files directly and compute from them.

## Find the rules

1. List `.claude/rules/` and read every top-level `*.md` file. Each one should contain exactly one
   rule.
2. `<name>.local.md` is a rule like any other, personal to this clone. Note it as local storage and
   check that `.gitignore` carries a `.claude/rules/*.local.md` line; without it, a personal rule is
   being committed.
3. `<name>.md.off` is a disabled rule. Report it as disabled, not as missing.
4. A rule in a **subdirectory** of `.claude/rules/` loads natively but gets no live-rules timing, so
   it is never re-grounded mid-session. Report it and suggest moving it to the top level.
5. If `.claude/rules/` is absent or holds no `*.md` files, check for a retired store:
   `.claude/live-rules/` or a legacy `.claude/live-rules.md`. If either exists, report unmigrated
   storage and point at the migration command below. If neither exists, report that no rules are
   configured and point the user to `add-rule`.

`~/.claude/rules/` holds the user's own cross-project rules. Claude Code reads it in every project,
but live-rules never reads or writes it, so it is outside what this skill audits. Mention it only to
explain where a personal rule belongs.

### Migrating a retired store

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/migrate-rules.js" --project "${CLAUDE_PROJECT_DIR}"
```

Run `--dry-run` first and show the user what it would do. It moves the rule files into
`.claude/rules/`, rewrites `globs:`/`dirs:` to `paths:`, splits a legacy single file into per-rule
files, adds the `.gitignore` line to an existing `.gitignore`, and refuses on a filename collision
having written nothing.

## How to read the files

Inspect every top-level `*.md` file in `.claude/rules/`. Each must contain exactly one frontmatter
block and one body. Derive scope, priority, and cadence from the frontmatter the same way the hooks
do; there is no second copy of that metadata to compare against. A file with no complete frontmatter
block is one global rule whose body is the whole file.

## Tasks

### List the rules

Present a compact table. Use the `description` as the rule name, falling back to the filename:

| Rule | File | Scope | Fires when | Priority | State |
|------|------|-------|-----------|----------|-------|
| House style | `house-style.md` | global | loaded natively at session start; re-said when changed | 0 | on |
| React component conventions | `react-components.md` | paths | loaded natively on an edit to `**/*.tsx`; re-said when changed | 0 | on |
| API layer rules | `api-layer.md` | paths (directory) | editing under `packages/api`, or a matching cwd | 0 | on |
| Deploy checklist | `deploy-checklist.md` | prompt | prompt matches `deploy` | 0 | on |
| My local endpoints | `local-endpoints.local.md` | global, local | loaded natively; not committed | 0 | on |
| Strict lint gate | `strict-lint.md.off` | paths | nothing; disabled | 0 | **off** |

Derive scope the same way the hooks do: no `paths` and no `prompt` means global; otherwise list
whichever are present. A rule with only `include:` is still global. A `paths:` value of
`.live-rules-never-match/**` is the keyword sentinel, so report that rule's scope as prompt-only, not
as a path rule. Note any include payload and whether its target exists.

### Audit the rules

Report concrete, rule-specific issues and the exact fix:

- **A `prompt:` rule with no never-match sentinel.** A keyword rule whose `paths:` is absent is loaded
  globally by Claude Code at every session start, so its keyword trigger means nothing. It needs
  `paths: [".live-rules-never-match/**"]`.
- **Retired scope keys.** `globs:` or `dirs:` still fold into `paths:` for one release with a stderr
  notice, but Claude Code ignores them. Rewrite them to `paths:` or run the migration.
- **An `enabled:` key in frontmatter.** It does nothing: Claude Code ignores unknown keys and loads the
  rule regardless. Disabling is a rename to `.md.off`.
- **A personal rule that is not ignored.** A `*.local.md` file with no matching `.gitignore` line is a
  committed rule wearing a personal name.
- **A project rule that should be personal.** Response format and length, voice, tone, punctuation, and
  cross-project workflow habits belong in `~/.claude/rules/`, never in the repo.
- **A rule in a subdirectory**, which loads natively but is never re-grounded. Move it to the top
  level.
- **More than one rule in one file**, which the parser reads as separate fenced rules. Split it.
- **Broken or empty frontmatter** that the parser would skip, such as an unterminated array, a missing
  closing `---`, or no body.
- **A stray `---` inside a body**, which the parser reads as the next rule's fence. Suggest `***` or
  `___` instead.
- **`paths:` patterns that match nothing** in the repo. Compile the pattern and test it against tracked
  files before reporting it.
- **Invalid prompt regexes** written as `/.../flags`.
- **An `include:` target that does not exist.** A rule whose includes are all missing is dropped and
  injects nothing.
- **Duplicates or conflicts:** contradictory instructions or near-identical rules that should be merged.
- **Oversized rules:** a body long enough to crowd the roughly 10k-character injection budget.
- **Over-broad global rules** that should be scoped to a path or a prompt keyword.
- **`reground: true` on more than a couple of rules.** Each one costs context every twenty prompts.
- **Unmigrated storage:** a `.claude/live-rules/` directory or a legacy `.claude/live-rules.md` file.

Summarize findings as a short list of "rule: problem, suggested fix". Only change content if the user
asks; `add-rule` is the right tool for content rewrites.

### Disable or enable a rule

Disabling is a rename, not a frontmatter edit:

```text
disable:  .claude/rules/<name>.md      ->  .claude/rules/<name>.md.off
enable:   .claude/rules/<name>.md.off  ->  .claude/rules/<name>.md
```

Both Claude Code and live-rules discover only `*.md`, so the rename hides the rule from both at once
and keeps the content for later. Never write `enabled: false` into frontmatter: Claude Code ignores
unknown keys and would load the rule anyway. Leave other files untouched, and confirm which rule you
renamed and its new state. A disable takes effect on the next prompt or relevant edit.

### Promote a personal rule to the team

Promotion is also a rename:

```text
.claude/rules/<name>.local.md  ->  .claude/rules/<name>.md
```

The content does not change; the file stops being matched by the `.claude/rules/*.local.md`
`.gitignore` line and becomes a committed project rule. Before renaming, re-read the body and confirm
it is actually true of the repo for anyone who clones it, not just for this user. Tell the user the
file now needs committing.

### Explain what is active

Given a situation such as "for a normal prompt", "when I edit `src/app/page.tsx`", or "when I say
'deploy'", walk the rules and report which ones apply and who delivers them. Claude Code loads the rule
files itself, so most of the answer is native loading and live-rules only adds timing:

- **Global rules** (no `paths`, no `prompt`) are loaded natively at session start, in the main session
  and in subagents. live-rules records their hashes at SessionStart and emits nothing.
- **Path rules** are loaded natively on the first Read, Write, or Edit of a matching file. live-rules
  stays silent on that first touch, because that touch is native's load.
- **Either** is re-grounded by live-rules only once its content hash has changed, so an edited rule
  takes effect on the next prompt or relevant edit with no restart. A rule added mid-session is
  emitted, because its absence from a grounded ledger proves Claude Code never read it.
- **A summarizing compaction** re-grounds every applicable rule in full, because nothing re-reads the
  rule files at that boundary.
- **Keyword rules** are the one kind Claude Code cannot deliver on demand, so live-rules emits them on
  a matching prompt. That path does not reach subagents.
- **`reground: true`** adds a periodic re-say, once every twenty user prompts.

A rule carrying `include:` fires only if at least one included file exists; if all are missing it is
dropped. So "why did Claude follow this?" usually answers to native loading, and "why didn't it say it
again?" answers to an unchanged content hash.

## Guidelines

- **Read and toggle, not rewrite.** Send content changes to `add-rule`.
- **Toggle by rename.** Never write `enabled:` into a rule file.
- **The files are the store.** Compute everything from `.claude/rules/`; there is nothing to resync.
- **Verify before claiming.** Test a `paths:` pattern against the repo file list and inspect include
  targets.
- **Never touch `CLAUDE.md`** or `CLAUDE.local.md`.
- After a change, remind the user to review and commit the project rule files so the team stays in
  sync, and say plainly that `*.local.md` files are not committed.

## Success criteria

- [ ] `.claude/rules/` was listed and every top-level `*.md` file read
- [ ] `*.local.md`, `*.md.off`, and subdirectory rules are each reported for what they are
- [ ] An unmigrated `.claude/live-rules/` store or legacy file is reported with the migration command
- [ ] Rules are listed with file, scope, trigger, priority, and on/off state
- [ ] Audit reports real, rule-specific issues and tests `paths:` patterns against actual files
- [ ] A keyword rule missing the never-match sentinel is flagged
- [ ] Any disable, enable, or promote was done by renaming the right file, never via frontmatter
- [ ] `CLAUDE.md` is untouched
