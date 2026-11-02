# average-record-rust — conversion analysis & plan

> **Note (0.2.0):** this design document predates the non-optional primary-key contract. Every
> `id: Option<i64>` snippet below now reads `id: i64`, where `0` means "new record"; hand-written
> models also implement `set_primary_key(&mut self, id: i64)`. See `rust/README.md` → "Primary keys".

## The public README (contract artifact)

The crate folder `components/average-record/` (note: not `average-record-rust` — the folder will
later also hold the Bun implementation and be extracted into its own repository,
<https://github.com/dimensionalpocket/average-record>) contains a single file, `README-RUST.md`. It is
written as **end-user documentation** — as if the implementation were already complete — and is the
source of truth for the public API.

That README doubles as the **interface contract**: it intentionally precedes implementation so the
ergonomics can be reviewed and adjusted before any code is written. Once the API is frozen, the
implementation follows the phased plan below. Anything about process, feasibility, or internal
design lives in this plan, not in the README.

## Goal

Evaluate converting `@dimensionalpocket/average-record` (`components/database`) into a Rust
crate that a future Rust app (TBD) can consume. If feasible, the crate would live at
`components/average-record/` as a standalone Cargo crate (like `api-rescuer/`, not a Bun
workspace and not referenced from the root `package.json`).

The consuming Rust app follows the `api` workspace model: **it owns its migration files, its data
folder, and all pool/PRAGMA configuration**. The crate provides the engine (models, query builder,
migrations, validation); the app supplies the schema and the database connection.

Scope constraints from the request:

- **Fully async where possible.** Unlike the original (deliberately synchronous), the public API
  should be async and never block the async executor.
- **SQLite only.** No Postgres/MySQL compatibility work.
- **Connection-based, never pool-based.** All execution APIs take a caller-provided
  `&mut SqliteConnection` (or `&mut Transaction`); the crate never owns or accepts a `Database`/pool
  and ships no pool/PRAGMA configuration helpers. This mirrors the validated pattern in
  [`dimensionalpocket/dps-auth-api`](https://github.com/dimensionalpocket/dps-auth-api/tree/library-conversion)
  (orchestrators acquire one connection from the pool and pass it down to services/queries), which
  itself follows the official `sqlx` SQLite example.
- **Behavioral parity, not API parity.** The TS class-inheritance surface does not translate to
  Rust; the crate should preserve the *capabilities* (CRUD, query builder, migrations, validation,
  redaction, change tracking, timestamps, lifecycle hooks) in an idiomatic Rust shape.

This document is analysis + a plan, not an implementation. Code blocks are illustrative sketches.

## Executive verdict

**Technically feasible with moderate effort, and worth doing — but it is a rewrite, not a port.**

Every capability in the component is standard and well supported in the Rust ecosystem (async
SQLite, dynamic query building, streaming rows, migrations, validation). Nothing is exotic. What
does *not* survive translation is the Active-Record **class-inheritance + static-property** model:
Rust has no inheritance, no per-subclass static storage, and no per-class `typeof` lookup. That
forces a different (arguably better) design: a `Model` trait with associated consts, **a
caller-provided connection on every execution method**, and — for ergonomics — an optional
`#[derive]` proc-macro.

Two honest caveats:

1. **"Fully async" is an API-level property, not a SQLite-level one.** SQLite is a synchronous,
   in-process C library. The `sqlx` SQLite driver runs every call on a dedicated worker thread and
   hands results back over channels. The API can be fully `async` and executor-friendly; the
   underlying `sqlite3_step` is still blocking work on one thread. That is the maximum achievable
   with SQLite and is sufficient.
2. **The pinned toolchain was behind `sqlx` 0.9's MSRV.** `.tool-versions` pin was `rust 1.93.1`;
   `sqlx` 0.9.0 requires Rust 1.94.0. Resolved: bumped to current stable **1.99.0** (2026-10-01),
   targeting `sqlx` 0.9.0.

## Resolved decisions

1. **The consuming app owns migrations and the data folder.** The crate exposes a `Migrator` the app
   points at its own migrations directory and SQLite file path (exactly how `api` wires four
   databases today). No paths are baked into the crate.
2. **No dynamic model registry in the crate.** Validated: the only `MODELS` lookup in `api`
   (`DiscordPublishRecordUpdateJob`) uses a model *class* solely to read its static list of redacted
   columns. It never instantiates or queries through the registry, so no `dyn Model`, no
   `async-trait`, and no boxing are required. A plain `model_name -> &'static [&'static str]` lookup
   in the consuming app covers it.
3. **Typed structs, including virtual optional columns.** Query results are typed. When a query
   selects a custom/derived column, that column is added to the struct as an `Option<T>` field with
   a doc comment, marked non-persisted. This mirrors the current `api` pattern
   (`declare artist_name?: string`, `declare score?: number`, etc.).
4. **No `query!` compile-time checking.** The query builder is inherently dynamic (conditional
   clauses, whole subqueries in the `SELECT` list — see `Song.scoreSelect`,
   `Song.audioTrackSelect`, `Song.currentUserRatingSelect`). `query!` cannot express these. Use the
   runtime `QueryBuilder`, which is the right tool.
5. **Hooks run inside the write's transaction; write methods are split by concern.** `save(conn)` /
   `destroy(conn)` use default options and own their transaction; `save_with_options(conn, opts)` /
   `destroy_with_options(conn, opts)` add flags; `save_within(tx)` / `destroy_within(tx)` (and their
   `_with_options` forms) join a caller-managed unit of work. Rationale for the transaction is below.
6. **Execution is connection-based.** The crate's model, query, validation, uniqueness, change-
   tracking, and migration APIs take `&mut SqliteConnection` / `&mut Transaction`. The app owns the
   `SqlitePool`.
7. **No pool/PRAGMA helpers in the crate.** The app owns connection options, `journal_mode`,
   `busy_timeout`, `after_connect`, lazy connect, and idle timeout. `VACUUM INTO` backup is likewise
   an app-side one-liner on a connection. The crate stays focused on the ORM/query/migration surface.
8. **Flags are `bool`, not `0/1` integers.** The model author knows which columns are true flags and
   which are small ints/enums/counts. Details and trade-offs below.
9. **`SaveOptions` carries behavior flags only, never the connection.** `track_changes` (and
   `skip_updated_at`) stay opt-in via a `Default`-able options struct, accepted only by the
   `*_with_options` write variants. `save(conn)` / `save_within(tx)` keep the common case clean. Why
   the connection is deliberately not a field of the options struct is explained below.
10. **Hooks live on a separate `ModelHooks` trait.** `#[derive(Model)]` generates `impl Model` (table
    metadata + row mapping); the developer writes `impl ModelHooks` (lifecycle hooks + `validate_custom`),
    which is valid when empty. This avoids one impl block being co-owned by a derive and the developer.
11. **Builder steps are fallible when they validate developer input.** `where_*`, `where_in/not_in`,
    `where_raw`, `order_by(_raw)`, `join`, and `fuzzy_search` return `Result<Self>`; `select`,
    `select_clear`, `limit`, and `offset` are infallible. Terminals take a connection.
12. **Models may derive `serde::Serialize`.** `to_json` and `TrackedChanges::to_json` need it; the
    derive macro can add it, or models add it themselves. This is the one place Rust needs a derive
    the TS version got for free.
13. **Timestamps default to ISO-8601 UTC strings formatted with std** (no `chrono`/`time`), matching
    the existing schema; a model may instead opt into `i64` epoch-millisecond columns, configured per
    model. See the Implementation reference.

Details for decisions 5, 8, 9, 10, 11, 12, and 13 are collected in the **Implementation reference**
section near the end; where that section and the README (the contract) disagree, the README wins.

### Registry validation detail

`api/src/models/index.ts` exports `MODELS: Record<string, typeof ApplicationRecord>`. Grep across
`api` shows a single consumer:

- `api/src/jobs/discord/DiscordPublishRecordUpdateJob.ts:30` — `const ModelClass =
  MODELS[jobArgs.modelName]`, only to call `ModelClass.redacted()` (line 36). The changed data is
  already serialized into the job payload; no record is loaded through the class.

Therefore the registry reduces to a static redaction lookup, e.g.:

```rust
pub fn redacted_columns_for(model_name: &str) -> &'static [&'static str] {
    match model_name {
        "Song" => Song::REDACTED_COLUMNS,
        "User" => User::REDACTED_COLUMNS,
        // ...
        _ => &[],
    }
}
```

No inheritance, no dynamic dispatch, no async. The crate stays free of `async-trait`.

## Connection-based execution model

### Why

With a pool of more than one connection, a multi-step workflow (create a role, then a user that
references it; check permissions, then write) can land on different connections. Related writes are
then not visible to each other at the right time, producing foreign-key failures and race
conditions. The fix is **connection affinity per unit of work**: acquire exactly one connection, do
everything on it, release it. This is the pattern documented and validated in `dps-auth-api`
(`docs/llm/plans/2025/12/05-connection-based-architecture.md` and
`...-sqlx-connection-pattern-validation.md`), and it matches the official `sqlx` SQLite example.

### Layout

```
App owns: SqlitePool (connection options, WAL, busy_timeout, connect_lazy, idle_timeout)
  │
  ├─ boot: acquire connection → Migrator::run(&mut conn).await
  │
  └─ request / controller / orchestrator:
        let mut conn = pool.acquire().await?;        // ONE connection
        // optional explicit unit of work:
        let mut tx = conn.begin().await?;
        Song::find(&mut *tx, id).await?;             // same connection
        Song::query().where_eq("artist_id", 1)?.all(&mut *tx).await?;
        song.save_within(&mut tx).await?;   // hooks + DML in the caller's tx
        tx.commit().await?;
```

### Implications for the crate

- The crate has **no `Database` singleton, no pool dependency, and no PRAGMA/pool helpers** on its
  execution path. Models do not carry a `db()` handle; query builders are not bound to a database.
  Everything that touches SQL takes `&mut SqliteConnection` (or `&mut Transaction`).
- Pool concerns are entirely the app's: connection options, `journal_mode = WAL`, `foreign_keys`,
  `busy_timeout`, `after_connect`, `connect_lazy`, `idle_timeout`, `pool.close()`, and backups
  (`VACUUM INTO`).
- The `Migrator` receives a connection and the app-supplied migration/schema paths.

### Transaction nesting with the write variants

`save_within(tx)` / `save_within_with_options(tx, opts)` (and the `destroy` pair) never begin or
commit — they use the caller's transaction directly. `save(conn)` / `save_with_options(conn, opts)`
(and the `destroy` pair) are thin wrappers: `conn.begin()` → `save_within_with_options` → `commit`.
Because `Transaction<'_, Sqlite>` dereferences to `SqliteConnection`, callers pass `&mut *tx` where
the API expects `&mut SqliteConnection`. If a caller passes a connection that is already inside a
transaction (rather than using the `_within` variant), `sqlx`'s SQLite worker tracks transaction
depth and emits a `SAVEPOINT`, so the write still nests safely.

**Why the transaction at all?** Three reasons:

1. **Atomicity of a save unit.** A save is not one statement: custom/DB-dependent validation reads
   (uniqueness, cross-column checks), `before_*` hooks, the `INSERT`/`UPDATE`, and `after_*`/
   `after_save` hooks (which often touch counters or related rows) must all succeed or all roll back.
   Without a transaction, SQLite auto-commits each statement and a failing hook leaves partial state.
2. **TOCTOU on uniqueness.** A uniqueness check followed by an insert on the same connection is only
   race-free if both are in one transaction; otherwise another connection can insert the same value
   in between.
3. **Isolation / visibility.** The record and its side effects become visible only at commit, so a
   concurrent reader never observes a half-saved record.

Caveat: a transaction holds a write lock for its duration, so hooks must stay short. When the app
already manages the larger unit of work (the usual orchestrator case), `save_within` avoids repeated
nested savepoints.

### Reference: connections vs transactions

`Transaction<'_, DB>` implements `Deref`/`DerefMut` to the inner `DB::Connection`, and sqlx does
**not** implement `Executor` for `Transaction` or `&mut Transaction` — only `&Pool` and
`&mut Connection` (see the sqlx `Executor` docs). Two consequences for this crate:

- A function whose parameter is `&mut SqliteConnection` **accepts a transaction**, but only via an
  explicit reborrow-deref: pass `&mut *tx` (or `&mut **p` when the variable is already a
  `&mut Transaction`). Passing `tx` or `&mut tx` directly fails to compile (no auto-deref at a
  function-call boundary). This means a transaction transparently satisfies every `conn`-typed API.
- `Connection::begin(&mut self)` returns a `Transaction<'_, DB>` that mutably borrows the connection
  for the transaction's lifetime, so while `tx` is alive you cannot also use `conn` directly (the
  compiler rejects the double mutable borrow). Everything in the unit of work must go through `tx`
  (`&mut *tx`). There is no API path that runs a statement on a bare `conn` *inside* an open
  transaction — acquiring a second pooled connection would run on a different physical connection and
  lose the consistency guarantee.

Therefore: within a transaction, `tx` **is** the connection; route all reads (uniqueness checks,
`validate_custom`, `changes`, etc.) and writes through `&mut *tx` so they all execute inside that
transaction. The `_within` write variants take the actual `&mut Transaction` (not `&mut *tx`) because
they need the transaction itself to nest a savepoint.

#### `save(conn)` vs `save(&mut *tx)`: not a data bug, an idiom bug

`&mut SqliteConnection` does not encode at the type level whether it is a bare pooled connection or a
reborrow of a transaction. So `save(&mut *tx)` compiles and is *correct*: sqlx's worker sees the
connection is already in a transaction and emits a `SAVEPOINT`, so the write still lands inside the
caller's transaction. The cost is an unnecessary savepoint, not lost atomicity.

- Holding a `Transaction`? Call `save_within(&mut tx)` — no extra savepoint. `save(&mut *tx)` here is
  a likely idiom mistake.
- Holding a plain `&mut SqliteConnection` with no transaction of your own? Call `save(&mut conn)` —
  the crate opening the transaction/savepoint is the point.
- Legitimate `save(&mut *tx)`: a helper typed on `&mut SqliteConnection` that deliberately wants its
  own "save + hooks" savepoint boundary *inside* a larger transaction, without threading `Transaction`
  through its signature.
- Never acquire a second pooled connection inside a transaction: that runs on a different physical
  connection and loses the consistency guarantee (the real data bug).

The mitigation for the footgun is naming plus docs (`save_within` reads as "join the transaction I
already have"), not the type system.

#### Why not a generic `Executor` parameter

A tempting alternative is a single write method generic over sqlx's `Executor`, so one call works for
both connections and transactions. We deliberately reject it:

- sqlx does **not** implement `Executor` for `Transaction` or `&mut Transaction` (0.7+ architecture
  change); callers must pass `tx.as_mut()` / `&mut **tx`, and the `for<'c>` + `'q: 'e` lifetimes leak
  into every signature. This is a well-known source of cascading compile errors.
- The executor is consumed by value per call, so reusing it for several queries requires contorted
  reborrows.
- It only adds `&Pool` support, which this crate intentionally does not use (connection-based, no
  pool), so there is no capability gain.
- It obscures transaction ownership — the "who owns the transaction" signal is exactly what the
  explicit `save` / `save_within` split makes obvious.

The narrow version of the idea is simply to keep parameters as `&mut SqliteConnection`; `&mut *tx`
already satisfies those. That is why every `conn`-typed API is transparently transaction-compatible
without any generic `Executor` bound.

### Illustrative usage

```rust
async fn create_song_with_tags(pool: &SqlitePool, input: SongInput) -> Result<Song> {
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin().await?;

    let mut song = Song { title: input.title, ..Default::default() };
    song.save_within(&mut tx).await?;   // hooks + validate + insert in the caller's tx

    for tag in input.tags {
        let mut t = Tag { song_id: song.id.unwrap(), ..Default::default() };
        t.save_within(&mut tx).await?;
    }

    tx.commit().await?;
    Ok(song)
}
```

And the standalone form (crate owns the tiny transaction):

```rust
let mut conn = pool.acquire().await?;
song.save_with_options(&mut conn, SaveOptions { track_changes: true, ..Default::default() }).await?;  // begin → hooks/DML → commit
```

## Inventory of the current component

`components/database/` — `@dimensionalpocket/average-record`, private workspace package.

| File | LOC (approx) | Role |
| --- | --- | --- |
| `index.ts` | 9 | Public exports |
| `src/Database.ts` | 16 | Abstract `Database<T>`: `getDb`, `checkIdle`, `close`, `backupToFile`, logger |
| `src/BunSqliteDatabase.ts` | 78 | `bun:sqlite` impl: lazy open, PRAGMA init, idle auto-close timer, `VACUUM INTO` backup |
| `src/ApplicationRecord.ts` | 506 | Base model: CRUD, timestamps, hooks, validation, redaction, change tracking, uniqueness |
| `src/ApplicationRecordQuery.ts` | 220 | Fluent query builder → SQL string + params |
| `src/Migrator.ts` | 214 | `{version}_{name}.{up,down}.sql` runner, `schema_migrations`, schema dump |
| `src/MigrationExecutor.ts` | 116 | `process.argv` CLI wrapper around `Migrator` |
| tests | ~1.5k | Behavior spec: 4 test files |

Usage footprint in the monorepo: 21 models in `api/src/models`, 4 databases (`main`, `wiki`,
`jobs`, `metrics`), 76 migration files, and ~41 call sites of hooks/validation/tracking. Models
subclass `MainRecord`/`WikiRecord`/etc., which subclass `ApplicationRecord`. The Bun API relies on
the **synchronous** return of `save()`/query methods throughout (e.g. `Song.refreshCounters()` calls
`this.save()` inline; `Video.platformId` setter calls `Platform.find(value)` inline).

### Capability catalog (the contract to preserve)

- **Database layer** (now app-owned): lazy connection on first use, ordered PRAGMA initialization,
  optional idle auto-close, `close()`, `backupToFile()` via `VACUUM INTO`. The crate keeps none of
  this; the app owns pool config and backup.
- **Model**: schema-declared columns; `find`, `all`, `allRaw`, `first`, `count`, `each`, `eachRaw`;
  `save()` (insert vs update by PK presence), `destroy()`; `created_at`/`updated_at` auto-management
  with `skipUpdatedAt`; insert returns `lastInsertRowid`.
- **Query builder**: `where`, `whereIn`, `whereNotIn`, `whereRaw`, `fuzzySearch`, `orderBy`,
  `limit`, `offset`, `select`/`selectClear`, `join` (raw, accumulating), `count`, `first`, `find`,
  `all`, `allRaw`, `each`, `eachRaw`, `toSQL`. Params are always bound as `?` placeholders; joins
  bind before where regardless of call order.
- **Lifecycle hooks**: `beforeCreate`/`beforeUpdate` before the write, `afterCreate`/`afterUpdate`
  after, then `afterSave`; `afterDestroy` after delete. Overridable, chained via `super`.
- **Validation**: schema validation + `validateCustom()`; returns `{ column, message }[]`.
- **Uniqueness**: `checkUniqueness(field, value)`, `checkUniquenessRaw(condition, params)`, both
  excluding the current record.
- **Redaction**: columns marked in schema metadata; `redacted()`, `redact()`, and redacted variants
  of `persisted()`, `toJSON()`, `changes()`.
- **Change tracking**: `persisted()` (DB state), `changes()` (current vs DB), `changed()`,
  `trackedChanges()` after `save({ trackChanges })` / `destroy({ trackChanges })` as
  `{ col: [old, new] }`.
- **Migrations**: filename convention `{version}_{name}.{up,down}.sql`, applied versions in
  `schema_migrations`, direction/target version, schema dump from `sqlite_master`, CLI flags.

## Rust design analysis

### What translates cleanly

| TS concept | Rust equivalent | Notes |
| --- | --- | --- |
| `ApplicationRecordQuery` | `Query<M>` builder over `sqlx::QueryBuilder` | Raw fragments + binds map to `push` / `push_bind`; terminals take a connection |
| `each`/`eachRaw` | `query.execute(conn).fetch(conn)` async stream | `futures::TryStreamExt::try_next()`; stream borrows the connection |
| `count` | `SELECT COUNT(*)` scalar query | Straightforward |
| `VACUUM INTO` backup | app-side `sqlx::query("VACUUM INTO ?")` | Not a crate concern (decision 7) |
| `Migrator` | Ported custom migrator | Preserves `schema_migrations`; runs against a caller-provided connection |
| `validateCustom` | async trait method taking `&mut SqliteConnection` | Native `async fn` in traits (Rust 1.75+) |
| `trackedChanges` | snapshot + diff | Snapshot stored on the instance; sync accessor |
| `TaggedLogger` | `tracing` | Matches `api-rescuer` conventions |

### What fights the language

1. **Class inheritance + `static` per-subclass storage.** `User.database`, `User.schema`,
   `User.tableName` are resolved statically per subclass. Rust has no inheritance. The replacement is
   a `Model` trait with associated consts (`TABLE_NAME`, `PRIMARY_KEY`, `COLUMNS`,
   `REDACTED_COLUMNS`, `TIMESTAMPS`) and connection-parameterized methods.
2. **Duck-typed attribute bags.** Models are dynamic property bags; SQLite columns are only known at
   runtime. Rust structs are fixed layouts. The resolution (decision 3) is typed structs with
   virtual optional fields: any projection column used by a query gets a matching `Option<T>` field,
   documented as non-persisted. The `Model` trait derives `COLUMNS` from the persisted fields only.
3. **Exceptions vs `Result`.** `find()` returns `T | null` (a miss is not an error) but a DB failure
   throws. Rust models this as `Result<Option<T>, Error>`, which is noisier at call sites but
   correct.
4. **Synchronous reliance.** Every `save()`/query assumes immediate completion. Rust forces `.await`
   to propagate through every hook, static helper, and caller, and the caller must thread a
   connection through the call chain.

### Flag columns: `bool` vs `0/1` integers

SQLite has no boolean type; flags live in `INTEGER` columns. `sqlx` has first-class `bool` support:
`bool` maps to `BOOLEAN` / `INTEGER` / `INT8` columns, encodes `true → 1` / `false → 0`, and decodes
as `value.int() != 0` (lenient — a stray `2` decodes as `true` rather than erroring). So `bool` is
safe even against legacy non-`0/1` data.

**Recommendation: model genuine on/off flags as `bool` (`Option<bool>` when the column is
nullable), and keep integer types for numeric values.** Trade-offs:

| | `bool` | `i64` (`0/1`) |
| --- | --- | --- |
| Domain modeling | Exact on/off semantics | Weak; any integer is representable |
| Invalid states | Impossible at compile time | `2`, `-1`, etc. possible |
| JSON wire format | `true`/`false` — matches what the Bun frontends already send | `0`/`1` — forces the frontend/serializer coercion the original works around |
| sqlx mapping | Automatic `0/1`; lenient decode (`!= 0`) | Native |
| Legacy non-`0/1` rows | Decodes as `true`, no error (re-encodes as `1`) | Preserved verbatim |
| Reads | `if song.locked` | `if song.locked == 1` |
| Nullable | `Option<bool>` | `Option<i64>` |

The original's `v.transform(Number)` workaround exists only because Valibot re-parses a JSON boolean
into a `v.number()` column. In Rust there is no such re-parse: the field is `bool`, and
`to_values()` emits `0`/`1`. The entire problem disappears. The one case *not* to use `bool` is a
small-integer column that is semantically an enum, status, or count (e.g. a `category_code`) — those
stay integers or become Rust enums.

### Proposed crate architecture

Standalone Cargo workspace, macro-free core plus an optional derive companion. The on-disk folder is
`components/average-record/`, matching the README's location and the future standalone repo
(`github.com/dimensionalpocket/average-record`). The Cargo packages inside it are named
`average-record` (core) and `average-record-derive` (proc-macro).

```
components/average-record/
├── README-RUST.md             # end-user docs + interface contract (exists)
├── Cargo.toml                 # workspace root: members = core + derive; shared [workspace.dependencies]
├── Cargo.lock                 # committed (api-rescuer convention)
├── .gitignore                 # target/
├── average-record/            # core library crate
│   ├── Cargo.toml             # name = "average-record", version = "0.1.0", edition = "2024"
│   └── src/
│       ├── lib.rs             # re-exports; `pub use average_record_derive::*` behind the `derive` feature
│       ├── error.rs           # Error enum + Result alias (thiserror)
│       ├── model.rs           # Model trait, ModelHooks trait, timestamps, save/destroy (+_within)
│       ├── query.rs           # Query<M> builder, GeneratedSql, SqlValue (no DB handle stored)
│       ├── validation.rs      # ValidationError, validate helpers
│       ├── changes.rs         # Change/Changes snapshot + diff (change tracking)
│       └── migrations/
│           ├── mod.rs         # Migrator (TS-semantics port; takes &mut conn)
│           └── cli.rs         # optional clap executor (feature-gated)
└── average-record-derive/     # optional proc-macro crate
    ├── Cargo.toml             # name = "average-record-derive", proc-macro = true
    └── src/lib.rs            # #[derive(Model)], #[model(...)], #[redacted]
```

There is deliberately no `Database`/pool type and no PRAGMA/pool/backup helpers. The `Migrator` is
given a connection, not a pool.

**Where each type lives in the feature graph.** `sqlx`, `tokio`, `serde`, `serde_json`, `garde`,
`thiserror`, and `tracing` are core-crate dependencies. `clap` is an optional dependency gated by the
`cli` feature. The core crate does not depend on the derive crate; instead the derive crate depends on
nothing from core (it only emits `impl average_record::...` blocks), and the core crate re-exports the
macros behind its default `derive` feature so hosts write a single dependency.

**Package versions and features.**

| Package | Version | Features |
| --- | --- | --- |
| `average-record` | `0.1.0` | default = `["derive"]`; optional `derive` (re-exports the proc-macros), `cli` (migration CLI) |
| `average-record-derive` | `0.1.0` | proc-macro crate; no features |

The host app enables `cli` explicitly when it wants `MigrationExecutor`; `derive` is on by default.

Illustrative core trait (sketch — not final syntax). Note the **two-trait split**: `Model` holds the
static table metadata and row mapping (generated by `#[derive(Model)]`), while `ModelHooks` holds the
overridable lifecycle hooks and DB-dependent validation (hand-written, with defaults for every
method). The split exists because Rust cannot generate overridable default method bodies *and* let the
derive own the impl — the derive writes `impl Model`, and the developer writes an (often empty)
`impl ModelHooks`. This matches the README, which is the source of truth.

```rust
/// Behavior flags for a write, independent of which connection/transaction it runs on.
/// Derives `Default`, so callers write `SaveOptions { track_changes: true, ..Default::default() }`.
/// Passed only to the `*_with_options` write variants.
#[derive(Default, Clone, Copy)]
pub struct SaveOptions {
    pub track_changes: bool,      // opt-in change tracking (decision 9)
    pub skip_updated_at: bool,    // on update, preserve the existing update timestamp
}

/// Static metadata + row/column mapping. Generated by `#[derive(Model)]`; hand-written when the
/// macro is not used.
pub trait Model: Sized + Send + 'static {
    const TABLE_NAME: &'static str;
    const PRIMARY_KEY: &'static str = "id";
    const COLUMNS: &'static [&'static str];
    const REDACTED_COLUMNS: &'static [&'static str] = &[];
    const TIMESTAMPS: Timestamps = Timestamps::ISO8601; // per-model columns + format

    fn from_row(row: &SqliteRow) -> Result<Self>;
    fn to_values(&self) -> Vec<SqlValue>;

    // Reads are connection-based and provided by the trait.
    async fn find(conn: &mut SqliteConnection, id: i64) -> Result<Option<Self>> { /* ... */ }
    async fn all(conn: &mut SqliteConnection) -> Result<Vec<Self>> { /* ... */ }
    async fn first(conn: &mut SqliteConnection) -> Result<Option<Self>> { /* ... */ }
    async fn count(conn: &mut SqliteConnection) -> Result<i64> { /* ... */ }
    fn query() -> Query<Self> { /* ... */ }

    // Writes: the connection/tx is an explicit argument; options are split into a separate method
    // so the common case stays clean (`save(conn)`), and flags live in `*_with_options`.
    async fn save(&mut self, conn: &mut SqliteConnection) -> Result<()> {
        self.save_with_options(conn, SaveOptions::default()).await
    }
    async fn save_with_options(&mut self, conn: &mut SqliteConnection, opts: SaveOptions) -> Result<()> {
        let mut tx = conn.begin().await?;
        self.save_within_with_options(&mut tx, opts).await?;
        tx.commit().await?;
        Ok(())
    }
    async fn save_within(&mut self, tx: &mut Transaction<'_, Sqlite>) -> Result<()> {
        self.save_within_with_options(tx, SaveOptions::default()).await
    }
    async fn save_within_with_options(&mut self, tx: &mut Transaction<'_, Sqlite>, opts: SaveOptions) -> Result<()> { /* ... */ }

    async fn destroy(&mut self, conn: &mut SqliteConnection) -> Result<()> {
        self.destroy_with_options(conn, SaveOptions::default()).await
    }
    async fn destroy_with_options(&mut self, conn: &mut SqliteConnection, opts: SaveOptions) -> Result<()> {
        let mut tx = conn.begin().await?;
        self.destroy_within_with_options(&mut tx, opts).await?;
        tx.commit().await?;
        Ok(())
    }
    async fn destroy_within(&mut self, tx: &mut Transaction<'_, Sqlite>) -> Result<()> {
        self.destroy_within_with_options(tx, SaveOptions::default()).await
    }
    async fn destroy_within_with_options(&mut self, tx: &mut Transaction<'_, Sqlite>, opts: SaveOptions) -> Result<()> { /* ... */ }
}

/// Overridable lifecycle hooks + DB-dependent validation. Hand-written per model; all methods have
/// defaults, so `impl ModelHooks for Song {}` is valid. Called by `save_within_with_options` /
/// `destroy_within_with_options`.
pub trait ModelHooks {
    async fn before_create(&mut self, _conn: &mut SqliteConnection) -> Result<()> { Ok(()) }
    async fn before_update(&mut self, _conn: &mut SqliteConnection) -> Result<()> { Ok(()) }
    async fn after_create(&self, _conn: &mut SqliteConnection) -> Result<()> { Ok(()) }
    async fn after_update(&self, _conn: &mut SqliteConnection) -> Result<()> { Ok(()) }
    async fn after_save(&self, _conn: &mut SqliteConnection) -> Result<()> { Ok(()) }
    async fn after_destroy(&self, _conn: &mut SqliteConnection) -> Result<()> { Ok(()) }
    async fn validate_custom(&self, _conn: &mut SqliteConnection) -> Result<Vec<ValidationError>> { Ok(vec![]) }
}
```

<details>
<summary>Alternative considered and rejected: hooks on the <code>Model</code> trait</summary>

An earlier sketch put the hooks directly on `Model` with default bodies, so a model only needed
`impl Model`. That couples the derive-generated impl (which cannot know which hooks the developer
wants to override without extra attributes) to hand-written overrides in the same impl block, and
Rust does not let a derive emit *some* methods of an impl while the user writes others. Splitting into
`Model` (derived) + `ModelHooks` (hand-written) keeps each impl block owned by exactly one writer.
The cost is a mandatory `impl ModelHooks for Song {}` line for hook-less models. This is the accepted
design; `ModelHooks` is part of the public API contract.

</details>

`save_within_with_options` / `destroy_within_with_options` are the shared implementations (they never
begin/commit). They delegate hook and validation calls to `ModelHooks`:

```rust
// Illustrative flow inside save_within_with_options.
self.validate_custom(&mut *tx).await?;             // DB-dependent validation in the same tx (ModelHooks)
if is_new { self.before_create(&mut *tx).await? } else { self.before_update(&mut *tx).await? }
self.set_timestamps(opts.skip_updated_at);
insert_or_update(&mut *tx, self).await?;           // DML inside the transaction
if is_new { self.after_create(&mut *tx).await? } else { self.after_update(&mut *tx).await? }
self.after_save(&mut *tx).await?;
if opts.track_changes { self.capture_tracked_changes(before); }   // opt-in (decision 9)
```

**Why `SaveOptions` does not carry the connection.** Keeping the connection out of the options
struct is deliberate:

- A `&mut` field forces a lifetime parameter on `SaveOptions<'a>`, which blocks `#[derive(Default)]`,
  `Copy`, and the ergonomic `..Default::default()` pattern that makes an options struct worthwhile.
- The two write modes target different types (`&mut SqliteConnection` vs
  `&mut Transaction<'_, Sqlite>`). Folding the target into the options would require an enum inside
  the struct (with its own lifetime juggling) or duplicated options types; separate method variants
  keep each signature concrete.
- The connection is the *target* of the call; the options are *how* to run it. `save_with_options(&mut conn, opts)`
  reads better and keeps the borrow visible than burying it in a struct literal.
- Reborrowing a connection out of a struct (`&mut *opts.conn`) is awkward and blocks partial moves;
  an explicit argument lets the compiler reborrow naturally.

Call sites:

```rust
song.save(&mut conn).await?;                                                          // defaults
song.save_with_options(&mut conn, SaveOptions { track_changes: true, ..Default::default() }).await?;
song.save_within(&mut tx).await?;                                                     // in caller's tx
song.save_within_with_options(&mut tx, SaveOptions { skip_updated_at: true, ..Default::default() }).await?;
```

`Result` here is the crate alias `average_record::Result<T> = std::result::Result<T, average_record::Error>`
(see the Implementation reference below). The README's `use average_record::{Error, Result};`
examples match this naming; there is no separate `RecordError` type.

Query sketch (no database argument when building; the connection is passed to terminals):

```rust
// Static queries take a connection.
let song = Song::find(&mut conn, 42).await?;

let songs = Song::query()
    .where_eq("artist_id", 1)?
    .order_by("title", Direction::Asc)?
    .limit(20)
    .all(&mut conn)
    .await?;

let mut stream = Song::query()
    .fuzzy_search("night fire", ["title", "original_title"])?
    .fetch(&mut conn);
while let Some(song) = stream.try_next().await? { /* ... */ }
```

Change tracking and uniqueness are connection-based because they read the DB:

```rust
song.persisted(&mut conn, false).await?;                 // current DB state (or None for new)
song.changes(&mut conn, false).await?;                   // diff current vs DB
song.changed(&mut conn).await?;                          // bool
song.check_uniqueness(&mut conn, "title", &song.title).await?;
song.tracked_changes();                                  // sync, from the last tracked save/destroy
```

### Typed structs with virtual columns

Each model is a struct whose persisted fields are the schema; projection columns are `Option<T>`
fields not listed in `COLUMNS`. The `api` `Song` model illustrates the pattern (its `artist_name`,
`score`, `video_song_count`, `user_rating`, `user_training`, `audio_track` all come from `SELECT`
fragments):

```rust
#[derive(Model)]
#[model(table = "songs")]
pub struct Song {
    #[model(primary_key)]
    pub id: Option<i64>,
    pub artist_id: i64,
    pub title: String,
    pub original_title: Option<String>,
    pub genre: Option<String>,
    // ... counters ...
    pub locked: bool,               // INTEGER 0/1; sqlx maps automatically (decision 8)
    pub created_at: String,
    pub updated_at: String,

    /// Populated by `with_artist_name()`; not persisted.
    pub artist_name: Option<String>,
    /// Populated by `Song::score_select()`; not persisted.
    pub score: Option<i64>,
    /// Populated by the audio-track projection; JSON string; not persisted.
    pub audio_track: Option<String>,
}
```

Rule of thumb (decision 3): **any query that selects a custom column adds the corresponding
`Option<T>` field to the struct with a doc comment.** A raw escape hatch (`all_raw()` returning
`HashMap<String, SqlValue>`) covers ad-hoc projections that do not warrant struct fields.

### Macro: what it does, and does it introduce `unsafe`?

**No `unsafe`.** A Rust `#[derive]`/attribute proc-macro is a compile-time code generator: it
receives the item's token stream and *emits ordinary Rust source* (trait impls, `impl` blocks,
consts). Unless the macro author deliberately writes `unsafe { ... }` into the generated code, the
output is as safe as hand-written impls. `syn`/`quote`/`proc-macro2` are widely used, audited
community crates. The macro adds **no runtime dependency** and no unsafe surface; it only saves
boilerplate and runs during compilation.

