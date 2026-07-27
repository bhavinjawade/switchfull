import { Type, type Static } from "@sinclair/typebox";
import { BudgetSchema } from "./common.js";
import { ExecutionPlanSchema } from "./execution-plan.js";

export const RoutingStrategySchema = Type.Union([
  Type.Literal("single"),
  Type.Literal("parallel"),
  Type.Literal("sequential"),
  Type.Literal("council"),
  Type.Literal("verify"),
  Type.Literal("cascade"),
  Type.Literal("cached"),
  Type.Literal("human_gate"),
]);
export type RoutingStrategy = Static<typeof RoutingStrategySchema>;

export const RoutingDecisionSchema = Type.Object(
  {
    apiVersion: Type.Literal("switch.dev/routing-decision/v1alpha1"),
    id: Type.String({ format: "uuid" }),
    routerSessionId: Type.String({ format: "uuid" }),
    strategy: RoutingStrategySchema,
    reason: Type.String({ minLength: 1 }),
    difficulty: Type.Object(
      {
        level: Type.Union([
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
          Type.Literal("extreme"),
        ]),
        confidence: Type.Number({ minimum: 0, maximum: 1 }),
      },
      { additionalProperties: false },
    ),
    selectedParticipants: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
    proposedPlan: ExecutionPlanSchema,
    requestedBudget: BudgetSchema,
    alternatives: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
export type RoutingDecision = Static<typeof RoutingDecisionSchema>;
