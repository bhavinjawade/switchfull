import { randomUUID } from "node:crypto";
import { asSwitchError, SwitchError } from "../domain/errors.js";
import type { ArtifactId, RunId } from "../domain/ids.js";
import type { ParticipantPort, ParticipantRegistry } from "../connectors/index.js";
import { DecisionContentSchema, type Decision, type DecisionContent } from "../schema/decision.js";
import type { ParticipantRequest, ParticipantResult } from "../schema/participant.js";
import type { PlanStage } from "../schema/execution-plan.js";
import { compileValidator } from "../schema/validator.js";
import type { FileArtifactStore } from "../persistence/index.js";
import { type ArtifactRecord, type RunRecord, type RunRepository } from "../persistence/index.js";
import { evaluatePredicate } from "../protocol/predicate.js";
import { renderStagePrompt, type PromptArtifact } from "../protocol/prompts.js";
import { canReadArtifact, shouldStripArtifactIdentity } from "../protocol/visibility.js";
import { BudgetGuard } from "./budget.js";
import { delay, parallelMap } from "./concurrency.js";
import { InvocationScheduler } from "./scheduler.js";

export interface RunProgress {
  readonly runId: RunId;
  readonly phase: string;
  readonly stageId?: string;
  readonly participantId?: string;
  readonly displayName?: string;
  readonly operator?: string;
  readonly message: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly source?: string;
  };
  readonly preview?: string;
}

export interface ExecuteOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly thinking?: "low" | "medium" | "high";
  readonly onProgress?: (progress: RunProgress) => void;
}

export interface ExecutionResult {
  readonly run: RunRecord;
  readonly decision?: Decision;
  readonly paused: boolean;
}

interface InvocationWork {
  readonly participant: ParticipantPort;
  readonly sample: number;
}

interface SuccessfulInvocation {
  readonly participant: ParticipantPort;
  readonly result: ParticipantResult;
  readonly artifact: ArtifactRecord;
}

interface InvocationInput {
  readonly artifactId: ArtifactId;
  readonly prompt: PromptArtifact;
}

const validateDecisionContent = compileValidator(DecisionContentSchema);

function parseDecisionContent(text: string): DecisionContent | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text)?.[1];
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  const candidate =
    fenced ??
    (firstBrace >= 0 && lastBrace > firstBrace ? text.slice(firstBrace, lastBrace + 1) : "");
  if (!candidate) return undefined;
  try {
    return validateDecisionContent(JSON.parse(candidate) as unknown);
  } catch {
    return undefined;
  }
}

function stageArtifactKind(stage: PlanStage): string {
  const kinds: Readonly<Record<PlanStage["operator"], string>> = {
    generate: "candidate",
    sample: "sample",
    critique: "critique",
    revise: "revision",
    synthesize: "synthesis",
    verify: "verification",
    vote: "vote",
    stop: "final_decision",
    human_gate: "human_input",
  };
  return kinds[stage.operator];
}

function classifyAttemptState(error: SwitchError): "failed" | "timed_out" | "cancelled" {
  if (error.code === "timeout") return "timed_out";
  if (error.code === "cancelled") return "cancelled";
  return "failed";
}

function retryDelay(stage: PlanStage, attempt: number): number {
  return Math.min(
    stage.retry.maxDelayMs,
    stage.retry.initialDelayMs * stage.retry.backoffMultiplier ** Math.max(0, attempt - 1),
  );
}

export class RunExecutor {
  constructor(
    private readonly repository: RunRepository,
    private readonly artifacts: FileArtifactStore,
    private readonly participants: ParticipantRegistry,
    private readonly scheduler = new InvocationScheduler(),
  ) {}

