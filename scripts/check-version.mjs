import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const versionSource = readFileSync(join(root, "src", "domain", "version.ts"), "utf8");
const match = /SWITCH_VERSION\s*=\s*"([^"]+)"/u.exec(versionSource);

if (!match) {
  throw new Error("Could not read SWITCH_VERSION from src/domain/version.ts.");
}

if (packageJson.version !== match[1]) {
  throw new Error(
    `Version mismatch: package.json=${packageJson.version}, SWITCH_VERSION=${match[1]}.`,
  );
}

process.stdout.write(`Version ${packageJson.version} is consistent.\n`);
