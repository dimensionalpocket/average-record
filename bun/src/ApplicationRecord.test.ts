import { describe, expect, it, beforeAll, setSystemTime } from "bun:test";
import * as v from "valibot";
import {
  ApplicationRecord,
  redactedCache,
  RecordInvalid,
  Timestamps,
} from "./ApplicationRecord";
import type { ValidationError } from "./ApplicationRecord";
import { BunSqliteDatabase } from "./BunSqliteDatabase";

beforeAll(() => {
  redactedCache.clear();
});

describe("ApplicationRecord", () => {
  const db = new BunSqliteDatabase(":memory:", ":memory:", { strict: true }, [
    "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)",
    "CREATE TABLE artists (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT, updated_at TEXT)",
    "CREATE TABLE empty_models (id INTEGER PRIMARY KEY, name TEXT, email TEXT)",
  ]);

  class User extends ApplicationRecord {
    static database = db;
    static tableName = "users";
    static schema = v.object({
      id: v.optional(v.number()),
      name: v.string(),
      email: v.optional(v.pipe(v.string(), v.metadata({ redacted: true }))),
    });

    declare id: number;
    declare name: string;
    declare email: string;
  }

  describe(".database", () => {
    it("accepts database assignment on subclass", async () => {
      class Product extends ApplicationRecord {}
      const productDb = new BunSqliteDatabase(":memory:", ":memory:", {
        strict: true,
      });
      Product.database = productDb;
      expect(Product.database).toBe(productDb);
    });

    it("inherits database from ApplicationRecord when not overridden", async () => {
      const inheritedDb = new BunSqliteDatabase(":memory:", ":memory:", {
        strict: true,
      });
      ApplicationRecord.database = inheritedDb;

      class Item extends ApplicationRecord {}
      expect(Item.database).toBe(inheritedDb);
    });

    it("maintains separate database instances per subclass", async () => {
      class A extends ApplicationRecord {}
      class B extends ApplicationRecord {}

      const dbA = new BunSqliteDatabase(":memory:", ":memory:", {
        strict: true,
      });
      const dbB = new BunSqliteDatabase(":memory:", ":memory:", {
        strict: true,
      });

      A.database = dbA;
      B.database = dbB;

      expect(A.database).toBe(dbA);
      expect(B.database).toBe(dbB);
    });

    it("leaves ApplicationRecord.database unchanged when subclass overrides", async () => {
      const parentDb = new BunSqliteDatabase(":memory:", ":memory:", {
        strict: true,
      });
      ApplicationRecord.database = parentDb;

      class C extends ApplicationRecord {}
      const childDb = new BunSqliteDatabase(":memory:", ":memory:", {
        strict: true,
      });
      C.database = childDb;

      expect(C.database).toBe(childDb);
      expect(ApplicationRecord.database).toBe(parentDb);
    });
  });

  describe("#constructor", () => {
    it("creates instance with typed data", async () => {
      const user = new User({ name: "Alice", email: "alice@example.com" });
      expect(user.name).toBe("Alice");
      expect(user.email).toBe("alice@example.com");
    });
  });

  describe(".find()", () => {
    it("finds existing record by id", async () => {
      const user = new User({ name: "Bob", email: "bob@example.com" });
      await user.save();
      const found = User.find(user.id!);
      expect(found).not.toBeNull();
      expect(found!.name).toBe("Bob");
    });

    it("returns null for missing id", async () => {
      const user = User.find(999);
      expect(user).toBeNull();
    });

    it("returns null for id 0", async () => {
      expect(User.find(0)).toBeNull();
    });
  });

  describe(".allRaw()", () => {
    it("returns all records as plain objects", async () => {
      await new User({ name: "RawUser", email: "raw@example.com" }).save();
      const users = User.allRaw();
      expect(users.length).toBeGreaterThanOrEqual(1);
      expect(users[0]).toBeInstanceOf(Object);
    });

    it("filters records with conditions", async () => {
      await new User({
        name: "FilteredRaw",
        email: "filteredraw@example.com",
      }).save();
      const users = User.where("name", "=", "FilteredRaw").allRaw();
      expect(users.length).toBe(1);
      expect(users[0].name).toBe("FilteredRaw");
    });

    it("applies limit with scope", async () => {
      const users = User.limit(1).allRaw();
      expect(users.length).toBeLessThanOrEqual(1);
    });
  });

  describe(".all()", () => {
    it("returns all records", async () => {
      const users = User.all();
      expect(users.length).toBeGreaterThanOrEqual(1);
    });

    it("filters records with conditions", async () => {
      await new User({
        name: "FilteredUser",
        email: "filtered@example.com",
      }).save();
      const users = User.where("name", "=", "FilteredUser").all();
      expect(users.length).toBe(1);
      expect(users[0].name).toBe("FilteredUser");
    });

    it("applies order by with scope", async () => {
      await new User({ name: "AUser", email: "a@example.com" }).save();
      await new User({ name: "BUser", email: "b@example.com" }).save();
      const users = User.orderBy("name", "DESC").limit(1).all();
      expect(users.length).toBe(1);
    });
  });

  describe(".first()", () => {
    it("returns null when no records match", async () => {
      const result = User.where("name", "=", "Nonexistent").first();
      expect(result).toBeNull();
    });

    it("returns the first record matching conditions", async () => {
      await new User({
        name: "FirstMatch",
        email: "firstmatch@example.com",
      }).save();
      const result = User.where("name", "=", "FirstMatch").first();
      expect(result).not.toBeNull();
      expect(result!.name).toBe("FirstMatch");
    });

    it("returns a record without conditions", async () => {
      const result = User.first();
      expect(result).not.toBeNull();
      expect(typeof result!.name).toBe("string");
    });

    it("respects ORDER BY when sorting is given", async () => {
      await new User({
        name: "Aardvark",
        email: "aardvark@example.com",
      }).save();
      await new User({ name: "Zebra", email: "zebra@example.com" }).save();
      const result = User.orderBy("name", "DESC").first();
      expect(result).not.toBeNull();
      expect(result!.name).toBe("Zebra");
    });
  });

  describe(".count()", () => {
    it("counts all records", async () => {
      const count = User.count();
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it("counts records with conditions", async () => {
      await new User({ name: "CountMe", email: "countme@example.com" }).save();
      const count = User.where("name", "=", "CountMe").count();
      expect(count).toBe(1);
    });

    it("returns 0 when no records match", async () => {
      const count = User.where("name", "=", "Nonexistent").count();
      expect(count).toBe(0);
    });
  });

  describe(".eachRaw()", () => {
    it("iterates over all records as plain objects", async () => {
      await new User({
        name: "EachRawUser",
        email: "eachraw@example.com",
      }).save();
      const names: string[] = [];
      for (const user of User.eachRaw()) {
        names.push(user.name as string);
      }
      expect(names).toContain("EachRawUser");
    });

    it("yields plain objects, not model instances", async () => {
      await new User({ name: "PlainUser", email: "plain@example.com" }).save();
      for (const row of User.eachRaw()) {
        expect(row).toBeInstanceOf(Object);
        expect(row).not.toBeInstanceOf(User);
        break;
      }
    });

    it("filters records with conditions", async () => {
      await new User({
        name: "FilteredEachRaw",
        email: "filteredeachraw@example.com",
      }).save();
      const names: string[] = [];
      for (const row of User.where("name", "=", "FilteredEachRaw").eachRaw()) {
        names.push(row.name as string);
      }
      expect(names).toContain("FilteredEachRaw");
    });
  });

  describe(".each()", () => {
    it("iterates over all records", async () => {
      await new User({ name: "EachUser", email: "each@example.com" }).save();
      const names: string[] = [];
      for (const user of User.each()) {
        names.push(user.name);
      }
      expect(names).toContain("EachUser");
    });

    it("returns model instances", async () => {
      await new User({
        name: "InstanceUser",
        email: "instance@example.com",
      }).save();
      for (const user of User.each()) {
        expect(user).toBeInstanceOf(User);
        break;
      }
    });

    it("works with empty tables", async () => {
      class EmptyModel extends ApplicationRecord {
        static database = db;
        static tableName = "empty_models";
        static schema = v.object({
          id: v.optional(v.number()),
          name: v.string(),
          email: v.optional(v.string()),
        });

        declare id: number;
        declare name: string;
        declare email: string;
      }

      const count = [...EmptyModel.each()].length;
      expect(count).toBe(0);
    });

    it("filters records with conditions", async () => {
      await new User({
        name: "FilteredEach",
        email: "filteredeach@example.com",
      }).save();
      const names: string[] = [];
      for (const user of User.where("name", "=", "FilteredEach").each()) {
        names.push(user.name);
      }
      expect(names).toContain("FilteredEach");
    });

    it("applies limit with scope", async () => {
      const count = [...User.limit(1).each()].length;
      expect(count).toBeLessThanOrEqual(1);
    });
  });

  describe(".redacted()", () => {
    it("returns columns marked as redacted in schema", async () => {
      expect(User.redacted()).toEqual(["email"]);
    });
  });

  describe("#save()", () => {
    it("saves new record and assigns id", async () => {
      const user = new User({ name: "Charlie", email: "charlie@example.com" });
      await user.save();
      expect(user.id).toBeDefined();
    });

    it("updates existing record", async () => {
      const user = User.all()[0];
      user.name = "Chuck";
      await user.save();
      const updated = User.find(user.id)!;
      expect(updated.name).toBe("Chuck");
    });

    it("inserts a record whose id is 0 and receives a new id", async () => {
      const before = User.count();
      const user = new User({
        id: 0,
        name: "ZeroId",
        email: "zero@example.com",
      });
      await user.save();

      expect(user.id).toBeGreaterThan(0);
      expect(User.count()).toBe(before + 1);
      expect(User.find(0)).toBeNull();
      expect(
        db.getDb().query("SELECT id FROM users WHERE id = 0").all(),
      ).toHaveLength(0);

      // A second save updates the assigned row rather than inserting a duplicate.
      user.name = "ZeroIdUpdated";
      await user.save();
      expect(User.count()).toBe(before + 1);
      expect(User.find(user.id)!.name).toBe("ZeroIdUpdated");
    });

    it("applies defaults on insert", async () => {
      class DefaultUser extends ApplicationRecord {
        static database = db;
        static tableName = "default_users";
        static schema = v.object({
          id: v.optional(v.number()),
          name: v.string(),
          email: v.optional(v.string()),
          role: v.fallback(v.string(), "member"),
          active: v.fallback(v.number(), 1),
        });

        declare id: number;
        declare name: string;
        declare email: string;
        declare role: string;
        declare active: number;
      }

      db.getDb().run(`
        CREATE TABLE IF NOT EXISTS default_users (
          id INTEGER PRIMARY KEY,
          name TEXT,
          email TEXT,
          role TEXT NOT NULL DEFAULT 'member',
          active INTEGER NOT NULL DEFAULT 1
        )
      `);

      const user = new DefaultUser({ name: "DefaultsOnly" });
      await user.save();
      expect(user.role).toBe("member");
      expect(user.active).toBe(1);

      const found = DefaultUser.find(user.id!)!;
      expect(found.role).toBe("member");
      expect(found.active).toBe(1);
    });
  });

  describe("#setTimestamps()", () => {
    class TimestampedModel extends ApplicationRecord {
      static database = db;
      static tableName = "timestamped_models";
      static schema = v.object({
        id: v.optional(v.number()),
        name: v.string(),
        created_at: v.string(),
        updated_at: v.string(),
      });

      declare id: number;
      declare name: string;
      declare created_at: string;
      declare updated_at: string;
    }

    class NoTimestampModel extends ApplicationRecord {
      static database = db;
      static tableName = "no_timestamp_models";
      static schema = v.object({
        id: v.optional(v.number()),
        name: v.string(),
      });

      declare id: number;
      declare name: string;
    }

    class MillisModel extends ApplicationRecord {
      static database = db;
      static tableName = "millis_models";
      static timestamps = Timestamps.epochMillis;
      static schema = v.object({
        id: v.optional(v.number()),
        name: v.string(),
        created_ts: v.number(),
        updated_ts: v.number(),
      });

      declare id: number;
      declare name: string;
      declare created_ts: number;
      declare updated_ts: number;
    }

    class CustomMillisModel extends ApplicationRecord {
      static database = db;
      static tableName = "custom_millis_models";
      static timestamps = {
        created: "inserted_ms",
        updated: "modified_ms",
        format: "millis",
      } as const;
      static schema = v.object({
        id: v.optional(v.number()),
        name: v.string(),
        inserted_ms: v.number(),
        modified_ms: v.number(),
      });

      declare id: number;
      declare name: string;
      declare inserted_ms: number;
      declare modified_ms: number;
    }

    class UntimedModel extends ApplicationRecord {
      static database = db;
      static tableName = "untimed_models";
      static timestamps = Timestamps.none;
      static schema = v.object({
        id: v.optional(v.number()),
        name: v.string(),
        created_at: v.optional(v.string()),
        updated_at: v.optional(v.string()),
      });

      declare id: number;
      declare name: string;
      declare created_at: string | undefined;
      declare updated_at: string | undefined;
    }

    beforeAll(() => {
      db.getDb().run(`
        CREATE TABLE IF NOT EXISTS timestamped_models (
          id INTEGER PRIMARY KEY,
          name TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      db.getDb().run(`
        CREATE TABLE IF NOT EXISTS no_timestamp_models (
          id INTEGER PRIMARY KEY,
          name TEXT
        )
      `);
      db.getDb().run(`
        CREATE TABLE IF NOT EXISTS millis_models (
          id INTEGER PRIMARY KEY,
          name TEXT,
          created_ts INTEGER NOT NULL,
          updated_ts INTEGER NOT NULL
        )
      `);
      db.getDb().run(`
        CREATE TABLE IF NOT EXISTS custom_millis_models (
          id INTEGER PRIMARY KEY,
          name TEXT,
          inserted_ms INTEGER NOT NULL,
          modified_ms INTEGER NOT NULL
        )
      `);
      db.getDb().run(`
        CREATE TABLE IF NOT EXISTS untimed_models (
          id INTEGER PRIMARY KEY,
          name TEXT,
          created_at TEXT,
          updated_at TEXT
        )
      `);
    });

    it("sets created_at and updated_at on new records", async () => {
      const model = new TimestampedModel({ name: "NewTimestamped" });
      await model.save();
      expect(model.created_at).toBeDefined();
      expect(model.updated_at).toBeDefined();
    });

    it("updates updated_at but preserves created_at on updates", async () => {
      const model = new TimestampedModel({ name: "UpdateTimestamped" });
      await model.save();
      const originalCreatedAt = model.created_at;
      const originalUpdatedAt = model.updated_at;

      setSystemTime(new Date(Date.now() + 1000));
      model.name = "UpdatedName";
      await model.save();
      setSystemTime();

      expect(model.created_at).toBe(originalCreatedAt);
      expect(model.updated_at).not.toBe(originalUpdatedAt);
    });

    it("preserves updated_at when skipUpdatedAt is set on update", async () => {
      const model = new TimestampedModel({ name: "SkipUpdatedAt" });
      await model.save();
      const originalCreatedAt = model.created_at;
      const originalUpdatedAt = model.updated_at;

      setSystemTime(new Date(Date.now() + 1000));
      model.name = "SkippedName";
      await model.save({ skipUpdatedAt: true });
      setSystemTime();

      expect(model.created_at).toBe(originalCreatedAt);
      expect(model.updated_at).toBe(originalUpdatedAt);

      const found = TimestampedModel.find(model.id)!;
      expect(found.name).toBe("SkippedName");
      expect(found.updated_at).toBe(originalUpdatedAt);
    });

    it("sets updated_at on insert even when skipUpdatedAt is set", async () => {
      const model = new TimestampedModel({ name: "InsertSkipUpdatedAt" });
      await model.save({ skipUpdatedAt: true });
      expect(model.created_at).toBeDefined();
      expect(model.updated_at).toBeDefined();
    });

    it("does not overwrite existing created_at value", async () => {
      const past = "2020-01-01T00:00:00.000Z";
      const model = new TimestampedModel({
        name: "PastTimestamped",
        created_at: past,
      });
      await model.save();
      expect(model.created_at).toBe(past);
    });

    it("treats id 0 as new and sets timestamps", async () => {
      const model = new TimestampedModel({ id: 0, name: "ZeroTimestamped" });
      expect(model.created_at).toBeDefined();
      expect(model.updated_at).toBeDefined();
      await model.save();
      expect(model.id).toBeGreaterThan(0);
    });

    it("does nothing when schema has no timestamp columns", async () => {
      const model = new NoTimestampModel({ name: "NoTimestamps" });
      await model.save();
      expect((model as any).created_at).toBeUndefined();
      expect((model as any).updated_at).toBeUndefined();
    });

    it("sets integer epoch-millisecond timestamps on new records", async () => {
      const before = Date.now();
      const model = new MillisModel({ name: "MillisNew" });
      await model.save();

      expect(typeof model.created_ts).toBe("number");
      expect(model.created_ts).toBe(model.updated_ts);
      expect(model.created_ts).toBeGreaterThanOrEqual(before);

      const raw = MillisModel.allRaw().find((row) => row.id === model.id);
      expect(typeof raw!.created_ts).toBe("number");
    });

    it("advances only updated_ts on update", async () => {
      const model = new MillisModel({ name: "MillisUpdate" });
      await model.save();
      const created = model.created_ts;

      model.name = "MillisUpdated";
      model.updated_ts = 1;
      await model.save();

      expect(model.created_ts).toBe(created);
      expect(model.updated_ts).toBeGreaterThan(1);
    });

    it("preserves updated_ts when skipUpdatedAt is set on update", async () => {
      const model = new MillisModel({ name: "MillisSkip" });
      await model.save();
      const created = model.created_ts;

      model.updated_ts = 1;
      await model.save({ skipUpdatedAt: true });

      expect(model.updated_ts).toBe(1);
      expect(model.created_ts).toBe(created);
    });

    it("treats 0 as unset for epoch-millisecond timestamps", async () => {
      const model = new MillisModel({
        name: "MillisZero",
        created_ts: 0,
        updated_ts: 0,
      });
      expect(model.created_ts).toBeGreaterThan(0);
      await model.save();
      expect(model.created_ts).toBeGreaterThan(0);
    });

    it("treats an empty string as unset like the Rust implementation", async () => {
      const model = new TimestampedModel({
        name: "EmptyCreatedAt",
        created_at: "",
        updated_at: "",
      });
      expect(model.created_at).not.toBe("");
      expect(model.updated_at).not.toBe("");
    });

    it("uses custom timestamp column names", async () => {
      const model = new CustomMillisModel({ name: "CustomMillis" });
      await model.save();

      expect(model.inserted_ms).toBe(model.modified_ms);
      const raw = CustomMillisModel.allRaw().find((row) => row.id === model.id);
      expect(typeof raw!.inserted_ms).toBe("number");
      expect(raw).not.toHaveProperty("created_at");
    });

    it("does nothing when timestamps are disabled", async () => {
      const model = new UntimedModel({ name: "Untimed" });
      await model.save();
      expect(model.created_at).toBeUndefined();
      expect(model.updated_at).toBeUndefined();
    });
  });

  describe("#destroy()", () => {
    it("removes record from database", async () => {
      const user = User.all()[0];
      user.destroy();
      const found = User.find(user.id!);
      expect(found).toBeNull();
    });

    it("throws for an unsaved record", async () => {
      const before = User.count();
      const user = new User({ name: "Unsaved", email: "unsaved@example.com" });
      expect(() => user.destroy()).toThrow("cannot destroy an unsaved record");
      expect(User.count()).toBe(before);
    });

    it("throws for a record whose id is 0", async () => {
      const user = new User({
        id: 0,
        name: "ZeroDestroy",
        email: "zerodestroy@example.com",
      });
      expect(() => user.destroy()).toThrow("cannot destroy an unsaved record");
    });
  });

  describe("#persisted()", () => {
    it("returns null for new record", async () => {
      const user = new User({ name: "New", email: "new@example.com" });
      expect(user.persisted()).toBeNull();
    });

    it("returns null for a record whose id is 0", async () => {
      const user = new User({ id: 0, name: "Zero", email: "zero@example.com" });
      expect(user.persisted()).toBeNull();
    });

    it("returns current database state ignoring unsaved changes", async () => {
      const user = new User({
        name: "PersistedUser",
        email: "persisted@example.com",
      });
      await user.save();
      user.name = "Modified";
      const state = user.persisted();
      expect(state!.name).toBe("PersistedUser");
    });

    it("redacts sensitive columns when redact is true", async () => {
      const user = new User({
        name: "RedactedUser",
        email: "redacted@example.com",
      });
      await user.save();
      const state = user.persisted(true);
      expect(state!.email).toBe("[redacted]");
    });

    it("redacts sensitive columns when redact is true", async () => {
      const user = new User({
        name: "RedactPersistedUser",
        email: "redactpersisted@example.com",
      });
      await user.save();
      const state = user.persisted(true);
      expect(state!.email).toBe("[redacted]");
    });
  });

  describe("#toJSON()", () => {
    it("returns instance attributes as JSON", async () => {
      const user = new User({ name: "Eve", email: "eve@example.com" });
      await user.save();
      expect(user.toJSON()).toEqual({
        id: user.id,
        name: "Eve",
        email: "eve@example.com",
      });
    });

    it("redacts sensitive columns when redact is true", async () => {
      const user = new User({ name: "Frank", email: "frank@example.com" });
      await user.save();
      expect(user.toJSON(true)).toEqual({
        id: user.id,
        name: "Frank",
        email: "[redacted]",
      });
    });
  });

  describe("#changes()", () => {
    it("returns empty object for new record", async () => {
      const user = new User({ name: "Grace", email: "grace@example.com" });
      expect(user.changes()).toEqual({});
    });

    it("returns diff when instance values differ from database", async () => {
      const user = new User({
        name: "ChangeUser",
        email: "change@example.com",
      });
      await user.save();
      user.name = "NewName";
      expect(user.changes()).toEqual({ name: "NewName" });
    });

    it("returns empty object when no changes made", async () => {
      const user = new User({
        name: "NoChangeUser",
        email: "nochange@example.com",
      });
      await user.save();
      expect(user.changes()).toEqual({});
    });

    it("redacts sensitive columns in diff when redact is true", async () => {
      const user = new User({
        name: "RedactChangeUser",
        email: "redactchange@example.com",
      });
      await user.save();
      user.email = "new@example.com";
      expect(user.changes(true)).toEqual({ email: "[redacted]" });
    });
  });

  describe("#beforeCreate()", () => {
    it("calls beforeCreate when saving a new record", async () => {
      let called = false;
      class HookedUser extends ApplicationRecord {
        static database = db;
        static tableName = "users";
        static schema = User.schema;

        declare id: number;
        declare name: string;
        declare email: string;

        protected beforeCreate(): void {
          called = true;
        }
      }

      const user = new HookedUser({ name: "Hook", email: "hook@example.com" });
      await user.save();
      expect(called).toBe(true);
    });

    it("does not call beforeCreate when updating an existing record", async () => {
      let createCalled = false;
      class HookedUser extends ApplicationRecord {
        static database = db;
        static tableName = "users";
        static schema = User.schema;

        declare id: number;
        declare name: string;
        declare email: string;

        protected beforeCreate(): void {
          createCalled = true;
        }
      }

      const user = new HookedUser({ name: "Hook", email: "hook@example.com" });
      await user.save();
      createCalled = false;

      user.name = "Updated";
      await user.save();
      expect(createCalled).toBe(false);
    });
  });

  describe("#beforeUpdate()", () => {
    it("calls beforeUpdate when saving an existing record", async () => {
      let updateCalled = false;
      class HookedUser extends ApplicationRecord {
        static database = db;
        static tableName = "users";
        static schema = User.schema;

        declare id: number;
        declare name: string;
        declare email: string;

        protected beforeUpdate(): void {
          updateCalled = true;
        }
      }

      const user = new HookedUser({ name: "Hook", email: "hook@example.com" });
      await user.save();
      updateCalled = false;

      user.name = "Updated";
      await user.save();
      expect(updateCalled).toBe(true);
    });

    it("does not call beforeUpdate when inserting a new record", async () => {
      let updateCalled = false;
      class HookedUser extends ApplicationRecord {
        static database = db;
        static tableName = "users";
        static schema = User.schema;

        declare id: number;
        declare name: string;
        declare email: string;

        protected beforeUpdate(): void {
          updateCalled = true;
        }
      }

      const user = new HookedUser({ name: "Hook", email: "hook@example.com" });
      await user.save();
      expect(updateCalled).toBe(false);
    });
  });

  describe("#afterCreate()", () => {
    it("calls afterCreate when creating a new record", async () => {
      let createCalled = false;
      class HookedUser extends ApplicationRecord {
        static database = db;
        static tableName = "users";
        static schema = User.schema;

        declare id: number;
        declare name: string;
        declare email: string;

        protected afterCreate(): void {
          createCalled = true;
        }
      }

      const user = new HookedUser({ name: "Hook", email: "hook@example.com" });
      await user.save();
      expect(createCalled).toBe(true);
    });

    it("does not call afterCreate when updating", async () => {
      let createCalled = false;
      class HookedUser extends ApplicationRecord {
        static database = db;
        static tableName = "users";
        static schema = User.schema;

        declare id: number;
        declare name: string;
        declare email: string;

        protected afterCreate(): void {
          createCalled = true;
        }
      }

      const user = new HookedUser({ name: "Hook", email: "hook@example.com" });
      await user.save();
      createCalled = false;

      user.name = "Updated";
      await user.save();
      expect(createCalled).toBe(false);
    });
  });

  describe("#afterUpdate()", () => {
    it("calls afterUpdate when updating an existing record", async () => {
      let updateCalled = false;
      class HookedUser extends ApplicationRecord {
        static database = db;
        static tableName = "users";
        static schema = User.schema;

        declare id: number;
        declare name: string;
        declare email: string;

        protected afterUpdate(): void {
          updateCalled = true;
        }
      }

      const user = new HookedUser({ name: "Hook", email: "hook@example.com" });
      await user.save();
      updateCalled = false;

      user.name = "Updated";
      await user.save();
      expect(updateCalled).toBe(true);
    });

    it("does not call afterUpdate when creating", async () => {
      let updateCalled = false;
      class HookedUser extends ApplicationRecord {
        static database = db;
        static tableName = "users";
        static schema = User.schema;

        declare id: number;
        declare name: string;
        declare email: string;

        protected afterUpdate(): void {
          updateCalled = true;
        }
      }

      const user = new HookedUser({ name: "Hook", email: "hook@example.com" });
      await user.save();
      expect(updateCalled).toBe(false);
    });
  });

  describe("#afterSave()", () => {
    it("calls afterSave when creating a new record", async () => {
      let saveCalled = false;
      class HookedUser extends ApplicationRecord {
        static database = db;
        static tableName = "users";
        static schema = User.schema;

        declare id: number;
        declare name: string;
        declare email: string;

        protected afterSave(): void {
          saveCalled = true;
        }
      }

      const user = new HookedUser({ name: "Hook", email: "hook@example.com" });
      await user.save();
      expect(saveCalled).toBe(true);
    });

    it("calls afterSave when updating an existing record", async () => {
      let saveCalled = false;
      class HookedUser extends ApplicationRecord {
        static database = db;
        static tableName = "users";
        static schema = User.schema;

        declare id: number;
        declare name: string;
        declare email: string;

        protected afterSave(): void {
          saveCalled = true;
        }
      }

      const user = new HookedUser({ name: "Hook", email: "hook@example.com" });
      await user.save();
      saveCalled = false;

      user.name = "Updated";
      await user.save();
      expect(saveCalled).toBe(true);
    });

    it("runs after specialized callback on create", async () => {
      const order: string[] = [];
      class HookedUser extends ApplicationRecord {
        static database = db;
        static tableName = "users";
        static schema = User.schema;

        declare id: number;
        declare name: string;
        declare email: string;

        protected afterCreate(): void {
          order.push("afterCreate");
        }

        protected afterSave(): void {
          order.push("afterSave");
        }
      }

      const user = new HookedUser({ name: "Hook", email: "hook@example.com" });
      await user.save();
      expect(order).toEqual(["afterCreate", "afterSave"]);
    });

    it("runs after specialized callback on update", async () => {
      const order: string[] = [];
      class HookedUser extends ApplicationRecord {
        static database = db;
        static tableName = "users";
        static schema = User.schema;

        declare id: number;
        declare name: string;
        declare email: string;

        protected afterUpdate(): void {
          order.push("afterUpdate");
        }

        protected afterSave(): void {
          order.push("afterSave");
        }
      }

      const user = new HookedUser({ name: "Hook", email: "hook@example.com" });
      await user.save();
      order.length = 0;

      user.name = "Updated";
      await user.save();
      expect(order).toEqual(["afterUpdate", "afterSave"]);
    });
  });

  describe("#afterDestroy()", () => {
    it("calls afterDestroy when destroying a record", async () => {
      let destroyCalled = false;
      class HookedUser extends ApplicationRecord {
        static database = db;
        static tableName = "users";
        static schema = User.schema;

        declare id: number;
        declare name: string;
        declare email: string;

        protected afterDestroy(): void {
          destroyCalled = true;
        }
      }

      const user = new HookedUser({ name: "Hook", email: "hook@example.com" });
      await user.save();
      user.destroy();
      expect(destroyCalled).toBe(true);
    });

    it("does not call afterDestroy when not destroying", async () => {
      let destroyCalled = false;
      class HookedUser extends ApplicationRecord {
        static database = db;
        static tableName = "users";
        static schema = User.schema;

        declare id: number;
        declare name: string;
        declare email: string;

        protected afterDestroy(): void {
          destroyCalled = true;
        }
      }

      const user = new HookedUser({ name: "Hook", email: "hook@example.com" });
      await user.save();
      expect(destroyCalled).toBe(false);
    });
  });

  describe("#validate()", () => {
    it("returns empty array for valid record", async () => {
      const user = new User({ name: "Valid", email: "valid@example.com" });
      expect(await user.validate()).toEqual([]);
    });

    it("returns errors for invalid record", async () => {
      const user = new User({ name: 123 as any, email: 456 as any });
      const errors = await user.validate();
      expect(errors.length).toBe(2);
      expect(errors.some((e) => e.column === "name")).toBe(true);
      expect(errors.some((e) => e.column === "email")).toBe(true);
      expect(errors.every((e) => e.code === "type")).toBe(true);
    });

    it("returns codes and params instead of messages", async () => {
      class StrictUser extends ApplicationRecord {
        static database = db;
        static tableName = "users";
        static schema = v.object({
          id: v.optional(v.number()),
          name: v.pipe(v.string(), v.minLength(5)),
          email: v.optional(v.pipe(v.string(), v.email())),
        });

        declare id: number;
        declare name: string;
        declare email: string;
      }

      const user = new StrictUser({ name: "ab", email: "invalid" });
      const errors = await user.validate();

      expect(errors).toEqual([
        { column: "name", code: "length", params: { min: 5 } },
        { column: "email", code: "email" },
      ]);
    });

    it("returns multiple errors for same column", async () => {
      class StrictUser extends ApplicationRecord {
        static database = db;
        static tableName = "users";
        static schema = v.object({
          id: v.optional(v.number()),
          name: v.pipe(v.string(), v.minLength(5), v.maxLength(1)),
          email: v.optional(v.pipe(v.string(), v.email())),
        });

        declare id: number;
        declare name: string;
        declare email: string;
      }

      const user = new StrictUser({ name: "abc", email: "ok@example.com" });
      const nameErrors = (await user.validate()).filter(
        (e) => e.column === "name",
      );
      expect(nameErrors).toEqual([
        { column: "name", code: "length", params: { min: 5 } },
        { column: "name", code: "length", params: { max: 1 } },
      ]);
    });

    it("maps a missing required value to the required code", async () => {
      const user = new User({ email: "missing@example.com" });
      const errors = await user.validate();
      expect(errors).toEqual([{ column: "name", code: "required" }]);
    });

    it("never echoes the submitted value", async () => {
      const user = new User({ name: "short" });
      const errors = await user.validate();
      expect(JSON.stringify(errors)).not.toContain("short");
    });

    it("returns empty array when optional fields are missing", async () => {
      const user = new User({ name: "Test" });
      expect(await user.validate()).toEqual([]);
    });

    it("combines schema and custom validation errors", async () => {
      class CustomUser extends ApplicationRecord {
        static database = db;
        static tableName = "users";
        static schema = v.object({
          id: v.optional(v.number()),
          name: v.string(),
          email: v.optional(v.string()),
        });

        declare id: number;
        declare name: string;
        declare email: string;

        protected async validateCustom() {
          const errors: ValidationError[] = [];
          if (this.name === "BadName") {
            errors.push({ column: "name", code: "not_allowed" });
          }
          return errors;
        }
      }

      const user = new CustomUser({
        name: "BadName",
        email: "bad@example.com",
      });
      const errors = await user.validate();
      expect(errors.length).toBe(1);
      expect(errors[0]).toEqual({ column: "name", code: "not_allowed" });
    });

    it("returns only schema errors when custom validation passes", async () => {
      class CustomUser extends ApplicationRecord {
        static database = db;
        static tableName = "users";
        static schema = v.object({
          id: v.optional(v.number()),
          name: v.string(),
          email: v.optional(v.string()),
        });

        declare id: number;
        declare name: string;
        declare email: string;

        protected async validateCustom() {
          return [];
        }
      }

      const user = new CustomUser({ name: 123 as any });
      const errors = await user.validate();
      expect(errors.length).toBe(1);
      expect(errors[0].column).toBe("name");
    });
  });

  describe("#save() validation", () => {
    it("throws RecordInvalid carrying schema errors and writes nothing", async () => {
      const before = User.count();
      const user = new User({ name: 123 as any });

      const error = await user.save().catch((e) => e);

      expect(error).toBeInstanceOf(RecordInvalid);
      expect(error.message).toBe("validation failed: 1 error");
      expect(error.errors).toEqual([
        { column: "name", code: "type", params: { expected: "string" } },
      ]);
      expect(User.count()).toBe(before);
    });

    it("throws RecordInvalid carrying custom validation errors", async () => {
      class TakenUser extends ApplicationRecord {
        static database = db;
        static tableName = "users";
        static schema = v.object({
          id: v.optional(v.number()),
          name: v.string(),
          email: v.optional(v.string()),
        });

        declare id: number;
        declare name: string;
        declare email: string;

        protected async validateCustom() {
          return this.name === "taken"
            ? [{ column: "name", code: "taken" }]
            : [];
        }
      }

      const before = User.count();
      const user = new TakenUser({ name: "taken" });
      const error = await user.save().catch((e) => e);

      expect(error).toBeInstanceOf(RecordInvalid);
      expect(error.errors).toEqual([{ column: "name", code: "taken" }]);
      expect(User.count()).toBe(before);
    });

    it("does not run hooks for an invalid record", async () => {
      let hookCalled = false;

      class HookedUser extends ApplicationRecord {
        static database = db;
        static tableName = "users";
        static schema = v.object({
          id: v.optional(v.number()),
          name: v.pipe(v.string(), v.minLength(3)),
          email: v.optional(v.string()),
        });

        declare id: number;
        declare name: string;
        declare email: string;

        protected beforeCreate() {
          hookCalled = true;
        }
      }

      const user = new HookedUser({ name: "x" });
      await expect(user.save()).rejects.toBeInstanceOf(RecordInvalid);
      expect(hookCalled).toBe(false);
    });

    it("saves a valid record", async () => {
      const user = new User({ name: "AsyncSave", email: "async@example.com" });
      await user.save();
      expect(user.id).toBeGreaterThan(0);
      expect(User.find(user.id)!.name).toBe("AsyncSave");
    });
  });

  describe("#checkUniqueness()", () => {
    class TestArtist extends ApplicationRecord {
      static database = db;
      static tableName = "artists";
      static schema = v.object({
        id: v.optional(v.number()),
        name: v.string(),
        created_at: v.string(),
        updated_at: v.string(),
      });

      declare id: number;
      declare name: string;
      declare created_at: string;
      declare updated_at: string;
    }

    it("returns true for a new unique value", async () => {
      const artist = new TestArtist({ name: "UniqueName" });
      expect(artist.checkUniqueness("name", "UniqueName")).toBe(true);
    });

    it("returns false for a duplicate value", async () => {
      const existing = new TestArtist({ name: "ExistingArtist" });
      await existing.save();

      const artist = new TestArtist({ name: "ExistingArtist" });
      expect(artist.checkUniqueness("name", "ExistingArtist")).toBe(false);
    });

    it("returns true when updating an existing record with its own value", async () => {
      const existing = new TestArtist({ name: "OwnValue" });
      await existing.save();

      expect(existing.checkUniqueness("name", "OwnValue")).toBe(true);
    });

    it("treats id 0 as new and does not exclude a matching row", async () => {
      const existing = new TestArtist({ name: "ZeroUniqueness" });
      await existing.save();

      const zero = new TestArtist({ id: 0, name: "ZeroUniqueness" });
      expect(zero.checkUniqueness("name", "ZeroUniqueness")).toBe(false);
    });
  });

  describe("#checkUniquenessRaw()", () => {
    class TestArtist extends ApplicationRecord {
      static database = db;
      static tableName = "artists";
      static schema = v.object({
        id: v.optional(v.number()),
        name: v.string(),
        created_at: v.string(),
        updated_at: v.string(),
      });

      declare id: number;
      declare name: string;
      declare created_at: string;
      declare updated_at: string;
    }

    it("returns true for a unique combination", async () => {
      const artist = new TestArtist({ name: "ComboUnique" });
      expect(artist.checkUniquenessRaw("name = ?", ["ComboUnique"])).toBe(true);
    });

    it("returns false for a duplicate combination", async () => {
      const existing = new TestArtist({ name: "ComboExisting" });
      await existing.save();

      const artist = new TestArtist({ name: "ComboExisting" });
      expect(artist.checkUniquenessRaw("name = ?", ["ComboExisting"])).toBe(
        false,
      );
    });

    it("returns true when updating an existing record with its own values", async () => {
      const existing = new TestArtist({ name: "ComboOwn" });
      await existing.save();

      expect(existing.checkUniquenessRaw("name = ?", ["ComboOwn"])).toBe(true);
    });

    it("treats id 0 as new and does not exclude a matching row", async () => {
      const existing = new TestArtist({ name: "ComboZero" });
      await existing.save();

      const zero = new TestArtist({ id: 0, name: "ComboZero" });
      expect(zero.checkUniquenessRaw("name = ?", ["ComboZero"])).toBe(false);
    });

    it("supports multi-column conditions", async () => {
      const existing = new TestArtist({ name: "MultiCol" });
      await existing.save();

      const artist = new TestArtist({ name: "MultiCol" });
      expect(
        artist.checkUniquenessRaw("name = ? AND created_at = ?", [
          "MultiCol",
          existing.created_at,
        ]),
      ).toBe(false);
    });

    it("returns true when multi-column condition does not match", async () => {
      const existing = new TestArtist({ name: "MultiColNoMatch" });
      await existing.save();

      const artist = new TestArtist({ name: "MultiColNoMatch" });
      expect(
        artist.checkUniquenessRaw("name = ? AND created_at = ?", [
          "MultiColNoMatch",
          "2099-01-01",
        ]),
      ).toBe(true);
    });
  });

  describe("#trackedChanges()", () => {
    class TrackedItem extends ApplicationRecord {
      static database = db;
      static tableName = "artists";
      static schema = v.object({
        id: v.optional(v.number()),
        name: v.string(),
        created_at: v.string(),
        updated_at: v.string(),
      });
      declare id: number;
      declare name: string;
      declare created_at: string;
      declare updated_at: string;
    }

    it("returns null after save without trackChanges", async () => {
      const item = new TrackedItem({ name: "NoTrack" });
      await item.save();
      expect(item.trackedChanges()).toBeNull();
    });

    it("captures changes as old/new pairs after save with trackChanges", async () => {
      const item = new TrackedItem({ name: "Original" });
      await item.save();

      item.name = "Updated";
      await item.save({ trackChanges: true });

      const changes = item.trackedChanges();
      expect(changes).not.toBeNull();
      expect(changes!.name).toEqual(["Original", "Updated"]);
    });

    it("captures old/undefined pairs after destroy with trackChanges", async () => {
      const item = new TrackedItem({ name: "ToBeDestroyed" });
      await item.save();

      item.destroy({ trackChanges: true });

      const changes = item.trackedChanges();
      expect(changes).not.toBeNull();
      expect(changes!.name).toEqual(["ToBeDestroyed", undefined]);
      expect(changes!.id).toEqual([item.id, undefined]);
    });

    it("returns null after destroy without trackChanges", async () => {
      const item = new TrackedItem({ name: "NoTrackDestroy" });
      await item.save();

      item.destroy();

      expect(item.trackedChanges()).toBeNull();
    });

    it("captures multiple changed columns", async () => {
      const item = new TrackedItem({ name: "A" });
      await item.save();

      item.name = "B";
      await item.save({ trackChanges: true });

      const changes = item.trackedChanges()!;
      expect(changes.name).toEqual(["A", "B"]);
      // created_at and updated_at may or may not appear depending on timing;
      // the key assertion is that the changed column is captured correctly
    });

    it("captures insert as undefined-to-value pairs", async () => {
      const item = new TrackedItem({ name: "NewRecord" });
      await item.save({ trackChanges: true });

      const changes = item.trackedChanges();
      expect(changes).not.toBeNull();
      expect(changes!.name).toEqual([undefined, "NewRecord"]);
      expect(changes!.id).toEqual([undefined, item.id]);
    });

    it("is not set by default save without trackChanges", async () => {
      const item = new TrackedItem({ name: "DefaultSave" });
      await item.save();
      item.name = "Changed";
      await item.save();
      expect(item.trackedChanges()).toBeNull();
    });
  });

  describe(".where()", () => {
    it("returns an ApplicationRecordQuery with the filter applied", async () => {
      const query = User.where("name", "=", "test");
      const { sql, params } = query.toSQL();

      expect(sql).toBe("SELECT * FROM users WHERE name = ?");
      expect(params).toEqual(["test"]);
    });

    it("allows chaining query methods after where", async () => {
      const query = User.where("name", "=", "test").limit(10);
      const { sql, params } = query.toSQL();

      expect(sql).toBe("SELECT * FROM users WHERE name = ? LIMIT 10");
      expect(params).toEqual(["test"]);
    });
  });

  describe(".fuzzySearch()", () => {
    it("returns an ApplicationRecordQuery with the filter applied", async () => {
      const query = User.fuzzySearch("alice", ["name", "email"]);
      const { sql, params } = query.toSQL();

      expect(sql).toBe(
        "SELECT * FROM users WHERE (name LIKE ? OR email LIKE ?)",
      );
      expect(params).toEqual(["%alice%", "%alice%"]);
    });

    it("returns no conditions for null terms", async () => {
      const query = User.fuzzySearch(null, ["name"]);
      const { sql, params } = query.toSQL();

      expect(sql).toBe("SELECT * FROM users");
      expect(params).toEqual([]);
    });

    it("allows chaining query methods after fuzzySearch", async () => {
      const query = User.fuzzySearch("alice", ["name"]).limit(10);
      const { sql, params } = query.toSQL();

      expect(sql).toBe("SELECT * FROM users WHERE (name LIKE ?) LIMIT 10");
      expect(params).toEqual(["%alice%"]);
    });

    it("returns matching records", async () => {
      await new User({
        name: "alice wonderland",
        email: "alice@example.com",
      }).save();
      await new User({ name: "bob", email: "bob@example.com" }).save();

      const records = User.fuzzySearch("wonderland", ["name", "email"]).all();

      expect(records.length).toBe(1);
      expect(records[0].name).toBe("alice wonderland");

      db.getDb().run("DELETE FROM users");
    });
  });

  describe(".join()", () => {
    it("returns an ApplicationRecordQuery with the join applied", async () => {
      const query = User.join("INNER JOIN artists a ON a.name = users.name");
      const { sql, params } = query.toSQL();

      expect(sql).toBe(
        "SELECT * FROM users INNER JOIN artists a ON a.name = users.name",
      );
      expect(params).toEqual([]);
    });

    it("allows chaining query methods after join", async () => {
      const query = User.join("INNER JOIN artists a ON a.name = users.name")
        .where("name", "=", "test")
        .limit(10);
      const { sql, params } = query.toSQL();

      expect(sql).toBe(
        "SELECT * FROM users INNER JOIN artists a ON a.name = users.name WHERE name = ? LIMIT 10",
      );
      expect(params).toEqual(["test"]);
    });

    it("binds join params before where params regardless of call order", async () => {
      const join = "INNER JOIN artists a ON a.name = ?";

      const query = User.join(join, ["alice"]).where(
        "email",
        "=",
        "alice@example.com",
      );
      expect(query.toSQL().params).toEqual(["alice", "alice@example.com"]);

      const reversed = User.where("email", "=", "alice@example.com").join(
        join,
        ["alice"],
      );
      expect(reversed.toSQL().params).toEqual(["alice", "alice@example.com"]);
    });

    it("returns matching records", async () => {
      db.getDb().run("DELETE FROM artists");
      await new User({ name: "alice", email: "alice@example.com" }).save();
      await new User({ name: "bob", email: "bob@example.com" }).save();
      db.getDb().run("INSERT INTO artists (name) VALUES ('alice')");

      const records = User.selectClear()
        .select("users.*")
        .join("INNER JOIN artists a ON a.name = users.name")
        .all();

      expect(records.length).toBe(1);
      expect(records[0].name).toBe("alice");
      expect(records[0].email).toBe("alice@example.com");

      db.getDb().run("DELETE FROM users");
      db.getDb().run("DELETE FROM artists");
    });
  });
});
