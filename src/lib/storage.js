import { useCallback, useEffect, useRef, useState } from "react";

export const STORAGE_KEYS = {
  sessions: "rpe-tracker.sessions.v1",
  nextPlans: "rpe-tracker.next-plans.v1",
  setupCues: "rpe-tracker.setup-cues.v1",
  readinessByDate: "rpe-tracker.readiness-by-date.v1",
  workoutDrafts: "rpe-tracker.workout-drafts.v1",
  appUiState: "rpe-tracker.app-ui-state.v1",
  programStorageMeta: "rpe-tracker.program-storage-meta.v1",
  programs: "rpe-tracker.programs.v1",
  activeProgramId: "rpe-tracker.active-program-id.v1",
  programDays: "rpe-tracker.program-days.v1",
  programSections: "rpe-tracker.program-sections.v1",
  exerciseLibrary: "rpe-tracker.exercise-library.v1",
  programExercises: "rpe-tracker.program-exercises.v1",
  baselines: "rpe-tracker.baselines.v1",
  programStates: "rpe-tracker.program-states.v1",
  programProgressions: "rpe-tracker.program-progressions.v1",
  // Saved program drafts (decision H2-3): structured draft text only, so the
  // key is tracked (backup / reset) like every other app key.
  programDrafts: "rpe-tracker.program-drafts.v1",
};

export const BACKUP_SCHEMA_VERSION = 1;
export const BACKUP_APP_ID = "rpe-workout-tracker";

export function getTrackedStorageKeys() {
  return Object.values(STORAGE_KEYS);
}

// ---------------------------------------------------------------------------
// Storage issues observable (decision new-G, review finding F2).
// Issues are in-memory only; the UI decides how to surface them.
// kind: "read-corrupt" | "write-failed" | "quota"
// ---------------------------------------------------------------------------

export const STORAGE_ISSUE_KINDS = Object.freeze({
  readCorrupt: "read-corrupt",
  writeFailed: "write-failed",
  quota: "quota",
});

export const STORAGE_ERROR_CODES = Object.freeze({
  quota: "quota",
  write: "write",
  serialize: "serialize",
  unavailable: "unavailable",
  read: "read",
  // The key currently holds unreadable JSON and the caller did not ask to
  // overwrite it (decision new-U).
  corrupt: "corrupt",
});

export const MAX_CORRUPT_COPIES_PER_KEY = 3;

let storageIssues = [];
const storageIssueSubscribers = new Set();

function warnStorageError(message, error) {
  console.warn(`[RPE Tracker storage] ${message}`, error);
}

function notifyStorageIssueSubscribers() {
  const snapshot = getStorageIssues();

  storageIssueSubscribers.forEach((callback) => {
    try {
      callback(snapshot);
    } catch (error) {
      warnStorageError("A storage issue subscriber threw.", error);
    }
  });
}

function isSameStorageIssue(existing, { key, kind, message, extra }) {
  if (!existing || existing.key !== key || existing.kind !== kind || existing.message !== message) {
    return false;
  }

  return Object.entries(extra ?? {}).every(([field, value]) => existing[field] === value);
}

function recordStorageIssue({ key, kind, message, extra }) {
  // One live issue per key + kind. Re-recording an identical issue (the same
  // corrupt key read again during a render) keeps the existing entry and does
  // not notify: a notification is a React state update in App.jsx, and a read
  // that happens during render must not schedule another render (render loop).
  const existing = storageIssues.find(
    (candidate) => candidate.key === key && candidate.kind === kind,
  );

  if (isSameStorageIssue(existing, { key, kind, message, extra })) {
    return existing;
  }

  const issue = {
    key,
    kind,
    message,
    at: new Date().toISOString(),
    ...(extra ?? {}),
  };

  storageIssues = [
    ...storageIssues.filter((candidate) => !(candidate.key === key && candidate.kind === kind)),
    issue,
  ];
  notifyStorageIssueSubscribers();

  return issue;
}

function clearStorageIssuesOfKinds(key, kinds) {
  const before = storageIssues.length;
  storageIssues = storageIssues.filter(
    (issue) => !(issue.key === key && kinds.includes(issue.kind)),
  );

  if (storageIssues.length !== before) {
    notifyStorageIssueSubscribers();
  }
}

