---
title: Model Gateway
description: Add ChatGPT/Codex and Grok subscription models, and Antigravity Gemini models, to Claude Code.
---

Model Gateway adds subscription-backed GPT and Grok models, and Antigravity-backed Gemini models, to Claude Code. Claude Code v2.1.129+ can show those gateway models in its `/model` picker. Claude models keep using Anthropic normally.

## Install

Run these in Claude Code:

```text
/plugin marketplace add poindexter12/loadout
/plugin install model-gateway@loadout --scope project
```

Reload the plugin, then start the Model Gateway skill:

> Set up Model Gateway for me.

The skill runs `setup` with project-local wiring, installs and starts the local gateway, checks your subscription login, and confirms the current project's `.claude/settings.local.json`. If setup asks for login, complete the browser sign-in, then let Claude run `setup` again to finish and confirm the project wiring.

After the wiring is confirmed, fully restart the Claude Code process for that same project. A plugin reload alone does not reload the picker cache or the settings in the new process. Select a gateway model only after that restart.

Model Gateway writes `ANTHROPIC_BASE_URL` to `.claude/settings.local.json`, never the committed `.claude/settings.json`. That keeps your local gateway endpoint out of other people's checkouts. You can opt into one shared fallback URL in the `settings.json` of your active Claude config tree — `CLAUDE_CONFIG_DIR` when it is set, otherwise `~/.claude` — but a project's local setting wins. `model-gateway doctor` marks the effective source and calls out conflicting gateway modes.

You may need to complete a browser sign-in or restart Claude Code. Claude will ask only when either step is actually needed.

## Pick a model

In Claude Code v2.1.129+, open `/model` and choose a row labeled `From gateway`. Claude Code only refetches gateway discovery
with an API-key credential. Model Gateway writes its discovery cache for OAuth subscriptions, and
new rows appear after a full Claude Code restart. `/reload-plugins` does not reload the picker cache.

