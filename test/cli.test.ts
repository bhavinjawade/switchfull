import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { defaultConfig } from "../src/config/defaults.js";
import { saveConfig } from "../src/config/load.js";
import type { SwitchConfig } from "../src/schema/config.js";

void test("CLI exits nonzero when a durable execution fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "switch-cli-"));
  const home = join(directory, "home");
  const codex = defaultConfig.connectors["codex"];
  assert.ok(codex);
  const config: SwitchConfig = {
    ...defaultConfig,
    connectors: {
      ...defaultConfig.connectors,
      codex: {
        ...codex,
        command: [process.execPath, "-e", "process.exit(1);"],
      },
    },
  };
  try {
    saveConfig(config, join(home, "config.json"));
    const result = spawnSync(
      process.execPath,
      [
        join(process.cwd(), "dist/bin/switch.js"),
        "--json",
        "ask",
        "--protocol",
        "direct",
        "--participant",
        "codex-architect",
        "test",
      ],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, SWITCH_HOME: home },
      },
    );
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout) as { run?: { status?: string } };
    assert.equal(output.run?.status, "failed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
