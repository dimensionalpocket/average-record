use std::any::TypeId;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use serde_json::{Value, json};

use crate::query::SqlValue;

/// A single column's before/after values in a [`Changes`] set.
#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    /// The column name.
    pub column: String,
    /// The value before the operation (`None` for inserts).
    pub before: Option<SqlValue>,
    /// The value after the operation (`None` for deletes).
    pub after: Option<SqlValue>,
}

/// An ordered set of column changes.
///
/// Produced by [`Model::changes`](crate::Model::changes) and
/// [`Model::tracked_changes`](crate::Model::tracked_changes).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Changes {
    entries: Vec<Change>,
    redacted_columns: &'static [&'static str],
}

/// Historical alias for [`Changes`], matching the reference implementation's naming.
pub type TrackedChanges = Changes;

impl Changes {
    /// Builds a change set from the supplied entries, with no redaction metadata.
    pub fn new(entries: Vec<Change>) -> Self {
        Self {
            entries,
            redacted_columns: &[],
        }
    }

    pub(crate) fn with_redacted(
        entries: Vec<Change>,
        redacted_columns: &'static [&'static str],
    ) -> Self {
        Self {
            entries,
            redacted_columns,
        }
    }

    /// Iterates over `(column, change)` pairs in declaration order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &Change)> {
        self.entries
            .iter()
            .map(|change| (change.column.as_str(), change))
    }

    /// Returns `true` when there are no changes.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Returns the number of changed columns.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Returns the change for a column, if it changed.
    pub fn get(&self, column: &str) -> Option<&Change> {
        self.entries.iter().find(|change| change.column == column)
    }

    /// Renders the change set as a JSON object of `{ column: [before, after] }`.
    ///
    /// When `redact` is `true`, redacted columns are rendered as `"[redacted]"`.
    pub fn to_json(&self, redact: bool) -> Value {
        let mut map = serde_json::Map::with_capacity(self.entries.len());
        for change in &self.entries {
            let redact_column = redact && self.redacted_columns.contains(&change.column.as_str());
            let before = if redact_column {
                json!("[redacted]")
            } else {
                change
                    .before
                    .as_ref()
                    .map(SqlValue::to_json)
                    .unwrap_or(Value::Null)
            };
            let after = if redact_column {
                json!("[redacted]")
            } else {
                change
                    .after
                    .as_ref()
                    .map(SqlValue::to_json)
                    .unwrap_or(Value::Null)
            };
            map.insert(change.column.clone(), json!([before, after]));
        }
        Value::Object(map)
    }
}

type TrackedKey = (TypeId, Option<i64>);
type TrackedStore = LazyLock<Mutex<HashMap<TrackedKey, Changes>>>;

/// Process-global store for the change set captured by the most recent tracked write on a record.
///
/// Models are plain structs and cannot carry hidden per-instance state, so tracked changes are
/// keyed by `(model type, primary key)`. `tracked_changes()` reads the entry for the record's
/// current primary key; entries are overwritten on each tracked write.
static TRACKED: TrackedStore = LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) fn store_tracked(model: TypeId, id: Option<i64>, changes: Changes) {
    if let Ok(mut map) = TRACKED.lock() {
        map.insert((model, id), changes);
    }
}

pub(crate) fn load_tracked(model: TypeId, id: Option<i64>) -> Option<Changes> {
    TRACKED
        .lock()
        .ok()
        .and_then(|map| map.get(&(model, id)).cloned())
}
