// H1 Track B: persistWorkoutSave writes sessions, next plans, drafts,
// progressions and program state in one batch (F2, handoff section 7).
import assert from "node:assert/strict";

class MemoryLocalStorage {
  constructor() {
    this.store = new Map();
    this.failAllWrites = false;
    this.failNextWriteForKey = null;
    this.writes = [];
  }

  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  setItem(key, value) {
    if (this.failAllWrites || this.failNextWriteForKey === key) {
      this.failNextWriteForKey = null;
      throw new DOMException(`Simulated write failure for ${key}`, "QuotaExceededError");
    }

    this.writes.push(key);
    this.store.set(key, String(value));
  }

  removeItem(key) {
    this.store.delete(key);
  }
}

const storage = new MemoryLocalStorage();
globalThis.window = { localStorage: storage };

const originalWarn = console.warn;
console.warn = () => {};

const {
  applyProgressionUpdates,
  buildProgressionUpdatesFromPlan,
  DEFAULT_PROGRAM_ID,
  getProgramDays,
  getProgramExercises,
  getProgramProgression,
  getProgramState,
  persistWorkoutSave,
  seedDefaultProgramIfNeeded,
  upsertProgramProgressionsFromPlan,
} = await import("../src/lib/programStorage.js");
const { getStorageIssues, readStorage, STORAGE_KEYS } = await import("../src/lib/storage.js");

function snapshotKeys() {
  return Object.fromEntries([...storage.store.entries()]);
}

