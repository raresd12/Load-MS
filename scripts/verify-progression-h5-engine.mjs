// Phase H5 Track A, engine side of decisions H5-2 (time / distance
// progression), H5-3 (profile overrides, program aggression), H5-4
// (equipment-realistic increments) and H5-6 (a held exercise in the plan).
// Pure: generateNextPlan is called with plain objects, nothing reads storage.
import assert from "node:assert/strict";
import {
  buildExerciseProfile,
  DUMBBELL_STEP_BANDS_KG,
  EQUIPMENT_STEPS_KG,
  generateNextPlan,
  getDumbbellStep,
  increaseMeasurementRange,
  MEASUREMENT_PROGRESSION,
  PROGRESSION_MODES,
  resolveEquipmentClass,
  resolveLoadIncrement,
  roundLoadForProfile,
  roundToEquipment,
} from "../src/lib/progression.js";
import { computeSessionAdherence } from "../src/lib/adherence.js";

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

function dayFor(targetExercise, extra = {}) {
  return { id: "h5-day", name: "H5 Day", type: "lifting", exercises: [targetExercise], ...extra };
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
  sets,
  rpe = 8,
  sessionRpe = 8,
  readiness = { status: "green", averageScore: 4.3, isGood: true, isPoor: false },
  date = "2026-02-10T10:00:00.000Z",
}) {
  return {
    id,
    date,
    programId: "h5-program",
    dayId: "h5-day",
    dayName: "H5 Day",
    sessionRpe,
    readiness,
    plannedExercises: { exercises: { [targetExercise.id]: plannedExercise(targetExercise) } },
    exercises: {
      [targetExercise.id]: {
        programExerciseId: targetExercise.id,
        exerciseId: targetExercise.id,
        exerciseRPE: rpe,
        sets: sets.map((set) => ({ rpe, ...set })),
      },
    },
  };
}

function repsSets(reps, weight) {
  return reps.map((value) => ({ reps: value, weight }));
}

function plan(targetExercise, current, previous = [], options = undefined, dayExtra = {}) {
  return generateNextPlan(dayFor(targetExercise, dayExtra), current, previous, options);
}

function recommendation(targetExercise, current, previous = [], options = undefined, dayExtra = {}) {
  return plan(targetExercise, current, previous, options, dayExtra).exercises[0];
}

// ---------------------------------------------------------------------------
// H5-2: time_first / distance_first.
// ---------------------------------------------------------------------------
assert.ok(PROGRESSION_MODES.includes("time_first") && PROGRESSION_MODES.includes("distance_first"));
assert.deepEqual(MEASUREMENT_PROGRESSION.time, { stepUnder60: 5, stepFrom60: 10, threshold: 60, max: 600 });
assert.deepEqual(increaseMeasurementRange("time", 45, 60), { min: 55, max: 70, step: 10 }, "from 60 s the step is 10 s");
assert.deepEqual(increaseMeasurementRange("time", 30, 30), { min: 35, max: 35, step: 5 }, "under 60 s the step is 5 s");
assert.deepEqual(increaseMeasurementRange("time", 55, 55), { min: 60, max: 60, step: 5 });
assert.equal(increaseMeasurementRange("time", 590, 600), null, "capped at 600 s per set");
assert.deepEqual(increaseMeasurementRange("time", 595, 595), { min: 600, max: 600, step: 5 }, "the last step stops at the cap");
assert.deepEqual(increaseMeasurementRange("distance", 400, 400), { min: 450, max: 450, step: 50 }, "+10 % rounded to 25 m");
assert.deepEqual(increaseMeasurementRange("distance", 100, 100), { min: 125, max: 125, step: 25 }, "at least 25 m");
assert.deepEqual(increaseMeasurementRange("distance", 1000, 1000), { min: 1100, max: 1100, step: 100 });
assert.equal(increaseMeasurementRange("distance", 10000, 10000), null, "capped at 10,000 m");
assert.equal(increaseMeasurementRange("time", null, null), null);

