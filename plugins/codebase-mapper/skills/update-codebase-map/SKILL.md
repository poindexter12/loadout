---
name: update-codebase-map
description: >-
  Refresh an existing .claude/.codebase-info/ map after code changes. Use for stale codebase or
  architecture docs; use map-codebase to create one.
---

# Update Codebase Map

Bring an existing map up to date with surgical edits : detect changes, touch only the affected
documents, keep everything internally consistent. This is a refresh, **not** a full rewrite.

## Prerequisite

A `.claude/.codebase-info/` directory with `INDEX.md` must already exist. If it doesn't, stop and
use the `map-codebase` skill to create the initial map.

## Process

The installed Mapper hook tells the main session to assess the map after code changes and invoke this
skill immediately when documentation work is warranted. A true no-op ends without editing the map or
refreshing state. This process does not wait for a separate user approval.

### Step 1 : Load current state

Read `.claude/.codebase-info/.map-state.json` to get `gitCommit`, `mappedAt`, `structure`, and the
list of existing `documents`. Skim `INDEX.md` to recall what's already covered. (If `.map-state.json`
is missing : e.g. a map from an older version : fall back to the `mappedAt` date in `INDEX.md`, and
plan to write a fresh `.map-state.json` at the end.)

`structure` decides what this map is responsible for:

- **`structure: "graphify"` → graph mode.** graphify owns the structure of the code and this map
  carries narrative documents only. `modules.md`, `entry-points.md` and `directory-structure.md` are
  retired: they are not on disk, not in `documents`, and never in `hashes`. Freshness is split in
  two : graphify keeps the graph current, this skill keeps the narrative current.
- **No `structure`, but `graphify-out/GRAPH_REPORT.md` exists → convert first.** This map was
  written before the graph and still carries its own structural documents. See
  "Converting an existing map to graph mode" below, then continue in graph mode.
- **No `structure` and no `graphify-out/GRAPH_REPORT.md` → classic mode, nothing to decide.** The map
  carries structure itself and this skill behaves exactly as it always has.

### Step 2 : Detect what changed

**Git repo (preferred : precise):** diff against the last-mapped commit.
```bash
git diff --stat <gitCommit>..HEAD          # which files changed, added, deleted
git log --oneline <gitCommit>..HEAD        # what the changes were about
git diff <gitCommit>..HEAD -- package.json pyproject.toml go.mod Cargo.toml composer.json Gemfile   # dependency churn (adjust to the project's manifests)
```

**No git, or no stored commit (fallback):** find source files modified since the map was written.
```bash
# files newer than the index (skip noise dirs)
find . -type f -newer .claude/.codebase-info/INDEX.md \
  -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/vendor/*' \
  -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/target/*' -not -path '*/.venv/*'
```

In classic mode, go straight to Step 2a with that diff. In graph mode, split it first.

#### Step 2 in graph mode : the graph takes the structural half

Changed code files *are* structure. Do not re-read them to re-derive modules, routes or the folder
tree : that is the graph's job, and it does it deterministically without a model. Hand that half over
first, then assess only what is left.

**1. Ask whether the deterministic refresh is already installed.**

```bash
graphify hook status
```

**2. Hook installed → confirm the report is no older than the last commit, then move on.**

```bash
test "$(git log -1 --format=%ct)" -le "$(date -r graphify-out/GRAPH_REPORT.md +%s)" \
  && echo "graph fresh" || echo "graph behind HEAD"
```

`graph fresh` means the post-commit hook already re-extracted everything that changed, so there is
nothing structural left to do. `graph behind HEAD` means a commit landed without the hook running (a
`--no-verify` commit, a rebase, or a hook installed after that commit), so refresh once as below.

**3. No hook → refresh the graph once yourself.** It re-extracts only the files that changed, so it
is cheap:

```bash
graphify update .
```

Run it once. Do not loop, and do not force a full rebuild. If the `graphify` CLI is not on `PATH`,
say so in one line and continue with the narrative half only : offering the install belongs to
Quartermaster, not to this skill.

**If you are a subagent, do neither.** NEVER run `graphify update <root>` or its undocumented alias
`graphify ... --update`, and never update the map: the post-commit hook or the main session refreshes
the graph, and the main session refreshes the map
once after all parallel work integrates. Querying is fine : `graphify query`, `graphify explain` and
`graphify path` are read-only. Report staleness in your final report instead.

**4. Then assess narrative impact only.** "What modules are there now?" is answered by
`graphify query`, so the only question left for you is whether the *story* changed:

- Did a **convention** change (naming, error handling, config layout, test layout)? →
  `coding-style.md`, `patterns.md`
