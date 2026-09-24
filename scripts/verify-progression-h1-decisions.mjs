import assert from "node:assert/strict";
import {
  generateNextPlan,
  getSessionAgeDays,
  HISTORY_RECENCY_DAYS,
  PAIN_FLAG_WARNING,
} from "../src/lib/progression.js";

// Phase H1 / Track A decisions: top-set working weight (new-A), history
// recency window (new-B), first-bad-session hold (new-D / F3) and reason
// lists that never contradict the final decision.

const baseCompound = {
  id: "bench",
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
};

const mediumCompound = {
  ...baseCompound,
  id: "hack-squat",
  name: "Hack Squat",
  muscleGroup: "quads",
  priority: "medium",
  progressionType: "hypertrophy",
  sets: 3,
  repsMin: 8,
  repsMax: 10,
  repsLabel: "8-10",
  recommendedWeight: 120,
};

const isolation = {
  id: "cable-curl",
  name: "Cable Curl",
  category: "isolation",
  equipment: "cable",
  muscleGroup: "biceps",
  priority: "medium",
  progressionType: "pump",
  sets: 3,
  repsMin: 10,
  repsMax: 12,
  repsLabel: "10-12",
  targetRPE: 8,
  restSeconds: 60,
  recommendedWeight: 25,
  loadType: "external",
};

function dayFor(exercise) {
  return { id: "day-1", name: "Test Day", type: "lifting", exercises: [exercise] };
}

function plannedExercise(exercise) {
  return {
    sets: exercise.sets,
    repsMin: exercise.repsMin,
    repsMax: exercise.repsMax,
    repsLabel: exercise.repsLabel,
    restSeconds: exercise.restSeconds,
    targetRPE: exercise.targetRPE,
    recommendedWeight: exercise.recommendedWeight,
  };
}

function sessionFor({
  id,
  exercise,
  reps,
  weight = exercise.recommendedWeight,
  weights = null,
  rpe = 8,
  sessionRpe = 8,
  date = "2026-03-10T10:00:00.000Z",
  readiness = { status: "green", averageScore: 4.2, isGood: true, isPoor: false },
  painFlag = false,
}) {
  return {
    id,
    date,
    dayId: "day-1",
    dayName: "Test Day",
    sessionRpe,
    readiness,
    plannedExercises: { exercises: { [exercise.id]: plannedExercise(exercise) } },
    exercises: {
      [exercise.id]: {
        programExerciseId: exercise.id,
        exerciseId: exercise.id,
        exerciseRPE: rpe,
        painFlag,
        sets: reps.map((rep, index) => ({ reps: rep, weight: weights ? weights[index] : weight, rpe })),
      },
    },
  };
}

function planFor(exercise, currentSession, previousSessions = []) {
  return generateNextPlan(dayFor(exercise), currentSession, previousSessions).exercises[0];
}

// Fragments that would contradict the decision they are listed under. These are
// the affirmative phrasings the engine uses for the *other* decisions; a
// negation such as "not an automatic reduction" is not a contradiction.
const CONTRADICTIONS = {
  hold: ["goes up", "Load increased", "creeps up", "nudges up", "time for more weight", "comes down a touch", "support a small load reduction"],
  increase_load: ["stays put", "Holding", "comes down a touch", "support a small load reduction", "on hold"],
  increase_reps: ["goes up", "Load increased", "comes down a touch", "support a small load reduction", "on hold"],
  reduce_load: ["hold", "Hold", "goes up", "Load increased", "stays put"],
  reduce_volume: ["goes up", "Load increased"],
};

function assertReasonsConsistent(plan, label) {
  const fragments = CONTRADICTIONS[plan.decision] ?? [];
  for (const reason of plan.reasons) {
    for (const fragment of fragments) {
      assert.ok(
        !reason.includes(fragment),
        `${label}: decision ${plan.decision} has contradictory reason "${reason}" (contains "${fragment}")`,
      );
    }
  }
  assert.ok(plan.reasons.length >= 1 && plan.reasons.length <= 2, `${label}: expected 1-2 reasons, got ${plan.reasons.length}`);
}

