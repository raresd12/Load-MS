// Phase H4 Track A: src/lib/sessionNormalize.js (moved verbatim from
// src/App.jsx). Pins today's behaviour:
// - blank / null reps, RPE and load are not completed evidence (19.1 "Missing data");
// - RPE is 1-10 in half steps; BW text is a valid load for bodyweight work;
// - manual weight normalisation; createDraft never builds a set slot for a warm-up;
// - mergeSavedDraft keeps saved values when the plan changes the slot count (new-S);
// - createWorkoutSetLogs: ids, programExerciseId identity, no warm-up rows;
// - getExerciseLog: programId + programExerciseId identity, never a Library-id
//   fallback when a set carries a different programExerciseId (new-J).
import assert from "node:assert/strict";

const {
  calculateAutoExerciseRpe,
  createDefaultWellness,
  createDraft,
  createDraftFromStorage,
  createNeutralReadiness,
  createWorkoutSetLogs,
  getExerciseLog,
  getExerciseStorageIds,
  getPlanExercise,
  getSetRpe,
  getStoredSetupCue,
  getStoredWorkoutDraft,
  isBlank,
  isHalfStep,
  isValidRpeValue,
  isValidWeightEntry,
  mergeSavedDraft,
  normalizeExerciseLogs,
  normalizeManualWeight,
  normalizeWellness,
  numberValue,
  validateDraft,
} = await import("../src/lib/sessionNormalize.js");
const { wellnessMetrics } = await import("../src/lib/progression.js");

const metricIds = wellnessMetrics.map((metric) => metric.id);

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------
assert.equal(numberValue(null), 0);
assert.equal(numberValue(undefined, 7), 7);
assert.equal(numberValue("", NaN), NaN);
assert.equal(numberValue("abc", null), null);
assert.equal(numberValue("7.5"), 7.5);
assert.equal(numberValue(0, 9), 0, "0 is a value, not blank");

assert.equal(isBlank(""), true);
assert.equal(isBlank(null), true);
assert.equal(isBlank(undefined), true);
assert.equal(isBlank(0), false);
assert.equal(isBlank("0"), false);

assert.equal(isHalfStep(7.5), true);
assert.equal(isHalfStep(8), true);
assert.equal(isHalfStep(7.25), false);

assert.equal(isValidRpeValue(1), true);
assert.equal(isValidRpeValue(10), true);
assert.equal(isValidRpeValue("8.5"), true);
assert.equal(isValidRpeValue(0.5), false);
assert.equal(isValidRpeValue(10.5), false);
assert.equal(isValidRpeValue(8.3), false, "not a half step");
assert.equal(isValidRpeValue(""), false, "Number('') is 0");
assert.equal(isValidRpeValue(null), false);

assert.equal(getSetRpe({ rpe: "" }), null);
assert.equal(getSetRpe({ rpe: null }), null);
assert.equal(getSetRpe({ rpe: "8.5" }), 8.5);
assert.equal(getSetRpe({ rpe: 11 }), null);
assert.equal(getSetRpe({ rpe: 8.3 }), null);
assert.equal(getSetRpe(undefined), null);

assert.equal(calculateAutoExerciseRpe({ sets: [{ rpe: 8 }, { rpe: "" }, { rpe: 9 }] }), 8.5);
assert.equal(calculateAutoExerciseRpe({ sets: [{ rpe: 8 }, { rpe: 8 }, { rpe: 9 }] }), 8.3);
assert.equal(calculateAutoExerciseRpe({ sets: [{ rpe: "" }] }), null);
assert.equal(calculateAutoExerciseRpe(null), null);

