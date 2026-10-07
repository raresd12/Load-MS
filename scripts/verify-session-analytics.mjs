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
  assert.deepEqual(Object.keys(analytics), ["exerciseCount", "loggedSetCount", "totalReps", "exerciseSummaries"], "a reps session keeps the pre-H5 keys");

  // Decision H5-30: timed / distance sets and bodyweight sets without a typed
  // load are counted in the exercise's measurement.
  const plank = { id: "pe-plank", name: "Plank", repsLabel: "45 s", loadType: "bodyweight", weightMode: "kg" };
  const carry = { id: "pe-carry", name: "Carry", repsLabel: "40 m", loadType: "external", weightMode: "per dumbbell" };
  const pushup = { id: "pe-pushup", name: "Push-up", repsLabel: "10-15", loadType: "bodyweight", weightMode: "kg" };
  const measuredDay = { id: "day-m", name: "Measured", type: "training", exercises: [plank, carry, pushup] };
  const measured = getSessionAnalytics(measuredDay, {
    exercises: {
      "pe-plank": { notes: "", painFlag: false, sets: [{ seconds: "45", weight: "BW", rpe: "7" }, { seconds: "50", weight: "", rpe: "8" }, { reps: "12", weight: "BW", rpe: "8" }, { seconds: "", weight: "", rpe: "" }] },
      "pe-carry": { notes: "", painFlag: false, sets: [{ meters: "40", weight: "24", rpe: "7" }, { meters: "40", weight: "", rpe: "7" }, { meters: "60", weight: "24", rpe: "" }] },
      "pe-pushup": { notes: "", painFlag: false, sets: [{ reps: "12", weight: "", rpe: "8" }, { reps: "10", weight: "BW", rpe: "8" }] },
    },
  });
  assert.equal(measured.loggedSetCount, 6, "3 plank sets (one legacy reps), 1 carry set (kg and RPE needed), 2 push-up sets (no typed load needed)");
  assert.equal(measured.totalReps, 34, "reps only: 12 legacy reps on the plank + 22 push-ups; seconds and meters are never reps");
  assert.equal(measured.totalSeconds, 95);
  assert.equal(measured.totalMeters, 140);
  assert.deepEqual(measured.exerciseSummaries[0], { exerciseId: "pe-plank", totalReps: 12, averageWeight: null, setCount: 3, exerciseRPE: measured.exerciseSummaries[0].exerciseRPE, totalSeconds: 95 });
  assert.deepEqual(measured.exerciseSummaries[1], { exerciseId: "pe-carry", totalReps: 0, averageWeight: 24, setCount: 1, exerciseRPE: measured.exerciseSummaries[1].exerciseRPE, totalMeters: 140 });
  assert.equal(measured.exerciseSummaries[2].setCount, 2);
  assert.equal("totalSeconds" in measured.exerciseSummaries[2], false);
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
  assert.equal(consistency.toneClass, "tone-good", "tone class is part of the card model (HV-5 tone-* component class)");

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
  // A legacy map keyed by a Library / legacy exercise id whose log carries no
  // ids resolves through that key (H5-22: the oldest sessions have no ids in
  // the log at all); an unknown key still ends as a name key.
  const bareLegacy = { ...legacy, exercises: { "lib-bench": { sets: [{ reps: 5, weight: 70, rpe: 8 }] } } };
  assert.equal(getSessionSetRecords(bareLegacy, lookup)[0].exerciseKey, "program-exercise:program-a:pe-bench");
  assert.equal(getSessionSetRecords(bareLegacy, lookup)[0].identitySource, "library");
  assert.equal(getSessionSetRecords({ ...legacy, exercises: { "lib-unknown": { sets: [{ reps: 5, weight: 70, rpe: 8 }] } } }, lookup)[0].exerciseKey, "name:lib-unknown");
  assert.equal(records[0].exerciseName, "Bench Press");
  assert.equal(records[0].rpe, 8, "exercise RPE fills in a missing set RPE");
  // A blank or unparsable set RPE falls back to the exercise RPE as before H5.
  const blankRpe = { ...legacy, exercises: { "lib-bench": { exerciseId: "lib-bench", exerciseRPE: 7.5, sets: [{ reps: "5", weight: "70", rpe: "" }, { reps: 5, weight: 70, rpe: "x" }] } } };
  assert.deepEqual(getSessionSetRecords(blankRpe, lookup).map((record) => record.rpe), [7.5, 7.5]);
  assert.equal(getSessionSetRecords(blankRpe, lookup)[0].reps, 5, "string counts are read as numbers");
  // A legacy set whose count is blank is not a logged set (H5-45): reps stay
  // null (never 0) and the set is not counted, whatever weight / RPE it has.
  const blankReps = getSessionSetRecords({ ...legacy, exercises: { "lib-bench": { exerciseId: "lib-bench", exerciseRPE: 9, sets: [{ reps: "8", weight: "60", rpe: "" }, { reps: "", weight: "60", rpe: "8" }, { reps: " ", weight: "60", rpe: "8" }] } } }, lookup);
  assert.deepEqual(blankReps.map((record) => [record.reps, record.rpe, record.completed]), [[8, 9, true], [null, 8, false], [null, 8, false]]);
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

