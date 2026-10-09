import assert from "node:assert/strict";

// Phase H4 fix round 2, decision H4-12: restoreLocalBackup and
// resetLocalAppData emit one write notification on success, naming the
// tracked keys whose stored text changed, and nothing on failure.

class MemoryLocalStorage {
  constructor() {
    this.store = new Map();
    this.failNextWriteForKey = null;
    this.failNextRemove = false;
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
    if (this.failNextRemove) {
      this.failNextRemove = false;
      throw new Error("Simulated remove failure");
    }

    this.store.delete(key);
  }
}

const storage = new MemoryLocalStorage();
globalThis.window = { localStorage: storage };

const originalWarn = console.warn;
console.warn = () => {};

const {
  createLocalBackup,
  getTrackedStorageKeys,
  resetLocalAppData,
  restoreLocalBackup,
  SECRET_STORAGE_KEYS,
  STORAGE_KEYS,
  STORAGE_WRITE_REASONS,
  subscribeStorageWrites,
  writeSecret,
  writeStorage,
  writeStorageBatch,
} = await import("../src/lib/storage.js");

try {
  assert.deepEqual(
    { ...STORAGE_WRITE_REASONS },
    // Decision H6-7 adds "sync" (scripts/verify-sync-storage-h6.mjs).
    { write: "write", restore: "restore", reset: "reset", sync: "sync" },
  );
  assert.ok(Object.isFrozen(STORAGE_WRITE_REASONS));

  const trackedKeys = getTrackedStorageKeys();
  const trackedOrder = (keys) => trackedKeys.filter((key) => keys.includes(key));

  // Device A: the data the backup is made from.
  writeStorage(STORAGE_KEYS.sessions, [{ id: "s1" }]);
  writeStorage(STORAGE_KEYS.programs, [{ id: "p1" }]);
  writeStorage(STORAGE_KEYS.activeProgramId, "p1");
  writeSecret(SECRET_STORAGE_KEYS.geminiApiKey, "secret-key");
  const backup = createLocalBackup();

  const events = [];
  const unsubscribe = subscribeStorageWrites((event) => events.push(event));

  // ------------------------------------------------------------------
  // Restoring what is already stored changes nothing: silent.
  // ------------------------------------------------------------------
  const same = restoreLocalBackup(backup);
  assert.equal(same.valid, true);
  assert.equal(events.length, 0, "an identical restore emits nothing");

  // ------------------------------------------------------------------
  // Restore over different data: one event, changed keys only, tracked-key
  // order, including the keys the restore removed.
  // ------------------------------------------------------------------
  writeStorage(STORAGE_KEYS.sessions, [{ id: "s1" }, { id: "s2" }]);
  writeStorage(STORAGE_KEYS.readinessByDate, { "2026-09-29": { status: "green" } });
  events.length = 0;

  const restored = restoreLocalBackup(backup);
  assert.equal(restored.valid, true);
  assert.deepEqual(restored.restoredKeys, backup.storageKeys.filter((key) => key in backup.data));
  assert.equal(events.length, 1, "one event per successful restore");
  assert.deepEqual(
    events[0].keys,
    trackedOrder([STORAGE_KEYS.sessions, STORAGE_KEYS.readinessByDate]),
    "replaced and removed keys, unchanged keys left out",
  );
  assert.equal(events[0].reason, "restore");
  assert.equal(events[0].source, "local");
  assert.equal(new Date(events[0].at).toISOString(), events[0].at);
  assert.ok(Object.isFrozen(events[0]) && Object.isFrozen(events[0].keys));
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.sessions)), [{ id: "s1" }]);
  assert.equal(storage.getItem(STORAGE_KEYS.readinessByDate), null);
  assert.ok(
    events[0].keys.every((key) => trackedKeys.includes(key)),
    "only tracked keys are named",
  );
  assert.ok(!events[0].keys.includes(SECRET_STORAGE_KEYS.geminiApiKey), "never a secret");

  // The listener sees the restored data already in place (success first).
  let seenDuringEvent = null;
  const stopPeek = subscribeStorageWrites(() => {
    seenDuringEvent = storage.getItem(STORAGE_KEYS.sessions);
  });
  writeStorage(STORAGE_KEYS.sessions, []);
  restoreLocalBackup(backup);
  assert.equal(seenDuringEvent, JSON.stringify([{ id: "s1" }]));
  stopPeek();

  // A throwing listener never fails the restore.
  const stopThrowing = subscribeStorageWrites(() => {
    throw new Error("listener exploded");
  });
  writeStorage(STORAGE_KEYS.sessions, []);
  assert.equal(restoreLocalBackup(backup).valid, true);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.sessions)), [{ id: "s1" }]);
  stopThrowing();

  // ------------------------------------------------------------------
  // Failed restores emit nothing.
  // ------------------------------------------------------------------
  events.length = 0;
  assert.equal(restoreLocalBackup({ app: "other", data: {} }).valid, false);
  assert.equal(restoreLocalBackup(null).valid, false);
  assert.equal(events.length, 0, "an invalid backup emits nothing");

  writeStorage(STORAGE_KEYS.sessions, [{ id: "kept" }]);
  events.length = 0;
  storage.failNextWriteForKey = STORAGE_KEYS.programs;
  const failed = restoreLocalBackup(backup);
  assert.equal(failed.valid, false);
  assert.equal(failed.rolledBack, true);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.sessions)), [{ id: "kept" }]);
  assert.equal(events.length, 0, "a rolled-back restore emits nothing");

  // ------------------------------------------------------------------
  // Reset: one event with the tracked keys that held data; secrets and
  // corrupt copies are never named; an empty device stays silent.
  // ------------------------------------------------------------------
  storage.setItem(`${STORAGE_KEYS.sessions}.corrupt-1`, "{broken");
  events.length = 0;
  const present = trackedKeys.filter((key) => storage.getItem(key) !== null);
  assert.deepEqual(
    present,
    trackedOrder([STORAGE_KEYS.sessions, STORAGE_KEYS.programs, STORAGE_KEYS.activeProgramId]),
  );

  storage.failNextRemove = true;
  assert.equal(resetLocalAppData().ok, false);
  assert.equal(events.length, 0, "a failed reset emits nothing");

  assert.deepEqual(resetLocalAppData(), { ok: true });
  assert.equal(events.length, 1, "one event per successful reset");
  assert.deepEqual(events[0].keys, present);
  assert.equal(events[0].reason, "reset");
  assert.equal(events[0].source, "local");
  assert.ok(Object.isFrozen(events[0]) && Object.isFrozen(events[0].keys));
  assert.ok(trackedKeys.every((key) => storage.getItem(key) === null));
  assert.equal(storage.getItem(`${STORAGE_KEYS.sessions}.corrupt-1`), null);
  assert.equal(storage.getItem(SECRET_STORAGE_KEYS.geminiApiKey), "secret-key", "reset leaves the secret");

  assert.deepEqual(resetLocalAppData(), { ok: true });
  assert.equal(events.length, 1, "resetting an empty device emits nothing");

  // Restore onto the empty device: every restored key is new.
  events.length = 0;
  assert.equal(restoreLocalBackup(backup).valid, true);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].keys, present);
  assert.equal(events[0].reason, "restore");

  // Ordinary writes keep reason "write".
  events.length = 0;
  writeStorage(STORAGE_KEYS.sessions, [{ id: "s9" }]);
  writeStorageBatch([{ key: STORAGE_KEYS.programs, value: [] }]);
  assert.deepEqual(
    events.map((event) => event.reason),
    ["write", "write"],
  );

  // No subscriber after unsubscribe.
  unsubscribe();
  events.length = 0;
  resetLocalAppData();
  assert.equal(events.length, 0);

  console.log("Storage H4 restore / reset write-notification verification passed.");
} finally {
  console.warn = originalWarn;
}
