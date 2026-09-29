// Phase H4 Track A: src/lib/sessionEdit.js (moved verbatim from src/App.jsx).
// Decision new-E / new-H: the History editor rebuilds a session with the same
// day-driven normalisation as the save path, so
// - an edit round-trip keeps id / date / program / day identity and set ids;
// - an exercise no longer in the program day is dropped from the edited session;
// - invalid edits are refused and nothing is rebuilt;
// - the builders never mutate the session they read (delete never drops anything:
//   deleting is a filter in App state, no builder touches other sessions).
import assert from "node:assert/strict";

class MemoryLocalStorage {
  constructor() {
    this.store = new Map();
  }

  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  setItem(key, value) {
    this.store.set(key, String(value));
  }

  removeItem(key) {
    this.store.delete(key);
  }
}

globalThis.window = { localStorage: new MemoryLocalStorage() };
console.warn = () => {};

const {
  buildDraftFromSession,
  buildPlanFromSessionSnapshot,
  buildPlannedExercisesSnapshot,
  buildResolvedPlan,
  rebuildSessionFromEdits,
  stringifyDraftValue,
} = await import("../src/lib/sessionEdit.js");
const { createDefaultWellness } = await import("../src/lib/sessionNormalize.js");
const { getBasePlan } = await import("../src/lib/progression.js");

const bench = {
  id: "pe-bench",
  programExerciseId: "pe-bench",
  libraryExerciseId: "lib-bench",
  programId: "program-a",
  name: "Bench Press",
  sets: 3,
  repsMin: 6,
  repsMax: 8,
  repsLabel: "6-8",
  targetRPE: 8,
  restSeconds: [150, 180],
  recommendedWeight: 60,
  loadType: "external",
  weightMode: "kg",
};
const row = {
  ...bench,
  id: "pe-row",
  programExerciseId: "pe-row",
  libraryExerciseId: "lib-row",
  name: "Barbell Row",
  sets: 2,
  restSeconds: 120,
  recommendedWeight: 50,
};
const dayWithBoth = { id: "day-1", name: "Day 1", type: "training", exercises: [bench, row] };
const dayWithoutRow = { id: "day-1", name: "Day 1", type: "training", exercises: [bench] };

function set(programExerciseId, exerciseId, setNumber, reps, weight, rpe, planned = {}) {
  return {
    sessionId: "s-1",
    programId: "program-a",
    dayId: "day-1",
    programExerciseId,
    exerciseId,
    setNumber,
    plannedWeight: null,
    plannedReps: "6-8",
    ...planned,
    actualWeight: weight,
    actualReps: reps,
    actualRPE: rpe,
    completed: reps !== null && weight !== null && rpe !== null,
  };
}

const savedSession = Object.freeze({
  id: "s-1",
  date: "2026-09-20T18:00:00+03:00",
  programId: "program-a",
  programName: "Custom",
  dayId: "day-1",
  dayName: "Day 1",
  dayType: "training",
  sessionRpe: 8,
  sessionNotes: "ok",
  wellness: { sleep: 4 },
  readiness: { status: "green" },
  plannedExercises: {
    "pe-bench": { sets: 3, repsMin: 6, repsMax: 8, repsLabel: "6-8", targetRPE: 8, recommendedWeight: 62.5, restSeconds: 180, prescriptionSource: "plan" },
    "pe-row": { sets: 2, repsMin: 6, repsMax: 8, repsLabel: "6-8", targetRPE: 8, recommendedWeight: 50, restSeconds: 120, prescriptionSource: "target" },
  },
  exercises: {
    "pe-bench": { programExerciseId: "pe-bench", exerciseId: "lib-bench", notes: "solid", painFlag: false, exerciseRPE: 8, sets: [{ reps: 8, weight: 60, rpe: 8 }, { reps: 8, weight: 60, rpe: 8 }, { reps: null, weight: null, rpe: null }] },
    "pe-row": { programExerciseId: "pe-row", exerciseId: "lib-row", notes: "", painFlag: true, exerciseRPE: 7, sets: [{ reps: 10, weight: 50, rpe: 7 }, { reps: null, weight: null, rpe: null }] },
  },
  workoutSets: [
    set("pe-bench", "lib-bench", 1, 8, 60, 8, { plannedWeight: 62.5 }),
    set("pe-bench", "lib-bench", 2, 8, 60, 8, { plannedWeight: 62.5 }),
    set("pe-bench", "lib-bench", 3, null, null, null, { plannedWeight: 62.5 }),
    set("pe-row", "lib-row", 1, 10, 50, 7, { plannedWeight: 50 }),
    set("pe-row", "lib-row", 2, null, null, null, { plannedWeight: 50 }),
  ],
  analytics: { exerciseCount: 2, loggedSetCount: 3, totalReps: 26, exerciseSummaries: [] },
});
const sessionSnapshot = JSON.stringify(savedSession);

