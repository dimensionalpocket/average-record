use std::collections::HashMap;
use std::fmt;
use std::marker::PhantomData;

use futures_core::stream::BoxStream;
use futures_util::StreamExt;
use serde_json::Value;
use sqlx::sqlite::SqliteRow;
use sqlx::{AssertSqlSafe, Column, Row, Sqlite, SqliteConnection, TypeInfo, ValueRef};

use crate::error::{Error, Result};
use crate::model::Model;

/// A row decoded into a map of column name to [`SqlValue`].
pub type ValueMap = HashMap<String, SqlValue>;

/// An owned value mirroring SQLite's storage classes, used for bind parameters and raw rows.
#[derive(Debug, Clone, PartialEq)]
pub enum SqlValue {
    /// SQL `NULL`.
    Null,
    /// A 64-bit signed integer.
    Integer(i64),
    /// A 64-bit float.
    Real(f64),
    /// A UTF-8 text value.
    Text(String),
    /// A binary blob.
    Blob(Vec<u8>),
}

impl SqlValue {
    /// Returns the value as a string slice, if it is text.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            SqlValue::Text(text) => Some(text),
            _ => None,
        }
    }

    /// Returns the value as an integer, if it is an integer.
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            SqlValue::Integer(value) => Some(*value),
            _ => None,
        }
    }

    /// Returns the value as a float, if it is a float.
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            SqlValue::Real(value) => Some(*value),
            _ => None,
        }
    }

    /// Returns the value as a boolean, decoding any non-zero integer as `true`.
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            SqlValue::Integer(value) => Some(*value != 0),
            SqlValue::Real(value) => Some(*value != 0.0),
            SqlValue::Blob(_) | SqlValue::Null | SqlValue::Text(_) => None,
        }
    }

    /// Returns `true` for [`SqlValue::Null`].
    pub fn is_null(&self) -> bool {
        matches!(self, SqlValue::Null)
    }

    /// Renders the value as a [`serde_json::Value`].
    pub fn to_json(&self) -> Value {
        match self {
            SqlValue::Null => Value::Null,
            SqlValue::Integer(value) => Value::from(*value),
            SqlValue::Real(value) => Value::from(*value),
            SqlValue::Text(text) => Value::String(text.clone()),
            SqlValue::Blob(bytes) => {
                Value::Array(bytes.iter().map(|byte| Value::from(*byte)).collect())
            }
        }
    }
}

impl sqlx::Type<Sqlite> for SqlValue {
    fn type_info() -> sqlx::sqlite::SqliteTypeInfo {
        <String as sqlx::Type<Sqlite>>::type_info()
    }

    fn compatible(_ty: &sqlx::sqlite::SqliteTypeInfo) -> bool {
        true
    }
}

impl<'q> sqlx::Encode<'q, Sqlite> for SqlValue {
    fn encode_by_ref(
        &self,
        buffer: &mut <Sqlite as sqlx::Database>::ArgumentBuffer,
    ) -> std::result::Result<sqlx::encode::IsNull, sqlx::error::BoxDynError> {
        match self {
            SqlValue::Null => Ok(sqlx::encode::IsNull::Yes),
            SqlValue::Integer(value) => value.encode_by_ref(buffer),
            SqlValue::Real(value) => value.encode_by_ref(buffer),
            SqlValue::Text(text) => text.as_str().encode_by_ref(buffer),
            SqlValue::Blob(bytes) => bytes.as_slice().encode_by_ref(buffer),
        }
    }
}

impl<T: Into<SqlValue>> From<Option<T>> for SqlValue {
    fn from(value: Option<T>) -> Self {
        value.map(Into::into).unwrap_or(SqlValue::Null)
    }
}

impl<T: Clone + Into<SqlValue>> From<&Option<T>> for SqlValue {
    fn from(value: &Option<T>) -> Self {
        value.clone().map(Into::into).unwrap_or(SqlValue::Null)
    }
}

impl From<&SqlValue> for SqlValue {
    fn from(value: &SqlValue) -> Self {
        value.clone()
    }
}

