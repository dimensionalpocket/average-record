# Plan: epoch-millisecond timestamps (`created_ts` / `updated_ts`), configurable per model

## Date Created

2026-11-02

## Status

Implemented. The Rust crate, derive macro, tests, Bun parity, and docs match this plan.

Implementation notes (refinements made while implementing):

- The derive's column/type validation is `strict`: it runs for configurations the model author opted
  into (`timestamps = "epoch_millis"`, explicit `timestamps(...)`), but not for the implicit
  `created_at`/`updated_at` default. Otherwise every model without timestamp columns would fail to
  derive. A bare `timestamps(format = "...")` therefore falls back to that format's preset columns.
- `timestamp_now()` was removed instead of kept: once `set_timestamps` used the millisecond primitive,
  the only caller was its own test. `format_timestamp(millis)` is the public-in-crate primitive, and
  the ISO-8601 shape test exercises it directly.
- The debug assertion compares the value that was written against the value read back, so a no-op
  `set_column` on a `String` column that defaults to `""` is caught too.
- Bun exports `Timestamps` and the `TimestampConfig` type from the package root.

## Goal

Add a second, first-class timestamp flavor: **`created_ts` / `updated_ts` holding `i64` epoch
milliseconds** instead of ISO-8601 `TEXT`. The column names and the representation are **configured
per model**, not globally:

```rust
#[derive(Model, Default)]
#[model(table = "events", timestamps = "epoch_millis")]
pub struct Event {
    #[model(primary_key)]
    pub id: i64,
    pub name: String,
    pub created_ts: i64,   // epoch ms, 0 = unset
    pub updated_ts: i64,   // epoch ms
}
```

Why:

- Millisecond integers sort, compare, and index correctly as `INTEGER` in SQLite; ISO strings only
  sort correctly while the format stays fixed-width and UTC.
- They cross the JSON boundary as numbers (no parsing on the consumer side) and need no date crate in
  either implementation.
- The current hard-coded column names (`created_at`/`updated_at`) and type (`String`) prevent hosts
  whose schemas already use integer timestamps (or different column names) from using the feature at
  all. Making it a per-model setting removes that coupling without a second trait.

Non-goal: changing the existing string behavior. `created_at`/`updated_at` as ISO-8601 text remains
the default, so this is an additive `feat:` (0.4.0), not a breaking change.

## Scope

### In scope

- `rust/average-record/src/model.rs` — `Timestamps`/`TimestampFormat`, `set_timestamps`,
  millisecond clock helper, unit tests.
- `rust/average-record/src/lib.rs` — export the two new types.
- `rust/average-record/src/test_support.rs` — one hand-written epoch-millis model.
- `rust/average-record-derive/src/lib.rs` — `#[model(timestamps = ...)]` parsing, validation,
  `TIMESTAMPS` codegen, `i64` `set_column` arms.
- `rust/average-record/tests/derive.rs` — derived epoch-millis model + custom column names.
- `rust/README.md`, `dev/average-record-rust.md` — contract and examples.
- `bun/src/ApplicationRecord.ts`, `bun/src/ApplicationRecord.test.ts`, `bun/README.md` — parity.
- `dev/parity-comparison.md` — one row under "Parity".

### Out of scope

- **No change to the default.** Models that declare `created_at: String` / `updated_at: String`
  behave exactly as today, including automatic setup.
- No `DateTime`, `chrono`, or `time` dependency; no timezone handling beyond UTC.
- No per-column format mixing inside one model (one format per model; see "Rejected alternatives").
- No automatic schema generation/migration — hosts still own DDL. The library only documents the
  expected column type.
