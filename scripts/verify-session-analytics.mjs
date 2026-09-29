// Phase H4 Track A: src/lib/sessionAnalytics.js (moved verbatim from
// src/App.jsx). A small deterministic session set pins:
// - per-session analytics (totals, logged set count) and "last time" helpers;
// - the beat-last cue (first session, skipped exercise, try vs keep, athletic);
// - PR / best set by exercise identity: programId + programExerciseId, never
//   merged by name or Library id when the ids conflict (19.1 "Identity");
// - the Progress-page builders: set records, exercise options, selected
//   exercise analytics, insight cards, readiness/performance and weekly review.
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
  average,
  buildExerciseSessionSummaries,
  buildProgressAnalytics,
  buildProgressExerciseLookup,
  buildReadinessEntries,
  buildSelectedExerciseAnalytics,
  buildWeeklyReview,
  calculateEstimatedOneRepMax,
  compareBestSet,
  compareRecentSessionValues,
  formatAverage,
  formatBestWeightReps,
  formatKg,
  formatLoggedWeight,
  formatPlainNumber,
  formatReadinessAverage,
  formatSetPerformance,
  formatVolume,
  getAverageLoggedWeight,
  getBeatLastCue,
  getDateTime,
  getExerciseTotalReps,
  getLastExerciseLog,
  getLastExerciseSession,
  getProgressExerciseKey,
  getSessionAnalytics,
  getSessionReadinessForProgress,
  getSessionSetRecords,
  getTrendDirection,
  recentWorkoutWindowDays,
} = await import("../src/lib/sessionAnalytics.js");

// ---------------------------------------------------------------------------
// Program fixture
// ---------------------------------------------------------------------------
const bench = {
  id: "pe-bench",
  programExerciseId: "pe-bench",
  libraryExerciseId: "lib-bench",
  programId: "program-a",
  name: "Bench Press",
  category: "compound",
  progressionType: "compound",
  sets: 3,
  repsMin: 5,
  repsMax: 8,
  repsLabel: "5-8",
  targetRPE: 8,
  restSeconds: [150, 180],
  recommendedWeight: 80,
  loadType: "external",
  weightMode: "kg",
};
const chin = {
  id: "pe-chin",
  programExerciseId: "pe-chin",
  libraryExerciseId: "lib-chin",
  programId: "program-a",
  name: "Chin-up",
  category: "compound",
  progressionType: "compound",
  sets: 2,
  repsMin: 5,
  repsMax: 10,
  repsLabel: "5-10",
  targetRPE: 8,
  restSeconds: 120,
  recommendedWeight: null,
  loadType: "bodyweight",
};
const day = { id: "day-1", name: "Day 1", focus: "Push", type: "training", exercises: [bench, chin] };
const activeProgram = { id: "program-a", name: "Custom Push", nickname: null };

function benchSet(setNumber, reps, weight, rpe, extra = {}) {
  return {
    programExerciseId: "pe-bench",
    exerciseId: "lib-bench",
    setNumber,
    actualReps: reps,
    actualWeight: weight,
    actualRPE: rpe,
    completed: reps !== null && weight !== null && rpe !== null,
    ...extra,
  };
}

const now = Date.parse("2026-09-26T12:00:00+03:00");
const dayMs = 24 * 60 * 60 * 1000;
const at = (daysAgo) => new Date(now - daysAgo * dayMs).toISOString();

