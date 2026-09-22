---
description: Route and execute an Agent Harness workflow action.
agent: build
---

Execute the requested Agent Harness action: $ARGUMENTS.
1. Resolve the target project and workflow intent.
2. Query `harness_status` to ensure no conflicting active Run is running.
3. Coordinate execution through `harness-worker` following strict quality criteria.
4. Execute `harness_gate` before closing the lifecycle run.
