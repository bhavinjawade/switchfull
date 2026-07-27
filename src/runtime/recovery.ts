import type { RunId } from "../domain/ids.js";
import type { RunRepository } from "../persistence/run-repository.js";
import type { SwitchConfig } from "../schema/config.js";

export interface RecoveryDiagnostic {
  readonly runId: RunId;
  readonly action: "reconciled" | "paused" | "ready";
  readonly message: string;
}

export class RecoveryService {
  constructor(
    private readonly repository: RunRepository,
    private readonly config: SwitchConfig,
  ) {}

  recover(): readonly RecoveryDiagnostic[] {
    const diagnostics: RecoveryDiagnostic[] = [];
    for (const run of this.repository.listRecoverableRuns()) {
      this.repository.verifyJournal(run.id);
      const runningAttempts = this.repository
        .getAttempts(run.id)
        .filter((attempt) => attempt.state === "running");
      for (const attempt of runningAttempts) {
        const receipt = this.repository
          .getAttemptArtifacts(attempt.id)
          .find((artifact) => artifact.kind !== "routing_proposal");
        if (receipt) {
          this.repository.finishAttempt(attempt.id, "succeeded", {
            resultArtifactId: receipt.id,
            uncertainty: { recoveredFromDurableArtifact: true },
          });
          diagnostics.push({
            runId: run.id,
            action: "reconciled",
            message: `Recovered attempt ${attempt.id} from durable artifact ${receipt.id}.`,
          });
        } else {
          this.repository.finishAttempt(attempt.id, "unknown", {
            uncertainty: {
              reason: "process_terminated_between_external_call_and_durable_receipt",
            },
          });
        }
      }
      for (const stage of this.repository
        .getStages(run.id)
        .filter((candidate) => candidate.status === "running")) {
        const attempts = this.repository.getAttempts(run.id, stage.id);
        const succeeded = attempts.filter((attempt) => attempt.state === "succeeded").length;
        if (succeeded >= stage.plan.quorum) {
          this.repository.transitionStage(run.id, stage.id, "completed", "StageCompleted", {
            recovered: true,
          });
        } else {
          this.repository.transitionStage(run.id, stage.id, "paused", "RunPaused", {
            recovered: true,
            succeeded,
            quorum: stage.plan.quorum,
          });
        }
      }
      let current = this.repository.getRun(run.id);
      if (current.status === "running") {
        current = this.repository.transitionRun(
          run.id,
          "recovering",
          "RunPaused",
          { recovery: true },
          "switch.recovery",
        );
      }
      const hasUnknown = this.repository
        .getAttempts(run.id)
        .some((attempt) => attempt.state === "unknown");
      if (
        hasUnknown &&
        (this.config.defaults.unknownAttemptPolicy === "pause" ||
          this.config.defaults.unknownAttemptPolicy === "human")
      ) {
        if (current.status === "recovering") {
          this.repository.transitionRun(
            run.id,
            "paused",
            "RunPaused",
            { reason: "unknown_attempt_requires_review" },
            "switch.recovery",
          );
        }
        diagnostics.push({
          runId: run.id,
          action: "paused",
          message: "Run paused because an external invocation has unknown completion state.",
        });
      } else {
        diagnostics.push({
          runId: run.id,
          action: "ready",
          message: "Run is ready to resume.",
        });
      }
    }
    return diagnostics;
  }
}
