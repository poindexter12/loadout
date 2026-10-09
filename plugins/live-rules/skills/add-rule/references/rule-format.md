# Rule Format

A rule is one Markdown file in a native Claude Code rule directory. Claude Code reads those
directories itself, so a rule file is the store and live-rules only adds timing on top of it. There
is no manifest, no index, and no sync step: content hashes are computed from the files on every read.

## The three layers

| File | True for | Read by | Committed |
|------|----------|---------|-----------|
| `.claude/rules/<name>.md` | this repo, anyone who clones it | Claude Code natively, plus live-rules timing | yes |
| `.claude/rules/<name>.local.md` | this repo, this user only | Claude Code natively, plus live-rules timing | no, gitignored |
| `~/.claude/rules/<name>.md` | this user, in every project | Claude Code natively only | not in this repo |

A `.local.md` file is a rule like any other to both readers; the `.local` in the name means only that
`.claude/rules/*.local.md` in `.gitignore` keeps it out of the repo. Confirm that line exists before
writing one. Promoting a personal project rule to a team rule is a rename to `<name>.md`.

Live Rules never writes or reads `~/.claude/rules/`. Response format and length, voice, tone,
punctuation, and cross-project workflow habits belong there and are never project rules.

Scanning for live-rules timing is **non-recursive** and `*.md` only: just the top level of
`.claude/rules/`. A rule in a subdirectory still loads natively but is never re-grounded mid-session.

## A rule file

Exactly one frontmatter block and its body:

```markdown
---
description: React component conventions
paths: ["**/*.tsx", "**/*.jsx"]
priority: 10
---
- Prefer function components with hooks over class components.
- No inline styles; use CSS modules.
- Co-locate the test file next to the component.
```

A stable filename such as `react-components.md` is easier to maintain than a generated-looking name.
Saving the file is the whole operation.

A file with no complete frontmatter block is treated as one global rule whose body is the whole file.
Anything before the first `---` fence is ignored. A rule body must not contain a line that is exactly
`---`; use `***` or `___` for a horizontal rule. Parsing is fail-soft, so a malformed file degrades to
"skip that rule" and a missing directory produces no output.

## Frontmatter fields

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `description` | string | `""` | Human title shown when the rule is injected and in `manage-rules` listings. |
| `paths` | list of strings, or a comma-separated scalar | none | Scope. This is Claude Code's own key, so a scoped rule loads natively on a matching file touch. |
| `prompt` | list of strings | none | Prompt-keyword scope. Emitted when the submitted prompt matches a literal or `/regex/flags`. |
| `include` | string or list | none | Live file payload. Matching injections read these files fresh and append their contents. |
| `priority` | number | `0` | Higher numbers are injected first when several rules match. |
| `reground` | boolean | `false` | `true` re-says this rule once every 20 user prompts in a long session. |

Singular aliases are accepted for `prompt` (`prompts`, `keywords`) and `include` (`includes`).

**There is no `enabled:` key.** Claude Code ignores unknown frontmatter keys, so a rule marked
disabled in frontmatter would still load natively. Disabling is a rename to `<name>.md.off`, which
hides the file from Claude Code and from live-rules at once, because both read only `*.md`.

**`globs:` and `dirs:` are deprecated.** They still fold into `paths:` for one release, with a single
stderr notice per process, so an un-migrated rule keeps its scope instead of silently becoming
global. Claude Code ignores both keys, so never write them into a new rule. `paths:` subsumes them:
see "Directory-style patterns" below.

## Scope and cadence

Scope follows from the fields present. There is no separate `type` field:

- **Global:** no `paths` and no `prompt`. Applies to every prompt.
- **Path:** has `paths`. Applies to a matching file, and to a matching directory on prompts (see
  below).
- **Prompt-keyword:** has `prompt`. Applies when the submitted prompt matches.

A rule may declare more than one scope. Conditions are combined with **OR**.

Claude Code loads the rule files itself, so the cadence is about what live-rules adds, not about
delivery:

- A **global** rule is loaded natively at session start, in the main session and in subagents.
  live-rules records its hash at SessionStart and emits nothing.
- A **path** rule is loaded natively on the first Read, Write, or Edit of a matching file. live-rules
  stays silent on that first touch, because that touch *is* native's load, and records the hash.
- Either one is **re-grounded only when its content hash changes** after that, so editing a rule takes
  effect on the next prompt or relevant edit with no restart. A rule added mid-session is emitted,
  because its absence from a grounded ledger proves Claude Code never read it.
