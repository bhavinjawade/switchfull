import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type { ParticipantConnector } from "../connectors/port.js";
import type {
  ConnectorHealth,
  InvocationContext,
  ResolvedParticipant,
} from "../connectors/port.js";
import { runProcess } from "../connectors/process-runner.js";
import { SwitchError } from "../domain/errors.js";
import type { ConnectorConfig } from "../schema/config.js";
import {
  ParticipantResultSchema,
  type ParticipantRequest,
  type ParticipantResult,
} from "../schema/participant.js";
import { compileValidator } from "../schema/validator.js";
import type { PluginManifest } from "./schema.js";

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly result?: ParticipantResult;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

const validateParticipantResult = compileValidator(ParticipantResultSchema);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseResponse(value: unknown): JsonRpcResponse {
  if (!isRecord(value) || value["jsonrpc"] !== "2.0" || typeof value["id"] !== "string") {
    throw new Error("Plugin returned an invalid JSON-RPC envelope.");
  }
  const result =
    value["result"] === undefined ? undefined : validateParticipantResult(value["result"]);
  let error: JsonRpcResponse["error"];
  if (value["error"] !== undefined) {
    if (
      !isRecord(value["error"]) ||
      typeof value["error"]["code"] !== "number" ||
      typeof value["error"]["message"] !== "string"
    ) {
      throw new Error("Plugin returned an invalid JSON-RPC error.");
    }
    error = {
      code: value["error"]["code"],
      message: value["error"]["message"],
      ...(value["error"]["data"] !== undefined ? { data: value["error"]["data"] } : {}),
    };
  }
  return {
    jsonrpc: "2.0",
    id: value["id"],
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
  };
}

function safeCommand(root: string, command: readonly string[]): readonly string[] {
  const executable = command[0];
  if (!executable) throw new Error("Plugin command is empty.");
  if (!executable.includes("/") && !executable.includes("\\")) return command;
  const resolved = isAbsolute(executable) ? executable : resolve(root, executable);
  const traversal = relative(root, resolved);
  if (!isAbsolute(executable) && (traversal.startsWith("..") || isAbsolute(traversal))) {
    throw new SwitchError({
      code: "plugin_error",
      message: "Plugin executable escapes its package directory.",
      retry: "non_retryable",
    });
  }
  return [resolved, ...command.slice(1)];
}

export class JsonRpcPluginConnector implements ParticipantConnector {
  readonly manifest;
  private readonly command: readonly string[];

  constructor(
    private readonly plugin: PluginManifest,
    private readonly root: string,
  ) {
    if (!plugin.connector || !plugin.command) {
      throw new Error(`Participant plugin ${plugin.id} requires connector and command.`);
    }
    this.manifest = plugin.connector;
    this.command = safeCommand(root, plugin.command);
  }

  async invoke(
    participant: ResolvedParticipant,
    request: ParticipantRequest,
    context: InvocationContext,
  ): Promise<ParticipantResult> {
    const id = randomUUID();
    const [command, ...args] = this.command;
    if (!command) throw new Error("Plugin command is empty.");
    const frame = {
      jsonrpc: "2.0",
      id,
      method: "participant.invoke",
      params: {
        apiVersion: "switch.dev/plugin-abi/v1alpha1",
        participant: {
          id: participant.id,
          snapshot: participant.snapshot,
          config: participant.participant.config,
        },
        request,
      },
    };
    const processResult = await runProcess(command, args, {
      cwd: this.root,
      input: `${JSON.stringify(frame)}\n`,
      timeoutMs: context.timeoutMs,
      ...(context.signal ? { signal: context.signal } : {}),
      environmentAllowlist: [
        ...new Set([
          ...this.plugin.permissions.environment,
          ...participant.connector.environmentAllowlist,
        ]),
      ],
      ...(context.environment ? { environment: context.environment } : {}),
      maxOutputBytes: 10 * 1024 * 1024,
    });
    const line = processResult.stdout
      .trim()
      .split("\n")
      .findLast((candidate) => candidate.trim().startsWith("{"));
    if (!line) {
      throw new SwitchError({
        code: "plugin_error",
        message: `Plugin ${this.plugin.id} returned no JSON-RPC response.`,
        retry: "unknown",
      });
    }
    const response = parseResponse(JSON.parse(line) as unknown);
    if (response.id !== id) {
      throw new SwitchError({
        code: "plugin_error",
        message: `Plugin ${this.plugin.id} returned a mismatched JSON-RPC response.`,
        retry: "non_retryable",
      });
    }
    if (response.error) {
      throw new SwitchError({
        code: "plugin_error",
        message: response.error.message,
        retry: "unknown",
        details: { pluginCode: response.error.code, data: response.error.data },
      });
    }
    if (!response.result) {
      throw new SwitchError({
        code: "plugin_error",
        message: `Plugin ${this.plugin.id} returned neither result nor error.`,
        retry: "non_retryable",
      });
    }
    return response.result;
  }

  async health(
    _connector: ConnectorConfig,
    _context: Pick<InvocationContext, "cwd" | "environment">,
  ): Promise<ConnectorHealth> {
    return {
      status: "healthy",
      checkedAt: new Date().toISOString(),
      message: `Plugin ${this.plugin.name} manifest loaded; invocation uses a Tier 0 separate process.`,
      version: this.plugin.version,
    };
  }
}
