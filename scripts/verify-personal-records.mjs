// Phase H5 Track B: src/lib/personalRecords.js (decision H5-8).
// Personal records by identity programId + programExerciseId (primary) with
// a Library-wide roll-up "across programs" that is never merged into it;
// e1RM eligibility (reps 1-10, numeric external / additional load, RPE >= 6
// or none); best weight / reps at weight / session volume (measurement-aware
// tonnage) / time / distance; new and tied records of a session; ineligible
// sets with their reason; legacy sets attach only unambiguously.
import assert from "node:assert/strict";

process.env.TZ = "Europe/Bucharest";

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
  attributeRecordIdentity,
  buildRecordsLookup,
  computePersonalRecords,
  detectNewRecords,
  E1RM_ELIGIBILITY,
  getRecordIdentityKey,
  getRecordRollupKey,
  listIneligibleSets,
  PERSONAL_RECORD_TYPES,
  RECORD_SCOPES,
} = await import("../src/lib/personalRecords.js");
const { getE1rmEligibility } = await import("../src/lib/sessionAnalytics.js");

assert.deepEqual(PERSONAL_RECORD_TYPES, ["best_e1rm", "best_weight", "best_reps_at_weight", "best_session_volume", "best_time", "best_distance"]);
assert.deepEqual(RECORD_SCOPES, { program: "program", acrossPrograms: "across programs" });
assert.deepEqual(E1RM_ELIGIBILITY, { minReps: 1, maxReps: 10, minRpe: 6 });
assert.equal(getRecordIdentityKey("program-a", "pe-bench"), "program-a::pe-bench");
assert.equal(getRecordRollupKey("lib-bench", "reps", "kg"), "lib-bench::reps::kg");

// ---------------------------------------------------------------------------
// Program exercises: raw ProgramExercise records (as stored) for program-a
// and program-b; a per-dumbbell press, a bodyweight chin-up, a timed plank,
// a distance carry.
// ---------------------------------------------------------------------------
const exerciseLibrary = [
  { id: "lib-bench", name: "Bench Press", equipment: "barbell" },
  { id: "lib-db-press", name: "DB Press", equipment: "dumbbell" },
  { id: "lib-chin", name: "Chin-up", equipment: "bodyweight" },
  { id: "lib-plank", name: "Plank", equipment: "bodyweight" },
  { id: "lib-carry", name: "Farmer Carry", equipment: "dumbbell" },
  { id: "lib-split", name: "Split Squat", equipment: "dumbbell" },
];
const programs = [{ id: "program-a", name: "A" }, { id: "program-b", name: "B" }];
const programExercises = [
  { id: "pe-bench", programId: "program-a", dayId: "day-1", exerciseId: "lib-bench", targetSets: 3, targetReps: { min: 5, max: 8, label: null }, targetRPE: 8, restTime: 150, targetWeight: 80, loadType: "external", weightMode: "kg" },
  { id: "pe-db", programId: "program-a", dayId: "day-1", exerciseId: "lib-db-press", targetSets: 3, targetReps: { min: 8, max: 12, label: null }, targetRPE: 8, restTime: 90, targetWeight: 30, loadType: "external", weightMode: "per dumbbell" },
  { id: "pe-chin", programId: "program-a", dayId: "day-1", exerciseId: "lib-chin", targetSets: 3, targetReps: { min: 5, max: 10, label: null }, targetRPE: 8, restTime: 120, targetWeight: null, loadType: "optionalExternal", weightMode: "additional load" },
  { id: "pe-plank", programId: "program-a", dayId: "day-1", exerciseId: "lib-plank", targetSets: 3, targetReps: { min: null, max: null, label: "45 s" }, targetRPE: 8, restTime: 45, targetWeight: null, loadType: "bodyweight", weightMode: "kg" },
  { id: "pe-carry", programId: "program-a", dayId: "day-1", exerciseId: "lib-carry", targetSets: 2, targetReps: { min: null, max: null, label: "40 m" }, targetRPE: 8, restTime: 90, targetWeight: 24, loadType: "external", weightMode: "per dumbbell" },
  { id: "pe-split", programId: "program-a", dayId: "day-1", exerciseId: "lib-split", targetSets: 3, targetReps: { min: 8, max: 8, label: "8 per side" }, targetRPE: 8, restTime: 90, targetWeight: 16, loadType: "external", weightMode: "per dumbbell" },
  // program-b has its own bench occurrence of the same Library exercise.
  { id: "pe-bench-b", programId: "program-b", dayId: "day-1", exerciseId: "lib-bench", targetSets: 5, targetReps: { min: 3, max: 5, label: null }, targetRPE: 8, restTime: 180, targetWeight: 90, loadType: "external", weightMode: "kg" },
];
const context = { programs, programExercises, exerciseLibrary };