The macro is **optional**. The core crate has zero proc-macro dependency; the derive crate is
feature-gated. Without the macro, each model implements the `Model` trait by hand.

Without the macro (manual, explicit):

```rust
pub struct Song {
    pub id: Option<i64>,
    pub artist_id: i64,
    pub title: String,
    pub original_title: Option<String>,
    pub locked: bool,
    pub created_at: String,
    pub updated_at: String,
    /// Populated by `with_artist_name()`; not persisted.
    pub artist_name: Option<String>,
    /// Populated by `score_select()`; not persisted.
    pub score: Option<i64>,
}

impl Model for Song {
    const TABLE_NAME: &'static str = "songs";
    const PRIMARY_KEY: &'static str = "id";
    const COLUMNS: &'static [&'static str] = &[
        "id", "artist_id", "title", "original_title", "genre",
        "rating_5_count", /* ... */ "locked", "created_at", "updated_at",
    ];
    const REDACTED_COLUMNS: &'static [&'static str] = &[];

    fn from_row(row: &SqliteRow) -> Result<Self> {
        Ok(Self {
            id: row.try_get("id")?,
            artist_id: row.try_get("artist_id")?,
            title: row.try_get("title")?,
            original_title: row.try_get("original_title")?,
            locked: row.try_get("locked")?,      // bool, decoded from INTEGER
            created_at: row.try_get("created_at")?,
            updated_at: row.try_get("updated_at")?,
            artist_name: row.try_get("artist_name").ok(), // virtual column
            score: row.try_get("score").ok(),             // virtual column
        })
    }

    fn to_values(&self) -> Vec<SqlValue> {
        vec![
            self.id.into(), self.artist_id.into(), self.title.clone().into(),
            self.original_title.clone().into(), /* ... */
        ]
    }

    // save_within / destroy_within provided by the trait; override hooks as needed.
}
```

