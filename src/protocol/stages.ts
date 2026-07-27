import type { Budget } from "../schema/common.js";
import type { OperatorKind, PlanStage } from "../schema/execution-plan.js";

const retry = {
  maxAttempts: 2,
  initialDelayMs: 250,
  maxDelayMs: 2_000,
  backoffMultiplier: 2,
} as const;

export interface StageOptions {
  readonly id: string;
  readonly operator: OperatorKind;
  readonly participants?: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly inputStages?: readonly string[];
  readonly role?: string;
  readonly visibility?: PlanStage["visibility"];
  readonly quorum?: number;
  readonly timeoutMs: number;
  readonly budget?: Budget;
  readonly maxIterations?: number;
  readonly config?: Readonly<Record<string, unknown>>;
}

export function stage(options: StageOptions): PlanStage {
  const participants = [...(options.participants ?? [])];
  return {
    id: options.id,
    operator: options.operator,
    dependsOn: [...(options.dependsOn ?? [])],
    participants,
    ...(options.role ? { role: options.role } : {}),
    ...(options.inputStages ? { inputStages: [...options.inputStages] } : {}),
    visibility: options.visibility ?? "identity-stripped-council",
    quorum:
      options.quorum ??
      (participants.length === 0 ? 0 : Math.max(1, Math.ceil(participants.length / 2))),
    retry,
    timeoutMs: options.timeoutMs,
    ...(options.budget ? { budget: options.budget } : {}),
    ...(options.maxIterations ? { maxIterations: options.maxIterations } : {}),
    ...(options.config ? { config: { ...options.config } } : {}),
  };
}
