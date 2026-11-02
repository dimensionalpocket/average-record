use std::sync::{LazyLock, Mutex};

use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{AssertSqlSafe, Connection, Row, SqliteConnection};
use std::str::FromStr;

use crate::Result;
use crate::model::{Model, ModelHooks, Timestamps};
use crate::query::SqlValue;
use crate::validation::ValidationError;

/// Serializes tests that share the process-global tracked-changes registry.
pub static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Log of hook invocations, used by [`HookModel`].
pub static HOOK_EVENTS: LazyLock<Mutex<Vec<&'static str>>> =
    LazyLock::new(|| Mutex::new(Vec::new()));

/// Drains and returns the recorded hook events.
pub fn take_hook_events() -> Vec<&'static str> {
    HOOK_EVENTS
        .lock()
        .map(|mut events| std::mem::take(&mut *events))
        .unwrap_or_default()
}

fn record(event: &'static str) {
    if let Ok(mut events) = HOOK_EVENTS.lock() {
        events.push(event);
    }
}

/// Opens a fresh in-memory connection with the test schema applied.
pub async fn memory_connection() -> SqliteConnection {
    let options = SqliteConnectOptions::from_str("sqlite::memory:").expect("valid sqlite url");
    let mut conn = SqliteConnection::connect_with(&options)
        .await
        .expect("connect");
    let ddl = "CREATE TABLE test_models (\
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, role TEXT, \
        score INTEGER, created_at TEXT, updated_at TEXT, secret TEXT\
    );\
    CREATE TABLE test_stats (id INTEGER PRIMARY KEY, test_model_id INTEGER, score INTEGER);\
    CREATE TABLE hook_models (id INTEGER PRIMARY KEY, name TEXT);\
    CREATE TABLE millis_models (\
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, \
        created_ts INTEGER NOT NULL DEFAULT 0, updated_ts INTEGER NOT NULL DEFAULT 0\
    );";
    sqlx::raw_sql(AssertSqlSafe(ddl.to_string()))
        .execute(&mut conn)
        .await
        .expect("schema");
    conn
}

/// A hand-written test model covering a broad column set.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TestModel {
    pub id: i64,
    pub name: String,
    pub status: String,
    pub role: Option<String>,
    pub score: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    pub secret: Option<String>,
}

impl Model for TestModel {
    const TABLE_NAME: &'static str = "test_models";
    const PRIMARY_KEY: &'static str = "id";
    const COLUMNS: &'static [&'static str] = &[
        "id",
        "name",
        "status",
        "role",
        "score",
        "created_at",
        "updated_at",
        "secret",
    ];
    const REDACTED_COLUMNS: &'static [&'static str] = &["secret"];

    fn from_row(row: &sqlx::sqlite::SqliteRow) -> Result<Self> {
        Ok(Self {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            status: row.try_get("status")?,
            role: row.try_get("role")?,
            score: row.try_get("score")?,
            created_at: row.try_get("created_at")?,
            updated_at: row.try_get("updated_at")?,
            secret: row.try_get("secret")?,
        })
    }

    fn to_values(&self) -> Vec<SqlValue> {
        vec![
            self.id.into(),
            self.name.clone().into(),
            self.status.clone().into(),
            self.role.clone().into(),
            self.score.into(),
            self.created_at.clone().into(),
            self.updated_at.clone().into(),
            self.secret.clone().into(),
        ]
    }

    fn primary_key_value(&self) -> i64 {
        self.id
    }

    fn set_primary_key(&mut self, id: i64) {
        self.id = id;
    }

    fn set_column(&mut self, column: &str, value: SqlValue) {
        match column {
            "created_at" => {
                if let Some(text) = value.as_str() {
                    self.created_at = text.to_string();
                }
            }
            "updated_at" => {
                if let Some(text) = value.as_str() {
                    self.updated_at = text.to_string();
                }
            }
            _ => {}
        }
    }
}

impl ModelHooks for TestModel {}

/// A model whose hooks record their invocation order.
#[derive(Debug, Clone, Default)]
pub struct HookModel {
    pub id: i64,
    pub name: String,
}

impl Model for HookModel {
    const TABLE_NAME: &'static str = "hook_models";
    const COLUMNS: &'static [&'static str] = &["id", "name"];

    fn from_row(row: &sqlx::sqlite::SqliteRow) -> Result<Self> {
        Ok(Self {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
        })
    }

    fn to_values(&self) -> Vec<SqlValue> {
        vec![self.id.into(), self.name.clone().into()]
    }

    fn primary_key_value(&self) -> i64 {
        self.id
    }

    fn set_primary_key(&mut self, id: i64) {
        self.id = id;
    }
}

impl ModelHooks for HookModel {
    async fn before_create(&mut self, _conn: &mut SqliteConnection) -> Result<()> {
        record("before_create");
        Ok(())
    }

    async fn before_update(&mut self, _conn: &mut SqliteConnection) -> Result<()> {
        record("before_update");
        Ok(())
    }

    async fn after_create(&self, _conn: &mut SqliteConnection) -> Result<()> {
        record("after_create");
        Ok(())
    }

    async fn after_update(&self, _conn: &mut SqliteConnection) -> Result<()> {
        record("after_update");
        Ok(())
    }

    async fn after_save(&self, _conn: &mut SqliteConnection) -> Result<()> {
        record("after_save");
        Ok(())
    }

    async fn after_destroy(&self, _conn: &mut SqliteConnection) -> Result<()> {
        record("after_destroy");
        Ok(())
    }
}

/// A model that rejects every save through `validate_custom`.
#[derive(Debug, Clone, Default)]
pub struct ValidatedModel {
    pub id: i64,
    pub name: String,
}

impl Model for ValidatedModel {
    const TABLE_NAME: &'static str = "test_models";
    const COLUMNS: &'static [&'static str] = &["id", "name"];

    fn from_row(row: &sqlx::sqlite::SqliteRow) -> Result<Self> {
        Ok(Self {
            id: row.try_get("id").unwrap_or(0),
            name: row.try_get("name").unwrap_or_default(),
        })
    }

    fn to_values(&self) -> Vec<SqlValue> {
        vec![self.id.into(), self.name.clone().into()]
    }

    fn primary_key_value(&self) -> i64 {
        self.id
    }

    fn set_primary_key(&mut self, id: i64) {
        self.id = id;
    }
}

impl ModelHooks for ValidatedModel {
    async fn validate_custom(&self, _conn: &mut SqliteConnection) -> Result<Vec<ValidationError>> {
        Ok(vec![ValidationError::new("name", "is not allowed")])
    }
}

/// A hand-written model using epoch-millisecond timestamps.
#[derive(Debug, Clone, Default, PartialEq)]
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

    fn from_row(row: &sqlx::sqlite::SqliteRow) -> Result<Self> {
        Ok(Self {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            created_ts: row.try_get("created_ts")?,
            updated_ts: row.try_get("updated_ts")?,
        })
    }

    fn to_values(&self) -> Vec<SqlValue> {
        vec![
            self.id.into(),
            self.name.clone().into(),
            self.created_ts.into(),
            self.updated_ts.into(),
        ]
    }

    fn primary_key_value(&self) -> i64 {
        self.id
    }

    fn set_primary_key(&mut self, id: i64) {
        self.id = id;
    }

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
