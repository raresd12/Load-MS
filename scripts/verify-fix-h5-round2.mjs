// Phase H5, fix round 2 (decisions H5-46 to H5-56). One block per finding:
//  1. a regenerated plan is frozen by the session's own snapshot only (H5-47)
//  2. a deload session is no history evidence (H5-46)
//  3. per side / load type reach the comparability check in the recap and on Progress (H5-20)
//  4. records never compare across a per-side / load-type change (H5-48)
//  5. the recap comparison ranks only sessions logged under today's profile (H5-51)
//  6. a set with a retired occurrence id keeps its own record identity (H5-49)
//  7. no weighted set today: the recap comparison ranks no e1RM (H5-51)
//  8. the weekly review counts only records that beat an earlier value (H5-50)
//  9. a 0 kg / negative load is not e1RM eligible (H5-29)
// 10. an optional day is never the stored "up next" pointer (H5-53)
// 11. time_first / distance_first only on an exercise measured that way (H5-52)
// 12. "additional load" on a required load does not promise "blank means BW" (H5-55)
// 13. Records dates are local dates (H5-56)
// 14. the program card week is derived on read (H5-54)
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

const storage = new MemoryLocalStorage();
globalThis.window = { localStorage: storage };
console.warn = () => {};

const { STORAGE_KEYS } = await import("../src/lib/storage.js");
const { buildExerciseProfile, generateNextPlan, getProgressionModeMeasurement } = await import("../src/lib/progression.js");
const { computePersonalRecords, detectNewRecords, getRecordRollupKey } = await import("../src/lib/personalRecords.js");
const {
  buildProgressAnalytics,
  buildSelectedExerciseAnalytics,
  buildWeeklyReview,
  countRecordsInWindow,
  getE1rmEligibility,
} = await import("../src/lib/sessionAnalytics.js");
const { buildPostWorkoutCoachRecap } = await import("../src/lib/workoutRecap.js");
const {
  applyProgramDraft,
  collectProgramExerciseProfileErrors,
  DEFAULT_PROGRAM_ID,
  deriveProgramStatePatchFromSessions,
  duplicateProgram,
  exportProgramShare,
  getFirstScheduledDayId,
  getProgramDays,
  getProgramDayViewModels,
  getProgramState,
  getProgramStateForDisplay,
  getPrograms,
  getScheduledDayIdFrom,
  importProgramShare,
  saveProgramDraft,
  seedDefaultProgramIfNeeded,
  updateProgramState,
} = await import("../src/lib/programStorage.js");
const { draftFromProgram, updateDayMeta } = await import("../src/lib/programDraft.js");
const { buildCoachProfilePatch, buildRecordsSections, createCoachProfileForm, formatProgramWeekLabel } = await import(
  "../src/lib/coachControlsView.js"
);
const {
  ADDITIONAL_LOAD_NOTE,
  getSetEntryLabels,
  getSetEntryProfile,
  REQUIRED_ADDITIONAL_LOAD_NOTE,
  toDraftSetPatch,
} = await import("../src/lib/setEntryView.js");
const { isValidWeightEntry } = await import("../src/lib/sessionNormalize.js");