function ws(programExerciseId, exerciseId, setNumber, reps, weight, rpe, extra = {}) {
  return { programExerciseId, exerciseId, setNumber, actualReps: reps, actualWeight: weight, actualRPE: rpe, completed: reps !== null && weight !== null, ...extra };
}

const s1 = {
  id: "s1", date: "2026-09-01T18:00:00+03:00", programId: "program-a", dayId: "day-1",
  workoutSets: [
    ws("pe-bench", "lib-bench", 1, 5, 80, 8),     // e1RM 93.33
    ws("pe-bench", "lib-bench", 2, 12, 70, 8),    // 12 reps: ineligible for e1RM (would be 98)
    ws("pe-bench", "lib-bench", 3, 3, 90, 5),     // RPE 5: ineligible (would be 99)
    ws("pe-db", "lib-db-press", 1, 10, 30, 8),    // per dumbbell: tonnage 600
    ws("pe-chin", "lib-chin", 1, 8, "BW", 8),
    ws("pe-chin", "lib-chin", 2, 6, 10, 8),       // additional load 10 kg: e1RM eligible (prompt contract)
    { programExerciseId: "pe-plank", exerciseId: "lib-plank", setNumber: 1, seconds: 45, actualWeight: "BW", actualRPE: 7, completed: true },
    { programExerciseId: "pe-plank", exerciseId: "lib-plank", setNumber: 2, seconds: 50, actualWeight: "BW", actualRPE: 8, completed: true },
    { programExerciseId: "pe-carry", exerciseId: "lib-carry", setNumber: 1, meters: 40, actualWeight: 24, actualRPE: 7, completed: true },
    ws("pe-split", "lib-split", 1, 8, 16, 8),     // per dumbbell x per side: 16*8*2*2 = 512
  ],
};
const s2 = {
  id: "s2", date: "2026-09-08T18:00:00+03:00", programId: "program-a", dayId: "day-1",
  workoutSets: [
    ws("pe-bench", "lib-bench", 1, 6, 80, 8),     // e1RM 96: new record
    ws("pe-bench", "lib-bench", 2, 5, 80, 8),     // tie with s1's best weight? no: best weight stays 80 (tie), reps at 80: 6 new
    ws("pe-db", "lib-db-press", 1, 10, 30, 8),    // same tonnage 600: tie
    ws("pe-chin", "lib-chin", 1, 8, "BW", 8),     // tie BW x 8
    { programExerciseId: "pe-plank", exerciseId: "lib-plank", setNumber: 1, seconds: 60, actualWeight: "BW", actualRPE: 8, completed: true },
    { programExerciseId: "pe-plank", exerciseId: "lib-plank", setNumber: 2, seconds: 70, actualWeight: 10, actualRPE: 8, completed: true }, // top weight 10 kg: 70 s at the top weight
    { programExerciseId: "pe-carry", exerciseId: "lib-carry", setNumber: 1, meters: 60, actualWeight: 24, actualRPE: 8, completed: true },
  ],
};
// Foreign program: heavier bench, same Library id. Never a program-a record.
const sb = {
  id: "sb", date: "2026-09-05T18:00:00+03:00", programId: "program-b", dayId: "day-1",
  workoutSets: [ws("pe-bench-b", "lib-bench", 1, 5, 100, 8)],
};

