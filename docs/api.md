# HTTP API

The default endpoint is `http://127.0.0.1:8787`. Binding outside loopback
requires a bearer token.

## Catalogs

```text
GET /v1/health
GET /v1/profiles
GET /v1/protocols
GET /v1/participants
GET /v1/connectors/health
GET /v1/scheduler
GET /metrics
```

## Runs

```text
POST /v1/runs
GET  /v1/runs
GET  /v1/runs/:runId
GET  /v1/runs/:runId/events
POST /v1/runs/:runId/start
POST /v1/runs/:runId/pause
POST /v1/runs/:runId/resume
POST /v1/runs/:runId/cancel
POST /v1/runs/:runId/fork
POST /v1/runs/:runId/human-input
POST /v1/runs/:runId/export
```

Use `Accept: text/event-stream` or `?stream=true` on the events endpoint. Resume
with `?after=<sequence>`; durable events are replayed before live polling.

## Routing And Evaluation

```text
POST /v1/route
GET  /v1/evaluations
POST /v1/evaluations
```

Write payloads reject invalid plans before execution. Errors return a stable
error name and safe message. The TypeScript HTTP client is exported from
`switch/client`.

`POST /v1/runs` accepts a compiled `plan` or the same declarative inputs as the
CLI: `query`, `profileId`, `protocolId`, `participants`, `synthesizer`,
`critiqueRounds`, `parameters`, and `dataClass`. Set `execute` to start the
durable run immediately. Fork requests may override the same compilation inputs.

## TypeScript Client

```ts
import { SwitchClient } from "switch/client";

const client = new SwitchClient({
  baseUrl: "http://127.0.0.1:8787",
});

const { run } = await client.createRun({
  query: "Review this design",
  profileId: "balanced",
  dataClass: "internal",
});

await client.startRun(run.id);
for await (const event of client.streamEvents(run.id)) {
  console.log(event.sequence, event.type);
}
```

The client covers health and catalogs, connector health, scheduler state,
create/list/inspect/start/pause/resume/cancel/fork, human input, event replay and
SSE streaming, verifiable export creation, routing, evaluations, and metrics.
Run and router-session identifiers are validated as UUIDs at HTTP boundaries.
Routing responses identify whether their source was `llm`, `deterministic`, or
`deterministic-fallback`; fallback responses include a sanitized
`fallbackReason`, which is also retained in router-session history.
