use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// A single validation failure, keyed by the offending column (or column path).
///
/// Returned by [`ModelHooks::validate`](crate::ModelHooks::validate) and
/// [`ModelHooks::validate_custom`](crate::ModelHooks::validate_custom), and wrapped in
/// [`Error::Validation`](crate::Error::Validation) when a save aborts.
///
/// The crate never produces human-readable text: [`code`](Self::code) identifies the failure and
/// [`params`](Self::params) carries the values the host needs to interpolate its own translation.
/// One column may appear more than once, once per failed rule.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ValidationError {
    /// The offending column, or a dot-joined path for nested data (`author.name`, `tags.0`).
    pub column: String,
    /// Stable, translatable identifier: `"length"`, `"required"`, `"email"`, a model-defined code
    /// passed to [`ValidationError::new`], and so on.
    pub code: String,
    /// Interpolation values for the host's translation (for example `{"min": 3}`).
    ///
    /// Never contains the submitted value, so the array can be returned to a client verbatim.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub params: Map<String, Value>,
}

impl ValidationError {
    /// Builds a new validation error from a column and a code.
    pub fn new(column: impl Into<String>, code: impl Into<String>) -> Self {
        Self {
            column: column.into(),
            code: code.into(),
            params: Map::new(),
        }
    }

    /// Adds one interpolation value.
    pub fn with_param(mut self, key: impl Into<String>, value: impl Into<Value>) -> Self {
        self.params.insert(key.into(), value.into());
        self
    }

    /// Replaces the interpolation values.
    pub fn with_params(mut self, params: Map<String, Value>) -> Self {
        self.params = params;
        self
    }
}

/// Maps a `validator` report into this crate's flat, code-based shape.
///
/// Flattens nested structs and lists into dot-joined column paths, drops the submitted value from
/// `params` (rules such as `length` echo it back, which would leak password fields), and sorts by
/// `(column, code)` so the result does not depend on `validator`'s hash-map iteration order.
#[doc(hidden)]
pub fn collect(report: &validator::ValidationErrors) -> Vec<ValidationError> {
    let mut errors = Vec::new();
    collect_into(report, "", &mut errors);
    errors.sort_by(|left, right| (&left.column, &left.code).cmp(&(&right.column, &right.code)));
    errors
}

fn collect_into(
    report: &validator::ValidationErrors,
    prefix: &str,
    errors: &mut Vec<ValidationError>,
) {
    for (field, kind) in report.errors() {
        // `validator` keys struct-level errors under `__all__`; Bun reports those with an empty
        // column, so drop the sentinel and keep the parent path.
        let path = match (prefix.is_empty(), field.as_ref()) {
            (_, "__all__") => prefix.to_string(),
            (true, field) => field.to_string(),
            (false, field) => format!("{prefix}.{field}"),
        };

        match kind {
            validator::ValidationErrorsKind::Field(field_errors) => {
                for error in field_errors {
                    let mut params = Map::new();
                    for (key, value) in &error.params {
                        if key != "value" {
                            params.insert(key.to_string(), value.clone());
                        }
                    }
                    errors.push(ValidationError {
                        column: path.clone(),
                        code: error.code.to_string(),
                        params,
                    });
                }
            }
            validator::ValidationErrorsKind::Struct(inner) => collect_into(inner, &path, errors),
            validator::ValidationErrorsKind::List(list) => {
                for (index, inner) in list {
                    collect_into(inner, &format!("{path}.{index}"), errors);
                }
            }
        }
    }
}
