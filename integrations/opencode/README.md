# Agent Harness OpenCode Plugin

Experimental OpenCode channel providing initialization/read-only tools and write-boundary enforcement for Agent Harness. It does not claim lifecycle execution until OpenCode supplies every required native visible-host callback.

## Features
- **Native Tools**: `harness_init`, `harness_status`, `harness_gate`; initialization reads the project-owned `harness.json`, uses the Core InitPlan/Receipt, and requires an external Authority Decision file
- **Write Guard**: Reads the actual tool output arguments and enforces explicit targets inside managed scopes
- **Fail-closed Host Adapter**: Requires native spawn, inspect, wait, result, cancel, Host Effect reconciliation, and Lease confirmation callbacks
- **Lifecycle Status**: Unsupported without those callbacks; commands do not create a Run or synthesize success