// Weight entry per load type (19.1 "Analytics" BW convention).
const externalExercise = { loadType: "external" };
const bodyweightExercise = { loadType: "bodyweight" };
const optionalExercise = { loadType: "optionalExternal" };
assert.equal(isValidWeightEntry("BW", bodyweightExercise), true);
assert.equal(isValidWeightEntry("bodyweight", bodyweightExercise), true);
assert.equal(isValidWeightEntry("80", bodyweightExercise), false, "bodyweight work has no kg");
assert.equal(isValidWeightEntry("", bodyweightExercise), false);
assert.equal(isValidWeightEntry("BW", optionalExercise), true);
assert.equal(isValidWeightEntry("10", optionalExercise), true);
assert.equal(isValidWeightEntry("", optionalExercise), false);
assert.equal(isValidWeightEntry("BW", externalExercise), false);
assert.equal(isValidWeightEntry("", externalExercise), false, "blank is not 0 kg");
assert.equal(isValidWeightEntry("-1", externalExercise), false);
assert.equal(isValidWeightEntry("0", externalExercise), true);
assert.equal(isValidWeightEntry("82.5", externalExercise), true);
assert.equal(isValidWeightEntry("abc", externalExercise), false);

assert.equal(normalizeManualWeight(""), null);
assert.equal(normalizeManualWeight(null), null);
assert.equal(normalizeManualWeight(undefined), null);
assert.equal(normalizeManualWeight("abc"), null);
assert.equal(normalizeManualWeight("BW"), null, "manual plan weight is numeric only");
assert.equal(normalizeManualWeight("80"), 80);
assert.equal(normalizeManualWeight("0"), 0);
assert.equal(normalizeManualWeight(62.5), 62.5);

// Wellness.
{
  const defaults = createDefaultWellness();
  assert.deepEqual(Object.keys(defaults).sort(), [...metricIds].sort());
  assert.ok(Object.values(defaults).every((value) => value === 3));

  const normalized = normalizeWellness({ [metricIds[0]]: 7, [metricIds[1]]: 0, [metricIds[2]]: "" });
  assert.equal(normalized[metricIds[0]], 5, "clamped to 5");
  assert.equal(normalized[metricIds[1]], 1, "clamped to 1");
  assert.equal(normalized[metricIds[2]], 3, "blank -> neutral 3");
  assert.deepEqual(Object.keys(normalized).sort(), [...metricIds].sort(), "unknown keys dropped, all metrics present");
  assert.deepEqual(normalizeWellness({}), defaults);

  assert.deepEqual(createNeutralReadiness(), {
    status: "yellow",
    averageScore: 3,
    isPoor: false,
    isGood: false,
    lowMetrics: [],
    missing: true,
  });
}

// ---------------------------------------------------------------------------
// Day / plan fixtures (warm-up is informational only, handoff 3.3)
// ---------------------------------------------------------------------------
const day = {
  id: "day-1",
  name: "Day 1",
  type: "training",
  warmup: {
    items: [{ id: "wu-1", name: "Band pull-aparts", prescription: "2x15" }],
  },
  exercises: [
    {
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
      recommendedWeight: 60,
      loadType: "external",
    },
    {
      id: "pe-chin",
      programExerciseId: "pe-chin",
      libraryExerciseId: "lib-chin",
      programId: "program-a",
      name: "Chin-up",
      sets: 2,
      repsMin: 5,
      repsMax: 10,
      repsLabel: "5-10",
      targetRPE: 8,
      recommendedWeight: null,
      loadType: "bodyweight",
    },
  ],
};
const plan = {
  status: "generated",
  exercises: [
    { exerciseId: "pe-bench", sets: 4, repsLabel: "6-8", recommendedWeight: 62.5 },
    { exerciseId: "pe-chin", sets: 2, repsLabel: "5-10", recommendedWeight: null },
  ],
};

assert.equal(getPlanExercise(plan, "pe-bench").sets, 4);
assert.equal(getPlanExercise(plan, "wu-1"), undefined);
assert.equal(getPlanExercise(null, "pe-bench"), undefined);

