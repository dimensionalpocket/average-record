# @dimensionalpocket/average-record

A lightweight Active Record-style ORM with an abstract `Database` class. Currently ships with a `BunSqliteDatabase` implementation backed by `bun:sqlite`.

## Installation

The package is distributed from GitHub (no npm release). The entry point is `bun/index.ts`, so Bun consumes the TypeScript source directly — no build step, no `dist/`.

Pin a tag:

<!-- x-release-please-start-version -->

```bash
bun add github:dimensionalpocket/average-record#0.1.0
```

<!-- x-release-please-end -->

Or add it to `package.json` directly:

<!-- x-release-please-start-version -->

```json
{
  "dependencies": {
    "@dimensionalpocket/average-record": "github:dimensionalpocket/average-record#0.1.0"
  }
}
```

<!-- x-release-please-end -->

## Features

- **Lazy connection**: Database connects only on first query
- **Synchronous API**: No `async/await` overhead; queries block the event loop
- **Valibot schemas**: Validation and type inference powered by Valibot
- **Type-safe models**: Generic attributes for TypeScript support
- **Fluent query builder**: Chainable `where()`, `orderBy()`, `limit()` and more via `ApplicationRecordQuery`

## Usage

### Database Setup

```typescript
import { BunSqliteDatabase } from "@dimensionalpocket/average-record";

const db = new BunSqliteDatabase(
  "app", // logical name, used in log tags
  "app.db", // file path, or ":memory:"
  undefined, // bun:sqlite DatabaseOptions
  ["PRAGMA journal_mode = WAL", "PRAGMA foreign_keys = ON"],
  30_000, // optional idle timeout in ms
);
```

The connection is lazy: it opens on the first query and `getDb()` refreshes the activity timestamp.
Passing an idle timeout also starts a background check that closes the handle after inactivity; the
same check can be triggered manually.

```typescript
db.checkIdle(); // closes the handle if it has been idle past the timeout
db.close(); // closes now and stops the background check

// Consistent copy of the whole database (VACUUM INTO). The target directory must exist.
db.backupToFile("/backups/app.sqlite");
```

### Model Definition

```typescript
import * as v from "valibot";
import { ApplicationRecord } from "@dimensionalpocket/average-record";

class User extends ApplicationRecord {
  static database = db;
  static tableName = "users";
  static schema = v.object({
    id: v.optional(v.number()),
    name: v.string(),
    email: v.pipe(v.string(), v.metadata({ redacted: true })),
  });

  declare id: number;
  declare name: string;
  declare email: string;
}
```

### CRUD Operations

```typescript
// Create
const user = new User({ name: "Alice", email: "alice@example.com" });
user.save();

// Read
const found = User.find(user.id);
const all = User.all();

// Stream records one at a time (memory-efficient for large tables)
for (const u of User.each()) {
  // process one user at a time without loading them all in memory
}

// Raw database rows (plain objects, not model instances)
const rawAll = User.allRaw();
for (const rawRow of User.eachRaw()) {
  // process raw row directly
}

// Update
found!.name = "Alice Smith";
found!.save();

// Destroy
found!.destroy();

// Get current database state (ignores unsaved changes)
const beforeState = user.persisted();
const safeBeforeState = user.persisted(true); // redacts sensitive columns

// Serialization
const json = user.toJSON();
const safeJson = user.toJSON(true); // redacts sensitive columns

// Diff tracking (useful for audit logs)
user.name = "New Name";
const diff = user.changes(); // { name: "New Name" }
const safeDiff = user.changes(true); // redacted columns become "[redacted]"

// Dirty check against the persisted row
const isDirty = user.changed();

// Recorded change history from the last tracked write
user.save({ trackChanges: true });
const tracked = user.trackedChanges(); // { name: ["New Name", "Newer Name"] }, or null
// Inserts record [undefined, value], updates [before, after], and
// destroy({ trackChanges: true }) records [value, undefined].

// Timestamps: save() calls this automatically when the schema defines the columns
user.setTimestamps(); // sets created_at on insert, bumps updated_at
user.setTimestamps({ updatedAt: false }); // preserve an existing updated_at
```

### Query Builder

Use `scope()` or any chainable method to create an `ApplicationRecordQuery` and build filtered, sorted, and paginated queries:

