import { SwitchError } from "../domain/errors.js";
import type { RunId } from "../domain/ids.js";
import type { Budget } from "../schema/common.js";
import type { PlanStage } from "../schema/execution-plan.js";
import type { AttemptRecord, RunRepository } from "../persistence/run-repository.js";

export class BudgetGuard {
  constructor(
    private readonly repository: RunRepository,
    private readonly runId: RunId,
    private readonly budget: Budget,
  ) {}

  assertCanSchedule(additionalCalls = 1, stage?: Pick<PlanStage, "id" | "budget">): void {
    const attempts = this.repository.getAttempts(this.runId);
    this.assertCalls(this.budget, attempts, additionalCalls, "run");
    this.assertWallTime(this.budget, this.repository.getRun(this.runId).startedAt, "run", true);
    this.assertUsage(this.budget, attempts, "run", true);
    if (stage?.budget) {
      const stageAttempts = attempts.filter((attempt) => attempt.stageId === stage.id);
      this.assertCalls(stage.budget, stageAttempts, additionalCalls, `stage:${stage.id}`);
      this.assertWallTime(
        stage.budget,
        this.repository.getStage(this.runId, stage.id).startedAt,
        `stage:${stage.id}`,
        true,
      );
      this.assertUsage(stage.budget, stageAttempts, `stage:${stage.id}`, true);
    }
  }

  assertWithinLimits(stage?: Pick<PlanStage, "id" | "budget">): void {
    const attempts = this.repository.getAttempts(this.runId);
    this.assertCalls(this.budget, attempts, 0, "run");
    this.assertWallTime(this.budget, this.repository.getRun(this.runId).startedAt, "run", false);
    this.assertUsage(this.budget, attempts, "run", false);
    if (stage?.budget) {
      const stageAttempts = attempts.filter((attempt) => attempt.stageId === stage.id);
      this.assertCalls(stage.budget, stageAttempts, 0, `stage:${stage.id}`);
      this.assertWallTime(
        stage.budget,
        this.repository.getStage(this.runId, stage.id).startedAt,
        `stage:${stage.id}`,
        false,
      );
      this.assertUsage(stage.budget, stageAttempts, `stage:${stage.id}`, false);
    }
  }

  private assertCalls(
    budget: Budget,
    attempts: readonly AttemptRecord[],
    additionalCalls: number,
    scope: string,
  ): void {
    if (budget.maxCalls !== undefined && attempts.length + additionalCalls > budget.maxCalls) {
      this.exceeded(`${scope}.calls`, attempts.length + additionalCalls, budget.maxCalls);
    }
  }

  private assertWallTime(
    budget: Budget,
    startedAt: string | undefined,
    scope: string,
    inclusive: boolean,
  ): void {
    if (budget.maxWallTimeMs === undefined || !startedAt) return;
    const elapsed = Math.max(0, Date.now() - Date.parse(startedAt));
    if (inclusive ? elapsed >= budget.maxWallTimeMs : elapsed > budget.maxWallTimeMs) {
      this.exceeded(`${scope}.wallTimeMs`, elapsed, budget.maxWallTimeMs);
    }
  }

  private assertUsage(
    budget: Budget,
    attempts: readonly AttemptRecord[],
    scope: string,
    inclusive: boolean,
  ): void {
    const check = (
      field: "inputTokens" | "outputTokens" | "cost",
      maximum: number | undefined,
    ): void => {
      if (maximum === undefined) return;
      const consumed = attempts.reduce((sum, attempt) => {
        const value = attempt.usage[field];
        return sum + (typeof value === "number" ? value : 0);
      }, 0);
      if (inclusive ? consumed >= maximum : consumed > maximum) {
        this.exceeded(`${scope}.${field}`, consumed, maximum);
      }
    };
    check("inputTokens", budget.maxInputTokens);
    check("outputTokens", budget.maxOutputTokens);
    check("cost", budget.maxCost);
  }

  private exceeded(dimension: string, consumed: number, maximum: number): never {
    throw new SwitchError({
      code: "quota_exhausted",
      message: `Run budget exceeded for ${dimension}: ${consumed} >= ${maximum}.`,
      retry: "non_retryable",
      details: { dimension, consumed, maximum },
    });
  }
}