impl From<bool> for SqlValue {
    fn from(value: bool) -> Self {
        SqlValue::Integer(i64::from(value))
    }
}

impl From<&bool> for SqlValue {
    fn from(value: &bool) -> Self {
        SqlValue::Integer(i64::from(*value))
    }
}

impl From<f64> for SqlValue {
    fn from(value: f64) -> Self {
        SqlValue::Real(value)
    }
}

impl From<&f64> for SqlValue {
    fn from(value: &f64) -> Self {
        SqlValue::Real(*value)
    }
}

impl From<&str> for SqlValue {
    fn from(value: &str) -> Self {
        SqlValue::Text(value.to_string())
    }
}

impl From<String> for SqlValue {
    fn from(value: String) -> Self {
        SqlValue::Text(value)
    }
}

impl From<&String> for SqlValue {
    fn from(value: &String) -> Self {
        SqlValue::Text(value.clone())
    }
}

impl From<Vec<u8>> for SqlValue {
    fn from(value: Vec<u8>) -> Self {
        SqlValue::Blob(value)
    }
}

impl From<&[u8]> for SqlValue {
    fn from(value: &[u8]) -> Self {
        SqlValue::Blob(value.to_vec())
    }
}

macro_rules! impl_sql_value_integer {
    ($($ty:ty),* $(,)?) => {
        $(
            impl From<$ty> for SqlValue {
                fn from(value: $ty) -> Self {
                    SqlValue::Integer(value as i64)
                }
            }

            impl From<&$ty> for SqlValue {
                fn from(value: &$ty) -> Self {
                    SqlValue::Integer(*value as i64)
                }
            }
        )*
    };
}

impl_sql_value_integer!(i8, i16, i32, i64, u8, u16, u32);

/// Sort direction for [`Query::order_by`] and [`Query::order_by_raw`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// Ascending order.
    Asc,
    /// Descending order.
    Desc,
}

impl Direction {
    /// Returns the SQL keyword for the direction.
    pub fn as_str(self) -> &'static str {
        match self {
            Direction::Asc => "ASC",
            Direction::Desc => "DESC",
        }
    }
}

impl fmt::Display for Direction {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// The SQL text and bind parameters produced by [`Query::to_sql`].
#[derive(Debug, Clone, PartialEq)]
pub struct GeneratedSql {
    /// The generated SQL string.
    pub sql: String,
    /// The bind parameters, in placeholder order.
    pub params: Vec<SqlValue>,
}

/// A fluent, connection-agnostic query builder for a model `M`.
///
/// The builder holds no database handle; terminals take a connection.
pub struct Query<M: Model> {
    model: PhantomData<M>,
    conditions: Vec<String>,
    params: Vec<SqlValue>,
    joins: Vec<String>,
    join_params: Vec<SqlValue>,
    order_by: Vec<String>,
    limit: Option<i64>,
    offset: Option<i64>,
    select: Vec<String>,
}

impl<M: Model> Default for Query<M> {
    fn default() -> Self {
        Self::new()
    }
}

impl<M: Model> Clone for Query<M> {
    fn clone(&self) -> Self {
        Self {
            model: PhantomData,
            conditions: self.conditions.clone(),
            params: self.params.clone(),
            joins: self.joins.clone(),
            join_params: self.join_params.clone(),
            order_by: self.order_by.clone(),
            limit: self.limit,
            offset: self.offset,
            select: self.select.clone(),
        }
    }
}

impl<M: Model> Query<M> {
    pub(crate) fn new() -> Self {
        Self {
            model: PhantomData,
            conditions: Vec::new(),
            params: Vec::new(),
            joins: Vec::new(),
            join_params: Vec::new(),
            order_by: Vec::new(),
            limit: None,
            offset: None,
            select: vec!["*".to_string()],
        }
    }

    /// Appends a fragment to the `SELECT` list.
    pub fn select(mut self, fragment: impl Into<String>) -> Self {
        self.select.push(fragment.into());
        self
    }

    /// Clears the `SELECT` list. Call [`Query::select`] before consuming the query.
    pub fn select_clear(mut self) -> Self {
        self.select.clear();
        self
    }

