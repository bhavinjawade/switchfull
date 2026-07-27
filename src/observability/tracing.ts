import { SpanStatusCode, trace, type Attributes } from "@opentelemetry/api";
import { SWITCH_VERSION } from "../domain/version.js";

const tracer = trace.getTracer("switch", SWITCH_VERSION);

export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  operation: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await operation();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error("Unknown Switch failure.");
      span.recordException(normalized);
      span.setStatus({ code: SpanStatusCode.ERROR, message: normalized.message });
      throw error;
    } finally {
      span.end();
    }
  });
}
