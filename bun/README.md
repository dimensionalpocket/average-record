# @dimensionalpocket/average-record

A lightweight Active Record-style ORM with an abstract `Database` class. Currently ships with a `BunSqliteDatabase` implementation backed by `bun:sqlite`.

## Installation

The package is distributed from GitHub (no npm release). The entry point is `bun/index.ts`, so Bun consumes the TypeScript source directly — no build step, no `dist/`.

Pin a tag:

<!-- x-release-please-start-version -->

```bash
bun add github:dimensionalpocket/average-record#0.5.0
```

<!-- x-release-please-end -->

Or add it to `package.json` directly:

<!-- x-release-please-start-version -->

```json
{
  "dependencies": {
    "@dimensionalpocket/average-record": "github:dimensionalpocket/average-record#0.5.0"
  }
}
```

<!-- x-release-please-end -->

## Features

- **Lazy connection**: Database connects only on first query
- **Synchronous queries**: Reads and writes block the event loop rather than returning promises; `save()` is `async` because it runs validation first
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

### Primary Keys

`0`, `null`, and an absent key all mean "new record". `save()` treats such a record as an insert and
**omits the primary-key column**, so SQLite assigns the rowid; the library never writes `0`. A record
is persisted once its primary key is non-zero.

```typescript
const user = new User({ id: 0, name: "Alice", email: "alice@example.com" });

user.persisted(); // null (id 0 means new)
User.find(0); // null (0 is never a stored key)

await user.save(); // INSERT without the id column; user.id is assigned (1, 2, ...)
await user.save(); // UPDATE (the id is now non-zero)

user.destroy(); // DELETE
```

`destroy()` on an unsaved record throws `cannot destroy an unsaved record`. A row with `id = 0` can
only appear through a write that bypasses the library; hosts that want to reject those can add
`CHECK (id != 0)` to their schema.

### Timestamps

`save()` stamps the model's configured timestamp columns. The default is ISO-8601 text.

| Preset                         | `created` / `updated`       | Representation                |
| ------------------------------ | --------------------------- | ----------------------------- |
| `Timestamps.iso8601` (default) | `created_at` / `updated_at` | ISO-8601 string               |
| `Timestamps.epochMillis`       | `created_ts` / `updated_ts` | epoch milliseconds (`number`) |
| `Timestamps.none`              | —                           | automatic timestamps disabled |

```typescript
import { ApplicationRecord, Timestamps } from "average-record";

class Event extends ApplicationRecord {
  static database = db;
  static tableName = "events";
  static timestamps = Timestamps.epochMillis;
  static schema = v.object({
    id: v.optional(v.number()),
    name: v.string(),
    created_ts: v.number(),
    updated_ts: v.number(),
  });
}
```

Custom column names use a `TimestampConfig` literal:

```typescript
static timestamps = {
  created: "inserted_ms",
  updated: "modified_ms",
  format: "millis",
} as const;
```

Rules (identical to the Rust implementation):

- `created` is set only on insert, and only when it is unset — `null`/absent, `""` for ISO, `0` for
  millis.
- `updated` is set on every save unless `save({ skipUpdatedAt: true })`.
- Both columns receive the same clock reading (`Date.now()` for millis, `new Date().toISOString()`
  for ISO), so a new record has `created === updated`.
- `Timestamps.none` disables both.

DDL: `TEXT` for ISO-8601, `INTEGER` for epoch milliseconds.

### CRUD Operations

```typescript
// Create
const user = new User({ name: "Alice", email: "alice@example.com" });
await user.save();

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
await found!.save();

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
await user.save({ trackChanges: true });
const tracked = user.trackedChanges(); // { name: ["New Name", "Newer Name"] }, or null
// Inserts record [undefined, value], updates [before, after], and
// destroy({ trackChanges: true }) records [value, undefined].

// Timestamps: save() calls this automatically using the model's static config
user.setTimestamps(); // sets created on insert, bumps updated on save
user.setTimestamps({ updatedAt: false }); // preserve an existing update timestamp
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

`validate()` checks an instance against its Valibot schema plus `validateCustom()`:

```typescript
class Signup extends ApplicationRecord {
  static schema = v.object({
    id: v.optional(v.number()),
    name: v.pipe(v.string(), v.minLength(1)),
    email: v.pipe(v.string(), v.email()),
  });
}

