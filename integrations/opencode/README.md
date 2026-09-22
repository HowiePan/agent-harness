# Agent Harness OpenCode Plugin

Native OpenCode plugin providing first-class tool definitions, subagent coordination, and write boundary guards for Agent Harness.

## Features
- **Native Tools**: `harness_status`, `harness_gate`
- **Subagent Integration**: `harness-worker` pre-configured in `opencode.json`
- **Write Guard**: Intercepts unauthorized file modifications via `tool.execute.before`
- **Host Adapter**: Implements the `VisibleHostAdapter` contract for OpenCode
