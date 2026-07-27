import { Type, type Static } from "@sinclair/typebox";
import { BillingTypeSchema, IdSchema, UsageSchema } from "./common.js";

export const ParticipantKindSchema = Type.Union([
  Type.Literal("model"),
  Type.Literal("model_session"),
  Type.Literal("agent"),
  Type.Literal("judge"),
  Type.Literal("verifier"),
  Type.Literal("human"),
  Type.Literal("composite"),
]);
export type ParticipantKind = Static<typeof ParticipantKindSchema>;

export const AuthOwnerSchema = Type.Union([
  Type.Literal("external_cli"),
  Type.Literal("switch_secret_store"),
  Type.Literal("environment"),
  Type.Literal("operating_system"),
  Type.Literal("provider_sdk"),
  Type.Literal("enterprise_identity"),
  Type.Literal("none"),
]);
export type AuthOwner = Static<typeof AuthOwnerSchema>;

export const CapabilitySchema = Type.Union([
  Type.Literal("text_generation"),
  Type.Literal("structured_output"),
  Type.Literal("streaming"),
  Type.Literal("tool_use"),
  Type.Literal("vision"),
  Type.Literal("file_context"),
  Type.Literal("workspace"),
  Type.Literal("persistent_session"),
  Type.Literal("reasoning_controls"),
  Type.Literal("seed_support"),
  Type.Literal("usage_reporting"),
  Type.Literal("provider_idempotency"),
  Type.Literal("cancellation"),
]);
export type Capability = Static<typeof CapabilitySchema>;

export const ConnectorManifestSchema = Type.Object(
  {
    apiVersion: Type.Literal("switch.dev/connector/v1alpha1"),
    id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    version: Type.String({ minLength: 1 }),
    kind: ParticipantKindSchema,
    stability: Type.Union([
      Type.Literal("built-in-stable"),
      Type.Literal("first-party-beta"),
      Type.Literal("first-party-experimental"),
      Type.Literal("community"),
      Type.Literal("unsupported"),
    ]),
    transport: Type.Union([
      Type.Literal("process"),
      Type.Literal("http"),
      Type.Literal("acp"),
      Type.Literal("embedded"),
      Type.Literal("human"),
    ]),
    authOwner: AuthOwnerSchema,
    billingType: BillingTypeSchema,
    capabilities: Type.Array(CapabilitySchema, { uniqueItems: true }),
    command: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
    environmentAllowlist: Type.Optional(Type.Array(Type.String(), { uniqueItems: true })),
    supportedPlatforms: Type.Optional(Type.Array(Type.String(), { uniqueItems: true })),
  },
  { additionalProperties: false },
);
export type ConnectorManifest = Static<typeof ConnectorManifestSchema>;

export const ParticipantSnapshotSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    kind: ParticipantKindSchema,
    connectorId: Type.String({ minLength: 1 }),
    connectorVersion: Type.String({ minLength: 1 }),
    provider: Type.Optional(Type.String({ minLength: 1 })),
    model: Type.Optional(Type.String({ minLength: 1 })),
    displayName: Type.String({ minLength: 1 }),
    role: Type.Optional(Type.String({ minLength: 1 })),
    mandate: Type.Optional(Type.String()),
    capabilities: Type.Array(CapabilitySchema, { uniqueItems: true }),
    expertise: Type.Array(Type.String(), { uniqueItems: true }),
    billingType: BillingTypeSchema,
    privacyClass: Type.Union([
      Type.Literal("local"),
      Type.Literal("external"),
      Type.Literal("enterprise"),
      Type.Literal("unknown"),
    ]),
    configHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  },
  { additionalProperties: false },
);
export type ParticipantSnapshot = Static<typeof ParticipantSnapshotSchema>;

export const ParticipantMessageSchema = Type.Object(
  {
    role: Type.Union([
      Type.Literal("system"),
      Type.Literal("user"),
      Type.Literal("assistant"),
      Type.Literal("tool"),
    ]),
    content: Type.String(),
  },
  { additionalProperties: false },
);

export const ParticipantRequestSchema = Type.Object(
  {
    requestId: IdSchema,
    messages: Type.Array(ParticipantMessageSchema, { minItems: 1 }),
    model: Type.Optional(Type.String()),
    outputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    sessionId: Type.Optional(Type.String()),
    workspace: Type.Optional(Type.String()),
    deadline: Type.Optional(Type.String({ format: "date-time" })),
    idempotencyKey: Type.Optional(Type.String()),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type ParticipantRequest = Static<typeof ParticipantRequestSchema>;

export const ParticipantResultSchema = Type.Object(
  {
    requestId: IdSchema,
    text: Type.String(),
    raw: Type.Optional(Type.String()),
    structured: Type.Optional(Type.Unknown()),
    providerRequestId: Type.Optional(Type.String()),
    sessionId: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    stopReason: Type.Optional(Type.String()),
    usage: UsageSchema,
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type ParticipantResult = Static<typeof ParticipantResultSchema>;