// ===========================================================================
// Phase H5 (decision H5-10): measurement-aware analytics. Everything above
// is the pre-H5 fixture, unchanged: a reps / external / kg session keeps
// every output. Below: per-dumbbell x2, per-side x2, BW reps counted apart,
// timed / distance totals and trends, comparability guards, weekly
// observations, and the no-medical-claims grep.
// ===========================================================================
const {
  buildExerciseProgressTrend,
  buildExerciseMetricTrend,
  buildWeeklyObservationNotes,
  checkTrendComparability,
  countRecordsInWindow,
  DELOAD_SAMPLE_REQUIREMENT,
  E1RM_ELIGIBILITY,
  formatDuration,
  formatMeters,
  formatMetricValue,
  formatRecordLabel,
  getExerciseTrendMetric,
  readMeasuredSet,
  resolveProgressExerciseMatch,
  resolveSetMeasurementProfile,
} = await import("../src/lib/sessionAnalytics.js");
const { computePersonalRecords } = await import("../src/lib/personalRecords.js");

assert.deepEqual(DELOAD_SAMPLE_REQUIREMENT, { sessions: 6, windowDays: 21 });
assert.deepEqual(E1RM_ELIGIBILITY, { minReps: 1, maxReps: 10, minRpe: 6 });

// The pre-H5 outputs carry the new fields with their legacy values.
{
  const s1Summary = analytics.sessionSummaries[0];
  assert.equal(s1Summary.loggedVolume, 800, "as-logged sum equals the tonnage for kg sets");
  assert.equal(s1Summary.totalSeconds, 0);
  assert.equal(s1Summary.totalMeters, 0);
  assert.equal(s1Summary.bodyweightReps, 8, "the chin-up's BW reps are counted apart");
  assert.deepEqual(s1Summary.measurements, ["reps"]);
  assert.deepEqual(s1Summary.weightModes, ["kg"]);
  assert.equal(analytics.loggedVolume, analytics.totalVolume);
  const benchRecord = analytics.setRecords.find((record) => record.sessionId === "s1" && record.setNumber === 1);
  assert.equal(benchRecord.measurement, "reps");
  assert.equal(benchRecord.value, 5);
  assert.equal(benchRecord.tonnage, 400);
  assert.equal(benchRecord.weightMode, "kg");
  assert.equal(benchRecord.identitySource, "exact");
  assert.deepEqual(benchRecord.e1rmEligibility, { eligible: true, reason: null });
  const selected = buildSelectedExerciseAnalytics(analytics.exerciseOptions[0], analytics.setRecords);
  assert.equal(selected.measurement, "reps");
  assert.equal(selected.measurementUnit, "reps");
  assert.deepEqual(selected.comparability, { comparable: true, reason: null });
  assert.equal(selected.timeTrend.value, "No data");
  assert.equal(selected.loggedVolume, selected.totalVolume);
}

// Measurement-aware program: per-dumbbell press, per-side split squat,
// timed plank, distance carry, next to the kg bench and the BW chin-up.
const dbPress = { id: "pe-db", programExerciseId: "pe-db", libraryExerciseId: "lib-db", programId: "program-m", name: "DB Press", category: "compound", progressionType: "hypertrophy", sets: 3, repsMin: 8, repsMax: 12, repsLabel: "8-12", targetRPE: 8, restSeconds: 90, recommendedWeight: 30, loadType: "external", weightMode: "per dumbbell" };
const split = { id: "pe-split", programExerciseId: "pe-split", libraryExerciseId: "lib-split", programId: "program-m", name: "Split Squat", category: "compound", progressionType: "hypertrophy", sets: 3, repsMin: 8, repsMax: 8, repsLabel: "8 per side", targetRPE: 8, restSeconds: 90, recommendedWeight: 16, loadType: "external", weightMode: "per dumbbell" };
const plank = { id: "pe-plank", programExerciseId: "pe-plank", libraryExerciseId: "lib-plank", programId: "program-m", name: "Plank", category: "core", progressionType: "core", sets: 3, repsMin: null, repsMax: null, repsLabel: "45 s", targetRPE: 8, restSeconds: 45, recommendedWeight: null, loadType: "bodyweight", weightMode: "kg" };
const carry = { id: "pe-carry", programExerciseId: "pe-carry", libraryExerciseId: "lib-carry", programId: "program-m", name: "Farmer Carry", category: "compound", progressionType: "athletic", sets: 2, repsMin: null, repsMax: null, repsLabel: "40 m", targetRPE: 8, restSeconds: 90, recommendedWeight: 24, loadType: "external", weightMode: "per dumbbell" };
const mDay = { id: "day-m", name: "Measured", focus: "Mixed", type: "training", exercises: [{ ...bench, programId: "program-m" }, { ...chin, programId: "program-m" }, dbPress, split, plank, carry] };
const mProgram = { id: "program-m", name: "Measured", nickname: null };
const mNow = Date.parse("2026-09-30T12:00:00+03:00");
const mAt = (daysAgo) => new Date(mNow - daysAgo * dayMs).toISOString();

