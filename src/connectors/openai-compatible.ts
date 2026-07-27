import { SwitchError } from "../domain/errors.js";
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

interface ChatCompletionResponse {
  readonly id?: string;
  readonly model?: string;
  readonly choices?: readonly {
    readonly message?: { readonly content?: string };
    readonly finish_reason?: string;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
  readonly error?: { readonly message?: string };
}

function resolveBearerToken(
  connector: ConnectorConfig,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const reference = connector.secrets["apiKey"];
  if (!reference) return undefined;
  if (reference.source !== "environment") {
    throw new SwitchError({
      code: "configuration_error",
      message: `Secret source ${reference.source} is not implemented by the local-v1 secret resolver.`,
      retry: "non_retryable",
    });
  }
  const value = environment[reference.key];
  if (!value) {
    throw new SwitchError({
      code: "authentication_error",
      message: `Required environment secret ${reference.key} is not set.`,
      retry: "non_retryable",
    });
  }
  return value;
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export class OpenAiCompatibleConnector implements ParticipantConnector {
  readonly manifest: ConnectorManifest = {
    apiVersion: "switch.dev/connector/v1alpha1",
    id: "openai-compatible",
    name: "OpenAI-compatible HTTP",
    version: "1.0.0",
    kind: "model",
    stability: "built-in-stable",
    transport: "http",
    authOwner: "switch_secret_store",
    billingType: "metered_api",
    capabilities: [
      "text_generation",
      "structured_output",
      "streaming",
      "usage_reporting",
      "cancellation",
    ],
  };

  async invoke(
    participant: ResolvedParticipant,
    request: ParticipantRequest,
    context: InvocationContext,
  ): Promise<ParticipantResult> {
    const baseUrl = participant.connector.baseUrl;
    const model = participant.participant.model;
    if (!baseUrl || !model) {
      throw new SwitchError({
        code: "configuration_error",
        message: `Participant ${participant.id} requires baseUrl and model.`,
        retry: "non_retryable",
      });
    }
    const requiredSuffix = participant.connector.config["enforceModelSuffix"];
    if (typeof requiredSuffix === "string" && requiredSuffix && !model.endsWith(requiredSuffix)) {
      throw new SwitchError({
        code: "policy_denied",
        message: `Model ${model} is denied: connector requires the ${requiredSuffix} suffix.`,
        retry: "non_retryable",
      });
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("request timed out")),
      context.timeoutMs,
    );
    const abort = (): void => controller.abort(context.signal?.reason);
    context.signal?.addEventListener("abort", abort, { once: true });
    try {
      const token = resolveBearerToken(participant.connector, context.environment ?? process.env);
      const response = await fetch(endpoint(baseUrl, "/chat/completions"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: request.messages,
          ...(request.outputSchema
            ? {
                response_format: {
                  type: "json_schema",
                  json_schema: { name: "switch_output", schema: request.outputSchema },
                },
              }
            : {}),
        }),
        signal: controller.signal,
      });
      const body = (await response.json()) as ChatCompletionResponse;
      if (!response.ok) {
        throw new SwitchError({
          code: response.status === 429 ? "rate_limited" : "provider_error",
          message: body.error?.message ?? `Provider returned HTTP ${response.status}.`,
          retry: response.status >= 500 || response.status === 429 ? "retryable" : "non_retryable",
          details: { status: response.status },
        });
      }
      const choice = body.choices?.[0];
      const text = choice?.message?.content?.trim();
      if (!text) {
        throw new SwitchError({
          code: "provider_error",
          message: "Provider returned an empty response.",
          retry: "unknown",
        });
      }
      return {
        requestId: request.requestId,
        text,
        ...(body.id ? { providerRequestId: body.id } : {}),
        model: body.model ?? model,
        ...(choice?.finish_reason ? { stopReason: choice.finish_reason } : {}),
        usage: body.usage
          ? {
              inputTokens: body.usage.prompt_tokens ?? null,
              outputTokens: body.usage.completion_tokens ?? null,
              source: "reported",
            }
          : { source: "unavailable" },
      };
    } catch (error) {
      if (error instanceof SwitchError) throw error;
      throw new SwitchError({
        code: controller.signal.aborted
          ? context.signal?.aborted
            ? "cancelled"
            : "timeout"
          : "provider_error",
        message: error instanceof Error ? error.message : String(error),
        retry: "unknown",
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
      context.signal?.removeEventListener("abort", abort);
    }
  }

  async health(
    connector: ConnectorConfig,
    context: Pick<InvocationContext, "environment">,
  ): Promise<ConnectorHealth> {
    if (!connector.baseUrl) {
      return {
        status: "unavailable",
        checkedAt: new Date().toISOString(),
        message: "No baseUrl is configured.",
      };
    }
    const startedAt = performance.now();
    try {
      const token = resolveBearerToken(connector, context.environment ?? process.env);
      const response = await fetch(endpoint(connector.baseUrl, "/models"), {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      return {
        status: response.ok
          ? "healthy"
          : response.status === 401 || response.status === 403
            ? "unauthenticated"
            : "degraded",
        checkedAt: new Date().toISOString(),
        message: response.ok
          ? "Endpoint is available."
          : `Endpoint returned HTTP ${response.status}.`,
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