const plank = exercise({
  id: "plank",
  name: "Plank",
  category: "core",
  equipment: "bodyweight",
  progressionType: "core",
  repsMin: 45,
  repsMax: 60,
  repsLabel: "45-60 s",
  recommendedWeight: null,
  loadType: "bodyweight",
});
const plankUp = recommendation(plank, sessionFor({ id: "c", targetExercise: plank, sets: [{ seconds: 60 }, { seconds: 60 }, { seconds: 60 }], rpe: 7 }));
assert.equal(plankUp.progressionMode, "time_first");
assert.equal(plankUp.decision, "increase_time");
assert.equal(plankUp.repsMin, 55);
assert.equal(plankUp.repsMax, 70);
assert.equal(plankUp.repsLabel, "55-70 s");
assert.equal(plankUp.recommendedWeight, null, "bodyweight-only: never a load");
assert.equal(plankUp.exerciseProfile.measurement, "time");
assert.equal(plankUp.exerciseProfile.unit, "s");
assert.ok(plankUp.reasons.some((reason) => /time/i.test(reason)), "the coach reason talks about time");

const plankShort = recommendation(plank, sessionFor({ id: "c", targetExercise: plank, sets: [{ seconds: 60 }, { seconds: 50 }, { seconds: 45 }], rpe: 8 }));
assert.equal(plankShort.decision, "hold", "not every set at the top: hold the target");
assert.equal(plankShort.repsMax, 60);
assert.equal(plankShort.repsLabel, "45-60 s");

const plankRed = recommendation(
  plank,
  sessionFor({
    id: "c",
    targetExercise: plank,
    sets: [{ seconds: 60 }, { seconds: 60 }, { seconds: 60 }],
    rpe: 7,
    readiness: { status: "red", averageScore: 2, isGood: false, isPoor: true },
  }),
);
assert.equal(plankRed.decision, "hold", "red readiness never steps the time up");
assert.equal(plankRed.repsMax, 60);

const plankLegacy = recommendation(plank, sessionFor({ id: "c", targetExercise: plank, sets: repsSets([60, 60, 60], null), rpe: 7 }));
assert.equal(plankLegacy.decision, "increase_time", "an old session that logged the seconds under `reps` still counts as logged");

const capped = exercise({ ...plank, id: "long-hold", repsMin: 600, repsMax: 600, repsLabel: "600 s" });
const cappedResult = recommendation(capped, sessionFor({ id: "c", targetExercise: capped, sets: [{ seconds: 600 }, { seconds: 600 }, { seconds: 600 }], rpe: 6 }));
assert.equal(cappedResult.decision, "hold", "at the cap the time is held");
assert.equal(cappedResult.repsMax, 600);

const carry = exercise({
  id: "farmer-carry",
  name: "Farmer Carry",
  category: "compound",
  equipment: "dumbbell",
  progressionType: "strength",
  repsMin: 40,
  repsMax: 40,
  repsLabel: "40 m",
  recommendedWeight: 30,
  weightMode: "per dumbbell",
});
const carryUp = recommendation(carry, sessionFor({ id: "c", targetExercise: carry, sets: [{ meters: 40, weight: 30 }, { meters: 40, weight: 30 }, { meters: 40, weight: 30 }], rpe: 7 }));
assert.equal(carryUp.progressionMode, "distance_first");
assert.equal(carryUp.decision, "increase_distance");
assert.equal(carryUp.repsMin, 65, "+25 m minimum step (10 % of 40 m rounds to 0, floor 25 m)");
assert.equal(carryUp.repsMax, 65);
assert.equal(carryUp.repsLabel, "65 m");
assert.equal(carryUp.recommendedWeight, 30, "the load never changes in a measurement mode");
assert.equal(carryUp.exerciseProfile.measurement, "distance");

// perSide only changes the wording.
const sidePlank = exercise({ ...plank, id: "side-plank", repsMin: 30, repsMax: 30, repsLabel: "30 s/side" });
const sideUp = recommendation(sidePlank, sessionFor({ id: "c", targetExercise: sidePlank, sets: [{ seconds: 30 }, { seconds: 30 }, { seconds: 30 }], rpe: 7 }));
assert.equal(sideUp.decision, "increase_time");
assert.equal(sideUp.repsMax, 35, "the per-side value moves, not the total");
assert.equal(sideUp.repsLabel, "35 s/side");
assert.equal(sideUp.exerciseProfile.perSide, true);

