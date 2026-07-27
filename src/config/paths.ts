import { homedir } from "node:os";
import { join } from "node:path";

export interface SwitchPaths {
  readonly home: string;
  readonly config: string;
  readonly database: string;
  readonly artifacts: string;
  readonly cache: string;
  readonly logs: string;
  readonly plugins: string;
}

export function getSwitchPaths(environment: NodeJS.ProcessEnv = process.env): SwitchPaths {
  const home = environment["SWITCH_HOME"] ?? join(homedir(), ".switch");
  return {
    home,
    config: environment["SWITCH_CONFIG"] ?? join(home, "config.json"),
    database: environment["SWITCH_DATABASE"] ?? join(home, "data", "switch.sqlite"),
    artifacts: environment["SWITCH_ARTIFACTS"] ?? join(home, "artifacts"),
    cache: join(home, "cache"),
    logs: join(home, "logs"),
    plugins: join(home, "plugins"),
  };
}
