import { DatabaseSync } from 'node:sqlite';
import type { Database, SqlValue, Statement } from './database.js';

// node:sqlite accepts plain values only, so booleans become 0 or 1 and
// undefined becomes NULL, which matches how the old D1 binding stored them.
function toSql(value: unknown): SqlValue {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value as SqlValue;
}

// Statements are compiled again on every call. That keeps them independent
// of each other, and node:sqlite caches nothing that would make reuse faster
// for the short queries this app runs.
function statement(sqlite: DatabaseSync, query: string, values: SqlValue[] = []): Statement {
  return {
    bind: (...params) => statement(sqlite, query, params.map(toSql)),
    async first<T>(column?: string) {
      const row = sqlite.prepare(query).get(...values) as Record<string, unknown> | undefined;
      if (!row) return null;
      return (column ? row[column] ?? null : row) as T | null;
    },
    async all<T>() { return { results: sqlite.prepare(query).all(...values) as T[] }; },
    async raw<T>() {
      const s = sqlite.prepare(query);
      s.setReturnArrays(true);
      return s.all(...values) as T[];
    },
    async run() { return { changes: Number(sqlite.prepare(query).run(...values).changes) }; },
  };
}

export function openDatabase(sqlite: DatabaseSync, readOnly = false): Database {
  return {
    readOnly,
    prepare: query => statement(sqlite, query),
    async batch<T>(statements: Statement[]) {
      sqlite.exec('BEGIN');
      try {
        const out: { results: T[] }[] = [];
        for (const s of statements) out.push(await s.all<T>());
        sqlite.exec('COMMIT');
        return out;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    async exec(query: string) { sqlite.exec(query); },
  };
}

export function openSQLite(path: string, readOnly = false) {
  const sqlite = new DatabaseSync(path, { readOnly });
  sqlite.exec('PRAGMA busy_timeout=5000');
  return { db: openDatabase(sqlite, readOnly), close: () => sqlite.close() };
}
