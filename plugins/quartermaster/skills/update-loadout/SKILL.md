---
name: update-loadout
description: >-
  Update installed Loadout plugins and model-gateway, or check their status. Use to update
  Loadout, refresh the marketplace, or check versions.
---

# Update Loadout

Run the portable updater from this plugin installation:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/update-loadout.js"
```

It reads Claude Code's installed-plugin registry, refreshes the Loadout marketplace, and
updates every active Loadout install recorded there at its recorded scope and project directory. That
includes user, project, and local installs across projects, not only the project where this skill is
invoked. It does not inspect, refresh, or update third-party marketplaces or plugins. When Model Gateway
is installed, it runs its stable updater, `node ~/.claude/model-gateway/update.js`, and surfaces that
command's output. The updater downloads and verifies the proxy, swaps it by rename without asking you to
close sessions, restarts it when it can, and reports the resulting state. Claude Code's registry has
versions but not release notes or commit history, so the updater says that plainly instead of guessing at
a changelog. Gateway wiring stays at its recorded scope: the stable updater delegates to setup, which
preserves per-project `.claude/settings.local.json` or user-level `~/.claude/settings.json` wiring and
never escalates scope. Remote Control compatibility points the base URL at `api.anthropic.com`, so the
Codex/Grok rows disappear from `/model`; an explicit id such as `/model claude-gpt-5.6-terra` still works.
Gateway wiring changes apply to new Claude Code sessions, so restart affected sessions. On a tree that sets
`"model-gateway@loadout": false` in `enabledPlugins` (project-local, project, or the active config dir's
user settings, first match wins), the updater still updates the plugin files but skips the gateway updater,
so it never starts the daemon there; it prints `Gateway update skipped` naming the file. It continues after
individual failures and prints the failing commands.

## graphify, when it is already installed

graphify is codebase-mapper's optional structural layer and the one piece of Loadout's
dependency surface that is not node: it is a Python `uv tool`, the PyPI distribution
`graphifyy` (two y's) providing a `graphify` executable. Quartermaster owns its lifecycle,
so this updater keeps it current.

It is strictly opt-in, and the updater holds that line in one direction only:

- **Already installed** (`uv tool list` names it, or names a tool providing the `graphify`
  executable): the updater runs `uv tool upgrade <distribution>` and surfaces its output the
  way it surfaces the Model Gateway updater's. It upgrades the distribution name uv actually
  recorded, so an upstream rename does not leave it chasing a package that no longer exists.
- **Not installed**: the updater says `graphify: not installed (opt-in)` and does nothing
  else. **It never installs graphify.** That choice belongs to `/quartermaster:setup`, which
  offers it alongside codebase-mapper.
- **`uv` itself missing**: the updater reports that it cannot tell, points at
  https://docs.astral.sh/uv/getting-started/installation/, and moves on. It never installs `uv`.

`--check` reports the installed version and does not upgrade. `--dry-run` prints the upgrade
command without running it. A failed upgrade is reported with its output and counted as a
failure, and the rest of the update continues, like every other step.

For the installed version, whether the project is in graph mode, and whether the CLI surfaces
the mapper depends on still exist, use `/quartermaster:loadout-doctor` instead: this skill
changes things, the doctor only reads.

## Gateway rename migration

If the updater finds the retired `codex-gateway` install, it stops before refreshing plugins, running setup, or changing wiring. Close every Claude Code session using Codex. From a terminal, run the updater's deferred migration command from the installed Quartermaster plugin:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/update-loadout.js" --migrate-model-gateway --confirm-sessions-closed
```

It installs `model-gateway` at each legacy scope, moves only `~/.claude/codex-gateway` state, runs setup, ensure, and doctor, rewires recorded projects, then retires the legacy registry rows. The confirmation is deliberate: the command does not stop the shared gateway or change its state while another session may still use it.

Before changing anything, use this for a read-only report:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/update-loadout.js" --check
```

Use this to show every command without changing anything:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/update-loadout.js" --dry-run
```

## Freshness guard and reload boundary

Quartermaster's freshness hooks report cached availability and loaded-version mismatches. Their notices
are advisory: they do not install plugins or restart Claude Code. Run this updater when you want the
installed versions changed, then `/reload-plugins` or restart Claude Code and resubmit the prompt. The
maintenance commands remain available when a freshness notice appears. For an emergency only, start
Claude Code with `LOADOUT_FRESHNESS_BYPASS=1`; remove that override once updates are possible.

An update does not replace the plugin code already loaded by an open Claude Code session. Tell the user
exactly what the updater reports: run `/reload-plugins` in each affected session, or restart Claude Code
if reload does not pick up the new version. User-scoped installs affect every open session; project and
local installs affect sessions open in their recorded project directories.

## Optional marketplace auto-update

Marketplace auto-update is optional. To enable it, open `/plugin`, open **Marketplaces**, select
`loadout`, and choose **Enable auto-update**. Claude Code checks after session start with a
random delay of up to 10 minutes. Third-party marketplaces start with auto-update off, and an already-open
session still needs `/reload-plugins` or a restart after an update lands.

Do not add this updater to SessionStart. It intentionally changes installed plugins and downloads the
codex gateway dependency, so automatic startup work stays non-mutating.
