# Operator Contract

## Normal lifecycle

1. `doctor` must be read-only.
2. Resolve the initialized standalone control root and verify its release manifest.
3. Load registered Extension Packs from installation receipts before reading or creating a run.
4. Register or read the Project Descriptor from the Harness Project Registry, not the business repository. Static Registry readiness is not execution readiness.
5. Compile the exact Lifecycle Plan, then create a short-lived `ExecutionReadinessReport` that aggregates active immutable Runtime, Project/Extension identity, logical Run conflicts, workspace source, Runtime/Prompt/Host capabilities, active-Lease reattachment, every required Gate prerequisite and an atomic write probe. Start nothing unless `executionReady=true`.
6. Start a run with its selected Profile and immutable Feature graph, passing the unchanged Preflight Report.
7. Schedule eligible Features using the configured Scheduler.
8. For each Dispatch, verify packet digest. In `conversation-visible` mode, the embedded Host Coordinator creates a native visible child Agent, discloses its task identity/status, and uses the trusted host adapter to attest and bind its Agent/Dispatch/packet/prompt-specific Runtime receipt to a Lease before waiting for a structured result. After restart it must re-attest persisted active Leases before continuation. Direct Kernel/PluginHost calls and raw CLI receipt JSON are forbidden bypasses. In explicit `headless` mode, bind the selected headless Runtime receipt instead.
9. Derive changed files from workspace snapshots. Preserve result, runtime, verification, output-cleanup, sandbox, and Gate receipts as Evidence. Visible results pass the strict runtime schema at the Harness boundary.
10. Record completion, blocker, failure, finding, decision, or Gate result through Kernel commands with expected revision and a unique command ID. A quality review is read-only; every Finding creates a path-scoped repair, and a completed repair requires passing evidence-backed checkpoints plus host-preserved verification Receipts.
11. After the final repair in a wave, schedule a fresh full-scope read-only re-review against the new source digest. Reopen repeated Findings in a new repair round. Repeat until closure is allowed or user authority is required.

Feature Steps remain serial within one Feature. Separate Features may run concurrently only when dependencies, conflict paths, lane policy, logical limits, and physical capacity all permit it.

Interactive execution must not become opaque: a conversation-visible Runtime must be host-orchestrated and cannot hold `process.spawn`; it cannot be driven by the headless `RunCoordinator`; and failure to create, attest, observe, heartbeat or reattach a visible child Agent is attention-required with no CLI/process/standalone-task fallback. Record at least one fresh heartbeat before submission and keep the current conversation updated with its inspectable reference and meaningful status changes. Headless mode requires separate explicit authorization in both the user request and Project Descriptor and is never inferred.

## Attention conditions

Stop and report the exact Authority state when a user decision is required, a required Extension is absent or identity-mismatched, a required sandbox cannot be applied, source drift is detected, a write path leaves the standalone control root, a budget is exceeded, a revision conflicts, or retries are exhausted.

## Recovery

Ordinary resume invalidates obsolete Transport and continues the same Epoch under a new Generation. Hard recovery requires a fully verified Recovery Capsule: reject links and source drift, recompute the strict manifest/assessment/payload inventory, and create a time-bounded content-addressed verification Receipt bound to the exact Importer, project, run, current generation, and target Epoch. Record a separate approved `live-hard-recovery` Decision that binds the verification reference, expected revision, and target Epoch; then execute through the Recovery Coordinator with that Decision ID and a stable command ID. The Coordinator re-verifies the Capsule, archives a rollback snapshot, creates the new Epoch, invalidates every legacy Lease, and marks prior completion for current-evidence revalidation. Never accept a standalone assessment JSON or execute code stored in a Recovery Capsule.

## Output control

Every process-capable plugin declares output roots, file and byte budgets, retention, cleanup behavior, and sandbox mode. A process-backed Agent Runtime additionally declares `headless` and is rejected by a conversation-visible Project. Successful and failed operations must produce a cleanup receipt. Retained Evidence is deliberate state; ephemeral output must be removed before the plugin returns. Deterministic Gate/build/test processes require a live observer before launch and expose start, output/progress, finish, and interruption state to the operator; missing observation fails closed.
