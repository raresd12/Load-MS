import assert from "node:assert/strict";
import { generateNextPlan } from "../src/lib/progression.js";

// Phase H1 / Track A: strict progression identity (F1), skipped-exercise
// handling (decision new-C) and own-snapshot history evaluation (F11).
//
// Session shapes mirror what src/App.jsx saveWorkout writes (schema 6):
// exercises keyed by programExerciseId with programExerciseId/exerciseId,
// plannedExercises snapshot keyed the same way, and workoutSets carrying
// programId/programExerciseId/exerciseId. "Legacy" sessions mirror the
// pre-programs shape: exercises keyed by the config/Library id with no ids
// inside the log, no programId and no workoutSets.

const LIBRARY_BENCH = "bench-press";

function programExercise({ programId, dayId = "day-1", libraryId = LIBRARY_BENCH, overrides = {} }) {
  const programExerciseId = `${programId}:${dayId}:${libraryId}`;
  return {
    id: programExerciseId,
    programExerciseId,
    libraryExerciseId: libraryId,
    legacyExerciseId: libraryId,
    programId,
    dayId,
    name: "Bench Press",
    category: "compound",
    equipment: "barbell",
    muscleGroup: "chest",
    priority: "high",
    progressionType: "strength",
    sets: 4,
    repsMin: 5,
    repsMax: 7,
    repsLabel: "5-7",
    targetRPE: 8,
    restSeconds: 180,
    recommendedWeight: 100,
    loadType: "external",
    roundToKg: 2.5,
    ...overrides,
  };
}

function dayFor(exercises, { id = "day-1", name = "Day 1" } = {}) {
  return { id, name, type: "lifting", exercises };
}

function snapshotFor(exercise, overrides = {}) {
  return {
    sets: exercise.sets,
    repsMin: exercise.repsMin,
    repsMax: exercise.repsMax,
    repsLabel: exercise.repsLabel,
    restSeconds: exercise.restSeconds,
    targetRPE: exercise.targetRPE,
    recommendedWeight: exercise.recommendedWeight,
    ...overrides,
  };
}

function modernSession({
  id,
  exercise,
  reps,
  weight = exercise.recommendedWeight,
  rpe = 8,
  sessionRpe = 8,
  date = "2026-03-10T10:00:00.000Z",
  dayId = exercise.dayId,
  dayName = "Day 1",
  programId = exercise.programId,
  snapshot = snapshotFor(exercise),
  extraExercises = {},
}) {
  const sets = reps.map((rep) => ({ reps: rep, weight: rep === null ? null : weight, rpe: rep === null ? null : rpe }));
  const numericRpes = sets.map((set) => set.rpe).filter((value) => Number.isFinite(value));
  const exerciseRPE = numericRpes.length
    ? Number((numericRpes.reduce((total, value) => total + value, 0) / numericRpes.length).toFixed(1))
    : null;

  return {
    id,
    schemaVersion: 6,
    date,
    programId,
    dayId,
    dayName,
    sessionRpe,
    readiness: { status: "green", averageScore: 4.2, isGood: true, isPoor: false },
    plannedExercises: {
      exercises: { [exercise.id]: snapshot },
    },
    exercises: {
      [exercise.id]: {
        programExerciseId: exercise.programExerciseId,
        exerciseId: exercise.libraryExerciseId,
        exerciseRPE,
        painFlag: false,
        sets,
      },
      ...extraExercises,
    },
    workoutSets: sets.map((set, index) => ({
      sessionId: id,
      programId,
      dayId,
      programExerciseId: exercise.programExerciseId,
      exerciseId: exercise.libraryExerciseId,
      setNumber: index + 1,
      plannedWeight: snapshot.recommendedWeight,
      plannedReps: snapshot.repsLabel,
      actualWeight: set.weight,
      actualReps: set.reps,
      actualRPE: set.rpe,
      completed: set.reps !== null,
    })),
  };
}

