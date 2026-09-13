# Pseudo-command adapter contract

`h:<project-alias> <action> <target> [preset]` is the portable conversational command envelope. The alias explicitly selects a Project Registry identity; it is installation data rather than a hard-coded project type. The envelope contains no model, provider, Runtime, language, or build-system identity. `h:where [project-alias]` is the read-only binding query.

The adapter only parses the envelope. It never starts a Run. Resolution is performed in this order:

1. Codex supplies `PLUGIN_ROOT` and writable `PLUGIN_DATA` to the plugin Hook;
2. the Hook reads the exact Harness and project bindings from `PLUGIN_DATA/bindings.json` (the install source may seed `.plugin-data/bindings.json`);
3. the command's explicit project alias selects one project ID, Profile ID, and Extension ID;
4. the bound standalone Project Registry provides that exact Project Descriptor;
5. the Descriptor and installed Extension artifact identities must match the binding;
6. the Extension's `commandManifest` resolves the action/alias and optional preset.

The resulting intent binds `controlRoot`, `entrypoint`, `dataRoot`, `workspaceRoot`, project alias, `projectId`, Profile and Extension identities, action, target, preset, declared scope, source policy, current Authority revision, and a new command ID. Runtime, model, tool, Gate, storage, and concurrency selections remain Descriptor/Extension concerns.

Unknown projects and actions, missing bindings, workspace mismatch, and ambiguous inputs fail closed. The adapter must not scan disks or map inputs through natural-language similarity. The optional preset is one token; a manifest may declare a parameterized prefix such as `item:` and receives the suffix as a selector. Arguments are data, never executable shell fragments.

After resolution, use the packaged Operator Contract. Feature remains the lease unit, Steps stay serial inside a Feature, all current-cycle P0-P3 findings block formal quality closure, and every Dispatch, Gate, Decision, Evidence item, and Receipt stays bound to versioned identities and content digests.

Inspection language such as “只评估”“不要启动”“dry-run” means resolve and report only. It never creates or resumes a Run. Publication, commit, tag, cutover, live hard recovery, and legacy deletion keep their separate approval requirements.

Codex implements the adapter with a `UserPromptSubmit` Hook plus this single Skill. Another tool can implement the same parser and Operator Contract without adopting Codex files or changing the command envelope.
