# Extension Contract

## Pack boundary

An Extension Pack may register:

- Profiles that define workflow eligibility, projection, and closure policy;
- plugin factories for Scheduler, Runtime, Model Router, Tool Broker, Codec, Gate, Artifact, Storage, or OS Sandbox;
- read-only legacy importers;
- a declarative `commandManifest` that maps project-neutral action tokens and presets to one Profile's scopes;
- build-time descriptor or Feature-graph operations.

The command manifest is versioned data, not a Codex prompt. Action names use the portable `h:<action> <target> [preset]` envelope; project, provider, model, language, and build-system names stay out of the global router. Aliases must be unique within one manifest. Every action declares a target kind, a default preset, and presets with an explicit scope and mutation flag. A parameterized preset may declare a fixed argument prefix and receives only the non-empty suffix as a selector.

Default Harness creation installs no provider-specific, consumer-specific, or legacy Extension Pack. Installations require an approved Authority Decision, register Extension entrypoints under the standalone control root, reject symlink/junction traversal, and bind a complete artifact-manifest digest in an installation receipt. Bundle every runtime dependency inside that artifact root and list every file. Projects bind the exact Harness and required Extension identities in their central Project Descriptor; run start fails when an ID, version, or digest is missing or mismatched.

A legacy importer is read-only and deterministic. Its assessment must satisfy the strict migration-manifest schema, identify the exact importer version, and bind every fact to an inventoried source-file digest. It must not follow or omit symbolic links or junctions, add undeclared fields, retain private mutable state, or treat a legacy completion string as current Authority. Capsule creation normalizes the staged logical root to `payload` and rejects any mismatch between the staged inventory and importer assessment.

## Testing

Test manifest validation, denied permissions, immutable plugin envelopes, extension duplication, missing and mismatched identities, output budgets, cleanup receipts, fail-closed sandbox behavior, and packaged resolution of every declared entry. Consumer Profile tests use synthetic fixtures and must not read legacy Harness source.

## Defect handling

Capture the Harness release digest, Extension identities, sanitized Descriptor digest, command, Authority revision, Dispatch and Evidence references, expected result, actual result, and a minimal synthetic reproduction. Fix the owning upstream layer, publish an immutable release, then update the Project Registry binding. Emergency testing may point to a reviewed commit artifact; it must not create a consumer-local fork.
