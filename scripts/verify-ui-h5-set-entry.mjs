// Phase H5 UI track, decision H5-13: set entry by measurement.
// src/lib/setEntryView.js decides, per exercise profile, which draft field
// the Save Set form edits (reps / seconds / meters), its label, stepper and
// placeholder, how the load field behaves (Kg, "+kg" for an optional load,
// no field for bodyweight, "per dumbbell"), and how saved sets are
// summarised ("10/side", "30 s", "x2 for volume"). Old reps-only drafts of a
// timed exercise stay reps sets. The save-path normalisation
// (src/lib/sessionNormalize.js) persists seconds / meters and the profile.
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
  ADDITIONAL_LOAD_NOTE,
  PER_DUMBBELL_NOTE,
  PER_SIDE_NOTE,
  formatSetEntrySummary,
  formatSetEntryTotals,
  formatSetTargetLabel,
  formatSetValueText,
  formatSetWeightText,
  getSetEntryDefaults,
  getSetEntryLabels,
  getSetEntryProfile,
  getSetValueKey,
  hasSetEntryValue,
  readDraftSetValue,
  readSetEntryValues,
  toDraftSetPatch,
  validateSetEntryValues,
} = await import("../src/lib/setEntryView.js");
const {
  createDraft,
  createWorkoutSetLogs,
  getDraftSetCount,
  getExerciseLog,
  mergeSavedDraft,
  normalizeExerciseLogs,
  validateDraft,
} = await import("../src/lib/sessionNormalize.js");
const { buildDraftFromSession, rebuildSessionFromEdits, buildPlannedExercisesSnapshot } = await import("../src/lib/sessionEdit.js");

const bench = {
  id: "pe-bench",
  programExerciseId: "pe-bench",
  libraryExerciseId: "lib-bench",
  name: "Bench Press",
  sets: 3,
  repsMin: 6,
  repsMax: 8,
  repsLabel: "6-8",
  targetRPE: 8,
  restSeconds: 150,
  recommendedWeight: 60,
  loadType: "external",
  weightMode: "kg",
  measurement: "reps",
  perSide: false,
};
const plank = {
  ...bench,
  id: "pe-plank",
  programExerciseId: "pe-plank",
  libraryExerciseId: "lib-plank",
  name: "Side Plank",
  sets: 2,
  repsMin: 30,
  repsMax: 30,
  repsLabel: "30 s",
  recommendedWeight: null,
  loadType: "bodyweight",
  measurement: "time",
  perSide: true,
};
const carry = {
  ...bench,
  id: "pe-carry",
  programExerciseId: "pe-carry",
  libraryExerciseId: "lib-carry",
  name: "Farmer Carry",
  sets: 2,
  repsMin: 40,
  repsMax: 40,
  repsLabel: "40 m",
  recommendedWeight: 24,
  weightMode: "per dumbbell",
  measurement: "distance",
};
const split = {
  ...bench,
  id: "pe-split",
  programExerciseId: "pe-split",
  libraryExerciseId: "lib-split",
  name: "Split Squat",
  sets: 3,
  repsMin: 10,
  repsMax: 10,
  repsLabel: "10/side",
  recommendedWeight: 20,
  weightMode: "per dumbbell",
  measurement: "reps",
  perSide: true,
};
const chin = {
  ...bench,
  id: "pe-chin",
  programExerciseId: "pe-chin",
  libraryExerciseId: "lib-chin",
  name: "Chin-up",
  sets: 3,
  repsMin: 5,
  repsMax: 8,
  repsLabel: "5-8",
  recommendedWeight: null,
  loadType: "optionalExternal",
  weightMode: "additional load",
};
const legacyTimed = {
  ...plank,
  id: "pe-legacy",
  programExerciseId: "pe-legacy",
  measurement: undefined,
  perSide: undefined,
  repsLabel: "30 s",
};