// ---------------------------------------------------------------------------
// 1 + 2. Engine: regenerated plans and deload sessions as history.
// ---------------------------------------------------------------------------
{
  const bench = {
    id: "pe-bench",
    name: "Bench Press",
    category: "compound",
    equipment: "barbell",
    muscleGroup: "chest",
    priority: "medium",
    progressionType: "hypertrophy",
    sets: 3,
    repsMin: 8,
    repsMax: 10,
    repsLabel: "8-10",
    targetRPE: 8,
    restSeconds: 120,
    recommendedWeight: 100,
    loadType: "external",
  };
  const planned = (extra = {}) => ({
    sets: 3, repsMin: 8, repsMax: 10, repsLabel: "8-10", restSeconds: 120, targetRPE: 8, recommendedWeight: 100, ...extra,
  });
  const session = (id, date, reps, weight, rpe, snapshotExtra = {}) => ({
    id,
    date: `${date}T10:00:00.000Z`,
    programId: "p",
    dayId: "d",
    dayName: "Day",
    sessionRpe: 7,
    readiness: { status: "green", averageScore: 4.3, isGood: true, isPoor: false },
    plannedExercises: { exercises: { [bench.id]: planned(snapshotExtra) } },
    exercises: {
      [bench.id]: {
        programExerciseId: bench.id,
        exerciseId: bench.id,
        exerciseRPE: rpe,
        sets: reps.map((value) => ({ reps: value, weight, rpe })),
      },
    },
  });
  const dayOf = (exercise, extra = {}) => ({ id: "d", name: "Day", type: "lifting", exercises: [exercise], ...extra });
  const activeDeload = { level: "deload", remainingSessions: 2 };
  const activeHold = { mode: "hold", remainingSessions: 2, programExerciseId: bench.id };

  // 1. A session logged BEFORE the deload / hold, regenerated while it is active.
  const s0 = session("s0", "2026-02-01", [10, 10, 10], 100, 7);
  const control = generateNextPlan(dayOf(bench), s0, []).exercises[0];
  assert.equal(control.decision, "increase_load");
  assert.equal(control.recommendedWeight, 102.5);

  const deloadDay = dayOf({ ...bench, deload: activeDeload }, { deload: activeDeload });
  const newSaveUnderDeload = generateNextPlan(deloadDay, s0, []);
  assert.equal(newSaveUnderDeload.status, "deload", "a NEW save under an active deload is still frozen (H5-7)");

  const regenerated = generateNextPlan(deloadDay, s0, [], { regenerated: true });
  assert.equal(regenerated.status, "generated", "H5-47: the active deload does not freeze a session logged before it");
  assert.equal(regenerated.exercises[0].decision, "increase_load");
  assert.equal(regenerated.exercises[0].recommendedWeight, 102.5);
  assert.ok(!regenerated.exercises[0].deloadSession);
  assert.ok(!regenerated.readinessNotes.some((note) => /logged under a/.test(note)), "no false 'logged under a deload' note");
  assert.equal(regenerated.deload, undefined);

  const heldDay = dayOf({ ...bench, override: activeHold });
  assert.equal(generateNextPlan(heldDay, s0, []).exercises[0].held, true, "a NEW save under a hold is still frozen (H5-6)");
  const regeneratedHeld = generateNextPlan(heldDay, s0, [], { regenerated: true }).exercises[0];
  assert.equal(regeneratedHeld.decision, "increase_load", "H5-47: the active hold does not freeze a session logged before it");
  assert.ok(!regeneratedHeld.held);
  assert.equal(
    generateNextPlan(dayOf(bench), s0, [], { regenerated: true, overrides: [activeHold] }).exercises[0].decision,
    "increase_load",
    "an explicit overrides option is ignored for a regenerated plan too",
  );

  // H5-15 still holds: a session whose snapshot says deload / held stays frozen when regenerated.
  const loggedUnderDeload = session("sd", "2026-02-02", [10, 10, 10], 85, 6, { deloadSession: true, deloadLevel: "deload" });
  const frozen = generateNextPlan(dayOf(bench), loggedUnderDeload, [], { regenerated: true });
  assert.equal(frozen.status, "deload");
  assert.equal(frozen.exercises[0].deloadSession, true);
  const loggedUnderHold = session("sh", "2026-02-02", [10, 10, 10], 100, 7, { held: true, overrideMode: "hold" });
  assert.equal(generateNextPlan(dayOf(bench), loggedUnderHold, [], { regenerated: true }).exercises[0].held, true);

  // 2. Deload sessions are no history evidence.
  const conservative = { ...bench, programProfile: { aggression: "conservative" } };
  const first = session("h0", "2026-02-01", [8, 8, 8], 100, 8);
  const d1 = session("h1", "2026-02-04", [10, 10, 10], 85, 6, { deloadSession: true, deloadLevel: "deload", recommendedWeight: 85 });
  const d2 = session("h2", "2026-02-07", [10, 10, 10], 85, 6, { deloadSession: true, deloadLevel: "deload", recommendedWeight: 85 });
  const after = session("h3", "2026-02-10", [10, 10, 10], 100, 8);

  const controlConservative = generateNextPlan(dayOf(conservative), after, [first]).exercises[0];
  assert.equal(controlConservative.decision, "hold", "one strong session: a conservative program waits");
  const withDeloads = generateNextPlan(dayOf(conservative), after, [d2, d1, first]).exercises[0];
  assert.equal(withDeloads.decision, controlConservative.decision, "H5-46: deload sessions do not unlock the step-up");
  assert.equal(withDeloads.recommendedWeight, controlConservative.recommendedWeight);
  assert.deepEqual(withDeloads.reasons, controlConservative.reasons, "same evidence, same reasons");
  assert.equal(withDeloads.historySampleSize, controlConservative.historySampleSize);

  const standardControl = generateNextPlan(dayOf(bench), after, [first]).exercises[0];
  const standardWithDeloads = generateNextPlan(dayOf(bench), after, [d2, d1, first]).exercises[0];
  assert.deepEqual(standardWithDeloads.reasons, standardControl.reasons);
  assert.ok(!standardWithDeloads.reasons.some((reason) => /Two strong sessions in a row/.test(reason)));

  // A deload session is training that happened: it still prevents a "long break".
  const oldFirst = session("o0", "2025-12-01", [8, 8, 8], 100, 8);
  const recentDeload = session("o1", "2026-02-07", [10, 10, 10], 85, 6, { deloadSession: true, deloadLevel: "deload" });
  const noBreak = generateNextPlan(dayOf(bench), after, [recentDeload, oldFirst]).exercises[0];
  const longBreak = generateNextPlan(dayOf(bench), after, [oldFirst]).exercises[0];
  assert.ok(JSON.stringify(longBreak).includes("break"), "control: 71 days without a session is a long break");
  assert.notDeepEqual(noBreak.reasons, longBreak.reasons, "the deload session counts as training for the long-break check");
}