const signup = new Signup({ name: "", email: "invalid" });
const errors = await signup.validate();
// [
//   { column: "name", code: "length", params: { min: 1 } },
//   { column: "email", code: "email" }
// ]
```

Each error carries a `column`, a machine-readable `code`, and optional `params` for interpolation.
The library never produces human-readable text, so the host owns translation and can return the
array to a client verbatim; `params` never contains the submitted value.

Multiple errors can target the same column — one per failed rule. Returns an empty array when valid.
Nested schemas produce dot-joined paths (`author.name`, `tags.1`), and a struct-level `v.check`
failure uses an empty `column`.

#### Codes

Valibot issue types are mapped onto a shared vocabulary, so the same failure reads the same in both
implementations:

| Code                      | Valibot source                                    | `params`                 |
| ------------------------- | ------------------------------------------------- | ------------------------ |
| `required`                | any datatype issue with `undefined` input         | —                        |
| `type`                    | any other datatype issue                          | `expected`               |
| `length`                  | `minLength` / `maxLength` / `length` / `nonEmpty` | `min`, `max`, or `equal` |
| `range`                   | `minValue` / `maxValue`                           | `min` and/or `max`       |
| `email` / `url` / `regex` | the action of the same name                       | —                        |
| `contains`                | `includes`                                        | `needle`                 |
| _your choice_             | `validateCustom()`                                | whatever you attach      |

Codes returned from `validateCustom()` are your own vocabulary. `type` only ever comes from this
implementation: Rust fields are statically typed, so it can never see the wrong datatype.

#### Saving

`save()` validates before writing — schema rules first, then `validateCustom()` — and throws
`RecordInvalid` carrying the errors. Nothing is written and no hook runs when the record is invalid:

```typescript
import { RecordInvalid } from "@dimensionalpocket/average-record";

try {
  await user.save();
} catch (error) {
  if (error instanceof RecordInvalid) {
    // error.errors is the same array validate() returns
    return new Response(JSON.stringify({ errors: error.errors }), {
      status: 422,
    });
  }
  throw error;
}
```

Call `save()` with `await`: it is asynchronous so that `validateCustom()` can run first.

### Custom Validation

Override `validateCustom()` to add model-specific validations (uniqueness, conditional checks, etc.).
It runs from both `validate()` and `save()`:

```typescript
class User extends ApplicationRecord {
  // ...

  protected async validateCustom() {
    const errors: ValidationError[] = [];
    if (!this.checkUniqueness("email", this.email)) {
      errors.push({ column: "email", code: "taken" });
    }
    return errors;
  }
}

const user = new User({ email: "alice@test.com" });
const errors = await user.validate(); // schema errors + custom errors
```

`checkUniqueness(field, value)` returns `true` if the value is unique and available to use. It automatically excludes the current record when updating (that is, when its primary key is non-zero).

`checkUniquenessRaw(condition, params)` takes an arbitrary WHERE condition (no table prefix) for multi-column checks, for example `checkUniquenessRaw("remote_id = ? AND platform = ?", [this.remote_id, this.platform])`. It excludes the current record by primary key the same way.

### Lifecycle Hooks

`save()` validates first — schema rules then `validateCustom()` — and throws `RecordInvalid`
without calling any hook when the record is invalid.

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
    // Runs before the insert; timestamps are handled by `static timestamps` (default ISO-8601).
    console.log(`creating ${this.name}`);
  }

  protected afterSave(): void {
    console.log(`User ${this.id} was saved`);
  }

  protected afterDestroy(): void {
    console.log(`User ${this.id} was deleted`);
  }
}

const user = new User({ name: "Alice" });
await user.save();
// validate → beforeCreate → insert → afterCreate → afterSave

user.name = "Alice Smith";
await user.save();
// validate → beforeUpdate → update → afterUpdate → afterSave

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
