import {
  getTrackedStorageKeys,
  readStorage,
  readStorageResult,
  STORAGE_KEYS,
  writeStorage,
  writeStorageBatch,
} from "./storage.js";

// ---------------------------------------------------------------------------
// Storage repository boundary (Phase H4, decision H4-4).
//
// Every tracked localStorage key (STORAGE_KEYS) is described once here as a
// collection: what it holds, how its records are identified, whether a backup
// carries it and whether a future sync (Phase H6) may send it off the device.
// The accessors below only delegate to storage.js so the checked-write
// guarantees (new-U, F2) stay in one place; callers such as programStorage.js
// keep their direct readStorage / writeStorage calls for now. Secrets
// (storage.js SECRET_STORAGE_KEYS) are deliberately not collections.
// ---------------------------------------------------------------------------

export const COLLECTION_KINDS = Object.freeze({
  // A JSON array of records, each identified by `idField`.
  list: "list",
  // A JSON object keyed by an id (day id, date, draft key, ...).
  map: "map",
  // One JSON value (an object or a scalar) with no per-record identity.
  value: "value",
});

export const COLLECTION_SCOPES = Object.freeze({
  // What the athlete did or set up: the data a sync would carry.
  userData: "user-data",
  // Per-device presentation state (open tabs, expanded panels).
  uiState: "ui-state",
  // Reserved for values that can be recomputed from user data; nothing uses
  // it yet (next plans are treated as user data so devices agree on them).
  derived: "derived",
  // Storage bookkeeping and the per-device active selection.
  meta: "meta",
});

// A collection's fallback is an empty list, an empty map or null. The
// registry copy is frozen and every read gets its own copy, so a caller that
// mutates what it read (push, splice, a new property) can never change what
// the next read of an absent collection returns.
function freezeFallback(fallback) {
  return fallback && typeof fallback === "object" ? Object.freeze(fallback) : fallback;
}

function copyFallback(fallback) {
  if (Array.isArray(fallback)) {
    return [...fallback];
  }

  return fallback && typeof fallback === "object" ? { ...fallback } : fallback;
}

function defineCollection(name, spec) {
  const key = STORAGE_KEYS[name];

  if (typeof key !== "string" || !key) {
    throw new Error(`Repository collection "${name}" has no STORAGE_KEYS entry.`);
  }

  return Object.freeze({
    name,
    key,
    kind: spec.kind,
    idField: spec.idField ?? null,
    scope: spec.scope,
    backedUp: spec.backedUp,
    syncable: spec.syncable,
    fallback: freezeFallback(spec.fallback),
  });
}

const userList = (name, idField = "id") =>
  defineCollection(name, {
    kind: COLLECTION_KINDS.list,
    idField,
    scope: COLLECTION_SCOPES.userData,
    backedUp: true,
    syncable: true,
    fallback: [],
  });

const userMap = (name) =>
  defineCollection(name, {
    kind: COLLECTION_KINDS.map,
    scope: COLLECTION_SCOPES.userData,
    backedUp: true,
    syncable: true,
    fallback: {},
  });

export const COLLECTIONS = Object.freeze([
  // Training history and the state around it.
  userList("sessions"),
  userMap("nextPlans"), // keyed by day id (decision new-I)
  userMap("setupCues"), // keyed by exercise id
  userMap("readinessByDate"), // keyed by local date
  userMap("workoutDrafts"), // keyed by program + day + date draft key
  // Per-device presentation state: kept in backups so a restore feels the
  // same, never synced.
  defineCollection("appUiState", {
    kind: COLLECTION_KINDS.value,
    scope: COLLECTION_SCOPES.uiState,
    backedUp: true,
    syncable: false,
    fallback: {},
  }),
  // Program storage bookkeeping and the active selection.
  defineCollection("programStorageMeta", {
    kind: COLLECTION_KINDS.value,
    scope: COLLECTION_SCOPES.meta,
    backedUp: true,
    syncable: false,
    fallback: null,
  }),
  // Program template (technique lives in the Library, prescription in the
  // program exercise) and athlete progress (baseline, state, progression).
  userList("programs"),
  defineCollection("activeProgramId", {
    kind: COLLECTION_KINDS.value,
    scope: COLLECTION_SCOPES.meta,
    backedUp: true,
    syncable: false,
    fallback: null,
  }),
  userList("programDays"),
  userList("programSections"),
  userList("exerciseLibrary"),
  userList("programExercises"),
  userList("baselines", ["programId", "programExerciseId"]),
  userList("programStates", "programId"),
  userList("programProgressions", ["programId", "programExerciseId"]),
  // Saved program drafts (decision H2-3).
  userList("programDrafts", "draftId"),
  // Hold / manual overrides per program exercise (decision H5-6).
  userList("programOverrides"),
  // Losing local versions kept by the private sync (decision H6-8): newest
  // first, backed up with the device's data, never synced.
  defineCollection("syncConflicts", {
    kind: COLLECTION_KINDS.list,
    idField: "id",
    scope: COLLECTION_SCOPES.meta,
    backedUp: true,
    syncable: false,
    fallback: [],
  }),
]);