With the macro (equivalent output, less boilerplate):

```rust
#[derive(Model)]
#[model(table = "songs")]
pub struct Song {
    #[model(primary_key)]
    pub id: Option<i64>,
    pub artist_id: i64,
    pub title: String,
    pub original_title: Option<String>,
    #[model(column = "genre")]
    pub genre: Option<String>,
    // ...
    #[model(column = "locked")]
    pub locked: bool,
    pub created_at: String,
    pub updated_at: String,

    #[model(virtual)]
    pub artist_name: Option<String>,
    #[model(virtual)]
    pub score: Option<i64>,
}
```

The derive generates `TABLE_NAME`, `COLUMNS` (persisted fields only), `from_row`, `to_values`,
`REDACTED_COLUMNS` (from `#[redacted]`), and blank hook defaults. `bool <-> i64` and similar
mappings are emitted as ordinary safe code.

### Async strategy

- **Driver: `sqlx` 0.9 with `runtime-tokio` + `sqlite` (bundled).** Its `SqliteConnection` uses one
  dedicated worker thread per connection and communicates via channels, so
  `sqlx::query(...).fetch(conn)` is executor-friendly and returns a real async stream. Because every
  API takes a connection, the crate never touches a pool.
- **Hooks/validation are `async fn` taking `&mut SqliteConnection`.** Native async-in-trait works
  because models are concrete. No `async-trait` (decision 2: no `dyn Model`).