// ---------------------------------------------------------------------------
// e1RM eligibility
// ---------------------------------------------------------------------------
{
  assert.deepEqual(getE1rmEligibility({ weight: 80, reps: 5, rpe: 8 }), { eligible: true, reason: null });
  assert.deepEqual(getE1rmEligibility({ weight: 80, reps: 10, rpe: null }), { eligible: true, reason: null }, "no RPE is fine");
  assert.deepEqual(getE1rmEligibility({ weight: 80, reps: 1, rpe: 6 }), { eligible: true, reason: null });
  assert.equal(getE1rmEligibility({ weight: 70, reps: 12, rpe: 8 }).reason, "12 reps: e1RM only for 1-10 reps");
  assert.equal(getE1rmEligibility({ weight: 70, reps: 0, rpe: 8 }).reason, "0 reps: e1RM only for 1-10 reps");
  assert.equal(getE1rmEligibility({ weight: 90, reps: 3, rpe: 5 }).reason, "RPE 5: e1RM needs RPE 6 or higher (or no RPE)");
  assert.equal(getE1rmEligibility({ weight: "BW", reps: 8, rpe: 8 }).reason, "BW: e1RM needs a numeric load");
  assert.equal(getE1rmEligibility({ weight: null, reps: 8, rpe: 8 }).reason, "No load: e1RM needs a numeric load");
  assert.equal(getE1rmEligibility({ measurement: "time", weight: 10, reps: null, rpe: 8 }).reason, "time: e1RM only for rep-based sets");
  assert.equal(getE1rmEligibility({ weight: 10, reps: 8, rpe: 8, loadType: "bodyweight" }).reason, "bodyweight exercise: e1RM needs an external or additional load");
  assert.equal(getE1rmEligibility({ weight: 10, reps: 8, rpe: 8, loadType: "optionalExternal" }).eligible, true, "additional load on an optional-load exercise counts");

  // Decision H5-29 (19.4-6): ONE load policy. For every load kind the load
  // rule of measurement.getSetLoadForVolume (`e1rmWeight`) and
  // getE1rmEligibility agree on a set inside the rep / RPE gates.
  const { getMeasurementProfile, getSetLoadForVolume } = await import("../src/lib/measurement.js");
  [
    [{ repsLabel: "5-8", loadType: "external", weightMode: "kg" }, { reps: 6, weight: 80 }, true],
    [{ repsLabel: "8-12", loadType: "external", weightMode: "per dumbbell" }, { reps: 8, weight: 30 }, true],
    [{ repsLabel: "5-10", loadType: "optionalExternal", weightMode: "additional load" }, { reps: 6, weight: 10 }, true],
    [{ repsLabel: "5-10", loadType: "optionalExternal", weightMode: "additional load" }, { reps: 6, weight: "BW" }, false],
    [{ repsLabel: "5-10", loadType: "bodyweight", weightMode: "kg" }, { reps: 6, weight: 10 }, false],
    [{ repsLabel: "45 s", loadType: "external", weightMode: "kg" }, { seconds: 45, weight: 10 }, false],
    [{ repsLabel: "40 m", loadType: "external", weightMode: "per dumbbell" }, { meters: 40, weight: 24 }, false],
  ].forEach(([exercise, set, expected]) => {
    const profile = getMeasurementProfile(exercise);
    const load = getSetLoadForVolume(set, profile);
    const eligibility = getE1rmEligibility({ measurement: load.measurement, weight: load.weight, reps: load.measurement === "reps" ? load.value : null, rpe: 8, loadType: profile.loadType });
    assert.equal(load.e1rmWeight !== null, expected, `measurement.js load rule: ${JSON.stringify(exercise)}`);
    assert.equal(eligibility.eligible, expected, `getE1rmEligibility: ${JSON.stringify(exercise)}`);
  });
}