const s1 = {
  id: "s1",
  date: at(1),
  programId: "program-a",
  dayId: "day-1",
  dayName: "Day 1",
  sessionRpe: 8,
  readiness: { status: "green", averageScore: 4.2 },
  workoutSets: [
    benchSet(1, 5, 80, 8),
    benchSet(2, 5, 80, 8),
    benchSet(3, null, null, null),
    { programExerciseId: "pe-chin", exerciseId: "lib-chin", setNumber: 1, actualReps: 8, actualWeight: "BW", actualRPE: 8, completed: true },
  ],
};
const s2 = {
  id: "s2",
  date: at(3),
  programId: "program-a",
  dayId: "day-1",
  dayName: "Day 1",
  sessionRpe: 7,
  readiness: { status: "yellow", averageScore: 3.4 },
  workoutSets: [benchSet(1, 5, 77.5, 8), benchSet(2, 5, 77.5, 8.5)],
};
const s3 = {
  id: "s3",
  date: at(10),
  programId: "program-a",
  dayId: "day-1",
  dayName: "Day 1",
  sessionRpe: 9,
  readiness: { status: "red", averageScore: 2.4 },
  workoutSets: [benchSet(1, 5, 75, 9), benchSet(2, 4, 75, 9.5)],
};
// Foreign program, same day id, same Library exercise, heavier: never a PR of program-a's bench.
const s4 = {
  id: "s4",
  date: at(2),
  programId: "program-b",
  dayId: "day-1",
  dayName: "Day 1",
  sessionRpe: 8,
  readiness: null,
  workoutSets: [{ programExerciseId: "pe-bench-b", exerciseId: "lib-bench", setNumber: 1, actualReps: 5, actualWeight: 100, actualRPE: 8, completed: true }],
};
// Same program, a retired occurrence id of the same Library exercise.
const s5 = {
  id: "s5",
  date: at(6),
  programId: "program-a",
  dayId: "day-1",
  dayName: "Day 1",
  sessionRpe: 8,
  readiness: null,
  workoutSets: [{ programExerciseId: "pe-bench-old", exerciseId: "lib-bench", setNumber: 1, actualReps: 5, actualWeight: 90, actualRPE: 8, completed: true }],
};
const sessions = [s1, s4, s2, s5, s3]; // newest first, as App keeps them

// ---------------------------------------------------------------------------
// Formatters and scalar helpers
// ---------------------------------------------------------------------------
assert.equal(calculateEstimatedOneRepMax(80, 5), 80 * (1 + 5 / 30));
assert.equal(calculateEstimatedOneRepMax("BW", 5), null);
assert.equal(calculateEstimatedOneRepMax(80, 0), null, "a failed attempt has no e1RM");
assert.equal(calculateEstimatedOneRepMax(80, null), null);
assert.equal(average([1, 2, NaN, 3]), 2);
assert.equal(average([]), null);
assert.equal(getDateTime("not a date"), 0);
assert.equal(getDateTime(null), 0);
assert.equal(getDateTime("2026-09-26T09:00:00Z"), Date.parse("2026-09-26T09:00:00Z"));
assert.equal(formatKg(80), "80 kg");
assert.equal(formatKg(82.5), "82.5 kg");
assert.equal(formatKg(null), "No kg data");
assert.equal(formatVolume(675), "675 kg");
assert.match(formatVolume(2525), /^2[,.  ]?525 kg$/);
assert.equal(formatVolume(0), "No kg data");
assert.equal(formatVolume(691.67), "692 kg");
assert.equal(formatSetPerformance({ weight: 80, reps: 5, rpe: 8 }), "80 kg x 5 reps @ RPE 8");
assert.equal(formatSetPerformance({ weight: "BW", reps: 8, rpe: NaN }), "BW x 8 reps");
assert.equal(formatSetPerformance({ weight: null, reps: NaN }), "No kg x No reps");
assert.equal(formatBestWeightReps(null), "No set");
assert.equal(formatBestWeightReps({ weight: 80, reps: 5 }), "80 kg x 5 reps");
assert.equal(formatBestWeightReps({ weight: "BW", reps: 8 }), "BW x 8 reps");
assert.equal(formatBestWeightReps({ weight: null, reps: 8 }), "8 reps");
assert.equal(formatAverage(7.75), "7.8");
assert.equal(formatAverage(null), "No data");
assert.equal(formatPlainNumber(12), "12");
assert.equal(formatPlainNumber(12.34), "12.3");
assert.equal(formatReadinessAverage(3.333), "3.3 / 5");
assert.equal(recentWorkoutWindowDays, 30);
assert.equal(getTrendDirection(3.5, 3.2, 0.2), "Up");
assert.equal(getTrendDirection(3.05, 3.2, 0.2), "Stable");
assert.equal(getTrendDirection(2.9, 3.2, 0.2), "Down");
assert.equal(getTrendDirection(3.0, null, 0.2), "Stable");
assert.equal(getTrendDirection(110, 100, 0.05, true), "Up", "relative threshold: 10 > 5");
assert.equal(getTrendDirection(104, 100, 0.05, true), "Stable");

