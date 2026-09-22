---
description: Initialize and register Agent Harness workspace from local harness.json.
agent: build
---

Initialize and register the Agent Harness workspace for this project:
1. Call the `harness_init` tool with actor="$ARGUMENTS" (if empty, default to "howie") and file="harness.json".
2. Report the registration status, workspaceId, alias, revision, and configured sources and projects.