// ---------------------------------------------------------------------------
// stringifyDraftValue and the draft view of a saved session
// ---------------------------------------------------------------------------
assert.equal(stringifyDraftValue(null), "");
assert.equal(stringifyDraftValue(undefined), "");
assert.equal(stringifyDraftValue(""), "");
assert.equal(stringifyDraftValue(0), "0", "0 reps is a value");
assert.equal(stringifyDraftValue(62.5), "62.5");
assert.equal(stringifyDraftValue("BW"), "BW");

{
  const draft = buildDraftFromSession(savedSession, dayWithBoth);
  assert.deepEqual(Object.keys(draft.exercises), ["pe-bench", "pe-row"]);
  assert.deepEqual(draft.exercises["pe-bench"], {
    notes: "solid",
    painFlag: false,
    sets: [{ reps: "8", weight: "60", rpe: "8" }, { reps: "8", weight: "60", rpe: "8" }, { reps: "", weight: "", rpe: "" }],
  }, "sets come from the session's own log, blanks stay blank");
  assert.equal(draft.exercises["pe-row"].painFlag, true);
  assert.equal(draft.sessionRpe, "8");
  assert.equal(draft.sessionNotes, "ok");
  assert.deepEqual(draft.wellness, { sleep: 4 });
  assert.deepEqual(draft.recoveryActivities, {});

  // Exercise with no log: the planned set count, then the target set count, decides the row count.
  const noLog = { id: "s-2", plannedExercises: { "pe-bench": { sets: 4 } } };
  assert.equal(buildDraftFromSession(noLog, dayWithBoth).exercises["pe-bench"].sets.length, 4);
  assert.equal(buildDraftFromSession(noLog, dayWithBoth).exercises["pe-row"].sets.length, 2);
  assert.deepEqual(buildDraftFromSession({}, dayWithBoth).wellness, createDefaultWellness());
  assert.equal(buildDraftFromSession({}, dayWithBoth).sessionRpe, "");
}

// ---------------------------------------------------------------------------
// Plans: resolved plan, planned snapshot, plan from a session snapshot
// ---------------------------------------------------------------------------
{
  const basePlan = getBasePlan(dayWithBoth);
  const resolved = buildResolvedPlan(null, dayWithBoth, basePlan);
  assert.equal(resolved.status, "base", "plan fields are kept");
  assert.deepEqual(resolved.exercises.map((entry) => entry.exerciseId), ["pe-bench", "pe-row"]);
  assert.equal(resolved.exercises[0].name, "Bench Press");
  assert.equal(resolved.exercises[0].recommendedWeight, 60);
  assert.equal(resolved.exercises[0].prescriptionSource, "target");
  assert.deepEqual(resolved.exercises[0].restSeconds, [150, 180]);
  assert.equal(resolved.exercises[0].reasons?.[0], basePlan.exercises[0].reasons[0], "coach fields of the plan entry are kept");
  assert.deepEqual(buildResolvedPlan(null, null, null), { exercises: [] });

  const snapshot = buildPlannedExercisesSnapshot(dayWithBoth, resolved);
  assert.deepEqual(snapshot["pe-bench"], {
    sets: 3, repsMin: 6, repsMax: 8, repsLabel: "6-8", targetRPE: 8, recommendedWeight: 60, restSeconds: [150, 180], prescriptionSource: "target",
  });
  assert.deepEqual(Object.keys(snapshot), ["pe-bench", "pe-row"]);
  const fromTargets = buildPlannedExercisesSnapshot(dayWithBoth, null);
  assert.equal(fromTargets["pe-row"].recommendedWeight, 50);
  assert.equal(fromTargets["pe-row"].prescriptionSource, null);

  const fromSession = buildPlanFromSessionSnapshot(savedSession, dayWithBoth);
  assert.equal(fromSession.status, "snapshot");
  assert.equal(fromSession.exercises[0].recommendedWeight, 62.5, "the snapshot wins over the current target");
  assert.equal(fromSession.exercises[0].restSeconds, 180);
  assert.equal(fromSession.exercises[0].exerciseId, "pe-bench");
  const unknown = buildPlanFromSessionSnapshot({ plannedExercises: {} }, dayWithBoth);
  assert.equal(unknown.exercises[0].recommendedWeight, 60, "current target only for exercises the snapshot does not know");
}

