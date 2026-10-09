# Live Rules

Live Rules keeps project instructions in front of Claude Code when they apply to a prompt or edit. Use it for conventions, guardrails, and reminders that should follow the project instead of relying on memory.

[Setup guide](https://poindexter12.github.io/loadout/getting-started/live-rules/) · [Generated reference](https://poindexter12.github.io/loadout/reference/live-rules/) · [Loadout marketplace](../../README.md)

## Install

Run these in Claude Code from the project where the rules should live:

```text
/plugin marketplace add poindexter12/loadout
/plugin install live-rules@loadout --scope project
```

Reload plugins or start a new Claude Code session. The workspace setup flow can also install and configure Live Rules.

## Add a rule

Tell Claude the instruction and when it applies:

> Add a rule that runs the linter before every commit.

Rules are native Claude Code rule files: one rule per Markdown file in `.claude/rules/`, scoped by a `paths:` glob list or a `prompt:` keyword list. Claude Code reads that directory itself, so the files are the whole store. There is no manifest, no index, and no sync step, and content hashes are computed from the files on every read. The `add-rule` skill reads the format and examples before authoring.

Live Rules owns no storage. It adds timing to the files Claude Code already loads:

- Claude Code loads a global rule at session start, and a `paths:` rule on the first edit of a matching file, in the main session and in subagents. Live Rules stays silent on both, because the rule is already in context.
- Live Rules re-grounds a rule once its content hash changes, so editing a rule takes effect on the next prompt or relevant edit with no restart. A rule added mid-session is said once, and a summarizing compaction re-grounds everything, since nothing re-reads the rule files at that boundary.
- A `prompt:` keyword rule is the one kind Claude Code cannot deliver on demand, so Live Rules emits it when a prompt matches. Keyword rules carry the reserved never-match scope `paths: [".live-rules-never-match/**"]` so Claude Code does not load them globally instead. That delivery path does not reach subagents.
- `reground: true` opts a rule into a periodic re-say, once every twenty user prompts. Off by default.

Three destinations, chosen by who the rule is true for. `.claude/rules/<name>.md` is a committed project rule; `.claude/rules/<name>.local.md` is personal to one clone, kept out of git by a `.claude/rules/*.local.md` line in `.gitignore`; `~/.claude/rules/<name>.md` is personal to the user in every project, and Live Rules never reads or writes it. Response style, voice, tone, punctuation, and cross-project workflow habits belong in that last one, never in a repo.

Disable a rule by renaming it to `<name>.md.off`, which hides it from Claude Code and from Live Rules at once. There is no `enabled:` key, because Claude Code ignores unknown frontmatter keys and would load the rule anyway.

A project still holding a pre-2.13 `.claude/live-rules/` store, or a legacy `.claude/live-rules.md` single file, is moved over once with the plugin-owned migration:

```text
node plugins/live-rules/scripts/migrate-rules.js --project <dir> [--dry-run]
```

It rewrites `globs:`/`dirs:` to `paths:`, splits a legacy single file into per-rule files, adds the `.gitignore` line to an existing `.gitignore`, and refuses on a filename collision having written nothing. It is idempotent, so re-running it is a no-op.

## Daily use

Tell Claude what you need:

> List and audit the live rules in this project.

> Which rules are active when you edit `src/api/client.ts`?

> Disable the strict lint rule for now.

Ask Claude to add or edit rule content with `add-rule`. Use `manage-rules` to list, audit, explain, disable, enable, or promote rules. Live Rules does not edit `CLAUDE.md`.

## If something stops working

Tell Claude the symptom and ask it to audit the live rules. The audit reads `.claude/rules/` directly. Common answers: the rule is disabled (`.md.off`), it sits in a subdirectory so it loads natively but is never re-grounded, it is a keyword rule missing the never-match `paths:` sentinel and so is loading globally instead, or its content has not changed since Claude Code loaded it, which is why Live Rules has not said it again. If rules still live in `.claude/live-rules/`, run the migration above, then reload plugins or restart Claude Code after an install or update.

The migration writes and removes tracked project files, including a `.gitignore` line. Review those changes before committing.

## License

MIT
