import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { BunSqliteDatabase } from "../src/BunSqliteDatabase";
import { Migrator } from "../src/Migrator";

const TEST_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "test");
const SCHEMA_OUTPUT = join(TEST_ROOT, "schema-test.sql");

describe("Migrator", () => {
  describe("#run()", () => {
    describe(".up", () => {
      it("applies all pending migrations", () => {
        const db = new BunSqliteDatabase(":memory:", ":memory:");
        const migrator = new Migrator(db, {
          pwd: TEST_ROOT,
          migrationsDir: "migrations",
          silent: true,
        });

        migrator.run();

        const tables = db
          .getDb()
          .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'",
          )
          .all() as { name: string }[];
        const tableNames = tables.map((t) => t.name).sort();
        expect(tableNames).toEqual(["comments", "posts", "users"]);

        const versions = db
          .getDb()
          .query("SELECT version FROM schema_migrations ORDER BY version")
          .all() as { version: number }[];
        expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);

        db.close();
      });

      it("applies migrations up to a specific version", () => {
        const db = new BunSqliteDatabase(":memory:", ":memory:");
        const migrator = new Migrator(db, {
          pwd: TEST_ROOT,
          migrationsDir: "migrations",
          version: 2,
          silent: true,
        });

        migrator.run();

        const tables = db
          .getDb()
          .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'",
          )
          .all() as { name: string }[];
        const tableNames = tables.map((t) => t.name).sort();
        expect(tableNames).toEqual(["posts", "users"]);

        const versions = db
          .getDb()
          .query("SELECT version FROM schema_migrations ORDER BY version")
          .all() as { version: number }[];
        expect(versions.map((v) => v.version)).toEqual([1, 2]);

        db.close();
      });

      it("does nothing when no pending migrations exist", () => {
        const db = new BunSqliteDatabase(":memory:", ":memory:");
        const migrator = new Migrator(db, {
          pwd: TEST_ROOT,
          migrationsDir: "migrations",
          silent: true,
        });

        migrator.run();
        migrator.run();

        const versions = db
          .getDb()
          .query("SELECT version FROM schema_migrations ORDER BY version")
          .all() as { version: number }[];
        expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);

        db.close();
      });
    });

    describe(".down", () => {
      it("rolls back only the most recent migration by default", () => {
        const db = new BunSqliteDatabase(":memory:", ":memory:");
        const upMigrator = new Migrator(db, {
          pwd: TEST_ROOT,
          migrationsDir: "migrations",
          silent: true,
        });
        upMigrator.run();

        const downMigrator = new Migrator(db, {
          pwd: TEST_ROOT,
          migrationsDir: "migrations",
          direction: "down",
          silent: true,
        });
        downMigrator.run();

        const tables = db
          .getDb()
          .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'",
          )
          .all() as { name: string }[];
        const tableNames = tables.map((t) => t.name).sort();
        expect(tableNames).toEqual(["posts", "users"]);

        const versions = db
          .getDb()
          .query("SELECT version FROM schema_migrations ORDER BY version")
          .all() as { version: number }[];
        expect(versions.map((v) => v.version)).toEqual([1, 2]);

        db.close();
      });

      it("rolls back to a specific version", () => {
        const db = new BunSqliteDatabase(":memory:", ":memory:");
        const upMigrator = new Migrator(db, {
          pwd: TEST_ROOT,
          migrationsDir: "migrations",
          silent: true,
        });
        upMigrator.run();

        const downMigrator = new Migrator(db, {
          pwd: TEST_ROOT,
          migrationsDir: "migrations",
          direction: "down",
          version: 1,
          silent: true,
        });
        downMigrator.run();

        const tables = db
          .getDb()
          .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'",
          )
          .all() as { name: string }[];
        const tableNames = tables.map((t) => t.name).sort();
        expect(tableNames).toEqual(["users"]);

        const versions = db
          .getDb()
          .query("SELECT version FROM schema_migrations ORDER BY version")
          .all() as { version: number }[];
        expect(versions.map((v) => v.version)).toEqual([1]);

        db.close();
      });

      it("rolls back all migrations when version is 0", () => {
        const db = new BunSqliteDatabase(":memory:", ":memory:");
        const upMigrator = new Migrator(db, {
          pwd: TEST_ROOT,
          migrationsDir: "migrations",
          silent: true,
        });
        upMigrator.run();

        const downMigrator = new Migrator(db, {
          pwd: TEST_ROOT,
          migrationsDir: "migrations",
          direction: "down",
          version: 0,
          silent: true,
        });
        downMigrator.run();

        const tables = db
          .getDb()
          .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'",
          )
          .all() as { name: string }[];
        expect(tables).toEqual([]);

        const versions = db
          .getDb()
          .query("SELECT version FROM schema_migrations")
          .all() as { version: number }[];
        expect(versions).toEqual([]);

        db.close();
      });

      it("does nothing when no migrations are applied", () => {
        const db = new BunSqliteDatabase(":memory:", ":memory:");
        const downMigrator = new Migrator(db, {
          pwd: TEST_ROOT,
          migrationsDir: "migrations",
          direction: "down",
          silent: true,
        });
        downMigrator.run();

        const versions = db
          .getDb()
          .query("SELECT version FROM schema_migrations")
          .all() as { version: number }[];
        expect(versions).toEqual([]);

        db.close();
      });
    });

    describe(".dump", () => {
      it("writes schema SQL file after migration", () => {
        if (existsSync(SCHEMA_OUTPUT)) {
          rmSync(SCHEMA_OUTPUT);
        }

        const db = new BunSqliteDatabase(":memory:", ":memory:");
        const migrator = new Migrator(db, {
          pwd: TEST_ROOT,
          migrationsDir: "migrations",
          dump: true,
          schemaPath: "schema-test.sql",
          silent: true,
        });

        migrator.run();

        expect(existsSync(SCHEMA_OUTPUT)).toBe(true);
        const schema = readFileSync(SCHEMA_OUTPUT, "utf-8");
        expect(schema).toContain("CREATE TABLE users");
        expect(schema).toContain("CREATE TABLE posts");
        expect(schema).toContain("CREATE TABLE comments");

        db.close();
      });
    });

    describe("validation", () => {
      it("throws when migration version is 0", () => {
        const db = new BunSqliteDatabase(":memory:", ":memory:");
        const migrator = new Migrator(db, {
          pwd: TEST_ROOT,
          migrationsDir: "migrations-zero",
          silent: true,
        });

        expect(() => migrator.run()).toThrow("Migration version 0 is reserved");

        db.close();
      });
    });
  });
});
