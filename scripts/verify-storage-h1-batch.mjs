// H1 Track B: checked persistence primitives (F2), corrupt reads (decision new-G)
// and the storage issues observable.
import assert from "node:assert/strict";

class MemoryLocalStorage {
  constructor() {
    this.store = new Map();
    this.failAllWrites = false;
    this.failNextWriteForKey = null;
    this.failWritesForKeys = new Set();
    this.failureName = "QuotaExceededError";
    this.writes = [];
  }

  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  setItem(key, value) {
    if (
      this.failAllWrites ||
      this.failNextWriteForKey === key ||
      this.failWritesForKeys.has(key)
    ) {
      this.failNextWriteForKey = null;
      throw new DOMException(`Simulated write failure for ${key}`, this.failureName);
    }

    this.writes.push(key);
    this.store.set(key, String(value));
  }

  removeItem(key) {
    this.store.delete(key);
  }
}

function installStorage(localStorage) {
  globalThis.window = { localStorage };
  return localStorage;
}

const capturedWarnings = [];
const originalWarn = console.warn;
console.warn = (...args) => {
  capturedWarnings.push(args);
};

const {
  clearStorageIssue,
  getStorageIssues,
  MAX_CORRUPT_COPIES_PER_KEY,
  readStorage,
  readStorageResult,
  STORAGE_KEYS,
  subscribeStorageIssues,
  writeStorage,
  writeStorageBatch,
} = await import("../src/lib/storage.js");

