# Extension Contract

## Pack boundary

An Extension Pack may register:

- Profiles that define workflow eligibility, projection, and closure policy;
- plugin factories for Scheduler, Runtime, Model Router, Tool Broker, Codec, Gate, Artifact, Storage, or OS Sandbox;
- read-only legacy importers;
- build-time descriptor or Feature-graph operations.

Default Harness creation installs no provider-specific, consumer-specific, or legacy Extension Pack. Installations require an approved Authority Decision, register Extension entrypoints under the standalone control root, reject symlink/junction traversal, and bind a complete artifact-manifest digest in an installation receipt. Bundle every runtime dependency inside that artifact root and list every file. Projects bind the exact Harness and required Extension identities in their central Project Descriptor; run start fails when an ID, version, or digest is missing or mismatched.

## Testing

Test manifest validation, denied permissions, immutable plugin envelopes, extension duplication, missing and mismatched identities, output budgets, cleanup receipts, fail-closed sandbox behavior, and packaged resolution of every declared entry. Consumer Profile tests use synthetic fixtures and must not read legacy Harness source.

## Defect handling

Capture the Harness release digest, Extension identities, sanitized Descriptor digest, command, Authority revision, Dispatch and Evidence references, expected result, actual result, and a minimal synthetic reproduction. Fix the owning upstream layer, publish an immutable release, then update the Project Registry binding. Emergency testing may point to a reviewed commit artifact; it must not create a consumer-local fork.
