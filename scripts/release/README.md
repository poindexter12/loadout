# Release engine

These scripts build the release from the repository tree. They use Node 22 and the standard library, so a release runner needs no install beyond the repository checkout.

| Script | Writes | What it does |
| --- | --- | --- |
| `note.mjs` | one fragment | Records what an integrated ticket releases |
| `plan.mjs` | nothing | Shows the release window the cut would build |
| `cut.mjs` | the release | Bumps versions, writes changelogs, consumes fragments, creates tags, runs suites, and optionally publishes |
| `guard.mjs` | nothing | Checks release invariants in CI |

See [`.release/README.md`](../../.release/README.md) for the fragment schema.

## Release authority

The orchestrator owns the release cut from `main` at `HEAD`. Each integrated ticket gets one fragment in `.release/unreleased/`. Ticket work records the fragment and does not hand-edit plugin or marketplace versions. `cut.mjs` reads the queued fragments, applies the version bumps, writes the changelogs, removes the consumed fragments, creates the release commit and tags, and runs the suites for changed plugins.

A normal cut defaults to the current `main` checkout. Use `--sha <rev>` only when the release window must be pinned to a specific descendant of `main`. The cut checks the branch and fast-forward relationship before it writes anything.

## Delivery and GitHub Releases

The marketplace is delivered through `main` and its marketplace tag, `v<marketplace-version>`. When `--push` is used, the cut publishes those two refs together in one atomic push. Plugin version tags, `<plugin>-v<plugin-version>`, are published in a second atomic push. These pushes are separate, so the release process never promises one atomic update across `main`, the marketplace tag, and every plugin tag.

The GitHub Release workflow is notification-only. It runs for marketplace `v*` tag pushes, on its daily schedule, and on manual dispatch. The daily cap can defer the GitHub Release, but it does not delay the already-published marketplace `main` branch or marketplace tag. Plugin tags do not create GitHub Releases.

`--push` acquires the Sidequest publish lock before changing the local release window. It also checks the Test workflow on the pinned commit the release is built from, not on whatever the remote `main` head happens to be. A failed or missing run stops the cut unless `--ci-override "<reason>"` records why it may proceed. `--trust-ci` goes the other way: when that Test workflow passed on the pinned commit itself, a failing local suite is recorded as a warning (`suiteWarnings` in `--json`) instead of stopping the cut. It refuses when no CI verdict was checked, beside `--ci-override`, and in hotfix mode. After the pushes, the cut checks that every planned tag resolves on the remote and fails naming any that do not. The lock is released after the pushes or any failure.

## Workflow

At integration time, record one fragment for the ticket:

```bash
node scripts/release/note.mjs SQ-843 --title "Build the release engine" --plugins sidequest --bump minor --commit "$(git rev-parse HEAD)"
```

Inspect the queued window, then preview it from `main` at `HEAD`:

```bash
node scripts/release/plan.mjs
node scripts/release/cut.mjs --dry-run
```

Build the release locally, or build and publish it:

```bash
node scripts/release/cut.mjs
node scripts/release/cut.mjs --push
```

`--dry-run` writes nothing. Without `--push`, the cut creates the local commit and tags and prints the exact publish commands. Other useful options include `--sha <rev>`, `--skip-tests`, `--allow-dirty` for unstaged or untracked files outside the paths the release writes, `--keep-on-failure` to keep a failed unpublished window for inspection, and `--force` to override a hold or recreate this clone's own leftover local tags. `--force` is local only: the pushes are never forced, so it cannot repair or move a tag on the remote. A hotfix selects tickets explicitly:

```bash
node scripts/release/cut.mjs --mode hotfix --tickets SQ-843,SQ-845 --push
```

Run `--help` for the complete option list.

## Recovery