try {
  // ------------------------------------------------------------------
  // writeStorage: error codes and issue bookkeeping
  // ------------------------------------------------------------------
  {
    const storage = installStorage(new MemoryLocalStorage());
    storage.failAllWrites = true;

    const quotaResult = writeStorage(STORAGE_KEYS.sessions, [{ id: "s1" }]);
    assert.equal(quotaResult.ok, false);
    assert.equal(quotaResult.code, "quota", "quota failures are recognisable by code");

    let issues = getStorageIssues();
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, "quota");
    assert.equal(issues[0].key, STORAGE_KEYS.sessions);
    assert.ok(issues[0].at, "issue carries a timestamp");

    storage.failureName = "SecurityError";
    const writeResult = writeStorage(STORAGE_KEYS.sessions, [{ id: "s1" }]);
    assert.equal(writeResult.code, "write");
    issues = getStorageIssues();
    assert.equal(issues.length, 1, "quota issue replaced by write-failed issue for the same key");
    assert.equal(issues[0].kind, "write-failed");

    storage.failAllWrites = false;
    assert.equal(writeStorage(STORAGE_KEYS.sessions, [{ id: "s1" }]).ok, true);
    assert.equal(getStorageIssues().length, 0, "a successful write clears write issues for that key");

    const circular = {};
    circular.self = circular;
    const serializeResult = writeStorage(STORAGE_KEYS.sessions, circular);
    assert.equal(serializeResult.ok, false);
    assert.equal(serializeResult.code, "serialize");
    clearStorageIssue(STORAGE_KEYS.sessions);
    assert.equal(getStorageIssues().length, 0);
  }

  // ------------------------------------------------------------------
  // writeStorageBatch: all-or-nothing
  // ------------------------------------------------------------------
  {
    const storage = installStorage(new MemoryLocalStorage());
    storage.setItem(STORAGE_KEYS.sessions, JSON.stringify([{ id: "old" }]));
    storage.setItem(STORAGE_KEYS.nextPlans, JSON.stringify({ old: true }));
    storage.writes = [];

    const okResult = writeStorageBatch([
      { key: STORAGE_KEYS.sessions, value: [{ id: "new" }] },
      { key: STORAGE_KEYS.nextPlans, value: { fresh: true } },
      { key: STORAGE_KEYS.workoutDrafts, value: { draft: 1 } },
    ]);
    assert.equal(okResult.ok, true);
    assert.deepEqual(okResult.writtenKeys, [
      STORAGE_KEYS.sessions,
      STORAGE_KEYS.nextPlans,
      STORAGE_KEYS.workoutDrafts,
    ]);
    assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.workoutDrafts)), { draft: 1 });

    // Failure on the third key rolls the first two back, including a key that
    // did not exist before the batch (removed again, not left behind).
    storage.failNextWriteForKey = STORAGE_KEYS.programStates;
    const failed = writeStorageBatch([
      { key: STORAGE_KEYS.sessions, value: [{ id: "third-attempt" }] },
      { key: STORAGE_KEYS.programProgressions, value: [{ id: "p1" }] },
      { key: STORAGE_KEYS.programStates, value: [{ programId: "x" }] },
    ]);
    assert.equal(failed.ok, false);
    assert.equal(failed.failedKey, STORAGE_KEYS.programStates);
    assert.equal(failed.code, "quota");
    assert.equal(failed.rolledBack, true);
    assert.match(failed.error, /Browser storage is full/);
    assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.sessions)), [{ id: "new" }]);
    assert.equal(storage.getItem(STORAGE_KEYS.programProgressions), null, "new key rolled back");
    assert.equal(storage.getItem(STORAGE_KEYS.programStates), null);

    const issue = getStorageIssues().find((entry) => entry.key === STORAGE_KEYS.programStates);
    assert.ok(issue, "batch failure is recorded as an issue");
    assert.equal(issue.kind, "quota");

    // All writes failing: nothing changes.
    storage.failAllWrites = true;
    const allFailed = writeStorageBatch([
      { key: STORAGE_KEYS.sessions, value: [] },
      { key: STORAGE_KEYS.nextPlans, value: {} },
    ]);
    assert.equal(allFailed.ok, false);
    assert.equal(allFailed.failedKey, STORAGE_KEYS.sessions);
    assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.sessions)), [{ id: "new" }]);
    assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.nextPlans)), { fresh: true });
    storage.failAllWrites = false;

    // Serialization failure: nothing is written at all, even for earlier entries.
    storage.writes = [];
    const circular = {};
    circular.self = circular;
    const serializeFailed = writeStorageBatch([
      { key: STORAGE_KEYS.sessions, value: [{ id: "should-not-land" }] },
      { key: STORAGE_KEYS.nextPlans, value: circular },
    ]);
    assert.equal(serializeFailed.ok, false);
    assert.equal(serializeFailed.code, "serialize");
    assert.equal(serializeFailed.failedKey, STORAGE_KEYS.nextPlans);
    assert.deepEqual(storage.writes, [], "no key touched when serialization fails");
    assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.sessions)), [{ id: "new" }]);

    // Empty / malformed input.
    assert.equal(writeStorageBatch([]).ok, true);
    assert.equal(writeStorageBatch([{ value: 1 }]).ok, false);

    // Successful batch clears earlier write issues for its keys.
    const cleared = writeStorageBatch([{ key: STORAGE_KEYS.programStates, value: [] }]);
    assert.equal(cleared.ok, true);
    assert.equal(
      getStorageIssues().some((entry) => entry.key === STORAGE_KEYS.programStates),
      false,
    );
  }

  // ------------------------------------------------------------------
  // Corrupt reads (decision new-G)
  // ------------------------------------------------------------------
  {
    const storage = installStorage(new MemoryLocalStorage());
    const corruptRaw = '[{"id":"s1"';
    storage.setItem(STORAGE_KEYS.sessions, corruptRaw);
    storage.writes = [];
    clearStorageIssue(STORAGE_KEYS.sessions);
    assert.equal(getStorageIssues().some((entry) => entry.key === STORAGE_KEYS.sessions), false);

    const notifications = [];
    const unsubscribe = subscribeStorageIssues((issues) => notifications.push(issues));

    const value = readStorage(STORAGE_KEYS.sessions, []);
    assert.deepEqual(value, [], "fallback returned");
    assert.equal(storage.getItem(STORAGE_KEYS.sessions), corruptRaw, "corrupt value not overwritten");
    assert.equal(
      storage.getItem(`${STORAGE_KEYS.sessions}.corrupt-1`),
      corruptRaw,
      "raw value copied to .corrupt-1",
    );
    assert.deepEqual(storage.writes, [`${STORAGE_KEYS.sessions}.corrupt-1`], "only the copy was written");

    const issues = getStorageIssues();
    const corruptIssue = issues.find(
      (entry) => entry.key === STORAGE_KEYS.sessions && entry.kind === "read-corrupt",
    );
    assert.ok(corruptIssue, "read-corrupt issue recorded");
    assert.equal(issues.filter((entry) => entry.key === STORAGE_KEYS.sessions).length, 1);
    assert.equal(corruptIssue.corruptCopyKey, `${STORAGE_KEYS.sessions}.corrupt-1`);
    assert.match(corruptIssue.message, /corrupt-1/);
    assert.ok(notifications.length >= 1, "subscriber notified");

    // Re-reading the same corrupt value does not consume another slot.
    readStorage(STORAGE_KEYS.sessions, []);
    readStorage(STORAGE_KEYS.sessions, []);
    assert.equal(storage.getItem(`${STORAGE_KEYS.sessions}.corrupt-2`), null);

    // A different corrupt value gets the next free slot; at most 3 copies.
    storage.setItem(STORAGE_KEYS.sessions, "{bad-2");
    readStorage(STORAGE_KEYS.sessions, []);
    assert.equal(storage.getItem(`${STORAGE_KEYS.sessions}.corrupt-2`), "{bad-2");
    storage.setItem(STORAGE_KEYS.sessions, "{bad-3");
    readStorage(STORAGE_KEYS.sessions, []);
    assert.equal(storage.getItem(`${STORAGE_KEYS.sessions}.corrupt-3`), "{bad-3");
    storage.setItem(STORAGE_KEYS.sessions, "{bad-4");
    const fourth = readStorageResult(STORAGE_KEYS.sessions, []);
    assert.equal(fourth.ok, false);
    assert.equal(fourth.corrupt, true);
    assert.equal(fourth.corruptCopyKey, null, "no fourth copy");
    assert.equal(MAX_CORRUPT_COPIES_PER_KEY, 3);
    assert.equal(storage.getItem(`${STORAGE_KEYS.sessions}.corrupt-4`), null);
    assert.equal(storage.getItem(`${STORAGE_KEYS.sessions}.corrupt-1`), corruptRaw, "first copy kept");
    assert.equal(
      getStorageIssues().filter((entry) => entry.key === STORAGE_KEYS.sessions).length,
      1,
      "one live read-corrupt issue per key",
    );

    // Healthy read shape.
    storage.setItem(STORAGE_KEYS.nextPlans, JSON.stringify({ day: 1 }));
    const healthy = readStorageResult(STORAGE_KEYS.nextPlans, {});
    assert.deepEqual(healthy, {
      value: { day: 1 },
      ok: true,
      error: null,
      code: null,
      corrupt: false,
      corruptCopyKey: null,
    });
    const missing = readStorageResult(STORAGE_KEYS.workoutDrafts, { fallback: true });
    assert.equal(missing.ok, true);
    assert.deepEqual(missing.value, { fallback: true });

    // clearStorageIssue(key) removes the issue and notifies; unsubscribe stops notifications.
    const beforeClear = notifications.length;
    clearStorageIssue(STORAGE_KEYS.sessions);
    assert.equal(getStorageIssues().some((entry) => entry.key === STORAGE_KEYS.sessions), false);
    assert.ok(notifications.length > beforeClear);
    unsubscribe();
    const afterUnsubscribe = notifications.length;
    storage.setItem(STORAGE_KEYS.readinessByDate, "{corrupt");
    readStorage(STORAGE_KEYS.readinessByDate, {});
    assert.equal(notifications.length, afterUnsubscribe, "unsubscribed callback not called");

    // Subscribers that throw do not break the read.
    const throwingUnsubscribe = subscribeStorageIssues(() => {
      throw new Error("boom");
    });
    storage.setItem(STORAGE_KEYS.setupCues, "{corrupt");
    assert.doesNotThrow(() => readStorage(STORAGE_KEYS.setupCues, {}));
    throwingUnsubscribe();
    assert.equal(subscribeStorageIssues(null)(), undefined);
  }

  console.warn = originalWarn;
  console.log("Storage H1 batch/corrupt/issue verification passed.");
} catch (error) {
  console.warn = originalWarn;
  throw error;
}
