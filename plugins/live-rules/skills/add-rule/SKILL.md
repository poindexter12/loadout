---
name: add-rule
description: >-
  Create or edit a project rule file in Claude Code's native rule directory, kept current in context
  by live-rules. Use to add a rule, coding guideline, guardrail, convention, or automatic reminder.
---

# Add Rule

Turn a request like *"always run the linter before committing"* or *"when editing `*.tsx`, prefer
function components"* into a **rule**: one Markdown file in a native Claude Code rule directory.

Claude Code reads those files itself. Live Rules owns no storage; it adds timing on top of them, so
an edited rule takes effect mid-session and a keyword-scoped rule fires on a matching prompt.

Read `references/rule-format.md` for the full frontmatter spec and `references/example-rules.md` for
ready-to-adapt examples before writing a rule.

**Do not edit `CLAUDE.md`** or `CLAUDE.local.md`. Rule files are the delivery mechanism.

## Step 1: Choose the destination

Decide where the rule goes before writing it, and ask one short question when the answer is not
obvious. The destination is a question about **who the rule is true for**, never about what is
installed.

| True of... | Destination | Committed |
|------------|-------------|-----------|
| this repo, for anyone who clones it | `.claude/rules/<name>.md` | yes |
| this repo, for this user only | `.claude/rules/<name>.local.md` | no, gitignored |
| this user everywhere | `~/.claude/rules/<name>.md` | not in this repo at all |

- **Project rule** - `.claude/rules/<name>.md`. The project's stack, conventions, tooling, and test
  commands. Commit it so the whole team gets the same guidance.
- **Personal to this clone** - `.claude/rules/<name>.local.md`. A local path or a habit confined to
  this one project. Claude Code loads it because it sits in that directory; a
  `.claude/rules/*.local.md` line in `.gitignore` is the only thing keeping it out of git. Confirm
  that line exists before choosing this destination and offer to add it when it does not, because
  without it the file is a committed rule wearing a personal name. Promoting it later is a rename to
  `<name>.md`.
- **Personal everywhere** - `~/.claude/rules/<name>.md`, in the user's own config tree, which Claude
  Code reads in every project. **Response format and length, voice, tone, punctuation, and
  cross-project workflow habits are always this row.** They are never project rules, so never write
  them into the repo however strong this project's evidence looks: the evidence is about the user,
  and the repo is the one place the rule would not follow them.

Live Rules never writes or reads `~/.claude/rules/`. A rule placed there is Claude Code's alone to
load; this skill's job is to put the instruction in the right file.

## Step 2: Understand the rule

Pin down two things from the user's request:

