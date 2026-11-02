import * as v from "valibot";
import { Database } from "./Database";
import { detailedDiff } from "deep-object-diff";
import { ApplicationRecordQuery } from "./ApplicationRecordQuery";

type ModelConstructor = new (
  data: Record<string, unknown>,
) => ApplicationRecord;

/**
 * Returns true when a record has not been persisted yet: the primary key is absent, `null`, or `0`.
 * `0` is never a stored key — `save()` omits the primary-key column on insert, so the database
 * assigns the rowid.
 */
function isNewRecord(record: Record<string, unknown>, pk: string): boolean {
  return record[pk] == null || record[pk] === 0;
}

/**
 * Where a model keeps its timestamps and how they are written.
 *
 * Set via the static `timestamps` property (see the {@link Timestamps} presets).
 */
export interface TimestampConfig {
  /** Column receiving the creation timestamp, or `null` to disable. */
  created: string | null;
  /** Column receiving the update timestamp, or `null` to disable. */
  updated: string | null;
  /** `"iso"` writes `Date#toISOString()`; `"millis"` writes `Date.now()`. */
  format: "iso" | "millis";
}

/**
 * Timestamp presets for the static `timestamps` property.
 *
 * ```typescript
 * class Event extends ApplicationRecord {
 *   static timestamps = Timestamps.epochMillis; // created_ts / updated_ts as integers
 * }
 * ```
 */
export const Timestamps = {
  /** `created_at` / `updated_at` as ISO-8601 text. The default. */
  iso8601: { created: "created_at", updated: "updated_at", format: "iso" },
  /** `created_ts` / `updated_ts` as epoch milliseconds. */
  epochMillis: {
    created: "created_ts",
    updated: "updated_ts",
    format: "millis",
  },
  /** No automatic timestamps. */
  none: { created: null, updated: null, format: "iso" },
} satisfies Record<string, TimestampConfig>;

/** Returns true when a timestamp column holds no value for the given format. */
function isUnsetTimestamp(
  value: unknown,
  format: TimestampConfig["format"],
): boolean {
  if (value == null) return true;
  return format === "millis" ? value === 0 : value === "";
}

/**
 * Base class for database models. Subclasses define `tableName`, `schema`, and `database`.
 * The `schema` property must be a Valibot object schema defining the model's columns.
 *
 * Usage:
 * ```typescript
 * class User extends ApplicationRecord {
 *   static database = db;
 *   static tableName = "users";
 *   static schema = v.object({
 *     id: v.optional(v.number()),
 *     name: v.string(),
 *     email: v.pipe(v.string(), v.metadata({ redacted: true })),
 *   });
 * }
 *
 * const user = new User({ name: "Alice" });
 * user.save();
 * const found = User.find(user.id);
 * const all = User.all();
 * user.destroy();
 * ```
 */
export class ApplicationRecord {
  static database: Database;
  static tableName: string;
  static schema: v.ObjectSchema<any, any>;
  static primaryKey: string = "id";

  /**
   * Where this model keeps its timestamps and how they are written. Defaults to
   * {@link Timestamps.iso8601} (`created_at`/`updated_at` as ISO-8601 text).
   *
   * Use {@link Timestamps.epochMillis} for `created_ts`/`updated_ts` integer columns, or a
   * {@link TimestampConfig} literal for custom column names.
   */
  static timestamps: TimestampConfig = Timestamps.iso8601;

  /** @see {@link ApplicationRecordQuery.where} */
  static where<T extends typeof ApplicationRecord>(
    this: T,
    column: string,
    operator: string,
    value: unknown,
  ): ApplicationRecordQuery<T> {
    return new ApplicationRecordQuery(this).where(column, operator, value);
  }

  /** @see {@link ApplicationRecordQuery.whereIn} */
  static whereIn<T extends typeof ApplicationRecord>(
    this: T,
    column: string,
    values: unknown[],
  ): ApplicationRecordQuery<T> {
    return new ApplicationRecordQuery(this).whereIn(column, values);
  }

  /** @see {@link ApplicationRecordQuery.whereNotIn} */
  static whereNotIn<T extends typeof ApplicationRecord>(
    this: T,
    column: string,
    values: unknown[],
  ): ApplicationRecordQuery<T> {
    return new ApplicationRecordQuery(this).whereNotIn(column, values);
  }

