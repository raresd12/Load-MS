// Phase H5 Track B: src/lib/adherence.js (decision H5-9).
// Session-plan adherence is measured against the session's OWN
// plannedExercises snapshot, never the current plan; partial logging is
// exposed as a measure (status complete / partial / minimal / unplanned),
// the engine decides its evidence weight. Also pins the hold / override /
// deload reader used by the recap and the weekly review.
import assert from "node:assert/strict";

const {
  ADHERENCE_THRESHOLDS,
  computeAdherenceTrend,
  computeSessionAdherence,
  countLoggedSetsByExercise,
  describeSessionAdherence,
  getSessionCoachStatus,
  isPartialSession,
} = await import("../src/lib/adherence.js");

const exercises = [
  { id: "pe-bench", programExerciseId: "pe-bench", name: "Bench Press" },
  { id: "pe-row", programExerciseId: "pe-row", name: "Row" },
  { id: "pe-chin", programExerciseId: "pe-chin", name: "Chin-up" },
];

function set(programExerciseId, setNumber, reps, weight = 60, rpe = 8) {
  return { programExerciseId, exerciseId: `lib-${programExerciseId}`, setNumber, actualReps: reps, actualWeight: weight, actualRPE: rpe, completed: reps !== null };
}

// The snapshot the session was logged against: 4 + 4 + 4 = 12 planned sets.
const snapshot = {
  "pe-bench": { sets: 4, repsMin: 6, repsMax: 8, recommendedWeight: 60, prescriptionSource: "progression" },
  "pe-row": { sets: 4, repsMin: 8, repsMax: 10, recommendedWeight: 40, prescriptionSource: "target" },
  "pe-chin": { sets: 4, repsMin: 5, repsMax: 10, recommendedWeight: null, prescriptionSource: "target" },
};

assert.deepEqual(ADHERENCE_THRESHOLDS, { complete: 0.9, partial: 0.5 });

// ---------------------------------------------------------------------------
// Partial session: 4 of 12 planned sets, one exercise skipped, one partial
// ---------------------------------------------------------------------------
{
  const session = {
    id: "s-partial",
    date: "2026-09-30T18:00:00+03:00",
    plannedExercises: snapshot,
    workoutSets: [
      set("pe-bench", 1, 8), set("pe-bench", 2, 8), set("pe-bench", 3, 7),
      set("pe-bench", 4, null, null, null),
      set("pe-row", 1, 10, 40), set("pe-row", 2, null, null, null),
      set("pe-chin", 1, null, null, null),
    ],
  };
  const adherence = computeSessionAdherence({ session, exercises });
  assert.equal(adherence.plannedSets, 12);
  assert.equal(adherence.completedSets, 4);
  assert.equal(adherence.countedSets, 4);
  assert.equal(adherence.plannedExercises, 3);
  assert.equal(adherence.loggedExercises, 2);
  assert.deepEqual(adherence.skippedExercises, [{ programExerciseId: "pe-chin", name: "Chin-up" }]);
  assert.deepEqual(adherence.partialExercises, [
    { programExerciseId: "pe-bench", name: "Bench Press", plannedSets: 4, completedSets: 3 },
    { programExerciseId: "pe-row", name: "Row", plannedSets: 4, completedSets: 1 },
  ]);
  assert.equal(adherence.unplannedExercises, 0);
  assert.ok(Math.abs(adherence.ratio - 4 / 12) < 1e-9);
  assert.equal(adherence.status, "minimal", "4 of 12 is under 0.5");
  assert.equal(isPartialSession(adherence), true);
  assert.equal(
    describeSessionAdherence(adherence, { keptTargets: true }),
    "Partial session (4 of 12 planned sets): coach kept targets. Skipped: Chin-up.",
  );
  assert.equal(
    describeSessionAdherence(adherence, { keptTargets: false }),
    "Partial session (4 of 12 planned sets): coach adjusted the logged exercises only. Skipped: Chin-up.",
  );

  // The snapshot decides, never the current plan: the same session against a
  // plan that today asks for 2 sets per exercise would be "complete", and
  // the function ignores such a plan because it only reads the session.
  const shrunk = computeSessionAdherence({ session: { ...session, plannedExercises: undefined }, plannedExercises: { "pe-bench": { sets: 2 }, "pe-row": { sets: 1 }, "pe-chin": { sets: 0 } }, exercises });
  assert.equal(shrunk.status, "complete", "an explicit snapshot argument is honoured (it is the caller's copy of the session snapshot)");
  assert.equal(computeSessionAdherence({ session, exercises }).status, "minimal", "the stored snapshot wins when none is passed");
}