// --- new-A: working weight is the top set, not the mean -------------------
const topSetCurrent = planFor(
  baseCompound,
  sessionFor({ id: "current", exercise: baseCompound, reps: [7, 7, 7, 7], weights: [100, 100, 100, 90], rpe: 8 }),
  [sessionFor({ id: "prev", exercise: baseCompound, reps: [7, 7, 7, 7], date: "2026-03-03T10:00:00.000Z" })],
);
assert.equal(topSetCurrent.decision, "increase_load");
assert.equal(topSetCurrent.recommendedWeight, 102.5, "increase is applied to the top set (100), not the mean (97.5)");

const topSetHold = planFor(
  baseCompound,
  sessionFor({ id: "current", exercise: baseCompound, reps: [6, 6, 6, 6], weights: [100, 100, 100, 90], rpe: 8 }),
);
assert.equal(topSetHold.recommendedWeight, 100, "hold keeps the top set weight, not the mean");

// Previous-session comparison uses the top set too: previous top 100 vs
// current top 100 is comparable load even though the previous mean was lower.
const previousMixed = sessionFor({
  id: "prev-mixed",
  exercise: baseCompound,
  reps: [7, 7, 7, 7],
  weights: [100, 90, 90, 90],
  date: "2026-03-03T10:00:00.000Z",
});
const regressedVsTop = planFor(
  baseCompound,
  sessionFor({ id: "current", exercise: baseCompound, reps: [5, 5, 5, 5], weight: 100, rpe: 8 }),
  [previousMixed],
);
assert.equal(regressedVsTop.previousTotalReps, 28);
assert.equal(regressedVsTop.totalReps, 20);

// Bodyweight handling is unchanged: "BW" only counts as 0 kg for optionalExternal.
const weightedDips = { ...baseCompound, id: "dips", name: "Weighted Dips", equipment: "bodyweight", loadType: "optionalExternal", recommendedWeight: 10 };
const dipsPlan = planFor(
  weightedDips,
  sessionFor({ id: "current", exercise: weightedDips, reps: [7, 7, 7, 7], weights: ["BW", 10, 10, 10], rpe: 8 }),
  [sessionFor({ id: "prev", exercise: weightedDips, reps: [7, 7, 7, 7], weight: 10, date: "2026-03-03T10:00:00.000Z" })],
);
assert.equal(dipsPlan.recommendedWeight, 12.5);

// --- new-D / F3: first bad session holds, never reduces ------------------
const firstBadMain = planFor(
  baseCompound,
  sessionFor({ id: "current", exercise: baseCompound, reps: [4, 4, 4, 3], weight: 60, rpe: 9.5 }),
);
assert.equal(firstBadMain.decision, "hold", "first severe bad session on a main lift holds");
assert.equal(firstBadMain.recommendedWeight, 60);
assert.equal(firstBadMain.conservative, true);
assertReasonsConsistent(firstBadMain, "first bad main");

const firstBadMedium = planFor(
  mediumCompound,
  sessionFor({ id: "current", exercise: mediumCompound, reps: [6, 6, 6], rpe: 9.5 }),
);
assert.equal(firstBadMedium.decision, "hold", "first bad session on a medium compound holds");
assert.equal(firstBadMedium.recommendedWeight, 120);
assertReasonsConsistent(firstBadMedium, "first bad medium");

const firstBadIsolation = planFor(
  isolation,
  sessionFor({ id: "current", exercise: isolation, reps: [8, 8, 7], rpe: 9.5 }),
);
assert.equal(firstBadIsolation.decision, "hold");
assert.equal(firstBadIsolation.recommendedWeight, 25);

// A bad session after a good one is still only one bad session.
const badAfterGood = planFor(
  mediumCompound,
  sessionFor({ id: "current", exercise: mediumCompound, reps: [6, 6, 6], rpe: 9.5 }),
  [sessionFor({ id: "prev", exercise: mediumCompound, reps: [10, 10, 10], rpe: 8, date: "2026-03-03T10:00:00.000Z" })],
);
assert.equal(badAfterGood.decision, "hold");
assertReasonsConsistent(badAfterGood, "bad after good");

// Two consecutive qualifying bad sessions earn the reduction.
const twoBad = planFor(
  mediumCompound,
  sessionFor({ id: "current", exercise: mediumCompound, reps: [6, 6, 6], rpe: 9.5 }),
  [sessionFor({ id: "prev", exercise: mediumCompound, reps: [6, 6, 6], rpe: 9.5, date: "2026-03-03T10:00:00.000Z" })],
);
assert.equal(twoBad.decision, "reduce_load");
assert.ok(twoBad.recommendedWeight < 120);
assertReasonsConsistent(twoBad, "two bad");

