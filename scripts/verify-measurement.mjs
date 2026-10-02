// Phase H5 Track A, decision H5-1: measurement semantics (reps / time /
// distance, per side) and the volume conventions of 19.4-5, all pure.
import assert from "node:assert/strict";
import {
  DEFAULT_MEASUREMENT,
  formatMeasurementRange,
  getMeasurementProfile,
  getMeasurementTargetRange,
  getSetLoadForVolume,
  inferMeasurementFromLabel,
  inferPerSideFromLabel,
  MEASUREMENTS,
  normalizeSetEntry,
} from "../src/lib/measurement.js";

assert.deepEqual([...MEASUREMENTS], ["reps", "time", "distance"]);
assert.equal(DEFAULT_MEASUREMENT, "reps");

// --- label inference ---------------------------------------------------------
assert.deepEqual(inferMeasurementFromLabel("8-12"), { measurement: "reps", unit: "reps", min: 8, max: 12 });
assert.deepEqual(inferMeasurementFromLabel("8–12"), { measurement: "reps", unit: "reps", min: 8, max: 12 }, "en dash");
assert.deepEqual(inferMeasurementFromLabel("30 s"), { measurement: "time", unit: "s", min: 30, max: 30 });
assert.deepEqual(inferMeasurementFromLabel("45-60 sec"), { measurement: "time", unit: "s", min: 45, max: 60 });
assert.deepEqual(inferMeasurementFromLabel("2 min"), { measurement: "time", unit: "s", min: 120, max: 120 });
assert.deepEqual(inferMeasurementFromLabel("0:45"), { measurement: "time", unit: "s", min: 45, max: 45 });
assert.deepEqual(inferMeasurementFromLabel("1:00-1:30"), { measurement: "time", unit: "s", min: 60, max: 90 });
assert.deepEqual(inferMeasurementFromLabel("400 m"), { measurement: "distance", unit: "m", min: 400, max: 400 });
assert.deepEqual(inferMeasurementFromLabel("1 km"), { measurement: "distance", unit: "m", min: 1000, max: 1000 });
assert.deepEqual(inferMeasurementFromLabel("60 sec"), { measurement: "time", unit: "s", min: 60, max: 60 });
// Coaching notation: a closing inch mark is seconds (H5-35). The unit group
// used to end on ``, which a trailing quote never satisfies.
assert.deepEqual(inferMeasurementFromLabel('60"'), { measurement: "time", unit: "s", min: 60, max: 60 });
assert.deepEqual(inferMeasurementFromLabel('30-45"'), { measurement: "time", unit: "s", min: 30, max: 45 });
assert.deepEqual(inferMeasurementFromLabel('45" hold'), { measurement: "time", unit: "s", min: 45, max: 45 });
assert.equal(inferMeasurementFromLabel("12 x").measurement, "reps", "an unknown trailing word is still a count");
assert.equal(inferMeasurementFromLabel("10 reps, 3 s pause").measurement, "reps", "a count first stays reps");
assert.equal(inferMeasurementFromLabel("8-12 per side").measurement, "reps");
assert.deepEqual(inferMeasurementFromLabel("AMRAP"), { measurement: "reps", unit: "reps", min: null, max: null });
assert.deepEqual(inferMeasurementFromLabel(""), { measurement: "reps", unit: "reps", min: null, max: null });
assert.deepEqual(inferMeasurementFromLabel(null), { measurement: "reps", unit: "reps", min: null, max: null });

assert.equal(inferPerSideFromLabel("10/side"), true);
assert.equal(inferPerSideFromLabel("8-12 each leg"), true);
assert.equal(inferPerSideFromLabel("12 per arm"), true);
assert.equal(inferPerSideFromLabel("10 pe parte"), true);
assert.equal(inferPerSideFromLabel("8-12"), false);
assert.equal(inferPerSideFromLabel("sideways"), false, "the word must be a side marker");

// --- profile: persisted fields win, the label is the fallback ---------------
const legacyPlank = { targetReps: { min: null, max: null, label: "60 sec" }, loadType: "bodyweight" };
assert.deepEqual(getMeasurementProfile(legacyPlank), {
  measurement: "time",
  unit: "s",
  perSide: false,
  loadType: "bodyweight",
  weightMode: "kg",
  inferred: { measurement: true, perSide: true },
});
assert.deepEqual(getMeasurementTargetRange(legacyPlank), { min: 60, max: 60 }, "the range comes from the label");
assert.deepEqual(getMeasurementTargetRange({ repsMin: 8, repsMax: 12, repsLabel: "8-12" }), { min: 8, max: 12 });

const stored = { measurement: "reps", perSide: true, targetReps: { min: 30, max: 30, label: "30 s" } };
const storedProfile = getMeasurementProfile(stored);
assert.equal(storedProfile.measurement, "reps", "a stored measurement beats the label");
assert.equal(storedProfile.perSide, true);
assert.deepEqual(storedProfile.inferred, { measurement: false, perSide: false });
assert.equal(getMeasurementProfile({ measurement: "bogus", repsLabel: "30 s" }).measurement, "time", "an invalid stored value falls back to the label");
assert.equal(getMeasurementProfile({ repsLabel: "10/side" }).perSide, true, "day view model shape (repsLabel)");
assert.equal(getMeasurementProfile(null).measurement, "reps");

