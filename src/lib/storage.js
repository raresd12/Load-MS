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
  // Hold / manual overrides per program exercise (decision H5-6).
  programOverrides: "rpe-tracker.program-overrides.v1",
  // Losing local versions kept by the private sync (decision H6-8): device
  // bookkeeping, backed up, never synced.
  syncConflicts: "rpe-tracker.sync-conflicts.v1",
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

// ---------------------------------------------------------------------------
// Write notifications (Phase H4, decision H4-4). After every SUCCESSFUL
// writeStorage / writeStorageBatch call the listeners receive one event
// { keys, at, source: "local" } naming the keys that were written (a batch is
// one event with all of its keys). A failed, refused or rolled-back write
// emits nothing, and neither does a secret (writeSecret). This is the hook a
// sync queue (Phase H6) attaches to; the app itself does not consume it yet.
// Decision H4-9: an event means "the user's data changed on this device".
// The write useLocalStorageState does when it mounts puts back the value it
// just read (or the fallback on a fresh device), so it is written with
// `{ notify: false }` and emits nothing.
// Decision H4-12: restoreLocalBackup and resetLocalAppData replace or remove
// tracked keys without going through writeStorage, so on success they emit
// one event themselves, naming only the tracked keys whose stored text
// actually changed. `reason` tells a listener which of the three it was.
// ---------------------------------------------------------------------------

export const STORAGE_WRITE_SOURCE_LOCAL = "local";

export const STORAGE_WRITE_REASONS = Object.freeze({
  // writeStorage / writeStorageBatch.
  write: "write",
  // restoreLocalBackup replaced the tracked keys with a backup.
  restore: "restore",
  // resetLocalAppData removed the tracked keys.
  reset: "reset",
  // The private sync wrote what it pulled from the account (decision H6-7);
  // the sync trigger ignores these events.
  sync: "sync",
});

const knownWriteReasons = new Set(Object.values(STORAGE_WRITE_REASONS));

// writeStorageBatch's `options.reason`: a known reason, else "write".
function getBatchWriteReason(options) {
  return knownWriteReasons.has(options?.reason) ? options.reason : STORAGE_WRITE_REASONS.write;
}

const storageWriteSubscribers = new Set();

export function subscribeStorageWrites(listener) {
  if (typeof listener !== "function") {
    return () => {};
  }

  storageWriteSubscribers.add(listener);

  return () => {
    storageWriteSubscribers.delete(listener);
  };
}

function notifyStorageWriteSubscribers(keys, reason = STORAGE_WRITE_REASONS.write) {
  if (!keys.length || !storageWriteSubscribers.size) {
    return;
  }

  const event = Object.freeze({
    keys: Object.freeze([...keys]),
    at: new Date().toISOString(),
    source: STORAGE_WRITE_SOURCE_LOCAL,
    reason,
  });

  // Iterate over a copy so a listener that unsubscribes itself (or another
  // listener) during the notification does not skip anyone, and a listener
  // that throws never prevents the others from running or fails the write.
  [...storageWriteSubscribers].forEach((listener) => {
    try {
      listener(event);
    } catch (error) {
      warnStorageError("A storage write subscriber threw.", error);
    }
  });
}

/**
 * True when a window "storage" event (another tab's write) concerns this
 * app's localStorage; false for sessionStorage or when storage is unavailable
 * (decision H6-35).
 */