// ---------------------------------------------------------------------------
// 3 + 4. Per side toggled between two identical sessions.
// ---------------------------------------------------------------------------
const splitDay = {
  id: "day-1",
  name: "Legs",
  exercises: [
    {
      id: "pe-split", programExerciseId: "pe-split", libraryExerciseId: "lib-split", name: "Split Squat", programId: "P",
      sets: 3, repsMin: 10, repsMax: 10, repsLabel: "10", targetRPE: 8, restSeconds: 90, recommendedWeight: 20,
      loadType: "external", weightMode: "kg",
    },
  ],
};
const splitSet = (sessionId, setNumber, extra) => ({
  sessionId, programId: "P", dayId: "day-1", programExerciseId: "pe-split", exerciseId: "lib-split", setNumber,
  actualReps: 10, actualWeight: 20, actualRPE: 8, completed: true, measurement: "reps", weightMode: "kg", loadType: "external", ...extra,
});
const splitSession = (id, date, extra) => ({
  id, date, programId: "P", dayId: "day-1", dayName: "Legs", sessionRpe: 8,
  workoutSets: [1, 2, 3].map((setNumber) => splitSet(id, setNumber, extra)),
});
const twoSided = splitSession("a", "2026-09-01T10:00:00.000Z", { perSide: false });
const perSide = splitSession("b", "2026-09-05T10:00:00.000Z", { perSide: true });
const splitContext = { programs: [{ id: "P", name: "P" }], programExercises: splitDay.exercises, activeProgram: { id: "P" } };

{
  const recap = buildPostWorkoutCoachRecap(perSide, [twoSided], splitDay, null, splitContext);
  assert.equal(recap.totalVolume, 1200, "per side doubles the tonnage (H5-1)");
  assert.match(recap.improvedText, /^Not comparable: measurement changed/, recap.improvedText);
  assert.ok(!/improved from/.test(recap.improvedText));

  const analytics = buildProgressAnalytics({
    sessions: [twoSided, perSide], readinessByDate: {}, programs: splitContext.programs,
    activeProgram: { id: "P", name: "P" }, activeProgramDays: [splitDay], exerciseLibrary: [], now: Date.parse("2026-09-06T00:00:00.000Z"),
  });
  const option = analytics.exerciseOptions.find((entry) => entry.programExerciseId === "pe-split");
  const selected = buildSelectedExerciseAnalytics(option, analytics.setRecords);
  assert.equal(selected.recentSessions[0].perSide, true);
  assert.equal(selected.recentSessions[1].perSide, false);
  assert.equal(selected.recentSessions[0].loadType, "external");
  assert.equal(selected.comparability.comparable, false, "Progress: a per-side change is not comparable");
  assert.equal(selected.comparability.changed, "perSide");

  // Same profile on both sides: still comparable.
  const same = buildSelectedExerciseAnalytics(
    option,
    buildProgressAnalytics({
      sessions: [twoSided, splitSession("c", "2026-09-05T10:00:00.000Z", { perSide: false })], readinessByDate: {}, programs: splitContext.programs,
      activeProgram: { id: "P", name: "P" }, activeProgramDays: [splitDay], exerciseLibrary: [], now: Date.parse("2026-09-06T00:00:00.000Z"),
    }).setRecords,
  );
  assert.equal(same.comparability.comparable, true);

  // 4. Records.
  const before = computePersonalRecords({ ...splitContext, sessions: [twoSided] });
  assert.equal(before.primary["P::pe-split"].records.best_session_volume.value, 600);
  const detected = detectNewRecords(before, perSide, splitContext);
  assert.ok(detected.length > 0);
  assert.ok(detected.every((record) => record.status === "first"), "H5-48: a per-side change starts over, nothing 'beats' the two-sided record");
  assert.ok(detected.every((record) => record.acrossPrograms === false));
  assert.ok(!/New record/.test(recap.recordsText), recap.recordsText);

  const both = computePersonalRecords({ ...splitContext, sessions: [twoSided, perSide] });
  const identity = both.primary["P::pe-split"];
  assert.equal(identity.perSide, true, "the identity keeps the profile of its most recent set");
  assert.equal(identity.records.best_session_volume.value, 1200);
  assert.equal(identity.records.best_session_volume.previousValue, null, "the two-sided session is not its predecessor");
  assert.equal(identity.ineligibleSets.filter((entry) => entry.type === "all").length, 3, "the two-sided sets are listed as not comparable");
  assert.match(identity.ineligibleSets[0].reason, /now reps \/ kg \/ per side/);
  assert.equal(getRecordRollupKey("lib-split", "reps", "kg"), "lib-split::reps::kg", "default key unchanged");
  assert.deepEqual(Object.keys(both.acrossPrograms).sort(), ["lib-split::reps::kg", "lib-split::reps::kg::per side"], "the roll-up never mixes per-side and two-sided sets");
  assert.equal(both.acrossPrograms["lib-split::reps::kg"].records.best_session_volume.value, 600);

  // A load-type change is the same guard.
  const optional = splitSession("o", "2026-09-07T10:00:00.000Z", { perSide: true, loadType: "optionalExternal" });
  assert.ok(detectNewRecords(both, optional, splitContext).every((record) => record.status === "first"));
  assert.equal(getRecordRollupKey("x", "reps", "kg", { perSide: true, loadType: "optionalExternal" }), "x::reps::kg::per side::optionalExternal");

  // Same profile: a better session is still a new record.
  const heavier = { ...splitSession("h", "2026-09-09T10:00:00.000Z", { perSide: true, actualWeight: 22.5 }) };
  const better = detectNewRecords(both, heavier, splitContext);
  assert.equal(better.find((record) => record.type === "best_session_volume").status, "new");
}

