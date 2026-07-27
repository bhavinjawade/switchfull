#!/usr/bin/env node

import { main } from "../src/cli.js";

main().catch((error: unknown) => {
  process.stderr.write(`switch: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
