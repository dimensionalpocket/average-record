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

The crate is distributed from GitHub (no crates.io release). Add it to `Cargo.toml` as a git
dependency, pinned to a tag:

```toml
[dependencies]
average-record = { git = "https://github.com/dimensionalpocket/average-record", tag = "0.1.0", features = ["derive"] }

# You also need sqlx to build your pool and acquire connections.
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
#[model(table = "songs")]
struct Song {
    #[model(primary_key)]
    id: Option<i64>,
    artist_id: i64,
    title: String,
    locked: bool,
    created_at: String,
    updated_at: String,
}

impl ModelHooks for Song {}

async fn run(pool: &SqlitePool) -> Result<()> {
    let mut conn = pool.acquire().await?;

    // Create.
    let mut song = Song {
        id: None,
        artist_id: 1,
        title: "NIGHT OF FIRE".into(),
        locked: false,
        created_at: String::new(),
        updated_at: String::new(),
    };
    song.save(&mut conn).await?;

    // Update.
    song.title = "Night of Fire".into();
    song.save(&mut conn).await?;

    // Query.
    let eurobeat = Song::query()
        .where_eq("artist_id", 1)?
        .order_by("title", average_record::Direction::Asc)?
        .all(&mut conn)
        .await?;

    println!("{} songs", eurobeat.len());
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

let song = Song::find(&mut conn, 42).await?;
let stats = Stat::query().where_eq("song_id", 42)?.all(&mut conn).await?;
```

When a workflow performs several related writes, wrap it in a transaction and use the `_within`
variants:

```rust
let mut conn = pool.acquire().await?;
let mut tx = conn.begin().await?;

let mut song = Song { artist_id: 1, title: "NIGHT OF FIRE".into(), ..Default::default() };
song.save_within(&mut tx).await?;

let mut stat = Stat { song_id: song.id.unwrap(), ..Default::default() };
stat.save_within(&mut tx).await?;

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
use garde::Validate;
use sqlx::SqliteConnection;

#[derive(Model, Validate)]
#[model(table = "songs")]
pub struct Song {
    #[model(primary_key)]
    pub id: Option<i64>,

    pub artist_id: i64,

    #[garde(length(min = 1, max = 200))]
    pub title: String,

    pub original_title: Option<String>,
    pub genre: Option<String>,

    #[model(column = "locked")]
    pub locked: bool,                 // SQLite INTEGER 0/1, mapped to bool

    pub created_at: String,
    pub updated_at: String,

    /// Populated by a projection (e.g. `Song::artist_name_expr()`); not persisted.
    #[model(virtual)]
    pub artist_name: Option<String>,
}
```

### Model attributes

| Attribute                     | Placement | Meaning                                                                 |
| ----------------------------- | --------- | ----------------------------------------------------------------------- |
| `#[model(table = "songs")]`   | struct    | Required. Table name.                                                   |
| `#[model(primary_key)]`       | field     | Marks the primary key (defaults to a column named `id` if absent).      |
| `#[model(column = "locked")]` | field     | Maps a Rust field to a differently named column.                        |
| `#[model(virtual)]`           | field     | Non-persisted projection field (excluded from `COLUMNS` and writes).    |
| `#[redacted]`                 | field     | Redacted in `to_json`, `persisted`, and `changes` when redaction is on. |
| `#[garde(...)]`               | field     | Field validation rules (from `garde`).                                  |

`#[derive(Model)]` also derives `serde::Serialize`, which `to_json` and `TrackedChanges::to_json`
require. If you implement `Model` by hand (below), derive `Serialize` yourself.

### Lifecycle hooks

Hooks and DB-dependent validation live in a separate, mostly-default `ModelHooks` impl. An empty
impl is valid when the model needs no custom behavior.

```rust
impl ModelHooks for Song {
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
        if !self.check_uniqueness(conn, "title", &self.title).await? {
            errors.push(ValidationError::new("title", "is already taken"));
        }
        Ok(errors)
    }
}
```

Hook order on a write: `validate_custom` → `before_create`/`before_update` → timestamps → DML →
`after_create`/`after_update` → `after_save`. On delete: DML → `after_destroy`.