- No `block_on` inside the library; the consuming app owns the `tokio` runtime.

### Migrations

Port `Migrator` semantics rather than adopt `sqlx::migrate!`:

- Why: the existing 76 migration files use the `{version}_{name}.{up,down}.sql` convention and
  `schema_migrations`. `sqlx::migrate!` uses `_sqlx_migrations` and its own naming, which would not
  apply to existing database files and would silently fork the tracking table. A small port keeps
  DB files drop-in usable and preserves down/version/dump behavior exactly.
- API takes a connection: `Migrator::new(options).run(&mut conn).await`. The app acquires the
  connection and supplies `migrations_dir`, `schema_path`, `pwd`, `direction`, `version`, `dump`,
  `silent`.
- Reads `sqlite_master` for the schema dump; version parsed as `i64` (filenames are 14-digit
  timestamps).
- Migration CLI: a small `clap` executor (`--up`, `--down`, `--version/-v`, `--migrations-dir`,
  `--schema-path`, `--dump`, `--silent`, `--pwd`) or a hand-rolled parser to match current flags.

### Validation, redaction, change tracking

- **Validation**: `garde` 0.23 `#[derive(Validate)]` for field rules (required, length, email,
  ranges). DB-dependent rules (uniqueness, cross-column) stay in `validate_custom(&mut conn)`, which
  is async and queries the same connection. Map `garde` reports to `ValidationError { column,
  message }`. `valibot`'s `fallback` defaults become struct defaults / `Option`; the boolean→0/1
  concern is handled by the `bool` field mapping (decision 8).