- No rename of `SaveOptions::skip_updated_at` (kept for compatibility; it means "skip the update
  timestamp", whatever its column/type).
- Downstream application changes (`dps-backend` has its own plans).

## Current state

- `Model::set_timestamps(&mut self, skip_updated_at: bool)` (`rust/average-record/src/model.rs:150`)
  hard-codes the column names and the representation:

  ```rust
  if Self::COLUMNS.contains(&"created_at") && is_new { /* SqlValue::Text(timestamp_now()) */ }
  if Self::COLUMNS.contains(&"updated_at") && !skip_updated_at { /* SqlValue::Text(timestamp_now()) */ }
  ```

  Emptiness is decided by `None | Some(SqlValue::Null) | Some(SqlValue::Text(""))`.

- `timestamp_now() -> String` (`model.rs:574`) reads `SystemTime`, does the civil-date math itself,
  and formats `YYYY-MM-DDTHH:MM:SS.mmmZ`. It is called **twice** per save (once for each column), so
  `created_at == updated_at` after an insert is only true because the two calls usually land in the
  same millisecond. The test at `model.rs:631` asserts that equality, so it is theoretically flaky.

- The derive's `set_column` arms only exist for `String` and `Option<String>` fields
  (`average-record-derive/src/lib.rs:124-144`), so an `i64` timestamp column would silently never be
  assigned.

- `struct_table()` (`lib.rs:232`) parses only `table = "..."` and rejects every other struct-level
  option with `unknown #[model(...)] option on the struct; expected \`table\``.

- Bun mirrors the same hard-coding: `setTimestamps()` uses `created_at`/`updated_at` and
  `new Date().toISOString()`, and the constructor calls it for new records.

- Docs: `rust/README.md:387` ("managed automatically when those columns exist in `COLUMNS`"),
  `dev/average-record-rust.md:825` ("Timestamps are `String` … decision: timestamps are strings"),
  `bun/README.md:163` and `:342`, `dev/parity-comparison.md:49`.

## Target contract (public API)

### Rust

```rust
/// How a model's timestamps are written into their columns.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TimestampFormat {
    /// UTC text, `YYYY-MM-DDTHH:MM:SS.mmmZ` (`TEXT` column).
    #[default]
    Iso8601,
    /// Milliseconds since the Unix epoch (`INTEGER` column).
    EpochMillis,
}

/// Where a model keeps its creation/update timestamps and how they are written.
///
/// Column names must be persisted columns ([`Model::COLUMNS`]); a name that is not persisted is
/// ignored at runtime (the derive rejects it at compile time).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timestamps {
    pub created: Option<&'static str>,
    pub updated: Option<&'static str>,
    pub format: TimestampFormat,
}

impl Timestamps {
    /// `created_at` / `updated_at` as ISO-8601 text. The historical default.
    pub const ISO8601: Self = Self {
        created: Some("created_at"),
        updated: Some("updated_at"),
        format: TimestampFormat::Iso8601,
    };

    /// `created_ts` / `updated_ts` as epoch milliseconds.
    pub const EPOCH_MILLIS: Self = Self {
        created: Some("created_ts"),
        updated: Some("updated_ts"),
        format: TimestampFormat::EpochMillis,
    };

    /// No automatic timestamps.
    pub const NONE: Self = Self {
        created: None,
        updated: None,
        format: TimestampFormat::Iso8601,
    };
}

pub trait Model: Sized + Send + 'static {
    // ...existing consts/methods...

    /// Where this model keeps its timestamps and how they are written.
    ///
    /// Defaults to [`Timestamps::ISO8601`] (`created_at`/`updated_at` as text), so existing models
    /// are unaffected.
    const TIMESTAMPS: Timestamps = Timestamps::ISO8601;

    fn set_timestamps(&mut self, skip_updated_at: bool) { /* see Implementation §1 */ }
}
```

Guarantees (both formats, identical to today's semantics otherwise):

| Operation | `created` column | `updated` column |
|---|---|---|
| INSERT (`save`) | set when the record is new **and** the field is unset (`null`/`""`/`0`) | always set (even with `skip_updated_at`) |
| UPDATE (`save`) | never touched | set unless `skip_updated_at` |
| `skip_updated_at: true` on INSERT | — | still set |
| Column not in `COLUMNS`, or `None` in `TIMESTAMPS` | no-op | no-op |
| Both columns configured | same clock reading, so `created == updated` after INSERT | — |

"Unset" is format-aware: `None`/`NULL` for both, `""` for `Iso8601`, `0` for `EpochMillis`. `0` is
never a valid timestamp, mirroring the `id == 0` "new record" convention.

### Derive attribute

```rust
#[model(table = "events", timestamps = "epoch_millis")]   // created_ts/updated_ts, i64
#[model(table = "events", timestamps = "iso8601")]        // created_at/updated_at, String (default)
#[model(table = "events", timestamps = "none")]           // disabled
#[model(
    table = "events",
    timestamps(created = "inserted_ms", updated = "modified_ms", format = "epoch_millis")
)]
```

The `timestamps(...)` form may omit `created` or `updated` (`None`), and may omit `format`
(defaults to `iso8601`). A bare `timestamps(format = "...")` (neither column named) falls back to that
format's preset names rather than disabling both. Any column named in the explicit form must be a
persisted column with a matching type; the implicit default is not validated, so models with no
timestamp columns need no attribute.

### Bun

```ts
export interface TimestampConfig {
  /** Column receiving the creation timestamp, or `null` to disable. */
  created: string | null;
  /** Column receiving the update timestamp, or `null` to disable. */
  updated: string | null;
  /** `"iso"` writes `Date#toISOString()`; `"millis"` writes `Date.now()`. */
  format: "iso" | "millis";
}

export const Timestamps = {
  iso8601: { created: "created_at", updated: "updated_at", format: "iso" },
  epochMillis: { created: "created_ts", updated: "updated_ts", format: "millis" },
  none: { created: null, updated: null, format: "iso" },
} satisfies Record<string, TimestampConfig>;

class Event extends ApplicationRecord {
  static timestamps = Timestamps.epochMillis;
  // ...
}
```

`ApplicationRecord.timestamps` defaults to `Timestamps.iso8601`.

## Implementation

### 1. `rust/average-record/src/model.rs`

**New public types** — place them next to `SaveOptions`, and add
`pub use model::{TimestampFormat, Timestamps};` in `lib.rs` (alongside `SaveOptions`).

**Clock.** Split the current helper so one reading can serve both columns:

```rust
/// Returns the current Unix time in milliseconds.
pub(crate) fn timestamp_now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Returns the current UTC time formatted as ISO-8601 (`YYYY-MM-DDTHH:MM:SS.mmmZ`).
pub(crate) fn timestamp_now() -> String {
    format_timestamp(timestamp_now_millis())
}

/// Formats epoch milliseconds as ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SS.mmmZ`).
fn format_timestamp(millis: i64) -> String {
    // The existing civil-date math, unchanged, operating on `millis`.
}
```

`as_millis() as i64` is safe for any realistic clock; add a short comment rather than saturating (it
overflows in year ~292 million). Keep the existing `timestamp_now_is_iso8601_utc` test and add one
for the millisecond primitive (`now.abs_diff(timestamp_now_millis()) < 1_000`).

**Value helpers** (private, next to the clock):

```rust
fn timestamp_value(millis: i64, format: TimestampFormat) -> SqlValue {
    match format {
        TimestampFormat::Iso8601 => SqlValue::Text(format_timestamp(millis)),
        TimestampFormat::EpochMillis => SqlValue::Integer(millis),
    }
}

/// `true` when the column holds no timestamp for this format.
fn is_unset_timestamp(value: Option<SqlValue>, format: TimestampFormat) -> bool {
    match (value, format) {
        (None, _) | (Some(SqlValue::Null), _) => true,
        (Some(value), TimestampFormat::Iso8601) => value.as_str().is_some_and(str::is_empty),
        (Some(value), TimestampFormat::EpochMillis) => value.as_i64() == Some(0),
        // A type mismatch means the model disagrees with its own format (only reachable from a
        // hand-written impl); preserving the stored value is the safe choice.
        (Some(_), _) => false,
    }
}
```

**`set_timestamps`** — same position in the hook order (after the before-hooks, before DML):

```rust
fn set_timestamps(&mut self, skip_updated_at: bool) {
    let spec = Self::TIMESTAMPS;
    // One clock reading per save, so `created` and `updated` agree on insert.
    let now = timestamp_now_millis();

    if let Some(column) = spec.created {
        if Self::COLUMNS.contains(&column)
            && self.is_new()
            && is_unset_timestamp(self.get_column(column), spec.format)
        {
            self.set_column(column, timestamp_value(now, spec.format));
        }
    }

    if let Some(column) = spec.updated {
        if Self::COLUMNS.contains(&column) && !skip_updated_at {
            self.set_column(column, timestamp_value(now, spec.format));
        }
    }
}
```

Optional hardening (recommended, debug-only): after each `set_column`, assert the value actually
changed, so a hand-written `Model` that forgot the `set_column` arm fails loudly in tests instead of
silently not stamping:

```rust
debug_assert_ne!(
    self.get_column(column),
    Some(SqlValue::Null),
    "{}::set_column(\"{column}\") did not assign the timestamp; implement set_column for it",
    Self::TABLE_NAME
);
```

(For `EpochMillis` the assigned value is non-null, so this single check covers both formats.)

**Trait docs.** Update `set_column`'s doc: it now serves automatic `created_at`/`updated_at` **and**
`created_ts`/`updated_ts`; the derive implements it for `String`/`Option<String>` fields and for the
configured timestamp columns when they are `i64`/`Option<i64>`.

**Unit tests** (in the existing `mod tests`, using the new `test_support` model — see §3):

- insert sets `created_ts`/`updated_ts` to an integer within ±5 s of `Date`-free `timestamp_now_millis()`,
  and `created_ts == updated_ts`;
- a second `save()` advances `updated_ts` and preserves `created_ts`;
- `skip_updated_at: true` on update preserves `updated_ts` (existing string test keeps its twin);
- `created_ts: 0` on a new record is treated as unset and replaced;
- a non-zero `created_ts` supplied by the caller is preserved on insert;
- a model with no timestamp columns (`HookModel`) still saves.

### 2. `rust/average-record/src/lib.rs`

```rust
pub use model::{Model, ModelHooks, SaveOptions, TimestampFormat, Timestamps};
```

Also add one line to the crate-level docs' example or a short "Timestamps" paragraph pointing at
`Model::TIMESTAMPS`.

### 3. `rust/average-record/src/test_support.rs`

Add a hand-written millisecond model (this is the macro-free coverage for the new contract):

```rust
pub struct MillisModel {
    pub id: i64,
    pub name: String,
    pub created_ts: i64,
    pub updated_ts: i64,
}

impl Model for MillisModel {
    const TABLE_NAME: &'static str = "millis_models";
    const TIMESTAMPS: Timestamps = Timestamps::EPOCH_MILLIS;
    const COLUMNS: &'static [&'static str] = &["id", "name", "created_ts", "updated_ts"];

    // from_row / to_values / primary_key_value / set_primary_key as with TestModel

    fn set_column(&mut self, column: &str, value: SqlValue) {
        match column {
            "created_ts" => {
                if let Some(value) = value.as_i64() {
                    self.created_ts = value;
                }
            }
            "updated_ts" => {
                if let Some(value) = value.as_i64() {
                    self.updated_ts = value;
                }
            }
            _ => {}
        }
    }
}