  async execute(runId: RunId, options: ExecuteOptions): Promise<ExecutionResult> {
    const progress = options.onProgress ?? (() => undefined);
    try {
      let run = this.prepareRun(runId);
      const budget = new BudgetGuard(this.repository, runId, run.budget);
      progress({ runId, phase: "run", message: `Executing ${run.plan.protocolId}.` });

      while (true) {
        if (options.signal?.aborted) throw options.signal.reason ?? new Error("cancelled");
        run = this.repository.getRun(runId);
        if (run.status === "paused" || run.status === "waiting_for_human") {
          return { run, paused: true };
        }
        const stages = this.repository.getStages(runId);
        const final = stages.find((stage) => stage.id === run.plan.finalStage);
        if (final?.status === "completed") break;
        const schedulable = stages.filter(
          (stage) => stage.status === "pending" || stage.status === "ready",
        );
        if (schedulable.length === 0) {
          const failed = stages.find((stage) => stage.status === "failed");
          throw new SwitchError({
            code: "protocol_error",
            message: failed ? `Stage ${failed.id} failed.` : "Execution plan cannot make progress.",
            retry: "non_retryable",
          });
        }
        const completed = new Set(
          stages
            .filter((stage) => stage.status === "completed" || stage.status === "skipped")
            .map((stage) => stage.id),
        );
        const ready = schedulable.filter((stage) =>
          stage.plan.dependsOn.every((dependency) => completed.has(dependency)),
        );
        if (ready.length === 0) {
          throw new SwitchError({
            code: "protocol_error",
            message: "Execution plan is deadlocked.",
            retry: "non_retryable",
          });
        }
        for (const stage of ready) {
          const predicateContext = this.predicateContext(runId);
          if (stage.plan.condition && !evaluatePredicate(stage.plan.condition, predicateContext)) {
            this.repository.transitionStage(runId, stage.id, "skipped", "StageCompleted", {
              reason: "condition_false",
            });
            continue;
          }
          const outcome = await this.executeStage(run, stage.plan, budget, options, progress);
          if (outcome === "paused") {
            return { run: this.repository.getRun(runId), paused: true };
          }
        }
      }

      const decision = this.createDecision(runId);
      const stored = this.artifacts.put(`${JSON.stringify(decision, null, 2)}\n`);
      const decisionArtifact = this.repository.recordArtifact({
        runId,
        stageId: run.plan.finalStage,
        kind: "final_decision",
        contentHash: stored.hash,
        storagePath: stored.path,
        mediaType: "application/json",
        byteSize: stored.byteSize,
        visibility: "public-result",
        parentIds: decision.supportingArtifactIds as ArtifactId[],
        metadata: {
          schema: decision.apiVersion,
          protocolId: run.plan.protocolId,
          protocolVersion: run.plan.protocolVersion,
        },
      });
      this.repository.reconcileRunUsage(runId);
      const completed = this.repository.completeRun(runId, decisionArtifact.id);
      progress({ runId, phase: "completed", message: "Run completed." });
      return { run: completed, decision, paused: false };
    } catch (error) {
      return this.failRun(runId, error, options.onProgress);
    }
  }

  submitHumanInput(runId: RunId, stageId: string, text: string): ArtifactRecord {
    if (!text.trim()) throw new Error("Human input cannot be empty.");
    const run = this.repository.getRun(runId);
    const stage = this.repository.getStage(runId, stageId);
    if (run.status !== "waiting_for_human" || stage.status !== "waiting_for_human") {
      throw new Error(`Stage ${stageId} is not waiting for human input.`);
    }
    const stored = this.artifacts.put(text);
    const artifact = this.repository.recordArtifact({
      runId,
      stageId,
      kind: "human_input",
      contentHash: stored.hash,
      storagePath: stored.path,
      mediaType: "text/plain",
      byteSize: stored.byteSize,
      visibility: stage.plan.visibility,
      parentIds: this.inputArtifactIds(runId, stage.plan),
      metadata: { actor: "human" },
    });
    this.repository.transitionStage(runId, stageId, "running", "HumanInputReceived", {
      artifactId: artifact.id,
    });
    this.repository.transitionStage(runId, stageId, "completed", "StageCompleted", {
      artifactIds: [artifact.id],
    });
    this.repository.transitionRun(
      runId,
      "running",
      "HumanInputReceived",
      { stageId, artifactId: artifact.id },
      "human",
    );
    return artifact;
  }