// Partial (0.5-0.9), complete (>= 0.9), boundaries.
{
  const base = { id: "b", date: "2026-09-30T18:00:00+03:00", plannedExercises: snapshot };
  const sets = (counts) =>
    Object.entries(counts).flatMap(([id, count]) => Array.from({ length: count }, (_, index) => set(id, index + 1, 8)));

  const half = computeSessionAdherence({ session: { ...base, workoutSets: sets({ "pe-bench": 4, "pe-row": 2, "pe-chin": 0 }) }, exercises });
  assert.equal(half.ratio, 0.5);
  assert.equal(half.status, "partial", "0.5 is partial, not minimal");
  assert.equal(describeSessionAdherence(half), "Partial session (6 of 12 planned sets): coach kept targets. Skipped: Chin-up.");

  const eleven = computeSessionAdherence({ session: { ...base, workoutSets: sets({ "pe-bench": 4, "pe-row": 4, "pe-chin": 3 }) }, exercises });
  assert.ok(Math.abs(eleven.ratio - 11 / 12) < 1e-9);
  assert.equal(eleven.status, "complete", "11 of 12 (0.917) is complete");
  assert.equal(describeSessionAdherence(eleven), "Full session: 11 of 12 planned sets.");
  assert.equal(isPartialSession(eleven), false);

  // Extra sets on one exercise never cover a skipped one.
  const lopsided = computeSessionAdherence({ session: { ...base, workoutSets: sets({ "pe-bench": 8, "pe-row": 4, "pe-chin": 0 }) }, exercises });
  assert.equal(lopsided.completedSets, 12, "raw logged count");
  assert.equal(lopsided.countedSets, 8, "capped per exercise");
  assert.ok(Math.abs(lopsided.ratio - 8 / 12) < 1e-9);
  assert.equal(lopsided.status, "partial");

  // A 0-rep attempt and an untouched slot are not logged sets.
  const attempts = computeSessionAdherence({ session: { ...base, workoutSets: [set("pe-bench", 1, 0, 100, 10), set("pe-bench", 2, null, null, null)] }, exercises });
  assert.equal(attempts.completedSets, 0);
  assert.deepEqual(attempts.skippedExercises.map((exercise) => exercise.name), ["Bench Press", "Row", "Chin-up"]);
  assert.equal(attempts.status, "minimal");

  // Timed sets count by seconds (Track A's set shape) when reps are absent.
  const timed = computeSessionAdherence({
    session: { ...base, plannedExercises: { "pe-plank": { sets: 3 } }, workoutSets: [{ programExerciseId: "pe-plank", setNumber: 1, seconds: 45, actualWeight: "BW", completed: true }, { programExerciseId: "pe-plank", setNumber: 2, seconds: 40, actualWeight: "BW", completed: true }] },
  });
  assert.equal(timed.countedSets, 2);
  assert.equal(timed.status, "partial");
}

// Unplanned: no snapshot, or a recovery day with nothing planned.
{
  const noSnapshot = computeSessionAdherence({ session: { id: "legacy", workoutSets: [set("pe-bench", 1, 8), set("pe-bench", 2, 8)] } });
  assert.equal(noSnapshot.status, "unplanned");
  assert.equal(noSnapshot.ratio, null);
  assert.equal(noSnapshot.plannedSets, 0);
  assert.equal(noSnapshot.completedSets, 2, "logged sets are still counted");
  assert.equal(noSnapshot.loggedExercises, 1);
  assert.equal(isPartialSession(noSnapshot), false, "unplanned is not partial");
  assert.equal(describeSessionAdherence(noSnapshot), "Unplanned session: no plan snapshot to compare against.");

  const recovery = computeSessionAdherence({ session: { id: "rec", plannedExercises: {}, workoutSets: [] } });
  assert.equal(recovery.status, "unplanned");
  assert.equal(describeSessionAdherence(null), "Unplanned session: no plan snapshot to compare against.");
  assert.equal(computeSessionAdherence({ session: null }).status, "unplanned");
  assert.equal(computeSessionAdherence().status, "unplanned");
}

