import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { defaultConfig } from "../src/config/defaults.js";
import { SubscriptionProcessConnector } from "../src/connectors/process-connectors.js";
import { ParticipantRegistry } from "../src/connectors/registry.js";
import { SwitchError } from "../src/domain/errors.js";
import type { SwitchConfig } from "../src/schema/config.js";

void test("OpenCode surfaces zero-exit stderr provider failures", async () => {
  const opencode = defaultConfig.connectors["opencode"];
  assert.ok(opencode);
  const config: SwitchConfig = {
    ...defaultConfig,
    connectors: {
      ...defaultConfig.connectors,
      opencode: {
        ...opencode,
        command: [
          process.execPath,
          "-e",
          'process.stderr.write("Error: test model is unavailable\\n");',
        ],
      },
    },
  };
  const participant = new ParticipantRegistry(config)
    .register(new SubscriptionProcessConnector("opencode"))
    .resolve("oss-critic");

  await assert.rejects(
    participant.invoke(
      {
        requestId: randomUUID(),
        messages: [{ role: "user", content: "test" }],
      },
      { cwd: process.cwd(), timeoutMs: 5_000 },
    ),
    (error: unknown) =>
      error instanceof SwitchError &&
      error.code === "provider_error" &&
      error.message.includes("test model is unavailable"),
  );
});

void test("OpenCode free-only participants fail closed for unmarked models", async () => {
  const config = structuredClone(defaultConfig);
  const participantConfig = config.participants["oss-critic"];
  assert.ok(participantConfig);
  participantConfig.model = "opencode/future-paid-model";
  const participant = new ParticipantRegistry(config)
    .register(new SubscriptionProcessConnector("opencode"))
    .resolve("oss-critic");

  await assert.rejects(
    participant.invoke(
      {
        requestId: randomUUID(),
        messages: [{ role: "user", content: "test" }],
      },
      { cwd: process.cwd(), timeoutMs: 5_000 },
    ),
    /Refusing non-free OpenCode model/u,
  );
});

void test("subscription CLI usage-limit failures are classified without leaking stderr", async () => {
  const codex = defaultConfig.connectors["codex"];
  assert.ok(codex);
  const config: SwitchConfig = {
    ...defaultConfig,
    connectors: {
      ...defaultConfig.connectors,
      codex: {
        ...codex,
        command: [
          process.execPath,
          "-e",
          'process.stderr.write("ERROR: You have hit your usage limit. Purchase more credits.\\n"); process.exit(1);',
        ],
      },
    },
  };
  const participant = new ParticipantRegistry(config)
    .register(new SubscriptionProcessConnector("codex"))
    .resolve("codex-architect");

  await assert.rejects(
    participant.invoke(
      {
        requestId: randomUUID(),
        messages: [{ role: "user", content: "sensitive prompt" }],
      },
      { cwd: process.cwd(), timeoutMs: 5_000 },
    ),
    (error: unknown) =>
      error instanceof SwitchError &&
      error.code === "quota_exhausted" &&
      error.retry === "non_retryable" &&
      error.message === "OpenAI Codex subscription CLI quota is exhausted." &&
      error.details["stderr"] === undefined,
  );
});
