---
name: agent-harness-command
description: "Resolve explicit-project Agent Harness pseudo-commands such as h:engine quality V3.8.4, report installed bindings with h:where, and record conversation-backed issues with h:report. Use whenever a prompt starts with h: or asks how to invoke a repeatable Harness lifecycle action without composing a prompt."
---

# Agent Harness Command

Treat a prompt matching `h:<project-alias> <action> <target> [preset]` as a deterministic Command Intent. The project alias is an exact external binding, never a guess derived from a version, batch, path name, model, or action.

Treat `h:where [project-alias]` as read-only. Display the Hook-provided `controlRoot`, `entrypoint`, `dataRoot`, configured `workspaceRoot`, verified `executionWorkspaceRoot`, workspace match kind, binding source, and selected/all project bindings. Do not inspect Authority, run a Gate, or create/resume a Run.

Treat `h:report <project-alias>` as an explicit request to record the current problem in the bound upstream Harness repository. It is an Integration maintenance command, not an Extension lifecycle action, and must remain usable when the data root, Extension Registry, Project Descriptor, or Authority is unavailable. Do not create or delegate to another task.

For `h:report`:

1. Use only the Hook-provided project and Harness binding. Never scan for another repository or accept a user-supplied output path.
2. Extract only conversation excerpts relevant to the reported problem. Build an Issue Intake conforming to `issue-intake.schema.json`, set `conversation.source` to `current-thread`, explicitly confirm sanitization, and list unavailable evidence in `missingEvidence`; never invent identities or digests.
3. Invoke the exact bound entrypoint with `issue record --control-root <bound-control-root> --input - --command-id <hook-command-id>`, sending JSON through stdin so no intermediate file is created.
4. The recorder must write only beneath `<controlRoot>/issues`. Return the resulting issue ID and exact paths. State that the record remains device-local until the user separately chooses to commit and push it.
5. Do not start or recover a Run, execute a Gate, modify Authority, change an implementation, commit, or push as part of reporting.

For lifecycle commands other than `h:report`, before any mutation:

1. Require the Hook-provided binding resolved from `PLUGIN_DATA/bindings.json`. Use only its exact Harness entrypoint/data root and project ID; never scan the disk for Agent Harness or infer a project from the workspace. Use the Hook-verified `executionWorkspaceRoot`; a linked worktree is valid only when its Git common-directory identity matches the configured workspace.
2. Verify the bound Harness installation, Project Descriptor, and Extension artifact identities against the standalone registries.
3. Select the bound Extension Pack and require its `commandManifest.profileId` to equal the bound Profile, then resolve the action, alias, target kind, preset, scope, and mutation policy from that manifest.
4. Read current Authority and perform a read-only preflight. `doctor`, `extension list`, `project list`, and `run status` must not be treated as authorization to initialize directories. A missing project, ambiguous project, unknown action, unknown preset, digest mismatch, or unmet prerequisite ends as `attention-required`; never substitute a similar action.
5. If the bound CLI is denied access to its external control/data root by the task sandbox, request approval only for the exact bound Node entrypoint and command. Do not move the data root into the business repository, weaken the Project path policy, or request a generic shell/file-system exemption.
6. For a state-changing intent, use the exact current revision and a fresh command ID, pass `--execution-workspace <Hook-verified-executionWorkspaceRoot>` when starting a Run, then follow `$agent-harness-operator` until the manifest's scoped stop condition. The Project Descriptor must explicitly allow `workspace.rootSelector=git-worktree` before a linked worktree can be selected. For a read-only intent, do not create a Run, schedule work, run a Gate, or write Authority.

Never interpret command arguments as shell text. Never append free-form prompt text to change the declared scope. Runtime, model, tools, Gate recipes, paths, and concurrency come only from the Project Descriptor and approved Extension Registry. A missing/invalid binding is attention-required; do not repair it by searching the repository or other drives.

If the user asks to evaluate, explain, dry-run, or not start, report the resolved intent and prerequisites only. This instruction overrides a manifest's state-changing default for that turn and creates no Authority.

Read [the pseudo-command contract](../../references/pseudo-command-contract.md) for the stable adapter boundary and stopping rules.
