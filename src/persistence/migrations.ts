export interface Migration {
  readonly version: number;
  readonly description: string;
  readonly sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    description: "durable local runtime",
    sql: `
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        parent_run_id TEXT REFERENCES runs(id),
        mode TEXT NOT NULL CHECK (mode IN ('direct', 'council', 'routed')),
        status TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        query TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        config_json TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        usage_json TEXT NOT NULL,
        final_artifact_id TEXT,
        failure_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      ) STRICT;

      CREATE TABLE run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        sequence INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        causation_id TEXT,
        actor TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        UNIQUE (run_id, sequence)
      ) STRICT;

      CREATE TABLE stages (
        run_id TEXT NOT NULL REFERENCES runs(id),
        id TEXT NOT NULL,
        operator TEXT NOT NULL,
        status TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        plan_json TEXT NOT NULL,
        output_artifact_ids_json TEXT NOT NULL DEFAULT '[]',
        failure_json TEXT,
        started_at TEXT,
        completed_at TEXT,
        PRIMARY KEY (run_id, id)
      ) STRICT;

      CREATE TABLE attempts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        stage_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        state TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        provider_request_id TEXT,
        result_artifact_id TEXT,
        started_at TEXT,
        finished_at TEXT,
        timeout_ms INTEGER NOT NULL,
        usage_json TEXT NOT NULL,
        error_json TEXT,
        uncertainty_json TEXT,
        FOREIGN KEY (run_id, stage_id) REFERENCES stages(run_id, id)
      ) STRICT;

      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        stage_id TEXT,
        attempt_id TEXT REFERENCES attempts(id),
        kind TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        media_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        visibility TEXT NOT NULL,
        parent_ids_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE participant_snapshots (
        run_id TEXT NOT NULL REFERENCES runs(id),
        participant_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        snapshot_hash TEXT NOT NULL,
        PRIMARY KEY (run_id, participant_id)
      ) STRICT;

      CREATE TABLE routing_decisions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        router_session_id TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        validation_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX idx_runs_status ON runs(status);
      CREATE INDEX idx_events_run_sequence ON run_events(run_id, sequence);
      CREATE INDEX idx_stages_run_status ON stages(run_id, status);
      CREATE INDEX idx_attempts_run_state ON attempts(run_id, state);
      CREATE INDEX idx_artifacts_run_kind ON artifacts(run_id, kind);
      CREATE UNIQUE INDEX idx_attempts_idempotency
        ON attempts(run_id, stage_id, participant_id, idempotency_key);
    `,
  },
  {
    version: 2,
    description: "persistent router sessions",
    sql: `
      CREATE TABLE router_sessions (
        id TEXT PRIMARY KEY,
        router_participant_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        eligible_participants_json TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        history_json TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX idx_router_sessions_updated ON router_sessions(updated_at);
    `,
  },
  {
    version: 3,
    description: "evaluation experiments and trials",
    sql: `
      CREATE TABLE experiments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        dataset_hash TEXT NOT NULL,
        profiles_json TEXT NOT NULL,
        config_json TEXT NOT NULL,
        status TEXT NOT NULL,
        summary_json TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      ) STRICT;

      CREATE TABLE evaluation_trials (
        id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL REFERENCES experiments(id),
        case_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        run_id TEXT REFERENCES runs(id),
        input_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        latency_ms REAL,
        result_text TEXT,
        score_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      ) STRICT;

      CREATE INDEX idx_trials_experiment
        ON evaluation_trials(experiment_id, profile_id, case_id);
    `,
  },
  {
    version: 4,
    description: "allow retries to reuse provider idempotency keys",
    sql: `
      DROP INDEX IF EXISTS idx_attempts_idempotency;
      CREATE INDEX idx_attempts_idempotency_lookup
        ON attempts(run_id, stage_id, participant_id, idempotency_key);
    `,
  },
];
