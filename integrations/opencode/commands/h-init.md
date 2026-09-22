---
description: Initialize and register Agent Harness from project-owned harness.json.
agent: build
---

Initialize and register Agent Harness for this project:
1. Require an explicit Authority Decision file in `$ARGUMENTS`.
2. Call the `harness_init` tool with decisionFile="$ARGUMENTS", file="harness.json", and projectRoot set to the current project. Never create or infer an approval.
3. Report the initialization receipt, project or Workspace identity, alias, and revision.