// ---------------------------------------------------------------------------
// 5 + 7. Recap comparison.
// ---------------------------------------------------------------------------
{
  const day = {
    id: "d1", name: "Push",
    exercises: [{ id: "pe-db", programExerciseId: "pe-db", libraryExerciseId: "lib-db", name: "DB Press", sets: 1, repsMin: 8, repsMax: 10, repsLabel: "8-10", loadType: "external", weightMode: "per dumbbell" }],
  };
  const session = (id, date, weight, weightMode) => ({
    id, date, programId: "P", dayId: "d1", dayName: "Push", sessionRpe: 8,
    workoutSets: [{ sessionId: id, programId: "P", dayId: "d1", programExerciseId: "pe-db", exerciseId: "lib-db", setNumber: 1, actualReps: 10, actualWeight: weight, actualRPE: 8, completed: true, measurement: "reps", weightMode, loadType: "external", perSide: false }],
  });
  const p1 = session("p1", "2026-09-01T10:00:00.000Z", 40, "kg");
  const p2 = session("p2", "2026-09-03T10:00:00.000Z", 42, "kg");
  const p3 = session("p3", "2026-09-05T10:00:00.000Z", 44, "kg");
  const today = session("t", "2026-09-08T10:00:00.000Z", 22, "per dumbbell");

  const recap = buildPostWorkoutCoachRecap(today, [p3, p2, p1], day, null);
  assert.match(recap.improvedText, /^Not comparable: measurement changed/);
  assert.equal(recap.comparison.comparable, false, "H5-51: kg sessions are not comparable sessions of a per-dumbbell log");
  assert.equal(recap.comparisonText, "Not comparable yet: 1 more session needed.");
  assert.ok(!/58\.7/.test(recap.comparisonText));

  // Once two sessions share today's profile they are ranked, the kg ones still left out.
  const next = session("t2", "2026-09-10T10:00:00.000Z", 24, "per dumbbell");
  const ranked = buildPostWorkoutCoachRecap(next, [today, p3, p2, p1], day, null).comparison;
  assert.equal(ranked.comparable, true);
  assert.equal(ranked.rankedCount, 2);
  assert.equal(ranked.isBest, true);
  assert.equal(ranked.exerciseName, "DB Press");

  // Unchanged profile: the pre-fix ranking is intact.
  const kgToday = session("k", "2026-09-08T10:00:00.000Z", 46, "kg");
  const kgRanked = buildPostWorkoutCoachRecap(kgToday, [p3, p2, p1], day, null).comparison;
  assert.equal(kgRanked.rankedCount, 4);
  assert.equal(kgRanked.isBest, true);

  // 7. No weighted set today.
  const bwDay = {
    id: "d2", name: "Pull",
    exercises: [
      { id: "pe-chin", programExerciseId: "pe-chin", libraryExerciseId: "lib-chin", name: "Chin-up", sets: 1, repsMin: 6, repsMax: 8, repsLabel: "6-8", loadType: "optionalExternal", weightMode: "additional load" },
      { id: "pe-dip", programExerciseId: "pe-dip", libraryExerciseId: "lib-dip", name: "Dip", sets: 1, repsMin: 6, repsMax: 8, repsLabel: "6-8", loadType: "optionalExternal", weightMode: "additional load" },
    ],
  };
  const bwSession = (id, date, chin, dip) => ({
    id, date, programId: "P", dayId: "d2", dayName: "Pull", sessionRpe: 8,
    workoutSets: [["pe-chin", "lib-chin", chin], ["pe-dip", "lib-dip", dip]].map(([pe, lib, weight], index) => ({
      sessionId: id, programId: "P", dayId: "d2", programExerciseId: pe, exerciseId: lib, setNumber: index + 1,
      actualReps: 8, actualWeight: weight, actualRPE: 8, completed: true, measurement: "reps", weightMode: "additional load", loadType: "optionalExternal", perSide: false,
    })),
  });
  const b1 = bwSession("b1", "2026-09-01T10:00:00.000Z", 10, 25);
  const b2 = bwSession("b2", "2026-09-05T10:00:00.000Z", 10, 30);
  const bwToday = bwSession("b3", "2026-09-08T10:00:00.000Z", "BW", "BW");
  const comparison = buildPostWorkoutCoachRecap(bwToday, [b2, b1], bwDay, null).comparison;
  assert.notEqual(comparison.metricId === "e1rm" && comparison.comparable, true, "H5-51: no anchor today, no e1RM ranking across the lifts of the day");
  assert.ok(!/Best e1RM for this day/.test(comparison.text), comparison.text);
  assert.ok(!/38 kg/.test(comparison.text), comparison.text);
  // With a weighted set today the per-exercise anchor still works (H5-25).
  const weighted = buildPostWorkoutCoachRecap(bwSession("b4", "2026-09-08T10:00:00.000Z", 12.5, "BW"), [b2, b1], bwDay, null).comparison;
  assert.equal(weighted.metricId, "e1rm");
  assert.equal(weighted.exerciseName, "Chin-up");
}

