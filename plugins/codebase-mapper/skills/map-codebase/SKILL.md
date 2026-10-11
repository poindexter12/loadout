---
name: map-codebase
description: >-
  Create a self-maintaining codebase map in .claude/.codebase-info/. Use to map, document, analyze,
  or onboard a codebase, including a new project.
---

# Map Codebase

Generate a codebase map as a collection of **atomic documents** in `.claude/.codebase-info/`. Each
document covers one aspect of the project, so the map stays easy to read, update, and navigate. The
map is written for the next Claude session (and the next human): it is grounding context, not
marketing.

Loading is automatic and you don't have to wire anything up: this plugin ships a `SessionStart`
hook that injects the map at the start of each session, so Claude starts oriented and keeps
consulting and updating it as work goes on. **Never edit `CLAUDE.md`.** The hook is the only loading
mechanism; leave `CLAUDE.md` alone. Your job is just to write the docs in `.claude/.codebase-info/`.

## Output

```
.claude/.codebase-info/
├── INDEX.md                # Navigation hub + how-to-use; the hook injects this at session start
├── architecture.md         # System overview, components, boundaries, data flow
├── tech-landscape.md       # Languages, frameworks, runtimes, infra, source-of-truth files
├── directory-structure.md  # Annotated folder tree                      (classic mode only)
├── entry-points.md         # Where execution starts (routes, CLIs, jobs) (classic mode only)
├── modules.md              # Key modules/packages: purpose, deps, exports (classic mode only)
├── communication.md        # APIs, events, queues, external integrations   (if applicable)
├── database.md             # Schema, relationships, migrations              (if applicable)
├── dependencies.md         # Categorized packages                           (if applicable)
├── patterns.md             # Recurring patterns, error handling, testing, config
├── coding-style.md         # Conventions derived from linters + existing code
├── docker.md               # Containers / local dev environment             (if applicable)
├── onboarding.md           # Quick start + common tasks
└── .map-state.json         # Machine state (last-mapped commit + date) for staleness checks
```

**This list is a menu, not a checklist.** Create only the documents that earn their place in *this*
codebase, and feel free to go beyond the list when a project has a major aspect the standard docs do
not cover. Two directions:

- **Omit what does not apply.** Skip `database.md` if there's no datastore, `docker.md` if there are
  no containers, `dependencies.md` if there's no dependency manifest, and so on. A tiny project might
  only need `INDEX.md`, `architecture.md`, `tech-landscape.md`, and `onboarding.md`.
- **Skip what graphify owns.** In graph mode (Step 0b) the three documents marked *classic mode only*
  are not written at all: the graph is the structural answer, and a hand-written copy of it would only
  go stale. See **Graph mode** in Step 0b for the full list of what changes.
- **Add what the project actually warrants.** If a major aspect deserves its own doc and none of the
  standard names fit, create one (e.g. `ml-pipeline.md` for a training/inference flow, `cli-reference.md`
  for a tool with many subcommands, `realtime.md` for a websocket/event core, `iac.md` for substantial
  infrastructure-as-code). List any such doc in `INDEX.md` and in the state file the same as the rest.

The test for every doc, standard or not, is the same: would a future session be meaningfully faster
for having it? If yes, write it; if not, leave it out.

## Process

### Step 0 : Assess project state (decide the path)

Once a map exists, the plugin's session context tells the main session to assess the map after code
changes and invoke `update-codebase-map` immediately when documentation work is warranted. It does not
wait for a separate user approval. A genuine no-op ends with no map edit or state refresh. This initial
mapping skill creates the starting map; use `update-codebase-map` for later assessments.

Get the lay of the land first, then pick a path:

- Count real source files, ignoring noise (`.git/`, `node_modules/`, `vendor/`, `dist/`, `build/`,
  `target/`, `.venv/`, `__pycache__/`, `.next/`, lockfiles, generated code, minified assets).
- Roughly size the project (file count, lines, number of top-level areas).

Then branch:

- **Existing project with real code → assess and map it inline by default.** For a larger remap or a
  small or medium initial map, use the optional Sidequest handoff below when its live contract is
  available; otherwise continue inline with Steps 1–8.
- **Greenfield (empty repo, scaffold only, or just a spec/README) → seed mapping inline.** Jump to the
  **Greenfield projects** section below, then do Step 8. Do not file a mapping ticket for this.
- **Large codebase (hundreds+ of source files) → use the optional large-repo handoff below when
  Sidequest is available.** Otherwise parallelize inline as described there, then complete Steps 7–8.

Also check today's actual date (it's provided in the session context, or run `date`) so the
"Last Updated" stamps are real, not placeholders.

