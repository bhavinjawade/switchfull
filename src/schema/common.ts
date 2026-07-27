import { Type, type Static } from "@sinclair/typebox";

export const IdSchema = Type.String({ format: "uuid" });
export const TimestampSchema = Type.String({ format: "date-time" });
export const HashSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });

export const ExecutionModeSchema = Type.Union([
  Type.Literal("direct"),
  Type.Literal("council"),
  Type.Literal("routed"),
]);
export type ExecutionMode = Static<typeof ExecutionModeSchema>;

export const BillingTypeSchema = Type.Union([
  Type.Literal("metered_api"),
  Type.Literal("prepaid_subscription"),
  Type.Literal("free_tier"),
  Type.Literal("local_compute"),
  Type.Literal("enterprise_allocation"),
  Type.Literal("unknown_external"),
]);
export type BillingType = Static<typeof BillingTypeSchema>;

export const VisibilitySchema = Type.Union([
  Type.Literal("private"),
  Type.Literal("role"),
  Type.Literal("identity-stripped-council"),
  Type.Literal("council"),
  Type.Literal("judge-only"),
  Type.Literal("public-result"),
  Type.Literal("audit-only"),
]);
export type Visibility = Static<typeof VisibilitySchema>;

export const UsageSchema = Type.Object(
  {
    inputTokens: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    outputTokens: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    estimatedTokens: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    cost: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
    currency: Type.Optional(Type.Union([Type.String({ minLength: 3, maxLength: 3 }), Type.Null()])),
    subscriptionUnits: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
    source: Type.Union([
      Type.Literal("reported"),
      Type.Literal("estimated"),
      Type.Literal("unavailable"),
    ]),
  },
  { additionalProperties: false },
);
export type Usage = Static<typeof UsageSchema>;

export const BudgetSchema = Type.Object(
  {
    maxInputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    maxOutputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    maxCalls: Type.Optional(Type.Integer({ minimum: 0 })),
    maxRouterCalls: Type.Optional(Type.Integer({ minimum: 0 })),
    maxCost: Type.Optional(Type.Number({ minimum: 0 })),
    currency: Type.Optional(Type.String({ minLength: 3, maxLength: 3 })),
    maxWallTimeMs: Type.Optional(Type.Integer({ minimum: 1 })),
    maxConcurrency: Type.Optional(Type.Integer({ minimum: 1 })),
    maxRounds: Type.Optional(Type.Integer({ minimum: 0 })),
    maxGraphNodes: Type.Optional(Type.Integer({ minimum: 1 })),
    maxNestedDepth: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type Budget = Static<typeof BudgetSchema>;
