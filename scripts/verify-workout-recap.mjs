// Phase H4 Track A: src/lib/workoutRecap.js (moved verbatim from src/App.jsx).
// Pins the post-workout recap texts for a better, an equal and a worse
// session versus the previous comparable one, and that history of another
// program is never the comparison (19.1 "Identity").
import assert from "node:assert/strict";

const {
  buildPostWorkoutCoachRecap,
  buildPostWorkoutImprovementText,
  buildPostWorkoutNextText,
  buildPostWorkoutWatchText,
  getPostWorkoutBestSet,
  getPostWorkoutCompletedSets,
  getPostWorkoutSessionMetrics,
  getPreviousComparableSession,
} = await import("../src/lib/workoutRecap.js");

const bench = { id: "pe-bench", programExerciseId: "pe-bench", libraryExerciseId: "lib-bench", name: "Bench Press", repsMin: 6, repsMax: 8 };
const chin = { id: "pe-chin", programExerciseId: "pe-chin", libraryExerciseId: "lib-chin", name: "Chin-up", repsMin: 5, repsMax: 10 };
const day = { id: "day-1", name: "Day 1", type: "training", exercises: [bench, chin] };

function benchSet(setNumber, reps, weight, rpe) {
  return {
    programExerciseId: "pe-bench",
    exerciseId: "lib-bench",
    setNumber,
    actualReps: reps,
    actualWeight: weight,
    actualRPE: rpe,
    completed: reps !== null && weight !== null && rpe !== null,
  };
}

function session(id, date, sets, extra = {}) {
  return {
    id,
    date,
    programId: "program-a",
    programName: "Custom Push",
    dayId: "day-1",
    dayName: "Day 1",
    sessionRpe: 7,
    readiness: { status: "green", isPoor: false },
    exercises: { "pe-bench": { painFlag: false, sets: [] } },
    workoutSets: sets,
    ...extra,
  };
}

const previous = session("prev", "2026-09-19T18:00:00+03:00", [benchSet(1, 8, 60, 8), benchSet(2, 8, 60, 8)]); // 960 kg, 16 reps
const better = session("better", "2026-09-26T18:00:00+03:00", [benchSet(1, 8, 62.5, 8), benchSet(2, 8, 62.5, 8)]); // 1000 kg
const equal = session("equal", "2026-09-26T18:00:00+03:00", [benchSet(1, 8, 60, 8), benchSet(2, 8, 60, 8)]);
const worse = session("worse", "2026-09-26T18:00:00+03:00", [benchSet(1, 6, 60, 9), benchSet(2, 6, 60, 9.5)]); // 720 kg
const foreign = session("foreign", "2026-09-24T18:00:00+03:00", [benchSet(1, 10, 100, 8)], { programId: "program-b" });

// ---------------------------------------------------------------------------
// Completed sets and best set
// ---------------------------------------------------------------------------
{
  const withEmpty = session("x", "2026-09-26T18:00:00+03:00", [
    benchSet(1, 8, 60, 8),
    benchSet(2, null, null, null),
    { programExerciseId: "pe-bench", exerciseId: "lib-bench", setNumber: 3, actualReps: 5, actualWeight: null, actualRPE: 8, completed: true },
    { programExerciseId: "pe-chin", exerciseId: "lib-chin", setNumber: 1, actualReps: 8, actualWeight: "BW", actualRPE: 8, completed: true },
  ]);
  const completed = getPostWorkoutCompletedSets(withEmpty, day);
  assert.deepEqual(completed.map((set) => [set.exerciseName, set.setNumber, set.weight, set.reps]), [
    ["Bench Press", 1, 60, 8],
    ["Chin-up", 1, "BW", 8],
  ], "an empty slot and a set without a load are not completed sets");
  assert.equal(completed[0].targetRepsMin, 6);
  assert.equal(completed[0].exerciseKey, "pe-bench");

  const best = getPostWorkoutBestSet(completed);
  assert.equal(best.weight, 60, "e1RM ranks the kg set above the BW set");
  assert.equal(getPostWorkoutBestSet([]), null);
  // Two BW sets: more reps wins (volume = reps when there is no kg).
  const bw = [{ weight: "BW", reps: 6 }, { weight: "BW", reps: 9 }];
  assert.equal(getPostWorkoutBestSet(bw).reps, 9);

  // Legacy session shape (exercises map, no workoutSets).
  const legacy = { exercises: { "pe-bench": { exerciseRPE: 8, sets: [{ reps: 5, weight: 70 }, { reps: null, weight: null }] } } };
  const legacyCompleted = getPostWorkoutCompletedSets(legacy, day);
  assert.equal(legacyCompleted.length, 1);
  assert.equal(legacyCompleted[0].rpe, 8, "exercise RPE fills in the set RPE");
  assert.equal(legacyCompleted[0].exerciseName, "Bench Press");
  assert.deepEqual(getPostWorkoutCompletedSets({}, day), []);
  assert.deepEqual(getPostWorkoutSessionMetrics(previous, day), { setCount: 2, totalReps: 16, totalVolume: 960 });
}

