import assert from "node:assert/strict";

// Phase H4 / Track B, decision H4-4: secrets (the Gemini key) go through
// storage.js readSecret / writeSecret / clearSecret but never leave the
// device: not tracked, not in a backup, untouched by restore, no write
// notification, no storage issue. The Settings reset keeps today's behaviour:
// resetLocalAppData leaves the key and App calls clearGeminiApiKey after it.

class MemoryLocalStorage {
  constructor() {
    this.store = new Map();
    this.failNextWriteForKey = null;
    this.failReads = false;
  }

  getItem(key) {
    if (this.failReads) {
      throw new Error("Simulated read failure");
    }

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
const capturedWarnings = [];
console.warn = (...args) => {
  capturedWarnings.push(args);
};

const {
  clearSecret,
  createLocalBackup,
  getSecretStorageKeys,
  getStorageIssues,
  getTrackedStorageKeys,
  isSecretStorageKey,
  readSecret,
  resetLocalAppData,
  restoreLocalBackup,
  SECRET_STORAGE_KEYS,
  STORAGE_ERROR_CODES,
  STORAGE_KEYS,
  subscribeStorageWrites,
  writeSecret,
  writeStorage,
  BACKUP_APP_ID,
} = await import("../src/lib/storage.js");
const { clearGeminiApiKey, GEMINI_API_KEY_STORAGE_KEY, getGeminiApiKey, setGeminiApiKey } =
  await import("../src/lib/aiProgram.js");

const KEY = SECRET_STORAGE_KEYS.geminiApiKey;
const SECRET = "AIzaSy-H4-SECRET-VALUE-4242";

try {
  // Registry.
  assert.equal(KEY, "rpe-tracker.gemini-api-key.v1");
  assert.equal(GEMINI_API_KEY_STORAGE_KEY, KEY, "aiProgram keeps the same key name");
  assert.deepEqual(getSecretStorageKeys(), [KEY]);
  assert.ok(Object.isFrozen(SECRET_STORAGE_KEYS));
  assert.ok(isSecretStorageKey(KEY));
  assert.ok(!isSecretStorageKey(STORAGE_KEYS.sessions));
  assert.ok(!getTrackedStorageKeys().includes(KEY), "a secret is never a tracked key");

  const events = [];
  const unsubscribe = subscribeStorageWrites((event) => events.push(event));

  // Round trip as raw text (a key saved before H4 is raw text too).
  assert.equal(readSecret(KEY), "", "absent reads as empty");
  assert.deepEqual(writeSecret(KEY, SECRET), { ok: true });
  assert.equal(storage.getItem(KEY), SECRET, "stored as raw text, not JSON");
  assert.equal(readSecret(KEY), SECRET);
  storage.setItem(KEY, "legacy-raw-key");
  assert.equal(readSecret(KEY), "legacy-raw-key", "a pre-H4 raw value stays readable");
  assert.deepEqual(writeSecret(KEY, 12345), { ok: true });
  assert.equal(readSecret(KEY), "12345", "non-string values are stored as text");
  assert.deepEqual(writeSecret(KEY, SECRET), { ok: true });
  assert.equal(events.length, 0, "a secret write emits no write notification");
  assert.deepEqual(getStorageIssues(), [], "a secret write records no issue");

  // Only registered secret keys.
  const foreign = writeSecret(STORAGE_KEYS.sessions, "x");
  assert.equal(foreign.ok, false);
  assert.equal(foreign.code, STORAGE_ERROR_CODES.write);
  assert.equal(storage.getItem(STORAGE_KEYS.sessions), null, "a tracked key cannot be written as a secret");
  assert.equal(readSecret(STORAGE_KEYS.sessions), "", "a tracked key cannot be read as a secret");
  assert.equal(readSecret("rpe-tracker.other"), "");
  assert.equal(events.length, 0);

  // Quota / write failure: same codes and message as writeStorage, no issue,
  // no notification, value untouched.
  storage.failNextWriteForKey = KEY;
  const quota = writeSecret(KEY, "new-value");
  assert.equal(quota.ok, false);
  assert.equal(quota.code, STORAGE_ERROR_CODES.quota);
  assert.match(quota.error, /Browser storage is full/);
  assert.equal(readSecret(KEY), SECRET, "failed write keeps the previous secret");
  assert.deepEqual(getStorageIssues(), [], "no storage issue for a secret");
  assert.equal(events.length, 0);

  // Read failure never throws.
  storage.failReads = true;
  assert.equal(readSecret(KEY), "");
  storage.failReads = false;
  assert.ok(
    capturedWarnings.every((args) => !args.some((arg) => String(arg).includes(SECRET))),
    "warnings never contain the secret value",
  );

  // Backups: neither the key name nor the value.
  writeStorage(STORAGE_KEYS.sessions, [{ id: "s1" }]);
  assert.equal(events.length, 1, "a tracked write still notifies");
  const backup = createLocalBackup();
  const backupJson = JSON.stringify(backup);
  assert.ok(!backupJson.includes(SECRET), "backup never carries the secret value");
  assert.ok(!backupJson.includes(KEY), "backup never lists the secret key");
  assert.ok(!(KEY in backup.data));

  // Restore leaves the secret untouched, even when the backup smuggles one.
  const restored = restoreLocalBackup({
    app: BACKUP_APP_ID,
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    storageKeys: [STORAGE_KEYS.sessions, KEY],
    data: { [STORAGE_KEYS.sessions]: [{ id: "restored" }], [KEY]: "smuggled-key" },
  });
  assert.equal(restored.valid, true);
  assert.deepEqual(restored.ignoredKeys, [KEY], "a secret inside a backup is ignored");
  assert.equal(readSecret(KEY), SECRET, "restore does not touch the secret");
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.sessions)), [{ id: "restored" }]);
  // Decision H4-12: the restore notifies, and names tracked keys only.
  assert.equal(events.length, 2, "the restore is one write event");
  assert.deepEqual([...events[1].keys], [STORAGE_KEYS.sessions], "the smuggled secret is not named");
  assert.equal(events[1].reason, "restore");

  // Reset: resetLocalAppData leaves the secret (unchanged pre-H4 behaviour);
  // the Settings reset then calls clearGeminiApiKey explicitly.
  assert.deepEqual(resetLocalAppData(), { ok: true });
  assert.deepEqual(storage.keys(), [KEY], "reset removes tracked keys only");
  assert.equal(events.length, 3, "the reset is one write event");
  assert.deepEqual([...events[2].keys], [STORAGE_KEYS.sessions], "the secret is not named by a reset");
  assert.equal(events[2].reason, "reset");
  assert.equal(readSecret(KEY), SECRET);

  // clearSecret removes the key.
  assert.deepEqual(clearSecret(KEY), { ok: true });
  assert.equal(storage.getItem(KEY), null);
  assert.equal(readSecret(KEY), "");
  assert.deepEqual(writeSecret(KEY, "   "), { ok: true }, "whitespace-only is stored as given by writeSecret");
  assert.equal(readSecret(KEY), "   ");
  assert.deepEqual(writeSecret(KEY, null), { ok: true });
  assert.equal(storage.getItem(KEY), null, "null removes the key");

  // aiProgram accessors go through the secret API.
  assert.equal(getGeminiApiKey(), "");
  assert.deepEqual(setGeminiApiKey("  spaced-key  "), { ok: true });
  assert.equal(storage.getItem(KEY), "spaced-key", "setGeminiApiKey trims and stores raw text");
  assert.equal(getGeminiApiKey(), "spaced-key");
  storage.failNextWriteForKey = KEY;
  const failedSet = setGeminiApiKey("another");
  assert.equal(failedSet.ok, false);
  assert.equal(failedSet.code, STORAGE_ERROR_CODES.quota);
  assert.match(failedSet.error, /Browser storage is full/, "the quota message is kept");
  assert.equal(getGeminiApiKey(), "spaced-key");
  assert.deepEqual(clearGeminiApiKey(), { ok: true });
  assert.equal(getGeminiApiKey(), "");
  assert.equal(storage.getItem(KEY), null);
  // H4 fix round 1: a non-quota failure shown by the AI assistant never names
  // the storage key (writeSecret's own message still does, for the console).
  {
    const originalSetItem = storage.setItem.bind(storage);
    storage.setItem = () => {
      throw new Error("denied");
    };
    const rawFailure = writeSecret(KEY, "raw");
    assert.equal(rawFailure.ok, false);
    assert.equal(rawFailure.code, STORAGE_ERROR_CODES.write);
    const deniedSet = setGeminiApiKey("denied-key");
    assert.deepEqual(deniedSet, {
      ok: false,
      error: "Could not save the API key to local storage.",
      code: STORAGE_ERROR_CODES.write,
    });
    assert.ok(!deniedSet.error.includes("rpe-tracker"), "the storage key name is not shown to the user");
    assert.ok(!deniedSet.error.includes("denied-key"), "the key value is not echoed");
    storage.setItem = originalSetItem;
    assert.equal(getGeminiApiKey(), "");
  }
  assert.deepEqual(setGeminiApiKey("   "), { ok: true });
  assert.equal(storage.getItem(KEY), null, "a blank key removes the stored one");
  assert.equal(events.length, 3, "none of the secret operations notified");
  assert.ok(
    events.every((event) => !event.keys.includes(KEY)),
    "no event ever names the secret key",
  );
  assert.deepEqual(getStorageIssues(), []);

  unsubscribe();

  // Without window: safe results.
  delete globalThis.window;
  assert.equal(readSecret(KEY), "");
  assert.equal(writeSecret(KEY, "x").code, STORAGE_ERROR_CODES.unavailable);
  assert.equal(getGeminiApiKey(), "");
  assert.equal(setGeminiApiKey("x").ok, false);

  console.log("Storage H4 secrets verification passed.");
} finally {
  console.warn = originalWarn;
}
