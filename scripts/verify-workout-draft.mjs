// Fixer round 1: Workout Log draft helpers (src/lib/workoutDraft.js).
// - A workout that crosses midnight keeps its draft: resolveWorkoutDraftKey
//   resumes the previous date's in-progress draft while it has logged data
//   and was touched recently, instead of switching to a blank draft.
// - getPlanSlotSignature changes when an exercise's set count changes even if
//   the plan's generatedAt does not (target edit on a generated day plan).
import assert from "node:assert/strict";

const {
  DRAFT_RESUME_WINDOW_MS,
  draftHasLoggedData,
  getPlanSlotSignature,
  getWorkoutDraftKey,
  resolveWorkoutDraftKey,
} = await import("../src/lib/workoutDraft.js");

function blankDraft() {
  return {
    exercises: {
      bench: { notes: "", painFlag: false, sets: [{ reps: "", weight: "", rpe: "" }, { reps: "", weight: "", rpe: "" }] },
    },
    wellness: { sleep: 3 },
    recoveryActivities: { walk: false },
    recoveryNotes: "",
    sessionRpe: "",
    sessionNotes: "",
  };
}

function loggedDraft() {
  const draft = blankDraft();
  draft.exercises.bench.sets[0] = { reps: 5, weight: 70, rpe: 8 };
  return draft;
}

// ---------------------------------------------------------------------------
// draftHasLoggedData
// ---------------------------------------------------------------------------
assert.equal(draftHasLoggedData(blankDraft()), false);
assert.equal(draftHasLoggedData(null), false);
assert.equal(draftHasLoggedData(loggedDraft()), true);
{
  const weightOnly = blankDraft();
  weightOnly.exercises.bench.sets[1].weight = "70";
  assert.equal(draftHasLoggedData(weightOnly), true, "a typed kg value counts");
  const rpeOnly = blankDraft();
  rpeOnly.sessionRpe = 8;
  assert.equal(draftHasLoggedData(rpeOnly), true);
  const pain = blankDraft();
  pain.exercises.bench.painFlag = true;
  assert.equal(draftHasLoggedData(pain), true);
  const notes = blankDraft();
  notes.exercises.bench.notes = "  felt heavy ";
  assert.equal(draftHasLoggedData(notes), true);
  const recovery = blankDraft();
  recovery.recoveryActivities.walk = true;
  assert.equal(draftHasLoggedData(recovery), true);
  const zeroReps = blankDraft();
  zeroReps.exercises.bench.sets[0].reps = 0;
  assert.equal(draftHasLoggedData(zeroReps), true, "0 reps is logged data");
}

// ---------------------------------------------------------------------------
// resolveWorkoutDraftKey: midnight rollover
// ---------------------------------------------------------------------------
const programId = "default-athletic-bodybuilding-rpe";
const dayId = "day-1";
const yesterdayKey = getWorkoutDraftKey(programId, dayId, "2026-09-19");
const todayKey = getWorkoutDraftKey(programId, dayId, "2026-09-20");
assert.equal(yesterdayKey, `${programId}::${dayId}::2026-09-19`);
assert.equal(getWorkoutDraftKey(null, null, "2026-09-20"), "no-program::no-day::2026-09-20");

const midnight = Date.parse("2026-09-20T00:00:00.000Z");

function entry(overrides = {}) {
  return {
    schemaVersion: 1,
    key: yesterdayKey,
    status: "in_progress",
    programId,
    dayId,
    date: "2026-09-19",
    updatedAt: "2026-09-19T23:50:00.000Z",
    draft: loggedDraft(),
    ...overrides,
  };
}

// The repro: a set logged at 23:50, the clock crosses midnight, the draft
// under yesterday's key is resumed instead of a blank draft for today.
{
  const resolved = resolveWorkoutDraftKey({
    workoutDrafts: { [yesterdayKey]: entry() },
    programId,
    dayId,
    todayDateKey: "2026-09-20",
    now: midnight + 5 * 60 * 1000,
  });
  assert.equal(resolved.key, yesterdayKey, "in-progress draft with data is kept across midnight");
  assert.equal(resolved.dateKey, "2026-09-19");
  assert.equal(resolved.resumedFromDateKey, "2026-09-19");
}

// No draft at all: today's key.
assert.deepEqual(
  resolveWorkoutDraftKey({ workoutDrafts: {}, programId, dayId, todayDateKey: "2026-09-20", now: midnight }),
  { key: todayKey, dateKey: "2026-09-20", resumedFromDateKey: null },
);
assert.equal(
  resolveWorkoutDraftKey({ workoutDrafts: null, programId, dayId, todayDateKey: "2026-09-20", now: midnight }).key,
  todayKey,
);

// Yesterday's draft is blank (nothing was logged): roll over to today.
assert.equal(
  resolveWorkoutDraftKey({
    workoutDrafts: { [yesterdayKey]: entry({ draft: blankDraft() }) },
    programId,
    dayId,
    todayDateKey: "2026-09-20",
    now: midnight,
  }).key,
  todayKey,
);