// A stored measurement wins over a label that looks like reps.
const storedTime = exercise({ ...plank, id: "stored-time", measurement: "time", repsMin: 30, repsMax: 30, repsLabel: "30" });
assert.equal(recommendation(storedTime, sessionFor({ id: "c", targetExercise: storedTime, sets: [{ seconds: 30 }, { seconds: 30 }, { seconds: 30 }], rpe: 7 })).progressionMode, "time_first");

// ---------------------------------------------------------------------------
// H5-4: equipment-realistic increments and rounding.
// ---------------------------------------------------------------------------
assert.deepEqual(EQUIPMENT_STEPS_KG, { barbell: 2.5, smith: 2.5, machine: 2.5, selectorized: 5, cable: 2.5, kettlebell: 4, additional: 2.5 });
assert.deepEqual(
  DUMBBELL_STEP_BANDS_KG.map((band) => [band.below, band.step]),
  [[10, 1], [30, 2], [Infinity, 2.5]],
);
assert.equal(resolveEquipmentClass({ equipment: "Dumbbells, bench" }), "dumbbell");
assert.equal(resolveEquipmentClass({ equipment: "Smith machine" }), "smith");
assert.equal(resolveEquipmentClass({ equipment: "Cable machine, rope attachment" }), "cable");
assert.equal(resolveEquipmentClass({ equipment: "Selectorized stack" }), "selectorized");
assert.equal(resolveEquipmentClass({ equipment: "Leg press (plate-loaded)" }), "machine");
assert.equal(resolveEquipmentClass({ equipment: "Kettlebell" }), "kettlebell");
assert.equal(resolveEquipmentClass({ equipment: "Barbell, rack" }), "barbell");
assert.equal(resolveEquipmentClass({ equipment: "Pull-up bar" }), "bodyweight");
assert.equal(resolveEquipmentClass({}), "unknown");

assert.equal(getDumbbellStep(8), 1);
assert.equal(getDumbbellStep(10), 2);
assert.equal(getDumbbellStep(29.9), 2);
assert.equal(getDumbbellStep(30), 2.5);
assert.equal(getDumbbellStep(null), null);

const table = [
  [{ equipment: "barbell" }, 2.5],
  [{ equipment: "Smith machine" }, 2.5],
  [{ equipment: "Leg press machine" }, 2.5],
  [{ equipment: "Cable machine" }, 2.5],
  [{ equipment: "Selectorized stack", category: "isolation" }, 5],
  [{ equipment: "Kettlebell" }, 4],
  [{ equipment: "dumbbell", recommendedWeight: 8 }, 1],
  [{ equipment: "dumbbell", recommendedWeight: 20 }, 2],
  [{ equipment: "dumbbell", recommendedWeight: 32.5 }, 2.5],
  [{ equipment: "dumbbell", recommendedWeight: null, category: "compound" }, 2],
  [{ equipment: "dumbbell", recommendedWeight: null, category: "isolation" }, 1],
  [{ equipment: "bodyweight", loadType: "bodyweight" }, null],
  [{ equipment: "bodyweight", loadType: "optionalExternal", weightMode: "additional load", recommendedWeight: 10 }, 2.5],
  [{ equipment: "barbell", incrementKg: 1.25 }, 1.25],
  [{ equipment: "dumbbell", recommendedWeight: 20, profileOverrides: { incrementKg: 4 } }, 4],
];
table.forEach(([fields, expected]) => {
  const candidate = exercise({ id: "t", name: "Table", ...fields });
  assert.equal(resolveLoadIncrement(candidate), expected, `increment for ${JSON.stringify(fields)}`);
  assert.equal(buildExerciseProfile(candidate).loadIncrementKg, expected);
});

