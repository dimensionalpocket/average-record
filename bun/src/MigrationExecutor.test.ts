import { describe, expect, it } from "bun:test";
import { BunSqliteDatabase } from "../src/BunSqliteDatabase";
import { MigrationExecutor } from "../src/MigrationExecutor";

describe("MigrationExecutor", () => {
  describe("#parseArgs()", () => {
    it("returns empty options with no args", () => {
      const db = new BunSqliteDatabase(":memory:", ":memory:");
      const executor = new MigrationExecutor(db);
      const options = executor.parseArgs([]);
      expect(options).toEqual({});
      db.close();
    });

    it("parses --up direction", () => {
      const db = new BunSqliteDatabase(":memory:", ":memory:");
      const executor = new MigrationExecutor(db);
      const options = executor.parseArgs(["--up"]);
      expect(options).toEqual({ direction: "up" });
      db.close();
    });

    it("parses --down direction", () => {
      const db = new BunSqliteDatabase(":memory:", ":memory:");
      const executor = new MigrationExecutor(db);
      const options = executor.parseArgs(["--down"]);
      expect(options).toEqual({ direction: "down" });
      db.close();
    });

    it("parses --version", () => {
      const db = new BunSqliteDatabase(":memory:", ":memory:");
      const executor = new MigrationExecutor(db);
      const options = executor.parseArgs(["--version", "5"]);
      expect(options).toEqual({ version: 5 });
      db.close();
    });

    it("parses -v shorthand", () => {
      const db = new BunSqliteDatabase(":memory:", ":memory:");
      const executor = new MigrationExecutor(db);
      const options = executor.parseArgs(["-v", "3"]);
      expect(options).toEqual({ version: 3 });
      db.close();
    });

    it("parses --dump", () => {
      const db = new BunSqliteDatabase(":memory:", ":memory:");
      const executor = new MigrationExecutor(db);
      const options = executor.parseArgs(["--dump"]);
      expect(options).toEqual({ dump: true });
      db.close();
    });

    it("parses --silent", () => {
      const db = new BunSqliteDatabase(":memory:", ":memory:");
      const executor = new MigrationExecutor(db);
      const options = executor.parseArgs(["--silent"]);
      expect(options).toEqual({ silent: true });
      db.close();
    });

    it("parses -s shorthand", () => {
      const db = new BunSqliteDatabase(":memory:", ":memory:");
      const executor = new MigrationExecutor(db);
      const options = executor.parseArgs(["-s"]);
      expect(options).toEqual({ silent: true });
      db.close();
    });

    it("parses --migrations-dir", () => {
      const db = new BunSqliteDatabase(":memory:", ":memory:");
      const executor = new MigrationExecutor(db);
      const options = executor.parseArgs(["--migrations-dir", "custom/path"]);
      expect(options).toEqual({ migrationsDir: "custom/path" });
      db.close();
    });

    it("parses --schema-path", () => {
      const db = new BunSqliteDatabase(":memory:", ":memory:");
      const executor = new MigrationExecutor(db);
      const options = executor.parseArgs(["--schema-path", "output.sql"]);
      expect(options).toEqual({ schemaPath: "output.sql" });
      db.close();
    });

    it("parses --pwd", () => {
      const db = new BunSqliteDatabase(":memory:", ":memory:");
      const executor = new MigrationExecutor(db);
      const options = executor.parseArgs(["--pwd", "/some/path"]);
      expect(options).toEqual({ pwd: "/some/path" });
      db.close();
    });

    it("applies defaults from constructor", () => {
      const db = new BunSqliteDatabase(":memory:", ":memory:");
      const executor = new MigrationExecutor(db, {
        migrationsDir: "default/migrations",
        schemaPath: "default.sql",
        pwd: "/default",
      });
      const options = executor.parseArgs([]);
      expect(options).toEqual({
        migrationsDir: "default/migrations",
        schemaPath: "default.sql",
        pwd: "/default",
      });
      db.close();
    });

    it("merges args over defaults", () => {
      const db = new BunSqliteDatabase(":memory:", ":memory:");
      const executor = new MigrationExecutor(db, {
        migrationsDir: "default/migrations",
      });
      const options = executor.parseArgs(["--migrations-dir", "override/path"]);
      expect(options).toEqual({ migrationsDir: "override/path" });
      db.close();
    });

    it("parses multiple flags", () => {
      const db = new BunSqliteDatabase(":memory:", ":memory:");
      const executor = new MigrationExecutor(db);
      const options = executor.parseArgs([
        "--down",
        "-v",
        "2",
        "--dump",
        "--silent",
      ]);
      expect(options).toEqual({
        direction: "down",
        version: 2,
        dump: true,
        silent: true,
      });
      db.close();
    });

    it("throws on unknown flag", () => {
      const db = new BunSqliteDatabase(":memory:", ":memory:");
      const executor = new MigrationExecutor(db);
      expect(() => executor.parseArgs(["--unknown"])).toThrow(
        "Unknown option: --unknown",
      );
      db.close();
    });

    it("throws when flag is missing value", () => {
      const db = new BunSqliteDatabase(":memory:", ":memory:");
      const executor = new MigrationExecutor(db);
      expect(() => executor.parseArgs(["--version"])).toThrow(
        "Missing value for --version",
      );
      db.close();
    });
  });
});
