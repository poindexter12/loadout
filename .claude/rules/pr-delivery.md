---
description: Every commit reaches main through a pull request
priority: 50
---
- `main` is never advanced by a direct push. Ticket work reaches it through a pull request with the
  required checks green, and nothing else does.
- A branch-protection refusal is an instruction, not an obstacle. "Changes must be made through a
  pull request" or "N of N required status checks are expected" means stop and open the PR. Bypass
  rights existing is not permission to use them; only the user may decide to bypass, explicitly, for
  that specific push.
- **Chunk the work.** One PR per integrated wave, or per coherent group of tickets touching the same
  area. Never accumulate a backlog of integrated commits and push them as one lump — on 2026-10-13 76
  commits went to `main` in a single bypassing push, which is unreviewable and unrevertable per
  ticket.
- The board can do this from sidequest 5.10.0 (SQ-340): `sidequest board-config --delivery-channel pr`
  makes `integrate` push a wave branch and open the PR itself, leaving local `main` alone. Turn it on
  once this machine actually runs 5.10.0 or later — merging the fix is not enough, the release has to
  be cut, the plugin updated, and the session restarted.
- Until then, the hand procedure stands. After a wave integrates: push the integrated range as a
  branch (`git push -u origin HEAD:refs/heads/<branch>`), open the PR against `main`, and leave local
  `main` alone until it merges. Then `git fetch origin` and reconcile local `main` to `origin/main`
  before the next integrate.
- Auto-merge does not fire on this repository. `gh pr merge --auto` has been armed and silently failed
  to land a green PR twice (#37, #39), so merge every green PR explicitly and confirm `main` moved.
- One exemption, and it is the only one: `scripts/release/cut.mjs --push` publishes `main` and its
  tag atomically under the Sidequest publish lock. It is release-owned and pre-push-hook enforced.
  Everything it publishes must already have arrived on `main` through a PR.
- Never weaken a branch ruleset, a required check, or the pre-push hook to make a push succeed.