// Legacy session shape (exercises map, no workoutSets) and names from the log.
{
  const legacy = {
    id: "legacy-map",
    plannedExercises: { "pe-bench": { sets: 3 }, "pe-row": { sets: 3 } },
    exercises: {
      "pe-bench": { name: "Bench (log)", sets: [{ reps: 8, weight: 60 }, { reps: 8, weight: 60 }, { reps: null, weight: null }] },
      "pe-row": { sets: [] },
    },
  };
  const counts = countLoggedSetsByExercise(legacy);
  assert.deepEqual([...counts.entries()], [["pe-bench", 2]]);
  const adherence = computeSessionAdherence({ session: legacy });
  assert.equal(adherence.countedSets, 2);
  assert.equal(adherence.plannedSets, 6);
  assert.deepEqual(adherence.skippedExercises, [{ programExerciseId: "pe-row", name: "pe-row" }], "no name known: the id is shown");
  assert.deepEqual(adherence.partialExercises[0].name, "Bench (log)", "the legacy log's own name is used");
  assert.equal(adherence.status, "minimal");

  const legacyArray = { exercises: [{ programExerciseId: "pe-bench", sets: [{ reps: 5 }] }, { id: "pe-row", sets: [{ reps: "6" }] }] };
  assert.deepEqual([...countLoggedSetsByExercise(legacyArray).entries()], [["pe-bench", 1], ["pe-row", 1]]);
}

// ---------------------------------------------------------------------------
// Trend over a rolling window (injected clock; sessions newest first)
// ---------------------------------------------------------------------------
{
  const now = Date.parse("2026-09-30T12:00:00+03:00");
  const dayMs = 24 * 60 * 60 * 1000;
  const at = (daysAgo) => new Date(now - daysAgo * dayMs).toISOString();
  const full = (id, daysAgo) => ({ id, date: at(daysAgo), plannedExercises: { "pe-bench": { sets: 2, name: "Bench Press" } }, workoutSets: [set("pe-bench", 1, 8), set("pe-bench", 2, 8)] });
  const half = (id, daysAgo) => ({ id, date: at(daysAgo), plannedExercises: { "pe-bench": { sets: 2, name: "Bench Press" }, "pe-row": { sets: 2, name: "Row" } }, workoutSets: [set("pe-bench", 1, 8), set("pe-bench", 2, 8)] });
  const sessions = [full("a", 1), half("b", 3), { id: "c", date: at(5), workoutSets: [set("pe-bench", 1, 8)] }, half("d", 20), full("old", 40)];

  const trend = computeAdherenceTrend(sessions, 28, now);
  assert.equal(trend.days, 28);
  assert.equal(trend.sessionCount, 4, "the 40-day-old session is outside the window");
  assert.equal(trend.plannedSessionCount, 3, "the session without a snapshot has no ratio");
  assert.ok(Math.abs(trend.averageRatio - (1 + 0.5 + 0.5) / 3) < 1e-9);
  assert.deepEqual(trend.statusCounts, { complete: 1, partial: 2, minimal: 0, unplanned: 1 });
  assert.deepEqual(trend.mostSkipped, [{ programExerciseId: "pe-row", name: "Row", count: 2 }]);

  const week = computeAdherenceTrend(sessions, 7, now);
  assert.equal(week.sessionCount, 3);
  assert.equal(week.plannedSessionCount, 2);
  assert.equal(week.averageRatio, 0.75);

  const empty = computeAdherenceTrend([], 28, now);
  assert.equal(empty.averageRatio, null);
  assert.equal(empty.sessionCount, 0);
  assert.deepEqual(computeAdherenceTrend(undefined, 28, now).statusCounts, { complete: 0, partial: 0, minimal: 0, unplanned: 0 });

  // A future-dated or unparsable session is ignored.
  assert.equal(computeAdherenceTrend([{ id: "f", date: at(-1), plannedExercises: {} }, { id: "g", date: "nope" }], 28, now).sessionCount, 0);
}

