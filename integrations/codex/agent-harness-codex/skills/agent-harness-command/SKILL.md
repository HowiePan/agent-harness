---
name: agent-harness-command
description: "Resolve explicit-project Agent Harness pseudo-commands such as h:engine quality V3.8.4, and report installed bindings with h:where. Use whenever a prompt starts with h: or asks how to invoke a repeatable Harness lifecycle action without composing a prompt."
---

# Agent Harness Command

Treat a prompt matching `h:<project-alias> <action> <target> [preset]` as a deterministic Command Intent. The project alias is an exact external binding, never a guess derived from a version, batch, path name, model, or action.

Treat `h:where [project-alias]` as read-only. Display the Hook-provided `controlRoot`, `entrypoint`, `dataRoot`, `workspaceRoot`, binding source, and selected/all project bindings. Do not inspect Authority, run a Gate, or create/resume a Run.

Before any mutation:

1. Require the Hook-provided binding resolved from `PLUGIN_DATA/bindings.json`. Use only its exact Harness entrypoint/data root and project ID; never scan the disk for Agent Harness or infer a project from the workspace.
2. Verify the bound Harness installation, Project Descriptor, and Extension artifact identities against the standalone registries.
3. Select the bound Extension Pack and require its `commandManifest.profileId` to equal the bound Profile, then resolve the action, alias, target kind, preset, scope, and mutation policy from that manifest.
4. Read current Authority and perform a read-only preflight. A missing project, ambiguous project, unknown action, unknown preset, digest mismatch, or unmet prerequisite ends as `attention-required`; never substitute a similar action.
5. For a state-changing intent, use the exact current revision and a fresh command ID, then follow `$agent-harness-operator` until the manifest's scoped stop condition. For a read-only intent, do not create a Run, schedule work, run a Gate, or write Authority.

Never interpret command arguments as shell text. Never append free-form prompt text to change the declared scope. Runtime, model, tools, Gate recipes, paths, and concurrency come only from the Project Descriptor and approved Extension Registry. A missing/invalid binding is attention-required; do not repair it by searching the repository or other drives.

If the user asks to evaluate, explain, dry-run, or not start, report the resolved intent and prerequisites only. This instruction overrides a manifest's state-changing default for that turn and creates no Authority.

Read [the pseudo-command contract](../../references/pseudo-command-contract.md) for the stable adapter boundary and stopping rules.
