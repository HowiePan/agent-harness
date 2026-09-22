# Agent Harness VS Code Extension

Experimental VS Code extension exposing Agent Harness status and review surfaces. It does not claim lifecycle execution until a host supplies every required native visible-agent callback.

## Features
- **Project Initialization**: `Agent Harness: Initialize Project` or `@harness /init <decision-file>` reads the project-owned `harness.json` and uses the Core InitPlan/Receipt
- **Copilot Chat Participant**: `@harness /status`; `/full` and `/quality` return an explicit unsupported result and create no Run
- **Activity Bar View**: Shows verified Harness state or an explicit unsupported empty state
- **Diff Inspector**: Native side-by-side file review for Agent submissions
- **Fail-closed Host Adapter**: Requires native spawn, inspect, wait, result, cancel, Host Effect reconciliation, and Lease confirmation callbacks