- `claude-gpt-*[1m]` uses your ChatGPT/Codex subscription. `MODEL_WINDOW_POLICY` in Model Gateway's runtime is the authority for every gateway picker row. GPT-5.6 Sol, Terra, Luna, and GPT-6 Astra are measured rows; other Codex proxy rows use its explicit unmeasured 920k default until measured.
- A `[1m]` alias gives Claude Code a 1M client window, but a lower explicit `autoCompactWindow` still wins. The optional `325000` setting is a cap, and with that cap the client compacts around `292000`. The alias is removed before forwarding to the backend and does not promise a 1M backend input limit. Use `/context` to inspect the selected model and effective cap.
- `claude-grok-4.5[1m]` uses your Grok subscription and is advertised only while the Grok CLI is installed and signed in. Without that sign-in the row is withheld from `/model` rather than shown as a row whose every request fails. Sign in with `grok`, then restart Claude Code to pick the row up. Its measured backend window is 500k. The alias is removed before requests reach the backend.
- `claude-gemini-*` routes to a local `antigravity-claude-proxy`, which speaks the Anthropic Messages API natively and signs in with a Google account — Model Gateway does not install or log into it for you. Install it from its project page, [antigravity-claude-proxy on GitHub](https://github.com/badrisnarayanan/antigravity-claude-proxy) (also published on npm), run it, and add an account with `antigravity-claude-proxy accounts add`. The rows are live-only: the gateway advertises whatever the proxy's `/v1/models` answers with, and while the proxy is down every Gemini row is withheld from `/model` rather than shown as a row whose every request fails. The gateway probes the proxy at `http://127.0.0.1:18766`; set `CODEX_GATEWAY_ANTIGRAVITY_ENDPOINT` if yours listens elsewhere. With the proxy up, restart Claude Code to pick the rows up. `doctor`'s model-window table includes the live Gemini rows, and its readiness report has no local credential probe for Antigravity — the proxy checks the Google login per request.
- Claude models keep using Anthropic.

Sidequest can select these models automatically when both plugins are installed.

## Daily use

There are no routine Model Gateway commands to remember. The shim supervisor checks the proxy's `/v1/models` endpoint while it runs and waits for three consecutive failures before recovering a still-bound proxy with bounded backoff. It leaves a healthy proxy alone. Startup, stop, supervisor replacement, drain, and worker restart leave a bound shim listener untouched unless its ownership is confirmed. If the PID or process inspection is unavailable, retry `ensure` or `stop` after inspection is available; do not kill an unidentified listener. Proxy recovery retries inconclusive ownership automatically after backoff. A confirmed foreign install is never stopped; manage it through its own install. Confirmed older cache siblings from the same marketplace can be replaced, while an older session leaves a newer shim running and asks you to reload plugins or restart Claude Code. Account-specific state and socket paths remain separate. Claude handles setup, updates, authentication checks, model discovery, and settings repair through the skill.

SessionStart launches a missing supervisor outside the hook's process tree, then waits no more than 12 seconds inside its 30-second hook budget. A slow proxy keeps starting in the background. Claude asks you to retry the Codex model in a few seconds instead of holding the session-start hook open.

Two SessionStart hooks (or any two `ensure` calls) can start close together. `ensure` claims an exclusive lockfile before it decides recovery is needed, so only one of an overlapping pair ever independently observes a symptom and starts recovery; the other waits briefly and reports that first invocation's actual outcome instead of racing it. A lock left behind by a process that is no longer alive is reclaimed rather than blocked on forever, as is a lock older than an absolute age cap, whatever its recorded pid reports — so a dead holder whose pid has since been recycled onto an unrelated live process cannot leave recovery deadlocked. `ensure` also now tolerates a single bad health probe rather than treating it as proof the gateway is down.

When the gateway disappears or restarts, ask Claude to run `doctor`. It names `$CLAUDE_CONFIG_DIR/model-gateway/logs/lifecycle.jsonl` (the active config dir, default `~/.claude`) and says whether it found an observed supervisor, worker, or proxy exit. The bounded records include PIDs, orderly setup/stop/restart requests, signals, and recovery outcomes. A force-killed supervisor or OS termination can leave no final record, so a missing exit entry does not prove an orderly shutdown.

Running Model Gateway's own suite uses a separate test home and never touches the installed gateway. Codex sessions dropping while tests ran was a supervisor cleanup bug, fixed in this version. Cleanup uses this home's recorded PIDs and targeted ownership checks only: the live command must still identify this install, and the recorded command or start time must match. A stale record is deleted without stopping its reused PID; `doctor` reports `stale pid file guardian: PID <pid> is now <command>`.

If a request fails with `502 model-gateway: the local gateway proxy is temporarily unreachable`, that names a brief connection drop (`ECONNREFUSED`/`ECONNRESET`/`EPIPE`) to the shim, most often mid-restart; recovery is automatic and the request is retried without any action needed. A 502 that instead says the failure "does not look like a transient restart" is not self-healing — run `model-gateway status`, then `doctor` if it persists.

A `429` on a `gpt-*` model is rewritten to say the codex backend, not Anthropic, is rate limiting the account, and that it is not your Claude usage limit. All `gpt-*` picker models route to the same codex backend, but throttling has been observed to hit one model at a time rather than the whole account, so switching to a different `gpt-*` model is worth trying. The reliable escape is a different backend — a `claude-*` model, or `grok-4.5` — neither of which touches codex. Otherwise wait for the codex limit to clear.

If something breaks, describe the symptom:

> My gateway models disappeared from `/model`. Diagnose and fix it.

> Codex fails, but Claude models still work. Repair Model Gateway.

## Troubleshooting model visibility

If GPT-6 Astra is missing from `/model`, check the installed and serving claude-code-proxy version before diagnosing account access. Astra requires version 0.1.36 or newer. Version 0.1.35 does not include its backend allowlist, and the current `doctor` check can still report `PASS` when Astra is the missing row. Ask Claude to rerun `setup`, which fetches the latest GitHub release, then fully restart Claude Code. A `models.json` edit cannot add a backend that the proxy does not allow.

Authentication recovery has a different boundary. Complete `login` and let Claude run `setup` again; the refreshed credential can serve the already-running proxy, so a process restart is not required just for auth. Settings, discovery-cache, plugin, or model-row changes do require a full restart of the affected project process. `/reload-plugins` alone is not enough.

## Local gateway records

The shim writes request-route metadata to `$CLAUDE_CONFIG_DIR/model-gateway/logs/request-routes.jsonl` by default. Records contain the time, backend, model, request path, route and effort when present, and safe session or agent correlation fields. They do not contain request bodies, prompts, messages, tools, authentication, or arbitrary headers. Set `CODEX_GATEWAY_REQUEST_LOG=0` before the shim starts, then restart the shim through `setup` or `ensure`, to disable this route log. The setting is read by the shim process at startup. `CODEX_GATEWAY_REQUEST_LOG_PATH` changes the file location.

Usage observability also keeps one high-water JSON file per valid session under `$CLAUDE_CONFIG_DIR/model-gateway/request-body/`. It records only the largest forwarded request-body byte count seen for that session and an observation timestamp. It does not contain the request body. No retention period is promised for either local record.

Remote Control gives each project two choices.

### Use RC-compatibility mode

RC-compatibility keeps Model Gateway routed for the project. It maps `api.anthropic.com` to loopback in the hosts file and needs the gateway shim to bind port 80. Gateway rows disappear from `/model`, but only in RC-compatibility mode, explicit gateway ids such as `/model claude-gpt-5.6-terra` still work.

Tell Claude you want to enable, disable, or diagnose RC-compatibility. Its read-only diagnosis checks port 80 before any hosts-file change. If another process already holds the port, RC-compatibility cannot start until that process releases it. Docker Desktop is a common holder and is named in the refusal.

### Turn the gateway off for this project

To get Remote Control without RC-compatibility, remove only `ANTHROPIC_BASE_URL` from the `env` object in that project's `.claude/settings.local.json`. Keep every other gateway setting, then restart Claude Code. The project talks to `api.anthropic.com` directly and Remote Control becomes available.

That project has no gateway models after the restart: gateway rows disappear from `/model` and typed gateway ids do not work either. A manually exported `ANTHROPIC_BASE_URL` still wins over the file edit, so remove that environment variable before restarting if the project remains wired.

The generated [Model Gateway reference](../../reference/model-gateway/) records the agent-facing commands and configuration details used by the skill.
