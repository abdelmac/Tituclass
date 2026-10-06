import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function openDatabase(path = process.env.DATABASE_PATH || './data/medclass.sqlite') {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS classes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, timezone TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS members (
      class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('admin','editor','student')),
      subgroup TEXT NOT NULL DEFAULT '', last_visit TEXT,
      PRIMARY KEY(class_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL UNIQUE, subgroup TEXT NOT NULL DEFAULT '',
      expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      series_id TEXT, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL, updated_by TEXT NOT NULL REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS events_class ON events(class_id);
    CREATE TABLE IF NOT EXISTS history (
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE, version INTEGER NOT NULL,
      data TEXT NOT NULL, changed_fields TEXT NOT NULL, author_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL, UNIQUE(event_id,version)
    );
    CREATE TABLE IF NOT EXISTS announcements (
      id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      title TEXT NOT NULL, message TEXT NOT NULL, subgroup TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL CHECK(priority IN ('urgent','important','normal')),
      pinned INTEGER NOT NULL DEFAULT 0, expires_at TEXT, version INTEGER NOT NULL DEFAULT 1,
      author_id TEXT NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      subgroup TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, message TEXT NOT NULL,
      kind TEXT NOT NULL, event_id TEXT, author_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notifications_class ON notifications(class_id,created_at);
    CREATE INDEX IF NOT EXISTS notifications_page ON notifications(class_id,created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS members_user ON members(user_id,class_id);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS announcements_class ON announcements(class_id,updated_at);
    CREATE TABLE IF NOT EXISTS notification_reads (
      notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY(notification_id,user_id)
    );
  `);
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const value = fn(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