- A **summarizing compaction** re-grounds every applicable rule in full, because nothing re-reads the
  rule files at that boundary.
- A **keyword** rule is the one kind Claude Code cannot deliver on demand, so live-rules emits it on a
  matching prompt. That path is `UserPromptSubmit`, so it does not reach subagents.
- `reground: true` opts a rule into a periodic re-say, once every 20 user prompts. Turns, not elapsed
  time: an idle hour grows no context, twenty turns does. Off by default.

### The never-match sentinel

A keyword rule with no real path scope must declare this exact `paths:` value:

```yaml
paths: [".live-rules-never-match/**"]
```

Claude Code scopes a rule by `paths:` only, so a file without it is loaded globally at every session
start, which is exactly what a keyword rule must not do. The sentinel is a reserved directory name
this plugin owns and never creates, and both live-rules matchers short-circuit on that exact string,
so no real path can select the rule at any depth. Write it verbatim.

## Including a live file

`include:` is a payload, not a scope. When a matching rule fires, the current contents of each listed
file are read fresh and appended under an `--- included: <path> ---` block. If none of the files can be
read, the rule is dropped for that injection. Project-relative paths are resolved from the project
root; absolute and `~`-relative paths are also honored.

```markdown
---
description: Codebase map protocol
include: .claude/.codebase-info/INDEX.md
---
This repo has a maintained codebase map. Read only the relevant map document before exploring.
```

Included content counts against the same roughly 10,000-character injection budget as the rule body.
Point `include:` at a compact hub such as `INDEX.md`, not a giant document.

## `paths:` syntax

A `paths:` value is a YAML list, or a comma-separated scalar that splits into independent patterns.
Commas inside `{}` stay part of the pattern, so `paths: "**/*.{ts,tsx}, docs/**"` is two patterns, not
three. Comma splitting applies to `paths:` only, never to `prompt:` or `include:`, where a comma can be
part of a keyword or a regex quantifier.

Patterns match gitignore-style against the repo-relative path of the file being edited:

- A pattern with no `/` matches that name at any depth: `*.sql` matches `db/schema.sql`.
- A pattern containing `/` is anchored to the repo-relative path: `src/*.ts` matches `src/index.ts`
  but not `deep/src/index.ts`.
- Dotfiles are not excluded: `*.md` matches `.hidden.md`.

| Token | Meaning |
|-------|---------|
| `*` | Any run of characters within one path segment. |
| `**` | Any number of segments, including zero. |
| `?` | Exactly one non-`/` character. |
| `{a,b,c}` | Alternation. |

Trailing `**` also matches the bare directory. A leading `/` is accepted and ignored. POSIX character
classes, extglobs, numeric ranges, and nested braces are not supported. The pinned case table lives in
`test/matcher-conformance.test.js`.

### Directory-style patterns

A `paths:` entry is directory-style when it names a directory rather than a file pattern: it ends in
`/`, or it carries no glob metacharacter at all. `packages/api` and `services/worker/` both select
every file under that directory, which is what the retired `dirs:` key did. Directory-style entries
are also the only ones that can select on the session's cwd at prompt time; a wildcard pattern such as
`src/**/*.ts` stays a file pattern and never selects on cwd alone.

## Prompt-keyword syntax

A `prompt` entry is either a case-insensitive literal substring or a regex written as `/pattern/flags`.
An invalid regex is ignored and does not match.

## Keep rules small

All matching rules for one event share a context budget of about 10,000 characters. The hooks inject
higher-priority rules first and note when matching rules are held back. Keep each body to a few tight
lines, use `priority` for the important rules, and split unrelated guidance into separate files.

## Migrating an old store

A project still holding a pre-2.13 `.claude/live-rules/` store, or a legacy `.claude/live-rules.md`
single file, is migrated with the plugin-owned script:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/migrate-rules.js" --project "${CLAUDE_PROJECT_DIR}"
```

It moves the rule files into `.claude/rules/`, rewrites `globs:`/`dirs:` to `paths:`, splits a legacy
single file into per-rule files, adds the `.claude/rules/*.local.md` line to an existing `.gitignore`,
and removes the retired store once the new one verifies. It refuses on a filename collision having
written nothing, it is idempotent, and `--dry-run` reports what it would do without writing.

`LIVE_RULES_PATH` is no longer a store: the hooks read `.claude/rules/` and nothing else. The
migration still honors the variable when it looks for a relocated legacy single file to convert, so a
project that set it should keep it until the migration has run, then drop it.
