import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { asSwitchError, SwitchError } from "../domain/errors.js";
import { runProcess, type ProcessResult, type ProcessRunOptions } from "./process-runner.js";

type ProcessConnectorId = "codex" | "antigravity" | "grok" | "opencode";

function cleanOutput(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "").trim();
}

function renderMessages(request: ParticipantRequest): string {
  return request.messages
    .map(
      (message) =>
        `<${message.role.toUpperCase()}>\n${message.content}\n</${message.role.toUpperCase()}>`,
    )
    .join("\n\n");
}

function isFreeModel(model: string): boolean {
  return model.endsWith(":free") || model.endsWith("-free") || model.includes("/free/");
}

function commandFor(config: ConnectorConfig, fallback: string): readonly string[] {
  return config.command?.length ? config.command : [fallback];
}

async function runProviderProcess(
  providerName: string,
  command: string,
  args: readonly string[],
  options: ProcessRunOptions,
): Promise<ProcessResult> {
  try {
    return await runProcess(command, args, options);
  } catch (error) {
    const normalized = asSwitchError(error);
    if (normalized.code !== "provider_error") throw normalized;
    const stderr =
      typeof normalized.details["stderr"] === "string" ? normalized.details["stderr"] : "";
    const diagnostic = `${normalized.message}\n${stderr}`;
    const exitCode =
      typeof normalized.details["code"] === "number" ? normalized.details["code"] : undefined;
    if (
      /usage limit|quota(?: is)? exhausted|quota exceeded|insufficient[_ ]quota|purchase more credits|credit balance/iu.test(
        diagnostic,
      )
    ) {
      throw new SwitchError({
        code: "quota_exhausted",
        message: `${providerName} quota is exhausted.`,
        retry: "non_retryable",
        cause: error,
        details: { providerName, ...(exitCode !== undefined ? { exitCode } : {}) },
      });
    }
    if (/rate limit|too many requests|\b429\b/iu.test(diagnostic)) {
      throw new SwitchError({
        code: "rate_limited",
        message: `${providerName} is rate limited.`,
        retry: "retryable",
        cause: error,
        details: { providerName, ...(exitCode !== undefined ? { exitCode } : {}) },
      });
    }
    if (
      /not authenticated|authentication required|not logged in|please log in|login required|unauthorized|invalid api key|\b401\b/iu.test(
        diagnostic,
      )
    ) {
      throw new SwitchError({
        code: "authentication_error",
        message: `${providerName} is not authenticated.`,
        retry: "non_retryable",
        cause: error,
        details: { providerName, ...(exitCode !== undefined ? { exitCode } : {}) },
      });
    }
    throw normalized;
  }
}

function result(
  request: ParticipantRequest,
  participant: ResolvedParticipant,
  text: string,
  metadata: Readonly<Record<string, unknown>>,
): ParticipantResult {
  return {
    requestId: request.requestId,
    text,
    ...(participant.participant.model ? { model: participant.participant.model } : {}),
    usage: { source: "unavailable" },
    metadata,
  };
}

function manifest(id: ProcessConnectorId): ConnectorManifest {
  const names: Record<ProcessConnectorId, string> = {
    codex: "OpenAI Codex subscription CLI",
    antigravity: "Google Antigravity CLI",
    grok: "Grok Build CLI",
    opencode: "OpenCode CLI",
  };
  return {
    apiVersion: "switch.dev/connector/v1alpha1",
    id,
    name: names[id],
    version: "1.0.0",
    kind: "agent",
    stability: id === "codex" ? "built-in-stable" : "first-party-beta",
    transport: "process",
    authOwner: "external_cli",
    billingType: id === "opencode" ? "free_tier" : "prepaid_subscription",
    capabilities: [
      "text_generation",
      "file_context",
      "workspace",
      "reasoning_controls",
      "cancellation",
    ],
    command: [id === "antigravity" ? "agy" : id],
    environmentAllowlist: ["PATH", "HOME", "LANG", "LC_ALL", "TERM"],
    supportedPlatforms: ["darwin", "linux", "win32"],
  };
}

export class SubscriptionProcessConnector implements ParticipantConnector {
  readonly manifest: ConnectorManifest;

  constructor(readonly id: ProcessConnectorId) {
    this.manifest = manifest(id);
  }

