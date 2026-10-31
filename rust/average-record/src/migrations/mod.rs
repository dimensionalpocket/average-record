//! A connection-based migration runner compatible with the
//! `{version}_{name}.{up,down}.sql` convention and the `schema_migrations` tracking table.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::PathBuf;

use sqlx::{AssertSqlSafe, Row, Sqlite, SqliteConnection};

use crate::error::{Error, Result};

#[cfg(feature = "cli")]
mod cli;

#[cfg(feature = "cli")]
pub use cli::MigrationExecutor;

const MIGRATIONS_TABLE: &str = "schema_migrations";

/// The direction a [`Migrator`] runs in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MigrationDirection {
    /// Apply pending migrations.
    #[default]
    Up,
    /// Roll back applied migrations.
    Down,
}

/// Configuration for a [`Migrator`].
#[derive(Debug, Clone)]
pub struct MigratorOptions {
    /// Base directory for resolving relative paths.
    pub pwd: PathBuf,
    /// Path to the migrations directory, relative to `pwd`.
    pub migrations_dir: PathBuf,
    /// Output path for the schema dump, relative to `pwd`. Required only when `dump` is `true`.
    pub schema_path: Option<PathBuf>,
    /// Migration direction.
    pub direction: MigrationDirection,
    /// Target version. `None` means latest (up) or one step (down).
    pub version: Option<i64>,
    /// Dump the schema after migrating.
    pub dump: bool,
    /// Suppress progress output.
    pub silent: bool,
}

impl Default for MigratorOptions {
    fn default() -> Self {
        Self {
            pwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            migrations_dir: PathBuf::from("migrations"),
            schema_path: None,
            direction: MigrationDirection::Up,
            version: None,
            dump: false,
            silent: false,
        }
    }
}

#[derive(Debug, Default)]
struct Migration {
    up: String,
    down: String,
    up_file: Option<String>,
    down_file: Option<String>,
}

/// Executes SQL migrations up or down, tracks applied versions, and optionally dumps the schema.
///
/// The runner takes a caller-provided connection; it never opens a database or owns a pool.
#[derive(Debug, Clone)]
pub struct Migrator {
    options: MigratorOptions,
}

impl Migrator {
    /// Builds a migrator from the given options.
    pub fn new(options: MigratorOptions) -> Self {
        Self { options }
    }

    /// Runs the configured migrations and, when requested, dumps the schema.
    pub async fn run(&self, conn: &mut SqliteConnection) -> Result<()> {
        self.ensure_migrations_table(conn).await?;

        let applied = self.applied_migrations(conn).await?;
        let available = self.available_migrations()?;

        match self.options.direction {
            MigrationDirection::Up => self.run_up(conn, &applied, &available).await?,
            MigrationDirection::Down => self.run_down(conn, &applied, &available).await?,
        }

        if self.options.dump {
            self.dump_schema(conn).await?;
        }

        Ok(())
    }

    fn log(&self, message: impl AsRef<str>) {
        if !self.options.silent {
            tracing::info!("{}", message.as_ref());
        }
    }

    async fn ensure_migrations_table(&self, conn: &mut SqliteConnection) -> Result<()> {
        let sql =
            format!("CREATE TABLE IF NOT EXISTS {MIGRATIONS_TABLE} (version INTEGER PRIMARY KEY)");
        sqlx::query::<Sqlite>(AssertSqlSafe(sql))
            .execute(conn)
            .await?;
        Ok(())
    }

    async fn applied_migrations(&self, conn: &mut SqliteConnection) -> Result<HashSet<i64>> {
        let sql = format!("SELECT version FROM {MIGRATIONS_TABLE}");
        let rows = sqlx::query::<Sqlite>(AssertSqlSafe(sql))
            .fetch_all(conn)
            .await?;
        let mut applied = HashSet::with_capacity(rows.len());
        for row in rows {
            applied.insert(row.try_get::<i64, _>("version")?);
        }
        Ok(applied)
    }

    fn available_migrations(&self) -> Result<BTreeMap<i64, Migration>> {
        let dir = self.options.pwd.join(&self.options.migrations_dir);
        let mut migrations: BTreeMap<i64, Migration> = BTreeMap::new();

        if !dir.exists() {
            return Ok(migrations);
        }

        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let Some((version, direction, _name)) = parse_migration_file(&file_name) else {
                continue;
            };
            if version == 0 {
                return Err(Error::Migration(format!(
                    "migration version 0 is reserved and cannot be used: {file_name}"
                )));
            }

            let sql = fs::read_to_string(entry.path())?;
            let migration = migrations.entry(version).or_default();
            match direction {
                "up" => {
                    migration.up = sql;
                    migration.up_file = Some(file_name);
                }
                _ => {
                    migration.down = sql;
                    migration.down_file = Some(file_name);
                }
            }
        }

