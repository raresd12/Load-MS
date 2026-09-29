import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as progression from "../src/lib/progression.js";

// Phase H4 / Track B, decision H4-3: the v1 engine (calculateExerciseRecommendation
// and the progress*Exercise family) is deleted from src/lib/progression.js.
// generateNextPlan -> calculateExerciseRecommendationV2 is the only engine.
// GOLDEN below is generateNextPlan's output for the verify-progression-h1-decisions
// inputs, captured from the module as it was before the deletion (git HEAD
// f8423f4) and asserted equal against the module before and after it.

const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/progression.js");
const source = readFileSync(modulePath, "utf8");

const RETIRED_NAMES = [
  "calculateExerciseRecommendation",
  "progressCompoundExercise",
  "progressIsolationExercise",
  "progressAthleticExercise",
  "progressCoreExercise",
  // Helpers only the v1 engine used.
  "getWorkingWeight",
  "formatRpe",
  "canProgressLoad",
  "isAccessoryReductionCandidate",
];

for (const name of RETIRED_NAMES) {
  assert.ok(
    !new RegExp(`\\b${name}\\b(?!V2)`).test(source),
    `${name} is no longer present in progression.js`,
  );
  assert.equal(progression[name], undefined, `${name} is not exported`);
}

assert.ok(/function calculateExerciseRecommendationV2\(/.test(source), "the live engine is still there");
assert.equal(typeof progression.generateNextPlan, "function", "generateNextPlan stays exported");

const EXPECTED_EXPORTS = [
  "generateNextPlan",
  "getSessionAgeDays",
  "HISTORY_RECENCY_DAYS",
  "PAIN_FLAG_WARNING",
];

for (const name of EXPECTED_EXPORTS) {
  assert.notEqual(progression[name], undefined, `${name} is still exported`);
}

// --- Inputs (verbatim from verify-progression-h1-decisions.mjs) ----------
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
  sets: 3,
  repsMin: 8,
  repsMax: 10,
  repsLabel: "8-10",
  recommendedWeight: 120,
};

const isolation = {
  id: "cable-curl",
  name: "Cable Curl",
  category: "isolation",
  equipment: "cable",
  muscleGroup: "biceps",
  priority: "medium",
  progressionType: "pump",
  sets: 3,
  repsMin: 10,
  repsMax: 12,
  repsLabel: "10-12",
  targetRPE: 8,
  restSeconds: 60,
  recommendedWeight: 25,
  loadType: "external",
};

const weightedDips = {
  ...baseCompound,
  id: "dips",
  name: "Weighted Dips",
  equipment: "bodyweight",
  loadType: "optionalExternal",
  recommendedWeight: 10,
};

function dayFor(exercise) {
  return { id: "day-1", name: "Test Day", type: "lifting", exercises: [exercise] };
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
  weights = null,
  rpe = 8,
  sessionRpe = 8,
  date = "2026-03-10T10:00:00.000Z",
  readiness = { status: "green", averageScore: 4.2, isGood: true, isPoor: false },
  painFlag = false,
}) {
  return {
    id,
    date,
    dayId: "day-1",
    dayName: "Test Day",
    sessionRpe,
    readiness,
    plannedExercises: { exercises: { [exercise.id]: plannedExercise(exercise) } },
    exercises: {
      [exercise.id]: {
        programExerciseId: exercise.id,
        exerciseId: exercise.id,
        exerciseRPE: rpe,
        painFlag,
        sets: reps.map((rep, index) => ({ reps: rep, weight: weights ? weights[index] : weight, rpe })),
      },
    },
  };
}

const PREV = "2026-03-03T10:00:00.000Z";

