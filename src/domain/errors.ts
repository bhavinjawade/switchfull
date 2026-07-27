export const errorCodes = [
  "configuration_error",
  "validation_error",
  "policy_denied",
  "authentication_error",
  "authorization_error",
  "connector_unavailable",
  "provider_error",
  "rate_limited",
  "quota_exhausted",
  "timeout",
  "attempt_unknown",
  "protocol_error",
  "plugin_error",
  "storage_error",
  "integrity_error",
  "cancelled",
  "internal_error",
] as const;

export type ErrorCode = (typeof errorCodes)[number];
export type RetryDisposition = "retryable" | "non_retryable" | "unknown";

export interface SwitchErrorOptions {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retry: RetryDisposition;
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class SwitchError extends Error {
  readonly code: ErrorCode;
  readonly retry: RetryDisposition;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(options: SwitchErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SwitchError";
    this.code = options.code;
    this.retry = options.retry;
    this.details = options.details ?? {};
  }
}

export function asSwitchError(error: unknown): SwitchError {
  if (error instanceof SwitchError) return error;
  if (error instanceof Error) {
    return new SwitchError({
      code: "internal_error",
      message: error.message,
      retry: "unknown",
      cause: error,
    });
  }
  return new SwitchError({
    code: "internal_error",
    message: String(error),
    retry: "unknown",
    cause: error,
  });
}
