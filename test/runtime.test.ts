import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config/defaults.js";
import { FakeConnector } from "../src/connectors/fake.js";
import { ParticipantRegistry } from "../src/connectors/registry.js";
import { FileArtifactStore } from "../src/persistence/artifact-store.js";
import { SwitchDatabase } from "../src/persistence/database.js";
import { RunRepository } from "../src/persistence/run-repository.js";
import { RunExecutor } from "../src/runtime/executor.js";
import { RunService } from "../src/runtime/run-service.js";
import type { ExecutionPlan } from "../src/schema/execution-plan.js";

type FakeHandler = NonNullable<ConstructorParameters<typeof FakeConnector>[0]>;

const noRetry = {
  maxAttempts: 1,
  initialDelayMs: 0,
  maxDelayMs: 0,
  backoffMultiplier: 1,
} as const;

function fixture(handler?: FakeHandler): {
  readonly directory: string;
  readonly database: SwitchDatabase;
  readonly service: RunService;
  readonly fake: FakeConnector;
} {
  const directory = mkdtempSync(join(tmpdir(), "switch-runtime-"));
  const database = new SwitchDatabase(join(directory, "data.sqlite"));
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
  const fake = new FakeConnector(
    handler ??
      ((participant, request) => {
        const stage = request.metadata?.["stageId"];
        return `${String(stage)} response from ${participant.id}`;
      }),
  );
  const registry = new ParticipantRegistry(config).register(fake);
  const repository = new RunRepository(database);
  const executor = new RunExecutor(
    repository,
    new FileArtifactStore(join(directory, "artifacts")),
    registry,
  );
  return {
    directory,
    database,
    service: new RunService(config, registry, repository, executor),
    fake,
  };
}

void test("RunService executes a durable council through the protocol plan", async () => {
  const context = fixture();
  try {
    const result = await context.service.run(
      {
        query: "Design a safe cache.",
        profileId: "balanced",
        critiqueRounds: 1,
      },
      { cwd: process.cwd() },
    );
    assert.equal(result.run.status, "completed");
    assert.equal(result.paused, false);
    assert.match(result.decision?.answer ?? "", /synthesis response/);
    assert.equal(context.fake.calls.length, 11);
    const inspected = context.service.inspect(result.run.id);
    assert.equal(
      inspected.stages.every((stage) => stage.status === "completed"),
      true,
    );
    assert.ok(inspected.events.some((event) => event.type === "RunCompleted"));
    assert.ok(inspected.artifacts.some((artifact) => artifact.kind === "final_decision"));
  } finally {
    context.database.close();
    rmSync(context.directory, { recursive: true, force: true });
  }
});

void test("RunService executes direct mode with one participant", async () => {
  const context = fixture();
  try {
    const result = await context.service.run(
      { query: "Answer.", profileId: "quick", protocolId: "direct" },
      { cwd: process.cwd() },
    );
    assert.equal(result.run.status, "completed");
    assert.equal(context.fake.calls.length, 1);
  } finally {
    context.database.close();
    rmSync(context.directory, { recursive: true, force: true });
  }
});