export function getStorageIssues() {
  return storageIssues.map((issue) => ({ ...issue }));
}

export function subscribeStorageIssues(callback) {
  if (typeof callback !== "function") {
    return () => {};
  }

  storageIssueSubscribers.add(callback);

  return () => {
    storageIssueSubscribers.delete(callback);
  };
}

export function clearStorageIssue(key, kind) {
  const before = storageIssues.length;
  storageIssues = storageIssues.filter(
    (issue) => !(issue.key === key && (kind === undefined || issue.kind === kind)),
  );

  if (storageIssues.length !== before) {
    notifyStorageIssueSubscribers();
  }
}

export function isQuotaError(error) {
  if (!error) {
    return false;
  }

  return (
    error.name === "QuotaExceededError" ||
    error.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    error.code === 22 ||
    error.code === 1014
  );
}

function getStorageErrorCode(error) {
  return isQuotaError(error) ? STORAGE_ERROR_CODES.quota : STORAGE_ERROR_CODES.write;
}

function getStorageErrorMessage(error, fallbackMessage) {
  if (isQuotaError(error)) {
    return "Browser storage is full. Export a backup, then free browser storage before saving more data.";
  }

  return error?.message ? `${fallbackMessage} ${error.message}` : fallbackMessage;
}

function getCorruptCopyKey(key, index) {
  return `${key}.corrupt-${index}`;
}

/**
 * Decision new-G: copy an unparsable raw value to `<key>.corrupt-<n>` before any
 * fallback is used. Never overwrites an existing copy, never writes the fallback
 * back over the corrupt value, and keeps at most MAX_CORRUPT_COPIES_PER_KEY copies.
 * Returns the copy key, or null when no copy could be made.
 */
function preserveCorruptStorageValue(key, rawValue) {
  let firstFreeKey = null;

  for (let index = 1; index <= MAX_CORRUPT_COPIES_PER_KEY; index += 1) {
    const copyKey = getCorruptCopyKey(key, index);
    let existing = null;

    try {
      existing = window.localStorage.getItem(copyKey);
    } catch (error) {
      warnStorageError(`Could not inspect ${copyKey}.`, error);
      return null;
    }

    if (existing === rawValue) {
      // The same corrupt value is already preserved; do not use another slot.
      return copyKey;
    }

    if (existing === null && !firstFreeKey) {
      firstFreeKey = copyKey;
    }
  }

  if (!firstFreeKey) {
    return null;
  }

  try {
    window.localStorage.setItem(firstFreeKey, rawValue);
    return firstFreeKey;
  } catch (error) {
    warnStorageError(`Could not preserve corrupt value of ${key} at ${firstFreeKey}.`, error);
    return null;
  }
}

/**
 * Checked read. Returns { value, ok, error, code, corrupt, corruptCopyKey }.
 * `value` is always usable: the parsed value or the fallback.
 */
export function readStorageResult(key, fallbackValue) {
  if (typeof window === "undefined") {
    return {
      value: fallbackValue,
      ok: false,
      error: "Local storage is not available.",
      code: STORAGE_ERROR_CODES.unavailable,
      corrupt: false,
      corruptCopyKey: null,
    };
  }

  let stored;

  try {
    stored = window.localStorage.getItem(key);
  } catch (error) {
    const message = getStorageErrorMessage(error, `Could not read ${key} from local storage.`);
    warnStorageError(message, error);
    return {
      value: fallbackValue,
      ok: false,
      error: message,
      code: STORAGE_ERROR_CODES.read,
      corrupt: false,
      corruptCopyKey: null,
    };
  }

  if (stored === null || stored === "") {
    return {
      value: fallbackValue,
      ok: true,
      error: null,
      code: null,
      corrupt: false,
      corruptCopyKey: null,
    };
  }

  try {
    return {
      value: JSON.parse(stored),
      ok: true,
      error: null,
      code: null,
      corrupt: false,
      corruptCopyKey: null,
    };
  } catch (error) {
    const flagged = flagCorruptStorageValue(key, stored, error);

    return {
      value: fallbackValue,
      ok: false,
      error: flagged.message,
      code: STORAGE_ERROR_CODES.read,
      corrupt: true,
      corruptCopyKey: flagged.corruptCopyKey,
    };
  }
}

