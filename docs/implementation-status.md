# Implementation Status

This file distinguishes implemented local-v0.1 behavior from roadmap scope.

## Implemented

- Standalone strict TypeScript package and generated JSON Schemas.
- Versioned config, legacy migration, atomic backups, and typed participant/profile
  management commands.
- Participant port plus Codex, Antigravity, Grok, OpenCode, OpenRouter, generic
  HTTP, fake, and JSON-RPC plugin connectors.
- SQLite migrations, event journal, projections, attempts, artifacts, router
  sessions, evaluations, backups, and schema-versioned verifiable exports.
- Direct, council, and routed plans through one executor.
- Thirteen protocol presets, including durable human-gated direct execution, and
  enum-only predicates.
- LLM and deterministic routing with hard plan authorization, typed provider
  failure fallback, and durable sanitized fallback reasons.
- Budgets, retries, concurrency, circuit breakers, cancellation, recovery,
  pause/resume, fork, human gates, stage-level limits, and durable wall-time
  accounting.
- Enforced private, role, identity-stripped council, council, judge-only,
  public-result, and audit-only artifact visibility.
- Schema-validated structured decisions with explicit consensus, dissent,
  unresolved questions, risks, actions, and confidence, plus a plain-text
  compatibility fallback.
- CLI, interactive full-screen TUI (default entry), setup wizard surface,
  session modes (council/routed/plan), config sources (default/manual/auto),
  built-in tool host (fs/search; optional network), in-process API, HTTP/SSE,
  TypeScript client, Paseo RPC, metrics, and structured logging.
- Explicit plugin trust controlled by user configuration, bounded canonical
  package hashes, and denial of self-asserted first-party authority.
- OpenTelemetry API spans around durable run execution.
- Offline contract, integration, recovery, security, and interface tests.

## Experimental

- Research protocol fidelity beyond the documented stage topology.
- Plugin ABI and community manifests.
- Router quality heuristics and LLM proposal prompting.
- Evaluation metrics beyond deterministic references.
- Cached-artifact routing. The reserved `cached` proposal strategy is denied and
  falls back instead of being represented as a cache hit.

## Remaining Stable-v1 Release Gates

- Safe run-import support; portable run export is implemented.
- Matched-budget statistical benchmark reports and published quality evidence.
- Cross-platform CI evidence, performance/soak baselines, and compatibility
  fixtures from released upstream CLI versions.
- Signed public release artifacts, external security review, and a real support
  contact/repository policy.
- First-party Claude Code and OS-enforced plugin sandbox adapters. The current
  user roster does not require Claude Code.

## Deferred By The Approved Local-v1 Scope

- Hosted multi-tenancy, PostgreSQL, worker fleets, RBAC, and SSO.
- Community registry distribution and OS-enforced plugin network/filesystem
  sandbox tiers.
- Web UI (terminal TUI is implemented for local interactive use).
- MCP and ACP client/server packages.
- Call-level routing, unbounded tree/graph search, and composite participants.
- Public quality claims before matched-budget benchmark results exist.

The complete design and delivery rationale remains in [`plan/`](plan/).
