import type { ConnectorHealth } from "../connectors/port.js";
import type { RunId } from "../domain/ids.js";
import type { EvaluationCase } from "../evaluation/dataset.js";
import type { EvaluationResult } from "../evaluation/runner.js";
import type { ExperimentRecord } from "../evaluation/repository.js";
import type { RunExportManifest } from "../persistence/run-export.js";
import type { RunRecord } from "../persistence/run-repository.js";
import type { ProtocolMetadata } from "../protocol/types.js";
import type { RouteRequest, RouteResult } from "../routing/router-service.js";
import type { RunEventEnvelope } from "../schema/event.js";
import type { SwitchConfig } from "../schema/config.js";
import type { ExecutionResult } from "../runtime/executor.js";
import type { CreateRunRequest, RunService } from "../runtime/run-service.js";
import type { SchedulerSnapshot } from "../runtime/scheduler.js";

export interface SwitchClientOptions {
  readonly baseUrl?: string;
  readonly token?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface HttpCreateRunRequest extends Omit<CreateRunRequest, "parentRunId"> {
  readonly cwd?: string;
  readonly execute?: boolean;
}

export interface HttpRouteRequest extends Omit<RouteRequest, "cwd" | "signal" | "sessionId"> {
  readonly cwd?: string;
  readonly sessionId?: string;
}

export interface EvaluationRequest {
  readonly name: string;
  readonly cases: readonly EvaluationCase[];
  readonly profiles: readonly string[];
  readonly cwd?: string;
  readonly maxConcurrency?: number;
}

export type RunInspection = ReturnType<RunService["inspect"]>;

export class SwitchClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly request: typeof globalThis.fetch;

  constructor(options: SwitchClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
    this.token = options.token;
    this.request = options.fetch ?? globalThis.fetch;
  }

  async health(): Promise<{
    readonly status: "ok";
    readonly version: string;
    readonly storage: "local";
  }> {
    return this.json("/v1/health");
  }

  async profiles(): Promise<SwitchConfig["profiles"]> {
    return this.json("/v1/profiles");
  }

  async protocols(): Promise<readonly ProtocolMetadata[]> {
    return this.json("/v1/protocols");
  }

  async participants(): Promise<SwitchConfig["participants"]> {
    return this.json("/v1/participants");
  }

  async connectorHealth(): Promise<Readonly<Record<string, ConnectorHealth>>> {
    return this.json("/v1/connectors/health");
  }

  async scheduler(): Promise<SchedulerSnapshot> {
    return this.json("/v1/scheduler");
  }

  async createRun(request: HttpCreateRunRequest): Promise<{ readonly run: RunRecord }> {
    return this.json("/v1/runs", { method: "POST", body: JSON.stringify(request) });
  }

  async getRun(runId: RunId | string): Promise<RunInspection> {
    return this.json(`/v1/runs/${this.id(runId)}`);
  }

  async listRuns(): Promise<readonly RunRecord[]> {
    return this.json("/v1/runs");
  }

  async startRun(
    runId: RunId | string,
    options: { readonly cwd?: string } = {},
  ): Promise<ExecutionResult> {
    return this.json(`/v1/runs/${this.id(runId)}/start`, {
      method: "POST",
      body: JSON.stringify(options),
    });
  }

  async pauseRun(runId: RunId | string): Promise<RunRecord> {
    return this.json(`/v1/runs/${this.id(runId)}/pause`, { method: "POST" });
  }

  async resumeRun(
    runId: RunId | string,
    options: { readonly cwd?: string } = {},
  ): Promise<ExecutionResult> {
    return this.json(`/v1/runs/${this.id(runId)}/resume`, {
      method: "POST",
      body: JSON.stringify(options),
    });
  }

  async cancelRun(runId: RunId | string): Promise<RunRecord> {
    return this.json(`/v1/runs/${this.id(runId)}/cancel`, { method: "POST" });
  }

  async forkRun(
    runId: RunId | string,
    overrides: Partial<Omit<HttpCreateRunRequest, "execute" | "cwd">> = {},
  ): Promise<{ readonly run: RunRecord }> {
    return this.json(`/v1/runs/${this.id(runId)}/fork`, {
      method: "POST",
      body: JSON.stringify(overrides),
    });
  }

  async submitHumanInput(
    runId: RunId | string,
    input: { readonly stageId: string; readonly text: string; readonly cwd?: string },
  ): Promise<ExecutionResult> {
    return this.json(`/v1/runs/${this.id(runId)}/human-input`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async events(runId: RunId | string, after = 0): Promise<readonly RunEventEnvelope[]> {
    return this.json(`/v1/runs/${this.id(runId)}/events?after=${after}`);
  }

  async *streamEvents(
    runId: RunId | string,
    options: { readonly after?: number; readonly signal?: AbortSignal } = {},
  ): AsyncGenerator<RunEventEnvelope, void, void> {
    const headers = this.headers();
    headers.set("accept", "text/event-stream");
    const response = await this.request(
      `${this.baseUrl}/v1/runs/${this.id(runId)}/events?stream=true&after=${options.after ?? 0}`,
      {
        headers,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    if (!response.ok || !response.body) {
      throw new Error(
        `Switch event stream returned HTTP ${response.status}: ${await response.text()}`,
      );
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value: unknown = chunk.value;
        if (!(value instanceof Uint8Array)) {
          throw new Error("Switch event stream returned an invalid binary chunk.");
        }
        buffer += decoder.decode(value, { stream: true });
        while (true) {
          const boundary = /\r?\n\r?\n/u.exec(buffer);
          if (!boundary) break;
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = frame
            .split(/\r?\n/u)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data) yield JSON.parse(data) as RunEventEnvelope;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async exportRun(runId: RunId | string, destination: string): Promise<RunExportManifest> {
    return this.json(`/v1/runs/${this.id(runId)}/export`, {
      method: "POST",
      body: JSON.stringify({ destination }),
    });
  }

  async route(request: HttpRouteRequest): Promise<RouteResult> {
    return this.json("/v1/route", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async evaluations(): Promise<readonly ExperimentRecord[]> {
    return this.json("/v1/evaluations");
  }

  async evaluate(request: EvaluationRequest): Promise<EvaluationResult> {
    return this.json("/v1/evaluations", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async metrics(): Promise<string> {
    const response = await this.request(`${this.baseUrl}/metrics`, {
      headers: this.headers(),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Switch metrics returned HTTP ${response.status}: ${body}`);
    }
    return body;
  }

  private id(value: RunId | string): string {
    return encodeURIComponent(value);
  }

  private headers(init?: ConstructorParameters<typeof Headers>[0]): Headers {
    const headers = new Headers(init);
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    return headers;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = this.headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body) headers.set("content-type", "application/json");
    const response = await this.request(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      throw new Error(`Switch API returned HTTP ${response.status}: ${JSON.stringify(body)}`);
    }
    return body as T;
  }
}