// A bad session, a good one, then a bad one is not consecutive.
const notConsecutive = planFor(
  mediumCompound,
  sessionFor({ id: "current", exercise: mediumCompound, reps: [6, 6, 6], rpe: 9.5 }),
  [
    sessionFor({ id: "prev-good", exercise: mediumCompound, reps: [10, 10, 10], rpe: 8, date: "2026-03-06T10:00:00.000Z" }),
    sessionFor({ id: "prev-bad", exercise: mediumCompound, reps: [6, 6, 6], rpe: 9.5, date: "2026-03-03T10:00:00.000Z" }),
  ],
);
assert.equal(notConsecutive.decision, "hold");

// Pain handling stays independent of the first-bad-session rule.
const painFirstBad = planFor(
  baseCompound,
  sessionFor({ id: "current", exercise: baseCompound, reps: [4, 4, 4, 3], weight: 60, rpe: 9.5, painFlag: true }),
);
assert.equal(painFirstBad.decision, "hold");
assert.ok(painFirstBad.warnings.includes(PAIN_FLAG_WARNING));
assert.ok(painFirstBad.reasons.some((reason) => reason.includes("pain")));
assertReasonsConsistent(painFirstBad, "pain first bad");

// --- new-B: 42-day recency window ------------------------------------------
assert.equal(HISTORY_RECENCY_DAYS, 42);
assert.equal(getSessionAgeDays({ date: "2026-03-01T10:00:00.000Z" }, "2026-03-11T10:00:00.000Z"), 10);
assert.equal(getSessionAgeDays({ savedAt: "2026-03-01T10:00:00.000Z" }, new Date("2026-03-11T09:00:00.000Z")), 9);
assert.equal(getSessionAgeDays({ date: "2026-03-01T10:00:00.000Z" }, Date.parse("2026-03-01T12:00:00.000Z")), 0);
assert.equal(getSessionAgeDays({}, "2026-03-11T10:00:00.000Z"), null);
assert.equal(getSessionAgeDays({ date: "not a date" }, "2026-03-11T10:00:00.000Z"), null);

const currentDate = "2026-03-10T10:00:00.000Z";
const freshDate = "2026-01-30T10:00:00.000Z"; // 39 days earlier
const staleDate = "2026-01-20T10:00:00.000Z"; // 49 days earlier

const freshHistory = planFor(
  baseCompound,
  sessionFor({ id: "current", exercise: baseCompound, reps: [7, 7, 7, 7], date: currentDate }),
  [sessionFor({ id: "prev", exercise: baseCompound, reps: [7, 7, 7, 7], date: freshDate })],
);
assert.equal(freshHistory.historySampleSize, 1);
assert.equal(freshHistory.decision, "increase_load");
assert.equal(freshHistory.confidence, "high");

const longBreak = planFor(
  baseCompound,
  sessionFor({ id: "current", exercise: baseCompound, reps: [7, 7, 7, 7], date: currentDate }),
  [sessionFor({ id: "prev", exercise: baseCompound, reps: [7, 7, 7, 7], date: staleDate })],
);
assert.equal(longBreak.decision, "hold", "strong session after a long break holds");
assert.equal(longBreak.historySampleSize, 0, "stale sessions are not fresh history");
assert.equal(longBreak.conservative, true);
assert.ok(["low", "medium"].includes(longBreak.confidence), `confidence must be <= medium, got ${longBreak.confidence}`);
assert.ok(longBreak.reasons.some((reason) => /long break/i.test(reason)), "reason mentions the long break");
assert.equal(longBreak.recommendedWeight, 100);
assertReasonsConsistent(longBreak, "long break");

// Recency is relative to the session date, not the wall clock: the same
// sessions shifted far into the past still count as fresh history.
const oldButFresh = planFor(
  baseCompound,
  sessionFor({ id: "current", exercise: baseCompound, reps: [7, 7, 7, 7], date: "2020-03-10T10:00:00.000Z" }),
  [sessionFor({ id: "prev", exercise: baseCompound, reps: [7, 7, 7, 7], date: "2020-03-03T10:00:00.000Z" })],
);
assert.equal(oldButFresh.historySampleSize, 1);
assert.equal(oldButFresh.decision, "increase_load");

