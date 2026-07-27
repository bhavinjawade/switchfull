import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config/defaults.js";
import { updateParticipant } from "../src/config/manage.js";
import { ProtocolCompiler } from "../src/protocol/compiler.js";
import { ProtocolRegistry } from "../src/protocol/registry.js";
import { validatePlan } from "../src/protocol/validator.js";
import {
  canReadArtifact,
  shouldStripArtifactIdentity,
  type ArtifactAudience,
} from "../src/protocol/visibility.js";

void test("all built-in protocols compile to accepted execution plans", () => {
  const compiler = new ProtocolCompiler();
  const protocols = new ProtocolRegistry().list();
  for (const protocol of protocols) {
    const minimum = Math.max(protocol.minimumParticipants, 1);
    const participants = Object.keys(defaultConfig.participants).slice(0, minimum);
    const synthesizer = participants[0];
    assert.ok(synthesizer);
    const plan = compiler.compile(defaultConfig, {
      profileId: "balanced",
      protocolId: protocol.id,
      participants,
      synthesizer,
      critiqueRounds: 1,
      planId: crypto.randomUUID(),
      parameters: { sampleCount: 3 },
    });
    assert.equal(validatePlan(plan, defaultConfig).outcome, "accepted", protocol.id);
    assert.equal(plan.protocolId, protocol.id);
    assert.equal(plan.mode, protocol.id === "direct" ? "direct" : "council");
  }
});

void test("plan validator rejects cycles and disabled participants", () => {
  const compiler = new ProtocolCompiler();
  const valid = compiler.compile(defaultConfig, {
    profileId: "balanced",
    planId: crypto.randomUUID(),
  });
  const invalid = structuredClone(valid);
  const first = invalid.stages[0];
  assert.ok(first);
  first.dependsOn.push(invalid.finalStage);
  first.participants.push("missing-participant");
  const validation = validatePlan(invalid, defaultConfig);
  assert.equal(validation.outcome, "repairable");
  assert.ok(validation.violations.some((violation) => violation.code === "cyclic_plan"));
  assert.ok(validation.violations.some((violation) => violation.code === "participant_ineligible"));
});

void test("participant overrides do not retain an ineligible profile synthesizer", () => {
  const plan = new ProtocolCompiler().compile(defaultConfig, {
    profileId: "balanced",
    protocolId: "direct",
    participants: ["gemini-analyst"],
    planId: crypto.randomUUID(),
  });
  assert.deepEqual(plan.stages[0]?.participants, ["gemini-analyst"]);
  assert.equal(plan.mode, "direct");
});

void test("disabled profile members are omitted without invalidating the council", () => {
  const config = updateParticipant(defaultConfig, "oss-critic", { enabled: false });
  const plan = new ProtocolCompiler().compile(config, {
    profileId: "balanced",
    planId: crypto.randomUUID(),
  });
  assert.ok(plan.stages.every((stage) => !stage.participants.includes("oss-critic")));
  assert.equal(validatePlan(plan, config).outcome, "accepted");
});

void test("artifact visibility policies fail closed", () => {
  const participant: ArtifactAudience = {
    participantId: "member-a",
    participantRole: "Analyst",
    stage: {
      operator: "critique",
      role: "reviewer",
      visibility: "council",
    },
  };
  assert.equal(canReadArtifact("private", { participantId: "member-a" }, participant), true);
  assert.equal(canReadArtifact("private", { participantId: "member-b" }, participant), false);
  assert.equal(canReadArtifact("role", { role: "analyst" }, participant), true);
  assert.equal(canReadArtifact("role", { role: "architect" }, participant), false);
  assert.equal(canReadArtifact("audit-only", {}, participant), false);
  assert.equal(canReadArtifact("judge-only", {}, participant), false);
  assert.equal(
    canReadArtifact(
      "judge-only",
      {},
      {
        ...participant,
        stage: { ...participant.stage, operator: "vote", role: "judge" },
      },
    ),
    true,
  );
  assert.equal(canReadArtifact("council", {}, participant), true);
  assert.equal(canReadArtifact("public-result", {}, participant), true);
  assert.equal(shouldStripArtifactIdentity("identity-stripped-council", "public-result"), true);
  assert.equal(shouldStripArtifactIdentity("council", "identity-stripped-council"), true);
  assert.equal(shouldStripArtifactIdentity("council", "public-result"), false);
});

void test("plan validation rejects hidden graph edges and non-public finals", () => {
  const compiler = new ProtocolCompiler();
  const plan = compiler.compile(defaultConfig, {
    profileId: "balanced",
    planId: crypto.randomUUID(),
  });
  const invalid = structuredClone(plan);
  const final = invalid.stages.find((stage) => stage.id === invalid.finalStage);
  assert.ok(final);
  final.inputStages = [...(final.inputStages ?? []), "missing-evidence"];
  final.visibility = "council";
  const validation = validatePlan(invalid, defaultConfig);
  assert.ok(validation.violations.some((item) => item.code === "missing_input_stage"));
  assert.ok(validation.violations.some((item) => item.code === "final_stage_not_public"));
});
