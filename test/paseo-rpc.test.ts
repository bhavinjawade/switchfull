import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { createSwitchRuntime } from "../src/application/runtime.js";
import { PaseoRpcServer } from "../src/integrations/paseo-rpc.js";

void test("Paseo RPC advertises all configured council and router profiles", async () => {
  const home = mkdtempSync(join(tmpdir(), "switch-rpc-"));
  const runtime = createSwitchRuntime({
    environment: { ...process.env, SWITCH_HOME: home },
  });
  let output = "";
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk);
      callback();
    },
  });
  try {
    await new PaseoRpcServer({
      runtime,
      cwd: process.cwd(),
      input: Readable.from([`${JSON.stringify({ id: 1, type: "get_available_models" })}\n`]),
      output: writable,
    }).run();
    const frame = JSON.parse(output.trim()) as {
      success: boolean;
      data: { models: { id: string }[] };
    };
    assert.equal(frame.success, true);
    const ids = frame.data.models.map((model) => model.id);
    assert.ok(ids.includes("balanced"));
    assert.ok(ids.includes("router-balanced"));
    assert.ok(ids.includes("jury"));
    assert.ok(!ids.includes("multi-agent-debate"));
    assert.ok(ids.includes("debate"));
  } finally {
    runtime.close();
    rmSync(home, { recursive: true, force: true });
  }
});