// ---------------------------------------------------------------------------
// Previous comparable session: same day AND same program
// ---------------------------------------------------------------------------
{
  assert.equal(getPreviousComparableSession(better, [better, foreign, previous]), previous, "own id and the foreign program are skipped");
  assert.equal(getPreviousComparableSession(better, [foreign]), null, "another program's day is never the comparison");
  assert.equal(getPreviousComparableSession(better, [session("other-day", "2026-09-20", [], { dayId: "day-2" })]), null);
  assert.equal(getPreviousComparableSession(better, []), null);
  const legacyCurrent = { ...better, programId: undefined };
  assert.equal(getPreviousComparableSession(legacyCurrent, [foreign]), foreign, "a session without a program id compares by day only (legacy)");
}

// ---------------------------------------------------------------------------
// Improvement text
// ---------------------------------------------------------------------------
{
  const prevMetrics = getPostWorkoutSessionMetrics(previous, day);
  assert.equal(buildPostWorkoutImprovementText(getPostWorkoutSessionMetrics(better, day), prevMetrics), "Volume improved from 960 kg to 1,000 kg.".replace("1,000", (1000).toLocaleString()));
  assert.equal(buildPostWorkoutImprovementText(getPostWorkoutSessionMetrics(equal, day), prevMetrics), "Logged and counted. The next repeat of this day will tell us more.");
  assert.equal(buildPostWorkoutImprovementText(getPostWorkoutSessionMetrics(worse, day), prevMetrics), "Logged and counted. The next repeat of this day will tell us more.");
  assert.equal(buildPostWorkoutImprovementText(getPostWorkoutSessionMetrics(better, day), null), "First log for this day saved - that's your baseline to beat.");
  // A tiny volume change (within 2 % / 5 kg) is not an improvement; more reps at the same volume is.
  assert.equal(buildPostWorkoutImprovementText({ setCount: 2, totalReps: 16, totalVolume: 964 }, prevMetrics), "Logged and counted. The next repeat of this day will tell us more.");
  assert.equal(buildPostWorkoutImprovementText({ setCount: 2, totalReps: 17, totalVolume: 964 }, prevMetrics), "Total reps improved from 16 to 17.");
  assert.equal(buildPostWorkoutImprovementText({ setCount: 3, totalReps: 16, totalVolume: 960 }, prevMetrics), "More working sets completed than last time: 3 vs 2.");
  // BW-only sessions have no kg volume, so reps decide.
  assert.equal(buildPostWorkoutImprovementText({ setCount: 2, totalReps: 20, totalVolume: 0 }, { setCount: 2, totalReps: 18, totalVolume: 0 }), "Total reps improved from 18 to 20.");
}