/**
 * Shared corrupt-read bookkeeping (decision new-G): keep a copy of the raw
 * text and record the read-corrupt issue for the banner. Idempotent for the
 * same raw value (no second copy, no re-notification).
 */
function flagCorruptStorageValue(key, stored, error) {
  const corruptCopyKey = preserveCorruptStorageValue(key, stored);
  const message = corruptCopyKey
    ? `Stored data for ${key} could not be read. A copy was kept at ${corruptCopyKey}.`
    : `Stored data for ${key} could not be read and no copy could be kept.`;

  warnStorageError(message, error);
  recordStorageIssue({
    key,
    kind: STORAGE_ISSUE_KINDS.readCorrupt,
    message,
    extra: { corruptCopyKey },
  });

  return { message, corruptCopyKey };
}

function isUnparsableStorageText(stored) {
  if (stored === null || stored === "") {
    return false;
  }

  try {
    JSON.parse(stored);
    return false;
  } catch {
    return true;
  }
}

function getCorruptWriteMessage(key) {
  return `Stored data for ${key} could not be read, so it was not overwritten. Restore a backup or discard the unreadable data from the storage warning, then try again.`;
}

/**
 * Decision new-U: a writer must never replace a value it could not read with a
 * value computed from the fallback. Returns { corrupt, raw }. A corrupt value
 * is flagged (copy + issue) exactly like a read of it would be.
 */
function inspectStoredValueForWrite(key) {
  let stored;

  try {
    stored = window.localStorage.getItem(key);
  } catch (error) {
    // Unreadable storage is reported by the write itself.
    warnStorageError(`Could not inspect ${key} before writing.`, error);
    return { corrupt: false, raw: null };
  }

  if (!isUnparsableStorageText(stored)) {
    return { corrupt: false, raw: stored };
  }

  flagCorruptStorageValue(key, stored, new SyntaxError("Stored text is not valid JSON."));
  return { corrupt: true, raw: stored };
}

function mayOverwriteCorrupt(options, key) {
  const overwriteCorrupt = options?.overwriteCorrupt;

  if (Array.isArray(overwriteCorrupt)) {
    return overwriteCorrupt.includes(key);
  }

  return overwriteCorrupt === true;
}

function clearReadCorruptIssue(key) {
  clearStorageIssuesOfKinds(key, [STORAGE_ISSUE_KINDS.readCorrupt]);
}

/**
 * Returns true when `key` currently holds text that is not valid JSON. Does
 * not flag or copy anything; readStorageResult / a write attempt do that.
 */
export function isStorageKeyCorrupt(key) {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return isUnparsableStorageText(window.localStorage.getItem(key));
  } catch {
    return false;
  }
}

/**
 * The explicit "use defaults for this key" action of the storage warning
 * (decision new-U). The unreadable text must already be preserved under a
 * `<key>.corrupt-<n>` copy (or a copy is made now); only then is the key
 * removed and its read-corrupt issue cleared, so later writes go through.
 *
 * Returns { ok: true, discarded, corruptCopyKey } or { ok: false, error }.
 */
export function discardCorruptStorageValue(key) {
  if (typeof window === "undefined") {
    return { ok: false, error: "Local storage is not available." };
  }

  let stored;

  try {
    stored = window.localStorage.getItem(key);
  } catch (error) {
    const message = getStorageErrorMessage(error, `Could not read ${key} from local storage.`);
    warnStorageError(message, error);
    return { ok: false, error: message };
  }

  if (!isUnparsableStorageText(stored)) {
    clearReadCorruptIssue(key);
    return { ok: true, discarded: false, corruptCopyKey: null };
  }

  const corruptCopyKey = preserveCorruptStorageValue(key, stored);

  if (!corruptCopyKey) {
    return {
      ok: false,
      error: `No copy of the unreadable data under ${key} could be kept, so it was not discarded. Export a backup first.`,
    };
  }

  try {
    window.localStorage.removeItem(key);
  } catch (error) {
    const message = getStorageErrorMessage(error, `Could not remove ${key} from local storage.`);
    warnStorageError(message, error);
    return { ok: false, error: message };
  }

  clearReadCorruptIssue(key);
  return { ok: true, discarded: true, corruptCopyKey };
}

