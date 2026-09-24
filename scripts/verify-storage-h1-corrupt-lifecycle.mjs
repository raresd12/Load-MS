// Fixer round 1 (decision new-G): the lifecycle of a corrupt key.
// - Re-reading the same corrupt key does not re-notify subscribers (a read
//   during a React render must not schedule another render).
// - Writing `undefined` is a serialize failure, never the string "undefined".
// - A backup carries a corrupt key's raw text and restore writes it back raw.
// - Reset removes the `.corrupt-<n>` copies and the in-memory issues.
import assert from "node:assert/strict";

class MemoryLocalStorage {
  constructor() {
    this.store = new Map();
    this.writes = [];
  }

  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  setItem(key, value) {
    this.writes.push(key);
    this.store.set(key, String(value));
  }

  removeItem(key) {
    this.store.delete(key);
  }

  keys() {
    return [...this.store.keys()];
  }
}

function installStorage() {
  const storage = new MemoryLocalStorage();
  globalThis.window = { localStorage: storage };
  return storage;
}

const originalWarn = console.warn;
console.warn = () => {};

const {
  clearStorageIssue,
  createLocalBackup,
  getStorageIssues,
  readStorage,
  readStorageResult,
  resetLocalAppData,
  restoreLocalBackup,
  STORAGE_KEYS,
  subscribeStorageIssues,
  writeStorage,
  writeStorageBatch,
} = await import("../src/lib/storage.js");

function resetIssues() {
  getStorageIssues().forEach((issue) => clearStorageIssue(issue.key));
}

