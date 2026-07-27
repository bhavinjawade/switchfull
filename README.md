# Switch

Switch is a standalone, local-first runtime for LLM councils, structured
debates, dynamic model routing, and evaluation. It can use official subscription
CLIs without extracting their credentials, free OpenCode/OpenRouter models, and
OpenAI-compatible HTTP endpoints.

Switch is independent of Paseo. Paseo support is an adapter over the same
`RunService`, durable journal, protocol engine, and router used by the CLI, SDK,
and HTTP API.

## Capabilities

- Direct, fixed-council, and dynamic-router execution modes.
- Thirteen built-in protocols: direct, human-gated direct, independent
  critique/synthesis, self-consistency, generator-critic-verifier, jury,
  ReConcile-style rounds, multi-agent debate, tournament, mixture-of-agents,
  pair-rank/fusion, cascade, and courtroom.
- Selectable members, roles, mandates, synthesizer, router, rounds, and budgets.
- Codex, Antigravity, Grok Build, OpenCode, OpenRouter, and generic
  OpenAI-compatible connectors.
- Durable SQLite runs, append-only event journal, immutable artifacts, recovery,
  cancellation, pause/resume, fork, and human gates.
- Persistent router sessions with LLM proposals, deterministic authorization,
  bounded repair, deterministic fallback, and durable sanitized fallback reasons.
- Schema-validated final decisions with consensus, dissent, unresolved questions,
  risks, actions, confidence, and a plain-text compatibility fallback.
- Local HTTP/SSE API, TypeScript SDK, Prometheus metrics, OpenTelemetry spans,
  and Paseo-compatible JSONL RPC.
- Dataset evaluation, separate-process JSON-RPC plugins, verifiable run exports,
  and verified database/artifact backups.

## Requirements

- Node.js 26 or newer.
- npm 11 or newer.
- Any subscription CLIs you choose to enable, authenticated through their own
  official login flow.

```bash
npm install
npm run build
npm link
switch            # interactive TUI (default)
switch doctor     # connector health
```

Switch never reads Codex, Antigravity, Grok, OpenCode, or Pi credential
stores. Process connectors receive an explicit environment allowlist.

## Default Council

The balanced profile uses:

| Participant             | Access path            | Default model                                    | Role       |
| ----------------------- | ---------------------- | ------------------------------------------------ | ---------- |
| Codex Architect         | Codex subscription CLI | `gpt-5.6-sol`                                    | Architect  |
| Gemini Analyst          | Antigravity CLI        | `gemini-3.1-pro-high`                            | Analyst    |
| Grok Challenger         | Grok Build CLI         | `grok-4.5`                                       | Challenger |
| Open-source Critic      | OpenCode free catalog  | `opencode/deepseek-v4-flash-free`                | Critic     |
| OpenRouter Free Analyst | OpenCode/OpenRouter    | `openrouter/nvidia/nemotron-3-nano-30b-a3b:free` | Analyst    |

OpenCode participants configured as `free-only` reject any model that is not an
OpenCode free model or an OpenRouter `:free` model. The optional direct
OpenRouter connector also enforces a `:free` suffix by default.

## Interactive TUI

Running `switch` with no arguments opens the full-screen terminal UI (splash,
dual-pane session, slash commands). See [docs/tui.md](docs/tui.md).

```bash
switch              # splash → session
switch tui          # same
# Inside: /setup /mode /config /council /goal /plan /tools /help
```

## CLI

```bash
# Catalogs and connection diagnostics
switch profiles
switch protocols
switch participants
switch doctor
switch setup
switch connect codex
switch connect codex --login

# Fixed council or a different protocol
switch ask --profile balanced "Review this architecture"
switch ask --profile debate "Argue both sides and reach a judgment"
switch ask --profile jury "Select the most defensible answer"

# Dynamic routing, with an LLM router or deterministic baseline
switch route --profile router-balanced "Implement this change"
switch route --execute "Implement and verify this change"
switch route --deterministic "Classify this small request"

# Durable operations
switch runs list
switch runs show <run-id>
switch runs cancel <run-id>
switch runs resume <run-id>
switch runs fork <run-id>
switch runs recover
switch runs export <run-id> ./run-export
switch runs verify-export ./run-export

# Evaluation and backup
switch eval run cases.jsonl --profile quick balanced
switch db status
switch db backup
switch db verify-backup <backup-directory>
```

Add `--json` before a command for machine-readable output. Human progress is
written to stderr; result data is written to stdout.

## Configuration

Configuration layers are merged in this order:

1. Versioned built-in defaults.
2. User configuration at `~/.switch/config.json`.
3. Workspace configuration at `.switch/config.json` or `.yaml`.
4. Per-request overrides.

Set `SWITCH_HOME`, `SWITCH_CONFIG`, `SWITCH_DATABASE`, or
`SWITCH_ARTIFACTS` to override storage paths. Legacy v1 seat configuration
is migrated in memory to v2 participant configuration with warnings.

```bash
switch config path
switch config show
switch config validate
switch config init
switch config participant set oss-critic --model opencode/mimo-v2.5-free --role Verifier
switch config participant set openrouter-free-analyst --disable
switch config profile clone balanced my-council --label "My Council"
switch config profile set my-council \
  --participant codex-architect gemini-analyst grok-challenger \
  --synthesizer codex-architect --rounds 1
switch config export ./switch-config.json
switch config import ./switch-config.json
```

See [configuration.md](docs/configuration.md) and
[connectors.md](docs/connectors.md).

## API And SDK

```bash
switch serve
# http://127.0.0.1:8787/v1/health
```

Non-loopback binding requires `--token`. The API supports durable run lifecycle,
SSE event replay, catalogs, routing, human input, exports, evaluation, and
Prometheus metrics.

```ts
import { SwitchClient } from "switch/client";

const client = new SwitchClient();
const run = await client.createRun({
  query: "Compare these implementations",
  profileId: "balanced",
});
```

See [api.md](docs/api.md).

## Paseo

Paseo can register Switch as a Pi-compatible provider:

```json
{
  "extends": "pi",
  "enabled": true,
  "label": "Switch",
  "command": ["switch"]
}
```

The RPC adapter advertises every configured profile, maps cancellation and
progress frames, and returns the durable Switch run ID in provenance. Paseo
is not imported by the core runtime.

## Architecture

```text
CLI / HTTP / SDK / Paseo adapter
              |
       application services
              |
 protocol compiler -- deterministic policy -- dynamic router
              |
 durable executor -- scheduler -- participant registry
              |
 SQLite journal -- artifact store -- connector/plugin processes
```

Public wire contracts are generated into [`schemas/`](schemas/). Architecture
decisions and the full roadmap are under [`docs/`](docs/).

## Security Boundary

The current plugin tier provides a separate process, bounded I/O, cancellation,
manifest/package validation, explicit environment inheritance, and
configuration-owned trust. An external package cannot grant itself first-party
status. This tier does not claim OS-enforced filesystem or network sandboxing.
Hosted multi-tenancy, community registry distribution, and distributed workers
remain outside the local v0.1 security boundary.

See [security-model.md](docs/security-model.md) and [SECURITY.md](SECURITY.md).

## Development

```bash
npm ci
npm run check
npm pack --dry-run
```

Offline tests use fake participants and never require subscriptions, network
access, or credentials. Live model invocations are always explicit.
