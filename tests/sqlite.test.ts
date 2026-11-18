import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { openSQLite } from '../server/sqlite';

async function people() {
  const { db, close } = openSQLite(':memory:');
  await db.exec('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER)');
  return { db, close };
}

describe('node:sqlite database adapter', () => {
  it('returns rows, single columns and null when nothing matches', async () => {
    const { db, close } = await people();
    await db.prepare('INSERT INTO people(name, active) VALUES (?, ?), (?, ?)').bind('Ada', 1, 'Lin', 0).run();
    expect(await db.prepare('SELECT name FROM people WHERE id = ?').bind(1).first()).toEqual({ name: 'Ada' });
    expect(await db.prepare('SELECT count(*) AS n FROM people').first<number>('n')).toBe(2);
    expect(await db.prepare('SELECT name FROM people WHERE id = ?').bind(99).first()).toBeNull();
    expect(await db.prepare('SELECT name FROM people WHERE id = ?').bind(99).first('name')).toBeNull();
    expect((await db.prepare('SELECT name FROM people ORDER BY id').all<{ name: string }>()).results.map(r => r.name)).toEqual(['Ada', 'Lin']);
    expect(await db.prepare('SELECT id, name FROM people ORDER BY id').raw()).toEqual([[1, 'Ada'], [2, 'Lin']]);
    close();
  });

  it('reports how many rows a write changed', async () => {
    const { db, close } = await people();
    await db.prepare("INSERT INTO people(name) VALUES ('a'), ('b'), ('c')").run();
    expect(await db.prepare("UPDATE people SET active = 1 WHERE name <> 'b'").run()).toEqual({ changes: 2 });
    close();
  });

  it('binds into a new statement and leaves the original untouched', async () => {
    const { db, close } = await people();
    await db.prepare("INSERT INTO people(name) VALUES ('Ada'), ('Lin')").run();
    const byId = db.prepare('SELECT name FROM people WHERE id = ?');
    const first = byId.bind(1), second = byId.bind(2);
    expect(await first.first('name')).toBe('Ada');
    expect(await second.first('name')).toBe('Lin');
    close();
  });

  it('stores booleans as 0 or 1 and undefined as NULL', async () => {
    const { db, close } = await people();
    await db.prepare('INSERT INTO people(name, active) VALUES (?, ?), (?, ?)').bind('yes', true, 'unset', undefined).run();
    expect(await db.prepare('SELECT name, active FROM people ORDER BY id').raw()).toEqual([['yes', 1], ['unset', null]]);
    close();
  });

  it('runs a batch in one transaction and rolls it all back on failure', async () => {
    const { db, close } = await people();
    const results = await db.batch([
      db.prepare("INSERT INTO people(name) VALUES ('kept') RETURNING id"),
      db.prepare('SELECT name FROM people'),
    ]);
    expect(results.map(r => r.results.length)).toEqual([1, 1]);
    await expect(db.batch([
      db.prepare("INSERT INTO people(name) VALUES ('lost')"),
      db.prepare('INSERT INTO people(name) VALUES (NULL)'),
    ])).rejects.toThrow();
    expect(await db.prepare('SELECT count(*) AS n FROM people').first('n')).toBe(1);
    close();
  });

  it('opens a file read-only so writes fail and readOnly is set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-sqlite-'));
    const path = join(dir, 'snapshot.sqlite');
    const writer = openSQLite(path);
    await writer.db.exec("CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('saved')");
    writer.close();
    const reader = openSQLite(path, true);
    expect(reader.db.readOnly).toBe(true);
    expect(await reader.db.prepare('SELECT x FROM t').first('x')).toBe('saved');
    await expect(reader.db.prepare("INSERT INTO t VALUES ('nope')").run()).rejects.toThrow();
    reader.close();
    await rm(dir, { recursive: true, force: true });
  });
});