// createDraft: one slot group per day exercise, set count from the plan.
{
  const draft = createDraft(day, plan);
  assert.deepEqual(Object.keys(draft.exercises), ["pe-bench", "pe-chin"], "no warm-up slot group");
  assert.equal(draft.exercises["pe-bench"].sets.length, 4, "plan set count wins over the target");
  assert.equal(draft.exercises["pe-chin"].sets.length, 2);
  assert.deepEqual(draft.exercises["pe-bench"].sets[0], { reps: "", weight: "", rpe: "" });
  assert.deepEqual(draft.exercises["pe-bench"], { notes: "", painFlag: false, sets: draft.exercises["pe-bench"].sets });
  assert.deepEqual(draft.wellness, createDefaultWellness());
  assert.deepEqual(draft.recoveryActivities, {});
  assert.equal(draft.recoveryNotes, "");
  assert.equal(draft.sessionRpe, "");
  assert.equal(draft.sessionNotes, "");

  const noPlan = createDraft(day, null);
  assert.equal(noPlan.exercises["pe-bench"].sets.length, 3, "target set count without a plan");

  const recoveryDay = { id: "day-r", type: "recovery", exercises: [], activities: ["Walk", "Stretch"] };
  assert.deepEqual(createDraft(recoveryDay, null).recoveryActivities, { Walk: false, Stretch: false });
}

// mergeSavedDraft keeps saved values when the slot count changes (new-S).
{
  const base = createDraft(day, plan); // bench 4 slots
  const saved = {
    exercises: {
      "pe-bench": {
        notes: " felt heavy ",
        painFlag: true,
        sets: [
          { reps: 8, weight: 60, rpe: 8 },
          { reps: 7, weight: 60, rpe: 8.5 },
        ],
      },
      "pe-removed": { notes: "gone", painFlag: false, sets: [{ reps: 1, weight: 1, rpe: 1 }] },
    },
    sessionRpe: 8,
    sessionNotes: "ok",
    recoveryActivities: { Walk: true },
  };
  const merged = mergeSavedDraft(base, saved);
  assert.equal(merged.exercises["pe-bench"].sets.length, 4, "plan slot count (4) is kept");
  assert.deepEqual(merged.exercises["pe-bench"].sets[0], { reps: 8, weight: 60, rpe: 8 });
  assert.deepEqual(merged.exercises["pe-bench"].sets[1], { reps: 7, weight: 60, rpe: 8.5 });
  assert.deepEqual(merged.exercises["pe-bench"].sets[2], { reps: "", weight: "", rpe: "" });
  assert.equal(merged.exercises["pe-bench"].notes, " felt heavy ", "notes are kept as typed");
  assert.equal(merged.exercises["pe-bench"].painFlag, true);
  assert.equal("pe-removed" in merged.exercises, false, "an exercise no longer in the day is dropped");
  assert.equal(merged.sessionRpe, 8);
  assert.equal(merged.sessionNotes, "ok");
  assert.deepEqual(merged.recoveryActivities, { Walk: true });
  assert.deepEqual(merged.wellness, base.wellness, "wellness stays the base draft's");

  // Fewer slots than saved values: the saved extra sets are dropped, the rest kept.
  const smallerPlan = { status: "generated", exercises: [{ exerciseId: "pe-bench", sets: 1 }] };
  const shrunk = mergeSavedDraft(createDraft(day, smallerPlan), saved);
  assert.equal(shrunk.exercises["pe-bench"].sets.length, 1);
  assert.deepEqual(shrunk.exercises["pe-bench"].sets[0], { reps: 8, weight: 60, rpe: 8 });

  // A saved set with only some fields keeps the blank defaults for the others.
  const partial = mergeSavedDraft(base, { exercises: { "pe-bench": { sets: [{ reps: 5 }] } } });
  assert.deepEqual(partial.exercises["pe-bench"].sets[0], { reps: 5, weight: "", rpe: "" });
  assert.equal(partial.exercises["pe-bench"].painFlag, false);

  assert.equal(mergeSavedDraft(base, null), base, "no saved draft -> base draft as is");
}