// Identity keys.
assert.equal(getProgressExerciseKey({ programId: "program-a", programExerciseId: "pe-bench", exerciseId: "lib-bench", exerciseName: "Bench Press" }), "program-exercise:program-a:pe-bench");
assert.equal(getProgressExerciseKey({ programExerciseId: "pe-bench", exerciseId: "lib-bench" }), "program-exercise:pe-bench");
assert.equal(getProgressExerciseKey({ exerciseId: "lib-bench", exerciseName: "Bench Press" }), "exercise:lib-bench");
assert.equal(getProgressExerciseKey({ exerciseName: " Bench Press " }), "name:bench press");

// compareBestSet: e1RM first, then weight, then reps.
{
  const sorted = [
    { weight: 80, reps: 5, estimatedOneRepMax: 93.3 },
    { weight: 100, reps: 5, estimatedOneRepMax: 116.7 },
    { weight: "BW", reps: 12, estimatedOneRepMax: null },
    { weight: "BW", reps: 8, estimatedOneRepMax: null },
  ].sort(compareBestSet);
  assert.deepEqual(sorted.map((set) => `${set.weight}x${set.reps}`), ["100x5", "80x5", "BWx12", "BWx8"]);
}

// ---------------------------------------------------------------------------
// Per-session analytics (Workout Log draft shape)
// ---------------------------------------------------------------------------
{
  const draft = {
    exercises: {
      "pe-bench": { notes: "", painFlag: false, sets: [{ reps: "5", weight: "80", rpe: "8" }, { reps: "5", weight: "80", rpe: "" }, { reps: "", weight: "", rpe: "" }] },
      "pe-chin": { notes: "", painFlag: false, sets: [{ reps: "8", weight: "BW", rpe: "8" }, { reps: "", weight: "", rpe: "" }] },
    },
  };
  const analytics = getSessionAnalytics(day, draft);
  assert.equal(analytics.exerciseCount, 2);
  assert.equal(analytics.loggedSetCount, 2, "only fully logged sets (reps + kg + RPE)");
  assert.equal(analytics.totalReps, 18, "reps of every slot that has reps");
  assert.deepEqual(analytics.exerciseSummaries[0], { exerciseId: "pe-bench", totalReps: 10, averageWeight: 80, setCount: 1, exerciseRPE: 8 });
  assert.deepEqual(analytics.exerciseSummaries[1], { exerciseId: "pe-chin", totalReps: 8, averageWeight: null, setCount: 1, exerciseRPE: 8 }, "BW is not a kg average");
}

