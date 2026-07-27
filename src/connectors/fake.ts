import type { ConnectorConfig } from "../schema/config.js";
import type {
  ConnectorManifest,
  ParticipantRequest,
  ParticipantResult,
} from "../schema/participant.js";
import type {
  ConnectorHealth,
  InvocationContext,
  ParticipantConnector,
  ResolvedParticipant,
} from "./port.js";

export interface FakeInvocation {
  readonly participantId: string;
  readonly request: ParticipantRequest;
}

export class FakeConnector implements ParticipantConnector {
  readonly calls: FakeInvocation[] = [];
  readonly manifest: ConnectorManifest = {
    apiVersion: "switch.dev/connector/v1alpha1",
    id: "fake",
    name: "Deterministic fake connector",
    version: "1.0.0",
    kind: "model",
    stability: "built-in-stable",
    transport: "embedded",
    authOwner: "none",
    billingType: "local_compute",
    capabilities: ["text_generation", "structured_output", "usage_reporting", "cancellation"],
  };

  constructor(
    private readonly handler: (
      participant: ResolvedParticipant,
      request: ParticipantRequest,
    ) => string | ParticipantResult | Promise<string | ParticipantResult> = (
      participant,
      request,
    ) => `${participant.id}: ${request.messages.at(-1)?.content ?? ""}`,
  ) {}

  async invoke(
    participant: ResolvedParticipant,
    request: ParticipantRequest,
    _context: InvocationContext,
  ): Promise<ParticipantResult> {
    this.calls.push({ participantId: participant.id, request });
    const value = await this.handler(participant, request);
    if (typeof value !== "string") return value;
    return {
      requestId: request.requestId,
      text: value,
      ...(participant.participant.model ? { model: participant.participant.model } : {}),
      usage: { inputTokens: 1, outputTokens: 1, source: "reported" },
    };
  }

  async health(
    _connector: ConnectorConfig,
    _context: Pick<InvocationContext, "cwd" | "environment">,
  ): Promise<ConnectorHealth> {
    return {
      status: "healthy",
      checkedAt: new Date().toISOString(),
      message: "Fake connector is healthy.",
      version: this.manifest.version,
    };
  }
}
