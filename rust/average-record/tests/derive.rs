use average_record::{Error, Model, ModelHooks, SqlValue, Timestamps};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{AssertSqlSafe, Connection, SqliteConnection};
use std::str::FromStr;
use validator::Validate;

#[derive(Model, Validate, Debug, Clone, Default)]
#[model(table = "users")]
struct User {
    #[model(primary_key)]
    #[validate(skip)]
    id: i64,

    #[validate(length(min = 1, max = 200))]
    name: String,

    #[redacted]
    #[validate(skip)]
    password_digest: Option<String>,

    #[model(column = "locked")]
    #[validate(skip)]
    locked: bool,

    #[validate(skip)]
    created_at: String,

    #[validate(skip)]
    updated_at: String,

    /// Not persisted.
    #[model(virtual)]
    #[validate(skip)]
    post_count: Option<i64>,
}

impl ModelHooks for User {}

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

#[derive(Model, Debug, Clone, Default)]
#[model(
    table = "audits",
    timestamps(
        created = "inserted_ms",
        updated = "modified_ms",
        format = "epoch_millis"
    )
)]
struct Audit {
    #[model(primary_key)]
    id: i64,
    action: String,
    inserted_ms: i64,
    modified_ms: i64,
}

impl ModelHooks for Audit {}

#[derive(Model, Debug, Clone, Default)]
#[model(table = "optional_ts", timestamps = "epoch_millis")]
struct OptionalTs {
    #[model(primary_key)]
    id: i64,
    created_ts: Option<i64>,
    updated_ts: Option<i64>,
}

impl ModelHooks for OptionalTs {}

#[derive(Model, Debug, Clone, Default)]
#[model(table = "untimed", timestamps = "none")]
struct Untimed {
    #[model(primary_key)]
    id: i64,
    created_at: String,
    updated_at: String,
}

impl ModelHooks for Untimed {}

async fn connection() -> SqliteConnection {
    let options = SqliteConnectOptions::from_str("sqlite::memory:").unwrap();
    let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::raw_sql(AssertSqlSafe(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, password_digest TEXT, locked INTEGER, created_at TEXT, updated_at TEXT);\
         CREATE TABLE events (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL);\
         CREATE TABLE audits (id INTEGER PRIMARY KEY, action TEXT NOT NULL, inserted_ms INTEGER NOT NULL, modified_ms INTEGER NOT NULL);\
         CREATE TABLE optional_ts (id INTEGER PRIMARY KEY, created_ts INTEGER, updated_ts INTEGER);\
         CREATE TABLE untimed (id INTEGER PRIMARY KEY, created_at TEXT, updated_at TEXT)"
            .to_string(),
    ))
    .execute(&mut conn)
    .await
    .unwrap();
    conn
}

#[tokio::test(flavor = "multi_thread")]
async fn derived_metadata_excludes_virtual_fields() {
    assert_eq!(User::TABLE_NAME, "users");
    assert_eq!(
        User::COLUMNS,
        &[
            "id",
            "name",
            "password_digest",
            "locked",
            "created_at",
            "updated_at"
        ]
    );
    assert_eq!(User::REDACTED_COLUMNS, &["password_digest"]);
    assert_eq!(User::TIMESTAMPS, Timestamps::ISO8601);
}

