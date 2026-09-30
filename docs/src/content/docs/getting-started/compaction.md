---
title: Compaction and third-party plugins
description: Keep Sidequest context and credentials safe when a replacement-style compaction plugin is installed.
---

Claude Code can compact a session through its built-in path or through a function-hook plugin such as `fast-jev-compaction`. The distinction matters: a replacement-style plugin can answer `session.compact` itself and replace the transcript without calling Claude Code's core compaction path.

## What Loadout does during compaction

Loadout keeps its classic hooks in place for the core path. Sidequest's `PreCompact` hook pins live board context for both `auto` and `manual` compactions. Its veto remains `auto`-only, so a user-requested `/compact` is never blocked. A replacement plugin can bypass both of those classic hooks when it does not call the next compaction handler.

The optional Sidequest function-hook guard covers that replacement path. When it is active and a compaction plugin is beneath Sidequest in the hook chain, it:

- passes the board recovery pin down to the next compaction handler;
- restores protected Sidequest dispatch and briefing tool results that the replacement truncated or dropped, keeping the restored messages in the transcript's current parent chain; and
- leaves non-text results alone and uses retrieval pointers when a result exceeds the 32 KiB per-result or 64 KiB total restore budget.

The guard is disabled by default. Enable Claude Code function hooks and seat Sidequest outside the third-party plugin by putting this in your **user** settings:

```json
{
  "prependPlugins": ["sidequest@loadout"]
}
```

Set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the environment that starts Claude Code. Then configure Sidequest's `compactionGuard` plugin option:

- `off` (default) registers nothing and does not write compaction-guard state.
- `auto` activates after the function-hook trace shows a non-core compaction plugin beneath Sidequest.
- `on` always pins and restores against a replacement-style compaction.

A replacement compaction is identified by its empty compact summary. On the main session, the PostCompact and SessionStart hooks still run, but Codebase Mapper and Live Rules emit a short “history retained” note instead of reinjecting context that is already present verbatim. A normal summarized compaction keeps their usual re-grounding behavior. The function-hook guard protects dispatch and briefing results; it cannot recover an unspawned orchestrator result or an executor handle that was never retained.

## Why `autoCompactWindow` matters

Quartermaster's `autoCompactWindow=200000` is an intentional cap for the Codex compaction point. With `fast-jev-compaction` set to 80%, that makes replacement compaction happen around 160K tokens, before Claude Code's built-in threshold near 167K.

Do not remove that cap casually for `[1m]` or gateway models. Without it, 80% is roughly 736K–800K tokens against the advertised 920K–1M window. The Codex sentry may reject the larger request with HTTP 413 before compaction gets a chance to run. Use `/context` to check the effective cap after changing model or project settings.

## Keep TypeSafe credentials out of settings files

The Sidequest compaction guard does not need a TypeSafe API key or any network request. If you separately enable a TypeSafe feature in the compaction plugin, keep `TYPESAFE_API_KEY` in a 1Password Secure Note named `provider-typesafe` (for example, the `jev` section with its token, scopes, and expiry), or use that plugin's sensitive `userConfig` mechanism for runtime injection.

Never put the key in a stowed `settings.json`, commit it, or copy it into project configuration. Inject it only at runtime, and keep the ordinary Sidequest guard enabled without a key.