try {
  // ------------------------------------------------------------------
  // Identical corrupt reads: one notification, stable issue identity.
  // ------------------------------------------------------------------
  {
    const storage = installStorage();
    resetIssues();
    storage.setItem(STORAGE_KEYS.programDays, "{oops");

    const notifications = [];
    const unsubscribe = subscribeStorageIssues((issues) => notifications.push(issues));

    readStorage(STORAGE_KEYS.programDays, []);
    assert.equal(notifications.length, 1, "first corrupt read notifies");
    const firstIssue = getStorageIssues().find((issue) => issue.key === STORAGE_KEYS.programDays);
    assert.ok(firstIssue);

    // The render-loop scenario: the same key is read again and again
    // (ProgramCard / WorkoutExerciseCard render). Nothing new is notified.
    for (let index = 0; index < 50; index += 1) {
      readStorage(STORAGE_KEYS.programDays, []);
    }
    assert.equal(notifications.length, 1, "identical corrupt reads do not re-notify");
    const sameIssue = getStorageIssues().find((issue) => issue.key === STORAGE_KEYS.programDays);
    assert.equal(sameIssue.at, firstIssue.at, "issue timestamp (banner id) stays stable");
    assert.equal(sameIssue.corruptCopyKey, `${STORAGE_KEYS.programDays}.corrupt-1`);
    assert.equal(
      storage.writes.filter((key) => key.startsWith(`${STORAGE_KEYS.programDays}.corrupt-`)).length,
      1,
      "the copy is written once",
    );

    // A genuinely different issue for the same key (new corrupt value -> new
    // copy key) is a new notification.
    storage.setItem(STORAGE_KEYS.programDays, "{oops-2");
    readStorage(STORAGE_KEYS.programDays, []);
    assert.equal(notifications.length, 2, "a different corrupt value notifies again");
    assert.equal(
      getStorageIssues().find((issue) => issue.key === STORAGE_KEYS.programDays).corruptCopyKey,
      `${STORAGE_KEYS.programDays}.corrupt-2`,
    );

    // Subscriber that re-reads the corrupt key inside the callback (the
    // App state update -> render -> read chain, collapsed): must terminate.
    let reentrantCalls = 0;
    const reentrantUnsubscribe = subscribeStorageIssues(() => {
      reentrantCalls += 1;
      if (reentrantCalls < 1000) {
        readStorage(STORAGE_KEYS.programDays, []);
      }
    });
    storage.setItem(STORAGE_KEYS.programDays, "{oops-3");
    readStorage(STORAGE_KEYS.programDays, []);
    assert.equal(reentrantCalls, 1, "re-entrant identical read does not cascade");
    reentrantUnsubscribe();

    // Write failures still refresh (different message -> notify).
    unsubscribe();
    resetIssues();
  }

  // ------------------------------------------------------------------
  // undefined is not storable.
  // ------------------------------------------------------------------
  {
    const storage = installStorage();
    resetIssues();

    const single = writeStorage(STORAGE_KEYS.nextPlans, undefined);
    assert.equal(single.ok, false);
    assert.equal(single.code, "serialize");
    assert.equal(storage.getItem(STORAGE_KEYS.nextPlans), null, "nothing stored");

    const batch = writeStorageBatch([
      { key: STORAGE_KEYS.sessions, value: [] },
      { key: STORAGE_KEYS.workoutDrafts, value: undefined },
    ]);
    assert.equal(batch.ok, false);
    assert.equal(batch.code, "serialize");
    assert.equal(batch.failedKey, STORAGE_KEYS.workoutDrafts);
    assert.equal(storage.getItem(STORAGE_KEYS.sessions), null, "batch wrote nothing");
    assert.equal(writeStorage(STORAGE_KEYS.setupCues, () => {}).ok, false, "functions are not storable");

    const read = readStorageResult(STORAGE_KEYS.nextPlans, {});
    assert.equal(read.ok, true);
    assert.equal(read.corrupt, false, "no fake corruption after a rejected write");
    assert.equal(storage.getItem(`${STORAGE_KEYS.nextPlans}.corrupt-1`), null);
    assert.ok(
      !getStorageIssues().some((issue) => issue.kind === "read-corrupt"),
      "no read-corrupt issue recorded",
    );
    assert.equal(writeStorage(STORAGE_KEYS.nextPlans, null).ok, true, "null is storable");
    assert.equal(readStorage(STORAGE_KEYS.nextPlans, "fb"), null);
    resetIssues();
  }

  // ------------------------------------------------------------------
  // Backup + restore of a corrupt key keeps it corrupt (and flagged).
  // ------------------------------------------------------------------
  {
    const storage = installStorage();
    resetIssues();
    storage.setItem(STORAGE_KEYS.setupCues, "{corrupt");
    storage.setItem(STORAGE_KEYS.sessions, JSON.stringify([{ id: "s1" }]));
    storage.setItem(STORAGE_KEYS.activeProgramId, JSON.stringify("program-1"));
    readStorage(STORAGE_KEYS.setupCues, {});
    assert.equal(storage.getItem(`${STORAGE_KEYS.setupCues}.corrupt-1`), "{corrupt");

    const backup = createLocalBackup();
    assert.equal(backup.data[STORAGE_KEYS.setupCues], "{corrupt", "raw text carried");
    assert.deepEqual(backup.corruptKeys, [STORAGE_KEYS.setupCues]);
    assert.deepEqual(backup.data[STORAGE_KEYS.sessions], [{ id: "s1" }]);
    assert.equal(backup.data[STORAGE_KEYS.activeProgramId], "program-1");
    assert.ok(
      !Object.keys(backup.data).some((key) => key.includes(".corrupt-")),
      "corrupt copies are not tracked keys",
    );

    // Restore into a fresh origin.
    const restoredStorage = installStorage();
    resetIssues();
    const restore = restoreLocalBackup(JSON.parse(JSON.stringify(backup)));
    assert.equal(restore.valid, true);
    assert.equal(
      restoredStorage.getItem(STORAGE_KEYS.setupCues),
      "{corrupt",
      "corrupt raw text restored verbatim, not as a JSON string",
    );
    assert.equal(
      restoredStorage.getItem(STORAGE_KEYS.activeProgramId),
      JSON.stringify("program-1"),
      "healthy string values are still JSON-encoded",
    );
    const reread = readStorageResult(STORAGE_KEYS.setupCues, {});
    assert.equal(reread.corrupt, true, "the restored key is flagged again");
    assert.deepEqual(reread.value, {});
    assert.equal(restoredStorage.getItem(`${STORAGE_KEYS.setupCues}.corrupt-1`), "{corrupt");
    assert.ok(getStorageIssues().some((issue) => issue.key === STORAGE_KEYS.setupCues));

    // Backups without corruptKeys (older exports) restore as before.
    const legacyStorage = installStorage();
    resetIssues();
    const { corruptKeys, ...legacyBackup } = backup;
    assert.equal(restoreLocalBackup(JSON.parse(JSON.stringify(legacyBackup))).valid, true);
    assert.equal(legacyStorage.getItem(STORAGE_KEYS.setupCues), JSON.stringify("{corrupt"));
    resetIssues();
  }

  // ------------------------------------------------------------------
  // Reset removes the corrupt copies and clears the issues.
  // ------------------------------------------------------------------
  {
    const storage = installStorage();
    resetIssues();
    storage.setItem(STORAGE_KEYS.setupCues, "undefined");
    storage.setItem(STORAGE_KEYS.sessions, "{bad");
    storage.setItem("rpe-tracker.gemini-api-key.v1", "secret-key");
    readStorage(STORAGE_KEYS.setupCues, {});
    readStorage(STORAGE_KEYS.sessions, []);
    storage.setItem(STORAGE_KEYS.sessions, "{bad-2");
    readStorage(STORAGE_KEYS.sessions, []);
    assert.equal(storage.getItem(`${STORAGE_KEYS.sessions}.corrupt-2`), "{bad-2");
    assert.equal(getStorageIssues().length, 2);

    const notifications = [];
    const unsubscribe = subscribeStorageIssues((issues) => notifications.push(issues));
    const reset = resetLocalAppData();
    assert.equal(reset.ok, true);
    assert.deepEqual(
      storage.keys(),
      ["rpe-tracker.gemini-api-key.v1"],
      "tracked keys and their corrupt copies are gone; untracked keys stay",
    );
    assert.equal(getStorageIssues().length, 0, "issues of the reset keys cleared");
    assert.equal(notifications.length, 1, "subscribers told once");
    assert.deepEqual(notifications[0], []);
    unsubscribe();

    // A reset with nothing corrupt does not notify.
    const quiet = [];
    const quietUnsubscribe = subscribeStorageIssues((issues) => quiet.push(issues));
    assert.equal(resetLocalAppData().ok, true);
    assert.equal(quiet.length, 0);
    quietUnsubscribe();
  }

  console.warn = originalWarn;
  console.log("Storage H1 corrupt-lifecycle verification passed.");
} catch (error) {
  console.warn = originalWarn;
  throw error;
}
