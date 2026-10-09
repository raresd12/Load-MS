import { getCollection, getSyncableCollections, readCollectionResult, writeCollections } from "./repository.js";
import {
  clearDeviceValue,
  clearSecret,
  DEVICE_STORAGE_KEYS,
  readDeviceValue,
  readSecret,
  SECRET_STORAGE_KEYS,
  STORAGE_WRITE_REASONS,
  writeDeviceValue,
  writeSecret,
} from "./storage.js";
import { toWireOp } from "./syncApi.js";
import {
  applyPulledRecords,
  canonicalJson,
  computeOpId,
  DELETED_HASH,
  diffForPush,
  enumerateLocalRecords,
  MAX_PUSH_OPS,
  parseRecordKey,
  recordKey,
  sha256Hex,
} from "./syncRecords.js";
import { classifySeedPair, SEED_PAIR_KINDS } from "./syncSeeds.js";

// ---------------------------------------------------------------------------
// Private sync engine (Phase H6, decisions H6-5 to H6-11). Local-first: the
// device's localStorage stays the source of truth; a sync pushes the local
// changes found by hashing every syncable record against the sync meta, then
// pulls what changed in the account, and writes everything it takes from the
// account in ONE writeStorageBatch with reason "sync". The losing local
// version of every conflict, and every device version a link replaces or
// removes, goes to syncConflicts in that same batch, before the data entries.
// Nothing here touches React or the DOM: the API, the storage adapter, the
// clock, the lock and the id source are injected.
// ---------------------------------------------------------------------------

export const SYNC_STATUSES = Object.freeze({
  synced: "synced",
  offline: "offline",
  error: "error",
  needsLink: "needs-link",
  needsConfirmation: "needs-confirmation",
  signedOut: "signed-out",
  // Another tab (or a call still running in this tab) holds the sync lock
  // (decision H6-18).
  busy: "busy",
});

export const SYNC_LOCK_NAME = "loadms-sync";
export const SYNC_LEASE_KEY = DEVICE_STORAGE_KEYS.syncLease;
export const SYNC_LEASE_MS = 120000;
export const MAX_SYNC_CONFLICTS = 200;
export const PULL_PAGE_SIZE = 500;
export const SYNC_CONFLICTS_COLLECTION = "syncConflicts";
// One push request carries at most this many bytes of ops (decision H6-40),
// well under the server's 4 MiB push cap.
export const MAX_PUSH_BYTES = 3 * 1024 * 1024;
// Hashes remembered per record for ops whose answer may have been lost
// (decision H6-34).
export const MAX_INFLIGHT_HASHES = 4;
export const EPOCH_CHANGED_MESSAGE =
  "The sync server was restored from a backup. Link this device again: your data on this device is kept.";

export const SYNC_CONFLICT_SOURCES = Object.freeze({
  sync: "sync",
  linkMerge: "link-merge",
  linkUseAccount: "link-use-account",
});

const RETRY_BASE_MS = 30000;
const RETRY_MAX_MS = 600000;

/**
 * Retry delay after `failures` consecutive failed syncs (decision H6-11):
 * 0 for none, then 30 s, 60 s, 2 min, 4 min, 8 min, and 10 min from then on.
 */
export function nextRetryDelay(failures) {
  const count = Math.floor(Number(failures) || 0);

  if (count <= 0) {
    return 0;
  }

  return Math.min(RETRY_BASE_MS * 2 ** Math.min(count - 1, 20), RETRY_MAX_MS);
}