void test("durable human gates accept input and resume the same execution plan", async () => {
  const context = fixture();
  try {
    const plan: ExecutionPlan = {
      apiVersion: "switch.dev/plan/v1alpha1",
      id: crypto.randomUUID(),
      mode: "direct",
      protocolId: "human-review-test",
      protocolVersion: "1.0.0",
      entryStages: ["approval"],
      finalStage: "answer",
      budget: { maxCalls: 1, maxConcurrency: 1, maxGraphNodes: 2 },
      metadata: {},
      stages: [
        {
          id: "approval",
          operator: "human_gate",
          dependsOn: [],
          participants: [],
          visibility: "council",
          quorum: 0,
          retry: noRetry,
          timeoutMs: 10_000,
        },
        {
          id: "answer",
          operator: "generate",
          dependsOn: ["approval"],
          inputStages: ["approval"],
          participants: ["codex-architect"],
          visibility: "public-result",
          quorum: 1,
          retry: noRetry,
          timeoutMs: 10_000,
        },
      ],
    };
    const run = context.service.create({
      query: "Proceed after approval.",
      profileId: "quick",
      plan,
    });
    const paused = await context.service.execute(run.id, { cwd: process.cwd() });
    assert.equal(paused.run.status, "waiting_for_human");
    assert.equal(paused.paused, true);

    assert.equal(context.service.pause(run.id).status, "paused");
    const waitingAgain = await context.service.resume(run.id, { cwd: process.cwd() });
    assert.equal(waitingAgain.run.status, "waiting_for_human");
    assert.equal(waitingAgain.paused, true);

    const completed = await context.service.submitHumanInput(
      run.id,
      "approval",
      "Approved with read-only access.",
      { cwd: process.cwd() },
    );
    assert.equal(completed.run.status, "completed");
    assert.equal(context.fake.calls.length, 1);
    assert.ok(
      context.service.inspect(run.id).artifacts.some((artifact) => artifact.kind === "human_input"),
    );
  } finally {
    context.database.close();
    rmSync(context.directory, { recursive: true, force: true });
  }
});

void test("artifact visibility scopes are enforced for each recipient", async () => {
  const context = fixture((participant, request) => {
    const stage = String(request.metadata?.["stageId"]);
    return `${stage} evidence from ${participant.id}`;
  });
  try {
    const plan: ExecutionPlan = {
      apiVersion: "switch.dev/plan/v1alpha1",
      id: crypto.randomUUID(),
      mode: "council",
      protocolId: "private-visibility-test",
      protocolVersion: "1.0.0",
      entryStages: ["private-drafts"],
      finalStage: "review",
      budget: { maxCalls: 4, maxConcurrency: 4, maxGraphNodes: 2 },
      metadata: {},
      stages: [
        {
          id: "private-drafts",
          operator: "generate",
          dependsOn: [],
          participants: ["codex-architect", "gemini-analyst"],
          visibility: "private",
          quorum: 2,
          retry: noRetry,
          timeoutMs: 10_000,
        },
        {
          id: "review",
          operator: "synthesize",
          dependsOn: ["private-drafts"],
          inputStages: ["private-drafts"],
          participants: ["codex-architect", "grok-challenger"],
          visibility: "public-result",
          quorum: 2,
          retry: noRetry,
          timeoutMs: 10_000,
        },
      ],
    };
    const result = await context.service.run(
      { query: "Review only evidence visible to you.", profileId: "balanced", plan },
      { cwd: process.cwd() },
    );
    assert.equal(result.run.status, "completed");

    const reviews = context.fake.calls.filter(
      (call) => call.request.metadata?.["stageId"] === "review",
    );
    const codexPrompt = reviews
      .find((call) => call.participantId === "codex-architect")
      ?.request.messages.at(-1)?.content;
    const grokPrompt = reviews
      .find((call) => call.participantId === "grok-challenger")
      ?.request.messages.at(-1)?.content;
    assert.match(codexPrompt ?? "", /private-drafts evidence from codex-architect/u);
    assert.doesNotMatch(codexPrompt ?? "", /gemini-analyst/u);
    assert.doesNotMatch(grokPrompt ?? "", /private-drafts evidence/u);

    const reviewArtifacts = context.service
      .inspect(result.run.id)
      .artifacts.filter((artifact) => artifact.stageId === "review");
    assert.equal(
      reviewArtifacts.find((artifact) => artifact.metadata["participantId"] === "codex-architect")
        ?.parentIds.length,
      1,
    );
    assert.equal(
      reviewArtifacts.find((artifact) => artifact.metadata["participantId"] === "grok-challenger")
        ?.parentIds.length,
      0,
    );
  } finally {
    context.database.close();
    rmSync(context.directory, { recursive: true, force: true });
  }
});

