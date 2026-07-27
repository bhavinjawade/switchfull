import type { RunId } from "../domain/ids.js";
import type { SwitchConfig } from "../schema/config.js";
import type { ExecutionPlan } from "../schema/execution-plan.js";
import type { ParticipantRegistry } from "../connectors/registry.js";
import { withSpan } from "../observability/tracing.js";
import type { RunRecord, RunRepository } from "../persistence/run-repository.js";
import { ProtocolCompiler } from "../protocol/compiler.js";
import { assertValidPlan } from "../protocol/validator.js";
import { PolicyEngine, type DataClass } from "../policy/engine.js";
import type { RunExecutor } from "./executor.js";
import { type ExecuteOptions, type ExecutionResult } from "./executor.js";

export interface CreateRunRequest {
  readonly query: string;
  readonly profileId?: string;
  readonly protocolId?: string;
  readonly participants?: readonly string[];
  readonly synthesizer?: string;
  readonly critiqueRounds?: number;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly plan?: ExecutionPlan;
  readonly parentRunId?: RunId;
  readonly dataClass?: DataClass;
}

export class RunService {
  private readonly controllers = new Map<RunId, AbortController>();

  constructor(
    readonly config: SwitchConfig,
    private readonly registry: ParticipantRegistry,
    private readonly repository: RunRepository,
    private readonly executor: RunExecutor,
    private readonly compiler = new ProtocolCompiler(),
  ) {}

  create(request: CreateRunRequest): RunRecord {
    if (!request.query.trim()) throw new Error("Run query cannot be empty.");
    const profileId = request.profileId ?? this.config.defaults.profile;
    const plan =
      request.plan ??
      this.compiler.compile(this.config, {
        profileId,
        ...(request.protocolId ? { protocolId: request.protocolId } : {}),
        ...(request.participants ? { participants: request.participants } : {}),
        ...(request.synthesizer ? { synthesizer: request.synthesizer } : {}),
        ...(request.critiqueRounds !== undefined ? { critiqueRounds: request.critiqueRounds } : {}),
        ...(request.parameters ? { parameters: request.parameters } : {}),
      });
    assertValidPlan(plan, this.config);
    const policy = new PolicyEngine(this.config).assertAllowed(
      plan,
      request.dataClass ?? this.config.policy.defaultDataClass,
    );
    const participantIds = [...new Set(plan.stages.flatMap((stage) => stage.participants))];
    return this.repository.createRun({
      ...(request.parentRunId ? { parentRunId: request.parentRunId } : {}),
      mode: plan.mode,
      query: request.query,
      profileId,
      config: this.config,
      plan,
      policy: { ...this.config.policy, decision: policy },
      budget: plan.budget,
      participants: this.registry.snapshots(participantIds),
    });
  }

  async run(request: CreateRunRequest, options: ExecuteOptions): Promise<ExecutionResult> {
    const run = this.create(request);
    return this.execute(run.id, options);
  }

  async execute(runId: RunId, options: ExecuteOptions): Promise<ExecutionResult> {
    if (this.controllers.has(runId)) throw new Error(`Run ${runId} is already executing.`);
    const controller = new AbortController();
    const relayAbort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", relayAbort, { once: true });
    this.controllers.set(runId, controller);
    try {
      return await withSpan("switch.run.execute", { "switch.run.id": runId }, async () =>
        this.executor.execute(runId, {
          ...options,
          signal: controller.signal,
        }),
      );
    } finally {
      options.signal?.removeEventListener("abort", relayAbort);
      this.controllers.delete(runId);
    }
  }

  inspect(runId: RunId): {
    readonly run: RunRecord;
    readonly stages: ReturnType<RunRepository["getStages"]>;
    readonly attempts: ReturnType<RunRepository["getAttempts"]>;
    readonly artifacts: ReturnType<RunRepository["getArtifacts"]>;
    readonly events: ReturnType<RunRepository["getEvents"]>;
  } {
    return {
      run: this.repository.getRun(runId),
      stages: this.repository.getStages(runId),
      attempts: this.repository.getAttempts(runId),
      artifacts: this.repository.getArtifacts(runId),
      events: this.repository.getEvents(runId),
    };
  }

  cancel(runId: RunId): RunRecord {
    this.controllers.get(runId)?.abort(new Error("Run cancelled by user."));
    let run = this.repository.getRun(runId);
    if (["completed", "failed", "cancelled"].includes(run.status)) return run;
    if (run.status !== "cancelling") {
      run = this.repository.transitionRun(runId, "cancelling", "RunCancelling");
    }
    if (!this.controllers.has(runId)) {
      run = this.repository.transitionRun(runId, "cancelled", "RunCancelled");
    }
    return run;
  }

  pause(runId: RunId): RunRecord {
    const run = this.repository.getRun(runId);
    if (run.status !== "running" && run.status !== "waiting_for_human") {
      throw new Error(`Run ${runId} cannot be paused from ${run.status}.`);
    }
    if (run.status === "waiting_for_human") {
      for (const stage of this.repository
        .getStages(runId)
        .filter((candidate) => candidate.status === "waiting_for_human")) {
        this.repository.transitionStage(runId, stage.id, "paused", "RunPaused", {
          reason: "human_gate_paused",
        });
      }
    }
    return this.repository.transitionRun(runId, "paused", "RunPaused");
  }

  async resume(runId: RunId, options: ExecuteOptions): Promise<ExecutionResult> {
    const run = this.repository.getRun(runId);
    if (run.status !== "paused" && run.status !== "recovering") {
      throw new Error(`Run ${runId} cannot resume from ${run.status}.`);
    }
    for (const stage of this.repository.getStages(runId)) {
      if (stage.status === "paused") {
        this.repository.transitionStage(runId, stage.id, "ready", "StageReady");
      }
    }
    return this.execute(runId, options);
  }

  async submitHumanInput(
    runId: RunId,
    stageId: string,
    text: string,
    options: ExecuteOptions,
  ): Promise<ExecutionResult> {
    this.executor.submitHumanInput(runId, stageId, text);
    return this.execute(runId, options);
  }

  fork(
    parentRunId: RunId,
    overrides: Omit<CreateRunRequest, "parentRunId"> = { query: "" },
  ): RunRecord {
    const parent = this.repository.getRun(parentRunId);
    const child = this.create({
      query: overrides.query || parent.query,
      profileId: overrides.profileId ?? parent.profileId,
      plan: overrides.plan ?? parent.plan,
      ...(overrides.protocolId ? { protocolId: overrides.protocolId } : {}),
      ...(overrides.participants ? { participants: overrides.participants } : {}),
      ...(overrides.synthesizer ? { synthesizer: overrides.synthesizer } : {}),
      ...(overrides.critiqueRounds !== undefined
        ? { critiqueRounds: overrides.critiqueRounds }
        : {}),
      ...(overrides.parameters ? { parameters: overrides.parameters } : {}),
      ...(overrides.dataClass ? { dataClass: overrides.dataClass } : {}),
      parentRunId,
    });
    this.repository.appendEvent(child.id, "RunForked", { parentRunId }, "switch.run-service");
    return child;
  }
}
