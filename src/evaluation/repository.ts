import { randomUUID } from "node:crypto";
import type { SwitchDatabase } from "../persistence/database.js";
import type { EvaluationScore } from "./scoring.js";

export interface ExperimentRecord {
  readonly id: string;
  readonly name: string;
  readonly datasetHash: string;
  readonly profiles: readonly string[];
  readonly config: Readonly<Record<string, unknown>>;
  readonly status: "running" | "completed" | "failed";
  readonly summary?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly completedAt?: string;
}

export interface TrialRecord {
  readonly id: string;
  readonly experimentId: string;
  readonly caseId: string;
  readonly profileId: string;
  readonly runId?: string;
  readonly inputHash: string;
  readonly status: "running" | "completed" | "failed";
  readonly latencyMs?: number;
  readonly resultText?: string;
  readonly score?: EvaluationScore;
  readonly error?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly completedAt?: string;
}

interface ExperimentRow {
  id: string;
  name: string;
  dataset_hash: string;
  profiles_json: string;
  config_json: string;
  status: ExperimentRecord["status"];
  summary_json: string | null;
  created_at: string;
  completed_at: string | null;
}

interface TrialRow {
  id: string;
  experiment_id: string;
  case_id: string;
  profile_id: string;
  run_id: string | null;
  input_hash: string;
  status: TrialRecord["status"];
  latency_ms: number | null;
  result_text: string | null;
  score_json: string | null;
  error_json: string | null;
  created_at: string;
  completed_at: string | null;
}

export class EvaluationRepository {
  constructor(private readonly database: SwitchDatabase) {}

  createExperiment(input: {
    readonly name: string;
    readonly datasetHash: string;
    readonly profiles: readonly string[];
    readonly config?: Readonly<Record<string, unknown>>;
  }): ExperimentRecord {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    this.database.raw
      .prepare(
        `INSERT INTO experiments(
          id, name, dataset_hash, profiles_json, config_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(
        id,
        input.name,
        input.datasetHash,
        JSON.stringify(input.profiles),
        JSON.stringify(input.config ?? {}),
        timestamp,
      );
    return this.getExperiment(id);
  }

  createTrial(input: {
    readonly experimentId: string;
    readonly caseId: string;
    readonly profileId: string;
    readonly inputHash: string;
  }): TrialRecord {
    const id = randomUUID();
    this.database.raw
      .prepare(
        `INSERT INTO evaluation_trials(
          id, experiment_id, case_id, profile_id, input_hash, status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(
        id,
        input.experimentId,
        input.caseId,
        input.profileId,
        input.inputHash,
        new Date().toISOString(),
      );
    return this.getTrial(id);
  }

  finishTrial(
    id: string,
    result:
      | {
          readonly status: "completed";
          readonly runId: string;
          readonly latencyMs: number;
          readonly resultText: string;
          readonly score: EvaluationScore;
        }
      | {
          readonly status: "failed";
          readonly runId?: string;
          readonly latencyMs: number;
          readonly error: Readonly<Record<string, unknown>>;
        },
  ): TrialRecord {
    this.database.raw
      .prepare(
        `UPDATE evaluation_trials SET
          status = ?, run_id = ?, latency_ms = ?, result_text = ?, score_json = ?,
          error_json = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        result.status,
        result.runId ?? null,
        result.latencyMs,
        result.status === "completed" ? result.resultText : null,
        result.status === "completed" ? JSON.stringify(result.score) : null,
        result.status === "failed" ? JSON.stringify(result.error) : null,
        new Date().toISOString(),
        id,
      );
    return this.getTrial(id);
  }

  finishExperiment(id: string, summary: Readonly<Record<string, unknown>>): ExperimentRecord {
    this.database.raw
      .prepare(
        `UPDATE experiments
         SET status = 'completed', summary_json = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(summary), new Date().toISOString(), id);
    return this.getExperiment(id);
  }

  getExperiment(id: string): ExperimentRecord {
    const row = this.database.raw.prepare("SELECT * FROM experiments WHERE id = ?").get(id) as
      ExperimentRow | undefined;
    if (!row) throw new Error(`Experiment ${id} does not exist.`);
    return {
      id: row.id,
      name: row.name,
      datasetHash: row.dataset_hash,
      profiles: JSON.parse(row.profiles_json) as string[],
      config: JSON.parse(row.config_json) as Record<string, unknown>,
      status: row.status,
      ...(row.summary_json
        ? { summary: JSON.parse(row.summary_json) as Record<string, unknown> }
        : {}),
      createdAt: row.created_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    };
  }

  listExperiments(): readonly ExperimentRecord[] {
    return (
      this.database.raw
        .prepare("SELECT id FROM experiments ORDER BY created_at DESC")
        .all() as unknown as { id: string }[]
    ).map((row) => this.getExperiment(row.id));
  }

  getTrial(id: string): TrialRecord {
    const row = this.database.raw
      .prepare("SELECT * FROM evaluation_trials WHERE id = ?")
      .get(id) as TrialRow | undefined;
    if (!row) throw new Error(`Trial ${id} does not exist.`);
    return {
      id: row.id,
      experimentId: row.experiment_id,
      caseId: row.case_id,
      profileId: row.profile_id,
      ...(row.run_id ? { runId: row.run_id } : {}),
      inputHash: row.input_hash,
      status: row.status,
      ...(row.latency_ms !== null ? { latencyMs: row.latency_ms } : {}),
      ...(row.result_text !== null ? { resultText: row.result_text } : {}),
      ...(row.score_json ? { score: JSON.parse(row.score_json) as EvaluationScore } : {}),
      ...(row.error_json ? { error: JSON.parse(row.error_json) as Record<string, unknown> } : {}),
      createdAt: row.created_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    };
  }

  listTrials(experimentId: string): readonly TrialRecord[] {
    return (
      this.database.raw
        .prepare("SELECT id FROM evaluation_trials WHERE experiment_id = ? ORDER BY rowid")
        .all(experimentId) as unknown as { id: string }[]
    ).map((row) => this.getTrial(row.id));
  }
}
