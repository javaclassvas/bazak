import Database from 'better-sqlite3';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversations (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    id              TEXT NOT NULL,
    role            TEXT NOT NULL,
    parts           TEXT NOT NULL,          -- JSON: the UIMessage parts exactly as rendered
    seq             INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, id)
  );
  CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (conversation_id, seq);
`;

function open(file: string): Db {
  const db = new Database(file);
  try {
    if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('quick_check failed');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

export type OpenResult = {
  db: Db;
  /** Set when the existing file was unreadable and has been moved aside. */
  recoveredFrom?: string;
};

/**
 * Open the database, creating it if needed.
 *
 * A file that SQLite cannot read is not repaired and not deleted: it is renamed to `*.corrupt-<time>`
 * and a fresh database takes its place. Losing history is bad; refusing to start is worse; silently
 * deleting the evidence is worst.
 */
export function openDatabase(file: string): OpenResult {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  try {
    return { db: open(file) };
  } catch (err) {
    if (file === ':memory:' || !existsSync(file)) throw err;
    const aside = `${file}.corrupt-${Date.now()}`;
    renameSync(file, aside);
    for (const suffix of ['-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
    console.error(`[db] ${file} is unreadable (${err instanceof Error ? err.message : err}). Moved to ${aside}; starting empty.`);
    return { db: open(file), recoveredFrom: aside };
  }
}

// One connection per process. `globalThis` survives dev-server module reloads.
const globalForDb = globalThis as unknown as { __copilotDb?: OpenResult };

export function getDatabase(): OpenResult {
  globalForDb.__copilotDb ??= openDatabase(process.env.DATABASE_PATH ?? 'data/copilot.db');
  return globalForDb.__copilotDb;
}