- Did a **pattern** change : a new recurring approach, a retired one? → `patterns.md`
- Did an **architectural boundary** move : a new subsystem, a split service, a first datastore or
  queue? → `architecture.md`, `communication.md`, `database.md`
- Did the **story of an entry point** change : not the list of routes or commands, but what the
  important flow now does end to end? → `architecture.md`, `onboarding.md`
- Did an **onboarding step** change (setup, build, run, test commands)? → `onboarding.md`
- Did a **dependency manifest** change? → `dependencies.md`, maybe `tech-landscape.md`

A purely structural change : a file moved, a module renamed, a route added that introduces no new
convention or flow : is a no-op for this map in graph mode. Say so and stop; the graph already
carries it.

### Step 2a : Decide whether to hand off

Do not ask the user whether to update the map, run this skill, or create a handoff. Decide using this
process, announce the applicable documentation-check outcome, and immediately perform the warranted
update or handoff without waiting for a reply.

A true no-op stays inline: report that no documented behavior, structure, interface, dependency, or
convention changed, then leave the map alone. Do not create a ticket merely to refresh timestamps or
state.

For an incremental refresh, work inline in the invoking session when the diff since the stored
`gitCommit` touches fewer than ~15 files across already-mapped areas and adds or removes no top-level
aspect. Apply Steps 3 through 5 directly. Do not create a ticket or dispatch an agent for this case.

Use an optional shared-tree artifact handoff for a full remap or large structural drift: a new subsystem,
a deleted service, or the first Dockerfile or datastore. For incremental work, stay inline. Inspect the
session tool roster before reading further. The handoff requires the native `Agent` tool plus Sidequest
`category_list`, `add`, `comment`, `dispatch`, and `pulse`. Do not probe the Sidequest CLI or dashboard.
Read the live `codebase-exploration` category and hand off only when it is enabled and its contract
permits one bounded documentation-artifact write while keeping project source read-only.

- When the tools are absent, continue inline without an error banner. Standalone Codebase Mapper does not
  require Sidequest.
- When Sidequest is present but the category is missing, disabled, or does not permit the bounded
  `.claude/.codebase-info/` artifact root, continue inline and say: `Sidequest is loaded, but its live taxonomy cannot accept map artifacts yet.`
- A read-only category with that artifact root is ready: shared-tree artifact mode permits the bounded
  map write and refuses every other project path.
- When it is ready, you may create one `codebase-exploration` artifact ticket with
  `files: [".claude/.codebase-info/"]` and this exact clause. Do it immediately without checking in with
  the user: `Artifact write carve-out: write only .claude/.codebase-info/**; all project source is read-only.`

The handoff ticket records the stored `gitCommit`, current `HEAD`, initial dirty-source status outside
`.claude/.codebase-info/`, the current map document list, and the map's `structure` mode. Its writer diffs
from stored state through the visible working tree, reassesses the warranted docs, preserves intentional
manual map edits, touches only affected docs, and replaces `.map-state.json` last. It must inspect the
shared tree, verify every cited path, skip generated/vendor/secret material, never touch
`CLAUDE.md`, and never invoke `map-codebase` or create nested mapping tickets. In graph mode it must
also leave structure to the graph and keep `structure: "graphify"` in the state it writes. Include this
lifecycle marker verbatim:

```text
Shared-tree artifact mode: leave the generated map as working-tree output; verify, comment, and close with done. Do not commit, submit, push, or edit source.
```

The invoking parent session verifies the generated paths and state after the writer closes, then commits the map if its flow permits.

Before dispatch, comment this reason:

```text
Shared-tree dispatch is required because the map must describe the current working tree, including intentional uncommitted source, and the generated .claude/.codebase-info/** files must remain visible to the invoking session.
```

Dispatch with `{ sharedTree: true }`, pass returned spawn fields to the native `Agent` unchanged, then
end the turn. Resume only on native completion, never by polling or a proxy waiter. Do not make
concurrent project edits while the writer owns the shared tree.

On completion, inspect the ticket evidence and verify `INDEX.md`, changed paths, and hashes without
redoing the codebase reading:

```text
node -e "const fs=require('node:fs'),c=require('node:crypto'),p='.claude/.codebase-info/',s=JSON.parse(fs.readFileSync(p+'.map-state.json','utf8'));if(!Array.isArray(s.documents))throw Error('documents');for(const n of new Set(['INDEX.md',...s.documents])){const b=fs.readFileSync(p+n,'utf8');if(!s.hashes||s.hashes[n]!==c.createHash('sha256').update(b.replace(/\r/g,'')).digest('hex'))throw Error(n)}"
```

