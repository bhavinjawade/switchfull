import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildHttpServer } from "../src/api/server.js";
import { createSwitchRuntime } from "../src/application/runtime.js";
import { SwitchClient } from "../src/sdk/client.js";

void test("TypeScript SDK covers catalogs, runs, metrics, and SSE replay", async () => {
  const home = mkdtempSync(join(tmpdir(), "switch-sdk-"));
  const runtime = createSwitchRuntime({
    environment: { ...process.env, SWITCH_HOME: home },
  });
  const server = buildHttpServer(runtime, { logger: false });
  try {
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address();
    assert.ok(address && typeof address !== "string");
    const client = new SwitchClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
    });

    const health = await client.health();
    assert.equal(health.status, "ok");
    assert.equal(health.storage, "local");
    assert.equal((await client.protocols()).length, 13);
    assert.ok((await client.profiles())["balanced"]);

    const created = await client.createRun({
      query: "SDK contract test",
      profileId: "quick",
      execute: false,
    });
    assert.equal(created.run.status, "created");
    assert.equal((await client.getRun(created.run.id)).run.id, created.run.id);
    assert.equal((await client.cancelRun(created.run.id)).status, "cancelled");
    assert.ok((await client.events(created.run.id)).length > 0);

    const streamed = [];
    for await (const event of client.streamEvents(created.run.id)) streamed.push(event);
    assert.equal(streamed.at(-1)?.type, "RunCancelled");
    assert.match(await client.metrics(), /switch_runs_total/u);
  } finally {
    await server.close();
    runtime.close();
    rmSync(home, { recursive: true, force: true });
  }
});
