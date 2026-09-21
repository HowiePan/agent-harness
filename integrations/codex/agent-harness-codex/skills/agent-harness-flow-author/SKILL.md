---
name: agent-harness-flow-author
description: Create or change an Agent Harness Flow package, its graph, nodes, result contracts, Extension binding, design page, and command-level closure verification.
---

# Author a Harness Flow

## Project-local write boundary

Treat the exact user-selected project checkout as the only source-edit destination. Before any filesystem mutation, resolve the physical current workspace/worktree, Git top-level and common directory, registered project root, and every intended source, control, data, temporary, build, cache, package, install, and generated-artifact destination. Source changes are allowed only when the write target is inside the exact checkout the user reviews and `git status` from that checkout will show them. Sharing a Git common directory is not sufficient. Do not create or use a sibling worktree, clone, mirror, staging repository, or project-external directory to bypass a workspace, sandbox, or permission boundary unless the user explicitly requested that exact location. If the active task is attached to another checkout, stop before writing and require the task to be opened or rebound to the registered project checkout.

Creating or registering any Git worktree is a protected mutation. Immediately before running the creation command, obtain the user's explicit authorization for the exact repository, base ref or branch, and target path. Never create a worktree silently. A general request to implement, continue, isolate work, use another drive, or avoid the current checkout is not worktree authorization. If authorization is absent, keep the current checkout unchanged and ask before creating anything.

On Windows, treat `C:\` as read-only for every Harness-related action. If any mutation target is on `C:\`, stop before writing and report the exact blocked path. A Codex-managed workspace/worktree, sandbox writable root, tool approval, or successful relative workspace-boundary check does not waive this rule. Read-only inspection on `C:\` is allowed. Use only the exact registered non-`C:\` project checkout and its declared non-`C:\` control roots. Never copy, move, delete, or transplant existing changes between checkouts without separate user approval. Before handoff, verify from the registered project root that `git status --short` exposes every source change; state explicitly that uncommitted changes are not portable to another computer and never commit or push without the user's authorization.

Use this for Flow implementation work. If the change only selects projects, sources, resources, or an existing Flow, use the workspace author workflow instead.

Read `docs/architecture/system-design.md` section “Flow 包设计规范” and the nearest existing `docs/flows/<flow-id>/design.md`. Build the standard package under `src/flows/<flow-id>/`: public index, Extension, deterministic Planner, graph, stage-grouped nodes, contracts, and policy. Add branches and commands only when needed. Keep business-specific Gates in an integration variant. Never import another Flow's private graph, nodes, or policy, and never write Kernel Authority from a node or Extension operation.

Give every result port a verifiable Schema ID and evidence rule. Declare execution class for every Extension operation. Add or update the Flow design page with inputs, graph, branches, outputs, permissions, Gate/Decision, failure recovery, Workspace slots, and a command that reaches `closed`.

Run `npm run check`, relevant contract tests, and a command-level end-to-end run. Inspect its Run ID, Workflow ID, terminal state, and Receipt. Update release metadata after changing packaged files. Follow the user's authorization for any real business run, install, publication, or Git action.