    /// Appends a raw SQL join fragment after the `FROM` clause.
    ///
    /// Returns an error when the number of `?` placeholders does not match `params`.
    pub fn join<I, V>(mut self, sql: impl Into<String>, params: I) -> Result<Self>
    where
        I: IntoIterator<Item = V>,
        V: Into<SqlValue>,
    {
        let sql = sql.into();
        let params: Vec<SqlValue> = params.into_iter().map(Into::into).collect();
        ensure_placeholder_arity("join", &sql, params.len())?;
        self.joins.push(sql);
        self.join_params.extend(params);
        Ok(self)
    }

    /// Adds a `column = ?` condition.
    pub fn where_eq(self, column: impl Into<String>, value: impl Into<SqlValue>) -> Result<Self> {
        self.where_op(column, "=", value)
    }

    /// Adds a `column != ?` condition.
    pub fn where_ne(self, column: impl Into<String>, value: impl Into<SqlValue>) -> Result<Self> {
        self.where_op(column, "!=", value)
    }

    /// Adds a `column > ?` condition.
    pub fn where_gt(self, column: impl Into<String>, value: impl Into<SqlValue>) -> Result<Self> {
        self.where_op(column, ">", value)
    }

    /// Adds a `column >= ?` condition.
    pub fn where_gte(self, column: impl Into<String>, value: impl Into<SqlValue>) -> Result<Self> {
        self.where_op(column, ">=", value)
    }

    /// Adds a `column < ?` condition.
    pub fn where_lt(self, column: impl Into<String>, value: impl Into<SqlValue>) -> Result<Self> {
        self.where_op(column, "<", value)
    }

    /// Adds a `column <= ?` condition.
    pub fn where_lte(self, column: impl Into<String>, value: impl Into<SqlValue>) -> Result<Self> {
        self.where_op(column, "<=", value)
    }

    fn where_op(
        mut self,
        column: impl Into<String>,
        operator: &'static str,
        value: impl Into<SqlValue>,
    ) -> Result<Self> {
        let column = column.into();
        ensure_column::<M>(&column)?;
        self.conditions.push(format!("{column} {operator} ?"));
        self.params.push(value.into());
        Ok(self)
    }

    /// Adds a `column IN (?, ?, ...)` condition.
    pub fn where_in<I, V>(mut self, column: impl Into<String>, values: I) -> Result<Self>
    where
        I: IntoIterator<Item = V>,
        V: Into<SqlValue>,
    {
        let column = column.into();
        ensure_column::<M>(&column)?;
        let values: Vec<SqlValue> = values.into_iter().map(Into::into).collect();
        let placeholders = vec!["?"; values.len()].join(", ");
        self.conditions
            .push(format!("{column} IN ({placeholders})"));
        self.params.extend(values);
        Ok(self)
    }

    /// Adds a `column NOT IN (?, ?, ...)` condition.
    pub fn where_not_in<I, V>(mut self, column: impl Into<String>, values: I) -> Result<Self>
    where
        I: IntoIterator<Item = V>,
        V: Into<SqlValue>,
    {
        let column = column.into();
        ensure_column::<M>(&column)?;
        let values: Vec<SqlValue> = values.into_iter().map(Into::into).collect();
        let placeholders = vec!["?"; values.len()].join(", ");
        self.conditions
            .push(format!("{column} NOT IN ({placeholders})"));
        self.params.extend(values);
        Ok(self)
    }

    /// Adds a raw SQL fragment with optional params.
    ///
    /// Returns an error when the number of `?` placeholders does not match `params`.
    pub fn where_raw<I, V>(mut self, sql: impl Into<String>, params: I) -> Result<Self>
    where
        I: IntoIterator<Item = V>,
        V: Into<SqlValue>,
    {
        let sql = sql.into();
        let params: Vec<SqlValue> = params.into_iter().map(Into::into).collect();
        ensure_placeholder_arity("where_raw", &sql, params.len())?;
        self.conditions.push(sql);
        self.params.extend(params);
        Ok(self)
    }

