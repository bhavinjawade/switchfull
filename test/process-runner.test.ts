import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runProcess } from "../src/connectors/process-runner.js";

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Process ${pid} was still running after ${timeoutMs}ms.`);
}

void test("process runner does not inherit undeclared environment variables", async () => {
  const result = await runProcess(
    process.execPath,
    ["-e", "process.stdout.write(process.env.SWITCH_SECRET_CANARY ?? 'absent')"],
    {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      environmentAllowlist: ["PATH"],
      environment: { ...process.env, SWITCH_SECRET_CANARY: "must-not-leak" },
    },
  );
  assert.equal(result.stdout, "absent");
});

void test("process runner enforces output bounds", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000))"], {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      environmentAllowlist: ["PATH"],
      maxOutputBytes: 100,
    }),
    /output limit/,
  );
});

void test("process runner supports cancellation", async () => {
  const controller = new AbortController();
  const invocation = runProcess(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    cwd: process.cwd(),
    timeoutMs: 30_000,
    signal: controller.signal,
    environmentAllowlist: ["PATH"],
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(invocation, /cancelled/);
});

void test("process runner enforces invocation timeouts", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      cwd: process.cwd(),
      timeoutMs: 50,
      environmentAllowlist: ["PATH"],
      terminationGraceMs: 30,
    }),
    /timed out/,
  );
});

void test(
  "process runner force-kills a child that ignores graceful termination",
  { skip: process.platform === "win32" },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "switch-process-"));
    const pidFile = join(directory, "pid");
    try {
      const controller = new AbortController();
      let markReady: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        markReady = resolve;
      });
      const script = [
        "const fs = require('node:fs')",
        "fs.writeFileSync(process.argv[1], String(process.pid))",
        "process.on('SIGTERM', () => {})",
        "process.stderr.write('ready\\n')",
        "setInterval(() => {}, 1000)",
      ].join(";");
      const invocation = runProcess(process.execPath, ["-e", script, pidFile], {
        cwd: process.cwd(),
        timeoutMs: 5_000,
        signal: controller.signal,
        environmentAllowlist: ["PATH"],
        terminationGraceMs: 30,
        onStderr: (chunk) => {
          if (chunk.includes("ready")) markReady?.();
        },
      });
      await ready;
      const pid = Number(readFileSync(pidFile, "utf8"));
      controller.abort();
      await assert.rejects(invocation, /cancelled/);
      await waitForProcessExit(pid, 2_000);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
