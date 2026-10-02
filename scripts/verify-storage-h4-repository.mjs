import assert from "node:assert/strict";

// Phase H4 / Track B: storage repository registry (src/lib/repository.js) and
// write notifications (storage.js subscribeStorageWrites), decision H4-4.

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

const capturedWarnings = [];
const originalWarn = console.warn;
console.warn = (...args) => {
  capturedWarnings.push(args);
};

const {
  createLocalBackup,
  getStorageIssues,
  getTrackedStorageKeys,
  SECRET_STORAGE_KEYS,
  STORAGE_ERROR_CODES,
  STORAGE_KEYS,
  STORAGE_WRITE_REASONS,
  STORAGE_WRITE_SOURCE_LOCAL,
  subscribeStorageWrites,
  writeStorage,
  writeStorageBatch,
} = await import("../src/lib/storage.js");
const {
  checkCollectionRegistry,
  COLLECTION_KINDS,
  COLLECTION_SCOPES,
  COLLECTIONS,
  getCollection,
  getCollectionByKey,
  getCollectionNames,
  getRecordId,
  getSyncableCollections,
  listRecords,
  readCollection,
  readCollectionResult,
  writeCollection,
  writeCollections,
} = await import("../src/lib/repository.js");

try {
  // ------------------------------------------------------------------
  // Registry completeness: every STORAGE_KEYS entry exactly once, and the
  // registry names agree with the STORAGE_KEYS property names.
  // ------------------------------------------------------------------
  const trackedKeys = getTrackedStorageKeys();
  assert.deepEqual(checkCollectionRegistry(), { ok: true, missing: [], unknown: [], duplicate: [] });
  assert.equal(COLLECTIONS.length, trackedKeys.length, "one collection per tracked key");
  assert.deepEqual(
    [...COLLECTIONS.map((collection) => collection.key)].sort(),
    [...trackedKeys].sort(),
    "registered keys are exactly the tracked keys",
  );

  for (const [name, key] of Object.entries(STORAGE_KEYS)) {
    const matches = COLLECTIONS.filter((collection) => collection.key === key);
    assert.equal(matches.length, 1, `${name} is registered exactly once`);
    assert.equal(matches[0].name, name, `${name} is registered under its STORAGE_KEYS name`);
    assert.equal(getCollection(name), matches[0]);
    assert.equal(getCollectionByKey(key), matches[0]);
    assert.ok(Object.isFrozen(matches[0]), `${name} descriptor is frozen`);
    assert.ok(Object.values(COLLECTION_KINDS).includes(matches[0].kind), `${name} has a known kind`);
    assert.ok(Object.values(COLLECTION_SCOPES).includes(matches[0].scope), `${name} has a known scope`);
    assert.equal(typeof matches[0].backedUp, "boolean");
    assert.equal(typeof matches[0].syncable, "boolean");

    if (matches[0].kind === COLLECTION_KINDS.list) {
      assert.ok(matches[0].idField, `${name} list has an idField`);
    } else {
      assert.equal(matches[0].idField, null, `${name} ${matches[0].kind} has no idField`);
    }
  }

  assert.deepEqual(getCollectionNames(), Object.keys(STORAGE_KEYS));
  assert.equal(getCollection("gemini"), null);
  assert.equal(getCollectionByKey(SECRET_STORAGE_KEYS.geminiApiKey), null, "secrets are not collections");
  assert.ok(
    COLLECTIONS.every((collection) => !Object.values(SECRET_STORAGE_KEYS).includes(collection.key)),
    "no secret key is registered as a collection",
  );

  // backedUp agrees with the backup code path: createLocalBackup exports
  // exactly getTrackedStorageKeys.
  const backup = createLocalBackup();
  for (const collection of COLLECTIONS) {
    assert.equal(
      collection.backedUp,
      backup.storageKeys.includes(collection.key),
      `${collection.name}.backedUp matches createLocalBackup`,
    );
  }

  // Sync policy (decision H4-4).
  const syncable = new Set(getSyncableCollections().map((collection) => collection.name));
  const expectedSyncable = [
    "sessions",
    "nextPlans",
    "setupCues",
    "readinessByDate",
    "workoutDrafts",
    "programs",
    "programDays",
    "programSections",
    "exerciseLibrary",
    "programExercises",
    "baselines",
    "programStates",
    "programProgressions",
    "programDrafts",
    // Phase H5, decision H5-6: hold / manual overrides are user data.
    "programOverrides",
  ];
  assert.deepEqual([...syncable].sort(), [...expectedSyncable].sort());
  assert.equal(getCollection("programOverrides").idField, "id");
  assert.equal(getCollection("programOverrides").backedUp, true);
  assert.equal(getCollection("appUiState").scope, COLLECTION_SCOPES.uiState);
  assert.equal(getCollection("appUiState").syncable, false);
  assert.equal(getCollection("programStorageMeta").scope, COLLECTION_SCOPES.meta);
  assert.equal(getCollection("activeProgramId").scope, COLLECTION_SCOPES.meta);
  assert.equal(getCollection("activeProgramId").syncable, false);
  assert.ok(
    expectedSyncable.every((name) => getCollection(name).scope === COLLECTION_SCOPES.userData),
    "every syncable collection is user data",
  );
  assert.deepEqual(getCollection("baselines").idField, ["programId", "programExerciseId"]);
  assert.deepEqual(getCollection("programProgressions").idField, ["programId", "programExerciseId"]);
  assert.equal(getCollection("programStates").idField, "programId");
  assert.equal(getCollection("programDrafts").idField, "draftId");
  assert.equal(getCollection("sessions").idField, "id");
  assert.equal(getCollection("nextPlans").kind, COLLECTION_KINDS.map);

  // ------------------------------------------------------------------
  // Accessors delegate to storage.js and return its results unchanged.
  // ------------------------------------------------------------------
  assert.deepEqual(readCollection("sessions"), [], "list fallback");
  assert.deepEqual(readCollection("nextPlans"), {}, "map fallback");
  assert.equal(readCollection("activeProgramId"), null, "value fallback");
  assert.equal(readCollection("sessions", "custom"), "custom", "explicit fallback wins");
  assert.equal(readCollectionResult("sessions").ok, true);
  assert.deepEqual(readCollectionResult("sessions").value, []);
  assert.throws(() => readCollection("nope"), /Unknown repository collection "nope"/);

  // A read of an absent collection hands out its own copy of the fallback:
  // mutating it never changes the registry or the next read (H4 fix round 2).
  for (const collection of COLLECTIONS) {
    if (collection.fallback && typeof collection.fallback === "object") {
      assert.ok(Object.isFrozen(collection.fallback), `${collection.name} fallback is frozen`);
    }
  }
  assert.equal(storage.getItem(STORAGE_KEYS.sessions), null, "sessions is absent here");
  const ghostList = listRecords("sessions");
  ghostList.push({ id: "ghost" });
  readCollection("sessions").push({ id: "ghost-2" });
  readCollectionResult("sessions").value.push({ id: "ghost-3" });
  assert.deepEqual(readCollection("sessions"), [], "a mutated list read does not leak");
  assert.deepEqual(listRecords("sessions"), []);
  assert.deepEqual(readCollectionResult("sessions").value, []);
  assert.deepEqual(getCollection("sessions").fallback, []);
  assert.notEqual(readCollection("sessions"), readCollection("sessions"), "each read is a new array");
  readCollection("nextPlans").ghost = { generatedAt: "x" };
  readCollectionResult("appUiState").value.ghost = true;
  assert.deepEqual(readCollection("nextPlans"), {}, "a mutated map read does not leak");
  assert.deepEqual(listRecords("nextPlans"), []);
  assert.deepEqual(readCollection("appUiState"), {});
  assert.deepEqual(getCollection("nextPlans").fallback, {});
  assert.deepEqual(getCollection("appUiState").fallback, {});
  assert.throws(() => {
    getCollection("sessions").fallback.push({ id: "ghost" });
  }, TypeError);

  const events = [];
  const unsubscribe = subscribeStorageWrites((event) => events.push(event));

  assert.deepEqual(writeCollection("sessions", [{ id: "s1" }]), { ok: true });
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.sessions)), [{ id: "s1" }]);
  assert.deepEqual(readCollection("sessions"), [{ id: "s1" }]);
  assert.equal(events.length, 1, "one event per single write");
  assert.deepEqual(events[0].keys, [STORAGE_KEYS.sessions]);
  assert.equal(events[0].source, STORAGE_WRITE_SOURCE_LOCAL);
  assert.equal(events[0].source, "local");
  assert.equal(events[0].reason, STORAGE_WRITE_REASONS.write);
  assert.equal(events[0].reason, "write");
  assert.ok(!Number.isNaN(Date.parse(events[0].at)), "at is a date");
  assert.equal(new Date(events[0].at).toISOString(), events[0].at, "at is an ISO string");
  assert.ok(Object.isFrozen(events[0]) && Object.isFrozen(events[0].keys), "event is frozen");

  const batch = writeCollections([
    { name: "programs", value: [{ id: "p1" }] },
    { name: "activeProgramId", value: "p1" },
    { name: "programs", value: [{ id: "p1" }, { id: "p2" }] },
  ]);
  assert.equal(batch.ok, true);
  assert.deepEqual(batch.writtenKeys, [
    STORAGE_KEYS.programs,
    STORAGE_KEYS.activeProgramId,
    STORAGE_KEYS.programs,
  ]);
  assert.equal(events.length, 2, "one event per batch");
  assert.deepEqual(
    events[1].keys,
    [STORAGE_KEYS.programs, STORAGE_KEYS.activeProgramId],
    "batch event lists each key once, in entry order",
  );
  assert.equal(events[1].reason, "write");
  assert.deepEqual(readCollection("programs"), [{ id: "p1" }, { id: "p2" }]);

  // Unknown name in a batch throws before anything is written.
  const before = new Map(storage.store);
  assert.throws(
    () => writeCollections([{ name: "programs", value: [] }, { name: "ghost", value: 1 }]),
    /Unknown repository collection "ghost"/,
  );
  assert.deepEqual(new Map(storage.store), before, "nothing written for a bad batch");
  assert.equal(events.length, 2);

  // Empty batch: ok, nothing written, no event.
  assert.deepEqual(writeCollections([]), { ok: true, writtenKeys: [] });
  assert.equal(events.length, 2);

  // listRecords / getRecordId.
  assert.deepEqual(listRecords("programs"), [{ id: "p1" }, { id: "p2" }]);
  writeCollection("nextPlans", { "day-1": { generatedAt: "x" }, "day-2": { generatedAt: "y" } });
  assert.deepEqual(listRecords("nextPlans"), [
    { id: "day-1", value: { generatedAt: "x" } },
    { id: "day-2", value: { generatedAt: "y" } },
  ]);
  assert.deepEqual(listRecords("activeProgramId"), []);
  storage.setItem(STORAGE_KEYS.programDays, JSON.stringify({ not: "a list" }));
  assert.deepEqual(listRecords("programDays"), [], "a non-array list reads as empty");
  assert.equal(getRecordId("baselines", { programId: "p1", programExerciseId: "e1" }), "p1::e1");
  assert.equal(getRecordId("baselines", { programId: "p1" }), null);
  assert.equal(getRecordId("sessions", { id: 12 }), "12");
  assert.equal(getRecordId("sessions", null), null);
  assert.equal(getRecordId("nextPlans", { id: "x" }), null, "maps have no record id");

  // ------------------------------------------------------------------
  // Notifications only on success.
  // ------------------------------------------------------------------
  const eventsBefore = events.length;

  storage.failNextWriteForKey = STORAGE_KEYS.sessions;
  const failed = writeStorage(STORAGE_KEYS.sessions, [{ id: "s2" }]);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, STORAGE_ERROR_CODES.quota);
  assert.equal(events.length, eventsBefore, "failed single write emits nothing");

  const serializeFailed = writeStorage(STORAGE_KEYS.sessions, undefined);
  assert.equal(serializeFailed.ok, false);
  assert.equal(serializeFailed.code, STORAGE_ERROR_CODES.serialize);
  assert.equal(events.length, eventsBefore, "serialize failure emits nothing");

  storage.failNextWriteForKey = STORAGE_KEYS.activeProgramId;
  const rolledBack = writeStorageBatch([
    { key: STORAGE_KEYS.programs, value: [] },
    { key: STORAGE_KEYS.activeProgramId, value: "p9" },
  ]);
  assert.equal(rolledBack.ok, false);
  assert.equal(rolledBack.rolledBack, true);
  assert.deepEqual(readCollection("programs"), [{ id: "p1" }, { id: "p2" }], "batch rolled back");
  assert.equal(events.length, eventsBefore, "rolled-back batch emits nothing");

  storage.setItem(STORAGE_KEYS.setupCues, "{not json");
  const refused = writeStorage(STORAGE_KEYS.setupCues, {});
  assert.equal(refused.code, STORAGE_ERROR_CODES.corrupt);
  assert.equal(events.length, eventsBefore, "corrupt refusal emits nothing");
  const refusedBatch = writeStorageBatch([{ key: STORAGE_KEYS.setupCues, value: {} }]);
  assert.equal(refusedBatch.code, STORAGE_ERROR_CODES.corrupt);
  assert.equal(events.length, eventsBefore, "corrupt batch refusal emits nothing");

  const overwritten = writeStorage(STORAGE_KEYS.setupCues, { a: 1 }, { overwriteCorrupt: true });
  assert.equal(overwritten.ok, true);
  assert.equal(events.length, eventsBefore + 1, "an explicit overwrite is a successful write");
  assert.deepEqual(events.at(-1).keys, [STORAGE_KEYS.setupCues]);
  assert.equal(
    getStorageIssues().filter((issue) => issue.key === STORAGE_KEYS.setupCues).length,
    0,
    "read-corrupt issue cleared by the knowing overwrite",
  );

  // ------------------------------------------------------------------
  // Unsubscribe, throwing listeners, listener order.
  // ------------------------------------------------------------------
  unsubscribe();
  unsubscribe(); // idempotent
  writeStorage(STORAGE_KEYS.sessions, [{ id: "s3" }]);
  assert.equal(events.length, eventsBefore + 1, "unsubscribed listener receives nothing");

  const seen = [];
  const stopThrowing = subscribeStorageWrites(() => {
    seen.push("throwing");
    throw new Error("listener exploded");
  });
  const stopSecond = subscribeStorageWrites((event) => {
    seen.push(`second:${event.keys.join(",")}`);
  });
  const warningsBefore = capturedWarnings.length;
  const okWrite = writeStorage(STORAGE_KEYS.sessions, [{ id: "s4" }]);
  assert.deepEqual(okWrite, { ok: true }, "write succeeds although a listener threw");
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.sessions)), [{ id: "s4" }]);
  assert.deepEqual(seen, ["throwing", `second:${STORAGE_KEYS.sessions}`], "other listeners still run");
  assert.equal(capturedWarnings.length, warningsBefore + 1, "the throw is warned once");
  assert.match(String(capturedWarnings.at(-1)[0]), /write subscriber threw/);

  // A listener that unsubscribes itself during the notification does not
  // skip the next listener.
  seen.length = 0;
  stopThrowing();
  let stopSelf = () => {};
  stopSelf = subscribeStorageWrites(() => {
    seen.push("self");
    stopSelf();
  });
  const stopThird = subscribeStorageWrites(() => seen.push("third"));
  writeStorage(STORAGE_KEYS.sessions, [{ id: "s5" }]);
  assert.deepEqual(seen, [`second:${STORAGE_KEYS.sessions}`, "self", "third"]);
  seen.length = 0;
  writeStorage(STORAGE_KEYS.sessions, [{ id: "s6" }]);
  assert.deepEqual(seen, [`second:${STORAGE_KEYS.sessions}`, "third"], "self-unsubscribed listener is gone");
  stopSecond();
  stopThird();

  assert.equal(typeof subscribeStorageWrites(null), "function", "a non-function listener is ignored");
  seen.length = 0;
  writeStorage(STORAGE_KEYS.sessions, [{ id: "s7" }]);
  assert.deepEqual(seen, []);

  // A listener that mutates the event cannot affect others (frozen).
  const stopMutator = subscribeStorageWrites((event) => {
    assert.throws(() => {
      event.keys.push("x");
    });
    assert.throws(() => {
      event.source = "remote";
    });
  });
  writeStorage(STORAGE_KEYS.sessions, [{ id: "s8" }]);
  stopMutator();

  console.log("Storage H4 repository / write-notification verification passed.");
} finally {
  console.warn = originalWarn;
}