  /** @see {@link ApplicationRecordQuery.whereRaw} */
  static whereRaw<T extends typeof ApplicationRecord>(
    this: T,
    sql: string,
    params?: unknown[],
  ): ApplicationRecordQuery<T> {
    return new ApplicationRecordQuery(this).whereRaw(sql, params);
  }

  /** @see {@link ApplicationRecordQuery.fuzzySearch} */
  static fuzzySearch<T extends typeof ApplicationRecord>(
    this: T,
    terms: string | null | undefined,
    columns: string[],
  ): ApplicationRecordQuery<T> {
    return new ApplicationRecordQuery(this).fuzzySearch(terms, columns);
  }

  /** @see {@link ApplicationRecordQuery.orderBy} */
  static orderBy<T extends typeof ApplicationRecord>(
    this: T,
    column: string,
    direction?: "ASC" | "DESC",
  ): ApplicationRecordQuery<T> {
    return new ApplicationRecordQuery(this).orderBy(column, direction);
  }

  /** @see {@link ApplicationRecordQuery.limit} */
  static limit<T extends typeof ApplicationRecord>(
    this: T,
    n: number,
  ): ApplicationRecordQuery<T> {
    return new ApplicationRecordQuery(this).limit(n);
  }

  /** @see {@link ApplicationRecordQuery.offset} */
  static offset<T extends typeof ApplicationRecord>(
    this: T,
    n: number,
  ): ApplicationRecordQuery<T> {
    return new ApplicationRecordQuery(this).offset(n);
  }

  /** @see {@link ApplicationRecordQuery.select} */
  static select<T extends typeof ApplicationRecord>(
    this: T,
    fragment: string,
  ): ApplicationRecordQuery<T> {
    return new ApplicationRecordQuery(this).select(fragment);
  }

  /** @see {@link ApplicationRecordQuery.selectClear} */
  static selectClear<T extends typeof ApplicationRecord>(
    this: T,
  ): ApplicationRecordQuery<T> {
    return new ApplicationRecordQuery(this).selectClear();
  }

  /** @see {@link ApplicationRecordQuery.join} */
  static join<T extends typeof ApplicationRecord>(
    this: T,
    sql: string,
    params?: unknown[],
  ): ApplicationRecordQuery<T> {
    return new ApplicationRecordQuery(this).join(sql, params);
  }

  /** Returns a fresh `ApplicationRecordQuery` scoped to this model. */
  static scope<T extends typeof ApplicationRecord>(
    this: T,
  ): ApplicationRecordQuery<T> {
    return new ApplicationRecordQuery(this);
  }

  /**
   * Stores the result of the most recent `save({ trackChanges })` or `destroy({ trackChanges })` call.
   * - **Update**: `{ col: [oldValue, newValue] }` for each changed column.
   * - **Insert**: `{ col: [undefined, newValue] }` for every column.
   * - **Delete**: `{ col: [lastValue, undefined] }` for every column.
   * - `null` if no tracked operation has run since construction.
   */
  private _trackedChanges: Record<string, unknown> | null = null;

  constructor(data: Record<string, unknown> = {}) {
    const record = this as Record<string, unknown>;
    for (const [key, value] of Object.entries(data)) {
      record[key] = value;
    }
    // Only set timestamps for new records; DB rows already have them
    const Ctor = this.constructor as typeof ApplicationRecord;
    const pk = Ctor.primaryKey;
    if (isNewRecord(record, pk)) {
      this.setTimestamps();
    }
  }

  /** Fetches a single record by primary key. Returns null if not found or if `id` is `0`. */
  static find<T extends typeof ApplicationRecord>(
    this: T,
    id: number,
  ): InstanceType<T> | null {
    if (id === 0) return null;
    const pk = this.primaryKey;
    const table = this.tableName;
    const row = this.database
      .getDb()
      .query(`SELECT * FROM ${table} WHERE ${pk} = ?`)
      .get(id);
    if (!row) return null;
    return this.fromRow(row);
  }

  /** @see {@link ApplicationRecordQuery.first} */
  static first<T extends typeof ApplicationRecord>(
    this: T,
  ): InstanceType<T> | null {
    return new ApplicationRecordQuery(this).first();
  }

  /** @see {@link ApplicationRecordQuery.count} */
  static count<T extends typeof ApplicationRecord>(this: T): number {
    return new ApplicationRecordQuery(this).count();
  }

  static allRaw<T extends typeof ApplicationRecord>(
    this: T,
  ): Record<string, unknown>[] {
    return new ApplicationRecordQuery(this).allRaw();
  }

