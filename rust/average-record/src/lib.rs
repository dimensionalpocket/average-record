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
//! # Timestamps
//!
//! Writes stamp [`Model::TIMESTAMPS`]: by default `created_at`/`updated_at` as ISO-8601 text, or
//! `created_ts`/`updated_ts` as epoch milliseconds when a model opts in with
//! `#[model(timestamps = "epoch_millis")]`.
//!
//! ```
//! # use average_record::{Model, ModelHooks, Result};
//! # use sqlx::SqliteConnection;
//! # #[derive(Model)]
//! # #[model(table = "users")]
//! # struct User { #[model(primary_key)] id: i64, name: String }
//! # impl ModelHooks for User {}
//! # async fn example(conn: &mut SqliteConnection, mut user: User) -> Result<()> {
//! user.save(conn).await?;
//! let found = User::find(conn, user.id).await?;
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
pub use model::{Model, ModelHooks, SaveOptions, TimestampFormat, Timestamps};
pub use query::{Direction, GeneratedSql, Query, SqlValue, ValueMap};
pub use validation::ValidationError;

#[cfg(feature = "cli")]
pub use migrations::MigrationExecutor;
pub use migrations::{MigrationDirection, Migrator, MigratorOptions};

/// Implementation details re-exported for the derive macro. Not part of the public API.
#[doc(hidden)]
pub mod __private {
    pub use crate::validation::collect as validation_errors;
    pub use serde;
    pub use serde_json;
    pub use sqlx;
    pub use validator;
}