const CASES = {
  topSetCurrent: [
    baseCompound,
    sessionFor({ id: "current", exercise: baseCompound, reps: [7, 7, 7, 7], weights: [100, 100, 100, 90], rpe: 8 }),
    [sessionFor({ id: "prev", exercise: baseCompound, reps: [7, 7, 7, 7], date: PREV })],
  ],
  topSetHold: [
    baseCompound,
    sessionFor({ id: "current", exercise: baseCompound, reps: [6, 6, 6, 6], weights: [100, 100, 100, 90], rpe: 8 }),
    [],
  ],
  regressedVsTop: [
    baseCompound,
    sessionFor({ id: "current", exercise: baseCompound, reps: [5, 5, 5, 5], weight: 100, rpe: 8 }),
    [sessionFor({ id: "prev-mixed", exercise: baseCompound, reps: [7, 7, 7, 7], weights: [100, 90, 90, 90], date: PREV })],
  ],
  dips: [
    weightedDips,
    sessionFor({ id: "current", exercise: weightedDips, reps: [7, 7, 7, 7], weights: ["BW", 10, 10, 10], rpe: 8 }),
    [sessionFor({ id: "prev", exercise: weightedDips, reps: [7, 7, 7, 7], weight: 10, date: PREV })],
  ],
  firstBadMain: [
    baseCompound,
    sessionFor({ id: "current", exercise: baseCompound, reps: [4, 4, 4, 3], weight: 60, rpe: 9.5 }),
    [],
  ],
  firstBadMedium: [
    mediumCompound,
    sessionFor({ id: "current", exercise: mediumCompound, reps: [6, 6, 6], rpe: 9.5 }),
    [],
  ],
  firstBadIsolation: [
    isolation,
    sessionFor({ id: "current", exercise: isolation, reps: [8, 8, 7], rpe: 9.5 }),
    [],
  ],
  badAfterGood: [
    mediumCompound,
    sessionFor({ id: "current", exercise: mediumCompound, reps: [6, 6, 6], rpe: 9.5 }),
    [sessionFor({ id: "prev", exercise: mediumCompound, reps: [10, 10, 10], rpe: 8, date: PREV })],
  ],
  twoBad: [
    mediumCompound,
    sessionFor({ id: "current", exercise: mediumCompound, reps: [6, 6, 6], rpe: 9.5 }),
    [sessionFor({ id: "prev", exercise: mediumCompound, reps: [6, 6, 6], rpe: 9.5, date: PREV })],
  ],
  painFlag: [
    baseCompound,
    sessionFor({ id: "current", exercise: baseCompound, reps: [7, 7, 7, 7], rpe: 7, painFlag: true }),
    [sessionFor({ id: "prev", exercise: baseCompound, reps: [7, 7, 7, 7], date: PREV })],
  ],
  redReadiness: [
    isolation,
    sessionFor({
      id: "current",
      exercise: isolation,
      reps: [12, 12, 12],
      rpe: 9,
      sessionRpe: 9.5,
      readiness: { status: "red", averageScore: 2.1, isGood: false, isPoor: true },
    }),
    [],
  ],
};

