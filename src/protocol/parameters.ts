import type { ProtocolMetadata } from "./types.js";

export interface ProtocolParameterSpec {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly type: "integer" | "number" | "boolean" | "string";
  readonly minimum?: number;
  readonly maximum?: number;
  readonly defaultValue: unknown;
}

const critiqueRounds: ProtocolParameterSpec = {
  key: "critiqueRounds",
  label: "Critique / debate rounds",
  description: "How many critique or reconciliation rounds to run.",
  type: "integer",
  minimum: 0,
  maximum: 10,
  defaultValue: 1,
};

const sampleCount: ProtocolParameterSpec = {
  key: "sampleCount",
  label: "Sample count",
  description: "Independent samples for self-consistency aggregation.",
  type: "integer",
  minimum: 2,
  maximum: 16,
  defaultValue: 5,
};

/** Declares UI/auto-decider knobs each approach exposes. */
export function parametersForProtocol(protocolId: string): readonly ProtocolParameterSpec[] {
  switch (protocolId) {
    case "self-consistency":
      return [sampleCount];
    case "independent-critique-synthesis":
    case "reconcile":
    case "multi-agent-debate":
      return [critiqueRounds];
    case "generator-critic-verifier":
    case "jury":
    case "tournament":
    case "pair-rank-fusion":
    case "courtroom":
    case "cascade":
    case "mixture-of-agents":
      return [critiqueRounds];
    case "direct":
    case "human-gated-direct":
      return [];
    default:
      return [critiqueRounds];
  }
}

export function defaultHyperparams(protocolId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of parametersForProtocol(protocolId)) {
    out[spec.key] = spec.defaultValue;
  }
  return out;
}

export function describeApproach(meta: ProtocolMetadata): string {
  const cites = meta.citations.length ? ` · ${meta.citations[0]}` : "";
  return `${meta.name} (${meta.status})${cites}`;
}
