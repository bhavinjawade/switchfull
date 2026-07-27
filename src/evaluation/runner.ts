import { hashObject } from "../domain/hash.js";
import type { RunService } from "../runtime/run-service.js";
import { parallelMap } from "../runtime/concurrency.js";
import type { EvaluationDataset } from "./dataset.js";
import type { EvaluationRepository, ExperimentRecord, TrialRecord } from "./repository.js";
import { scoreOutput } from "./scoring.js";

export interface EvaluationResult {
  readonly experiment: ExperimentRecord;
  readonly trials: readonly TrialRecord[];
}

export class EvaluationRunner {
  constructor(
    private readonly runs: RunService,
    private readonly repository: EvaluationRepository,
  ) {}

  async run(input: {
    readonly dataset: EvaluationDataset;
    readonly profiles: readonly string[];
    readonly cwd: string;
    readonly maxConcurrency?: number;
    readonly signal?: AbortSignal;
  }): Promise<EvaluationResult> {
    if (input.profiles.length === 0) throw new Error("At least one profile is required.");
    const experiment = this.repository.createExperiment({
      name: input.dataset.name,
      datasetHash: input.dataset.hash,
      profiles: input.profiles,
      config: { maxConcurrency: input.maxConcurrency ?? 1 },
    });
    const work = input.profiles.flatMap((profileId) =>
      input.dataset.cases.map((item) => ({ profileId, item })),
    );
    await parallelMap(work, input.maxConcurrency ?? 1, async ({ profileId, item }) => {
      const trial = this.repository.createTrial({
        experimentId: experiment.id,
        caseId: item.id,
        profileId,
        inputHash: hashObject(item.input),
      });
      const startedAt = performance.now();
      try {
        const result = await this.runs.run(
          { query: item.input, profileId },
          {
            cwd: input.cwd,
            ...(input.signal ? { signal: input.signal } : {}),
          },
        );
        const answer = result.decision?.answer ?? "";
        if (result.run.status !== "completed") {
          throw new Error(
            result.run.failure?.["message"]?.toString() ?? `Run ended with ${result.run.status}.`,
          );
        }
        return this.repository.finishTrial(trial.id, {
          status: "completed",
          runId: result.run.id,
          latencyMs: performance.now() - startedAt,
          resultText: answer,
          score: scoreOutput(item, answer),
        });
      } catch (error) {
        return this.repository.finishTrial(trial.id, {
          status: "failed",
          latencyMs: performance.now() - startedAt,
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    });
    const trials = this.repository.listTrials(experiment.id);
    const profileSummaries = Object.fromEntries(
      input.profiles.map((profileId) => {
        const selected = trials.filter((trial) => trial.profileId === profileId);
        const completed = selected.filter(
          (trial): trial is TrialRecord & { score: NonNullable<TrialRecord["score"]> } =>
            trial.status === "completed" && trial.score !== undefined,
        );
        return [
          profileId,
          {
            trials: selected.length,
            completed: completed.length,
            failures: selected.length - completed.length,
            meanScore: completed.length
              ? completed.reduce((sum, trial) => sum + trial.score.value, 0) / completed.length
              : null,
            passRate: completed.length
              ? completed.filter((trial) => trial.score.passed).length / completed.length
              : null,
            meanLatencyMs: completed.length
              ? completed.reduce((sum, trial) => sum + (trial.latencyMs ?? 0), 0) / completed.length
              : null,
          },
        ];
      }),
    );
    return {
      experiment: this.repository.finishExperiment(experiment.id, {
        datasetHash: input.dataset.hash,
        cases: input.dataset.cases.length,
        profiles: profileSummaries,
      }),
      trials,
    };
  }
}
