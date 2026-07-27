import { Type, type Static } from "@sinclair/typebox";
import { RoutingStrategySchema } from "../schema/routing.js";

export const RouterProposalSchema = Type.Object(
  {
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
    selectedParticipants: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      uniqueItems: true,
    }),
    protocolId: Type.Optional(Type.String({ minLength: 1 })),
    critiqueRounds: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
    alternatives: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
export type RouterProposal = Static<typeof RouterProposalSchema>;
