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
5. Read `policy.agentExecutionMode` and the selected Runtime manifest. In an interactive Codex task, require the Descriptor to explicitly say `conversation-visible` and the Runtime to declare both `user-visible` and `host-orchestrated`, with no `process.spawn` permission. Never infer `headless` from a Runtime ID, missing adapter, CLI context, or automation-like wording; it requires an explicit user request for CI/unattended execution and an explicit Descriptor value.

For `conversation-visible` execution, use `lifecycle start`, then schedule eligible Dispatches. For every Dispatch, read its immutable packet and use the host's native multi-agent delegation capability to create a visible child Agent. Immediately show the Feature, visible task identity, and initial status in the current conversation. Bind the Lease only through the trusted host adapter, never through raw CLI JSON or direct Kernel/PluginHost calls. The Runtime Receipt must bind the exact `agentId`, `dispatchId`, and `packetDigest`, include `visibility.mode: user-visible`, its surface kind, and an inspectable task reference, and receive a matching host attestation. While it runs, wait through the host, relay meaningful progress in the conversation, and record Harness heartbeats; at least one fresh heartbeat is required before submission. Submit the structured result and Evidence, then continue scheduling. If native visible delegation, trusted host attestation, inspection, or heartbeat recording is unavailable, stop as `attention-required`; never call `codex exec`, another Agent CLI, a hidden process, `lifecycle execute`, `run execute`, or create an unrelated standalone task as a fallback.

Headless Agent execution is allowed only when the Descriptor explicitly selects `headless` and the user explicitly requested CI or unattended operation. Process-backed Runtime receipts and managed outputs remain Evidence, but headless mode is never inferred from a missing visible adapter.

After `start`, `resume`, or any scheduling action, keep coordinating while the run is active. Consume every Dispatch and Runtime result, bind its Lease, preserve receipts and Evidence, and continue until the run is closed, failed, or requires user authority. Do not treat a single completed child Agent as completion of the run. For deterministic Gate/build/test processes, attach a live progress observer before launch, announce each command or Gate, keep its terminal/progress surface observable, report meaningful output while it runs, and report completion or interruption. A missing observer is an execution error; do not suppress it or run the process silently. These processes must never perform Agent reasoning.

Never edit Authority files directly, reuse a command ID with different input, promote legacy completion without current-epoch Evidence, or bypass required P0-P3 findings and final Gates. A Runtime, model, tool, or sandbox is selected through the Project Descriptor and installed Extension Packs; do not assume a provider.

Obtain explicit user approval immediately before a real cutover, hard recovery of a live run, publication, destructive cleanup, or deletion of any legacy Harness. A live hard recovery must use a fresh content-addressed Capsule verification reference plus a recorded `live-hard-recovery` approval whose context binds the project, run, expected revision, verification reference, and target Epoch. The existence of a migration plan is not deletion approval.

For detailed event handling, recovery, and stopping conditions, read [references/operation-contract.md](references/operation-contract.md).