// ---------------------------------------------------------------------------
// "Last time" helpers and the beat-last cue
// ---------------------------------------------------------------------------
{
  assert.equal(getLastExerciseSession("day-1", bench, sessions), s1);
  assert.equal(getLastExerciseSession("day-1", bench, [s4, s2]), s2, "program-b's session is never last time for program-a's bench");
  assert.equal(getLastExerciseSession("day-1", bench, [s4]), undefined);
  assert.equal(getLastExerciseSession("day-1", bench, [s5, s2]), s2, "a retired occurrence id is not this exercise");
  const legacySession = { id: "legacy", dayId: "day-1", workoutSets: [{ exerciseId: "lib-bench", setNumber: 1, actualReps: 5, actualWeight: 50, actualRPE: 7 }] };
  assert.equal(getLastExerciseSession("day-1", bench, [legacySession]), legacySession, "a session without programId is compatible legacy data");
  assert.equal(getLastExerciseSession("day-2", bench, sessions), undefined);
  assert.equal(getLastExerciseSession("day-1", "pe-bench", sessions), s1, "string id: no program filter");

  assert.deepEqual(getLastExerciseLog("day-1", bench, sessions).sets[0], { reps: 5, weight: 80, rpe: 8 });
  assert.equal(getLastExerciseLog("day-1", bench, []), null);

  assert.equal(getExerciseTotalReps(s1, bench), 10, "the empty third slot adds nothing");
  assert.equal(getExerciseTotalReps(s1, chin), 8);
  assert.equal(getExerciseTotalReps(s4, bench), 0);
  assert.equal(getAverageLoggedWeight(s2, bench), 77.5);
  assert.equal(getAverageLoggedWeight(s1, chin), null);
  assert.equal(formatLoggedWeight(s2, bench, bench), "77.5 kg");
  assert.equal(formatLoggedWeight(s1, chin, chin), "BW", "bodyweight exercise without kg");
  assert.equal(formatLoggedWeight(s4, bench, bench), "BW / untracked load", "external exercise without a logged kg");
  assert.equal(formatLoggedWeight(s2, { ...bench, weightMode: "per dumbbell" }, bench), "77.5 kg per dumbbell");

  const firstTime = getBeatLastCue("day-1", bench, [], { recommendedWeight: 80 });
  assert.deepEqual(firstTime, {
    summary: "First logged session - establish your baseline today.",
    target: "Log honest reps and kg so next time has a target.",
  });
  const foreignOnly = getBeatLastCue("day-1", bench, [s4], { recommendedWeight: 80 });
  assert.equal(foreignOnly.summary, "First logged session - establish your baseline today.", "foreign history is not last time");

  const keep = getBeatLastCue("day-1", bench, sessions, { recommendedWeight: 80 });
  assert.deepEqual(keep, {
    summary: "Last time: 80 kg x 5, 5 - 10 total reps",
    target: "Today's target: keep 80 kg and beat last session's total reps.",
  });
  const tryHeavier = getBeatLastCue("day-1", bench, sessions, { recommendedWeight: 82.5 });
  assert.equal(tryHeavier.target, "Today's target: try 82.5 kg and stay within the rep range.");
  const athletic = getBeatLastCue("day-1", { ...bench, progressionType: "athletic" }, sessions, { recommendedWeight: 82.5 });
  assert.deepEqual(athletic, {
    summary: "Last time: 80 kg x 5, 5 - 10 total reps",
    target: "Prioritize speed and crisp execution over more volume.",
  });
  const athleticFirst = getBeatLastCue("day-1", { ...bench, progressionType: "athletic" }, [], { recommendedWeight: null });
  assert.equal(athleticFirst.target, "Prioritize speed and crisp execution over more volume.");

  // The session exists but this exercise was skipped in it.
  const skipped = { id: "skip", date: at(0.5), programId: "program-a", dayId: "day-1", workoutSets: [benchSet(1, null, null, null)] };
  assert.equal(getLastExerciseSession("day-1", bench, [skipped, s1]), skipped, "an all-empty log still matches");
  assert.equal(
    getBeatLastCue("day-1", bench, [skipped, s1], { recommendedWeight: 80 }).summary,
    "No logged sets for this exercise yet - establish your baseline today.",
  );
}

// ---------------------------------------------------------------------------
// Progress analytics
// ---------------------------------------------------------------------------
const analytics = buildProgressAnalytics({
  sessions,
  readinessByDate: {},
  programs: [],
  activeProgram,
  activeProgramDays: [day],
  exerciseLibrary: [{ id: "lib-bench", name: "Bench Press (library)" }, { id: "lib-chin", name: "Chin-up (library)" }],
  now,
});