function mSet(programExerciseId, exerciseId, setNumber, fields) {
  return { programExerciseId, exerciseId, setNumber, completed: true, actualRPE: 8, ...fields };
}

const m1 = {
  id: "m1", date: mAt(1), programId: "program-m", dayId: "day-m", dayName: "Measured", sessionRpe: 8,
  readiness: { status: "green", averageScore: 4 },
  plannedExercises: { "pe-bench": { sets: 3, recommendedWeight: 80, prescriptionSource: "progression" }, "pe-db": { sets: 3, prescriptionSource: "target" }, "pe-plank": { sets: 2, prescriptionSource: "target" }, "pe-carry": { sets: 2, prescriptionSource: "override", sourceLabel: "Manual override (1 session left)" } },
  workoutSets: [
    mSet("pe-bench", "lib-bench", 1, { actualReps: 5, actualWeight: 80 }),          // 400
    mSet("pe-chin", "lib-chin", 1, { actualReps: 8, actualWeight: "BW" }),         // BW reps 8
    mSet("pe-db", "lib-db", 1, { actualReps: 10, actualWeight: 30 }),              // 30*10*2 = 600
    mSet("pe-split", "lib-split", 1, { actualReps: 8, actualWeight: 16 }),         // 16*8*2*2 = 512
    mSet("pe-plank", "lib-plank", 1, { seconds: 45, actualWeight: "BW" }),
    mSet("pe-plank", "lib-plank", 2, { seconds: 50, actualWeight: "BW" }),
    mSet("pe-carry", "lib-carry", 1, { meters: 40, actualWeight: 24 }),
    mSet("pe-carry", "lib-carry", 2, { meters: 40, actualWeight: 24 }),
  ],
};
const m2 = {
  id: "m2", date: mAt(4), programId: "program-m", dayId: "day-m", dayName: "Measured", sessionRpe: 7,
  readiness: { status: "yellow", averageScore: 3.4 },
  plannedExercises: { "pe-bench": { sets: 3, recommendedWeight: 77.5, prescriptionSource: "progression", held: true, sourceLabel: "Held by you" }, "pe-db": { sets: 3 }, "pe-plank": { sets: 2 }, "pe-carry": { sets: 2 } },
  workoutSets: [
    mSet("pe-bench", "lib-bench", 1, { actualReps: 5, actualWeight: 77.5 }),
    mSet("pe-db", "lib-db", 1, { actualReps: 9, actualWeight: 30 }),
    mSet("pe-plank", "lib-plank", 1, { seconds: 40, actualWeight: "BW" }),
    mSet("pe-carry", "lib-carry", 1, { meters: 30, actualWeight: 24 }),
  ],
};
// Two weeks ago: the DB press was logged in kg (total), the plank as reps (pre-H5 set shape).
const m3 = {
  id: "m3", date: mAt(10), programId: "program-m", dayId: "day-m", dayName: "Measured", sessionRpe: 8,
  readiness: { status: "green", averageScore: 4.2 },
  workoutSets: [
    mSet("pe-bench", "lib-bench", 1, { actualReps: 5, actualWeight: 75 }),
    mSet("pe-db", "lib-db", 1, { actualReps: 10, actualWeight: 60, weightMode: "kg" }),
    mSet("pe-plank", "lib-plank", 1, { actualReps: 30, actualWeight: "BW" }),
  ],
};
const mSessions = [m1, m2, m3];
const mAnalytics = buildProgressAnalytics({ sessions: mSessions, readinessByDate: {}, programs: [], activeProgram: mProgram, activeProgramDays: [mDay], exerciseLibrary: [], now: mNow });

