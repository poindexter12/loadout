# Loadout codebase map

Last Updated: 2026-10-10

Loadout is a public Claude Code plugin marketplace. It ships six published plugins, with Sidequest as the largest runtime system and its stable executor roster bundled in the plugin package, plus shared test support, docs, examples, and release automation. The current gateway plugin is Model Gateway. `sandbox/windows/` is a maintainer-only, gitignored Windows Sandbox clean-room harness — not published, not linked from docs.

- [Architecture](architecture.md)
- [Tech landscape](tech-landscape.md)
- [Patterns](patterns.md)
- [Coding style](coding-style.md)
- [Onboarding](onboarding.md)
- [Release and publishing](release-publishing.md)

## Structure

Structure lives in the graph, not in these docs: `graphify-out/GRAPH_REPORT.md` (the summary) and `graphify-out/graph.json` (the graph itself). Both travel with the repository, so a fresh clone can answer structure questions without rebuilding.

| Ask | Command |
|-----|---------|
| Where does X happen? | `graphify query "<question>"` |
| What is X, and what touches it? | `graphify explain "<node>"` |
| How does X reach Y? | `graphify path "<from>" "<to>"` |

**Structure questions go to the graph, convention questions go to these docs.** `directory-structure.md`, `entry-points.md`, and `modules.md` are retired here: graphify owns the folder tree, where execution starts, and per-module purpose and dependencies, so there is no hand-written copy to drift. Their absence is deliberate and recorded as `structure: "graphify"` in `.map-state.json`.

## How to use and maintain this map

Read this index first, then the smallest linked document that answers the question. Paths and symbols are the source of truth. Refresh the narrative documents after structural or workflow changes with `/update-codebase-map`; update `Last Updated`, and replace `.map-state.json` last with hashes of the exact final bytes, keeping the `structure` field. The graph half refreshes separately: a post-commit hook rebuilds it where one is installed (`graphify hook install`, local and never committed), and `graphify update .` is the documented manual refresh. Both re-extract code only and need no LLM. graphify itself is an opt-in `uv` tool owned by Quartermaster, not a requirement for reading this map.
