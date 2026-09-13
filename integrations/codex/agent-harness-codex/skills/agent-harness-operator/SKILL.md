---
name: agent-harness-operator
description: Operate, resume, inspect, or recover an Agent Harness run while preserving Authority, extension, evidence, path, and user-approval boundaries. Use for Harness-controlled workflows; do not use for ordinary repository work that is not managed by Agent Harness.
---

# Agent Harness Operator

Treat Agent Harness Authority as the only workflow state. Agent conversation state, model output, process exit text, and projected reports are evidence or transport data, never Authority.

Before a state-changing operation:

1. Locate the standalone Agent Harness control root and its data root.
2. Read the registered Project Descriptor and verify every required Extension Pack version and artifact digest is installed.
3. Read current run status and use its exact revision with a new command ID.
4. Confirm all writable temporary, debug, build, cache, and evidence paths are declared beneath the standalone control root.

After `start`, `resume`, or any scheduling action, keep coordinating while the run is active. Consume every Dispatch and Runtime result, bind its Lease, preserve receipts and Evidence, and continue until the run is closed, failed, or requires user authority. Do not treat a single completed agent task as completion of the run.

Never edit Authority files directly, reuse a command ID with different input, promote legacy completion without current-epoch Evidence, or bypass required P0-P3 findings and final Gates. A Runtime, model, tool, or sandbox is selected through the Project Descriptor and installed Extension Packs; do not assume a provider.

Obtain explicit user approval immediately before a real cutover, hard recovery of a live run, publication, destructive cleanup, or deletion of any legacy Harness. The existence of a migration plan is not deletion approval.

For detailed event handling, recovery, and stopping conditions, read [references/operation-contract.md](references/operation-contract.md).