function legacySession({
  id,
  reps,
  weight = 100,
  rpe = 8,
  date = "2026-03-03T10:00:00.000Z",
  dayId = "day-1",
  dayName = "Day 1",
  logs = { [LIBRARY_BENCH]: null },
}) {
  const exercises = Object.fromEntries(
    Object.keys(logs).map((key) => [
      key,
      {
        exerciseRPE: rpe,
        sets: reps.map((rep) => ({ reps: rep, weight, rpe })),
      },
    ]),
  );

  return {
    id,
    schemaVersion: 3,
    date,
    dayId,
    dayName,
    sessionRpe: 8,
    readiness: { status: "green", averageScore: 4.2, isGood: true, isPoor: false },
    exercises,
  };
}

function planFor(day, currentSession, previousSessions = [], index = 0) {
  return generateNextPlan(day, currentSession, previousSessions).exercises[index];
}

const benchA = programExercise({ programId: "program-a" });
const benchB = programExercise({ programId: "program-b" });
const dayA = dayFor([benchA]);

// --- F1: program B history must not count for program A -------------------
// Both programs have a day called "Day 1" (default programs even share the
// day id), the same Library bench and distinct program/exercise ids.
const strongCurrentA = modernSession({ id: "a-current", exercise: benchA, reps: [7, 7, 7, 7], rpe: 8 });
const strongPriorB = modernSession({
  id: "b-prior",
  exercise: benchB,
  reps: [7, 7, 7, 7],
  rpe: 8,
  date: "2026-03-03T10:00:00.000Z",
});

const crossProgram = planFor(dayA, strongCurrentA, [strongPriorB]);
assert.equal(crossProgram.historySampleSize, 0, "program B session must not be history for program A");
assert.equal(crossProgram.decision, "increase_load");
assert.equal(crossProgram.confidence, "medium", "no foreign history -> first strong pattern stays medium confidence");
assert.equal(crossProgram.conservative, true);

// Positive control: the same session from program A does count.
const strongPriorA = modernSession({
  id: "a-prior",
  exercise: benchA,
  reps: [7, 7, 7, 7],
  rpe: 8,
  date: "2026-03-03T10:00:00.000Z",
});
const sameProgram = planFor(dayA, strongCurrentA, [strongPriorA]);
assert.equal(sameProgram.historySampleSize, 1);
assert.equal(sameProgram.decision, "increase_load");
assert.equal(sameProgram.confidence, "high");

// Conflicting exercise id inside an otherwise matching program/day is excluded.
const inclineA = programExercise({ programId: "program-a", libraryId: "incline-bench" });
const priorInclineOnly = modernSession({
  id: "a-incline",
  exercise: inclineA,
  reps: [7, 7, 7, 7],
  rpe: 8,
  date: "2026-03-03T10:00:00.000Z",
});
const conflictingExercise = planFor(dayA, strongCurrentA, [priorInclineOnly]);
assert.equal(conflictingExercise.historySampleSize, 0);

// Same day name but a different day id in the same program is a different day.
const benchADay2 = programExercise({ programId: "program-a", dayId: "day-2" });
const priorDay2 = modernSession({
  id: "a-day2",
  exercise: benchADay2,
  reps: [7, 7, 7, 7],
  rpe: 8,
  date: "2026-03-03T10:00:00.000Z",
  dayName: "Day 1",
});
assert.equal(planFor(dayA, strongCurrentA, [priorDay2]).historySampleSize, 0);

// --- Legacy sessions: allowed only when unambiguous -----------------------
const legacyPrior = legacySession({ id: "legacy-prior", reps: [7, 7, 7, 7], rpe: 8 });
const legacyUnambiguous = planFor(dayA, strongCurrentA, [legacyPrior]);
assert.equal(legacyUnambiguous.historySampleSize, 1, "legacy session keyed by Library id matches when unambiguous");
assert.equal(legacyUnambiguous.confidence, "high");
assert.ok(
  !legacyUnambiguous.warnings.some((warning) => warning.includes("Older sessions without exercise ids")),
  "no skip warning when the legacy session was usable",
);