// ---------------------------------------------------------------------------
// Records by identity
// ---------------------------------------------------------------------------
const records = computePersonalRecords({ ...context, sessions: [s2, sb, s1] }); // newest first, as App keeps them
{
  const benchKey = "program-a::pe-bench";
  const bench = records.primary[benchKey];
  assert.ok(bench, "primary identity exists");
  assert.equal(bench.scope, "program");
  assert.equal(bench.name, "Bench Press");
  assert.equal(bench.measurement, "reps");
  assert.equal(bench.weightMode, "kg");
  assert.equal(bench.sessionCount, 2);

  // best_e1rm: 80 x 6 (96) from s2; the 12-rep and RPE-5 sets never count although their formula value is higher.
  assert.equal(bench.records.best_e1rm.value, 96);
  assert.equal(bench.records.best_e1rm.sessionId, "s2");
  assert.equal(bench.records.best_e1rm.setIndex, 1);
  assert.equal(bench.records.best_e1rm.reps, 6);
  assert.equal(bench.records.best_e1rm.weight, 80);
  assert.equal(bench.records.best_e1rm.unit, "kg");
  assert.equal(bench.records.best_e1rm.eligible, true);
  assert.equal(bench.records.best_e1rm.date, s2.date);
  assert.deepEqual(
    bench.ineligibleSets.map((entry) => [entry.sessionId, entry.setIndex, entry.reason]),
    [["s1", 2, "12 reps: e1RM only for 1-10 reps"], ["s1", 3, "RPE 5: e1RM needs RPE 6 or higher (or no RPE)"]],
    "ineligible sets are listed with the reason so the UI can explain",
  );

  // best_weight: heaviest completed set at >= 1 rep is the 90 kg x 3 (RPE 5 does not matter for weight).
  assert.equal(bench.records.best_weight.value, 90);
  assert.equal(bench.records.best_weight.sessionId, "s1");
  assert.equal(bench.records.best_weight.reps, 3);

  // best_reps_at_weight: 80 -> 6 (s2), 70 -> 12, 90 -> 3.
  assert.deepEqual(
    Object.fromEntries(Object.entries(bench.records.best_reps_at_weight).map(([weight, record]) => [weight, [record.value, record.sessionId]])),
    { 80: [6, "s2"], 70: [12, "s1"], 90: [3, "s1"] },
  );

  // best_session_volume: s1 = 400 + 840 + 270 = 1510; s2 = 480 + 400 = 880.
  assert.equal(bench.records.best_session_volume.value, 1510);
  assert.equal(bench.records.best_session_volume.sessionId, "s1");
  assert.equal(bench.records.best_session_volume.setIndex, null);
  assert.equal(bench.records.best_session_volume.setCount, 3);
  assert.equal(bench.records.best_time, null);
  assert.equal(bench.records.best_distance, null);

  // The foreign program never contributes to program-a's bench (100 kg is not here).
  assert.ok(Object.values(bench.records.best_reps_at_weight).every((record) => record.programId === "program-a"));
  const benchB = records.primary["program-b::pe-bench-b"];
  assert.equal(benchB.records.best_weight.value, 100);
  assert.equal(benchB.records.best_e1rm.sessionId, "sb");

  // Roll-up across programs: same Library id, same measurement + weight mode, labelled, never merged.
  const rollup = records.acrossPrograms["lib-bench::reps::kg"];
  assert.equal(rollup.scope, "across programs");
  assert.equal(rollup.programId, null);
  assert.equal(rollup.programExerciseId, null);
  assert.equal(rollup.exerciseId, "lib-bench");
  assert.equal(rollup.records.best_weight.value, 100, "the roll-up sees program-b's 100 kg");
  assert.ok(Math.abs(rollup.records.best_e1rm.value - 100 * (1 + 5 / 30)) < 1e-9);
  assert.equal(rollup.records.best_e1rm.scope, "across programs");
  assert.equal(bench.records.best_weight.value, 90, "the primary is untouched by the roll-up");

  // Per-dumbbell: tonnage counts both dumbbells (30 x 10 x 2 = 600); e1RM keeps the per-dumbbell value.
  const db = records.primary["program-a::pe-db"];
  assert.equal(db.weightMode, "per dumbbell");
  assert.equal(db.records.best_session_volume.value, 600);
  assert.equal(db.records.best_session_volume.sessionId, "s1", "a tie keeps the earlier record");
  assert.ok(Math.abs(db.records.best_e1rm.value - 30 * (1 + 10 / 30)) < 1e-9);
  assert.equal(db.records.best_weight.value, 30);

  // Per side x per dumbbell: 16 x 8 x 2 x 2 = 512.
  assert.equal(records.primary["program-a::pe-split"].records.best_session_volume.value, 512);

  // Bodyweight chin-up: BW reps are a record of their own; the added-load set has an e1RM.
  const chin = records.primary["program-a::pe-chin"];
  assert.equal(chin.records.best_reps_at_weight.BW.value, 8);
  assert.equal(chin.records.best_reps_at_weight.BW.sessionId, "s1", "BW x 8 tied in s2 keeps s1");
  assert.equal(chin.records.best_reps_at_weight["10"].value, 6);
  assert.ok(Math.abs(chin.records.best_e1rm.value - 10 * (1 + 6 / 30)) < 1e-9, "additional load: e1RM of the added load, as the recorded load convention");
  assert.equal(chin.records.best_weight.value, 10);
  assert.equal(chin.records.best_session_volume, null, "additional load / BW is no tonnage");
  assert.equal(chin.ineligibleSets.length, 0, "BW sets of a bodyweight-style exercise are not listed one by one");

  // Timed plank: best_time = longest seconds at the TOP weight (10 kg x 70 s), not the longest overall at BW.
  const plank = records.primary["program-a::pe-plank"];
  assert.equal(plank.measurement, "time");
  assert.equal(plank.unit, "s");
  assert.equal(plank.records.best_time.value, 70);
  assert.equal(plank.records.best_time.weight, 10);
  assert.equal(plank.records.best_time.seconds, 70);
  assert.equal(plank.records.best_time.unit, "s");
  assert.equal(plank.records.best_e1rm, null);
  assert.equal(plank.records.best_weight, null);
  assert.equal(plank.records.best_session_volume, null);

  // Distance carry: best_distance 60 m at 24 kg.
  const carry = records.primary["program-a::pe-carry"];
  assert.equal(carry.measurement, "distance");
  assert.equal(carry.records.best_distance.value, 60);
  assert.equal(carry.records.best_distance.meters, 60);
  assert.equal(carry.records.best_distance.unit, "m");
  assert.equal(carry.records.best_distance.sessionId, "s2");
  assert.equal(carry.records.best_session_volume, null, "distance sets have no tonnage");

  assert.deepEqual(records.unattributed, []);
}

