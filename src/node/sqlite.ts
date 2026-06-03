import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { AppDatabase, AppPreparedStatement, AppRunResult } from "../db/types";

type SqliteDatabase = Database.Database;
type SqliteStatement = Database.Statement;

export class SqlitePreparedStatement implements AppPreparedStatement {
  private args: unknown[] = [];

  constructor(
    private readonly statement: SqliteStatement,
    private readonly sql: string,
  ) {}

  bind(...args: unknown[]): AppPreparedStatement {
    this.args = args;
    return this;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...this.args) as T[] };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.statement.get(...this.args) as T | undefined) ?? null;
  }

  async run(): Promise<AppRunResult> {
    const result = this.statement.run(...this.args);
    return { meta: { changes: result.changes } };
  }

  runSync(): AppRunResult {
    const result = this.statement.run(...this.args);
    return { meta: { changes: result.changes } };
  }

  toString(): string {
    return this.sql;
  }
}

export class SqliteD1Database implements AppDatabase {
  constructor(readonly raw: SqliteDatabase) {
    raw.pragma("foreign_keys = ON");
    raw.pragma("journal_mode = WAL");
  }

  prepare(sql: string): AppPreparedStatement {
    return new SqlitePreparedStatement(this.raw.prepare(sql), sql);
  }

  async batch(statements: AppPreparedStatement[]): Promise<AppRunResult[]> {
    const transaction = this.raw.transaction((items: AppPreparedStatement[]) => items.map((item) => {
      if (!(item instanceof SqlitePreparedStatement)) {
        throw new Error("SQLite batch received a non-SQLite prepared statement");
      }
      return item.runSync();
    }));
    return transaction(statements);
  }
}

export function openSqliteDatabase(filename: string): SqliteD1Database {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  return new SqliteD1Database(new Database(filename));
}