// The same Library bench appears twice in the day -> the legacy log cannot be
// attributed to one occurrence, so it is skipped with a single warning.
const benchA2 = programExercise({
  programId: "program-a",
  overrides: { id: "program-a:day-1:bench-press#2", programExerciseId: "program-a:day-1:bench-press#2" },
});
const dayWithTwoBenches = dayFor([benchA, benchA2]);
const ambiguousLegacy = planFor(dayWithTwoBenches, strongCurrentA, [legacyPrior, legacyPrior]);
assert.equal(ambiguousLegacy.historySampleSize, 0, "ambiguous legacy sessions must be excluded");
assert.equal(
  ambiguousLegacy.warnings.filter((warning) => warning.includes("Older sessions without exercise ids were skipped")).length,
  1,
  "exactly one skip warning",
);
assert.equal(ambiguousLegacy.decision, "increase_load");
assert.equal(ambiguousLegacy.confidence, "medium");

// 19.1 Identity, same exercise twice on one day: a MODERN session logged for
// the second occurrence (same Library id, same day, distinct
// programExerciseId) is never history for the first occurrence, and vice
// versa. Modern ids never trigger the legacy skip warning.
const priorOccurrence2 = modernSession({ id: "a2-prior", exercise: benchA2, reps: [7, 7, 7, 7], rpe: 8 });
const firstOccurrence = planFor(dayWithTwoBenches, strongCurrentA, [priorOccurrence2]);
assert.equal(firstOccurrence.historySampleSize, 0, "second-occurrence session is not history for the first occurrence");
assert.ok(
  !firstOccurrence.warnings.some((warning) => warning.includes("Older sessions without exercise ids")),
  "modern ids never trigger the legacy skip warning",
);
const secondOccurrence = planFor(dayWithTwoBenches, priorOccurrence2, [strongPriorA], 1);
assert.equal(secondOccurrence.historySampleSize, 0, "first-occurrence session is not history for the second occurrence");

// A legacy session with a conflicting known id is excluded silently, no name fallback.
const legacyOtherId = legacySession({ id: "legacy-other", reps: [7, 7, 7, 7], logs: { "incline-bench": null } });
assert.equal(planFor(dayA, strongCurrentA, [legacyOtherId]).historySampleSize, 0);

// Fix round 2 coverage: per-session ambiguity. ONE legacy session whose
// exercises map holds two id-less logs that both match the occurrence (keyed
// by the Library id and by the programExerciseId) cannot be attributed
// either, even though the day lists the bench once (pickLogCandidate's
// `legacy.length > 1` branch, not the day-level Library-id duplication).
const legacyTwoLogs = legacySession({
  id: "legacy-two-logs",
  reps: [7, 7, 7, 7],
  logs: { [LIBRARY_BENCH]: null, [benchA.programExerciseId]: null },
});
const perSessionAmbiguous = planFor(dayA, strongCurrentA, [legacyTwoLogs]);
assert.equal(perSessionAmbiguous.historySampleSize, 0, "two matching id-less logs in one session are ambiguous");
assert.equal(
  perSessionAmbiguous.warnings.filter((warning) => warning.includes("Older sessions without exercise ids were skipped")).length,
  1,
  "exactly one skip warning for the per-session ambiguity",
);

