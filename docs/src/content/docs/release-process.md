---
title: Release process
description: Maintainer workflow for moving verified Loadout changes to the marketplace.
---

## Maintainer overview

Loadout publishes from `main`. A release cut creates a marketplace tag, `v<marketplace-version>`, and a tag for each released plugin, `<plugin>-v<plugin-version>`. The `Publish GitHub Release` workflow runs for pushes of `v*` tags, on its daily schedule, and when manually dispatched. It creates GitHub Releases only for marketplace tags, so per-plugin tags do not create GitHub Releases.

## Prepare a release

1. Add a fragment under `.release/unreleased/` with the plugin, change type, and user-facing summary.
2. Check the queue and preview the release:

   ```text
   sidequest publish queue
   node scripts/release/cut.mjs --dry-run
   ```

3. Run the publish cut:

   ```text
   node scripts/release/cut.mjs --push
   ```

The release cut owns plugin manifest versions. Do not hand-edit a manifest to guess the next version. `hold: true` in a fragment holds only that fragment for a later cut. A `.release/HOLD` file holds the whole release window, though a hotfix still runs while it is present.

The `Test` and `Release guard` workflows run on pull requests and pushes to `main`. `Test` always runs. `Release guard` always runs its pull-request checks, including the fragment-coverage check that fails a plugin change shipping with no release note — nothing downstream catches that omission, so it is never gated. The repository `RELEASE_AUTOMATION` variable (`active`, `on`, `true`, or `1`) governs only the stricter `main`-mode checks, which compare versions against the previous head and require a `CHANGELOG.md` touch; while it is staged or paused, a push to `main` reports that and passes through, and pull requests are still checked. The `--push` cut holds the publish lock for the release transaction and stops before changing the release window when the lock is unavailable. Before publishing, it checks the `Test` workflow on the pinned commit the release is built from, not on the remote `main` head. A failed or missing run stops the cut unless an explicit `--ci-override "<reason>"` records why it may proceed.

## When the cut stops

The cut also runs tests itself. It writes the release commit and every tag locally, then runs the test suite of each plugin the release moves, and only pushes if they all pass. `--dry-run` lists those suites under `suites (N)`, so you can see what a cut will run before it runs it. With `--trust-ci`, a suite that fails locally while the `Test` workflow passed on the pinned commit itself becomes a recorded warning instead of a stop; it refuses when no CI verdict was checked, beside `--ci-override`, and in hotfix mode. After the pushes, the cut checks that every planned tag resolves on the remote and fails naming any that are missing.

A failing suite publishes nothing, but the local release commit and its tags are already written by that point. When no push has run, the cut rolls them back itself: it resets to the previous head and deletes each tag it created that still points at the release commit. It never rolls back once any push started. It also skips the rollback when the remote already has a planned tag, or when the remote's publish branch contains the release commit, even if someone has built on it since. The cut checks that against the branch tip the remote reports, fetching the remote's commits when this clone lacks them. A remote it cannot read or fetch counts as carrying the release, so nothing is reset.

Every check the cut makes against a remote (the tag listings, the publish-branch read, and the fetch behind it) runs without prompting and within a time bound. Git runs with `GIT_TERMINAL_PROMPT=0`, and ssh gets `-o BatchMode=yes` added to the ssh command you already use, so your key and agent still work but a password, passphrase, or unknown-host prompt fails instead of waiting. Connect to a new host once by hand to accept its key. Each check is killed after 60 seconds, and `LOADOUT_RELEASE_REMOTE_TIMEOUT_MS` changes that bound. A remote that fails or runs out of time counts as one the cut could not check, never as an answer.

`--keep-on-failure` keeps the failed window for inspection instead, and a failed first push leaves it in place too. In both cases the cut prints a `git reset --hard` back to the previous head and a `git tag -d` naming every tag it created. Run both. A reset alone leaves the tags behind, and a later cut for the same version will not be able to create them.

A local-only tag that already names a planned version stops the cut. The cut first checks the annotated tag's tagger against this clone's release identity (the committer identity plus any `loadout.releaseTagger` config values). A foreign tag, fetched from another remote, gets a `git tag -d` plus a `tagOpt --no-tags` fix for that remote. A matching tagger is not proof that this clone made the tag, because the same person's other clone stamps the same name and email. So a tag with a matching tagger is a leftover from an unpublished attempt only when the remotes prove it was never published: no configured remote lists the tag (`git ls-remote --tags` against each one), and neither the remote's publish branch nor any remote-tracking branch contains its commit. One on a commit the publish branch already contains should be pushed, not deleted. A leftover can be deleted, or recreated at the new release commit with `--force`.

`--force` is a local repair only. It recreates proven leftovers and nothing else. A foreign tag, a tag another remote already has, a tag on a commit any remote branch contains, or a tag the cut could not check against every configured remote still stops the cut, and the tag is not moved. A planned tag that already exists on the remote always stops the cut before anything is built, because the cut never force-pushes and so cannot move a published tag.

`--allow-dirty` tolerates unstaged and untracked files only outside the release. A local change to any path the release writes or removes stops the cut before it changes anything, because the release commit would take the change in and a rollback would discard it. That covers the released plugin manifests, the marketplace manifest, the changelogs, and the consumed fragments.

Deleting tags by hand needs the publish lock, because Sidequest refuses a manual `git tag` on this repository without one. Acquire it with `sidequest publish lock`, delete the tags, then `sidequest publish unlock`. The refusal blocks the whole shell invocation, so run the lock, the deletion, and the unlock as three separate commands rather than chaining them.

This gate is local and it runs on your machine, so a test that reads your own environment can fail here while CI is green on the same commit. That is a bug in the test, not a reason to skip the gate.

A failure that disappears when you rerun the failing file on its own is a different problem: a concurrency flake, usually two test files sharing a fixture, or a reader parsing a file another test is still writing. It is still worth stopping for, because an intermittent that can fail a cut can fail CI later. Undo the window, run the failing file alone to confirm, cut again, and file the flake as its own ticket so the next cut does not pay for it twice.

GitHub Releases publish at most once per UTC day. When several marketplace tags land before the daily publish, the workflow releases the newest unreleased tag and generated notes cover the intermediate versions from the previous published Release. A cut whose release workflow succeeds under that cap reports the deferral as successful, and the scheduled publish catches it up.

Executors stop at a verified commit. Integration, release cutting, manifest versioning, and publishing happen after their submission.

See [`scripts/release/README.md`](https://github.com/poindexter12/loadout/blob/main/scripts/release/README.md), [`.release/README.md`](https://github.com/poindexter12/loadout/blob/main/.release/README.md), and the [workflow docs](https://github.com/poindexter12/loadout/tree/main/.github/workflows) for current safeguards.
