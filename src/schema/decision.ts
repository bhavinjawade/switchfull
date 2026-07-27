import { Type, type Static } from "@sinclair/typebox";

export const DecisionContentSchema = Type.Object(
  {
    answer: Type.String(),
    consensus: Type.Array(Type.String()),
    dissent: Type.Array(Type.String()),
    unresolvedQuestions: Type.Array(Type.String()),
    risks: Type.Array(Type.String()),
    nextActions: Type.Array(Type.String()),
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  },
  { additionalProperties: false },
);
export type DecisionContent = Static<typeof DecisionContentSchema>;

export const DecisionSchema = Type.Object(
  {
    apiVersion: Type.Literal("switch.dev/decision/v1alpha1"),
    ...DecisionContentSchema.properties,
    supportingArtifactIds: Type.Array(Type.String({ format: "uuid" }), { uniqueItems: true }),
    provenance: Type.Object(
      {
        runId: Type.String({ format: "uuid" }),
        protocolId: Type.String(),
        protocolVersion: Type.String(),
        participants: Type.Array(Type.String(), { uniqueItems: true }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type Decision = Static<typeof DecisionSchema>;
