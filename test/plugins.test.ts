import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { computePluginPackageHash, PluginManager } from "../src/plugins/manager.js";
import type { ResolvedParticipant } from "../src/connectors/port.js";

function manifest(trust: "first-party" | "community"): Record<string, unknown> {
  return {
    apiVersion: "switch.dev/plugin/v1alpha1",
    id: "test-plugin",
    name: "Test Plugin",
    version: "1.0.0",
    type: "participant",
    trust,
    command: [process.execPath, "plugin.mjs"],
    connector: {
      apiVersion: "switch.dev/connector/v1alpha1",
      id: "test-plugin",
      name: "Test Plugin",
      version: "1.0.0",
      kind: "model",
      stability: "first-party-beta",
      transport: "process",
      authOwner: "none",
      billingType: "local_compute",
      capabilities: ["text_generation", "cancellation"],
    },
    permissions: {
      filesystem: "none",
      network: "none",
      environment: [],
    },
  };
}

function createPlugin(root: string, trust: "first-party" | "community"): string {
  const pluginRoot = join(root, "test-plugin");
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(join(pluginRoot, "switch-plugin.json"), JSON.stringify(manifest(trust)));
  const source = `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const result = {
    requestId: request.params.request.requestId,
    text: process.env.SWITCH_SECRET_CANARY ?? "isolated",
    usage: { source: "unavailable" }
  };
  process.stdout.write(JSON.stringify({jsonrpc:"2.0", id:request.id, result}) + "\\n");
});
`;
  const executable = join(pluginRoot, "plugin.mjs");
  writeFileSync(executable, source);
  chmodSync(executable, 0o700);
  return pluginRoot;
}

void test("trusted first-party JSON-RPC plugin invokes without ambient secret inheritance", async () => {
  const root = mkdtempSync(join(tmpdir(), "switch-plugins-"));
  try {
    createPlugin(root, "first-party");
    const manager = new PluginManager(root, { trustedPluginIds: ["test-plugin"] });
    const diagnostics = manager.discover();
    assert.equal(diagnostics[0]?.status, "loaded");
    const connector = manager.participantConnectors()[0];
    assert.ok(connector);
    const resolved: ResolvedParticipant = {
      id: "plugin-participant",
      participant: {
        enabled: true,
        kind: "model",
        connector: "test-plugin",
        model: "test",
        displayName: "Plugin",
        expertise: [],
        tags: [],
        config: {},
      },
      connector: {
        kind: "process",
        enabled: true,
        command: [process.execPath, "plugin.mjs"],
        environmentAllowlist: [],
        secrets: {},
        billingType: "local_compute",
        config: {},
      },
      snapshot: {
        id: "plugin-participant",
        kind: "model",
        connectorId: "test-plugin",
        connectorVersion: "1.0.0",
        model: "test",
        displayName: "Plugin",
        capabilities: ["text_generation", "cancellation"],
        expertise: [],
        billingType: "local_compute",
        privacyClass: "local",
        configHash: "0".repeat(64),
      },
    };
    const result = await connector.invoke(
      resolved,
      {
        requestId: crypto.randomUUID(),
        messages: [{ role: "user", content: "test" }],
      },
      {
        cwd: process.cwd(),
        timeoutMs: 5_000,
        environment: {
          ...process.env,
          SWITCH_SECRET_CANARY: "must-not-leak",
        },
      },
    );
    assert.equal(result.text, "isolated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("community plugins require explicit trust", () => {
  const root = mkdtempSync(join(tmpdir(), "switch-community-plugin-"));
  try {
    createPlugin(root, "community");
    assert.equal(new PluginManager(root).discover()[0]?.status, "denied");
    assert.equal(
      new PluginManager(root, { trustedPluginIds: ["test-plugin"] }).discover()[0]?.status,
      "loaded",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("self-declared first-party trust does not bypass explicit user trust", () => {
  const root = mkdtempSync(join(tmpdir(), "switch-spoofed-plugin-"));
  try {
    createPlugin(root, "first-party");
    assert.equal(new PluginManager(root).discover()[0]?.status, "denied");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("plugin package hashes are reproducible with the hash embedded in the manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "switch-hashed-plugin-"));
  try {
    const pluginRoot = createPlugin(root, "community");
    const path = join(pluginRoot, "switch-plugin.json");
    const value = JSON.parse(readFileSync(path, "utf8")) as ReturnType<typeof manifest> & {
      packageHash?: string;
    };
    value.packageHash = computePluginPackageHash(pluginRoot);
    writeFileSync(path, JSON.stringify(value));
    assert.equal(
      new PluginManager(root, { trustedPluginIds: ["test-plugin"] }).discover()[0]?.status,
      "loaded",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("plugin discovery rejects symlinked package roots", () => {
  const root = mkdtempSync(join(tmpdir(), "switch-symlink-plugin-root-"));
  const target = mkdtempSync(join(tmpdir(), "switch-symlink-plugin-target-"));
  try {
    const pluginRoot = createPlugin(target, "community");
    symlinkSync(pluginRoot, join(root, "test-plugin"), "dir");
    const diagnostic = new PluginManager(root, {
      trustedPluginIds: ["test-plugin"],
    }).discover()[0];
    assert.equal(diagnostic?.status, "invalid");
    assert.match(diagnostic?.message ?? "", /regular directory/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