    /// Adds a fuzzy `LIKE` search: each whitespace-separated term becomes an `AND`-joined group
    /// of `column LIKE ?` conditions.
    ///
    /// A column entry containing `?` is treated as a raw fragment and bound once per placeholder.
    /// Blank terms are a no-op; zero columns is an error.
    pub fn fuzzy_search<I, S>(mut self, terms: impl AsRef<str>, columns: I) -> Result<Self>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let columns: Vec<String> = columns.into_iter().map(Into::into).collect();
        if columns.is_empty() {
            return Err(Error::Record(
                "fuzzy_search requires at least one column".to_string(),
            ));
        }

        for word in terms.as_ref().split_whitespace() {
            let pattern = format!("%{word}%");
            let mut fragments = Vec::with_capacity(columns.len());
            let mut term_params = Vec::new();
            for column in &columns {
                let placeholders = column.matches('?').count();
                if placeholders > 0 {
                    fragments.push(column.clone());
                    for _ in 0..placeholders {
                        term_params.push(SqlValue::Text(pattern.clone()));
                    }
                } else {
                    fragments.push(format!("{column} LIKE ?"));
                    term_params.push(SqlValue::Text(pattern.clone()));
                }
            }
            self.conditions
                .push(format!("({})", fragments.join(" OR ")));
            self.params.extend(term_params);
        }
        Ok(self)
    }

    /// Adds an `ORDER BY column direction` clause. `column` is validated.
    pub fn order_by(mut self, column: impl Into<String>, direction: Direction) -> Result<Self> {
        let column = column.into();
        ensure_order_column::<M>(&column)?;
        self.order_by
            .push(format!("{column} {}", direction.as_str()));
        Ok(self)
    }

    /// Adds a raw `ORDER BY` expression (for example an alias or subquery).
    pub fn order_by_raw(mut self, expression: impl Into<String>, direction: Direction) -> Self {
        self.order_by
            .push(format!("{} {}", expression.into(), direction.as_str()));
        self
    }

    /// Sets the `LIMIT` clause.
    pub fn limit(mut self, limit: i64) -> Self {
        self.limit = Some(limit);
        self
    }

    /// Sets the `OFFSET` clause.
    pub fn offset(mut self, offset: i64) -> Self {
        self.offset = Some(offset);
        self
    }

    /// Builds the SQL without executing it.
    ///
    /// Consuming a query with an empty `SELECT` list is an error at the terminal methods, not here.
    pub fn to_sql(&self) -> GeneratedSql {
        self.build_sql()
    }

    fn build_sql(&self) -> GeneratedSql {
        let mut sql = format!("SELECT {} FROM {}", self.select.join(", "), M::TABLE_NAME);
        append_joins_conditions(&mut sql, &self.joins, &self.conditions);
        if !self.order_by.is_empty() {
            sql.push_str(" ORDER BY ");
            sql.push_str(&self.order_by.join(", "));
        }
        if let Some(limit) = self.limit {
            sql.push_str(&format!(" LIMIT {limit}"));
        }
        if let Some(offset) = self.offset {
            sql.push_str(&format!(" OFFSET {offset}"));
        }
        GeneratedSql {
            sql,
            params: merge_params(&self.join_params, &self.params),
        }
    }

    fn build_sql_checked(&self) -> Result<GeneratedSql> {
        if self.select.is_empty() {
            return Err(Error::Record(
                "query select list is empty; call select() before consuming the query".to_string(),
            ));
        }
        Ok(self.build_sql())
    }

    fn build_count_sql(&self) -> GeneratedSql {
        let mut sql = format!("SELECT COUNT(*) as count FROM {}", M::TABLE_NAME);
        append_joins_conditions(&mut sql, &self.joins, &self.conditions);
        GeneratedSql {
            sql,
            params: merge_params(&self.join_params, &self.params),
        }
    }

    /// Fetches every matching row as a model instance.
    pub async fn all(self, conn: &mut SqliteConnection) -> Result<Vec<M>> {
        let generated = self.build_sql_checked()?;
        let rows = execute_fetch_all(&generated, conn).await?;
        rows.iter().map(M::from_row).collect()
    }

