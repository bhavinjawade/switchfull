import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { SwitchRuntime } from "../application/runtime.js";
import type { RouterSessionId } from "../domain/ids.js";
import { RoutedRunOrchestrator } from "../routing/orchestrator.js";
import type { RunProgress } from "../runtime/executor.js";

interface RpcCommand {
  readonly id?: string | number;
  readonly type: string;
  readonly [key: string]: unknown;
}

interface RpcMessage {
  readonly role: string;
  readonly content: unknown;
  readonly timestamp: number;
  readonly [key: string]: unknown;
}

type RuntimeConfig = SwitchRuntime["loadedConfig"]["config"];
type CouncilProfile = RuntimeConfig["profiles"][string];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseCommand(line: string): RpcCommand {
  const parsed = JSON.parse(line) as unknown;
  if (!isRecord(parsed) || typeof parsed["type"] !== "string") {
    throw new Error("RPC command must be an object with a string type.");
  }
  const id = parsed["id"];
  if (id !== undefined && typeof id !== "string" && typeof id !== "number") {
    throw new Error("RPC command id must be a string or number.");
  }
  return parsed as RpcCommand;
}

function commandString(command: RpcCommand, key: string): string | undefined {
  const value = command[key];
  return typeof value === "string" ? value : undefined;
}

function firstText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const first = (content as unknown[])[0];
  if (!isRecord(first)) return null;
  const text = first["text"];
  return typeof text === "string" ? text : null;
}

function profileFor(config: RuntimeConfig, profileId: string): CouncilProfile {
  const profile = config.profiles[profileId];
  if (!profile) throw new Error(`Unknown Switch profile: ${profileId}`);
  return profile;
}

