---
name: agent-harness
description: Coordinate project lifecycle, batch production, requirements analysis, and deterministic gate verification through Agent Harness.
---

# Agent Harness Skill for OpenCode

Use this skill when orchestrating multi-step software delivery, quality loops, or batch production runs.

## Core Mandates
- Do not make unauthorized edits outside `allowedPaths`.
- Never bypass Gate verification; P0-P3 findings must be resolved before closure.
- Query `harness_status` before starting work to avoid epoch drift.
