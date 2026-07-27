import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRunId } from "../src/domain/ids.js";
import { FileArtifactStore } from "../src/persistence/artifact-store.js";
import { SwitchDatabase } from "../src/persistence/database.js";
import { RunRepository } from "../src/persistence/run-repository.js";
import type { ExecutionPlan } from "../src/schema/execution-plan.js";

function plan(): ExecutionPlan {
  return {
    apiVersion: "switch.dev/plan/v1alpha1",
    id: crypto.randomUUID(),
    mode: "direct",
    protocolId: "direct",
    protocolVersion: "1.0.0",
    entryStages: ["answer"],
    finalStage: "answer",
    budget: { maxCalls: 1, maxConcurrency: 1 },
    metadata: {},
    stages: [
      {
        id: "answer",
        operator: "generate",
        dependsOn: [],
        participants: ["fake"],
        visibility: "public-result",
        quorum: 1,
        retry: {
          maxAttempts: 1,
          initialDelayMs: 0,
          maxDelayMs: 0,
          backoffMultiplier: 1,
        },
        timeoutMs: 1_000,
      },
    ],
  };
}

void test("journal and materialized run state commit together", () => {
  const directory = mkdtempSync(join(tmpdir(), "switch-persistence-"));
  try {
    const database = new SwitchDatabase(join(directory, "switch.sqlite"));
    const repository = new RunRepository(database);
    const run = repository.createRun({
      mode: "direct",
      query: "test",
      profileId: "test",
      config: {},
      plan: plan(),
      policy: {},
      budget: { maxCalls: 1 },
      participants: [],
    });
    assert.equal(run.status, "created");
    assert.equal(repository.getEvents(run.id).length, 5);

    repository.transitionRun(run.id, "validating", "ConfigurationResolved");
    repository.transitionRun(run.id, "planned", "ExecutionPlanAccepted");
    repository.transitionRun(run.id, "queued", "RunQueued");
    repository.transitionRun(run.id, "running", "RunStarted");
    repository.transitionStage(run.id, "answer", "ready", "StageReady");
    repository.transitionStage(run.id, "answer", "running", "StageStarted");

    const attempt = repository.scheduleAttempt({
      runId: run.id,
      stageId: "answer",
      participantId: "fake",
      connectorId: "fake",
      request: { prompt: "test" },
      timeoutMs: 1_000,
    });
    repository.startAttempt(attempt.id);

    const store = new FileArtifactStore(join(directory, "artifacts"));
    const stored = store.put("answer");
    const artifact = repository.recordArtifact({
      runId: run.id,
      stageId: "answer",
      attemptId: attempt.id,
      kind: "model_response",
      contentHash: stored.hash,
      storagePath: stored.path,
      mediaType: "text/plain",
      byteSize: stored.byteSize,
      visibility: "public-result",
    });
    repository.finishAttempt(attempt.id, "succeeded", {
      resultArtifactId: artifact.id,
      usage: { inputTokens: 1, outputTokens: 1, source: "reported" },
    });
    repository.transitionStage(run.id, "answer", "completed", "StageCompleted");
    repository.completeRun(run.id, artifact.id);

    assert.equal(repository.getRun(run.id).status, "completed");
    assert.equal(store.get(stored.path, stored.hash).toString("utf8"), "answer");
    repository.verifyJournal(run.id);
    database.integrityCheck();
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("invalid transitions are rejected without journal mutation", () => {
  const database = new SwitchDatabase(":memory:");
  const repository = new RunRepository(database);
  const run = repository.createRun({
    id: createRunId(),
    mode: "direct",
    query: "test",
    profileId: "test",
    config: {},
    plan: plan(),
    policy: {},
    budget: {},
    participants: [],
  });
  const eventCount = repository.getEvents(run.id).length;
  assert.throws(() => repository.transitionRun(run.id, "completed", "RunCompleted"));
  assert.equal(repository.getEvents(run.id).length, eventCount);
  assert.equal(repository.getRun(run.id).status, "created");
  database.close();
});