// ---------------------------------------------------------------------------
// New and tied records of a session (for the recap)
// ---------------------------------------------------------------------------
{
  const before = computePersonalRecords({ ...context, sessions: [sb, s1] });
  const found = detectNewRecords(before, s2, context);
  const byKey = Object.fromEntries(found.map((record) => [`${record.identityKey}:${record.type}:${record.weightKey ?? ""}`, record]));

  assert.equal(byKey["program-a::pe-bench:best_e1rm:"].status, "new");
  assert.ok(Math.abs(byKey["program-a::pe-bench:best_e1rm:"].previousValue - 80 * (1 + 5 / 30)) < 1e-9);
  assert.equal(byKey["program-a::pe-bench:best_e1rm:"].previousDate, s1.date);
  assert.equal(byKey["program-a::pe-bench:best_e1rm:"].acrossPrograms, false, "program-b's 100 kg e1RM still tops the roll-up");
  assert.equal(byKey["program-a::pe-bench:best_reps_at_weight:80"].status, "new");
  assert.equal(byKey["program-a::pe-bench:best_reps_at_weight:80"].previousValue, 5);
  assert.equal(byKey["program-a::pe-bench:best_weight:"], undefined, "80 kg is below the 90 kg record: not reported");
  assert.equal(byKey["program-a::pe-bench:best_session_volume:"], undefined, "880 kg is below 1510 kg");
  assert.equal(byKey["program-a::pe-db:best_session_volume:"].status, "tied");
  assert.equal(byKey["program-a::pe-db:best_session_volume:"].previousValue, 600);
  assert.equal(byKey["program-a::pe-chin:best_reps_at_weight:BW"].status, "tied");
  assert.equal(byKey["program-a::pe-plank:best_time:"].status, "new");
  assert.equal(byKey["program-a::pe-plank:best_time:"].previousValue, 50);
  assert.equal(byKey["program-a::pe-carry:best_distance:"].status, "new");
  assert.ok(found.every((record) => record.scope === "program" && record.eligible === true));

  // A first session: every record is "first", none "new".
  const first = detectNewRecords(computePersonalRecords({ ...context, sessions: [] }), s1, context);
  assert.ok(first.length > 0);
  assert.ok(first.every((record) => record.status === "first" && record.previousValue === null));

  // Foreign history is not a previous record for program-a: s1 after sb alone is still "first".
  const afterForeign = detectNewRecords(computePersonalRecords({ ...context, sessions: [sb] }), s1, context);
  assert.equal(afterForeign.find((record) => record.identityKey === "program-a::pe-bench" && record.type === "best_weight").status, "first");
  assert.equal(afterForeign.find((record) => record.identityKey === "program-a::pe-bench" && record.type === "best_weight").acrossProgramsStatus, null, "90 kg does not top the 100 kg roll-up");

  // A session that also tops the Library-wide roll-up says so.
  const s3 = { ...s2, id: "s3", date: "2026-09-15T18:00:00+03:00", workoutSets: [ws("pe-bench", "lib-bench", 1, 5, 105, 8)] };
  const top = detectNewRecords(records, s3, context).find((record) => record.type === "best_weight");
  assert.equal(top.status, "new");
  assert.equal(top.acrossPrograms, true);

  // Timed records rank by load first: a longer hold at a lighter load is not
  // a new record, a shorter hold at a heavier load is (H5 fix round 1).
  const longerLighter = { ...s2, id: "s2-light", date: "2026-09-16T18:00:00+03:00", workoutSets: [{ programExerciseId: "pe-plank", exerciseId: "lib-plank", setNumber: 1, seconds: 90, actualWeight: "BW", actualRPE: 8, completed: true }] };
  const afterS2 = computePersonalRecords({ ...context, sessions: [sb, s1, s2] });
  assert.equal(detectNewRecords(afterS2, longerLighter, context).some((record) => record.type === "best_time"), false, "90 s at BW does not beat 70 s at 10 kg");
  const shorterHeavier = { ...longerLighter, id: "s2-heavy", workoutSets: [{ programExerciseId: "pe-plank", exerciseId: "lib-plank", setNumber: 1, seconds: 40, actualWeight: 15, actualRPE: 8, completed: true }] };
  const heavier = detectNewRecords(afterS2, shorterHeavier, context).find((record) => record.type === "best_time");
  assert.equal(heavier.status, "new", "40 s at 15 kg beats 70 s at 10 kg");
  assert.equal(heavier.previousValue, 70);
  // A weight-mode change starts over: the first per-dumbbell session after
  // kg sets is "first", never "new" against the kg records.
  const kgHistory = { ...s1, id: "kg-db", workoutSets: [ws("pe-db", "lib-db-press", 1, 10, 60, 8, { weightMode: "kg" })] };
  const modeSwitch = { ...s2, id: "db-mode", date: "2026-09-16T18:00:00+03:00", workoutSets: [ws("pe-db", "lib-db-press", 1, 10, 32, 8, { weightMode: "per dumbbell" })] };
  const switched = detectNewRecords(computePersonalRecords({ ...context, sessions: [kgHistory] }), modeSwitch, context);
  assert.ok(switched.length > 0);
  assert.ok(switched.every((record) => record.status === "first" && record.previousValue === null), "no record is announced across the mode change");

  assert.deepEqual(detectNewRecords(before, null, context), []);
  assert.deepEqual(detectNewRecords(null, { id: "empty", programId: "program-a", workoutSets: [] }, context), []);

  const ineligible = listIneligibleSets(s1, context);
  assert.deepEqual(
    ineligible.map((entry) => [entry.exerciseName, entry.setIndex, entry.reason]),
    [["Bench Press", 2, "12 reps: e1RM only for 1-10 reps"], ["Bench Press", 3, "RPE 5: e1RM needs RPE 6 or higher (or no RPE)"]],
  );
}

