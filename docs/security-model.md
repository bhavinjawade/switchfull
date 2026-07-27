# Security Model

## Enforced

- No shell interpolation for process connectors.
- Explicit child environment allowlists.
- Bounded process output, timeout, cancellation, and termination escalation.
- Deterministic plan and data-class policy.
- Hosted-policy denial for personal subscription connectors.
- Free-model enforcement for free-only OpenCode/OpenRouter participants.
- Local API loopback default and bearer requirement outside loopback.
- Immutable artifact hashes and journal payload hashes.
- Recipient-specific artifact visibility enforcement and configured identity
  metadata stripping at prompt-render boundaries.
- Canonical-path, symlink-escape, schema, checksum, event-sequence, and
  payload-hash verification for portable run exports.
- Plugin manifest validation, bounded package hashing, symlink denial,
  configuration-owned explicit trust, and JSON-RPC response correlation.
- Structured log redaction for authorization and secret fields.

## Tier 0 Limitation

Plugin and CLI child processes are isolated operationally, not sandboxed by an
OS security boundary. Tier 0 cannot prevent a trusted executable from reading
arbitrary user-readable files or opening network connections. Therefore:

- Every external plugin is denied unless explicitly trusted; manifest
  `first-party` labels do not grant authority.
- Network-requesting plugins require an unsafe opt-in.
- Filesystem permission fields are advisory until Tier 1/2 platform adapters.
- Subscription CLIs should run in their own plan/read-only modes.

## Data

`restricted` data is denied for external connectors. Artifacts and SQLite are
stored locally with user-only creation modes, but local v0.1 does not encrypt
them at rest. Backups and exports omit secret values but inherit the sensitivity
of prompts and model responses.

Hosted multi-tenancy, RBAC, remote workers, and enforceable community-plugin
sandboxing are not current claims.