// Session totals.
{
  const [sum1, sum2, sum3] = mAnalytics.sessionSummaries;
  assert.equal(sum1.sessionKey, "m1");
  assert.equal(sum1.totalVolume, 400 + 600 + 512, "tonnage: per dumbbell x2, per side x2, BW / timed / distance add nothing");
  assert.equal(sum1.loggedVolume, 400 + 300 + 128, "as logged: weight x reps");
  assert.equal(sum1.totalSeconds, 95);
  assert.equal(sum1.bestSeconds, 50);
  assert.equal(sum1.totalMeters, 80);
  assert.equal(sum1.bestMeters, 40);
  assert.equal(sum1.bodyweightReps, 8);
  assert.equal(sum1.totalReps, 5 + 8 + 10 + 8, "timed / distance sets are not reps");
  assert.equal(sum1.completedSetCount, 8);
  assert.deepEqual(sum1.measurements.sort(), ["distance", "reps", "time"]);
  assert.deepEqual(sum1.weightModes.sort(), ["kg", "per dumbbell"]);
  assert.ok(Math.abs(sum1.bestEstimatedStrength - 80 * (1 + 5 / 30)) < 1e-9, "e1RM stays the per-dumbbell / as-logged value");
  assert.equal(sum2.totalVolume, 387.5 + 540);
  assert.equal(sum3.totalVolume, 375 + 600, "a set persisted in kg is read in kg: 60 x 10, not doubled");
  assert.equal(sum3.totalSeconds, 0, "a reps-only set of the timed plank stays a reps set (H5-1), never relabelled");
  assert.equal(sum3.totalReps, 5 + 10 + 30, "the pre-H5 reps set of the plank counts as reps");
  assert.equal(mAnalytics.totalVolume, sum1.totalVolume + sum2.totalVolume + sum3.totalVolume);
  assert.equal(mAnalytics.totalSeconds, 135);
  assert.equal(mAnalytics.totalMeters, 110);
  assert.equal(sum3.bodyweightReps, 30, "the plank's reps at BW are bodyweight reps");
  assert.equal(mAnalytics.bodyweightReps, 38);

  const plankRecord = mAnalytics.setRecords.find((record) => record.sessionId === "m1" && record.programExerciseId === "pe-plank" && record.setNumber === 2);
  assert.equal(plankRecord.measurement, "time");
  assert.equal(plankRecord.seconds, 50);
  assert.equal(plankRecord.reps, null);
  assert.equal(plankRecord.value, 50);
  assert.equal(plankRecord.completed, true);
  assert.equal(plankRecord.tonnage, null);
  assert.equal(plankRecord.estimatedOneRepMax, null);
  assert.equal(plankRecord.e1rmEligibility.reason, "time: e1RM only for rep-based sets");
  const carryRecord = mAnalytics.setRecords.find((record) => record.sessionId === "m1" && record.programExerciseId === "pe-carry" && record.setNumber === 1);
  assert.equal(carryRecord.measurement, "distance");
  assert.equal(carryRecord.meters, 40);
  assert.equal(carryRecord.weightMode, "per dumbbell");
  const dbRecord = mAnalytics.setRecords.find((record) => record.sessionId === "m1" && record.programExerciseId === "pe-db");
  assert.equal(dbRecord.tonnage, 600);
  assert.equal(dbRecord.weightMode, "per dumbbell");
  const dbOld = mAnalytics.setRecords.find((record) => record.sessionId === "m3" && record.programExerciseId === "pe-db");
  assert.equal(dbOld.weightMode, "kg", "the set's own persisted weight mode wins over the exercise profile");
  assert.equal(dbOld.tonnage, 600);
  const splitRecord = mAnalytics.setRecords.find((record) => record.programExerciseId === "pe-split");
  assert.equal(splitRecord.perSide, true);
  assert.equal(splitRecord.tonnage, 512);

  assert.equal(formatSetPerformance(plankRecord), "BW x 50 sec @ RPE 8");
  assert.equal(formatSetPerformance(carryRecord), "24 kg x 40 m @ RPE 8");
  assert.equal(formatSetPerformance({ measurement: "time", weight: 10, seconds: 150, rpe: NaN }), "10 kg x 2 min 30 sec");
  assert.equal(formatSetPerformance({ measurement: "distance", weight: "BW", meters: NaN }), "BW x No distance");
  assert.equal(formatDuration(95), "1 min 35 sec");
  assert.equal(formatDuration(null), "No time");
  assert.equal(formatMeters(1200), (1200).toLocaleString() + " m");
  assert.equal(formatMeters(-1), "No distance");
  assert.equal(formatMetricValue("time", 60), "1 min");
  assert.equal(formatMetricValue("distance", 400), "400 m");
  assert.equal(formatMetricValue("e1rm", 93.33), "93.3 kg");
  assert.equal(formatMetricValue("volume", 2525.4), formatVolume(2525.4));
}

