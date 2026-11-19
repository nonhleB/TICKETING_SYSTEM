// server/db.js
// SQLite database setup using better-sqlite3.
// Creates ticketai.db in the project root on first run and sets up all tables.

const Database = require("better-sqlite3");
const path = require("path");

const dbPath = path.join(__dirname, "../ticketai.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

// ── SCHEMA ───────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','agent','user')),
  name          TEXT NOT NULL,
  avatar        TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tickets (
  id                  TEXT PRIMARY KEY,
  uid                 TEXT UNIQUE NOT NULL,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL,
  submitted_by        TEXT NOT NULL,
  submitted_by_user_id TEXT NOT NULL,
  category            TEXT NOT NULL,
  priority            TEXT NOT NULL,
  confidence          INTEGER NOT NULL,
  summary             TEXT NOT NULL,
  keywords            TEXT NOT NULL DEFAULT '[]',
  status              TEXT NOT NULL DEFAULT 'Open',
  response            TEXT,
  tone                TEXT,
  responded_by        TEXT,
  assigned_to         TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,
  ticket_uid TEXT NOT NULL REFERENCES tickets(uid) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  author     TEXT NOT NULL,
  role       TEXT NOT NULL,
  avatar     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id        TEXT PRIMARY KEY,
  action    TEXT NOT NULL,
  by_name   TEXT NOT NULL,
  role      TEXT NOT NULL,
  detail    TEXT NOT NULL,
  at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(submitted_by_user_id);
CREATE INDEX IF NOT EXISTS idx_comments_ticket ON comments(ticket_uid);
`);

module.exports = db;