  private prepareRun(runId: RunId): RunRecord {
    let run = this.repository.getRun(runId);
    if (run.status === "created") {
      run = this.repository.transitionRun(runId, "validating", "ConfigurationResolved");
    }
    if (run.status === "validating") {
      run = this.repository.transitionRun(runId, "planned", "ExecutionPlanAccepted");
    }
    if (run.status === "planned") {
      run = this.repository.transitionRun(runId, "queued", "RunQueued");
    }
    if (run.status === "queued") {
      run = this.repository.transitionRun(runId, "running", "RunStarted");
    } else if (run.status === "paused" || run.status === "recovering") {
      run = this.repository.transitionRun(runId, "running", "RunResumed");
    }
    if (run.status !== "running") {
      throw new SwitchError({
        code: "validation_error",
        message: `Run ${runId} cannot execute from status ${run.status}.`,
        retry: "non_retryable",
      });
    }
    return run;
  }

  private async executeStage(
    run: RunRecord,
    stage: PlanStage,
    budget: BudgetGuard,
    options: ExecuteOptions,
    progress: (progress: RunProgress) => void,
  ): Promise<"completed" | "paused"> {
    if (this.repository.getStage(run.id, stage.id).status === "pending") {
      this.repository.transitionStage(run.id, stage.id, "ready", "StageReady");
    }
    this.repository.transitionStage(run.id, stage.id, "running", "StageStarted");
    progress({
      runId: run.id,
      phase: stage.operator,
      stageId: stage.id,
      operator: stage.operator,
      message: `Running stage ${stage.id}.`,
    });
    if (stage.operator === "human_gate") {
      this.repository.transitionStage(run.id, stage.id, "waiting_for_human", "HumanInputRequested");
      this.repository.transitionRun(run.id, "waiting_for_human", "HumanInputRequested", {
        stageId: stage.id,
      });
      return "paused";
    }
    if (stage.operator === "stop") {
      this.completeStopStage(run.id, stage);
      return "completed";
    }

    const sampleCount =
      stage.operator === "sample" && typeof stage.config?.["sampleCount"] === "number"
        ? Math.max(1, Math.trunc(stage.config["sampleCount"]))
        : 1;
    const work = stage.participants.flatMap((participantId) => {
      const participant = this.participants.resolve(participantId);
      return Array.from({ length: sampleCount }, (_, sample) => ({ participant, sample }));
    });
    try {
      budget.assertCanSchedule(work.length, stage);
    } catch (error) {
      this.repository.transitionStage(run.id, stage.id, "failed", "StageFailed", {
        reason: "budget_exceeded",
      });
      throw error;
    }
    const settled = await parallelMap(
      work,
      Math.min(
        run.budget.maxConcurrency ?? 4,
        stage.budget?.maxConcurrency ?? Number.POSITIVE_INFINITY,
      ),
      (item) => this.invokeWithRetry(run, stage, item, budget, options, progress),
    );
    const successes = settled.flatMap((item) => (item.status === "fulfilled" ? [item.value] : []));
    const requiredQuorum = stage.operator === "sample" ? stage.quorum : stage.quorum;
    if (successes.length < requiredQuorum) {
      const failures = settled.flatMap((item) =>
        item.status === "rejected"
          ? [item.reason instanceof Error ? item.reason.message : String(item.reason)]
          : [],
      );
      this.repository.transitionStage(run.id, stage.id, "failed", "StageFailed", {
        successes: successes.length,
        quorum: requiredQuorum,
        failures,
      });
      throw new SwitchError({
        code: "provider_error",
        message: `Stage ${stage.id} reached ${successes.length}/${requiredQuorum} quorum.`,
        retry: "non_retryable",
        details: { failures },
      });
    }
    this.repository.reconcileRunUsage(run.id);
    try {
      budget.assertWithinLimits(stage);
    } catch (error) {
      this.repository.transitionStage(run.id, stage.id, "failed", "StageFailed", {
        reason: "budget_exceeded_after_reconciliation",
      });
      throw error;
    }
    this.repository.transitionStage(run.id, stage.id, "completed", "StageCompleted", {
      artifactIds: successes.map((success) => success.artifact.id),
      successfulParticipants: successes.map((success) => success.participant.id),
    });
    return "completed";
  }

