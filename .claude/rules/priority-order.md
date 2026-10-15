---
description: Work the board in priority order
priority: 45
---
- Address board items in priority order: `urgent` before `high`, `high` before `normal`, `normal`
  before `low`. Oldest-first within a priority. This is the order the board already hands work out
  in (`PRIORITY_RANK` in `plugins/sidequest/src/lib/store.ts`, honored by both `ready` and
  `claimNext`), so a session that dispatches out of order is overriding the board, not following it.
- Before dispatching anything, check whether unblocked ready work exists at a higher priority. If it
  does, dispatch that first. Do not reach past an urgent to pick up a high, or past a high to pick up
  a normal.
- File-overlap clustering decides *which* same-priority tickets run concurrently. It never justifies
  starting a lower-priority ticket while higher-priority ready work is waiting. If the highest
  priority band is fully blocked or already in flight, say so explicitly before dropping a band.
- A ticket that is genuinely blocked (`blocked-by` an open ticket, or parked on a pending submission)
  is not "ready" and does not hold up the band. Blocked work is skipped, not waited on.
- Priority is the user's lever on sequencing. Changing what gets worked next by re-prioritizing a
  ticket is their call; silently working a lower band because it is easier or better isolated is not.
