// H1 follow-up (a), decision H2-19: the Readiness page reports "saved" only
// after the checked storage write succeeded. The decision is a pure helper
// (src/lib/readinessSave.js) so both branches run here through the real
// writeStorage: a refused write (quota, corrupt key) yields an error message
// and the UNCHANGED readiness map (the form keeps the user's values), a
// successful one yields the saved message and the new map, and savedAt of an
// existing entry for the day is kept while updatedAt moves.
import assert from "node:assert/strict";

class MemoryLocalStorage {
  constructor() {
    this.store = new Map();
    this.failOn = null;
  }

  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  setItem(key, value) {
    if (this.failOn && this.failOn(key)) {
      throw new Error("QuotaExceededError (simulated)");
    }

    this.store.set(key, String(value));
  }

  removeItem(key) {
    this.store.delete(key);
  }
}

const storage = new MemoryLocalStorage();
globalThis.window = { localStorage: storage };
console.warn = () => {};

const { STORAGE_KEYS, readStorage, writeStorage } = await import("../src/lib/storage.js");
const { buildReadinessCheckIn, READINESS_SAVED_MESSAGE, saveReadinessCheckIn } = await import("../src/lib/readinessSave.js");
const { interpretWellness } = await import("../src/lib/progression.js");

const KEY = STORAGE_KEYS.readinessByDate;
const write = (value) => writeStorage(KEY, value);
const wellness = { sleep: 4, energy: 4, soreness: 2, stress: 2, motivation: 5 };
const readiness = interpretWellness(wellness);
const existing = {
  "2026-09-25": {
    schemaVersion: 1,
    date: "2026-09-25",
    savedAt: "2026-09-25T06:00:00.000Z",
    updatedAt: "2026-09-25T06:00:00.000Z",
    wellness,
    readiness,
  },
};

try {
  storage.setItem(KEY, JSON.stringify(existing));

  // ------------------------------------------------------------------
  // Success: written, then reported
  // ------------------------------------------------------------------
  const saved = saveReadinessCheckIn({
    readinessByDate: existing,
    dateKey: "2026-09-26",
    wellness,
    readiness,
    now: "2026-09-26T06:30:00.000Z",
    write,
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.message, READINESS_SAVED_MESSAGE);
  assert.equal(saved.message, "Today's readiness saved.");
  assert.equal(saved.error, null);
  assert.deepEqual(Object.keys(saved.readinessByDate).sort(), ["2026-09-25", "2026-09-26"], "the other day is kept");
  assert.deepEqual(saved.readinessByDate["2026-09-26"], {
    schemaVersion: 1,
    date: "2026-09-26",
    savedAt: "2026-09-26T06:30:00.000Z",
    updatedAt: "2026-09-26T06:30:00.000Z",
    wellness,
    readiness,
  });
  assert.deepEqual(readStorage(KEY, null), saved.readinessByDate, "the reported map is the stored map");
  assert.notEqual(saved.readinessByDate, existing, "the input map is not mutated");
  assert.equal(existing["2026-09-26"], undefined);

  // Re-saving the same day keeps savedAt and moves updatedAt.
  const resaved = saveReadinessCheckIn({
    readinessByDate: saved.readinessByDate,
    dateKey: "2026-09-26",
    wellness: { ...wellness, sleep: 2 },
    readiness: interpretWellness({ ...wellness, sleep: 2 }),
    now: "2026-09-26T09:00:00.000Z",
    write,
  });
  assert.equal(resaved.ok, true);
  assert.equal(resaved.readinessByDate["2026-09-26"].savedAt, "2026-09-26T06:30:00.000Z", "first save time kept");
  assert.equal(resaved.readinessByDate["2026-09-26"].updatedAt, "2026-09-26T09:00:00.000Z");
  assert.equal(resaved.readinessByDate["2026-09-26"].wellness.sleep, 2);
  assert.equal(readStorage(KEY, null)["2026-09-26"].wellness.sleep, 2);
  assert.deepEqual(
    buildReadinessCheckIn({ readinessByDate: null, dateKey: "2026-09-27", wellness, readiness, now: "t" })["2026-09-27"].savedAt,
    "t",
    "a missing map builds a fresh entry",
  );

  // ------------------------------------------------------------------
  // Failure 1: the write throws (quota) -> error message, map unchanged,
  // storage unchanged, nothing reported as saved
  // ------------------------------------------------------------------
  const before = storage.getItem(KEY);
  const beforeMap = resaved.readinessByDate;
  storage.failOn = (key) => key === KEY;
  const refused = saveReadinessCheckIn({
    readinessByDate: beforeMap,
    dateKey: "2026-09-27",
    wellness,
    readiness,
    now: "2026-09-27T06:00:00.000Z",
    write,
  });
  storage.failOn = null;
  assert.equal(refused.ok, false);
  assert.equal(refused.readinessByDate, beforeMap, "the map handed back is the input map, untouched");
  assert.equal(refused.readinessByDate["2026-09-27"], undefined, "the failed entry is not in the map");
  assert.match(refused.message, /^Today's readiness could not be saved: /);
  assert.match(refused.message, /Your check-in is still in the form\.$/);
  assert.ok(refused.error, "the storage error is carried");
  assert.ok(refused.message.includes(refused.error), "the storage error is shown");
  assert.notEqual(refused.message, READINESS_SAVED_MESSAGE);
  assert.equal(storage.getItem(KEY), before, "storage untouched");

  // ------------------------------------------------------------------
  // Failure 2: unreadable key (new-U) -> refused, never overwritten
  // ------------------------------------------------------------------
  storage.setItem(KEY, "{broken");
  const corrupt = saveReadinessCheckIn({
    readinessByDate: beforeMap,
    dateKey: "2026-09-27",
    wellness,
    readiness,
    now: "2026-09-27T06:00:00.000Z",
    write,
  });
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.readinessByDate, beforeMap);
  assert.match(corrupt.message, /could not be saved/);
  assert.equal(storage.getItem(KEY), "{broken", "the unreadable value is never overwritten");
  storage.setItem(KEY, before);
  storage.removeItem(`${KEY}.corrupt-1`);

  // ------------------------------------------------------------------
  // Failure 3: a writer that returns no ok / throws is not a success either
  // ------------------------------------------------------------------
  const noResult = saveReadinessCheckIn({ readinessByDate: beforeMap, dateKey: "d", wellness, readiness, now: "t", write: () => undefined });
  assert.equal(noResult.ok, false);
  assert.equal(noResult.readinessByDate, beforeMap);
  const threw = saveReadinessCheckIn({
    readinessByDate: beforeMap,
    dateKey: "d",
    wellness,
    readiness,
    now: "t",
    write: () => {
      throw new Error("boom");
    },
  });
  assert.equal(threw.ok, false);
  assert.ok(threw.message.includes("boom"));
  const noWriter = saveReadinessCheckIn({ readinessByDate: beforeMap, dateKey: "d", wellness, readiness, now: "t" });
  assert.equal(noWriter.ok, false);
  assert.deepEqual(saveReadinessCheckIn({ readinessByDate: null, dateKey: "d", wellness, readiness, now: "t", write: () => ({ ok: false, error: "x" }) }).readinessByDate, {});

  console.log("verify-readiness-save: ok");
} catch (error) {
  console.error("verify-readiness-save: FAIL");
  console.error(error);
  process.exit(1);
}