```typescript
// Filter with WHERE conditions
const activeUsers = User.where("status", "=", "active").all();

// Chain multiple conditions (joined with AND)
const admins = User.where("role", "=", "admin").where("active", "=", 1).all();

// Sort and paginate
const page = User.where("status", "=", "active")
  .orderBy("created_at", "DESC")
  .limit(20)
  .offset(40)
  .all();

// Stream filtered results
for (const user of User.where("status", "=", "active").limit(100).each()) {
  // process one user at a time
}

// Use raw SQL fragments for complex conditions
const results = User.where("status", "=", "active")
  .whereRaw("score > ? AND score < ?", [50, 100])
  .orderBy("score", "DESC")
  .limit(10)
  .all();

// IN clause
const selected = User.whereIn("id", [1, 2, 3]).all();

// NOT IN clause
const excluded = User.whereNotIn("status", ["archived", "deleted"]).all();

// Raw SQL joins, appended after the FROM clause. The fragment is passed
// through verbatim, so INNER JOIN, LEFT JOIN, CROSS JOIN, and join
// subqueries all work. Multiple `.join()` calls accumulate. With the
// default `SELECT *`, joined columns that collide with model column names
// overwrite them; use `selectClear()` to pick explicit columns.
const joined = User.selectClear()
  .select("users.*")
  .select("s.score")
  .join("INNER JOIN stats s ON s.user_id = users.id AND s.score > ?", [50])
  .where("status", "=", "active")
  .orderBy("s.score", "DESC")
  .all();

// LEFT JOIN example
const withLeftJoin = User.join(
  "LEFT JOIN stats s ON s.user_id = users.id",
).all();

// Fuzzy search: splits `terms` on spaces, one AND-combined `(col LIKE ? OR ...)`
// group per term (each term must match any column). No-op when terms is
// null/undefined/blank, so request params can be passed through directly.
const matches = User.fuzzySearch("alice wonder", ["name", "email"]).all();

// Raw SQL fragments are allowed as columns (pattern bound once per `?`)
const users = User.fuzzySearch("alice smith", [
  "name",
  "EXISTS (SELECT 1 FROM teams WHERE id = users.team_id AND (name LIKE ? OR slug LIKE ?))",
]).all();

// Start fresh with an empty scope
const scope = User.scope();
const allUsers = scope.all();

// Inspect the generated SQL and bind parameters without running the query
const { sql, params } = User.where("status", "=", "active").toSQL();
```

### Counting Records

Use `count()` to count records — chain conditions first:

```typescript
// Count all records
const total = User.count();

// Count with conditions
const activeCount = User.where("status", "=", "active").count();

// Count with multiple conditions
const adminCount = User.where("role", "=", "admin")
  .where("active", "=", 1)
  .count();
```

### Selecting Specific Columns

Use `select()` to limit the columns returned by `allRaw()` and `eachRaw()`:

```typescript
const names = User.select("name, email").where("active", "=", 1).allRaw();
```

### Finding Records

```typescript
// Find by primary key
const user = User.find(1);

// Find by primary key with additional conditions
const result = User.where("status", "=", "active").find(42);

// First matching record
const first = User.where("status", "=", "active").first();

// First with ordering
const latest = User.orderBy("created_at", "DESC").first();
```

### Validation

Use `validate()` to check an instance against its schema before saving:

```typescript
const user = new User({ name: "", email: "invalid" });
const errors = await user.validate();
// [
//   { column: "name", message: "String must contain at least 1 character(s)" },
//   { column: "email", message: "Invalid email" }
// ]

if (errors.length > 0) {
  // handle errors
}
```

Multiple errors can target the same column. Returns an empty array when valid.

### Custom Validation

Override `validateCustom()` to add model-specific validations (uniqueness, conditional checks, etc.):

```typescript
class User extends ApplicationRecord {
  // ...

  protected async validateCustom() {
    const errors: ValidationError[] = [];
    if (!this.checkUniqueness("email", this.email)) {
      errors.push({ column: "email", message: "is already taken" });
    }
    return errors;
  }
}

const user = new User({ email: "alice@test.com" });
const errors = await user.validate(); // schema errors + custom errors
```

`checkUniqueness(field, value)` returns `true` if the value is unique and available to use. It automatically excludes the current record when updating.