// --- Golden output of the pre-deletion module ----------------------------
const GOLDEN = JSON.parse(
  '{"topSetCurrent":{"exerciseId":"bench","name":"Bench Press","sets":4,"repsMin":5,"repsMax":7,"repsLabel":"5-7","restSeconds":180,"targetRPE":8,"recommendedWeight":102.5,"previousWeight":100,"repFocus":"Own the same rep range with the heavier load.","totalReps":28,"previousTotalReps":28,"exerciseRPE":8,"reasons":["All sets reached the top of the rep range with effort in reserve - the weight goes up.","Two strong sessions in a row support this load increase."],"conservative":false,"decision":"increase_load","confidence":"high","warnings":[],"historyTrend":"insufficient_history","historySampleSize":1,"progressionMode":"double_progression","exerciseProfile":{"type":"compound","progressionMode":"double_progression","equipment":"barbell","loadType":"external","weightMode":"kg","priority":"high","loadIncrementKg":2.5,"roundToKg":2.5,"maxRpeForLoadIncrease":8.5,"volumePolicy":"protected"}},"topSetHold":{"exerciseId":"bench","name":"Bench Press","sets":4,"repsMin":5,"repsMax":7,"repsLabel":"5-7","restSeconds":180,"targetRPE":8,"recommendedWeight":100,"previousWeight":100,"repFocus":"Beat 24 total reps next time.","totalReps":24,"previousTotalReps":null,"exerciseRPE":8,"reasons":["Same weight next time. The goal is to beat your total reps before adding load."],"conservative":false,"decision":"increase_reps","confidence":"high","warnings":[],"historyTrend":"insufficient_history","historySampleSize":0,"progressionMode":"double_progression","exerciseProfile":{"type":"compound","progressionMode":"double_progression","equipment":"barbell","loadType":"external","weightMode":"kg","priority":"high","loadIncrementKg":2.5,"roundToKg":2.5,"maxRpeForLoadIncrease":8.5,"volumePolicy":"protected"}},"regressedVsTop":{"exerciseId":"bench","name":"Bench Press","sets":4,"repsMin":5,"repsMax":7,"repsLabel":"5-7","restSeconds":180,"targetRPE":8,"recommendedWeight":100,"previousWeight":100,"repFocus":"Beat 20 total reps next time.","totalReps":20,"previousTotalReps":28,"exerciseRPE":8,"reasons":["Same weight next time. The goal is to beat your total reps before adding load."],"conservative":false,"decision":"increase_reps","confidence":"high","warnings":[],"historyTrend":"insufficient_history","historySampleSize":1,"progressionMode":"double_progression","exerciseProfile":{"type":"compound","progressionMode":"double_progression","equipment":"barbell","loadType":"external","weightMode":"kg","priority":"high","loadIncrementKg":2.5,"roundToKg":2.5,"maxRpeForLoadIncrease":8.5,"volumePolicy":"protected"}},"dips":{"exerciseId":"dips","name":"Weighted Dips","sets":4,"repsMin":5,"repsMax":7,"repsLabel":"5-7","restSeconds":180,"targetRPE":8,"recommendedWeight":12.5,"previousWeight":10,"repFocus":"Own the same rep range with the heavier load.","totalReps":28,"previousTotalReps":28,"exerciseRPE":8,"reasons":["All sets reached the top of the rep range with effort in reserve - the weight goes up.","Two strong sessions in a row support this load increase."],"conservative":false,"decision":"increase_load","confidence":"high","warnings":[],"historyTrend":"insufficient_history","historySampleSize":1,"progressionMode":"double_progression","exerciseProfile":{"type":"compound","progressionMode":"double_progression","equipment":"bodyweight","loadType":"optionalexternal","weightMode":"kg","priority":"high","loadIncrementKg":2.5,"roundToKg":2.5,"maxRpeForLoadIncrease":8.5,"volumePolicy":"protected"}},"firstBadMain":{"exerciseId":"bench","name":"Bench Press","sets":4,"repsMin":5,"repsMax":7,"repsLabel":"5-7","restSeconds":180,"targetRPE":8,"recommendedWeight":60,"previousWeight":100,"repFocus":"Repeat the load once before reducing unless the same issue repeats.","totalReps":15,"previousTotalReps":null,"exerciseRPE":9.5,"reasons":["The load stays put while you build reps and keep effort inside the target range.","One difficult session usually earns a hold, not an automatic reduction."],"conservative":true,"decision":"hold","confidence":"medium","warnings":[],"historyTrend":"insufficient_history","historySampleSize":0,"progressionMode":"double_progression","exerciseProfile":{"type":"compound","progressionMode":"double_progression","equipment":"barbell","loadType":"external","weightMode":"kg","priority":"high","loadIncrementKg":2.5,"roundToKg":2.5,"maxRpeForLoadIncrease":8.5,"volumePolicy":"protected"}},"firstBadMedium":{"exerciseId":"hack-squat","name":"Hack Squat","sets":3,"repsMin":8,"repsMax":10,"repsLabel":"8-10","restSeconds":180,"targetRPE":8,"recommendedWeight":120,"previousWeight":120,"repFocus":"Repeat the load once before reducing unless the same issue repeats.","totalReps":18,"previousTotalReps":null,"exerciseRPE":9.5,"reasons":["The load stays put while you build reps and keep effort inside the target range.","One difficult session usually earns a hold, not an automatic reduction."],"conservative":true,"decision":"hold","confidence":"medium","warnings":[],"historyTrend":"insufficient_history","historySampleSize":0,"progressionMode":"double_progression","exerciseProfile":{"type":"compound","progressionMode":"double_progression","equipment":"barbell","loadType":"external","weightMode":"kg","priority":"medium","loadIncrementKg":2.5,"roundToKg":2.5,"maxRpeForLoadIncrease":8.5,"volumePolicy":"normal"}},"firstBadIsolation":{"exerciseId":"cable-curl","name":"Cable Curl","sets":3,"repsMin":10,"repsMax":12,"repsLabel":"10-12","restSeconds":60,"targetRPE":8,"recommendedWeight":25,"previousWeight":25,"repFocus":"Repeat the load once before reducing unless the same issue repeats.","totalReps":23,"previousTotalReps":null,"exerciseRPE":9.5,"reasons":["The load stays put while you build reps and keep effort inside the target range.","One difficult session usually earns a hold, not an automatic reduction."],"conservative":true,"decision":"hold","confidence":"medium","warnings":[],"historyTrend":"insufficient_history","historySampleSize":0,"progressionMode":"reps_first","exerciseProfile":{"type":"isolation","progressionMode":"reps_first","equipment":"cable","loadType":"external","weightMode":"kg","priority":"medium","loadIncrementKg":1.25,"roundToKg":1.25,"maxRpeForLoadIncrease":8.5,"volumePolicy":"normal"}},"badAfterGood":{"exerciseId":"hack-squat","name":"Hack Squat","sets":3,"repsMin":8,"repsMax":10,"repsLabel":"8-10","restSeconds":180,"targetRPE":8,"recommendedWeight":120,"previousWeight":120,"repFocus":"Repeat the load once before reducing unless the same issue repeats.","totalReps":18,"previousTotalReps":30,"exerciseRPE":9.5,"reasons":["The load stays put while you build reps and keep effort inside the target range.","One difficult session usually earns a hold, not an automatic reduction."],"conservative":true,"decision":"hold","confidence":"medium","warnings":[],"historyTrend":"insufficient_history","historySampleSize":1,"progressionMode":"double_progression","exerciseProfile":{"type":"compound","progressionMode":"double_progression","equipment":"barbell","loadType":"external","weightMode":"kg","priority":"medium","loadIncrementKg":2.5,"roundToKg":2.5,"maxRpeForLoadIncrease":8.5,"volumePolicy":"normal"}},"twoBad":{"exerciseId":"hack-squat","name":"Hack Squat","sets":3,"repsMin":8,"repsMax":10,"repsLabel":"8-10","restSeconds":180,"targetRPE":8,"recommendedWeight":112.5,"previousWeight":120,"repFocus":"Rebuild the bottom of the range with cleaner reps.","totalReps":18,"previousTotalReps":18,"exerciseRPE":9.5,"reasons":["Reps dropped under target at high effort, so the load comes down a touch to rebuild momentum.","Repeated missed targets with high RPE support a small load reduction."],"conservative":true,"decision":"reduce_load","confidence":"medium","warnings":["Repeated missed targets with high RPE showed up across recent sessions.","Repeated high exercise RPE showed up across recent sessions."],"historyTrend":"insufficient_history","historySampleSize":1,"progressionMode":"double_progression","exerciseProfile":{"type":"compound","progressionMode":"double_progression","equipment":"barbell","loadType":"external","weightMode":"kg","priority":"medium","loadIncrementKg":2.5,"roundToKg":2.5,"maxRpeForLoadIncrease":8.5,"volumePolicy":"normal"}},"painFlag":{"exerciseId":"bench","name":"Bench Press","sets":4,"repsMin":5,"repsMax":7,"repsLabel":"5-7","restSeconds":180,"targetRPE":8,"recommendedWeight":100,"previousWeight":100,"repFocus":"Stay in a pain-free range and cut a set short the moment it flares up.","totalReps":28,"previousTotalReps":28,"exerciseRPE":7,"reasons":["The load stays put while you build reps and keep effort inside the target range.","You flagged pain or discomfort here, so progression is on hold until a pain-free session is logged."],"conservative":true,"decision":"hold","confidence":"high","warnings":["Pain or discomfort was flagged on this exercise. The coach is holding progression - if it keeps showing up, lower the load, swap the movement, or get it checked."],"historyTrend":"insufficient_history","historySampleSize":1,"progressionMode":"double_progression","exerciseProfile":{"type":"compound","progressionMode":"double_progression","equipment":"barbell","loadType":"external","weightMode":"kg","priority":"high","loadIncrementKg":2.5,"roundToKg":2.5,"maxRpeForLoadIncrease":8.5,"volumePolicy":"protected"}},"redReadiness":{"exerciseId":"cable-curl","name":"Cable Curl","sets":3,"repsMin":10,"repsMax":12,"repsLabel":"10-12","restSeconds":60,"targetRPE":8,"recommendedWeight":25,"previousWeight":25,"repFocus":"Add 1 rep where form stays sharp.","totalReps":36,"previousTotalReps":null,"exerciseRPE":9,"reasons":["Same weight next time. The goal is to beat your total reps before adding load."],"conservative":true,"decision":"increase_reps","confidence":"high","warnings":[],"historyTrend":"insufficient_history","historySampleSize":0,"progressionMode":"reps_first","exerciseProfile":{"type":"isolation","progressionMode":"reps_first","equipment":"cable","loadType":"external","weightMode":"kg","priority":"medium","loadIncrementKg":1.25,"roundToKg":1.25,"maxRpeForLoadIncrease":8.5,"volumePolicy":"normal"}}}',
);