- **Redaction**: `const REDACTED_COLUMNS` (or `#[redacted]` via the macro). Provides `to_json(redact)`,
  `persisted(conn, redact)`, `changes(conn, redact)`, and powers `redacted_columns_for(model_name)`.
- **Change tracking**: store a serialized snapshot (`serde_json::Value` of the persisted row) on the
  instance; `changes(conn)` diffs snapshot vs current; `tracked_changes()` (sync) records
  `[old, new]` pairs captured around `save`/`destroy`. No third-party diff crate needed.

## Implementation reference

This section pins down details the rest of the plan leaves to the reader. Where the README (the
contract) already fixes a shape, this section must match it; if they ever disagree, the README wins
and this section is corrected.

### Error type and `Result` alias

One public error enum `Error` (in `error.rs`) plus the alias:

```rust
pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("validation failed: {0:?}")]
    Validation(Vec<ValidationError>),
    #[error(transparent)]
    Sqlite(#[from] sqlx::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("migration error: {0}")]
    Migration(String),
    #[error("record error: {0}")]
    Record(String),
}
```

`ValidationError { column: String, message: String }` with `ValidationError::new(column, message)`.

### Persistence semantics

- **Insert vs update decision:** a record is "new" (INSERT) iff the primary-key field is `None`;
  otherwise it is an UPDATE keyed on `PRIMARY_KEY`. This is checked once at the top of
  `save_within_with_options`.
- **INSERT** writes every column in `COLUMNS` (including the PK column; `NULL` lets SQLite assign the
  rowid). After the insert, the PK field is set from `last_insert_rowid()`.