// Yesterday's draft was completed (workout saved): today's key.
assert.equal(
  resolveWorkoutDraftKey({
    workoutDrafts: { [yesterdayKey]: entry({ status: "completed" }) },
    programId,
    dayId,
    todayDateKey: "2026-09-20",
    now: midnight,
  }).key,
  todayKey,
);

// App left open overnight and reopened the next morning: still resumed.
assert.equal(
  resolveWorkoutDraftKey({
    workoutDrafts: { [yesterdayKey]: entry({ updatedAt: "2026-09-19T22:00:00.000Z" }) },
    programId,
    dayId,
    todayDateKey: "2026-09-20",
    now: midnight + 9 * 60 * 60 * 1000,
  }).key,
  yesterdayKey,
);

// Stale draft (last touched longer ago than the resume window): today's key,
// the old draft stays stored under its own key.
assert.equal(
  resolveWorkoutDraftKey({
    workoutDrafts: { [yesterdayKey]: entry({ updatedAt: "2026-09-18T08:00:00.000Z" }) },
    programId,
    dayId,
    todayDateKey: "2026-09-20",
    now: midnight,
  }).key,
  todayKey,
);
assert.equal(DRAFT_RESUME_WINDOW_MS, 36 * 60 * 60 * 1000);

// Today's draft already has data: it wins over yesterday's.
{
  const resolved = resolveWorkoutDraftKey({
    workoutDrafts: {
      [yesterdayKey]: entry(),
      [todayKey]: entry({ key: todayKey, date: "2026-09-20", updatedAt: "2026-09-20T00:10:00.000Z" }),
    },
    programId,
    dayId,
    todayDateKey: "2026-09-20",
    now: midnight + 15 * 60 * 1000,
  });
  assert.equal(resolved.key, todayKey);
  assert.equal(resolved.resumedFromDateKey, null);
}

// Another day / program / a future-dated entry never gets resumed.
{
  const otherDayKey = getWorkoutDraftKey(programId, "day-2", "2026-09-19");
  const otherProgramKey = getWorkoutDraftKey("program-copy", dayId, "2026-09-19");
  const tomorrowKey = getWorkoutDraftKey(programId, dayId, "2026-09-21");
  const resolved = resolveWorkoutDraftKey({
    workoutDrafts: {
      [otherDayKey]: entry({ key: otherDayKey, dayId: "day-2" }),
      [otherProgramKey]: entry({ key: otherProgramKey, programId: "program-copy" }),
      [tomorrowKey]: entry({ key: tomorrowKey, date: "2026-09-21", updatedAt: "2026-09-21T00:00:00.000Z" }),
    },
    programId,
    dayId,
    todayDateKey: "2026-09-20",
    now: midnight,
  });
  assert.equal(resolved.key, todayKey);
}

// Two earlier drafts: the most recently updated one is resumed.
{
  const olderKey = getWorkoutDraftKey(programId, dayId, "2026-09-18");
  const resolved = resolveWorkoutDraftKey({
    workoutDrafts: {
      [olderKey]: entry({ key: olderKey, date: "2026-09-18", updatedAt: "2026-09-19T23:55:00.000Z" }),
      [yesterdayKey]: entry(),
    },
    programId,
    dayId,
    todayDateKey: "2026-09-20",
    now: midnight,
  });
  assert.equal(resolved.key, olderKey);
}

// Malformed entries are ignored.
assert.equal(
  resolveWorkoutDraftKey({
    workoutDrafts: { [yesterdayKey]: entry({ updatedAt: "not a date" }), junk: null, other: "x" },
    programId,
    dayId,
    todayDateKey: "2026-09-20",
    now: midnight,
  }).key,
  todayKey,
);

// ---------------------------------------------------------------------------
// getPlanSlotSignature: a target edit that changes the set count of one
// exercise changes the signature although generatedAt is untouched.
// ---------------------------------------------------------------------------
{
  const plan = {
    generatedAt: "2026-09-19T10:00:00.000Z",
    status: "generated",
    exercises: [
      { exerciseId: "pe-bench", sets: 4 },
      { exerciseId: "pe-row", sets: 3 },
    ],
  };
  const edited = {
    ...plan,
    exercises: [
      { exerciseId: "pe-bench", sets: 3 },
      { exerciseId: "pe-row", sets: 3 },
    ],
  };
  assert.equal(plan.generatedAt, edited.generatedAt);
  assert.equal(getPlanSlotSignature(plan), "pe-bench:4|pe-row:3");
  assert.notEqual(getPlanSlotSignature(plan), getPlanSlotSignature(edited), "set count change is visible");
  assert.equal(
    getPlanSlotSignature({ ...plan, exercises: plan.exercises.map((exercise) => ({ ...exercise, recommendedWeight: 99 })) }),
    getPlanSlotSignature(plan),
    "weight-only changes do not force a draft rebuild",
  );
  assert.equal(getPlanSlotSignature(null), "");
  assert.equal(getPlanSlotSignature({ exercises: [{ sets: 2 }] }), ":2");
}

console.log("verify-workout-draft: all assertions passed");
