use average_record::{Model, ModelHooks, SqlValue};
use garde::Validate;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{AssertSqlSafe, Connection, SqliteConnection};
use std::str::FromStr;

#[derive(Model, Validate, Debug, Clone, Default)]
#[model(table = "users")]
struct User {
    #[model(primary_key)]
    #[garde(skip)]
    id: i64,

    #[garde(length(min = 1, max = 200))]
    name: String,

    #[redacted]
    #[garde(skip)]
    password_digest: Option<String>,

    #[model(column = "locked")]
    #[garde(skip)]
    locked: bool,

    #[garde(skip)]
    created_at: String,

    #[garde(skip)]
    updated_at: String,

    /// Not persisted.
    #[model(virtual)]
    #[garde(skip)]
    post_count: Option<i64>,
}

impl ModelHooks for User {}

async fn connection() -> SqliteConnection {
    let options = SqliteConnectOptions::from_str("sqlite::memory:").unwrap();
    let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::raw_sql(AssertSqlSafe(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, password_digest TEXT, locked INTEGER, created_at TEXT, updated_at TEXT)"
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