// ---------------------------------------------------------------------------
// Watch text (priority order)
// ---------------------------------------------------------------------------
{
  const completed = getPostWorkoutCompletedSets(better, day);
  assert.equal(buildPostWorkoutWatchText(better, completed, day), "Nothing to worry about here - effort and readiness both look in range.");

  const pain = { ...better, sessionRpe: 9.5, exercises: { "pe-bench": { painFlag: true, sets: [] }, "pe-chin": { painFlag: true, sets: [] } } };
  assert.equal(
    buildPostWorkoutWatchText(pain, completed, day),
    "You flagged pain on Bench Press, Chin-up. Good call logging it - the coach holds back there until a pain-free session. If it keeps coming back, get it looked at.",
    "pain wins over a hot session RPE",
  );
  assert.equal(buildPostWorkoutWatchText({ ...better, sessionRpe: 9 }, completed, day), "That one ran hot. If the fatigue carries into next session, take the conservative option.");
  assert.equal(buildPostWorkoutWatchText({ ...better, sessionRpe: "9" }, completed, day), "That one ran hot. If the fatigue carries into next session, take the conservative option.");
  assert.equal(buildPostWorkoutWatchText({ ...better, readiness: { status: "red" } }, completed, day), "You trained on low readiness - judge today's numbers in that context before changing anything.");
  assert.equal(buildPostWorkoutWatchText({ ...better, readiness: null, readinessSnapshot: { readiness: { status: "yellow", isPoor: true } } }, completed, day), "You trained on low readiness - judge today's numbers in that context before changing anything.");

  const missed = getPostWorkoutCompletedSets(session("m", "2026-09-26", [benchSet(1, 5, 60, 8), benchSet(2, 4, 60, 8)]), day);
  assert.equal(buildPostWorkoutWatchText(better, missed, day), "2 sets landed below the target range. Keep an eye on load selection next time.");
  assert.equal(buildPostWorkoutWatchText(better, missed.slice(0, 1), day), "1 set landed below the target range. Keep an eye on load selection next time.");
  const hot = getPostWorkoutCompletedSets(worse, day);
  assert.equal(buildPostWorkoutWatchText(worse, hot, day), "A few sets were near the limit. Progress only if the reps stay clean next time.");

  const recoveryDay = { id: "day-r", name: "Recovery", type: "recovery", exercises: [] };
  assert.equal(buildPostWorkoutWatchText({ sessionRpe: 4 }, [], recoveryDay), "Recovery work saved. Let readiness pick the next training day.");
}

// ---------------------------------------------------------------------------
// Next text
// ---------------------------------------------------------------------------
{
  assert.equal(buildPostWorkoutNextText({ status: "generated", exercises: [{ name: "Bench Press", reasons: ["", " Hit 8 reps at RPE 8, so load goes up. "] }] }), "Bench Press:  Hit 8 reps at RPE 8, so load goes up. ", "the first non-blank reason, as stored");
  assert.equal(buildPostWorkoutNextText({ status: "generated", exercises: [{ name: "Bench Press", reasons: [], repFocus: "Own the top of the range." }] }), "Bench Press: Own the top of the range.");
  assert.equal(buildPostWorkoutNextText({ status: "generated", exercises: [{ name: "Bench Press", recommendationNote: "Hold." }] }), "Bench Press: Hold.");
  assert.equal(buildPostWorkoutNextText({ status: "generated", exercises: [{ name: "Bench Press" }] }), "Next session recommendation was generated from this log.");
  assert.equal(buildPostWorkoutNextText({ generatedAt: "2026-09-26T18:00:00Z" }), "Next session recommendation was generated from this log.");
  assert.equal(buildPostWorkoutNextText(null), "Save more complete sets to sharpen the next recommendation.");
  assert.equal(buildPostWorkoutNextText({ exercises: [] }), "Save more complete sets to sharpen the next recommendation.");
}

