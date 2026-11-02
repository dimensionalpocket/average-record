# Parity analysis: Rust vs Bun implementations

Snapshot taken 2026-11-01, comparing `rust/README.md` against `bun/README.md`, with anything the
READMEs omit cross-checked against the source (`rust/average-record/src/`, `bun/src/`).

This is a **capability comparison**, not a behavioral one: it records which features each
implementation exposes, not how each behaves on edge cases (missing columns, `NULL` in non-optional
fields, malformed migrations). Nothing here is a decision record — no changes were made from it.

## Verdict

Neither implementation is a superset of the other.

- **Bun is ahead on the connection/database layer and query flexibility**: a pluggable `Database`
  abstraction, connection lifecycle helpers, backups, a generic operator-based `where()`, and a
  synchronous API.
- **Rust is ahead on transactions and SQL-safety validation**: caller-managed transactions,
  column-name and placeholder-arity validation, raw ordering, and typed projection fields.

## Only Bun supports

| Capability | Where |
| --- | --- |
| Pluggable backend via `abstract Database` (SQLite is one implementation) | `bun/src/Database.ts`, `bun/src/BunSqliteDatabase.ts` |
| Connection lifecycle: lazy connect on first query, `checkIdle()`, `close()` | `bun/src/BunSqliteDatabase.ts` |
| `backupToFile(path)` | `bun/src/BunSqliteDatabase.ts` |
| Arbitrary operators in one call: `where(column, "LIKE", value)` | `bun/src/ApplicationRecordQuery.ts` |
| Public `setTimestamps()` | `bun/src/ApplicationRecord.ts` |
| Synchronous (blocking) API — no `await` in the data path | all of `bun/src` |

Rust intentionally has no pool/connection layer: the host application owns the pool, PRAGMAs, and
data folder (README "Design principles", item 1). So the missing lifecycle helpers are a stated
design choice, except `backupToFile`, which has no Rust equivalent at any layer.

## Only Rust supports

| Capability | Where | Why it matters |
| --- | --- | --- |
| **Transactions**: `save_within(tx)`, `destroy_within(tx)`, `save_within_with_options`, plus a crate-owned transaction around each `save`. Hooks and custom validation run inside that transaction. | `rust/average-record/src/model.rs` | A multi-table write in Bun cannot be atomic, and a failing `afterSave()` cannot roll back an already-committed insert. No `BEGIN`/`COMMIT` exists anywhere in `bun/src`. |
| **Column-name validation**: `where_eq/ne/gt/gte/lt/lte`, `where_in`, `where_not_in`, `order_by` validate against `M::COLUMNS` (qualified names such as `s.score` allowed) | `rust/average-record/src/query.rs` | Typos return `Err` instead of producing broken SQL; Bun interpolates the string verbatim. |
| **Placeholder arity validation**: `where_raw` and `join` error when the `?` count differs from the parameter count | `rust/average-record/src/query.rs` | Bun silently accepts mismatched params. |
| `order_by_raw(expr, dir)` | `rust/average-record/src/query.rs` | Order by an alias or subquery; Bun only has `orderBy(column, dir)`. |
| **Virtual/projection fields** (`#[model(virtual)]`) | `rust/average-record/src/model.rs` | A projection (`s.score`) can hydrate a typed field and is excluded from `COLUMNS` and writes. Bun maps rows to instances by schema keys, so extra selected columns are dropped; only raw rows see them. |
| Typed error enum: `Error::{Validation, Sqlite, Io, Migration, Record}` returned from every API | `rust/average-record/src/error.rs` | Bun's `save()` throws raw Valibot errors; only `validate()` returns an array. |
| Models implemented without the derive macro | `rust/average-record/src/model.rs` | Macro-free escape hatch; Bun's class model is inherently manual. |

## Parity (no gap, despite surface differences)

CRUD and save/destroy options (`trackChanges`/`skipUpdatedAt` ≡ `track_changes`/`skip_updated_at`),
automatic timestamps (configurable per model: `Model::TIMESTAMPS` ≡ `static timestamps`, with an
ISO-8601 text default and an epoch-millisecond integer option in both), `find`/`first`/`all`/`count`, streaming (`each`/`eachRaw` ≡
`fetch`/`fetch_raw`), raw rows (`allRaw` ≡ `all_raw`), `select`/`selectClear`/`join`, fuzzy search
(raw SQL fragments with `?` patterns allowed as search columns in **both**), `IN`/`NOT IN`,
`limit`/`offset`, validation (Valibot vs garde) plus `validateCustom` and uniqueness checks
(including the raw-condition variant), redaction (schema metadata vs `#[redacted]`, applied in
`toJSON`/`persisted`/`changes`), before/after change capture including deletes, all six lifecycle
hooks, migrations (`up`/`down`/version/`dump`/`silent`/`pwd`/`schemaPath`, `schema_migrations`), and
the CLI flag set (`--dump`, `--down`, `-v`, `--help`).

Neither implementation wraps a migration in a transaction.

Both implementations share the primary-key contract (0.2.0 in Rust): `0` means "new". Neither ever
writes a literal `0` — inserts omit the primary-key column so the database assigns the rowid. Bun also
accepts `null`/absent as "new" because its schema types are optional; Rust has no such state. `destroy()`
on an unsaved record errors in both.

## Naming differences (not gaps)

| Concept | Rust | Bun |
| --- | --- | --- |
| Query entry | `Model::query()` | `Model.scope()` |
| Comparison helpers | `where_eq`, `where_gt`, … | `where(col, op, value)` |
| Redaction source | `#[redacted]` field attribute | `v.metadata({ redacted: true })` |
| Validation rules | `#[garde(...)]` | Valibot schema |
| Timestamp config | `Model::TIMESTAMPS` (`Timestamps` presets / derive attribute) | `static timestamps` (`Timestamps` presets) |

## If this is ever acted on

Ordered by user-visible impact, not effort:

1. Bun: add transaction support (`_within`-style methods or a `transaction(fn)` helper).
2. Rust: consider a generic `where(col, op, val)` alongside the typed helpers.
3. Decide whether Bun's `Database` abstraction is a model to port to Rust or a deliberate
   divergence (Rust currently states the opposite principle).

Cross-implementation behavior (not just surface) would need the parity-fixture approach discussed
during repository setup: language-neutral JSON cases consumed by both `rust/average-record/tests/`
and `bun/test/`.