`checkUniquenessRaw(condition, params)` takes an arbitrary WHERE condition (no table prefix) for multi-column checks, for example `checkUniquenessRaw("remote_id = ? AND platform = ?", [this.remote_id, this.platform])`. It excludes the current record by primary key the same way.

### Lifecycle Hooks

`save()` and `destroy()` call lifecycle hooks at specific points. Override these in subclasses:

**Save hooks** (called in order):

1. `beforeCreate()` or `beforeUpdate()` — before the database operation
2. Database insert/update
3. `afterCreate()` or `afterUpdate()` — after the database operation
4. `afterSave()` — after any save (runs after the specialized callback)

**Destroy hooks:**

1. Database delete
2. `afterDestroy()`

```typescript
class User extends ApplicationRecord {
  static database = db;
  static tableName = "users";
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

  protected beforeCreate(): void {
    const record = this as Record<string, unknown>;
    const now = new Date().toISOString();
    record.created_at = record.created_at ?? now;
    record.updated_at = now;
  }

  protected beforeUpdate(): void {
    const record = this as Record<string, unknown>;
    record.updated_at = new Date().toISOString();
  }

  protected afterSave(): void {
    console.log(`User ${this.id} was saved`);
  }

  protected afterDestroy(): void {
    console.log(`User ${this.id} was deleted`);
  }
}

const user = new User({ name: "Alice" });
user.save();
// beforeCreate → insert → afterCreate → afterSave

user.name = "Alice Smith";
user.save();
// beforeUpdate → update → afterUpdate → afterSave

user.destroy();
// delete → afterDestroy
```

Subclasses can call `super` to extend parent behavior:

```typescript
class Admin extends User {
  protected beforeCreate(): void {
    super.beforeCreate();
    (this as Record<string, unknown>).role = "admin";
  }
}
```

## Migrations

### Migration Files

Place SQL files in a migrations directory using the naming convention `{version}_{name}.{up|down}.sql`:

```
migrations/
├── 001_create_users.up.sql
├── 001_create_users.down.sql
├── 002_create_posts.up.sql
└── 002_create_posts.down.sql
```

Applied versions are tracked in a `schema_migrations` table.

### Migrator

The `Migrator` class executes migrations programmatically:

```typescript
import { BunSqliteDatabase, Migrator } from "@dimensionalpocket/average-record";

const db = new BunSqliteDatabase("app.db");

// Apply all pending migrations
const migrator = new Migrator(db, {
  migrationsDir: "migrations",
  dump: true,
  schemaPath: "schema.sql",
});
migrator.run();

// Roll back only the most recent migration
const downMigrator = new Migrator(db, {
  migrationsDir: "migrations",
  direction: "down",
});
downMigrator.run();

// Roll back to a specific version
const rollbackMigrator = new Migrator(db, {
  migrationsDir: "migrations",
  direction: "down",
  version: 1,
});
rollbackMigrator.run();
```

### MigrationExecutor

The `MigrationExecutor` is a CLI helper that parses `process.argv` and runs a `Migrator` internally. Create a script and run it from the command line:

```typescript
// scripts/migrate.ts
import {
  BunSqliteDatabase,
  MigrationExecutor,
} from "@dimensionalpocket/average-record";

const db = new BunSqliteDatabase("app.db", undefined, [
  "PRAGMA foreign_keys = ON",
]);

const executor = new MigrationExecutor(db, {
  migrationsDir: "migrations",
  schemaPath: "schema.sql",
});

executor.run();
```

```bash
bun scripts/migrate.ts                    # Apply all pending migrations
bun scripts/migrate.ts --dump             # Apply and dump schema
bun scripts/migrate.ts --down             # Roll back most recent migration
bun scripts/migrate.ts --down -v 1        # Roll back to version 1
bun scripts/migrate.ts --help             # Show help
```

## Development

Run from the repository root — `package.json` and `bunfig.toml` live there, and `bunfig.toml` scopes
the test root to `bun/`.

```bash
bun install
bun test
bun check
bun fmt bun
bun fmt --check bun
```

`bun check` is Bun's native type checker (no `tsc`). Scope the formatter to `bun/`: a bare `bun fmt`
would also rewrite the Rust docs and root config.
