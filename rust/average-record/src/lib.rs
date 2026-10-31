//! A lightweight, fully async, Active-Record-style ORM for SQLite.
//!
//! The host application owns the database (its pool, PRAGMAs, and data folder); this crate
//! provides the model, query, and migration layer on top of the connection you give it.
//!
//! # Connection model
//!
//! Every read, write, validation, and migration takes an explicit `&mut SqliteConnection` (or
//! `&mut Transaction<'_, Sqlite>`). Acquire one connection per unit of work and pass it down so
//! related reads and writes see each other.
//!
//! ```
//! # use average_record::{Model, ModelHooks, Result};
//! # use sqlx::SqliteConnection;
//! # #[derive(Model)]
//! # #[model(table = "songs")]
//! # struct Song { #[model(primary_key)] id: Option<i64>, title: String }
//! # impl ModelHooks for Song {}
//! # async fn example(conn: &mut SqliteConnection, mut song: Song) -> Result<()> {
//! song.save(conn).await?;
//! let found = Song::find(conn, song.id.unwrap_or_default()).await?;
//! # let _ = found;
//! # Ok(())
//! # }
//! ```

#![allow(async_fn_in_trait)]
#![forbid(unsafe_code)]

mod changes;
mod error;
mod model;
mod query;
#[cfg(test)]
mod test_support;
mod validation;

/// Migration runner and options.
pub mod migrations;

#[cfg(feature = "derive")]
pub use average_record_derive::Model;

pub use changes::{Change, Changes, TrackedChanges};
pub use error::{Error, Result};
pub use model::{Model, ModelHooks, SaveOptions};
pub use query::{Direction, GeneratedSql, Query, SqlValue, ValueMap};
pub use validation::ValidationError;

#[cfg(feature = "cli")]
pub use migrations::MigrationExecutor;
pub use migrations::{MigrationDirection, Migrator, MigratorOptions};

/// Implementation details re-exported for the derive macro. Not part of the public API.
#[doc(hidden)]
pub mod __private {
    pub use garde;
    pub use serde;
    pub use serde_json;
    pub use sqlx;
}
