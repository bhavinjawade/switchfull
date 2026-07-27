import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { migrateConfig } from "../src/config/migrate.js";
import { saveConfig, validateConfig } from "../src/config/load.js";
import { defaultConfig } from "../src/config/defaults.js";
import type { SwitchConfig } from "../src/schema/config.js";

void test("legacy seats migrate to participant records", () => {
  const result = migrateConfig({
    version: 1,
    defaults: { profile: "quick", timeoutMs: 1000, maxConcurrency: 2 },
    commands: { codex: "/custom/codex", agy: "agy" },
    seats: [
      {
        id: "architect",
        enabled: true,
        adapter: "codex",
        model: "gpt-test",
        role: "Architect",
      },
      {
        id: "analyst",
        enabled: true,
        adapter: "agy",
        model: "gemini-test",
        role: "Analyst",
      },
    ],
    profiles: {
      quick: {
        label: "Quick",
        description: "Legacy",
        seats: "*",
        critiqueRounds: 0,
        synthesizer: "architect",
      },
    },
  });

  assert.equal(result.migrated, true);
  assert.equal(result.config.participants["architect"]?.connector, "codex");
  assert.equal(result.config.participants["analyst"]?.connector, "antigravity");
  assert.equal(result.warnings.length, 1);
  assert.doesNotThrow(() => validateConfig(result.config));
});

void test("configuration validation rejects dangling semantic references", () => {
  const invalid = structuredClone(defaultConfig);
  invalid.defaults.profile = "missing-profile";
  const participant = invalid.participants["codex-architect"];
  const profile = invalid.profiles["balanced"];
  assert.ok(participant);
  assert.ok(profile);
  participant.connector = "missing-connector";
  profile.participants.push("missing-participant");
  assert.throws(
    () => validateConfig(invalid),
    /Default profile missing-profile.*unknown connector.*unknown participant/u,
  );
});

void test("config writes are atomic and preserve the previous version", () => {
  const directory = mkdtempSync(join(tmpdir(), "switch-config-"));
  const path = join(directory, "config.json");
  try {
    saveConfig(defaultConfig, path);
    const changed: SwitchConfig = {
      ...defaultConfig,
      defaults: { ...defaultConfig.defaults, profile: "quick" },
    };
    saveConfig(changed, path);

    const backups = readdirSync(directory).filter((name) => name.startsWith("config.json.bak-"));
    assert.equal(backups.length, 1);
    assert.equal(validateConfig(JSON.parse(readFileSync(path, "utf8"))).defaults.profile, "quick");
    assert.equal(
      validateConfig(JSON.parse(readFileSync(join(directory, backups[0] ?? ""), "utf8"))).defaults
        .profile,
      "balanced",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
