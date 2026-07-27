# Security Policy

## Supported Versions

Until Switch reaches 1.0, only the latest released version receives
security fixes.

## Reporting

Do not open a public issue for a suspected vulnerability involving credential
exposure, sandbox escape, cross-run access, command injection, or malicious
plugins. Contact the maintainers privately through the security contact listed
on the project repository.

Include:

- Affected version and platform.
- Reproduction steps.
- Expected and observed behavior.
- Potential impact.
- Any logs after removing secrets.

## Security Boundaries

The current implementation is local-first. Third-party plugin loading and
hosted multi-tenancy are not stable security boundaries until their documented
release gates are complete.

Subscription connectors must delegate authentication to official tools and
must not read their credential stores.
