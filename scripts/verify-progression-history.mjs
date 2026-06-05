import assert from "node:assert/strict";
import { generateNextPlan } from "../src/lib/progression.js";

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

const mediumCompound = {
  ...baseCompound,
  id: "hack-squat",
  name: "Hack Squat",
  muscleGroup: "quads",
  priority: "medium",
  progressionType: "hypertrophy",
  repsMin: 8,
  repsMax: 10,
  repsLabel: "8-10",
  recommendedWeight: 120,
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

const athletic = {
  id: "box-jumps",
  name: "Box Jumps",
  category: "athletic",
  equipment: "bodyweight",
  muscleGroup: "lower",
  priority: "medium",
  progressionType: "athletic",
  sets: 4,
  repsMin: 3,
  repsMax: 3,
  repsLabel: "3",
  targetRPE: 7,
  restSeconds: 90,
  recommendedWeight: null,
  loadType: "bodyweight",
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
            sets: reps.map((rep) => ({ reps: rep, weight, rpe })),
          },
        }
      : {},
  };
}

function planFor(exercise, currentSession, previousSessions = []) {
  return generateNextPlan(dayFor(exercise), currentSession, previousSessions).exercises[0];
}

const twoStrong = planFor(
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
assert.equal(twoStrong.decision, "increase_load");
assert.equal(twoStrong.confidence, "high");
assert.equal(twoStrong.historySampleSize, 1);

const oneStrong = planFor(
  baseCompound,
  sessionFor({ id: "current", exercise: baseCompound, reps: [7, 7, 7, 7], rpe: 8 }),
);
assert.equal(oneStrong.decision, "increase_load");
assert.equal(oneStrong.confidence, "medium");
assert.equal(oneStrong.conservative, true);

const highRpeCompound = planFor(
  baseCompound,
  sessionFor({ id: "current", exercise: baseCompound, reps: [7, 6, 6, 5], rpe: 9 }),
);
assert.equal(highRpeCompound.decision, "hold");

const repeatedMissed = planFor(
  mediumCompound,
  sessionFor({ id: "current", exercise: mediumCompound, reps: [6, 6, 6], rpe: 9.5 }),
  [
    sessionFor({
      id: "prev-1",
      exercise: mediumCompound,
      reps: [6, 6, 6],
      rpe: 9.5,
      date: "2026-01-03T10:00:00.000Z",
    }),
  ],
);
assert.equal(repeatedMissed.decision, "reduce_load");
assert.ok(repeatedMissed.warnings.some((warning) => warning.includes("Repeated missed targets")));

const isolationTrend = planFor(
  isolation,
  sessionFor({ id: "current", exercise: isolation, reps: [12, 11, 10], rpe: 8 }),
  [
    sessionFor({
      id: "prev-1",
      exercise: isolation,
      reps: [11, 10, 10],
      rpe: 8,
      date: "2026-01-03T10:00:00.000Z",
    }),
  ],
);
assert.equal(isolationTrend.decision, "increase_reps");

const athleticTrend = planFor(
  athletic,
  sessionFor({ id: "current", exercise: athletic, reps: [3, 3, 3, 3], weight: null, rpe: 6 }),
  [
    sessionFor({
      id: "prev-1",
      exercise: athletic,
      reps: [3, 3, 3, 3],
      weight: null,
      rpe: 6,
      date: "2026-01-03T10:00:00.000Z",
    }),
  ],
);
assert.equal(athleticTrend.decision, "hold");
assert.equal(athleticTrend.historySampleSize, 1);

const repeatedHighSessionRpe = planFor(
  baseCompound,
  sessionFor({ id: "current", exercise: baseCompound, reps: [7, 7, 7, 7], rpe: 8, sessionRpe: 8 }),
  [
    sessionFor({
      id: "prev-1",
      exercise: baseCompound,
      reps: [7, 7, 7, 7],
      rpe: 8,
      sessionRpe: 9.5,
      date: "2026-01-03T10:00:00.000Z",
    }),
    sessionFor({
      id: "prev-2",
      exercise: baseCompound,
      reps: [7, 7, 7, 7],
      rpe: 8,
      sessionRpe: 9.2,
      date: "2025-12-27T10:00:00.000Z",
    }),
  ],
);
assert.equal(repeatedHighSessionRpe.conservative, true);
assert.ok(
  repeatedHighSessionRpe.warnings.some((warning) => warning.includes("session RPE 9+")),
);

const missingData = planFor(
  baseCompound,
  sessionFor({
    id: "current",
    exercise: baseCompound,
    reps: [],
    includeLog: false,
  }),
  [{ id: "legacy", date: "2026-01-01T10:00:00.000Z", exercises: [] }],
);
assert.equal(missingData.decision, "insufficient_data");
assert.equal(missingData.confidence, "low");

console.log("Progression history fixtures passed.");
