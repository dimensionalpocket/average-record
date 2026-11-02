#![forbid(unsafe_code)]

use proc_macro::TokenStream;
use proc_macro2::TokenStream as TokenStream2;
use quote::quote;
use syn::{Data, DeriveInput, Fields, Type, parse_macro_input};

/// Derives `average_record::Model` (and `serde::Serialize`) for a struct.
///
/// Struct attributes:
/// - `#[model(table = "users")]` — required table name.
/// - `#[model(timestamps = "iso8601" | "epoch_millis" | "none")]` — where and how timestamps are
///   written. `iso8601` (the default) uses `created_at`/`updated_at` as `String`; `epoch_millis`
///   uses `created_ts`/`updated_ts` as `i64`; `none` disables them.
/// - `#[model(timestamps(created = "...", updated = "...", format = "..."))]` — custom column names.
///   An omitted `created`/`updated` disables that column; `format` defaults to `iso8601`.
///
/// Field attributes:
/// - `#[model(primary_key)]` — marks the primary key (defaults to a field named `id`). Must be a
///   plain `i64`; `0` means "new record".
/// - `#[model(column = "locked")]` — maps a Rust field to a differently named column.
/// - `#[model(virtual)]` — non-persisted projection field.
/// - `#[redacted]` — redacted in `to_json`, `persisted`, and `changes`.
#[proc_macro_derive(Model, attributes(model, redacted))]
pub fn derive_model(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    match expand(input) {
        Ok(tokens) => tokens.into(),
        Err(error) => error.to_compile_error().into(),
    }
}

struct FieldInfo {
    ident: syn::Ident,
    ty: Type,
    column: String,
    is_virtual: bool,
    is_primary: bool,
    is_redacted: bool,
}

