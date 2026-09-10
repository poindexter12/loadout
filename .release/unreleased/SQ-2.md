---
ref: SQ-2
title: "Observability data moves to ~/.claude/observability with automatic migration"
bump: minor
plugins: [observability]
commit: 4966e3e0e9b15ec59f8099b627e03a14c3dd524f
---

New default data directory ~/.claude/observability (override: OBSERVABILITY_HOME). An existing Eigenwise/Workbench directory is migrated automatically on first use; on failure the legacy directory stays in use.