// ---------------------------------------------------------------------------
// Weight-mode change: earlier sets under another mode are not comparable
// ---------------------------------------------------------------------------
{
  const oldMode = { id: "old", date: "2026-08-01T18:00:00+03:00", programId: "program-a", dayId: "day-1", workoutSets: [ws("pe-db", "lib-db-press", 1, 10, 60, 8, { weightMode: "kg" })] };
  const changed = computePersonalRecords({ ...context, sessions: [s1, oldMode] });
  const db = changed.primary["program-a::pe-db"];
  assert.equal(db.weightMode, "per dumbbell", "the identity keeps the most recent mode");
  assert.equal(db.records.best_weight.value, 30, "the 60 kg (total) set is not a 60 kg per-dumbbell record");
  assert.equal(db.ineligibleSets.length, 1);
  assert.match(db.ineligibleSets[0].reason, /weight mode changed/);
  assert.equal(changed.acrossPrograms["lib-db-press::reps::kg"].records.best_weight.value, 60, "the roll-up keeps it under its own mode");
}

// ---------------------------------------------------------------------------
// Legacy sets without ids attach only unambiguously
// ---------------------------------------------------------------------------
{
  const lookup = buildRecordsLookup(context);
  // lib-bench is in two programs: a legacy set by Library id is ambiguous.
  const legacyBench = { id: "legacy-bench", date: "2026-07-01T18:00:00+03:00", dayId: "day-1", workoutSets: [{ exerciseId: "lib-bench", setNumber: 1, actualReps: 5, actualWeight: 120, actualRPE: 8 }] };
  const ambiguous = computePersonalRecords({ ...context, sessions: [legacyBench, s1] });
  assert.equal(ambiguous.primary["program-a::pe-bench"].records.best_weight.value, 90, "120 kg is not attributed to program-a");
  assert.equal(ambiguous.primary["program-b::pe-bench-b"], undefined);
  assert.equal(ambiguous.unattributed.length, 1);
  assert.match(ambiguous.unattributed[0].reason, /matches 2 program exercises by Library id/);
  assert.equal(ambiguous.acrossPrograms["lib-bench::reps::kg"].records.best_weight.value, 120, "it still counts across programs");

  // lib-db-press is in one program: a legacy set attaches.
  const legacyDb = { id: "legacy-db", date: "2026-07-02T18:00:00+03:00", dayId: "day-1", workoutSets: [{ exerciseId: "lib-db-press", setNumber: 1, actualReps: 10, actualWeight: 32, actualRPE: 8 }] };
  const unique = computePersonalRecords({ ...context, sessions: [legacyDb, s1] });
  assert.equal(unique.primary["program-a::pe-db"].records.best_weight.value, 32);
  assert.equal(unique.primary["program-a::pe-db"].records.best_weight.sessionId, "legacy-db");
  assert.deepEqual(unique.unattributed, []);

  // A legacy session that names another program is never attached to program-a's occurrence.
  const foreignLegacy = { ...legacyDb, id: "foreign-legacy", programId: "program-b" };
  const foreign = computePersonalRecords({ ...context, sessions: [foreignLegacy, s1] });
  assert.equal(foreign.primary["program-a::pe-db"].records.best_weight.value, 30);
  assert.equal(foreign.unattributed[0].reason, "legacy set belongs to another program");

  // Direct attribution API.
  assert.deepEqual(attributeRecordIdentity({ identitySource: "exact", programId: "p", programExerciseId: "x" }, lookup), { key: "p::x", reason: null });
  assert.equal(attributeRecordIdentity({ identitySource: "none" }, lookup).key, null);
  assert.equal(attributeRecordIdentity({ identitySource: "none", programId: "p", programExerciseId: "retired" }, lookup).key, "p::retired", "a retired occurrence keeps its own identity");
  assert.equal(attributeRecordIdentity({ identitySource: "loose", programId: "program-b", programExerciseId: "pe-bench" }, lookup).key, "program-b::pe-bench", "a foreign program's set with program-a's occurrence id is its own identity, never program-a's");

  // Legacy exercises map with a session of the retired-id shape.
  const legacyMap = { id: "legacy-map", date: "2026-07-03T18:00:00+03:00", programId: "program-a", dayId: "day-1", exercises: { "pe-db": { exerciseId: "lib-db-press", exerciseRPE: 8, sets: [{ reps: 8, weight: 34 }, { reps: null, weight: null }] } } };
  const mapped = computePersonalRecords({ ...context, sessions: [legacyMap] });
  assert.equal(mapped.primary["program-a::pe-db"].records.best_weight.value, 34);
  assert.equal(mapped.primary["program-a::pe-db"].records.best_e1rm.rpe, 8, "exercise RPE fills in the set RPE");
}

