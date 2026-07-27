import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildHttpServer } from "../src/api/server.js";
import { createSwitchRuntime } from "../src/application/runtime.js";

void test("HTTP API exposes catalogs and durable run resources", async () => {
  const home = mkdtempSync(join(tmpdir(), "switch-api-"));
  const runtime = createSwitchRuntime({
    environment: { ...process.env, SWITCH_HOME: home },
  });
  const server = buildHttpServer(runtime, { logger: false });
  try {
    const health = await server.inject({ method: "GET", url: "/v1/health" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json<{ status: string }>().status, "ok");
    assert.equal("database" in health.json<Record<string, unknown>>(), false);

    const protocols = await server.inject({ method: "GET", url: "/v1/protocols" });
    assert.equal(protocols.statusCode, 200);
    assert.ok(
      protocols
        .json<readonly { id: string }[]>()
        .some((protocol) => protocol.id === "independent-critique-synthesis"),
    );

    const created = await server.inject({
      method: "POST",
      url: "/v1/runs",
      payload: {
        query: "API contract test",
        profileId: "quick",
        execute: false,
      },
    });
    assert.equal(created.statusCode, 202);
    const runId = created.json<{ run: { id: string } }>().run.id;
    const inspected = await server.inject({
      method: "GET",
      url: `/v1/runs/${runId}`,
    });
    assert.equal(inspected.statusCode, 200);
    assert.equal(inspected.json<{ run: { status: string } }>().run.status, "created");

    const invalidPolicy = await server.inject({
      method: "POST",
      url: "/v1/runs",
      payload: { query: "Malformed policy", dataClass: "secret" },
    });
    assert.equal(invalidPolicy.statusCode, 400);
    const invalidRoute = await server.inject({
      method: "POST",
      url: "/v1/route",
      payload: { query: "Malformed route", deterministic: "false" },
    });
    assert.equal(invalidRoute.statusCode, 400);
    const invalidRunId = await server.inject({
      method: "GET",
      url: "/v1/runs/not-a-uuid",
    });
    assert.equal(invalidRunId.statusCode, 400);
  } finally {
    await server.close();
    runtime.close();
    rmSync(home, { recursive: true, force: true });
  }
});

void test("HTTP API enforces configured bearer authentication", async () => {
  const home = mkdtempSync(join(tmpdir(), "switch-api-auth-"));
  const runtime = createSwitchRuntime({
    environment: { ...process.env, SWITCH_HOME: home },
  });
  const server = buildHttpServer(runtime, { logger: false, token: "test-token" });
  try {
    const denied = await server.inject({ method: "GET", url: "/v1/protocols" });
    assert.equal(denied.statusCode, 401);
    const allowed = await server.inject({
      method: "GET",
      url: "/v1/protocols",
      headers: { authorization: "Bearer test-token" },
    });
    assert.equal(allowed.statusCode, 200);
  } finally {
    await server.close();
    runtime.close();
    rmSync(home, { recursive: true, force: true });
  }
});
