# Plan: make primary keys non-optional (`id: i64`, `0` = new)

## Date Created

2026-11-01

## Status

Implemented. The Rust crate, derive macro, tests, Bun parity, and docs match this plan; downstream
consumers (e.g. `dps-backend`) pin the resulting `0.2.0` tag.

## Goal

Replace the `Option<i64>` primary-key contract with a non-optional `i64` contract in which **`0` always means
"new record"**. This is a deliberate, documented library contract, not an opt-in attribute. `Option<i64>` primary
keys are removed entirely, so there is exactly one way to express a model.

Why: `Option` forces every consumer to carry `None` checks through response/DTO boundaries, and the alternative
(sentinel flags or per-model hand-written impls) adds surface for the same outcome. `0` is never a valid stored
key: SQLite auto-assigned rowids start at 1, and the library itself must never write `0` — it always INSERTs
when the PK is `0`, and those INSERTs omit the PK column so the database assigns it.

## Scope

### In scope

- `rust/average-record/src/model.rs` — trait contract, defaults, writes/reads.
- `rust/average-record/src/changes.rs` — tracked-changes registry key.
- `rust/average-record/src/test_support.rs` — hand-written test models.
- `rust/average-record-derive/src/lib.rs` — derive codegen + validation.
- `rust/average-record/tests/derive.rs`, `rust/average-record/tests/manual.rs`.
- `rust/README.md`, `dev/average-record-rust.md`, `dev/parity-comparison.md`.
- `bun/src/ApplicationRecord.ts`, `bun/src/ApplicationRecord.test.ts`, `bun/README.md` (parity).
- Root `README.md` if it documents the PK shape.

### Out of scope

- Any downstream application changes (`dps-backend` has its own plan).
- Host schemas/migrations. The library documents the obligation; hosts enforce it.
- New attributes. No `zero_means_new` flag: the contract applies to every model.

## Current state (what exists today)

- `Model::PRIMARY_KEY: &'static str = "id"`.
- `Model::primary_key_value(&self) -> Option<i64>`; the default reads the PK column from `to_values()`.
- `Model::is_new(&self) -> bool { self.primary_key_value().is_none() }`.
- `Model::set_primary_key(&mut self, id: i64)` defaults to `set_column(PRIMARY_KEY, Integer(id))`.
- `#[derive(Model)]` hard-codes `Option<i64>`: it requires the PK field to be `Option<i64>`, generates
  `fn primary_key_value(&self) -> Option<i64> { self.id }` and `self.id = Some(id)`.
- `changes.rs` keys the tracked-changes registry by `(TypeId, Option<i64>)`.
- Bun uses `record[pk] == null` as its `isNew` check (`bun/src/ApplicationRecord.ts`).
- Both implementations INSERT **every** column, primary key included. Today the PK is `None`/`null`, which
  binds as `NULL`, so SQLite assigns the rowid. With `0` the PK would bind as a literal `0`, which SQLite
  accepts as an explicit rowid: the row is stored as `0` and `last_insert_rowid()` returns `0`, so the record
  never becomes persisted. Insert paths must therefore omit the PK column (see below).

## Target contract (public API)

```rust
pub trait Model: Sized + Send + 'static {
    const TABLE_NAME: &'static str;
    const PRIMARY_KEY: &'static str = "id";
    const COLUMNS: &'static [&'static str];
    const REDACTED_COLUMNS: &'static [&'static str] = &[];

    fn from_row(row: &sqlite::SqliteRow) -> Result<Self>;
    fn to_values(&self) -> Vec<SqlValue>;

    /// Returns the primary-key value, or `0` for an unsaved record.
    fn primary_key_value(&self) -> i64 {
        Self::COLUMNS
            .iter()
            .position(|column| *column == Self::PRIMARY_KEY)
            .and_then(|index| self.to_values().into_iter().nth(index))
            .and_then(|value| value.as_i64())
            .unwrap_or(0)
    }

    /// Returns `true` when the record has not been persisted yet.
    fn is_new(&self) -> bool {
        self.primary_key_value() == 0
    }

    /// Sets the primary-key value (called after an `INSERT`).
    ///
    /// No default: hand-written models must assign their own field so id assignment
    /// can never silently no-op.
    fn set_primary_key(&mut self, id: i64);
    // ...
}
```

Behavioral guarantees after this change:

