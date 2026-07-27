import { SwitchError } from "../domain/errors.js";
import type { SwitchConfig } from "../schema/config.js";
import {
  ExecutionPlanSchema,
  type ExecutionPlan,
  type PlanStage,
} from "../schema/execution-plan.js";
import { compileValidator } from "../schema/validator.js";

const validateSchema = compileValidator(ExecutionPlanSchema);

export interface PlanViolation {
  readonly code: string;
  readonly message: string;
  readonly stageId?: string;
  readonly repairable: boolean;
}

export interface PlanValidation {
  readonly outcome: "accepted" | "repairable" | "denied" | "requires_human";
  readonly violations: readonly PlanViolation[];
  readonly estimatedCalls: number;
}

function sampleCount(stage: PlanStage): number {
  const configured = stage.config?.["sampleCount"];
  return typeof configured === "number" && Number.isInteger(configured) ? configured : 1;
}

export function estimatePlanCalls(plan: ExecutionPlan): number {
  return plan.stages.reduce((sum, stage) => {
    if (stage.operator === "human_gate" || stage.operator === "stop") return sum;
    return sum + stage.participants.length * (stage.operator === "sample" ? sampleCount(stage) : 1);
  }, 0);
}

function hasCycle(stages: readonly PlanStage[]): boolean {
  const dependencies = new Map(stages.map((stage) => [stage.id, stage.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return stages.some((stage) => visit(stage.id));
}

function ancestorIds(
  stageId: string,
  dependencies: ReadonlyMap<string, readonly string[]>,
): ReadonlySet<string> {
  const ancestors = new Set<string>();
  const pending = [...(dependencies.get(stageId) ?? [])];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || ancestors.has(current)) continue;
    ancestors.add(current);
    pending.push(...(dependencies.get(current) ?? []));
  }
  return ancestors;
}

export function validatePlan(planValue: unknown, config: SwitchConfig): PlanValidation {
  let plan: ExecutionPlan;
  try {
    plan = validateSchema(planValue);
  } catch (error) {
    return {
      outcome: "denied",
      violations: [
        {
          code: "schema_invalid",
          message: error instanceof Error ? error.message : String(error),
          repairable: true,
        },
      ],
      estimatedCalls: 0,
    };
  }
  const violations: PlanViolation[] = [];
  const ids = new Set<string>();
  for (const stage of plan.stages) {
    if (ids.has(stage.id)) {
      violations.push({
        code: "duplicate_stage",
        message: `Stage ${stage.id} is duplicated.`,
        stageId: stage.id,
        repairable: true,
      });
    }
    ids.add(stage.id);
  }
  const dependencies = new Map(plan.stages.map((stage) => [stage.id, stage.dependsOn]));
  const declaredEntries = new Set(plan.entryStages);
  const actualEntries = new Set(
    plan.stages.filter((stage) => stage.dependsOn.length === 0).map((stage) => stage.id),
  );
  for (const entry of declaredEntries) {
    if (!actualEntries.has(entry)) {
      violations.push({
        code: "invalid_entry_stage",
        message: `Declared entry stage ${entry} is missing or has dependencies.`,
        stageId: entry,
        repairable: true,
      });
    }
  }
  for (const entry of actualEntries) {
    if (!declaredEntries.has(entry)) {
      violations.push({
        code: "undeclared_entry_stage",
        message: `Dependency-free stage ${entry} is not declared as an entry stage.`,
        stageId: entry,
        repairable: true,
      });
    }
  }
  for (const stage of plan.stages) {
    for (const dependency of stage.dependsOn) {
      if (!ids.has(dependency)) {
        violations.push({
          code: "missing_dependency",
          message: `Stage ${stage.id} depends on missing stage ${dependency}.`,
          stageId: stage.id,
          repairable: true,
        });
      }
    }
    const ancestors = ancestorIds(stage.id, dependencies);
    for (const inputStage of stage.inputStages ?? []) {
      if (!ids.has(inputStage)) {
        violations.push({
          code: "missing_input_stage",
          message: `Stage ${stage.id} reads from missing stage ${inputStage}.`,
          stageId: stage.id,
          repairable: true,
        });
      } else if (!ancestors.has(inputStage)) {
        violations.push({
          code: "undeclared_data_dependency",
          message: `Stage ${stage.id} reads ${inputStage} without a dependency path.`,
          stageId: stage.id,
          repairable: true,
        });
      }
    }
    for (const participantId of stage.participants) {
      const participant = config.participants[participantId];
      if (!participant?.enabled) {
        violations.push({
          code: "participant_ineligible",
          message: `Participant ${participantId} is missing or disabled.`,
          stageId: stage.id,
          repairable: true,
        });
        continue;
      }
      const connector = config.connectors[participant.connector];
      if (!connector?.enabled) {
        violations.push({
          code: "connector_ineligible",
          message: `Connector ${participant.connector} is missing or disabled.`,
          stageId: stage.id,
          repairable: true,
        });
      } else if (
        connector.billingType === "prepaid_subscription" &&
        (config.policy.deployment === "hosted" || !config.policy.allowPersonalSubscriptions)
      ) {
        violations.push({
          code: "subscription_denied",
          message: `Personal subscription participant ${participantId} is denied by policy.`,
          stageId: stage.id,
          repairable: false,
        });
      }
    }
    if (!["human_gate", "stop"].includes(stage.operator) && stage.participants.length === 0) {
      violations.push({
        code: "participants_required",
        message: `Stage ${stage.id} requires at least one participant.`,
        stageId: stage.id,
        repairable: true,
      });
    }
    if (
      stage.quorum >
      stage.participants.length * (stage.operator === "sample" ? sampleCount(stage) : 1)
    ) {
      violations.push({
        code: "impossible_quorum",
        message: `Stage ${stage.id} quorum exceeds its participant count.`,
        stageId: stage.id,
        repairable: true,
      });
    }
    if (
      (stage.operator === "human_gate" || stage.operator === "stop") &&
      (stage.participants.length > 0 || stage.quorum !== 0)
    ) {
      violations.push({
        code: "deterministic_stage_contract",
        message: `Stage ${stage.id} must have no participants and zero quorum.`,
        stageId: stage.id,
        repairable: true,
      });
    }
    if (stage.operator === "stop" && (stage.inputStages ?? stage.dependsOn).length === 0) {
      violations.push({
        code: "stop_input_required",
        message: `Stop stage ${stage.id} requires an input stage.`,
        stageId: stage.id,
        repairable: true,
      });
    }
    if (stage.retry.maxDelayMs < stage.retry.initialDelayMs) {
      violations.push({
        code: "invalid_retry_delay",
        message: `Stage ${stage.id} max retry delay is below its initial delay.`,
        stageId: stage.id,
        repairable: true,
      });
    }
  }
  const finalStage = plan.stages.find((stage) => stage.id === plan.finalStage);
  if (!finalStage) {
    violations.push({
      code: "missing_final_stage",
      message: `Final stage ${plan.finalStage} does not exist.`,
      repairable: true,
    });
  } else {
    if (finalStage.visibility !== "public-result") {
      violations.push({
        code: "final_stage_not_public",
        message: `Final stage ${finalStage.id} must use public-result visibility.`,
        stageId: finalStage.id,
        repairable: true,
      });
    }
    if (finalStage.condition) {
      violations.push({
        code: "conditional_final_stage",
        message: `Final stage ${finalStage.id} cannot be conditional.`,
        stageId: finalStage.id,
        repairable: true,
      });
    }
    const finalAncestors = ancestorIds(finalStage.id, dependencies);
    for (const stage of plan.stages) {
      if (stage.id !== finalStage.id && !finalAncestors.has(stage.id)) {
        violations.push({
          code: "orphan_stage",
          message: `Stage ${stage.id} does not contribute to final stage ${finalStage.id}.`,
          stageId: stage.id,
          repairable: true,
        });
      }
    }
  }
  if (hasCycle(plan.stages)) {
    violations.push({
      code: "cyclic_plan",
      message: "Execution plan contains a dependency cycle.",
      repairable: true,
    });
  }
  const estimatedCalls = estimatePlanCalls(plan);
  if (plan.budget.maxCalls !== undefined && estimatedCalls > plan.budget.maxCalls) {
    violations.push({
      code: "call_budget_exceeded",
      message: `Plan needs up to ${estimatedCalls} calls but maxCalls is ${plan.budget.maxCalls}.`,
      repairable: true,
    });
  }
  if (plan.budget.maxGraphNodes !== undefined && plan.stages.length > plan.budget.maxGraphNodes) {
    violations.push({
      code: "graph_budget_exceeded",
      message: `Plan has ${plan.stages.length} stages but maxGraphNodes is ${plan.budget.maxGraphNodes}.`,
      repairable: true,
    });
  }
  const outcome =
    violations.length === 0
      ? "accepted"
      : violations.every((violation) => violation.repairable)
        ? "repairable"
        : "denied";
  return { outcome, violations, estimatedCalls };
}

export function assertValidPlan(plan: unknown, config: SwitchConfig): ExecutionPlan {
  const validation = validatePlan(plan, config);
  if (validation.outcome !== "accepted") {
    throw new SwitchError({
      code: "validation_error",
      message: "Execution plan validation failed.",
      retry: "non_retryable",
      details: { validation },
    });
  }
  return plan as ExecutionPlan;
}