impl ModelHooks for MillisModel {}
```

Extend the DDL in `memory_connection()`:

```sql
CREATE TABLE millis_models (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL,
    created_ts INTEGER NOT NULL DEFAULT 0, updated_ts INTEGER NOT NULL DEFAULT 0
);
```

`TestModel` is unchanged: it keeps `created_at`/`updated_at` as `String`, which is what proves the
default is backward compatible.

### 4. `rust/average-record-derive/src/lib.rs`

**Struct options.** Replace `struct_table` with a small `StructOptions` parser. Keep the error
message style of the existing code:

```rust
struct StructOptions {
    table: String,
    timestamps: TimestampSpec,
}

struct TimestampSpec {
    created: Option<String>,
    updated: Option<String>,
    format: TimestampFormat, // Iso8601 | EpochMillis
}

impl Default for TimestampSpec {
    fn default() -> Self {
        Self { created: Some("created_at".into()), updated: Some("updated_at".into()), format: TimestampFormat::Iso8601 }
    }
}
```

`expand` calls `struct_options(&input)?` instead of `struct_table(&input)?`.

Parsing sketch (inside the existing `attr.parse_nested_meta` closure; initialize the locals as
`let mut table = None;` and `let mut timestamps = TimestampSpec::default();` before the loop, so the
attribute's absence means "today's behavior"):

```rust
if meta.path.is_ident("table") {
    table = Some(meta.value()?.parse::<syn::LitStr>()?.value());
} else if meta.path.is_ident("timestamps") {
    if meta.input.peek(syn::token::Paren) {
        // timestamps(created = "...", updated = "...", format = "...")
        meta.parse_nested_meta(|inner| { /* set fields; err on unknown keys */ })?;
    } else {
        // timestamps = "iso8601" | "epoch_millis" | "none"
        timestamps = match meta.value()?.parse::<syn::LitStr>()?.value().as_str() {
            "iso8601" => TimestampSpec {
                created: Some("created_at".to_string()),
                updated: Some("updated_at".to_string()),
                format: TimestampFormat::Iso8601,
            },
            "epoch_millis" => TimestampSpec {
                created: Some("created_ts".to_string()),
                updated: Some("updated_ts".to_string()),
                format: TimestampFormat::EpochMillis,
            },
            "none" => TimestampSpec { created: None, updated: None, format: TimestampFormat::Iso8601 },
            other => return Err(meta.error(format!(
                "unknown timestamps preset `{other}`; expected `iso8601`, `epoch_millis`, or `none`"
            ))),
        };
    }
} else {
    return Err(meta.error(
        "unknown #[model(...)] option on the struct; expected `table` or `timestamps`",
    ));
}
```

Spell the `iso8601` arm out rather than reusing `Default`, so the preset→value mapping is readable in
one place.

**Validation** (before codegen; all errors point at the struct ident or the offending literal). The
checks run only for configurations the model author opted into (`strict`): the implicit default must
stay permissive so a model with no timestamp columns needs no attribute.

1. Every configured `created`/`updated` name must appear in `COLUMNS` (i.e. be a non-virtual field's
   column). Otherwise a typo silently disables stamping:

   ```
   #[derive(Model)] timestamps: `inserted_ms` is not a persisted column of `Event`
   ```

2. The referenced field's type must match the format:

   | Format | Accepted field types |
   | --- | --- |
   | `Iso8601` | `String`, `Option<String>` |
   | `EpochMillis` | `i64`, `Option<i64>` |

   Error text names the expected type and the actual one, e.g.
   `#[derive(Model)] `created_ts` is used as an epoch-millisecond timestamp, so it must be `i64` or `Option<i64>``.