// ---------------------------------------------------------------------------
// Profile -> value key, labels, steps, notes
// ---------------------------------------------------------------------------
{
  assert.equal(getSetValueKey(getSetEntryProfile(bench)), "reps");
  assert.equal(getSetValueKey(getSetEntryProfile(plank)), "seconds");
  assert.equal(getSetValueKey(getSetEntryProfile(carry)), "meters");
  assert.equal(getSetValueKey(getSetEntryProfile(legacyTimed)), "seconds", "a '30 s' label infers time when nothing is stored");
  assert.equal(getSetValueKey(null), "reps");

  const benchLabels = getSetEntryLabels(getSetEntryProfile(bench));
  assert.equal(benchLabels.valueLabel, "Reps");
  assert.equal(benchLabels.valueHint, "");
  assert.equal(benchLabels.valueStep, 1);
  assert.equal(benchLabels.weightLabel, "Kg");
  assert.equal(benchLabels.weightHint, "");
  assert.equal(benchLabels.showWeightInput, true);
  assert.deepEqual(benchLabels.notes, []);

  const plankLabels = getSetEntryLabels(getSetEntryProfile(plank));
  assert.equal(plankLabels.valueLabel, "Seconds");
  assert.equal(plankLabels.valueHint, "per side");
  assert.equal(plankLabels.valueStep, 5, "timed sets step 5 s");
  assert.equal(plankLabels.valuePlaceholder, "sec");
  assert.equal(plankLabels.showWeightInput, false, "bodyweight: no kg field");
  assert.equal(plankLabels.bodyweightLabel, "BW");
  assert.ok(plankLabels.notes.includes(PER_SIDE_NOTE));

  const carryLabels = getSetEntryLabels(getSetEntryProfile(carry));
  assert.equal(carryLabels.valueLabel, "Meters");
  assert.equal(carryLabels.valueStep, 10);
  assert.equal(carryLabels.weightHint, "per dumbbell");
  assert.equal(carryLabels.weightPlaceholder, "kg each");
  assert.ok(carryLabels.notes.includes(PER_DUMBBELL_NOTE));

  const chinLabels = getSetEntryLabels(getSetEntryProfile(chin));
  assert.equal(chinLabels.weightLabel, "+kg", "optional external load shows an added-kg field");
  assert.equal(chinLabels.weightHint, "optional");
  assert.equal(chinLabels.weightPlaceholder, "BW");
  assert.equal(chinLabels.showWeightInput, true);
  assert.equal(chinLabels.weightInputType, "number");
  assert.ok(chinLabels.notes.includes(ADDITIONAL_LOAD_NOTE));

  const splitLabels = getSetEntryLabels(getSetEntryProfile(split));
  assert.equal(splitLabels.valueLabel, "Reps");
  assert.equal(splitLabels.valueHint, "per side");
  assert.equal(splitLabels.weightHint, "per dumbbell");
}

