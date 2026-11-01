import { describe, expect, it, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { BunSqliteDatabase } from "./BunSqliteDatabase";

describe("BunSqliteDatabase", () => {
  it("creates instance without connecting", () => {
    const db = new BunSqliteDatabase(":memory:", ":memory:", { strict: true });
    expect(db["db"]).toBeNull();
  });

  it("connects lazily on first getDb() call", () => {
    const db = new BunSqliteDatabase(":memory:", ":memory:", { strict: true });
    expect(db["db"]).toBeNull();
    db.getDb();
    expect(db["db"]).not.toBeNull();
  });

  it("returns same instance on subsequent getDb() calls", () => {
    const db = new BunSqliteDatabase(":memory:", ":memory:", { strict: true });
    const first = db.getDb();
    const second = db.getDb();
    expect(first).toBe(second);
  });

  it("runs initialization commands on first connection", () => {
    const db = new BunSqliteDatabase(":memory:", ":memory:", { strict: true }, [
      "CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)",
      "INSERT INTO test (value) VALUES ('hello')",
    ]);
    const bunDb = db.getDb();
    const row = bunDb.query("SELECT value FROM test WHERE id = 1").get();
    expect(row).toEqual({ value: "hello" });
  });

  it("disconnects and resets db property on close()", () => {
    const db = new BunSqliteDatabase(":memory:", ":memory:", { strict: true });
    db.getDb();
    expect(db["db"]).not.toBeNull();
    db.close();
    expect(db["db"]).toBeNull();
  });

  describe("idle auto-close", () => {
    it("closes connection after idle timeout", () => {
      const db = new BunSqliteDatabase(
        ":memory:",
        ":memory:",
        undefined,
        undefined,
        50,
      );
      db.getDb();
      expect(db["db"]).not.toBeNull();

      setSystemTime(new Date(Date.now() + 100));
      db.checkIdle();
      setSystemTime();

      expect(db["db"]).toBeNull();
    });

    it("does not close before idle timeout", () => {
      const db = new BunSqliteDatabase(
        ":memory:",
        ":memory:",
        undefined,
        undefined,
        50,
      );
      db.getDb();
      expect(db["db"]).not.toBeNull();

      setSystemTime(new Date(Date.now() + 30));
      db.checkIdle();
      setSystemTime();

      expect(db["db"]).not.toBeNull();
    });

    it("reconnects on getDb() after auto-close", () => {
      const db = new BunSqliteDatabase(
        ":memory:",
        ":memory:",
        undefined,
        undefined,
        50,
      );
      const first = db.getDb();
      setSystemTime(new Date(Date.now() + 100));
      db.checkIdle();
      setSystemTime();

      const second = db.getDb();
      expect(second).not.toBe(first);
    });

    it("does not auto-close when idleTimeoutMs is undefined", () => {
      const db = new BunSqliteDatabase(":memory:", ":memory:");
      db.getDb();
      setSystemTime(new Date(Date.now() + 10000));
      expect(db["db"]).not.toBeNull();
      setSystemTime();
    });

    it("keeps connection alive with repeated access", () => {
      const db = new BunSqliteDatabase(
        ":memory:",
        ":memory:",
        undefined,
        undefined,
        50,
      );
      db.getDb();
      setSystemTime(new Date(Date.now() + 40));
      db.getDb();
      setSystemTime(new Date(Date.now() + 40));
      db.checkIdle();
      setSystemTime();

      expect(db["db"]).not.toBeNull();
    });
  });

  describe(".backupToFile()", () => {
    it("creates a backup file", () => {
      const db = new BunSqliteDatabase(
        ":memory:",
        ":memory:",
        { strict: true },
        [
          "CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)",
          "INSERT INTO test (value) VALUES ('hello')",
        ],
      );
      const tmpDir = mkdtempSync(join(tmpdir(), "average-record-"));
      const backupPath = join(tmpDir, "backup-test.sqlite");

      try {
        db.backupToFile(backupPath);
        const backup = new BunSqliteDatabase("backup-test", backupPath, {
          strict: true,
        });
        const row = backup
          .getDb()
          .query("SELECT value FROM test WHERE id = 1")
          .get();
        expect(row).toEqual({ value: "hello" });
        backup.close();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("throws if the directory does not exist", () => {
      const db = new BunSqliteDatabase(":memory:", ":memory:", {
        strict: true,
      });
      expect(() =>
        db.backupToFile("/nonexistent-dir-xyz123/backup.sqlite"),
      ).toThrow("Directory does not exist");
    });
  });
});
