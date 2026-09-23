// Fixer round 2: logged-set helpers extracted from src/App.jsx into
// src/lib/sessionLog.js.
// - An untouched set slot (weight null, reps null) is not "0 kg x 0 reps":
//   the Workouts "Last time" cue for one logged set (5 x 80 kg) plus three
//   empty slots reads 80 kg x 5, not 20 kg x 5, 0, 0, 0, and the planned
//   80 kg is a "keep" target, not a "try 80 kg" target.
// - Recovery sessions are recognised by `dayType` (what saveWorkout stores),
//   with `type` as a legacy fallback only.
import assert from "node:assert/strict";

const {
  getAverageNumericWeight,
  getLoggedReps,
  getNumericSetWeights,
  isBodyweightText,
  isRecoverySession,
  normalizeWeight,
} = await import("../src/lib/sessionLog.js");

// normalizeWeight: null / undefined / blank are "nothing logged", never 0.
assert.equal(normalizeWeight(null), null, "null weight is not 0 kg");
assert.equal(normalizeWeight(undefined), null);
assert.equal(normalizeWeight(""), null);
assert.equal(normalizeWeight("   "), null);
assert.equal(normalizeWeight("abc"), null);
assert.equal(normalizeWeight(0), 0, "an explicit 0 kg stays 0");
assert.equal(normalizeWeight("0"), 0);
assert.equal(normalizeWeight(80), 80);
assert.equal(normalizeWeight(" 82.5 "), 82.5);
assert.equal(normalizeWeight("bw"), "BW");
assert.equal(normalizeWeight("Body weight"), "BW");
assert.equal(isBodyweightText("BW"), true);
assert.equal(isBodyweightText("80"), false);

// The exact session shape saveWorkout stores for one logged set + 3 blanks
// (normalizeExerciseLogs: reps null, weight normalizeWeight("") = null).
const loggedSets = [
  { reps: 5, weight: 80, rpe: 8 },
  { reps: null, weight: null, rpe: null },
  { reps: null, weight: null, rpe: null },
  { reps: null, weight: null, rpe: null },
];
assert.deepEqual(getNumericSetWeights(loggedSets), [80], "empty slots contribute no weight");
assert.equal(getAverageNumericWeight(loggedSets), 80, "average is 80, not 20");
assert.deepEqual(getLoggedReps(loggedSets), [5], "empty slots contribute no reps");
assert.equal(getLoggedReps(loggedSets).reduce((total, reps) => total + reps, 0), 5);

// The cue decision the Workouts card makes with these numbers: the planned
// 80 kg is NOT above last time's 80 kg -> keep, not "try 80 kg".
const plannedWeight = normalizeWeight(80);
assert.equal(plannedWeight > getAverageNumericWeight(loggedSets), false, "keep-weight target");
assert.equal(`Last time: ${getAverageNumericWeight(loggedSets)} kg x ${getLoggedReps(loggedSets).join(", ")}`, "Last time: 80 kg x 5");

// The workoutSets fallback shape (actualWeight mapped to weight) and mixed data.
assert.equal(getAverageNumericWeight([{ weight: 80 }, { weight: 100 }, { weight: null }]), 90);
assert.equal(getAverageNumericWeight([{ weight: "BW" }, { weight: null }]), null, "BW-only is not numeric");
assert.equal(getAverageNumericWeight([]), null);
assert.equal(getAverageNumericWeight(null), null);
assert.deepEqual(getLoggedReps([{ reps: "6" }, { reps: "" }, { reps: 0 }, null, { reps: "x" }]), [6, 0]);
assert.deepEqual(getLoggedReps(undefined), []);

// Recovery detection.
assert.equal(isRecoverySession({ dayType: "recovery" }), true, "saved sessions carry dayType");
assert.equal(isRecoverySession({ type: "recovery" }), true, "legacy type still honoured");
assert.equal(isRecoverySession({ dayType: "lifting", type: "recovery" }), false, "dayType wins");
assert.equal(isRecoverySession({ dayType: "lifting" }), false);
assert.equal(isRecoverySession({}), false);
assert.equal(isRecoverySession(null), false);

console.log("verify-session-log: all assertions passed");