3. `created == updated` (same column for both) is an error: the create and update paths would
   overwrite each other. (`Timestamps::NONE`/`None` on either side is fine.)

Reuse/extend `is_string_type`, `is_option_string`, `is_i64`, and add `is_option_i64` (same shape as
`is_option_string`).

**Codegen.** Emit the const inside the `impl Model` block:

```rust
const TIMESTAMPS: average_record::Timestamps = average_record::Timestamps {
    created: #created_option,   // ::std::option::Option::Some("created_ts") | None
    updated: #updated_option,
    format: average_record::TimestampFormat::#format_variant,
};
```

Keep `COLUMNS`, `REDACTED_COLUMNS`, `from_row`, `to_values`, `primary_key_value`,
`set_primary_key`, and `validate` untouched.

**`set_column` arms.** Keep the existing `String`/`Option<String>` arms for every string column
(unchanged) and add `i64`/`Option<i64>` arms **only for the configured timestamp columns**, so the
widening stays scoped to this feature (the PK and other numeric columns do not suddenly become
settable through `set_column`):

```rust
let timestamp_columns = [spec.created.as_deref(), spec.updated.as_deref()];

let set_column_arms = persisted.iter().filter_map(|field| {
    let ident = &field.ident;
    let column = &field.column;
    if is_string_type(&field.ty) {
        // existing arm
    } else if is_option_string(&field.ty) {
        // existing arm
    } else if timestamp_columns.contains(&Some(column.as_str())) {
        if is_i64(&field.ty) {
            Some(quote! {
                #column => {
                    if let Some(value) = value.as_i64() {
                        self.#ident = value;
                    }
                }
            })
        } else if is_option_i64(&field.ty) {
            Some(quote! {
                #column => {
                    self.#ident = value.as_i64();
                }
            })
        } else {
            None // rejected by validation above; unreachable
        }
    } else {
        None
    }
});
```

