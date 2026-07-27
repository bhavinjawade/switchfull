import { Type, type Static } from "@sinclair/typebox";
import { BudgetSchema, ExecutionModeSchema, VisibilitySchema } from "./common.js";
import { PredicateSchema } from "./predicate.js";

export const OperatorKindSchema = Type.Union([
  Type.Literal("generate"),
  Type.Literal("sample"),
  Type.Literal("critique"),
  Type.Literal("revise"),
  Type.Literal("synthesize"),
  Type.Literal("verify"),
  Type.Literal("vote"),
  Type.Literal("stop"),
  Type.Literal("human_gate"),
]);
export type OperatorKind = Static<typeof OperatorKindSchema>;

export const RetryPolicySchema = Type.Object(
  {
    maxAttempts: Type.Integer({ minimum: 1, maximum: 10 }),
    initialDelayMs: Type.Integer({ minimum: 0 }),
    maxDelayMs: Type.Integer({ minimum: 0 }),
    backoffMultiplier: Type.Number({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const PlanStageSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    operator: OperatorKindSchema,
    dependsOn: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
    participants: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
    role: Type.Optional(Type.String()),
    promptTemplate: Type.Optional(Type.String()),
    inputStages: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
    visibility: VisibilitySchema,
    quorum: Type.Integer({ minimum: 0 }),
    condition: Type.Optional(PredicateSchema),
    budget: Type.Optional(BudgetSchema),
    retry: RetryPolicySchema,
    timeoutMs: Type.Integer({ minimum: 1 }),
    maxIterations: Type.Optional(Type.Integer({ minimum: 1 })),
    config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type PlanStage = Static<typeof PlanStageSchema>;

export const ExecutionPlanSchema = Type.Object(
  {
    apiVersion: Type.Literal("switch.dev/plan/v1alpha1"),
    id: Type.String({ format: "uuid" }),
    mode: ExecutionModeSchema,
    protocolId: Type.String({ minLength: 1 }),
    protocolVersion: Type.String({ minLength: 1 }),
    stages: Type.Array(PlanStageSchema, { minItems: 1 }),
    entryStages: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
    finalStage: Type.String({ minLength: 1 }),
    budget: BudgetSchema,
    metadata: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
export type ExecutionPlan = Static<typeof ExecutionPlanSchema>;