        Ok(migrations)
    }

    async fn run_up(
        &self,
        conn: &mut SqliteConnection,
        applied: &HashSet<i64>,
        available: &BTreeMap<i64, Migration>,
    ) -> Result<()> {
        let mut pending: Vec<i64> = available
            .keys()
            .copied()
            .filter(|version| !applied.contains(version))
            .collect();
        pending.sort_unstable();

        let target = self
            .options
            .version
            .unwrap_or_else(|| pending.last().copied().unwrap_or(0));
        let to_run: Vec<i64> = pending
            .into_iter()
            .filter(|version| *version <= target)
            .collect();

        if to_run.is_empty() {
            self.log("No pending migrations.");
            return Ok(());
        }

        for version in to_run {
            let migration = available
                .get(&version)
                .expect("version came from the available map");
            if migration.up.is_empty() {
                return Err(Error::Migration(format!(
                    "missing up migration for version {version}"
                )));
            }
            self.log(format!(
                "Migrating up: {version} ({})",
                migration.up_file.as_deref().unwrap_or("")
            ));
            execute_sql(conn, &migration.up).await?;
            let sql = format!("INSERT INTO {MIGRATIONS_TABLE} (version) VALUES (?)");
            sqlx::query::<Sqlite>(AssertSqlSafe(sql))
                .bind(version)
                .execute(&mut *conn)
                .await?;
        }

        Ok(())
    }

    async fn run_down(
        &self,
        conn: &mut SqliteConnection,
        applied: &HashSet<i64>,
        available: &BTreeMap<i64, Migration>,
    ) -> Result<()> {
        let mut executed: Vec<i64> = applied.iter().copied().collect();
        executed.sort_unstable_by(|a, b| b.cmp(a));

        let target = match self.options.version {
            Some(version) => version,
            None => executed.get(1).copied().unwrap_or(0),
        };
        let to_run: Vec<i64> = executed
            .into_iter()
            .filter(|version| *version > target)
            .collect();

        if to_run.is_empty() {
            self.log("No migrations to roll back.");
            return Ok(());
        }

        for version in to_run {
            let Some(migration) = available.get(&version) else {
                return Err(Error::Migration(format!(
                    "missing down migration for version {version}"
                )));
            };
            if migration.down.is_empty() {
                return Err(Error::Migration(format!(
                    "missing down migration for version {version}"
                )));
            }
            self.log(format!(
                "Migrating down: {version} ({})",
                migration.down_file.as_deref().unwrap_or("")
            ));
            execute_sql(conn, &migration.down).await?;
            let sql = format!("DELETE FROM {MIGRATIONS_TABLE} WHERE version = ?");
            sqlx::query::<Sqlite>(AssertSqlSafe(sql))
                .bind(version)
                .execute(&mut *conn)
                .await?;
        }

        Ok(())
    }

    async fn dump_schema(&self, conn: &mut SqliteConnection) -> Result<()> {
        let schema_path = self.options.schema_path.as_ref().ok_or_else(|| {
            Error::Migration("dump requested but schema_path is not set".to_string())
        })?;
        let output_path = self.options.pwd.join(schema_path);

        let rows = sqlx::query::<Sqlite>(
            "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY tbl_name, type DESC",
        )
        .fetch_all(conn)
        .await?;

        let statements: Vec<String> = rows
            .iter()
            .map(|row| row.try_get::<String, _>("sql").map(|sql| format!("{sql};")))
            .collect::<std::result::Result<_, _>>()?;
        let output = statements.join("\n\n");

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&output_path, output)?;

        self.log(format!("Schema dumped to {}", output_path.display()));
        Ok(())
    }
}

