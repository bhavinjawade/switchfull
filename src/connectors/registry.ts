import { hashObject } from "../domain/hash.js";
import { SwitchError } from "../domain/errors.js";
import type { SwitchConfig } from "../schema/config.js";
import type { Capability, ParticipantSnapshot } from "../schema/participant.js";
import type {
  ConnectorHealth,
  InvocationContext,
  ParticipantConnector,
  ParticipantPort,
  ResolvedParticipant,
} from "./port.js";

const defaultCapabilities: readonly Capability[] = ["text_generation", "cancellation"];

export class ParticipantRegistry {
  private readonly connectors = new Map<string, ParticipantConnector>();

  constructor(readonly config: SwitchConfig) {}

  register(connector: ParticipantConnector, aliases: readonly string[] = []): this {
    this.connectors.set(connector.manifest.id, connector);
    aliases.forEach((alias) => this.connectors.set(alias, connector));
    return this;
  }

  connector(id: string): ParticipantConnector {
    const connector = this.connectors.get(id);
    if (!connector) {
      throw new SwitchError({
        code: "configuration_error",
        message: `No connector implementation is registered for ${id}.`,
        retry: "non_retryable",
      });
    }
    return connector;
  }

  resolve(id: string): ParticipantPort {
    const participant = this.config.participants[id];
    if (!participant?.enabled) {
      throw new SwitchError({
        code: "configuration_error",
        message: `Participant ${id} is missing or disabled.`,
        retry: "non_retryable",
      });
    }
    const connectorConfig = this.config.connectors[participant.connector];
    if (!connectorConfig?.enabled) {
      throw new SwitchError({
        code: "connector_unavailable",
        message: `Connector ${participant.connector} is missing or disabled.`,
        retry: "non_retryable",
      });
    }
    if (
      connectorConfig.billingType === "prepaid_subscription" &&
      (this.config.policy.deployment === "hosted" || !this.config.policy.allowPersonalSubscriptions)
    ) {
      throw new SwitchError({
        code: "policy_denied",
        message: `Personal subscription connector ${participant.connector} is denied by policy.`,
        retry: "non_retryable",
      });
    }
    const connector = this.connector(participant.connector);
    const snapshot: ParticipantSnapshot = {
      id,
      kind: participant.kind,
      connectorId: connector.manifest.id,
      connectorVersion: connector.manifest.version,
      ...(participant.model ? { model: participant.model } : {}),
      displayName: participant.displayName,
      ...(participant.role ? { role: participant.role } : {}),
      ...(participant.mandate ? { mandate: participant.mandate } : {}),
      capabilities: connector.manifest.capabilities.length
        ? connector.manifest.capabilities
        : [...defaultCapabilities],
      expertise: participant.expertise,
      billingType: connectorConfig.billingType,
      privacyClass: connector.manifest.transport === "embedded" ? "local" : "external",
      configHash: hashObject({ participant, connector: connectorConfig }),
    };
    const resolved: ResolvedParticipant = {
      id,
      participant,
      connector: connectorConfig,
      snapshot,
    };
    return {
      id,
      snapshot,
      invoke: (request, context) => connector.invoke(resolved, request, context),
      health: (context) => connector.health(connectorConfig, context),
    };
  }

  resolveMany(ids: readonly string[]): readonly ParticipantPort[] {
    return ids.map((id) => this.resolve(id));
  }

  snapshots(ids: readonly string[]): readonly ParticipantSnapshot[] {
    return this.resolveMany(ids).map((participant) => participant.snapshot);
  }

  eligible(ids?: readonly string[]): readonly ParticipantPort[] {
    const selected =
      ids ??
      Object.entries(this.config.participants)
        .filter(([, participant]) => participant.enabled)
        .map(([id]) => id);
    return selected.flatMap((id) => {
      try {
        return [this.resolve(id)];
      } catch {
        return [];
      }
    });
  }

  async doctor(
    context: Pick<InvocationContext, "cwd" | "environment">,
  ): Promise<Readonly<Record<string, ConnectorHealth>>> {
    const entries = await Promise.all(
      Object.entries(this.config.connectors)
        .filter(([, connector]) => connector.enabled)
        .map(async ([id, connectorConfig]) => {
          try {
            const health = await this.connector(id).health(connectorConfig, context);
            return [id, health] as const;
          } catch (error) {
            return [
              id,
              {
                status: "unavailable",
                checkedAt: new Date().toISOString(),
                message: error instanceof Error ? error.message : String(error),
              } satisfies ConnectorHealth,
            ] as const;
          }
        }),
    );
    return Object.fromEntries(entries);
  }
}