Do not add a `TimestampFormat` const to the derive crate; keep the derive's internal enum private and
map it to the quoted `average_record::TimestampFormat::…` path.

### 5. `rust/average-record/tests/derive.rs`

Add a second derived model next to `User` (same file, separate table):

```rust
#[derive(Model, Debug, Clone, Default)]
#[model(table = "events", timestamps = "epoch_millis")]
struct Event {
    #[model(primary_key)]
    id: i64,
    name: String,
    created_ts: i64,
    updated_ts: i64,
}

impl ModelHooks for Event {}

// Custom column names, same representation.
#[derive(Model, Debug, Clone, Default)]
#[model(table = "audits", timestamps(created = "inserted_ms", updated = "modified_ms", format = "epoch_millis"))]
struct Audit {
    #[model(primary_key)]
    id: i64,
    action: String,
    inserted_ms: i64,
    modified_ms: i64,
}
```

Extend `connection()` with:

```sql
CREATE TABLE events (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL);
CREATE TABLE audits (id INTEGER PRIMARY KEY, action TEXT NOT NULL, inserted_ms INTEGER NOT NULL, modified_ms INTEGER NOT NULL);
```

Tests:

```rust
#[tokio::test(flavor = "multi_thread")]
async fn epoch_millisecond_timestamps_are_integers() {
    let mut conn = connection().await;
    let before = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let mut event = Event { name: "boot".into(), ..Default::default() };

    assert_eq!(Event::TIMESTAMPS, average_record::Timestamps::EPOCH_MILLIS);
    event.save(&mut conn).await.unwrap();
    assert_eq!(event.created_ts, event.updated_ts);
    assert!(event.created_ts >= before && event.created_ts <= before + 5_000);

    // Stored as INTEGER, not TEXT.
    let raw = Event::query().all_raw(&mut conn).await.unwrap();
    assert!(matches!(raw[0].get("created_ts"), Some(SqlValue::Integer(_))));
}
```

