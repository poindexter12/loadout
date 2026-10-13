---
description: Automated release policy
paths: [".live-rules-never-match/**"]
prompt: ["ship", "publish", "release", "bump", "hotfix", "marketplace"]
---
- Integrate ticket work on `main`; write a release fragment in the same push with `node scripts/release/note.mjs <REF> --plugins <p> --bump <level> --commit <sha>`.
- Executors author their own `.release/unreleased/<REF>.md` when a submission changes a published plugin; Sidequest grants only the matching ticket fragment. Integration brings that fragment to `main` with the ticket commit.
- Versions, tags, and changelog edits are release-owned; only `scripts/release/cut.mjs` writes them.
- Run `node scripts/release/cut.mjs --dry-run` from a clean tree, then publish with `node scripts/release/cut.mjs --push`. `--push` acquires the Sidequest publish lock before it changes the release window and releases it after the push or a failure; a held lock stops the cut before it changes the window.
- For a normal window whose `Test` workflow succeeded on the exact pinned commit, `cut.mjs` skips local plugin suites and reports that it used CI; pass `--force-local-tests` to run them anyway. Missing, failed, or overridden CI leaves the local suite run unchanged.
- That skip needs the run to have actually run each released plugin's suite, not just to have concluded success. `Test` short-circuits a plugin's leg when the commit touched none of that plugin's paths, so a fragment-only or ledger-only commit goes green having tested nothing. `cut.mjs` reads each leg's suite step from the run record and refuses the window when a released plugin's suite was skipped or absent, naming it. `--force-local-tests` is the answer: it runs those suites locally and records `ci.status: "uncovered"`. `--skip-tests` and `--trust-ci` do not escape it; `--ci-override "<reason>"` still does, and stays a human judgement call.
- The pre-push hook enforces the publish lock on `main`.
- `.github/workflows/release.yml` is the sole GitHub Release publisher. It handles `v*` tag pushes, daily catch-up, and manual dispatch, with a one-Release-per-UTC-day cap; `cut.mjs --push` atomically publishes `main` and the tag that workflow notifies users about.