// ---------------------------------------------------------------------------
// 6. Retired occurrence id.
// ---------------------------------------------------------------------------
{
  const context = {
    programs: [{ id: "P", name: "P" }],
    programExercises: [{ id: "pe-new", programId: "P", dayId: "day-1", exerciseId: "lib-bench", targetSets: 3, targetReps: { min: 5, max: 8, label: null }, targetRPE: 8, restTime: 120, targetWeight: 80, loadType: "external", weightMode: "kg" }],
    exerciseLibrary: [{ id: "lib-bench", name: "Bench Press", equipment: "barbell" }],
  };
  const set = (programExerciseId, weight) => ({ programId: "P", ...(programExerciseId ? { programExerciseId } : {}), exerciseId: "lib-bench", setNumber: 1, actualReps: 5, actualWeight: weight, actualRPE: 8, completed: true });
  const retired = { id: "r1", date: "2026-08-01T10:00:00.000Z", programId: "P", dayId: "day-1", workoutSets: [set("pe-old", 100)] };
  const current = { id: "r2", date: "2026-08-08T10:00:00.000Z", programId: "P", dayId: "day-1", workoutSets: [set("pe-new", 80)] };
  const legacy = { id: "r3", date: "2026-08-09T10:00:00.000Z", programId: "P", dayId: "day-1", workoutSets: [set(null, 70)] };

  const records = computePersonalRecords({ ...context, sessions: [retired, current, legacy] });
  assert.deepEqual(Object.keys(records.primary).sort(), ["P::pe-new", "P::pe-old"], "H5-49: the retired id keeps its own identity");
  assert.equal(records.primary["P::pe-new"].records.best_weight.value, 80, "the retired occurrence's 100 kg is not this occurrence's record");
  assert.equal(records.primary["P::pe-old"].records.best_weight.value, 100);
  assert.equal(records.primary["P::pe-new"].sessionCount, 2, "a set WITHOUT an occurrence id still attaches by its unique Library id (H5-8)");
  assert.equal(records.unattributed.length, 0);
  assert.equal(records.acrossPrograms["lib-bench::reps::kg"].records.best_weight.value, 100, "the roll-up still sees every set of the Library exercise");
  assert.ok(detectNewRecords(computePersonalRecords({ ...context, sessions: [retired] }), current, context).every((record) => record.status === "first"));
}

// ---------------------------------------------------------------------------
// 8. Weekly review record count.   9. e1RM eligibility.
// ---------------------------------------------------------------------------
{
  const names = ["Bench", "Row", "Squat"];
  const day = {
    id: "wd", name: "Full",
    exercises: names.map((name) => ({ id: `pe-${name}`, programExerciseId: `pe-${name}`, libraryExerciseId: `lib-${name}`, name, programId: "W", sets: 3, repsMin: 6, repsMax: 10, repsLabel: "6-10", loadType: "external", weightMode: "kg" })),
  };
  const session = (id, date, loads) => ({
    id, date, programId: "W", dayId: "wd", dayName: "Full", sessionRpe: 8,
    workoutSets: names.flatMap((name) =>
      loads.map(([weight, reps], index) => ({
        sessionId: id, programId: "W", dayId: "wd", programExerciseId: `pe-${name}`, exerciseId: `lib-${name}`, setNumber: index + 1,
        actualReps: reps, actualWeight: weight, actualRPE: 8, completed: true, measurement: "reps", weightMode: "kg", loadType: "external", perSide: false,
      })),
    ),
  });
  const context = { programs: [{ id: "W", name: "W" }], programExercises: day.exercises, activeProgram: { id: "W" } };
  const first = session("w1", "2026-09-28T10:00:00.000Z", [[60, 10], [65, 8], [70, 6]]);
  const now = Date.parse("2026-10-02T12:00:00.000Z");
  const weekMs = 7 * 86400000;

  const firstRecords = computePersonalRecords({ ...context, sessions: [first] });
  assert.equal(buildPostWorkoutCoachRecap(first, [], day, null, context).recordsText, "First records for this day logged - the next repeat can beat them.");
  assert.deepEqual(countRecordsInWindow(firstRecords, now - weekMs, now), { count: 0, examples: [] }, "H5-50: first values are baselines, not records");
  const analytics = (sessions) => buildProgressAnalytics({ sessions, readinessByDate: {}, programs: context.programs, activeProgram: { id: "W", name: "W" }, activeProgramDays: [day], exerciseLibrary: [], now });
  const firstAnalytics = analytics([first]);
  const firstReview = buildWeeklyReview(firstAnalytics.sessionSummaries, firstAnalytics.setRecords, now, { sessions: [first], records: firstRecords });
  assert.ok(!firstReview.notes.some((note) => /new records? this week/.test(note)), firstReview.notes.join(" | "));

  // The next session: new top weight 72.5 x 6 (best weight, e1RM, volume) and
  // a first "6 reps at 72.5" that the recap does not announce either.
  const second = session("w2", "2026-10-01T10:00:00.000Z", [[60, 10], [65, 8], [72.5, 6]]);
  const bothRecords = computePersonalRecords({ ...context, sessions: [first, second] });
  const window = countRecordsInWindow(bothRecords, now - weekMs, now);
  const announced = detectNewRecords(firstRecords, second, context).filter((record) => record.status === "new");
  assert.equal(announced.length, 9, "3 exercises x (e1RM, top weight, session volume)");
  assert.equal(window.count, announced.length, "the weekly count is what the recap announced as new");
  assert.ok(window.examples.every((example) => !/reps at/.test(example)), window.examples.join(" | "));
  const bothAnalytics = analytics([first, second]);
  const review = buildWeeklyReview(bothAnalytics.sessionSummaries, bothAnalytics.setRecords, now, { sessions: [first, second], records: bothRecords });
  assert.ok(review.notes.some((note) => note.startsWith("9 new records this week")), review.notes.join(" | "));
  // Outside the window nothing counts.
  assert.equal(countRecordsInWindow(bothRecords, now - weekMs, Date.parse("2026-09-30T00:00:00.000Z")).count, 0);

  // 9.
  assert.equal(getE1rmEligibility({ weight: 0, reps: 5 }).eligible, false, "H5-29: a positive load");
  assert.match(getE1rmEligibility({ weight: 0, reps: 5 }).reason, /above 0 kg/);
  assert.equal(getE1rmEligibility({ weight: -5, reps: 5 }).eligible, false);
  assert.equal(getE1rmEligibility({ weight: 0, reps: 5, loadType: "optionalExternal" }).eligible, false);
  assert.equal(getE1rmEligibility({ weight: 2.5, reps: 5, loadType: "optionalExternal" }).eligible, true);
  assert.equal(getE1rmEligibility({ weight: 100, reps: 5, rpe: 8 }).eligible, true);
  const zero = { id: "z", date: "2026-10-01T10:00:00.000Z", programId: "W", dayId: "wd", workoutSets: [{ programId: "W", programExerciseId: "pe-Bench", exerciseId: "lib-Bench", setNumber: 1, actualReps: 5, actualWeight: 0, actualRPE: 8, completed: true }] };
  const zeroRecords = computePersonalRecords({ ...context, sessions: [zero] }).primary["W::pe-Bench"];
  assert.equal(zeroRecords.records.best_e1rm, null, "no 'e1RM 0 kg' record");
  assert.ok(zeroRecords.ineligibleSets.some((entry) => entry.type === "best_e1rm" && /above 0 kg/.test(entry.reason)), "and the set says why");
}

