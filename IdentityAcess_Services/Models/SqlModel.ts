import { query } from "../Config/db.ts";
import { newId } from "../Utils/crypto.ts";

/**
 * Small, explicit persistence helper for the identity service.
 *
 * Every model below declares the exact columns it needs; identifiers are
 * allow-listed from that declaration and every value is sent as a bound
 * parameter. Nothing is stored as an opaque document: the tables are regular
 * PostgreSQL tables (see Config/schema.sql), which keeps the data portable to
 * a managed PostgreSQL instance later.
 */

export type SqlDocument<T> = T & { _id: string; save(): Promise<void> };

type Filter = Record<string, unknown>;
type Changes = {
  $set?: Filter;
  $setOnInsert?: Filter;
  $inc?: Record<string, number>;
};
type Options = { new?: boolean; upsert?: boolean; setDefaultsOnInsert?: boolean };
type QueryOptions = {
  select: string;
  sort: Record<string, number>;
  skip: number;
  limit?: number;
};

/** Columns that PostgreSQL returns as JSON text and should become objects. */
const JSON_COLUMNS = new Set(["metadata"]);

function bindValue(values: unknown[], value: unknown): string {
  let prepared = value;

  if (
    value !== null &&
    typeof value === "object" &&
    !(value instanceof Date) &&
    !Buffer.isBuffer(value) &&
    !(value instanceof Uint8Array)
  ) {
    prepared = JSON.stringify(value);
  }

  values.push(prepared === undefined ? null : prepared);
  return `$${values.length}`;
}

class SqlQuery<R> implements Promise<R> {
  private options: QueryOptions = { select: "", sort: {}, skip: 0 };
  private result?: Promise<R>;

  constructor(private readonly execute: (options: QueryOptions) => Promise<R>) {}

  select(fields: string): this {
    this.options.select = fields;
    return this;
  }

  sort(fields: Record<string, number>): this {
    this.options.sort = fields;
    return this;
  }

  skip(value: number): this {
    this.options.skip = value;
    return this;
  }

  limit(value: number): this {
    this.options.limit = value;
    return this;
  }

  lean(): this {
    return this;
  }

  then<A = R, B = never>(
    resolve?: ((value: R) => A | PromiseLike<A>) | null,
    reject?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    this.result ??= this.execute(this.options);
    return this.result.then(resolve, reject);
  }

