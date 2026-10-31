use std::path::PathBuf;

use clap::Parser;
use sqlx::SqliteConnection;

use super::{MigrationDirection, Migrator, MigratorOptions};
use crate::error::{Error, Result};

#[derive(Debug, Parser)]
#[command(name = "migrate", about = "Run SQLite migrations up or down")]
struct Args {
    /// Apply pending migrations (default).
    #[arg(long)]
    up: bool,

    /// Roll back applied migrations.
    #[arg(long)]
    down: bool,

    /// Target version.
    #[arg(short = 'v', long)]
    version: Option<i64>,

    /// Path to the migrations directory.
    #[arg(long)]
    migrations_dir: Option<PathBuf>,

    /// Output path for the schema dump.
    #[arg(long)]
    schema_path: Option<PathBuf>,

    /// Dump the schema after migrating.
    #[arg(long)]
    dump: bool,

    /// Suppress progress output.
    #[arg(long)]
    silent: bool,

    /// Base directory for resolving relative paths.
    #[arg(long)]
    pwd: Option<PathBuf>,
}

/// A `clap`-based CLI wrapper around [`Migrator`].
///
/// The provided [`MigratorOptions`] act as defaults; command-line flags override them.
#[derive(Debug, Clone)]
pub struct MigrationExecutor {
    defaults: MigratorOptions,
}

impl MigrationExecutor {
    /// Builds an executor with the supplied default options.
    pub fn new(defaults: MigratorOptions) -> Self {
        Self { defaults }
    }

    /// Parses `argv`, merges it into the defaults, and runs the migrations on `conn`.
    pub async fn run(self, conn: &mut SqliteConnection) -> Result<()> {
        let args = Args::try_parse().map_err(|error| Error::Migration(error.to_string()))?;

        let mut options = self.defaults;
        if args.up {
            options.direction = MigrationDirection::Up;
        } else if args.down {
            options.direction = MigrationDirection::Down;
        }
        if args.version.is_some() {
            options.version = args.version;
        }
        if let Some(pwd) = args.pwd {
            options.pwd = pwd;
        }
        if let Some(migrations_dir) = args.migrations_dir {
            options.migrations_dir = migrations_dir;
        }
        if let Some(schema_path) = args.schema_path {
            options.schema_path = Some(schema_path);
        }
        if args.dump {
            options.dump = true;
        }
        if args.silent {
            options.silent = true;
        }

        Migrator::new(options).run(conn).await
    }
}
