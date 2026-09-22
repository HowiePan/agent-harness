# Security Policy

Report vulnerabilities privately to the repository owner before creating a public issue. Do not attach credentials, tokens, private prompts, raw business data, Authority stores, Evidence payloads, or Recovery Capsules to a public report.

Supported security fixes target the latest published V1 release. A report should include the affected release digest, Extension and Plugin identities, a sanitized reproduction, impact, and whether the issue crosses workspace, process, output, sandbox, Authority, or Evidence boundaries.

The project rejects writes outside its own project root, direct plugin Authority mutation, undeclared process output, required-sandbox fallback, and executable content in Recovery Capsules. Suspected bypasses of these controls should be treated as security issues.
