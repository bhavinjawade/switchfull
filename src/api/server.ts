import Fastify from "fastify";
import type { SwitchRuntime } from "../application/runtime.js";
import { asRouterSessionId, asRunId } from "../domain/ids.js";
import { SWITCH_VERSION } from "../domain/version.js";
import type { DataClass } from "../policy/engine.js";
import type { ExecutionPlan } from "../schema/execution-plan.js";
import { createLogger } from "../observability/logger.js";
import { SwitchMetrics } from "../observability/metrics.js";
import { ProtocolRegistry } from "../protocol/registry.js";
import { createDataset, type EvaluationCase } from "../evaluation/dataset.js";

interface ApiOptions {
  readonly token?: string;
  readonly logger?: boolean;
  readonly metrics?: SwitchMetrics;
}

interface RunBody {
  readonly query?: string;
  readonly profileId?: string;
  readonly protocolId?: string;
  readonly participants?: readonly string[];
  readonly synthesizer?: string;
  readonly critiqueRounds?: number;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly plan?: ExecutionPlan;
  readonly dataClass?: DataClass;
  readonly cwd?: string;
  readonly execute?: boolean;
}

interface RouteBody {
  readonly query?: string;
  readonly profileId?: string;
  readonly routerParticipantId?: string;
  readonly sessionId?: string;
  readonly eligibleParticipants?: readonly string[];
  readonly deterministic?: boolean;
  readonly cwd?: string;
}

