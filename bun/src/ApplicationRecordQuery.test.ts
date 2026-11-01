import { describe, it, expect, beforeAll } from "bun:test";
import * as v from "valibot";
import { ApplicationRecord } from "./ApplicationRecord";
import { ApplicationRecordQuery } from "./ApplicationRecordQuery";
import { BunSqliteDatabase } from "./BunSqliteDatabase";

class TestModel extends ApplicationRecord {
  static tableName = "test_models";
  static schema = v.object({
    id: v.optional(v.number()),
    name: v.string(),
    status: v.string(),
  });

  declare id: number;
  declare name: string;
  declare status: string;
}

const db = new BunSqliteDatabase(":memory:", ":memory:", { strict: true }, [
  "CREATE TABLE test_models (id INTEGER PRIMARY KEY, name TEXT, status TEXT)",
  "CREATE TABLE test_stats (id INTEGER PRIMARY KEY, test_model_id INTEGER, score INTEGER)",
]);

beforeAll(() => {
  TestModel.database = db;
});

describe("ApplicationRecordQuery", () => {
  describe(".toSQL()", () => {
    it("returns empty string with no conditions", () => {
      const query = new ApplicationRecordQuery(TestModel);
      const result = query.toSQL();

      expect(result.sql).toBe("SELECT * FROM test_models");
      expect(result.params).toEqual([]);
    });

    it("generates WHERE clause", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.where("status", "=", "active");
      const result = query.toSQL();

      expect(result.sql).toBe("SELECT * FROM test_models WHERE status = ?");
      expect(result.params).toEqual(["active"]);
    });

    it("chains multiple WHERE conditions", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.where("status", "=", "active").where("role", "!=", "banned");
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT * FROM test_models WHERE status = ? AND role != ?",
      );
      expect(result.params).toEqual(["active", "banned"]);
    });

    it("generates ORDER BY clause", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.orderBy("created_at", "DESC");
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT * FROM test_models ORDER BY created_at DESC",
      );
      expect(result.params).toEqual([]);
    });

    it("generates multiple ORDER BY clauses", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.orderBy("status", "ASC").orderBy("name", "DESC");
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT * FROM test_models ORDER BY status ASC, name DESC",
      );
      expect(result.params).toEqual([]);
    });

    it("defaults ORDER BY direction to ASC", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.orderBy("name");
      const result = query.toSQL();

      expect(result.sql).toBe("SELECT * FROM test_models ORDER BY name ASC");
    });

    it("generates LIMIT clause", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.limit(10);
      const result = query.toSQL();

      expect(result.sql).toBe("SELECT * FROM test_models LIMIT 10");
      expect(result.params).toEqual([]);
    });

    it("generates OFFSET clause", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.offset(20);
      const result = query.toSQL();

      expect(result.sql).toBe("SELECT * FROM test_models OFFSET 20");
      expect(result.params).toEqual([]);
    });

    it("combines WHERE, ORDER BY, LIMIT, and OFFSET", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query
        .where("status", "=", "active")
        .where("score", ">", 100)
        .orderBy("score", "DESC")
        .limit(10)
        .offset(20);
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT * FROM test_models WHERE status = ? AND score > ? ORDER BY score DESC LIMIT 10 OFFSET 20",
      );
      expect(result.params).toEqual(["active", 100]);
    });

    it("returns a copy of params array", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.where("id", "=", 1);
      const result1 = query.toSQL();
      const result2 = query.toSQL();

      expect(result1.params).not.toBe(result2.params);
      expect(result1.params).toEqual(result2.params);
    });

    it("handles numeric values in WHERE", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.where("age", ">=", 18);
      const result = query.toSQL();

      expect(result.sql).toBe("SELECT * FROM test_models WHERE age >= ?");
      expect(result.params).toEqual([18]);
    });

    it("handles null values in WHERE", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.where("deleted_at", "IS", null);
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT * FROM test_models WHERE deleted_at IS ?",
      );
      expect(result.params).toEqual([null]);
    });
  });

  describe(".select()", () => {
    it("appends multiple fragments to the select list", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.select("name").select("status");
      const result = query.toSQL();

      expect(result.sql).toBe("SELECT *, name, status FROM test_models");
      expect(result.params).toEqual([]);
    });

    it("defaults to * when no select fragments are added", () => {
      const query = new ApplicationRecordQuery(TestModel);
      const result = query.toSQL();

      expect(result.sql).toBe("SELECT * FROM test_models");
    });

    it("returns this to allow chaining", () => {
      const query = new ApplicationRecordQuery(TestModel);
      expect(query.select("name")).toBe(query);
    });

    it("combines select fragments with other clauses", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query
        .select("name")
        .where("status", "=", "active")
        .orderBy("name", "DESC");
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT *, name FROM test_models WHERE status = ? ORDER BY name DESC",
      );
      expect(result.params).toEqual(["active"]);
    });
  });

  describe(".selectClear()", () => {
    it("empties the select list", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.select("name").selectClear();

      expect(() => query.toSQL()).toThrow(/selectValue is empty/);
    });

    it("returns this to allow chaining", () => {
      const query = new ApplicationRecordQuery(TestModel);
      expect(query.selectClear()).toBe(query);
    });

    it("allows selecting fresh columns after clearing", () => {
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('foo', 'active')",
      );

      const query = new ApplicationRecordQuery(TestModel);
      query.selectClear().select("name").select("status");
      const rows = query.allRaw();

      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe("foo");
      expect(rows[0].status).toBe("active");

      db.getDb().run("DELETE FROM test_models");
    });

    it("throws when consuming a query with an empty select list", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.selectClear();

      expect(() => query.toSQL()).toThrow(/selectValue is empty/);
    });

    it("throws from allRaw when select list is empty", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.selectClear();

      expect(() => query.allRaw()).toThrow(/selectValue is empty/);
    });
  });

  describe(".join()", () => {
    it("appends a single join after the FROM clause", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.join("INNER JOIN test_stats s ON s.test_model_id = test_models.id");
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT * FROM test_models INNER JOIN test_stats s ON s.test_model_id = test_models.id",
      );
      expect(result.params).toEqual([]);
    });

    it("passes LEFT JOIN fragments through verbatim", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.join("LEFT JOIN test_stats s ON s.test_model_id = test_models.id");
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT * FROM test_models LEFT JOIN test_stats s ON s.test_model_id = test_models.id",
      );
    });

    it("accumulates multiple joins in call order", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query
        .join("INNER JOIN test_stats s ON s.test_model_id = test_models.id")
        .join("LEFT JOIN test_models parent ON parent.id = test_models.id");
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT * FROM test_models INNER JOIN test_stats s ON s.test_model_id = test_models.id LEFT JOIN test_models parent ON parent.id = test_models.id",
      );
    });

    it("renders joins before WHERE and binds join params first when join is called before where", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query
        .join(
          "INNER JOIN test_stats s ON s.test_model_id = test_models.id AND s.score > ?",
          [50],
        )
        .where("status", "=", "active");
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT * FROM test_models INNER JOIN test_stats s ON s.test_model_id = test_models.id AND s.score > ? WHERE status = ?",
      );
      expect(result.params).toEqual([50, "active"]);
    });

    it("binds join params first when where is called before join", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query
        .where("status", "=", "active")
        .join(
          "INNER JOIN test_stats s ON s.test_model_id = test_models.id AND s.score > ?",
          [50],
        );
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT * FROM test_models INNER JOIN test_stats s ON s.test_model_id = test_models.id AND s.score > ? WHERE status = ?",
      );
      expect(result.params).toEqual([50, "active"]);
    });

    it("combines joins with ORDER BY, LIMIT, and OFFSET", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query
        .join("INNER JOIN test_stats s ON s.test_model_id = test_models.id")
        .orderBy("name", "DESC")
        .limit(10)
        .offset(5);
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT * FROM test_models INNER JOIN test_stats s ON s.test_model_id = test_models.id ORDER BY name DESC LIMIT 10 OFFSET 5",
      );
    });

    it("filters rows through an INNER JOIN", () => {
      db.getDb().run(
        "INSERT INTO test_models (id, name, status) VALUES (1, 'foo', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (id, name, status) VALUES (2, 'bar', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_stats (test_model_id, score) VALUES (1, 10)",
      );

      const query = new ApplicationRecordQuery(TestModel);
      query.join("INNER JOIN test_stats s ON s.test_model_id = test_models.id");
      const rows = query.allRaw();

      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe("foo");
      expect(rows[0].score).toBe(10);

      db.getDb().run("DELETE FROM test_models");
      db.getDb().run("DELETE FROM test_stats");
    });

    it("keeps unmatched rows through a LEFT JOIN", () => {
      db.getDb().run(
        "INSERT INTO test_models (id, name, status) VALUES (1, 'foo', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (id, name, status) VALUES (2, 'bar', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_stats (test_model_id, score) VALUES (1, 10)",
      );

      const query = new ApplicationRecordQuery(TestModel);
      query.join("LEFT JOIN test_stats s ON s.test_model_id = test_models.id");
      const rows = query.allRaw();

      expect(rows.length).toBe(2);
      expect(rows.map((r) => r.name)).toContain("bar");
      expect(rows.filter((r) => r.name === "bar")[0].score).toBeNull();

      db.getDb().run("DELETE FROM test_models");
      db.getDb().run("DELETE FROM test_stats");
    });

    it("binds join params in an executed query", () => {
      db.getDb().run(
        "INSERT INTO test_models (id, name, status) VALUES (1, 'foo', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (id, name, status) VALUES (2, 'bar', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_stats (test_model_id, score) VALUES (1, 100)",
      );
      db.getDb().run(
        "INSERT INTO test_stats (test_model_id, score) VALUES (2, 10)",
      );

      const query = new ApplicationRecordQuery(TestModel);
      query
        .join(
          "INNER JOIN test_stats s ON s.test_model_id = test_models.id AND s.score > ?",
          [50],
        )
        .where("status", "=", "active");
      const rows = query.allRaw();

      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe("foo");

      db.getDb().run("DELETE FROM test_models");
      db.getDb().run("DELETE FROM test_stats");
    });

    it("includes joins and join params in count()", () => {
      db.getDb().run(
        "INSERT INTO test_models (id, name, status) VALUES (1, 'foo', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (id, name, status) VALUES (2, 'bar', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_stats (test_model_id, score) VALUES (1, 10)",
      );
      db.getDb().run(
        "INSERT INTO test_stats (test_model_id, score) VALUES (1, 20)",
      );

      const query = new ApplicationRecordQuery(TestModel);
      query
        .join(
          "INNER JOIN test_stats s ON s.test_model_id = test_models.id AND s.score > ?",
          [5],
        )
        .where("status", "=", "active");

      expect(query.count()).toBe(2);

      db.getDb().run("DELETE FROM test_models");
      db.getDb().run("DELETE FROM test_stats");
    });

    it("counts model rows only when the query has no joins", () => {
      db.getDb().run(
        "INSERT INTO test_models (id, name, status) VALUES (1, 'foo', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (id, name, status) VALUES (2, 'bar', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_stats (test_model_id, score) VALUES (1, 10)",
      );

      const query = new ApplicationRecordQuery(TestModel);

      expect(query.count()).toBe(2);

      db.getDb().run("DELETE FROM test_models");
      db.getDb().run("DELETE FROM test_stats");
    });

    it("maps joined rows to model instances with all()", () => {
      db.getDb().run(
        "INSERT INTO test_models (id, name, status) VALUES (1, 'foo', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (id, name, status) VALUES (2, 'bar', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_stats (test_model_id, score) VALUES (1, 10)",
      );

      const query = new ApplicationRecordQuery(TestModel);
      query
        .select("test_models.*")
        .join("INNER JOIN test_stats s ON s.test_model_id = test_models.id");
      const records = query.all();

      expect(records.length).toBe(1);
      expect(records[0].name).toBe("foo");
      expect(records[0].status).toBe("active");

      db.getDb().run("DELETE FROM test_models");
      db.getDb().run("DELETE FROM test_stats");
    });
  });

  describe(".whereRaw()", () => {
    it("adds raw SQL fragment to WHERE", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.whereRaw("status = ? AND role IN (?, ?)", [
        "active",
        "admin",
        "moderator",
      ]);
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT * FROM test_models WHERE status = ? AND role IN (?, ?)",
      );
      expect(result.params).toEqual(["active", "admin", "moderator"]);
    });

    it("combines where() and whereRaw()", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query
        .where("deleted_at", "IS", null)
        .whereRaw("score > ? AND score < ?", [50, 100]);
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT * FROM test_models WHERE deleted_at IS ? AND score > ? AND score < ?",
      );
      expect(result.params).toEqual([null, 50, 100]);
    });

    it("handles empty params array", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.whereRaw("status = 'active'");
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT * FROM test_models WHERE status = 'active'",
      );
      expect(result.params).toEqual([]);
    });

    it("chains multiple whereRaw() calls", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.whereRaw("a = ?", [1]).whereRaw("b = ?", [2]);
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT * FROM test_models WHERE a = ? AND b = ?",
      );
      expect(result.params).toEqual([1, 2]);
    });
  });

  describe(".whereIn()", () => {
    it("generates IN clause with multiple values", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.whereIn("status", ["active", "pending"]);
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT * FROM test_models WHERE status IN (?, ?)",
      );
      expect(result.params).toEqual(["active", "pending"]);
    });

    it("generates IN clause with single value", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.whereIn("id", [1]);
      const result = query.toSQL();

      expect(result.sql).toBe("SELECT * FROM test_models WHERE id IN (?)");
      expect(result.params).toEqual([1]);
    });

    it("chains whereIn with other where methods", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.where("name", "=", "test").whereIn("role", ["admin", "moderator"]);
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT * FROM test_models WHERE name = ? AND role IN (?, ?)",
      );
      expect(result.params).toEqual(["test", "admin", "moderator"]);
    });

    it("handles numeric arrays", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.whereIn("id", [1, 2, 3]);
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT * FROM test_models WHERE id IN (?, ?, ?)",
      );
      expect(result.params).toEqual([1, 2, 3]);
    });
  });

  describe(".whereNotIn()", () => {
    it("generates NOT IN clause with multiple values", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.whereNotIn("id", [1, 2, 3]);
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT * FROM test_models WHERE id NOT IN (?, ?, ?)",
      );
      expect(result.params).toEqual([1, 2, 3]);
    });

    it("chains whereNotIn with where", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query
        .where("status", "=", "active")
        .whereNotIn("role", ["guest", "trial"]);
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT * FROM test_models WHERE status = ? AND role NOT IN (?, ?)",
      );
      expect(result.params).toEqual(["active", "guest", "trial"]);
    });
  });

  describe(".fuzzySearch()", () => {
    it("adds one parenthesized OR group per term, joined with AND", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.fuzzySearch("night of fire", ["name", "status"]);
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT * FROM test_models WHERE (name LIKE ? OR status LIKE ?) AND (name LIKE ? OR status LIKE ?) AND (name LIKE ? OR status LIKE ?)",
      );
      expect(result.params).toEqual([
        "%night%",
        "%night%",
        "%of%",
        "%of%",
        "%fire%",
        "%fire%",
      ]);
    });

    it("adds a single OR group for a single term", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.fuzzySearch("alice", ["name", "status"]);
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT * FROM test_models WHERE (name LIKE ? OR status LIKE ?)",
      );
      expect(result.params).toEqual(["%alice%", "%alice%"]);
    });

    it("searches a single column", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.fuzzySearch("alice", ["name"]);
      const result = query.toSQL();

      expect(result.sql).toBe("SELECT * FROM test_models WHERE (name LIKE ?)");
      expect(result.params).toEqual(["%alice%"]);
    });

    it("collapses consecutive spaces between terms", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.fuzzySearch("alice   wonder", ["name"]);
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT * FROM test_models WHERE (name LIKE ?) AND (name LIKE ?)",
      );
      expect(result.params).toEqual(["%alice%", "%wonder%"]);
    });

    it("returns silently for undefined terms", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.fuzzySearch(undefined, ["name", "status"]);
      const result = query.toSQL();

      expect(result.sql).toBe("SELECT * FROM test_models");
      expect(result.params).toEqual([]);
    });

    it("returns silently for null terms", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.fuzzySearch(null, ["name", "status"]);
      const result = query.toSQL();

      expect(result.sql).toBe("SELECT * FROM test_models");
      expect(result.params).toEqual([]);
    });

    it("returns silently for empty terms", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.fuzzySearch("", ["name", "status"]);
      const result = query.toSQL();

      expect(result.sql).toBe("SELECT * FROM test_models");
      expect(result.params).toEqual([]);
    });

    it("returns silently for whitespace-only terms", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.fuzzySearch("   ", ["name", "status"]);
      const result = query.toSQL();

      expect(result.sql).toBe("SELECT * FROM test_models");
      expect(result.params).toEqual([]);
    });

    it("chains with where()", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.where("status", "=", "active").fuzzySearch("alice", ["name"]);
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT * FROM test_models WHERE status = ? AND (name LIKE ?)",
      );
      expect(result.params).toEqual(["active", "%alice%"]);
    });

    it("appends raw SQL fragments verbatim with one param per placeholder", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.fuzzySearch("alice", [
        "name",
        "EXISTS (SELECT 1 FROM others WHERE test_models.other_id = others.id AND (label LIKE ? OR tag LIKE ?))",
      ]);
      const result = query.toSQL();

      expect(result.sql).toBe(
        "SELECT * FROM test_models WHERE (name LIKE ? OR EXISTS (SELECT 1 FROM others WHERE test_models.other_id = others.id AND (label LIKE ? OR tag LIKE ?)))",
      );
      expect(result.params).toEqual(["%alice%", "%alice%", "%alice%"]);
    });

    it("throws when columns is empty", () => {
      const query = new ApplicationRecordQuery(TestModel);

      expect(() => query.fuzzySearch("alice", [])).toThrow(
        /at least one column/,
      );
    });

    it("returns rows containing all terms across columns", () => {
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('alice wonderland', 'on')",
      );
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('bob', 'on')",
      );
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('alice', 'off')",
      );

      const query = new ApplicationRecordQuery(TestModel);
      query.fuzzySearch("alice on", ["name", "status"]);
      const instances = query.all();

      expect(instances.length).toBe(1);
      expect(instances[0].name).toBe("alice wonderland");

      db.getDb().run("DELETE FROM test_models");
    });

    it("matches a term in any column", () => {
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('alice wonderland', 'on')",
      );
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('bob', 'on')",
      );
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('alice', 'off')",
      );

      const query = new ApplicationRecordQuery(TestModel);
      query.fuzzySearch("alice", ["name", "status"]);
      const instances = query.all();

      expect(instances.length).toBe(2);
      expect(instances.map((r) => r.name).sort()).toEqual([
        "alice",
        "alice wonderland",
      ]);

      db.getDb().run("DELETE FROM test_models");
    });
  });

  describe(".allRaw()", () => {
    it("returns all rows with no conditions", () => {
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('foo', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('bar', 'inactive')",
      );

      const query = new ApplicationRecordQuery(TestModel);
      const rows = query.allRaw();

      expect(rows.length).toBe(2);
      expect(rows[0].name).toBe("foo");
      expect(rows[1].name).toBe("bar");

      db.getDb().run("DELETE FROM test_models");
    });

    it("filters rows with where conditions", () => {
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('alice', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('bob', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('charlie', 'inactive')",
      );

      const query = new ApplicationRecordQuery(TestModel);
      query.where("status", "=", "active");
      const rows = query.allRaw();

      expect(rows.length).toBe(2);
      expect(rows[0].name).toBe("alice");
      expect(rows[1].name).toBe("bob");

      db.getDb().run("DELETE FROM test_models");
    });

    it("chains where and orderBy", () => {
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('c', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('a', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('b', 'active')",
      );

      const query = new ApplicationRecordQuery(TestModel);
      query.where("status", "=", "active").orderBy("name", "ASC");
      const rows = query.allRaw();

      expect(rows.map((r) => r.name)).toEqual(["a", "b", "c"]);

      db.getDb().run("DELETE FROM test_models");
    });

    it("respects limit and offset", () => {
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('a', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('b', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('c', 'active')",
      );

      const query = new ApplicationRecordQuery(TestModel);
      query.limit(2).offset(1).orderBy("name", "ASC");
      const rows = query.allRaw();

      expect(rows.map((r) => r.name)).toEqual(["b", "c"]);

      db.getDb().run("DELETE FROM test_models");
    });

    it("selects specific columns", () => {
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('foo', 'active')",
      );

      const query = new ApplicationRecordQuery(TestModel);
      query.selectClear().select("name");
      const rows = query.allRaw();

      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe("foo");
      expect(rows[0].status).toBeUndefined();

      db.getDb().run("DELETE FROM test_models");
    });
  });

  describe(".all()", () => {
    it("returns model instances with no conditions", () => {
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('foo', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('bar', 'inactive')",
      );

      const query = new ApplicationRecordQuery(TestModel);
      const instances = query.all();

      expect(instances.length).toBe(2);
      expect(instances[0]).toBeInstanceOf(ApplicationRecord);
      expect(instances[0].name).toBe("foo");
      expect(instances[1].name).toBe("bar");

      db.getDb().run("DELETE FROM test_models");
    });

    it("filters with where conditions", () => {
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('alice', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('bob', 'inactive')",
      );

      const query = new ApplicationRecordQuery(TestModel);
      query.where("status", "=", "active");
      const instances = query.all();

      expect(instances.length).toBe(1);
      expect(instances[0].name).toBe("alice");

      db.getDb().run("DELETE FROM test_models");
    });

    it("chains where and orderBy", () => {
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('c', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('a', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('b', 'active')",
      );

      const query = new ApplicationRecordQuery(TestModel);
      query.where("status", "=", "active").orderBy("name", "ASC");
      const instances = query.all();

      expect(instances.map((r) => r.name)).toEqual(["a", "b", "c"]);

      db.getDb().run("DELETE FROM test_models");
    });
  });

  describe(".first()", () => {
    it("returns first matching record", () => {
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('a', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('b', 'active')",
      );

      const query = new ApplicationRecordQuery(TestModel);
      query.orderBy("name", "ASC");
      const record = query.first();

      expect(record).not.toBeNull();
      expect(record!.name).toBe("a");

      db.getDb().run("DELETE FROM test_models");
    });

    it("returns null when no records match", () => {
      const query = new ApplicationRecordQuery(TestModel);
      query.where("name", "=", "nonexistent");
      const record = query.first();

      expect(record).toBeNull();
    });

    it("applies LIMIT 1 to the query", () => {
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('a', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('b', 'active')",
      );

      const query = new ApplicationRecordQuery(TestModel);
      const record = query.first();

      expect(record).not.toBeNull();
      expect(record!.name).toBe("a");

      db.getDb().run("DELETE FROM test_models");
    });
  });

  describe(".find()", () => {
    it("finds record by primary key", () => {
      db.getDb().run(
        "INSERT INTO test_models (id, name, status) VALUES (42, 'target', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (id, name, status) VALUES (99, 'other', 'active')",
      );

      const query = new ApplicationRecordQuery(TestModel);
      const record = query.find(42);

      expect(record).not.toBeNull();
      expect(record!.id).toBe(42);
      expect(record!.name).toBe("target");

      db.getDb().run("DELETE FROM test_models");
    });

    it("returns null when pk does not match", () => {
      db.getDb().run(
        "INSERT INTO test_models (id, name, status) VALUES (1, 'a', 'active')",
      );

      const query = new ApplicationRecordQuery(TestModel);
      const record = query.find(999);

      expect(record).toBeNull();

      db.getDb().run("DELETE FROM test_models");
    });

    it("combines pk filter with existing where conditions", () => {
      db.getDb().run(
        "INSERT INTO test_models (id, name, status) VALUES (1, 'a', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (id, name, status) VALUES (2, 'b', 'inactive')",
      );

      const query = new ApplicationRecordQuery(TestModel);
      query.where("status", "=", "active");
      const record = query.find(2);

      expect(record).toBeNull();

      db.getDb().run("DELETE FROM test_models");
    });

    it("combines pk filter with existing whereIn conditions", () => {
      db.getDb().run(
        "INSERT INTO test_models (id, name, status) VALUES (1, 'a', 'active')",
      );

      const query = new ApplicationRecordQuery(TestModel);
      query.whereIn("id", [1, 2, 3]);
      const record = query.find(1);

      expect(record).not.toBeNull();
      expect(record!.name).toBe("a");

      db.getDb().run("DELETE FROM test_models");
    });
  });

  describe(".count()", () => {
    it("counts all records with no conditions", () => {
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('a', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('b', 'active')",
      );

      const query = new ApplicationRecordQuery(TestModel);
      expect(query.count()).toBe(2);

      db.getDb().run("DELETE FROM test_models");
    });

    it("counts filtered records", () => {
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('a', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('b', 'inactive')",
      );

      const query = new ApplicationRecordQuery(TestModel);
      query.where("status", "=", "active");
      expect(query.count()).toBe(1);

      db.getDb().run("DELETE FROM test_models");
    });
  });

  describe(".eachRaw()", () => {
    it("iterates over raw rows", () => {
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('a', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('b', 'active')",
      );

      const query = new ApplicationRecordQuery(TestModel);
      query.orderBy("name", "ASC");
      const names: string[] = [];
      for (const row of query.eachRaw()) {
        names.push(row.name as string);
      }

      expect(names).toEqual(["a", "b"]);

      db.getDb().run("DELETE FROM test_models");
    });

    it("respects where conditions", () => {
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('a', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('b', 'inactive')",
      );

      const query = new ApplicationRecordQuery(TestModel);
      query.where("status", "=", "active");
      const names: string[] = [];
      for (const row of query.eachRaw()) {
        names.push(row.name as string);
      }

      expect(names).toEqual(["a"]);

      db.getDb().run("DELETE FROM test_models");
    });
  });

  describe(".each()", () => {
    it("iterates over model instances", () => {
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('a', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('b', 'active')",
      );

      const query = new ApplicationRecordQuery(TestModel);
      query.orderBy("name", "ASC");
      const names: string[] = [];
      for (const instance of query.each()) {
        expect(instance).toBeInstanceOf(ApplicationRecord);
        names.push(instance.name);
      }

      expect(names).toEqual(["a", "b"]);

      db.getDb().run("DELETE FROM test_models");
    });

    it("respects where conditions", () => {
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('a', 'active')",
      );
      db.getDb().run(
        "INSERT INTO test_models (name, status) VALUES ('b', 'inactive')",
      );

      const query = new ApplicationRecordQuery(TestModel);
      query.where("status", "=", "active");
      const names: string[] = [];
      for (const instance of query.each()) {
        names.push(instance.name);
      }

      expect(names).toEqual(["a"]);

      db.getDb().run("DELETE FROM test_models");
    });
  });
});
