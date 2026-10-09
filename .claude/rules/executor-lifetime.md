---
description: A dispatched executor is not yours to stop
priority: 5
---
- A dispatched executor is not yours to stop. Let it run to completion, timeout, or failure.
- If one looks stuck, report what you see (ticket ref, elapsed time, last recorded activity) and let the user decide. Do not call TaskStop on it.
- TaskStop is for background shell tasks you started yourself, such as dropping an `assemble-wave` that is holding the board lock through a whole suite.
- Evidence: every TaskStop aimed at an executor dispatch id (`sq-*`) has been user-rejected, 12 for 12 across six days; every one aimed at a background shell task id (`b*`) was approved.
