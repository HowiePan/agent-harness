---
description: Route and execute an Agent Harness workflow action, or initialize workspace with "init [actor]".
agent: build
---

Examine the requested Agent Harness argument: "$ARGUMENTS".
1. If $ARGUMENTS starts with "init":
   Call the `harness_init` tool with actor extracted from arguments (if empty, default to "howie") and file="harness.json". Report the registration result.
2. Otherwise:
   Execute the requested workflow action:
   - Resolve the target project and workflow intent.
   - Query `harness_status` to ensure no conflicting active Run is running.
   - Coordinate execution through `harness-worker` following strict quality criteria.
   - Execute `harness_gate` before closing the lifecycle run.

