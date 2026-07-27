import type { SwitchConfig } from "../schema/config.js";
import { defaultConfig } from "./defaults.js";

interface LegacySeat {
  id?: unknown;
  enabled?: unknown;
  adapter?: unknown;
  model?: unknown;
  role?: unknown;
  mandate?: unknown;
  costPolicy?: unknown;
}

interface LegacyProfile {
  label?: unknown;
  description?: unknown;
  seats?: unknown;
  critiqueRounds?: unknown;
  synthesizer?: unknown;
}

interface LegacyConfig {
  version?: unknown;
  defaults?: Record<string, unknown>;
  commands?: Record<string, unknown>;
  seats?: LegacySeat[];
  profiles?: Record<string, LegacyProfile>;
}

export interface MigrationResult {
  readonly config: SwitchConfig;
  readonly migrated: boolean;
  readonly warnings: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function migrateConfig(value: unknown): MigrationResult {
  if (isRecord(value) && value["apiVersion"] === "switch.dev/config/v2") {
    return { config: value as SwitchConfig, migrated: false, warnings: [] };
  }

  if (!isRecord(value) || !Array.isArray((value as LegacyConfig).seats)) {
    throw new Error("Configuration is neither Switch v2 nor a recognized legacy v1 config.");
  }

  const legacy = value as LegacyConfig;
  const config = structuredClone(defaultConfig);
  const warnings: string[] = [];

  if (isRecord(legacy.commands)) {
    for (const [legacyName, command] of Object.entries(legacy.commands)) {
      const connectorName = legacyName === "agy" ? "antigravity" : legacyName;
      const connector = config.connectors[connectorName];
      if (connector && typeof command === "string") {
        connector.command = [command];
        if (command.startsWith("/")) {
          warnings.push(
            `Connector ${connectorName} used an absolute command path; preserve it only as a local override.`,
          );
        }
      }
    }
  }

  config.participants = {};
  for (const seat of legacy.seats ?? []) {
    if (typeof seat.id !== "string") continue;
    const legacyAdapter = typeof seat.adapter === "string" ? seat.adapter : "";
    const connector = legacyAdapter === "agy" ? "antigravity" : legacyAdapter;
    config.participants[seat.id] = {
      enabled: seat.enabled !== false,
      kind: "agent",
      connector,
      ...(typeof seat.model === "string" ? { model: seat.model } : {}),
      displayName: typeof seat.role === "string" ? seat.role : seat.id,
      ...(typeof seat.role === "string" ? { role: seat.role } : {}),
      ...(typeof seat.mandate === "string" ? { mandate: seat.mandate } : {}),
      expertise: [],
      tags: [],
      ...(seat.costPolicy === "free-only" ? { costPolicy: "free-only" as const } : {}),
      config: {},
    };
  }

  config.profiles = {};
  for (const [id, profile] of Object.entries(legacy.profiles ?? {})) {
    const participantIds =
      profile.seats === "*"
        ? Object.keys(config.participants)
        : Array.isArray(profile.seats)
          ? profile.seats.filter((item): item is string => typeof item === "string")
          : [];
    config.profiles[id] = {
      label: typeof profile.label === "string" ? profile.label : id,
      description: typeof profile.description === "string" ? profile.description : "",
      mode: "council",
      protocol: "independent-critique-synthesis",
      participants: participantIds,
      ...(typeof profile.synthesizer === "string" ? { synthesizer: profile.synthesizer } : {}),
      critiqueRounds: typeof profile.critiqueRounds === "number" ? profile.critiqueRounds : 0,
      budget: {
        maxCalls: 20,
        maxRouterCalls: 0,
        maxWallTimeMs: 900_000,
        maxConcurrency: 4,
        maxRounds: typeof profile.critiqueRounds === "number" ? profile.critiqueRounds : 0,
        maxGraphNodes: 32,
        maxNestedDepth: 1,
      },
      config: {},
    };
  }

  const profile =
    typeof legacy.defaults?.["profile"] === "string"
      ? legacy.defaults["profile"]
      : Object.keys(config.profiles)[0];
  if (profile) config.defaults.profile = profile;
  if (typeof legacy.defaults?.["timeoutMs"] === "number") {
    config.defaults.timeoutMs = legacy.defaults["timeoutMs"];
  }
  if (typeof legacy.defaults?.["maxConcurrency"] === "number") {
    config.defaults.maxConcurrency = legacy.defaults["maxConcurrency"];
  }

  return {
    config,
    migrated: true,
    warnings,
  };
}