  static all<T extends typeof ApplicationRecord>(this: T): InstanceType<T>[] {
    return new ApplicationRecordQuery(this).all();
  }

  static eachRaw<T extends typeof ApplicationRecord>(
    this: T,
  ): Iterable<Record<string, unknown>> {
    return new ApplicationRecordQuery(this).eachRaw();
  }

  static each<T extends typeof ApplicationRecord>(
    this: T,
  ): Iterable<InstanceType<T>> {
    return new ApplicationRecordQuery(this).each();
  }

  /** Returns an array of column names marked as redacted in the schema. */
  static redacted(): string[] {
    const cached = redactedCache.get(this);
    if (cached) return cached;

    const result = Object.entries(this.schema.entries)
      .filter(([, col]) => hasRedactedMeta(col))
      .map(([key]) => key);

    redactedCache.set(this, result);
    return result;
  }

  /** Redacts sensitive columns in the given record in place and returns it. */
  static redact(record: Record<string, unknown>): Record<string, unknown> {
    for (const col of this.redacted()) {
      if (col in record) {
        record[col] = "[redacted]";
      }
    }
    return record;
  }

  /**
   * Converts a raw database row into a model instance.
   * Centralizes instantiation logic and type casting for reuse in `find`, `all`, and custom query methods.
   */
  protected static fromRow<T extends typeof ApplicationRecord>(
    this: T,
    row: unknown,
  ): InstanceType<T> {
    return new (this as ModelConstructor)(
      row as Record<string, unknown>,
    ) as InstanceType<T>;
  }

  /**
   * Inserts a new record or updates an existing one. A primary key of `0` (or absent/null) means
   * "new": the insert omits the primary-key column so the database assigns it.
   */
  save(options?: SaveOptions): this {
    const Ctor = this.constructor as typeof ApplicationRecord;
    const record = this as Record<string, unknown>;
    const pk = Ctor.primaryKey;
    const table = Ctor.tableName;
    const schema = Ctor.schema.entries;
    const isNew = isNewRecord(record, pk);

    let before: Record<string, unknown> | undefined;
    if (options?.trackChanges) {
      before = isNew ? undefined : (this.persisted() ?? undefined);
    }

    if (isNew) {
      this.beforeCreate();
    } else {
      this.beforeUpdate();
    }

    this.setTimestamps({ updatedAt: !options?.skipUpdatedAt });

    const parsed = v.parse(Ctor.schema, record);
    const columns = Object.keys(schema);
    const values = columns.map((col) => parsed[col]) as any[];

    for (const [key, value] of Object.entries(parsed)) {
      record[key] = value;
    }

    if (isNew) {
      // Never bind `0`: omit the primary-key column so SQLite assigns the rowid. Binding a
      // literal `0` would persist rowid `0` and `lastInsertRowid` would return `0`.
      const insertColumns = columns.filter((col) => col !== pk);
      const insertValues = insertColumns.map((col) => parsed[col]) as any[];
      const placeholders = insertColumns.map(() => "?").join(", ");
      const sql = `INSERT INTO ${table} (${insertColumns.join(", ")}) VALUES (${placeholders})`;
      const result = Ctor.database
        .getDb()
        .query(sql)
        .run(...insertValues);
      record[pk] = result.lastInsertRowid;
      if (options?.trackChanges) this._captureChanges(before);
      this.afterCreate();
    } else {
      const setClause = columns.map((col) => `${col} = ?`).join(", ");
      const sql = `UPDATE ${table} SET ${setClause} WHERE ${pk} = ?`;
      Ctor.database
        .getDb()
        .query(sql)
        .run(...values, record[pk]);
      if (options?.trackChanges) this._captureChanges(before);
      this.afterUpdate();
    }

    this.afterSave();

    return this;
  }

  /**
   * Sets the creation and update timestamps if the schema defines the configured columns.
   *
   * Columns and representation come from the static {@link timestamps} config: `created` only when
   * the record is new and the value is unset (`null`, `""` for ISO, `0` for millis), `updated`
   * unless `updatedAt: false`. Both receive the same clock reading.
   */
  setTimestamps(options: SetTimestampOptions = {}): void {
    const Ctor = this.constructor as typeof ApplicationRecord;
    const { created, updated, format } = Ctor.timestamps;
    const record = this as Record<string, unknown>;
    const schema = Ctor.schema.entries;
    const isNew = isNewRecord(record, Ctor.primaryKey);
    const now = format === "millis" ? Date.now() : new Date().toISOString();

    if (
      created &&
      created in schema &&
      isNew &&
      isUnsetTimestamp(record[created], format)
    ) {
      record[created] = now;
    }
    if (updated && updated in schema && options.updatedAt !== false) {
      record[updated] = now;
    }
  }

