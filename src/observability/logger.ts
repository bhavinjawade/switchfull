import pino, { type Logger } from "pino";

const redactPaths = [
  "req.headers.authorization",
  "authorization",
  "apiKey",
  "*.apiKey",
  "secrets",
  "*.secrets",
];

export function createLogger(level = process.env["SWITCH_LOG_LEVEL"] ?? "info"): Logger {
  return pino({
    level,
    redact: {
      paths: redactPaths,
      censor: "[REDACTED]",
    },
    base: { service: "switch" },
  });
}
