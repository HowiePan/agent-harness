# Operator Contract

## Normal lifecycle

1. `doctor` must be read-only.
2. Resolve the initialized standalone control root and verify its release manifest.
3. Load registered Extension Packs from installation receipts before reading or creating a run.
4. Register or read the Project Descriptor from the Harness Project Registry, not the business repository.
5. Start a run with its selected Profile and immutable Feature graph.
6. Schedule eligible Features using the configured Scheduler.
7. For each Dispatch, verify packet digest, bind a Runtime receipt to a Lease, and wait for a structured result.
8. Derive changed files from workspace snapshots. Preserve result, runtime, output-cleanup, sandbox, and Gate receipts as Evidence.
9. Record completion, blocker, failure, finding, decision, or Gate result through Kernel commands with expected revision and a unique command ID.
10. Repeat until closure is allowed or user authority is required.

Feature Steps remain serial within one Feature. Separate Features may run concurrently only when dependencies, conflict paths, lane policy, logical limits, and physical capacity all permit it.

## Attention conditions

Stop and report the exact Authority state when a user decision is required, a required Extension is absent or identity-mismatched, a required sandbox cannot be applied, source drift is detected, a write path leaves the standalone control root, a budget is exceeded, a revision conflicts, or retries are exhausted.

## Recovery

Ordinary resume invalidates obsolete Transport and continues the same Epoch under a new Generation. Hard recovery requires a fully verified Recovery Capsule: reject links and source drift, recompute the strict manifest/assessment/payload inventory, and create a time-bounded content-addressed verification Receipt bound to the exact Importer, project, run, current generation, and target Epoch. Record a separate approved `live-hard-recovery` Decision that binds the verification reference, expected revision, and target Epoch; then execute through the Recovery Coordinator with that Decision ID and a stable command ID. The Coordinator re-verifies the Capsule, archives a rollback snapshot, creates the new Epoch, invalidates every legacy Lease, and marks prior completion for current-evidence revalidation. Never accept a standalone assessment JSON or execute code stored in a Recovery Capsule.

## Output control

Every process-capable plugin declares output roots, file and byte budgets, retention, cleanup behavior, and sandbox mode. Successful and failed operations must produce a cleanup receipt. Retained Evidence is deliberate state; ephemeral output must be removed before the plugin returns.