for (const [name, [exercise, session, history]] of Object.entries(CASES)) {
  const plan = progression.generateNextPlan(dayFor(exercise), session, history);
  assert.equal(plan.exercises.length, 1, `${name}: one planned exercise`);
  assert.deepEqual(
    JSON.parse(JSON.stringify(plan.exercises[0])),
    GOLDEN[name],
    `${name}: generateNextPlan output is unchanged after the v1 engine deletion`,
  );
}

// The same expectations verify-progression-h1-decisions.mjs states, restated
// so a golden refresh cannot silently accept a wrong decision.
assert.equal(GOLDEN.topSetCurrent.decision, "increase_load");
assert.equal(GOLDEN.topSetCurrent.recommendedWeight, 102.5);
assert.equal(GOLDEN.topSetHold.recommendedWeight, 100);
assert.equal(GOLDEN.regressedVsTop.previousTotalReps, 28);
assert.equal(GOLDEN.regressedVsTop.totalReps, 20);
assert.equal(GOLDEN.dips.recommendedWeight, 12.5);
assert.equal(GOLDEN.firstBadMain.decision, "hold");
assert.equal(GOLDEN.firstBadMain.recommendedWeight, 60);
assert.equal(GOLDEN.firstBadMain.conservative, true);
assert.equal(GOLDEN.firstBadMedium.decision, "hold");
assert.equal(GOLDEN.firstBadIsolation.decision, "hold");
assert.equal(GOLDEN.badAfterGood.decision, "hold");
assert.equal(GOLDEN.twoBad.decision, "reduce_load");
assert.ok(GOLDEN.twoBad.recommendedWeight < 120);
assert.equal(GOLDEN.painFlag.decision, "hold");
assert.equal(GOLDEN.painFlag.warnings[0], progression.PAIN_FLAG_WARNING);

console.log("Progression H4 retired-engine verification passed.");
