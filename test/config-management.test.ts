import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config/defaults.js";
import {
  cloneParticipant,
  cloneProfile,
  updateParticipant,
  updateProfile,
} from "../src/config/manage.js";
import { validateConfig } from "../src/config/load.js";

void test("participant management updates models, roles, and enabled state", () => {
  const updated = updateParticipant(defaultConfig, "oss-critic", {
    enabled: false,
    model: "opencode/mimo-v2.5-free",
    role: "Verifier",
    expertise: ["coding", "coding", "verification"],
  });
  assert.equal(updated.participants["oss-critic"]?.enabled, false);
  assert.equal(updated.participants["oss-critic"]?.model, "opencode/mimo-v2.5-free");
  assert.equal(updated.participants["oss-critic"]?.role, "Verifier");
  assert.deepEqual(updated.participants["oss-critic"]?.expertise, ["coding", "verification"]);
  assert.doesNotThrow(() => validateConfig(updated));
});

void test("participant and profile cloning produce independent valid records", () => {
  const withParticipant = cloneParticipant(defaultConfig, "oss-critic", "oss-verifier", {
    displayName: "OSS Verifier",
    role: "Verifier",
  });
  const withProfile = cloneProfile(withParticipant, "balanced", "custom", {
    label: "Custom Council",
    participants: ["codex-architect", "oss-verifier"],
    synthesizer: "codex-architect",
    critiqueRounds: 0,
  });
  assert.equal(withProfile.participants["oss-verifier"]?.displayName, "OSS Verifier");
  assert.deepEqual(withProfile.profiles["custom"]?.participants, [
    "codex-architect",
    "oss-verifier",
  ]);
  assert.doesNotThrow(() => validateConfig(withProfile));
});

void test("profile membership changes remove a no-longer-eligible synthesizer", () => {
  const updated = updateProfile(defaultConfig, "balanced", {
    participants: ["gemini-analyst", "grok-challenger"],
  });
  assert.equal(updated.profiles["balanced"]?.synthesizer, undefined);
});
