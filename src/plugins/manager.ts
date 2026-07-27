import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import semver from "semver";
import { canonicalJson, hashObject, sha256 } from "../domain/hash.js";
import { compileValidator } from "../schema/validator.js";
import { JsonRpcPluginConnector } from "./json-rpc-connector.js";
import { PluginManifestSchema, type PluginManifest } from "./schema.js";

const validateManifest = compileValidator(PluginManifestSchema);

export interface LoadedPlugin {
  readonly root: string;
  readonly manifest: PluginManifest;
  readonly manifestHash: string;
  readonly packageHash: string;
  readonly warnings: readonly string[];
}

export interface PluginDiagnostic {
  readonly path: string;
  readonly status: "loaded" | "denied" | "invalid";
  readonly message: string;
  readonly plugin?: LoadedPlugin;
}

export function computePluginPackageHash(root: string): string {
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Plugin root ${root} must be a regular directory.`);
  }
  const entries: string[] = [];
  let totalBytes = 0;
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Plugin package contains symlink ${path}.`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        if (entries.length >= 1_000) throw new Error("Plugin package has too many files.");
        const raw = readFileSync(path);
        totalBytes += raw.byteLength;
        if (totalBytes > 100 * 1024 * 1024) {
          throw new Error("Plugin package exceeds the 100 MiB limit.");
        }
        let content: string | Uint8Array = raw;
        if (basename(path) === "switch-plugin.json") {
          const manifest = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
          delete manifest["packageHash"];
          content = canonicalJson(manifest);
        }
        const packagePath = relative(root, path).split(sep).join("/");
        entries.push(`${packagePath}\0${sha256(content)}`);
      }
    }
  };
  walk(root);
  return sha256(entries.join("\n"));
}

export class PluginManager {
  constructor(
    readonly root: string,
    private readonly options: {
      readonly trustedPluginIds?: readonly string[];
      readonly allowUntrusted?: boolean;
      readonly allowUnsafeNetwork?: boolean;
    } = {},
  ) {}

  discover(): readonly PluginDiagnostic[] {
    let directories: string[];
    try {
      directories = readdirSync(this.root);
    } catch {
      return [];
    }
    return directories.sort().map((name) => {
      const root = join(this.root, name);
      const path = join(root, "switch-plugin.json");
      try {
        const rootStat = lstatSync(root);
        if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
          throw new Error(`Plugin root ${root} must be a regular directory.`);
        }
        const manifest = validateManifest(JSON.parse(readFileSync(path, "utf8")));
        if (!semver.valid(manifest.version)) {
          throw new Error(`Plugin version ${manifest.version} is not valid semantic versioning.`);
        }
        if (basename(root) !== manifest.id) {
          throw new Error(`Plugin directory must be named ${manifest.id}.`);
        }
        const trusted =
          this.options.allowUntrusted === true ||
          this.options.trustedPluginIds?.includes(manifest.id) === true;
        if (!trusted) {
          return {
            path,
            status: "denied",
            message: "Plugin is not explicitly trusted.",
          } satisfies PluginDiagnostic;
        }
        if (manifest.permissions.network !== "none" && !this.options.allowUnsafeNetwork) {
          return {
            path,
            status: "denied",
            message: "Tier 0 cannot enforce network containment; explicitly opt in to this plugin.",
          } satisfies PluginDiagnostic;
        }
        const packageHash = computePluginPackageHash(root);
        if (manifest.packageHash && manifest.packageHash !== packageHash) {
          throw new Error("Plugin package hash does not match its manifest.");
        }
        const warnings =
          manifest.permissions.filesystem === "none"
            ? []
            : [
                "Tier 0 process containment does not enforce filesystem restrictions at the OS boundary.",
              ];
        return {
          path,
          status: "loaded",
          message: "Plugin manifest validated.",
          plugin: {
            root,
            manifest,
            manifestHash: hashObject(manifest),
            packageHash,
            warnings,
          },
        } satisfies PluginDiagnostic;
      } catch (error) {
        return {
          path,
          status: "invalid",
          message: error instanceof Error ? error.message : String(error),
        } satisfies PluginDiagnostic;
      }
    });
  }

  participantConnectors(): readonly JsonRpcPluginConnector[] {
    return this.discover().flatMap((diagnostic) =>
      diagnostic.status === "loaded" && diagnostic.plugin?.manifest.type === "participant"
        ? [new JsonRpcPluginConnector(diagnostic.plugin.manifest, diagnostic.plugin.root)]
        : [],
    );
  }
}