// Day view models are accepted as programExercises too (what the recap passes).
{
  const viewModels = [
    { id: "pe-bench", programExerciseId: "pe-bench", libraryExerciseId: "lib-bench", programId: "program-a", name: "Bench Press", sets: 3, repsMin: 5, repsMax: 8, repsLabel: "5-8", targetRPE: 8, restSeconds: 150, recommendedWeight: 80, loadType: "external", weightMode: "kg" },
  ];
  const result = computePersonalRecords({ programs, programExercises: viewModels, exerciseLibrary, sessions: [s1] });
  assert.equal(result.primary["program-a::pe-bench"].records.best_weight.value, 90);
  assert.equal(result.primary["program-a::pe-bench"].name, "Bench Press");
  assert.deepEqual(computePersonalRecords(), { primary: {}, acrossPrograms: {}, unattributed: [] });
}

// Determinism: same input, same output; nothing depends on the clock.
{
  const a = JSON.stringify(computePersonalRecords({ ...context, sessions: [s2, sb, s1] }));
  const b = JSON.stringify(computePersonalRecords({ ...context, sessions: [s1, s2, sb] }));
  assert.equal(a, b, "input order never changes the records");
}

// No medical claims in any produced string.
{
  const strings = [];
  Object.values(records.primary).forEach((identity) => identity.ineligibleSets.forEach((entry) => strings.push(entry.reason)));
  records.unattributed.forEach((entry) => strings.push(entry.reason));
  strings.forEach((text) => assert.doesNotMatch(String(text), /injury|overtraining syndrome|diagnos/i, text));
}

console.log("Personal records verification passed.");
