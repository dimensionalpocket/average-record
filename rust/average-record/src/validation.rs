/// A single validation failure, keyed by the offending column name.
///
/// Returned by [`ModelHooks::validate`](crate::ModelHooks::validate) and
/// [`ModelHooks::validate_custom`](crate::ModelHooks::validate_custom), and wrapped in
/// [`Error::Validation`](crate::Error::Validation) when a save aborts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationError {
    /// The column the error applies to.
    pub column: String,
    /// A human-readable message describing the failure.
    pub message: String,
}

impl ValidationError {
    /// Builds a new validation error.
    pub fn new(column: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            column: column.into(),
            message: message.into(),
        }
    }
}
