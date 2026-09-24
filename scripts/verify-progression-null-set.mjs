// Fixer round 2: a null / primitive entry inside a stored session's `sets`
// (hand-edited storage, a backup restored verbatim) must not make
// generateNextPlan throw from Save Workout / History edit. The malformed
// entries are skipped; the remaining set objects still count.
import assert from "node:assert/strict";
import { generateNextPlan } from "../src/lib/progression.js";

const programId = "program-a";
const programExerciseId = "program-a:day-1:bench-press";
const bench = {
  id: programExerciseId,
  programExerciseId,
  libraryExerciseId: "bench-press",
  legacyExerciseId: "bench-press",
  programId,
  dayId: "day-1",
  name: "Bench Press",
  category: "compound",
  equipment: "barbell",
  muscleGroup: "chest",
  priority: "high",
  progressionType: "strength",
  sets: 4,
  repsMin: 5,
  repsMax: 7,
  repsLabel: "5-7",
  targetRPE: 8,
  restSeconds: 180,
  recommendedWeight: 100,
  loadType: "external",
  roundToKg: 2.5,
};
const day = { id: "day-1", name: "Day 1", type: "lifting", exercises: [bench] };

function modernSession(id, sets, date = "2026-03-10T10:00:00.000Z") {
  return {
    id,
    schemaVersion: 6,
    date,
    programId,
    dayId: "day-1",
    dayName: "Day 1",
    sessionRpe: 8,
    readiness: { status: "green", averageScore: 4.2, isGood: true, isPoor: false },
    plannedExercises: {
      exercises: {
        [programExerciseId]: { sets: 4, repsMin: 5, repsMax: 7, repsLabel: "5-7", targetRPE: 8, recommendedWeight: 100 },
      },
    },
    exercises: {
      [programExerciseId]: { programExerciseId, exerciseId: "bench-press", exerciseRPE: 8, painFlag: false, sets },
    },
  };
}

const current = modernSession("current", [
  { reps: 7, weight: 100, rpe: 8 },
  { reps: 7, weight: 100, rpe: 8 },
  { reps: 7, weight: 100, rpe: 8 },
  { reps: 7, weight: 100, rpe: 8 },
]);

// Legacy session (keyed by the config id, no ids inside) with a null set entry.
const legacyWithNull = {
  id: "j8",
  schemaVersion: 3,
  date: "2026-03-03T10:00:00.000Z",
  dayId: "day-1",
  dayName: "Day 1",
  sessionRpe: 8,
  readiness: { status: "green", averageScore: 4.2, isGood: true, isPoor: false },
  exercises: { "bench-press": { exerciseRPE: 8, sets: [{ reps: 6, weight: 80 }, null] } },
};

let plan;
assert.doesNotThrow(() => {
  plan = generateNextPlan(day, current, [legacyWithNull]);
}, "a null set entry in a legacy session must not throw");
assert.equal(plan.exercises[0].historySampleSize, 1, "the session still counts through its valid set");

// Mixed garbage: null, empty object, unparsable reps/weight.
const legacyGarbage = {
  ...legacyWithNull,
  id: "j9",
  exercises: { "bench-press": { exerciseRPE: 8, sets: [null, {}, { reps: "abc", weight: "BW" }, 7, "x"] } },
};
assert.doesNotThrow(() => generateNextPlan(day, current, [legacyGarbage]));
assert.equal(
  generateNextPlan(day, current, [legacyGarbage]).exercises[0].historySampleSize,
  0,
  "a session with no usable set is not a history sample",
);

// Modern session with a null inside its sets, as history and as the current session.
const modernWithNull = modernSession("m-null", [{ reps: 7, weight: 100, rpe: 8 }, null, undefined, { reps: 7, weight: 100, rpe: 8 }], "2026-03-03T10:00:00.000Z");
assert.doesNotThrow(() => generateNextPlan(day, current, [modernWithNull]));
assert.equal(generateNextPlan(day, current, [modernWithNull]).exercises[0].historySampleSize, 1);

let currentPlan;
assert.doesNotThrow(() => {
  currentPlan = generateNextPlan(day, { ...modernWithNull, id: "current-null", date: current.date }, []);
});
assert.equal(currentPlan.exercises[0].decision !== undefined, true);
assert.notEqual(currentPlan.exercises[0].decision, "insufficient_data", "two valid sets are still usable data");

// A current session whose sets are only garbage is insufficient data, not a crash.
const allGarbage = modernSession("garbage", [null, "x", 3]);
assert.equal(generateNextPlan(day, allGarbage, []).exercises[0].decision, "insufficient_data");

console.log("Progression null-set fixtures passed.");