fn expand(input: DeriveInput) -> syn::Result<TokenStream2> {
    let name = &input.ident;
    let (impl_generics, ty_generics, where_clause) = input.generics.split_for_impl();

    let StructOptions { table, timestamps } = struct_options(&input)?;

    let Data::Struct(data) = &input.data else {
        return Err(syn::Error::new_spanned(
            name,
            "#[derive(Model)] can only be used on structs",
        ));
    };
    let Fields::Named(named) = &data.fields else {
        return Err(syn::Error::new_spanned(
            name,
            "#[derive(Model)] requires named fields",
        ));
    };

    let mut fields = Vec::new();
    for field in &named.named {
        let ident = field.ident.clone().expect("named field");
        let column = field_column(field).unwrap_or_else(|| ident.to_string());
        fields.push(FieldInfo {
            ident,
            ty: field.ty.clone(),
            column,
            is_virtual: has_flag(field, "virtual")?,
            is_primary: has_flag(field, "primary_key")?,
            is_redacted: field
                .attrs
                .iter()
                .any(|attr| attr.path().is_ident("redacted")),
        });
    }

    let primary = fields
        .iter()
        .find(|field| field.is_primary)
        .or_else(|| fields.iter().find(|field| !field.is_virtual && field.column == "id"))
        .ok_or_else(|| {
            syn::Error::new_spanned(
                name,
                "#[derive(Model)] requires a primary-key field (mark one with #[model(primary_key)] or name it `id`)",
            )
        })?;
    let primary_ident = &primary.ident;
    let primary_column = primary.column.clone();

    if !is_i64(&primary.ty) {
        return Err(syn::Error::new_spanned(
            &primary.ident,
            "#[derive(Model)] primary key must be a plain `i64` (`0` means new); `Option<i64>` is no longer supported",
        ));
    }

    let persisted: Vec<&FieldInfo> = fields.iter().filter(|field| !field.is_virtual).collect();
    let columns: Vec<&str> = persisted
        .iter()
        .map(|field| field.column.as_str())
        .collect();
    let redacted: Vec<&str> = persisted
        .iter()
        .filter(|field| field.is_redacted)
        .map(|field| field.column.as_str())
        .collect();

    validate_timestamps(name, &persisted, &timestamps)?;
    let timestamp_columns = [timestamps.created.as_deref(), timestamps.updated.as_deref()];
    let created_column = option_str(&timestamps.created);
    let updated_column = option_str(&timestamps.updated);
    let timestamp_format = match timestamps.format {
        TimestampFormat::Iso8601 => quote!(Iso8601),
        TimestampFormat::EpochMillis => quote!(EpochMillis),
    };

    let from_row_fields = fields.iter().map(|field| {
        let ident = &field.ident;
        let column = &field.column;
        if field.is_virtual {
            let ty = &field.ty;
            quote! {
                #ident: row.try_get::<#ty, _>(#column).ok().flatten()
            }
        } else {
            quote! {
                #ident: row.try_get(#column)?
            }
        }
    });

    let to_values = persisted.iter().map(|field| {
        let ident = &field.ident;
        quote! { self.#ident.clone().into() }
    });

    let set_column_arms = persisted.iter().filter_map(|field| {
        let ident = &field.ident;
        let column = &field.column;
        if is_string_type(&field.ty) {
            Some(quote! {
                #column => {
                    if let Some(text) = value.as_str() {
                        self.#ident = text.to_string();
                    }
                }
            })
        } else if is_option_string(&field.ty) {
            Some(quote! {
                #column => {
                    self.#ident = value.as_str().map(str::to_string);
                }
            })
        } else if timestamp_columns.contains(&Some(column.as_str())) {
            // Integer timestamp columns. Scoped to the configured timestamp columns so other
            // numeric columns do not become settable through `set_column`.
            if is_i64(&field.ty) {
                Some(quote! {
                    #column => {
                        if let Some(value) = value.as_i64() {
                            self.#ident = value;
                        }
                    }
                })
            } else if is_option_i64(&field.ty) {
                Some(quote! {
                    #column => {
                        self.#ident = value.as_i64();
                    }
                })
            } else {
                None
            }
        } else {
            None
        }
    });

    let has_validate = derives_validate(&input) || has_garde_attributes(&input);
    let validate_fields = if has_validate {
        quote! {
            fn validate_fields(&self) -> ::std::vec::Vec<average_record::ValidationError> {
                match <Self as average_record::__private::garde::Validate>::validate(self) {
                    ::std::result::Result::Ok(()) => ::std::vec::Vec::new(),
                    ::std::result::Result::Err(report) => report
                        .iter()
                        .map(|(path, error)| {
                            average_record::ValidationError::new(
                                ::std::string::ToString::to_string(path),
                                ::std::string::ToString::to_string(error),
                            )
                        })
                        .collect(),
                }
            }
        }
    } else {
        TokenStream2::new()
    };

    let expanded = quote! {
        impl #impl_generics average_record::Model for #name #ty_generics #where_clause {
            const TABLE_NAME: &'static str = #table;
            const PRIMARY_KEY: &'static str = #primary_column;
            const COLUMNS: &'static [&'static str] = &[#(#columns),*];
            const REDACTED_COLUMNS: &'static [&'static str] = &[#(#redacted),*];
            const TIMESTAMPS: average_record::Timestamps = average_record::Timestamps {
                created: #created_column,
                updated: #updated_column,
                format: average_record::TimestampFormat::#timestamp_format,
            };

            fn from_row(row: &average_record::__private::sqlx::sqlite::SqliteRow) -> average_record::Result<Self> {
                use average_record::__private::sqlx::Row as _;
                ::std::result::Result::Ok(Self {
                    #(#from_row_fields),*
                })
            }

            fn to_values(&self) -> ::std::vec::Vec<average_record::SqlValue> {
                vec![#(#to_values),*]
            }

            fn primary_key_value(&self) -> i64 {
                self.#primary_ident
            }

            fn set_primary_key(&mut self, id: i64) {
                self.#primary_ident = id;
            }

            fn set_column(&mut self, column: &str, value: average_record::SqlValue) {
                match column {
                    #(#set_column_arms),*
                    _ => {}
                }
            }

            #validate_fields
        }

        impl #impl_generics #name #ty_generics #where_clause {
            /// Validates the record against its declarative field rules and
            /// [`ModelHooks::validate_custom`](average_record::ModelHooks::validate_custom).
            ///
            /// Generated by `#[derive(Model)]` so that `.validate(conn)` resolves unambiguously
            /// even when `garde::Validate` is also in scope.
            pub async fn validate(
                &self,
                conn: &mut average_record::__private::sqlx::SqliteConnection,
            ) -> average_record::Result<::std::vec::Vec<average_record::ValidationError>> {
                <Self as average_record::ModelHooks>::validate(self, conn).await
            }
        }

        impl #impl_generics average_record::__private::serde::Serialize for #name #ty_generics #where_clause {
            fn serialize<S>(&self, serializer: S) -> ::std::result::Result<S::Ok, S::Error>
            where
                S: average_record::__private::serde::Serializer,
            {
                let value = <Self as average_record::Model>::to_json(self, false);
                average_record::__private::serde::Serialize::serialize(&value, serializer)
            }
        }
    };

    Ok(expanded)
}

/// Struct-level options parsed from `#[model(...)]`.
struct StructOptions {
    table: String,
    timestamps: TimestampSpec,
}