### Without the derive macro

```rust
use average_record::{Model, ModelHooks, Result, SqlValue};
use sqlx::{sqlite::SqliteRow, Row};

pub struct Song {
    pub id: Option<i64>,
    pub artist_id: i64,
    pub title: String,
    pub locked: bool,
    pub created_at: String,
    pub updated_at: String,
    /// Not persisted.
    pub artist_name: Option<String>,
}

impl Model for Song {
    const TABLE_NAME: &'static str = "songs";
    const PRIMARY_KEY: &'static str = "id";
    const COLUMNS: &'static [&'static str] = &[
        "id", "artist_id", "title", "locked", "created_at", "updated_at",
    ];
    const REDACTED_COLUMNS: &'static [&'static str] = &[];

    fn from_row(row: &SqliteRow) -> Result<Self> {
        Ok(Self {
            id: row.try_get("id")?,
            artist_id: row.try_get("artist_id")?,
            title: row.try_get("title")?,
            locked: row.try_get("locked")?,
            created_at: row.try_get("created_at")?,
            updated_at: row.try_get("updated_at")?,
            artist_name: row.try_get("artist_name").ok(),
        })
    }

    fn to_values(&self) -> Vec<SqlValue> {
        vec![
            self.id.into(),
            self.artist_id.into(),
            self.title.clone().into(),
            self.locked.into(),
            self.created_at.clone().into(),
            self.updated_at.clone().into(),
        ]
    }
}

impl ModelHooks for Song {}
```

---

## CRUD

```rust
let mut conn = pool.acquire().await?;

// Create — `id` is populated from last_insert_rowid.
let mut song = Song { artist_id: 1, title: "NIGHT OF FIRE".into(), ..Default::default() };
song.save(&mut conn).await?;

// Update — same method; presence of the primary key decides INSERT vs UPDATE.
song.title = "Night of Fire".into();
song.save(&mut conn).await?;

// Read
let found: Option<Song> = Song::find(&mut conn, song.id.unwrap()).await?;
let first: Option<Song> = Song::first(&mut conn).await?;
let all: Vec<Song> = Song::all(&mut conn).await?;
let total: i64 = Song::count(&mut conn).await?;

// Delete
song.destroy(&mut conn).await?;
```

`created_at` and `updated_at` are managed automatically when those columns exist in `COLUMNS`.

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
| `skip_updated_at` | `false` | On update, keep the existing `updated_at`.                   |

```rust
use average_record::SaveOptions;

song.save_with_options(&mut conn, SaveOptions { skip_updated_at: true, ..Default::default() }).await?;
```

---

## Queries

Queries start from `Model::query()` and are finalized by a terminal that takes a connection. The
builder holds no database handle.

```rust
use average_record::Direction;

let songs = Song::query()
    .where_eq("artist_id", 1)?                 // structured steps return Result
    .where_in("genre", ["eu", "te"])?
    .where_not_in("id", [1, 2, 3])?
    .where_raw("score > ? AND score < ?", [50, 100])?
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

let mut stream = Song::query()
    .where_eq("artist_id", 1)?
    .order_by("title", Direction::Asc)?
    .fetch(&mut conn);

while let Some(song) = stream.try_next().await? {
    // process one row at a time
}
```

### Joins and projections

```rust
let songs = Song::query()
    .select_clear()
    .select("songs.*")
    .select("s.score")
    .join("INNER JOIN stats s ON s.song_id = songs.id AND s.score > ?", [50])?
    .order_by("s.score", Direction::Desc)?
    .all(&mut conn)
    .await?;
```

### Fuzzy search

```rust
let matches = Song::query()
    .fuzzy_search("night fire", ["title", "original_title"])?
    .limit(10)
    .all(&mut conn)
    .await?;
```

### Raw rows