assert.equal(buildExerciseProfile(exercise({ equipment: "barbell", incrementKg: 2.5, roundToKg: 2.5 })).fieldSources.incrementKg, "config");
assert.equal(buildExerciseProfile(exercise({ equipment: "barbell" })).fieldSources.incrementKg, "classified");
assert.equal(buildExerciseProfile(exercise({ equipment: "barbell", profileOverrides: { incrementKg: 5 } })).fieldSources.incrementKg, "override");

// Dumbbell rounding never lands on a weight that does not exist.
assert.equal(roundToEquipment(13, { equipmentClass: "dumbbell" }), 14);
assert.equal(roundToEquipment(21.25, { equipmentClass: "dumbbell" }), 22);
assert.equal(roundToEquipment(9.4, { equipmentClass: "dumbbell" }), 9);
assert.equal(roundToEquipment(31, { equipmentClass: "dumbbell" }), 30);
assert.equal(roundToEquipment(21.25, { equipmentClass: "dumbbell", mode: "floor" }), 20);
assert.equal(roundToEquipment(13, { equipmentClass: "barbell", step: 2.5 }), 12.5);
assert.equal(roundToEquipment(13, { equipmentClass: "dumbbell", step: 1 }), 13, "an explicit step is respected as it is");

function increaseDumbbell(weight, extra = {}) {
  const db = exercise({ id: "db-press", name: "Flat Dumbbell Press", equipment: "Dumbbells, bench", weightMode: "per dumbbell", recommendedWeight: weight, ...extra });
  const prev = sessionFor({ id: "prev", targetExercise: db, sets: repsSets([10, 10, 10], weight), rpe: 8, date: "2026-02-03T10:00:00.000Z" });
  const current = sessionFor({ id: "cur", targetExercise: db, sets: repsSets([10, 10, 10], weight), rpe: 8 });
  return recommendation(db, current, [prev]);
}

const bandChecks = [
  [8, 9],
  [9, 10],
  [10, 12],
  [12, 14],
  [20, 22],
  [28, 30],
  [29, 30],
  [30, 32.5],
  [35, 37.5],
];
// Off-grid loads stored before the bands (H5-38): one increase is at most
// one step, onto the first grid point above (13 -> 14, not 13 + 2 = 15 -> 16).
[
  [13, 14],
  [12.5, 14],
  [15, 16],
  [11, 12],
].forEach(([from, expected]) => {
  const result = increaseDumbbell(from);
  assert.equal(result.decision, "increase_load", `off-grid dumbbells ${from} kg step up`);
  assert.equal(result.recommendedWeight, expected, `off-grid dumbbells ${from} -> ${expected}`);
});
bandChecks.forEach(([from, expected]) => {
  const result = increaseDumbbell(from);
  assert.equal(result.decision, "increase_load", `dumbbells ${from} kg step up`);
  assert.equal(result.recommendedWeight, expected, `dumbbells ${from} -> ${expected}`);
  assert.notEqual(result.recommendedWeight, 13);
  assert.notEqual(result.recommendedWeight, 21.25);
});

// Default programs keep their explicit incrementKg / roundToKg: the H4
// incline dumbbell press config (2 / 1) goes 29 -> 31, not to a band value.
const defaultStyle = increaseDumbbell(29, { incrementKg: 2, roundToKg: 1 });
assert.equal(defaultStyle.recommendedWeight, 31);
assert.equal(defaultStyle.exerciseProfile.loadIncrementKg, 2);
assert.equal(defaultStyle.exerciseProfile.fieldSources.incrementKg, "config");
assert.equal(defaultStyle.exerciseProfile.fieldSources.roundToKg, "config");

const kettlebell = exercise({ id: "kb-swing", name: "Kettlebell Swing", equipment: "Kettlebell", recommendedWeight: 24, repsMin: 10, repsMax: 15, repsLabel: "10-15" });
const kbResult = recommendation(
  kettlebell,
  sessionFor({ id: "cur", targetExercise: kettlebell, sets: repsSets([15, 15, 15], 24), rpe: 7.5 }),
  [sessionFor({ id: "prev", targetExercise: kettlebell, sets: repsSets([15, 15, 15], 24), rpe: 7.5, date: "2026-02-03T10:00:00.000Z" })],
);
assert.equal(kbResult.recommendedWeight, 28, "kettlebells step by 4 kg");

