import { loadConfig, type LoadedConfig } from "../config/load.js";
import { getSwitchPaths, type SwitchPaths } from "../config/paths.js";
import { createDefaultRegistry } from "../connectors/index.js";
import { FileArtifactStore } from "../persistence/artifact-store.js";
import { SwitchDatabase } from "../persistence/database.js";
import { RunRepository } from "../persistence/run-repository.js";
import { PluginManager } from "../plugins/manager.js";
import { RouterService } from "../routing/router-service.js";
import { RouterSessionStore } from "../routing/session-store.js";
import { RunExecutor } from "../runtime/executor.js";
import { RecoveryService } from "../runtime/recovery.js";
import { RunService } from "../runtime/run-service.js";
import { InvocationScheduler } from "../runtime/scheduler.js";
import { EvaluationRepository } from "../evaluation/repository.js";
import { EvaluationRunner } from "../evaluation/runner.js";
import { BackupService } from "../persistence/backup.js";
import { RunExportService } from "../persistence/run-export.js";

export interface SwitchRuntime {
  readonly loadedConfig: LoadedConfig;
  readonly paths: SwitchPaths;
  readonly database: SwitchDatabase;
  readonly repository: RunRepository;
  readonly registry: ReturnType<typeof createDefaultRegistry>;
  readonly plugins: PluginManager;
  readonly runs: RunService;
  readonly router: RouterService;
  readonly recovery: RecoveryService;
  readonly evaluations: EvaluationRepository;
  readonly evaluationRunner: EvaluationRunner;
  readonly backups: BackupService;
  readonly exports: RunExportService;
  readonly scheduler: InvocationScheduler;
  close(): void;
}

export function createSwitchRuntime(
  options: {
    readonly cwd?: string;
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
): SwitchRuntime {
  const environment = options.environment ?? process.env;
  const loadedConfig = loadConfig({
    ...(options.cwd ? { cwd: options.cwd } : {}),
    environment,
  });
  const paths = getSwitchPaths(environment);
  const database = new SwitchDatabase(paths.database);
  const repository = new RunRepository(database);
  const registry = createDefaultRegistry(loadedConfig.config);
  const pluginPolicy = loadedConfig.config.plugins;
  const plugins = new PluginManager(paths.plugins, {
    trustedPluginIds: pluginPolicy?.trustedPluginIds ?? [],
    allowUntrusted: pluginPolicy?.allowUntrusted ?? false,
    allowUnsafeNetwork: pluginPolicy?.allowUnsafeNetwork ?? false,
  });
  for (const connector of plugins.participantConnectors()) registry.register(connector);
  const artifacts = new FileArtifactStore(paths.artifacts);
  const scheduler = new InvocationScheduler({
    maxConcurrency: loadedConfig.config.defaults.maxConcurrency,
    perConnectorConcurrency: loadedConfig.config.defaults.maxConcurrency,
  });
  const executor = new RunExecutor(repository, artifacts, registry, scheduler);
  const runs = new RunService(loadedConfig.config, registry, repository, executor);
  const router = new RouterService(loadedConfig.config, registry, new RouterSessionStore(database));
  const recovery = new RecoveryService(repository, loadedConfig.config);
  const evaluations = new EvaluationRepository(database);
  const evaluationRunner = new EvaluationRunner(runs, evaluations);
  const backups = new BackupService(database, paths);
  const exports = new RunExportService(repository);
  return {
    loadedConfig,
    paths,
    database,
    repository,
    registry,
    plugins,
    runs,
    router,
    recovery,
    evaluations,
    evaluationRunner,
    backups,
    exports,
    scheduler,
    close: () => database.close(),
  };
}