{
  assert.deepEqual(analytics.sortedSessions.map((session) => session.id), ["s1", "s4", "s2", "s5", "s3"]);
  assert.equal(analytics.totalWorkouts, 5);
  assert.equal(analytics.recentWorkoutCount, 5);
  assert.equal(analytics.recentSevenDayWorkoutCount, 4);
  assert.equal(analytics.lastWorkoutDate, s1.date);
  assert.equal(analytics.lastWorkoutName, "Day 1");
  assert.equal(analytics.setRecords.length, 10, "every stored row, including the untouched slot");
  assert.equal(analytics.totalCompletedSets, 9);
  assert.equal(analytics.weightedSetCount, 8, "the BW chin-up set is not a kg set");
  assert.equal(analytics.totalVolume, 800 + 775 + 675 + 500 + 450);
  assert.equal(analytics.averageSessionRpe, 8);
  assert.equal(analytics.sessionRpeSampleSize, 5);
  assert.equal(analytics.readinessEntries.length, 3, "sessions without readiness add no entry");
  assert.ok(Math.abs(analytics.averageReadiness - (4.2 + 3.4 + 2.4) / 3) < 1e-9);
  assert.equal(analytics.bestRecentSet.weight, 100, "best recent set across all programs is the 100 kg set");
  assert.equal(analytics.bestRecentSet.exerciseKey, "program-exercise:program-b:pe-bench-b");

  // Set records keep the identity of their own program / occurrence.
  const benchKey = "program-exercise:program-a:pe-bench";
  const keys = new Set(analytics.setRecords.map((record) => record.exerciseKey));
  assert.deepEqual(
    [...keys].sort(),
    [benchKey, "program-exercise:program-a:pe-bench-old", "program-exercise:program-a:pe-chin", "program-exercise:program-b:pe-bench-b"],
  );
  const untouched = analytics.setRecords.find((record) => record.sessionId === "s1" && record.setNumber === 3);
  assert.equal(untouched.completed, false);
  assert.equal(untouched.reps, null);
  assert.equal(untouched.weight, null, "an untouched slot is never 0 kg");
  assert.equal(untouched.estimatedOneRepMax, null);
  const chinRecord = analytics.setRecords.find((record) => record.exerciseKey === "program-exercise:program-a:pe-chin");
  assert.equal(chinRecord.weight, "BW");
  assert.equal(chinRecord.exerciseName, "Chin-up", "program name wins over the Library name");
  assert.equal(chinRecord.estimatedOneRepMax, null);

  // Exercise options: the active program first, foreign / retired occurrences as separate entries.
  assert.equal(analytics.exerciseOptions[0].key, benchKey);
  assert.equal(analytics.exerciseOptions[0].loggedSetCount, 6);
  assert.equal(analytics.exerciseOptions[0].activeProgram, true);
  assert.equal(analytics.exerciseOptions[0].prescription, "3x 5-8 | 80 kg | RPE 8 | 2 min 30 sec - 3 min", "ranged rest reads as a range");
  assert.equal(analytics.exerciseOptions[1].key, "program-exercise:program-a:pe-chin");
  assert.equal(analytics.exerciseOptions[1].prescription, "2x 5-10 | Bodyweight | RPE 8 | 2 min");
  assert.deepEqual(
    analytics.exerciseOptions.slice(2).map((option) => [option.key, option.loggedSetCount, option.activeProgram]),
    [["program-exercise:program-b:pe-bench-b", 1, false], ["program-exercise:program-a:pe-bench-old", 1, false]],
  );
  assert.equal(analytics.loggedExerciseCount, 4);

  // Session summaries.
  const summary1 = analytics.sessionSummaries[0];
  assert.equal(summary1.sessionKey, "s1");
  assert.equal(summary1.completedSetCount, 3);
  assert.equal(summary1.exerciseCount, 2);
  assert.equal(summary1.totalReps, 18);
  assert.equal(summary1.totalVolume, 800);
  assert.equal(summary1.weightedSetCount, 2);
  assert.ok(Math.abs(summary1.bestEstimatedStrength - 80 * (1 + 5 / 30)) < 1e-9);
  assert.deepEqual(summary1.readiness, { status: "green", averageScore: 4.2 });
  assert.equal(analytics.sessionSummaries[1].readiness, null);

  // Insight cards.
  const [consistency, fatigue, readiness, volume, bestSet] = analytics.insights;
  assert.equal(consistency.status, "Strong");
  assert.equal(consistency.value, "4 this week");
  assert.equal(fatigue.status, "Productive");
  assert.equal(fatigue.value, "RPE 8.0");
  assert.equal(readiness.status, "Stable");
  assert.equal(readiness.value, "3.3 / 5");
  assert.equal(volume.status, "Up");
  assert.equal(volume.value, "692 kg");
  assert.equal(bestSet.status, "Best");
  assert.equal(bestSet.value, "100 kg x 5 reps @ RPE 8");
  assert.equal(bestSet.body, "Bench Press");
  assert.ok(consistency.toneClass.includes("lime"), "tone class is part of the card model");

  // Readiness / performance (F7: ranked within one metric).
  const rp = analytics.readinessPerformance;
  assert.deepEqual(rp.statusCounts, { green: 1, yellow: 1, red: 1, missing: 2 });
  assert.equal(rp.linkedSessionCount, 3);
  assert.equal(rp.highFatigueCount, 1, "red readiness with session RPE 9");
  assert.equal(rp.rpeByStatus.green.averageRpe, 8);
  assert.equal(rp.rpeByStatus.red.averageRpe, 9);
  assert.equal(rp.bestPerformance.comparable, true);
  assert.equal(rp.bestPerformance.metricId, "e1rm");
  assert.match(rp.bestPerformance.detail, /^Best e1RM: 93\.3 kg \| Green 4\.2\/5 \| ranked across 3 sessions with best e1rm$/);
  assert.equal(rp.performanceNote, "Some lower-readiness days also hit very high session RPE. Watch fatigue before forcing progression.");
  assert.equal(rp.coachNoteTitle, "Watch fatigue");
}