### Step 0b : Check for graphify (decide who owns structure)

`graphify` turns a repo into a queryable knowledge graph. Where it has already built one, it owns the
structural half of the map and this skill stops hand-writing it. Two cheap checks:

- `command -v graphify` : is the CLI installed?
- `graphify-out/GRAPH_REPORT.md` at the project root : has a graph already been built here? That file,
  and only that file, puts a project in **graph mode**. The plugin's hooks read the same path
  (`hooks/lib/graph-mode.js`), so the skill and the hooks can never disagree.

| `graphify` CLI | `graphify-out/GRAPH_REPORT.md` | Path |
|----------------|--------------------------------|------|
| present | exists  | **Graph mode.** Apply the rules below. |
| present | missing | Offer the first build. Accepted → graph mode; declined → classic mode. |
| absent  | —       | **Classic mode.** Say once: `graphify is not installed; quartermaster setup can install it.` Then map exactly as this skill always has. |

Graph mode is **opt-in**. It is never a prerequisite and it is never assumed: with no CLI and no report
this skill behaves exactly as it did before, and a complete map is still the result.

#### Offering the first build

Ask first; never build a graph unprompted, and state the cost honestly:

- The structural pass over **code** is AST only : deterministic, free, and fast.
- The semantic pass over **docs, papers and images** runs on *this session's LLM*, so a repo with a
  large `docs/` tree costs real tokens. A code-only corpus skips that pass entirely and costs nothing.

If the user accepts, run the build through graphify's own route: its `graphify` skill when this session
has one, otherwise `graphify extract .` headless against its own backend. Then offer
`graphify hook install` once, and say what it buys: a post-commit/post-checkout rebuild that is
deterministic and uses **no LLM**, which is what keeps structure fresh afterwards. `graphify hook status`
reports whether it is already installed, and is safe to run read-only.

If the hook is declined, say what that costs: nothing refreshes the graph, so structure drifts until
someone runs the documented refresh, `graphify update .`, by hand. That re-extracts code only and needs
no LLM either.

**Never run `graphify claude install`.** It writes a graphify section into `CLAUDE.md` plus its own
PreToolUse hook. This skill's "never touch `CLAUDE.md`" rule covers that command explicitly: this
plugin's SessionStart hook is already the loading mechanism, and nothing here may add, edit, or remove
anything in `CLAUDE.md`.

#### Graph mode : what changes

| Step | In graph mode |
|------|---------------|
| Step 2 (directory structure) | Do not write `directory-structure.md`. Read enough of the tree to orient yourself, nothing more. |
| Step 3 (entry points) | Do not write `entry-points.md`. Ask the graph instead. |
| Step 4 (key flows) | Trace flows with `graphify query` and `graphify path` rather than walking the tree by hand. |
| Step 5 (dependencies) | **Unchanged.** `dependencies.md` comes from package manifests, not from the AST. |
| Step 7 (write the docs) | Do not write `modules.md`. Every other warranted document is written as normal. |
| Step 8 (record state) | Run the state writer with `--structure graphify`, so it records `structure: "graphify"`, and add the `graphify-out/` ignore rules. |

Everything else stays LLM-authored: `architecture.md`, `tech-landscape.md`, `patterns.md`,
`coding-style.md`, `onboarding.md`, and the rest are judgement, not structure, and a graph cannot write
them. The split is the whole point: **structure questions go to the graph, convention questions go to
these docs.**

### Optional Sidequest handoff for an existing project

Use this handoff only when a small or medium initial map or a larger remap benefits from a bounded
shared-tree artifact writer. Inspect the session tool roster before doing mapping reads. Sidequest is
optional: the standalone path above and the inline fallback below remain valid.

The handoff is available only when the normal native `Agent` tool and Sidequest's `category_list`,
`add`, `comment`, `dispatch`, and `pulse` tools are present. Do not probe the Sidequest CLI or
dashboard. Read the live `codebase-exploration` category with `category_list`; delegate only when it is
enabled and its live contract permits one bounded documentation-artifact write. The required contract
language is that project source remains read-only while a ticket may explicitly name one bounded
documentation artifact directory as its only write scope.

- When the tools are absent, continue inline without an error banner.
- When Sidequest is present but the category is missing, disabled, or still says `no edits`, continue
  inline and tell the user: `Sidequest is loaded, but its live taxonomy cannot accept map artifacts yet.`
- When the category is ready, create one artifact ticket for a small or medium initial map. Use category
  `codebase-exploration`, `files: [".claude/.codebase-info/"]`, and this exact carve-out:
  `Artifact write carve-out: write only .claude/.codebase-info/**; all project source is read-only.`