// Stored draft entries.
{
  const drafts = {
    open: { status: "in-progress", draft: { sessionRpe: 7 } },
    done: { status: "completed", draft: { sessionRpe: 9 } },
    bare: { status: "in-progress" },
  };
  assert.deepEqual(getStoredWorkoutDraft(drafts, "open"), { sessionRpe: 7 });
  assert.equal(getStoredWorkoutDraft(drafts, "done"), null, "a completed draft is never resumed");
  assert.equal(getStoredWorkoutDraft(drafts, "bare"), null);
  assert.equal(getStoredWorkoutDraft(drafts, "missing"), null);

  const fromStorage = createDraftFromStorage(day, plan, [], { key: { status: "in-progress", draft: { sessionRpe: 7 } } }, "key");
  assert.equal(fromStorage.sessionRpe, 7);
  assert.equal(fromStorage.exercises["pe-bench"].sets.length, 4);
}

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------
assert.deepEqual(getExerciseStorageIds("pe-bench"), ["pe-bench"]);
assert.deepEqual(getExerciseStorageIds(day.exercises[0]), ["pe-bench", "lib-bench"], "deduplicated, falsy ids skipped");
assert.deepEqual(
  getExerciseStorageIds({ id: "x", legacyExerciseId: "legacy-x", libraryExerciseId: "lib-x", programExerciseId: "x" }),
  ["x", "legacy-x", "lib-x"],
);
assert.equal(getStoredSetupCue({ "lib-bench": "Feet flat." }, day.exercises[0]), "Feet flat.");
assert.equal(getStoredSetupCue({}, day.exercises[0]), "");

{
  const bench = day.exercises[0];
  // Modern session: workoutSets carry programExerciseId.
  const modern = {
    workoutSets: [
      { programExerciseId: "pe-bench", exerciseId: "lib-bench", setNumber: 2, actualReps: 7, actualWeight: 60, actualRPE: 9 },
      { programExerciseId: "pe-bench", exerciseId: "lib-bench", setNumber: 1, actualReps: 8, actualWeight: 60, actualRPE: 8 },
      { programExerciseId: "pe-bench", exerciseId: "lib-bench", setNumber: 3, actualReps: null, actualWeight: null, actualRPE: null },
    ],
  };
  const log = getExerciseLog(modern, bench);
  assert.equal(log.exerciseRPE, 8.5);
  assert.equal(log.notes, "");
  assert.deepEqual(log.sets, [
    { reps: 8, weight: 60, rpe: 8 },
    { reps: 7, weight: 60, rpe: 9 },
    { reps: null, weight: null, rpe: null },
  ], "sorted by setNumber; the empty slot stays null, never 0");

  // Conflict: the same Library exercise under ANOTHER programExerciseId never matches.
  const conflict = {
    workoutSets: [
      { programExerciseId: "pe-other", exerciseId: "lib-bench", setNumber: 1, actualReps: 10, actualWeight: 100, actualRPE: 8 },
    ],
  };
  assert.equal(getExerciseLog(conflict, bench), null, "different programExerciseId is a conflict, not a fallback");

  // Legacy sets without a programExerciseId match through the Library id.
  const legacy = {
    workoutSets: [{ exerciseId: "lib-bench", setNumber: 1, actualReps: 5, actualWeight: 50, actualRPE: 7 }],
  };
  assert.deepEqual(getExerciseLog(legacy, bench).sets, [{ reps: 5, weight: 50, rpe: 7 }]);

  // Exercises map keyed by id wins over workoutSets.
  const mapped = { exercises: { "pe-bench": { notes: "n", exerciseRPE: 8, sets: [{ reps: 5, weight: 50, rpe: 8 }] } }, workoutSets: [] };
  assert.equal(getExerciseLog(mapped, bench).notes, "n");
  assert.equal(getExerciseLog(mapped, "pe-bench").notes, "n");
  assert.equal(getExerciseLog({ exercises: {} }, bench), null);
  assert.equal(getExerciseLog(null, bench), null);
}

