import { SwitchError } from "../domain/errors.js";
import { builtInProtocols } from "./builtins.js";
import type { ProtocolDefinition, ProtocolMetadata } from "./types.js";

export class ProtocolRegistry {
  private readonly protocols = new Map<string, ProtocolDefinition>();

  constructor(protocols: readonly ProtocolDefinition[] = builtInProtocols) {
    protocols.forEach((protocol) => this.register(protocol));
  }

  register(protocol: ProtocolDefinition): this {
    if (this.protocols.has(protocol.metadata.id)) {
      throw new SwitchError({
        code: "protocol_error",
        message: `Protocol ${protocol.metadata.id} is already registered.`,
        retry: "non_retryable",
      });
    }
    this.protocols.set(protocol.metadata.id, protocol);
    return this;
  }

  get(id: string): ProtocolDefinition {
    const protocol = this.protocols.get(id);
    if (!protocol) {
      throw new SwitchError({
        code: "protocol_error",
        message: `Unknown protocol ${id}.`,
        retry: "non_retryable",
        details: { available: [...this.protocols.keys()] },
      });
    }
    return protocol;
  }

  list(): readonly ProtocolMetadata[] {
    return [...this.protocols.values()].map((protocol) => protocol.metadata);
  }
}