Record the starting `HEAD` (or `null` outside Git) and the initial working-tree status outside
`.claude/.codebase-info/` in the ticket. Its deliverable is warranted atomic docs, a compact linked
`INDEX.md`, and a final `.map-state.json` with exact document hashes. Tell the writer to inspect the
current shared tree; skip generated, vendor, and secret material; verify every cited path; never touch
`CLAUDE.md`; and never invoke `map-codebase` again or create nested mapping tickets.

In graph mode, the ticket instructions must carry the graph-mode rules from Step 0b: the writer does
not write `directory-structure.md`, `entry-points.md`, or `modules.md`; it uses
`graphify query|explain|path` as its structural input; and its final `.map-state.json` carries
`structure: "graphify"`. The writer never builds or refreshes a graph, never runs `graphify hook install`,
and never runs `graphify claude install`.

Include this lifecycle marker verbatim:

```text
Shared-tree artifact mode: leave the generated map as working-tree output; verify, comment, and close with done. Do not commit, submit, push, or edit source.
```

The invoking parent session verifies the generated paths and state after the writer closes, then commits the map if its flow permits.

Before dispatch, post this reason as a ticket comment:

```text
Shared-tree dispatch is required because the map must describe the current working tree, including intentional uncommitted source, and the generated .claude/.codebase-info/** files must remain visible to the invoking session.
```

Dispatch with `{ sharedTree: true }`. Pass every returned spawn field to the native `Agent` unchanged.
Then end the turn and resume only on the native completion notification. Do not poll or start a proxy
waiter. Do not make concurrent project edits while the writer owns the shared tree.

On completion, read the ticket evidence and verify `INDEX.md`, changed paths, and state/hash consistency
without repeating the codebase reading. Run:

```text
node -e "const fs=require('node:fs'),c=require('node:crypto'),p='.claude/.codebase-info/',s=JSON.parse(fs.readFileSync(p+'.map-state.json','utf8'));if(!Array.isArray(s.documents))throw Error('documents');for(const n of new Set(['INDEX.md',...s.documents])){const b=fs.readFileSync(p+n,'utf8');if(!s.hashes||s.hashes[n]!==c.createHash('sha256').update(b.replace(/\r/g,'')).digest('hex'))throw Error(n)}"
```

Require the writer's evidence to name cited-path checks, docs created/updated/removed, and confirmation
that `CLAUDE.md` is untouched. If source moved during mapping, the writer reconciles once or releases
rather than certifying a mixed snapshot.

For an add, dispatch, spawn, or executor failure, inspect `pulse` and the ticket thread first. Make at
most one diagnose-first redispatch, only when that diagnosis changes the launch and no live claim
remains. After a second failure, record the evidence on the ticket, make sure no writer owns the claim,
and complete the map inline in this same shared tree. Validate or repair any partial map before replacing
state, comment that the ticket completed through inline fallback, and give the user one short line naming
the delegation failure and inline fallback.

### Step 1 : Identify the stack

Read the project's manifest/config files to determine languages, frameworks, and tooling. See
`references/language-detection.md` for a broad map of signal files across ecosystems
(JS/TS, Python, Go, Rust, Java/Kotlin, .NET, Ruby, PHP, Swift, Elixir, C/C++, Dart/Flutter,
monorepos, and more). Note the framework(s) : they dictate where things live.

### Step 2 : Map the directory structure

List the tree (`git ls-files` in a git repo gives a clean, ignore-aware listing; otherwise `tree`
or a recursive list, skipping the noise dirs above). Identify the organizing principle:
- **Layer-based**: `controllers/`, `services/`, `models/`
- **Feature/domain-based**: `features/auth/`, `domains/billing/`
- **Hexagonal/clean**: `domain/`, `application/`, `infrastructure/`
- **Monorepo**: `packages/*`, `apps/*`, workspaces

**In graph mode:** do not write `directory-structure.md`. You still need the organizing principle for
`architecture.md`, so skim the top level and stop there; the graph holds the rest.

### Step 3 : Find the entry points

Where does execution begin? Web routes, API routers, CLI command handlers, background workers/cron,
serverless handlers, library public exports, app `main`/bootstrap files, build/start scripts.

**In graph mode:** do not write `entry-points.md`. Ask the graph when you need one:
`graphify query "where does execution start"`.

### Step 4 : Trace the key flows

For the 3–5 most important features, trace end to end: entry point → business logic → data layer →
external effects. Example: `POST /api/users` → `UserController.store()` → `UserService.create()` →
`users` table → `WelcomeEmail`. Note shared utilities and cross-cutting concerns (auth, logging,
validation, error handling).