| Operation | Result for a record with `id == 0` |
|---|---|
| `save(conn)` | INSERT; `last_insert_rowid()` assigned to the field |
| `persisted(conn, _)` | `Ok(None)` (no query issued) |
| `changes(conn, _)` / `changed(conn)` | empty / `false` |
| `check_uniqueness*` | no `AND pk != ?` self-exclusion clause |
| `destroy(conn)` | `Err(Error::Record("cannot destroy an unsaved record"))` |
| `find(conn, 0)` | `Ok(None)` (short-circuit, no query) |

Neither implementation ever sends a literal primary key on `INSERT`: the PK column is omitted from the
statement so SQLite assigns the rowid. The library therefore never writes `0`. A `0` row can only appear
through an out-of-band write that bypasses the library, and that is the host's problem, not the library's —
for such a row the library consistently behaves as "unsaved" (see the table).

## Implementation

### 1. `rust/average-record/src/model.rs`

**Trait: `primary_key_value`**

```rust
// before
fn primary_key_value(&self) -> Option<i64> {
    let index = Self::COLUMNS
        .iter()
        .position(|column| *column == Self::PRIMARY_KEY)?;
    self.to_values()
        .into_iter()
        .nth(index)
        .and_then(|value| value.as_i64())
}

// after
fn primary_key_value(&self) -> i64 {
    Self::COLUMNS
        .iter()
        .position(|column| *column == Self::PRIMARY_KEY)
        .and_then(|index| self.to_values().into_iter().nth(index))
        .and_then(|value| value.as_i64())
        .unwrap_or(0)
}
```

**Trait: `set_primary_key` becomes required**

Delete the default body (and its `set_column` fallback) and update the doc comment:

```rust
fn set_primary_key(&mut self, id: i64);
```

**Trait: `is_new`**

```rust
fn is_new(&self) -> bool {
    self.primary_key_value() == 0
}
```

**Trait: `find`** — short-circuit before querying:

```rust
async fn find(conn: &mut SqliteConnection, id: i64) -> Result<Option<Self>> {
    if id == 0 {
        return Ok(None);
    }
    Self::query().where_eq(Self::PRIMARY_KEY, id)?.first(conn).await
}
```

**`persisted`**

```rust
async fn persisted(&self, conn: &mut SqliteConnection, redact: bool) -> Result<Option<ValueMap>> {
    if self.is_new() {
        return Ok(None);
    }
    let id = self.primary_key_value();
    // ... existing SELECT ... WHERE pk = ? ...
}
```

**`check_uniqueness` and `check_uniqueness_raw`**

Replace `if let Some(id) = self.primary_key_value()` with:

```rust
if !self.is_new() {
    sql.push_str(&format!(" AND {} != ?", Self::PRIMARY_KEY));
    params.push(SqlValue::Integer(self.primary_key_value()));
}
```

**`tracked_changes`**

```rust
load_tracked(TypeId::of::<Self>(), self.primary_key_value())
```

**`save_within_with_options`**

- `let is_new = self.is_new();` stays.
- INSERT branch: **omit the PK column (and its value)** so SQLite assigns the rowid. Sending the
  `0` would persist `id = 0` and `last_insert_rowid()` would return `0`:

```rust
if is_new {
    // Never write `0`: omit the primary-key column so SQLite assigns the rowid.
    let mut columns: Vec<&str> = Self::COLUMNS.to_vec();
    let mut insert_values = values;
    if let Some(index) = columns.iter().position(|column| *column == Self::PRIMARY_KEY) {
        columns.remove(index);
        insert_values.remove(index);
    }
    let placeholders = vec!["?"; columns.len()].join(", ");
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({})",
        Self::TABLE_NAME,
        columns.join(", "),
        placeholders
    );
    let mut query = sqlx::query::<Sqlite>(AssertSqlSafe(sql));
    for value in insert_values {
        query = query.bind(value);
    }
    let result = query.execute(&mut **tx).await?;
    self.set_primary_key(result.last_insert_rowid());
}
```

  The `to_values()` length check stays where it is (it runs before the branch and still validates against
  the full `COLUMNS`), so only the statement-build changes.

- UPDATE branch: drop the fallible lookup:

```rust
// before
let id = self.primary_key_value()
    .ok_or_else(|| Error::Record("missing primary key for update".to_string()))?;
// after
let id = self.primary_key_value();
```