// ---------------------------------------------------------------------------
// 10. Optional days and the stored pointer.
// ---------------------------------------------------------------------------
assert.equal(getFirstScheduledDayId([{ id: "o", isOptional: true }, { id: "a" }, { id: "b" }]), "a");
assert.equal(getFirstScheduledDayId([{ id: "o", isOptional: true }]), "o", "all optional: all scheduled (H5-5)");
assert.equal(getFirstScheduledDayId([{ id: "a" }, { id: "b" }], "b"), "b");
assert.equal(getFirstScheduledDayId([{ id: "a" }, { id: "b", isOptional: true }], "b"), "a");
assert.equal(getFirstScheduledDayId([]), null);
assert.equal(getScheduledDayIdFrom([{ id: "a" }, { id: "b", isOptional: true }, { id: "c" }], "b"), "c", "an optional day hands over to the next scheduled day");
assert.equal(getScheduledDayIdFrom([{ id: "a" }, { id: "b" }, { id: "c", isOptional: true }], "c"), "a", "wraps");
assert.equal(getScheduledDayIdFrom([{ id: "a" }, { id: "b" }], "b"), "b");
assert.equal(getScheduledDayIdFrom([{ id: "a", isOptional: true }, { id: "b" }], "gone"), "b");
assert.equal(getScheduledDayIdFrom([{ id: "a", isOptional: true }], "a"), "a");