export function readStorage(key, fallbackValue) {
  return readStorageResult(key, fallbackValue).value;
}

function serializeStorageValue(value) {
  try {
    const serialized = JSON.stringify(value);

    // JSON.stringify(undefined) (and functions/symbols) returns undefined
    // without throwing; localStorage would store the literal string
    // "undefined", which the next read reports as corrupt data.
    if (serialized === undefined) {
      const message = "Could not prepare app data for local storage. The value cannot be stored.";
      warnStorageError(message, new TypeError("Value serializes to undefined."));
      return { ok: false, error: message, code: STORAGE_ERROR_CODES.serialize };
    }

    return { ok: true, serialized };
  } catch (error) {
    const message = getStorageErrorMessage(error, "Could not prepare app data for local storage.");
    warnStorageError(message, error);
    return { ok: false, error: message, code: STORAGE_ERROR_CODES.serialize };
  }
}

function recordWriteFailure(key, message, code) {
  // A key has one live write state: a newer failure replaces an older one of any kind.
  storageIssues = storageIssues.filter(
    (issue) =>
      !(
        issue.key === key &&
        (issue.kind === STORAGE_ISSUE_KINDS.writeFailed || issue.kind === STORAGE_ISSUE_KINDS.quota)
      ),
  );
  recordStorageIssue({
    key,
    kind:
      code === STORAGE_ERROR_CODES.quota ? STORAGE_ISSUE_KINDS.quota : STORAGE_ISSUE_KINDS.writeFailed,
    message,
  });
}

function clearWriteIssues(key) {
  clearStorageIssuesOfKinds(key, [STORAGE_ISSUE_KINDS.writeFailed, STORAGE_ISSUE_KINDS.quota]);
}

/**
 * Single-key checked write. Returns { ok: true } or { ok: false, error, code }.
 * code: "quota" | "write" | "serialize" | "unavailable" | "corrupt".
 *
 * Decision new-U: when the key currently holds unreadable JSON the write is
 * refused with code "corrupt" (nothing is written, no write issue is recorded;
 * the read-corrupt issue already describes the state). Pass
 * `{ overwriteCorrupt: true }` only for an explicit user action that replaces
 * the unreadable data; the read-corrupt issue is cleared on success so the
 * warning no longer claims the original is still in place.
 */
export function writeStorage(key, value, options = {}) {
  if (typeof window === "undefined") {
    return {
      ok: false,
      error: "Local storage is not available.",
      code: STORAGE_ERROR_CODES.unavailable,
    };
  }

  const serialized = serializeStorageValue(value);

  if (!serialized.ok) {
    recordWriteFailure(key, serialized.error, serialized.code);
    return { ok: false, error: serialized.error, code: serialized.code };
  }

  const overwriteCorrupt = mayOverwriteCorrupt(options, key);
  const inspected = inspectStoredValueForWrite(key);

  if (inspected.corrupt && !overwriteCorrupt) {
    return { ok: false, error: getCorruptWriteMessage(key), code: STORAGE_ERROR_CODES.corrupt };
  }

  try {
    window.localStorage.setItem(key, serialized.serialized);
    clearWriteIssues(key);

    if (inspected.corrupt) {
      clearReadCorruptIssue(key);
    }

    return { ok: true };
  } catch (error) {
    const code = getStorageErrorCode(error);
    const message = getStorageErrorMessage(error, `Could not save ${key} to local storage.`);
    warnStorageError(message, error);
    recordWriteFailure(key, message, code);
    return { ok: false, error: message, code };
  }
}

function snapshotRawStorageValues(keys) {
  const snapshot = [];

  for (const key of keys) {
    try {
      snapshot.push([key, window.localStorage.getItem(key)]);
    } catch (error) {
      return {
        ok: false,
        error: getStorageErrorMessage(error, `Could not snapshot ${key} before writing.`),
        failedKey: key,
      };
    }
  }

  return { ok: true, snapshot };
}