  /** Called before inserting a new record. Override in subclasses for custom behavior. */
  protected beforeCreate(): void {}

  /** Called before updating an existing record. Override in subclasses for custom behavior. */
  protected beforeUpdate(): void {}

  /** Called after inserting a new record. Override in subclasses for custom behavior. */
  protected afterCreate(): void {}

  /** Called after updating an existing record. Override in subclasses for custom behavior. */
  protected afterUpdate(): void {}

  /** Called after any save (create or update). Runs after the specialized callback. Override in subclasses for custom behavior. */
  protected afterSave(): void {}

  /** Called after deleting a record. Override in subclasses for custom behavior. */
  protected afterDestroy(): void {}

  /** Returns the current database state of this record, or null if new. Optionally redacts sensitive columns. */
  persisted(redact: boolean = false): Record<string, unknown> | null {
    const Ctor = this.constructor as typeof ApplicationRecord;
    const record = this as Record<string, unknown>;
    const pk = Ctor.primaryKey;
    if (isNewRecord(record, pk)) return null;
    const table = Ctor.tableName;
    const row = Ctor.database
      .getDb()
      .query(`SELECT * FROM ${table} WHERE ${pk} = ?`)
      .get(record[pk] as any) as Record<string, unknown> | null;

    if (redact && row) {
      Ctor.redact(row);
    }

    return row;
  }

  /**
   * Compares the state before and after a mutation, storing old/new value pairs
   * in `_trackedChanges` for every schema column that differs.
   *
   * @param before - The state before the mutation, or `undefined` for inserts
   *                 (every column is treated as new: `[undefined, value]`).
   * @param after  - The state after the mutation. Defaults to `this.toJSON()`.
   *                 Pass `{}` for deletes (every column becomes `[value, undefined]`).
   */
  private _captureChanges(
    before: Record<string, unknown> | undefined,
    after?: Record<string, unknown>,
  ): void {
    const Ctor = this.constructor as typeof ApplicationRecord;
    const snapshot = after ?? this.toJSON();
    const changes: Record<string, unknown> = {};
    const columns = Object.keys(Ctor.schema.entries);

    for (const key of columns) {
      if (before?.[key] !== snapshot[key]) {
        changes[key] = [before?.[key], snapshot[key]];
      }
    }

    this._trackedChanges = Object.keys(changes).length > 0 ? changes : null;
  }

  /**
   * Deletes the record from the database by primary key.
   *
   * Throws when the record has not been persisted yet (`0`/absent/null primary key), mirroring the
   * Rust implementation.
   */
  destroy(options?: SaveOptions): void {
    const Ctor = this.constructor as typeof ApplicationRecord;
    const record = this as Record<string, unknown>;
    const pk = Ctor.primaryKey;
    const table = Ctor.tableName;
    if (isNewRecord(record, pk)) {
      throw new Error("cannot destroy an unsaved record");
    }
    if (options?.trackChanges) {
      this._captureChanges(this.toJSON(), {});
    }
    Ctor.database
      .getDb()
      .query(`DELETE FROM ${table} WHERE ${pk} = ?`)
      .run(record[pk] as any);
    this.afterDestroy();
  }

  /**
   * Returns the changes captured by the last `save({ trackChanges: true })` or `destroy()` call.
   * For updates: the diff between persisted state and saved values (excluding unchanged columns).
   * For deletes: all attributes at the time of deletion.
   * Returns null if no tracked save or destroy has occurred.
   */
  trackedChanges(): Record<string, unknown> | null {
    return this._trackedChanges;
  }

  /** Returns a JSON representation of the instance's attributes. Optionally redacts sensitive columns. */
  toJSON(redact: boolean = false): Record<string, unknown> {
    const Ctor = this.constructor as typeof ApplicationRecord;
    const record = this as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const key of Object.keys(Ctor.schema.entries)) {
      result[key] = record[key];
    }

    if (redact) {
      Ctor.redact(result);
    }