// ---------------------------------------------------------------------------
// Full recap: better / equal / worse and foreign history excluded
// ---------------------------------------------------------------------------
{
  const plan = { status: "generated", exercises: [{ name: "Bench Press", reasons: ["Load goes up."] }] };
  const recap = buildPostWorkoutCoachRecap(better, [better, foreign, previous], day, plan);
  // H5 (decision H5-10): the recap gains adherence / records / coach status /
  // comparison fields; the pre-H5 fields are unchanged and pinned here.
  const preH5Keys = ["id", "savedAt", "programName", "dayName", "exerciseCount", "setCount", "totalVolume", "bestSetText", "improvedText", "watchText", "nextText"];
  assert.deepEqual(Object.fromEntries(preH5Keys.map((key) => [key, recap[key]])), {
    id: "recap-better",
    savedAt: better.date,
    programName: "Custom Push",
    dayName: "Day 1",
    exerciseCount: 1,
    setCount: 2,
    totalVolume: 1000,
    bestSetText: "Bench Press: 62.5 kg x 8 reps @ RPE 8",
    improvedText: `Volume improved from 960 kg to ${(1000).toLocaleString()} kg.`,
    watchText: "Nothing to worry about here - effort and readiness both look in range.",
    nextText: "Bench Press: Load goes up.",
  });
  assert.deepEqual(
    Object.keys(recap).sort(),
    [...preH5Keys, "adherence", "adherenceText", "records", "recordsText", "ineligibleSets", "coachStatus", "coachStatusText", "comparison", "comparisonText"].sort(),
  );

  assert.equal(buildPostWorkoutCoachRecap(equal, [previous], day, plan).improvedText, "Logged and counted. The next repeat of this day will tell us more.");
  const worseRecap = buildPostWorkoutCoachRecap(worse, [previous], day, null);
  assert.equal(worseRecap.improvedText, "Logged and counted. The next repeat of this day will tell us more.");
  assert.equal(worseRecap.watchText, "A few sets were near the limit. Progress only if the reps stay clean next time.");
  assert.equal(worseRecap.nextText, "Save more complete sets to sharpen the next recommendation.");

  // Only program-b history exists for this day: it is not a baseline for program-a.
  const firstForProgram = buildPostWorkoutCoachRecap(worse, [foreign], day, null);
  assert.equal(firstForProgram.improvedText, "First log for this day saved - that's your baseline to beat.");

  const noSets = buildPostWorkoutCoachRecap(session("empty", "2026-09-26", [benchSet(1, null, null, null)], { programName: undefined, dayName: undefined }), [], day, null);
  assert.equal(noSets.bestSetText, "No complete working set found.");
  assert.equal(noSets.programName, "Program");
  assert.equal(noSets.dayName, "Day 1", "falls back to the day's name");
  assert.equal(noSets.exerciseCount, 0);
}

// ===========================================================================
// Phase H5 (decision H5-10): records, adherence, hold / override / deload
// wording, comparable-metric guards, timed sets. The pre-H5 cases above are
// unchanged.
// ===========================================================================
const {
  buildPostWorkoutComparison,
  buildPostWorkoutCoachStatusText,
  buildPostWorkoutRecordsText,
  checkRecapComparability,
  didPlanKeepTargets,
} = await import("../src/lib/workoutRecap.js");
const { MIN_COMPARABLE_SESSIONS } = await import("../src/lib/readinessPerformance.js");

const h5Day = {
  ...day,
  exercises: [
    { ...bench, programId: "program-a", loadType: "external", weightMode: "kg", repsLabel: "6-8", sets: 3 },
    { ...chin, programId: "program-a", loadType: "bodyweight", weightMode: "kg", repsLabel: "5-10", sets: 3 },
    { id: "pe-plank", programExerciseId: "pe-plank", libraryExerciseId: "lib-plank", programId: "program-a", name: "Plank", repsMin: null, repsMax: null, repsLabel: "45 s", sets: 2, loadType: "bodyweight", weightMode: "kg" },
  ],
};
const snapshot = {
  "pe-bench": { sets: 3, repsMin: 6, repsMax: 8, recommendedWeight: 62.5, prescriptionSource: "progression" },
  "pe-chin": { sets: 3, repsMin: 5, repsMax: 10, recommendedWeight: null, prescriptionSource: "target" },
  "pe-plank": { sets: 2, repsMin: null, repsMax: null, recommendedWeight: null, prescriptionSource: "target" },
};

