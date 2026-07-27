import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { Command, Option } from "commander";
import { buildHttpServer } from "./api/server.js";
import { createSwitchRuntime, type SwitchRuntime } from "./application/runtime.js";
import { SetupService } from "./application/setup-service.js";
import { SWITCH_VERSION } from "./domain/version.js";
import { parseConfig, saveConfig, validateConfig } from "./config/load.js";
import {
  cloneParticipant,
  cloneProfile,
  updateParticipant,
  updateProfile,
  type ParticipantPatch,
  type ProfilePatch,
} from "./config/manage.js";
import { getSwitchPaths } from "./config/paths.js";
import { asRouterSessionId, asRunId } from "./domain/ids.js";
import { loadDataset } from "./evaluation/dataset.js";
import { PaseoRpcServer } from "./integrations/paseo-rpc.js";
import { ProtocolRegistry } from "./protocol/registry.js";
import { RoutedRunOrchestrator } from "./routing/orchestrator.js";
import { BackupService, defaultBackupName } from "./persistence/backup.js";
import { RunExportService } from "./persistence/run-export.js";
import { runTui } from "./tui/index.js";

function print(value: unknown, json = false): void {
  if (json || typeof value !== "string") {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else {
    process.stdout.write(`${value}\n`);
  }
}

function setExecutionExitCode(status: string): void {
  if (status === "failed" || status === "cancelled") process.exitCode = 1;
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function collectOption(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

interface ParticipantEditOptions {
  readonly enable?: boolean;
  readonly disable?: boolean;
  readonly connector?: string;
  readonly model?: string;
  readonly displayName?: string;
  readonly role?: string;
  readonly mandate?: string;
  readonly expertise?: string[];
  readonly tag?: string[];
}

function participantPatch(options: ParticipantEditOptions): ParticipantPatch {
  if (options.enable && options.disable) {
    throw new Error("--enable and --disable cannot be used together.");
  }
  return {
    ...(options.enable ? { enabled: true } : {}),
    ...(options.disable ? { enabled: false } : {}),
    ...(options.connector ? { connector: options.connector } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.displayName ? { displayName: options.displayName } : {}),
    ...(options.role ? { role: options.role } : {}),
    ...(options.mandate !== undefined ? { mandate: options.mandate } : {}),
    ...(options.expertise ? { expertise: options.expertise } : {}),
    ...(options.tag ? { tags: options.tag } : {}),
  };
}

interface ProfileEditOptions {
  readonly label?: string;
  readonly description?: string;
  readonly mode?: "direct" | "council" | "routed";
  readonly protocol?: string;
  readonly participant?: string[];
  readonly synthesizer?: string;
  readonly router?: string;
  readonly rounds?: number;
}

function profilePatch(options: ProfileEditOptions): ProfilePatch {
  return {
    ...(options.label ? { label: options.label } : {}),
    ...(options.description !== undefined ? { description: options.description } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.protocol ? { protocol: options.protocol } : {}),
    ...(options.participant ? { participants: options.participant } : {}),
    ...(options.synthesizer ? { synthesizer: options.synthesizer } : {}),
    ...(options.router ? { router: options.router } : {}),
    ...(options.rounds !== undefined ? { critiqueRounds: options.rounds } : {}),
  };
}

async function runRpcCompatibility(argv: readonly string[]): Promise<void> {
  const cwd = optionValue(argv, "--cwd") ?? process.cwd();
  const runtime = createSwitchRuntime({ cwd });
  try {
    const requestedProfile =
      optionValue(argv, "--model")?.replace(/^switch\//, "") ?? optionValue(argv, "--profile");
    const thinkingValue = optionValue(argv, "--thinking");
    const thinking =
      thinkingValue === "low" || thinkingValue === "medium" || thinkingValue === "high"
        ? thinkingValue
        : "high";
    await new PaseoRpcServer({
      runtime,
      cwd,
      ...(requestedProfile ? { profileId: requestedProfile } : {}),
      thinking,
    }).run();
  } finally {
    runtime.close();
  }
}

function shouldLaunchTui(argv: readonly string[]): boolean {
  if (argv.includes("--help") || argv.includes("-h")) return false;
  if (argv.includes("--version") || argv.includes("-V")) return false;
  if (argv.includes("--json")) return false;
  if (argv.length === 0) return true;
  const head = argv[0];
  return head === "tui" || head === "chat" || head === "ui";
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (optionValue(argv, "--mode") === "rpc") {
    await runRpcCompatibility(argv);
    return;
  }

  // Interactive full-screen UI (default when no subcommand)
  if (shouldLaunchTui(argv)) {
    const cwd = optionValue(argv, "--cwd") ?? process.cwd();
    const runtime = createSwitchRuntime({ cwd });
    try {
      await runTui({ runtime, cwd });
    } finally {
      runtime.close();
    }
    return;
  }

  const program = new Command()
    .name("switch")
    .description("Standalone LLM councils, dynamic routing, and test-time compute.")
    .version(SWITCH_VERSION)
    .option("--json", "emit machine-readable JSON");
  let runtime: SwitchRuntime | undefined;
  const getRuntime = (cwd = process.cwd()): SwitchRuntime => {
    runtime ??= createSwitchRuntime({ cwd });
    return runtime;
  };
  const jsonOutput = (): boolean => Boolean(program.opts<{ json?: boolean }>().json);

  program
    .command("tui")
    .alias("chat")
    .alias("ui")
    .description("Open the interactive Switch terminal UI.")
    .option("--cwd <path>", "workspace", process.cwd())
    .action(async (options: { cwd: string }) => {
      await runTui({ runtime: getRuntime(options.cwd), cwd: options.cwd });
    });

  program
    .command("ask")
    .description("Run a direct participant or council profile.")
    .argument("<query...>")
    .option("-p, --profile <id>", "profile ID")
    .option("--protocol <id>", "override the profile protocol")
    .option("--participant <id>", "override participant (repeatable)", collectOption)
    .option("--synthesizer <id>", "override synthesizer")
    .option("--rounds <count>", "critique rounds", Number.parseInt)
    .option("--cwd <path>", "workspace passed to participants", process.cwd())
    .addOption(
      new Option("--thinking <level>", "reasoning effort")
        .choices(["low", "medium", "high"])
        .default("high"),
    )
    .action(
      async (
        query: string[],
        options: {
          profile?: string;
          protocol?: string;
          participant?: string[];
          synthesizer?: string;
          rounds?: number;
          cwd: string;
          thinking: "low" | "medium" | "high";
        },
      ) => {
        const app = getRuntime(options.cwd);
        const result = await app.runs.run(
          {
            query: query.join(" "),
            ...(options.profile ? { profileId: options.profile } : {}),
            ...(options.protocol ? { protocolId: options.protocol } : {}),
            ...(options.participant ? { participants: options.participant } : {}),
            ...(options.synthesizer ? { synthesizer: options.synthesizer } : {}),
            ...(options.rounds !== undefined ? { critiqueRounds: options.rounds } : {}),
          },
          {
            cwd: options.cwd,
            thinking: options.thinking,
            onProgress: (progress) => {
              if (!jsonOutput()) process.stderr.write(`[${progress.phase}] ${progress.message}\n`);
            },
          },
        );
        print(jsonOutput() ? result : (result.decision?.answer ?? result.run), jsonOutput());
        setExecutionExitCode(result.run.status);
      },
    );

  program
    .command("route")
    .description("Ask the selected router to propose and optionally execute a plan.")
    .argument("<query...>")
    .option("-p, --profile <id>", "router profile", "router-balanced")
    .option("--router <participant>", "router participant")
    .option("--session <id>", "persistent router session ID")
    .option("--deterministic", "use the deterministic router")
    .option("--execute", "execute the accepted route")
    .option("--cwd <path>", "workspace passed to participants", process.cwd())
    .action(
      async (
        query: string[],
        options: {
          profile: string;
          router?: string;
          session?: string;
          deterministic?: boolean;
          execute?: boolean;
          cwd: string;
        },
      ) => {
        const app = getRuntime(options.cwd);
        const request = {
          query: query.join(" "),
          profileId: options.profile,
          cwd: options.cwd,
          ...(options.router ? { routerParticipantId: options.router } : {}),
          ...(options.session ? { sessionId: asRouterSessionId(options.session) } : {}),
          ...(options.deterministic ? { deterministic: true } : {}),
        };
        if (options.execute) {
          const result = await new RoutedRunOrchestrator(app.router, app.runs, app.repository).run(
            request,
            {
              cwd: options.cwd,
              onProgress: (progress) => {
                if (!jsonOutput()) {
                  const who = progress.displayName ?? progress.participantId;
                  process.stderr.write(
                    `[${progress.phase}]${who ? ` ${who}` : ""} ${progress.message}\n`,
                  );
                }
              },
            },
          );
          print(jsonOutput() ? result : (result.decision?.answer ?? result.run), jsonOutput());
          setExecutionExitCode(result.run.status);
        } else {
          print(await app.router.route(request), true);
        }
      },
    );

  program
    .command("profiles")
    .description("List configured execution profiles.")
    .action(() => {
      const profiles = getRuntime().loadedConfig.config.profiles;
      if (jsonOutput()) print(profiles, true);
      else {
        for (const [id, profile] of Object.entries(profiles)) {
          process.stdout.write(
            `${id.padEnd(24)} ${profile.mode.padEnd(8)} ${profile.label}: ${profile.description}\n`,
          );
        }
      }
    });

  program
    .command("protocols")
    .description("List built-in council and debate protocols.")
    .action(() => {
      const protocols = new ProtocolRegistry().list();
      if (jsonOutput()) print(protocols, true);
      else {
        protocols.forEach((protocol) =>
          process.stdout.write(
            `${protocol.id.padEnd(32)} ${protocol.status.padEnd(12)} ${protocol.name}\n`,
          ),
        );
      }
    });

  program
    .command("participants")
    .alias("roster")
    .description("List configured participants and assigned roles.")
    .action(() => {
      const config = getRuntime().loadedConfig.config;
      if (jsonOutput()) print(config.participants, true);
      else {
        for (const [id, participant] of Object.entries(config.participants)) {
          process.stdout.write(
            `${participant.enabled ? "on " : "off"} ${id.padEnd(22)} ${(participant.role ?? participant.kind).padEnd(22)} ${participant.connector}/${participant.model ?? "default"}\n`,
          );
        }
      }
    });

  program
    .command("doctor")
    .description("Check connector availability and external CLI authentication surfaces.")
    .option("--cwd <path>", "workspace", process.cwd())
    .action(async (options: { cwd: string }) => {
      const app = getRuntime(options.cwd);
      const status = await new SetupService(
        app.loadedConfig.config,
        app.registry,
        process.env,
      ).status(options.cwd);
      if (jsonOutput()) print(status, true);
      else {
        for (const item of status) {
          const result = item.health;
          process.stdout.write(
            `${item.access.padEnd(15)} ${item.provider.id.padEnd(16)} ${result?.version ?? ""} ${item.remediation}\n`,
          );
        }
      }
    });

  program
    .command("setup")
    .description("Interactive multi-provider setup (or --status for a report).")
    .option("--cwd <path>", "workspace", process.cwd())
    .option("--status", "print provider status as JSON and exit")
    .action(async (options: { cwd: string; status?: boolean }) => {
      const app = getRuntime(options.cwd);
      const setup = new SetupService(app.loadedConfig.config, app.registry, process.env);
      const status = await setup.status(options.cwd);
      if (options.status || jsonOutput()) {
        print(status, true);
        return;
      }
      // Non-TTY: print guidance and open TUI setup when possible
      if (!process.stdin.isTTY) {
        print(
          {
            note: "Run `switch` (TUI) and press s, or `switch setup` in a TTY.",
            status,
          },
          true,
        );
        return;
      }
      await runTui({ runtime: app, cwd: options.cwd });
    });

  program
    .command("connect")
    .description("Verify a connector whose credentials remain owned by its official CLI.")
    .argument("<connector>")
    .option("--cwd <path>", "workspace", process.cwd())
    .option("--login", "run the official CLI login handoff when available")
    .action(async (connectorId: string, options: { cwd: string; login?: boolean }) => {
      const app = getRuntime(options.cwd);
      const setup = new SetupService(app.loadedConfig.config, app.registry, process.env);
      if (options.login) {
        print(await setup.runOfficialLogin(connectorId), true);
      }
      const connector = app.loadedConfig.config.connectors[connectorId];
      if (!connector && connectorId !== "openrouter") {
        throw new Error(`Unknown connector ${connectorId}.`);
      }
      const health =
        connector !== undefined
          ? await app.registry.connector(connectorId).health(connector, {
              cwd: options.cwd,
              environment: process.env,
            })
          : undefined;
      print(
        {
          connector: connectorId,
          authOwner: connector
            ? app.registry.connector(connectorId).manifest.authOwner
            : "environment",
          health,
          note: "Switch does not read subscription credentials. Authenticate with the connector's official CLI.",
        },
        true,
      );
    });

  program
    .command("plugins")
    .description("Validate and list installed plugin manifests and trust decisions.")
    .action(() => print(getRuntime().plugins.discover(), true));

  const runs = program.command("runs").description("Inspect and control durable runs.");
  runs.command("list").action(() => print(getRuntime().repository.listRuns(), true));
  runs
    .command("show")
    .argument("<run-id>")
    .action((runId: string) => print(getRuntime().runs.inspect(asRunId(runId)), true));
  runs
    .command("cancel")
    .argument("<run-id>")
    .action((runId: string) => print(getRuntime().runs.cancel(asRunId(runId)), true));
  runs
    .command("resume")
    .argument("<run-id>")
    .option("--cwd <path>", "workspace", process.cwd())
    .action(async (runId: string, options: { cwd: string }) =>
      print(await getRuntime(options.cwd).runs.resume(asRunId(runId), { cwd: options.cwd }), true),
    );
  runs
    .command("fork")
    .argument("<run-id>")
    .option("--query <query>", "replacement query")
    .action((runId: string, options: { query?: string }) =>
      print(
        getRuntime().runs.fork(asRunId(runId), {
          query: options.query ?? "",
        }),
        true,
      ),
    );
  runs.command("recover").action(() => print(getRuntime().recovery.recover(), true));
  runs
    .command("human-input")
    .argument("<run-id>")
    .argument("<stage-id>")
    .argument("<text...>")
    .option("--cwd <path>", "workspace", process.cwd())
    .action(async (runId: string, stageId: string, text: string[], options: { cwd: string }) =>
      print(
        await getRuntime(options.cwd).runs.submitHumanInput(
          asRunId(runId),
          stageId,
          text.join(" "),
          { cwd: options.cwd },
        ),
        true,
      ),
    );
  runs
    .command("export")
    .argument("<run-id>")
    .argument("<destination>")
    .action((runId: string, destination: string) =>
      print(getRuntime().exports.export(asRunId(runId), destination), true),
    );
  runs
    .command("verify-export")
    .argument("<directory>")
    .action((directory: string) => print(RunExportService.verify(directory), true));

  const evaluation = program
    .command("eval")
    .description("Run and inspect reproducible profile evaluations.");
  evaluation
    .command("run")
    .argument("<dataset>")
    .requiredOption("--profile <id...>", "one or more profiles to compare")
    .option("--cwd <path>", "workspace", process.cwd())
    .option("--concurrency <count>", "parallel trials", Number.parseInt, 1)
    .action(
      async (
        datasetPath: string,
        options: { profile: string[]; cwd: string; concurrency: number },
      ) => {
        const app = getRuntime(options.cwd);
        print(
          await app.evaluationRunner.run({
            dataset: loadDataset(datasetPath),
            profiles: options.profile,
            cwd: options.cwd,
            maxConcurrency: options.concurrency,
          }),
          true,
        );
      },
    );
  evaluation.command("list").action(() => print(getRuntime().evaluations.listExperiments(), true));
  evaluation
    .command("show")
    .argument("<experiment-id>")
    .action((experimentId: string) =>
      print(
        {
          experiment: getRuntime().evaluations.getExperiment(experimentId),
          trials: getRuntime().evaluations.listTrials(experimentId),
        },
        true,
      ),
    );

  const config = program.command("config").description("Inspect and validate configuration.");
  config.command("path").action(() => print(getSwitchPaths().config));
  config.command("show").action(() => print(getRuntime().loadedConfig.config, true));
  config
    .command("validate")
    .argument("[path]")
    .action((path?: string) => {
      const value: unknown = path
        ? parseConfig(readFileSync(path, "utf8"), extname(path))
        : getRuntime().loadedConfig.config;
      print({ valid: true, config: validateConfig(value) }, true);
    });
  config.command("init").action(() => {
    const app = getRuntime();
    print({ path: saveConfig(app.loadedConfig.config) }, true);
  });
  config
    .command("export")
    .description("Export the resolved configuration.")
    .argument("<path>")
    .action((path: string) => {
      const destination = resolve(path);
      print({ path: saveConfig(getRuntime().loadedConfig.config, destination) }, true);
    });
  config
    .command("import")
    .description("Validate and install a complete JSON or YAML configuration.")
    .argument("<path>")
    .action((path: string) => {
      const imported = validateConfig(parseConfig(readFileSync(path, "utf8"), extname(path)));
      print({ path: saveConfig(imported), config: imported }, true);
    });

  const configParticipants = config
    .command("participant")
    .description("Update or clone participant models, roles, and routing metadata.");
  const participantOptions = (command: Command): Command =>
    command
      .option("--enable", "enable the participant")
      .option("--disable", "disable the participant")
      .option("--connector <id>", "connector ID")
      .option("--model <id>", "model ID")
      .option("--display-name <name>", "display name")
      .option("--role <role>", "council role")
      .option("--mandate <text>", "role mandate")
      .option("--expertise <item...>", "replace expertise tags")
      .option("--tag <item...>", "replace routing tags");
  participantOptions(
    configParticipants
      .command("set")
      .description("Update an existing participant.")
      .argument("<id>"),
  ).action((id: string, options: ParticipantEditOptions) => {
    const next = validateConfig(
      updateParticipant(getRuntime().loadedConfig.config, id, participantPatch(options)),
    );
    print({ path: saveConfig(next), participant: next.participants[id] }, true);
  });
  participantOptions(
    configParticipants
      .command("clone")
      .description("Clone a participant before customizing it.")
      .argument("<source-id>")
      .argument("<target-id>"),
  ).action((sourceId: string, targetId: string, options: ParticipantEditOptions) => {
    const next = validateConfig(
      cloneParticipant(
        getRuntime().loadedConfig.config,
        sourceId,
        targetId,
        participantPatch(options),
      ),
    );
    print({ path: saveConfig(next), participant: next.participants[targetId] }, true);
  });

  const configProfiles = config
    .command("profile")
    .description("Update or clone council and router profiles.");
  const profileOptions = (command: Command): Command =>
    command
      .option("--label <label>", "profile label")
      .option("--description <text>", "profile description")
      .addOption(
        new Option("--mode <mode>", "execution mode").choices(["direct", "council", "routed"]),
      )
      .option("--protocol <id>", "protocol ID")
      .option("--participant <id...>", "replace council membership")
      .option("--synthesizer <id>", "synthesizer participant")
      .option("--router <id>", "router participant")
      .option("--rounds <count>", "critique rounds", Number.parseInt);
  profileOptions(
    configProfiles.command("set").description("Update an existing profile.").argument("<id>"),
  ).action((id: string, options: ProfileEditOptions) => {
    const next = validateConfig(
      updateProfile(getRuntime().loadedConfig.config, id, profilePatch(options)),
    );
    print({ path: saveConfig(next), profile: next.profiles[id] }, true);
  });
  profileOptions(
    configProfiles
      .command("clone")
      .description("Clone a profile before customizing it.")
      .argument("<source-id>")
      .argument("<target-id>"),
  ).action((sourceId: string, targetId: string, options: ProfileEditOptions) => {
    const next = validateConfig(
      cloneProfile(getRuntime().loadedConfig.config, sourceId, targetId, profilePatch(options)),
    );
    print({ path: saveConfig(next), profile: next.profiles[targetId] }, true);
  });

  const database = program
    .command("db")
    .description("Inspect, back up, verify, and restore local durable state.");
  database.command("status").action(() => {
    const app = getRuntime();
    app.database.integrityCheck();
    print(
      {
        database: app.paths.database,
        artifacts: app.paths.artifacts,
        integrity: "ok",
        migrations: app.database.migrationStatus(),
      },
      true,
    );
  });
  database
    .command("backup")
    .argument("[destination]")
    .action(async (destination?: string) => {
      const app = getRuntime();
      const path = destination ?? defaultBackupName(app.paths.home);
      print({ path, manifest: await app.backups.create(path) }, true);
    });
  database
    .command("verify-backup")
    .argument("<source>")
    .action((source: string) => print(BackupService.verify(source), true));
  database
    .command("restore")
    .argument("<source>")
    .requiredOption("--force", "replace existing local database and artifacts")
    .action((source: string, options: { force: boolean }) => {
      if (runtime) throw new Error("Restore must run before opening the Switch database.");
      const paths = getSwitchPaths();
      BackupService.restore(source, paths, { force: options.force });
      print({ restored: true, source, database: paths.database }, true);
    });

  program
    .command("serve")
    .description("Start the local versioned HTTP and SSE API.")
    .option("--host <host>", "listen host", "127.0.0.1")
    .option("--port <port>", "listen port", Number.parseInt, 8787)
    .option("--token <token>", "bearer token (required outside loopback)")
    .action(async (options: { host: string; port: number; token?: string }) => {
      if (
        options.host !== "127.0.0.1" &&
        options.host !== "::1" &&
        options.host !== "localhost" &&
        !options.token
      ) {
        throw new Error("--token is required when binding outside loopback.");
      }
      const app = buildHttpServer(getRuntime(), {
        ...(options.token ? { token: options.token } : {}),
      });
      await app.listen({ host: options.host, port: options.port });
      process.stdout.write(`Switch API listening at http://${options.host}:${options.port}\n`);
      await new Promise<void>((resolve) => {
        const stop = (): void => {
          void app.close().finally(resolve);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    });

  try {
    await program.parseAsync(argv, { from: "user" });
  } finally {
    runtime?.close();
  }
}
