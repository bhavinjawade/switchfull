import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BackupManifestSchema,
  SwitchConfigSchema,
  DecisionSchema,
  RunEventEnvelopeSchema,
  ExecutionPlanSchema,
  ParticipantRequestSchema,
  ParticipantResultSchema,
  RoutingDecisionSchema,
  RunExportManifestSchema,
} from "../src/schema/index.js";
import { PluginManifestSchema } from "../src/plugins/schema.js";
import { RouterProposalSchema } from "../src/routing/schema.js";

const root = join(import.meta.dirname, "..", "schemas");
mkdirSync(root, { recursive: true });

const schemas: Readonly<Record<string, object>> = {
  "backup-manifest-v1alpha1": BackupManifestSchema,
  "config-v2": SwitchConfigSchema,
  "decision-v1alpha1": DecisionSchema,
  "execution-plan-v1alpha1": ExecutionPlanSchema,
  "participant-request-v1alpha1": ParticipantRequestSchema,
  "participant-result-v1alpha1": ParticipantResultSchema,
  "plugin-manifest-v1alpha1": PluginManifestSchema,
  "router-proposal-v1alpha1": RouterProposalSchema,
  "routing-decision-v1alpha1": RoutingDecisionSchema,
  "run-export-manifest-v1alpha1": RunExportManifestSchema,
  "run-event-v1alpha1": RunEventEnvelopeSchema,
};

for (const [name, schema] of Object.entries(schemas)) {
  writeFileSync(
    join(root, `${name}.schema.json`),
    `${JSON.stringify(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: `https://switch.dev/schema/${name}`,
        ...schema,
      },
      null,
      2,
    )}\n`,
  );
}