export function isLocalStorageEvent(event) {
  try {
    return Boolean(event) && (!event.storageArea || event.storageArea === window.localStorage);
  } catch {
    return false;
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
  markSyncRefetch(key);
  return { ok: true, discarded: true, corruptCopyKey };
}

/**
 * Decision H6-36: on a linked device, a discarded key is fetched back from
 * the account by the next sync instead of being read as "every record of it
 * was deleted". Best effort: the engine also refetches a collection that is
 * absent while the sync meta knows live records of it.
 */
function markSyncRefetch(key) {
  try {
    const meta = readDeviceValue(DEVICE_STORAGE_KEYS.syncMeta, null);

    if (!meta || typeof meta !== "object" || Array.isArray(meta) || meta.linked !== true) {
      return;
    }

    const refetchKeys = Array.isArray(meta.refetchKeys) ? meta.refetchKeys : [];

    if (!refetchKeys.includes(key)) {
      writeDeviceValue(DEVICE_STORAGE_KEYS.syncMeta, { ...meta, refetchKeys: [...refetchKeys, key] });
    }
  } catch {
    // The absent-collection rule still covers it.
  }
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
 *
 * Decision H4-9: `{ notify: false }` writes without a write notification. It
 * is only for a write that re-states what storage already means (the mount
 * write of useLocalStorageState), never for a change made by the user.
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

    if (options?.notify !== false) {
      notifyStorageWriteSubscribers([key]);
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
 *
 * Decision H6-7: `options.reason` names the write in the notification event;
 * only the sync passes STORAGE_WRITE_REASONS.sync. Anything else is "write".
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
  notifyStorageWriteSubscribers(uniqueKeys, getBatchWriteReason(options));

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

/**
 * The keys of `snapshot` ([key, rawTextOrNull] pairs, tracked-key order)
 * whose stored text differs from `nextRawByKey` (a Map of key -> raw text; a
 * key that is absent from it is absent from storage afterwards).
 */
function getChangedSnapshotKeys(snapshot, nextRawByKey) {
  return snapshot
    .filter(([key, previous]) => {
      const next = nextRawByKey.has(key) ? nextRawByKey.get(key) : null;

      return previous !== next;
    })
    .map(([key]) => key);
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
  // Decision H6-10: a restored device is unlinked before its data changes, so
  // even an interrupted restore makes the next sync show the link preview
  // instead of pushing the restored records as edits. The token stays.
  const previousSyncMeta = unlinkSyncMeta();

  try {
    trackedKeys.forEach((key) => {
      window.localStorage.removeItem(key);
    });

    serializedEntries.forEach(([key, serialized]) => {
      window.localStorage.setItem(key, serialized);
    });
  } catch (error) {
    const rolledBack = rollbackTrackedStorageValues(previousSnapshot);
    restoreRawDeviceValue(DEVICE_STORAGE_KEYS.syncMeta, previousSyncMeta);
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

  // Decision H4-12: the restore is durable here, so tell the write
  // subscribers which tracked keys now hold different text (replaced, added
  // or removed). Restoring what is already stored changes nothing and stays
  // silent.
  notifyStorageWriteSubscribers(
    getChangedSnapshotKeys(previousSnapshot, new Map(serializedEntries)),
    STORAGE_WRITE_REASONS.restore,
  );

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
 *
 * Decision H6-10: a reset also signs the device out of sync (the sync token
 * and the sync meta go first), so it is never pushed as deletes. The Gemini
 * key is still left for the Settings reset to clear (H4-6).
 */
export function resetLocalAppData() {
  if (typeof window === "undefined") {
    return { ok: false, error: "Local storage is not available." };
  }

  const trackedKeys = getTrackedStorageKeys();
  const previousSnapshot = snapshotTrackedStorageValues(trackedKeys);

  try {
    // Sync first: a reset that stops half way must not leave a linked device
    // whose missing records look like deletes.
    window.localStorage.removeItem(SECRET_STORAGE_KEYS.syncToken);
    window.localStorage.removeItem(DEVICE_STORAGE_KEYS.syncMeta);

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

    // Decision H4-12: one event naming the tracked keys that held data and
    // are gone now; resetting an already empty device stays silent.
    notifyStorageWriteSubscribers(
      getChangedSnapshotKeys(previousSnapshot, new Map()),
      STORAGE_WRITE_REASONS.reset,
    );

    return { ok: true };
  } catch (error) {
    const message = getStorageErrorMessage(error, "Could not reset local app data.");
    warnStorageError(message, error);
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Secrets (Phase H4, decision H4-4). Device-only credentials such as the
// Gemini key. A secret key is never part of STORAGE_KEYS /
// getTrackedStorageKeys, so it is never in a backup, a program share, a
// repository collection or a write notification (restore and reset events
// name tracked keys only, H4-12), and restoreLocalBackup /
// resetLocalAppData leave it untouched (the Settings reset removes the Gemini
// key through clearGeminiApiKey afterwards, as before H4). Values are stored
// as raw text, not JSON, so a key saved before H4 stays readable.
// Decision H6-3: the sync token follows the same rules, except that
// resetLocalAppData removes it (H6-10); restoreLocalBackup keeps it.
// ---------------------------------------------------------------------------

export const SECRET_STORAGE_KEYS = Object.freeze({
  geminiApiKey: "rpe-tracker.gemini-api-key.v1",
  syncToken: "rpe-tracker.sync-token.v1",
});

export function getSecretStorageKeys() {
  return Object.values(SECRET_STORAGE_KEYS);
}

export function isSecretStorageKey(key) {
  return getSecretStorageKeys().includes(key);
}

/**
 * Returns the stored secret text, or "" when the key is absent, not a
 * registered secret key, or storage is unavailable. Never records an issue.
 */
export function readSecret(key) {
  if (typeof window === "undefined" || !isSecretStorageKey(key)) {
    return "";
  }

  try {
    return window.localStorage.getItem(key) ?? "";
  } catch (error) {
    warnStorageError(`Could not read ${key} from local storage.`, error);
    return "";
  }
}

/**
 * Stores `value` as raw text; an empty value removes the key. Returns
 * { ok: true } or { ok: false, error, code } with the same quota handling and
 * codes as writeStorage, but records no storage issue and emits no write
 * notification. Only registered secret keys are accepted.
 */
export function writeSecret(key, value) {
  if (typeof window === "undefined") {
    return {
      ok: false,
      error: "Local storage is not available.",
      code: STORAGE_ERROR_CODES.unavailable,
    };
  }

  if (!isSecretStorageKey(key)) {
    return {
      ok: false,
      error: `${key} is not a secret storage key.`,
      code: STORAGE_ERROR_CODES.write,
    };
  }

  const text = value === null || value === undefined ? "" : String(value);

  try {
    if (text) {
      window.localStorage.setItem(key, text);
    } else {
      window.localStorage.removeItem(key);
    }

    return { ok: true };
  } catch (error) {
    const code = getStorageErrorCode(error);
    const message = getStorageErrorMessage(error, `Could not save ${key} to local storage.`);
    warnStorageError(message, error);
    return { ok: false, error: message, code };
  }
}

export function clearSecret(key) {
  return writeSecret(key, "");
}

// ---------------------------------------------------------------------------
// Device values (Phase H6, decision H6-7): JSON bookkeeping that belongs to
// this device only, such as the sync meta. Like a secret it is never tracked,
// never in a backup or share, never a repository collection, never named by a
// write notification, and a backup that carries one is ignored for it (a
// restore only marks the sync meta unlinked, H6-10); resetLocalAppData
// removes the sync meta. Unreadable JSON reads as the fallback: lost sync meta
// means an unlinked device, never a mass delete.
// ---------------------------------------------------------------------------

export const DEVICE_STORAGE_KEYS = Object.freeze({
  syncMeta: "rpe-tracker.sync-meta.v1",
  // The cross-tab sync lease `{ owner, expiresAt }` where navigator.locks is
  // missing (decision H6-18).
  syncLease: "rpe-tracker.sync-lease.v1",
});

export function getDeviceStorageKeys() {
  return Object.values(DEVICE_STORAGE_KEYS);
}

export function isDeviceStorageKey(key) {
  return getDeviceStorageKeys().includes(key);
}

function rejectDeviceKey(key) {
  if (typeof window === "undefined") {
    return {
      ok: false,
      error: "Local storage is not available.",
      code: STORAGE_ERROR_CODES.unavailable,
    };
  }

  return isDeviceStorageKey(key)
    ? null
    : { ok: false, error: `${key} is not a device storage key.`, code: STORAGE_ERROR_CODES.write };
}

/** The parsed value, or `fallbackValue` when absent, unreadable or not a device key. */
export function readDeviceValue(key, fallbackValue = null) {
  if (rejectDeviceKey(key)) {
    return fallbackValue;
  }

  try {
    const stored = window.localStorage.getItem(key);

    return stored === null || stored === "" ? fallbackValue : JSON.parse(stored);
  } catch (error) {
    warnStorageError(`Could not read ${key} from local storage.`, error);
    return fallbackValue;
  }
}

/**
 * Stores `value` as JSON. Returns { ok: true } or { ok: false, error, code }
 * with writeStorage's codes; records no storage issue and emits no write
 * notification. Only registered device keys are accepted.
 */
export function writeDeviceValue(key, value) {
  const rejected = rejectDeviceKey(key);

  if (rejected) {
    return rejected;
  }

  const serialized = serializeStorageValue(value);

  if (!serialized.ok) {
    return { ok: false, error: serialized.error, code: serialized.code };
  }

  try {
    window.localStorage.setItem(key, serialized.serialized);
    return { ok: true };
  } catch (error) {
    const code = getStorageErrorCode(error);
    const message = getStorageErrorMessage(error, `Could not save ${key} to local storage.`);
    warnStorageError(message, error);
    return { ok: false, error: message, code };
  }
}

/** Removes a device value. Returns { ok: true } or { ok: false, error, code }. */
export function clearDeviceValue(key) {
  const rejected = rejectDeviceKey(key);

  if (rejected) {
    return rejected;
  }

  try {
    window.localStorage.removeItem(key);
    return { ok: true };
  } catch (error) {
    const message = getStorageErrorMessage(error, `Could not remove ${key} from local storage.`);
    warnStorageError(message, error);
    return { ok: false, error: message, code: getStorageErrorCode(error) };
  }
}

/**
 * Restore helper (decision H6-10): sets `linked: false` on the stored sync
 * meta and returns its previous raw text (null when there was none), so a
 * failed restore can put it back. Unreadable meta, or meta that cannot be
 * rewritten, is removed: that also means an unlinked device.
 */
function unlinkSyncMeta() {
  const key = DEVICE_STORAGE_KEYS.syncMeta;
  let raw = null;

  try {
    raw = window.localStorage.getItem(key);
  } catch (error) {
    warnStorageError(`Could not read ${key} before restore.`, error);
    return null;
  }

  if (raw === null) {
    return null;
  }

  let meta = null;

  try {
    meta = JSON.parse(raw);
  } catch {
    meta = null;
  }

  try {
    if (meta && typeof meta === "object" && !Array.isArray(meta)) {
      window.localStorage.setItem(key, JSON.stringify({ ...meta, linked: false }));
    } else {
      window.localStorage.removeItem(key);
    }
  } catch (error) {
    warnStorageError(`Could not mark ${key} unlinked; removing it.`, error);

    try {
      window.localStorage.removeItem(key);
    } catch (removeError) {
      warnStorageError(`Could not remove ${key}.`, removeError);
    }
  }

  return raw;
}

function restoreRawDeviceValue(key, raw) {
  try {
    if (raw === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, raw);
    }
  } catch (error) {
    warnStorageError(`Could not put ${key} back after a failed restore.`, error);
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
  // Decision H4-9: until setState is called the hook only holds what it read
  // (or the fallback), so its write is not a change and notifies nobody.
  const changedByAppRef = useRef(false);

  useEffect(() => {
    if (deferWriteRef.current) {
      return;
    }

    const result = writeStorage(key, value, { notify: changedByAppRef.current });
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
    changedByAppRef.current = true;
    setValue(nextValue);
  }, []);

  return [value, setStoredValue, status];
}

// ---------------------------------------------------------------------------
// Storage status copy (Phase H4): moved verbatim from src/App.jsx so the
// save-error and storage-warning texts have a fixture
// (scripts/verify-storage-h4-messages.mjs).
// ---------------------------------------------------------------------------

export function buildSaveErrorMessage(result) {
  const detail = String(result?.error ?? "").trim();

  if (result?.code === "quota") {
    return {
      code: "quota",
      title: "Workout not saved - storage is full.",
      message:
        "Your draft is kept. Export a backup in Settings, delete old data, then press Save Workout again.",
      detail,
    };
  }

  if (result?.code === "corrupt") {
    // Decision new-U: saving would replace stored data the app could not read.
    return {
      code: "corrupt",
      title: "Workout not saved - stored data could not be read.",
      message: `Your draft is kept. Saving would overwrite the unreadable data under "${
        result?.failedKey ?? "a storage key"
      }". Use the storage warning at the top to restore a backup or discard that data, then press Save Workout again.`,
      detail,
    };
  }

  return {
    code: result?.code ?? "write",
    title: "Workout not saved.",
    message: `The browser refused the write${detail ? ` (${detail})` : ""}. Your draft is kept - try again, and export a backup in Settings if this repeats.`,
    detail,
  };
}

/**
 * Persistent storage warnings (decision new-G / review finding F2): storage
 * issues recorded by src/lib/storage.js plus failed writes reported by the
 * localStorage hooks. Each entry has a stable id used for dismissal.
 */
export function buildStorageWarnings({ storageIssues, hookStatuses }) {
  const warnings = (storageIssues ?? []).map((issue) => {
    const isCorrupt = issue.kind === STORAGE_ISSUE_KINDS.readCorrupt;
    const isQuota = issue.kind === STORAGE_ISSUE_KINDS.quota;

    return {
      id: `issue|${issue.key}|${issue.kind}|${issue.at}`,
      key: issue.key,
      kind: issue.kind,
      fromIssue: true,
      corruptCopyKey: issue.corruptCopyKey ?? null,
      title: isCorrupt
        ? "Stored data could not be read"
        : isQuota
          ? "Browser storage is full"
          : "A save failed",
      canDiscard: isCorrupt,
      message: isCorrupt
        ? `The data under "${issue.key}" is not valid JSON, so the app is using defaults for it.${
            issue.corruptCopyKey ? ` The original was kept as "${issue.corruptCopyKey}".` : ""
          } Nothing was overwritten, and nothing will be saved over it until you restore a backup or discard it.`
        : isQuota
          ? `Saving "${issue.key}" failed because storage is full. Export a backup in Settings and delete old data before logging more.`
          : `Saving "${issue.key}" failed${issue.message ? `: ${issue.message}` : "."} Recent changes may not be on disk - export a backup in Settings.`,
    };
  });
  // A hook write refused because the key is unreadable (decision new-U) is
  // already explained by the read-corrupt warning of that key.
  const coveredKeys = new Set(warnings.map((warning) => warning.key));

  (hookStatuses ?? []).forEach(({ key, status }) => {
    if (!status || status.lastWriteOk !== false || coveredKeys.has(key)) {
      return;
    }

    warnings.push({
      id: `hook|${key}|${status.lastWriteError ?? ""}`,
      key,
      kind: STORAGE_ISSUE_KINDS.writeFailed,
      fromIssue: false,
      corruptCopyKey: null,
      title: "A save failed",
      message: `The latest change to "${key}" was not written${
        status.lastWriteError ? `: ${status.lastWriteError}` : "."
      } Export a backup in Settings before continuing.`,
    });
  });

  return warnings;
}
