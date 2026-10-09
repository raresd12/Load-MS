import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// SQLite storage for the sync API (decisions H6-1, H6-4). node:sqlite works
// without a flag from Node 22.13 (decision H6-37); only DatabaseSync, exec,
// prepare, run, get and all are used.
// Migrations are keyed by PRAGMA user_version and only ever move forward.

const MIGRATIONS = [
  // 1: accounts, tokens, the schema-agnostic record store and the op log.
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    recovery_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE tokens (
    hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX tokens_user ON tokens(user_id);
  CREATE INDEX tokens_expires ON tokens(expires_at);

  CREATE TABLE records (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    collection TEXT NOT NULL,
    record_id TEXT NOT NULL,
    rev INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    body TEXT,
    hash TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    device_id TEXT,
    PRIMARY KEY (user_id, collection, record_id)
  );
  CREATE UNIQUE INDEX records_user_seq ON records(user_id, seq);

  CREATE TABLE applied_ops (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    op_id TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, op_id)
  );
  CREATE INDEX applied_ops_created ON applied_ops(created_at);
  `,
  // 2: the database epoch (decision H6-31) - a random id that changes when a
  // backup copy is made or restored, so a client that synced against newer
  // data notices the rollback - and the per-user op log index the op cap
  // prunes by (decision H6-32).
  `
  CREATE TABLE server_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  INSERT INTO server_meta (key, value) VALUES ('epoch', lower(hex(randomblob(16))));
  CREATE INDEX applied_ops_user_created ON applied_ops(user_id, created_at);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDatabase(file = ":memory:") {
  if (file !== ":memory:" && !file.startsWith("file:")) {
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }

  const db = new DatabaseSync(file);

  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }

  return db;
}

export function getSchemaVersion(db) {
  return Number(db.prepare("PRAGMA user_version").get().user_version);
}

export function migrate(db) {
  let version = getSchemaVersion(db);

  if (version > SCHEMA_VERSION) {
    throw new Error(`Database schema ${version} is newer than this server (${SCHEMA_VERSION}).`);
  }

  while (version < SCHEMA_VERSION) {
    db.exec("BEGIN IMMEDIATE");

    try {
      db.exec(MIGRATIONS[version]);
      version += 1;
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return version;
}

export function getEpoch(db) {
  return String(db.prepare("SELECT value FROM server_meta WHERE key = 'epoch'").get()?.value ?? "");
}

// Gives the database a new random epoch (decision H6-31). Run on every backup
// copy and again after a restore, so clients never trust their sync position
// across a rollback.
export function rotateEpoch(db) {
  db.prepare("INSERT INTO server_meta (key, value) VALUES ('epoch', lower(hex(randomblob(16)))) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
  return getEpoch(db);
}

// Runs fn inside BEGIN IMMEDIATE ... COMMIT and rolls back when it throws.
// fn must be synchronous: DatabaseSync keeps the whole transaction on one tick.
export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");

  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction is already gone (SQLite rolled it back itself).
    }

    throw error;
  }
}