    /// Fetches the first matching row, or `None`.
    pub async fn first(mut self, conn: &mut SqliteConnection) -> Result<Option<M>> {
        self.limit = Some(1);
        let mut rows = self.all(conn).await?;
        Ok(if rows.is_empty() {
            None
        } else {
            Some(rows.remove(0))
        })
    }

    /// Counts matching rows, ignoring `ORDER BY`, `LIMIT`, and `OFFSET`.
    pub async fn count(self, conn: &mut SqliteConnection) -> Result<i64> {
        let generated = self.build_count_sql();
        let mut query = sqlx::query::<Sqlite>(AssertSqlSafe(generated.sql));
        for param in generated.params {
            query = query.bind(param);
        }
        let row = query.fetch_one(conn).await?;
        Ok(row.try_get("count")?)
    }

    /// Streams matching rows as model instances.
    pub fn fetch<'c>(self, conn: &'c mut SqliteConnection) -> BoxStream<'c, Result<M>>
    where
        M: 'c,
    {
        let generated = match self.build_sql_checked() {
            Ok(generated) => generated,
            Err(error) => return error_stream(error),
        };
        let mut query = sqlx::query::<Sqlite>(AssertSqlSafe(generated.sql));
        for param in generated.params {
            query = query.bind(param);
        }
        query
            .fetch(conn)
            .map(|result| {
                result
                    .map_err(Error::from)
                    .and_then(|row| M::from_row(&row))
            })
            .boxed()
    }

    /// Fetches every matching row as a raw value map.
    pub async fn all_raw(self, conn: &mut SqliteConnection) -> Result<Vec<ValueMap>> {
        let generated = self.build_sql_checked()?;
        let rows = execute_fetch_all(&generated, conn).await?;
        rows.iter().map(row_to_value_map).collect()
    }

    /// Streams matching rows as raw value maps.
    pub fn fetch_raw<'c>(self, conn: &'c mut SqliteConnection) -> BoxStream<'c, Result<ValueMap>> {
        let generated = match self.build_sql_checked() {
            Ok(generated) => generated,
            Err(error) => return error_stream(error),
        };
        let mut query = sqlx::query::<Sqlite>(AssertSqlSafe(generated.sql));
        for param in generated.params {
            query = query.bind(param);
        }
        query
            .fetch(conn)
            .map(|result| {
                result
                    .map_err(Error::from)
                    .and_then(|row| row_to_value_map(&row))
            })
            .boxed()
    }
}

fn append_joins_conditions(sql: &mut String, joins: &[String], conditions: &[String]) {
    if !joins.is_empty() {
        sql.push(' ');
        sql.push_str(&joins.join(" "));
    }
    if !conditions.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.join(" AND "));
    }
}

fn merge_params(join_params: &[SqlValue], params: &[SqlValue]) -> Vec<SqlValue> {
    let mut merged = Vec::with_capacity(join_params.len() + params.len());
    merged.extend_from_slice(join_params);
    merged.extend_from_slice(params);
    merged
}

async fn execute_fetch_all(
    generated: &GeneratedSql,
    conn: &mut SqliteConnection,
) -> Result<Vec<SqliteRow>> {
    let mut query = sqlx::query::<Sqlite>(AssertSqlSafe(generated.sql.clone()));
    for param in &generated.params {
        query = query.bind(param.clone());
    }
    Ok(query.fetch_all(conn).await?)
}

fn error_stream<'c, T: Send + 'c>(error: Error) -> BoxStream<'c, Result<T>> {
    futures_util::stream::once(async move { Err(error) }).boxed()
}

fn ensure_column<M: Model>(column: &str) -> Result<()> {
    if M::COLUMNS.contains(&column) {
        Ok(())
    } else {
        Err(Error::Record(format!(
            "unknown column `{column}` for table `{}`",
            M::TABLE_NAME
        )))
    }
}