// ---------------------------------------------------------------------------
// Hold / override / deload reader (wording hooks for the recap and the week)
// ---------------------------------------------------------------------------
{
  const none = getSessionCoachStatus({ plannedExercises: snapshot }, { status: "generated", exercises: [{ exerciseId: "pe-bench", decision: "hold", reasons: ["Reps were below target, so hold the load."] }] });
  assert.deepEqual(none, { held: [], overridden: [], deload: false, sources: ["progression", "target", "generated", "Reps were below target, so hold the load."] });
  assert.equal(none.held.length, 0, "the engine's own hold decision / reason is not a user hold");

  // The engine's frozen plan entry for a held exercise (Track A, H5-6).
  const heldPlan = { status: "generated", exercises: [{ exerciseId: "pe-bench", decision: "hold", reasons: ["Held by you", "Note: elbow"], held: true, overrideMode: "hold" }, { exerciseId: "pe-row", decision: "increase_load", reasons: ["Load goes up."] }] };
  const held = getSessionCoachStatus({ plannedExercises: snapshot }, heldPlan);
  assert.deepEqual(held.held, ["pe-bench"]);
  assert.deepEqual(held.overridden, []);
  assert.equal(held.deload, false);

  // What a SAVED held session stores (H5-37): the resolver's source value of
  // a hold is "override" too, so the bare value is not a manual-override
  // marker; the exercise is held, never also overridden.
  const storedHold = getSessionCoachStatus({ plannedExercises: { ...snapshot, "pe-bench": { ...snapshot["pe-bench"], prescriptionSource: "override", held: true, overrideMode: "hold" } } });
  assert.deepEqual(storedHold.held, ["pe-bench"]);
  assert.deepEqual(storedHold.overridden, [], "a hold is not reported as a manual override as well");
  assert.deepEqual(getSessionCoachStatus({ plannedExercises: { "pe-bench": { prescriptionSource: "override" } } }).overridden, [], "the bare source value names no mode");
  assert.deepEqual(getSessionCoachStatus({ plannedExercises: { "pe-bench": { prescriptionSource: "override", overrideMode: "manual" } } }).overridden, ["pe-bench"]);
  // The engine's reason prose is never a user hold: core_control's load
  // increase says "Control held all the way ...".
  const controlHeld = getSessionCoachStatus({ plannedExercises: snapshot }, { status: "generated", exercises: [{ exerciseId: "pe-bench", decision: "increase_load", reasons: ["Control held all the way to the top of the range, so the difficulty nudges up."] }] });
  assert.deepEqual(controlHeld.held, []);
  assert.deepEqual(controlHeld.overridden, []);

  // Manual override on the snapshot's source label and on the plan flag.
  const overridden = getSessionCoachStatus(
    { plannedExercises: { ...snapshot, "pe-row": { ...snapshot["pe-row"], prescriptionSource: "override", sourceLabel: "Manual override (2 sessions left)" } } },
    { status: "generated", exercises: [{ exerciseId: "pe-chin", overrideMode: "manual" }] },
  );
  assert.deepEqual(overridden.overridden.sort(), ["pe-chin", "pe-row"]);
  assert.deepEqual(overridden.held, []);

  // "On hold" wording (describeOverride) and a deload session (Track A, H5-7).
  const onHold = getSessionCoachStatus({ plannedExercises: { "pe-bench": { sets: 4, sourceLabel: "On hold (1 session left)" } } });
  assert.deepEqual(onHold.held, ["pe-bench"]);
  const deload = getSessionCoachStatus({ plannedExercises: snapshot }, { status: "generated", exercises: [{ exerciseId: "pe-bench", reasons: ["Logged during a deload, so this session is not used as progression evidence."], deloadSession: true, deloadLevel: "deload" }] });
  assert.equal(deload.deload, true);
  assert.deepEqual(deload.held, []);
  assert.equal(getSessionCoachStatus({ planStatus: "deload" }).deload, true);
  assert.deepEqual(getSessionCoachStatus(null), { held: [], overridden: [], deload: false, sources: [] });
  assert.deepEqual(getSessionCoachStatus({ plannedExercises: { "pe-bench": { sets: 3, prescriptionSource: "hold" } } }).held, ["pe-bench"], "a bare 'hold' source value is a user hold");
}

// No medical claims in any produced string.
{
  const strings = [
    describeSessionAdherence(computeSessionAdherence({ session: { plannedExercises: snapshot, workoutSets: [set("pe-bench", 1, 8)] }, exercises })),
    describeSessionAdherence(null),
  ];
  strings.forEach((text) => assert.doesNotMatch(text, /injury|overtraining syndrome|diagnos/i, text));
}

console.log("Adherence verification passed.");