// ---------------------------------------------------------------------------
// Defaults and reading a draft set
// ---------------------------------------------------------------------------
{
  assert.deepEqual(getSetEntryDefaults(bench, { repsMin: 6, recommendedWeight: 62.5, targetRPE: 8 }), { value: "6", weight: "62.5", rpe: "8" });
  assert.deepEqual(getSetEntryDefaults(plank, { repsMin: 35, repsMax: 50, recommendedWeight: null, targetRPE: 7 }), { value: "35", weight: "", rpe: "7" });
  assert.deepEqual(getSetEntryDefaults(plank, null), { value: "30", weight: "", rpe: "8" }, "the target range of a timed exercise is the default");
  assert.deepEqual(getSetEntryDefaults(legacyTimed, null), { value: "30", weight: "", rpe: "8" }, "'30 s' label gives 30 when nothing numeric is stored");
  assert.deepEqual(getSetEntryDefaults(chin, null), { value: "5", weight: "", rpe: "8" }, "optional load: BW default shows as a blank +kg field");
  assert.deepEqual(getSetEntryDefaults(carry, null), { value: "40", weight: "24", rpe: "8" });

  const defaults = { value: "6", weight: "60", rpe: "8" };
  const profile = getSetEntryProfile(bench);
  assert.equal(readSetEntryValues({ reps: "", weight: "", rpe: "" }, defaults, profile), defaults, "untouched set shows the defaults");
  assert.deepEqual(readSetEntryValues({ reps: "8", weight: "60", rpe: "9" }, defaults, profile), { value: "8", weight: "60", rpe: "9" });
  assert.deepEqual(
    readSetEntryValues({ reps: "", seconds: "40", meters: "", weight: "BW", rpe: "7" }, defaults, getSetEntryProfile(plank)),
    { value: "40", weight: "", rpe: "7" },
  );
  assert.equal(readDraftSetValue({ reps: "10", seconds: "" }, getSetEntryProfile(plank)), "", "a reps-only set is never read as seconds");
  assert.equal(readDraftSetValue({ reps: "", meters: 400 }, getSetEntryProfile(carry)), "400");
  assert.equal(hasSetEntryValue({ reps: "", seconds: "30", weight: "", rpe: "" }), true);
  assert.equal(hasSetEntryValue({ reps: "", weight: "", rpe: "" }), false);
  assert.equal(hasSetEntryValue(undefined), false);
}

// ---------------------------------------------------------------------------
// Draft patch and validation per profile
// ---------------------------------------------------------------------------
{
  assert.deepEqual(toDraftSetPatch({ value: "8", weight: "60", rpe: "8" }, getSetEntryProfile(bench)), {
    reps: "8", seconds: "", meters: "", weight: "60", rpe: "8",
  });
  assert.deepEqual(toDraftSetPatch({ value: "30", weight: "", rpe: "7" }, getSetEntryProfile(plank)), {
    reps: "", seconds: "30", meters: "", weight: "BW", rpe: "7",
  }, "a timed bodyweight set stores seconds and BW");
  assert.deepEqual(toDraftSetPatch({ value: "40", weight: "24", rpe: "8" }, getSetEntryProfile(carry)), {
    reps: "", seconds: "", meters: "40", weight: "24", rpe: "8",
  });
  assert.equal(toDraftSetPatch({ value: "6", weight: "", rpe: "8" }, getSetEntryProfile(chin)).weight, "BW", "blank +kg means bodyweight");
  assert.equal(toDraftSetPatch({ value: "6", weight: "0", rpe: "8" }, getSetEntryProfile(chin)).weight, "BW", "0 added kg is bodyweight");
  assert.equal(toDraftSetPatch({ value: "6", weight: "10", rpe: "8" }, getSetEntryProfile(chin)).weight, "10", "added kg is kept as a number");

  assert.deepEqual(validateSetEntryValues({ value: "8", weight: "60", rpe: "8" }, bench), []);
  assert.deepEqual(validateSetEntryValues({ value: "-1", weight: "60", rpe: "8" }, bench), ["Reps must be 0 or higher."]);
  assert.deepEqual(validateSetEntryValues({ value: "-5", weight: "", rpe: "7" }, plank), ["Seconds must be 0 or higher."]);
  assert.deepEqual(validateSetEntryValues({ value: "40", weight: "abc", rpe: "8" }, carry), ["Kg must be a valid number or BW."]);
  assert.deepEqual(validateSetEntryValues({ value: "6", weight: "x", rpe: "8" }, chin), ["+kg must be a number or blank."]);
  assert.deepEqual(validateSetEntryValues({ value: "6", weight: "", rpe: "8.3" }, chin), ["Set RPE must be 1-10 in .5 steps."]);
  assert.deepEqual(validateSetEntryValues({ value: "", weight: "", rpe: "" }, bench), [], "blank fields are decided at Save Workout");
}