// Records and adherence in the recap; "Partial session (...): coach kept targets".
{
  const partial = session("partial", "2026-09-27T18:00:00+03:00", [benchSet(1, 8, 62.5, 8), benchSet(2, 8, 62.5, 8), benchSet(3, null, null, null)], { plannedExercises: snapshot });
  const keepPlan = { status: "generated", exercises: [{ exerciseId: "pe-bench", name: "Bench Press", sets: 3, repsMin: 6, repsMax: 8, recommendedWeight: 62.5, reasons: ["Reps were below target, so hold the load."], decision: "hold" }] };
  const recap = buildPostWorkoutCoachRecap(partial, [previous, foreign], h5Day, keepPlan);
  assert.equal(recap.adherence.status, "minimal");
  assert.equal(recap.adherence.plannedSets, 8);
  assert.equal(recap.adherence.countedSets, 2);
  assert.deepEqual(recap.adherence.skippedExercises.map((exercise) => exercise.name), ["Chin-up", "Plank"]);
  assert.equal(recap.adherenceText, "Partial session (2 of 8 planned sets): coach kept targets. Skipped: Chin-up, Plank.");
  assert.equal(didPlanKeepTargets(partial, keepPlan), true);

  const bumpPlan = { ...keepPlan, exercises: [{ ...keepPlan.exercises[0], recommendedWeight: 65 }] };
  assert.equal(didPlanKeepTargets(partial, bumpPlan), false);
  assert.equal(buildPostWorkoutCoachRecap(partial, [previous], h5Day, bumpPlan).adherenceText, "Partial session (2 of 8 planned sets): coach adjusted the logged exercises only. Skipped: Chin-up, Plank.");
  assert.equal(didPlanKeepTargets(partial, null), true, "no plan: nothing changed");
  assert.equal(didPlanKeepTargets({ plannedExercises: {} }, bumpPlan), true, "no snapshot entry: nothing to compare");

  // Records: 62.5 x 8 beats the previous 60 x 8 for program-a's bench (e1RM, top weight, reps at 62.5 first, session volume no: 1000 < ... wait previous volume 960, current 1000 -> new).
  const byType = Object.fromEntries(recap.records.map((record) => [`${record.type}:${record.weightKey ?? ""}`, record]));
  assert.equal(byType["best_e1rm:"].status, "new");
  assert.equal(byType["best_e1rm:"].previousValue, 76);
  assert.equal(byType["best_weight:"].status, "new");
  assert.equal(byType["best_reps_at_weight:62.5"].status, "first");
  assert.equal(byType["best_session_volume:"].status, "new");
  assert.ok(recap.records.every((record) => record.programId === "program-a"), "program-b's 100 kg is never the previous record");
  assert.equal(
    recap.recordsText,
    "New records: Bench Press e1RM 79.2 kg (was e1RM 76 kg); Bench Press top weight 62.5 kg (was top weight 60 kg); Bench Press session volume " + (1000).toLocaleString() + " kg (was session volume 960 kg).",
  );
  assert.deepEqual(recap.ineligibleSets, []);

  // The 12-rep set is explained.
  const twelve = session("twelve", "2026-09-28T18:00:00+03:00", [benchSet(1, 12, 50, 8)], { plannedExercises: snapshot });
  const explained = buildPostWorkoutCoachRecap(twelve, [previous], h5Day, null);
  assert.deepEqual(explained.ineligibleSets.map((entry) => [entry.exerciseName, entry.setIndex, entry.reason]), [["Bench Press", 1, "12 reps: e1RM only for 1-10 reps"]]);
  assert.equal(explained.recordsText, "No new records today.", "a first 'reps at weight' of a known exercise is only a new weight key, not a record to announce");
  assert.equal(explained.records.find((record) => record.type === "best_reps_at_weight").identityHadRecords, true);
  assert.equal(explained.records.find((record) => record.type === "best_reps_at_weight").status, "first");

  // First log of a day: every record is "first" and the text says baseline.
  const first = buildPostWorkoutCoachRecap(previous, [foreign], h5Day, null);
  assert.ok(first.records.every((record) => record.status === "first" && record.identityHadRecords === false));
  assert.equal(first.recordsText, "First records for this day logged - the next repeat can beat them.");
  assert.equal(first.comparisonText, "Not comparable yet: 1 more session needed.");
  assert.equal(first.comparison.needed, MIN_COMPARABLE_SESSIONS - 1);

  // A session that only ties says so; nothing new says so.
  const tie = session("tie", "2026-09-29T18:00:00+03:00", [benchSet(1, 8, 60, 8), benchSet(2, 8, 60, 8)]);
  const tied = buildPostWorkoutCoachRecap(tie, [previous], h5Day, null);
  assert.equal(tied.recordsText, "Tied: Bench Press e1RM 76 kg; Bench Press top weight 60 kg; Bench Press 8 reps at 60 kg.");
  const lower = buildPostWorkoutCoachRecap(session("lower", "2026-09-29T18:00:00+03:00", [benchSet(1, 5, 50, 8)]), [previous], h5Day, null);
  assert.equal(lower.recordsText, "No new records today.", "a lighter set at a new weight key is not announced");
  assert.equal(buildPostWorkoutRecordsText([]), "No new records today.");
  assert.equal(buildPostWorkoutRecordsText(undefined), "No new records today.");

  // previousRecords can be injected (the UI keeps them), and options carry the program context.
  const injected = buildPostWorkoutCoachRecap(tie, [], h5Day, null, { previousRecords: { primary: {}, acrossPrograms: {}, unattributed: [] }, programs: [{ id: "program-a", name: "A" }], exerciseLibrary: [{ id: "lib-bench", name: "Bench Press" }] });
  assert.ok(injected.records.every((record) => record.status === "first"));
}

