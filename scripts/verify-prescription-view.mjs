// Phase H4 Track A: src/lib/prescriptionView.js (moved verbatim from
// src/App.jsx). Pins the view glue around the shared resolver (19.4-2):
// - base plan -> "Source: program target", earned progression -> "Source: earned progression";
// - the prescription strip with a ranged rest;
// - BW / per-dumbbell / additional-load load labels (19.1 "Analytics");
// - the engine's pain-flag warning passes through untouched;
// - coach labels, program nickname, technical values and warm-up items.
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

const { STORAGE_KEYS, writeStorage } = await import("../src/lib/storage.js");
const { BASE_PLAN_REASON } = await import("../src/lib/prescription.js");
const { PAIN_FLAG_WARNING, getBasePlan } = await import("../src/lib/progression.js");
const {
  formatPrescriptionStrip,
  formatTechnicalValue,
  getCoachConfidenceLabel,
  getCoachDecisionLabel,
  getCoachHistoryTrendLabel,
  getCoachProgressionModeLabel,
  getCoachVolumePolicyLabel,
  getExerciseVideoUrl,
  getProgramNickname,
  getWarmupItems,
  getWorkoutExerciseRecommendation,
  normalizeCoachWarnings,
  resolveDayPrescriptions,
} = await import("../src/lib/prescriptionView.js");

