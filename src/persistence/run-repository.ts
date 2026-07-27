import { isoNow, type Clock } from "../domain/clock.js";
import { SwitchError } from "../domain/errors.js";
import { hashObject } from "../domain/hash.js";
import {
  createArtifactId,
  createAttemptId,
  createEventId,
  createRunId,
  type ArtifactId,
  type AttemptId,
  type RunId,
} from "../domain/ids.js";
import {
  assertAttemptTransition,
  assertRunTransition,
  assertStageTransition,
  type AttemptStatus,
  type RunStatus,
  type StageStatus,
} from "../domain/run.js";
import type { Budget, ExecutionMode, Usage, Visibility } from "../schema/common.js";
import type { RunEventEnvelope, RunEventType } from "../schema/event.js";
import type { ExecutionPlan, PlanStage } from "../schema/execution-plan.js";
import type { ParticipantSnapshot } from "../schema/participant.js";
import type { RoutingDecision } from "../schema/routing.js";
import { systemClock } from "../domain/clock.js";
import type { SwitchDatabase } from "./database.js";

interface RunRow {
  readonly id: string;
  readonly parent_run_id: string | null;
  readonly mode: ExecutionMode;
  readonly status: RunStatus;
  readonly version: number;
  readonly query: string;
  readonly profile_id: string;
  readonly config_json: string;
  readonly plan_json: string;
  readonly policy_json: string;
  readonly budget_json: string;
  readonly usage_json: string;
  readonly final_artifact_id: string | null;
  readonly failure_json: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly updated_at: string;
  readonly completed_at: string | null;
}

