# Contributing

All Harness fixes and extensions are developed in this repository. Do not copy Harness source into a consumer repository.

Before opening a change:

1. Classify it as Core, Profile, plugin, integration Skill, or Legacy Compatibility.
2. Add a minimal synthetic regression test at that boundary.
3. Keep consumer and provider names out of the default composition and Kernel.
4. Declare process outputs, budgets, retention, cleanup, and sandbox behavior.
5. Run `npm run check`, `npm test`, `npm run check:clean-room`, and `npm run pack:dry-run`.

Use `schemas/defect-bundle.schema.json` for defects discovered by a consumer. Remove credentials, private prompts, personal paths, and business data before attaching a bundle.

V1.0.0 remains one delivery scope until first publication; candidate builds are identified by commit and release-manifest digest. Published artifacts are immutable. Compatible fixes after publication use a patch version.

Real cutover, live hard recovery, publication, destructive migration, Recovery Capsule removal, and deletion of any legacy Harness require separate owner approval.

