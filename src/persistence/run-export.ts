import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { hashObject, sha256 } from "../domain/hash.js";
import type { RunId } from "../domain/ids.js";
import { SWITCH_VERSION } from "../domain/version.js";
import {
  RunEventEnvelopeSchema,
  RunExportManifestSchema,
  compileValidator,
  type RunExportManifest,
} from "../schema/index.js";
import type { RunRepository } from "./run-repository.js";

export type { RunExportManifest } from "../schema/run-export.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const validateManifest = compileValidator(RunExportManifestSchema);
const validateEvent = compileValidator(RunEventEnvelopeSchema);

function safeChild(root: string, path: string): string {
  if (
    !path ||
    path.includes("\0") ||
    path.includes("\\") ||
    isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path === "." ||
    path.startsWith("../")
  ) {
    throw new Error(`Unsafe run export path ${path}.`);
  }
  const resolved = resolve(root, path);
  const traversal = relative(resolve(root), resolved);
  if (traversal.startsWith("..") || traversal === "") {
    throw new Error(`Unsafe run export path ${path}.`);
  }
  return resolved;
}

function regularFile(root: string, path: string): Buffer {
  const fullPath = safeChild(root, path);
  const stat = lstatSync(fullPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Run export entry ${path} must be a regular file.`);
  }
  const realRoot = realpathSync(root);
  const realFile = realpathSync(fullPath);
  const realTraversal = relative(realRoot, realFile);
  if (realTraversal.startsWith("..") || realTraversal === "") {
    throw new Error(`Run export entry ${path} escapes the export directory.`);
  }
  return readFileSync(realFile);
}

function verifiedFile(root: string, path: string, expectedHash: string): Buffer {
  const content = regularFile(root, path);
  if (sha256(content) !== expectedHash) {
    throw new Error(`Run export checksum mismatch for ${path}.`);
  }
  return content;
}

export class RunExportService {
  constructor(private readonly repository: RunRepository) {}

  export(runId: RunId, destination: string): RunExportManifest {
    if (existsSync(destination)) {
      throw new Error(`Export destination already exists: ${destination}`);
    }
    const sourceArtifacts = this.repository.getArtifacts(runId);
    const inspected = {
      run: this.repository.getRun(runId),
      stages: this.repository.getStages(runId),
      attempts: this.repository.getAttempts(runId),
      participants: this.repository.getParticipantSnapshots(runId),
      artifacts: sourceArtifacts.map((artifact) => ({
        ...artifact,
        storagePath: `artifacts/${artifact.id}`,
      })),
    };
    const events = this.repository.getEvents(runId);
    mkdirSync(join(destination, "artifacts"), { recursive: true, mode: 0o700 });
    const checksums: Record<string, string> = {};
    const write = (path: string, content: string): void => {
      const fullPath = join(destination, path);
      writeFileSync(fullPath, content, { mode: 0o600 });
      checksums[path] = sha256(content);
    };
    write("run.json", `${JSON.stringify(inspected, null, 2)}\n`);
    write("events.jsonl", `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    for (const artifact of sourceArtifacts) {
      const path = `artifacts/${artifact.id}`;
      copyFileSync(artifact.storagePath, join(destination, path));
      const content = readFileSync(join(destination, path));
      const hash = sha256(content);
      if (hash !== artifact.contentHash) {
        throw new Error(`Artifact ${artifact.id} failed integrity validation during export.`);
      }
      checksums[path] = hash;
    }
    const manifest: RunExportManifest = {
      apiVersion: "switch.dev/run-export/v1alpha1",
      switchVersion: SWITCH_VERSION,
      createdAt: new Date().toISOString(),
      runId,
      parentRunId: inspected.run.parentRunId ?? null,
      included: ["run", "stages", "attempts", "participants", "events", "artifacts"],
      omitted: ["credentials", "secret-values", "machine-local-storage-paths"],
      checksums,
    };
    writeFileSync(join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    return manifest;
  }

  static verify(source: string): RunExportManifest {
    const manifest = validateManifest(
      JSON.parse(regularFile(source, "manifest.json").toString("utf8")) as unknown,
    );
    for (const [path, expected] of Object.entries(manifest.checksums)) {
      verifiedFile(source, path, expected);
    }
    const runChecksum = manifest.checksums["run.json"];
    const eventsChecksum = manifest.checksums["events.jsonl"];
    if (!runChecksum || !eventsChecksum) {
      throw new Error("Run export must include checksummed run.json and events.jsonl files.");
    }
    const inspected = JSON.parse(
      verifiedFile(source, "run.json", runChecksum).toString("utf8"),
    ) as unknown;
    if (!isRecord(inspected) || !isRecord(inspected["run"])) {
      throw new Error("Run export run.json has an invalid structure.");
    }
    if (
      inspected["run"]["id"] !== manifest.runId ||
      (inspected["run"]["parentRunId"] ?? null) !== manifest.parentRunId ||
      !Array.isArray(inspected["artifacts"])
    ) {
      throw new Error("Run export manifest and run.json do not describe the same run.");
    }
    const artifactIds = new Set<string>();
    for (const value of inspected["artifacts"] as unknown[]) {
      if (
        !isRecord(value) ||
        typeof value["id"] !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          value["id"],
        ) ||
        typeof value["contentHash"] !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value["contentHash"])
      ) {
        throw new Error("Run export contains invalid artifact metadata.");
      }
      if (artifactIds.has(value["id"])) {
        throw new Error(`Run export contains duplicate artifact ${value["id"]}.`);
      }
      artifactIds.add(value["id"]);
      const path = `artifacts/${value["id"]}`;
      if (value["storagePath"] !== path || manifest.checksums[path] !== value["contentHash"]) {
        throw new Error(`Run export artifact metadata mismatch for ${value["id"]}.`);
      }
    }
    const eventLines = verifiedFile(source, "events.jsonl", eventsChecksum)
      .toString("utf8")
      .split(/\r?\n/)
      .filter(Boolean);
    if (eventLines.length === 0) {
      throw new Error("Run export must contain at least one run event.");
    }
    let expectedSequence = 1;
    for (const line of eventLines) {
      const event = validateEvent(JSON.parse(line) as unknown);
      if (event.runId !== manifest.runId) {
        throw new Error("Run export contains an event for a different run.");
      }
      if (event.sequence !== expectedSequence) {
        throw new Error(
          `Run export event sequence expected ${expectedSequence} but found ${event.sequence}.`,
        );
      }
      if (event.payloadHash !== hashObject(event.payload)) {
        throw new Error(`Run export event ${event.id} has an invalid payload hash.`);
      }
      expectedSequence += 1;
    }
    return manifest;
  }
}
