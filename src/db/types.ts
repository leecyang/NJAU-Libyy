export type AppRunResult = {
  meta: {
    changes: number;
  };
};

export interface AppPreparedStatement {
  bind(...args: unknown[]): AppPreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<AppRunResult>;
}

export interface AppDatabase {
  prepare(sql: string): AppPreparedStatement;
  batch(statements: AppPreparedStatement[]): Promise<AppRunResult[]>;
}
