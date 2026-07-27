import { Type, type Static } from "@sinclair/typebox";
import { ConnectorManifestSchema } from "../schema/participant.js";

export const PluginPermissionSchema = Type.Object(
  {
    filesystem: Type.Union([
      Type.Literal("none"),
      Type.Literal("workspace-read"),
      Type.Literal("workspace-write"),
    ]),
    network: Type.Union([Type.Literal("none"), Type.Literal("declared")]),
    environment: Type.Array(Type.String(), { uniqueItems: true }),
  },
  { additionalProperties: false },
);

export const PluginManifestSchema = Type.Object(
  {
    apiVersion: Type.Literal("switch.dev/plugin/v1alpha1"),
    id: Type.String({ pattern: "^[a-z0-9][a-z0-9._-]+$" }),
    name: Type.String({ minLength: 1 }),
    version: Type.String({ minLength: 1 }),
    type: Type.Union([Type.Literal("participant"), Type.Literal("protocol")]),
    trust: Type.Union([
      Type.Literal("built-in"),
      Type.Literal("first-party"),
      Type.Literal("community"),
    ]),
    command: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
    connector: Type.Optional(ConnectorManifestSchema),
    permissions: PluginPermissionSchema,
    packageHash: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
    protocolFiles: Type.Optional(Type.Array(Type.String(), { uniqueItems: true })),
  },
  { additionalProperties: false },
);
export type PluginManifest = Static<typeof PluginManifestSchema>;
