import { Database } from "./Database";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";

export type MigrationDirection = "up" | "down";

/** Options for configuring a Migrator instance */
export interface MigratorOptions {
  /** Target version to migrate to */
  version?: number;
  /** Suppress console output */
  silent?: boolean;
  /** Dump schema SQL file after migration */
  dump?: boolean;
  /** Migration direction, defaults to "up" */
  direction?: MigrationDirection;
  /** Base path for resolving relative paths */
  pwd?: string;
  /** Relative path to migrations directory */
  migrationsDir?: string;
  /** Path (including filename) for schema dump output */
  schemaPath?: string;
}

const DEFAULT_MIGRATIONS_DIR = "migrations";
const DEFAULT_SCHEMA_PATH = "schema.sql";
const MIGRATIONS_TABLE = "schema_migrations";

/**
 * Executes SQL migrations up or down, tracks applied versions, and optionally dumps the schema.
 *
 * Migration files must follow the naming convention: `{version}_{name}.{up|down}.sql`
 * Applied versions are tracked in a `schema_migrations` table.
 */
export class Migrator {
  /** Database instance to run migrations against */
  readonly #db: Database;
  /** Target version to migrate to. If undefined, migrates to latest (up) or zero (down) */
  readonly #version?: number;
  /** Suppress console output when true */
  readonly #silent: boolean;
  /** Dump schema to file after migration completes */
  readonly #dump: boolean;
  /** Migration direction: "up" applies pending, "down" rolls back */
  readonly #direction: MigrationDirection;
  /** Base path for resolving relative migration and schema paths */
  readonly #pwd: string;
  /** Relative path to the directory containing migration files */
  readonly #migrationsDir: string;
  /** Output path for the generated schema SQL file */
  readonly #schemaPath: string;

  constructor(db: Database, options: MigratorOptions = {}) {
    this.#db = db;
    this.#version = options.version;
    this.#silent = options.silent ?? false;
    this.#dump = options.dump ?? false;
    this.#direction = options.direction ?? "up";
    this.#pwd = options.pwd ?? process.cwd();
    this.#migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
    this.#schemaPath = options.schemaPath ?? DEFAULT_SCHEMA_PATH;
  }

  /**
   * Executes migrations in the configured direction.
   * Creates the tracking table if needed, runs pending/executed migrations,
   * and optionally dumps the schema to a SQL file.
   */
  run(): void {
    this.#ensureMigrationsTable();

    const applied = this.#getAppliedMigrations();
    const available = this.#getAvailableMigrations();

    if (this.#direction === "up") {
      this.#runUp(applied, available);
    } else {
      this.#runDown(applied, available);
    }

    if (this.#dump) {
      this.#dumpSchema();
    }
  }

  /** Logs a message unless silent mode is enabled */
  #log(message: string): void {
    if (!this.#silent) {
      console.log(message);
    }
  }

  /** Creates the schema_migrations tracking table if it doesn't exist */
  #ensureMigrationsTable(): void {
    this.#db
      .getDb()
      .run(
        `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (version INTEGER PRIMARY KEY)`,
      );
  }

  /** Returns a Set of already-applied migration version numbers */
  #getAppliedMigrations(): Set<number> {
    const rows = this.#db
      .getDb()
      .query(`SELECT version FROM ${MIGRATIONS_TABLE}`)
      .all() as { version: number }[];
    return new Set(rows.map((r) => r.version));
  }

  /**
   * Scans the migrations directory and returns a Map of available migrations.
   * Keys are version numbers, values are objects with `up` and `down` SQL strings.
   */
  #getAvailableMigrations(): Map<
    number,
    { up: string; down: string; upFile?: string; downFile?: string }
  > {
    const dir = resolve(this.#pwd, this.#migrationsDir);
    if (!existsSync(dir)) {
      return new Map();
    }

    const files = readdirSync(dir);
    const migrations = new Map<
      number,
      { up: string; down: string; upFile?: string; downFile?: string }
    >();

    for (const file of files) {
      const match = file.match(/^(\d+)_(.+)\.(up|down)\.sql$/);
      if (!match) continue;

      const version = parseInt(match[1], 10);
      if (version === 0) {
        throw new Error(
          `Migration version 0 is reserved and cannot be used: ${file}`,
        );
      }
      const direction = match[3] as "up" | "down";
      const sql = readFileSync(join(dir, file), "utf-8");

      if (!migrations.has(version)) {
        migrations.set(version, { up: "", down: "" });
      }

      const entry = migrations.get(version)!;
      entry[direction] = sql;
      entry[`${direction}File`] = file;
    }

    return migrations;
  }

  /**
   * Applies pending up migrations in ascending version order.
   * Stops at `version` if specified, otherwise migrates to the latest.
   */
  #runUp(
    applied: Set<number>,
    available: Map<
      number,
      { up: string; down: string; upFile?: string; downFile?: string }
    >,
  ): void {
    const pending = [...available.keys()]
      .filter((v) => !applied.has(v))
      .sort((a, b) => a - b);

    const target = this.#version ?? Math.max(...pending, 0);
    const toRun = pending.filter((v) => v <= target);

    if (toRun.length === 0) {
      this.#log("No pending migrations.");
      return;
    }

    const bunDb = this.#db.getDb();

    for (const version of toRun) {
      const migration = available.get(version)!;
      if (!migration.up) {
        throw new Error(`Missing up migration for version ${version}`);
      }

      this.#log(`Migrating up: ${version} (${migration.upFile})`);
      bunDb.run(migration.up);
      bunDb
        .query(`INSERT INTO ${MIGRATIONS_TABLE} (version) VALUES (?)`)
        .run(version);
    }
  }

  /**
   * Rolls back executed down migrations in descending version order.
   * If `version` is specified, rolls back to that version. Otherwise, rolls back only the most recent migration.
   */
  #runDown(
    applied: Set<number>,
    available: Map<
      number,
      { up: string; down: string; upFile?: string; downFile?: string }
    >,
  ): void {
    const executed = [...applied].sort((a, b) => b - a);

    const target =
      this.#version !== undefined
        ? this.#version
        : executed.length > 1
          ? executed[1]
          : 0;
    const toRun = executed.filter((v) => v > target);

    if (toRun.length === 0) {
      this.#log("No migrations to roll back.");
      return;
    }

    const bunDb = this.#db.getDb();

    for (const version of toRun) {
      const migration = available.get(version);
      if (!migration?.down) {
        throw new Error(`Missing down migration for version ${version}`);
      }

      this.#log(`Migrating down: ${version} (${migration.downFile})`);
      bunDb.run(migration.down);
      bunDb
        .query(`DELETE FROM ${MIGRATIONS_TABLE} WHERE version = ?`)
        .run(version);
    }
  }

  /** Dumps the current database schema to the configured schema file path */
  #dumpSchema(): void {
    const bunDb = this.#db.getDb();
    const schema = bunDb
      .query(
        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY tbl_name, type DESC",
      )
      .all() as { sql: string }[];
    const sql = schema.map((row) => row.sql + ";").join("\n\n");

    const outputPath = resolve(this.#pwd, this.#schemaPath);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, sql, "utf-8");

    this.#log(`Schema dumped to ${outputPath}`);
  }
}