Require cited-path checks, docs created/updated/removed, and confirmation that `CLAUDE.md` is untouched.
A writer whose source snapshot moves reconciles once or releases rather than certifying a mixed snapshot.
For a broad diff, use a `codebase-exploration` story with read-only area tickets and one dependent final
artifact writer. Area tickets report paths, symbols, entry points, and flows in their threads; never use
nested generic tasks.

For an add, dispatch, spawn, or executor failure, inspect `pulse` and the ticket thread. Retry once only
when a diagnosis changes the launch and no live claim remains. After a second failure, record the
evidence, ensure no writer owns the claim, validate or repair any partial map inline in this shared tree,
replace state last, and comment that the ticket completed through inline fallback. Give the user one short
line naming the failure and inline fallback.

### Step 3 : Re-assess the warranted doc set, then map changes to documents

An update is not only "edit the docs that exist." First **re-evaluate which documents this codebase
now warrants**, because the right set drifts as the project grows. The map should always carry the docs
that apply now, no more and no less:

- **A new aspect appeared → add its doc.** The project gained its first `Dockerfile`/`compose.yaml`, so
  create `docker.md` now even though the last map had none. First datastore → add `database.md`. First
  dependency manifest → add `dependencies.md`. A new major subsystem that no standard doc covers → add
  a custom doc (e.g. `ml-pipeline.md`, `realtime.md`), the same way `map-codebase` would. This is the
  common case the user cares about: you don't make `docker.md` until there's Docker, and once the code
  is dockerized, the next update is exactly when it should appear.
- **An aspect vanished → prune its doc.** A service, integration, or datastore was removed, so delete
  the now-empty doc and its `INDEX.md` row.

Then map the remaining changes onto the existing documents:

| If this changed… | Update… |
|------------------|---------|
| Directory layout (folders added/removed/renamed) | `directory-structure.md` |
| Components / services / module boundaries | `architecture.md`, `modules.md` |
| New/removed routes, CLI commands, jobs, handlers | `entry-points.md` |
| API contracts, events, queues, integrations | `communication.md` |
| Schema, migrations, new tables/collections | `database.md` |
| Dependency manifest (added/removed/upgraded) | `dependencies.md`, maybe `tech-landscape.md` |
| Design patterns, error handling, test setup, config | `patterns.md` |
| Linter/formatter config or naming conventions | `coding-style.md` |
| Container/compose setup | `docker.md` |
| Setup steps or common processes | `onboarding.md` |
| Project name/description, or any doc added/removed | `INDEX.md` |

**In graph mode, drop the three retired rows.** `directory-structure.md`, `modules.md` and
`entry-points.md` are not part of this map, so a folder rename, a new module or a new route routes to
the graph, not to a document : and **never recreate a retired document** to hold them. Those changes
still reach the map when they change the story, through the narrative questions in Step 2: a new
top-level boundary belongs in `architecture.md`, a changed important flow in `architecture.md` or
`onboarding.md`. Every other row applies unchanged, `dependencies.md` included.

Prioritize structural changes (new/removed entry points, components, infra, data model) over cosmetic
ones. Skip pure internal refactors that don't change any documented interface, layout, or convention.

### Step 4 : Apply targeted edits

For each affected document:
1. Read it.
2. Make focused edits : change only what's now different; don't rewrite the whole file.
3. Update its `*Last Updated: YYYY-MM-DD*` line to today's real date.

Then carry out the additions and removals you identified in Step 3:
- **New doc for an aspect that appeared:** create it from the matching template in
  `../map-codebase/references/document-templates.md` (or, for a non-standard aspect, follow the same
  shape), then add it to `INDEX.md` and to the `documents` list in state.
- **Prune a doc for an aspect that vanished:** delete the now-empty doc (and its `INDEX.md` row), or
  prune the stale sections from a shared doc. Remove orphaned references.

### Step 5 : Re-record state

After the final document edits, run the bundled state writer from the installed plugin:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/write-map-state.js" --project .
```

It discovers the current documents, records today's date and the current commit (or `null` outside a
git repo), hashes the final bytes, and atomically replaces `.map-state.json` last. A manual edit or
interrupted write can leave hashes stale; that is safe because hooks hash live files and treat the
manifest only as a consistency check.

**In graph mode, declare it on the same command.** Pass `--structure graphify` and the writer records
the field itself, in one step:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/write-map-state.js" --project . --structure graphify
```

Because the retired documents are not on disk, the rebuilt `documents` and `hashes` never mention them,
and `structure: "graphify"` is what tells the hook that absence is deliberate. Without the field the
hook reports the map stale on every session. The writer also **preserves** an existing `structure`, so
a plain run without the flag cannot demote a graph-mode map back to classic; pass the flag anyway, so
the mode is declared rather than inherited. `graphify` is the only value it accepts: anything else
fails loudly and writes nothing.

