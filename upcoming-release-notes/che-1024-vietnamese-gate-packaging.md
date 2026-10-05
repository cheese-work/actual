---
category: Maintenance
authors: [congvc-dev]
---

Stage the fork-owned Vietnamese translation only when the declared current screen batch in `locale-fork/batches.json` is complete (none is declared yet, so Vietnamese stays hidden), and run the batch gate as a required CI check. Only the validated declared and shared keys (plural forms expanded) are written to the staged file; out-of-batch translations are never shipped, and a null manifest stages nothing. Declaring and accepting a batch remains a separate CHE-830/CHE-831 decision.
