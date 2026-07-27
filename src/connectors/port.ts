import type { ConnectorConfig, ParticipantConfig } from "../schema/config.js";
import type {
  ConnectorManifest,
  ParticipantRequest,
  ParticipantResult,
  ParticipantSnapshot,
} from "../schema/participant.js";

export interface InvocationContext {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly thinking?: "low" | "medium" | "high";
  readonly environment?: NodeJS.ProcessEnv;
}

export interface ConnectorHealth {
  readonly status: "healthy" | "degraded" | "unavailable" | "unauthenticated";
  readonly checkedAt: string;
  readonly message: string;
  readonly version?: string;
  readonly latencyMs?: number;
}

export interface ResolvedParticipant {
  readonly id: string;
  readonly participant: ParticipantConfig;
  readonly connector: ConnectorConfig;
  readonly snapshot: ParticipantSnapshot;
}

export interface ParticipantConnector {
  readonly manifest: ConnectorManifest;
  invoke(
    participant: ResolvedParticipant,
    request: ParticipantRequest,
    context: InvocationContext,
  ): Promise<ParticipantResult>;
  health(
    connector: ConnectorConfig,
    context: Pick<InvocationContext, "cwd" | "environment">,
  ): Promise<ConnectorHealth>;
  listModels?(
    connector: ConnectorConfig,
    context: Pick<InvocationContext, "cwd" | "environment">,
  ): Promise<readonly string[]>;
}

export interface ParticipantPort {
  readonly id: string;
  readonly snapshot: ParticipantSnapshot;
  invoke(request: ParticipantRequest, context: InvocationContext): Promise<ParticipantResult>;
  health(context: Pick<InvocationContext, "cwd" | "environment">): Promise<ConnectorHealth>;
}