// --- set normalisation --------------------------------------------------------
const timeProfile = getMeasurementProfile({ repsLabel: "45 s" });
assert.deepEqual(normalizeSetEntry({ seconds: 50, weight: null, rpe: 7 }, timeProfile), {
  measurement: "time",
  unit: "s",
  value: 50,
  reps: null,
  seconds: 50,
  meters: null,
  weight: null,
  rpe: 7,
  completed: true,
});
const legacySet = normalizeSetEntry({ reps: 45, weight: "", rpe: "" }, timeProfile);
assert.equal(legacySet.measurement, "reps", "an old set with only reps is never relabelled as seconds");
assert.equal(legacySet.value, 45);
assert.equal(legacySet.seconds, null);
const distanceSet = normalizeSetEntry({ meters: 400, weight: "bw" }, getMeasurementProfile({ repsLabel: "400 m" }));
assert.equal(distanceSet.measurement, "distance");
assert.equal(distanceSet.value, 400);
assert.equal(distanceSet.weight, "BW");
assert.equal(normalizeSetEntry({}, timeProfile).value, null, "missing is null, never 0");
assert.equal(normalizeSetEntry({ reps: 0, completed: false }).completed, false);
assert.equal(normalizeSetEntry({ reps: "8", weight: "40", rpe: "8.5" }).weight, 40, "string inputs are parsed");

// --- volume conventions (19.4-5) ------------------------------------------------
const perDumbbell = getMeasurementProfile({ repsLabel: "8-10", weightMode: "per dumbbell" });
const dbLoad = getSetLoadForVolume({ reps: 10, weight: 24 }, perDumbbell);
assert.equal(dbLoad.kind, "external");
assert.equal(dbLoad.tonnage, 480, "per dumbbell counts both dumbbells for tonnage");
assert.equal(dbLoad.countedDumbbells, 2);
assert.equal(dbLoad.e1rmWeight, 24, "e1RM keeps the per-dumbbell value");
assert.equal(dbLoad.e1rmReps, 10);

const perSide = getMeasurementProfile({ repsLabel: "10/side" });
const sideLoad = getSetLoadForVolume({ reps: 10, weight: 20 }, perSide);
assert.equal(sideLoad.countedSides, 2);
assert.equal(sideLoad.tonnage, 400, "per side counts both sides");
assert.equal(sideLoad.value, 10, "the set value stays per side");
assert.equal(sideLoad.totalValue, 20);

const bodyweight = getMeasurementProfile({ repsLabel: "6-10", loadType: "bodyweight" });
const bwLoad = getSetLoadForVolume({ reps: 8, weight: "BW" }, bodyweight);
assert.equal(bwLoad.kind, "bodyweight");
assert.equal(bwLoad.tonnage, null, "bodyweight sets have no tonnage (no body mass is known)");
assert.equal(bwLoad.e1rmWeight, null);
assert.equal(bwLoad.value, 8);

const additional = getMeasurementProfile({ repsLabel: "6-8", loadType: "optionalExternal", weightMode: "additional load" });
const addLoad = getSetLoadForVolume({ reps: 8, weight: 20 }, additional);
assert.equal(addLoad.kind, "additional", "added load is labelled as such");
assert.equal(addLoad.tonnage, null);
assert.equal(addLoad.weight, 20);
// Decision H5-29 (19.4-6): one e1RM load policy. An additional load is
// eligible on the ADDED load, as getE1rmEligibility and the records say.
assert.equal(addLoad.e1rmWeight, 20, "additional load: the added load is the e1RM load");
assert.equal(addLoad.e1rmReps, 8);
assert.equal(getSetLoadForVolume({ reps: 8, weight: "BW" }, additional).e1rmWeight, null, "BW on an additional-load exercise: no e1RM");
assert.equal(getSetLoadForVolume({ reps: 8, weight: 0 }, additional).e1rmWeight, null, "+0 kg: no e1RM");

const timedLoad = getSetLoadForVolume({ seconds: 45, weight: 10 }, timeProfile);
assert.equal(timedLoad.tonnage, null, "timed sets never produce tonnage");
assert.equal(timedLoad.e1rmWeight, null);
assert.equal(timedLoad.value, 45);
assert.equal(timedLoad.unit, "s");
const sidePlank = getSetLoadForVolume({ seconds: 30 }, getMeasurementProfile({ repsLabel: "30 s/side" }));
assert.equal(sidePlank.totalValue, 60, "30 s per side is 60 s in total");
assert.equal(sidePlank.value, 30);

const distanceLoad = getSetLoadForVolume({ meters: 400 }, getMeasurementProfile({ repsLabel: "400 m" }));
assert.equal(distanceLoad.tonnage, null);
assert.equal(distanceLoad.e1rmReps, null);
assert.equal(distanceLoad.unit, "m");

const empty = getSetLoadForVolume({}, perDumbbell);
assert.equal(empty.kind, "none");
assert.equal(empty.tonnage, null);
assert.equal(empty.value, null);
assert.equal(empty.totalValue, null);
assert.equal(getSetLoadForVolume({ reps: 0, weight: 50 }).e1rmWeight, null, "a 0-rep set gives no e1RM");

// --- formatting ------------------------------------------------------------------
assert.equal(formatMeasurementRange({ min: 35, max: 50, unit: "s" }), "35-50 s");
assert.equal(formatMeasurementRange({ min: 30, max: 30, unit: "s" }), "30 s");
assert.equal(formatMeasurementRange({ min: 10, max: 10, unit: "reps", perSide: true }), "10/side");
assert.equal(formatMeasurementRange({ min: 400, max: 400, unit: "m" }), "400 m");
assert.equal(formatMeasurementRange({ min: 8, max: 12 }), "8-12");
assert.equal(formatMeasurementRange({ min: null, max: null, unit: "s" }), null);

console.log("Measurement (H5-1) verification passed.");
