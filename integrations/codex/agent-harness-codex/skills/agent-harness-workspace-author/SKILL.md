---
name: agent-harness-workspace-author
description: Create or revise an Agent Harness Workspace with exact Flow bindings, projects, sources, execution targets, resource scopes, and command-level access verification.
---

# Author a Harness Workspace

Read `docs/architecture/system-design.md` sections “Workspace 与资源” and “接入与验证边界”, then `docs/guides/workspace-configuration.md`. Workspace configuration selects published Flows; it cannot edit their graph, branches, Gate or close rules.

Assign a stable ID and unambiguous alias. Bind each Flow by ID, version, Extension and artifact digest. Declare member projects, default project scope, source ownership/sharing, Runtime receivers, execution targets, and resource provider identities. Separate workspace-common and project-specific knowledge. Register or roll back with expected revision, unique command ID, and matching Authority Decision. Treat imported knowledge as unverified until the current source and reviewer establish it.

Verify a command resolves the intended Workspace and Flow and reaches `closed` in a synthetic run. Test rejection of ambiguous selection, unauthorized project/source/resource access, stale Plan, and provider mismatch. For added repositories, check coverage invalidation; for revocation, check that later Dispatch/read is blocked; for rollback, check that a new revision is created. Real business execution or external mutation follows the user's authorization.
