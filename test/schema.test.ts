import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  ExecutionPlanSchema,
  RoutingDecisionSchema,
  compileValidator,
  defaultConfig,
  validateConfig,
} from "../src/index.js";

void test("default v2 configuration validates", () => {
  assert.deepEqual(validateConfig(defaultConfig), defaultConfig);
});

void test("execution plan rejects arbitrary condition expressions", () => {
  const validate = compileValidator(ExecutionPlanSchema);
  assert.throws(() =>
    validate({
      apiVersion: "switch.dev/plan/v1alpha1",
      id: randomUUID(),
      mode: "direct",
      protocolId: "direct",
      protocolVersion: "1alpha1",
      stages: [
        {
          id: "answer",
          operator: "generate",
          dependsOn: [],
          participants: ["primary"],
          visibility: "private",
          quorum: 1,
          condition: "risk > 5",
          retry: {
            maxAttempts: 1,
            initialDelayMs: 0,
            maxDelayMs: 0,
            backoffMultiplier: 1,
          },
          timeoutMs: 1000,
        },
      ],
      entryStages: ["answer"],
      finalStage: "answer",
      budget: { maxCalls: 1 },
      metadata: {},
    }),
  );
});

void test("routing decision schema embeds a validated execution plan", () => {
  const validate = compileValidator(RoutingDecisionSchema);
  const plan = {
    apiVersion: "switch.dev/plan/v1alpha1" as const,
    id: randomUUID(),
    mode: "direct" as const,
    protocolId: "direct",
    protocolVersion: "1alpha1",
    stages: [
      {
        id: "answer",
        operator: "generate" as const,
        dependsOn: [],
        participants: ["primary"],
        visibility: "private" as const,
        quorum: 1,
        retry: {
          maxAttempts: 1,
          initialDelayMs: 0,
          maxDelayMs: 0,
          backoffMultiplier: 1,
        },
        timeoutMs: 1000,
      },
    ],
    entryStages: ["answer"],
    finalStage: "answer",
    budget: { maxCalls: 1 },
    metadata: {},
  };
  const decision = validate({
    apiVersion: "switch.dev/routing-decision/v1alpha1",
    id: randomUUID(),
    routerSessionId: randomUUID(),
    strategy: "single",
    reason: "Simple task.",
    difficulty: { level: "low", confidence: 0.9 },
    selectedParticipants: ["primary"],
    proposedPlan: plan,
    requestedBudget: { maxCalls: 1 },
    alternatives: [],
  });
  assert.equal(decision.strategy, "single");
});