  async invoke(
    participant: ResolvedParticipant,
    request: ParticipantRequest,
    context: InvocationContext,
  ): Promise<ParticipantResult> {
    const model = participant.participant.model;
    if (!model) throw new Error(`Participant ${participant.id} has no model.`);
    const [command = this.id, ...commandPrefix] = commandFor(
      participant.connector,
      this.id === "antigravity" ? "agy" : this.id,
    );
    const prompt = renderMessages(request);
    const common = {
      cwd: context.cwd,
      timeoutMs: context.timeoutMs,
      environmentAllowlist: participant.connector.environmentAllowlist,
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.environment ? { environment: context.environment } : {}),
    };

    if (this.id === "codex") {
      const directory = mkdtempSync(join(tmpdir(), "switch-codex-"));
      const outputPath = join(directory, "answer.txt");
      try {
        const processResult = await runProviderProcess(
          this.manifest.name,
          command,
          [
            ...commandPrefix,
            "exec",
            "--model",
            model,
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "--ephemeral",
            "--color",
            "never",
            "--cd",
            context.cwd,
            "--output-last-message",
            outputPath,
            "-",
          ],
          { ...common, input: prompt },
        );
        return result(request, participant, cleanOutput(readFileSync(outputPath, "utf8")), {
          durationMs: processResult.durationMs,
          connector: this.id,
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }

    let args: readonly string[];
    if (this.id === "antigravity") {
      const modelIncludesEffort = /-(low|medium|high)$/i.test(model);
      args = [
        ...commandPrefix,
        "--print",
        prompt,
        "--model",
        model,
        ...(modelIncludesEffort ? [] : ["--effort", context.thinking ?? "high"]),
        "--mode",
        "plan",
        "--sandbox",
        "--print-timeout",
        `${Math.ceil(context.timeoutMs / 1_000)}s`,
      ];
    } else if (this.id === "grok") {
      args = [
        ...commandPrefix,
        "--single",
        prompt,
        "--model",
        model,
        "--output-format",
        "plain",
        "--permission-mode",
        "plan",
        "--no-subagents",
        "--no-memory",
        "--disable-web-search",
        "--cwd",
        context.cwd,
        "--reasoning-effort",
        context.thinking ?? "high",
      ];
    } else {
      if (participant.participant.costPolicy !== "free-only" || !isFreeModel(model)) {
        throw new Error(`Refusing non-free OpenCode model: ${model}`);
      }
      args = [
        ...commandPrefix,
        "run",
        "--pure",
        "--model",
        model,
        "--agent",
        "plan",
        "--dir",
        context.cwd,
        prompt,
      ];
    }
    const processResult = await runProviderProcess(this.manifest.name, command, args, common);
    const text = cleanOutput(processResult.stdout);
    if (!text) {
      const diagnostic = cleanOutput(processResult.stderr);
      throw new SwitchError({
        code: "provider_error",
        message: diagnostic
          ? `${this.manifest.name} returned no answer: ${diagnostic}`
          : `${this.manifest.name} returned an empty response.`,
        retry: "unknown",
      });
    }
    return result(request, participant, text, {
      durationMs: processResult.durationMs,
      connector: this.id,
    });
  }

  async health(
    connector: ConnectorConfig,
    context: Pick<InvocationContext, "cwd" | "environment">,
  ): Promise<ConnectorHealth> {
    const [command = this.id, ...prefix] = commandFor(
      connector,
      this.id === "antigravity" ? "agy" : this.id,
    );
    const startedAt = performance.now();
    try {
      const processResult = await runProcess(command, [...prefix, "--version"], {
        cwd: context.cwd,
        timeoutMs: 10_000,
        environmentAllowlist: connector.environmentAllowlist,
        ...(context.environment ? { environment: context.environment } : {}),
        maxOutputBytes: 64 * 1024,
      });
      const version = cleanOutput(processResult.stdout || processResult.stderr).split("\n")[0];
      return {
        status: "healthy",
        checkedAt: new Date().toISOString(),
        message: `${this.manifest.name} is available.`,
        ...(version ? { version } : {}),
        latencyMs: performance.now() - startedAt,
      };
    } catch (error) {
      return {
        status: "unavailable",
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
        latencyMs: performance.now() - startedAt,
      };
    }
  }
}

export function builtInProcessConnectors(): readonly SubscriptionProcessConnector[] {
  return [
    new SubscriptionProcessConnector("codex"),
    new SubscriptionProcessConnector("antigravity"),
    new SubscriptionProcessConnector("grok"),
    new SubscriptionProcessConnector("opencode"),
  ];
}
