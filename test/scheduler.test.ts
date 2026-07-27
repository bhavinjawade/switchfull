import assert from "node:assert/strict";
import test from "node:test";
import { SwitchError } from "../src/domain/errors.js";
import { InvocationScheduler } from "../src/runtime/scheduler.js";

void test("scheduler enforces global and per-connector concurrency", async () => {
  const scheduler = new InvocationScheduler({
    maxConcurrency: 2,
    perConnectorConcurrency: 1,
  });
  let active = 0;
  let maximum = 0;
  const operation = async (): Promise<number> => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return maximum;
  };
  await Promise.all([
    scheduler.run("a", operation),
    scheduler.run("a", operation),
    scheduler.run("b", operation),
  ]);
  assert.equal(maximum, 2);
  assert.equal(scheduler.snapshot().queued, 0);
  assert.equal(scheduler.snapshot().active, 0);
});

void test("scheduler opens a connector circuit after repeated provider failures", async () => {
  const scheduler = new InvocationScheduler({
    failureThreshold: 2,
    circuitCooldownMs: 60_000,
  });
  const fail = (): Promise<never> =>
    Promise.reject(
      new SwitchError({
        code: "provider_error",
        message: "provider down",
        retry: "retryable",
      }),
    );
  await assert.rejects(scheduler.run("broken", fail), /provider down/);
  await assert.rejects(scheduler.run("broken", fail), /provider down/);
  await assert.rejects(
    scheduler.run("broken", async () => "never"),
    /Circuit/,
  );
  assert.equal(scheduler.snapshot().connectors["broken"]?.circuit, "open");
});

void test("scheduler rejects cancelled queued work before a slot opens", async () => {
  const scheduler = new InvocationScheduler({ maxConcurrency: 1 });
  let release: (() => void) | undefined;
  const blocker = scheduler.run(
    "slow",
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));

  const controller = new AbortController();
  const queued = scheduler.run("other", async () => "should-not-run", {
    signal: controller.signal,
  });
  controller.abort(new Error("cancel queued work"));
  await assert.rejects(
    Promise.race([
      queued,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("queued cancellation was delayed")), 50),
      ),
    ]),
    /cancel queued work/u,
  );
  assert.equal(scheduler.snapshot().queued, 0);
  release?.();
  await blocker;
});