- `store_tracked(..., self.primary_key_value(), changes)` — now `i64`.

**`destroy_within_with_options`**

```rust
// before
let id = self.primary_key_value().ok_or_else(|| {
    Error::Record("cannot destroy a record without a primary key".to_string())
})?;
// after
if self.is_new() {
    return Err(Error::Record(
        "cannot destroy an unsaved record".to_string(),
    ));
}
let id = self.primary_key_value();
```

**Docs in the file**

- `primary_key_value`: "Returns the primary-key value, or `0` for an unsaved record."
- `set_primary_key`: "Hand-written models must implement this; there is no `set_column` fallback."
- `set_column`: drop the "and for the primary key" clause; it now only serves automatic
  `created_at`/`updated_at`.
- `is_new`: "`true` when the primary key is `0`."

### 2. `rust/average-record/src/changes.rs`

Change the registry key from `Option<i64>` to `i64`:

```rust
// before
type TrackedKey = (TypeId, Option<i64>);
pub(crate) fn store_tracked(model: TypeId, id: Option<i64>, changes: Changes) { ... }
pub(crate) fn load_tracked(model: TypeId, id: Option<i64>) -> Option<Changes> { ... }

// after
type TrackedKey = (TypeId, i64);
pub(crate) fn store_tracked(model: TypeId, id: i64, changes: Changes) { ... }
pub(crate) fn load_tracked(model: TypeId, id: i64) -> Option<Changes> { ... }
```

Note in the module docs that `0` is never a persisted key: tracked changes for inserts are stored **after**
`set_primary_key`, so they land under the assigned id. Also update the destroy call site in `model.rs`
(`store_tracked(TypeId::of::<Self>(), Some(id), ...)` → `store_tracked(TypeId::of::<Self>(), id, ...)`).

### 3. `rust/average-record-derive/src/lib.rs`

**Type validation** — after selecting the primary field, reject anything that is not a plain `i64`:

```rust
fn is_i64(ty: &syn::Type) -> bool {
    matches!(
        ty,
        syn::Type::Path(path)
            if path.qself.is_none()
                && path.path.segments.last().is_some_and(|s| s.ident == "i64")
    )
}

if !is_i64(&primary.ty) {
    return Err(syn::Error::new_spanned(
        &primary.ident,
        "#[derive(Model)] primary key must be a plain `i64` (`0` means new); `Option<i64>` is no longer supported",
    ));
}
```

(`FieldInfo` already carries `ty: Type`, so validation can happen in `expand` before codegen.)

**Codegen** — replace the `Option` shape:

```rust
// before
fn primary_key_value(&self) -> ::std::option::Option<i64> {
    self.#primary_ident
}

fn set_primary_key(&mut self, id: i64) {
    self.#primary_ident = ::std::option::Option::Some(id);
}

// after
fn primary_key_value(&self) -> i64 {
    self.#primary_ident
}

fn set_primary_key(&mut self, id: i64) {
    self.#primary_ident = id;
}
```

No other macro changes: `COLUMNS`, `REDACTED_COLUMNS`, `from_row`, `to_values`, `set_column`, `Serialize`, and
`validate` are unaffected.

Compile-fail coverage: the repo has no `trybuild`. Either verify the error manually once (documented in the PR) or
add `trybuild` via `cargo add --dev trybuild` (ask the maintainer first; adding a dependency is a review point).

### 4. `rust/average-record/src/test_support.rs`

Update `TestModel`, `HookModel`, and `ValidatedModel`:

- fields: `pub id: i64` (they derive `Default`, so a new record is `id: 0`);
- `from_row`: `id: row.try_get("id")?` (for `ValidatedModel`, keep the tolerant
  `row.try_get("id").unwrap_or(0)`);
- `to_values`: `self.id.into()`;
- `primary_key_value`: `self.id` (or delete the override and rely on the default);
- `set_primary_key`: `self.id = id;`.

### 5. `rust/average-record/tests/derive.rs`

```rust
#[derive(Model, Validate, Debug, Clone, Default)]
#[model(table = "users")]
struct User {
    #[model(primary_key)]
    #[garde(skip)]
    id: i64,            // was Option<i64>
    // ... unchanged
}
```

Assertions:

