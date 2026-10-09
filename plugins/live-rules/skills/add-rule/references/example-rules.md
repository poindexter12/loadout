# Example Rules

Copy and adapt these. Each example is one rule file in a native Claude Code rule directory, and
saving the file is the whole operation: there is no index to regenerate and no sync step to run.

Most examples below are project rules in `.claude/rules/`. Pick that destination only when the rule is
true of the repo for anyone who clones it; see "Personal rules" at the end for the other two layers.
The examples are illustrative, so swap in the real conventions of the project.

## Global rule

Create `.claude/rules/house-style.md`. Claude Code loads it at session start, in the main session and
in subagents; live-rules re-grounds it only after its content changes:

```markdown
---
description: House writing style
---
- No em dashes. Use commas, colons, parentheses, or periods.
- Prefer plain words over jargon. Write like a human, not a press release.
```

A higher priority global rule can go in `.claude/rules/commit-hygiene.md`:

```markdown
---
description: Commit and branch hygiene
priority: 5
---
- Never commit directly to main; branch first.
- Run the test suite before committing.
- Keep commits focused; one logical change per commit.
```

## Path scope

Create `.claude/rules/react-components.md`:

```markdown
---
description: React component conventions
paths: ["**/*.tsx", "**/*.jsx"]
---
- Function components with hooks only; no class components.
- No inline styles; use CSS modules.
- Co-locate the test as ComponentName.test.tsx next to the component.
```

Any SQL file, at any depth, can use `.claude/rules/sql-safety.md`. A pattern with no `/` matches the
basename anywhere in the repo:

```markdown
---
description: SQL safety
paths: ["*.sql"]
priority: 10
---
- Always use parameterized queries; never concatenate user input.
- Every destructive migration needs a tested down-migration.
```

A comma-separated scalar is also accepted and splits into independent patterns, with commas inside
`{}` left intact. This is two patterns, not three:

```markdown
---
description: TypeScript sources and docs
paths: "**/*.{ts,tsx}, docs/**"
---
- Public exports need a doc comment.
```

## Directory scope

`paths:` covers directories too, so there is no separate key. An entry with no glob metacharacter, or
one ending in `/`, names a directory and selects everything under it. Create
`.claude/rules/api-layer.md`:

```markdown
---
description: API layer rules
paths: ["packages/api", "services/gateway/"]
---
- Validate endpoints with the shared schemas in packages/api/schemas.
- Return the standard error envelope from packages/api/errors.ts.
```

Directory-style entries are also the only ones that can select on the session's cwd at prompt time.

## Prompt-keyword scope

A keyword rule needs the reserved never-match `paths:` sentinel. Without it, Claude Code sees a file
with no scope and loads it globally at every session start, which is exactly what a keyword rule must
not do. Write the sentinel verbatim. Create `.claude/rules/deploy-checklist.md`:

```markdown
---
description: Deploy checklist
paths: [".live-rules-never-match/**"]
prompt: ["deploy", "release", "ship to prod"]
---
- Confirm the staging smoke tests passed.
- Check the release plan before changing version fields.
- Record the rollout result after it completes.
```

A regex can cover both migration spellings in `.claude/rules/database-migration.md`:

```markdown
---
description: Database migration care
paths: [".live-rules-never-match/**"]
prompt: ["/migrat(e|ion)/i"]
---
- Write the migration and its rollback together.
- Run it against a copy of production-shaped data before merging.
```

Keyword rules are delivered by live-rules on `UserPromptSubmit`, so they do not reach subagents the
way natively loaded rules do.

## Combined scope

A rule with a real `paths:` scope and `prompt:` fires on either, so it needs no sentinel. Create
`.claude/rules/auth-high-risk.md`:

```markdown
---
description: Authentication is high-risk
paths: ["**/auth/**", "**/*auth*.ts"]
prompt: ["auth", "login", "session", "token"]
priority: 20
---
- Never log tokens, passwords, or session identifiers.
- All auth changes need a second reviewer.
- Use the existing session helpers in src/auth/session.ts.
```

## Include a live file

Create `.claude/rules/codebase-map-protocol.md`. The body is the protocol and `include:` is the live
payload:

```markdown
---
description: Codebase map protocol
include: .claude/.codebase-info/INDEX.md
---
This repo has a maintained codebase map. Read the relevant map document before exploring.
After changing code, assess whether the map needs updating.
```

If the map file does not exist, the rule stays silent. Any file can be included, but a compact hub such
as `INDEX.md` leaves room for the rule body and other matching rules.

## Periodic re-say in a long session

Most rules are said once and re-grounded only when they change. A rule that keeps getting forgotten
over a long session can opt into a periodic re-say, once every twenty user prompts. Use it sparingly;
it costs context every time it fires. Create `.claude/rules/no-force-push.md`:

```markdown
---
description: Never force-push a shared branch
reground: true
---
- Never force-push main or a branch someone else has pulled.
- Rewrite history only on your own unshared branch.
```

## Personal rules

The destination is a question about who the rule is true for.

**Personal to this clone** - `.claude/rules/local-paths.local.md`. Claude Code loads it because it
sits in that directory; a `.claude/rules/*.local.md` line in `.gitignore` is what keeps it out of git.
Confirm that line exists first. Promoting it later is a rename to `local-paths.md`:

```markdown
---
description: My local service endpoints
---
- The local API runs on port 8787, not the default 3000.
- Use the seeded database at ~/dev/fixtures/app.db for manual testing.
```

**Personal everywhere** - `~/.claude/rules/response-style.md`, in the user's own config tree, which
Claude Code reads in every project. Response format and length, voice, tone, punctuation, and
cross-project workflow habits always go here, never into a repo:

```markdown
---
description: How I want answers written
---
- Lead with the answer, then the reasoning. No preamble.
- No em dashes.
- Show the command you ran, not a description of it.
```

Live Rules never writes or reads `~/.claude/rules/`; Claude Code loads it on its own.

## Temporarily disabling a rule

There is no `enabled:` key, because Claude Code ignores unknown frontmatter keys and would load the
rule anyway. Keep the file and rename it:

```text
.claude/rules/strict-lint.md  ->  .claude/rules/strict-lint.md.off
```

Both readers discover only `*.md`, so the rename hides the rule from Claude Code and from live-rules at
once. Rename it back to re-enable it. `manage-rules` does this for you.