```rust
use std::collections::HashMap;
use average_record::SqlValue;

let rows: Vec<HashMap<String, SqlValue>> = Song::query()
    .select_clear()
    .select("title, COUNT(*) AS n")
    .order_by_raw("n", Direction::Desc)
    .all_raw(&mut conn)
    .await?;

for row in &rows {
    if let Some(title) = row.get("title").and_then(SqlValue::as_str) {
        println!("{title}");
    }
}
```

### Inspecting generated SQL

```rust
let generated = Song::query().where_eq("artist_id", 1)?.to_sql();
assert_eq!(generated.sql, "SELECT * FROM songs WHERE artist_id = ?");
```

---

## Validation

`validate(conn)` combines declarative field rules (via `garde`) with `validate_custom`, running on
the same connection. It returns all errors (empty means valid).

```rust
let errors = song.validate(&mut conn).await?;
for error in &errors {
    eprintln!("{}: {}", error.column, error.message);
}
```

`save` and `save_within` invoke `validate_custom` inside the write transaction and return
`Error::Validation(Vec<ValidationError>)` when a custom check fails. A common controller flow is to
call `validate` first to surface field errors to the client, then `save`.

### Field rules (`garde`)

Declarative rules are attached with `#[garde(...)]` on the struct fields. A few common ones:

| Rule | Example | Checks |
| --- | --- | --- |
| `required` | `#[garde(required)]` | an `Option` field is `Some` |
| `length` | `#[garde(length(min = 1, max = 200))]` | string/container length in `min..=max` (or `equal`) |
| `range` | `#[garde(range(min = 0, max = 100))]` | a number in `min..=max` (or `equal`) |
| `email` | `#[garde(email)]` | an HTML5 email address |
| `url` | `#[garde(url)]` | a URL |
| `pattern` | `#[garde(pattern(r"^[a-z0-9_]+$"))]` | a string matching a regular expression |
| `contains` / `prefix` / `suffix` | `#[garde(prefix("https://"))]` | a substring / prefix / suffix |
| `matches` | `#[garde(matches(password))]` | a field equals another field |
| `ascii` / `alphanumeric` | `#[garde(alphanumeric)]` | ASCII-only / letters-and-digits-only |
| `ip` / `ipv4` / `ipv6` | `#[garde(ipv4)]` | an IP address of the given family |
| `dive` / `custom` / `skip` | `#[garde(skip)]` | nested validation / custom fn / opt out |

Feature-gated rules: `email`, `url`, `pattern` (regex), `credit_card`, `phone_number`. Enable them
in your own `Cargo.toml` (for example `garde = { version = "0.23", features = ["email", "url", "regex"] }`).

For the complete, always-current list and their exact arguments, see the
[`garde` "Available validation rules" table](https://docs.rs/garde/0.23.0/garde/#available-validation-rules).

### Uniqueness helpers

```rust
// Single column, excluding this record's own primary key.
let unique = song.check_uniqueness(&mut conn, "title", &song.title).await?;

// Multi-column or arbitrary condition.
let unique = song
    .check_uniqueness_raw(&mut conn, "remote_id = ? AND platform = ?", [&song.remote_id, &song.platform])
    .await?;
```

---

## Redaction

Mark sensitive columns with `#[redacted]`. Redaction is applied on demand.

```rust
#[derive(Model)]
#[model(table = "users")]
pub struct User {
    #[model(primary_key)]
    pub id: Option<i64>,
    pub username: String,
    #[redacted]
    pub email: String,
    #[redacted]
    pub password_digest: String,
}
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
        "Song" => Song::REDACTED_COLUMNS,
        _ => &[],
    }
}
```

---

## Change tracking

Change tracking is opt-in per write via `SaveOptions`, passed to a `*_with_options` method.

```rust
song.title = "Night of Fire (Extended)".into();
song.save_with_options(&mut conn, SaveOptions { track_changes: true, ..Default::default() }).await?;

if let Some(changes) = song.tracked_changes() {
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
let current_vs_db = song.changes(&mut conn, false).await?; // diff of current values vs persisted
let dirty = song.changed(&mut conn).await?;                // bool
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

async fn rename(song: &mut Song, conn: &mut sqlx::SqliteConnection) -> Result<()> {
    match song.save(conn).await {
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