```rust
let mut user = User { name: "Alice".to_string(), ..Default::default() };
assert_eq!(user.id, 0);
assert!(user.is_new());
user.save(&mut conn).await.unwrap();
assert_eq!(user.id, 1);
assert!(!user.is_new());

let found = User::find(&mut conn, user.id).await.unwrap().unwrap();
```

Add a test for the new contract:

```rust
#[tokio::test(flavor = "multi_thread")]
async fn zero_primary_key_is_treated_as_new() {
    let mut conn = connection().await;
    let mut user = User { id: 0, name: "Zero".to_string(), ..Default::default() };
    assert!(user.persisted(&mut conn, false).await.unwrap().is_none());
    user.save(&mut conn).await.unwrap();
    assert_eq!(user.id, 1);
    assert_eq!(User::count(&mut conn).await.unwrap(), 1);
    assert!(User::find(&mut conn, 0).await.unwrap().is_none());
}
```

`assert_eq!(user.id, 1)` plus `count == 1` also guards the INSERT path: binding a literal `0` would leave the
id at `0` and `find(0)` would then return that row, so the assertions fail loudly if the PK is not omitted.

Also add (or adapt) a `#[should_panic]`-free test that `destroy` on an unsaved record errors:

```rust
let mut unsaved = User { name: "x".to_string(), ..Default::default() };
let error = unsaved.destroy(&mut conn).await.unwrap_err();
assert!(matches!(error, average_record::Error::Record(_)));
```

### 6. `rust/average-record/tests/manual.rs`

Mirror the README's macro-free example:

- `pub id: i64`;
- add the now-required `set_primary_key`:

```rust
fn set_primary_key(&mut self, id: i64) {
    self.id = id;
}
```

- construct with `id: 0`; keep `assert!(user.is_new())`.

### 7. `rust/README.md`

Update every PK reference:

- Quick start: `id: i64`; `id: 0`; `user.save(&mut conn)`; no `.unwrap()` on ids.
- "The connection model": `User::find(&mut conn, user.id)`.
- Model attributes table: `#[model(primary_key)]` — "must be a plain `i64`; `0` means new".
- "Without the derive macro": `id: i64` + a `set_primary_key` impl.
- Add a short **Primary keys** section stating the contract, the guarantees table above, and that the
  library never writes `0` (INSERTs omit the PK column, so SQLite assigns the rowid). A `0` row can only
  arrive through an out-of-band write; that is outside the library's contract, and hosts that want to reject
  it can add `CHECK (id != 0)` as optional hardening.
- Any `Option<i64>`/`Some(1)`/`None` id snippets in CRUD, redaction, change-tracking, and uniqueness sections.
- Document the contract as-is: no mention of the previous `Option<i64>` shape and no breaking-change
  note (the library has no production users yet).

### 8. `bun/` parity

`bun/src/ApplicationRecord.ts`: introduce one predicate and use it everywhere `== null` currently means "new":

```ts
function isNewRecord(record: Record<string, unknown>, pk: string): boolean {
  return record[pk] == null || record[pk] === 0;
}
```

Replace in:

- constructor (`if (record[pk] == null) this.setTimestamps();`);
- `save()` (`const isNew = ...`);
- `setTimestamps()` (`const isNew = ...`);
- `persisted()` (`if (record[pk] == null) return null;`);
- `checkUniqueness()` and `checkUniquenessRaw()` (`if (record[pk] != null)` → `if (!isNewRecord(...))`);
- `destroy()` — currently runs `DELETE ... WHERE pk = ?` even for an unsaved record (a silent no-op). Mirror Rust:
  `if (isNewRecord(record, pk)) throw new Error("cannot destroy an unsaved record");`, and document the small
  behavior change.

`save()` INSERT branch: **omit the PK column and value** instead of reusing the full `columns`/`values`
arrays (which would write a literal `0` and leave `lastInsertRowid` at `0`):

```ts
if (isNew) {
  const insertColumns = columns.filter((col) => col !== pk);
  const insertValues = insertColumns.map((col) => parsed[col]);
  const placeholders = insertColumns.map(() => "?").join(", ");
  const sql = `INSERT INTO ${table} (${insertColumns.join(", ")}) VALUES (${placeholders})`;
  const result = Ctor.database.getDb().query(sql).run(...(insertValues as any[]));
  record[pk] = result.lastInsertRowid;
  // ...
}
```

The UPDATE branch keeps the full column list and binds `record[pk]` in the `WHERE`.

