# Repository scripts

The scripts here support repository maintenance, measurement, and release work. The release engine lives in
`scripts/release/`; its README is the source for fragment, planning, cut, and guard commands.

## Transcript measurement

`measure.mjs` estimates one-shot and carried tool-result context volume from explicitly selected
local Claude Code `.jsonl` files or shallow directories. It has no dependencies or network access,
never changes transcripts or settings, and emits only aggregates. These are approximate token
volumes, not dollar savings or proof that a read can be offloaded.

```bash
node scripts/measure.mjs --help
node scripts/measure.mjs --json /path/to/project-transcripts
node --test scripts/test/measure.test.mjs
```

Defaults: at least five usage-bearing messages per file and 8,000 returned text characters for a
bulk-read candidate. Override with `--min-turns` and `--min-chars`. Subagent directories must be
passed explicitly. See the [methodology and limits](../docs/src/content/docs/architecture/transcript-measurement.md)
before interpreting the output. Tests use synthetic transcripts only.

## Release work

Release publication normally uses `node scripts/release/cut.mjs --push`. Preview with
`node scripts/release/cut.mjs --dry-run` first; `--push` acquires the Sidequest publish lock before
it changes the release window and releases it after the push or a failure. If another publisher
holds the lock, it stops before changing the window. Wait for the holder, or reclaim a confirmed
stale lock with `sidequest publish lock --steal --by <who>`.

For the manual fallback, acquire the Sidequest publish lock, run `cut.mjs` without `--push`, use
its printed `git push --atomic` command, then unlock.

The release tests run with Node 22 and use throwaway local repositories for git behavior:

```bash
node --test scripts/release/test/*.test.mjs
```