function restoreRawStorageValues(snapshot) {
  let restored = true;

  snapshot.forEach(([key, value]) => {
    try {
      if (value === null) {
        window.localStorage.removeItem(key);
      } else {
        window.localStorage.setItem(key, value);
      }
    } catch (error) {
      restored = false;
      warnStorageError(`Could not restore ${key} after a failed batch write.`, error);
    }
  });

  return restored;
}

/**
 * Multi-key checked write (review finding F2).
 * entries: Array<{ key, value }>. Values are serialized up front; nothing is
 * written if any entry cannot be serialized. Writes happen sequentially; on the
 * first failure every key in the batch is restored to its pre-batch raw value.
 *
 * Returns { ok: true, writtenKeys } or
 *         { ok: false, error, code, failedKey, rolledBack }.
 *
 * Decision new-U: a key of the batch that currently holds unreadable JSON
 * makes the whole batch fail with code "corrupt" before anything is written,
 * unless `options.overwriteCorrupt` is true or lists that key.
 */
export function writeStorageBatch(entries, options = {}) {
  if (typeof window === "undefined") {
    return {
      ok: false,
      error: "Local storage is not available.",
      code: STORAGE_ERROR_CODES.unavailable,
      failedKey: null,
      rolledBack: true,
    };
  }

  const list = Array.isArray(entries) ? entries : [];

  if (!list.length) {
    return { ok: true, writtenKeys: [] };
  }

  const serializedEntries = [];

  for (const entry of list) {
    const key = entry?.key;

    if (typeof key !== "string" || !key) {
      return {
        ok: false,
        error: "A batch entry has no storage key.",
        code: STORAGE_ERROR_CODES.write,
        failedKey: null,
        rolledBack: true,
      };
    }

    const serialized = serializeStorageValue(entry.value);

    if (!serialized.ok) {
      recordWriteFailure(key, serialized.error, serialized.code);
      return {
        ok: false,
        error: serialized.error,
        code: serialized.code,
        failedKey: key,
        rolledBack: true,
      };
    }

    serializedEntries.push([key, serialized.serialized]);
  }

  const uniqueKeys = [...new Set(serializedEntries.map(([key]) => key))];
  const snapshotResult = snapshotRawStorageValues(uniqueKeys);

  if (!snapshotResult.ok) {
    warnStorageError(snapshotResult.error);
    return {
      ok: false,
      error: snapshotResult.error,
      code: STORAGE_ERROR_CODES.read,
      failedKey: snapshotResult.failedKey,
      rolledBack: true,
    };
  }

  // Decision new-U: the snapshot already holds every key's raw text, so an
  // unreadable value is detected here, before the first write.
  const corruptKeys = [];

  for (const [key, raw] of snapshotResult.snapshot) {
    if (isUnparsableStorageText(raw)) {
      flagCorruptStorageValue(key, raw, new SyntaxError("Stored text is not valid JSON."));
      corruptKeys.push(key);
    }
  }

  const refusedKey = corruptKeys.find((key) => !mayOverwriteCorrupt(options, key));

  if (refusedKey) {
    return {
      ok: false,
      error: getCorruptWriteMessage(refusedKey),
      code: STORAGE_ERROR_CODES.corrupt,
      failedKey: refusedKey,
      rolledBack: true,
    };
  }

  const writtenKeys = [];

  for (const [key, serialized] of serializedEntries) {
    try {
      window.localStorage.setItem(key, serialized);
      writtenKeys.push(key);
    } catch (error) {
      const code = getStorageErrorCode(error);
      const rolledBack = restoreRawStorageValues(snapshotResult.snapshot);
      const message = getStorageErrorMessage(
        error,
        rolledBack
          ? `Could not save ${key} to local storage. Previous data was kept.`
          : `Could not save ${key} to local storage and earlier writes could not be fully undone.`,
      );

      warnStorageError(message, error);
      recordWriteFailure(key, message, code);

      return { ok: false, error: message, code, failedKey: key, rolledBack };
    }
  }

  uniqueKeys.forEach((key) => clearWriteIssues(key));
  corruptKeys.forEach((key) => clearReadCorruptIssue(key));

  return { ok: true, writtenKeys };
}

