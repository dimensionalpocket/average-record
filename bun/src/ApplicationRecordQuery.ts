import { ApplicationRecord } from "./ApplicationRecord";

export interface GeneratedSqlString {
  sql: string;
  params: unknown[];
}

export class ApplicationRecordQuery<M extends typeof ApplicationRecord> {
  private conditions: string[] = [];
  private params: unknown[] = [];
  private joins: string[] = [];
  private joinParams: unknown[] = [];
  private orderByClauses: string[] = [];
  private limitValue?: number;
  private offsetValue?: number;
  private selectValue: string[] = ["*"];

  constructor(private readonly model: M) {}

  /** Appends a fragment to the `SELECT` list. Defaults to `*`. */
  select(fragment: string): this {
    this.selectValue.push(fragment);
    return this;
  }

  /** Clears the `SELECT` list. Call `select()` before consuming the query. */
  selectClear(): this {
    this.selectValue = [];
    return this;
  }

  /**
   * Appends a raw SQL join fragment after the `FROM` clause, before `WHERE`.
   * The fragment is passed through verbatim, so `INNER JOIN`, `LEFT JOIN`,
   * `CROSS JOIN`, and join subqueries are all supported. Multiple calls
   * accumulate in call order.
   *
   * With the default `SELECT *`, joined columns whose names collide with the
   * model's columns overwrite them in the row object; use `select()` or
   * `selectClear()` to pick explicit columns in that case.
   */
  join(sql: string, params: unknown[] = []): this {
    this.joins.push(sql);
    this.joinParams.push(...params);
    return this;
  }

  /** Adds a `column operator ?` condition joined with `AND`. */
  where(column: string, operator: string, value: unknown): this {
    this.conditions.push(`${column} ${operator} ?`);
    this.params.push(value);
    return this;
  }

  /** Adds a `column IN (?, ?, ...)` condition with one placeholder per value. */
  whereIn(column: string, values: unknown[]): this {
    const placeholders = values.map(() => "?").join(", ");
    this.conditions.push(`${column} IN (${placeholders})`);
    this.params.push(...values);
    return this;
  }

  /** Adds a `column NOT IN (?, ?, ...)` condition with one placeholder per value. */
  whereNotIn(column: string, values: unknown[]): this {
    const placeholders = values.map(() => "?").join(", ");
    this.conditions.push(`${column} NOT IN (${placeholders})`);
    this.params.push(...values);
    return this;
  }

  /** Adds a raw SQL fragment with optional params, joined with `AND`. */
  whereRaw(sql: string, params: unknown[] = []): this {
    this.conditions.push(sql);
    this.params.push(...params);
    return this;
  }

  /**
   * Adds a fuzzy LIKE search condition per space-separated term in `terms`,
   * joined with `AND`. Within a term, the searched columns are joined with `OR`,
   * so a term matches when any column contains it.
   *
   * Entries in `columns` are usually column names (`col LIKE ?` is built for
   * each). An entry containing `?` is treated as a raw SQL fragment and appended
   * verbatim, with the term pattern bound once per placeholder it contains
   * (e.g. an `EXISTS (SELECT ... LIKE ? OR ... LIKE ?)` subquery).
   *
   * Returns silently when `terms` is `null`, `undefined`, empty, or
   * whitespace-only, so request params can be passed through without guards.
   */
  fuzzySearch(terms: string | null | undefined, columns: string[]): this {
    if (columns.length === 0) {
      throw new Error("fuzzySearch requires at least one column");
    }
    if (!terms) return this;

    const words = terms
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 0);
    if (words.length === 0) return this;

    for (const word of words) {
      const pattern = `%${word}%`;
      const fragments: string[] = [];
      const termParams: unknown[] = [];

      for (const column of columns) {
        if (column.includes("?")) {
          fragments.push(column);
          for (let i = 0; i < column.split("?").length - 1; i++) {
            termParams.push(pattern);
          }
        } else {
          fragments.push(`${column} LIKE ?`);
          termParams.push(pattern);
        }
      }

      this.whereRaw(`(${fragments.join(" OR ")})`, termParams);
    }

    return this;
  }

  /** Adds an `ORDER BY column direction` clause. Direction defaults to `ASC`. */
  orderBy(column: string, direction: "ASC" | "DESC" = "ASC"): this {
    this.orderByClauses.push(`${column} ${direction}`);
    return this;
  }

  /** Sets the `LIMIT` clause. */
  limit(n: number): this {
    this.limitValue = n;
    return this;
  }

  /** Sets the `OFFSET` clause. */
  offset(n: number): this {
    this.offsetValue = n;
    return this;
  }

  /** Fetches a single record by primary key. Returns null if not found or if `id` is `0`. */
  find(id: number): InstanceType<M> | null {
    if (id === 0) return null;
    return this.where(this.model.primaryKey, "=", id).first();
  }

  first(): InstanceType<M> | null {
    this.limit(1);
    const records = this.all();
    return records[0] ?? null;
  }

  eachRaw(): Iterable<Record<string, unknown>> {
    const { sql, params } = this.toSQL();
    return this.model.database
      .getDb()
      .query(sql)
      .iterate(...(params as any[])) as Iterable<Record<string, unknown>>;
  }

  *each(): Iterable<InstanceType<M>> {
    for (const row of this.eachRaw()) {
      yield new this.model(row) as InstanceType<M>;
    }
  }

  count(): number {
    let sql = `SELECT COUNT(*) as count FROM ${this.model.tableName}`;
    if (this.joins.length > 0) {
      sql += ` ${this.joins.join(" ")}`;
    }
    if (this.conditions.length > 0) {
      sql += ` WHERE ${this.conditions.join(" AND ")}`;
    }
    const row = this.model.database
      .getDb()
      .query(sql)
      .get(...([...this.joinParams, ...this.params] as any[])) as {
      count: number;
    };
    return row.count;
  }

  all(): InstanceType<M>[] {
    return this.allRaw().map((row) => new this.model(row)) as InstanceType<M>[];
  }

  allRaw(): Record<string, unknown>[] {
    const { sql, params } = this.toSQL();
    return this.model.database
      .getDb()
      .query(sql)
      .all(...(params as any[])) as Record<string, unknown>[];
  }

  toSQL(): GeneratedSqlString {
    if (this.selectValue.length === 0) {
      throw new Error(
        "ApplicationRecordQuery selectValue is empty. Call select() before consuming the query.",
      );
    }
    let sql = `SELECT ${this.selectValue.join(", ")} FROM ${this.model.tableName}`;

    if (this.joins.length > 0) {
      sql += ` ${this.joins.join(" ")}`;
    }

    if (this.conditions.length > 0) {
      sql += ` WHERE ${this.conditions.join(" AND ")}`;
    }

    if (this.orderByClauses.length > 0) {
      sql += ` ORDER BY ${this.orderByClauses.join(", ")}`;
    }

    if (this.limitValue !== undefined) {
      sql += ` LIMIT ${this.limitValue}`;
    }

    if (this.offsetValue !== undefined) {
      sql += ` OFFSET ${this.offsetValue}`;
    }

    return { sql, params: [...this.joinParams, ...this.params] };
  }
}
