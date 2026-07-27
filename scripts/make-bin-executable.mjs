import { chmodSync } from "node:fs";

if (process.platform !== "win32") {
  chmodSync("dist/bin/switch.js", 0o755);
}