try {
  seedDefaultProgramIfNeeded();

  const days = getProgramDays(DEFAULT_PROGRAM_ID);
  const day = days[0];
  const exercises = getProgramExercises(day.id);
  const [firstExercise, secondExercise] = exercises;

  const existingSessions = [{ id: "session-old", date: "2026-09-10T10:00:00.000Z" }];
  storage.setItem(STORAGE_KEYS.sessions, JSON.stringify(existingSessions));
  storage.setItem(STORAGE_KEYS.nextPlans, JSON.stringify({}));
  storage.setItem(
    STORAGE_KEYS.workoutDrafts,
    JSON.stringify({ [`${DEFAULT_PROGRAM_ID}::${day.id}::2026-09-18`]: { status: "in-progress" } }),
  );

  const newSession = {
    id: "session-new",
    schemaVersion: 6,
    date: "2026-09-18T10:00:00.000Z",
    programId: DEFAULT_PROGRAM_ID,
    dayId: day.id,
  };
  const generatedPlan = {
    schemaVersion: 2,
    dayId: day.id,
    generatedAt: "2026-09-18T10:00:01.000Z",
    sourceSessionId: newSession.id,
    exercises: [
      {
        exerciseId: firstExercise.id,
        name: "First",
        sets: 4,
        repsMin: 6,
        repsMax: 8,
        repsLabel: "6-8",
        restSeconds: [150, 180],
        targetRPE: 8,
        recommendedWeight: 85,
        previousWeight: 82.5,
        reasons: ["Top of range reached: add 2.5 kg."],
        decision: "increase_load",
        confidence: "high",
        warnings: [],
        conservative: false,
      },
      {
        exerciseId: secondExercise.id,
        name: "Second",
        sets: 3,
        repsMin: 8,
        repsMax: 12,
        repsLabel: "8-12",
        restSeconds: 90,
        targetRPE: 8,
        recommendedWeight: 30,
        reasons: [],
        repFocus: "Beat last session's total reps.",
        decision: "increase_reps",
        confidence: "medium",
        warnings: ["one warning", null],
        conservative: true,
      },
    ],
  };

  // ------------------------------------------------------------------
  // The pure plan -> updates conversion matches the legacy upsert.
  // ------------------------------------------------------------------
  const updates = buildProgressionUpdatesFromPlan(generatedPlan);
  assert.equal(updates.length, 2);
  assert.equal(updates[0].programExerciseId, firstExercise.id);
  assert.equal(updates[0].patch.recommendationNote, "Top of range reached: add 2.5 kg.");
  assert.equal(updates[1].patch.recommendationNote, "Beat last session's total reps.");
  assert.deepEqual(updates[1].patch.warnings, ["one warning"]);
  assert.equal(updates[0].patch.sourceSessionId, newSession.id);
  assert.equal(updates[0].patch.sourcePlanGeneratedAt, generatedPlan.generatedAt);

  const legacyStore = JSON.parse(JSON.stringify(readStorage(STORAGE_KEYS.programProgressions, [])));
  const viaLegacy = upsertProgramProgressionsFromPlan(DEFAULT_PROGRAM_ID, generatedPlan);
  const viaPure = applyProgressionUpdates(legacyStore, DEFAULT_PROGRAM_ID, updates);
  const stripTime = (records) => records.map(({ updatedAt, ...rest }) => rest);
  assert.deepEqual(stripTime(viaPure), stripTime(viaLegacy), "pure path equals legacy upsert");

  // Reset progressions to the seeded state for the transaction fixtures.
  storage.setItem(STORAGE_KEYS.programProgressions, JSON.stringify(legacyStore));

  // ------------------------------------------------------------------
  // Failure on the LAST key (programStates) leaves sessions untouched.
  // ------------------------------------------------------------------
  const snapshotBefore = snapshotKeys();
  storage.failNextWriteForKey = STORAGE_KEYS.programStates;
  const failed = persistWorkoutSave({
    sessions: [newSession, ...existingSessions],
    nextPlans: { [day.id]: generatedPlan },
    workoutDrafts: {},
    programId: DEFAULT_PROGRAM_ID,
    plan: generatedPlan,
    programStatePatch: {
      lastCompletedDayId: day.id,
      nextRecommendedDayId: days[1]?.id ?? day.id,
      lastWorkoutDate: newSession.date,
    },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.failedKey, STORAGE_KEYS.programStates);
  assert.equal(failed.code, "quota");
  assert.equal(failed.rolledBack, true);
  assert.match(failed.error, /Browser storage is full/);
  assert.deepEqual(readStorage(STORAGE_KEYS.sessions, []), existingSessions, "sessions untouched");
  assert.deepEqual(readStorage(STORAGE_KEYS.nextPlans, {}), {}, "next plans untouched");
  assert.equal(
    Object.keys(readStorage(STORAGE_KEYS.workoutDrafts, {})).length,
    1,
    "draft kept on failure",
  );
  assert.equal(
    getProgramProgression(DEFAULT_PROGRAM_ID, firstExercise.id).sourceSessionId,
    undefined,
    "progression not updated",
  );
  assert.equal(getProgramState(DEFAULT_PROGRAM_ID).lastCompletedDayId, null);
  assert.deepEqual(snapshotKeys(), snapshotBefore, "storage byte-identical after failed save");
  assert.ok(
    getStorageIssues().some((issue) => issue.key === STORAGE_KEYS.programStates && issue.kind === "quota"),
    "failure surfaced as a storage issue",
  );

  // All writes failing: same guarantee.
  storage.failAllWrites = true;
  const failedAll = persistWorkoutSave({
    sessions: [newSession, ...existingSessions],
    nextPlans: { [day.id]: generatedPlan },
    workoutDrafts: {},
    programId: DEFAULT_PROGRAM_ID,
    plan: generatedPlan,
    programStatePatch: { lastCompletedDayId: day.id },
  });
  storage.failAllWrites = false;
  assert.equal(failedAll.ok, false);
  assert.equal(failedAll.failedKey, STORAGE_KEYS.sessions);
  assert.deepEqual(snapshotKeys(), snapshotBefore);

  // ------------------------------------------------------------------
  // Successful save writes everything in one batch.
  // ------------------------------------------------------------------
  storage.writes = [];
  const saved = persistWorkoutSave({
    sessions: [newSession, ...existingSessions],
    nextPlans: { [day.id]: generatedPlan },
    workoutDrafts: {},
    programId: DEFAULT_PROGRAM_ID,
    plan: generatedPlan,
    programStatePatch: {
      lastCompletedDayId: day.id,
      nextRecommendedDayId: days[1]?.id ?? day.id,
      lastWorkoutDate: newSession.date,
    },
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.writtenKeys, [
    STORAGE_KEYS.sessions,
    STORAGE_KEYS.nextPlans,
    STORAGE_KEYS.workoutDrafts,
    STORAGE_KEYS.programProgressions,
    STORAGE_KEYS.programStates,
  ]);
  assert.deepEqual(storage.writes, saved.writtenKeys, "each key written exactly once");
  assert.equal(readStorage(STORAGE_KEYS.sessions, [])[0].id, "session-new");
  assert.equal(readStorage(STORAGE_KEYS.nextPlans, {})[day.id].generatedAt, generatedPlan.generatedAt);
  assert.deepEqual(readStorage(STORAGE_KEYS.workoutDrafts, {}), {}, "draft cleared on success");

  const storedProgression = getProgramProgression(DEFAULT_PROGRAM_ID, firstExercise.id);
  assert.equal(storedProgression.lastRecommendedWeight, 85);
  assert.equal(storedProgression.sourceSessionId, newSession.id);
  assert.equal(storedProgression.sourcePlanGeneratedAt, generatedPlan.generatedAt);
  assert.equal(storedProgression.recommendationNote, "Top of range reached: add 2.5 kg.");
  assert.deepEqual(stripTime(saved.progressions), stripTime(viaLegacy), "returned progressions match storage");

  const storedState = getProgramState(DEFAULT_PROGRAM_ID);
  assert.equal(storedState.lastCompletedDayId, day.id);
  assert.equal(storedState.lastWorkoutDate, newSession.date);
  assert.equal(saved.programState.lastCompletedDayId, day.id);
  assert.equal(storedState.currentWeek, 1, "untouched state fields preserved");
  assert.equal(
    getStorageIssues().some((issue) => issue.key === STORAGE_KEYS.programStates),
    false,
    "issue cleared after a successful write",
  );

  // ------------------------------------------------------------------
  // Explicit progressionUpdates (no plan) and partial inputs.
  // ------------------------------------------------------------------
  storage.writes = [];
  const partial = persistWorkoutSave({
    programId: DEFAULT_PROGRAM_ID,
    progressionUpdates: [
      { programExerciseId: secondExercise.id, patch: { lastRecommendedWeight: 32.5, recommendationNote: "manual" } },
      { programExerciseId: null, patch: { ignored: true } },
    ],
  });
  assert.equal(partial.ok, true);
  assert.deepEqual(partial.writtenKeys, [STORAGE_KEYS.programProgressions], "only progressions written");
  assert.equal(partial.programState, null);
  const second = getProgramProgression(DEFAULT_PROGRAM_ID, secondExercise.id);
  assert.equal(second.lastRecommendedWeight, 32.5);
  assert.equal(second.recommendationNote, "manual");
  assert.equal(second.decision, "increase_reps", "patch merges over the existing record");
  assert.equal(second.programExerciseId, secondExercise.id);

  // Sessions-only save, no program.
  const sessionsOnly = persistWorkoutSave({ sessions: [] });
  assert.equal(sessionsOnly.ok, true);
  assert.deepEqual(sessionsOnly.writtenKeys, [STORAGE_KEYS.sessions]);
  assert.deepEqual(readStorage(STORAGE_KEYS.sessions, null), []);

  // Nothing to write is still ok.
  assert.equal(persistWorkoutSave({}).ok, true);
  assert.equal(persistWorkoutSave().ok, true);

  // ------------------------------------------------------------------
  // Fixer round 1 (decision new-E, F2): deleting the last session of a day
  // clears that day's progressions in the SAME batch as the sessions. A
  // failure on the progressions key leaves the sessions untouched, so
  // storage and React state never diverge.
  // ------------------------------------------------------------------
  {
    const seeded = persistWorkoutSave({
      sessions: [newSession],
      nextPlans: { [day.id]: generatedPlan },
      workoutDrafts: {},
      programId: DEFAULT_PROGRAM_ID,
      plan: generatedPlan,
    });
    assert.equal(seeded.ok, true);
    assert.equal(
      getProgramProgression(DEFAULT_PROGRAM_ID, firstExercise.id).sourceSessionId,
      newSession.id,
      "earned progression stored",
    );
    const otherDay = days[1];
    const otherDayExercise = getProgramExercises(otherDay.id)[0];
    assert.ok(otherDayExercise, "fixture needs a second day");
    const otherProgressionBefore = getProgramProgression(DEFAULT_PROGRAM_ID, otherDayExercise.id);
    assert.ok(otherProgressionBefore, "other day keeps a seeded progression");

    const before = snapshotKeys();
    storage.failNextWriteForKey = STORAGE_KEYS.programProgressions;
    const failedDelete = persistWorkoutSave({
      sessions: [],
      nextPlans: {},
      programId: DEFAULT_PROGRAM_ID,
      deleteProgressionsForDayId: day.id,
    });
    assert.equal(failedDelete.ok, false);
    assert.equal(failedDelete.failedKey, STORAGE_KEYS.programProgressions);
    assert.deepEqual(snapshotKeys(), before, "sessions not committed when the cleanup write fails");
    assert.deepEqual(readStorage(STORAGE_KEYS.sessions, null), [newSession], "session still stored");
    assert.equal(
      getProgramProgression(DEFAULT_PROGRAM_ID, firstExercise.id).sourceSessionId,
      newSession.id,
      "progression still stored",
    );

    const deleted = persistWorkoutSave({
      sessions: [],
      nextPlans: {},
      programId: DEFAULT_PROGRAM_ID,
      deleteProgressionsForDayId: day.id,
    });
    assert.equal(deleted.ok, true);
    assert.deepEqual(deleted.writtenKeys, [
      STORAGE_KEYS.sessions,
      STORAGE_KEYS.nextPlans,
      STORAGE_KEYS.programProgressions,
    ]);
    assert.ok(deleted.removedProgressionCount >= 1, "day progressions removed");
    assert.deepEqual(readStorage(STORAGE_KEYS.sessions, null), []);
    assert.equal(getProgramProgression(DEFAULT_PROGRAM_ID, firstExercise.id), null);
    assert.equal(getProgramProgression(DEFAULT_PROGRAM_ID, secondExercise.id), null);
    assert.deepEqual(
      getProgramProgression(DEFAULT_PROGRAM_ID, otherDayExercise.id),
      otherProgressionBefore,
      "other days untouched",
    );

    // Nothing to delete: the progressions key is not rewritten.
    const noop = persistWorkoutSave({
      sessions: [],
      programId: DEFAULT_PROGRAM_ID,
      deleteProgressionsForDayId: day.id,
    });
    assert.equal(noop.ok, true);
    assert.deepEqual(noop.writtenKeys, [STORAGE_KEYS.sessions]);
    assert.equal(noop.removedProgressionCount, 0);
  }

  console.warn = originalWarn;
  console.log("Program H1 save transaction verification passed.");
} catch (error) {
  console.warn = originalWarn;
  throw error;
}
