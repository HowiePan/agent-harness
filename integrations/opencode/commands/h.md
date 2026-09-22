---
description: Inspect Agent Harness state or initialize a workspace with an external Authority Decision.
agent: build
---

Examine the requested Agent Harness argument: "$ARGUMENTS".
1. If $ARGUMENTS starts with "init <decision-file>":
   Call the `harness_init` tool with file="harness.json" and decisionFile set to the explicit decision file. Never create or infer an approval.
2. Otherwise:
   Query `harness_status` only, then report that OpenCode conversation-visible lifecycle execution is unsupported until a verified native host contract is installed.