- **UPDATE** writes every column in `COLUMNS` except the PK, with `WHERE {PRIMARY_KEY} = ?`.
- **DELETE** (`destroy_*`) deletes by `WHERE {PRIMARY_KEY} = ?`; `after_destroy` runs after the DML,
  inside the same transaction.
- Column order everywhere is exactly the order of `COLUMNS`; `to_values()` returns values in the same
  order, and the builder must assert `to_values().len() == COLUMNS.len()` (a debug assertion or a
  `Result` error) to catch manual-impl mistakes.
- There is **no** implicit "save if dirty"; `save` always issues the DML. Downstream apps that want
  conditional saves check `changed(conn)` first.

### Timestamps (`set_timestamps`)

Called inside `save_within_with_options` after the before-hooks and before the DML, mirroring the TS
behavior. The columns and the representation come from `Model::TIMESTAMPS` (`Timestamps`), which every
model may override; the default is `Timestamps::ISO8601`.

- `Timestamps { created, updated, format }`. `created`/`updated` are column names (`None` disables
  that side); `format` is `Iso8601` or `EpochMillis`.
- Creation column: set only when the record is new **and** the field is unset —
  `NULL`/`None` for both formats, `""` for ISO-8601 text, `0` for epoch milliseconds.
- Update column: set unless `skip_updated_at` is `true` (`skip_updated_at` is ignored for inserts:
  the update timestamp is always set on insert).
- Both columns receive **one** clock reading (`SystemTime` → epoch millis), so a new record has
  `created == updated` exactly.
- `Iso8601` renders the same `chrono`-free `YYYY-MM-DDTHH:MM:SS.mmmZ` text as before; `EpochMillis`
  binds the raw `i64`. No date crate is pulled in, and integer timestamps still need none.
- A configured column that is not in `COLUMNS` is left alone at runtime. The derive rejects columns
  the model author named that are not persisted (or whose Rust type does not match the format); the
  implicit default is permissive so models with no timestamp columns need no attribute.
- `#[model(timestamps = "iso8601" | "epoch_millis" | "none")]` and
  `#[model(timestamps(created = "...", updated = "...", format = "..."))]` generate the constant.
- `set_column` is the assignment hook: the derive implements it for `String`/`Option<String>` columns
  and for configured `i64`/`Option<i64>` timestamp columns; hand-written models implement it for
  their timestamp columns. A debug assertion catches a hand-written no-op.

### Query builder conventions

- **Fallibility.** Structured steps that validate developer-supplied identifiers or placeholder arity
  return `Result<Self>` (`where_*`, `where_in`, `where_not_in`, `where_raw`, `order_by`, `order_by_raw`,
  `join`, `fuzzy_search`). Value-only/no-validation steps are infallible (`select`, `select_clear`,
  `limit`, `offset`). An `order_by` column is validated against `COLUMNS`; raw variants
  (`where_raw`, `order_by_raw`, `select`, `join`) skip identifier validation by design.
- **Operator set.** `where_eq` (`=`), `where_ne` (`!=`), `where_gt` (`>`), `where_gte` (`>=`),
  `where_lt` (`<`), `where_lte` (`<=`). Each contributes one `col op ?` condition AND-ed with the
  rest. `WHERE` conditions and joins accumulate in call order.
- **Param ordering.** SQL placeholder order is: join params (in join call order), then `WHERE`
  params (in condition call order), then nothing else (LIMIT/OFFSET are inlined integers, never
  bound). `to_sql()` returns `GeneratedSql { sql: String, params: Vec<SqlValue> }` in exactly that
  order, so terminals can execute without re-ordering.
- **`select` defaults to `["*"]`**, `select(fragment)` appends, `select_clear()` empties. Consuming a
  query with an empty select list is an error (`Error::Record`), matching the TS throw.
- **`fuzzy_search`** splits `terms` on whitespace; each term becomes a parenthesized
  `(col LIKE ? OR ...)` group AND-ed with the others; a column entry containing `?` is treated as a
  raw fragment and gets one bound pattern per `?` (this supports the TS subquery-column case). Blank
  `terms` is a no-op; zero columns is an error.
- **`count()`** generates `SELECT COUNT(*) ...` with the same joins/conditions (no order/limit), and
  returns `i64`.
- **Terminal methods** consume the builder and take a connection: `all`, `first` (adds `LIMIT 1`),
  `count`, `fetch` (stream), `all_raw`, `fetch_raw`. `to_sql()` builds without executing.
- **`each`/`each_raw`** from the TS API map to the `fetch`/`fetch_raw` streams; the crate does not
  provide a separate iterator abstraction (a stream is the idiomatic Rust equivalent and is what the
  README documents).

### `SqlValue` and raw rows

`SqlValue` is a small owned enum mirroring SQLite storage classes, used for bind params and raw rows:

```rust
#[derive(Debug, Clone, PartialEq)]
pub enum SqlValue { Null, Integer(i64), Real(f64), Text(String), Blob(Vec<u8>) }

impl SqlValue {
    pub fn as_str(&self) -> Option<&str> { /* ... */ }
    pub fn as_i64(&self) -> Option<i64> { /* ... */ }
    pub fn as_f64(&self) -> Option<f64> { /* ... */ }
    pub fn as_bool(&self) -> Option<bool> { /* Integer != 0 */ }
    // From<i64>/From<i32>/From<String>/From<&str>/From<bool>/From<f64>/From<Option<T>> ...
}
```

`all_raw`/`fetch_raw` return `HashMap<String, SqlValue>` (column name → value). The `Model::to_values`
manual impls in the README use `.into()` to build `SqlValue`s.

### String-literal convenience (`&str` params) and serde

Two ergonomic conveniences affect signatures and must be honored:

- **`&str`-friendly params.** Rust has no string-literal → `String` coercion. So builder methods that
  take one string take `impl Into<String>` (e.g. `where_eq(column, value)` where `column:
  impl Into<String>`), and value params accept `impl Into<SqlValue>` / `&[impl Into<SqlValue>]`. This
  is what lets the README write `.where_eq("artist_id", 1)` without `.to_string()` or `.into()` at
  every call. `check_uniqueness(conn, "title", &song.title)` similarly takes `column: impl Into<String>`
  and `value: impl Into<SqlValue>`.
- **`to_json(redact)` / `TrackedChanges::to_json(redact)`** depend on `serde`. The derive-generated
  models should implement `serde::Serialize` (the derive macro can add it, or models derive it
  themselves). This is a **new dependency on models** vs the TS API (which got JSON for free); flag it
  as a deliberate consequence. The core crate already depends on `serde`/`serde_json` (decision
  4/change tracking), so this adds no new crate, only a derive requirement on models.

### Validation details

- `validate` is a **provided method on `ModelHooks`** (it needs `self`, `validate_custom`, and the
  `garde` rules that live on the model struct). Signature:
  `async fn validate(&self, conn: &mut SqliteConnection) -> Result<Vec<ValidationError>>`.
  The README shows it called on an instance (`song.validate(&mut conn).await?`), which resolves to
  this `ModelHooks` method.
- `validate(conn)` = declarative rules (via `garde::Validate`, if the model derives it) **plus**
  `validate_custom(conn)`; it returns `Vec<ValidationError>` (empty = valid) and does **not** throw on
  invalid records.
- `save_within_with_options` calls **`validate_custom` only** (not full `validate`), matching the TS
  `save` behavior; a non-empty result aborts the save with `Error::Validation(errors)`. Field-level
  `garde` rules are expected to be run by the caller (`validate`) before `save`, mirroring the TS
  controller flow.
- Declarative rules are optional: a model need not derive `garde::Validate`. When it does,
  `validate` must collect `garde`'s report; mapping the report to `ValidationError { column, message }`
  is the derive macro's job (it can emit a `validate_fields()` helper called by the default
  `validate`). When `garde` is not derived, `validate` reduces to `validate_custom`.

### Redaction and change tracking details

- `REDACTED_COLUMNS` is the field order declaration order of `#[redacted]` fields. `redact` replaces
  present redacted columns with the literal `"[redacted]"`.
- `to_json(redact)`, `persisted(conn, redact)`, `changes(conn, redact)` are the redaction-aware
  methods. `persisted` returns the current DB row (or `None` for a new record) as a value map;
  `changes` diffs persisted vs current.
- `tracked_changes()` is **sync** and returns `Option<Changes>`; `Changes` holds
  `{ column, before: Option<SqlValue>, after: Option<SqlValue> }` entries, iterable, with
  `to_json(redact)`. It is populated only when the write used `SaveOptions { track_changes: true }`.
  Insert → every column `[None, Some]`; update → changed columns `[Some, Some]`; destroy with the flag
  → `[Some, None]`.