void test("identity-stripped evidence omits configured source metadata", async () => {
  const context = fixture((_participant, request) => {
    return `${String(request.metadata?.["stageId"])} evidence`;
  });
  try {
    const plan: ExecutionPlan = {
      apiVersion: "switch.dev/plan/v1alpha1",
      id: crypto.randomUUID(),
      mode: "council",
      protocolId: "identity-strip-test",
      protocolVersion: "1.0.0",
      entryStages: ["candidates"],
      finalStage: "judgment",
      budget: { maxCalls: 3, maxConcurrency: 3, maxGraphNodes: 2 },
      metadata: {},
      stages: [
        {
          id: "candidates",
          operator: "generate",
          dependsOn: [],
          participants: ["codex-architect", "gemini-analyst"],
          visibility: "identity-stripped-council",
          quorum: 2,
          retry: noRetry,
          timeoutMs: 10_000,
        },
        {
          id: "judgment",
          operator: "vote",
          dependsOn: ["candidates"],
          inputStages: ["candidates"],
          participants: ["grok-challenger"],
          role: "judge",
          visibility: "public-result",
          quorum: 1,
          retry: noRetry,
          timeoutMs: 10_000,
        },
      ],
    };
    const result = await context.service.run(
      { query: "Judge these candidates.", profileId: "balanced", plan },
      { cwd: process.cwd() },
    );
    assert.equal(result.run.status, "completed");

    const prompt =
      context.fake.calls
        .find((call) => call.request.metadata?.["stageId"] === "judgment")
        ?.request.messages.at(-1)?.content ?? "";
    assert.match(prompt, /label="CANDIDATE A"/u);
    assert.match(prompt, /label="CANDIDATE B"/u);
    assert.doesNotMatch(prompt, /codex-architect|gemini-analyst|Architect|Analyst/u);
  } finally {
    context.database.close();
    rmSync(context.directory, { recursive: true, force: true });
  }
});

void test("stop stages durably forward a compatible public result", async () => {
  const context = fixture();
  try {
    const plan: ExecutionPlan = {
      apiVersion: "switch.dev/plan/v1alpha1",
      id: crypto.randomUUID(),
      mode: "direct",
      protocolId: "stop-test",
      protocolVersion: "1.0.0",
      entryStages: ["draft"],
      finalStage: "stop",
      budget: { maxCalls: 1, maxConcurrency: 1, maxGraphNodes: 2 },
      metadata: {},
      stages: [
        {
          id: "draft",
          operator: "generate",
          dependsOn: [],
          participants: ["codex-architect"],
          visibility: "public-result",
          quorum: 1,
          retry: noRetry,
          timeoutMs: 10_000,
        },
        {
          id: "stop",
          operator: "stop",
          dependsOn: ["draft"],
          inputStages: ["draft"],
          participants: [],
          visibility: "public-result",
          quorum: 0,
          retry: noRetry,
          timeoutMs: 10_000,
        },
      ],
    };
    const result = await context.service.run(
      { query: "Return the draft unchanged.", profileId: "quick", plan },
      { cwd: process.cwd() },
    );
    assert.equal(result.run.status, "completed");
    assert.equal(result.decision?.answer, "draft response from codex-architect");
    assert.equal(context.fake.calls.length, 1);
    const stopArtifact = context.service
      .inspect(result.run.id)
      .artifacts.find(
        (artifact) => artifact.stageId === "stop" && artifact.kind === "final_decision",
      );
    assert.equal(stopArtifact?.parentIds.length, 1);
  } finally {
    context.database.close();
    rmSync(context.directory, { recursive: true, force: true });
  }
});