/**
 * Reads a tracked key for a backup. Returns { value, corrupt: false } for a
 * parsable value, { value: rawText, corrupt: true } when the stored text is
 * not valid JSON (the raw text is carried so the backup preserves it), or
 * null when the key is absent or unreadable.
 */
function readRawStorageValue(key) {
  if (typeof window === "undefined") {
    return null;
  }

  let stored;

  try {
    stored = window.localStorage.getItem(key);
  } catch (error) {
    warnStorageError(`Could not read ${key} from local storage.`, error);
    return null;
  }

  if (stored === null) {
    return null;
  }

  try {
    return { value: JSON.parse(stored), corrupt: false };
  } catch {
    return { value: stored, corrupt: true };
  }
}

/**
 * Backups carry the tracked keys only. A key whose stored text is not valid
 * JSON is exported as its raw text and listed in `corruptKeys`, so a restore
 * writes the same raw text back (and the corrupt-read warning is raised again)
 * instead of turning it into a valid JSON string that reads as healthy data.
 */
export function createLocalBackup() {
  const storageKeys = getTrackedStorageKeys();
  const data = {};
  const corruptKeys = [];

  storageKeys.forEach((key) => {
    const entry = readRawStorageValue(key);

    if (!entry) {
      return;
    }

    data[key] = entry.value;

    if (entry.corrupt) {
      corruptKeys.push(key);
    }
  });

  return {
    app: BACKUP_APP_ID,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    storageKeys,
    data,
    ...(corruptKeys.length ? { corruptKeys } : {}),
  };
}

function getBackupCorruptKeys(backup) {
  return new Set(
    Array.isArray(backup?.corruptKeys)
      ? backup.corruptKeys.filter((key) => typeof key === "string")
      : [],
  );
}

export function validateLocalBackup(backup) {
  if (!backup || typeof backup !== "object") {
    return { valid: false, error: "Backup file is not a valid JSON object." };
  }

  if (backup.app !== BACKUP_APP_ID) {
    return { valid: false, error: "This file is not an RPE Tracker backup." };
  }

  if (!backup.data || typeof backup.data !== "object" || Array.isArray(backup.data)) {
    return { valid: false, error: "Backup file does not contain app data." };
  }

  const trackedKeys = new Set(getTrackedStorageKeys());
  const backupKeys = Object.keys(backup.data);
  const recognizedKeys = backupKeys.filter((key) => trackedKeys.has(key));

  if (!recognizedKeys.length) {
    return { valid: false, error: "Backup file does not contain recognized RPE Tracker data." };
  }

  return {
    valid: true,
    recognizedKeys,
    ignoredKeys: backupKeys.filter((key) => !trackedKeys.has(key)),
  };
}

function snapshotTrackedStorageValues(keys) {
  return keys.map((key) => {
    try {
      return [key, window.localStorage.getItem(key)];
    } catch (error) {
      warnStorageError(`Could not snapshot ${key} before restore.`, error);
      return [key, null];
    }
  });
}

function rollbackTrackedStorageValues(snapshot) {
  try {
    getTrackedStorageKeys().forEach((key) => {
      window.localStorage.removeItem(key);
    });

    snapshot.forEach(([key, value]) => {
      if (value !== null) {
        window.localStorage.setItem(key, value);
      }
    });

    return true;
  } catch (error) {
    warnStorageError("Could not fully roll back local storage after failed backup restore.", error);
    return false;
  }
}