function councilModel(id: string, profile: CouncilProfile): Readonly<Record<string, unknown>> {
  return {
    id,
    name: profile.label,
    description: profile.description,
    api: "switch",
    provider: "switch",
    baseUrl: "local://switch",
    reasoning: true,
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function assistantMessage(
  text: string,
  profileId: string,
  usage?: { readonly inputTokens?: number | null; readonly outputTokens?: number | null },
): RpcMessage {
  const inputKnown = typeof usage?.inputTokens === "number";
  const outputKnown = typeof usage?.outputTokens === "number";
  const input = inputKnown ? (usage.inputTokens ?? 0) : 0;
  const output = outputKnown ? (usage.outputTokens ?? 0) : 0;
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "switch",
    provider: "switch",
    model: profileId,
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    usageStatus: {
      inputTokens: inputKnown ? "reported" : "unavailable",
      outputTokens: outputKnown ? "reported" : "unavailable",
      monetaryCost: "unavailable",
      compatibilityZeros: !inputKnown || !outputKnown,
    },
    stopReason: "stop",
    timestamp: Date.now(),
    responseId: randomUUID(),
  };
}

export interface PaseoRpcOptions {
  readonly runtime: SwitchRuntime;
  readonly cwd: string;
  readonly profileId?: string;
  readonly thinking?: "low" | "medium" | "high";
  readonly input?: Readable;
  readonly output?: Writable;
}

export class PaseoRpcServer {
  private profileId: string;
  private thinking: "low" | "medium" | "high";
  private readonly input: Readable;
  private readonly output: Writable;
  private messages: RpcMessage[] = [];
  private running: AbortController | undefined;
  private sessionId = randomUUID();
  private routerSessionId: RouterSessionId | undefined;
  private sessionName?: string;
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly options: PaseoRpcOptions) {
    const config = options.runtime.loadedConfig.config;
    this.profileId =
      options.profileId && config.profiles[options.profileId]
        ? options.profileId
        : config.defaults.profile;
    this.thinking = options.thinking ?? "high";
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
  }

  async run(): Promise<void> {
    const lines = createInterface({ input: this.input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        await this.handle(parseCommand(line));
      } catch (error) {
        this.send({
          type: "response",
          command: "unknown",
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await Promise.allSettled([...this.pending]);
  }

  private send(frame: Readonly<Record<string, unknown>>): void {
    this.output.write(`${JSON.stringify(frame)}\n`);
  }

  private respond(command: RpcCommand, success: boolean, data?: unknown, error?: string): void {
    this.send({
      ...(command.id !== undefined ? { id: command.id } : {}),
      type: "response",
      command: command.type,
      success,
      ...(data !== undefined ? { data } : {}),
      ...(error ? { error } : {}),
    });
  }

  private async handle(command: RpcCommand): Promise<void> {
    const config = this.options.runtime.loadedConfig.config;
    switch (command.type) {
      case "get_state":
        this.respond(command, true, {
          model: councilModel(this.profileId, profileFor(config, this.profileId)),
          thinkingLevel: this.thinking,
          isStreaming: Boolean(this.running),
          isCompacting: false,
          steeringMode: "one-at-a-time",
          followUpMode: "one-at-a-time",
          sessionId: this.sessionId,
          sessionName: this.sessionName,
          autoCompactionEnabled: false,
          messageCount: this.messages.length,
          pendingMessageCount: 0,
        });
        return;
      case "get_messages":
        this.respond(command, true, { messages: this.messages });
        return;
      case "get_available_models":
        this.respond(command, true, {
          models: Object.entries(config.profiles).map(([id, profile]) => councilModel(id, profile)),
        });
        return;
      case "set_model": {
        const modelId = (commandString(command, "modelId") ?? "").replace(/^switch\//, "");
        if (command["provider"] !== "switch" || !config.profiles[modelId]) {
          this.respond(command, false, undefined, `Unknown Switch profile: ${modelId}`);
          return;
        }
        this.profileId = modelId;
        this.respond(command, true, councilModel(modelId, profileFor(config, modelId)));
        return;
      }
      case "set_thinking_level": {
        const level = commandString(command, "level");
        if (level === "low" || level === "medium" || level === "high") {
          this.thinking = level;
        }
        this.respond(command, true, {});
        return;
      }
      case "get_session_stats": {
        const lastRun = this.options.runtime.repository.listRuns()[0];
        const usage = lastRun?.usage;
        this.respond(command, true, {
          tokens: {
            input: usage?.inputTokens ?? 0,
            output: usage?.outputTokens ?? 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          usageStatus: {
            inputTokens: typeof usage?.inputTokens === "number" ? "reported" : "unavailable",
            outputTokens: typeof usage?.outputTokens === "number" ? "reported" : "unavailable",
            monetaryCost: "unavailable",
            compatibilityZeros:
              typeof usage?.inputTokens !== "number" || typeof usage?.outputTokens !== "number",
          },
          cost: usage?.cost ?? 0,
          contextUsage: { tokens: 0, contextWindow: 1_000_000, percent: 0 },
        });
        return;
      }
      case "get_commands":
        this.respond(command, true, { commands: [] });
        return;
      case "get_last_assistant_text": {
        const last = [...this.messages].reverse().find((message) => message.role === "assistant");
        this.respond(command, true, { text: firstText(last?.content) });
        return;
      }
      case "set_session_name":
        this.sessionName = commandString(command, "name") ?? "";
        this.respond(command, true, {});
        return;
      case "new_session":
        this.running?.abort();
        this.messages = [];
        this.sessionId = randomUUID();
        this.routerSessionId = undefined;
        this.respond(command, true, { cancelled: Boolean(this.running) });
        return;
      case "set_auto_compaction":
      case "compact":
        this.respond(command, true, {});
        return;
      case "abort":
        this.running?.abort(new Error("Aborted by host."));
        this.respond(command, true, {});
        return;
      case "prompt":
        if (this.running) {
          this.respond(command, false, undefined, "A Switch run is already active.");
          return;
        }
        this.respond(command, true, { agentInvoked: true });
        {
          const task = this.startPrompt(commandString(command, "message") ?? "").catch(
            (error: unknown) => {
              const message = assistantMessage(
                `Switch failed: ${error instanceof Error ? error.message : String(error)}`,
                this.profileId,
              );
              this.messages.push(message);
              this.emitTextTurn(message);
            },
          );
          this.pending.add(task);
          void task.finally(() => this.pending.delete(task));
        }
        return;
      default:
        this.respond(command, false, undefined, `Unsupported RPC command: ${command.type}`);
    }
  }

  private emitTextTurn(message: RpcMessage): void {
    this.send({ type: "message_start", message });
    const text = firstText(message.content) ?? "";
    this.send({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: text,
        partial: message,
      },
    });
    this.send({ type: "message_end", message });
    this.send({ type: "turn_end", message, toolResults: [] });
    this.send({ type: "agent_end", messages: [message], willRetry: false });
    this.send({ type: "agent_settled" });
  }

  private emitProgress(progress: RunProgress): void {
    const text = `[${progress.phase}] ${progress.message}\n`;
    const partial = assistantMessage(text, this.profileId);
    this.send({
      type: "message_update",
      message: partial,
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: text,
        partial,
      },
    });
  }

  private async startPrompt(query: string): Promise<void> {
    const controller = new AbortController();
    this.running = controller;
    this.messages.push({
      role: "user",
      content: query,
      timestamp: Date.now(),
      attachments: [],
    });
    this.send({ type: "agent_start" });
    this.send({ type: "turn_start" });
    try {
      const profile = profileFor(this.options.runtime.loadedConfig.config, this.profileId);
      let result;
      if (profile.mode === "routed") {
        const routed = await new RoutedRunOrchestrator(
          this.options.runtime.router,
          this.options.runtime.runs,
          this.options.runtime.repository,
        ).run(
          {
            query,
            profileId: this.profileId,
            cwd: this.options.cwd,
            ...(profile.router ? { routerParticipantId: profile.router } : {}),
            ...(this.routerSessionId ? { sessionId: this.routerSessionId } : {}),
            signal: controller.signal,
          },
          {
            cwd: this.options.cwd,
            thinking: this.thinking,
            signal: controller.signal,
            onProgress: (progress) => this.emitProgress(progress),
          },
        );
        this.routerSessionId = routed.route.session.id;
        result = routed;
      } else {
        result = await this.options.runtime.runs.run(
          { query, profileId: this.profileId },
          {
            cwd: this.options.cwd,
            thinking: this.thinking,
            signal: controller.signal,
            onProgress: (progress) => this.emitProgress(progress),
          },
        );
      }
      const snapshots = this.options.runtime.repository.getParticipantSnapshots(result.run.id);
      const provenance = snapshots
        .map(
          (participant) =>
            `- ${participant.role ?? participant.displayName}: ${participant.connectorId}/${participant.model ?? "default"}`,
        )
        .join("\n");
      const answer =
        result.decision?.answer ??
        `Switch run ended with status ${result.run.status}. Run ID: ${result.run.id}`;
      const text = `${answer}\n\nSwitch provenance:\n${provenance}\n- Protocol: ${result.run.plan.protocolId}@${result.run.plan.protocolVersion}\n- Run: ${result.run.id}`;
      const message = assistantMessage(text, this.profileId, result.run.usage);
      this.messages.push(message);
      this.emitTextTurn(message);
    } finally {
      this.running = undefined;
    }
  }
}
