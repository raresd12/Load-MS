import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { backupFileName, createBackup, DEFAULT_KEEP, listBackups } from "../server/backup.mjs";
import { getSchemaVersion, openDatabase, SCHEMA_VERSION } from "../server/db.mjs";

// H6 Track A: daily VACUUM INTO copies and their retention (decision H6-1),
// plus the database file itself (WAL, migrations by user_version). Works in a
// temporary directory that is removed afterwards.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(os.tmpdir(), "loadms-backup-"));

try {
  const dbPath = path.join(temp, "data", "loadms.db");
  const db = openDatabase(dbPath);
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal", "the file database runs in WAL mode");
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
  db.prepare("INSERT INTO users (id, username, password_hash, recovery_hash, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)").run(
    "u_backup",
    "backup-user",
    "scrypt$x",
    "scrypt$y",
    1,
    1,
  );
  db.prepare(
    "INSERT INTO records (user_id, collection, record_id, rev, seq, deleted, body, hash, size, updated_at, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("u_backup", "sessions", "s1", 1, 1, 0, '{"id":"s1"}', "h", 11, 1, "d");

  // Reopening runs no migration twice.
  const reopened = openDatabase(dbPath);
  assert.equal(getSchemaVersion(reopened), SCHEMA_VERSION);
  reopened.close();

  // A newer schema than this server knows is refused, never rewritten.
  const futurePath = path.join(temp, "future.db");
  const future = new DatabaseSync(futurePath);
  future.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  future.close();
  assert.throws(() => openDatabase(futurePath), /newer than this server/);

  // ---- names --------------------------------------------------------------------------
  assert.equal(backupFileName(new Date(Date.UTC(2026, 9, 7, 3, 4, 5))), "loadms-20261007-030405.db");
  assert.equal(DEFAULT_KEEP, 14);

  // ---- a copy holds the live data (WAL included) -----------------------------------------
  const dir = path.join(temp, "backups");
  const firstRun = createBackup({ dbPath, dir, keep: 3, now: new Date(Date.UTC(2026, 9, 1, 3, 0, 0)) });
  assert.equal(path.basename(firstRun.file), "loadms-20261001-030000.db");
  assert.deepEqual(firstRun.removed, []);
  const copy = new DatabaseSync(firstRun.file);
  assert.equal(copy.prepare("SELECT body FROM records WHERE record_id = 's1'").get().body, '{"id":"s1"}', "the copy has the committed rows");
  assert.equal(copy.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  assert.equal(copy.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  copy.close();

  // ---- retention -------------------------------------------------------------------------------
  writeFileSync(path.join(dir, "notes.txt"), "not a backup");
  for (let day = 2; day <= 5; day += 1) {
    createBackup({ dbPath, dir, keep: 3, now: new Date(Date.UTC(2026, 9, day, 3, 0, 0)) });
  }
  assert.deepEqual(listBackups(dir), ["loadms-20261003-030000.db", "loadms-20261004-030000.db", "loadms-20261005-030000.db"], "the 3 newest are kept");
  assert.ok(existsSync(path.join(dir, "notes.txt")), "other files in the directory are left alone");
  assert.ok(!readdirSync(dir).some((name) => name.endsWith(".partial")), "no partial file is left behind");
  assert.throws(() => createBackup({ dbPath, dir, keep: 0 }), /keep/);
  assert.throws(() => createBackup({ dbPath: path.join(temp, "missing.db"), dir }), /does not exist/);
  assert.ok(!existsSync(path.join(temp, "missing.db")), "a missing database is never created by a backup");

  // ---- the CLI the timer runs ---------------------------------------------------------------------
  const cli = spawnSync(process.execPath, [path.join(root, "server", "backup.mjs"), dbPath, dir, "2"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /loadms backup written: loadms-\d{8}-\d{6}\.db; removed 2 old copy\(ies\)/);
  assert.equal(listBackups(dir).length, 2);
  const usage = spawnSync(process.execPath, [path.join(root, "server", "backup.mjs")], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  db.close();
} finally {
  rmSync(temp, { recursive: true, force: true });
}

assert.ok(!existsSync(temp), "the temporary directory is removed");
console.log("verify-server-backup: ok");
