import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config/defaults.js";
import { FakeConnector } from "../src/connectors/fake.js";
import { ParticipantRegistry } from "../src/connectors/registry.js";
import { SwitchError } from "../src/domain/errors.js";
import { SwitchDatabase } from "../src/persistence/database.js";
import { RouterService } from "../src/routing/router-service.js";
import { RouterSessionStore } from "../src/routing/session-store.js";

function routerFixture(handler?: ConstructorParameters<typeof FakeConnector>[0]): {
  readonly database: SwitchDatabase;
  readonly router: RouterService;
  readonly connector: FakeConnector;
} {
  const database = new SwitchDatabase(":memory:");
  const config = structuredClone(defaultConfig);
  for (const connector of Object.values(config.connectors)) connector.enabled = false;
  config.connectors["fake"] = {
    kind: "embedded",
    enabled: true,
    environmentAllowlist: [],
    secrets: {},
    billingType: "local_compute",
    config: {},
  };
  for (const participant of Object.values(config.participants)) {
    participant.connector = "fake";
    participant.enabled = true;
  }
  const connector = new FakeConnector(handler);
  const registry = new ParticipantRegistry(config).register(connector);
  return {
    database,
    router: new RouterService(config, registry, new RouterSessionStore(database)),
    connector,
  };
}

void test("deterministic router selects bounded plans by difficulty", async () => {
  const context = routerFixture();
  try {
    const easy = await context.router.route({
      query: "What is 2 + 2?",
      cwd: process.cwd(),
      deterministic: true,
    });
    assert.equal(easy.decision.strategy, "single");
    assert.equal(easy.validation.outcome, "accepted");

    const hard = await context.router.route({
      query:
        "Implement and security audit a production distributed database migration with concurrency controls.",
      cwd: process.cwd(),
      deterministic: true,
      sessionId: easy.session.id,
    });
    assert.equal(hard.decision.strategy, "council");
    assert.equal(hard.session.history.length, 2);
    assert.ok(hard.decision.selectedParticipants.length >= 3);
  } finally {
    context.database.close();
  }
});

void test("LLM router proposal is authorized and compiled by deterministic code", async () => {
  const context = routerFixture((_participant, request) => {
    assert.equal(request.metadata?.["purpose"], "routing");
    return JSON.stringify({
      strategy: "cascade",
      reason: "Use a coding primary and independent analyst.",
      difficulty: { level: "medium", confidence: 0.8 },
      selectedParticipants: ["codex-architect", "gemini-analyst"],
      protocolId: "cascade",
      critiqueRounds: 0,
      alternatives: ["grok-challenger"],
    });
  });
  try {
    const result = await context.router.route({
      query: "Review this implementation.",
      cwd: process.cwd(),
    });
    assert.equal(result.source, "llm");
    assert.equal(result.validation.outcome, "accepted");
    assert.equal(result.decision.proposedPlan.mode, "routed");
  } finally {
    context.database.close();
  }
});

void test("invalid LLM routes fall back to an authorized deterministic plan", async () => {
  const context = routerFixture(() =>
    JSON.stringify({
      strategy: "single",
      reason: "Attempt an incompatible protocol.",
      difficulty: { level: "low", confidence: 0.9 },
      selectedParticipants: ["codex-architect"],
      protocolId: "tournament",
      critiqueRounds: 0,
      alternatives: [],
    }),
  );
  try {
    const result = await context.router.route({
      query: "What is 2 + 2?",
      cwd: process.cwd(),
    });
    assert.equal(result.source, "deterministic-fallback");
    assert.match(result.fallbackReason ?? "", /protocol_error|internal_error/u);
    assert.equal(result.validation.outcome, "accepted");
    assert.equal(result.decision.proposedPlan.protocolId, "direct");
  } finally {
    context.database.close();
  }
});

void test("router records a sanitized fallback reason and does not retry exhausted quota", async () => {
  const context = routerFixture(() => {
    throw new SwitchError({
      code: "quota_exhausted",
      message: "Router provider quota is exhausted.",
      retry: "non_retryable",
      details: { stderr: "must not leak" },
    });
  });
  try {
    const result = await context.router.route({
      query: "Review this implementation.",
      cwd: process.cwd(),
    });
    assert.equal(result.source, "deterministic-fallback");
    assert.equal(result.fallbackReason, "quota_exhausted: Router provider quota is exhausted.");
    assert.equal(context.connector.calls.length, 1);
    assert.equal(result.session.history[0]?.fallbackReason, result.fallbackReason);
    assert.doesNotMatch(JSON.stringify(result), /must not leak/u);
  } finally {
    context.database.close();
  }
});

void test("human-gate routing compiles an actual durable human gate", async () => {
  const context = routerFixture(() =>
    JSON.stringify({
      strategy: "human_gate",
      reason: "Require a human authorization decision.",
      difficulty: { level: "high", confidence: 0.95 },
      selectedParticipants: ["codex-architect"],
      protocolId: "direct",
      critiqueRounds: 0,
      alternatives: [],
    }),
  );
  try {
    const result = await context.router.route({
      query: "Perform a sensitive operation.",
      cwd: process.cwd(),
    });
    assert.equal(result.source, "llm");
    assert.equal(result.decision.proposedPlan.protocolId, "human-gated-direct");
    assert.equal(result.decision.proposedPlan.stages[0]?.operator, "human_gate");
  } finally {
    context.database.close();
  }
});