  catch<B = never>(
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<R | B> {
    return this.then(undefined, onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<R> {
    return this.then(
      (value) => {
        onfinally?.();
        return value;
      },
      (error: unknown) => {
        onfinally?.();
        throw error;
      },
    );
  }

  readonly [Symbol.toStringTag] = "Promise";
}

export class SqlModel<T extends object> {
  private readonly fields: Set<string>;
  private readonly hidden: Set<string>;

  constructor(
    private readonly table: string,
    columns: string,
    hidden: string[] = [],
  ) {
    if (!/^[a-z_]+$/.test(table)) throw new Error("Invalid SQL table name");
    this.fields = new Set(["_id", ...columns.split(/\s+/).filter(Boolean)]);
    this.hidden = new Set(hidden);
  }

  private col(field: string): string {
    if (!this.fields.has(field)) {
      throw new Error(`Unknown ${this.table} column: ${field}`);
    }
    return `"${field}"`;
  }

  private where(filter: Filter, values: unknown[]): string {
    const parts: string[] = [];

    for (const [key, value] of Object.entries(filter)) {
      if (key === "$or") {
        if (!Array.isArray(value)) throw new Error("Invalid OR filter");
        parts.push(
          value.length
            ? `(${value
                .map((part) => this.where(part as Filter, values))
                .join(" OR ")})`
            : "FALSE",
        );
        continue;
      }

      const column = this.col(key);

      if (value === null || value === undefined) {
        parts.push(`${column} IS NULL`);
        continue;
      }

      if (value instanceof RegExp) {
        parts.push(
          `${column} ${value.ignoreCase ? "~*" : "~"} ${bindValue(values, value.source)}`,
        );
        continue;
      }

      if (typeof value === "object" && !(value instanceof Date)) {
        const conditions = Object.entries(value as Record<string, unknown>).map(
          ([operator, operand]) => {
            if (operator === "$in") {
              if (!Array.isArray(operand)) throw new Error("Invalid IN filter");
              return operand.length
                ? `${column} IN (${operand
                    .map((item) => bindValue(values, item))
                    .join(",")})`
                : "FALSE";
            }
            if (operator === "$nin") {
              if (!Array.isArray(operand)) throw new Error("Invalid NIN filter");
              return operand.length
                ? `${column} NOT IN (${operand
                    .map((item) => bindValue(values, item))
                    .join(",")})`
                : "TRUE";
            }
            if (operator === "$ne") {
              return `${column} IS DISTINCT FROM ${bindValue(values, operand)}`;
            }
            const comparison = (
              { $gt: ">", $gte: ">=", $lt: "<", $lte: "<=" } as Record<
                string,
                string
              >
            )[operator];
            if (!comparison) {
              throw new Error(`Unsupported SQL filter operator: ${operator}`);
            }
            return `${column} ${comparison} ${bindValue(values, operand)}`;
          },
        );
        parts.push(conditions.join(" AND "));
        continue;
      }

      parts.push(`${column} = ${bindValue(values, value)}`);
    }

    return parts.length > 0 ? parts.join(" AND ") : "TRUE";
  }

  private projection(selection = ""): string {
    const requested = new Set(
      selection
        .split(/\s+/)
        .map((value) => value.trim())
        .filter((value) => value.startsWith("+"))
        .map((value) => value.slice(1)),
    );

    for (const field of requested) this.col(field);

    return [...this.fields]
      .filter((field) => !this.hidden.has(field) || requested.has(field))
      .map((field) => this.col(field))
      .join(", ");
  }

  private hydrate(row: Record<string, unknown>): SqlDocument<T> {
    const data: Record<string, unknown> = { ...row };

    for (const [key, value] of Object.entries(data)) {
      if (
        (key.endsWith("_at") || key === "locked_until") &&
        typeof value === "string"
      ) {
        data[key] = new Date(value);
      }
      if (
        JSON_COLUMNS.has(key) &&
        typeof value === "string" &&
        value.length > 0
      ) {
        try {
          data[key] = JSON.parse(value);
        } catch {
          // Keep the original value when it is not valid JSON.
        }
      }
    }

    let snapshot: Record<string, unknown> = { ...data };
    const document = data as unknown as SqlDocument<T>;

    Object.defineProperty(document, "save", {
      enumerable: false,
      value: async () => {
        const changed: Filter = {};
        for (const field of this.fields) {
          if (field === "_id") continue;
          if (data[field] !== snapshot[field]) {
            changed[field] = data[field] ?? null;
          }
        }
        if (Object.keys(changed).length > 0) {
          await this.updateOne({ _id: document._id }, { $set: changed });
          snapshot = { ...data };
        }
      },
    });

    return document;
  }

  find(filter: Filter = {}): SqlQuery<SqlDocument<T>[]> {
    return new SqlQuery(async (options) => {
      const values: unknown[] = [];
      const where = this.where(filter, values);
      const order = Object.entries(options.sort).map(
        ([field, direction]) =>
          `${this.col(field)} ${direction < 0 ? "DESC" : "ASC"}`,
      );
      order.push(`${this.col("_id")} ASC`);
      const limit =
        options.limit == null ? "" : ` LIMIT ${bindValue(values, options.limit)}`;
      const offset = ` OFFSET ${bindValue(values, options.skip)}`;
      const rows = await query(
        `SELECT ${this.projection(options.select)} FROM ${this.table} WHERE ${where} ORDER BY ${order.join(", ")}${limit}${offset}`,
        values,
      );
      return rows.map((row) => this.hydrate(row));
    });
  }

  findOne(filter: Filter): SqlQuery<SqlDocument<T> | null> {
    return new SqlQuery(async (options) => {
      const rows = await this.find(filter).select(options.select).limit(1);
      return rows[0] ?? null;
    });
  }

  async exists(filter: Filter): Promise<boolean> {
    const values: unknown[] = [];
    const rows = await query(
      `SELECT 1 FROM ${this.table} WHERE ${this.where(filter, values)} LIMIT 1`,
      values,
    );
    return rows.length > 0;
  }

  async countDocuments(filter: Filter): Promise<number> {
    const values: unknown[] = [];
    const rows = await query(
      `SELECT count(*)::integer AS count FROM ${this.table} WHERE ${this.where(filter, values)}`,
      values,
    );
    return Number(rows[0]?.count ?? 0);
  }

  async create(input: Partial<T> & { _id?: string }): Promise<SqlDocument<T>> {
    const source = input as Record<string, unknown>;
    const record: Record<string, unknown> = {
      ...source,
      _id: source._id ?? newId(),
    };
    const entries = Object.entries(record).filter(
      ([, value]) => value !== undefined,
    );
    const values: unknown[] = [];
    const columns = entries.map(([key]) => this.col(key));
    const parameters = entries.map(([, value]) =>
      bindValue(values, value),
    );
    const rows = await query(
      `INSERT INTO ${this.table} (${columns.join(",")}) VALUES (${parameters.join(",")}) RETURNING *`,
      values,
    );
    const row = rows[0];
    if (!row) throw new Error(`Insert into ${this.table} returned no row`);
    return this.hydrate(row);
  }

  private assignments(update: Changes, values: unknown[]): string[] {
    const sets: string[] = [];

    for (const [key, value] of Object.entries(update.$set ?? {})) {
      sets.push(`${this.col(key)} = ${bindValue(values, value)}`);
    }

    for (const [key, value] of Object.entries(update.$inc ?? {})) {
      sets.push(
        `${this.col(key)} = ${this.table}.${this.col(key)} + ${bindValue(values, value)}`,
      );
    }

    if (this.fields.has("updated_at")) {
      sets.push(`${this.col("updated_at")} = CURRENT_TIMESTAMP`);
    }

    return sets;
  }

  findOneAndUpdate(
    filter: Filter,
    update: Changes,
    options: Options & { upsert: true },
  ): SqlQuery<SqlDocument<T>>;
  findOneAndUpdate(
    filter: Filter,
    update: Changes,
    options?: Options,
  ): SqlQuery<SqlDocument<T> | null>;
  findOneAndUpdate(
    filter: Filter,
    update: Changes,
    options: Options = {},
  ): SqlQuery<SqlDocument<T> | null> {
    return new SqlQuery(async () => {
      const values: unknown[] = [];

      if (options.upsert) {
        for (const value of Object.values(filter)) {
          if (value == null || typeof value === "object") {
            throw new Error("Upsert requires scalar unique keys");
          }
        }

        const input: Record<string, unknown> = {
          ...filter,
          ...update.$setOnInsert,
          ...update.$set,
          ...update.$inc,
        };
        const entries = Object.entries(input).filter(
          ([, value]) => value !== undefined,
        );
        const columns = entries.map(([key]) => this.col(key));
        const parameters = entries.map(([, value]) =>
          bindValue(values, value),
        );
        const sets = this.assignments(update, values);

        if (sets.length === 0) {
          const key = Object.keys(filter)[0];
          if (!key) throw new Error("Upsert requires a filter");
          sets.push(`${this.col(key)} = EXCLUDED.${this.col(key)}`);
        }

        const targets = Object.keys(filter).map((key) => this.col(key));
        const rows = await query(
          `INSERT INTO ${this.table} (${columns.join(",")}) VALUES (${parameters.join(",")}) ON CONFLICT (${targets.join(",")}) DO UPDATE SET ${sets.join(",")} RETURNING *`,
          values,
        );
        const row = rows[0];
        if (!row) throw new Error(`Upsert into ${this.table} returned no row`);
        return this.hydrate(row);
      }

      const sets = this.assignments(update, values);
      if (sets.length === 0) return await this.findOne(filter);

      const where = this.where(filter, values);
      const rows = await query(
        `UPDATE ${this.table} SET ${sets.join(",")} WHERE "_id" IN (SELECT "_id" FROM ${this.table} WHERE ${where} LIMIT 1 FOR UPDATE) RETURNING *`,
        values,
      );
      const row = rows[0];
      return row ? this.hydrate(row) : null;
    });
  }

  findByIdAndUpdate(
    id: string,
    update: Changes,
    options: Options & { upsert: true },
  ): SqlQuery<SqlDocument<T>>;
  findByIdAndUpdate(
    id: string,
    update: Changes,
    options?: Options,
  ): SqlQuery<SqlDocument<T> | null>;
  findByIdAndUpdate(
    id: string,
    update: Changes,
    options: Options = {},
  ): SqlQuery<SqlDocument<T> | null> {
    return this.findOneAndUpdate({ _id: id }, update, options);
  }

  async updateOne(
    filter: Filter,
    update: Changes,
    options: Options = {},
  ): Promise<{ modifiedCount: number }> {
    const row = await this.findOneAndUpdate(filter, update, options);
    return { modifiedCount: row ? 1 : 0 };
  }

  async updateMany(
    filter: Filter,
    update: Changes,
  ): Promise<{ modifiedCount: number }> {
    const values: unknown[] = [];
    const sets = this.assignments(update, values);
    if (sets.length === 0) return { modifiedCount: 0 };

    const rows = await query(
      `UPDATE ${this.table} SET ${sets.join(",")} WHERE ${this.where(filter, values)} RETURNING "_id"`,
      values,
    );
    return { modifiedCount: rows.length };
  }

  async deleteOne(filter: Filter): Promise<void> {
    const values: unknown[] = [];
    await query(
      `DELETE FROM ${this.table} WHERE "_id" IN (SELECT "_id" FROM ${this.table} WHERE ${this.where(filter, values)} LIMIT 1)`,
      values,
    );
  }
}
