import assert from "node:assert/strict";
import { generateNextPlan } from "../src/lib/progression.js";

const defaults = {
  category: "compound",
  equipment: "barbell",
  muscleGroup: "general",
  priority: "medium",
  progressionType: "hypertrophy",
  sets: 3,
  repsMin: 8,
  repsMax: 10,
  repsLabel: "8-10",
  targetRPE: 8,
  restSeconds: 120,
  recommendedWeight: 50,
  loadType: "external",
};

function exercise(overrides) {
  return { ...defaults, ...overrides };
}

function dayFor(targetExercise) {
  return {
    id: "profile-day",
    name: "Profile Day",
    type: "lifting",
    exercises: [targetExercise],
  };
}

function plannedExercise(targetExercise) {
  return {
    sets: targetExercise.sets,
    repsMin: targetExercise.repsMin,
    repsMax: targetExercise.repsMax,
    repsLabel: targetExercise.repsLabel,
    restSeconds: targetExercise.restSeconds,
    targetRPE: targetExercise.targetRPE,
    recommendedWeight: targetExercise.recommendedWeight,
  };
}

function sessionFor({
  id,
  targetExercise,
  reps,
  weight = targetExercise.recommendedWeight,
  rpe = 8,
  sessionRpe = 8,
  readiness = { status: "green", averageScore: 4.3, isGood: true, isPoor: false },
  date = "2026-02-10T10:00:00.000Z",
}) {
  return {
    id,
    date,
    dayId: "profile-day",
    dayName: "Profile Day",
    sessionRpe,
    readiness,
    plannedExercises: {
      exercises: {
        [targetExercise.id]: plannedExercise(targetExercise),
      },
    },
    exercises: {
      [targetExercise.id]: {
        programExerciseId: targetExercise.id,
        exerciseId: targetExercise.id,
        exerciseRPE: rpe,
        sets: reps.map((rep) => ({ reps: rep, weight, rpe })),
      },
    },
  };
}

function recommendation(targetExercise, currentSession, previousSessions = []) {
  return generateNextPlan(dayFor(targetExercise), currentSession, previousSessions).exercises[0];
}

const bench = exercise({
  id: "bench",
  name: "Bench Press",
  priority: "high",
  progressionType: "strength",
  sets: 4,
  repsMin: 5,
  repsMax: 7,
  repsLabel: "5-7",
  recommendedWeight: 100,
  roundToKg: 2.5,
});
const benchProgress = recommendation(
  bench,
  sessionFor({ id: "current", targetExercise: bench, reps: [7, 7, 7, 7], weight: 100, rpe: 8 }),
  [
    sessionFor({
      id: "prev",
      targetExercise: bench,
      reps: [7, 7, 7, 7],
      weight: 100,
      rpe: 8,
      date: "2026-02-03T10:00:00.000Z",
    }),
  ],
);
assert.equal(benchProgress.decision, "increase_load");
assert.equal(benchProgress.sets, 4);
assert.equal(benchProgress.exerciseProfile.volumePolicy, "protected");

const curl = exercise({
  id: "cable-curl",
  name: "Cable Curl",
  category: "isolation",
  equipment: "cable",
  progressionType: "pump",
  repsMin: 10,
  repsMax: 12,
  repsLabel: "10-12",
  recommendedWeight: 25,
});
const curlBuildReps = recommendation(
  curl,
  sessionFor({ id: "current", targetExercise: curl, reps: [12, 11, 10], weight: 25, rpe: 8 }),
);
assert.equal(curlBuildReps.progressionMode, "reps_first");
assert.equal(curlBuildReps.decision, "increase_reps");
assert.equal(curlBuildReps.recommendedWeight, 25);

const lateralRaise = exercise({
  id: "lateral-raises",
  name: "Lateral Raises",
  category: "isolation",
  equipment: "dumbbell",
  progressionType: "pump",
  repsMin: 12,
  repsMax: 15,
  repsLabel: "12-15",
  recommendedWeight: 8,
});
const lateralConservative = recommendation(
  lateralRaise,
  sessionFor({ id: "current", targetExercise: lateralRaise, reps: [15, 15, 15], weight: 8, rpe: 7.5 }),
);
assert.equal(lateralConservative.decision, "increase_reps");
assert.equal(lateralConservative.exerciseProfile.loadIncrementKg, 0.5);

