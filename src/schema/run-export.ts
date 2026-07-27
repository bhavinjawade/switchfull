import { Type, type Static } from "@sinclair/typebox";
import { HashSchema, IdSchema, TimestampSchema } from "./common.js";

export const RunExportManifestSchema = Type.Object(
  {
    apiVersion: Type.Literal("switch.dev/run-export/v1alpha1"),
    switchVersion: Type.String({
      pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$",
    }),
    createdAt: TimestampSchema,
    runId: IdSchema,
    parentRunId: Type.Union([IdSchema, Type.Null()]),
    included: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
    omitted: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
    checksums: Type.Record(Type.String({ minLength: 1 }), HashSchema),
  },
  { additionalProperties: false },
);

export type RunExportManifest = Static<typeof RunExportManifestSchema>;
