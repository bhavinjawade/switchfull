import { Type, type Static } from "@sinclair/typebox";
import { HashSchema, TimestampSchema } from "./common.js";

export const BackupManifestSchema = Type.Object(
  {
    apiVersion: Type.Literal("switch.dev/backup/v1alpha1"),
    createdAt: TimestampSchema,
    database: Type.Literal("switch.sqlite"),
    artifacts: Type.Literal("artifacts"),
    checksums: Type.Record(Type.String({ minLength: 1 }), HashSchema),
  },
  { additionalProperties: false },
);

export type BackupManifest = Static<typeof BackupManifestSchema>;