interface StageRow {
  readonly run_id: string;
  readonly id: string;
  readonly operator: string;
  readonly status: StageStatus;
  readonly sequence: number;
  readonly plan_json: string;
  readonly output_artifact_ids_json: string;
  readonly failure_json: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

interface AttemptRow {
  readonly id: string;
  readonly run_id: string;
  readonly stage_id: string;
  readonly participant_id: string;
  readonly connector_id: string;
  readonly state: AttemptStatus;
  readonly request_hash: string;
  readonly idempotency_key: string;
  readonly provider_request_id: string | null;
  readonly result_artifact_id: string | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly timeout_ms: number;
  readonly usage_json: string;
  readonly error_json: string | null;
  readonly uncertainty_json: string | null;
}

interface EventRow {
  readonly id: string;
  readonly run_id: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: RunEventType;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly actor: string;
  readonly payload_json: string;
  readonly payload_hash: string;
}

interface ArtifactRow {
  readonly id: string;
  readonly run_id: string;
  readonly stage_id: string | null;
  readonly attempt_id: string | null;
  readonly kind: string;
  readonly content_hash: string;
  readonly storage_path: string;
  readonly media_type: string;
  readonly byte_size: number;
  readonly visibility: Visibility;
  readonly parent_ids_json: string;
  readonly metadata_json: string;
  readonly created_at: string;
}

const emptyUsage: Usage = { source: "unavailable" };

function stringify(value: unknown): string {
  return JSON.stringify(value);
}

function parse(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function required<T>(value: T | undefined, message: string): T {
  if (value !== undefined) return value;
  throw new SwitchError({
    code: "storage_error",
    message,
    retry: "non_retryable",
  });
}

export interface RunRecord {
  readonly id: RunId;
  readonly parentRunId?: RunId;
  readonly mode: ExecutionMode;
  readonly status: RunStatus;
  readonly version: number;
  readonly query: string;
  readonly profileId: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly plan: ExecutionPlan;
  readonly policy: Readonly<Record<string, unknown>>;
  readonly budget: Budget;
  readonly usage: Usage;
  readonly finalArtifactId?: ArtifactId;
  readonly failure?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export interface StageRecord {
  readonly runId: RunId;
  readonly id: string;
  readonly operator: PlanStage["operator"];
  readonly status: StageStatus;
  readonly sequence: number;
  readonly plan: PlanStage;
  readonly outputArtifactIds: readonly ArtifactId[];
  readonly failure?: Readonly<Record<string, unknown>>;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface AttemptRecord {
  readonly id: AttemptId;
  readonly runId: RunId;
  readonly stageId: string;
  readonly participantId: string;
  readonly connectorId: string;
  readonly state: AttemptStatus;
  readonly requestHash: string;
  readonly idempotencyKey: string;
  readonly providerRequestId?: string;
  readonly resultArtifactId?: ArtifactId;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly timeoutMs: number;
  readonly usage: Usage;
  readonly error?: Readonly<Record<string, unknown>>;
  readonly uncertainty?: Readonly<Record<string, unknown>>;
}

export interface ArtifactRecord {
  readonly id: ArtifactId;
  readonly runId: RunId;
  readonly stageId?: string;
  readonly attemptId?: AttemptId;
  readonly kind: string;
  readonly contentHash: string;
  readonly storagePath: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly visibility: Visibility;
  readonly parentIds: readonly ArtifactId[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface CreateRunInput {
  readonly id?: RunId;
  readonly parentRunId?: RunId;
  readonly mode: ExecutionMode;
  readonly query: string;
  readonly profileId: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly plan: ExecutionPlan;
  readonly policy: Readonly<Record<string, unknown>>;
  readonly budget: Budget;
  readonly participants: readonly ParticipantSnapshot[];
  readonly actor?: string;
}

export interface RecordArtifactInput {
  readonly id?: ArtifactId;
  readonly runId: RunId;
  readonly stageId?: string;
  readonly attemptId?: AttemptId;
  readonly kind: string;
  readonly contentHash: string;
  readonly storagePath: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly visibility: Visibility;
  readonly parentIds?: readonly ArtifactId[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export class RunRepository {
  constructor(
    readonly database: SwitchDatabase,
    private readonly clock: Clock = systemClock,
  ) {}

  createRun(input: CreateRunInput): RunRecord {
    const id = input.id ?? createRunId();
    const timestamp = isoNow(this.clock);
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `INSERT INTO runs(
            id, parent_run_id, mode, status, version, query, profile_id, config_json,
            plan_json, policy_json, budget_json, usage_json, created_at, updated_at
          ) VALUES (?, ?, ?, 'created', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.parentRunId ?? null,
          input.mode,
          input.query,
          input.profileId,
          stringify(input.config),
          stringify(input.plan),
          stringify(input.policy),
          stringify(input.budget),
          stringify(emptyUsage),
          timestamp,
          timestamp,
        );
      const insertStage = this.database.raw.prepare(
        `INSERT INTO stages(
          run_id, id, operator, status, sequence, plan_json, output_artifact_ids_json
        ) VALUES (?, ?, ?, 'pending', ?, ?, '[]')`,
      );
      input.plan.stages.forEach((stage, index) => {
        insertStage.run(id, stage.id, stage.operator, index, stringify(stage));
      });
      const insertParticipant = this.database.raw.prepare(
        `INSERT INTO participant_snapshots(
          run_id, participant_id, snapshot_json, snapshot_hash
        ) VALUES (?, ?, ?, ?)`,
      );
      for (const participant of input.participants) {
        insertParticipant.run(id, participant.id, stringify(participant), hashObject(participant));
      }
      const actor = input.actor ?? "switch.run-service";
      this.appendEventInTransaction(
        id,
        "RunCreated",
        { parentRunId: input.parentRunId ?? null },
        actor,
      );
      this.appendEventInTransaction(
        id,
        "ConfigurationResolved",
        { configHash: hashObject(input.config) },
        actor,
      );
      this.appendEventInTransaction(
        id,
        "PolicyResolved",
        { policyHash: hashObject(input.policy) },
        actor,
      );
      this.appendEventInTransaction(
        id,
        "ProtocolCompiled",
        {
          protocolId: input.plan.protocolId,
          protocolVersion: input.plan.protocolVersion,
          planHash: hashObject(input.plan),
        },
        actor,
      );
      this.appendEventInTransaction(id, "ExecutionPlanAccepted", { planId: input.plan.id }, actor);
    });
    return this.getRun(id);
  }

  getRun(id: RunId): RunRecord {
    const row = this.database.raw.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
      RunRow | undefined;
    return this.toRun(required(row, `Run ${id} does not exist.`));
  }

  listRuns(status?: RunStatus): readonly RunRecord[] {
    const rows = (status
      ? this.database.raw
          .prepare("SELECT * FROM runs WHERE status = ? ORDER BY created_at DESC")
          .all(status)
      : this.database.raw
          .prepare("SELECT * FROM runs ORDER BY created_at DESC")
          .all()) as unknown as RunRow[];
    return rows.map((row) => this.toRun(row));
  }

  listRecoverableRuns(): readonly RunRecord[] {
    const terminal = ["completed", "failed", "cancelled"];
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM runs
         WHERE status NOT IN (${terminal.map(() => "?").join(",")})
         ORDER BY created_at`,
      )
      .all(...terminal) as unknown as RunRow[];
    return rows.map((row) => this.toRun(row));
  }

  transitionRun(
    id: RunId,
    status: RunStatus,
    eventType: RunEventType,
    payload: Readonly<Record<string, unknown>> = {},
    actor = "switch.executor",
  ): RunRecord {
    this.database.transaction(() => {
      const current = this.getRun(id);
      assertRunTransition(current.status, status);
      const timestamp = isoNow(this.clock);
      const startedAt = status === "running" && !current.startedAt ? timestamp : current.startedAt;
      const completedAt = ["completed", "failed", "cancelled"].includes(status)
        ? timestamp
        : current.completedAt;
      this.database.raw
        .prepare(
          `UPDATE runs
           SET status = ?, started_at = ?, completed_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(status, startedAt ?? null, completedAt ?? null, timestamp, id);
      this.appendEventInTransaction(id, eventType, { ...payload, status }, actor);
    });
    return this.getRun(id);
  }

  setRunFailure(
    id: RunId,
    failure: Readonly<Record<string, unknown>>,
    actor = "switch.executor",
  ): RunRecord {
    this.database.transaction(() => {
      const current = this.getRun(id);
      assertRunTransition(current.status, "failed");
      const timestamp = isoNow(this.clock);
      this.database.raw
        .prepare(
          `UPDATE runs
           SET status = 'failed', failure_json = ?, completed_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(stringify(failure), timestamp, timestamp, id);
      this.appendEventInTransaction(id, "RunFailed", failure, actor);
    });
    return this.getRun(id);
  }

  completeRun(id: RunId, finalArtifactId: ArtifactId): RunRecord {
    this.database.transaction(() => {
      const current = this.getRun(id);
      assertRunTransition(current.status, "completed");
      const artifact = this.getArtifact(finalArtifactId);
      if (artifact.runId !== id) {
        throw new SwitchError({
          code: "validation_error",
          message: "Final artifact belongs to another run.",
          retry: "non_retryable",
        });
      }
      const timestamp = isoNow(this.clock);
      this.database.raw
        .prepare(
          `UPDATE runs
           SET status = 'completed', final_artifact_id = ?, completed_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(finalArtifactId, timestamp, timestamp, id);
      this.appendEventInTransaction(
        id,
        "BudgetReconciled",
        { usage: current.usage },
        "switch.budget",
      );
      this.appendEventInTransaction(id, "RunCompleted", { finalArtifactId }, "switch.executor");
    });
    return this.getRun(id);
  }

  getStages(runId: RunId): readonly StageRecord[] {
    const rows = this.database.raw
      .prepare("SELECT * FROM stages WHERE run_id = ? ORDER BY sequence")
      .all(runId) as unknown as StageRow[];
    return rows.map((row) => this.toStage(row));
  }

  getStage(runId: RunId, stageId: string): StageRecord {
    const row = this.database.raw
      .prepare("SELECT * FROM stages WHERE run_id = ? AND id = ?")
      .get(runId, stageId) as StageRow | undefined;
    return this.toStage(required(row, `Stage ${stageId} does not exist in run ${runId}.`));
  }

  transitionStage(
    runId: RunId,
    stageId: string,
    status: StageStatus,
    eventType: RunEventType,
    payload: Readonly<Record<string, unknown>> = {},
  ): StageRecord {
    this.database.transaction(() => {
      const current = this.getStage(runId, stageId);
      assertStageTransition(current.status, status);
      const timestamp = isoNow(this.clock);
      const startedAt = status === "running" && !current.startedAt ? timestamp : current.startedAt;
      const completedAt = ["completed", "failed", "cancelled", "skipped"].includes(status)
        ? timestamp
        : current.completedAt;
      this.database.raw
        .prepare(
          `UPDATE stages
           SET status = ?, started_at = ?, completed_at = ?
           WHERE run_id = ? AND id = ?`,
        )
        .run(status, startedAt ?? null, completedAt ?? null, runId, stageId);
      this.appendEventInTransaction(
        runId,
        eventType,
        { ...payload, stageId, status },
        "switch.executor",
      );
    });
    return this.getStage(runId, stageId);
  }

  scheduleAttempt(input: {
    readonly id?: AttemptId;
    readonly runId: RunId;
    readonly stageId: string;
    readonly participantId: string;
    readonly connectorId: string;
    readonly request: unknown;
    readonly timeoutMs: number;
    readonly idempotencyKey?: string;
  }): AttemptRecord {
    const id = input.id ?? createAttemptId();
    const requestHash = hashObject(input.request);
    const idempotencyKey =
      input.idempotencyKey ??
      `${input.runId}:${input.stageId}:${input.participantId}:${requestHash}`;
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `INSERT INTO attempts(
            id, run_id, stage_id, participant_id, connector_id, state, request_hash,
            idempotency_key, timeout_ms, usage_json
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.runId,
          input.stageId,
          input.participantId,
          input.connectorId,
          requestHash,
          idempotencyKey,
          input.timeoutMs,
          stringify(emptyUsage),
        );
      this.appendEventInTransaction(
        input.runId,
        "AttemptScheduled",
        {
          attemptId: id,
          stageId: input.stageId,
          participantId: input.participantId,
          requestHash,
          idempotencyKey,
        },
        "switch.scheduler",
      );
    });
    return this.getAttempt(id);
  }

  startAttempt(id: AttemptId): AttemptRecord {
    const current = this.getAttempt(id);
    assertAttemptTransition(current.state, "running");
    this.database.transaction(() => {
      const timestamp = isoNow(this.clock);
      this.database.raw
        .prepare("UPDATE attempts SET state = 'running', started_at = ? WHERE id = ?")
        .run(timestamp, id);
      this.appendEventInTransaction(
        current.runId,
        "InvocationStarted",
        { attemptId: id, stageId: current.stageId },
        "switch.connector",
      );
    });
    return this.getAttempt(id);
  }

  finishAttempt(
    id: AttemptId,
    state: Exclude<AttemptStatus, "pending" | "running">,
    details: {
      readonly providerRequestId?: string;
      readonly resultArtifactId?: ArtifactId;
      readonly usage?: Usage;
      readonly error?: Readonly<Record<string, unknown>>;
      readonly uncertainty?: Readonly<Record<string, unknown>>;
    } = {},
  ): AttemptRecord {
    const current = this.getAttempt(id);
    assertAttemptTransition(current.state, state);
    const eventByState: Record<typeof state, RunEventType> = {
      succeeded: "InvocationSucceeded",
      failed: "InvocationFailed",
      timed_out: "InvocationTimedOut",
      cancelled: "InvocationCancelled",
      unknown: "InvocationBecameUnknown",
    };
    this.database.transaction(() => {
      const timestamp = isoNow(this.clock);
      this.database.raw
        .prepare(
          `UPDATE attempts SET
            state = ?, provider_request_id = ?, result_artifact_id = ?, finished_at = ?,
            usage_json = ?, error_json = ?, uncertainty_json = ?
           WHERE id = ?`,
        )
        .run(
          state,
          details.providerRequestId ?? null,
          details.resultArtifactId ?? null,
          timestamp,
          stringify(details.usage ?? emptyUsage),
          details.error ? stringify(details.error) : null,
          details.uncertainty ? stringify(details.uncertainty) : null,
          id,
        );
      this.appendEventInTransaction(
        current.runId,
        eventByState[state],
        {
          attemptId: id,
          stageId: current.stageId,
          participantId: current.participantId,
          resultArtifactId: details.resultArtifactId ?? null,
        },
        "switch.connector",
      );
      if (details.usage) {
        this.appendEventInTransaction(
          current.runId,
          "UsageRecorded",
          { attemptId: id, usage: details.usage },
          "switch.budget",
        );
      }
    });
    return this.getAttempt(id);
  }

  getAttempt(id: AttemptId): AttemptRecord {
    const row = this.database.raw.prepare("SELECT * FROM attempts WHERE id = ?").get(id) as
      AttemptRow | undefined;
    return this.toAttempt(required(row, `Attempt ${id} does not exist.`));
  }

  getAttempts(runId: RunId, stageId?: string): readonly AttemptRecord[] {
    const rows = (stageId
      ? this.database.raw
          .prepare("SELECT * FROM attempts WHERE run_id = ? AND stage_id = ? ORDER BY rowid")
          .all(runId, stageId)
      : this.database.raw
          .prepare("SELECT * FROM attempts WHERE run_id = ? ORDER BY rowid")
          .all(runId)) as unknown as AttemptRow[];
    return rows.map((row) => this.toAttempt(row));
  }

  recordArtifact(input: RecordArtifactInput): ArtifactRecord {
    const id = input.id ?? createArtifactId();
    const timestamp = isoNow(this.clock);
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `INSERT INTO artifacts(
            id, run_id, stage_id, attempt_id, kind, content_hash, storage_path, media_type,
            byte_size, visibility, parent_ids_json, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.runId,
          input.stageId ?? null,
          input.attemptId ?? null,
          input.kind,
          input.contentHash,
          input.storagePath,
          input.mediaType,
          input.byteSize,
          input.visibility,
          stringify(input.parentIds ?? []),
          stringify(input.metadata ?? {}),
          timestamp,
        );
      if (input.stageId) {
        const stage = this.getStage(input.runId, input.stageId);
        this.database.raw
          .prepare("UPDATE stages SET output_artifact_ids_json = ? WHERE run_id = ? AND id = ?")
          .run(stringify([...stage.outputArtifactIds, id]), input.runId, input.stageId);
      }
      this.appendEventInTransaction(
        input.runId,
        "ArtifactRecorded",
        {
          artifactId: id,
          stageId: input.stageId ?? null,
          attemptId: input.attemptId ?? null,
          kind: input.kind,
          contentHash: input.contentHash,
        },
        "switch.artifact-store",
      );
    });
    return this.getArtifact(id);
  }

  getArtifact(id: ArtifactId): ArtifactRecord {
    const row = this.database.raw.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as
      ArtifactRow | undefined;
    return this.toArtifact(required(row, `Artifact ${id} does not exist.`));
  }

  getArtifacts(runId: RunId, kind?: string): readonly ArtifactRecord[] {
    const rows = (kind
      ? this.database.raw
          .prepare("SELECT * FROM artifacts WHERE run_id = ? AND kind = ? ORDER BY rowid")
          .all(runId, kind)
      : this.database.raw
          .prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY rowid")
          .all(runId)) as unknown as ArtifactRow[];
    return rows.map((row) => this.toArtifact(row));
  }

  getAttemptArtifacts(attemptId: AttemptId): readonly ArtifactRecord[] {
    const rows = this.database.raw
      .prepare("SELECT * FROM artifacts WHERE attempt_id = ? ORDER BY rowid")
      .all(attemptId) as unknown as ArtifactRow[];
    return rows.map((row) => this.toArtifact(row));
  }

  getParticipantSnapshots(runId: RunId): readonly ParticipantSnapshot[] {
    const rows = this.database.raw
      .prepare(
        "SELECT snapshot_json FROM participant_snapshots WHERE run_id = ? ORDER BY participant_id",
      )
      .all(runId) as unknown as { snapshot_json: string }[];
    return rows.map((row) => parse(row.snapshot_json) as ParticipantSnapshot);
  }

  reconcileRunUsage(runId: RunId): Usage {
    const usages = this.getAttempts(runId).map((attempt) => attempt.usage);
    const sum = (field: "inputTokens" | "outputTokens" | "estimatedTokens" | "cost") => {
      const values = usages
        .map((usage) => usage[field])
        .filter((value): value is number => typeof value === "number");
      return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
    };
    const inputTokens = sum("inputTokens");
    const outputTokens = sum("outputTokens");
    const estimatedTokens = sum("estimatedTokens");
    const cost = sum("cost");
    const source =
      usages.length === 0 || usages.every((usage) => usage.source === "unavailable")
        ? "unavailable"
        : usages.some((usage) => usage.source === "estimated")
          ? "estimated"
          : "reported";
    const usage: Usage = {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
      ...(cost !== undefined ? { cost } : {}),
      source,
    };
    this.database.raw
      .prepare("UPDATE runs SET usage_json = ?, updated_at = ? WHERE id = ?")
      .run(stringify(usage), isoNow(this.clock), runId);
    return usage;
  }

  recordRoutingDecision(
    runId: RunId,
    decision: RoutingDecision,
    validation: Readonly<Record<string, unknown>>,
  ): void {
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `INSERT INTO routing_decisions(
            id, run_id, router_session_id, decision_json, validation_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          decision.id,
          runId,
          decision.routerSessionId,
          stringify(decision),
          stringify(validation),
          isoNow(this.clock),
        );
      this.appendEventInTransaction(
        runId,
        "RoutingDecisionProposed",
        {
          decisionId: decision.id,
          routerSessionId: decision.routerSessionId,
          strategy: decision.strategy,
        },
        "switch.router",
      );
    });
  }

  appendEvent(
    runId: RunId,
    type: RunEventType,
    payload: Readonly<Record<string, unknown>>,
    actor = "switch",
  ): RunEventEnvelope {
    return this.database.transaction(() =>
      this.appendEventInTransaction(runId, type, payload, actor),
    );
  }

  getEvents(runId: RunId, afterSequence = 0): readonly RunEventEnvelope[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM run_events
         WHERE run_id = ? AND sequence > ?
         ORDER BY sequence`,
      )
      .all(runId, afterSequence) as unknown as EventRow[];
    return rows.map((row) => ({
      apiVersion: "switch.dev/run-event/v1alpha1",
      id: row.id,
      runId: row.run_id,
      sequence: row.sequence,
      timestamp: row.timestamp,
      type: row.type,
      correlationId: row.correlation_id,
      ...(row.causation_id ? { causationId: row.causation_id } : {}),
      actor: row.actor,
      payload: parse(row.payload_json) as Record<string, unknown>,
      payloadHash: row.payload_hash,
    }));
  }

  verifyJournal(runId: RunId): void {
    const events = this.getEvents(runId);
    events.forEach((event, index) => {
      if (event.sequence !== index + 1) {
        throw new SwitchError({
          code: "integrity_error",
          message: `Journal sequence gap in run ${runId}.`,
          retry: "non_retryable",
          details: { expected: index + 1, actual: event.sequence },
        });
      }
      if (hashObject(event.payload) !== event.payloadHash) {
        throw new SwitchError({
          code: "integrity_error",
          message: `Journal payload hash mismatch at sequence ${event.sequence}.`,
          retry: "non_retryable",
        });
      }
    });
  }

  private appendEventInTransaction(
    runId: RunId,
    type: RunEventType,
    payload: Readonly<Record<string, unknown>>,
    actor: string,
  ): RunEventEnvelope {
    const row = this.database.raw.prepare("SELECT version FROM runs WHERE id = ?").get(runId) as
      { version: number } | undefined;
    const version = required(row, `Run ${runId} does not exist.`).version;
    const sequence = version + 1;
    const timestamp = isoNow(this.clock);
    const id = createEventId();
    const correlationId = createEventId();
    const payloadHash = hashObject(payload);
    this.database.raw
      .prepare(
        `INSERT INTO run_events(
          id, run_id, sequence, timestamp, type, correlation_id, actor, payload_json, payload_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        runId,
        sequence,
        timestamp,
        type,
        correlationId,
        actor,
        stringify(payload),
        payloadHash,
      );
    this.database.raw
      .prepare("UPDATE runs SET version = ?, updated_at = ? WHERE id = ? AND version = ?")
      .run(sequence, timestamp, runId, version);
    return {
      apiVersion: "switch.dev/run-event/v1alpha1",
      id,
      runId,
      sequence,
      timestamp,
      type,
      correlationId,
      actor,
      payload,
      payloadHash,
    };
  }

  private toRun(row: RunRow): RunRecord {
    return {
      id: row.id as RunId,
      ...(row.parent_run_id ? { parentRunId: row.parent_run_id as RunId } : {}),
      mode: row.mode,
      status: row.status,
      version: row.version,
      query: row.query,
      profileId: row.profile_id,
      config: parse(row.config_json) as Record<string, unknown>,
      plan: parse(row.plan_json) as ExecutionPlan,
      policy: parse(row.policy_json) as Record<string, unknown>,
      budget: parse(row.budget_json) as Budget,
      usage: parse(row.usage_json) as Usage,
      ...(row.final_artifact_id ? { finalArtifactId: row.final_artifact_id as ArtifactId } : {}),
      ...(row.failure_json ? { failure: parse(row.failure_json) as Record<string, unknown> } : {}),
      createdAt: row.created_at,
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      updatedAt: row.updated_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    };
  }

  private toStage(row: StageRow): StageRecord {
    return {
      runId: row.run_id as RunId,
      id: row.id,
      operator: row.operator as PlanStage["operator"],
      status: row.status,
      sequence: row.sequence,
      plan: parse(row.plan_json) as PlanStage,
      outputArtifactIds: parse(row.output_artifact_ids_json) as ArtifactId[],
      ...(row.failure_json ? { failure: parse(row.failure_json) as Record<string, unknown> } : {}),
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    };
  }

  private toAttempt(row: AttemptRow): AttemptRecord {
    return {
      id: row.id as AttemptId,
      runId: row.run_id as RunId,
      stageId: row.stage_id,
      participantId: row.participant_id,
      connectorId: row.connector_id,
      state: row.state,
      requestHash: row.request_hash,
      idempotencyKey: row.idempotency_key,
      ...(row.provider_request_id ? { providerRequestId: row.provider_request_id } : {}),
      ...(row.result_artifact_id ? { resultArtifactId: row.result_artifact_id as ArtifactId } : {}),
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      timeoutMs: row.timeout_ms,
      usage: parse(row.usage_json) as Usage,
      ...(row.error_json ? { error: parse(row.error_json) as Record<string, unknown> } : {}),
      ...(row.uncertainty_json
        ? { uncertainty: parse(row.uncertainty_json) as Record<string, unknown> }
        : {}),
    };
  }

  private toArtifact(row: ArtifactRow): ArtifactRecord {
    return {
      id: row.id as ArtifactId,
      runId: row.run_id as RunId,
      ...(row.stage_id ? { stageId: row.stage_id } : {}),
      ...(row.attempt_id ? { attemptId: row.attempt_id as AttemptId } : {}),
      kind: row.kind,
      contentHash: row.content_hash,
      storagePath: row.storage_path,
      mediaType: row.media_type,
      byteSize: row.byte_size,
      visibility: row.visibility,
      parentIds: parse(row.parent_ids_json) as ArtifactId[],
      metadata: parse(row.metadata_json) as Record<string, unknown>,
      createdAt: row.created_at,
    };
  }
}