fn ensure_order_column<M: Model>(column: &str) -> Result<()> {
    if M::COLUMNS.contains(&column) || is_qualified_identifier(column) {
        Ok(())
    } else {
        Err(Error::Record(format!(
            "unknown column `{column}` for table `{}`",
            M::TABLE_NAME
        )))
    }
}

fn is_qualified_identifier(column: &str) -> bool {
    column.contains('.')
        && column
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
}

fn ensure_placeholder_arity(context: &str, sql: &str, expected: usize) -> Result<()> {
    let actual = sql.matches('?').count();
    if actual != expected {
        return Err(Error::Record(format!(
            "{context}: {actual} placeholders but {expected} params"
        )));
    }
    Ok(())
}

/// Decodes a row into a map of column name to [`SqlValue`], preserving SQLite storage classes.
pub(crate) fn row_to_value_map(row: &SqliteRow) -> Result<ValueMap> {
    let mut map = HashMap::new();
    for (index, column) in row.columns().iter().enumerate() {
        let raw = row.try_get_raw(index)?;
        let value = if raw.is_null() {
            SqlValue::Null
        } else {
            match raw.type_info().name() {
                "INTEGER" | "INT4" | "BOOLEAN" | "NUMERIC" => {
                    SqlValue::Integer(row.try_get::<i64, _>(index)?)
                }
                "REAL" | "FLOAT" | "DOUBLE" => SqlValue::Real(row.try_get::<f64, _>(index)?),
                "BLOB" => SqlValue::Blob(row.try_get::<Vec<u8>, _>(index)?),
                _ => SqlValue::Text(row.try_get::<String, _>(index)?),
            }
        };
        map.insert(column.name().to_string(), value);
    }
    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestModel;

    fn sql(query: &Query<TestModel>) -> String {
        query.to_sql().sql
    }

    fn params(query: &Query<TestModel>) -> Vec<SqlValue> {
        query.to_sql().params
    }

    fn text(value: &str) -> SqlValue {
        SqlValue::Text(value.to_string())
    }

    #[test]
    fn defaults_to_select_star() {
        let query = TestModel::query();
        assert_eq!(sql(&query), "SELECT * FROM test_models");
        assert!(params(&query).is_empty());
    }

    #[test]
    fn appends_select_fragments() {
        let query = TestModel::query().select("name").select("status");
        assert_eq!(sql(&query), "SELECT *, name, status FROM test_models");
        assert!(params(&query).is_empty());
    }

    #[test]
    fn generates_where_clause() {
        let query = TestModel::query().where_eq("status", "active").unwrap();
        assert_eq!(sql(&query), "SELECT * FROM test_models WHERE status = ?");
        assert_eq!(params(&query), vec![text("active")]);
    }

    #[test]
    fn chains_multiple_where_conditions() {
        let query = TestModel::query()
            .where_eq("status", "active")
            .unwrap()
            .where_ne("role", "admin")
            .unwrap();
        assert_eq!(
            sql(&query),
            "SELECT * FROM test_models WHERE status = ? AND role != ?"
        );
        assert_eq!(params(&query), vec![text("active"), text("admin")]);
    }

    #[test]
    fn applies_every_comparison_operator() {
        let query = TestModel::query()
            .where_gt("score", 10)
            .unwrap()
            .where_gte("score", 10)
            .unwrap()
            .where_lt("score", 20)
            .unwrap()
            .where_lte("score", 20)
            .unwrap();
        assert_eq!(
            sql(&query),
            "SELECT * FROM test_models WHERE score > ? AND score >= ? AND score < ? AND score <= ?"
        );
        assert_eq!(
            params(&query),
            vec![
                SqlValue::Integer(10),
                SqlValue::Integer(10),
                SqlValue::Integer(20),
                SqlValue::Integer(20),
            ]
        );
    }

    #[test]
    fn generates_order_by_clauses() {
        let query = TestModel::query()
            .order_by("status", Direction::Asc)
            .unwrap()
            .order_by("name", Direction::Desc)
            .unwrap();
        assert_eq!(
            sql(&query),
            "SELECT * FROM test_models ORDER BY status ASC, name DESC"
        );
        assert!(params(&query).is_empty());
    }

    #[test]
    fn order_by_accepts_qualified_columns() {
        let query = TestModel::query()
            .order_by("s.score", Direction::Desc)
            .unwrap();
        assert_eq!(
            sql(&query),
            "SELECT * FROM test_models ORDER BY s.score DESC"
        );
        assert!(params(&query).is_empty());
    }

    #[test]
    fn order_by_raw_is_infallible() {
        let query = TestModel::query().order_by_raw("n", Direction::Desc);
        assert_eq!(sql(&query), "SELECT * FROM test_models ORDER BY n DESC");
        assert!(params(&query).is_empty());
    }

    #[test]
    fn generates_limit_offset_and_combination() {
        let query = TestModel::query().limit(10).offset(20);
        assert_eq!(sql(&query), "SELECT * FROM test_models LIMIT 10 OFFSET 20");
        assert!(params(&query).is_empty());

        let combined = TestModel::query()
            .where_eq("status", "active")
            .unwrap()
            .where_gt("score", 50)
            .unwrap()
            .order_by("score", Direction::Desc)
            .unwrap()
            .limit(10)
            .offset(20);
        assert_eq!(
            sql(&combined),
            "SELECT * FROM test_models WHERE status = ? AND score > ? ORDER BY score DESC LIMIT 10 OFFSET 20"
        );
        assert_eq!(
            params(&combined),
            vec![text("active"), SqlValue::Integer(50)]
        );
    }

    #[test]
    fn generates_in_and_not_in() {
        let query = TestModel::query()
            .where_in("status", ["active", "pending"])
            .unwrap()
            .where_not_in("role", ["admin", "moderator"])
            .unwrap();
        assert_eq!(
            sql(&query),
            "SELECT * FROM test_models WHERE status IN (?, ?) AND role NOT IN (?, ?)"
        );
        assert_eq!(
            params(&query),
            vec![
                text("active"),
                text("pending"),
                text("admin"),
                text("moderator")
            ]
        );
    }

    #[test]
    fn where_in_converts_integer_values() {
        let query = TestModel::query().where_in("score", [10, 20]).unwrap();
        assert_eq!(
            sql(&query),
            "SELECT * FROM test_models WHERE score IN (?, ?)"
        );
        assert_eq!(
            params(&query),
            vec![SqlValue::Integer(10), SqlValue::Integer(20)]
        );
    }

    #[test]
    fn where_raw_validates_placeholder_arity() {
        assert!(
            TestModel::query()
                .where_raw("status = ?", ["active", "extra"])
                .is_err()
        );
        let query = TestModel::query()
            .where_raw(
                "deleted_at IS ? AND score > ? AND score < ?",
                [SqlValue::Null, 50.into(), 100.into()],
            )
            .unwrap();
        assert_eq!(
            sql(&query),
            "SELECT * FROM test_models WHERE deleted_at IS ? AND score > ? AND score < ?"
        );
        assert_eq!(
            params(&query),
            vec![
                SqlValue::Null,
                SqlValue::Integer(50),
                SqlValue::Integer(100)
            ]
        );
    }

    #[test]
    fn rejects_unknown_columns() {
        assert!(TestModel::query().where_eq("nope", 1).is_err());
        assert!(TestModel::query().order_by("nope", Direction::Asc).is_err());
    }

    #[test]
    fn joins_accumulate_and_bind_before_where() {
        let query = TestModel::query()
            .where_eq("status", "active")
            .unwrap()
            .join(
                "INNER JOIN test_stats s ON s.test_model_id = test_models.id AND s.score > ?",
                [50],
            )
            .unwrap();
        let generated = query.to_sql();
        assert_eq!(
            generated.sql,
            "SELECT * FROM test_models INNER JOIN test_stats s ON s.test_model_id = test_models.id AND s.score > ? WHERE status = ?"
        );
        assert_eq!(
            generated.params,
            vec![SqlValue::Integer(50), SqlValue::Text("active".to_string())]
        );
    }

    #[test]
    fn join_validates_placeholder_arity() {
        assert!(
            TestModel::query()
                .join("JOIN x ON x.id = ?", Vec::<SqlValue>::new())
                .is_err()
        );
    }

    #[test]
    fn fuzzy_search_splits_terms_and_groups_by_column() {
        let query = TestModel::query()
            .fuzzy_search("night fire", ["name", "status"])
            .unwrap();
        assert_eq!(
            sql(&query),
            "SELECT * FROM test_models WHERE (name LIKE ? OR status LIKE ?) AND (name LIKE ? OR status LIKE ?)"
        );
        assert_eq!(
            params(&query),
            vec![
                text("%night%"),
                text("%night%"),
                text("%fire%"),
                text("%fire%")
            ]
        );
    }

    #[test]
    fn fuzzy_search_expands_raw_fragments() {
        let query = TestModel::query()
            .fuzzy_search("x", ["EXISTS (SELECT 1 WHERE a LIKE ? OR b LIKE ?)"])
            .unwrap();
        assert_eq!(
            sql(&query),
            "SELECT * FROM test_models WHERE (EXISTS (SELECT 1 WHERE a LIKE ? OR b LIKE ?))"
        );
        assert_eq!(params(&query), vec![text("%x%"), text("%x%")]);
    }

    #[test]
    fn fuzzy_search_blank_terms_is_noop_and_requires_columns() {
        let query = TestModel::query().fuzzy_search("   ", ["name"]).unwrap();
        assert_eq!(sql(&query), "SELECT * FROM test_models");
        assert!(params(&query).is_empty());
        assert!(
            TestModel::query()
                .fuzzy_search("x", Vec::<String>::new())
                .is_err()
        );
    }

    #[test]
    fn select_clear_is_reported_when_consumed() {
        let query = TestModel::query().select_clear();
        assert_eq!(sql(&query), "SELECT  FROM test_models");
        assert!(params(&query).is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn empty_select_list_errors_on_terminals() {
        let mut conn = crate::test_support::memory_connection().await;
        let error = TestModel::query().select_clear().all(&mut conn).await;
        assert!(matches!(error, Err(Error::Record(_))));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn terminals_and_raw_rows_work() {
        let mut conn = crate::test_support::memory_connection().await;

        let mut first = TestModel {
            name: "foo".to_string(),
            status: "active".to_string(),
            score: Some(10),
            ..Default::default()
        };
        first.save(&mut conn).await.unwrap();
        let mut second = TestModel {
            name: "bar".to_string(),
            status: "active".to_string(),
            score: Some(20),
            ..Default::default()
        };
        second.save(&mut conn).await.unwrap();

        let all = TestModel::query()
            .where_eq("status", "active")
            .unwrap()
            .order_by("name", Direction::Asc)
            .unwrap()
            .all(&mut conn)
            .await
            .unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].name, "bar");

        let count = TestModel::query()
            .where_eq("status", "active")
            .unwrap()
            .count(&mut conn)
            .await
            .unwrap();
        assert_eq!(count, 2);

        let first_row = TestModel::query()
            .order_by("score", Direction::Desc)
            .unwrap()
            .first(&mut conn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first_row.name, "bar");

        let raw = TestModel::query()
            .select_clear()
            .select("name, COUNT(*) AS n")
            .all_raw(&mut conn)
            .await
            .unwrap();
        assert_eq!(raw[0].get("n"), Some(&SqlValue::Integer(2)));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn streaming_yields_rows() {
        use futures_util::TryStreamExt;

        let mut conn = crate::test_support::memory_connection().await;
        for name in ["a", "b", "c"] {
            let mut model = TestModel {
                name: name.to_string(),
                status: "active".to_string(),
                ..Default::default()
            };
            model.save(&mut conn).await.unwrap();
        }

        let mut stream = TestModel::query()
            .where_eq("status", "active")
            .unwrap()
            .order_by("name", Direction::Asc)
            .unwrap()
            .fetch(&mut conn);
        let mut names = Vec::new();
        while let Some(model) = stream.try_next().await.unwrap() {
            names.push(model.name);
        }
        assert_eq!(names, vec!["a", "b", "c"]);
    }
}
