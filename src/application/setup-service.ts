import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { SwitchConfig } from "../schema/config.js";
import type { ParticipantRegistry } from "../connectors/registry.js";
import type { ConnectorHealth } from "../connectors/port.js";
import { runInteractiveProcess, runProcess } from "../connectors/process-runner.js";
import { saveConfig } from "../config/load.js";
import { getSwitchPaths } from "../config/paths.js";

export interface ProviderSetupInfo {
  readonly id: string;
  readonly label: string;
  readonly kind: "process" | "http";
  readonly description: string;
  readonly defaultCommand?: string;
  readonly loginHint: string;
  readonly loginCommand?: readonly string[];
  readonly accessCheckCommand?: readonly string[];
  readonly envKey?: string;
}

export const SETUP_PROVIDERS: readonly ProviderSetupInfo[] = [
  {
    id: "codex",
    label: "Codex",
    kind: "process",
    description: "OpenAI Codex subscription CLI",
    defaultCommand: "codex",
    loginHint: "Run `switch connect codex --login`, then re-check access.",
    loginCommand: ["codex", "login"],
    accessCheckCommand: ["codex", "login", "status"],
  },
  {
    id: "antigravity",
    label: "Antigravity / Gemini CLI",
    kind: "process",
    description: "Google Antigravity (agy) Gemini CLI",
    defaultCommand: "agy",
    loginHint: "Run `agy` once and complete its official sign-in flow, then re-check access.",
    accessCheckCommand: ["agy", "models"],
  },
  {
    id: "grok",
    label: "Grok Build",
    kind: "process",
    description: "xAI Grok Build CLI",
    defaultCommand: "grok",
    loginHint: "Run `switch connect grok --login`, then re-check access.",
    loginCommand: ["grok", "login"],
    accessCheckCommand: ["grok", "models"],
  },
  {
    id: "opencode",
    label: "OpenCode",
    kind: "process",
    description: "OpenCode free-model and OpenRouter free routes",
    defaultCommand: "opencode",
    loginHint: "Run `switch connect opencode --login`, then re-check access.",
    loginCommand: ["opencode", "providers", "login"],
    accessCheckCommand: ["opencode", "providers", "list"],
  },
  {
    id: "openrouter",
    label: "OpenRouter (HTTP)",
    kind: "http",
    description: "Direct OpenRouter API with OPENROUTER_API_KEY",
    loginHint:
      "Export OPENROUTER_API_KEY in your environment (Switch stores only the env var name).",
    envKey: "OPENROUTER_API_KEY",
  },
];

export interface ProviderStatus {
  readonly provider: ProviderSetupInfo;
  readonly enabled: boolean;
  readonly binaryFound: boolean;
  readonly binaryPath?: string;
  readonly health?: ConnectorHealth;
  readonly envPresent?: boolean;
  readonly access: "available" | "unauthenticated" | "unavailable" | "not_checked";
  readonly remediation: string;
}

