import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config/defaults.js";
import { SwitchDatabase } from "../src/persistence/database.js";
import { RunRepository } from "../src/persistence/run-repository.js";
import { ProtocolCompiler } from "../src/protocol/compiler.js";
import { RecoveryService } from "../src/runtime/recovery.js";

function runningAttemptFixture(): {
  readonly directory: string;
  readonly database: SwitchDatabase;
  readonly repository: RunRepository;
  readonly runId: ReturnType<RunRepository["createRun"]>["id"];
  readonly attemptId: ReturnType<RunRepository["scheduleAttempt"]>["id"];
} {
  const directory = mkdtempSync(join(tmpdir(), "switch-recovery-"));
  const database = new SwitchDatabase(join(directory, "data.sqlite"));
  const repository = new RunRepository(database);
  const plan = new ProtocolCompiler().compile(defaultConfig, {
    profileId: "quick",
    protocolId: "direct",
    participants: ["codex-architect"],
    synthesizer: "codex-architect",
    planId: crypto.randomUUID(),
  });
  const run = repository.createRun({
    mode: "direct",
    query: "recover",
    profileId: "quick",
    config: {},
    plan,
    policy: {},
    budget: plan.budget,
    participants: [],
  });
  repository.transitionRun(run.id, "validating", "ConfigurationResolved");
  repository.transitionRun(run.id, "planned", "ExecutionPlanAccepted");
  repository.transitionRun(run.id, "queued", "RunQueued");
  repository.transitionRun(run.id, "running", "RunStarted");
  repository.transitionStage(run.id, "answer", "ready", "StageReady");
  repository.transitionStage(run.id, "answer", "running", "StageStarted");
  const attempt = repository.scheduleAttempt({
    runId: run.id,
    stageId: "answer",
    participantId: "codex-architect",
    connectorId: "codex",
    request: { prompt: "recover" },
    timeoutMs: 10_000,
    idempotencyKey: "stable-key",
  });
  repository.startAttempt(attempt.id);
  return {
    directory,
    database,
    repository,
    runId: run.id,
    attemptId: attempt.id,
  };
}

void test("recovery marks an unreceipted external invocation unknown and pauses", () => {
  const context = runningAttemptFixture();
  try {
    const diagnostics = new RecoveryService(context.repository, defaultConfig).recover();
    assert.equal(context.repository.getAttempt(context.attemptId).state, "unknown");
    assert.equal(context.repository.getRun(context.runId).status, "paused");
    assert.equal(context.repository.getStage(context.runId, "answer").status, "paused");
    assert.ok(diagnostics.some((item) => item.action === "paused"));

    const retry = context.repository.scheduleAttempt({
      runId: context.runId,
      stageId: "answer",
      participantId: "codex-architect",
      connectorId: "codex",
      request: { prompt: "recover" },
      timeoutMs: 10_000,
      idempotencyKey: "stable-key",
    });
    assert.equal(retry.idempotencyKey, "stable-key");
  } finally {
    context.database.close();
    rmSync(context.directory, { recursive: true, force: true });
  }
});
