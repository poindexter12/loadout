---
description: Release-owned manifest versions
paths: [".claude-plugin/marketplace.json","plugins/*/.claude-plugin/plugin.json"]
priority: 0
---
- Non-version manifest metadata is normal ticket work: name, description, author, keywords, and entries.
- Only the `version` field is release-owned and written by `scripts/release/cut.mjs`; do not edit it during ticket work.