function findOnPath(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (command.includes("/") || command.includes("\\")) {
    try {
      accessSync(command, constants.X_OK);
      return command;
    } catch {
      return undefined;
    }
  }
  const pathVar = environment["PATH"] ?? "";
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  // macOS ChatGPT-bundled Codex
  if (command === "codex") {
    const bundled = "/Applications/ChatGPT.app/Contents/Resources/codex";
    try {
      accessSync(bundled, constants.X_OK);
      return bundled;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export class SetupService {
  constructor(
    private readonly config: SwitchConfig,
    private readonly registry: ParticipantRegistry,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  listProviders(): readonly ProviderSetupInfo[] {
    return SETUP_PROVIDERS;
  }

  async status(cwd = process.cwd()): Promise<readonly ProviderStatus[]> {
    const results: ProviderStatus[] = [];
    for (const provider of SETUP_PROVIDERS) {
      results.push(await this.providerStatus(provider, cwd));
    }
    return results;
  }

  async providerStatus(provider: ProviderSetupInfo, cwd = process.cwd()): Promise<ProviderStatus> {
    const connector = this.config.connectors[provider.id];
    const enabled = Boolean(connector?.enabled);
    if (provider.kind === "http") {
      const envPresent = Boolean(provider.envKey && this.environment[provider.envKey]);
      let health: ConnectorHealth | undefined;
      try {
        health = await this.registry.connector(provider.id).health(
          connector ?? {
            kind: "http",
            enabled: true,
            environmentAllowlist: [],
            secrets: provider.envKey
              ? { apiKey: { source: "environment", key: provider.envKey } }
              : {},
            billingType: "free_tier",
            config: {},
            baseUrl: "https://openrouter.ai/api/v1",
          },
          { cwd, environment: this.environment },
        );
      } catch (error) {
        health = {
          status: "unavailable",
          checkedAt: new Date().toISOString(),
          message: error instanceof Error ? error.message : String(error),
        };
      }
      return {
        provider,
        enabled,
        binaryFound: true,
        health,
        envPresent,
        access: !envPresent
          ? "unauthenticated"
          : health.status === "healthy"
            ? "available"
            : "unavailable",
        remediation: envPresent
          ? health.status === "healthy"
            ? enabled
              ? "Ready. Switch can invoke this provider."
              : "Authenticated, but disabled in Switch. Press Enter to enable it."
            : provider.loginHint
          : `Set ${provider.envKey} then re-run doctor/setup.`,
      };
    }

    const command = connector?.command?.[0] ?? provider.defaultCommand ?? provider.id;
    const binaryPath = findOnPath(command, this.environment);
    let health: ConnectorHealth | undefined;
    if (binaryPath && connector) {
      try {
        health = await this.registry.connector(provider.id).health(connector, {
          cwd,
          environment: this.environment,
        });
      } catch (error) {
        health = {
          status: "unavailable",
          checkedAt: new Date().toISOString(),
          message: error instanceof Error ? error.message : String(error),
        };
      }
    } else if (!binaryPath) {
      health = {
        status: "unavailable",
        checkedAt: new Date().toISOString(),
        message: `Executable not found: ${command}`,
      };
    }

    let access: ProviderStatus["access"] = binaryPath ? "not_checked" : "unavailable";
    if (binaryPath && connector && provider.accessCheckCommand) {
      const [configuredProbeCommand = command, ...probeArgs] = provider.accessCheckCommand;
      const probeCommand =
        configuredProbeCommand === provider.defaultCommand ? binaryPath : configuredProbeCommand;
      try {
        await runProcess(probeCommand, probeArgs, {
          cwd,
          timeoutMs: 20_000,
          environmentAllowlist: connector.environmentAllowlist,
          environment: this.environment,
          maxOutputBytes: 128 * 1024,
        });
        access = "available";
        health = {
          ...(health ?? { checkedAt: new Date().toISOString() }),
          status: "healthy",
          message: `${provider.label} is installed and its access probe passed.`,
        };
      } catch (error) {
        access = "unauthenticated";
        health = {
          ...(health ?? { checkedAt: new Date().toISOString() }),
          status: "unauthenticated",
          message: `${provider.label} is installed but not authenticated or not accessible: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    return {
      provider,
      enabled,
      binaryFound: Boolean(binaryPath),
      ...(binaryPath ? { binaryPath } : {}),
      ...(health ? { health } : {}),
      access,
      remediation: !binaryPath
        ? `Install ${provider.label} and ensure \`${command}\` is on PATH.`
        : access === "available"
          ? enabled
            ? "Ready. Switch can invoke this provider."
            : "Authenticated, but disabled in Switch. Press Enter to enable it."
          : provider.loginHint,
    };
  }

  /**
   * Spawn the official login command with a full inherited environment (TTY).
   * Switch never captures tokens — the external CLI owns credentials.
   */
  async runOfficialLogin(providerId: string): Promise<{ ok: boolean; message: string }> {
    const provider = SETUP_PROVIDERS.find((item) => item.id === providerId);
    if (!provider?.loginCommand?.length) {
      return {
        ok: false,
        message: provider
          ? `${provider.label} has no automated login command. ${provider.loginHint}`
          : `Unknown provider ${providerId}`,
      };
    }
    const [command, ...args] = provider.loginCommand;
    if (!command) return { ok: false, message: "Empty login command" };
    try {
      // Intentionally not using process allowlist — login needs user credentials env/TTY.
      const code = await runInteractiveProcess(command, args, {
        cwd: process.cwd(),
        timeoutMs: 300_000,
        environment: this.environment,
      });
      return {
        ok: code === 0,
        message:
          code === 0
            ? `${provider.label} login completed. Re-run setup/doctor to verify access.`
            : `${provider.label} login exited ${code}. Re-run setup for diagnostics.`,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  enableProvider(providerId: string, commandPath?: string): SwitchConfig {
    const next: SwitchConfig = structuredClone(this.config);
    const connector = next.connectors[providerId];
    if (!connector) {
      if (providerId === "openrouter") {
        next.connectors["openrouter"] = {
          kind: "http",
          enabled: true,
          baseUrl: "https://openrouter.ai/api/v1",
          environmentAllowlist: [],
          secrets: { apiKey: { source: "environment", key: "OPENROUTER_API_KEY" } },
          billingType: "free_tier",
          config: { enforceModelSuffix: ":free" },
        };
      } else {
        throw new Error(`Unknown connector ${providerId}`);
      }
    } else {
      next.connectors[providerId] = {
        ...connector,
        enabled: true,
        ...(commandPath ? { command: [commandPath] } : {}),
      };
    }
    // Enable participants that use this connector
    for (const [id, participant] of Object.entries(next.participants)) {
      if (
        participant.connector === providerId ||
        (providerId === "antigravity" && participant.connector === "antigravity")
      ) {
        next.participants[id] = { ...participant, enabled: true };
      }
    }
    return next;
  }

  disableProvider(providerId: string): SwitchConfig {
    const next: SwitchConfig = structuredClone(this.config);
    const connector = next.connectors[providerId];
    if (connector) {
      next.connectors[providerId] = { ...connector, enabled: false };
    }
    for (const [id, participant] of Object.entries(next.participants)) {
      if (participant.connector === providerId) {
        next.participants[id] = { ...participant, enabled: false };
      }
    }
    return next;
  }

  persist(config: SwitchConfig): string {
    const path = getSwitchPaths(this.environment).config;
    return saveConfig(config, path);
  }
}