  private async invokeWithRetry(
    run: RunRecord,
    stage: PlanStage,
    work: InvocationWork,
    budget: BudgetGuard,
    options: ExecuteOptions,
    progress: (progress: RunProgress) => void,
  ): Promise<SuccessfulInvocation> {
    const inputs = this.inputArtifacts(run.id, stage, work.participant);
    let lastError: SwitchError | undefined;
    for (let attemptNumber = 1; attemptNumber <= stage.retry.maxAttempts; attemptNumber += 1) {
      budget.assertCanSchedule(1, stage);
      const prompt = renderStagePrompt(
        stage,
        run.query,
        inputs.map((input) => input.prompt),
        {
          ...(work.participant.snapshot.role ? { role: work.participant.snapshot.role } : {}),
          ...(work.participant.snapshot.mandate
            ? { mandate: work.participant.snapshot.mandate }
            : {}),
        },
      );
      const idempotencyKey = `${run.id}:${stage.id}:${work.participant.id}:${work.sample}`;
      const request: ParticipantRequest = {
        requestId: randomUUID(),
        messages: [{ role: "user", content: prompt }],
        ...(work.participant.snapshot.model ? { model: work.participant.snapshot.model } : {}),
        ...(stage.operator === "synthesize" ? { outputSchema: DecisionContentSchema } : {}),
        workspace: options.cwd,
        deadline: new Date(Date.now() + stage.timeoutMs).toISOString(),
        idempotencyKey,
        metadata: {
          runId: run.id,
          stageId: stage.id,
          operator: stage.operator,
          sample: work.sample,
          attempt: attemptNumber,
        },
      };
      const attempt = this.repository.scheduleAttempt({
        runId: run.id,
        stageId: stage.id,
        participantId: work.participant.id,
        connectorId: work.participant.snapshot.connectorId,
        request,
        timeoutMs: stage.timeoutMs,
        idempotencyKey,
      });
      this.repository.startAttempt(attempt.id);
      progress({
        runId: run.id,
        phase: "invocation",
        stageId: stage.id,
        participantId: work.participant.id,
        displayName: work.participant.snapshot.displayName,
        operator: stage.operator,
        message: `Invoking ${work.participant.snapshot.displayName}.`,
      });
      try {
        const result = await this.scheduler.run(
          work.participant.snapshot.connectorId,
          () =>
            work.participant.invoke(request, {
              cwd: options.cwd,
              timeoutMs: stage.timeoutMs,
              ...(options.signal ? { signal: options.signal } : {}),
              ...(options.thinking ? { thinking: options.thinking } : {}),
            }),
          {
            priority: run.mode === "routed" ? 1 : 0,
            ...(options.signal ? { signal: options.signal } : {}),
          },
        );
        if (!result.text.trim()) {
          throw new SwitchError({
            code: "provider_error",
            message: `${work.participant.id} returned an empty response.`,
            retry: "unknown",
          });
        }
        const stored = this.artifacts.put(result.text);
        const artifact = this.repository.recordArtifact({
          runId: run.id,
          stageId: stage.id,
          attemptId: attempt.id,
          kind: stageArtifactKind(stage),
          contentHash: stored.hash,
          storagePath: stored.path,
          mediaType: "text/plain",
          byteSize: stored.byteSize,
          visibility: stage.visibility,
          parentIds: inputs.map((input) => input.artifactId),
          metadata: {
            participantId: work.participant.id,
            model: result.model ?? work.participant.snapshot.model ?? null,
            role: work.participant.snapshot.role ?? stage.role ?? null,
            operator: stage.operator,
            sample: work.sample,
          },
        });
        this.repository.finishAttempt(attempt.id, "succeeded", {
          resultArtifactId: artifact.id,
          ...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {}),
          usage: result.usage,
        });
        const preview = result.text.replace(/\s+/g, " ").trim().slice(0, 160);
        progress({
          runId: run.id,
          phase: "invocation_complete",
          stageId: stage.id,
          participantId: work.participant.id,
          displayName: work.participant.snapshot.displayName,
          operator: stage.operator,
          message: `Completed ${work.participant.snapshot.displayName}.`,
          preview,
          usage: {
            ...(typeof result.usage.inputTokens === "number"
              ? { inputTokens: result.usage.inputTokens }
              : {}),
            ...(typeof result.usage.outputTokens === "number"
              ? { outputTokens: result.usage.outputTokens }
              : {}),
            source: result.usage.source,
          },
        });
        return { participant: work.participant, result, artifact };
      } catch (error) {
        const failure = asSwitchError(error);
        lastError = failure;
        this.repository.finishAttempt(attempt.id, classifyAttemptState(failure), {
          error: {
            code: failure.code,
            message: failure.message,
            retry: failure.retry,
          },
        });
        if (
          attemptNumber >= stage.retry.maxAttempts ||
          failure.retry === "non_retryable" ||
          failure.code === "cancelled"
        ) {
          throw failure;
        }
        await delay(retryDelay(stage, attemptNumber), options.signal);
      }
    }
    throw lastError ?? new Error("Invocation exhausted retries.");
  }

  private inputArtifacts(
    runId: RunId,
    stage: PlanStage,
    participant: ParticipantPort,
  ): readonly InvocationInput[] {
    const inputStageIds = new Set(stage.inputStages ?? stage.dependsOn);
    return this.repository
      .getArtifacts(runId)
      .filter(
        (artifact) =>
          artifact.stageId !== undefined &&
          inputStageIds.has(artifact.stageId) &&
          artifact.kind !== "final_decision" &&
          canReadArtifact(
            artifact.visibility,
            {
              ...(typeof artifact.metadata["participantId"] === "string"
                ? { participantId: artifact.metadata["participantId"] }
                : {}),
              ...(typeof artifact.metadata["role"] === "string"
                ? { role: artifact.metadata["role"] }
                : {}),
            },
            {
              participantId: participant.id,
              ...(participant.snapshot.role ? { participantRole: participant.snapshot.role } : {}),
              stage,
            },
          ),
      )
      .map((artifact) => {
        const metadata = artifact.metadata;
        return {
          artifactId: artifact.id,
          prompt: {
            ...(typeof metadata["participantId"] === "string"
              ? { participantId: metadata["participantId"] }
              : {}),
            ...(typeof metadata["role"] === "string" ? { role: metadata["role"] } : {}),
            identityStripped: shouldStripArtifactIdentity(artifact.visibility, stage.visibility),
            text: this.artifacts.get(artifact.storagePath, artifact.contentHash).toString("utf8"),
          },
        };
      });
  }

  private inputArtifactIds(runId: RunId, stage: PlanStage): readonly ArtifactId[] {
    const inputStageIds = new Set(stage.inputStages ?? stage.dependsOn);
    return this.repository
      .getArtifacts(runId)
      .filter((artifact) => artifact.stageId && inputStageIds.has(artifact.stageId))
      .map((artifact) => artifact.id);
  }

  private completeStopStage(runId: RunId, stage: PlanStage): void {
    const inputStageIds = new Set(stage.inputStages ?? stage.dependsOn);
    const source = this.repository
      .getArtifacts(runId)
      .filter(
        (artifact) =>
          artifact.stageId !== undefined &&
          inputStageIds.has(artifact.stageId) &&
          artifact.visibility === stage.visibility &&
          artifact.kind !== "final_decision",
      )
      .at(-1);
    if (!source) {
      this.repository.transitionStage(runId, stage.id, "failed", "StageFailed", {
        reason: "compatible_stop_input_missing",
      });
      throw new SwitchError({
        code: "protocol_error",
        message: `Stop stage ${stage.id} has no input with ${stage.visibility} visibility.`,
        retry: "non_retryable",
      });
    }
    const artifact = this.repository.recordArtifact({
      runId,
      stageId: stage.id,
      kind: "final_decision",
      contentHash: source.contentHash,
      storagePath: source.storagePath,
      mediaType: source.mediaType,
      byteSize: source.byteSize,
      visibility: stage.visibility,
      parentIds: [source.id],
      metadata: {
        operator: "stop",
        sourceArtifactId: source.id,
      },
    });
    this.repository.transitionStage(runId, stage.id, "completed", "StageCompleted", {
      artifactIds: [artifact.id],
    });
  }

  private predicateContext(runId: RunId): Readonly<Record<string, unknown>> {
    const attempts = this.repository.getAttempts(runId);
    return {
      calls: attempts.length,
      failures: attempts.filter((attempt) => attempt.state !== "succeeded").length,
      usage: this.repository.getRun(runId).usage,
      stages: Object.fromEntries(
        this.repository
          .getStages(runId)
          .map((stage) => [
            stage.id,
            { status: stage.status, outputs: stage.outputArtifactIds.length },
          ]),
      ),
    };
  }

  private createDecision(runId: RunId): Decision {
    const run = this.repository.getRun(runId);
    const finalStage = this.repository.getStage(runId, run.plan.finalStage);
    const finalArtifactId = finalStage.outputArtifactIds.at(-1);
    if (!finalArtifactId) {
      throw new SwitchError({
        code: "protocol_error",
        message: "Final stage completed without an output artifact.",
        retry: "non_retryable",
      });
    }
    const finalArtifact = this.repository.getArtifact(finalArtifactId);
    const answer = this.artifacts
      .get(finalArtifact.storagePath, finalArtifact.contentHash)
      .toString("utf8");
    const structured = parseDecisionContent(answer);
    return {
      apiVersion: "switch.dev/decision/v1alpha1",
      answer: structured?.answer ?? answer,
      supportingArtifactIds: this.repository
        .getArtifacts(runId)
        .filter((artifact) => artifact.kind !== "final_decision")
        .map((artifact) => artifact.id),
      consensus: structured?.consensus ?? [],
      dissent: structured?.dissent ?? [],
      unresolvedQuestions: structured?.unresolvedQuestions ?? [],
      risks: structured?.risks ?? [],
      nextActions: structured?.nextActions ?? [],
      ...(structured?.confidence !== undefined ? { confidence: structured.confidence } : {}),
      provenance: {
        runId,
        protocolId: run.plan.protocolId,
        protocolVersion: run.plan.protocolVersion,
        participants: this.repository
          .getParticipantSnapshots(runId)
          .map((participant) => participant.id),
      },
    };
  }

  private failRun(
    runId: RunId,
    error: unknown,
    progress?: (progress: RunProgress) => void,
  ): ExecutionResult {
    const failure = asSwitchError(error);
    let run = this.repository.getRun(runId);
    if (["completed", "failed", "cancelled"].includes(run.status)) {
      return { run, paused: false };
    }
    if (failure.code === "cancelled") {
      if (run.status !== "cancelling") {
        this.repository.transitionRun(runId, "cancelling", "RunCancelling");
      }
      run = this.repository.transitionRun(runId, "cancelled", "RunCancelled", {
        reason: failure.message,
      });
    } else {
      run = this.repository.setRunFailure(runId, {
        code: failure.code,
        message: failure.message,
        retry: failure.retry,
        details: failure.details,
      });
    }
    progress?.({
      runId,
      phase: run.status,
      message: failure.message,
    });
    return { run, paused: false };
  }
}