const bench = {
  id: "pe-bench",
  programExerciseId: "pe-bench",
  libraryExerciseId: "lib-bench",
  programId: "program-a",
  dayId: "day-1",
  name: "Bench Press",
  category: "compound",
  progressionType: "compound",
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
const chin = {
  ...bench,
  id: "pe-chin",
  programExerciseId: "pe-chin",
  libraryExerciseId: "lib-chin",
  name: "Chin-up",
  sets: 2,
  repsMin: 5,
  repsMax: 10,
  repsLabel: "5-10",
  restSeconds: 120,
  recommendedWeight: null,
  loadType: "bodyweight",
};
const day = {
  id: "day-1",
  name: "Day 1",
  type: "training",
  warmup: {
    items: [
      { id: "wu-1", name: "Band pull-aparts", prescription: "2x15", notes: ["light", ""], videoUrl: " https://example.test/v " },
      { id: "", name: "", prescription: "", notes: "" },
      { name: "Hip circles" },
    ],
  },
  exercises: [bench, chin],
};

// ---------------------------------------------------------------------------
// Base plan: every value is the program target
// ---------------------------------------------------------------------------
{
  const basePlan = getBasePlan(day);
  assert.equal(basePlan.status, "base");
  const benchPlan = basePlan.exercises.find((entry) => entry.exerciseId === "pe-bench");
  const rec = getWorkoutExerciseRecommendation("program-a", bench, benchPlan, basePlan.status);
  assert.equal(rec.source, "target");
  assert.equal(rec.sourceLabel, "Source: program target");
  assert.equal(rec.sourceDetail, "Program target.");
  assert.equal(rec.fieldSources.weight, "target");
  assert.equal(rec.sets, 3);
  assert.equal(rec.repsMin, 6);
  assert.equal(rec.repsMax, 8);
  assert.equal(rec.repsLabel, "6-8");
  assert.equal(rec.recommendedWeight, 60);
  assert.equal(rec.targetRPE, 8);
  assert.deepEqual(rec.restSeconds, [150, 180]);
  assert.equal(rec.recommendationNote, "Starting recommendation based on current program target.");
  assert.deepEqual(rec.warnings, []);
  assert.equal(rec.decision, null);
  assert.equal(rec.confidence, null);
  assert.equal(rec.conservative, false);
  assert.deepEqual(Object.keys(rec).sort(), [
    "confidence", "conservative", "decision", "exerciseProfile", "fieldSources", "historySampleSize",
    "historyTrend", "progressionMode", "recommendationNote", "recommendedWeight", "repFocus", "repsLabel",
    "repsMax", "repsMin", "restSeconds", "sets", "source", "sourceDetail", "sourceLabel", "targetRPE", "warnings",
  ]);

  assert.equal(formatPrescriptionStrip(rec, bench), "3x 6-8 | 60 kg | RPE 8 | Rest 2 min 30 sec - 3 min", "ranged rest strip");

  const all = resolveDayPrescriptions("program-a", day, basePlan);
  assert.deepEqual(Object.keys(all), ["pe-bench", "pe-chin"], "keyed by exercise id, no warm-up entry");
  assert.equal(all["pe-chin"].recommendedWeight, null);
  assert.equal(all["pe-chin"].source, "target");
  assert.equal(formatPrescriptionStrip(all["pe-chin"], chin), "2x 5-10 | Bodyweight | RPE 8 | Rest 2 min");
  assert.deepEqual(resolveDayPrescriptions("program-a", null, null), {});

  // Without a program id nothing is read from storage; the plan entry still resolves.
  assert.equal(getWorkoutExerciseRecommendation(null, bench, benchPlan, "base").source, "target");
}

// ---------------------------------------------------------------------------
// Earned plan: a stored progression from a saved session wins
// ---------------------------------------------------------------------------
{
  const write = writeStorage(STORAGE_KEYS.programProgressions, [
    {
      programId: "program-a",
      programExerciseId: "pe-bench",
      lastRecommendedSets: 3,
      lastRecommendedReps: { min: 6, max: 8 },
      lastTargetRPE: 8,
      lastRecommendedWeight: 62.5,
      recommendationNote: "Hit the top of the rep range at RPE 8, so load goes up.",
      decision: "increase_load",
      confidence: "high",
      conservative: false,
      warnings: [PAIN_FLAG_WARNING],
      historyTrend: "improving",
      historySampleSize: 2,
      progressionMode: "double_progression",
      sourceSessionId: "session-1",
    },
    // Another program's row for the same occurrence id is ignored (F1).
    {
      programId: "program-b",
      programExerciseId: "pe-bench",
      lastRecommendedWeight: 200,
      sourceSessionId: "session-x",
    },
  ]);
  assert.equal(write.ok, true);
  assert.equal(writeStorage(STORAGE_KEYS.baselines, [
    { programId: "program-a", programExerciseId: "pe-chin", startingSets: 2, startingReps: { min: 5, max: 10 }, startingRPE: 7, startingWeight: null, restTime: 90 },
  ]).ok, true);

  const generatedPlan = {
    status: "generated",
    exercises: [
      { exerciseId: "pe-bench", sets: 3, repsMin: 6, repsMax: 8, repsLabel: "6-8", targetRPE: 8, restSeconds: 180, recommendedWeight: 62.5, reasons: ["Hit the top of the rep range at RPE 8, so load goes up."], decision: "increase_load", confidence: "high" },
      { exerciseId: "pe-chin", sets: 2, repsMin: 5, repsMax: 10, repsLabel: "5-10", targetRPE: 8, restSeconds: 120, recommendedWeight: null, reasons: [BASE_PLAN_REASON] },
    ],
  };
  const all = resolveDayPrescriptions("program-a", day, generatedPlan);
  const earned = all["pe-bench"];
  assert.equal(earned.source, "progression");
  assert.equal(earned.sourceLabel, "Source: earned progression");
  assert.equal(earned.sourceDetail, "Earned from your last saved session of this program.");
  assert.equal(earned.recommendedWeight, 62.5);
  assert.equal(earned.fieldSources.weight, "progression");
  assert.deepEqual(earned.restSeconds, 180, "rest is not stored on the progression: the plan entry supplies it");
  assert.equal(earned.fieldSources.restSeconds, "plan");
  assert.equal(earned.recommendationNote, "Hit the top of the rep range at RPE 8, so load goes up.");
  assert.equal(earned.decision, "increase_load");
  assert.equal(earned.confidence, "high");
  assert.deepEqual(earned.warnings, [PAIN_FLAG_WARNING], "the engine's pain-flag warning passes through untouched");
  assert.equal(earned.historyTrend, "improving");
  assert.equal(earned.historySampleSize, 2);
  assert.equal(earned.progressionMode, "double_progression");
  assert.equal(formatPrescriptionStrip(earned, bench), "3x 6-8 | 62.5 kg | RPE 8 | Rest 3 min");

  // The refilled base entry of a generated plan resolves as target (new-T).
  const chinRec = all["pe-chin"];
  assert.equal(chinRec.source, "target");
  assert.equal(chinRec.sourceLabel, "Source: program target");

  // Same occurrence id under another program: program-b's row does not leak in.
  const foreign = getWorkoutExerciseRecommendation("program-b", { ...bench, programId: "program-b", recommendedWeight: null }, null, undefined);
  assert.equal(foreign.recommendedWeight, 200, "program-b sees its own row");
  const noRow = getWorkoutExerciseRecommendation("program-c", { ...bench, programId: "program-c" }, null, undefined);
  assert.equal(noRow.source, "target");
  assert.equal(noRow.recommendedWeight, 60);
}

// ---------------------------------------------------------------------------
// Load labels (19.1 "Analytics")
// ---------------------------------------------------------------------------
{
  const base = { sets: 3, repsLabel: "8-12", targetRPE: 8, restSeconds: 90 };
  assert.equal(formatPrescriptionStrip({ ...base, recommendedWeight: null }, { loadType: "bodyweight" }), "3x 8-12 | Bodyweight | RPE 8 | Rest 1 min 30 sec");
  assert.equal(formatPrescriptionStrip({ ...base, recommendedWeight: 20 }, { loadType: "bodyweight" }), "3x 8-12 | Bodyweight | RPE 8 | Rest 1 min 30 sec", "a stray kg never shows on bodyweight work");
  assert.equal(formatPrescriptionStrip({ ...base, recommendedWeight: 22.5 }, { loadType: "external", weightMode: "per dumbbell" }), "3x 8-12 | 22.5 kg per dumbbell | RPE 8 | Rest 1 min 30 sec");
  assert.equal(formatPrescriptionStrip({ ...base, recommendedWeight: 10 }, { loadType: "optionalExternal", weightMode: "additional load" }), "3x 8-12 | 10 kg additional load | RPE 8 | Rest 1 min 30 sec");
  assert.equal(formatPrescriptionStrip({ ...base, recommendedWeight: null }, { loadType: "optionalExternal", weightMode: "additional load" }), "3x 8-12 | BW / add kg | RPE 8 | Rest 1 min 30 sec");
  assert.equal(formatPrescriptionStrip({ ...base, recommendedWeight: "BW" }, { loadType: "optionalExternal" }), "3x 8-12 | BW | RPE 8 | Rest 1 min 30 sec");
  assert.equal(formatPrescriptionStrip({ ...base, recommendedWeight: null }, { loadType: "external" }), "3x 8-12 | Enter kg | RPE 8 | Rest 1 min 30 sec");
  assert.equal(formatPrescriptionStrip({ ...base, recommendedWeight: 60, restSeconds: 45 }, { loadType: "external", weightMode: "kg" }), "3x 8-12 | 60 kg | RPE 8 | Rest 45 sec");
}

// ---------------------------------------------------------------------------
// Coach warnings and labels
// ---------------------------------------------------------------------------
assert.deepEqual(normalizeCoachWarnings(null), []);
assert.deepEqual(normalizeCoachWarnings(""), []);
assert.deepEqual(normalizeCoachWarnings(PAIN_FLAG_WARNING), [PAIN_FLAG_WARNING]);
assert.deepEqual(normalizeCoachWarnings([" a ", "", null, "b"]), ["a", "b"]);

assert.equal(getCoachDecisionLabel("increase_load"), "Increase load");
assert.equal(getCoachDecisionLabel("increase_reps"), "Build reps");
assert.equal(getCoachDecisionLabel("hold"), "Hold steady");
assert.equal(getCoachDecisionLabel("reduce_load"), "Reduce load");
assert.equal(getCoachDecisionLabel("reduce_volume"), "Reduce volume");
assert.equal(getCoachDecisionLabel("deload_suggestion"), "Consider lighter day");
assert.equal(getCoachDecisionLabel("recovery_suggestion"), "Recovery focus");
assert.equal(getCoachDecisionLabel("insufficient_data"), "Establish baseline");
assert.equal(getCoachDecisionLabel("unknown"), "");
assert.equal(getCoachDecisionLabel(null), "");
assert.equal(getCoachConfidenceLabel("high"), "High confidence");
assert.equal(getCoachConfidenceLabel("medium"), "Medium confidence");
assert.equal(getCoachConfidenceLabel("low"), "Low confidence");
assert.equal(getCoachConfidenceLabel(undefined), "");
assert.equal(getCoachHistoryTrendLabel("improving"), "Improving trend");
assert.equal(getCoachHistoryTrendLabel("stable"), "Stable trend");
assert.equal(getCoachHistoryTrendLabel("regressing"), "Regression watch");
assert.equal(getCoachHistoryTrendLabel("repeated_high_rpe"), "High fatigue pattern");
assert.equal(getCoachHistoryTrendLabel("insufficient_history"), "Limited history");
assert.equal(getCoachHistoryTrendLabel("x"), "");
assert.equal(getCoachProgressionModeLabel("double_progression"), "Double progression");
assert.equal(getCoachProgressionModeLabel("load_progression"), "Load progression");
assert.equal(getCoachProgressionModeLabel("reps_first"), "Reps first");
assert.equal(getCoachProgressionModeLabel("quality_first"), "Quality first");
assert.equal(getCoachProgressionModeLabel("rpe_capped"), "RPE-capped");
assert.equal(getCoachProgressionModeLabel("core_control"), "Core control");
assert.equal(getCoachProgressionModeLabel("hold_conservative"), "Conservative hold");
assert.equal(getCoachProgressionModeLabel(""), "");
assert.equal(getCoachVolumePolicyLabel("protected"), "Volume protected");
assert.equal(getCoachVolumePolicyLabel("normal"), "Normal volume");
assert.equal(getCoachVolumePolicyLabel("reducible_low_priority"), "Low-priority volume can flex");
assert.equal(getCoachVolumePolicyLabel(null), "");

// Program nickname.
assert.equal(getProgramNickname(null), "Athletic Program");
assert.equal(getProgramNickname({ name: "Anything", nickname: "Push/Pull" }), "Push/Pull");
assert.equal(getProgramNickname({ name: "Custom", isDefault: true }), "Athletic Program");
assert.equal(getProgramNickname({ name: "My Athletic Bodybuilding Block" }), "Athletic Program");
assert.equal(getProgramNickname({ name: "Custom Push" }), "Custom Push");

// Technical values, video url, warm-up items (informational only).
assert.equal(formatTechnicalValue(null), "");
assert.equal(formatTechnicalValue(undefined), "");
assert.equal(formatTechnicalValue("  keep the bar path tight  "), "keep the bar path tight");
assert.equal(formatTechnicalValue(["a", "", null, "b"]), "a, b");
assert.equal(formatTechnicalValue(0), "0");
assert.equal(getExerciseVideoUrl({ videoUrl: " https://a.test " }), "https://a.test");
assert.equal(getExerciseVideoUrl({ video_url: "https://b.test" }), "https://b.test");
assert.equal(getExerciseVideoUrl({}), "");
assert.equal(getExerciseVideoUrl(null), "");
{
  const items = getWarmupItems(day);
  assert.deepEqual(items, [
    { id: "wu-1", name: "Band pull-aparts", prescription: "2x15", notes: "light", videoUrl: "https://example.test/v" },
    { id: "warmup-3", name: "Hip circles", prescription: "", notes: "", videoUrl: "" },
  ], "empty items are dropped; a missing id is derived from the position");
  assert.ok(items.every((item) => !("sets" in item) && !("reps" in item) && !("programExerciseId" in item)), "warm-up items carry no set / prescription record fields");
  assert.deepEqual(getWarmupItems({ exercises: [bench] }), []);
  assert.deepEqual(getWarmupItems(null), []);
}

console.log("Prescription view verification passed.");
