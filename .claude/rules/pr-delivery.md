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
- **The board does this itself now.** `deliveryChannel` mode `pr` is enabled on this board (since
  2026-11-05), so `integrate` assembles the wave on `sidequest/wave/<waveId>` from `origin/main`,
  pushes it, opens one PR, and returns `awaiting-merge` with the tickets still `doing`. It runs no
  local full suite, takes no publish lock, and never pushes `HEAD:main`. CI on that PR is the wave
  gate. Re-call `integrate` on the same refs, without `wave`, to reconcile once CI settles: merged
  closes every participant with the PR merge commit as delivery; still pending returns
  `awaiting-merge`; `wave_ci_failed`, `wave_pr_closed_unmerged`, `wave_merge_unreachable`, and
  `pr_delivery_unavailable` refuse and carry a `guidance` field with the next step.
- Do not hand-push a wave branch while that mode is on — it would duplicate the board's PR. The hand
  procedure (`git push -u origin HEAD:refs/heads/<branch>`, open the PR, leave local `main` alone,
  then `git fetch origin` and reconcile) is the fallback for `local` mode only.
- Auto-merge does not fire on this repository. `gh pr merge --auto` has been armed and silently failed
  to land a green PR twice (#37, #39), so merge every green PR explicitly and confirm `main` moved.
- One exemption, and it is the only one: `scripts/release/cut.mjs --push` publishes `main` and its
  tag atomically under the Sidequest publish lock. It is release-owned and uses the ruleset's admin
  bypass; there is no pre-push hook in this repo to enforce it. Everything it publishes must already
  have arrived on `main` through a PR.
- Never weaken a branch ruleset or a required check to make a push succeed.