// ---------------------------------------------------------------------------
// Summaries: "10/side", "30 s", "BW", "x2 for volume"
// ---------------------------------------------------------------------------
{
  assert.equal(formatSetValueText({ reps: "10" }, getSetEntryProfile(split)), "10/side");
  assert.equal(formatSetValueText({ seconds: "30" }, getSetEntryProfile(plank)), "30 s/side");
  assert.equal(formatSetValueText({ meters: 400 }, getSetEntryProfile(carry)), "400 m");
  assert.equal(formatSetValueText({ reps: "12" }, getSetEntryProfile(plank)), "12 reps", "a reps-only set of a timed exercise stays reps");
  assert.equal(formatSetValueText({}, getSetEntryProfile(bench)), "?");
  assert.equal(formatSetWeightText("60", getSetEntryProfile(bench)), "60kg");
  assert.equal(formatSetWeightText("62.5", getSetEntryProfile(bench)), "62.5kg");
  assert.equal(formatSetWeightText("BW", getSetEntryProfile(plank)), "BW");
  assert.equal(formatSetWeightText("", getSetEntryProfile(plank)), "BW?");
  assert.equal(formatSetWeightText("", getSetEntryProfile(bench)), "kg?");
  assert.equal(formatSetWeightText("10", getSetEntryProfile(chin)), "10kg added");
  assert.equal(formatSetEntrySummary({ reps: "10", weight: "20", rpe: "8" }, 0, getSetEntryProfile(split)), "S1 20kg x 10/side @8");
  assert.equal(formatSetEntrySummary({ seconds: "30", weight: "BW", rpe: "7" }, 1, getSetEntryProfile(plank)), "S2 BW x 30 s/side @7");
  assert.equal(formatSetEntrySummary({ reps: "", weight: "", rpe: "" }, 2, getSetEntryProfile(bench)), "S3 empty");
  assert.equal(formatSetEntryTotals([{ reps: "10", weight: "20", rpe: "8" }, { reps: "", weight: "", rpe: "" }], getSetEntryProfile(carry)), "1 of 2 sets logged | per dumbbell, x2 for volume");
  assert.equal(formatSetEntryTotals([], getSetEntryProfile(bench)), "0 of 0 sets logged");
  assert.equal(formatSetTargetLabel({ repsMin: 6, repsMax: 8 }, getSetEntryProfile(bench)), "6-8");
  assert.equal(formatSetTargetLabel({ repsMin: 35, repsMax: 50 }, getSetEntryProfile(plank)), "35-50 s/side");
  assert.equal(formatSetTargetLabel({ repsMin: 10, repsMax: 10 }, getSetEntryProfile(split)), "10/side");
  assert.equal(formatSetTargetLabel({ repsLabel: "AMRAP" }, getSetEntryProfile(split)), "AMRAP/side");
  assert.equal(formatSetTargetLabel({ repsLabel: "8 each" }, getSetEntryProfile(split)), "8 each");
  assert.equal(formatSetTargetLabel({}, getSetEntryProfile(bench)), "");
}

