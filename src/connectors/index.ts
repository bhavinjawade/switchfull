import type { SwitchConfig } from "../schema/config.js";
import { OpenAiCompatibleConnector } from "./openai-compatible.js";
import { builtInProcessConnectors } from "./process-connectors.js";
import { ParticipantRegistry } from "./registry.js";

export * from "./fake.js";
export * from "./openai-compatible.js";
export * from "./port.js";
export * from "./process-connectors.js";
export * from "./process-runner.js";
export * from "./registry.js";

export function createDefaultRegistry(config: SwitchConfig): ParticipantRegistry {
  const registry = new ParticipantRegistry(config);
  for (const connector of builtInProcessConnectors()) {
    registry.register(connector, connector.id === "antigravity" ? ["agy"] : []);
  }
  const compatible = new OpenAiCompatibleConnector();
  registry.register(compatible, ["openrouter", "openai", "local-openai"]);
  return registry;
}
