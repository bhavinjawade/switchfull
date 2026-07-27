import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "src");
const files = [];

function walk(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith(".ts")) files.push(path);
  }
}

walk(source);

const forbidden = {
  domain: new Set([
    "api",
    "application",
    "config",
    "connectors",
    "evaluation",
    "integrations",
    "persistence",
    "plugins",
    "policy",
    "protocol",
    "routing",
    "runtime",
    "sdk",
  ]),
  schema: new Set([
    "api",
    "application",
    "config",
    "connectors",
    "evaluation",
    "integrations",
    "persistence",
    "plugins",
    "policy",
    "protocol",
    "routing",
    "runtime",
    "sdk",
  ]),
  protocol: new Set(["api", "application", "integrations", "persistence", "runtime"]),
  runtime: new Set(["api", "application", "integrations", "sdk"]),
  persistence: new Set(["api", "application", "integrations", "runtime", "sdk"]),
  connectors: new Set(["api", "application", "integrations", "persistence", "runtime", "sdk"]),
};

const violations = [];
const importPattern = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;

for (const file of files) {
  const fromArea = relative(source, file).split(sep)[0];
  const denied = forbidden[fromArea];
  if (!denied) continue;
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier?.startsWith(".")) continue;
    const target = resolve(dirname(file), specifier);
    const targetArea = relative(source, target).split(sep)[0];
    if (denied.has(targetArea)) {
      violations.push(
        `${relative(root, file)} (${fromArea}) imports forbidden ${targetArea} module ${specifier}`,
      );
    }
  }
}

if (violations.length) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Architecture boundaries valid across ${files.length} source files.\n`);
}