// Fresh sessions after the break are history; stale ones before it are not.
const mixedRecency = planFor(
  baseCompound,
  sessionFor({ id: "current", exercise: baseCompound, reps: [7, 7, 7, 7], date: currentDate }),
  [
    sessionFor({ id: "prev-fresh", exercise: baseCompound, reps: [7, 7, 7, 7], date: freshDate }),
    sessionFor({ id: "prev-stale", exercise: baseCompound, reps: [7, 7, 7, 7], date: staleDate }),
  ],
);
assert.equal(mixedRecency.historySampleSize, 1);
assert.equal(mixedRecency.decision, "increase_load");

// No history at all behaves as before (insufficient history, normal first-session rule).
const noHistory = planFor(
  baseCompound,
  sessionFor({ id: "current", exercise: baseCompound, reps: [7, 7, 7, 7], date: currentDate }),
);
assert.equal(noHistory.decision, "increase_load");
assert.equal(noHistory.historyTrend, "insufficient_history");
assert.ok(!noHistory.reasons.some((reason) => /long break/i.test(reason)));

// A stale session whose exercise was skipped does not count as "last logged".
const staleSkipped = { ...sessionFor({ id: "prev-skipped", exercise: baseCompound, reps: [], date: freshDate }) };
staleSkipped.exercises[baseCompound.id].sets = [{ reps: null, weight: null, rpe: null }];
staleSkipped.exercises[baseCompound.id].exerciseRPE = null;
const skippedThenStale = planFor(
  baseCompound,
  sessionFor({ id: "current", exercise: baseCompound, reps: [7, 7, 7, 7], date: currentDate }),
  [staleSkipped, sessionFor({ id: "prev-stale", exercise: baseCompound, reps: [7, 7, 7, 7], date: staleDate })],
);
assert.equal(skippedThenStale.decision, "hold");
assert.ok(skippedThenStale.reasons.some((reason) => /long break/i.test(reason)));

// --- Contradictory reasons: downgraded decisions rebuild their reasons -----
const downgraded = planFor(
  baseCompound,
  sessionFor({ id: "current", exercise: baseCompound, reps: [7, 7, 7, 7], rpe: 8, sessionRpe: 8, date: currentDate }),
  [
    sessionFor({ id: "prev-1", exercise: baseCompound, reps: [7, 7, 7, 7], rpe: 8, sessionRpe: 9.5, date: "2026-03-03T10:00:00.000Z" }),
    sessionFor({ id: "prev-2", exercise: baseCompound, reps: [7, 7, 7, 7], rpe: 8, sessionRpe: 9.2, date: "2026-02-24T10:00:00.000Z" }),
  ],
);
assert.equal(downgraded.decision, "hold", "repeated high session RPE downgrades the load increase");
assert.equal(downgraded.recommendedWeight, 100);
assertReasonsConsistent(downgraded, "history downgrade");

const lateralRaise = { ...isolation, id: "lateral-raises", name: "Lateral Raises", equipment: "dumbbell", recommendedWeight: 8, repsMin: 12, repsMax: 15, repsLabel: "12-15" };
const lateralDowngrade = planFor(
  lateralRaise,
  sessionFor({ id: "current", exercise: lateralRaise, reps: [15, 15, 15], rpe: 7.5 }),
);
assert.equal(lateralDowngrade.decision, "increase_reps");
assertReasonsConsistent(lateralDowngrade, "lateral raise downgrade");

const painDowngrade = planFor(
  baseCompound,
  sessionFor({ id: "current", exercise: baseCompound, reps: [7, 7, 7, 7], rpe: 8, painFlag: true }),
  [sessionFor({ id: "prev", exercise: baseCompound, reps: [7, 7, 7, 7], rpe: 8, date: "2026-03-03T10:00:00.000Z" })],
);
assert.equal(painDowngrade.decision, "hold");
assert.ok(painDowngrade.reasons.some((reason) => reason.includes("pain")));
assertReasonsConsistent(painDowngrade, "pain override");

const painIsolation = planFor(
  isolation,
  sessionFor({ id: "current", exercise: isolation, reps: [12, 12, 12], rpe: 7.5, painFlag: true }),
  [sessionFor({ id: "prev", exercise: isolation, reps: [12, 12, 12], rpe: 7.5, date: "2026-03-03T10:00:00.000Z" })],
);
assert.equal(painIsolation.decision, "hold");
assertReasonsConsistent(painIsolation, "pain isolation");

