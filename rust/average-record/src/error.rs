use crate::validation::ValidationError;

/// Convenience alias for results returned by this crate.
///
/// `Result<T>` is shorthand for `Result<T, average_record::Error>`.
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// The single error type returned by every fallible crate API.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// One or more validation rules failed.
    #[error("validation failed: {0:?}")]
    Validation(Vec<ValidationError>),

    /// An error raised by the underlying SQLite driver.
    #[error(transparent)]
    Sqlite(#[from] sqlx::Error),

    /// A filesystem error, raised while reading migrations or dumping the schema.
    #[error(transparent)]
    Io(#[from] std::io::Error),

    /// A migration error (missing migration, invalid version, and so on).
    #[error("migration error: {0}")]
    Migration(String),

    /// A general record/query error (unknown column, empty select list, and so on).
    #[error("record error: {0}")]
    Record(String),
}