async fn execute_sql(conn: &mut SqliteConnection, sql: &str) -> Result<()> {
    sqlx::raw_sql(AssertSqlSafe(sql.to_string()))
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Parses `{version}_{name}.{up|down}.sql` into `(version, direction, name)`.
fn parse_migration_file(file_name: &str) -> Option<(i64, &'static str, String)> {
    let (stem, direction) = if let Some(stem) = file_name.strip_suffix(".up.sql") {
        (stem, "up")
    } else {
        let stem = file_name.strip_suffix(".down.sql")?;
        (stem, "down")
    };

    let (version_str, name) = stem.split_once('_')?;
    if version_str.is_empty()
        || !version_str
            .chars()
            .all(|character| character.is_ascii_digit())
        || name.is_empty()
    {
        return None;
    }

    let version = version_str.parse().ok()?;
    Some((version, direction, name.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::memory_connection;
    use std::path::Path;

    fn write(dir: &Path, name: &str, sql: &str) {
        fs::write(dir.join(name), sql).unwrap();
    }

    fn setup() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let migrations = temp.path().join("migrations");
        fs::create_dir_all(&migrations).unwrap();
        (temp, migrations)
    }

    async fn applied_versions(conn: &mut SqliteConnection) -> Vec<i64> {
        let rows = sqlx::query(AssertSqlSafe(format!(
            "SELECT version FROM {MIGRATIONS_TABLE} ORDER BY version"
        )))
        .fetch_all(conn)
        .await
        .unwrap();
        rows.iter()
            .map(|row| row.try_get::<i64, _>("version").unwrap())
            .collect()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn runs_up_and_down() {
        let (temp, _migrations) = setup();
        let migrations_dir = temp.path().join("migrations");
        write(
            &migrations_dir,
            "20250101000000_create_foo.up.sql",
            "CREATE TABLE foo (id INTEGER PRIMARY KEY);",
        );
        write(
            &migrations_dir,
            "20250101000000_create_foo.down.sql",
            "DROP TABLE foo;",
        );
        write(
            &migrations_dir,
            "20250102000000_create_bar.up.sql",
            "CREATE TABLE bar (id INTEGER PRIMARY KEY);",
        );
        write(
            &migrations_dir,
            "20250102000000_create_bar.down.sql",
            "DROP TABLE bar;",
        );

        let mut conn = memory_connection().await;
        let options = MigratorOptions {
            pwd: temp.path().to_path_buf(),
            migrations_dir: "migrations".into(),
            silent: true,
            ..Default::default()
        };
        Migrator::new(options.clone()).run(&mut conn).await.unwrap();
        assert_eq!(
            applied_versions(&mut conn).await,
            vec![20250101000000, 20250102000000]
        );
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE name = 'foo'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(count, 1);

        let mut down = options;
        down.direction = MigrationDirection::Down;
        Migrator::new(down).run(&mut conn).await.unwrap();
        assert_eq!(applied_versions(&mut conn).await, vec![20250101000000]);

        let dropped: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE name = 'bar'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(dropped, 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rejects_version_zero() {
        let (temp, _migrations) = setup();
        let migrations_dir = temp.path().join("migrations");
        write(&migrations_dir, "0_bad.up.sql", "SELECT 1;");

        let mut conn = memory_connection().await;
        let options = MigratorOptions {
            pwd: temp.path().to_path_buf(),
            migrations_dir: "migrations".into(),
            silent: true,
            ..Default::default()
        };
        let error = Migrator::new(options).run(&mut conn).await.unwrap_err();
        assert!(matches!(error, Error::Migration(message) if message.contains("version 0")));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn errors_when_down_migration_is_missing() {
        let (temp, _migrations) = setup();
        let migrations_dir = temp.path().join("migrations");
        write(
            &migrations_dir,
            "20250101000000_create_foo.up.sql",
            "CREATE TABLE foo (id INTEGER PRIMARY KEY);",
        );

        let mut conn = memory_connection().await;
        let up = MigratorOptions {
            pwd: temp.path().to_path_buf(),
            migrations_dir: "migrations".into(),
            silent: true,
            ..Default::default()
        };
        Migrator::new(up.clone()).run(&mut conn).await.unwrap();

        let down = MigratorOptions {
            direction: MigrationDirection::Down,
            ..up
        };
        let error = Migrator::new(down).run(&mut conn).await.unwrap_err();
        assert!(matches!(error, Error::Migration(message) if message.contains("missing down")));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn dumps_the_schema() {
        let (temp, _migrations) = setup();
        let migrations_dir = temp.path().join("migrations");
        write(
            &migrations_dir,
            "20250101000000_create_foo.up.sql",
            "CREATE TABLE foo (id INTEGER PRIMARY KEY);",
        );

        let mut conn = memory_connection().await;
        let options = MigratorOptions {
            pwd: temp.path().to_path_buf(),
            migrations_dir: "migrations".into(),
            schema_path: Some("schema.sql".into()),
            dump: true,
            silent: true,
            ..Default::default()
        };
        Migrator::new(options).run(&mut conn).await.unwrap();

        let schema = fs::read_to_string(temp.path().join("schema.sql")).unwrap();
        assert!(schema.contains("CREATE TABLE foo"));
        assert!(schema.contains("schema_migrations"));
    }
}