1. **The instruction** itself: what should Claude do, prefer, or avoid? Keep it concrete and testable
   (*"use `httpx`, not `requests`*) rather than vague (*"write good code"*).
2. **When it applies** (the scope). Listen for the trigger in how they phrase it:

| The user says... | Scope | Frontmatter |
|------------------|-------|-------------|
| "always", "in general", "house style", no condition | **global** | no scope fields |
| "when editing / for / in *.tsx", a file type, path, or directory | **path** | `paths:` |
| "when I ask about / mention deploy/migration/auth" | **prompt-keyword** | `prompt:` plus the never-match sentinel |

`paths:` is Claude Code's own scope key, and it covers what the retired `globs:` and `dirs:` keys
used to split: a bare directory name such as `packages/api` selects everything under it. `globs:`
and `dirs:` still parse for one release with a deprecation notice on stderr, but never write them
into a new rule.

**Keyword-only rules need a never-match path scope.** A rule with `prompt:` and no real path scope
must carry this exact value:

```yaml
paths: [".live-rules-never-match/**"]
```

Without it, Claude Code sees a file with no `paths:` and loads it as a global rule, so the keyword
trigger would mean nothing. Live Rules recognises that exact string, never matches it against a real
path at any depth, and keeps delivering the rule on a keyword match. Write it verbatim; do not invent
a variant.

A rule may combine a real `paths:` with `prompt:`; it is injected when either condition matches. If
you are unsure whether something is global or scoped, ask one short question rather than guessing,
because an over-broad rule adds noise.

**Including a live file.** If the request is "load my codebase map", "keep `<file>` in front of
you", or "inject the contents of `<file>`", use the `include:` field, not a scope. Add
`include: <path>` and write the body as the protocol for using that file. The file is read fresh each
time the rule is injected, and a missing include makes the rule silent. A pure-include rule is global.
See the "Including a live file" section of `references/rule-format.md`.

## Step 3: Write the file

Create or edit one file at the destination chosen in Step 1. Use a stable, descriptive filename such
as `commit-checks.md`. A rule file contains one frontmatter block, one body, and one concern:

```markdown
---
description: Short human title (also shown as the rule's heading when injected)
paths: ["**/*.tsx"]     # include only the scope fields that apply; omit the rest
priority: 0             # optional; higher injects first (default 0)
reground: true          # optional; re-say this rule every 20 prompts in a long session
---
- Write the rule body as tight, imperative bullet points.
- One concern per file; add another rule file rather than overloading this one.
```

Saving the file is the whole operation. There is no index to regenerate and no sync step to run:
Claude Code and the hooks both read the directory, and content hashes are computed on every read.

Only `*.md` at the top level of `.claude/rules/` gets live-rules timing. A rule in a subdirectory
still loads natively but is never re-grounded mid-session, so keep new rules at the top level.

There is no `enabled:` key. Disabling a rule is a rename to `<name>.md.off`, which hides it from
Claude Code and from the hooks at once. Use `manage-rules` for that.

A project still holding a pre-2.13 `.claude/live-rules/` store or a legacy `.claude/live-rules.md`
file should be migrated before new rules are added, with the plugin-owned migration script run from
the project root:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/migrate-rules.js" --project "${CLAUDE_PROJECT_DIR}"
```

It moves the rule files to `.claude/rules/`, rewrites `globs:`/`dirs:` to `paths:`, splits a legacy
single-file store into per-rule files, and adds the `.claude/rules/*.local.md` line to an existing
`.gitignore`. It refuses on a filename collision having written nothing, and is idempotent. Pass
`--dry-run` first to show the user what it would do.

Guidelines for a good rule:

- **Imperative and concrete.** "Do X", "Never Y", with a real symbol, path, or command where possible.
- **Short.** Injected context is capped at about 10k characters across all matching rules, so keep each
  body to a handful of lines. Long rationale belongs in a linked doc.
- **Atomic.** One concern per file. It keeps scoping precise and lets the user disable just that one.
- **No bare `---` in the body.** A line that is exactly `---` would be read as another rule's fence.
  Use `***` or `___` for a horizontal rule inside a body.
- **`paths:` patterns are gitignore-style:** a pattern with no `/` (like `*.sql`) matches that name at
  any depth; a pattern containing `/` (like `src/**/*.ts`) is anchored to the repo-relative path.

## Step 4: Validate

Before finishing:

- Confirm the destination matches who the rule is true for, and that a `.local.md` choice has its
  `.gitignore` line.
- Confirm any `paths:` patterns correspond to files that exist, or clearly will, in this repo. If a
  pattern matches nothing, say so.
- If a `prompt` entry is a `/regex/flags`, make sure it is valid.
- Confirm a keyword-only rule carries the never-match `paths:` sentinel exactly as written above.
- Re-read the body: is it short, concrete, and free of contradictions with the other rules? Skim them
  for overlap or conflicts.
- Make sure the frontmatter fences are intact and the file contains exactly one rule.

## Step 5: Confirm

Tell the user what you added: the rule's title, the file it went in, the scope, and a one-line
summary. Explain the cadence honestly:

- Claude Code loads project and personal rule files itself, so a global rule and a `paths:` rule are
  already in context without live-rules saying anything. Those reach subagents too.
- Live Rules re-grounds a rule when its content hash changes, so editing a rule takes effect on the
  next prompt or relevant edit with no restart, and re-grounds everything after a summarizing
  compaction.
- A keyword rule is the one kind Claude Code cannot deliver on demand, so live-rules emits it when a
  prompt matches. That path does not reach subagents.

For a committed project rule, remind them to review and commit the file so the team shares it. For a
`.local.md` or `~/.claude/rules/` rule, say plainly that it is not committed. They can disable any
rule by renaming it to `.md.off` or by asking `manage-rules`.

## Guidelines

- **Never touch `CLAUDE.md`** or `CLAUDE.local.md`.
- **Destination before content.** Who the rule is true for decides the file; get that right first.
- **One concern per file.** Prefer several small rules over one large one.
- **Scope tightly.** Global rules apply everywhere, every session; reserve them for instructions that
  truly apply everywhere.
- **Don't leak secrets.** A rule can say where config lives, never actual credential values.

## Success criteria

- [ ] A new or edited rule file exists at the destination chosen in Step 1
- [ ] Personal style, voice, tone, punctuation, and cross-project habits went to `~/.claude/rules/`,
      not into the repo
- [ ] A `.local.md` destination was confirmed against a `.claude/rules/*.local.md` `.gitignore` line
- [ ] The rule has a `description`, the correct scope fields, and a concise body
- [ ] A keyword-only rule carries the exact never-match `paths:` sentinel
- [ ] Scope is verified (`paths:` patterns match real paths; any regex compiles)
- [ ] The rule file parses as exactly one rule with intact fences and no stray `---` in its body
- [ ] User told the rule's title, its file, when it fires, and what reaches subagents
- [ ] `CLAUDE.md` is untouched

## References

- `references/rule-format.md` - full frontmatter spec, the three rule layers, native loading, cadence, scope semantics, and `paths:` syntax
- `references/example-rules.md` - copy-and-adapt examples for each scope type and destination