// PR by identity: program-a's bench never sees the 100 kg (program-b) or 90 kg (retired id) sets.
{
  const selected = buildSelectedExerciseAnalytics(analytics.exerciseOptions[0], analytics.setRecords);
  assert.equal(selected.completedSets.length, 6);
  assert.ok(selected.completedSets.every((set) => set.programId === "program-a" && set.programExerciseId === "pe-bench"));
  assert.equal(selected.bestSet.weight, 80);
  assert.equal(selected.bestSet.reps, 5);
  assert.ok(Math.abs(selected.bestEstimatedStrength - 80 * (1 + 5 / 30)) < 1e-9);
  assert.equal(selected.totalVolume, 800 + 775 + 675);
  assert.equal(selected.recentSessions.length, 3);
  assert.equal(selected.latestSession.totalVolume, 800);
  assert.equal(selected.latestSession.setSummary, "80 kg x 5 reps @ RPE 8 | 80 kg x 5 reps @ RPE 8");
  assert.equal(selected.trendInfo.status, "improving");
  assert.equal(selected.trendInfo.label, "Improving");
  assert.equal(selected.strengthTrend.value, "93.3 kg");
  assert.equal(selected.strengthTrend.detail, "Up 2.9 kg versus last time.");
  assert.equal(selected.volumeTrend.value, "800 kg");
  assert.equal(selected.volumeTrend.detail, "Up 25 kg versus last time.");
  assert.equal(selected.repsTrend.value, "10 reps");
  assert.equal(selected.repsTrend.detail, "Stable versus last time.");
  assert.ok(Math.abs(selected.averageSetRpe - (8 + 8 + 8 + 8.5 + 9 + 9.5) / 6) < 1e-9);

  const foreign = buildSelectedExerciseAnalytics(analytics.exerciseOptions[2], analytics.setRecords);
  assert.equal(foreign.completedSets.length, 1);
  assert.equal(foreign.bestSet.weight, 100);
  assert.equal(foreign.trendInfo.status, "not_enough_data");
  assert.equal(foreign.strengthTrend.detail, "One logged session so far.");
}

// Weekly review (7-day windows relative to the injected clock).
{
  const review = buildWeeklyReview(analytics.sessionSummaries, analytics.setRecords, now);
  assert.deepEqual(review.current, { workouts: 4, setCount: 7, totalVolume: 2525, averageRpe: 7.75, averageReadiness: 3.8 });
  assert.deepEqual(review.previous, { workouts: 1, setCount: 2, totalVolume: 675, averageRpe: 9, averageReadiness: 2.4 });
  assert.equal(review.bestSet.weight, 100);
  assert.deepEqual(review.notes, [
    "4 sessions banked this week. Consistency like that is what actually moves the numbers.",
    `Training volume climbed from ${formatVolume(675)} to ${formatVolume(2525)}. Nice work - just keep the jumps gradual.`,
    "Readiness improved to 3.8/5. Good window to push the main lifts.",
    "Set of the week: Bench Press - 100 kg x 5 reps @ RPE 8.",
  ]);

  const empty = buildWeeklyReview([], [], now);
  assert.deepEqual(empty.current, { workouts: 0, setCount: 0, totalVolume: 0, averageRpe: null, averageReadiness: null });
  assert.equal(empty.bestSet, null);
  assert.equal(empty.notes.length, 1);
  assert.match(empty.notes[0], /^Nothing logged in the last 7 days/);

  // A quiet week after an active one.
  const quiet = buildWeeklyReview(analytics.sessionSummaries, analytics.setRecords, now + 7.5 * dayMs);
  assert.equal(quiet.current.workouts, 0);
  assert.equal(quiet.previous.workouts, 4);
  assert.equal(quiet.notes[1], "The week before had 4 sessions, so the habit is there. Get one in early this week.");
}

