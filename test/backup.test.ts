import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSwitchRuntime } from "../src/application/runtime.js";
import { getSwitchPaths } from "../src/config/paths.js";
import { sha256 } from "../src/domain/hash.js";
import { BackupService } from "../src/persistence/backup.js";
import { SwitchDatabase } from "../src/persistence/database.js";
import { RunRepository } from "../src/persistence/run-repository.js";
import { RunExportService } from "../src/persistence/run-export.js";

void test("backup, verification, restore, and run export preserve inspectable state", async () => {
  const root = mkdtempSync(join(tmpdir(), "switch-backup-"));
  const sourceHome = join(root, "source");
  const backupPath = join(root, "backup");
  const exportPath = join(root, "run-export");
  const targetHome = join(root, "target");
  const runtime = createSwitchRuntime({
    environment: { ...process.env, SWITCH_HOME: sourceHome },
  });
  try {
    const run = runtime.runs.create({
      query: "Backup test",
      profileId: "quick",
    });
    const manifest = await runtime.backups.create(backupPath);
    assert.equal(manifest.apiVersion, "switch.dev/backup/v1alpha1");
    assert.equal(BackupService.verify(backupPath).database, "switch.sqlite");
    const backupManifestPath = join(backupPath, "manifest.json");
    const originalBackupManifest = readFileSync(backupManifestPath, "utf8");
    const incompleteBackupManifest = JSON.parse(originalBackupManifest) as {
      checksums: Record<string, string>;
    };
    delete incompleteBackupManifest.checksums["switch.sqlite"];
    writeFileSync(backupManifestPath, `${JSON.stringify(incompleteBackupManifest, null, 2)}\n`);
    assert.throws(() => BackupService.verify(backupPath), /inventory does not match/);
    writeFileSync(backupManifestPath, originalBackupManifest);

    const exportManifest = runtime.exports.export(run.id, exportPath);
    assert.equal(exportManifest.runId, run.id);
    assert.equal(existsSync(join(exportPath, "events.jsonl")), true);
    assert.equal(existsSync(join(exportPath, "manifest.json")), true);
    assert.equal(RunExportService.verify(exportPath).runId, run.id);
    const exportedRun = JSON.parse(readFileSync(join(exportPath, "run.json"), "utf8")) as {
      artifacts: readonly { storagePath: string }[];
    };
    assert.ok(exportedRun.artifacts.every((artifact) => !artifact.storagePath.startsWith("/")));

    const manifestPath = join(exportPath, "manifest.json");
    const eventsPath = join(exportPath, "events.jsonl");
    const originalManifest = readFileSync(manifestPath, "utf8");
    const originalEvents = readFileSync(eventsPath, "utf8");
    const unsafeManifest = JSON.parse(originalManifest) as {
      checksums: Record<string, string>;
    };
    unsafeManifest.checksums["artifacts/../run.json"] = unsafeManifest.checksums["run.json"] ?? "";
    writeFileSync(manifestPath, `${JSON.stringify(unsafeManifest, null, 2)}\n`);
    assert.throws(() => RunExportService.verify(exportPath), /Unsafe run export path/);

    const tamperedEvents = originalEvents
      .trimEnd()
      .split("\n")
      .map((line, index) => {
        if (index !== 0) return line;
        const event = JSON.parse(line) as { payload: Record<string, unknown> };
        event.payload["tampered"] = true;
        return JSON.stringify(event);
      })
      .join("\n")
      .concat("\n");
    const tamperedManifest = JSON.parse(originalManifest) as {
      checksums: Record<string, string>;
    };
    tamperedManifest.checksums["events.jsonl"] = sha256(tamperedEvents);
    writeFileSync(eventsPath, tamperedEvents);
    writeFileSync(manifestPath, `${JSON.stringify(tamperedManifest, null, 2)}\n`);
    assert.throws(() => RunExportService.verify(exportPath), /invalid payload hash/);

    writeFileSync(manifestPath, originalManifest);
    writeFileSync(join(exportPath, "events.jsonl"), "{}\n");
    assert.throws(() => RunExportService.verify(exportPath), /checksum mismatch/);

    const targetPaths = getSwitchPaths({
      ...process.env,
      SWITCH_HOME: targetHome,
    });
    BackupService.restore(backupPath, targetPaths, { force: true });
    const restoredDatabase = new SwitchDatabase(targetPaths.database);
    try {
      restoredDatabase.integrityCheck();
      const restored = new RunRepository(restoredDatabase).getRun(run.id);
      assert.equal(restored.query, "Backup test");
    } finally {
      restoredDatabase.close();
    }
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