// Fix round 2 coverage: the analytics.exerciseSummaries fallback. A schema 3-5
// session with an empty exercises map and only per-exercise summaries is still
// one legacy history sample (resolveExerciseLog's summaryCandidates block).
const summariesOnly = {
  id: "summaries-only",
  schemaVersion: 3,
  date: "2026-03-03T10:00:00.000Z",
  dayId: "day-1",
  dayName: "Day 1",
  sessionRpe: 8,
  readiness: { status: "green", averageScore: 4.2, isGood: true, isPoor: false },
  exercises: {},
  analytics: {
    exerciseSummaries: [
      {
        exerciseId: LIBRARY_BENCH,
        exerciseName: "Bench Press",
        exerciseRPE: 8,
        totalReps: 28,
        setCount: 4,
        averageWeight: 100,
      },
    ],
  },
};
const fromSummaries = planFor(dayA, strongCurrentA, [summariesOnly]);
assert.equal(fromSummaries.historySampleSize, 1, "summaries-only legacy session counts as one sample");
assert.ok(
  !fromSummaries.warnings.some((warning) => warning.includes("Older sessions without exercise ids")),
  "a resolvable summaries session is not skipped",
);
// ... and a summaries session for another Library id stays excluded.
const otherSummaries = {
  ...summariesOnly,
  id: "summaries-other",
  analytics: { exerciseSummaries: [{ ...summariesOnly.analytics.exerciseSummaries[0], exerciseId: "incline-bench" }] },
};
assert.equal(planFor(dayA, strongCurrentA, [otherSummaries]).historySampleSize, 0);

// --- new-C: a skipped exercise is insufficient_data and never a history sample
const skippedCurrent = modernSession({ id: "a-skipped", exercise: benchA, reps: [null, null, null, null] });
const skippedPlan = planFor(dayA, skippedCurrent, [strongPriorA]);
assert.equal(skippedPlan.decision, "insufficient_data");
assert.equal(skippedPlan.confidence, "low");
assert.equal(skippedPlan.recommendedWeight, 100, "planned weight is carried forward untouched");
assert.equal(skippedPlan.sets, 4);

const skippedPrior = modernSession({
  id: "a-skipped-prior",
  exercise: benchA,
  reps: [null, null, null, null],
  date: "2026-03-06T10:00:00.000Z",
});
const withSkippedInHistory = planFor(dayA, strongCurrentA, [skippedPrior, strongPriorA]);
assert.equal(withSkippedInHistory.historySampleSize, 1, "skipped session must not be a history sample");
assert.equal(withSkippedInHistory.confidence, "high", "strong prior still counts through the skipped one");

// --- F11: history samples are judged against their own planned snapshot ----
// The prior session was planned as 4x8-10 and hit every set at 10 -> strong
// under its own snapshot. Under the current 5-7 plan it would still read as
// "at top", so make the current plan stricter: 4x11-12.
const benchStrict = programExercise({
  programId: "program-a",
  overrides: { repsMin: 11, repsMax: 12, repsLabel: "11-12" },
});
const dayStrict = dayFor([benchStrict]);
const strictCurrent = modernSession({ id: "strict-current", exercise: benchStrict, reps: [12, 12, 12, 12], rpe: 8 });
const olderTargetsPrior = modernSession({
  id: "older-targets",
  exercise: benchStrict,
  reps: [10, 10, 10, 10],
  rpe: 8,
  date: "2026-03-03T10:00:00.000Z",
  snapshot: snapshotFor(benchStrict, { repsMin: 8, repsMax: 10, repsLabel: "8-10" }),
});
const ownSnapshot = planFor(dayStrict, strictCurrent, [olderTargetsPrior]);
assert.equal(ownSnapshot.historySampleSize, 1);
assert.equal(ownSnapshot.decision, "increase_load");
assert.equal(ownSnapshot.confidence, "high", "prior counts as strong against its own 8-10 snapshot");

// Fallback: without a snapshot the current plan is used (prior 10s are below 11).
const noSnapshotPrior = { ...olderTargetsPrior, id: "no-snapshot", plannedExercises: undefined };
const fallbackPlan = planFor(dayStrict, strictCurrent, [noSnapshotPrior]);
assert.equal(fallbackPlan.historySampleSize, 1);
assert.equal(fallbackPlan.confidence, "medium");

console.log("Progression H1 identity fixtures passed.");