const boxJump = exercise({
  id: "box-jumps",
  name: "Box Jumps",
  category: "athletic",
  equipment: "bodyweight",
  progressionType: "athletic",
  repsMin: 3,
  repsMax: 3,
  repsLabel: "3",
  recommendedWeight: null,
  loadType: "bodyweight",
});
const athleticHold = recommendation(
  boxJump,
  sessionFor({ id: "current", targetExercise: boxJump, reps: [3, 3, 3], weight: null, rpe: 6 }),
);
assert.equal(athleticHold.progressionMode, "quality_first");
assert.equal(athleticHold.decision, "hold");

const pullUp = exercise({
  id: "pull-ups",
  name: "Pull-Ups",
  category: "compound",
  equipment: "bodyweight",
  progressionType: "strength",
  repsMin: 6,
  repsMax: 10,
  repsLabel: "6-10",
  recommendedWeight: null,
  loadType: "bodyweight",
});
const pullUpReps = recommendation(
  pullUp,
  sessionFor({ id: "current", targetExercise: pullUp, reps: [10, 10, 10], weight: null, rpe: 8 }),
);
assert.equal(pullUpReps.progressionMode, "reps_first");
assert.equal(pullUpReps.decision, "increase_reps");

const weightedDips = exercise({
  id: "weighted-dips",
  name: "Weighted Dips",
  category: "compound",
  equipment: "bodyweight",
  progressionType: "strength",
  repsMin: 6,
  repsMax: 8,
  repsLabel: "6-8",
  recommendedWeight: 20,
  loadType: "optionalExternal",
});
const dipProgress = recommendation(
  weightedDips,
  sessionFor({ id: "current", targetExercise: weightedDips, reps: [8, 8, 8], weight: 20, rpe: 8 }),
  [
    sessionFor({
      id: "prev",
      targetExercise: weightedDips,
      reps: [8, 8, 8],
      weight: 20,
      rpe: 8,
      date: "2026-02-03T10:00:00.000Z",
    }),
  ],
);
assert.equal(dipProgress.decision, "increase_load");
assert.equal(dipProgress.recommendedWeight, 22.5);

const dbPress = exercise({
  id: "db-press",
  name: "Flat Dumbbell Press",
  equipment: "dumbbell",
  progressionType: "hypertrophy",
  repsMin: 8,
  repsMax: 10,
  repsLabel: "8-10",
  recommendedWeight: 24,
});
const dbProgress = recommendation(
  dbPress,
  sessionFor({ id: "current", targetExercise: dbPress, reps: [10, 10, 10], weight: 24, rpe: 8 }),
  [
    sessionFor({
      id: "prev",
      targetExercise: dbPress,
      reps: [10, 10, 10],
      weight: 24,
      rpe: 8,
      date: "2026-02-03T10:00:00.000Z",
    }),
  ],
);
assert.equal(dbProgress.recommendedWeight, 26);
assert.equal(dbProgress.exerciseProfile.loadIncrementKg, 2);

const plank = exercise({
  id: "plank",
  name: "Plank",
  category: "core",
  equipment: "bodyweight",
  progressionType: "core",
  repsMin: 60,
  repsMax: 60,
  repsLabel: "60 sec",
  recommendedWeight: null,
  loadType: "bodyweight",
});
const coreControl = recommendation(
  plank,
  sessionFor({ id: "current", targetExercise: plank, reps: [60, 60, 60], weight: null, rpe: 8 }),
);
assert.equal(coreControl.progressionMode, "core_control");
assert.equal(coreControl.decision, "increase_reps");

const unknown = {
  id: "unknown",
  name: "Unknown Movement",
  sets: 3,
  repsMin: 8,
  repsMax: 10,
  repsLabel: "8-10",
  targetRPE: 8,
  restSeconds: 90,
  recommendedWeight: null,
};
const unknownResult = recommendation(
  unknown,
  sessionFor({ id: "current", targetExercise: unknown, reps: [10, 10, 10], weight: null, rpe: 8 }),
);
assert.notEqual(unknownResult.decision, "increase_load");
assert.equal(unknownResult.exerciseProfile.loadType, "unknown");

console.log("Progression profile fixtures passed.");
