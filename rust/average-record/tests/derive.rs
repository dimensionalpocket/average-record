use average_record::{Model, ModelHooks, SqlValue};
use garde::Validate;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{AssertSqlSafe, Connection, SqliteConnection};
use std::str::FromStr;

#[derive(Model, Validate, Debug, Clone, Default)]
#[model(table = "songs")]
struct Song {
    #[model(primary_key)]
    #[garde(skip)]
    id: Option<i64>,

    #[garde(length(min = 1, max = 200))]
    title: String,

    #[redacted]
    #[garde(skip)]
    secret: Option<String>,

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
    score: Option<i64>,
}

impl ModelHooks for Song {}

async fn connection() -> SqliteConnection {
    let options = SqliteConnectOptions::from_str("sqlite::memory:").unwrap();
    let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::raw_sql(AssertSqlSafe(
        "CREATE TABLE songs (id INTEGER PRIMARY KEY, title TEXT NOT NULL, secret TEXT, locked INTEGER, created_at TEXT, updated_at TEXT)"
            .to_string(),
    ))
    .execute(&mut conn)
    .await
    .unwrap();
    conn
}

#[tokio::test(flavor = "multi_thread")]
async fn derived_metadata_excludes_virtual_fields() {
    assert_eq!(Song::TABLE_NAME, "songs");
    assert_eq!(
        Song::COLUMNS,
        &[
            "id",
            "title",
            "secret",
            "locked",
            "created_at",
            "updated_at"
        ]
    );
    assert_eq!(Song::REDACTED_COLUMNS, &["secret"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn derived_crud_and_bool_mapping() {
    let mut conn = connection().await;
    let mut song = Song {
        title: "NIGHT OF FIRE".to_string(),
        locked: true,
        score: Some(42),
        ..Default::default()
    };
    song.save(&mut conn).await.unwrap();
    assert_eq!(song.id, Some(1));
    assert!(!song.created_at.is_empty());

    let found = Song::find(&mut conn, song.id.unwrap())
        .await
        .unwrap()
        .unwrap();
    assert!(found.locked);
    assert_eq!(found.title, "NIGHT OF FIRE");
    assert_eq!(found.score, None);

    song.title = "Night of Fire".to_string();
    song.save(&mut conn).await.unwrap();

    let query = Song::query()
        .where_eq("title", "Night of Fire")
        .unwrap()
        .all(&mut conn)
        .await
        .unwrap();
    assert_eq!(query.len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn derived_validation_and_redaction() {
    let mut conn = connection().await;

    let invalid = Song {
        title: String::new(),
        ..Default::default()
    };
    let errors = invalid.validate(&mut conn).await.unwrap();
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].column, "title");

    let mut song = Song {
        title: "NIGHT OF FIRE".to_string(),
        secret: Some("hunter2".to_string()),
        ..Default::default()
    };
    assert!(song.validate(&mut conn).await.unwrap().is_empty());
    song.save(&mut conn).await.unwrap();

    let json = song.to_json(true);
    assert_eq!(json["secret"], serde_json::json!("[redacted]"));
    assert!(json.get("score").is_none());

    let serialized = serde_json::to_value(&song).unwrap();
    assert_eq!(serialized["title"], serde_json::json!("NIGHT OF FIRE"));
    assert!(serialized.get("score").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn derived_change_tracking() {
    let mut conn = connection().await;
    let mut song = Song {
        title: "NIGHT OF FIRE".to_string(),
        ..Default::default()
    };
    song.save_with_options(
        &mut conn,
        average_record::SaveOptions {
            track_changes: true,
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let changes = song.tracked_changes().unwrap();
    assert_eq!(
        changes.get("title").unwrap().after,
        Some(SqlValue::Text("NIGHT OF FIRE".to_string()))
    );
}