function defaultRandomId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Locks. Every lock is { run(fn) -> Promise<{ acquired: true, value } |
// { acquired: false }> }: it never waits for a held lock.
// ---------------------------------------------------------------------------

/** One lock per object: share one instance to model two tabs in a fixture. */
export function createMemoryLock() {
  let held = false;

  return {
    async run(fn) {
      if (held) {
        return { acquired: false };
      }

      held = true;

      try {
        return { acquired: true, value: await fn() };
      } finally {
        held = false;
      }
    },
  };
}

/** navigator.locks (decision H6-11): lock `loadms-sync`, ifAvailable. */
export function createNavigatorLock(locks, name = SYNC_LOCK_NAME) {
  return {
    run(fn) {
      return locks.request(name, { ifAvailable: true }, async (lock) =>
        lock ? { acquired: true, value: await fn() } : { acquired: false },
      );
    },
  };
}

/**
 * The lease store over storage.js device values (decision H6-18): read() ->
 * the lease or null, write(lease) -> { ok }, clear() -> { ok }. Only storage.js
 * talks to the browser storage (decision H4-6).
 */
export function createDeviceLeaseStore() {
  return {
    read: () => readDeviceValue(DEVICE_STORAGE_KEYS.syncLease, null),
    write: (lease) => writeDeviceValue(DEVICE_STORAGE_KEYS.syncLease, lease),
    clear: () => clearDeviceValue(DEVICE_STORAGE_KEYS.syncLease),
  };
}

/**
 * Lease fallback (decisions H6-11, H6-18): `{ owner, expiresAt }` under
 * SYNC_LEASE_KEY (a device value: never tracked or backed up). A live lease
 * of another owner means busy; an expired one is taken over. When the lease
 * cannot be written at all the sync still runs (one tab is the usual case).
 */
export function createLeaseLock({
  store = createDeviceLeaseStore(),
  clock = () => Date.now(),
  random = defaultRandomId,
  leaseMs = SYNC_LEASE_MS,
} = {}) {
  const readLease = () => {
    try {
      const lease = store.read();
      return lease && typeof lease === "object" ? lease : null;
    } catch {
      return null;
    }
  };

  return {
    async run(fn) {
      const owner = String(random());
      const now = clock();
      const current = readLease();

      if (current?.owner && Number(current.expiresAt) > now) {
        return { acquired: false };
      }

      let written = false;

      try {
        written = Boolean(store.write({ owner, expiresAt: now + leaseMs })?.ok);
      } catch {
        written = false;
      }

      if (written && readLease()?.owner !== owner) {
        return { acquired: false };
      }

      try {
        return { acquired: true, value: await fn() };
      } finally {
        try {
          if (readLease()?.owner === owner) {
            store.clear();
          }
        } catch {
          // The lease expires on its own.
        }
      }
    },
  };
}

/** navigator.locks where available, else a device-value lease, else in memory. */
export function createDefaultSyncLock({
  navigatorLike = globalThis.navigator,
  leaseStore = typeof window === "undefined" ? null : createDeviceLeaseStore(),
} = {}) {
  if (navigatorLike?.locks && typeof navigatorLike.locks.request === "function") {
    return createNavigatorLock(navigatorLike.locks);
  }

  return leaseStore ? createLeaseLock({ store: leaseStore }) : createMemoryLock();
}

// ---------------------------------------------------------------------------
// The storage adapter over storage.js / repository.js. Every method is
// synchronous, so a sync's final check-and-write runs without yielding.
// ---------------------------------------------------------------------------

export function createLocalSyncStorage() {
  return {
    /** -> { ok: true, values: { name: value } } | { ok: false, error, code, collection } */
    readCollections(names) {
      const values = {};

      for (const name of names) {
        // Absent reads as null, not as the empty fallback, so the engine can
        // tell a missing collection from an emptied one (decision H6-36).
        const result = readCollectionResult(name, null);

        if (!result.ok) {
          return { ok: false, error: result.error, code: result.code, collection: name };
        }

        values[name] = result.value;
      }

      return { ok: true, values };
    },
    /** entries: [{ name, value }] -> writeStorageBatch's result */
    writeCollections(entries, options) {
      return writeCollections(entries, options);
    },
    readMeta: () => readDeviceValue(DEVICE_STORAGE_KEYS.syncMeta, null),
    writeMeta: (meta) => writeDeviceValue(DEVICE_STORAGE_KEYS.syncMeta, meta),
    clearMeta: () => clearDeviceValue(DEVICE_STORAGE_KEYS.syncMeta),
    readToken: () => readSecret(SECRET_STORAGE_KEYS.syncToken),
    writeToken: (token) => writeSecret(SECRET_STORAGE_KEYS.syncToken, token),
    clearToken: () => clearSecret(SECRET_STORAGE_KEYS.syncToken),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A usable sync meta, or null (lost or unreadable meta = unlinked device, H6-10). */
export function normalizeSyncMeta(meta) {
  if (!isPlainObject(meta) || typeof meta.deviceId !== "string" || !meta.deviceId) {
    return null;
  }

  return {
    userId: typeof meta.userId === "string" ? meta.userId : null,
    username: typeof meta.username === "string" ? meta.username : null,
    deviceId: meta.deviceId,
    since: Number.isInteger(meta.since) && meta.since >= 0 ? meta.since : 0,
    records: isPlainObject(meta.records) ? meta.records : {},
    lastSyncAt: typeof meta.lastSyncAt === "string" ? meta.lastSyncAt : null,
    lastError: isPlainObject(meta.lastError) ? meta.lastError : null,
    linked: meta.linked === true && isPlainObject(meta.records),
    // The database epoch the device last synced with (decision H6-31).
    epoch: typeof meta.epoch === "string" && meta.epoch ? meta.epoch : null,
    // Hashes of ops sent whose answer may have been lost (decision H6-34).
    inflight: normalizeInflight(meta.inflight),
    // Storage keys to fetch back from the account (decision H6-36).
    refetchKeys: Array.isArray(meta.refetchKeys) ? meta.refetchKeys.filter((key) => typeof key === "string") : [],
  };
}

function normalizeInflight(value) {
  if (!isPlainObject(value)) {
    return {};
  }

  const inflight = {};

  for (const [key, hashes] of Object.entries(value)) {
    if (Array.isArray(hashes)) {
      const list = hashes.filter((hash) => typeof hash === "string" && hash).slice(-MAX_INFLIGHT_HASHES);

      if (list.length) {
        inflight[key] = list;
      }
    }
  }

  return inflight;
}

function withInflight(inflight, key, hash) {
  const list = (inflight[key] ?? []).filter((item) => item !== hash);
  inflight[key] = [...list, hash].slice(-MAX_INFLIGHT_HASHES);
}

function utf8Length(text) {
  return typeof TextEncoder === "function" ? new TextEncoder().encode(text).length : text.length * 3;
}

/**
 * Splits ops into push requests of at most maxOps ops and about maxBytes of
 * wire JSON each (decisions H6-5, H6-40). An op bigger than maxBytes goes
 * alone (the server answers for it). Keeps the op order.
 */
export function chunkPushOps(ops, { maxOps = MAX_PUSH_OPS, maxBytes = MAX_PUSH_BYTES } = {}) {
  const chunks = [];
  let current = [];
  let bytes = 0;

  for (const op of Array.isArray(ops) ? ops : []) {
    const size = utf8Length(JSON.stringify(toWireOp(op))) + 1;

    if (current.length && (current.length >= maxOps || bytes + size > maxBytes)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }

    current.push(op);
    bytes += size;
  }

  if (current.length) {
    chunks.push(current);
  }

  return chunks;
}

/** The syncable collection names behind storage keys. */
function collectionsForKeys(keys) {
  const byKey = new Map(getSyncableCollections().map((collection) => [collection.key, collection.name]));
  return keys.map((key) => byKey.get(key)).filter(Boolean);
}

function syncableNames() {
  return getSyncableCollections().map((collection) => collection.name);
}

function localError(code, message) {
  return { kind: "local", code, message, status: null, retryAfterMs: null };
}

function epochError() {
  return { kind: "rejected", code: "epoch_changed", message: EPOCH_CHANGED_MESSAGE, status: 409, retryAfterMs: null };
}

function errorFromRead(read) {
  return localError(
    "local_read",
    `Stored data for ${read.collection ?? "a collection"} could not be read, so nothing was synced. ${read.error ?? ""}`.trim(),
  );
}

/** Index of { "<c>\u001f<id>" -> canonical text } over collection values. */
function indexCanonical(values) {
  const { records, invalid } = enumerateLocalRecords((name) => values[name]);
  const texts = new Map();

  records.forEach((record) => texts.set(recordKey(record.collection, record.recordId), canonicalJson(record.body)));

  return { texts, invalid };
}

function mergeConflictEntries(added, existing) {
  const older = Array.isArray(existing) ? existing : [];

  // Newest first, at most 200: older entries are dropped first, never an entry
  // this operation just added (decision H6-19).
  return [...added, ...older.slice(0, Math.max(0, MAX_SYNC_CONFLICTS - added.length))];
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * createSyncEngine({ api, storage, clock, lock, random })
 * api: createSyncApi(...); storage: createLocalSyncStorage() or a fake with
 * the same synchronous methods; clock: () => ms; lock: see createMemoryLock;
 * random: () => unique string (device ids, conflict ids, lease owners).
 */
export function createSyncEngine({
  api,
  storage,
  clock = () => Date.now(),
  lock = createMemoryLock(),
  random = defaultRandomId,
} = {}) {
  const state = {
    running: null,
    failures: 0,
    waiting: 0,
    lastResult: null,
    lastError: null,
  };

  const isoNow = () => new Date(clock()).toISOString();
  const readMeta = () => normalizeSyncMeta(storage.readMeta());
  const hasToken = () => Boolean(storage.readToken());

  function readConflictList() {
    const read = storage.readCollections([SYNC_CONFLICTS_COLLECTION]);
    const list = read.ok ? read.values[SYNC_CONFLICTS_COLLECTION] : null;

    return Array.isArray(list) ? list : [];
  }

  function status() {
    const meta = readMeta();
    const signedIn = hasToken();

    return {
      signedIn,
      linked: Boolean(signedIn && meta?.linked),
      username: meta?.username ?? null,
      userId: meta?.userId ?? null,
      deviceId: meta?.deviceId ?? null,
      lastSyncAt: meta?.lastSyncAt ?? null,
      lastError: state.lastError ?? meta?.lastError ?? null,
      lastStatus: state.lastResult?.status ?? null,
      running: Boolean(state.running),
      waiting: state.waiting,
      failures: state.failures,
      retryDelayMs: Math.max(nextRetryDelay(state.failures), state.lastError?.retryAfterMs ?? 0),
      conflicts: readConflictList().length,
    };
  }

  function finish(result) {
    const outcome = { pushed: 0, pulled: 0, conflicts: 0, waiting: 0, ...result };

    if (outcome.status === SYNC_STATUSES.synced) {
      state.failures = 0;
      state.lastError = null;
    } else if (outcome.status === SYNC_STATUSES.offline || outcome.status === SYNC_STATUSES.error) {
      state.failures += 1;
      state.lastError = outcome.error ?? null;
    } else if (outcome.status === SYNC_STATUSES.signedOut) {
      state.failures = 0;
      state.lastError = outcome.error ?? null;
    }

    if (outcome.status !== SYNC_STATUSES.busy) {
      state.waiting = outcome.waiting;
    }

    state.lastResult = outcome;
    return outcome;
  }

  /** A 401 (decision H6-11): the token goes, the device is unlinked, user data is untouched. */
  function handleUnauthorized(error) {
    storage.clearToken();
    const meta = readMeta();

    if (meta) {
      storage.writeMeta({ ...meta, linked: false, lastError: error });
    }

    return { status: SYNC_STATUSES.signedOut, error };
  }

  /**
   * The account's database was restored or replaced (decision H6-31): its
   * revs no longer match this device's meta. The device is unlinked (its data
   * stays) and asks to link again, which shows the H6-9 preview.
   */
  function unlinkForEpoch() {
    const error = epochError();
    const meta = readMeta();

    if (meta) {
      storage.writeMeta({
        ...meta,
        linked: false,
        records: {},
        since: 0,
        epoch: null,
        inflight: {},
        refetchKeys: [],
        lastError: error,
      });
    }

    return { status: SYNC_STATUSES.needsLink, error };
  }

  function failure(error, extra = {}) {
    if (error?.kind === "unauthorized") {
      return { ...handleUnauthorized(error), ...extra };
    }

    if (error?.code === "epoch_changed") {
      return { ...unlinkForEpoch(), ...extra };
    }

    return {
      status: error?.kind === "offline" ? SYNC_STATUSES.offline : SYNC_STATUSES.error,
      error,
      ...extra,
    };
  }

  /** -> { ok: true, records, nextSince, epoch } (epoch: string or null) | { ok: false, error } */
  async function pullAll(since) {
    const records = [];
    let cursor = since;
    let epoch;

    for (;;) {
      const result = await api.pull({ since: cursor, limit: PULL_PAGE_SIZE });

      if (!result.ok) {
        return result;
      }

      const { records: page, nextSince, more } = result.data ?? {};

      if (!Array.isArray(page) || !Number.isInteger(nextSince) || nextSince < cursor) {
        return { ok: false, error: { kind: "server", code: "bad_response", message: "The sync server sent an unreadable page.", status: null, retryAfterMs: null } };
      }

      const pageEpoch = typeof result.data.epoch === "string" && result.data.epoch ? result.data.epoch : null;

      if (epoch !== undefined && pageEpoch !== epoch) {
        // The database was swapped between two pages (decision H6-31).
        return { ok: false, error: epochError() };
      }

      epoch = pageEpoch;
      records.push(...page);

      if (!more) {
        return { ok: true, records, nextSince, epoch };
      }

      if (nextSince === cursor) {
        return { ok: false, error: { kind: "server", code: "stuck_pull", message: "The sync server did not advance the pull.", status: null, retryAfterMs: null } };
      }

      cursor = nextSince;
    }
  }

  /** Every syncable local record with its canonical text and hash. */
  async function readLocal() {
    const read = storage.readCollections(syncableNames());

    if (!read.ok) {
      return { ok: false, error: errorFromRead(read) };
    }

    const { records, skipped, invalid } = enumerateLocalRecords((name) => read.values[name]);

    if (invalid.length) {
      return {
        ok: false,
        error: localError("local_shape", `Stored data for ${invalid.join(", ")} has an unexpected shape, so nothing was synced.`),
      };
    }

    const texts = new Map();
    const hashed = await Promise.all(
      records.map(async (record) => {
        const text = canonicalJson(record.body);
        texts.set(recordKey(record.collection, record.recordId), text);
        return { ...record, hash: await sha256Hex(text) };
      }),
    );

    return { ok: true, records: hashed, texts, skipped, values: read.values };
  }

  /** The account's latest version of every record, keyed, with hashes. */
  async function indexAccount(pulled) {
    const latest = new Map();

    for (const record of pulled) {
      if (getCollection(record?.collection)?.syncable && typeof record.recordId === "string" && Number.isInteger(record.rev)) {
        latest.set(recordKey(record.collection, record.recordId), record);
      }
    }

    const entries = await Promise.all(
      [...latest].map(async ([key, record]) => {
        const deleted = Boolean(record.deleted);
        const text = deleted ? null : canonicalJson(record.body);

        return [
          key,
          {
            collection: record.collection,
            recordId: record.recordId,
            rev: record.rev,
            deleted,
            body: deleted ? null : record.body,
            text,
            hash: deleted ? DELETED_HASH : await sha256Hex(text),
          },
        ];
      }),
    );

    return new Map(entries);
  }

  function conflictEntry({ collection, recordId, body, deleted, serverRev, source }) {
    return {
      id: String(random()),
      collection,
      recordId,
      body: deleted ? null : body,
      deleted: Boolean(deleted),
      serverRev,
      at: isoNow(),
      source,
    };
  }

  /**
   * The synchronous end of a sync or a link: checks the session did not
   * change while the network was in use, re-reads the data, writes
   * syncConflicts + the changed collections in one batch (reason "sync"),
   * then the meta. Returns { ok, ... } or { ok: false, result }.
   */
  function commit({ session, expectLinked, local, changes, conflicts, records, since, linked, strict, metaPatch = {} }) {
    if (!hasToken()) {
      return { ok: false, result: { status: SYNC_STATUSES.signedOut } };
    }

    const metaNow = readMeta();

    if (!metaNow || metaNow.linked !== expectLinked || metaNow.userId !== session.userId || metaNow.deviceId !== session.deviceId) {
      return { ok: false, result: { status: SYNC_STATUSES.needsLink } };
    }

    const names = [...syncableNames(), SYNC_CONFLICTS_COLLECTION];
    const fresh = storage.readCollections(names);

    if (!fresh.ok) {
      return { ok: false, result: failure(errorFromRead(fresh)) };
    }

    const { texts: freshTexts, invalid } = indexCanonical(fresh.values);
    const storedConflicts = fresh.values[SYNC_CONFLICTS_COLLECTION];

    if (invalid.length || (storedConflicts !== null && storedConflicts !== undefined && !Array.isArray(storedConflicts))) {
      return { ok: false, result: failure(localError("local_shape", "Stored data has an unexpected shape, so nothing was synced.")) };
    }

    const nextRecords = { ...records };
    const apply = [];
    const added = [];
    let pulled = 0;
    let skipped = 0;

    for (const change of changes) {
      const key = recordKey(change.collection, change.recordId);

      if (local.texts.get(key) !== freshTexts.get(key)) {
        // Changed on this device while the sync was on the network: keep it
        // live and leave the meta, so the next sync sends it as a change.
        if (strict) {
          return {
            ok: false,
            result: failure(localError("local_changed", "Your data changed while linking. Try again.")),
          };
        }

        skipped += 1;
        continue;
      }

      if (change.meta) {
        nextRecords[key] = change.meta;
      }

      if (change.conflict) {
        added.push(conflictEntry(change.conflict));
      }

      if (change.keepLocal) {
        // The device's version stays live; the meta now holds the account's
        // rev, so the next push sends it on top (decisions H6-34, H6-36).
        continue;
      }

      const target = change.deleted ? undefined : change.text;

      if (freshTexts.get(key) !== target) {
        apply.push({ collection: change.collection, recordId: change.recordId, deleted: change.deleted, body: change.body });

        if (!change.conflict) {
          pulled += 1;
        }
      }
    }

    for (const conflict of conflicts ?? []) {
      added.push(conflictEntry(conflict));
    }

    const { values, changed } = applyPulledRecords(apply, fresh.values);
    const entries = [];

    if (added.length) {
      entries.push({ name: SYNC_CONFLICTS_COLLECTION, value: mergeConflictEntries(added, storedConflicts) });
    }

    changed.forEach((name) => entries.push({ name, value: values[name] }));

    if (entries.length) {
      const written = storage.writeCollections(entries, { reason: STORAGE_WRITE_REASONS.sync });

      if (!written?.ok) {
        // The meta is left as it was, so the next sync retries the same ops
        // (same opIds) and pulls the same records again.
        return {
          ok: false,
          result: failure(localError(written?.code === "quota" ? "local_quota" : "local_write", written?.error ?? "Could not save synced data on this device.")),
        };
      }
    }

    const nextMeta = { ...metaNow, ...metaPatch, records: nextRecords, since, linked, lastSyncAt: isoNow(), lastError: null };
    const metaWritten = storage.writeMeta(nextMeta);

    if (!metaWritten?.ok) {
      return {
        ok: false,
        result: failure(localError("meta_write", metaWritten?.error ?? "Could not save the sync state on this device.")),
      };
    }

    return { ok: true, pulled, conflicts: added.length, skipped, written: apply.length };
  }

  /**
   * Writes part of the meta between network calls (in-flight hashes before a
   * push, earned revs after a failure), only while the session is unchanged.
   * -> { ok: true } | { ok: false, result }
   */
  function patchMeta(session, patch) {
    const metaNow = readMeta();

    if (!metaNow || !metaNow.linked || metaNow.userId !== session.userId || metaNow.deviceId !== session.deviceId) {
      return { ok: false, result: { status: SYNC_STATUSES.needsLink } };
    }

    const next = typeof patch === "function" ? patch(metaNow) : { ...metaNow, ...patch };
    const written = storage.writeMeta(next);

    return written?.ok
      ? { ok: true }
      : { ok: false, result: failure(localError("meta_write", written?.error ?? "Could not save the sync state on this device.")) };
  }

  /**
   * Collections to fetch back from the account before the diff (decision
   * H6-36): the ones a discard marked, and any that is absent on the device
   * while the meta knows live records of it. Reading those as empty would
   * send every record of them as a delete.
   */
  function refetchCollections(meta, local) {
    const names = new Set(collectionsForKeys(meta.refetchKeys));
    const liveKnown = new Set();

    for (const [key, entry] of Object.entries(meta.records)) {
      if (entry && entry.hash !== DELETED_HASH) {
        const parsed = parseRecordKey(key);

        if (parsed) {
          liveKnown.add(parsed.collection);
        }
      }
    }

    for (const name of syncableNames()) {
      const value = local.values?.[name];

      if ((value === null || value === undefined) && liveKnown.has(name)) {
        names.add(name);
      }
    }

    return names;
  }

  /**
   * Fetches the account's records of some collections (or of some record
   * keys) back onto the device (decisions H6-36, H6-39):
   * - only in the account -> added on the device;
   * - on both and the same (or the same apart from seed time, H6-38) -> the
   *   meta takes the account's rev;
   * - on both and different -> the device's version stays live and is sent
   *   next on top of the account's rev; the account's version is kept aside
   *   in syncConflicts (not when it is the untouched built-in default);
   * - a meta entry the account no longer has -> dropped, never a delete.
   * The since cursor is left alone. -> { ok: true } | { ok: false, result }
   */
  async function runRefetch(meta, local, { collections = new Set(), keys = null }) {
    const pulled = await pullAll(0);

    if (!pulled.ok) {
      return { ok: false, result: failure(pulled.error) };
    }

    if (meta.epoch && pulled.epoch && pulled.epoch !== meta.epoch) {
      return { ok: false, result: unlinkForEpoch() };
    }

    const inScope = (key, collection) => (keys ? keys.has(key) : collections.has(collection));
    const account = await indexAccount(pulled.records);
    const localByKey = new Map(local.records.map((record) => [recordKey(record.collection, record.recordId), record]));
    const records = {};
    const changes = [];

    for (const [key, entry] of Object.entries(meta.records)) {
      const parsed = parseRecordKey(key);

      if (!parsed || !inScope(key, parsed.collection)) {
        records[key] = entry;
      }
    }

    for (const [key, remote] of account) {
      if (!inScope(key, remote.collection)) {
        continue;
      }

      const remoteMeta = { rev: remote.rev, hash: remote.hash };
      records[key] = remoteMeta;

      if (remote.deleted) {
        // A device record with that id is sent next on the tombstone's rev.
        continue;
      }

      const mine = localByKey.get(key);

      if (!mine) {
        changes.push({ ...remote, meta: remoteMeta, conflict: null });
        continue;
      }

      if (mine.hash === remote.hash) {
        continue;
      }

      const seedKind = classifySeedPair(key, mine.body, remote.body);

      if (seedKind === SEED_PAIR_KINDS.same || seedKind === SEED_PAIR_KINDS.deviceDefault) {
        changes.push({ ...remote, meta: remoteMeta, conflict: null });
        continue;
      }

      changes.push({
        ...remote,
        meta: remoteMeta,
        keepLocal: true,
        conflict:
          seedKind === SEED_PAIR_KINDS.accountDefault
            ? null
            : {
                collection: remote.collection,
                recordId: remote.recordId,
                body: remote.body,
                deleted: false,
                serverRev: remote.rev,
                source: SYNC_CONFLICT_SOURCES.sync,
              },
      });
    }

    const committed = commit({
      session: meta,
      expectLinked: true,
      local,
      changes,
      conflicts: [],
      records,
      since: meta.since,
      linked: true,
      strict: false,
      metaPatch: {
        refetchKeys: keys ? meta.refetchKeys : [],
        epoch: meta.epoch ?? pulled.epoch ?? null,
      },
    });

    return committed.ok ? { ok: true, pulled: committed.pulled, conflicts: committed.conflicts } : committed;
  }

  /**
   * One round of pushes (decisions H6-5, H6-34, H6-40). Before each request
   * the hashes it carries are stored as in flight, so a lost answer is
   * recognised later: a conflict whose account version is one of this
   * device's in-flight hashes is the device's own earlier write, so its rev is
   * taken and the newer edit is sent again on top of it (once).
   * A conflict the server answered without its body (its answer budget was
   * spent, decision H6-43) is returned in `again`, to be sent once more.
   */
  async function pushRound(session, ops, ctx, { allowOwnRetry }) {
    const retry = [];
    const again = [];

    for (const chunk of chunkPushOps(ops)) {
      chunk.forEach((op) => withInflight(ctx.inflight, recordKey(op.collection, op.recordId), op.hash));

      const marked = patchMeta(session, { inflight: ctx.inflight });

      if (!marked.ok) {
        return marked;
      }

      const result = await api.push({ deviceId: session.deviceId, ops: chunk, epoch: session.epoch ?? undefined });

      if (!result.ok) {
        return { ok: false, error: result.error };
      }

      const answerEpoch = typeof result.data?.epoch === "string" && result.data.epoch ? result.data.epoch : null;

      if (answerEpoch && session.epoch && answerEpoch !== session.epoch) {
        return { ok: false, error: epochError() };
      }

      ctx.epoch = ctx.epoch ?? answerEpoch;

      const answers = Array.isArray(result.data?.results) ? result.data.results : [];

      for (const [index, op] of chunk.entries()) {
        const answer = answers[index];
        const key = recordKey(op.collection, op.recordId);
        const matches = answer && (answer.opId === undefined || answer.opId === null || answer.opId === op.opId);

        if (matches && answer.status === "applied" && Number.isInteger(answer.rev)) {
          ctx.records[key] = { rev: answer.rev, hash: op.hash };
          ctx.earned[key] = ctx.records[key];
          ctx.pushed += 1;
          ctx.answered.add(key);
          continue;
        }

        if (matches && answer.status === "conflict" && answer.bodyOmitted === true) {
          again.push(op);
          continue;
        }

        if (matches && answer.status === "conflict" && Number.isInteger(answer.rev)) {
          const deleted = Boolean(answer.deleted);
          const answerHash = deleted ? DELETED_HASH : await sha256Hex(canonicalJson(answer.body));
          ctx.answered.add(key);

          if (answerHash === op.hash) {
            // The account already holds exactly this version.
            ctx.records[key] = { rev: answer.rev, hash: op.hash };
            ctx.earned[key] = ctx.records[key];
            continue;
          }

          if (allowOwnRetry && (ctx.inflight[key] ?? []).includes(answerHash)) {
            ctx.records[key] = { rev: answer.rev, hash: answerHash };
            ctx.earned[key] = ctx.records[key];
            retry.push({ ...op, baseRev: answer.rev });
            continue;
          }

          ctx.changes.set(key, {
            collection: op.collection,
            recordId: op.recordId,
            rev: answer.rev,
            deleted,
            body: deleted ? null : answer.body,
            conflict: {
              collection: op.collection,
              recordId: op.recordId,
              body: op.body,
              deleted: op.deleted,
              serverRev: answer.rev,
              source: SYNC_CONFLICT_SOURCES.sync,
            },
          });
          continue;
        }

        ctx.pending.set(key, answer?.code ?? "no_answer");
      }
    }

    return { ok: true, retry, again };
  }

  /**
   * pushRound, then the conflicts answered without a body sent again until
   * every op has its answer. The server sends at least one body per answer,
   * so each pass leaves fewer; a pass that answers none leaves the rest
   * waiting (decision H6-43).
   */
  async function pushAll(session, ops, ctx, options) {
    const retry = [];
    let next = ops;

    while (next.length) {
      const round = await pushRound(session, next, ctx, options);

      if (!round.ok) {
        return round;
      }

      retry.push(...round.retry);

      if (round.again.length >= next.length) {
        round.again.forEach((op) => ctx.pending.set(recordKey(op.collection, op.recordId), "no_answer"));
        break;
      }

      next = round.again;
    }

    return { ok: true, retry };
  }

  /** After a failure mid-sync: keep the revs the account already gave (decision H6-34). */
  function keepEarned(session, ctx) {
    if (!Object.keys(ctx.earned).length) {
      return;
    }

    patchMeta(session, (metaNow) => ({
      ...metaNow,
      records: { ...metaNow.records, ...ctx.earned },
      inflight: ctx.inflight,
    }));
  }

  async function runSync({ confirmMassDelete = false, restoreDeletes = false, followUp = false } = {}) {
    if (!hasToken()) {
      return { status: SYNC_STATUSES.signedOut };
    }

    let meta = readMeta();

    if (!meta || !meta.linked) {
      return { status: SYNC_STATUSES.needsLink };
    }

    let local = await readLocal();

    if (!local.ok) {
      return failure(local.error);
    }

    let refetched = { pulled: 0, conflicts: 0 };
    const refetch = refetchCollections(meta, local);

    if (!refetch.size && meta.refetchKeys.length) {
      // Marked keys that name no syncable collection: nothing to fetch.
      patchMeta(meta, { refetchKeys: [] });
    }

    if (refetch.size) {
      const result = await runRefetch(meta, local, { collections: refetch });

      if (!result.ok) {
        return result.result;
      }

      refetched = result;
      meta = readMeta();
      local = await readLocal();

      if (!meta?.linked) {
        return { status: SYNC_STATUSES.needsLink };
      }

      if (!local.ok) {
        return failure(local.error);
      }
    }

    let diff = await diffForPush(local.records, meta);

    if (diff.needsConfirmation && !confirmMassDelete && restoreDeletes) {
      // "Bring them back from the account" (decision H6-39).
      const keys = new Set(diff.ops.filter((op) => op.deleted).map((op) => recordKey(op.collection, op.recordId)));
      const result = await runRefetch(meta, local, { keys });

      if (!result.ok) {
        return result.result;
      }

      refetched = { pulled: refetched.pulled + result.pulled, conflicts: refetched.conflicts + result.conflicts };
      meta = readMeta();
      local = await readLocal();

      if (!meta?.linked) {
        return { status: SYNC_STATUSES.needsLink };
      }

      if (!local.ok) {
        return failure(local.error);
      }

      diff = await diffForPush(local.records, meta);
    }

    const waiting = diff.ops.length;

    if (diff.needsConfirmation && !confirmMassDelete) {
      return {
        status: SYNC_STATUSES.needsConfirmation,
        deletes: diff.deleteCount,
        live: diff.liveCount,
        waiting,
        pulled: refetched.pulled,
        conflicts: refetched.conflicts,
      };
    }

    const ctx = {
      records: { ...meta.records },
      earned: {},
      inflight: normalizeInflight(meta.inflight),
      changes: new Map(),
      pending: new Map(),
      answered: new Set(),
      pushed: 0,
      epoch: meta.epoch,
    };
    const stop = (error) => {
      if (error?.code !== "epoch_changed") {
        keepEarned(meta, ctx);
      }

      return failure(error, { waiting });
    };

    const first = await pushAll(meta, diff.ops, ctx, { allowOwnRetry: true });

    if (!first.ok) {
      return first.error ? stop(first.error) : { waiting, ...first.result };
    }

    if (first.retry.length) {
      const retryOps = await Promise.all(
        first.retry.map(async (op) => ({ ...op, opId: await computeOpId({ deviceId: meta.deviceId, ...op }) })),
      );
      const second = await pushAll(meta, retryOps, ctx, { allowOwnRetry: false });

      if (!second.ok) {
        return second.error ? stop(second.error) : { waiting, ...second.result };
      }
    }

    const pulledResult = await pullAll(meta.since);

    if (!pulledResult.ok) {
      return stop(pulledResult.error);
    }

    if (meta.epoch && pulledResult.epoch && pulledResult.epoch !== meta.epoch) {
      return { waiting, ...unlinkForEpoch() };
    }

    const { records, changes, pending, inflight } = ctx;
    const localHashes = new Map(local.records.map((record) => [recordKey(record.collection, record.recordId), record.hash]));

    for (const record of pulledResult.records) {
      if (!getCollection(record?.collection)?.syncable || typeof record.recordId !== "string" || !Number.isInteger(record.rev)) {
        continue;
      }

      const key = recordKey(record.collection, record.recordId);
      const known = changes.get(key)?.rev ?? records[key]?.rev ?? 0;

      if (pending.has(key) || record.rev <= known) {
        continue;
      }

      changes.set(key, {
        collection: record.collection,
        recordId: record.recordId,
        rev: record.rev,
        deleted: Boolean(record.deleted),
        body: record.deleted ? null : record.body,
        conflict: changes.get(key)?.conflict ?? null,
      });
    }

    let ownPending = 0;
    const prepared = await Promise.all(
      [...changes.values()].map(async (change) => {
        const text = change.deleted ? null : canonicalJson(change.body);
        const hash = change.deleted ? DELETED_HASH : await sha256Hex(text);
        const key = recordKey(change.collection, change.recordId);
        // The device's own write whose answer was lost, and the device has
        // edited the record again since: the newer edit stays (H6-34).
        const own = !change.conflict && (inflight[key] ?? []).includes(hash) && localHashes.get(key) !== hash;

        if (own) {
          ownPending += 1;
        }

        return { ...change, text, keepLocal: own, meta: { rev: change.rev, hash } };
      }),
    );

    // Hashes stay in flight only for ops this sync sent and the server did
    // not answer. A key this completed sync sent nothing for (the edit was
    // undone after a lost request) drops them, so a later identical edit from
    // another device is never mistaken for this device's own write.
    const nextInflight = {};

    for (const [key, hashes] of Object.entries(inflight)) {
      if (pending.has(key) && !ctx.answered.has(key) && !changes.has(key)) {
        nextInflight[key] = hashes;
      }
    }

    const committed = commit({
      session: meta,
      expectLinked: true,
      local,
      changes: prepared,
      conflicts: [],
      records,
      since: pulledResult.nextSince,
      linked: true,
      strict: false,
      metaPatch: { inflight: nextInflight, epoch: meta.epoch ?? ctx.epoch ?? pulledResult.epoch ?? null },
    });

    if (!committed.ok) {
      keepEarned(meta, ctx);
      return { waiting, ...committed.result };
    }

    const left = pending.size + committed.skipped;
    const base = {
      pushed: ctx.pushed,
      pulled: committed.pulled + refetched.pulled,
      conflicts: committed.conflicts + refetched.conflicts,
      waiting: left,
    };

    if (pending.size) {
      const code = [...pending.values()][0];

      return {
        ...base,
        status: SYNC_STATUSES.error,
        error: {
          kind: "rejected",
          code,
          message: `${pending.size} change${pending.size === 1 ? " was" : "s were"} not accepted by the sync server (${code}).`,
          status: null,
          retryAfterMs: null,
        },
      };
    }

    if (ownPending && !followUp) {
      // Send the newer edits kept above right away.
      const next = await runSync({ confirmMassDelete, followUp: true });

      return {
        ...next,
        pushed: base.pushed + (next.pushed ?? 0),
        pulled: base.pulled + (next.pulled ?? 0),
        conflicts: base.conflicts + (next.conflicts ?? 0),
      };
    }

    return { ...base, status: SYNC_STATUSES.synced };
  }

  function exclusive(task) {
    if (state.running) {
      return null;
    }

    const promise = (async () => {
      let outcome;

      try {
        outcome = await lock.run(task);
      } catch (error) {
        return finish({
          status: SYNC_STATUSES.error,
          error: localError("internal", error?.message ?? "The sync stopped unexpectedly."),
        });
      }

      return finish(outcome?.acquired ? outcome.value : { status: SYNC_STATUSES.busy });
    })();

    state.running = promise.finally(() => {
      state.running = null;
    });

    return state.running;
  }

  /**
   * One sync (decisions H6-5, H6-7, H6-8, H6-10): push, then pull.
   * -> { status, pushed, pulled, conflicts, waiting, error?, deletes?, live? }
   * A second call while one runs in this tab returns the same promise.
   * options: { confirmMassDelete } sends the deletes the H6-10 guard stopped;
   * { restoreDeletes } instead fetches those records back from the account
   * (decision H6-39).
   */
  function syncNow({ confirmMassDelete = false, restoreDeletes = false } = {}) {
    return state.running ?? exclusive(() => runSync({ confirmMassDelete, restoreDeletes }));
  }

  /**
   * The link preview (decision H6-9): pulls the whole account into memory and
   * compares it with the device. Writes nothing.
   * -> { ok: true, status: "needs-link", collections: { name: { deviceOnly,
   *      accountOnly, identical, different } }, totals: { ... },
   *      skipped: n (device records without an id, never synced) }
   *  | { ok: false, status, error }
   */
  async function buildLinkPreview() {
    if (!hasToken()) {
      return { ok: false, status: SYNC_STATUSES.signedOut, error: null };
    }

    const ensured = await ensureMeta();

    if (!ensured.ok) {
      return { ok: false, status: ensured.status, error: ensured.error ?? null };
    }

    const pulled = await pullAll(0);

    if (!pulled.ok) {
      return { ok: false, ...failure(pulled.error) };
    }

    const local = await readLocal();

    if (!local.ok) {
      return { ok: false, ...failure(local.error) };
    }

    const account = await indexAccount(pulled.records);
    const blank = () => ({ deviceOnly: 0, accountOnly: 0, identical: 0, different: 0 });
    const collections = Object.fromEntries(syncableNames().map((name) => [name, blank()]));
    const totals = blank();
    // Records where one side is still the built-in default (decision H6-38):
    // counted under "different" and also here.
    const defaults = { inAccount: 0, onDevice: 0 };
    const seen = new Set();
    const count = (name, field) => {
      collections[name][field] += 1;
      totals[field] += 1;
    };

    for (const record of local.records) {
      const key = recordKey(record.collection, record.recordId);
      const remote = account.get(key);
      seen.add(key);

      if (!remote || remote.deleted) {
        count(record.collection, "deviceOnly");
      } else if (remote.hash === record.hash) {
        count(record.collection, "identical");
      } else {
        const seedKind = classifySeedPair(key, record.body, remote.body);

        if (seedKind === SEED_PAIR_KINDS.same) {
          count(record.collection, "identical");
        } else {
          count(record.collection, "different");

          if (seedKind === SEED_PAIR_KINDS.accountDefault) {
            defaults.inAccount += 1;
          } else if (seedKind === SEED_PAIR_KINDS.deviceDefault) {
            defaults.onDevice += 1;
          }
        }
      }
    }

    for (const [key, remote] of account) {
      if (!remote.deleted && !seen.has(key)) {
        count(remote.collection, "accountOnly");
      }
    }

    return { ok: true, status: SYNC_STATUSES.needsLink, collections, totals, defaults, skipped: local.skipped.length };
  }

  async function runLink(choice) {
    if (!hasToken()) {
      return { status: SYNC_STATUSES.signedOut };
    }

    const ensured = await ensureMeta();

    if (!ensured.ok) {
      return { status: ensured.status, error: ensured.error ?? null };
    }

    const meta = ensured.meta;
    const pulled = await pullAll(0);

    if (!pulled.ok) {
      return failure(pulled.error);
    }

    const local = await readLocal();

    if (!local.ok) {
      return failure(local.error);
    }

    const account = await indexAccount(pulled.records);
    const useAccount = choice === "useAccount";
    const source = useAccount ? SYNC_CONFLICT_SOURCES.linkUseAccount : SYNC_CONFLICT_SOURCES.linkMerge;
    const records = {};
    const changes = [];
    const conflicts = [];
    const localKeys = new Set();

    account.forEach((remote, key) => {
      records[key] = { rev: remote.rev, hash: remote.hash };
    });

    for (const record of local.records) {
      const key = recordKey(record.collection, record.recordId);
      const remote = account.get(key);
      localKeys.add(key);

      if (remote && !remote.deleted) {
        if (remote.hash !== record.hash) {
          const seedKind = classifySeedPair(key, record.body, remote.body);

          if (seedKind === SEED_PAIR_KINDS.same || seedKind === SEED_PAIR_KINDS.deviceDefault) {
            // The same apart from seed time, or this device still has the
            // untouched default: the account's version, nothing kept (H6-38).
            changes.push({ ...remote, conflict: null });
            continue;
          }

          if (seedKind === SEED_PAIR_KINDS.accountDefault && !useAccount) {
            // The account still has the default and this device changed it:
            // Merge keeps the device's version live; the meta holds the
            // account's rev, so the sync below sends it on top (H6-38).
            continue;
          }

          // Different in both: the account version goes live, the device
          // version is kept (both choices).
          changes.push({
            ...remote,
            conflict: { collection: record.collection, recordId: record.recordId, body: record.body, deleted: false, serverRev: remote.rev, source },
          });
        }
      } else if (useAccount) {
        // Only on this device: removed, and kept in syncConflicts.
        changes.push({
          collection: record.collection,
          recordId: record.recordId,
          rev: remote?.rev ?? 0,
          deleted: true,
          body: null,
          text: null,
          conflict: { collection: record.collection, recordId: record.recordId, body: record.body, deleted: false, serverRev: remote?.rev ?? 0, source },
        });
      }
      // Merge keeps a device-only record; the sync below uploads it (a
      // tombstone's rev is its baseRev, so it is not a conflict).
    }

    account.forEach((remote, key) => {
      if (!remote.deleted && !localKeys.has(key)) {
        changes.push({ ...remote, conflict: null });
      }
    });

    const committed = commit({
      session: meta,
      expectLinked: meta.linked,
      local,
      changes,
      conflicts,
      records,
      since: pulled.nextSince,
      linked: true,
      strict: true,
      metaPatch: { epoch: pulled.epoch ?? null, inflight: {}, refetchKeys: [] },
    });

    if (!committed.ok) {
      return committed.result;
    }

    const sync = await runSync({ confirmMassDelete: false });

    return {
      ...sync,
      linked: true,
      choice,
      linkWritten: committed.written,
      conflicts: committed.conflicts + (sync.conflicts ?? 0),
    };
  }

  /**
   * Links the device (decision H6-9) and then syncs once.
   * choice: "merge" | "useAccount" | "cancel" (cancel = signOut()).
   * -> the syncNow result plus { linked: true, choice, linkWritten }, or a
   *    failure / "busy" result with nothing written.
   */
  function applyLink(choice) {
    if (choice === "cancel") {
      return signOut();
    }

    if (choice !== "merge" && choice !== "useAccount") {
      return Promise.resolve(
        finish({ status: SYNC_STATUSES.error, error: localError("invalid_choice", "Choose Merge or Use the account's data.") }),
      );
    }

    return exclusive(() => runLink(choice)) ?? Promise.resolve(finish({ status: SYNC_STATUSES.busy }));
  }

  /** Changes waiting to be pushed (no network). -> number, or null when unlinked / unreadable. */
  async function refreshWaiting() {
    const meta = readMeta();

    if (!hasToken() || !meta?.linked) {
      return null;
    }

    const local = await readLocal();

    if (!local.ok) {
      return null;
    }

    const diff = await diffForPush(local.records, meta);
    state.waiting = diff.ops.length;
    return state.waiting;
  }

  /** The sync meta of a device that is signed in and not linked yet (H6-7, H6-9). */
  function freshMeta(user) {
    return {
      userId: String(user.id),
      username: typeof user.username === "string" ? user.username : "",
      deviceId: String(random()),
      since: 0,
      records: {},
      lastSyncAt: null,
      lastError: null,
      linked: false,
      epoch: null,
      inflight: {},
      refetchKeys: [],
    };
  }

  /**
   * The sync meta, rebuilt when it was lost while the token stayed (decisions
   * H6-10, H6-49): such a device is simply unlinked. The account is read once
   * (GET /v1/account) for its user id and username, a fresh unlinked meta is
   * written, and the link preview goes on as after a sign-in. Nothing is
   * pushed or deleted. A 401 there signs the device out as usual.
   * -> { ok: true, meta } | { ok: false, status, error }
   */
  async function ensureMeta() {
    const meta = readMeta();

    if (meta) {
      return { ok: true, meta };
    }

    const account = await api.getAccount();

    if (!account.ok) {
      return { ok: false, ...failure(account.error) };
    }

    const user = account.data?.user;

    if (!user || (typeof user.id !== "string" && typeof user.id !== "number")) {
      return {
        ok: false,
        status: SYNC_STATUSES.error,
        error: { kind: "server", code: "bad_response", message: "The sync server sent an unexpected answer.", status: null, retryAfterMs: null },
      };
    }

    const rebuilt = freshMeta(user);
    const written = storage.writeMeta(rebuilt);

    if (!written?.ok) {
      return {
        ok: false,
        status: SYNC_STATUSES.error,
        error: localError("meta_write", written?.error ?? "Could not save the sign-in on this device."),
      };
    }

    return { ok: true, meta: readMeta() ?? rebuilt };
  }

  function startSession(data) {
    const token = data?.token;
    const user = data?.user;

    if (typeof token !== "string" || !token || !user || (typeof user.id !== "string" && typeof user.id !== "number")) {
      return { ok: false, error: { kind: "server", code: "bad_response", message: "The sync server sent an unexpected answer.", status: null, retryAfterMs: null } };
    }

    const meta = freshMeta(user);
    const metaWritten = storage.writeMeta(meta);

    if (!metaWritten?.ok) {
      return { ok: false, error: localError("meta_write", metaWritten?.error ?? "Could not save the sign-in on this device.") };
    }

    const tokenWritten = storage.writeToken(token);

    if (!tokenWritten?.ok) {
      storage.clearMeta();
      return { ok: false, error: localError("token_write", tokenWritten?.error ?? "Could not save the sign-in on this device.") };
    }

    state.failures = 0;
    state.lastError = null;
    state.waiting = 0;
    return { ok: true, status: SYNC_STATUSES.needsLink, username: meta.username };
  }

  /** -> { ok: true, status: "needs-link", username } | { ok: false, error } */
  async function signIn(credentials) {
    const result = await api.signIn(credentials);
    return result.ok ? startSession(result.data) : { ok: false, error: result.error };
  }

  /** -> { ok: true, status: "needs-link", username, recoveryCode } | { ok: false, error } */
  async function signUp(credentials) {
    const result = await api.signUp(credentials);

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    const started = startSession(result.data);
    return started.ok ? { ...started, recoveryCode: result.data.recoveryCode ?? null } : started;
  }

  /** Sets a new password with the recovery code and signs in. -> like signUp */
  async function recover(details) {
    const result = await api.recover(details);

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    const started = startSession(result.data);
    return started.ok ? { ...started, recoveryCode: result.data.recoveryCode ?? null } : started;
  }

  async function authed(call) {
    const result = await call();

    if (!result.ok && result.error?.kind === "unauthorized" && result.error.code !== "wrong_password") {
      handleUnauthorized(result.error);
    }

    return result;
  }

  /** -> api result ({ ok, data } | { ok: false, error }) */
  function changePassword(details) {
    return authed(() => api.changePassword(details));
  }

  /** -> api result */
  function getAccount() {
    return authed(() => api.getAccount());
  }

  function clearLocalSession() {
    storage.clearToken();
    storage.clearMeta();
    state.failures = 0;
    state.lastError = null;
    state.waiting = 0;
    state.lastResult = null;
  }

  /**
   * Signs out (decision H6-3): revokes the token on the server (all of the
   * user's tokens with everywhere), then removes the token and the sync meta
   * from this device even when the server could not be reached. User data is
   * never touched. -> { ok: true, status: "signed-out", remoteOk, error }
   */
  async function signOut({ everywhere = false } = {}) {
    let remote = null;

    if (hasToken()) {
      remote = await (everywhere ? api.signOutAll() : api.signOut());
    }

    clearLocalSession();
    return { ok: true, status: SYNC_STATUSES.signedOut, remoteOk: Boolean(remote?.ok), error: remote?.ok ? null : remote?.error ?? null };
  }

  /** Deletes the account (H6-2); local data stays. -> { ok: true } | { ok: false, error } */
  async function deleteAccount({ password } = {}) {
    const result = await api.deleteAccount({ password });

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    clearLocalSession();
    return { ok: true, status: SYNC_STATUSES.signedOut };
  }

  /** The kept local versions, newest first. */
  function listConflicts() {
    return readConflictList();
  }

  function updateConflicts(id, applyEntry) {
    const read = storage.readCollections([SYNC_CONFLICTS_COLLECTION]);

    if (!read.ok) {
      return { ok: false, error: errorFromRead(read) };
    }

    const list = read.values[SYNC_CONFLICTS_COLLECTION];
    const entry = Array.isArray(list) ? list.find((item) => item?.id === id) : null;

    if (!entry) {
      return { ok: false, error: localError("not_found", "That kept version is no longer there.") };
    }

    const entries = [{ name: SYNC_CONFLICTS_COLLECTION, value: list.filter((item) => item !== entry) }];

    if (applyEntry) {
      const collection = getCollection(entry.collection);

      if (!collection?.syncable || typeof entry.recordId !== "string") {
        return { ok: false, error: localError("invalid_entry", "That kept version cannot be restored.") };
      }

      const current = storage.readCollections([collection.name]);

      if (!current.ok) {
        return { ok: false, error: errorFromRead(current) };
      }

      const { values, changed } = applyPulledRecords(
        [{ collection: collection.name, recordId: entry.recordId, deleted: Boolean(entry.deleted), body: entry.body }],
        current.values,
      );

      changed.forEach((name) => entries.push({ name, value: values[name] }));
    }

    // A user change: reason "write", so the sync trigger sends it.
    const written = storage.writeCollections(entries, { reason: STORAGE_WRITE_REASONS.write });

    return written?.ok
      ? { ok: true }
      : { ok: false, error: localError("local_write", written?.error ?? "Could not save on this device.") };
  }

  /**
   * "Keep this version" (decision H6-8): the kept local body becomes the live
   * record again (a delete when the kept version was a delete) and the entry
   * is removed, in one batch with reason "write". The meta still holds the
   * server rev, so the next sync pushes it as a change on top of that rev.
   * -> { ok: true } | { ok: false, error }
   */
  function keepConflictVersion(id) {
    return updateConflicts(id, true);
  }

  /** "Discard": removes the entry only. -> { ok: true } | { ok: false, error } */
  function discardConflict(id) {
    return updateConflicts(id, false);
  }

  return {
    status,
    syncNow,
    buildLinkPreview,
    applyLink,
    refreshWaiting,
    signIn,
    signUp,
    recover,
    changePassword,
    getAccount,
    deleteAccount,
    signOut,
    listConflicts,
    keepConflictVersion,
    discardConflict,
  };
}
