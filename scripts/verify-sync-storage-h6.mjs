import assert from "node:assert/strict";

// Phase H6 / Track B, decisions H6-3, H6-7, H6-8, H6-10: the sync token is a
// secret and the sync meta a device value; neither ever reaches a backup or a
// share file; a restore ignores them and unlinks the device; a reset signs
// the device out of sync (and so never pushes deletes); writes made by a sync
// carry reason "sync"; syncConflicts is a backed-up, never-synced collection;
// the Gemini key keeps its H4 behaviour.

class MemoryLocalStorage {
  constructor() {
    this.store = new Map();
    this.failNextWriteForKey = null;
  }

  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  setItem(key, value) {
    if (this.failNextWriteForKey === key) {
      this.failNextWriteForKey = null;
      throw new DOMException("Simulated quota failure", "QuotaExceededError");
    }

    this.store.set(key, String(value));
  }

  removeItem(key) {
    this.store.delete(key);
  }

  keys() {
    return [...this.store.keys()];
  }
}

const storage = new MemoryLocalStorage();
globalThis.window = { localStorage: storage };

const originalWarn = console.warn;
console.warn = () => {};

const {
  BACKUP_APP_ID,
  clearDeviceValue,
  createLocalBackup,
  DEVICE_STORAGE_KEYS,
  getDeviceStorageKeys,
  getSecretStorageKeys,
  getStorageIssues,
  getTrackedStorageKeys,
  isDeviceStorageKey,
  isSecretStorageKey,
  readDeviceValue,
  readSecret,
  resetLocalAppData,
  restoreLocalBackup,
  SECRET_STORAGE_KEYS,
  STORAGE_ERROR_CODES,
  STORAGE_KEYS,
  STORAGE_WRITE_REASONS,
  subscribeStorageWrites,
  writeDeviceValue,
  writeSecret,
  writeStorage,
  writeStorageBatch,
} = await import("../src/lib/storage.js");
const { checkCollectionRegistry, getCollection, getSyncableCollections } = await import("../src/lib/repository.js");
const { DEFAULT_PROGRAM_ID, exportProgramShare, seedDefaultProgramIfNeeded } = await import("../src/lib/programStorage.js");
const { createLocalSyncStorage, createSyncEngine, SYNC_STATUSES } = await import("../src/lib/syncEngine.js");

const TOKEN_KEY = "rpe-tracker.sync-token.v1";
const META_KEY = "rpe-tracker.sync-meta.v1";
const GEMINI_KEY = "rpe-tracker.gemini-api-key.v1";
const LEASE_KEY = "rpe-tracker.sync-lease.v1";
const TOKEN = "tok_H6_SECRET_7f3a9c";
const DEVICE_ID = "device-H6-unique-4411";
const GEMINI = "AIzaSy-H6-GEMINI-0042";

const linkedMeta = () => ({
  userId: "user-1",
  username: "athlete",
  deviceId: DEVICE_ID,
  since: 7,
  records: { "sessions\u001fs1": { rev: 2, hash: "a".repeat(64) } },
  lastSyncAt: "2026-10-07T08:00:00.000Z",
  lastError: null,
  linked: true,
});

