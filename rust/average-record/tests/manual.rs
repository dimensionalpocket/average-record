//! Mirrors the hand-written `Model` example in `rust/README.md` to ensure the documented
//! macro-free API compiles.

use average_record::{Model, ModelHooks, Result, SqlValue};
use sqlx::{Row, sqlite::SqliteRow};

pub struct User {
    pub id: Option<i64>,
    pub team_id: i64,
    pub name: String,
    pub locked: bool,
    pub created_at: String,
    pub updated_at: String,
    /// Not persisted.
    pub team_name: Option<String>,
}

impl Model for User {
    const TABLE_NAME: &'static str = "users";
    const PRIMARY_KEY: &'static str = "id";
    const COLUMNS: &'static [&'static str] = &[
        "id",
        "team_id",
        "name",
        "locked",
        "created_at",
        "updated_at",
    ];
    const REDACTED_COLUMNS: &'static [&'static str] = &[];

    fn from_row(row: &SqliteRow) -> Result<Self> {
        Ok(Self {
            id: row.try_get("id")?,
            team_id: row.try_get("team_id")?,
            name: row.try_get("name")?,
            locked: row.try_get("locked")?,
            created_at: row.try_get("created_at")?,
            updated_at: row.try_get("updated_at")?,
            team_name: row.try_get("team_name").ok(),
        })
    }

    fn to_values(&self) -> Vec<SqlValue> {
        vec![
            self.id.into(),
            self.team_id.into(),
            self.name.clone().into(),
            self.locked.into(),
            self.created_at.clone().into(),
            self.updated_at.clone().into(),
        ]
    }
}

impl ModelHooks for User {}

#[test]
fn manual_model_matches_the_documented_shape() {
    assert_eq!(User::COLUMNS.len(), 6);
    assert_eq!(User::query().to_sql().sql, "SELECT * FROM users");
    let user = User {
        id: None,
        team_id: 1,
        name: "Alice".to_string(),
        locked: true,
        created_at: String::new(),
        updated_at: String::new(),
        team_name: None,
    };
    assert!(user.is_new());
    assert_eq!(user.to_values().len(), User::COLUMNS.len());
}
