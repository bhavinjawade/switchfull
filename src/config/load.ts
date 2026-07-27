import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { SwitchConfigSchema, type SwitchConfig } from "../schema/config.js";
import { compileValidator } from "../schema/validator.js";
import { defaultConfig } from "./defaults.js";
import { migrateConfig, type MigrationResult } from "./migrate.js";
import { getSwitchPaths } from "./paths.js";

const validateConfigSchema = compileValidator(SwitchConfigSchema);

function assertConfigSemantics(config: SwitchConfig): SwitchConfig {
  const errors: string[] = [];
  if (!config.profiles[config.defaults.profile]) {
    errors.push(`Default profile ${config.defaults.profile} does not exist.`);
  }
  for (const [participantId, participant] of Object.entries(config.participants)) {
    if (!config.connectors[participant.connector]) {
      errors.push(
        `Participant ${participantId} references unknown connector ${participant.connector}.`,
      );
    }
  }
  for (const [profileId, profile] of Object.entries(config.profiles)) {
    if (profile.participants.length === 0) {
      errors.push(`Profile ${profileId} requires at least one participant.`);
    }
    for (const participantId of profile.participants) {
      if (!config.participants[participantId]) {
        errors.push(`Profile ${profileId} references unknown participant ${participantId}.`);
      }
    }
    if (profile.synthesizer && !profile.participants.includes(profile.synthesizer)) {
      errors.push(
        `Profile ${profileId} synthesizer ${profile.synthesizer} is not a profile participant.`,
      );
    }
    if (profile.router && !profile.participants.includes(profile.router)) {
      errors.push(`Profile ${profileId} router ${profile.router} is not a profile participant.`);
    }
    if (profile.budget.maxCost !== undefined && !profile.budget.currency) {
      errors.push(`Profile ${profileId} defines maxCost without a currency.`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Configuration references are invalid: ${errors.join(" ")}`);
  }
  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeValue(base: unknown, override: unknown): unknown {
  if (override === undefined) return structuredClone(base);
  if (isRecord(base) && isRecord(override)) {
    const result: Record<string, unknown> = structuredClone(base);
    for (const [key, value] of Object.entries(override)) {
      result[key] = mergeValue(result[key], value);
    }
    return result;
  }
  return structuredClone(override);
}

export function mergeConfigs(
  ...layers: readonly (Partial<SwitchConfig> | undefined)[]
): SwitchConfig {
  let merged: unknown = structuredClone(defaultConfig);
  for (const layer of layers) {
    if (layer) merged = mergeValue(merged, layer);
  }
  return assertConfigSemantics(validateConfigSchema(merged));
}

export function parseConfig(text: string, extension = ".json"): unknown {
  return extension === ".yaml" || extension === ".yml" ? parseYaml(text) : JSON.parse(text);
}

function readLayer(path: string): MigrationResult | undefined {
  if (!existsSync(path)) return undefined;
  const extension = path.endsWith(".yaml") ? ".yaml" : path.endsWith(".yml") ? ".yml" : ".json";
  return migrateConfig(parseConfig(readFileSync(path, "utf8"), extension));
}

export interface LoadedConfig {
  readonly config: SwitchConfig;
  readonly paths: readonly string[];
  readonly warnings: readonly string[];
}

export function loadConfig(
  options: {
    readonly cwd?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly requestOverrides?: Partial<SwitchConfig>;
  } = {},
): LoadedConfig {
  const cwd = options.cwd ?? process.cwd();
  const paths = getSwitchPaths(options.environment);
  const candidates = [
    paths.config,
    join(cwd, ".switch", "config.json"),
    join(cwd, ".switch", "config.yaml"),
  ];
  const layers: Partial<SwitchConfig>[] = [];
  const loadedPaths: string[] = [];
  const warnings: string[] = [];
  for (const candidate of candidates) {
    const layer = readLayer(candidate);
    if (!layer) continue;
    layers.push(layer.config);
    loadedPaths.push(candidate);
    warnings.push(...layer.warnings);
  }
  if (options.requestOverrides) layers.push(options.requestOverrides);
  return {
    config: mergeConfigs(...layers),
    paths: loadedPaths,
    warnings,
  };
}

export function validateConfig(value: unknown): SwitchConfig {
  const migration = migrateConfig(value);
  return assertConfigSemantics(validateConfigSchema(migration.config));
}

export function saveConfig(config: SwitchConfig, path = getSwitchPaths().config): string {
  const valid = assertConfigSemantics(validateConfigSchema(config));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    copyFileSync(path, `${path}.bak-${timestamp}`);
  }
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(valid, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return path;
}
