# Configuration

The current schema is
[`config-v2.schema.json`](../schemas/config-v2.schema.json).

## Layers

Switch merges built-in, user, workspace, and request layers. Objects merge
recursively; arrays replace the previous layer. The resolved config is validated
after migration and merge.

## Participants

A participant assigns:

- A connector and model.
- Kind, display name, role, and mandate.
- Expertise and routing tags.
- Billing and free-only policy.
- Connector-specific settings.

Profiles select participants and define mode, protocol, synthesizer or router,
rounds, and hard budgets.

Use typed mutation commands for routine changes:

```bash
switch config participant set <id> --model <model> --role <role>
switch config participant set <id> --enable
switch config participant set <id> --disable
switch config participant clone <source> <target>

switch config profile set <id> --participant <member...>
switch config profile set <id> --protocol <protocol> --synthesizer <member>
switch config profile clone <source> <target>
```

When a participant or its connector is disabled, default profile compilation
omits that member. Explicitly requesting a disabled participant still fails
closed. `config export` writes the fully resolved configuration; `config import`
validates a complete JSON or YAML configuration before replacing the user
configuration.

## Secrets

Configuration stores secret references, never secret values:

```json
{
  "apiKey": {
    "source": "environment",
    "key": "OPENROUTER_API_KEY"
  }
}
```

Official subscription CLIs remain the authentication owner. HTTP connectors can
resolve declared environment references. Keychain and encrypted-file references
are reserved but not implemented in local v0.1.

Personal subscription connectors are allowed only when
`policy.allowPersonalSubscriptions` is `true`. They are rejected both during
plan validation and authorization when disabled, and are always rejected by the
hosted deployment policy.

## Plugins

External JSON-RPC plugins are denied by default. Trust is owned by user
configuration, never by a package's self-declared `trust` field:

```json
{
  "plugins": {
    "trustedPluginIds": ["my-reviewed-plugin"],
    "allowUntrusted": false,
    "allowUnsafeNetwork": false
  }
}
```

Prefer enumerating reviewed IDs in `trustedPluginIds`. `allowUntrusted: true`
loads every structurally valid package in the plugin directory and should be
limited to disposable development environments. Network-requesting plugins also
require `allowUnsafeNetwork: true` because local v0.1 cannot enforce network
containment. Package roots and contents must be regular files/directories
without symlinks; optional manifest hashes cover a canonicalized manifest and
the complete bounded package inventory.

## Legacy Migration

Legacy `version: 1` seats are converted to v2 participants and profiles in
memory. Run `switch config init` after reviewing `switch config show` to
persist v2. Every replacement of an existing config creates a timestamped
`config.json.bak-*` copy before the atomic rename.