// Comparison: the best comparable metric for this program + day, never mixing units.
{
  const s1 = session("c1", "2026-09-01T18:00:00+03:00", [benchSet(1, 8, 60, 8)]);
  const s2 = session("c2", "2026-09-08T18:00:00+03:00", [benchSet(1, 8, 65, 8)]);
  const s3 = session("c3", "2026-09-15T18:00:00+03:00", [benchSet(1, 8, 62.5, 8)]);
  const best = buildPostWorkoutComparison(s2, [s1, foreign], h5Day);
  assert.equal(best.comparable, true);
  assert.equal(best.metricId, "e1rm");
  assert.equal(best.isBest, true);
  assert.equal(best.rankedCount, 2, "program-b's session is not a comparable session of this day");
  assert.equal(best.text, "Today is your best Bench Press e1RM for this day: 82.3 kg across 2 comparable sessions.");
  assert.equal(best.exerciseName, "Bench Press", "e1RM is compared per exercise (H5-25)");
  const notBest = buildPostWorkoutComparison(s3, [s2, s1], h5Day);
  assert.equal(notBest.isBest, false);
  assert.match(notBest.text, /^Best Bench Press e1RM for this day stays 82\.3 kg \(.*\); today 79\.2 kg, across 3 comparable sessions\.$/);
  // The anchor is today's best-e1RM exercise: a heavier chin-up e1RM of an
  // earlier session never competes with today's bench (H5-25).
  const chinSet = (setNumber, weight) => ({ ...benchSet(setNumber, 8, weight, 8), programExerciseId: "pe-chin", exerciseId: "lib-chin" });
  const chinHeavy = session("c-chin", "2026-09-03T18:00:00+03:00", [benchSet(1, 8, 50, 8), benchSet(2, 8, 50, 8), benchSet(3, 8, 50, 8), chinSet(1, 90), chinSet(2, 90), chinSet(3, 90)], { plannedExercises: snapshot });
  const anchored = buildPostWorkoutComparison(s2, [s1, chinHeavy], h5Day);
  assert.equal(anchored.exerciseName, "Bench Press");
  assert.equal(anchored.isBest, true, "the chin-up e1RM of c-chin is not compared with the bench");
  assert.equal(anchored.rankedCount, 3);
  // A minimal-adherence session (1 of 6 planned sets) is not a comparable session of the day.
  const minimal = session("c-min", "2026-09-04T18:00:00+03:00", [benchSet(1, 8, 70, 8)], { plannedExercises: snapshot });
  const withoutMinimal = buildPostWorkoutComparison(s2, [s1, minimal], h5Day);
  assert.equal(withoutMinimal.rankedCount, 2, "the minimal session is left out");
  assert.equal(withoutMinimal.isBest, true, "its 70 kg set never becomes the best of the day");
  assert.equal(notBest.bestDate, s2.date);
  assert.ok(Math.abs(notBest.todayValue - 62.5 * (1 + 8 / 30)) < 1e-9);

  // Timed day: seconds are ranked against seconds only.
  const plankSet = (setNumber, seconds) => ({ programExerciseId: "pe-plank", exerciseId: "lib-plank", setNumber, seconds, actualWeight: "BW", actualRPE: 8, completed: true });
  const t1 = session("t1", "2026-09-01T18:00:00+03:00", [plankSet(1, 45), plankSet(2, 45)]);
  const t2 = session("t2", "2026-09-08T18:00:00+03:00", [plankSet(1, 60), plankSet(2, 50)]);
  const timed = buildPostWorkoutComparison(t2, [t1], h5Day);
  assert.equal(timed.metricId, "time");
  assert.equal(timed.unit, "s");
  assert.equal(timed.text, "Today is your best total time for this day: 1 min 50 sec across 2 comparable sessions.");
  const timedRecap = buildPostWorkoutCoachRecap(t2, [t1], h5Day, null);
  assert.equal(timedRecap.setCount, 2);
  assert.equal(timedRecap.totalVolume, 0, "timed BW sets carry no tonnage");
  assert.equal(timedRecap.bestSetText, "Plank: BW x 1 min @ RPE 8");
  assert.equal(timedRecap.records.find((record) => record.type === "best_time").status, "new");
  assert.equal(timedRecap.records.find((record) => record.type === "best_time").previousValue, 45);
  assert.equal(timedRecap.improvedText, "Logged and counted. The next repeat of this day will tell us more.");

  // A reps day against a timed one: no shared metric -> exact sample requirement.
  const mixed = buildPostWorkoutComparison(s1, [t1], h5Day);
  assert.equal(mixed.comparable, false);
  assert.equal(mixed.text, "Not comparable yet: 1 more session needed.");
  assert.equal(buildPostWorkoutComparison(s1, [], h5Day, { minComparableSessions: 3 }).text, "Not comparable yet: 2 more sessions needed.");
}

