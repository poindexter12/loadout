# Eigenwise Toolshed

[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin_marketplace-D97757?logo=claude&logoColor=white)](https://claude.com/claude-code)
[![Docs](https://img.shields.io/badge/docs-online-CB7D32)](https://poindexter12.github.io/eigenwise-toolshed/)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](./LICENSE)

This repository is an independently maintained fork of the Eigenwise Toolshed. It publishes a Claude Code plugin marketplace of six independent plugins that address recurring costs in agent-assisted development: re-learning a repository each session, losing side work, routing routine jobs to expensive models, and leaving usage unmeasured.

Each plugin installs, operates, and updates on its own. Quartermaster is the guided entry point for selecting, installing, and verifying the plugins that fit a project. No plugin requires another.

## The six plugins

| Problem | Plugin | Function |
| --- | --- | --- |
| A fresh session re-explores the same repository | [Codebase Mapper](./plugins/codebase-mapper) | Builds a small project map, loads it at session start, and refreshes the parts touched by changes. |
| Project rules get forgotten or occupy every context | [Live Rules](./plugins/live-rules) | Injects matching rules when they apply, so conditional guidance stays out of unrelated work. |
| Side work gets lost; parallel changes need a clear owner | [Sidequest](./plugins/sidequest) | Tracks work as tickets, claims changes before work starts, dispatches independent work, and gates results on verification before integration. |
| Other subscription models are not available in Claude Code | [Model Gateway](./plugins/model-gateway) | Adds supported ChatGPT/Codex and Grok subscription models to Claude Code's `/model` picker through a local gateway. |
| Time and token usage are not visible | [Observability](./plugins/observability) | Records selected session and tool metadata locally, with per-project opt-in and optional sinks. |
| Setup, updates, and missing capabilities recur | [Quartermaster](./plugins/quartermaster) | Guides project setup, keeps active Toolshed installs current, checks health, and uses bounded session summaries to suggest one approved improvement at a time. |

Sidequest routes across Claude models on its own; Model Gateway is required only for its non-Claude routes. Observability is separate from the other plugins and remains opt-in per project.

## Installation with Quartermaster

Use Quartermaster when you want Claude to assess a project, explain which Toolshed pieces fit, and leave the rest alone. Install a plugin directly when you already know which job you want.

From the project directory:

1. Add the marketplace.
   ```text
   /plugin marketplace add poindexter12/eigenwise-toolshed
   ```
2. Install Quartermaster for this project. Project scope keeps the choice with the repository.
   ```text
   /plugin install quartermaster@eigenwise-toolshed --scope project
   ```
3. Activate the installed plugin. Reload plugins or start a new Claude Code session.
   ```text
   /reload-plugins
   ```
4. Run setup and approve the plan item by item.
   ```text
   /quartermaster:setup
   ```
5. Setup installs the selected plugins and writes the approved workspace files. When it pauses at the reload boundary, reload plugins — or restart Claude Code if the change affects the process environment — then tell Claude `continue`.
6. Allow setup to verify the installed plugins and workspace after that boundary. Run one real request in the project before adding more pieces.

Quartermaster's setup uses project scope by default; Claude Code also supports user and local scopes. The updater follows the recorded scope and project path for every active Toolshed install, so a request from one project can update Toolshed installs in other recorded projects. Read the update and reload notes before running it.

## Direct installation

Use the same marketplace with the scope you want:

```text
/plugin marketplace add poindexter12/eigenwise-toolshed
/plugin install <plugin-name>@eigenwise-toolshed --scope project
```

Replace `<plugin-name>` with `sidequest`, `model-gateway`, `observability`, `codebase-mapper`, `live-rules`, or `quartermaster`. Use `--scope user` for a plugin you want in every project, or `--scope local` to keep it out of shared settings. Reload plugins or start a new session after an install. The [plugin guides](https://poindexter12.github.io/eigenwise-toolshed/getting-started/) cover the first workflow for each plugin.

## Updates and reloads

`/quartermaster:update-toolshed` is the requested updater. It refreshes the Eigenwise Toolshed marketplace and updates all active Toolshed registry installs at their recorded user, project, or local scope and project path. It does not modify third-party marketplaces. Freshness hooks report cached availability or loaded-version mismatches and point to the updater; they do not install or restart anything.

Marketplace auto-update is optional. Enable it for the Eigenwise Toolshed marketplace in Claude Code if you want marketplace checks after session start. An open session still needs `/reload-plugins` after plugin code changes. Changes to process-level gateway wiring or model discovery may require a new Claude Code process instead of a reload.

## Documentation

- [Getting started](https://poindexter12.github.io/eigenwise-toolshed/getting-started/)
- [Quartermaster setup guide](https://poindexter12.github.io/eigenwise-toolshed/getting-started/quartermaster/)
- [Plugin reference](https://poindexter12.github.io/eigenwise-toolshed/reference/)
- [Contributing](https://poindexter12.github.io/eigenwise-toolshed/contributing/)
- [Release process](https://poindexter12.github.io/eigenwise-toolshed/release-process/)
- [Support](https://poindexter12.github.io/eigenwise-toolshed/support/)

## Compatibility

Toolshed plugins run inside Claude Code and use its plugin marketplace, plugin scopes, and reload commands. Quartermaster's local scripts use Node.js and the Node standard library. Model Gateway additionally requires the provider access and local process setup described in its guide. No plugin activation opts a project into telemetry, a gateway, or Sidequest routing by itself.

## Attribution

The Eigenwise Toolshed was created by [Eigenwise](https://github.com/Eigenwise), the original author and copyright holder of this codebase. This repository is an independently maintained fork; it is not affiliated with or endorsed by the original author. The original repository is [Eigenwise/eigenwise-toolshed](https://github.com/Eigenwise/eigenwise-toolshed).

## License

[MIT](./LICENSE) — Copyright (c) 2026 Eigenwise.