Everything before the first remote push is local. If a suite or invariant fails before any push ran, the cut rolls the window back itself: it resets to the previous `HEAD` (`--hard` from a clean start, `--keep` after an `--allow-dirty` start so your edits survive) and deletes each tag it created that still points at the release commit. It rolls back only when no push started, `HEAD` is still the release commit, and the remote has no planned tag and a publish branch that does not contain the release commit. Containment is checked against the branch tip the remote reports, fetching its commits if this clone lacks them, so a remote that has built on the release commit counts as carrying it. If the remote cannot be read or fetched, or does not answer within the probe bound (see Safeguards), the cut does not roll back. In every other case it prints the undo commands instead. `--keep-on-failure` keeps the commit and tags and prints the reset plus a `git tag -d` for every tag. Run both before retrying, because a reset alone leaves local tags behind.

If the first atomic push fails, nothing is rolled back automatically. Confirm the remote has neither the release commit nor its tags, then run the printed reset and `git tag -d`.

A local-only tag that already names a planned version stops the cut. A tag the release identity did not make, including a lightweight tag, is foreign: it came from another remote's fetch. Delete it and set `git config remote.<name>.tagOpt --no-tags` on that remote. The release identity is the committer identity plus every `git config --add loadout.releaseTagger "<name or email>"` value. A matching tagger narrows the question but proves nothing, since the same person's other clone stamps the same identity, so the remotes decide the rest. A tag another configured remote lists is published, not a leftover. A tag on a commit the remote's publish branch already contains is unpushed (push it). A tag on a commit any remote-tracking branch contains was published somewhere. Only a tag that every configured remote answered for, with none of those matches, is a leftover from an unpublished attempt (delete it, or pass `--force` to recreate it at the new release commit). If any remote does not answer `git ls-remote --tags` within the probe bound, or the cut cannot otherwise tell, the tag is unverified or unknown: retry once every remote answers. `--force` recreates leftovers only. Every other case still stops the cut under `--force`, and the tag stays where it was.

If the first atomic push succeeds and the separate plugin-tag push fails, `main` and the marketplace tag remain published. Inspect the remote, then publish the missing plugin tags with the plugin-tag push command printed by the cut. Do not rerun the whole cut or move an already-published marketplace tag.

If the pushes succeed and the GitHub Release is deferred by the daily cap, leave the marketplace refs in place. The scheduled workflow publishes the newest unreleased marketplace tag.

## Safeguards

- A staged index always stops the cut. `--allow-dirty` only tolerates unstaged and untracked files outside the release. Any local change to a path the release writes or removes (a released manifest, a changelog, a consumed fragment) stops the cut before anything changes, dry runs included.
- Manifest versions must match the plan when the cut writes the release.
- A planned tag that already exists on the remote always stops the cut, `--force` included: the pushes are never forced, so no option moves a published tag. `--force` only recreates this clone's own leftover local tags.
- Every remote probe runs without prompting and within a time bound. That covers the `git ls-remote` tag and branch reads and the `git fetch` behind the containment check, in the `--force` checks and the rollback check alike. Git runs with `GIT_TERMINAL_PROMPT=0`. Ssh runs with `-o BatchMode=yes` appended to the command git would have used (`GIT_SSH_COMMAND`, then `core.sshCommand`, then `GIT_SSH`), so your key, agent, and options still apply, but a password, passphrase, or unknown-host prompt fails instead of waiting. Connect to a new host once by hand to accept its key. Each probe is killed after 60 seconds, and `LOADOUT_RELEASE_REMOTE_TIMEOUT_MS` changes that bound. A probe that fails or times out means the remote could not be checked: `--force` refuses and leaves the tag where it was, and a failed cut is not rolled back. Pushes are not bounded.
- The cut rechecks the release commit, index, and tags after suites run, before it publishes.
- Suites run with release credentials and Sidequest runtime identity removed from their environment.

## Tests

```bash
node --test scripts/release/test/*.test.mjs
```

The release tests use throwaway repositories and local bare remotes. They do not contact a network. They cover planning, version bumps, changelogs, the separate push stages, recovery, tag checks, and suite safeguards.