// ---------------------------------------------------------------------------
// Edit round-trip
// ---------------------------------------------------------------------------
{
  const before = Date.now();
  const result = rebuildSessionFromEdits(savedSession, dayWithBoth, {
    sessionRpe: "8.5",
    sessionNotes: "  edited ",
    exercises: {
      "pe-bench": { sets: [{ reps: 8, weight: 60, rpe: 8 }, { reps: 9, weight: 60, rpe: 8.5 }, { reps: "", weight: "", rpe: "" }], notes: "tweaked" },
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  const edited = result.session;
  assert.equal(edited.id, "s-1");
  assert.equal(edited.date, savedSession.date, "date is kept");
  assert.equal(edited.programId, "program-a");
  assert.equal(edited.dayId, "day-1");
  assert.equal(edited.readiness, savedSession.readiness, "untouched fields are carried over");
  assert.equal(edited.plannedExercises, savedSession.plannedExercises);
  assert.equal(edited.sessionRpe, 8.5);
  assert.equal(edited.sessionNotes, "edited");
  assert.ok(Date.parse(edited.updatedAt) >= before, "updatedAt is bumped");
  assert.deepEqual(edited.exercises["pe-bench"].sets, [{ reps: 8, weight: 60, rpe: 8 }, { reps: 9, weight: 60, rpe: 8.5 }, { reps: null, weight: null, rpe: null }]);
  assert.equal(edited.exercises["pe-bench"].notes, "tweaked");
  assert.equal(edited.exercises["pe-bench"].exerciseRPE, 8.3);
  assert.equal(edited.exercises["pe-bench"].programExerciseId, "pe-bench");
  assert.equal(edited.exercises["pe-bench"].exerciseId, "lib-bench");
  assert.deepEqual(edited.exercises["pe-row"].sets, [{ reps: 10, weight: 50, rpe: 7 }, { reps: null, weight: null, rpe: null }], "an exercise without edits keeps its log");
  assert.equal(edited.exercises["pe-row"].painFlag, true);
  assert.equal(edited.workoutSets.length, 5);
  assert.deepEqual(
    edited.workoutSets.map((entry) => [entry.sessionId, entry.programId, entry.dayId, entry.programExerciseId, entry.exerciseId, entry.setNumber]),
    savedSession.workoutSets.map((entry) => [entry.sessionId, entry.programId, entry.dayId, entry.programExerciseId, entry.exerciseId, entry.setNumber]),
    "set identity is kept",
  );
  assert.equal(edited.workoutSets[1].actualReps, 9);
  assert.equal(edited.workoutSets[1].completed, true);
  assert.equal(edited.workoutSets[0].plannedWeight, 62.5, "planned values come from the session's own snapshot");
  assert.equal(edited.workoutSets[2].completed, false);
  assert.equal(edited.analytics.loggedSetCount, 3);
  assert.equal(edited.analytics.totalReps, 27);
  assert.equal(edited.analytics.exerciseCount, 2);

  // Editing the same session again from the rebuilt one yields the same data.
  const again = rebuildSessionFromEdits(edited, dayWithBoth, {});
  assert.equal(again.ok, true);
  assert.deepEqual(again.session.exercises, edited.exercises);
  assert.deepEqual(again.session.workoutSets, edited.workoutSets);
}

// Decision new-H: an exercise that left the program day is dropped by the edit.
{
  const result = rebuildSessionFromEdits(savedSession, dayWithoutRow, { sessionNotes: "row removed" });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.session.exercises), ["pe-bench"]);
  assert.ok(result.session.workoutSets.every((entry) => entry.programExerciseId === "pe-bench"));
  assert.equal(result.session.workoutSets.length, 3);
  assert.equal(result.session.analytics.exerciseCount, 1);
  assert.equal(result.session.analytics.loggedSetCount, 2);
  assert.equal(result.session.plannedExercises["pe-row"].sets, 2, "the planned snapshot is history and stays as saved");
}

// Invalid edits are refused; nothing is rebuilt.
{
  const result = rebuildSessionFromEdits(savedSession, dayWithBoth, {
    exercises: { "pe-bench": { sets: [{ reps: 8, weight: 60, rpe: 8.3 }] } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "Bench Press set 1: set RPE must be 1-10 in .5 steps.");
  assert.deepEqual(result.errors, ["Bench Press set 1: set RPE must be 1-10 in .5 steps."]);
  assert.equal(result.session, undefined);

  const noSets = rebuildSessionFromEdits(savedSession, dayWithBoth, {
    exercises: {
      "pe-bench": { sets: [{ reps: "", weight: "", rpe: "" }] },
      "pe-row": { sets: [{ reps: "", weight: "", rpe: "" }] },
    },
  });
  assert.equal(noSets.ok, false);
  assert.equal(noSets.error, "Log at least one complete set before generating recommendations.");
  assert.equal(rebuildSessionFromEdits(savedSession, dayWithBoth, { sessionRpe: "" }).error, "Session RPE needs a 1-10 score.");
}

// The builders never mutate what they read (delete never drops anything else).
assert.equal(JSON.stringify(savedSession), sessionSnapshot, "the saved session object is untouched by every builder");
{
  const sessions = [savedSession, { id: "s-other", programId: "program-a", dayId: "day-1", exercises: {} }];
  const snapshot = JSON.stringify(sessions);
  rebuildSessionFromEdits(sessions[0], dayWithoutRow, { sessionNotes: "x" });
  assert.equal(JSON.stringify(sessions), snapshot, "other sessions are never touched by an edit");
}

console.log("Session edit verification passed.");