// Legacy session shape (exercises map, no workoutSets) and readiness linking.
{
  const lookup = buildProgressExerciseLookup({ programs: [], activeProgram, activeProgramDays: [day], exerciseLibrary: [] });
  const legacy = {
    id: "legacy-1",
    date: "2026-09-20T18:00:00+03:00",
    dayId: "day-1",
    exercises: {
      "lib-bench": { exerciseId: "lib-bench", exerciseRPE: 8, sets: [{ reps: 5, weight: 70, rpe: null }, { reps: null, weight: null, rpe: null }] },
    },
  };
  const records = getSessionSetRecords(legacy, lookup);
  assert.equal(records.length, 2);
  assert.equal(records[0].exerciseKey, "program-exercise:program-a:pe-bench", "resolved through the Library id onto the active program occurrence");
  // A legacy map keyed by a Library id whose log carries no exerciseId resolves to a name key only.
  const bareLegacy = { ...legacy, exercises: { "lib-bench": { sets: [{ reps: 5, weight: 70, rpe: 8 }] } } };
  assert.equal(getSessionSetRecords(bareLegacy, lookup)[0].exerciseKey, "name:lib-bench");
  assert.equal(records[0].exerciseName, "Bench Press");
  assert.equal(records[0].rpe, 8, "exercise RPE fills in a missing set RPE");
  assert.equal(records[0].completed, true);
  assert.equal(records[1].completed, false);
  assert.equal(records[1].weight, null);

  const summaries = buildExerciseSessionSummaries(records.filter((record) => record.completed));
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].totalVolume, 350);

  const readinessByDate = {
    "2026-09-20": { date: "2026-09-20", readiness: { status: "yellow", averageScore: 3 } },
    "2026-09-21": { wellness: { sleep: 5, mood: 5, stress: 5, soreness: 5, fatigue: 5 } },
  };
  assert.deepEqual(getSessionReadinessForProgress(legacy, readinessByDate), { status: "yellow", averageScore: 3 }, "linked by the local date key of the session");
  assert.deepEqual(getSessionReadinessForProgress({ ...legacy, readinessDate: "2026-09-21" }, readinessByDate).status, "green", "readinessDate link wins");
  assert.equal(getSessionReadinessForProgress(legacy, {}), null);
  assert.equal(getSessionReadinessForProgress(s1, {}).status, "green");

  const entries = buildReadinessEntries(readinessByDate, sessions);
  assert.deepEqual(entries.map((entry) => entry.date), ["2026-09-21", "2026-09-20"], "stored check-ins win over session-derived entries");
  assert.equal(entries[0].readiness.status, "green");
  const derived = buildReadinessEntries({}, [s1]);
  assert.equal(derived.length, 1);
  assert.equal(derived[0].sessionId, "s1");
  assert.equal(derived[0].date, "2026-09-25");
}

// Recent-value trend helper.
{
  const trend = compareRecentSessionValues([{ v: 10 }, { v: 12 }, { v: 11 }, { v: 5 }, { v: 6 }, { v: 0 }], "v");
  assert.equal(trend.sampleSize, 3);
  assert.equal(trend.currentAverage, 11);
  assert.equal(trend.previousAverage, 5.5);
  assert.equal(trend.direction, "Up");
}

console.log("Session analytics verification passed.");
