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
  assert.deepEqual(recap, {
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

console.log("Workout recap verification passed.");