const stackProfile = buildExerciseProfile(exercise({ id: "row", equipment: "Selectorized stack", recommendedWeight: 45 }));
assert.equal(roundLoadForProfile(stackProfile, 47), 45, "selectorized rounds to 5 kg");
assert.equal(roundLoadForProfile(stackProfile, 48), 50);
assert.equal(roundLoadForProfile(buildExerciseProfile(exercise({ id: "lp", equipment: "Leg press", roundToKg: 5 })), 47), 45, "an explicit roundToKg wins");

// ---------------------------------------------------------------------------
// H5-3: profile overrides and program aggression.
// ---------------------------------------------------------------------------
const overridden = buildExerciseProfile(
  exercise({
    id: "bench",
    name: "Bench Press",
    priority: "high",
    progressionType: "strength",
    profileOverrides: { progressionMode: "reps_first", incrementKg: 5, roundToKg: 5, rpeMaxForLoadIncrease: 7, priority: "accessory", canIncreaseLoad: false },
  }),
);
assert.equal(overridden.progressionMode, "reps_first");
assert.equal(overridden.loadIncrementKg, 5);
assert.equal(overridden.roundToKg, 5);
assert.equal(overridden.rpePolicy.maxForLoadIncrease, 7);
assert.equal(overridden.role, "accessory");
assert.equal(overridden.progressionCaps.canIncreaseLoad, false);
assert.deepEqual(overridden.fieldSources, {
  progressionMode: "override",
  incrementKg: "override",
  roundToKg: "override",
  rpeMaxForLoadIncrease: "override",
  priority: "override",
  canIncreaseLoad: "override",
});
const classified = buildExerciseProfile(exercise({ id: "bench", name: "Bench Press", priority: "high", progressionType: "strength", roundToKg: 2.5 }));
assert.equal(classified.role, "main");
assert.deepEqual(classified.fieldSources, {
  progressionMode: "classified",
  incrementKg: "classified",
  roundToKg: "config",
  rpeMaxForLoadIncrease: "classified",
  priority: "classified",
  canIncreaseLoad: "classified",
});
const ignored = buildExerciseProfile(exercise({ id: "x", profileOverrides: { progressionMode: "not-a-mode", incrementKg: -1, priority: "top" } }));
const plain = buildExerciseProfile(exercise({ id: "x" }));
assert.equal(ignored.progressionMode, plain.progressionMode, "invalid override values are ignored");
assert.equal(ignored.loadIncrementKg, plain.loadIncrementKg);
assert.equal(ignored.role, plain.role);
assert.equal(ignored.fieldSources.progressionMode, "classified");

const bench = exercise({ id: "bench", name: "Bench Press", priority: "high", progressionType: "strength", sets: 4, repsMin: 5, repsMax: 7, repsLabel: "5-7", recommendedWeight: 100, roundToKg: 2.5 });
const benchPrev = sessionFor({ id: "prev", targetExercise: bench, sets: repsSets([7, 7, 7, 7], 100), rpe: 8, date: "2026-02-03T10:00:00.000Z" });
const benchNow = sessionFor({ id: "cur", targetExercise: bench, sets: repsSets([7, 7, 7, 7], 100), rpe: 8 });
assert.equal(recommendation(bench, benchNow, [benchPrev]).recommendedWeight, 102.5);
assert.equal(recommendation({ ...bench, profileOverrides: { incrementKg: 5 } }, benchNow, [benchPrev]).recommendedWeight, 105, "incrementKg override");
assert.equal(recommendation({ ...bench, profileOverrides: { incrementKg: 4, roundToKg: 5 } }, benchNow, [benchPrev]).recommendedWeight, 105, "roundToKg override");
const cappedRpe = recommendation({ ...bench, profileOverrides: { rpeMaxForLoadIncrease: 7 } }, benchNow, [benchPrev]);
assert.notEqual(cappedRpe.decision, "increase_load", "RPE 8 is above the overridden max of 7");
assert.equal(cappedRpe.recommendedWeight, 100);
const noIncrease = recommendation({ ...bench, profileOverrides: { canIncreaseLoad: false } }, benchNow, [benchPrev]);
assert.notEqual(noIncrease.decision, "increase_load");
assert.equal(noIncrease.recommendedWeight, 100);
assert.equal(noIncrease.exerciseProfile.fieldSources.canIncreaseLoad, "override");
assert.equal(recommendation({ ...bench, profileOverrides: { progressionMode: "reps_first" } }, benchNow, [benchPrev]).progressionMode, "reps_first");

