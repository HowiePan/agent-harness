# Pseudo-command adapter contract

`h:<action> <target> [preset]` is the portable conversational command envelope. It is intentionally smaller than any Project Profile and contains no project, model, provider, Runtime, language, or build-system identity.

The adapter only parses the envelope. It never starts a Run. Resolution is performed in this order:

1. session working directory;
2. standalone Project Registry;
3. one registered Project Descriptor whose local workspace contains that directory;
4. the Descriptor's exact installed Extension Pack identities;
5. one `commandManifest` matching the Descriptor Profile;
6. action/alias and optional preset declared by that manifest.

The resulting intent binds `projectId`, Profile and Extension digests, action, target, preset, declared scope, source policy, current Authority revision, and a new command ID. Runtime, model, tool, Gate, storage, and concurrency selections remain Descriptor/Extension concerns.

Unknown and ambiguous inputs fail closed. The adapter must not map them through natural-language similarity. The optional preset is one token; a manifest may declare a parameterized prefix such as `item:` and receives the suffix as a selector. Arguments are data, never executable shell fragments.

After resolution, use the packaged Operator Contract. Feature remains the lease unit, Steps stay serial inside a Feature, all current-cycle P0-P3 findings block formal quality closure, and every Dispatch, Gate, Decision, Evidence item, and Receipt stays bound to versioned identities and content digests.

Inspection language such as “只评估”“不要启动”“dry-run” means resolve and report only. It never creates or resumes a Run. Publication, commit, tag, cutover, live hard recovery, and legacy deletion keep their separate approval requirements.

Codex implements the adapter with a `UserPromptSubmit` Hook plus this single Skill. Another tool can implement the same parser and Operator Contract without adopting Codex files or changing the command envelope.
