---
name: agent-harness-extension-author
description: Create or change Agent Harness Extension Packs, Profiles, or plugins with versioned contracts and conformance tests. Use for upstream Harness extensibility work; do not use to vendor or patch Harness source inside a consumer repository.
---

# Agent Harness Extension Author

Make changes in the independent `agent-harness` source repository. Consumer repositories may supply a sanitized reproduction but must not receive a copied Harness implementation.

First classify the change as Kernel, Profile, plugin, tool integration, Skill adapter, or legacy compatibility. Keep the Kernel free of business, provider, model, language, and build-system names. Prefer a declarative Project Descriptor or Profile; use project-specific code only in an explicitly installed Extension Pack.

An Extension Pack has a stable lowercase ID, semantic version, immutable artifact digest, and explicit Profiles, plugin factories, recovery importers, or build-time operations. Plugins return only versioned Intent, Event, or Receipt envelopes and never mutate Authority. Process-capable plugins must declare managed outputs, budgets, retention, cleanup, and sandbox requirements.

Register Extension artifacts beneath the standalone control root. Do not load changed code under an existing installation receipt, and do not search a consumer repository for executable extensions.

Add a regression test at the narrowest owning layer and run the full project, conformance, canary, packaged-install, path-boundary, and residue checks before release. Do not silently replace an already published artifact: fix unreleased V1.0.0 work under a new commit digest, and use a patch version after V1.0.0 is published.

Read [references/extension-contract.md](references/extension-contract.md) when implementing or reviewing an Extension Pack.
