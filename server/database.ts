// The small slice of a SQL database that the server needs. It mirrors the
// prepare, bind and run style the code already uses, so a snapshot opened
// with node:sqlite and an in-memory test database share one type.
export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, unknown>;

export interface Statement {
  // Returns a new statement with these parameters. The original is unchanged.
  bind(...params: unknown[]): Statement;
  // The first row, or one column of it, or null when nothing matches.
  first<T = Row>(column?: string): Promise<T | null>;
  all<T = Row>(): Promise<{ results: T[] }>;
  // Rows as arrays of column values in select order.
  raw<T = unknown[]>(): Promise<T[]>;
  run(): Promise<{ changes: number }>;
}

export interface Database {
  // A read-only snapshot skips schema setup and every write.
  readonly readOnly?: boolean;
  prepare(query: string): Statement;
  // Runs every statement inside one transaction and returns each result set.
  batch<T = Row>(statements: Statement[]): Promise<{ results: T[] }[]>;
  exec(query: string): Promise<void>;
}
