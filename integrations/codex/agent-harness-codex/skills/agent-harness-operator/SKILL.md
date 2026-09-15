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
5. Read `policy.agentExecutionMode`, `policy.promptCodecPlugin`, and the selected Runtime and Prompt Codec manifests. Require every Dispatch to pin the Prompt Codec ID, plugin version, and Prompt Contract version. In an interactive Codex task, require the Descriptor to explicitly say `conversation-visible` and the Runtime to declare both `user-visible` and `host-orchestrated`, with no `process.spawn` permission. Never infer `headless` from a Runtime ID, missing adapter, CLI context, or automation-like wording; it requires an explicit user request for CI/unattended execution and an explicit Descriptor value.
6. Produce an action-scoped `ExecutionReadinessReport` for the exact immutable Plan. Do not create a Run unless the report is unexpired, digest-bound, includes a successful atomic write probe and Gate capability inventory, and has `executionReady=true`.

For `conversation-visible` execution, use the embedded visible lifecycle Coordinator after successful preflight. For every Dispatch it must take the generated `prompt.text`, `promptDigest`, `packetDigest`, Prompt Codec identity, and Prompt Contract version and pass `prompt.text` byte-for-byte as the complete user prompt to the host's native multi-agent delegation capability; do not summarize, prepend, append, translate, repair, interpolate, or compose substitute prose. The Codex host integration must use `createCodexVisibleHostAdapter` with native `spawnVisibleAgent`, `inspectVisibleAgent`, `waitVisibleAgent`, and `readVisibleResult` callbacks and pass it to `createHarness({ agentAdapter })`. The Coordinator persists the returned inspect reference in the Lease, re-observes at bind and heartbeat, and resumes active Leases from Authority after restart. Bind only through the trusted adapter, never through raw CLI JSON or direct Kernel/PluginHost calls. Every visible result must pass the strict transport schema; repair completion additionally requires non-empty verification checkpoints and host-preserved verification Receipts. If generated Prompt compilation, native visible delegation, trusted attestation, inspection, structured-result transport, heartbeat, or reattachment is unavailable, stop as `attention-required`; never improvise a prompt, call `codex exec`, another Agent CLI, a hidden process, headless `lifecycle execute`, `run execute`, or create an unrelated standalone task as a fallback.

Headless Agent execution is allowed only when the Descriptor explicitly selects `headless` and the user explicitly requested CI or unattended operation. Process-backed Runtime receipts and managed outputs remain Evidence, but headless mode is never inferred from a missing visible adapter.

After `start`, `resume`, or any scheduling action, keep coordinating while the run is active. Consume every Dispatch and Runtime result, bind its Lease, preserve receipts and Evidence, and continue until the run is closed, failed, or requires user authority. Do not treat a single completed child Agent as completion of the run. For deterministic Gate/build/test processes, attach a live progress observer before launch, announce each command or Gate, keep its terminal/progress surface observable, report meaningful output while it runs, and report completion or interruption. A missing observer is an execution error; do not suppress it or run the process silently. These processes must never perform Agent reasoning.

Never edit Authority files directly, reuse a command ID with different input, promote legacy completion without current-epoch Evidence, or bypass required P0-P3 findings and final Gates. A Runtime, model, tool, or sandbox is selected through the Project Descriptor and installed Extension Packs; do not assume a provider.

Obtain explicit user approval immediately before a real cutover, hard recovery of a live run, publication, destructive cleanup, or deletion of any legacy Harness. A live hard recovery must use a fresh content-addressed Capsule verification reference plus a recorded `live-hard-recovery` approval whose context binds the project, run, expected revision, verification reference, and target Epoch. The existence of a migration plan is not deletion approval.

For detailed event handling, recovery, and stopping conditions, read [references/operation-contract.md](references/operation-contract.md).