…plus:

- `update_advances_only_updated_ts`: second `save()` after a small sleep (or by asserting
  `>=`, since milliseconds may not advance) with `created_ts` unchanged;
- `skip_updated_at_preserves_updated_ts` for the integer model;
- `custom_timestamp_columns` for `Audit` (asserts `inserted_ms == modified_ms` and that the default
  `created_at` names are *not* used);
- `created_ts_zero_is_unset`: construct with `created_ts: 0`, save, assert replaced;
- `caller_supplied_created_ts_is_preserved`: construct with a fixed value, save, assert unchanged.

The `Event` model also proves the derive emits the `i64` `set_column` arms; without them the fields
stay `0` and the tests fail.

Compile-fail coverage (type mismatch, unknown column, `timestamps = "bogus"`): the repo still has no
`trybuild`. Verify each manually once and record the messages in the PR, or add `trybuild` via
`cargo add --dev trybuild` after maintainer approval (same open point as the 0.2.0 plan).

### 6. `rust/README.md` + `dev/average-record-rust.md`

`rust/README.md`:

- **Model attributes** table: add
  `#[model(timestamps = "epoch_millis")]` — struct — "Writes `created_ts`/`updated_ts` as epoch
  milliseconds instead of `created_at`/`updated_at` ISO text. `iso8601` (default) and `none` are the
  other presets; `timestamps(created = "...", updated = "...", format = "...")` sets custom column
  names."