interface EvaluationBody {
  readonly name?: string;
  readonly cases?: readonly EvaluationCase[];
  readonly profiles?: readonly string[];
  readonly cwd?: string;
  readonly maxConcurrency?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertOptionalString(record: Record<string, unknown>, key: string): void {
  const value = record[key];
  if (value !== undefined && (typeof value !== "string" || !value.trim())) {
    throw new Error(`${key} must be a non-empty string`);
  }
}

function assertOptionalStringArray(record: Record<string, unknown>, key: string): void {
  const value = record[key];
  if (
    value !== undefined &&
    (!Array.isArray(value) ||
      value.length === 0 ||
      value.some((item) => typeof item !== "string" || !item.trim()))
  ) {
    throw new Error(`${key} must be a non-empty string array`);
  }
}

function validateRunBody(value: unknown): asserts value is RunBody {
  if (!isRecord(value)) throw new Error("request body must be a JSON object");
  for (const key of ["query", "profileId", "protocolId", "synthesizer", "cwd"]) {
    assertOptionalString(value, key);
  }
  assertOptionalStringArray(value, "participants");
  if (
    value["critiqueRounds"] !== undefined &&
    (!Number.isInteger(value["critiqueRounds"]) ||
      Number(value["critiqueRounds"]) < 0 ||
      Number(value["critiqueRounds"]) > 10)
  ) {
    throw new Error("critiqueRounds must be an integer from 0 through 10");
  }
  if (value["parameters"] !== undefined && !isRecord(value["parameters"])) {
    throw new Error("parameters must be a JSON object");
  }
  if (value["plan"] !== undefined && !isRecord(value["plan"])) {
    throw new Error("plan must be a JSON object");
  }
  if (value["execute"] !== undefined && typeof value["execute"] !== "boolean") {
    throw new Error("execute must be a boolean");
  }
  const dataClass = value["dataClass"];
  if (
    dataClass !== undefined &&
    (typeof dataClass !== "string" ||
      !["public", "internal", "confidential", "restricted"].includes(dataClass))
  ) {
    throw new Error("dataClass is invalid");
  }
}

function validateRouteBody(value: unknown): asserts value is RouteBody {
  if (!isRecord(value)) throw new Error("request body must be a JSON object");
  for (const key of ["query", "profileId", "routerParticipantId", "sessionId", "cwd"]) {
    assertOptionalString(value, key);
  }
  assertOptionalStringArray(value, "eligibleParticipants");
  if (value["deterministic"] !== undefined && typeof value["deterministic"] !== "boolean") {
    throw new Error("deterministic must be a boolean");
  }
}

function validateEvaluationBody(value: unknown): asserts value is EvaluationBody {
  if (!isRecord(value)) throw new Error("request body must be a JSON object");
  assertOptionalString(value, "name");
  assertOptionalString(value, "cwd");
  assertOptionalStringArray(value, "profiles");
  if (!Array.isArray(value["cases"])) throw new Error("cases must be an array");
  if (
    value["maxConcurrency"] !== undefined &&
    (!Number.isInteger(value["maxConcurrency"]) || Number(value["maxConcurrency"]) < 1)
  ) {
    throw new Error("maxConcurrency must be a positive integer");
  }
}

function requestCwd(value: unknown): string {
  if (value === undefined) return process.cwd();
  if (!isRecord(value)) throw new Error("request body must be a JSON object");
  assertOptionalString(value, "cwd");
  return typeof value["cwd"] === "string" ? value["cwd"] : process.cwd();
}

function terminal(status: string): boolean {
  return ["completed", "failed", "cancelled"].includes(status);
}

export function buildHttpServer(runtime: SwitchRuntime, options: ApiOptions = {}) {
  const metrics = options.metrics ?? new SwitchMetrics();
  const app = Fastify({
    ...(options.logger === false ? {} : { loggerInstance: createLogger() }),
    bodyLimit: 2 * 1024 * 1024,
    requestTimeout: 30_000,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!options.token || request.url === "/v1/health") return;
    if (request.headers.authorization !== `Bearer ${options.token}`) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.setErrorHandler(async (error, _request, reply) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    await reply.code(400).send({
      error: normalized.name,
      message: normalized.message,
    });
  });

  app.get("/v1/health", async () => ({
    status: "ok",
    version: SWITCH_VERSION,
    storage: "local",
  }));

  app.get("/v1/profiles", async () => runtime.loadedConfig.config.profiles);
  app.get("/v1/protocols", async () => new ProtocolRegistry().list());
  app.get("/v1/participants", async () => runtime.loadedConfig.config.participants);
  app.get("/v1/connectors/health", async (_request) =>
    runtime.registry.doctor({ cwd: process.cwd(), environment: process.env }),
  );
  app.get("/v1/scheduler", async () => runtime.scheduler.snapshot());
  app.get("/v1/evaluations", async () => runtime.evaluations.listExperiments());

  app.post<{ Body: EvaluationBody }>("/v1/evaluations", async (request) => {
    validateEvaluationBody(request.body);
    if (!request.body.name || !request.body.cases || !request.body.profiles) {
      throw new Error("name, cases, and profiles are required");
    }
    return runtime.evaluationRunner.run({
      dataset: createDataset(request.body.name, request.body.cases),
      profiles: request.body.profiles,
      cwd: request.body.cwd ?? process.cwd(),
      ...(request.body.maxConcurrency !== undefined
        ? { maxConcurrency: request.body.maxConcurrency }
        : {}),
    });
  });

  app.get("/v1/runs", async () => runtime.repository.listRuns());

  app.post<{ Body: RunBody }>("/v1/runs", async (request, reply) => {
    validateRunBody(request.body);
    if (!request.body.query?.trim()) {
      return reply.code(400).send({ error: "query_required" });
    }
    const run = runtime.runs.create({
      query: request.body.query,
      ...(request.body.profileId ? { profileId: request.body.profileId } : {}),
      ...(request.body.protocolId ? { protocolId: request.body.protocolId } : {}),
      ...(request.body.participants ? { participants: request.body.participants } : {}),
      ...(request.body.synthesizer ? { synthesizer: request.body.synthesizer } : {}),
      ...(request.body.critiqueRounds !== undefined
        ? { critiqueRounds: request.body.critiqueRounds }
        : {}),
      ...(request.body.parameters ? { parameters: request.body.parameters } : {}),
      ...(request.body.plan ? { plan: request.body.plan } : {}),
      ...(request.body.dataClass ? { dataClass: request.body.dataClass } : {}),
    });
    metrics.runs.inc({ mode: run.mode });
    if (request.body.execute !== false) {
      metrics.activeRuns.inc();
      const startedAt = performance.now();
      void runtime.runs
        .execute(run.id, { cwd: request.body.cwd ?? process.cwd() })
        .then((result) => {
          metrics.runDuration.observe(
            { mode: result.run.mode, status: result.run.status },
            (performance.now() - startedAt) / 1_000,
          );
        })
        .finally(() => metrics.activeRuns.dec());
    }
    return reply.code(202).send({ run });
  });

  app.get<{ Params: { runId: string } }>("/v1/runs/:runId", async (request) =>
    runtime.runs.inspect(asRunId(request.params.runId)),
  );

  app.post<{ Params: { runId: string }; Body: { cwd?: string } }>(
    "/v1/runs/:runId/start",
    async (request) =>
      runtime.runs.execute(asRunId(request.params.runId), {
        cwd: requestCwd(request.body),
      }),
  );

  app.post<{ Params: { runId: string } }>("/v1/runs/:runId/pause", async (request) =>
    runtime.runs.pause(asRunId(request.params.runId)),
  );

  app.get<{
    Params: { runId: string };
    Querystring: { after?: string; stream?: string };
  }>("/v1/runs/:runId/events", async (request, reply) => {
    const runId = asRunId(request.params.runId);
    const after = Number(request.query.after ?? 0);
    if (!Number.isInteger(after) || after < 0) {
      throw new Error("after must be a non-negative integer");
    }
    const wantsStream =
      request.query.stream === "true" || request.headers.accept?.includes("text/event-stream");
    if (!wantsStream) return runtime.repository.getEvents(runId, after);

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    let sequence = after;
    const writeEvents = (): void => {
      const events = runtime.repository.getEvents(runId, sequence);
      for (const event of events) {
        reply.raw.write(
          `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
        sequence = event.sequence;
      }
      if (terminal(runtime.repository.getRun(runId).status)) {
        clearInterval(interval);
        reply.raw.end();
      }
    };
    const interval = setInterval(writeEvents, 250);
    request.raw.on("close", () => clearInterval(interval));
    writeEvents();
    return reply;
  });

  app.post<{ Params: { runId: string } }>("/v1/runs/:runId/cancel", async (request) =>
    runtime.runs.cancel(asRunId(request.params.runId)),
  );

  app.post<{ Params: { runId: string }; Body: { cwd?: string } }>(
    "/v1/runs/:runId/resume",
    async (request) =>
      runtime.runs.resume(asRunId(request.params.runId), {
        cwd: requestCwd(request.body),
      }),
  );

  app.post<{ Params: { runId: string }; Body: RunBody }>(
    "/v1/runs/:runId/fork",
    async (request, reply) => {
      validateRunBody(request.body);
      const child = runtime.runs.fork(asRunId(request.params.runId), {
        query: request.body?.query ?? "",
        ...(request.body?.profileId ? { profileId: request.body.profileId } : {}),
        ...(request.body?.protocolId ? { protocolId: request.body.protocolId } : {}),
        ...(request.body?.participants ? { participants: request.body.participants } : {}),
        ...(request.body?.synthesizer ? { synthesizer: request.body.synthesizer } : {}),
        ...(request.body?.critiqueRounds !== undefined
          ? { critiqueRounds: request.body.critiqueRounds }
          : {}),
        ...(request.body?.parameters ? { parameters: request.body.parameters } : {}),
        ...(request.body?.plan ? { plan: request.body.plan } : {}),
        ...(request.body?.dataClass ? { dataClass: request.body.dataClass } : {}),
      });
      return reply.code(201).send({ run: child });
    },
  );

  app.post<{
    Params: { runId: string };
    Body: { stageId?: string; text?: string; cwd?: string };
  }>("/v1/runs/:runId/human-input", async (request) => {
    if (!isRecord(request.body)) throw new Error("request body must be a JSON object");
    assertOptionalString(request.body, "stageId");
    assertOptionalString(request.body, "text");
    assertOptionalString(request.body, "cwd");
    if (!request.body.stageId || !request.body.text?.trim()) {
      throw new Error("stageId and text are required");
    }
    return runtime.runs.submitHumanInput(
      asRunId(request.params.runId),
      request.body.stageId,
      request.body.text,
      { cwd: request.body.cwd ?? process.cwd() },
    );
  });

  app.post<{
    Params: { runId: string };
    Body: { destination?: string };
  }>("/v1/runs/:runId/export", async (request) => {
    if (!isRecord(request.body)) throw new Error("request body must be a JSON object");
    assertOptionalString(request.body, "destination");
    if (!request.body.destination) throw new Error("destination is required");
    return runtime.exports.export(asRunId(request.params.runId), request.body.destination);
  });

  app.post<{ Body: RouteBody }>("/v1/route", async (request) => {
    validateRouteBody(request.body);
    if (!request.body.query?.trim()) throw new Error("query is required");
    const result = await runtime.router.route({
      query: request.body.query,
      cwd: request.body.cwd ?? process.cwd(),
      ...(request.body.profileId ? { profileId: request.body.profileId } : {}),
      ...(request.body.routerParticipantId
        ? { routerParticipantId: request.body.routerParticipantId }
        : {}),
      ...(request.body.sessionId ? { sessionId: asRouterSessionId(request.body.sessionId) } : {}),
      ...(request.body.eligibleParticipants
        ? { eligibleParticipants: request.body.eligibleParticipants }
        : {}),
      ...(request.body.deterministic !== undefined
        ? { deterministic: request.body.deterministic }
        : {}),
    });
    metrics.routing.inc({
      source: result.source,
      strategy: result.decision.strategy,
    });
    return result;
  });

  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  return app;
}