// ---------------------------------------------------------------------------
// Save-path normalisation: blanks are not evidence (19.1 "Missing data")
// ---------------------------------------------------------------------------
{
  const draftExercises = {
    "pe-bench": {
      notes: "  strong  ",
      painFlag: 1,
      sets: [
        { reps: "8", weight: "60", rpe: "8" },
        { reps: "", weight: "", rpe: "" },
        { reps: "0", weight: "60", rpe: "10" },
      ],
    },
    "pe-chin": {
      notes: "",
      painFlag: false,
      sets: [{ reps: "6", weight: "BW", rpe: "8.5" }, { reps: "", weight: "", rpe: "" }],
    },
  };
  const logs = normalizeExerciseLogs(day, draftExercises);
  assert.deepEqual(Object.keys(logs), ["pe-bench", "pe-chin"]);
  assert.equal(logs["pe-bench"].programExerciseId, "pe-bench");
  assert.equal(logs["pe-bench"].exerciseId, "lib-bench", "Library id is carried separately");
  assert.equal(logs["pe-bench"].notes, "strong");
  assert.equal(logs["pe-bench"].painFlag, true);
  assert.equal(logs["pe-bench"].exerciseRPE, 9, "(8 + 10) / 2");
  assert.deepEqual(logs["pe-bench"].sets[0], { reps: 8, weight: 60, rpe: 8 });
  assert.deepEqual(logs["pe-bench"].sets[1], { reps: null, weight: null, rpe: null }, "blank slot is null, never 0 x 0 kg");
  assert.deepEqual(logs["pe-bench"].sets[2], { reps: 0, weight: 60, rpe: 10 }, "an explicit 0 reps stays 0");
  assert.deepEqual(logs["pe-chin"].sets[0], { reps: 6, weight: "BW", rpe: 8.5 });
  assert.equal(logs["pe-chin"].exerciseRPE, 8.5);

  const setLogs = createWorkoutSetLogs({ sessionId: "s-1", programId: "program-a", day, plan, draft: { exercises: draftExercises } });
  assert.equal(setLogs.length, 5, "one row per draft slot, no warm-up row");
  assert.ok(setLogs.every((set) => set.sessionId === "s-1" && set.programId === "program-a" && set.dayId === "day-1"));
  assert.ok(!setLogs.some((set) => set.programExerciseId === "wu-1" || set.exerciseId === "wu-1"));
  assert.deepEqual(setLogs[0], {
    sessionId: "s-1",
    programId: "program-a",
    dayId: "day-1",
    programExerciseId: "pe-bench",
    exerciseId: "lib-bench",
    setNumber: 1,
    plannedWeight: 62.5,
    plannedReps: "6-8",
    actualWeight: 60,
    actualReps: 8,
    actualRPE: 8,
    completed: true,
  });
  assert.deepEqual(
    { reps: setLogs[1].actualReps, weight: setLogs[1].actualWeight, rpe: setLogs[1].actualRPE, completed: setLogs[1].completed, n: setLogs[1].setNumber },
    { reps: null, weight: null, rpe: null, completed: false, n: 2 },
    "an untouched slot is a row that is not completed",
  );
  assert.equal(setLogs[2].completed, true, "0 reps with kg and RPE is a completed (failed) set");
  assert.equal(setLogs[3].programExerciseId, "pe-chin");
  assert.equal(setLogs[3].actualWeight, "BW");
  assert.equal(setLogs[3].plannedWeight, null);
  assert.equal(setLogs[3].completed, true);

  // Without a plan entry the planned values come from the exercise target.
  const noPlanLogs = createWorkoutSetLogs({ sessionId: "s-2", programId: null, day, plan: null, draft: { exercises: draftExercises } });
  assert.equal(noPlanLogs[0].plannedWeight, 60);
  assert.equal(noPlanLogs[0].plannedReps, "6-8");
  assert.equal(noPlanLogs[0].programId, null);
}