// ---------------------------------------------------------------------------
// Save path: seconds / meters and the profile persist; reps sets unchanged
// ---------------------------------------------------------------------------
{
  const day = { id: "day-1", name: "Day 1", type: "training", exercises: [bench, plank, carry, chin] };
  const base = createDraft(day, null, []);
  assert.deepEqual(base.exercises["pe-plank"].sets[0], { reps: "", weight: "", rpe: "" }, "the draft shape is unchanged for old readers");

  const merged = mergeSavedDraft(base, {
    exercises: {
      "pe-plank": { sets: [{ reps: "", seconds: "30", meters: "", weight: "BW", rpe: "7" }] },
    },
  });
  assert.equal(merged.exercises["pe-plank"].sets[0].seconds, "30", "a saved seconds field survives the merge");

  assert.deepEqual(getDraftSetCount({ reps: "", seconds: "30" }, plank), { field: "seconds", value: "30", noun: "seconds" });
  assert.deepEqual(getDraftSetCount({ reps: "12" }, plank), { field: "reps", value: "12", noun: "reps" }, "old reps-only set of a timed exercise stays reps");
  assert.deepEqual(getDraftSetCount({ reps: "8" }, bench), { field: "reps", value: "8", noun: "reps" });

  const draft = {
    ...merged,
    sessionRpe: "8",
    exercises: {
      "pe-bench": { notes: "", painFlag: false, sets: [{ reps: "8", weight: "60", rpe: "8" }, { reps: "", weight: "", rpe: "" }, { reps: "", weight: "", rpe: "" }] },
      "pe-plank": { notes: "", painFlag: false, sets: [{ reps: "", seconds: "30", meters: "", weight: "BW", rpe: "7" }, { reps: "", weight: "", rpe: "" }] },
      "pe-carry": { notes: "", painFlag: false, sets: [{ reps: "", seconds: "", meters: "40", weight: "24", rpe: "8" }, { reps: "", weight: "", rpe: "" }] },
      "pe-chin": { notes: "", painFlag: false, sets: [{ reps: "6", seconds: "", meters: "", weight: "BW", rpe: "8" }, { reps: "", weight: "", rpe: "" }, { reps: "", weight: "", rpe: "" }] },
    },
  };
  assert.deepEqual(validateDraft(day, draft), [], "timed / distance / optional-load sets validate");
  assert.deepEqual(
    validateDraft(day, { ...draft, exercises: { ...draft.exercises, "pe-plank": { notes: "", painFlag: false, sets: [{ reps: "", seconds: "", meters: "", weight: "BW", rpe: "" }] } } }),
    ["Side Plank set 1: kg/BW was entered without seconds."],
    "validation names the measurement",
  );

  const logs = normalizeExerciseLogs(day, draft.exercises);
  assert.deepEqual(logs["pe-bench"].sets[0], { reps: 8, weight: 60, rpe: 8 }, "reps sets keep the H4 shape");
  assert.deepEqual(logs["pe-plank"].sets[0], { reps: null, weight: "BW", rpe: 7, seconds: 30 });
  assert.deepEqual(logs["pe-plank"].sets[1], { reps: null, weight: null, rpe: null });
  assert.deepEqual(logs["pe-carry"].sets[0], { reps: null, weight: 24, rpe: 8, meters: 40 });

  const setLogs = createWorkoutSetLogs({ sessionId: "s-1", programId: "program-a", day, plan: null, draft });
  const benchSet = setLogs.find((set) => set.programExerciseId === "pe-bench");
  assert.ok(!("actualSeconds" in benchSet), "a plain reps + kg set carries no timed field");
  assert.deepEqual(
    { measurement: benchSet.measurement, perSide: benchSet.perSide, weightMode: benchSet.weightMode, loadType: benchSet.loadType },
    { measurement: "reps", perSide: false, weightMode: "kg", loadType: "external" },
    "H5-20: a plain reps + kg set records the profile it was logged under too",
  );
  const plankSet = setLogs.find((set) => set.programExerciseId === "pe-plank");
  assert.equal(plankSet.actualSeconds, 30);
  assert.equal(plankSet.actualReps, null);
  assert.equal(plankSet.actualWeight, "BW");
  assert.equal(plankSet.measurement, "time");
  assert.equal(plankSet.perSide, true);
  assert.equal(plankSet.loadType, "bodyweight");
  assert.equal(plankSet.completed, true, "a timed set with seconds, BW and RPE is complete");
  const plankEmpty = setLogs.filter((set) => set.programExerciseId === "pe-plank")[1];
  assert.equal(plankEmpty.actualSeconds, null);
  assert.equal(plankEmpty.completed, false);
  const carrySet = setLogs.find((set) => set.programExerciseId === "pe-carry");
  assert.equal(carrySet.actualMeters, 40);
  assert.equal(carrySet.weightMode, "per dumbbell");
  assert.equal(carrySet.completed, true);
  const chinSet = setLogs.find((set) => set.programExerciseId === "pe-chin");
  assert.equal(chinSet.actualReps, 6);
  assert.equal(chinSet.loadType, "optionalExternal");
  assert.ok(!("actualSeconds" in chinSet));

  // Reading back: the log of a timed set carries seconds; History edit keeps it.
  const session = { id: "s-1", programId: "program-a", dayId: "day-1", sessionRpe: 8, workoutSets: setLogs, plannedExercises: {} };
  const plankLog = getExerciseLog(session, plank);
  assert.deepEqual(plankLog.sets[0], { reps: null, weight: "BW", rpe: 7, seconds: 30 });
  assert.deepEqual(getExerciseLog(session, bench).sets[0], { reps: 8, weight: 60, rpe: 8 }, "reps sets read back unchanged");
  const editDraft = buildDraftFromSession(session, day);
  assert.deepEqual(editDraft.exercises["pe-plank"].sets[0], { reps: "", weight: "BW", rpe: "7", seconds: "30" });
  assert.deepEqual(editDraft.exercises["pe-bench"].sets[0], { reps: "8", weight: "60", rpe: "8" });
  const rebuilt = rebuildSessionFromEdits(session, day, { exercises: { "pe-plank": { sets: [{ reps: "", weight: "BW", rpe: "8", seconds: "45" }, { reps: "", weight: "", rpe: "" }] } } });
  assert.equal(rebuilt.ok, true, rebuilt.error);
  assert.equal(rebuilt.session.workoutSets.find((set) => set.programExerciseId === "pe-plank").actualSeconds, 45);
  assert.equal(rebuilt.session.exercises["pe-plank"].sets[0].seconds, 45);

  // Old session: a reps-only timed set is still read as reps.
  const legacySession = { workoutSets: [{ programExerciseId: "pe-plank", exerciseId: "lib-plank", setNumber: 1, actualReps: 12, actualWeight: "BW", actualRPE: 7 }] };
  assert.deepEqual(getExerciseLog(legacySession, plank).sets[0], { reps: 12, weight: "BW", rpe: 7 });
  assert.equal(formatSetValueText(buildDraftFromSession(legacySession, day).exercises["pe-plank"].sets[0], getSetEntryProfile(plank)), "12 reps");
}