// Aggression: conservative caps at hold-or-one-step and needs two strong
// sessions in a row before stepping up.
const curl = exercise({ id: "cable-curl", name: "Cable Curl", category: "isolation", equipment: "cable", progressionType: "pump", repsMin: 10, repsMax: 12, repsLabel: "10-12", recommendedWeight: 25 });
const curlStrong = sessionFor({ id: "cur", targetExercise: curl, sets: repsSets([12, 12, 12], 25), rpe: 8 });
const curlStrongPrev = sessionFor({ id: "prev", targetExercise: curl, sets: repsSets([12, 12, 12], 25), rpe: 8, date: "2026-02-03T10:00:00.000Z" });
const curlStandard = recommendation(curl, curlStrong);
assert.equal(curlStandard.decision, "increase_load", "standard: one strong session steps the load up");
assert.equal(curlStandard.exerciseProfile.aggression, "standard");
const curlConservative = recommendation(curl, curlStrong, [], { programProfile: { aggression: "conservative", unit: "kg" } });
assert.notEqual(curlConservative.decision, "increase_load", "conservative: not on the first strong session");
assert.equal(curlConservative.recommendedWeight, 25);
assert.equal(curlConservative.conservative, true);
assert.equal(curlConservative.exerciseProfile.aggression, "conservative");
assert.ok(curlConservative.reasons.some((reason) => /conservative/i.test(reason)));
const curlConservativeTwo = recommendation(curl, curlStrong, [curlStrongPrev], { programProfile: { aggression: "conservative", unit: "kg" } });
assert.equal(curlConservativeTwo.decision, "increase_load", "conservative: the second strong session in a row steps up");
assert.equal(curlConservativeTwo.recommendedWeight, curlStandard.recommendedWeight, "one step, the same step");
assert.equal(
  recommendation(curl, curlStrong, [], undefined, { programProfile: { aggression: "conservative", unit: "kg" } }).conservative,
  true,
  "the day view model's programProfile is the fallback",
);

const curlMissed = sessionFor({ id: "cur", targetExercise: curl, sets: repsSets([6, 5, 5], 25), rpe: 9.5 });
const missedPrev = (id, date) => sessionFor({ id, targetExercise: curl, sets: repsSets([6, 5, 5], 25), rpe: 9.5, date });
assert.equal(recommendation(curl, curlMissed).decision, "hold", "one missed high-RPE session is a hold (new-D)");
const missedStandard = recommendation(curl, curlMissed, [missedPrev("p1", "2026-02-07T10:00:00.000Z")]);
assert.equal(missedStandard.decision, "reduce_load", "standard: two missed high-RPE sessions in a row reduce");
const missedConservative = recommendation(curl, curlMissed, [missedPrev("p1", "2026-02-07T10:00:00.000Z")], { programProfile: { aggression: "conservative", unit: "kg" } });
assert.equal(missedConservative.decision, "hold", "conservative: doubles the reduction sample");
assert.equal(missedConservative.recommendedWeight, 25);
assert.equal(missedConservative.conservative, true);
const missedConservativeThree = recommendation(curl, curlMissed, [missedPrev("p1", "2026-02-07T10:00:00.000Z"), missedPrev("p2", "2026-02-03T10:00:00.000Z")], { programProfile: { aggression: "conservative", unit: "kg" } });
assert.equal(missedConservativeThree.decision, "reduce_load", "conservative: the same miss three sessions in a row reduces");