void test("stage call budgets fail before external work is scheduled", async () => {
  const context = fixture();
  try {
    const plan: ExecutionPlan = {
      apiVersion: "switch.dev/plan/v1alpha1",
      id: crypto.randomUUID(),
      mode: "council",
      protocolId: "stage-call-budget-test",
      protocolVersion: "1.0.0",
      entryStages: ["answer"],
      finalStage: "answer",
      budget: { maxCalls: 2, maxConcurrency: 2, maxGraphNodes: 1 },
      metadata: {},
      stages: [
        {
          id: "answer",
          operator: "generate",
          dependsOn: [],
          participants: ["codex-architect", "gemini-analyst"],
          visibility: "public-result",
          quorum: 1,
          budget: { maxCalls: 1 },
          retry: noRetry,
          timeoutMs: 10_000,
        },
      ],
    };
    const result = await context.service.run(
      { query: "Respect the stage budget.", profileId: "balanced", plan },
      { cwd: process.cwd() },
    );
    assert.equal(result.run.status, "failed");
    assert.equal(context.fake.calls.length, 0);
    assert.equal(context.service.inspect(result.run.id).stages[0]?.status, "failed");
  } finally {
    context.database.close();
    rmSync(context.directory, { recursive: true, force: true });
  }
});

void test("usage budgets are reconciled after provider-reported usage", async () => {
  const context = fixture((_participant, request) => ({
    requestId: request.requestId,
    text: "A response that exceeded its output allowance.",
    usage: { inputTokens: 1, outputTokens: 2, source: "reported" },
  }));
  try {
    const plan: ExecutionPlan = {
      apiVersion: "switch.dev/plan/v1alpha1",
      id: crypto.randomUUID(),
      mode: "direct",
      protocolId: "usage-budget-test",
      protocolVersion: "1.0.0",
      entryStages: ["answer"],
      finalStage: "answer",
      budget: {
        maxCalls: 1,
        maxOutputTokens: 1,
        maxConcurrency: 1,
        maxGraphNodes: 1,
      },
      metadata: {},
      stages: [
        {
          id: "answer",
          operator: "generate",
          dependsOn: [],
          participants: ["codex-architect"],
          visibility: "public-result",
          quorum: 1,
          retry: noRetry,
          timeoutMs: 10_000,
        },
      ],
    };
    const result = await context.service.run(
      { query: "Respect the usage budget.", profileId: "quick", plan },
      { cwd: process.cwd() },
    );
    assert.equal(result.run.status, "failed");
    assert.equal(context.fake.calls.length, 1);
    assert.equal(result.run.usage.outputTokens, 2);
    assert.equal(context.service.inspect(result.run.id).stages[0]?.status, "failed");
  } finally {
    context.database.close();
    rmSync(context.directory, { recursive: true, force: true });
  }
});

void test("structured synthesis populates the durable decision contract", async () => {
  const context = fixture((_participant, request) => {
    if (request.metadata?.["stageId"] !== "synthesis") return "Independent evidence.";
    return JSON.stringify({
      answer: "Use the bounded design.",
      consensus: ["Bound concurrency."],
      dissent: ["One member preferred a queue."],
      unresolvedQuestions: ["Peak load is unknown."],
      risks: ["Provider throttling."],
      nextActions: ["Run a load test."],
      confidence: 0.82,
    });
  });
  try {
    const result = await context.service.run(
      { query: "Choose a design.", profileId: "quick" },
      { cwd: process.cwd() },
    );
    assert.equal(result.run.status, "completed");
    assert.equal(result.decision?.answer, "Use the bounded design.");
    assert.deepEqual(result.decision?.consensus, ["Bound concurrency."]);
    assert.deepEqual(result.decision?.dissent, ["One member preferred a queue."]);
    assert.deepEqual(result.decision?.risks, ["Provider throttling."]);
    assert.equal(result.decision?.confidence, 0.82);
    assert.ok(
      context.fake.calls.find((call) => call.request.metadata?.["stageId"] === "synthesis")?.request
        .outputSchema,
    );
  } finally {
    context.database.close();
    rmSync(context.directory, { recursive: true, force: true });
  }
});