// ---------------------------------------------------------------------------
// Planned snapshot: hold / manual / deload flags only when the plan entry has them
// ---------------------------------------------------------------------------
{
  const day = { id: "day-1", exercises: [bench] };
  const plain = buildPlannedExercisesSnapshot(day, { exercises: [{ exerciseId: "pe-bench", sets: 3, repsMin: 6, repsMax: 8, repsLabel: "6-8", targetRPE: 8, recommendedWeight: 60, restSeconds: 150, prescriptionSource: "plan" }] });
  assert.deepEqual(Object.keys(plain["pe-bench"]), ["sets", "repsMin", "repsMax", "repsLabel", "targetRPE", "recommendedWeight", "restSeconds", "prescriptionSource"]);
  const held = buildPlannedExercisesSnapshot(day, { exercises: [{ exerciseId: "pe-bench", sets: 3, held: true, overrideMode: "hold", prescriptionSource: "override" }] });
  assert.equal(held["pe-bench"].held, true);
  assert.equal(held["pe-bench"].overrideMode, "hold");
  const deload = buildPlannedExercisesSnapshot(day, { exercises: [{ exerciseId: "pe-bench", sets: 3, deloadSession: true }] });
  assert.equal(deload["pe-bench"].deloadSession, true);
  assert.ok(!("held" in deload["pe-bench"]));
}

console.log("UI H5 set entry verification passed.");