Then summarize for the user: which docs you updated, created, or removed, and why. Outside shared-tree
artifact mode, commit the refreshed map unless the user explicitly says not to commit, and include
**`.map-state.json` alongside the edited docs**. An uncommitted manifest means every other checkout
sees stale hashes and re-flags docs that are actually current. If `git check-ignore
.claude/.codebase-info/INDEX.md` matches (a broad `.claude/*` rule), add `!.claude/.codebase-info/`
and `!.claude/.codebase-info/**` to `.gitignore` in the same commit; the ignore warning on `git add`
does not mean the map is local-only. If the user explicitly says not to commit, leave the verified map
changes and `.map-state.json` in the working tree and say plainly that they still need review or
committing.

## Converting an existing map to graph mode

`graphify-out/GRAPH_REPORT.md` exists but `.map-state.json` has no `structure` field: this map predates
the graph and still carries its own structural documents, which now duplicate it and will drift from it.
Convert the map once, then refresh as normal.

Announce it in one line, for example: `This map still carries its own structure docs and the project now
has a graph; converting the map to graph mode once.` Then do it without waiting for a reply. It is a
one-time step for this map : afterwards Step 1 reads `structure: "graphify"` and this section never
applies again. Do not convert silently, do not convert a project with no graph report, and
do not convert twice.

**1. Rescue the narrative, then delete the three documents.** These docs sometimes carry a sentence the
graph cannot answer : why a boundary exists, which module to start reading in. Move that sentence into
`architecture.md`, `patterns.md` or `onboarding.md` first. Do not move lists of modules, routes or
folders; the graph has those.

```bash
git rm .claude/.codebase-info/modules.md .claude/.codebase-info/entry-points.md .claude/.codebase-info/directory-structure.md
```

(Plain `rm` if they are untracked.) Only these three : every other document stays LLM-authored,
`dependencies.md` included.

**2. Rewrite `INDEX.md`'s structure section** to match the graph-mode `INDEX.md` the `map-codebase`
skill writes (`../map-codebase/references/document-templates.md`): drop the three rows from the
Documents table and send structural questions to the graph instead : `graphify-out/GRAPH_REPORT.md`
for the overview, `graphify query`, `graphify explain` and `graphify path` for specifics. The hook
injects `INDEX.md` at the start of every session, so this is the line that stops the next session
hunting for a `modules.md` that no longer exists.

**3. Rehash state with the field set.** Deleting the files is what drops them from `documents` and
`hashes`; the field is what tells the hook the absence is deliberate. Run the Step 5 command with the
flag, which does both at once:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/write-map-state.js" --project . --structure graphify
```

**4. Commit the conversion as one commit** : the three deletions, the rewritten `INDEX.md`, and
`.map-state.json` together, so no other checkout ever sees a half-converted map.

Then, if code also changed since the last map, run Steps 2 to 5 as normal : now in graph mode.

## Guidelines

- **Surgical, not sweeping.** Targeted edits keep diffs reviewable and history meaningful.
- **Verify before writing.** Every path you add must exist; every path you remove must really be
  gone.
- **No churn for churn's sake.** If nothing meaningful changed, say so and leave the map and state
  untouched.
- **In graph mode, never re-derive structure by hand.** Modules, entry points and the file tree come
  from the graph. Your half is conventions, patterns, boundaries, flows and onboarding.
- **Never touch `CLAUDE.md`.** The plugin's hook handles loading; the map lives entirely in
  `.claude/.codebase-info/`. Leave `CLAUDE.md` (and `CLAUDE.local.md`) alone.

## Success criteria

- [ ] `structure` read from `.map-state.json`, and the mode (graph or classic) stated
- [ ] Changes since the last map detected (via stored commit, or mtime fallback)
- [ ] Graph mode: `graphify hook status` checked; the graph confirmed no older than the last commit, or
      refreshed exactly once; no structural document recreated
- [ ] Warranted doc set re-assessed: docs added for aspects that appeared (e.g. Docker, a datastore),
      docs pruned for aspects that vanished
- [ ] Only affected documents edited; new areas documented; removed areas pruned
- [ ] `INDEX.md` reflects any added/removed docs
- [ ] `Last Updated` dates current on every touched doc
- [ ] `CLAUDE.md` left untouched
- [ ] `.map-state.json` rewritten with today's date, current commit, and document list : in graph mode
      written with `--structure graphify`, so it records `structure: "graphify"`
- [ ] Map changes committed including `.map-state.json` (or the user told plainly they still need
      committing)
