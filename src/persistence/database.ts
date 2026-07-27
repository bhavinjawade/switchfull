import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { SwitchError } from "../domain/errors.js";
import { isoNow } from "../domain/clock.js";
import { migrations } from "./migrations.js";

export class SwitchDatabase {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.raw = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    this.raw.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;",
    );
    this.migrate();
  }

  close(): void {
    this.raw.close();
  }

  transaction<T>(operation: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  integrityCheck(): void {
    const row = this.raw.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
    if (!row || !Object.values(row).includes("ok")) {
      throw new SwitchError({
        code: "integrity_error",
        message: "SQLite integrity check failed.",
        retry: "non_retryable",
        details: { result: row ?? null },
      });
    }
  }

  async backup(path: string): Promise<number> {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.raw.exec("PRAGMA wal_checkpoint(PASSIVE)");
    return backup(this.raw, path);
  }

  migrationStatus(): readonly {
    readonly version: number;
    readonly description: string;
    readonly appliedAt: string;
  }[] {
    return (
      this.raw
        .prepare("SELECT version, description, applied_at FROM schema_migrations ORDER BY version")
        .all() as unknown as {
        version: number;
        description: string;
        applied_at: string;
      }[]
    ).map((row) => ({
      version: row.version,
      description: row.description,
      appliedAt: row.applied_at,
    }));
  }

  private migrate(): void {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    const applied = new Set(
      (
        this.raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
          version: number;
        }[]
      ).map((row) => row.version),
    );
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      this.transaction(() => {
        this.raw.exec(migration.sql);
        this.raw
          .prepare(
            "INSERT INTO schema_migrations(version, description, applied_at) VALUES (?, ?, ?)",
          )
          .run(migration.version, migration.description, isoNow());
      });
    }
  }
}