// ---------------------------------------------------------------------------
// H5-6: a held exercise in the plan.
// ---------------------------------------------------------------------------
const hold = { id: "override:bench", programId: "h5-program", programExerciseId: "bench", mode: "hold", prescription: null, remainingSessions: 2, untilDate: null, note: "Shoulder is cranky" };
const heldPlan = plan(bench, benchNow, [benchPrev], { overrides: [hold] });
const held = heldPlan.exercises[0];
assert.equal(held.held, true);
assert.equal(held.decision, "hold");
assert.equal(held.reasons[0], "Held by you");
assert.equal(held.reasons[1], "Note: Shoulder is cranky");
assert.equal(held.recommendedWeight, 100, "the current prescription is repeated");
assert.equal(held.sets, 4);
assert.equal(held.repsLabel, "5-7");
assert.equal(held.overrideMode, "hold");
assert.equal(held.overrideRemainingSessions, 2);
assert.equal(held.historySampleSize, 0, "no progression evidence");
assert.equal(heldPlan.status, "generated");
assert.equal(plan(bench, benchNow, [benchPrev], { overrides: { bench: hold } }).exercises[0].held, true, "map form");
assert.equal(plan({ ...bench, override: hold }, benchNow, [benchPrev]).exercises[0].held, true, "day view model form");
assert.equal(plan(bench, benchNow, [benchPrev], { overrides: [{ ...hold, remainingSessions: 0 }] }).exercises[0].held, undefined, "an exhausted hold is ignored");
assert.equal(plan(bench, benchNow, [benchPrev], { overrides: [{ ...hold, untilDate: "2026-02-01" }] }).exercises[0].held, undefined, "a hold past its date (at the session date) is ignored");
const manual = { ...hold, mode: "manual", prescription: { targetWeight: 90 } };
const manualPlanEntry = plan(bench, benchNow, [benchPrev], { overrides: [manual] }).exercises[0];
assert.equal(manualPlanEntry.held, undefined, "a manual override does not freeze the engine");
assert.equal(manualPlanEntry.decision, "increase_load");