seedDefaultProgramIfNeeded();
{
  const copy = duplicateProgram(DEFAULT_PROGRAM_ID);
  assert.equal(copy.ok, true);
  const programId = copy.programId;
  const [dayOne, dayTwo] = getProgramDays(programId);
  assert.equal(getProgramState(programId).nextRecommendedDayId, dayOne.id);

  // Marking the "up next" day optional in the Studio moves the pointer.
  let draft = updateDayMeta(draftFromProgram(programId).draft, draftFromProgram(programId).draft.days[0].id, { isOptional: true });
  const applied = applyProgramDraft(draft);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(getProgramDayViewModels(programId)[0].isOptional, true);
  assert.equal(getProgramState(programId).nextRecommendedDayId, dayTwo.id, "H5-53: an optional day is not left as 'up next'");
  assert.equal(
    getProgramState(programId).nextRecommendedDayId,
    deriveProgramStatePatchFromSessions(programId, [], getProgramDays(programId)).nextRecommendedDayId,
    "the stored pointer agrees with the derivation of H5-5",
  );

  // A pointer on a scheduled day is not touched by an unrelated apply.
  const lastDay = getProgramDays(programId).at(-1);
  assert.ok(updateProgramState(programId, { nextRecommendedDayId: lastDay.id }));
  draft = updateDayMeta(draftFromProgram(programId).draft, draftFromProgram(programId).draft.days[1].id, { notes: "easy" });
  assert.equal(applyProgramDraft(draft).ok, true);
  assert.equal(getProgramState(programId).nextRecommendedDayId, lastDay.id);

  // A duplicate, a shared copy and a new program saved from a draft start on the first scheduled day.
  const second = duplicateProgram(programId);
  assert.equal(second.ok, true);
  const secondDays = getProgramDays(second.programId);
  assert.equal(secondDays[0].isOptional, true);
  assert.equal(getProgramState(second.programId).nextRecommendedDayId, secondDays[1].id, "duplicate");

  const share = exportProgramShare(programId);
  const imported = importProgramShare(share);
  assert.equal(imported.ok, true, JSON.stringify(imported).slice(0, 300));
  const importedDays = getProgramDays(imported.programId);
  assert.equal(importedDays[0].isOptional, true);
  assert.equal(getProgramState(imported.programId).nextRecommendedDayId, importedDays[1].id, "imported share");

  const fresh = { ...draftFromProgram(programId).draft, sourceProgramId: null };
  const saved = saveProgramDraft(fresh);
  assert.equal(saved.ok, true, JSON.stringify(saved).slice(0, 300));
  const savedDays = getProgramDays(saved.programId);
  assert.equal(savedDays[0].isOptional, true);
  assert.equal(getProgramState(saved.programId).nextRecommendedDayId, savedDays[1].id, "saved draft");

  // A program without a stored state falls back to the first scheduled day too.
  const states = JSON.parse(storage.getItem(STORAGE_KEYS.programStates)).filter((state) => state.programId !== saved.programId);
  storage.setItem(STORAGE_KEYS.programStates, JSON.stringify(states));
  assert.equal(getProgramState(saved.programId).nextRecommendedDayId, savedDays[1].id, "state fallback");

  // -------------------------------------------------------------------------
  // 14. Week label derived on read.
  // -------------------------------------------------------------------------
  const weekCopy = duplicateProgram(DEFAULT_PROGRAM_ID);
  const weekProgramId = weekCopy.programId;
  const weekDays = getProgramDays(weekProgramId);
  const scheduled = weekDays.filter((day) => !day.isOptional);
  const sessions = [];
  for (let index = 0; index < scheduled.length * 5; index += 1) {
    sessions.push({
      id: `wk-${index}`,
      programId: weekProgramId,
      dayId: scheduled[index % scheduled.length].id,
      date: new Date(Date.UTC(2026, 7, 1) + index * 86400000).toISOString(),
      exercises: {},
      workoutSets: [],
    });
  }
  storage.setItem(STORAGE_KEYS.sessions, JSON.stringify(sessions));
  // The state as it was written before H5: the literal week 1 / cycle 1.
  assert.equal(getProgramState(weekProgramId).currentWeek, 1);
  const program = getPrograms().find((entry) => entry.id === weekProgramId);
  assert.equal(formatProgramWeekLabel(getProgramState(weekProgramId), program), "Week 1", "the stored legacy state alone says week 1");
  const derived = deriveProgramStatePatchFromSessions(weekProgramId, sessions, weekDays);
  assert.equal(derived.currentWeek, 6);
  const shown = getProgramStateForDisplay(weekProgramId);
  assert.equal(shown.currentWeek, 6, "H5-54: the card derives the week from the sessions on read");
  assert.equal(shown.currentCycle, 1);
  assert.equal(formatProgramWeekLabel(shown, program), "Week 6");
  assert.equal(shown.nextRecommendedDayId, getProgramState(weekProgramId).nextRecommendedDayId, "only week and cycle are derived");
  assert.equal(getProgramState(weekProgramId).currentWeek, 1, "read only: nothing was written");
  // A program without sessions keeps its stored state; unreadable sessions too.
  assert.deepEqual(getProgramStateForDisplay(programId), getProgramState(programId));
  storage.setItem(STORAGE_KEYS.sessions, "{not json");
  assert.equal(getProgramStateForDisplay(weekProgramId).currentWeek, 1);
  storage.setItem(STORAGE_KEYS.sessions, JSON.stringify([]));

  // -------------------------------------------------------------------------
  // 11. Progression mode vs measurement.
  // -------------------------------------------------------------------------
  const repsExercise = getProgramDayViewModels(weekProgramId)
    .flatMap((day) => day.exercises)
    .find((exercise) => exercise.measurement === "reps" && Number.isFinite(exercise.repsMin));
  assert.ok(repsExercise, "a reps exercise in the default program");
  const refused = buildCoachProfilePatch({ ...createCoachProfileForm(repsExercise, null), progressionMode: "time_first" }, repsExercise);
  assert.equal(refused.ok, false, "H5-52: time_first on a reps exercise is refused");
  assert.match(refused.errors.join(" "), /needs an exercise measured in seconds; this one is measured in reps/);
  assert.equal(buildCoachProfilePatch({ ...createCoachProfileForm(repsExercise, null), progressionMode: "distance_first" }, repsExercise).ok, false);
  assert.equal(buildCoachProfilePatch({ ...createCoachProfileForm(repsExercise, null), progressionMode: "reps_first" }, repsExercise).ok, true);
}
assert.equal(getProgressionModeMeasurement("time_first"), "time");
assert.equal(getProgressionModeMeasurement("distance_first"), "distance");
assert.equal(getProgressionModeMeasurement("double_progression"), null);
assert.deepEqual(
  collectProgramExerciseProfileErrors({ targetReps: { min: null, max: null, label: "45 s" }, profileOverrides: { progressionMode: "time_first" } }),
  [],
  "time_first on a timed exercise is fine",
);
assert.equal(
  collectProgramExerciseProfileErrors({ targetReps: { min: null, max: null, label: "45 s" }, profileOverrides: { progressionMode: "distance_first" } }).length,
  1,
);
assert.equal(
  collectProgramExerciseProfileErrors({ targetReps: { min: 5, max: 7, label: null }, profileOverrides: { progressionMode: "time_first" } }).length,
  1,
);
{
  // A record that already carries the mismatch (older data) is read with its classified mode.
  const base = { id: "b", name: "Bench Press", category: "compound", equipment: "barbell", sets: 3, repsMin: 5, repsMax: 7, repsLabel: "5-7", targetRPE: 8, recommendedWeight: 60, loadType: "external" };
  const classified = buildExerciseProfile(base);
  const mismatched = buildExerciseProfile({ ...base, profileOverrides: { progressionMode: "time_first" } });
  assert.equal(mismatched.progressionMode, classified.progressionMode, "the engine ignores an unusable mode override");
  assert.equal(buildExerciseProfile({ ...base, profileOverrides: { progressionMode: "reps_first" } }).progressionMode, "reps_first");
  const session = {
    id: "m1", date: "2026-02-10T10:00:00.000Z", programId: "p", dayId: "d", sessionRpe: 7,
    readiness: { status: "green", averageScore: 4.3, isGood: true, isPoor: false },
    plannedExercises: { exercises: { b: { sets: 3, repsMin: 5, repsMax: 7, repsLabel: "5-7", targetRPE: 8, recommendedWeight: 60 } } },
    exercises: { b: { programExerciseId: "b", exerciseId: "b", exerciseRPE: 7, sets: [7, 7, 7].map((reps) => ({ reps, weight: 60, rpe: 7 })) } },
  };
  const plan = (exercise) => generateNextPlan({ id: "d", name: "D", type: "lifting", exercises: [exercise] }, session, []).exercises[0];
  const control = plan(base);
  const withMismatch = plan({ ...base, profileOverrides: { progressionMode: "time_first" } });
  assert.equal(control.decision, "increase_load");
  assert.equal(withMismatch.decision, control.decision, "the lift keeps progressing");
  assert.equal(withMismatch.recommendedWeight, control.recommendedWeight);
}