try {
  const tracked0 = getTrackedStorageKeys();
  // ------------------------------------------------------------------
  // Registry
  // ------------------------------------------------------------------
  assert.equal(SECRET_STORAGE_KEYS.syncToken, TOKEN_KEY);
  assert.deepEqual(getSecretStorageKeys(), [GEMINI_KEY, TOKEN_KEY]);
  assert.ok(isSecretStorageKey(TOKEN_KEY));
  assert.deepEqual({ ...DEVICE_STORAGE_KEYS }, { syncMeta: META_KEY, syncLease: LEASE_KEY });
  assert.ok(Object.isFrozen(DEVICE_STORAGE_KEYS));
  assert.deepEqual(getDeviceStorageKeys(), [META_KEY, LEASE_KEY]);
  assert.ok(!tracked0.includes(LEASE_KEY), "the sync lease is never tracked (H6-18)");
  assert.ok(isDeviceStorageKey(META_KEY));
  assert.ok(!isDeviceStorageKey(TOKEN_KEY));
  assert.ok(!isSecretStorageKey(META_KEY));
  const tracked = getTrackedStorageKeys();
  assert.ok(!tracked.includes(TOKEN_KEY) && !tracked.includes(META_KEY), "token and meta are never tracked");

  assert.equal(STORAGE_KEYS.syncConflicts, "rpe-tracker.sync-conflicts.v1");
  assert.ok(tracked.includes(STORAGE_KEYS.syncConflicts), "syncConflicts is tracked");
  const conflicts = getCollection("syncConflicts");
  assert.equal(conflicts.key, STORAGE_KEYS.syncConflicts);
  assert.equal(conflicts.kind, "list");
  assert.equal(conflicts.idField, "id");
  assert.equal(conflicts.scope, "meta");
  assert.equal(conflicts.backedUp, true, "syncConflicts is backed up");
  assert.equal(conflicts.syncable, false, "syncConflicts is never synced");
  assert.deepEqual(conflicts.fallback, []);
  assert.equal(checkCollectionRegistry().ok, true, "registry still matches the tracked keys");
  assert.equal(getSyncableCollections().length, 15);
  assert.ok(!getSyncableCollections().some((c) => c.name === "syncConflicts"));

  // ------------------------------------------------------------------
  // Device values: JSON, no issue, no notification, device keys only.
  // ------------------------------------------------------------------
  const events = [];
  const unsubscribe = subscribeStorageWrites((event) => events.push(event));

  assert.equal(readDeviceValue(META_KEY), null, "absent reads as the fallback");
  assert.equal(readDeviceValue(META_KEY, "fb"), "fb");
  assert.deepEqual(writeDeviceValue(META_KEY, linkedMeta()), { ok: true });
  assert.equal(storage.getItem(META_KEY), JSON.stringify(linkedMeta()), "stored as JSON");
  assert.deepEqual(readDeviceValue(META_KEY), linkedMeta());
  storage.setItem(META_KEY, "{broken");
  assert.equal(readDeviceValue(META_KEY, null), null, "unreadable meta reads as the fallback");
  const foreign = writeDeviceValue(STORAGE_KEYS.sessions, []);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.code, STORAGE_ERROR_CODES.write);
  assert.equal(storage.getItem(STORAGE_KEYS.sessions), null, "a tracked key cannot be written as a device value");
  assert.equal(readDeviceValue(TOKEN_KEY, "x"), "x", "a secret is not a device value");
  storage.failNextWriteForKey = META_KEY;
  const quota = writeDeviceValue(META_KEY, linkedMeta());
  assert.equal(quota.ok, false);
  assert.equal(quota.code, STORAGE_ERROR_CODES.quota);
  assert.equal(storage.getItem(META_KEY), "{broken", "a failed write leaves the old text");
  assert.equal(writeDeviceValue(META_KEY, { n: 10n }).ok, false, "unserializable value refused");
  assert.deepEqual(clearDeviceValue(META_KEY), { ok: true });
  assert.equal(storage.getItem(META_KEY), null);
  assert.equal(clearDeviceValue(STORAGE_KEYS.sessions).ok, false);
  assert.equal(events.length, 0, "device values never notify");
  assert.deepEqual(getStorageIssues(), [], "device values never record an issue");

  // ------------------------------------------------------------------
  // The "sync" write reason (H6-7).
  // ------------------------------------------------------------------
  assert.equal(STORAGE_WRITE_REASONS.sync, "sync");
  writeStorageBatch([{ key: STORAGE_KEYS.sessions, value: [{ id: "s1" }] }], { reason: STORAGE_WRITE_REASONS.sync });
  writeStorageBatch([{ key: STORAGE_KEYS.sessions, value: [{ id: "s1", v: 2 }] }]);
  writeStorageBatch([{ key: STORAGE_KEYS.sessions, value: [{ id: "s1", v: 3 }] }], { reason: "made-up" });
  writeStorage(STORAGE_KEYS.programs, []);
  const adapter = createLocalSyncStorage();
  assert.equal(adapter.writeCollections([{ name: "sessions", value: [{ id: "s1", v: 4 }] }], { reason: "sync" }).ok, true);
  assert.deepEqual(
    events.map((event) => event.reason),
    ["sync", "write", "write", "write", "sync"],
    "sync batches say so; default and unknown reasons stay write",
  );
  assert.deepEqual([...events[0].keys], [STORAGE_KEYS.sessions]);
  events.length = 0;

  // ------------------------------------------------------------------
  // Backups and share files never carry the token or the meta.
  // ------------------------------------------------------------------
  seedDefaultProgramIfNeeded();
  writeStorage(STORAGE_KEYS.syncConflicts, [{ id: "c1", collection: "sessions", recordId: "s1", body: { id: "s1" }, deleted: false, serverRev: 3, at: "2026-10-07T08:00:00.000Z", source: "sync" }]);
  assert.deepEqual(writeSecret(TOKEN_KEY, TOKEN), { ok: true });
  assert.deepEqual(writeSecret(GEMINI_KEY, GEMINI), { ok: true });
  assert.deepEqual(writeDeviceValue(META_KEY, linkedMeta()), { ok: true });

  const backup = createLocalBackup();
  const backupText = JSON.stringify(backup);
  for (const needle of [TOKEN, TOKEN_KEY, META_KEY, DEVICE_ID, GEMINI, GEMINI_KEY]) {
    assert.ok(!backupText.includes(needle), `backup never contains ${needle.slice(0, 18)}`);
  }
  assert.ok(STORAGE_KEYS.syncConflicts in backup.data, "kept conflict versions are backed up");
  assert.equal(backup.data[STORAGE_KEYS.syncConflicts][0].id, "c1");

  const share = exportProgramShare(DEFAULT_PROGRAM_ID);
  assert.ok(share, "the default program exports");
  const shareText = JSON.stringify(share);
  for (const needle of [TOKEN, TOKEN_KEY, META_KEY, DEVICE_ID, GEMINI, GEMINI_KEY, "sync-conflicts"]) {
    assert.ok(!shareText.includes(needle), `share file never contains ${needle.slice(0, 18)}`);
  }

  // ------------------------------------------------------------------
  // Restore ignores smuggled token / meta, keeps the token, unlinks.
  // ------------------------------------------------------------------
  events.length = 0;
  const smuggled = {
    app: BACKUP_APP_ID,
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    storageKeys: [STORAGE_KEYS.sessions, TOKEN_KEY, META_KEY],
    data: {
      [STORAGE_KEYS.sessions]: [{ id: "restored" }],
      [TOKEN_KEY]: "smuggled-token",
      [META_KEY]: { ...linkedMeta(), deviceId: "smuggled-device", records: {} },
    },
  };
  const restored = restoreLocalBackup(smuggled);
  assert.equal(restored.valid, true);
  assert.deepEqual([...restored.ignoredKeys].sort(), [META_KEY, TOKEN_KEY].sort(), "token and meta in a backup are ignored");
  assert.equal(readSecret(TOKEN_KEY), TOKEN, "the token is kept");
  assert.equal(readSecret(GEMINI_KEY), GEMINI, "the Gemini key is kept");
  assert.deepEqual(readDeviceValue(META_KEY), { ...linkedMeta(), linked: false }, "the device is unlinked, everything else kept");
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.sessions)), [{ id: "restored" }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "restore");
  assert.ok(!events[0].keys.includes(TOKEN_KEY) && !events[0].keys.includes(META_KEY));

  // A restored device is not synced until it is linked again.
  const calls = [];
  const recordingApi = new Proxy(
    {},
    {
      get: (_, name) => async () => {
        calls.push(name);
        return { ok: false, error: { kind: "offline", code: "network" } };
      },
    },
  );
  const engine = createSyncEngine({ api: recordingApi, storage: createLocalSyncStorage() });
  assert.equal((await engine.syncNow()).status, SYNC_STATUSES.needsLink);
  assert.equal(engine.status().linked, false);
  assert.deepEqual(calls, [], "an unlinked device pushes nothing");

  // A restore that fails half way puts the meta back exactly.
  assert.deepEqual(writeDeviceValue(META_KEY, linkedMeta()), { ok: true });
  const metaText = storage.getItem(META_KEY);
  storage.failNextWriteForKey = STORAGE_KEYS.programs;
  const failed = restoreLocalBackup(backup);
  assert.equal(failed.valid, false);
  assert.equal(failed.rolledBack, true);
  assert.equal(storage.getItem(META_KEY), metaText, "the meta is back as it was (still linked)");
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.sessions)), [{ id: "restored" }], "data rolled back");

  // An invalid backup leaves the meta linked.
  assert.equal(restoreLocalBackup({ app: "other" }).valid, false);
  assert.equal(storage.getItem(META_KEY), metaText);

  // Unreadable meta is removed by a restore; no meta stays no meta.
  storage.setItem(META_KEY, "{broken");
  assert.equal(restoreLocalBackup(backup).valid, true);
  assert.equal(storage.getItem(META_KEY), null);
  assert.equal(restoreLocalBackup(backup).valid, true);
  assert.equal(storage.getItem(META_KEY), null, "a restore never creates a meta");

  // ------------------------------------------------------------------
  // Reset signs the device out of sync, keeps the Gemini key, and the
  // engine then sends nothing (so never a delete).
  // ------------------------------------------------------------------
  assert.deepEqual(writeDeviceValue(META_KEY, linkedMeta()), { ok: true });
  assert.equal(engine.status().linked, true);
  events.length = 0;
  assert.deepEqual(resetLocalAppData(), { ok: true });
  assert.equal(storage.getItem(TOKEN_KEY), null, "token removed");
  assert.equal(storage.getItem(META_KEY), null, "meta removed");
  assert.equal(readSecret(GEMINI_KEY), GEMINI, "the Gemini key stays for the Settings reset (H4-6)");
  assert.deepEqual(storage.keys(), [GEMINI_KEY], "only the Gemini key is left");
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "reset");
  assert.ok(events[0].keys.every((key) => tracked.includes(key)), "the reset names tracked keys only");
  assert.ok(events[0].keys.includes(STORAGE_KEYS.syncConflicts), "kept conflicts are user data and go with a reset");

  calls.length = 0;
  const afterReset = await engine.syncNow();
  assert.equal(afterReset.status, SYNC_STATUSES.signedOut);
  assert.equal(engine.status().signedIn, false);
  assert.equal(await engine.refreshWaiting(), null);
  assert.deepEqual(calls, [], "after a reset the engine makes no request at all");

  unsubscribe();
  console.log("Sync storage H6 (token, meta, restore, reset, sync reason) verification passed.");
} finally {
  console.warn = originalWarn;
}