    return result;
  }

  /** Returns true if any attributes differ from the persisted database state. */
  changed(): boolean {
    return Object.keys(this.changes()).length > 0;
  }

  /** Returns the diff between persisted database state and current instance values. Optionally redacts sensitive columns. */
  changes(redact: boolean = false): Record<string, unknown> {
    const Ctor = this.constructor as typeof ApplicationRecord;
    const before = this.persisted();
    if (!before) return {};

    const after = this.toJSON();
    const { updated, added } = detailedDiff(before, after);
    const diff = { ...added, ...updated };

    if (redact) {
      Ctor.redact(diff);
    }

    return diff;
  }

  /**
   * Checks if a value is unique for the given field.
   * Excludes the current record, when persisted, to avoid false positives when updating.
   * Returns true if the value is unique and available to use.
   */
  checkUniqueness(field: string, value: unknown): boolean {
    const Ctor = this.constructor as typeof ApplicationRecord;
    const pk = Ctor.primaryKey;
    const table = Ctor.tableName;

    let query = `SELECT 1 FROM ${table} WHERE ${field} = ?`;
    const params: any[] = [value];

    const record = this as Record<string, unknown>;
    if (!isNewRecord(record, pk)) {
      query += ` AND ${pk} != ?`;
      params.push(record[pk]);
    }

    const exists = Ctor.database
      .getDb()
      .query(query)
      .get(...params);
    return !exists;
  }

  /**
   * Checks uniqueness with a raw SQL WHERE condition (no table prefix).
   * Excludes the current record by primary key when it is persisted.
   * Returns true if the combination is unique and available to use.
   */
  checkUniquenessRaw(condition: string, params: unknown[] = []): boolean {
    const Ctor = this.constructor as typeof ApplicationRecord;
    const pk = Ctor.primaryKey;
    const table = Ctor.tableName;

    let query = `SELECT 1 FROM ${table} WHERE ${condition}`;
    const allParams: unknown[] = [...params];

    const record = this as Record<string, unknown>;
    if (!isNewRecord(record, pk)) {
      query += ` AND ${pk} != ?`;
      allParams.push(record[pk]);
    }

    const exists = Ctor.database
      .getDb()
      .query(query)
      .get(...(allParams as any[]));
    return !exists;
  }

  /**
   * Custom validation hook. Override in subclasses to add model-specific validations
   * (e.g., uniqueness, conditional checks). Return an array of errors or an empty array if valid.
   *
   * @example
   * ```typescript
   * class User extends ApplicationRecord {
   *   protected async validateCustom() {
   *     const errors: ValidationError[] = [];
   *     const existing = User.all().find((u) => u.email === this.email && u.id !== this.id);
   *     if (existing) errors.push({ column: "email", message: "is already taken" });
   *     return errors;
   *   }
   * }
   * ```
   */
  protected async validateCustom(): Promise<ValidationError[]> {
    return [];
  }

  /** Validates the instance against the schema and custom validations. Returns an array of errors (empty if valid). */
  async validate(): Promise<ValidationError[]> {
    const Ctor = this.constructor as typeof ApplicationRecord;
    const record = this as Record<string, unknown>;
    const result = v.safeParse(Ctor.schema, record);

    let errors: ValidationError[] = [];

    if (!result.success) {
      errors = result.issues.map((issue) => ({
        column: issue.path?.map((p: any) => p.key ?? p.value).join(".") ?? "",
        message: issue.message,
      }));
    }

    const customErrors = await this.validateCustom();
    if (customErrors.length > 0) {
      errors = errors.concat(customErrors);
    }

    return errors;
  }
}

/** Validation error returned by `validate()` and `validateCustom()`. */
export interface ValidationError {
  column: string;
  message: string;
}

/** Memoized redacted column names per subclass. Keys are subclass constructors. */
export const redactedCache = new Map<typeof ApplicationRecord, string[]>();

/** Recursively checks if a Valibot schema (or its unwrapped inner schema) has `redacted` metadata. */
function hasRedactedMeta(schema: unknown): boolean {
  const meta = v.getMetadata(schema as any);
  if (meta?.redacted) return true;
  const obj = schema as { type: string } | null;
  if (obj && (obj.type === "nullable" || obj.type === "optional")) {
    const inner = v.unwrap(schema as any);
    return hasRedactedMeta(inner);
  }
  return false;
}

export interface SaveOptions {
  trackChanges?: boolean;
  /** On update, keep the existing update timestamp instead of bumping it. Ignored on insert. */
  skipUpdatedAt?: boolean;
}

export interface SetTimestampOptions {
  /** When false, an existing update timestamp is preserved instead of being bumped. */
  updatedAt?: boolean;
}