**In graph mode:** let the graph do the tracing and use its answers as input for the narrative docs,
rather than walking the tree by hand:

```bash
graphify query "how does a user request reach the database"   # BFS over the graph; --budget N caps output
graphify path "UserController" "users"                        # shortest path between two nodes
graphify explain "UserService"                                # one node and its neighbors
```

Read the answers, verify the paths they cite still exist, then write the flow into `architecture.md` in
your own words. Do not paste graph output into a document: the graph is already the durable copy, and a
transcription of it is the stale duplicate graph mode exists to remove.

### Step 5 : Catalog dependencies

From the manifest(s), categorize: **Core** (framework/runtime), **Data** (DB/ORM/cache),
**External** (API clients, third-party services), **Dev** (test/lint/build). Capture only what aids
understanding : don't transcribe the entire lockfile.

This step is the same in both modes. `dependencies.md` is read out of package manifests, not out of the
AST, so graphify does not replace it.

### Step 6 : Capture patterns & conventions

Recurring design patterns, error-handling approach, configuration/secrets management, logging and
observability, and testing structure. Derive coding style from linter/formatter configs
(`.eslintrc`, `ruff.toml`, `.editorconfig`, `rustfmt.toml`, etc.) **and** from what the code
actually does.

### Step 7 : Write the atomic documents

First decide the doc set: walk the aspects you found in Steps 1–6 and pick the documents this project
warrants (see "This list is a menu, not a checklist" above). Then create each one in
`.claude/.codebase-info/` using the templates in `references/document-templates.md`. For a
non-standard doc with no matching template, follow the same shape (title, `Last Updated` line, concrete
paths, tables/diagrams where they help). For each document:
- Put a real `*Last Updated: YYYY-MM-DD*` line under the title.
- Use concrete file paths (`src/auth/guard.ts`), not vague descriptions.
- Prefer tables for structured data (routes, modules, deps) and ASCII/Mermaid for architecture.
- Keep each doc self-contained but cross-link related docs.
- **Keep `INDEX.md` compact.** The hook injects it into context at the start of each session, so it should
  summarize the project in a few lines and link out to the detailed docs, which Claude reads on
  demand. Include the short "How to use / How to maintain this map" section from the template.

**In graph mode:** do not write `modules.md`, and leave the three retired documents out of `INDEX.md`'s
document table. Add the template's short **Structure** section to `INDEX.md` instead: it points at the
graph and at `graphify query|explain|path`, so a session that needs structure knows where to go without
reading a document that no longer exists.

### Step 8 : Record state

Run the bundled state writer after every map document is final:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/write-map-state.js" --project .
```

It records the current date, the full `HEAD` SHA (or `null` outside git), every discovered document,
and hashes of the final bytes. It atomically replaces `.map-state.json` last so a hook can only see
old hashes or a safely detectable stale manifest.

**In graph mode**, the manifest also has to say so. The writer discovers documents from disk, so the
three retired documents are already absent from `documents` and `hashes` — you never wrote them — but
graph mode is a declaration, so pass it on the same command instead:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/write-map-state.js" --project . --structure graphify
```

`structure: "graphify"` is what tells the hooks this manifest covers narrative documents only, so the
absence of `modules.md`, `entry-points.md`, and `directory-structure.md` reads as the design rather than
as drift. Narrative drift is still reported exactly as before. The writer **preserves** the field on
later runs without the flag, so a plain refresh cannot demote a graph-mode map, but pass
`--structure graphify` whenever you build one. `graphify` is the only value it accepts: anything else
fails loudly and writes nothing.

Outside shared-tree artifact mode, commit the map unless the user explicitly says not to commit. A map
that only exists in one working tree helps nobody else and goes stale silently, and the manifest is what
makes staleness detectable, so the commit must include **every generated doc AND `.map-state.json`**.
Before staging, check the repo's ignore rules: a broad `.claude/*` ignore swallows the map and makes
`git add` warn, which reads as "this is local-only" when it is not. If
`git check-ignore .claude/.codebase-info/INDEX.md` matches, add the negations
(`!.claude/.codebase-info/`, `!.claude/.codebase-info/**`) to `.gitignore` in the same commit.

**In graph mode**, settle `graphify-out/` in that same pass. Two files travel with the repo and the
rest stays local:

```gitignore
/graphify-out/*
!/graphify-out/GRAPH_REPORT.md
!/graphify-out/graph.json
```