// Set reading helpers.
{
  const timedProfile = resolveSetMeasurementProfile({}, { measurement: "time", unit: "s", perSide: false, loadType: "bodyweight", weightMode: "kg" });
  assert.equal(timedProfile.measurement, "time");
  const overridden = resolveSetMeasurementProfile({ measurement: "reps", weightMode: "kg", perSide: true }, { measurement: "time", unit: "s", perSide: false, loadType: "external", weightMode: "per dumbbell" });
  assert.deepEqual(overridden, { measurement: "reps", unit: "reps", perSide: true, loadType: "external", weightMode: "kg" });
  assert.equal(resolveSetMeasurementProfile({ measurement: "bogus" }, undefined).measurement, "reps");
  const read = readMeasuredSet({ actualReps: 10, actualWeight: 30, actualRPE: 8 }, { measurement: "reps", perSide: false, loadType: "external", weightMode: "per dumbbell" });
  assert.deepEqual(read, { measurement: "reps", value: 10, weight: 30, rpe: 8, completed: true, tonnage: 600 });
  const untouched = readMeasuredSet({ actualReps: null, actualWeight: null, actualRPE: null }, undefined);
  assert.equal(untouched.value, null);
  assert.equal(untouched.completed, false);
  assert.equal(untouched.tonnage, null);
  assert.equal(readMeasuredSet({ actualReps: 5, actualWeight: 80, actualRPE: 11 }, undefined).rpe, null, "RPE keeps the 1-10 rule");
  const lookup = buildProgressExerciseLookup({ programs: [], activeProgram: mProgram, activeProgramDays: [mDay], exerciseLibrary: [] });
  assert.deepEqual(resolveProgressExerciseMatch({ programId: "program-m", programExerciseId: "pe-db" }, lookup).via, "exact");
  assert.deepEqual(resolveProgressExerciseMatch({ programExerciseId: "pe-db" }, lookup).via, "loose");
  assert.deepEqual(resolveProgressExerciseMatch({ exerciseId: "lib-db" }, lookup).via, "library");
  assert.deepEqual(resolveProgressExerciseMatch({ exerciseName: "DB PRESS" }, lookup).via, "name");
  assert.deepEqual(resolveProgressExerciseMatch({ exerciseName: "nothing" }, lookup), { entry: null, via: "none" });
  assert.equal(lookup.byProgramExercise.get("program-m::pe-plank").profile.measurement, "time");
  assert.equal(lookup.byProgramExercise.get("program-m::pe-split").profile.perSide, true);
  assert.equal(lookup.exerciseIdCounts.get("lib-bench"), 1);
}

