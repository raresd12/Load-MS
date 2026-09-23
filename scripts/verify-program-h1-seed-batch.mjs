// Fixer round 2: seeding is one checked batch and self-healing.
// - A fresh install whose Nth write fails leaves NOTHING behind (no programs
//   without days), and the next run seeds everything.
// - Storage that already lists a default program but lost its days /
//   sections / exercises (older partial seeds) gets them back on the next run.
// - A healthy second run writes nothing.
import assert from "node:assert/strict";

class MemoryLocalStorage {
  constructor() {
    this.store = new Map();
    this.writes = [];
    this.failWriteNumber = null;
    this.failKey = null;
  }

  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  setItem(key, value) {
    if (this.failKey === key || (this.failWriteNumber !== null && this.writes.length + 1 === this.failWriteNumber)) {
      throw new DOMException(`Simulated write failure for ${key}`, "QuotaExceededError");
    }

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

const originalWarn = console.warn;
console.warn = () => {};

const {
  ATHLETIC_AESTHETIC_BASKETBALL_PROGRAM_ID,
  DEFAULT_PROGRAM_ID,
  getProgramDays,
  getProgramExercises,
  getPrograms,
  seedDefaultProgramIfNeeded,
} = await import("../src/lib/programStorage.js");
const { clearStorageIssue, getStorageIssues, readStorage, STORAGE_KEYS } = await import(
  "../src/lib/storage.js"
);

function install() {
  const storage = new MemoryLocalStorage();
  globalThis.window = { localStorage: storage };
  getStorageIssues().forEach((issue) => clearStorageIssue(issue.key));
  return storage;
}

function countFor(programId) {
  return {
    days: getProgramDays(programId).length,
    exercises: getProgramDays(programId).reduce(
      (total, day) => total + getProgramExercises(day.id).length,
      0,
    ),
  };
}

try {
  // Reference: a healthy fresh install.
  const reference = install();
  const healthy = seedDefaultProgramIfNeeded();
  assert.equal(healthy.seeded, true);
  assert.equal(healthy.activeProgramId, DEFAULT_PROGRAM_ID);
  const expectedDefault = countFor(DEFAULT_PROGRAM_ID);
  const expectedBasketball = countFor(ATHLETIC_AESTHETIC_BASKETBALL_PROGRAM_ID);
  assert.ok(expectedDefault.days > 0 && expectedDefault.exercises > 0);
  assert.ok(expectedBasketball.days > 0 && expectedBasketball.exercises > 0);
  const referenceKeys = reference.keys().sort();
  assert.ok(referenceKeys.includes(STORAGE_KEYS.programStorageMeta));
  assert.ok(referenceKeys.includes(STORAGE_KEYS.activeProgramId));

  // Decision new-L: both default programs share Library exercises, yet the
  // seeded exercise library holds each Library id exactly once.
  const seededLibraryIds = readStorage(STORAGE_KEYS.exerciseLibrary, []).map((exercise) => exercise.id);
  assert.ok(seededLibraryIds.length > 0, "fresh seed writes the exercise library");
  assert.equal(
    new Set(seededLibraryIds).size,
    seededLibraryIds.length,
    "seeded exercise-library ids are unique (new-L)",
  );

  // A healthy second run is a no-op (no write at all, not even meta).
  reference.writes = [];
  const second = seedDefaultProgramIfNeeded();
  assert.equal(second.seeded, false);
  assert.deepEqual(reference.writes, [], "nothing rewritten on a healthy mount");

  // ------------------------------------------------------------------
  // Fresh install, the Nth write fails: nothing is left behind, and the
  // next run seeds everything.
  // ------------------------------------------------------------------
  for (const failAt of [1, 3, 6, 9]) {
    const storage = install();
    storage.failWriteNumber = failAt;
    const failed = seedDefaultProgramIfNeeded();
    assert.equal(failed.seeded, false, `write #${failAt}: not reported as seeded`);
    assert.equal(failed.code, "quota");
    assert.equal(failed.activeProgramId, null);
    assert.deepEqual(
      storage.keys().filter((key) => !key.includes(".corrupt-")),
      [],
      `write #${failAt}: nothing left behind (no programs without days)`,
    );
    assert.deepEqual(getPrograms(), []);

    storage.failWriteNumber = null;
    storage.writes = [];
    const recovered = seedDefaultProgramIfNeeded();
    assert.equal(recovered.seeded, true, `write #${failAt}: the next run seeds`);
    assert.deepEqual(countFor(DEFAULT_PROGRAM_ID), expectedDefault);
    assert.deepEqual(countFor(ATHLETIC_AESTHETIC_BASKETBALL_PROGRAM_ID), expectedBasketball);
    assert.deepEqual(storage.keys().sort(), referenceKeys, `write #${failAt}: same keys as a healthy install`);
  }

  // ------------------------------------------------------------------
  // Older partial state: both programs listed, days / exercises missing.
  // ------------------------------------------------------------------
  {
    const storage = install();
    for (const [key, value] of reference.store) {
      if (
        key !== STORAGE_KEYS.programDays &&
        key !== STORAGE_KEYS.programExercises &&
        key !== STORAGE_KEYS.programSections
      ) {
        storage.store.set(key, value);
      }
    }
    assert.deepEqual(countFor(DEFAULT_PROGRAM_ID), { days: 0, exercises: 0 });
    const progressionsBefore = storage.getItem(STORAGE_KEYS.programProgressions);

    const repaired = seedDefaultProgramIfNeeded();
    assert.equal(repaired.seeded, false);
    assert.equal(repaired.blocked, undefined);
    assert.deepEqual(countFor(DEFAULT_PROGRAM_ID), expectedDefault, "default days/exercises reseeded");
    assert.deepEqual(countFor(ATHLETIC_AESTHETIC_BASKETBALL_PROGRAM_ID), expectedBasketball);
    assert.equal(
      storage.getItem(STORAGE_KEYS.programProgressions),
      progressionsBefore,
      "progressions of an existing program are not touched by the backfill",
    );
    assert.equal(getPrograms().length, 2, "no program duplicated");
  }

  // Only one exercise of a default program missing: it is added back, the
  // user's other records are untouched (add-only by id).
  {
    const storage = install();
    for (const [key, value] of reference.store) {
      storage.store.set(key, value);
    }
    const exercises = readStorage(STORAGE_KEYS.programExercises, []);
    const removed = exercises.find((exercise) => exercise.programId === DEFAULT_PROGRAM_ID);
    const custom = { ...exercises[0], id: "custom-exercise", programId: "custom-program", notes: "mine" };
    storage.store.set(
      STORAGE_KEYS.programExercises,
      JSON.stringify([...exercises.filter((exercise) => exercise.id !== removed.id), custom]),
    );
    storage.writes = [];

    seedDefaultProgramIfNeeded();
    const after = readStorage(STORAGE_KEYS.programExercises, []);
    assert.ok(after.some((exercise) => exercise.id === removed.id), "missing default exercise restored");
    assert.deepEqual(after.find((exercise) => exercise.id === "custom-exercise"), custom, "custom record kept");
    assert.ok(storage.writes.includes(STORAGE_KEYS.programExercises), "exercises key rewritten");
    assert.ok(
      !storage.writes.some((key) =>
        [STORAGE_KEYS.programs, STORAGE_KEYS.programDays, STORAGE_KEYS.programProgressions].includes(key),
      ),
      "unchanged collections are not rewritten",
    );
  }

  // ------------------------------------------------------------------
  // A failed backfill on existing storage leaves it exactly as it was.
  // ------------------------------------------------------------------
  {
    const storage = install();
    for (const [key, value] of reference.store) {
      if (key !== STORAGE_KEYS.programDays) {
        storage.store.set(key, value);
      }
    }
    const before = new Map(storage.store);
    storage.failKey = STORAGE_KEYS.programStorageMeta;
    const failed = seedDefaultProgramIfNeeded();
    assert.equal(failed.seeded, false);
    assert.equal(failed.code, "quota");
    assert.equal(failed.activeProgramId, DEFAULT_PROGRAM_ID, "active id still resolved in memory");
    assert.deepEqual(
      new Map([...storage.store].filter(([key]) => !key.includes(".corrupt-"))),
      before,
      "rolled back byte for byte",
    );
  }

  console.warn = originalWarn;
  console.log("Program H1 seed-batch verification passed.");
} catch (error) {
  console.warn = originalWarn;
  throw error;
}