// ---------------------------------------------------------------------------
// validateDraft
// ---------------------------------------------------------------------------
{
  function draftWith(benchSets, sessionRpe = "8") {
    return {
      exercises: {
        "pe-bench": { notes: "", painFlag: false, sets: benchSets },
        "pe-chin": { notes: "", painFlag: false, sets: [{ reps: "", weight: "", rpe: "" }] },
      },
      sessionRpe,
    };
  }
  const blank = { reps: "", weight: "", rpe: "" };

  assert.deepEqual(validateDraft(day, draftWith([{ reps: "8", weight: "60", rpe: "8" }])), []);
  assert.deepEqual(validateDraft(day, draftWith([blank, blank])), [
    "Log at least one complete set before generating recommendations.",
  ]);
  assert.deepEqual(validateDraft(day, draftWith([blank], "")), [
    "Session RPE needs a 1-10 score.",
    "Log at least one complete set before generating recommendations.",
  ]);
  assert.deepEqual(validateDraft(day, draftWith([{ reps: "8", weight: "60", rpe: "8" }], "11")), [
    "Session RPE needs a 1-10 score.",
  ]);
  assert.deepEqual(validateDraft(day, draftWith([{ reps: "8", weight: "", rpe: "" }])), [
    "Bench Press set 1: enter kg or BW.",
    "Bench Press set 1: enter set RPE.",
    "Log at least one complete set before generating recommendations.",
  ]);
  assert.deepEqual(validateDraft(day, draftWith([{ reps: "", weight: "60", rpe: "" }])), [
    "Bench Press set 1: kg/BW was entered without reps.",
    "Log at least one complete set before generating recommendations.",
  ]);
  assert.deepEqual(validateDraft(day, draftWith([{ reps: "", weight: "", rpe: "8" }])), [
    "Bench Press set 1: set RPE was entered without reps.",
    "Log at least one complete set before generating recommendations.",
  ]);
  assert.deepEqual(validateDraft(day, draftWith([{ reps: "8", weight: "60", rpe: "8.3" }])), [
    "Bench Press set 1: set RPE must be 1-10 in .5 steps.",
  ]);
  assert.deepEqual(validateDraft(day, draftWith([{ reps: "-1", weight: "60", rpe: "8" }])), [
    "Bench Press set 1: reps must be 0 or higher.",
  ]);
  assert.deepEqual(validateDraft(day, draftWith([{ reps: "8", weight: "BW", rpe: "8" }])), [
    "Bench Press set 1: enter kg or BW.",
    "Bench Press set 1: enter a valid kg value or BW.",
  ], "BW is not a load for an external-load exercise");
  assert.deepEqual(validateDraft(day, draftWith([{ reps: "0", weight: "60", rpe: "10" }])), [], "a failed attempt is a complete set");

  // Bodyweight exercise accepts BW only.
  const chinDraft = {
    exercises: {
      "pe-bench": { notes: "", painFlag: false, sets: [blank] },
      "pe-chin": { notes: "", painFlag: false, sets: [{ reps: "6", weight: "BW", rpe: "8" }] },
    },
    sessionRpe: "7",
  };
  assert.deepEqual(validateDraft(day, chinDraft), []);
  chinDraft.exercises["pe-chin"].sets[0].weight = "20";
  assert.deepEqual(validateDraft(day, chinDraft), [
    "Chin-up set 1: enter kg or BW.",
    "Chin-up set 1: enter a valid kg value or BW.",
  ]);

  // Recovery day: only the session RPE matters.
  const recoveryDay = { id: "day-r", type: "recovery", exercises: [] };
  assert.deepEqual(validateDraft(recoveryDay, { exercises: {}, sessionRpe: "5" }), []);
  assert.deepEqual(validateDraft(recoveryDay, { exercises: {}, sessionRpe: "" }), ["Session RPE needs a 1-10 score."]);
}

console.log("Session normalize verification passed.");
