# Source-link native Host readiness

Before the first source-link Coordinator launch, run the bound `scripts/local-source-host-probe.mjs` with its exact `--bindings-dir` and verified current `--session-id`. Preserve its live process session and service its one native `collaboration.list_agents` request with the exact emitted arguments. The probe creates no Run and starts no Agent. Require terminal `ok: true`; a missing or failed probe blocks startup.

If it exits `CODEX_ROLLOUT_DATABASE_UNAVAILABLE`, retry only this exact probe once with narrowly scoped sandbox escalation for read-only access to the current Codex SQLite record. If that probe passes, use the same narrow escalation on the first bound Coordinator launch; do not first launch it in the known-failing sandbox. Do not retry a failed Coordinator using this rule. Other probe errors, including a native-result timeout, do not authorize this retry.

A logical Codex session may resume into another paginated physical rollout. Its original UUID date and `session_meta` cannot identify the current file. Never scan for a substitute, copy the database, edit Codex data, or handwrite a Host response. The exact current SQLite row, workspace, native call and output bindings remain mandatory. Narrow escalation is for the official probe or exact bound Coordinator, not a CLI Agent or a generic shell exemption.

This readiness check does not authorize a business command without the current Hook intent, a fresh intent invented in conversation, or relaunching an exited lifecycle Coordinator. Keep the single-command and allowed-retry rules in the Command Skill.
