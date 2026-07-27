import { Type, type Static } from "@sinclair/typebox";

export const SessionModeSchema = Type.Union([
  Type.Literal("council"),
  Type.Literal("routed"),
  Type.Literal("direct"),
  Type.Literal("plan"),
]);
export type SessionMode = Static<typeof SessionModeSchema>;

export const ConfigSourceSchema = Type.Union([
  Type.Literal("manual"),
  Type.Literal("default"),
  Type.Literal("auto"),
]);
export type ConfigSource = Static<typeof ConfigSourceSchema>;

export const CollapsePolicySchema = Type.Union([
  Type.Literal("collapsed"),
  Type.Literal("expanded"),
]);
export type CollapsePolicy = Static<typeof CollapsePolicySchema>;

export const SessionStateSchema = Type.Object(
  {
    apiVersion: Type.Literal("switch.dev/session/v1alpha1"),
    mode: SessionModeSchema,
    configSource: ConfigSourceSchema,
    profileId: Type.String({ minLength: 1 }),
    protocolId: Type.Optional(Type.String({ minLength: 1 })),
    participants: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
    synthesizer: Type.Optional(Type.String({ minLength: 1 })),
    routerParticipantId: Type.Optional(Type.String({ minLength: 1 })),
    autoDeciderParticipantId: Type.Optional(Type.String({ minLength: 1 })),
    critiqueRounds: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
    roleBindings: Type.Optional(Type.Record(Type.String(), Type.String())),
    hyperparams: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    goal: Type.String(),
    collapsePolicy: CollapsePolicySchema,
    thinking: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    planMode: Type.Boolean(),
  },
  { additionalProperties: false, $id: "switch.dev/session/v1alpha1" },
);
export type SessionState = Static<typeof SessionStateSchema>;

export function createDefaultSessionState(profileId = "balanced"): SessionState {
  return {
    apiVersion: "switch.dev/session/v1alpha1",
    mode: "council",
    configSource: "default",
    profileId,
    goal: "",
    collapsePolicy: "collapsed",
    thinking: "high",
    planMode: false,
  };
}