- **CRUD** line 387: replace with a short **Timestamps** subsection (new, after "Primary keys"),
  covering:
  - the three presets, the table of guarantees above, and that the columns must be in `COLUMNS`;
  - "one clock reading per save, so `created == updated` after an insert";
  - `0`/`""`/`NULL` all mean "unset" for `created`;
  - DDL expectation: `INTEGER NOT NULL DEFAULT 0` for millis, `TEXT` for ISO; if the column is
    nullable, model it as `Option<i64>`/`Option<String>` (the derive's `from_row` uses `try_get`);
  - hand-written models: set `const TIMESTAMPS` and implement `set_column` for those columns
    (show the `MillisModel` shape);
  - `to_json`/`Serialize` emit a JSON number for millis.
- **Without the derive macro** example: leave the string version, and add the `TIMESTAMPS` +
  integer `set_column` snippet in the new Timestamps section (keeps the quick path short).
- Hook-order line 278 stays correct ("… → timestamps → DML …").

`dev/average-record-rust.md` §"Timestamps (`set_timestamps`)" (line 825): rewrite to describe
`Model::TIMESTAMPS`, the two formats, the format-aware unset rule, the single clock read, and the
derive attribute. Change the decision line "timestamps are strings" to "timestamps default to ISO
strings; integer epoch milliseconds are opt-in per model".

### 7. `bun/` parity

`bun/src/ApplicationRecord.ts`:

- Add and export `TimestampConfig` and the `Timestamps` presets (see "Target contract §Bun").
- Add `static timestamps: TimestampConfig = Timestamps.iso8601;` to `ApplicationRecord`, next to
  `static primaryKey`.
- Rewrite `setTimestamps`:

  ```ts
  setTimestamps(options: SetTimestampOptions = {}): void {
    const Ctor = this.constructor as typeof ApplicationRecord;
    const { created, updated, format } = Ctor.timestamps;
    const record = this as Record<string, unknown>;
    const schema = Ctor.schema.entries;
    const isNew = isNewRecord(record, Ctor.primaryKey);
    const now = format === "millis" ? Date.now() : new Date().toISOString();

    if (created && created in schema && isNew && isUnsetTimestamp(record[created], format)) {
      record[created] = now;
    }
    if (updated && updated in schema && options.updatedAt !== false) {
      record[updated] = now;
    }
  }
  ```

  with

  ```ts
  function isUnsetTimestamp(value: unknown, format: TimestampConfig["format"]): boolean {
    if (value == null) return true;
    return format === "millis" ? value === 0 : value === "";
  }
  ```

  This also closes a small Rust/Bun parity gap: Bun previously treated an empty string as "set" and
  preserved it, while Rust treats `""` as unset and replaces it. Bun now matches Rust (`""` for iso,
  `0` for millis).

- `Constructor` and `save()` call sites are unchanged (they already call `setTimestamps()`), so no
  other behavior moves.
- Doc comment on `save()`/`setTimestamps` gains one sentence about the per-model config.

`bun/src/ApplicationRecord.test.ts` (extend `#setTimestamps()`):

- `class MillisModel` with `static timestamps = Timestamps.epochMillis`, schema
  `created_ts: v.number(), updated_ts: v.number()`, table `millis_models` with `INTEGER` columns;
- "sets integer timestamps on insert" — `typeof === "number"`, `created_ts === updated_ts`,
  `Date.now() - created_ts` small;
- "advances only updated_ts on update" with `setSystemTime(Date.now() + 1000)` (already used in the
  suite; `Date.now()` honors it);
- "preserves updated_ts when skipUpdatedAt is set";
- "treats 0/'' as unset" (mirrors Rust);
- "custom column names" — a class with
  `static timestamps = { created: "inserted_ms", updated: "modified_ms", format: "millis" }` and
  asserts no `created_at` appears;
- "`Timestamps.none` disables stamping";
- keep every existing string test green (the default config is identical to today).

`bun/README.md`: add a **Timestamps** subsection near line 163 showing
`static timestamps = Timestamps.epochMillis;`, the three presets, the `0`/`""`/`null` unset rule, and
the `INTEGER` column expectation. Replace the `beforeCreate`/`beforeUpdate` timestamp example at
line ~342 with `static timestamps` (it currently hand-rolls the same thing), keeping the hooks
section about hooks.

`dev/parity-comparison.md`: under "Parity", extend the `created_at`/`updated_at` line with
"…configurable per model (`Model::TIMESTAMPS` ≡ `static timestamps`), with an ISO-8601 text default
and an epoch-millisecond integer option in both."

### 8. Release

- Commit message: `feat: configurable timestamps with epoch-millisecond support`
  (non-breaking; the default ISO-8601 text behavior is unchanged).
- release-please cuts `0.4.0`. No manual version edits; no `Cargo.lock` commit; no `--locked`.

## Task order (commit-sized)

1. `model.rs`: `Timestamps`/`TimestampFormat`, clock split, `set_timestamps`, value helpers, exports,
   `test_support::MillisModel` + DDL, unit tests. (Library works for hand-written models.)
2. Derive: struct-options parser, validation, `TIMESTAMPS` codegen, scoped `i64`/`Option<i64>`
   `set_column` arms, `tests/derive.rs`.
3. `rust/README.md` + `dev/average-record-rust.md`.
4. Bun: `TimestampConfig`/`Timestamps`, `static timestamps`, `setTimestamps`, tests, `bun/README.md`.
5. `dev/parity-comparison.md`, then full verification + release.

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
bun fmt bun
bun fmt --check bun
```

## Acceptance criteria

- [ ] `Model::TIMESTAMPS` exists, defaults to `Timestamps::ISO8601`, and is overridable per model.
- [ ] `Timestamps::EPOCH_MILLIS` writes `created_ts`/`updated_ts` as `SqlValue::Integer` epoch
      milliseconds; `TimestampFormat::Iso8601` keeps today's `TEXT` output byte-for-byte.
- [ ] A model with custom column names (`timestamps(created = ..., updated = ...)`) stamps those
      columns and leaves `created_at`/`updated_at` alone.
- [ ] One clock reading per save: `created == updated` after INSERT in both formats.
- [ ] `created` is only stamped when new **and** unset (`NULL`, `""`, `0`); a caller-supplied value is
      preserved.
- [ ] `updated` is always stamped on INSERT (even with `skip_updated_at`) and on UPDATE only when
      `skip_updated_at` is false.
- [ ] `timestamps = "none"` (and `Timestamps::NONE`) disables stamping entirely.
- [ ] The derive rejects an unknown timestamp column, a field type that does not match the format,
      and `created == updated`, with actionable messages.
- [ ] The derive emits `set_column` arms for `i64`/`Option<i64>` timestamp columns only; hand-written
      models still work (covered by `MillisModel`).
- [ ] Derived and hand-written models both persist integers (`all_raw`/`persisted` show
      `SqlValue::Integer`), and `to_json` emits a JSON number.
- [ ] Bun: `static timestamps` with the same three presets, `Date.now()` for millis, `0`/`""`/`null`
      treated as unset, full suite green.
- [ ] READMEs (root/rust/bun), `dev/average-record-rust.md`, and `dev/parity-comparison.md` describe
      the contract; the default is documented as unchanged.
- [ ] `cargo clippy … -D warnings`, `cargo fmt --check`, `bun check`, `bun fmt --check bun` are clean.

## Rejected alternatives

| Alternative | Why not |
|---|---|
| Two independent consts (`CREATED_TS_COLUMN`, `UPDATED_TS_COLUMN`, `TIMESTAMP_FORMAT`) | Three knobs that can disagree (`format = millis` with the default `created_at` names is nonsense). A single `Timestamps` value makes column + representation atomic and adds one const, not three. |
| Infer the format from the field type, no `Timestamps.format` | Works for the derive but not for the trait: `set_timestamps` has no access to Rust field types, so hand-written models would need a separate format knob anyway. Inferring also cannot express "this `Option<i64>` column holds an ISO string" (a legitimate, if unusual, host schema). The recommended design keeps the explicit format and uses the derive only to *validate* that the field type agrees with it — same compile-time safety, one contract for both model styles. |
| Auto-detect by column name (`COLUMNS` contains `created_ts` → millis) | Silently changes behavior based on naming, forbids custom names, and makes the representation invisible at the call site. Explicit config is one attribute. |
| Replace ISO strings with integers everywhere | Breaking for every host schema and for `dps-backend`; the ask is additive. The default must stay byte-compatible. |
| Store seconds instead of milliseconds | Loses ordering precision that change tracking/audits care about; `Date.now()` and `SystemTime` both expose millis natively. Consistency: `0` is also the "unset" sentinel in `id`. |
| A new `TimestampStyle`/`date` crate | Neither format needs one: ISO formatting is already hand-rolled, and millis is `SystemTime`/`Date.now()`. Adding a dependency for this is not justified (see the existing design note). |
| Per-column format mixing in one model | No use case; doubles the validation matrix. One format per model, validated at derive time. |
| Rename `skip_updated_at` → `skip_updated_ts` | Public API churn with no benefit; the option means "skip the update timestamp", not "skip a column named `updated_at`". |

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Existing models change behavior | Default `Timestamps::ISO8601` reproduces today's column names, values, and unset rule exactly; the string test suite is kept as the regression guard. |
| A host defines `created_ts` as `TEXT` or nullable | The derive forces the Rust field type to match the configured format, so a mismatch surfaces at compile time; docs state the expected DDL (`INTEGER NOT NULL DEFAULT 0`). Nullable columns must be modeled as `Option<i64>`. |
| A typo in a custom column name silently disables stamping | The derive rejects any `timestamps` column that is not a persisted `COLUMNS` entry; the runtime `COLUMNS.contains` guard remains for hand-written models. |
| A hand-written model forgets `set_column` | `debug_assert` after assignment in `set_timestamps` fails tests instead of silently not stamping; docs show the required arm. |
| Millisecond collisions on a fast UPDATE (same `updated_ts`) | Acceptable and expected; tests assert monotonic non-decrease, not strict increase. `skip_updated_at` exists for "don't touch it at all". |
| `SystemTime` before the epoch (bad clock) | `unwrap_or_default()` keeps today's behavior (yields `0`, which reads as "unset" for `created` — the next save repairs it). |
| JS number precision | Epoch millis (~1.7e12) are far below `Number.MAX_SAFE_INTEGER` (9e15). |
| Bun/Rust drift | Same three presets, same unset rule, and mirrored tests in both suites; parity doc row updated in the same PR. |
| Clock read count changes existing timestamps | The single read makes `created == updated` deterministic; it cannot make previously distinct values equal in production, and the existing equality assertion was already assuming this. |

## Out-of-scope follow-ups

- `#[model(json = "...")]` for typed JSON columns (needs `to_values -> Result`).
- Composite/UUID primary keys (the contract stays integer-only).
- Optional timezone/local rendering helpers for ISO timestamps.
- A `trybuild` compile-fail suite for all derive validations (PK type, timestamp type, unknown
  timestamp column).