// Decisions that were not overridden keep consistent reasons as well.
for (const [label, plan] of Object.entries({ freshHistory, twoBad, topSetCurrent, firstBadIsolation, mixedRecency })) {
  assertReasonsConsistent(plan, label);
}

// --- Fixer round 1: a failed (0-rep) set is not the top set -----------------
// 130 kg x 0 is an attempt the athlete never completed a rep with; the working
// weight is the heaviest set that has reps, and the failed load never becomes
// the next prescription.
const failedAttempt = planFor(
  baseCompound,
  sessionFor({
    id: "current",
    exercise: baseCompound,
    reps: [0, 7, 7, 7],
    weights: [130, 100, 100, 100],
    rpe: 8.5,
    date: currentDate,
  }),
);
assert.equal(failedAttempt.recommendedWeight, 100, `working weight ignores the 0-rep set, got ${failedAttempt.recommendedWeight}`);
assert.notEqual(failedAttempt.decision, "increase_load", "a session with a failed set does not add load");
assertReasonsConsistent(failedAttempt, "failed attempt");

// The failed load does not feed the next session's comparison either: the
// following full session at 100 is compared against 100, not 130.
const afterFailedAttempt = planFor(
  baseCompound,
  sessionFor({ id: "current", exercise: baseCompound, reps: [7, 7, 7, 7], date: currentDate }),
  [
    sessionFor({
      id: "prev",
      exercise: baseCompound,
      reps: [0, 7, 7, 7],
      weights: [130, 100, 100, 100],
      rpe: 8.5,
      date: "2026-03-03T10:00:00.000Z",
    }),
  ],
);
assert.equal(afterFailedAttempt.decision, "increase_load");
assert.equal(afterFailedAttempt.recommendedWeight, 102.5);

// All sets failed: no top set exists, the planned weight is the working weight.
const allFailed = planFor(
  baseCompound,
  sessionFor({ id: "current", exercise: baseCompound, reps: [0, 0, 0, 0], weight: 130, rpe: 10, date: currentDate }),
);
assert.equal(allFailed.recommendedWeight, 100, "planned weight used when no set has reps");
assert.notEqual(allFailed.decision, "increase_load");

// --- Fixer round 1: pain + long break keeps the long-break explanation --------
// Pain takes the single context sentence (decision new-D stays independent),
// so the new-B "long break" explanation moves to the warnings instead of
// disappearing.
const painAfterLongBreak = planFor(
  baseCompound,
  sessionFor({ id: "current", exercise: baseCompound, reps: [7, 7, 7, 7], rpe: 8, date: currentDate, painFlag: true }),
  [sessionFor({ id: "prev", exercise: baseCompound, reps: [7, 7, 7, 7], date: staleDate })],
);
assert.equal(painAfterLongBreak.decision, "hold");
assert.equal(painAfterLongBreak.recommendedWeight, 100);
assert.equal(painAfterLongBreak.historySampleSize, 0);
assert.equal(painAfterLongBreak.conservative, true);
assert.ok(["low", "medium"].includes(painAfterLongBreak.confidence));
assert.ok(painAfterLongBreak.reasons.length >= 1 && painAfterLongBreak.reasons.length <= 2, "one primary reason plus at most one context sentence");
assert.ok(painAfterLongBreak.reasons.some((reason) => reason.includes("pain")), "pain stays the context sentence");
assert.ok(painAfterLongBreak.warnings.includes(PAIN_FLAG_WARNING));
assert.ok(
  [...painAfterLongBreak.reasons, ...painAfterLongBreak.warnings].some((text) => /long break/i.test(text)),
  "the long-break explanation is still returned (as a warning)",
);
assertReasonsConsistent(painAfterLongBreak, "pain after long break");

// Pain without a long break adds no long-break text anywhere.
const painFreshHistory = planFor(
  baseCompound,
  sessionFor({ id: "current", exercise: baseCompound, reps: [7, 7, 7, 7], rpe: 8, date: currentDate, painFlag: true }),
  [sessionFor({ id: "prev", exercise: baseCompound, reps: [7, 7, 7, 7], date: freshDate })],
);
assert.ok(![...painFreshHistory.reasons, ...painFreshHistory.warnings].some((text) => /long break/i.test(text)));

console.log("Progression H1 decision fixtures passed.");