const collectionsByName = new Map(COLLECTIONS.map((collection) => [collection.name, collection]));
const collectionsByKey = new Map(COLLECTIONS.map((collection) => [collection.key, collection]));

export function getCollection(name) {
  return collectionsByName.get(name) ?? null;
}

export function getCollectionByKey(key) {
  return collectionsByKey.get(key) ?? null;
}

export function getCollectionNames() {
  return COLLECTIONS.map((collection) => collection.name);
}

export function getSyncableCollections() {
  return COLLECTIONS.filter((collection) => collection.syncable);
}

/**
 * The registry must describe exactly the keys getTrackedStorageKeys returns,
 * each once. Returns { ok, missing, unknown, duplicate }.
 */
export function checkCollectionRegistry() {
  const tracked = getTrackedStorageKeys();
  const registered = COLLECTIONS.map((collection) => collection.key);
  const seen = new Set();
  const duplicate = [];

  registered.forEach((key) => {
    if (seen.has(key)) {
      duplicate.push(key);
    }

    seen.add(key);
  });

  const missing = tracked.filter((key) => !seen.has(key));
  const trackedSet = new Set(tracked);
  const unknown = registered.filter((key) => !trackedSet.has(key));

  return {
    ok: !missing.length && !unknown.length && !duplicate.length,
    missing,
    unknown,
    duplicate,
  };
}

function requireCollection(name) {
  const collection = getCollection(name);

  if (!collection) {
    throw new Error(`Unknown repository collection "${name}".`);
  }

  return collection;
}

/** readStorage(key, fallback) for the named collection; returns the value. */
export function readCollection(name, fallbackValue) {
  const collection = requireCollection(name);

  return readStorage(collection.key, arguments.length > 1 ? fallbackValue : copyFallback(collection.fallback));
}

/** readStorageResult(key, fallback) for the named collection, unchanged. */
export function readCollectionResult(name, fallbackValue) {
  const collection = requireCollection(name);

  return readStorageResult(
    collection.key,
    arguments.length > 1 ? fallbackValue : copyFallback(collection.fallback),
  );
}

/** writeStorage(key, value, options) for the named collection, unchanged. */
export function writeCollection(name, value, options) {
  const collection = requireCollection(name);

  return writeStorage(collection.key, value, options);
}

/**
 * writeStorageBatch for several collections in one checked batch:
 * entries: Array<{ name, value }>. An unknown name throws before anything is
 * written; the batch result ({ ok, writtenKeys } or
 * { ok: false, error, code, failedKey, rolledBack }) is returned unchanged.
 */
export function writeCollections(entries, options) {
  const list = Array.isArray(entries) ? entries : [];
  const storageEntries = list.map((entry) => ({
    key: requireCollection(entry?.name).key,
    value: entry?.value,
  }));

  return writeStorageBatch(storageEntries, options);
}

/**
 * Records of a collection as an array. A list returns its records (a
 * non-array stored value counts as empty); a map returns
 * [{ id, value }] per entry; a value collection returns [].
 */
export function listRecords(name) {
  const collection = requireCollection(name);
  const stored = readCollection(name);

  if (collection.kind === COLLECTION_KINDS.list) {
    return Array.isArray(stored) ? stored : [];
  }

  if (collection.kind === COLLECTION_KINDS.map) {
    return stored && typeof stored === "object" && !Array.isArray(stored)
      ? Object.keys(stored).map((id) => ({ id, value: stored[id] }))
      : [];
  }

  return [];
}

/**
 * The identity of a list record as one string (composite ids are joined with
 * "::"), or null when the record lacks any part of its id.
 */
export function getRecordId(name, record) {
  const collection = requireCollection(name);

  if (collection.kind !== COLLECTION_KINDS.list || !record || typeof record !== "object") {
    return null;
  }

  const fields = Array.isArray(collection.idField) ? collection.idField : [collection.idField];
  const parts = fields.map((field) => record[field]);

  if (parts.some((part) => part === null || part === undefined || part === "")) {
    return null;
  }

  return parts.map((part) => String(part)).join("::");
}
