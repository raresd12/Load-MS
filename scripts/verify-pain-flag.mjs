import assert from "node:assert/strict";
import { generateNextPlan, PAIN_FLAG_WARNING } from "../src/lib/progression.js";

const baseCompound = {
  id: "bench",
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

const isolation = {
  id: "lateral-raise",
  name: "Lateral Raises",
  category: "isolation",
  equipment: "dumbbell",
  muscleGroup: "delts",
  priority: "high",
  progressionType: "pump",
  sets: 3,
  repsMin: 10,
  repsMax: 12,
  repsLabel: "10-12",
  targetRPE: 8,
  restSeconds: 60,
  recommendedWeight: 10,
  loadType: "external",
  roundToKg: 1,
};

function dayFor(exercise) {
  return {
    id: "day-1",
    name: "Test Day",
    type: "lifting",
    exercises: [exercise],
  };
}

function plannedExercise(exercise) {
  return {
    sets: exercise.sets,
    repsMin: exercise.repsMin,
    repsMax: exercise.repsMax,
    repsLabel: exercise.repsLabel,
    restSeconds: exercise.restSeconds,
    targetRPE: exercise.targetRPE,
    recommendedWeight: exercise.recommendedWeight,
  };
}

function sessionFor({
  id,
  exercise,
  reps,
  weight = exercise.recommendedWeight,
  rpe = 8,
  sessionRpe = 8,
  date = "2026-01-10T10:00:00.000Z",
  painFlag = false,
  includeLog = true,
}) {
  return {
    id,
    date,
    dayId: "day-1",
    dayName: "Test Day",
    sessionRpe,
    readiness: { status: "green", averageScore: 4.2, isGood: true, isPoor: false },
    plannedExercises: {
      exercises: {
        [exercise.id]: plannedExercise(exercise),
      },
    },
    exercises: includeLog
      ? {
          [exercise.id]: {
            programExerciseId: exercise.id,
            exerciseId: exercise.id,
            exerciseRPE: rpe,
            painFlag,
            sets: reps.map((rep) => ({ reps: rep, weight, rpe })),
          },
        }
      : {},
  };
}

function planFor(exercise, currentSession, previousSessions = []) {
  return generateNextPlan(dayFor(exercise), currentSession, previousSessions).exercises[0];
}

// Control: strong performance without a pain flag progresses load.
const control = planFor(
  baseCompound,
  sessionFor({ id: "current", exercise: baseCompound, reps: [7, 7, 7, 7], rpe: 8 }),
  [
    sessionFor({
      id: "prev-1",
      exercise: baseCompound,
      reps: [7, 7, 7, 7],
      rpe: 8,
      date: "2026-01-03T10:00:00.000Z",
    }),
  ],
);
assert.equal(control.decision, "increase_load");

// Same strong performance with a pain flag must hold, stay conservative, and warn.
const painHold = planFor(
  baseCompound,
  sessionFor({ id: "current", exercise: baseCompound, reps: [7, 7, 7, 7], rpe: 8, painFlag: true }),
  [
    sessionFor({
      id: "prev-1",
      exercise: baseCompound,
      reps: [7, 7, 7, 7],
      rpe: 8,
      date: "2026-01-03T10:00:00.000Z",
    }),
  ],
);
assert.equal(painHold.decision, "hold");
assert.equal(painHold.conservative, true);
assert.equal(painHold.recommendedWeight, 100);
assert.ok(painHold.warnings.includes(PAIN_FLAG_WARNING));
assert.ok(
  painHold.reasons.some((reason) => reason.includes("pain")),
  "pain reason should be present",
);

// Pain flag must also block rep progression for isolation work.
const painIsolation = planFor(
  isolation,
  sessionFor({ id: "current", exercise: isolation, reps: [10, 10, 10], rpe: 7.5, painFlag: true }),
);
assert.notEqual(painIsolation.decision, "increase_reps");
assert.notEqual(painIsolation.decision, "increase_load");
assert.equal(painIsolation.conservative, true);
assert.ok(painIsolation.warnings.includes(PAIN_FLAG_WARNING));

// A protective decision (reduce_load) is not overridden into a plain hold.
const painPoorPerformance = planFor(
  baseCompound,
  sessionFor({
    id: "current",
    exercise: baseCompound,
    reps: [4, 4, 4, 3],
    rpe: 9.5,
    painFlag: true,
  }),
);
assert.ok(
  ["reduce_load", "hold"].includes(painPoorPerformance.decision),
  `expected protective decision, got ${painPoorPerformance.decision}`,
);
assert.equal(painPoorPerformance.conservative, true);
assert.ok(painPoorPerformance.warnings.includes(PAIN_FLAG_WARNING));

// Old sessions without the painFlag field behave exactly as before (no warning).
const legacySession = planFor(
  baseCompound,
  sessionFor({ id: "current", exercise: baseCompound, reps: [7, 7, 7, 7], rpe: 8 }),
);
assert.ok(!legacySession.warnings.includes(PAIN_FLAG_WARNING));

console.log("Pain flag fixtures passed.");
