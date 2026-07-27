# Connectors

All integrations implement one `ParticipantPort` request/result contract.

| Connector         | Transport        | Authentication owner      | Billing class |
| ----------------- | ---------------- | ------------------------- | ------------- |
| Codex             | Process          | Official Codex CLI        | Subscription  |
| Antigravity       | Process          | Official Antigravity CLI  | Subscription  |
| Grok Build        | Process          | Official Grok CLI         | Subscription  |
| OpenCode          | Process          | OpenCode                  | Free tier     |
| OpenRouter        | HTTP or OpenCode | Environment/OpenCode      | Free tier     |
| OpenAI-compatible | HTTP             | Declared secret reference | Configured    |
| Plugin            | JSON-RPC process | Plugin-specific           | Manifest      |

Process connectors use argument arrays without a shell, bounded stdout/stderr,
timeouts, process-group cancellation, and explicit environment allowlists.

Run `switch doctor` to verify executable discovery and versions.
Authentication failures remain connector-owned; Switch does not inspect
credential files.

Recognized subscription CLI usage-limit, rate-limit, and authentication failures
are normalized to stable Switch error codes. Router fallback exposes only a
sanitized provider-level reason; raw CLI stderr and echoed prompts are not
included in the routing response.

On macOS, both Homebrew Codex and the ChatGPT-bundled Codex CLI may be present.
If the PATH version hangs or is not authenticated, configure the working
ChatGPT-bundled executable explicitly:

```json
{
  "connectors": {
    "codex": {
      "command": ["/Applications/ChatGPT.app/Contents/Resources/codex"]
    }
  }
}
```

OpenCode `free-only` participants permit model IDs ending in `-free` or `:free`,
the OpenCode free namespace, and `openrouter/openrouter/free`.
