import { Type, type Static } from "@sinclair/typebox";
import { BillingTypeSchema, BudgetSchema } from "./common.js";
import { ParticipantKindSchema } from "./participant.js";

export const SecretReferenceSchema = Type.Object(
  {
    source: Type.Union([
      Type.Literal("environment"),
      Type.Literal("keychain"),
      Type.Literal("encrypted_file"),
      Type.Literal("external"),
    ]),
    key: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type SecretReference = Static<typeof SecretReferenceSchema>;

export const ConnectorConfigSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("process"),
      Type.Literal("http"),
      Type.Literal("embedded"),
      Type.Literal("human"),
    ]),
    enabled: Type.Boolean(),
    command: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
    baseUrl: Type.Optional(Type.String()),
    environmentAllowlist: Type.Array(Type.String(), { uniqueItems: true }),
    secrets: Type.Record(Type.String(), SecretReferenceSchema),
    billingType: BillingTypeSchema,
    config: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
export type ConnectorConfig = Static<typeof ConnectorConfigSchema>;

export const ParticipantConfigSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    kind: ParticipantKindSchema,
    connector: Type.String({ minLength: 1 }),
    model: Type.Optional(Type.String({ minLength: 1 })),
    displayName: Type.String({ minLength: 1 }),
    role: Type.Optional(Type.String({ minLength: 1 })),
    mandate: Type.Optional(Type.String()),
    expertise: Type.Array(Type.String(), { uniqueItems: true }),
    tags: Type.Array(Type.String(), { uniqueItems: true }),
    costPolicy: Type.Optional(Type.Union([Type.Literal("free-only"), Type.Literal("any")])),
    config: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
export type ParticipantConfig = Static<typeof ParticipantConfigSchema>;

export const ProfileConfigSchema = Type.Object(
  {
    label: Type.String({ minLength: 1 }),
    description: Type.String(),
    mode: Type.Union([Type.Literal("direct"), Type.Literal("council"), Type.Literal("routed")]),
    protocol: Type.Optional(Type.String()),
    participants: Type.Array(Type.String(), { uniqueItems: true }),
    synthesizer: Type.Optional(Type.String()),
    router: Type.Optional(Type.String()),
    critiqueRounds: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
    budget: BudgetSchema,
    config: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
export type ProfileConfig = Static<typeof ProfileConfigSchema>;

export const SwitchConfigSchema = Type.Object(
  {
    apiVersion: Type.Literal("switch.dev/config/v2"),
    defaults: Type.Object(
      {
        profile: Type.String({ minLength: 1 }),
        timeoutMs: Type.Integer({ minimum: 1 }),
        maxConcurrency: Type.Integer({ minimum: 1 }),
        unknownAttemptPolicy: Type.Union([
          Type.Literal("pause"),
          Type.Literal("human"),
          Type.Literal("retry"),
          Type.Literal("abandon"),
        ]),
      },
      { additionalProperties: false },
    ),
    connectors: Type.Record(Type.String(), ConnectorConfigSchema),
    participants: Type.Record(Type.String(), ParticipantConfigSchema),
    profiles: Type.Record(Type.String(), ProfileConfigSchema),
    plugins: Type.Optional(
      Type.Object(
        {
          trustedPluginIds: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
          allowUntrusted: Type.Boolean(),
          allowUnsafeNetwork: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    policy: Type.Object(
      {
        deployment: Type.Union([Type.Literal("local"), Type.Literal("hosted")]),
        allowPersonalSubscriptions: Type.Boolean(),
        defaultDataClass: Type.Union([
          Type.Literal("public"),
          Type.Literal("internal"),
          Type.Literal("confidential"),
          Type.Literal("restricted"),
        ]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: "switch.dev/config/v2" },
);
export type SwitchConfig = Static<typeof SwitchConfigSchema>;