// Exercise trends per measurement and the comparability guard.
{
  const option = (id) => mAnalytics.exerciseOptions.find((entry) => entry.programExerciseId === id);
  const plankTrend = buildSelectedExerciseAnalytics(option("pe-plank"), mAnalytics.setRecords);
  assert.equal(plankTrend.measurement, "time");
  assert.equal(plankTrend.measurementUnit, "s");
  assert.equal(plankTrend.bestSeconds, 50);
  assert.equal(plankTrend.totalSeconds, 135);
  assert.equal(plankTrend.timeTrend.value, "50 sec");
  assert.equal(plankTrend.timeTrend.detail, "Up 10 sec versus last time.");
  assert.equal(plankTrend.totalTimeTrend.value, "1 min 35 sec");
  assert.equal(plankTrend.totalTimeTrend.detail, "Up 55 sec versus last time.");
  assert.equal(plankTrend.strengthTrend.value, "No data");
  assert.equal(plankTrend.trendInfo.status, "improving");
  assert.equal(plankTrend.trendInfo.body, "Best time improved versus last time. Keep building without forcing jumps.");
  assert.equal(plankTrend.recentSessions[0].measurement, "time");
  assert.equal(plankTrend.recentSessions[2].measurement, "reps", "the pre-H5 reps set stays a reps session");
  assert.equal(plankTrend.bestSet.seconds, 50, "best timed set: longest at the top weight");
  assert.equal(plankTrend.trendMaxValue, 50);
  // The reps-only session versus a timed one is not comparable.
  assert.deepEqual(checkTrendComparability(plankTrend.recentSessions[1], plankTrend.recentSessions[2]), { comparable: false, reason: "Not comparable: measurement changed.", changed: "measurement" });
  assert.equal(buildExerciseProgressTrend(plankTrend.recentSessions.slice(1)).status, "not_comparable");
  assert.equal(buildExerciseProgressTrend(plankTrend.recentSessions.slice(1)).label, "Not comparable");
  assert.equal(buildExerciseProgressTrend(plankTrend.recentSessions.slice(1)).body, "Not comparable: measurement changed. The trend restarts from this session.");

  const carryTrend = buildSelectedExerciseAnalytics(option("pe-carry"), mAnalytics.setRecords);
  assert.equal(carryTrend.measurement, "distance");
  assert.equal(carryTrend.distanceTrend.value, "40 m");
  assert.equal(carryTrend.distanceTrend.detail, "Up 10 m versus last time.");
  assert.equal(carryTrend.totalDistanceTrend.value, "80 m");
  assert.equal(carryTrend.trendInfo.status, "improving");
  assert.deepEqual(getExerciseTrendMetric(carryTrend.recentSessions[0]), { label: "Best distance", value: 40 });
  assert.deepEqual(getExerciseTrendMetric(plankTrend.recentSessions[0]), { label: "Best time", value: 50 });
  assert.equal(carryTrend.totalVolume, 0, "distance sets carry no tonnage");

  // DB press: per dumbbell now, kg two weeks ago -> tonnage is not compared across the mode change.
  const dbTrend = buildSelectedExerciseAnalytics(option("pe-db"), mAnalytics.setRecords);
  assert.equal(dbTrend.weightMode, "per dumbbell");
  assert.equal(dbTrend.totalVolume, 600 + 540 + 600);
  assert.deepEqual(dbTrend.comparability, { comparable: true, reason: null }, "the two latest sessions share the mode");
  assert.equal(dbTrend.volumeTrend.detail, "Up 60 kg versus last time.");
  const modeChange = buildExerciseMetricTrend(dbTrend.recentSessions.slice(1), "totalVolume", formatVolume);
  assert.deepEqual(modeChange, { value: "540 kg", detail: "Not comparable: measurement changed.", comparable: false });
  assert.equal(buildExerciseProgressTrend(dbTrend.recentSessions.slice(1)).status, "not_comparable");
  assert.equal(buildExerciseMetricTrend(dbTrend.recentSessions.slice(1), "bestEstimatedStrength", formatKg).comparable, false, "e1RM is not compared across the mode change either");
  assert.deepEqual(checkTrendComparability({ measurement: "reps", weightMode: "kg" }, { measurement: "reps", weightMode: "kg" }), { comparable: true, reason: null });
  assert.deepEqual(checkTrendComparability({}, {}), { comparable: true, reason: null }, "pre-H5 entries without the fields stay comparable");
  assert.deepEqual(checkTrendComparability({ measurement: "reps", weightMode: "kg", perSide: true }, { measurement: "reps", weightMode: "kg" }), { comparable: false, reason: "Not comparable: measurement changed.", changed: "perSide" }, "per side changed (H5-20)");
  assert.deepEqual(checkTrendComparability({ loadType: "bodyweight" }, { loadType: "external" }), { comparable: false, reason: "Not comparable: measurement changed.", changed: "loadType" }, "load type changed (H5-20)");
  assert.deepEqual(checkTrendComparability({ perSide: false, loadType: "external" }, {}), { comparable: true, reason: null }, "explicit defaults equal absent fields");
  assert.deepEqual(checkTrendComparability(null, {}), { comparable: true, reason: null });

  // Mixed best-set ranking: reps above time above distance; within time the longer hold at the heavier load.
  const sorted = [
    { measurement: "distance", weight: 24, meters: 40, estimatedOneRepMax: null },
    { measurement: "time", weight: "BW", seconds: 50, estimatedOneRepMax: null },
    { measurement: "time", weight: 10, seconds: 30, estimatedOneRepMax: null },
    { weight: "BW", reps: 8, estimatedOneRepMax: null },
  ].sort(compareBestSet);
  assert.deepEqual(sorted.map((set) => `${set.measurement ?? "reps"}:${set.weight}`), ["reps:BW", "time:10", "time:BW", "distance:24"]);
  assert.equal([{ measurement: "time", weight: "BW", seconds: 30 }, { measurement: "time", weight: "BW", seconds: 45 }].sort(compareBestSet)[0].seconds, 45);
  assert.equal(mAnalytics.bestRecentSet.weight, 80, "a kg rep set is the best recent set of the mixed program");
}

