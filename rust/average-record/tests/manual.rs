//! Mirrors the hand-written `Model` example in `README-RUST.md` to ensure the documented
//! macro-free API compiles.

use average_record::{Model, ModelHooks, Result, SqlValue};
use sqlx::{Row, sqlite::SqliteRow};

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
        "id",
        "artist_id",
        "title",
        "locked",
        "created_at",
        "updated_at",
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

#[test]
fn manual_model_matches_the_documented_shape() {
    assert_eq!(Song::COLUMNS.len(), 6);
    assert_eq!(Song::query().to_sql().sql, "SELECT * FROM songs");
    let song = Song {
        id: None,
        artist_id: 1,
        title: "NIGHT OF FIRE".to_string(),
        locked: true,
        created_at: String::new(),
        updated_at: String::new(),
        artist_name: None,
    };
    assert!(song.is_new());
    assert_eq!(song.to_values().len(), Song::COLUMNS.len());
}