export function restoreLocalBackup(backup) {
  if (typeof window === "undefined") {
    return { valid: false, error: "Local storage is not available." };
  }

  const validation = validateLocalBackup(backup);

  if (!validation.valid) {
    return validation;
  }

  const trackedKeys = getTrackedStorageKeys();
  const corruptKeys = getBackupCorruptKeys(backup);
  const serializedEntries = [];

  for (const key of validation.recognizedKeys) {
    if (corruptKeys.has(key) && typeof backup.data[key] === "string") {
      // Raw text of a key that was already unreadable when the backup was
      // made: written back verbatim so the next read flags it again (new-G).
      serializedEntries.push([key, backup.data[key]]);
      continue;
    }

    const serialized = serializeStorageValue(backup.data[key]);

    if (!serialized.ok) {
      return {
        valid: false,
        error: `Backup data for ${key} could not be prepared. Existing data was not changed.`,
      };
    }

    serializedEntries.push([key, serialized.serialized]);
  }

  const previousSnapshot = snapshotTrackedStorageValues(trackedKeys);

  try {
    trackedKeys.forEach((key) => {
      window.localStorage.removeItem(key);
    });

    serializedEntries.forEach(([key, serialized]) => {
      window.localStorage.setItem(key, serialized);
    });
  } catch (error) {
    const rolledBack = rollbackTrackedStorageValues(previousSnapshot);
    const message = getStorageErrorMessage(
      error,
      rolledBack
        ? "Backup restore failed. Your previous local data was restored."
        : "Backup restore failed and rollback could not fully complete. Use your latest export if anything looks wrong.",
    );
    warnStorageError(message, error);

    return {
      valid: false,
      error: message,
      rolledBack,
    };
  }

  return {
    ...validation,
    restoredKeys: validation.recognizedKeys,
  };
}

function getCorruptCopyKeys(key) {
  return Array.from({ length: MAX_CORRUPT_COPIES_PER_KEY }, (_, index) =>
    getCorruptCopyKey(key, index + 1),
  );
}

/**
 * Removes every tracked key together with its `<key>.corrupt-<n>` copies
 * (decision new-G keeps those copies until the user resets the app; a reset
 * is the one explicit "wipe everything" action, so they go too), and clears
 * the in-memory issues of the removed keys.
 */
export function resetLocalAppData() {
  if (typeof window === "undefined") {
    return { ok: false, error: "Local storage is not available." };
  }

  const trackedKeys = getTrackedStorageKeys();

  try {
    trackedKeys.forEach((key) => {
      window.localStorage.removeItem(key);
      getCorruptCopyKeys(key).forEach((copyKey) => {
        window.localStorage.removeItem(copyKey);
      });
    });

    const trackedKeySet = new Set(trackedKeys);
    const before = storageIssues.length;
    storageIssues = storageIssues.filter((issue) => !trackedKeySet.has(issue.key));

    if (storageIssues.length !== before) {
      notifyStorageIssueSubscribers();
    }

    return { ok: true };
  } catch (error) {
    const message = getStorageErrorMessage(error, "Could not reset local app data.");
    warnStorageError(message, error);
    return { ok: false, error: message };
  }
}

function createInitialStorageStatus(readResult) {
  return {
    readOk: readResult.ok,
    readError: readResult.ok ? null : readResult.error,
    lastWriteOk: null,
    lastWriteError: null,
  };
}

/**
 * Returns [state, setState, status].
 * status: { readOk, readError, lastWriteOk, lastWriteError }.
 * When the initial read failed (corrupt JSON or unreadable storage) the hook
 * does not write the fallback back until the app calls setState, and even
 * then writeStorage refuses to overwrite an unreadable key (decision new-U):
 * the refusal is reported through status.lastWriteOk / lastWriteError until
 * the user restores a backup or discards the unreadable data.
 */
export function useLocalStorageState(key, fallbackValue) {
  const [initialRead] = useState(() => readStorageResult(key, fallbackValue));
  const [value, setValue] = useState(initialRead.value);
  const [status, setStatus] = useState(() => createInitialStorageStatus(initialRead));
  const deferWriteRef = useRef(!initialRead.ok);

  useEffect(() => {
    if (deferWriteRef.current) {
      return;
    }

    const result = writeStorage(key, value);
    const lastWriteOk = result.ok;
    const lastWriteError = result.ok ? null : result.error;

    setStatus((current) =>
      current.lastWriteOk === lastWriteOk && current.lastWriteError === lastWriteError
        ? current
        : { ...current, lastWriteOk, lastWriteError },
    );
  }, [key, value]);

  const setStoredValue = useCallback((nextValue) => {
    deferWriteRef.current = false;
    setValue(nextValue);
  }, []);

  return [value, setStoredValue, status];
}