- The internal persisted snapshot for `changes()` is captured via `to_json(false)` before mutation and
  compared per column; no external diff crate.

### `Migrator` options

```rust
pub struct MigratorOptions {
    pub pwd: PathBuf,                  // base for resolving relative paths
    pub migrations_dir: PathBuf,       // relative to pwd
    pub schema_path: Option<PathBuf>,  // relative to pwd; required only when dump = true
    pub direction: MigrationDirection, // Up | Down
    pub version: Option<i64>,          // target; None = latest (up) / one step (down)
    pub dump: bool,
    pub silent: bool,
}
```

Behavior mirrors `components/database/src/Migrator.ts` exactly (filename regex, `schema_migrations`
table, version-0 rejection, `sqlite_master` dump). The port should be validated by running it against
the existing 76 migration files and comparing the resulting schema dump.

### Build/config conventions (match `api-rescuer`)

- `edition = "2024"`; `rust-version = "1.94"` in the core crate.
- `.gitignore` contains `target/`.
- `Cargo.lock` is committed.
- `cargo clippy -- -D warnings` is the lint gate; `cargo test` is the test command (standalone Rust
  tests, **not** the Bun test runner).
- The crate is not a Bun workspace and is not referenced from the root `package.json`.

### Testing strategy

Tests follow the repo's Rust convention (see `api-rescuer/src/*.rs`): an inline `#[cfg(test)] mod
tests { use super::*; ... }` at the bottom of each source file. `#[cfg(test)]` guarantees the test
code is compiled out of production/release binaries — no test helpers, fixtures, or in-memory
connections leak into shipped code.

**Two layers, split by whether a database is needed:**

1. **SQL-assembly tests (no connection at all).** The query builder is almost fully testable by
   calling `to_sql()` and asserting the generated `sql` string and `params` vector. Cover, per
   builder method: clause text, condition/join accumulation order, placeholder count and ordering
   (join params before where params, regardless of call order), `select`/`select_clear` behavior
   (including the empty-select error), `fuzzy_search` term splitting and raw-fragment placeholder
   expansion, identifier validation errors, and the `where_*` operator mapping. These tests live in
   `query.rs` and need zero setup — no `SqliteConnection`, no runtime. This is the bulk of the
   behavior-parity coverage ported from `ApplicationRecordQuery.test.ts` (its `.toSQL()` cases map
   one-to-one).