// Measurement change between the current and the previous session of a day.
{
  const dbDay = { ...h5Day, exercises: [{ ...h5Day.exercises[0], weightMode: "per dumbbell" }] };
  const before = session("mode-old", "2026-09-01T18:00:00+03:00", [{ ...benchSet(1, 8, 60, 8), weightMode: "kg" }]);
  const after = session("mode-new", "2026-09-08T18:00:00+03:00", [{ ...benchSet(1, 8, 30, 8), weightMode: "per dumbbell" }]);
  const currentSets = getPostWorkoutCompletedSets(after, dbDay);
  const previousSets = getPostWorkoutCompletedSets(before, dbDay);
  assert.equal(currentSets[0].tonnage, 480, "per dumbbell x2");
  assert.equal(previousSets[0].tonnage, 480, "the old set is read in the kg it was stored with");
  assert.deepEqual(checkRecapComparability(currentSets, previousSets), { comparable: false, reason: "Not comparable: measurement changed.", exerciseName: "Bench Press" });
  assert.deepEqual(checkRecapComparability(currentSets, []), { comparable: true, reason: null, exerciseName: null });
  const recap = buildPostWorkoutCoachRecap(after, [before], dbDay, null);
  assert.equal(recap.improvedText, "Not comparable: measurement changed since the last log of this day (Bench Press). Today is the new baseline.");
  // The same recap never announces a record against a best of the earlier
  // weight mode (H5-8, H5-41): 30 kg per dumbbell is not "a new top weight,
  // was 60 kg" and not a lost one either; it is the first record of the mode.
  assert.ok(recap.records.length > 0);
  recap.records.forEach((record) => {
    assert.equal(record.status, "first", `${record.type} starts over after the weight-mode change`);
    assert.equal(record.previousValue, null);
  });
  assert.doesNotMatch(recap.recordsText, /New record|was /);
  // And the other way round (per dumbbell -> kg): a heavier kg set is not a
  // record over the per-dumbbell best.
  const kgRecap = buildPostWorkoutCoachRecap(
    session("mode-kg", "2026-09-15T18:00:00+03:00", [benchSet(1, 8, 50, 8)]),
    [session("mode-db", "2026-09-08T18:00:00+03:00", [{ ...benchSet(1, 10, 30, 8), weightMode: "per dumbbell" }])],
    h5Day,
    null,
  );
  assert.equal(kgRecap.improvedText, "Not comparable: measurement changed since the last log of this day (Bench Press). Today is the new baseline.");
  kgRecap.records.forEach((record) => assert.equal(record.status, "first", `${record.type}: kg after per dumbbell starts over`));
  assert.doesNotMatch(kgRecap.recordsText, /New record|was /);
  assert.equal(buildPostWorkoutImprovementText({ setCount: 1, totalReps: 8, totalVolume: 480 }, { setCount: 1, totalReps: 8, totalVolume: 480 }, { comparable: true }), "Logged and counted. The next repeat of this day will tell us more.");
}