// Weekly review: unchanged without options, H5 observations with them.
{
  const plain = buildWeeklyReview(mAnalytics.sessionSummaries, mAnalytics.setRecords, mNow);
  assert.deepEqual(Object.keys(plain).sort(), ["bestSet", "current", "notes", "previous"], "no options: the pre-H5 shape");
  assert.equal(plain.current.totalVolume, 1512 + 927.5, "window totals are measurement-aware tonnage");
  assert.equal(plain.previous.totalVolume, 975);

  const mRecords = computePersonalRecords({ sessions: mSessions, programs: [mProgram], programExercises: mDay.exercises, exerciseLibrary: [] });
  const review = buildWeeklyReview(mAnalytics.sessionSummaries, mAnalytics.setRecords, mNow, { sessions: mSessions, records: mRecords });
  const { observations } = review;
  assert.equal(observations.adherence.plannedSessionCount, 2, "m3 has no snapshot");
  // m1: 10 planned sets, 6 counted (chin-up and split squat were not planned); m2: 4 of 10.
  assert.ok(Math.abs(observations.adherence.averageRatio - (6 / 10 + 4 / 10) / 2) < 1e-9, String(observations.adherence.averageRatio));
  assert.deepEqual(observations.holdOverride, { count: 2, held: 1, overridden: 1, deload: 0 });
  assert.equal(observations.records.count > 0, true);
  assert.equal(observations.performance.comparable, true, "two readiness-linked sessions with e1RM this week");
  assert.equal(observations.performance.metricId, "e1rm");
  assert.equal(observations.performance.rankedCount, 2);
  assert.equal(observations.performance.readinessLabel, "Green");
  assert.deepEqual(observations.measured.current, { tonnage: 1512 + 927.5, loggedVolume: 828 + 657.5, totalSeconds: 135, totalMeters: 110, bodyweightReps: 8 });
  assert.deepEqual(observations.measured.previous, { tonnage: 975, loggedVolume: 975, totalSeconds: 0, totalMeters: 0, bodyweightReps: 30 });
  assert.deepEqual(observations.deloadCheck, { required: 6, windowDays: 21, have: 3, met: false });

  const notes = review.notes;
  assert.ok(notes.includes("Plan adherence averaged 50% across 2 planned sessions (2 were partial); the coach weighs partial sessions as lighter evidence."), notes.join("\n"));
  assert.ok(notes.includes("2 sessions used your own settings this week: 1 on hold, 1 with a manual override. History is kept as logged."), notes.join("\n"));
  assert.ok(notes.some((note) => /^\d+ new records? this week: /.test(note)), notes.join("\n"));
  // H5-44: an e1RM is one lift's number. The line names the lift and does
  // not call sessions that trained different lifts "comparable sessions".
  assert.equal(observations.performance.exerciseName, "Bench Press");
  assert.ok(notes.some((note) => /^Best e1RM this week: 93\.3 kg \(Bench Press\) on .* \(readiness Green\)\. 2 sessions logged an e1RM; different lifts are not ranked against each other\.$/.test(note)), notes.join("\n"));
  assert.ok(!notes.some((note) => /comparable sessions/.test(note)), "no cross-exercise 'comparable sessions' claim for e1RM");
  assert.ok(notes.includes("Timed work: 2 min 15 sec this week vs 0 sec the week before."), notes.join("\n"));
  assert.ok(notes.includes("Distance work: 110 m this week vs 0 m the week before."), notes.join("\n"));
  assert.ok(notes.includes("Deload check needs 6 sessions in 21 days; you have 3."), notes.join("\n"));
  assert.equal(notes.indexOf("Deload check needs 6 sessions in 21 days; you have 3."), notes.length - 1, "the deload line is the last observation");
  assert.ok(notes.includes("Bodyweight reps: 8 this week vs 30 the week before (counted apart from kg volume)."), notes.join("\n"));

  // Readiness/performance observation only with >= MIN_COMPARABLE_SESSIONS comparable sessions.
  const single = buildWeeklyReview(mAnalytics.sessionSummaries.slice(0, 1), mAnalytics.setRecords, mNow, { sessions: [m1] });
  assert.equal(single.observations.performance.comparable, false);
  assert.equal(single.observations.performance.needed, 1);
  assert.ok(single.notes.includes("Not comparable yet: 1 more session needed before a readiness/performance observation."), single.notes.join("\n"));
  assert.ok(single.notes.includes("Deload check needs 6 sessions in 21 days; you have 1."));

  // With the active program's deload evaluation the line states the same
  // sample the deload check uses (sessions AND check-ins), never a different
  // count (H5-23); an eligible evaluation drops the line.
  const evaluated = buildWeeklyReview(mAnalytics.sessionSummaries, mAnalytics.setRecords, mNow, {
    sessions: mSessions,
    deloadEvaluation: { eligible: false, sampleSize: { sessions: 2, checkIns: 1 }, requiredSampleSize: { sessions: 6, checkIns: 4 }, windowDays: 21 },
  });
  assert.deepEqual(evaluated.observations.deloadCheck, { required: 6, windowDays: 21, have: 2, met: false, checkIns: { required: 4, have: 1 }, fromEvaluation: true });
  assert.equal(evaluated.notes.at(-1), "Deload check needs 6 sessions and 4 readiness check-ins in 21 days; you have 2 sessions and 1 check-in.");
  assert.ok(!evaluated.notes.includes("Deload check needs 6 sessions in 21 days; you have 3."), "the session-only count is not stated alongside");
  const eligibleReview = buildWeeklyReview(mAnalytics.sessionSummaries, mAnalytics.setRecords, mNow, {
    sessions: mSessions,
    deloadEvaluation: { eligible: true, sampleSize: { sessions: 6, checkIns: 4 }, requiredSampleSize: { sessions: 6, checkIns: 4 }, windowDays: 21 },
  });
  assert.equal(eligibleReview.observations.deloadCheck.met, true);
  assert.ok(!eligibleReview.notes.some((note) => note.startsWith("Deload check")));

  // The deload requirement is overridable (Track A's constants) and the line goes when it is met.
  const met = buildWeeklyReview(mAnalytics.sessionSummaries, mAnalytics.setRecords, mNow, { sessions: mSessions, deloadRequirement: { sessions: 3, windowDays: 14 } });
  assert.deepEqual(met.observations.deloadCheck, { required: 3, windowDays: 14, have: 3, met: true });
  assert.ok(!met.notes.some((note) => note.startsWith("Deload check")));
  assert.equal(met.observations.records, null, "no records given: no records line");
  assert.ok(!met.notes.some((note) => /records? this week/.test(note)));

  // The records line counts records set inside the window; examples name the exercise.
  const window = countRecordsInWindow(mRecords, mNow - 7 * dayMs, mNow);
  assert.ok(window.count >= 4);
  assert.ok(window.examples.length <= 3);
  assert.ok(window.examples.every((example) => /^(Bench Press|Chin-up|DB Press|Split Squat|Plank|Farmer Carry) /.test(example)), window.examples.join(" | "));
  assert.deepEqual(countRecordsInWindow(null, 0, 1), { count: 0, examples: [] });
  assert.equal(formatRecordLabel({ type: "best_time", value: 70 }), "time 1 min 10 sec");
  assert.equal(formatRecordLabel({ type: "best_reps_at_weight", value: 8, weight: "BW" }), "8 reps at BW");
  assert.equal(formatRecordLabel({ type: "best_session_volume", value: 1510 }), "session volume " + formatVolume(1510));

  // Every observation line reads from the injected clock only: same input, same notes.
  assert.deepEqual(buildWeeklyReview(mAnalytics.sessionSummaries, mAnalytics.setRecords, mNow, { sessions: mSessions, records: mRecords }).notes, notes);
  assert.deepEqual(buildWeeklyObservationNotes({}), []);

  // The pre-H5 program's review with options: adherence has nothing to say (no snapshots), no hold / override.
  const legacyReview = buildWeeklyReview(analytics.sessionSummaries, analytics.setRecords, now, { sessions });
  assert.deepEqual(legacyReview.notes.slice(0, 4), buildWeeklyReview(analytics.sessionSummaries, analytics.setRecords, now).notes, "the pre-H5 notes come first, unchanged");
  assert.equal(legacyReview.observations.holdOverride.count, 0);
  assert.equal(legacyReview.observations.adherence.plannedSessionCount, 0);
  assert.ok(legacyReview.notes.includes("Deload check needs 6 sessions in 21 days; you have 5."));
}

// No medical claims in any produced string (H5-10 gate).
{
  const produced = [];
  const collect = (value) => {
    if (typeof value === "string") produced.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(buildWeeklyReview(mAnalytics.sessionSummaries, mAnalytics.setRecords, mNow, { sessions: mSessions, records: computePersonalRecords({ sessions: mSessions, programs: [mProgram], programExercises: mDay.exercises }) }));
  collect(buildWeeklyReview(analytics.sessionSummaries, analytics.setRecords, now + 7.5 * dayMs, { sessions }));
  collect(mAnalytics.insights);
  collect(mAnalytics.readinessPerformance);
  mAnalytics.exerciseOptions.forEach((option) => collect(buildSelectedExerciseAnalytics(option, mAnalytics.setRecords).trendInfo));
  assert.ok(produced.length > 20);
  produced.forEach((text) => assert.doesNotMatch(text, /injury|overtraining syndrome|diagnos/i, text));
}

console.log("Session analytics verification passed.");