2. **Terminal/DB tests (in-memory connection).** Terminal methods (`all`, `first`, `count`, `fetch`,
   `all_raw`, `fetch_raw`), CRUD, hooks, timestamps, validation, redaction, change tracking, and
   migrations need a real connection. Use **`sqlite::memory:`** so no file is touched and each test
   is isolated. A test connects via `SqlitePool`/`SqliteConnection`, runs `CREATE TABLE ...` DDL
   inline (or the app repo's migration fixture), and exercises the behavior. These live in
   `model.rs`, `changes.rs`, etc.

**Shared test support.** A `#[cfg(test)] pub(crate) mod test_support` (the `api-rescuer` pattern)
holds helpers reused across modules: opening an in-memory `SqliteConnection`, a sample `Song` model
(hand-written `impl Model` so the core tests do not depend on the derive crate), and small
row/DDL fixtures. It is `#[cfg(test)]`-gated so it never reaches production builds.

**Async tests.** Terminal/DB tests are `#[tokio::test]`. The tokio test macro/features are
**dev-dependencies only**, so they are not pulled into the production dependency graph. SQLite tests
must use the **multi-threaded** test runtime (`#[tokio::test(flavor = "multi_thread")]`) because the
sqlx SQLite driver opens its worker thread via `spawn_blocking`; the default single-threaded test
runtime panics (this is a known sqlx behavior, see the sqlx issue on `sqlite` + `current_thread`).

**Parity mapping.** Port the TS specs deliberately, not just the happy paths:
`ApplicationRecordQuery.test.ts` → `to_sql()` tests in `query.rs` plus terminal tests in `model.rs`;
`ApplicationRecord.test.ts` → `model.rs` / `changes.rs`; `BunSqliteDatabase.test.ts` → app-side (the
crate has no pool/database type; nothing to port); `Migrator.test.ts` → `migrations/mod.rs`.
Behavior differences that are intentional (e.g. async + `Result`, `bool` columns) are asserted in
their new shape rather than mimicking the TS return values.

**What not to test in the crate.** Pool configuration, PRAGMAs, WAL, idle timeout, and backup are
app-owned (decision 7), so their tests belong to the consuming app, not this crate.

### Definition of done (per phase)

- Compiles with `cargo build` and `cargo clippy -- -D warnings` clean.
- `cargo test` green, including a behavior-parity test that mirrors the relevant
  `components/database/src/*.test.ts` cases.
- A host app can compile an example model against the public API exactly as shown in `README-RUST.md`
  (the README examples should be compiled as doctests where practical).
- No `unsafe` outside the optional derive's generated-safe code (i.e. none at all by design).

## Ergonomics comparison: Bun/TypeScript vs Rust

| Dimension | Bun / average-record (TS) | Rust crate (proposed) | Verdict |
| --- | --- | --- | --- |
| Model definition | `class User extends ApplicationRecord` + static `schema`/`tableName`; fields declared twice | `struct User` + `#[derive(Model)]` (or manual `impl Model`) | Rust is more boilerplate upfront, but compile-time checked and no double declaration |
| Schema/type source of truth | Valibot schema drives both validation and TS types | Struct fields are the type; validation is a derive | TS has single source; Rust needs two annotations (acceptable) |
| Defaults/transforms | `v.fallback`, `v.transform(Number)` | struct defaults, `Option`, `bool` mapping | Rust removes the boolean/0-1 hack entirely |
| DB handle | `static database` on each subclass | caller-provided connection / transaction | Rust loses global convenience; gains explicit connection affinity and testability |
| Write API | `save()`, `destroy()` (sync) | `save(conn)`, `save_with_options(conn, opts)`, `save_within(tx)`, `destroy(...)` equivalents | Rust explicit about transaction ownership and options |
| Query builder | fluent, sync, returns arrays/iterables | fluent; build without a connect; terminals take a connection | Similar ergonomics; Rust adds `?`/`.await` |
| Async | synchronous (blocks event loop) | fully async at API boundary | Rust strictly better for concurrency |
| Error handling | `throw` + `T \| null` for misses | `Result<T, E>` + `Result<Option<T>, E>` | Rust safer, noisier |
| Dynamic projections | native (objects are bags) | typed optional fields per struct | Comparable, slightly more maintenance in Rust |
| Model registry / polymorphism | `Record<string, typeof Model>` | static `match` over model names (only redaction needs it) | Effectively equivalent here |
| Lifecycle hooks | override + `super` | trait default methods, `async`, same transaction | Comparable; Rust adds rollback + connection consistency |
| Redaction | schema metadata | field attribute / const list | Comparable |
| Change tracking | `deep-object-diff` on objects | snapshot + typed/`serde_json` diff | Comparable |
| Migrations | custom `Migrator` + CLI | ported custom `Migrator` (connection-based) + `clap` | Equivalent |
| Compile-time safety | none for columns/SQL | compile-checked `query!` optional; runtime builder used by design | Rust better where applicable, but dynamic queries stay runtime-checked |
| Build/tooling | Bun, instant | Cargo, slower builds, larger dep graph | Bun clearly better DX |

Net: Rust wins on safety, concurrency, and performance; TS wins on dynamic flexibility, model
polymorphism, and iteration speed. The connection-based API adds explicit plumbing but buys the
consistency guarantees the Bun/`bun:sqlite` single-connection world had implicitly.

## Feasibility by capability

| Capability | Difficulty | Notes |
| --- | --- | --- |
| Connection-based execution | Easy | `&mut SqliteConnection` throughout; `Transaction` derefs so `&mut *tx` works |
| CRUD + timestamps + PK handling | Easy/Moderate | Async + `Result`; row/struct mapping; bool column mapping |
| Transactional writes with `save`/`save_with_options`/`save_within` | Moderate | `conn.begin()` wrapper + caller-managed variant; nested begin → SAVEPOINT |
| Query builder (where/in/notIn/raw/order/limit/offset/select/join) | Moderate | `sqlx::QueryBuilder` does the heavy lifting; port param ordering rules |
| Streaming (`each`, `eachRaw`) | Moderate | sqlx streams; stream borrows the connection |
| Typed virtual projections | Moderate | Add `Option<T>` fields per custom column; `all_raw()` escape hatch |
| Validation (schema + custom) | Moderate | `garde` + async custom taking a connection; map error shape |
| Uniqueness checks | Easy | Ported SQL on the same connection |
| Redaction | Easy | const list or derive attribute |
| Change tracking | Moderate | Snapshot serialization + diff; watch redaction interaction |
| Migrations + CLI + schema dump | Moderate | Straight port; filesystem + `sqlite_master`; connection-based |
| Derive macro | Moderate | `syn`/`quote`; opt-in, safe codegen only, no unsafe |

**Overall: feasible.** Connection-based execution and dropping the pool/PRAGMA helpers *reduce*
crate scope (no `Database` lifecycle to own). The derive macro and typed virtual projections are the
only notably fiddly parts, and both have clear escape hatches (manual `impl Model`; `all_raw()`).

Rough effort (single developer, familiar with Rust): MVP ~1.5–2.5 weeks; full parity including
derive macro, streaming, validation, change tracking, transactions, and tests ~4–6 weeks. Much of
the schedule is tests (the TS component has ~1.5k lines of behavior specs to mirror).

## Phased plan

Each phase lands with its tests (see Testing strategy): `#[cfg(test)]` inline modules, `to_sql()`
assertions needing no database where possible, and `sqlite::memory:` + `#[tokio::test(flavor =
"multi_thread")]` for terminal/DB behavior.

1. **Phase 0 — spike.** Point `sqlx` 0.9 at a copy of an existing SQLite DB file via an app-owned
   pool; verify connection-based async queries, `bool` column mapping, `VACUUM INTO`, and the custom
   migrator against the real `schema_migrations` layout. Confirm the multi-threaded test-runtime
   requirement and the in-memory test setup.
2. **Phase 1 — core.** `Model` trait + `ModelHooks` trait + `save(conn)`/`save_with_options(conn, opts)`/
   `save_within(tx)`/`save_within_with_options(tx, opts)` (and `destroy` equivalents) +
   `find`/`all`/`first`/`count` + timestamps + hooks. Implement one model by hand (no macro) and add
   the in-memory `test_support` helper. Port the relevant `ApplicationRecord.test.ts` cases.
3. **Phase 2 — query builder.** Full clause set incl. `fuzzy_search`, raw joins, select/clear, param
   ordering, `to_sql`, streaming, all/raw variants, typed virtual projections. Bulk of tests are
   connection-free `to_sql()` assertions ported from `ApplicationRecordQuery.test.ts`; terminal
   behavior tested against `sqlite::memory:`.
4. **Phase 3 — validation, redaction, change tracking.** `garde` integration, error mapping,
   snapshots/diff, redacted variants, `redacted_columns_for`.
5. **Phase 4 — migrations.** Migrator port + CLI + schema dump; run against the 76 existing
   migration files; connection-based, app-owned paths. Port `Migrator.test.ts` against in-memory DBs.
6. **Phase 5 — ergonomics.** `#[derive(Model)]` macro, `#[redacted]`, `#[model(virtual)]`. Add a
   compile-test that a derived model behaves identically to the hand-written one from Phase 1.
7. **Phase 6 — hardening.** Benchmarks vs the Bun implementation, docs, `cargo clippy -D warnings`,
   CI wiring (standalone `cargo test`, not the Bun test runner).

## Write API summary (resolved)

- `track_changes` is opt-in via `SaveOptions`, which carries behavior flags only and is accepted
  only by the `*_with_options` variants.
- `save(conn)`, `save_with_options(conn, opts)`, `save_within(tx)`, `save_within_with_options(tx, opts)`
  and their `destroy` equivalents are all public on `Model`, each taking an explicit
  connection/transaction.
- Phase 0 only needs to validate real-data `bool` decoding and classify any small-integer column as
  an enum/status/count vs a true flag.

## Dependencies

Recommended after weighing performance, maintenance health, and industry adoption. Versions and
health verified against crates.io/docs.rs as of October 2026.

### Primary stack (recommended)

| Crate | Version | Health / adoption | Purpose & rationale |
| --- | --- | --- | --- |
| `sqlx` | `0.9.0` | Very high; LaunchBadge; ~157M downloads; released 2026-05-21; active | Async SQL toolkit. `features = ["runtime-tokio", "sqlite", "json"]`, `default-features = false`. SQLite driver runs on a dedicated worker thread + channels, streams rows, and maps `bool` ↔ `INTEGER`. Execution is connection-based; the app owns the pool. `QueryBuilder` builds dynamic SQL with safe binds. Requires **Rust 1.94.0**; satisfied by `.tool-versions` pin 1.99.0. |
| `tokio` | `1` | Industry standard; ubiquitous | Async runtime. `features = ["rt", "sync", "time"]`; app adds `macros`/`rt-multi-thread` as needed. |
| `serde` + `serde_json` | `1` / `1` | dtolnay ecosystem; ~1B+ downloads; active | JSON column round-tripping, change-tracking snapshots, `SqlValue` helpers. |
| `garde` | `0.23` | Active (v0.23 2026-05-23); ~4.7M downloads; maintained rewrite of `validator` | Field validation via `#[derive(Validate)]`; integrate with the async `validate_custom(&mut conn)` hook. Alternative: `validator`. |
| `thiserror` | `2` | dtolnay; ~1.5B downloads; active | Typed library errors (`Error` enum) with `#[from]` for `sqlx::Error`, IO, etc. Library crates should not force `anyhow`. |
| `tracing` | `0.1` | Tokio project; industry standard | Replaces `TaggedLogger`; matches `api-rescuer`. Consumer installs `tracing-subscriber`. |
| `clap` | `4` | clap-rs; ubiquitous | Migration CLI when the `cli` feature is enabled. Optional — drop for a hand-rolled parser if footprint matters. |

Optional ergonomics layer (compile-time only, no runtime deps, no unsafe output):

| Crate | Version | Health | Purpose |
| --- | --- | --- | --- |
| `average-record-derive` (local proc-macro) using `syn` `2`, `quote` `1`, `proc-macro2` `1` | — | All dtolnay/community, ubiquitous | `#[derive(Model)]`, `#[model(table = ...)]`, `#[model(virtual)]`, `#[redacted]` — eliminates per-model trait boilerplate. Feature-gated so the core crate stays macro-free. |

Dev-dependencies: `tokio` with the `macros` + `rt-multi-thread` features (for `#[tokio::test(flavor = "multi_thread")]`), and `tempfile` 3 (migration tests that need a real file). Both are dev-only and never reach production builds.

### Alternative minimal-footprint stack

For a low-RAM consumer in the spirit of `api-rescuer`, swap the driver:

| Crate | Version | Health | Trade-off |
| --- | --- | --- | --- |
| `rusqlite` | `0.40` with `bundled` | Very high; ~117M downloads; active; bundles SQLite 3.53.2 | Synchronous, minimal, battle-tested. No async. |
| `tokio-rusqlite` | `0.8` | Active (2026-09-06); `#![forbid(unsafe_code)]` | Async facade over `rusqlite` on a dedicated thread. It is itself connection-oriented (`Connection::call`), which fits the connection-based model well. Streaming is manual (collect in closure). `bool` maps to SQLite's 0/1. |

This avoids `sqlx`'s larger dependency tree and build times, at the cost of less ergonomic streaming,
no `QueryBuilder`, and no compile-time query checking. Migrations would use the same custom port.

### Explicitly rejected

| Rejected | Why |
| --- | --- |
| `sea-query` / `sea-orm` | Full AST/ORM layer is heavier and more opinionated than needed; the component is raw-SQL-centric (arbitrary joins, subqueries, `LIKE` groups). `sea-query` 1.0 is healthy and could serve as a structured AST later if desired, but is not required. |
| `diesel` / `diesel-async` | Sync-first DSL; compile-time schema coupling; awkward for fully dynamic/runtime-built queries with raw fragments. |
| `libsql` | Turso fork adds surface area and a non-standard distribution with no benefit for plain SQLite. |
| `refinery` | Solid migration tool, but adopting it forks the tracking table away from `schema_migrations` and the existing 76 files; the custom port is small and preserves parity. |
| `async-trait` | Not needed: decision 2 confirms no `dyn Model`; native async-in-trait covers concrete models without a boxed future per call. |
| `chrono` / `time` | Timestamps are stored and compared as ISO-8601 strings (as today); `std` + `serde_json` cover it unless typed date support is later required. |
| `deep-object-diff` equivalent | Change tracking is a per-column comparison of a stored snapshot; no diff crate needed. |

### Toolchain note

`.tool-versions` now pins `rust 1.99.0` (2026-10-01), satisfying `sqlx` 0.9.0's MSRV of 1.94.0.
(If a toolchain bump were undesirable, pin `sqlx` `0.8.6` instead; it works on 1.93 and the rest of
the plan is unchanged.)