// ---------------------------------------------------------------------------
// H5-9 (engine side, decision H5-32): a minimal session is thin evidence.
// Three sessions in a row with 1 of 6 planned sets logged never lower a
// target because the session was short: the logged exercise holds, the
// skipped one is insufficient_data with its targets repeated. A reduction
// still needs the usual evidence ON the logged sets (new-D: reps under the
// target at a high RPE in consecutive sessions) and then touches only the
// exercise that was logged.
// ---------------------------------------------------------------------------
{
  const press = exercise({ id: "min-press", name: "Press", recommendedWeight: 50 });
  const cableCurl = exercise({ id: "min-curl", name: "Cable Curl", category: "isolation", equipment: "cable", recommendedWeight: 25, repsMin: 10, repsMax: 12, repsLabel: "10-12" });
  const minimalDay = { id: "h5-day", name: "H5 Day", type: "lifting", exercises: [press, cableCurl] };
  const blank = { reps: null, weight: null, rpe: null };
  const minimalSession = (id, date, loggedSet, rpe) => ({
    id,
    date,
    programId: "h5-program",
    dayId: "h5-day",
    dayName: "H5 Day",
    sessionRpe: rpe,
    readiness: { status: "green", averageScore: 4.3, isGood: true, isPoor: false },
    // The stored snapshot shape (buildPlannedExercisesSnapshot): a map by exercise id.
    plannedExercises: { [press.id]: plannedExercise(press), [cableCurl.id]: plannedExercise(cableCurl) },
    exercises: {
      [press.id]: { programExerciseId: press.id, exerciseId: press.id, exerciseRPE: rpe, sets: [{ rpe, ...loggedSet }, blank, blank] },
      [cableCurl.id]: { programExerciseId: cableCurl.id, exerciseId: cableCurl.id, exerciseRPE: null, sets: [blank, blank, blank] },
    },
  });
  const threeMinimal = (loggedSet, rpe) => [
    minimalSession("min-3", "2026-02-10T10:00:00.000Z", loggedSet, rpe),
    minimalSession("min-2", "2026-02-07T10:00:00.000Z", loggedSet, rpe),
    minimalSession("min-1", "2026-02-04T10:00:00.000Z", loggedSet, rpe),
  ];
  const REDUCTIONS = ["reduce_load", "reduce_volume", "reduce_sets", "reduce_reps", "deload"];

  [
    ["in range", { reps: 8, weight: 50 }, 8],
    ["top of the range", { reps: 10, weight: 50 }, 7],
  ].forEach(([label, loggedSet, rpe]) => {
    const [current, ...previous] = threeMinimal(loggedSet, rpe);
    const adherence = computeSessionAdherence({ session: current, exercises: minimalDay.exercises });
    assert.equal(adherence.status, "minimal", `${label}: 1 of 6 planned sets is a minimal session`);
    assert.equal(adherence.plannedSets, 6);
    assert.equal(adherence.countedSets, 1);

    const minimalPlan = generateNextPlan(minimalDay, current, previous);
    const [pressEntry, curlEntry] = minimalPlan.exercises;
    assert.equal(pressEntry.decision, "hold", `${label}: the logged exercise holds`);
    assert.equal(curlEntry.decision, "insufficient_data", `${label}: the skipped exercise is no evidence`);
    // A lift that was not logged at all does not warn about its RPE (the
    // smoke run saw "Exercise RPE was unavailable" on skipped lifts); a
    // logged lift with an RPE does not either.
    const RPE_WARNING = "Exercise RPE was unavailable, so load progression stayed conservative.";
    assert.ok(!curlEntry.warnings.includes(RPE_WARNING), `${label}: no RPE warning for a skipped exercise`);
    assert.ok(!pressEntry.warnings.includes(RPE_WARNING), `${label}: no RPE warning when the RPE was logged`);
    minimalPlan.exercises.forEach((entry, index) => {
      const source = minimalDay.exercises[index];
      assert.ok(!REDUCTIONS.includes(entry.decision), `${label}: ${source.name} is not reduced`);
      assert.equal(entry.recommendedWeight, source.recommendedWeight, `${label}: ${source.name} keeps its load`);
      assert.equal(entry.sets, source.sets, `${label}: ${source.name} keeps its set count`);
      assert.equal(entry.repsMin, source.repsMin, `${label}: ${source.name} keeps its rep floor`);
      assert.equal(entry.repsMax, source.repsMax, `${label}: ${source.name} keeps its rep ceiling`);
    });
  });

  // Not "because it was short": the same miss at RPE 9.5 on the one logged
  // set, three sessions in a row, is the ordinary new-D evidence. Only the
  // logged exercise moves; the skipped one keeps every target.
  const [missedCurrent, ...missedPrevious] = threeMinimal({ reps: 6, weight: 50 }, 9.5);
  assert.equal(computeSessionAdherence({ session: missedCurrent, exercises: minimalDay.exercises }).status, "minimal");
  assert.equal(generateNextPlan(minimalDay, missedCurrent, []).exercises[0].decision, "hold", "one minimal bad session alone never reduces (new-D)");
  const [missedPress, missedCurl] = generateNextPlan(minimalDay, missedCurrent, missedPrevious).exercises;
  assert.equal(missedPress.decision, "reduce_load", "repeated misses on the logged sets are evidence of their own");
  assert.equal(missedPress.sets, 3, "the set count is not cut");
  assert.equal(missedCurl.decision, "insufficient_data");
  assert.equal(missedCurl.recommendedWeight, 25, "the skipped exercise keeps its load");
  assert.equal(missedCurl.sets, 3);
}

// The engine never rewrites its inputs.
const frozenBefore = JSON.stringify([benchNow, benchPrev, bench, hold]);
plan(bench, benchNow, [benchPrev], { overrides: [hold], programProfile: { aggression: "conservative", unit: "kg" } });
recommendation(carry, sessionFor({ id: "c", targetExercise: carry, sets: [{ meters: 40, weight: 30 }, { meters: 40, weight: 30 }, { meters: 40, weight: 30 }], rpe: 7 }));
assert.equal(JSON.stringify([benchNow, benchPrev, bench, hold]), frozenBefore, "sessions and exercises are byte-identical after planning");

console.log("Progression H5 engine verification passed.");