`GRAPH_REPORT.md` and `graph.json` are exactly what `graphify query|explain|path` read, so a clone
without them has no graph to ask. The generated html, the extraction cache, and the manifest are large,
fully rebuildable, and churn on every commit, so they stay untracked. Do not commit the graph outputs
without these rules in place.

Commit the map as its own commit when allowed. If the user explicitly says not to commit, leave the verified
map and `.map-state.json` in the working tree, say plainly that they still need review or committing,
and tell them the plugin's hook will surface the map automatically from now on.

## Greenfield projects

A brand-new or empty project has little to map yet : so seed the map with *intent* and let it grow:

1. Look for any existing intent: `README`, a spec/PRD, design notes, issues, or scaffolding.
2. If intent isn't written down anywhere, ask the user 2–3 brief questions: What are you building?
   What's the intended stack? Any key architectural decisions already made?
3. Create a **lean** map: `INDEX.md`, `architecture.md` (goals + intended design), `tech-landscape.md`
   (chosen/intended stack), `directory-structure.md` (planned layout), and `onboarding.md`. Mark it
   clearly as a greenfield seed that will grow.
4. Do Step 8 (write state). From here, `update-codebase-map` fills in the rest as real code lands.

Greenfield is classic mode: there is no code to extract yet, so do not offer a graph build and do write
`directory-structure.md` as the planned layout. Offer the build later, once real code exists.

## Large codebases

For hundreds or thousands of source files, do not try to read everything serially:

- When the Sidequest preflight is ready, create one `codebase-exploration` story with read-only area
  tickets, then one final artifact-writer ticket depending on them. Area tickets report concise paths,
  symbols, entry points, and flows in their ticket threads. They do not write the map. The final writer
  reads those threads, reconciles them against the shared tree, and uses the same artifact scope,
  carve-out, lifecycle marker, shared-tree reason, and verification as an initial-map ticket. Do not
  create nested generic tasks.
- When Sidequest is unavailable, map the areas inline in the invoking session. Keep the same bounded
  pass over top-level structure and major flows rather than starting nested generic tasks.
- Favor breadth over exhaustive depth: capture each area's purpose, entry points, and key files rather
  than every file. The map is a guide, not a mirror.
- If you must sample rather than cover everything, say so in the relevant doc.

## Guidelines

- **Audience is a future Claude session.** Optimize for fast grounding and navigation.
- **Accuracy over completeness.** Every path and reference you write must exist. Don't invent.
- **Concrete, not abstract.** Real file paths, real command names, real table/route names.
- **Atomic + linked.** One concern per file; cross-reference rather than duplicate.
- **Never touch `CLAUDE.md`.** The plugin's hook handles loading. Do not add, edit, or remove
  anything in `CLAUDE.md` (or `CLAUDE.local.md`). This includes running any tool that edits it for you:
  **never run `graphify claude install`**, which writes a graphify section into `CLAUDE.md` plus a
  competing PreToolUse hook. `graphify hook install` (git hooks only) is the one install this skill offers.
- **Structure questions go to the graph, convention questions go to these docs.** In graph mode, never
  re-create `modules.md`, `entry-points.md`, or `directory-structure.md`: a hand-written copy of the
  graph is a second source of truth that goes stale the first time anyone moves a file.
- **Respect ignore rules.** Never document `node_modules/`, `vendor/`, build output, or secrets.
- **Don't leak secrets.** Note that config exists and where, never actual credential values.

## Success criteria

- [ ] `.claude/.codebase-info/` created with `INDEX.md` + all applicable atomic docs
- [ ] `INDEX.md` is compact, links every created doc, and includes the how-to-use/maintain section
- [ ] Every doc has a real `Last Updated` date and verified file paths
- [ ] `.map-state.json` written with date, HEAD SHA (or null), and the document list
- [ ] `CLAUDE.md` left untouched, and `graphify claude install` never run
- [ ] Map committed, all docs plus `.map-state.json`, with `.gitignore` negations added if a
      `.claude/*` rule was swallowing it (or the user told plainly it still needs committing)

In graph mode, additionally:

- [ ] `directory-structure.md`, `entry-points.md`, and `modules.md` not written
- [ ] `INDEX.md` carries the **Structure** section pointing at the graph and its three commands
- [ ] `.map-state.json` written with `--structure graphify`, so it records `structure: "graphify"`
- [ ] `.gitignore` has `/graphify-out/*` with `!/graphify-out/GRAPH_REPORT.md` and
      `!/graphify-out/graph.json` negated before the graph outputs are committed

## References

- `references/document-templates.md` : templates for every document type
- `references/language-detection.md` : signal files for detecting stacks across ecosystems