Tests (`bun/src/ApplicationRecord.test.ts`):

- add "a record with id 0 is inserted and receives a new id" — assert the returned id is `1`, no row with
  `id = 0` exists, and a second `save()` updates that row;
- add "`find(0)` returns null" if applicable;
- add "`destroy()` on an unsaved record throws" to mirror Rust;
- keep existing suites green (schemas already use `v.optional(v.number())`, so 0 is valid).

`bun/README.md`: document that `0`/absent/null all mean "new", and that INSERTs omit the primary-key column so
the database assigns it (the library never writes `0`). Note the contract.

`dev/parity-comparison.md`: add a note under the shared sections that both implementations treat `0` as new.

`dev/average-record-rust.md`: update the model snippets (`id: Option<i64>` → `id: i64`) or add a note that the
design doc predates the 0.2.0 contract.

### 9. Release

- Commit as `feat!: primary keys are non-optional (0 means new)` (or `feat:` + `BREAKING CHANGE:` footer).
- release-please cuts `0.2.0`; versions in `.release-please-manifest.json`, `package.json`, and
  `[workspace.package]` must agree (release-please handles this — do not hand-edit).
- Do not commit `Cargo.lock`; never pass `--locked`/`--frozen`.

## Task order (commit-sized)

1. `model.rs` + `changes.rs` trait/registry change (including the PK-omitting INSERT); fix compile errors in
   `test_support.rs`.
2. Derive validation + codegen.
3. `tests/derive.rs` + `tests/manual.rs` migrated and new contract tests.
4. `rust/README.md` + `dev/average-record-rust.md`.
5. Bun predicate + PK-omitting INSERT + tests + `bun/README.md` + parity doc.
6. Full verification, then release.

## Verification

From the repository root (per `AGENTS.md`):

```bash
cargo test --workspace --all-features
cargo clippy --fix --workspace --all-targets --all-features --allow-dirty
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo fmt --all
cargo fmt --all -- --check

bun test
bun check
bun fmt --check bun
```

## Acceptance criteria

- [ ] `Model::primary_key_value` returns `i64`; `is_new()` is `== 0`.
- [ ] `set_primary_key` has no default implementation.
- [ ] The derive rejects any PK type other than `i64` with a clear error.
- [ ] Insert assigns the rowid; a second `save` updates (no duplicate insert).
- [ ] Neither implementation sends a literal primary key on INSERT: the PK column is omitted, so the library
      cannot write `id = 0` and `last_insert_rowid()` is always the assigned id.
- [ ] `persisted`/`changes` are empty for `id == 0`; `find(0)` is `None`; `destroy` on `0` errors.
- [ ] `check_uniqueness*` skips the self-exclusion only when `is_new()`.
- [ ] Tracked changes are keyed by `i64` and land under the assigned id after insert.
- [ ] `tests/derive.rs`, `tests/manual.rs`, `test_support.rs` compile with `id: i64` (no `Option`).
- [ ] READMEs (root/rust/bun), `dev/average-record-rust.md`, and `dev/parity-comparison.md` describe the contract.
- [ ] Bun treats `null`/absent/`0` as new and the full Bun suite passes.
- [ ] `cargo clippy ... -D warnings`, `cargo fmt --check`, `bun check`, `bun fmt --check bun` are clean.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Existing consumers pin `0.1.0` and expect `Option` ids | Breaking `0.2.0`; downstream pins the new tag/rev. Only known consumer is `dps-backend` (pre-production). |
| A host schema contains a real row with `id = 0` | The library never writes `0` (INSERTs omit the PK), so such a row can only come from an out-of-band write and is out of scope. For it, `find(0)`/`save(0)`/`destroy(0)` behave deterministically as "unsaved". `CHECK (id != 0)` is optional host hardening. |
| Hand-written models forget `set_primary_key` | Making it required turns the bug into a compile error. |
| Bun and Rust diverge on "new" | Bun predicate accepts `null`/absent/`0`, so both agree that `0` is never persisted. |
| Compile-fail coverage for `Option` PKs | No `trybuild` today; verify manually or add it as a reviewed dev-dependency. |

## Out-of-scope follow-ups

- `#[model(json = "...")]` for typed JSON columns (needs `to_values -> Result`, separate decision).
- Composite/UUID primary keys (the contract stays integer-only).