// Hold / override / deload wording hooks.
{
  const heldSnapshot = { ...snapshot, "pe-bench": { ...snapshot["pe-bench"], sourceLabel: "Held by you" } };
  const held = session("held", "2026-09-27T18:00:00+03:00", [benchSet(1, 8, 62.5, 8)], { plannedExercises: heldSnapshot });
  const heldPlan = { status: "generated", exercises: [{ exerciseId: "pe-bench", name: "Bench Press", sets: 3, repsMin: 6, repsMax: 8, recommendedWeight: 62.5, reasons: ["Held by you"], decision: "hold", held: true, overrideMode: "hold" }] };
  const recap = buildPostWorkoutCoachRecap(held, [previous], h5Day, heldPlan);
  assert.deepEqual(recap.coachStatus.held, ["pe-bench"]);
  assert.equal(recap.coachStatusText, "Held by you: Bench Press stays at your held targets.");
  assert.equal(recap.nextText, "Bench Press: Held by you", "the plan's own reason stays the Next note");

  const overridePlan = { status: "generated", exercises: [{ exerciseId: "pe-chin", name: "Chin-up", overrideMode: "manual", reasons: ["Manual override (2 sessions left)"] }] };
  assert.equal(buildPostWorkoutCoachRecap(held, [previous], h5Day, overridePlan).coachStatusText, "Held by you: Bench Press stays at your held targets. Manual override: Chin-up uses your own numbers.");

  const deloadPlan = { status: "generated", exercises: [{ exerciseId: "pe-bench", name: "Bench Press", reasons: ["Logged during a deload, so this session is not used as progression evidence."], deloadSession: true, deloadLevel: "deload" }] };
  const deloadRecap = buildPostWorkoutCoachRecap(session("d", "2026-09-27T18:00:00+03:00", [benchSet(1, 8, 50, 7)], { plannedExercises: snapshot }), [previous], h5Day, deloadPlan);
  assert.equal(deloadRecap.coachStatus.deload, true);
  assert.equal(deloadRecap.coachStatusText, "Deload: targets are reduced on purpose; history stays as logged.");

  assert.equal(buildPostWorkoutCoachRecap(session("plain", "2026-09-27T18:00:00+03:00", [benchSet(1, 8, 60, 8)]), [previous], h5Day, null).coachStatusText, null);
  assert.equal(buildPostWorkoutCoachStatusText(null, h5Day), null);
  assert.equal(buildPostWorkoutCoachStatusText({ held: ["unknown-id"], overridden: [], deload: false }, h5Day), "Held by you: unknown-id stays at your held targets.");
}

// No medical claims in any produced recap string (H5-10 gate).
{
  const produced = [];
  const collect = (value) => {
    if (typeof value === "string") produced.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  const pain = { ...better, sessionRpe: 9.5, plannedExercises: snapshot, exercises: { "pe-bench": { painFlag: true, sets: [] } } };
  collect(buildPostWorkoutCoachRecap(pain, [previous, foreign], h5Day, { status: "generated", exercises: [{ exerciseId: "pe-bench", name: "Bench Press", reasons: ["Held by you"], held: true }] }));
  collect(buildPostWorkoutCoachRecap({ ...worse, readiness: { status: "red" } }, [previous], h5Day, null));
  collect(buildPostWorkoutCoachRecap(previous, [], h5Day, null));
  assert.ok(produced.length > 15);
  produced.forEach((text) => assert.doesNotMatch(text, /injury|overtraining syndrome|diagnos/i, text));
}

console.log("Workout recap verification passed.");