#[tokio::test(flavor = "multi_thread")]
async fn derived_crud_and_bool_mapping() {
    let mut conn = connection().await;
    let mut user = User {
        name: "Alice".to_string(),
        locked: true,
        post_count: Some(42),
        ..Default::default()
    };
    user.save(&mut conn).await.unwrap();
    assert_eq!(user.id, 1);
    assert!(!user.created_at.is_empty());

    let found = User::find(&mut conn, user.id).await.unwrap().unwrap();
    assert!(found.locked);
    assert_eq!(found.name, "Alice");
    assert_eq!(found.post_count, None);

    user.name = "Alice Smith".to_string();
    user.save(&mut conn).await.unwrap();

    let query = User::query()
        .where_eq("name", "Alice Smith")
        .unwrap()
        .all(&mut conn)
        .await
        .unwrap();
    assert_eq!(query.len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn derived_validation_and_redaction() {
    let mut conn = connection().await;

    let invalid = User {
        name: String::new(),
        ..Default::default()
    };
    let errors = invalid.validate(&mut conn).await.unwrap();
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].column, "name");
    assert_eq!(errors[0].code, "length");
    // Interpolation values for the host's translation; the submitted value is never echoed back.
    assert_eq!(errors[0].params["min"], serde_json::json!(1));
    assert_eq!(errors[0].params["max"], serde_json::json!(200));
    assert!(!errors[0].params.contains_key("value"));

    let serialized = serde_json::to_value(&errors).unwrap();
    assert_eq!(serialized[0]["column"], serde_json::json!("name"));
    assert_eq!(serialized[0]["code"], serde_json::json!("length"));

    let mut user = User {
        name: "Alice".to_string(),
        password_digest: Some("hunter2".to_string()),
        ..Default::default()
    };
    assert!(user.validate(&mut conn).await.unwrap().is_empty());
    user.save(&mut conn).await.unwrap();

    let json = user.to_json(true);
    assert_eq!(json["password_digest"], serde_json::json!("[redacted]"));
    assert!(json.get("post_count").is_none());

    let serialized = serde_json::to_value(&user).unwrap();
    assert_eq!(serialized["name"], serde_json::json!("Alice"));
    assert!(serialized.get("post_count").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn derived_field_rules_abort_the_save() {
    let mut conn = connection().await;
    let mut invalid = User {
        name: String::new(),
        ..Default::default()
    };

    let error = invalid.save(&mut conn).await.unwrap_err();
    match error {
        Error::Validation(errors) => {
            assert_eq!(errors.len(), 1);
            assert_eq!(errors[0].column, "name");
            assert_eq!(errors[0].code, "length");
        }
        other => panic!("expected Error::Validation, got {other:?}"),
    }
    assert_eq!(User::count(&mut conn).await.unwrap(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn derived_change_tracking() {
    let mut conn = connection().await;
    let mut user = User {
        name: "Alice".to_string(),
        ..Default::default()
    };
    user.save_with_options(
        &mut conn,
        average_record::SaveOptions {
            track_changes: true,
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let changes = user.tracked_changes().unwrap();
    assert_eq!(
        changes.get("name").unwrap().after,
        Some(SqlValue::Text("Alice".to_string()))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn zero_primary_key_is_treated_as_new() {
    let mut conn = connection().await;
    let mut user = User {
        id: 0,
        name: "Zero".to_string(),
        ..Default::default()
    };
    assert!(user.is_new());
    assert!(user.persisted(&mut conn, false).await.unwrap().is_none());
    assert!(user.changes(&mut conn, false).await.unwrap().is_empty());

    user.save(&mut conn).await.unwrap();
    assert_eq!(user.id, 1);
    assert!(!user.is_new());
    assert_eq!(User::count(&mut conn).await.unwrap(), 1);
    assert!(User::find(&mut conn, 0).await.unwrap().is_none());

    // A second save updates the assigned row rather than inserting a duplicate.
    user.name = "Zero Updated".to_string();
    user.save(&mut conn).await.unwrap();
    assert_eq!(User::count(&mut conn).await.unwrap(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn destroy_rejects_an_unsaved_record() {
    let mut conn = connection().await;
    let mut user = User {
        name: "Unsaved".to_string(),
        ..Default::default()
    };
    let error = user.destroy(&mut conn).await.unwrap_err();
    assert!(matches!(error, average_record::Error::Record(_)));
    assert_eq!(User::count(&mut conn).await.unwrap(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn epoch_millisecond_timestamps_are_integers() {
    let mut conn = connection().await;
    let before = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let mut event = Event {
        name: "boot".to_string(),
        ..Default::default()
    };

    assert_eq!(Event::TIMESTAMPS, Timestamps::EPOCH_MILLIS);
    event.save(&mut conn).await.unwrap();

    assert_eq!(event.created_ts, event.updated_ts);
    assert!(event.created_ts >= before);
    assert!(event.created_ts <= before + 5_000);

    // Stored as INTEGER, not TEXT.
    let raw = Event::query().all_raw(&mut conn).await.unwrap();
    assert!(matches!(
        raw[0].get("created_ts"),
        Some(SqlValue::Integer(_))
    ));
    let found = Event::find(&mut conn, event.id).await.unwrap().unwrap();
    assert_eq!(found.created_ts, event.created_ts);
}

#[tokio::test(flavor = "multi_thread")]
async fn update_advances_only_the_updated_ts() {
    let mut conn = connection().await;
    let mut event = Event {
        name: "boot".to_string(),
        ..Default::default()
    };
    event.save(&mut conn).await.unwrap();
    let created = event.created_ts;

    event.name = "restart".to_string();
    event.updated_ts = 1;
    event.save(&mut conn).await.unwrap();

    assert_eq!(event.created_ts, created);
    assert!(event.updated_ts > 1);

    let found = Event::find(&mut conn, event.id).await.unwrap().unwrap();
    assert_eq!(found.created_ts, created);
    assert_eq!(found.updated_ts, event.updated_ts);
}

#[tokio::test(flavor = "multi_thread")]
async fn skip_updated_at_preserves_the_updated_ts() {
    let mut conn = connection().await;
    let mut event = Event {
        name: "boot".to_string(),
        ..Default::default()
    };
    event.save(&mut conn).await.unwrap();
    let created = event.created_ts;

    event.updated_ts = 1;
    event
        .save_with_options(
            &mut conn,
            average_record::SaveOptions {
                skip_updated_at: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();

    assert_eq!(event.updated_ts, 1);
    assert_eq!(event.created_ts, created);
}

#[tokio::test(flavor = "multi_thread")]
async fn custom_timestamp_columns_are_used() {
    let mut conn = connection().await;
    let mut audit = Audit {
        action: "login".to_string(),
        ..Default::default()
    };
    audit.save(&mut conn).await.unwrap();

    assert_eq!(audit.inserted_ms, audit.modified_ms);
    assert!(audit.inserted_ms > 0);

    let raw = Audit::query().all_raw(&mut conn).await.unwrap();
    assert!(!raw[0].contains_key("created_at"));
    assert!(matches!(
        raw[0].get("inserted_ms"),
        Some(SqlValue::Integer(_))
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn zero_created_ts_is_treated_as_unset() {
    let mut conn = connection().await;
    let mut event = Event {
        name: "boot".to_string(),
        created_ts: 0,
        ..Default::default()
    };
    event.save(&mut conn).await.unwrap();
    assert_ne!(event.created_ts, 0);
    assert_eq!(event.created_ts, event.updated_ts);
}

#[tokio::test(flavor = "multi_thread")]
async fn caller_supplied_created_ts_is_preserved() {
    let mut conn = connection().await;
    let fixed = 1_600_000_000_000;
    let mut event = Event {
        name: "boot".to_string(),
        created_ts: fixed,
        ..Default::default()
    };
    event.save(&mut conn).await.unwrap();
    assert_eq!(event.created_ts, fixed);
    assert!(event.updated_ts >= fixed);
}

#[tokio::test(flavor = "multi_thread")]
async fn optional_timestamp_columns_are_set() {
    let mut conn = connection().await;
    let mut model = OptionalTs::default();
    model.save(&mut conn).await.unwrap();

    assert!(model.created_ts.is_some());
    assert_eq!(model.created_ts, model.updated_ts);

    let found = OptionalTs::find(&mut conn, model.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(found.created_ts, model.created_ts);
}

#[tokio::test(flavor = "multi_thread")]
async fn timestamps_none_disables_stamping() {
    let mut conn = connection().await;
    let mut model = Untimed::default();
    assert_eq!(Untimed::TIMESTAMPS, Timestamps::NONE);
    model.save(&mut conn).await.unwrap();
    assert!(model.created_at.is_empty());
    assert!(model.updated_at.is_empty());
}
