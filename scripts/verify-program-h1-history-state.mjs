// Fixer round 2 (decision new-E completed): after a session is deleted or
// edited the ProgramState follows the most recent remaining session of that
// program, written in the same persistWorkoutSave batch. With no session left
// the state goes back to "nothing completed, first day next, no last date".
import assert from "node:assert/strict";

class MemoryLocalStorage {
  constructor() {
    this.store = new Map();
    this.failKey = null;
  }

  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  setItem(key, value) {
    if (this.failKey === key) {
      throw new DOMException(`Simulated write failure for ${key}`, "QuotaExceededError");
    }

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
  DEFAULT_PROGRAM_ID,
  deriveProgramStatePatchFromSessions,
  getProgramDays,
  getProgramState,
  persistWorkoutSave,
  seedDefaultProgramIfNeeded,
} = await import("../src/lib/programStorage.js");
const { readStorage, STORAGE_KEYS } = await import("../src/lib/storage.js");

function session(id, dayId, date, programId = DEFAULT_PROGRAM_ID) {
  return { id, schemaVersion: 6, programId, dayId, date, exercises: {}, workoutSets: [] };
}

try {
  seedDefaultProgramIfNeeded();
  const days = getProgramDays(DEFAULT_PROGRAM_ID);
  assert.ok(days.length >= 3);
  const [day1, day2, day3] = days;

  // ------------------------------------------------------------------
  // Pure derivation.
  // ------------------------------------------------------------------
  // Decision H5-5: the derived patch also carries currentWeek / currentCycle
  // (week 1, cycle 1 with no session; the first default program has no
  // optional day and no cycleWeeks).
  assert.deepEqual(deriveProgramStatePatchFromSessions(DEFAULT_PROGRAM_ID, [], days), {
    lastCompletedDayId: null,
    nextRecommendedDayId: day1.id,
    lastWorkoutDate: null,
    currentWeek: 1,
    currentCycle: 1,
  });

  const s1 = session("s1", day1.id, "2026-09-20T10:00:00.000Z");
  const s2 = session("s2", day2.id, "2026-09-22T10:00:00.000Z");
  const other = session("other", day3.id, "2026-09-23T10:00:00.000Z", "another-program");
  const legacy = { id: "legacy", dayId: day3.id, date: "2026-09-24T10:00:00.000Z", exercises: {} };

  assert.deepEqual(
    deriveProgramStatePatchFromSessions(DEFAULT_PROGRAM_ID, [s1, s2, other, legacy], days),
    { lastCompletedDayId: day2.id, nextRecommendedDayId: day3.id, lastWorkoutDate: s2.date, currentWeek: 1, currentCycle: 1 },
    "most recent session of THIS program drives the state; other/legacy sessions do not",
  );
  assert.deepEqual(
    deriveProgramStatePatchFromSessions(DEFAULT_PROGRAM_ID, [s2, s1], days).lastCompletedDayId,
    day2.id,
    "order of the array does not matter",
  );
  assert.equal(
    deriveProgramStatePatchFromSessions(DEFAULT_PROGRAM_ID, [session("last", days.at(-1).id, s2.date)], days)
      .nextRecommendedDayId,
    day1.id,
    "the cycle wraps to the first day",
  );
  assert.deepEqual(
    deriveProgramStatePatchFromSessions(DEFAULT_PROGRAM_ID, [session("gone", "deleted-day", s2.date)], days),
    { lastCompletedDayId: "deleted-day", nextRecommendedDayId: day1.id, lastWorkoutDate: s2.date, currentWeek: 1, currentCycle: 1 },
    "a day that no longer exists points at the first day",
  );

  // ------------------------------------------------------------------
  // The delete path end to end: save one Day 1 session, delete it.
  // ------------------------------------------------------------------
  const saved = persistWorkoutSave({
    sessions: [s1],
    nextPlans: { [day1.id]: { generatedAt: s1.date, exercises: [] } },
    workoutDrafts: {},
    programId: DEFAULT_PROGRAM_ID,
    programStatePatch: { lastCompletedDayId: day1.id, nextRecommendedDayId: day2.id, lastWorkoutDate: s1.date },
  });
  assert.equal(saved.ok, true);
  assert.equal(getProgramState(DEFAULT_PROGRAM_ID).nextRecommendedDayId, day2.id);

  // Exactly what applyHistoryChange issues for "last session of the day deleted".
  const remaining = [];
  const deleted = persistWorkoutSave({
    sessions: remaining,
    nextPlans: {},
    programId: DEFAULT_PROGRAM_ID,
    programStatePatch: deriveProgramStatePatchFromSessions(DEFAULT_PROGRAM_ID, remaining, days),
    deleteProgressionsForDayId: day1.id,
  });
  assert.equal(deleted.ok, true);
  assert.deepEqual(readStorage(STORAGE_KEYS.sessions, null), []);
  const state = getProgramState(DEFAULT_PROGRAM_ID);
  assert.equal(state.lastCompletedDayId, null, "no completed day is left");
  assert.equal(state.nextRecommendedDayId, day1.id, "Day 1 is 'Up next' again, not Day 2");
  assert.equal(state.lastWorkoutDate, null, "no last workout date for a session that no longer exists");
  assert.equal(deleted.programState.nextRecommendedDayId, day1.id);

  // Deleting the newest of two sessions falls back to the older one (another day).
  persistWorkoutSave({
    sessions: [s2, s1],
    programId: DEFAULT_PROGRAM_ID,
    programStatePatch: { lastCompletedDayId: day2.id, nextRecommendedDayId: day3.id, lastWorkoutDate: s2.date },
  });
  const afterNewestDeleted = persistWorkoutSave({
    sessions: [s1],
    programId: DEFAULT_PROGRAM_ID,
    programStatePatch: deriveProgramStatePatchFromSessions(DEFAULT_PROGRAM_ID, [s1], days),
    deleteProgressionsForDayId: day2.id,
  });
  assert.equal(afterNewestDeleted.ok, true);
  assert.deepEqual(
    (({ lastCompletedDayId, nextRecommendedDayId, lastWorkoutDate }) => ({
      lastCompletedDayId,
      nextRecommendedDayId,
      lastWorkoutDate,
    }))(getProgramState(DEFAULT_PROGRAM_ID)),
    { lastCompletedDayId: day1.id, nextRecommendedDayId: day2.id, lastWorkoutDate: s1.date },
  );

  // Atomic: a failed states write leaves sessions and state as they were.
  storage.failKey = STORAGE_KEYS.programStates;
  const failed = persistWorkoutSave({
    sessions: [],
    programId: DEFAULT_PROGRAM_ID,
    programStatePatch: deriveProgramStatePatchFromSessions(DEFAULT_PROGRAM_ID, [], days),
    deleteProgressionsForDayId: day1.id,
  });
  storage.failKey = null;
  assert.equal(failed.ok, false);
  assert.deepEqual(readStorage(STORAGE_KEYS.sessions, null), [s1], "sessions rolled back");
  assert.equal(getProgramState(DEFAULT_PROGRAM_ID).lastCompletedDayId, day1.id, "state rolled back");

  console.warn = originalWarn;
  console.log("Program H1 history-state verification passed.");
} catch (error) {
  console.warn = originalWarn;
  throw error;
}
