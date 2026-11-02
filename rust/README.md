# average-record (Rust)

A lightweight, fully async, Active-Record-style ORM for **SQLite**, with a fluent query builder,
lifecycle hooks, validation, column redaction, change tracking, and a migration runner.

The host application owns the database; this crate provides the model, query, and migration layer
on top of the connection you give it.

- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [The connection model](#the-connection-model)
- [Defining a model](#defining-a-model)
- [Primary keys](#primary-keys)
- [CRUD](#crud)
- [Queries](#queries)
- [Validation](#validation)
- [Redaction](#redaction)
- [Change tracking](#change-tracking)
- [Migrations](#migrations)
- [Error handling](#error-handling)
- [Feature flags and MSRV](#feature-flags-and-msrv)

---

## Design principles

1. **Your app owns the database.** You create and configure the `SqlitePool` (connection options,
   WAL, `busy_timeout`, idle timeout, backups), own the data folder, and own the migration files.
   The crate ships no pool type and no pool helpers.
2. **Connection-based execution.** Every query, write, validation, and migration takes an explicit
   `&mut SqliteConnection` (or `&mut Transaction<'_, Sqlite>`). Acquire **one connection per unit of
   work** and pass it down, so related reads and writes see each other.
3. **Fully async.** The public API is `async` and never blocks the executor.
4. **SQLite only.**
5. **Typed models.** Models are plain Rust structs. Projection/derived columns are optional fields
   marked virtual.
6. **No hidden `unsafe`.** The optional `#[derive(Model)]` macro emits only safe Rust.

---

## Requirements

- **Rust 1.94+** (the crate depends on `sqlx` 0.9).
- An async runtime. The crate targets **Tokio**.
- SQLite, bundled and statically linked through `sqlx`.

---

## Installation

The crate is distributed from GitHub (no crates.io release). Add it to `Cargo.toml`, pinned to a
tag:

<!-- x-release-please-start-version -->
```toml
[dependencies]
average-record = { git = "https://github.com/dimensionalpocket/average-record", tag = "0.4.0", features = ["derive"] }
```
<!-- x-release-please-end -->

Your application also supplies the supporting crates: `sqlx` to build the pool and acquire
connections, plus an async runtime.

```toml
[dependencies]
sqlx = { version = "0.9", default-features = false, features = ["runtime-tokio", "sqlite"] }
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
futures-util = "0.3"
```

### Features

| Feature  | Default | Description                                                         |
| -------- | ------- | ------------------------------------------------------------------- |
| `derive` | yes     | `#[derive(Model)]`, `#[model(...)]`, and `#[redacted]` proc-macro.  |
| `cli`    | no      | `MigrationExecutor` (a `clap`-based CLI wrapper around `Migrator`). |

---

## Quick start

```rust
use average_record::{Model, ModelHooks, Migrator, MigratorOptions, Result};
use sqlx::sqlite::SqlitePool;

#[derive(Model)]
#[model(table = "users")]
struct User {
    #[model(primary_key)]
    id: i64,                      // 0 means "new record"
    team_id: i64,
    name: String,
    email: String,
    locked: bool,
    created_at: String,
    updated_at: String,
}

impl ModelHooks for User {}

async fn run(pool: &SqlitePool) -> Result<()> {
    let mut conn = pool.acquire().await?;

    // Create.
    let mut user = User {
        id: 0,
        team_id: 1,
        name: "Alice".into(),
        email: "alice@example.com".into(),
        locked: false,
        created_at: String::new(),
        updated_at: String::new(),
    };
    user.save(&mut conn).await?;

    // Update.
    user.name = "Alice Smith".into();
    user.save(&mut conn).await?;

    // Query.
    let team = User::query()
        .where_eq("team_id", 1)?
        .order_by("name", average_record::Direction::Asc)?
        .all(&mut conn)
        .await?;

    println!("{} users", team.len());
    Ok(())
}
```

---

## The connection model

You build the pool; the crate only ever receives connections.

```rust
use std::str::FromStr;
use std::time::Duration;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqlitePool};

pub async fn build_pool(url: &str) -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::from_str(url)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5))
        .pragma("synchronous", "NORMAL")
        .pragma("cache_size", "-8000")
        .pragma("mmap_size", "0")
        .pragma("journal_size_limit", "4194304")
        .pragma("wal_autocheckpoint", "1000");

    SqlitePoolOptions::new()
        .max_connections(5)
        .idle_timeout(Some(Duration::from_secs(300)))
        .connect_with(options)
        .await
}
```

Per request / unit of work, acquire exactly one connection and pass it down. All reads and writes on
that connection see each other:

```rust
let mut conn = pool.acquire().await?;

let user = User::find(&mut conn, 42).await?;
let reviews = Review::query().where_eq("user_id", 42)?.all(&mut conn).await?;
```

When a workflow performs several related writes, wrap it in a transaction and use the `_within`
variants:

```rust
let mut conn = pool.acquire().await?;
let mut tx = conn.begin().await?;

let mut user = User { team_id: 1, name: "Alice".into(), ..Default::default() };
user.save_within(&mut tx).await?;

let mut review = Review { user_id: user.id, ..Default::default() };
review.save_within(&mut tx).await?;

tx.commit().await?;
```

A write's hooks and validation run inside the same transaction as the write itself. When you pass a
plain connection to `save(conn)` / `save_with_options(conn, opts)`, the crate starts and commits its
own transaction around the save.

---

## Defining a model

### With the derive macro

```rust
use average_record::{Model, ModelHooks, ValidationError, Result};
use validator::Validate;
use sqlx::SqliteConnection;

#[derive(Model, Validate, Default)]
#[model(table = "users")]
pub struct User {
    #[model(primary_key)]
    pub id: i64,                      // 0 means "new record"

    pub team_id: i64,

    #[validate(length(min = 1, max = 200))]
    pub name: String,

    #[redacted]
    pub email: String,

    #[redacted]
    pub password_digest: Option<String>,

    pub role: Option<String>,

    #[model(column = "locked")]
    pub locked: bool,                 // SQLite INTEGER 0/1, mapped to bool

    pub created_at: String,
    pub updated_at: String,

    /// Populated by a projection (e.g. `User::team_name_expr()`); not persisted.
    #[model(virtual)]
    pub team_name: Option<String>,
}
```

### Model attributes

| Attribute                     | Placement | Meaning                                                                 |
| ----------------------------- | --------- | ----------------------------------------------------------------------- |
| `#[model(table = "users")]`   | struct    | Required. Table name.                                                   |
| `#[model(timestamps = "epoch_millis")]` | struct | Writes `created_ts`/`updated_ts` as epoch-millisecond `i64`. Also `iso8601` (default) and `none`. |
| `#[model(timestamps(created = "...", updated = "...", format = "..."))]` | struct | Custom timestamp column names; an omitted `created`/`updated` disables that column. |
| `#[model(primary_key)]`       | field     | Marks the primary key (defaults to a column named `id`). Must be `i64`; `0` means new. |
| `#[model(column = "locked")]` | field     | Maps a Rust field to a differently named column.                        |
| `#[model(virtual)]`           | field     | Non-persisted projection field (excluded from `COLUMNS` and writes).    |
| `#[redacted]`                 | field     | Redacted in `to_json`, `persisted`, and `changes` when redaction is on. |
| `#[validate(...)]`            | field     | Field validation rules (from `validator`).                              |

`#[derive(Model)]` also derives `serde::Serialize`, which `to_json` and `TrackedChanges::to_json`
require. If you implement `Model` by hand (below), derive `Serialize` yourself.

### Lifecycle hooks

Hooks and DB-dependent validation live in a separate, mostly-default `ModelHooks` impl. An empty
impl is valid when the model needs no custom behavior.

```rust
impl ModelHooks for User {
    async fn before_create(&mut self, _conn: &mut SqliteConnection) -> Result<()> {
        // Runs inside the write transaction, before the INSERT.
        Ok(())
    }

    async fn after_save(&self, _conn: &mut SqliteConnection) -> Result<()> {
        // Runs after both create and update.
        Ok(())
    }

    async fn validate_custom(&self, conn: &mut SqliteConnection) -> Result<Vec<ValidationError>> {
        // DB-dependent checks run inside the write transaction.
        let mut errors = Vec::new();
        if !self.check_uniqueness(conn, "name", &self.name).await? {
            errors.push(ValidationError::new("name", "taken"));
        }
        Ok(errors)
    }
}
```

Hook order on a write: field rules → `validate_custom` → `before_create`/`before_update` → timestamps → DML →
`after_create`/`after_update` → `after_save`. On delete: DML → `after_destroy`.

### Without the derive macro

```rust
use average_record::{Model, ModelHooks, Result, SqlValue};
use sqlx::{sqlite::SqliteRow, Row};

pub struct User {
    pub id: i64,
    pub team_id: i64,
    pub name: String,
    pub locked: bool,
    pub created_at: String,
    pub updated_at: String,
    /// Not persisted.
    pub team_name: Option<String>,
}

impl Model for User {
    const TABLE_NAME: &'static str = "users";
    const PRIMARY_KEY: &'static str = "id";
    const COLUMNS: &'static [&'static str] = &[
        "id", "team_id", "name", "locked", "created_at", "updated_at",
    ];
    const REDACTED_COLUMNS: &'static [&'static str] = &[];

    fn from_row(row: &SqliteRow) -> Result<Self> {
        Ok(Self {
            id: row.try_get("id")?,
            team_id: row.try_get("team_id")?,
            name: row.try_get("name")?,
            locked: row.try_get("locked")?,
            created_at: row.try_get("created_at")?,
            updated_at: row.try_get("updated_at")?,
            team_name: row.try_get("team_name").ok(),
        })
    }

    fn to_values(&self) -> Vec<SqlValue> {
        vec![
            self.id.into(),
            self.team_id.into(),
            self.name.clone().into(),
            self.locked.into(),
            self.created_at.clone().into(),
            self.updated_at.clone().into(),
        ]
    }

    fn set_primary_key(&mut self, id: i64) {
        self.id = id;
    }
}

impl ModelHooks for User {}
```

---

## Primary keys

Primary keys are `i64` fields. **`0` always means "new record"**, and it is never a valid
stored key: an `INSERT` omits the primary-key column so SQLite assigns the rowid (auto-assigned rowids
start at `1`).

| Operation | Behavior for a record whose primary key is `0` |
| --- | --- |
| `save(conn)` | INSERT; the assigned rowid is written back to the field |
| `persisted(conn, _)` | `None` (no query issued) |
| `changes(conn, _)` / `changed(conn)` | empty / `false` |
| `check_uniqueness*` | no `AND pk != ?` self-exclusion clause |
| `destroy(conn)` | `Err(Error::Record("cannot destroy an unsaved record"))` |
| `find(conn, 0)` | `None` (short-circuit, no query) |

The library never writes `0`: the `INSERT` omits the primary-key column, so the database assigns it. A
row with `id = 0` can only appear through a write that bypasses the library; for such a row the library
consistently treats the record as unsaved. Hosts that want to reject out-of-band writes can add
`CHECK (id != 0)` to their schema as optional hardening.

Hand-written models must implement `set_primary_key`; there is no default, so a forgotten assignment is
a compile error rather than a silent no-op.

---

## Timestamps

Writes stamp the columns configured by the model's `TIMESTAMPS` constant. The default is
`Timestamps::ISO8601`: `created_at` and `updated_at` as ISO-8601 UTC text
(`YYYY-MM-DDTHH:MM:SS.mmmZ`). Models that store integer timestamps opt in:

```rust
use average_record::{Model, ModelHooks};

#[derive(Model)]
#[model(table = "events", timestamps = "epoch_millis")]
struct Event {
    #[model(primary_key)]
    id: i64,
    name: String,
    created_ts: i64,   // epoch milliseconds, 0 means "unset"
    updated_ts: i64,
}

impl ModelHooks for Event {}
```

| Preset | `created` / `updated` | Representation |
| --- | --- | --- |
| `iso8601` (default) | `created_at` / `updated_at` | `String`, UTC `YYYY-MM-DDTHH:MM:SS.mmmZ` |
| `epoch_millis` | `created_ts` / `updated_ts` | `i64`, milliseconds since the Unix epoch |
| `none` | — | automatic timestamps disabled |

Custom column names use the explicit form:

```rust
#[model(
    table = "audits",
    timestamps(created = "inserted_ms", updated = "modified_ms", format = "epoch_millis")
)]
```

| Operation | `created` column | `updated` column |
| --- | --- | --- |
| INSERT | set when the record is new **and** the field is unset (`NULL`, `""`, `0`) | always set |
| UPDATE | never touched | set unless `skip_updated_at` |
| `skip_updated_at: true` on INSERT | — | still set |
| Column missing from `COLUMNS`, or `None` in `TIMESTAMPS` | no-op | no-op |

Both columns receive the same clock reading, so a new record always has `created == updated`.
`0` is never a valid timestamp, mirroring `id == 0`.

The derive validates the columns you name: they must be persisted columns, and their Rust type must
match the representation (`String`/`Option<String>` for `iso8601`, `i64`/`Option<i64>` for
`epoch_millis`). The implicit default is permissive, so a model with no timestamp columns needs no
attribute.

DDL expectations: `TEXT` for ISO-8601, `INTEGER NOT NULL DEFAULT 0` for epoch milliseconds. A nullable
column must be modeled as `Option<i64>`/`Option<String>`; `from_row` uses `try_get` and does not
coalesce.

Hand-written models set the constant and assign the columns themselves:

```rust
use average_record::{Model, Timestamps, SqlValue};

impl Model for Event {
    const TABLE_NAME: &'static str = "events";
    const TIMESTAMPS: Timestamps = Timestamps::EPOCH_MILLIS;
    const COLUMNS: &'static [&'static str] = &["id", "name", "created_ts", "updated_ts"];

    // from_row, to_values, primary_key_value, set_primary_key ...

    fn set_column(&mut self, column: &str, value: SqlValue) {
        match column {
            "created_ts" => self.created_ts = value.as_i64().unwrap_or(self.created_ts),
            "updated_ts" => self.updated_ts = value.as_i64().unwrap_or(self.updated_ts),
            _ => {}
        }
    }
}
```

`to_json()`/`Serialize` emit a JSON number for epoch-millisecond columns.

---

## CRUD

```rust
let mut conn = pool.acquire().await?;

// Create — `id` is populated from last_insert_rowid.
let mut user = User { team_id: 1, name: "Alice".into(), ..Default::default() };
user.save(&mut conn).await?;

// Update — same method; a non-zero primary key decides INSERT vs UPDATE.
user.name = "Alice Smith".into();
user.save(&mut conn).await?;

// Read
let found: Option<User> = User::find(&mut conn, user.id).await?;
let first: Option<User> = User::first(&mut conn).await?;
let all: Vec<User> = User::all(&mut conn).await?;
let total: i64 = User::count(&mut conn).await?;

// Delete
user.destroy(&mut conn).await?;
```

Timestamps are managed automatically; see [Timestamps](#timestamps) for the ISO-8601 default and the
per-model epoch-millisecond option.

### Write methods

`save`/`destroy` use default options. The `_with_options` variants take an explicit `SaveOptions`;
the `_within` variants join a caller-managed transaction.

| Method                                  | Description                                            |
| --------------------------------------- | ------------------------------------------------------ |
| `save(conn)`                            | Insert or update; the crate owns the transaction.      |
| `save_with_options(conn, opts)`         | Same, with flags (`track_changes`, `skip_updated_at`). |
| `save_within(tx)`                       | Insert or update inside the caller's transaction.      |
| `save_within_with_options(tx, opts)`    | Same, with flags.                                      |
| `destroy(conn)`                         | Delete; the crate owns the transaction.                |
| `destroy_with_options(conn, opts)`      | Same, with flags.                                      |
| `destroy_within(tx)`                    | Delete inside the caller's transaction.                |
| `destroy_within_with_options(tx, opts)` | Same, with flags.                                      |

### SaveOptions

Passed to the `_with_options` variants only.

| Field             | Default | Meaning                                                      |
| ----------------- | ------- | ------------------------------------------------------------ |
| `track_changes`   | `false` | Capture old/new value pairs for `tracked_changes()` (below). |
| `skip_updated_at` | `false` | On update, keep the existing updated timestamp.              |

```rust
use average_record::SaveOptions;

user.save_with_options(&mut conn, SaveOptions { skip_updated_at: true, ..Default::default() }).await?;
```

---

## Queries

Queries start from `Model::query()` and are finalized by a terminal that takes a connection. The
builder holds no database handle.

```rust
use average_record::Direction;

let users = User::query()
    .where_eq("team_id", 1)?                   // structured steps return Result
    .where_in("role", ["admin", "editor"])?
    .where_not_in("id", [1, 2, 3])?
    .where_raw("id > ? AND id < ?", [10, 100])?
    .order_by("created_at", Direction::Desc)?  // validated column
    .limit(20)                                 // infallible
    .offset(40)
    .all(&mut conn)
    .await?;
```

### Builder reference

| Method                                                                        | Returns        | Notes                                                        |
| ----------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------ |
| `where_eq / where_ne / where_gt / where_gte / where_lt / where_lte(col, val)` | `Result<Self>` | Structured condition; `col` is validated against `COLUMNS`.  |
| `where_in(col, vals)` / `where_not_in(col, vals)`                             | `Result<Self>` | `IN` / `NOT IN`; validates `col`.                            |
| `where_raw(sql, params)`                                                      | `Result<Self>` | Raw fragment; validates `?` count against `params.len()`.    |
| `fuzzy_search(terms, columns)`                                                | `Result<Self>` | Space-split terms, `AND`-joined `(col LIKE ? OR ...)` groups. No-op when `terms` is blank. Requires at least one column. |
| `order_by(col, dir)`                                                          | `Result<Self>` | Validates `col`. `Direction::Asc` / `Direction::Desc`.       |
| `order_by_raw(expr, dir)`                                                     | `Self`         | Raw ORDER BY expression (for example an alias or subquery).  |
| `select(fragment)`                                                            | `Self`         | Appends to the `SELECT` list (raw fragment). Defaults to `*`.|
| `select_clear()`                                                              | `Self`         | Empties the `SELECT` list.                                   |
| `join(sql, params)`                                                           | `Result<Self>` | Raw join appended after `FROM`; validates `?` arity.         |
| `limit(n)` / `offset(n)`                                                      | `Self`         |                                                              |

`where_*` conditions and `join`s are combined with `AND`. Join bind parameters always come before
`WHERE` parameters, regardless of call order.

### Terminals

| Method         | Returns                                                      |
| -------------- | ------------------------------------------------------------ |
| `all(conn)`    | `Result<Vec<M>>`                                             |
| `first(conn)`  | `Result<Option<M>>`                                          |
| `count(conn)`  | `Result<i64>`                                                |
| `fetch(conn)`  | `impl Stream<Item = Result<M>> + '_`                         |
| `all_raw(conn)`| `Result<Vec<HashMap<String, SqlValue>>>`                     |
| `fetch_raw(conn)` | `impl Stream<Item = Result<HashMap<String, SqlValue>>> + '_` |
| `to_sql()`     | `GeneratedSql { sql, params }` (build only)                  |

### Streaming (memory-efficient)

```rust
use futures_util::TryStreamExt;

let mut stream = User::query()
    .where_eq("team_id", 1)?
    .order_by("name", Direction::Asc)?
    .fetch(&mut conn);

while let Some(user) = stream.try_next().await? {
    // process one row at a time
}
```

### Joins and projections

```rust
let users = User::query()
    .select_clear()
    .select("users.*")
    .select("r.rating")
    .join("INNER JOIN reviews r ON r.user_id = users.id AND r.rating > ?", [50])?
    .order_by("r.rating", Direction::Desc)?
    .all(&mut conn)
    .await?;
```

### Fuzzy search

```rust
let matches = User::query()
    .fuzzy_search("alice smith", ["name", "email"])?
    .limit(10)
    .all(&mut conn)
    .await?;
```

### Raw rows

```rust
use std::collections::HashMap;
use average_record::SqlValue;

let rows: Vec<HashMap<String, SqlValue>> = User::query()
    .select_clear()
    .select("name, COUNT(*) AS n")
    .order_by_raw("n", Direction::Desc)
    .all_raw(&mut conn)
    .await?;

for row in &rows {
    if let Some(name) = row.get("name").and_then(SqlValue::as_str) {
        println!("{name}");
    }
}
```

### Inspecting generated SQL

```rust
let generated = User::query().where_eq("team_id", 1)?.to_sql();
assert_eq!(generated.sql, "SELECT * FROM users WHERE team_id = ?");
```

---

## Validation

Validation produces data, not prose. Every failure is a `ValidationError` carrying the offending
`column`, a machine-readable `code`, and optional `params` for interpolation. The crate never
produces human-readable messages: the host owns translation, and the array can be returned to a
client verbatim.

```rust
pub struct ValidationError {
    pub column: String,   // "name", or a path such as "author.name" / "tags.0"
    pub code: String,     // "length", "required", "email", or a model-defined code
    pub params: serde_json::Map<String, serde_json::Value>, // {"min": 3}; empty when unused
}
```

`validate(conn)` runs declarative field rules and `validate_custom` on the same connection and
returns every error (empty means valid):

```rust
let errors = user.validate(&mut conn).await?;
for error in &errors {
    eprintln!("{}: {} {:?}", error.column, error.code, error.params);
}
// ValidationError { column: "name", code: "length", params: {"max": 200, "min": 1} }
```

One column can appear more than once — once per failed rule. `params` never contains the submitted
value, so nothing sensitive can leak through it.

`save` and `save_within` run that same combination inside the write transaction: a record that fails
a field rule is not written, no hook runs, and the call returns
`Error::Validation(Vec<ValidationError>)`. Use `validate` when you want to report errors without
attempting a write.

### Field rules (`validator`)

Declarative rules come from [`validator`](https://docs.rs/validator) and are attached with
`#[validate(...)]`; the struct needs `#[derive(validator::Validate)]`.

| Rule | Example | Checks |
| --- | --- | --- |
| `required` | `#[validate(required)]` | an `Option` field is `Some` |
| `length` | `#[validate(length(min = 1, max = 200))]` | string/container length in `min..=max` (or `equal`) |
| `range` | `#[validate(range(min = 0, max = 100))]` | a number in `min..=max` |
| `email` | `#[validate(email)]` | an HTML5 email address |
| `url` | `#[validate(url)]` | a URL |
| `regex` | `#[validate(regex(path = *NAME_RE))]` | a string matching a compiled regex |
| `contains` | `#[validate(contains(pattern = "https://"))]` | a substring |
| `must_match` | `#[validate(must_match(other = "password"))]` | a field equals another field |
| `custom` | `#[validate(custom(function = "check_name"))]` | a function returning `Result<(), ValidationError>` |
| `non_control_character` | `#[validate(non_control_character)]` | printable text only |
| `nested` / `skip` | `#[validate(skip)]` | nested struct/list validation / opt out |

`credit_card` is available behind validator's `card` feature. For the complete, always-current list
and its exact arguments, see the [`validator` crate docs](https://docs.rs/validator).

### Codes

Internal rules map to these codes; anything you return from `custom` rules or `validate_custom` is
your own vocabulary.

| Code | Source rule | `params` |
| --- | --- | --- |
| `required` | `required` | — |
| `length` | `length` | `min`, `max`, or `equal` |
| `range` | `range` | `min` and/or `max` |
| `email` / `url` / `regex` / `contains` / `must_match` / `non_control_character` / `credit_card` | the rule of the same name | `needle` for `contains`, `other` for `must_match` |
| *your choice* | `custom` rules and `validate_custom` | whatever you attach |

When both bounds on a `length`/`range` rule are set, they are reported together (`{"min": 1,
"max": 200}`) and the host renders a "between" message; the failing bound is not distinguished.

### Custom validation

Database-dependent checks stay in `ModelHooks::validate_custom`, which runs inside the write
transaction. Return a code (and optionally params) for each failure:

```rust
impl ModelHooks for User {
    async fn validate_custom(&self, conn: &mut SqliteConnection) -> Result<Vec<ValidationError>> {
        if !self.check_uniqueness(conn, "name", &self.name).await? {
            return Ok(vec![
                ValidationError::new("name", "taken").with_param("table", "users"),
            ]);
        }
        Ok(Vec::new())
    }
}
```

### Nested models

`#[validate(nested)]` on a nested struct or `Vec` flattens into dot-joined column paths
(`author.name`, `tags.1`) and struct-level failures use an empty `column`. The Bun implementation
uses the same convention, and maps its Valibot issues onto the same codes (`min_length`/`max_length`
→ `length`, missing input → `required`, datatype mismatch → `type`).

### Uniqueness helpers

```rust
// Single column, excluding this record's own primary key when it is persisted.
let unique = user.check_uniqueness(&mut conn, "name", &user.name).await?;

// Arbitrary condition (any raw WHERE fragment).
let unique = user
    .check_uniqueness_raw(&mut conn, "lower(name) = lower(?)", [&user.name])
    .await?;
```

---

## Redaction

Mark sensitive columns with `#[redacted]`. Redaction is applied on demand.

```rust
// From the model definition above:
#[redacted]
pub email: String,

#[redacted]
pub password_digest: Option<String>,
```

```rust
let public_json = user.to_json(true);                       // { "email": "[redacted]", ... }
let persisted   = user.persisted(&mut conn, true).await?;   // DB state, redacted
let diff        = user.changes(&mut conn, false).await?;    // current vs DB, unredacted

assert_eq!(User::REDACTED_COLUMNS, &["email", "password_digest"]);
```

To resolve redacted columns by model name (for example, a change-feed job that receives a model name
as a string), keep a small static lookup in your app:

```rust
fn redacted_columns_for(model_name: &str) -> &'static [&'static str] {
    match model_name {
        "User" => User::REDACTED_COLUMNS,
        "Review" => Review::REDACTED_COLUMNS,
        _ => &[],
    }
}
```

---

## Change tracking

Change tracking is opt-in per write via `SaveOptions`, passed to a `*_with_options` method.

```rust
user.name = "Alice Smith (Work)".into();
user.save_with_options(&mut conn, SaveOptions { track_changes: true, ..Default::default() }).await?;

if let Some(changes) = user.tracked_changes() {
    for (column, change) in changes.iter() {
        println!("{column}: {:?} -> {:?}", change.before, change.after);
    }
}
```

- Insert: every column is `[None, Some(value)]`.
- Update: only changed columns, `[Some(old), Some(new)]`.
- Delete (`destroy` with `track_changes`): `[Some(old), None]`.
- `tracked_changes()` returns `None` if the last write did not opt in.

For audit logging, `TrackedChanges::to_json(redact)` renders the diff, redacting columns on request.

Additional helpers:

```rust
let current_vs_db = user.changes(&mut conn, false).await?; // diff of current values vs persisted
let dirty = user.changed(&mut conn).await?;                // bool
```

---

## Migrations

You own the migration files and the schema dump path. The runner takes a connection, so run it at
boot on a connection you acquire.

```rust
use average_record::{Migrator, MigratorOptions, MigrationDirection};

let mut conn = pool.acquire().await?;

Migrator::new(MigratorOptions {
    pwd: workspace_root.clone(),
    migrations_dir: "config/databases/main/migrations".into(),
    schema_path: Some("config/databases/main/schema.sql".into()),
    direction: MigrationDirection::Up,
    version: None,
    dump: false,
    silent: true,
})
.run(&mut conn)
.await?;
```

Migration filenames follow `{version}_{name}.{up|down}.sql` (for example
`20250101000000_create_users.up.sql`). Applied versions are tracked in `schema_migrations`, so
existing databases remain usable.

### Migration CLI (`cli` feature)

```rust
use average_record::MigrationExecutor;

let mut conn = pool.acquire().await?;
MigrationExecutor::new(MigratorOptions::default()).run(&mut conn).await?;
```

```bash
app-migrate                  # apply all pending migrations
app-migrate --dump           # apply and dump the schema
app-migrate --down           # roll back the most recent migration
app-migrate --down -v 1      # roll back to version 1
app-migrate --help
```

---

## Error handling

The crate exposes a single error enum and a `Result` alias.

```rust
use average_record::{Error, Result};

async fn rename(user: &mut User, conn: &mut sqlx::SqliteConnection) -> Result<()> {
    match user.save(conn).await {
        Ok(()) => Ok(()),
        Err(Error::Validation(errors)) => {
            // surface `errors` to the caller
            Err(Error::Validation(errors))
        }
        Err(Error::Sqlite(e)) => Err(Error::Sqlite(e)),
        Err(other) => Err(other),
    }
}
```

`Error` variants include `Validation(Vec<ValidationError>)`, `Sqlite(sqlx::Error)`,
`Io(std::io::Error)`, `Migration(String)`, and `Record(String)`.

---

## Feature flags and MSRV

- **MSRV:** Rust 1.94 (driven by `sqlx` 0.9).
- **Features:** `derive` (default) for the model macro; `cli` for the migration CLI.
- **Runtime:** Tokio. SQLite is bundled and statically linked by `sqlx`.