/// Timestamp columns and representation, as configured by `#[model(timestamps = ...)]`.
struct TimestampSpec {
    created: Option<String>,
    updated: Option<String>,
    format: TimestampFormat,
    /// Whether configured columns must exist in `COLUMNS` and match the format.
    ///
    /// Off for the implicit default and the `none` preset (every model has that default, including
    /// models with no timestamp columns at all). On for anything the model author opted into.
    strict: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TimestampFormat {
    Iso8601,
    EpochMillis,
}

impl TimestampSpec {
    /// The default column pair for a format.
    fn for_format(format: TimestampFormat) -> Self {
        match format {
            TimestampFormat::Iso8601 => Self {
                created: Some("created_at".to_string()),
                updated: Some("updated_at".to_string()),
                format,
                strict: true,
            },
            TimestampFormat::EpochMillis => Self {
                created: Some("created_ts".to_string()),
                updated: Some("updated_ts".to_string()),
                format,
                strict: true,
            },
        }
    }
}

impl Default for TimestampSpec {
    /// The implicit default for every derived model: ISO-8601 columns when they exist.
    fn default() -> Self {
        Self {
            created: Some("created_at".to_string()),
            updated: Some("updated_at".to_string()),
            format: TimestampFormat::Iso8601,
            strict: false,
        }
    }
}

fn struct_options(input: &DeriveInput) -> syn::Result<StructOptions> {
    for attr in &input.attrs {
        if !attr.path().is_ident("model") {
            continue;
        }
        let mut table = None;
        let mut timestamps = TimestampSpec::default();
        attr.parse_nested_meta(|meta| {
            if meta.path.is_ident("table") {
                let value: syn::LitStr = meta.value()?.parse()?;
                table = Some(value.value());
                Ok(())
            } else if meta.path.is_ident("timestamps") {
                timestamps = parse_timestamps(&meta)?;
                Ok(())
            } else {
                Err(meta.error(
                    "unknown #[model(...)] option on the struct; expected `table` or `timestamps`",
                ))
            }
        })?;
        if let Some(table) = table {
            return Ok(StructOptions { table, timestamps });
        }
    }
    Err(syn::Error::new_spanned(
        &input.ident,
        "#[derive(Model)] requires #[model(table = \"...\")]",
    ))
}

fn parse_timestamps(meta: &syn::meta::ParseNestedMeta) -> syn::Result<TimestampSpec> {
    if !meta.input.peek(syn::token::Paren) {
        let preset: syn::LitStr = meta.value()?.parse()?;
        return match preset.value().as_str() {
            "iso8601" => Ok(TimestampSpec::default()),
            "epoch_millis" => Ok(TimestampSpec::for_format(TimestampFormat::EpochMillis)),
            "none" => Ok(TimestampSpec {
                created: None,
                updated: None,
                format: TimestampFormat::Iso8601,
                strict: false,
            }),
            other => Err(syn::Error::new_spanned(
                &preset,
                format!(
                    "unknown timestamps preset `{other}`; expected `iso8601`, `epoch_millis`, or `none`"
                ),
            )),
        };
    }

    // `timestamps(created = "...", updated = "...", format = "...")`.
    let mut created = None;
    let mut updated = None;
    let mut format = TimestampFormat::Iso8601;
    meta.parse_nested_meta(|inner| {
        if inner.path.is_ident("created") {
            created = Some(inner.value()?.parse::<syn::LitStr>()?.value());
        } else if inner.path.is_ident("updated") {
            updated = Some(inner.value()?.parse::<syn::LitStr>()?.value());
        } else if inner.path.is_ident("format") {
            let value: syn::LitStr = inner.value()?.parse()?;
            format = match value.value().as_str() {
                "iso8601" => TimestampFormat::Iso8601,
                "epoch_millis" => TimestampFormat::EpochMillis,
                other => {
                    return Err(inner.error(format!(
                        "unknown timestamp format `{other}`; expected `iso8601` or `epoch_millis`"
                    )));
                }
            };
        } else {
            return Err(inner
                .error("unknown `timestamps` option; expected `created`, `updated`, or `format`"));
        }
        Ok(())
    })?;

    // A bare `timestamps(format = "...")` would otherwise disable both columns; fall back to the
    // format's preset names. Once either column is named, an omitted one means "disabled".
    if created.is_none() && updated.is_none() {
        return Ok(TimestampSpec::for_format(format));
    }
    Ok(TimestampSpec {
        created,
        updated,
        format,
        strict: true,
    })
}

fn validate_timestamps(
    name: &syn::Ident,
    persisted: &[&FieldInfo],
    spec: &TimestampSpec,
) -> syn::Result<()> {
    if !spec.strict {
        return Ok(());
    }
    if let (Some(created), Some(updated)) = (&spec.created, &spec.updated)
        && created == updated
    {
        return Err(syn::Error::new_spanned(
            name,
            format!(
                "#[derive(Model)] timestamps: `created` and `updated` both point at `{created}`; use two distinct columns"
            ),
        ));
    }

    for column in [spec.created.as_deref(), spec.updated.as_deref()]
        .into_iter()
        .flatten()
    {
        let Some(field) = persisted.iter().find(|field| field.column == column) else {
            return Err(syn::Error::new_spanned(
                name,
                format!(
                    "#[derive(Model)] timestamps: `{column}` is not a persisted column of `{name}`"
                ),
            ));
        };
        let matches = match spec.format {
            TimestampFormat::Iso8601 => is_string_type(&field.ty) || is_option_string(&field.ty),
            TimestampFormat::EpochMillis => is_i64(&field.ty) || is_option_i64(&field.ty),
        };
        if !matches {
            let (kind, expected) = match spec.format {
                TimestampFormat::Iso8601 => ("ISO-8601", "`String` or `Option<String>`"),
                TimestampFormat::EpochMillis => ("epoch-millisecond", "`i64` or `Option<i64>`"),
            };
            return Err(syn::Error::new_spanned(
                &field.ident,
                format!(
                    "#[derive(Model)] timestamps: `{column}` is an {kind} timestamp, so it must be {expected}"
                ),
            ));
        }
    }
    Ok(())
}

/// Builds an `Option<&'static str>` expression for a column name.
fn option_str(value: &Option<String>) -> TokenStream2 {
    match value {
        Some(value) => quote!(::std::option::Option::Some(#value)),
        None => quote!(::std::option::Option::None),
    }
}

fn field_column(field: &syn::Field) -> Option<String> {
    let mut column = None;
    for attr in &field.attrs {
        if !attr.path().is_ident("model") {
            continue;
        }
        let _ = attr.parse_nested_meta(|meta| {
            if meta.path.is_ident("column")
                && let Ok(value) = meta.value().and_then(|value| value.parse::<syn::LitStr>())
            {
                column = Some(value.value());
            }
            Ok(())
        });
    }
    column
}

fn has_flag(field: &syn::Field, flag: &str) -> syn::Result<bool> {
    let mut found = false;
    for attr in &field.attrs {
        if !attr.path().is_ident("model") {
            continue;
        }
        attr.parse_nested_meta(|meta| {
            if meta.path.is_ident("virtual") || meta.path.is_ident("primary_key") {
                if meta.path.is_ident(flag) {
                    found = true;
                }
                // Accept both flags without an error so a single attribute may carry either.
                Ok(())
            } else if meta.path.is_ident("column") {
                let _ = meta.value()?.parse::<syn::LitStr>()?;
                Ok(())
            } else {
                Ok(())
            }
        })?;
    }
    Ok(found)
}

fn derives_validate(input: &DeriveInput) -> bool {
    input.attrs.iter().any(|attr| {
        if !attr.path().is_ident("derive") {
            return false;
        }
        let mut found = false;
        let _ = attr.parse_nested_meta(|meta| {
            if meta
                .path
                .segments
                .last()
                .is_some_and(|segment| segment.ident == "Validate")
            {
                found = true;
            }
            Ok(())
        });
        found
    })
}

/// The compiler strips `#[derive(...)]` from the token stream before invoking a derive macro, so
/// detect a `garde::Validate` derive by the presence of any `#[garde(...)]` attribute instead.
fn has_garde_attributes(input: &DeriveInput) -> bool {
    let struct_level = input.attrs.iter().any(|attr| attr.path().is_ident("garde"));
    let field_level = match &input.data {
        Data::Struct(data) => match &data.fields {
            Fields::Named(fields) => fields
                .named
                .iter()
                .any(|field| field.attrs.iter().any(|attr| attr.path().is_ident("garde"))),
            Fields::Unnamed(fields) => fields
                .unnamed
                .iter()
                .any(|field| field.attrs.iter().any(|attr| attr.path().is_ident("garde"))),
            Fields::Unit => false,
        },
        _ => false,
    };
    struct_level || field_level
}

fn is_string_type(ty: &Type) -> bool {
    matches!(ty, Type::Path(path) if path.path.is_ident("String"))
}

fn is_i64(ty: &Type) -> bool {
    matches!(
        ty,
        Type::Path(path)
            if path.qself.is_none()
                && path.path.segments.last().is_some_and(|s| s.ident == "i64")
    )
}

fn is_option_i64(ty: &Type) -> bool {
    is_option_of(ty, is_i64)
}

fn is_option_string(ty: &Type) -> bool {
    is_option_of(ty, is_string_type)
}

fn is_option_of(ty: &Type, inner: fn(&Type) -> bool) -> bool {
    let Type::Path(path) = ty else {
        return false;
    };
    let Some(segment) = path.path.segments.last() else {
        return false;
    };
    if segment.ident != "Option" {
        return false;
    }
    let syn::PathArguments::AngleBracketed(arguments) = &segment.arguments else {
        return false;
    };
    arguments.args.iter().any(|argument| match argument {
        syn::GenericArgument::Type(ty) => inner(ty),
        _ => false,
    })
}
