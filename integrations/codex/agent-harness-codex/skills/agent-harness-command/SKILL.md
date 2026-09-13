---
name: agent-harness-command
description: "Resolve and execute short Agent Harness pseudo-commands such as h:quality V3.8.4 or h:req V3.8.4 expand-to-plan through the current project's registered Extension command manifest. Use whenever a prompt starts with h: or asks how to invoke a repeatable Harness lifecycle action without composing a prompt."
---

# Agent Harness Command

Treat a prompt matching `h:<action> <target> [preset]` as a deterministic Command Intent. The prefix identifies Agent Harness only; the action does not identify a project, Profile, tool, Runtime, or model.

Before any mutation:

1. Use the session working directory to locate exactly one registered local Project Descriptor. Do not infer the project from the target text or repository name.
2. Verify the Descriptor's Harness and Extension artifact identities against the standalone registries.
3. Select the installed Extension Pack whose `commandManifest.profileId` matches the Descriptor Profile, then resolve the action, alias, target kind, preset, scope, and mutation policy from that manifest.
4. Read current Authority and perform a read-only preflight. A missing project, ambiguous project, unknown action, unknown preset, digest mismatch, or unmet prerequisite ends as `attention-required`; never substitute a similar action.
5. For a state-changing intent, use the exact current revision and a fresh command ID, then follow `$agent-harness-operator` until the manifest's scoped stop condition. For a read-only intent, do not create a Run, schedule work, run a Gate, or write Authority.

Never interpret command arguments as shell text. Never append free-form prompt text to change the declared scope. Runtime, model, tools, Gate recipes, paths, and concurrency come only from the Project Descriptor and approved Extension Registry.

If the user asks to evaluate, explain, dry-run, or not start, report the resolved intent and prerequisites only. This instruction overrides a manifest's state-changing default for that turn and creates no Authority.

Read [the pseudo-command contract](../../references/pseudo-command-contract.md) for the stable adapter boundary and stopping rules.
