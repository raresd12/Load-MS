import assert from "node:assert/strict";

import {
  BACKUP_APP_ID,
  restoreLocalBackup,
  STORAGE_KEYS,
  validateLocalBackup,
  writeStorage,
} from "../src/lib/storage.js";

class MemoryLocalStorage {
  constructor() {
    this.store = new Map();
    this.failAllWrites = false;
    this.failNextWriteForKey = null;
  }

  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  setItem(key, value) {
    if (this.failAllWrites || this.failNextWriteForKey === key) {
      this.failNextWriteForKey = null;
      throw new DOMException("Simulated write failure", "QuotaExceededError");
    }

    this.store.set(key, String(value));
  }

  removeItem(key) {
    this.store.delete(key);
  }
}

function installStorage(localStorage) {
  globalThis.window = { localStorage };
}

function createBackup(data) {
  return {
    app: BACKUP_APP_ID,
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    storageKeys: Object.keys(data),
    data,
  };
}

const capturedWarnings = [];
const originalWarn = console.warn;
console.warn = (...args) => {
  capturedWarnings.push(args);
};

try {
  const failingStorage = new MemoryLocalStorage();
  failingStorage.failAllWrites = true;
  installStorage(failingStorage);

  assert.doesNotThrow(() => writeStorage(STORAGE_KEYS.sessions, [{ id: "session-1" }]));
  const failedWrite = writeStorage(STORAGE_KEYS.sessions, [{ id: "session-1" }]);
  assert.equal(failedWrite.ok, false);
  assert.match(failedWrite.error, /Browser storage is full|Could not save/);

  const invalidStorage = new MemoryLocalStorage();
  installStorage(invalidStorage);
  invalidStorage.setItem(STORAGE_KEYS.sessions, JSON.stringify([{ id: "existing" }]));

  const invalidRestore = restoreLocalBackup({ app: "not-this-app", data: {} });
  assert.equal(invalidRestore.valid, false);
  assert.deepEqual(JSON.parse(invalidStorage.getItem(STORAGE_KEYS.sessions)), [{ id: "existing" }]);
  assert.equal(validateLocalBackup({ app: "not-this-app", data: {} }).valid, false);

  const validStorage = new MemoryLocalStorage();
  installStorage(validStorage);

  const validRestore = restoreLocalBackup(
    createBackup({
      [STORAGE_KEYS.sessions]: [{ id: "restored-session" }],
      [STORAGE_KEYS.readinessByDate]: { "2026-06-10": { status: "green" } },
    }),
  );

  assert.equal(validRestore.valid, true);
  assert.deepEqual(JSON.parse(validStorage.getItem(STORAGE_KEYS.sessions)), [
    { id: "restored-session" },
  ]);
  assert.deepEqual(JSON.parse(validStorage.getItem(STORAGE_KEYS.readinessByDate)), {
    "2026-06-10": { status: "green" },
  });

  const rollbackStorage = new MemoryLocalStorage();
  installStorage(rollbackStorage);
  rollbackStorage.setItem(STORAGE_KEYS.sessions, JSON.stringify([{ id: "old-session" }]));
  rollbackStorage.setItem(STORAGE_KEYS.readinessByDate, JSON.stringify({ old: true }));
  rollbackStorage.failNextWriteForKey = STORAGE_KEYS.readinessByDate;

  const failedRestore = restoreLocalBackup(
    createBackup({
      [STORAGE_KEYS.sessions]: [{ id: "new-session" }],
      [STORAGE_KEYS.readinessByDate]: { new: true },
    }),
  );

  assert.equal(failedRestore.valid, false);
  assert.equal(failedRestore.rolledBack, true);
  assert.deepEqual(JSON.parse(rollbackStorage.getItem(STORAGE_KEYS.sessions)), [
    { id: "old-session" },
  ]);
  assert.deepEqual(JSON.parse(rollbackStorage.getItem(STORAGE_KEYS.readinessByDate)), {
    old: true,
  });

  console.warn = originalWarn;
  console.log("Storage safety verification passed.");
} catch (error) {
  console.warn = originalWarn;
  throw error;
}
