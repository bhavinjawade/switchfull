import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha256 } from "../domain/hash.js";
import type { SwitchPaths } from "../config/paths.js";
import { BackupManifestSchema, compileValidator, type BackupManifest } from "../schema/index.js";
import type { SwitchDatabase } from "./database.js";

export type { BackupManifest } from "../schema/backup.js";

const validateManifest = compileValidator(BackupManifestSchema);

function files(root: string): readonly string[] {
  const output: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Backup contains symlink ${path}.`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) output.push(relative(root, path).split(sep).join("/"));
    }
  };
  walk(root);
  return output;
}

function checksumMap(root: string): Readonly<Record<string, string>> {
  return Object.fromEntries(
    files(root)
      .filter((path) => path !== "manifest.json")
      .map((path) => [path, sha256(readFileSync(join(root, path)))]),
  );
}

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
    throw new Error(`Unsafe backup path ${path}.`);
  }
  const resolved = resolve(root, path);
  const traversal = relative(resolve(root), resolved);
  if (traversal.startsWith("..") || traversal === "") {
    throw new Error(`Unsafe backup path ${path}.`);
  }
  return resolved;
}

export class BackupService {
  constructor(
    private readonly database: SwitchDatabase,
    private readonly paths: SwitchPaths,
  ) {}

  async create(destination: string): Promise<BackupManifest> {
    if (existsSync(destination)) {
      throw new Error(`Backup destination already exists: ${destination}`);
    }
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    try {
      await this.database.backup(join(destination, "switch.sqlite"));
      if (existsSync(this.paths.artifacts)) {
        cpSync(this.paths.artifacts, join(destination, "artifacts"), {
          recursive: true,
          errorOnExist: true,
        });
      } else {
        mkdirSync(join(destination, "artifacts"), { mode: 0o700 });
      }
      const manifest: BackupManifest = {
        apiVersion: "switch.dev/backup/v1alpha1",
        createdAt: new Date().toISOString(),
        database: "switch.sqlite",
        artifacts: "artifacts",
        checksums: checksumMap(destination),
      };
      writeFileSync(join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: 0o600,
      });
      return manifest;
    } catch (error) {
      rmSync(destination, { recursive: true, force: true });
      throw error;
    }
  }

  static verify(source: string): BackupManifest {
    const inventory = files(source)
      .filter((path) => path !== "manifest.json")
      .sort();
    const manifestPath = safeChild(source, "manifest.json");
    const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
    const declared = Object.keys(manifest.checksums).sort();
    if (
      inventory.length !== declared.length ||
      inventory.some((path, index) => path !== declared[index])
    ) {
      throw new Error("Backup manifest checksum inventory does not match backup files.");
    }
    const artifactsPath = safeChild(source, manifest.artifacts);
    const artifactsStat = lstatSync(artifactsPath);
    if (artifactsStat.isSymbolicLink() || !artifactsStat.isDirectory()) {
      throw new Error("Backup artifacts entry must be a regular directory.");
    }
    for (const [path, expected] of Object.entries(manifest.checksums)) {
      const contentPath = safeChild(source, path);
      const actual = sha256(readFileSync(contentPath));
      if (actual !== expected) throw new Error(`Backup checksum mismatch for ${path}.`);
    }
    const verificationDirectory = mkdtempSync(join(tmpdir(), "switch-backup-verify-"));
    const verificationDatabase = join(verificationDirectory, "switch.sqlite");
    let database: DatabaseSync | undefined;
    try {
      copyFileSync(safeChild(source, manifest.database), verificationDatabase);
      database = new DatabaseSync(verificationDatabase, { readOnly: true });
      const result = database.prepare("PRAGMA quick_check").get() as
        Record<string, unknown> | undefined;
      if (!result || !Object.values(result).includes("ok")) {
        throw new Error("Backup SQLite integrity check failed.");
      }
    } finally {
      database?.close();
      rmSync(verificationDirectory, { recursive: true, force: true });
    }
    return manifest;
  }

  static restore(source: string, paths: SwitchPaths, options: { readonly force: boolean }): void {
    const manifest = BackupService.verify(source);
    if (!options.force && (existsSync(paths.database) || existsSync(paths.artifacts))) {
      throw new Error("Restore target contains data; pass --force to replace it.");
    }
    mkdirSync(dirname(paths.database), { recursive: true, mode: 0o700 });
    if (options.force) {
      rmSync(paths.database, { force: true });
      rmSync(`${paths.database}-wal`, { force: true });
      rmSync(`${paths.database}-shm`, { force: true });
      rmSync(paths.artifacts, { recursive: true, force: true });
    }
    cpSync(safeChild(source, manifest.database), paths.database, {
      errorOnExist: true,
    });
    cpSync(safeChild(source, manifest.artifacts), paths.artifacts, {
      recursive: true,
      errorOnExist: true,
    });
  }
}

export function defaultBackupName(home: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(dirname(home), `${basename(home)}-backup-${timestamp}`);
}
