import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config/defaults.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { ProtocolCompiler } from "../src/protocol/compiler.js";

void test("restricted data is denied for external subscription participants", () => {
  const plan = new ProtocolCompiler().compile(defaultConfig, {
    profileId: "quick",
    planId: crypto.randomUUID(),
  });
  const decision = new PolicyEngine(defaultConfig).evaluate(plan, "restricted");
  assert.equal(decision.outcome, "denied");
  assert.ok(
    decision.violations.some(
      (violation) => violation.code === "restricted_data_external_connector",
    ),
  );
});

void test("internal local-mode plans remain allowed", () => {
  const plan = new ProtocolCompiler().compile(defaultConfig, {
    profileId: "quick",
    planId: crypto.randomUUID(),
  });
  assert.equal(new PolicyEngine(defaultConfig).evaluate(plan, "internal").outcome, "allowed");
});

void test("local policy can explicitly disable personal subscription connectors", () => {
  const config = structuredClone(defaultConfig);
  config.policy.allowPersonalSubscriptions = false;
  const permissivePlan = new ProtocolCompiler().compile(defaultConfig, {
    profileId: "quick",
    planId: crypto.randomUUID(),
  });
  const decision = new PolicyEngine(config).evaluate(permissivePlan, "internal");
  assert.equal(decision.outcome, "denied");
  assert.ok(
    decision.violations.some((violation) => violation.code === "personal_subscription_disabled"),
  );
  assert.throws(
    () =>
      new ProtocolCompiler().compile(config, {
        profileId: "quick",
        planId: crypto.randomUUID(),
      }),
    /validation failed/u,
  );
});