// ---------------------------------------------------------------------------
// 12. "additional load" on a required load.
// ---------------------------------------------------------------------------
{
  const weightedDips = { name: "Weighted Dips", loadType: "external", weightMode: "additional load", repsMin: 6, repsMax: 8, repsLabel: "6-8" };
  const profile = getSetEntryProfile(weightedDips);
  const labels = getSetEntryLabels(profile);
  assert.equal(labels.weightLabel, "+kg");
  assert.notEqual(labels.weightPlaceholder, "BW", "H5-55: the placeholder does not offer BW where BW is refused");
  assert.ok(!labels.notes.includes(ADDITIONAL_LOAD_NOTE), "no 'blank means BW' promise");
  assert.ok(labels.notes.includes(REQUIRED_ADDITIONAL_LOAD_NOTE));
  assert.ok(!/blank means BW/.test(labels.notes.join(" ")));
  // The hint matches what the save accepts.
  assert.equal(toDraftSetPatch({ value: "8", weight: "", rpe: "8" }, profile).weight, "");
  assert.equal(isValidWeightEntry("", weightedDips), false);
  assert.equal(isValidWeightEntry("BW", weightedDips), false);
  assert.equal(isValidWeightEntry("0", weightedDips), true, "'0 for none' is accepted");
  assert.equal(isValidWeightEntry("10", weightedDips), true);

  // The optional load keeps its hint, and blank still means BW there.
  const chin = { name: "Chin-up", loadType: "optionalExternal", weightMode: "additional load", repsMin: 5, repsMax: 8, repsLabel: "5-8" };
  const chinProfile = getSetEntryProfile(chin);
  const chinLabels = getSetEntryLabels(chinProfile);
  assert.equal(chinLabels.weightPlaceholder, "BW");
  assert.ok(chinLabels.notes.includes(ADDITIONAL_LOAD_NOTE));
  assert.equal(toDraftSetPatch({ value: "8", weight: "", rpe: "8" }, chinProfile).weight, "BW");
}

// ---------------------------------------------------------------------------
// 13. Records dates are local.
// ---------------------------------------------------------------------------
{
  // 01:30 on Oct 2 in Bucharest (UTC+3) is 22:30Z on Oct 1.
  const lateNight = {
    id: "ln", date: "2026-10-01T22:30:00.000Z", programId: "P", dayId: "day-1",
    workoutSets: [{ programId: "P", programExerciseId: "pe-split", exerciseId: "lib-split", setNumber: 1, actualReps: 8, actualWeight: 20, actualRPE: 8, completed: true }],
  };
  assert.equal(new Date(lateNight.date).getDate(), 2, "fixture runs in Europe/Bucharest");
  const sections = buildRecordsSections(computePersonalRecords({ ...splitContext, sessions: [lateNight] }), { programs: splitContext.programs, activeProgramId: "P" });
  const lines = sections[0].entries[0].lines;
  assert.ok(lines.length > 0);
  assert.ok(lines.every((line) => line.date === "2026-10-02"), `H5-56: local date, got ${lines.map((line) => line.date).join(", ")}`);
}

console.log("H5 fix round 2 verification passed.");
