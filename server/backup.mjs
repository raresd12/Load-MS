import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { rotateEpoch } from "./db.mjs";

// Daily database copy (decision H6-1): VACUUM INTO a consistent snapshot named
// loadms-YYYYMMDD-HHMMSS.db (UTC), then delete the oldest copies beyond keep.
// Usage: node server/backup.mjs <db> <dir> [keep=14]
//        node server/backup.mjs --rotate-epoch <db>   (after a restore)
//
// Every copy gets its own new database epoch (decision H6-31): a restored copy
// never carries the epoch the clients last saw, so they notice the rollback
// and link again instead of trusting sync positions the copy never reached.

export const BACKUP_PATTERN = /^loadms-\d{8}-\d{6}\.db$/;
export const DEFAULT_KEEP = 14;

function pad(value) {
  return String(value).padStart(2, "0");
}

export function backupFileName(date) {
  return `loadms-${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(
    date.getUTCHours(),
  )}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}.db`;
}

export function listBackups(dir) {
  return readdirSync(dir)
    .filter((name) => BACKUP_PATTERN.test(name))
    .sort();
}

/**
 * createBackup({ dbPath, dir, keep = 14, now = new Date() })
 *   -> { file, removed: string[] }
 * The copy is written under a .partial name and renamed when complete, so a
 * failed run never leaves a file that counts as a backup.
 */
export function createBackup({ dbPath, dir, keep = DEFAULT_KEEP, now = new Date() }) {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error("keep must be a whole number of at least 1.");
  }

  if (!existsSync(dbPath)) {
    throw new Error("The database file does not exist.");
  }

  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, backupFileName(now));
  const partial = `${file}.partial`;
  rmSync(partial, { force: true });

  const db = new DatabaseSync(dbPath);

  try {
    db.exec("PRAGMA busy_timeout = 10000");
    db.prepare("VACUUM INTO ?").run(partial);
  } finally {
    db.close();
  }

  stampNewEpoch(partial);

  renameSync(partial, file);

  const removed = [];
  const existing = listBackups(dir);

  for (const name of existing.slice(0, Math.max(0, existing.length - keep))) {
    rmSync(path.join(dir, name), { force: true });
    removed.push(name);
  }

  return { file, removed };
}

function hasEpochTable(db) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'server_meta'").get());
}

/** Gives the database file a new epoch; a database without the table is left as it is. */
export function stampNewEpoch(dbPath) {
  const db = new DatabaseSync(dbPath);

  try {
    db.exec("PRAGMA busy_timeout = 10000");
    return hasEpochTable(db) ? rotateEpoch(db) : null;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);

  if (args[0] === "--rotate-epoch") {
    if (!args[1] || !existsSync(args[1])) {
      console.error("Usage: node server/backup.mjs --rotate-epoch <db>");
      process.exit(2);
    }

    try {
      stampNewEpoch(args[1]);
      console.log("loadms database epoch rotated");
      process.exit(0);
    } catch (error) {
      console.error(`loadms epoch rotation failed: ${error?.message ?? error}`);
      process.exit(1);
    }
  }

  const [dbPath, dir, keepText] = args;

  if (!dbPath || !dir) {
    console.error("Usage: node server/backup.mjs <db> <dir> [keep=14]");
    process.exit(2);
  }

  try {
    const keep = keepText === undefined ? DEFAULT_KEEP : Number(keepText);
    const { file, removed } = createBackup({ dbPath, dir, keep });
    console.log(`loadms backup written: ${path.basename(file)}; removed ${removed.length} old copy(ies)`);
  } catch (error) {
    console.error(`loadms backup failed: ${error?.message ?? error}`);
    process.exit(1);
  }
}
