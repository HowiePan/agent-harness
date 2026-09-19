---
name: agent-harness-flow-author
description: Create or change an Agent Harness Flow package, its graph, nodes, result contracts, Extension binding, design page, and command-level closure verification.
---

# Author a Harness Flow

Use this for Flow implementation work. If the change only selects projects, sources, resources, or an existing Flow, use the workspace author workflow instead.

Read `docs/architecture/system-design.md` section “Flow 包设计规范” and the nearest existing `docs/flows/<flow-id>/design.md`. Build the standard package under `src/flows/<flow-id>/`: public index, Extension, deterministic Planner, graph, stage-grouped nodes, contracts, and policy. Add branches and commands only when needed. Keep business-specific Gates in an integration variant. Never import another Flow's private graph, nodes, or policy, and never write Kernel Authority from a node or Extension operation.

Give every result port a verifiable Schema ID and evidence rule. Declare execution class for every Extension operation. Add or update the Flow design page with inputs, graph, branches, outputs, permissions, Gate/Decision, failure recovery, Workspace slots, and a command that reaches `closed`.

Run `npm run check`, relevant contract tests, and a command-level end-to-end run. Inspect its Run ID, Workflow ID, terminal state, and Receipt. Update release metadata after changing packaged files. Follow the user's authorization for any real business run, install, publication, or Git action.
