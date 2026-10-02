// H4 fix round 3, decision H4-14 (repeat session): saving the same program
// day twice, on the same date, through the exact path App.jsx `saveWorkout`
// uses (buildResolvedPlan -> createDraft -> buildWorkoutSaveBundle ->
// persistWorkoutSave) gives
// - two sessions with distinct ids, the second prepended, the first unchanged;
// - a second plannedExercises snapshot that carries the progression earned by
//   the first session (source "progression");
// - nextPlans[dayId] and the program-progressions rows pointing at the SECOND
//   session after the second save;
// - the workout draft key removed by each save, other drafts untouched;
// - one checked batch per save; a failed write leaves storage as it was.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

class MemoryLocalStorage {
  constructor() {
    this.store = new Map();
    this.failKey = null;
  }

  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  setItem(key, value) {
    if (this.failKey === key) {
      throw new DOMException(`Simulated write failure for ${key}`, "QuotaExceededError");
    }

    this.store.set(key, String(value));
  }

  removeItem(key) {
    this.store.delete(key);
  }
}

const storage = new MemoryLocalStorage();
globalThis.window = { localStorage: storage };
console.warn = () => {};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const {
  getActiveProgram,
  getProgramDayViewModels,
  getProgramState,
  persistWorkoutSave,
  seedDefaultProgramIfNeeded,
} = await import("../src/lib/programStorage.js");
const { getPlanForDay } = await import("../src/lib/progression.js");
const { buildResolvedPlan } = await import("../src/lib/sessionEdit.js");
const { createDraft, getPlanExercise, validateDraft } = await import("../src/lib/sessionNormalize.js");
const { readStorage, STORAGE_KEYS } = await import("../src/lib/storage.js");
const getProgramProgressions = () => readStorage(STORAGE_KEYS.programProgressions, []);
const { getWorkoutDraftKey } = await import("../src/lib/workoutDraft.js");
const { buildWorkoutSaveBundle, WORKOUT_SESSION_SCHEMA_VERSION } = await import("../src/lib/workoutSave.js");

seedDefaultProgramIfNeeded();
const program = getActiveProgram();
assert.ok(program?.id, "a seeded active program");
const programDays = getProgramDayViewModels(program.id);
const day = programDays.find((candidate) => candidate.type !== "recovery" && candidate.exercises.length > 0);
assert.ok(day, "a training day");
const otherDay = programDays.find((candidate) => candidate.id !== day.id);

// The exercise whose progression the fixture follows: external load in kg
// with a rep range. The default program has no target weights, so the first
// session is logged at FIRST_WEIGHT and the engine works from there.
const FIRST_WEIGHT = 60;
const tracked = day.exercises.find(
  (exercise) => exercise.loadType === "external" && Number.isFinite(exercise.repsMax),
);
assert.ok(tracked, "the day has an external-load exercise with a rep range");

const todayDateKey = "2026-09-29";
const draftKey = getWorkoutDraftKey(program.id, day.id, todayDateKey);
const otherDraftKey = getWorkoutDraftKey(program.id, otherDay.id, todayDateKey);
const readinessEntry = {
  date: todayDateKey,
  wellness: { sleep: 4, soreness: 4, fatigue: 4, mood: 4, stress: 4 },
};

// What App.jsx holds in React state, read back from storage after each save.
function readAppState() {
  return {
    sessions: readStorage(STORAGE_KEYS.sessions, []),
    nextPlans: readStorage(STORAGE_KEYS.nextPlans, {}),
    workoutDrafts: readStorage(STORAGE_KEYS.workoutDrafts, {}),
  };
}

// App.jsx: basePlan -> activePlan (decision 19.4-2).
function resolveActivePlan(nextPlans) {
  return buildResolvedPlan(program.id, day, getPlanForDay(day, nextPlans[day.id]));
}

// Every set of every exercise logged at the top of the rep range, at the
// prescribed weight, two RPE points under the target: an easy session.
function fillDraft(plan, sessions) {
  const draft = createDraft(day, plan, sessions);

  day.exercises.forEach((exercise) => {
    const planExercise = getPlanExercise(plan, exercise.id);
    const planned = planExercise.recommendedWeight;
    const weight =
      typeof planned === "number" ? String(planned) : exercise.loadType === "external" ? String(FIRST_WEIGHT) : "BW";
    draft.exercises[exercise.id].sets = draft.exercises[exercise.id].sets.map(() => ({
      reps: String(planExercise.repsMax ?? planExercise.repsMin ?? 8),
      weight,
      rpe: String(Math.max(1, Number(planExercise.targetRPE ?? 8) - 2)),
    }));
  });
  draft.sessionRpe = "7";
  draft.sessionNotes = "  repeat fixture  ";

  return draft;
}

function save({ id, now }) {
  const state = readAppState();
  const plan = resolveActivePlan(state.nextPlans);
  const draft = fillDraft(plan, state.sessions);
  assert.deepEqual(validateDraft(day, draft), [], "the draft is valid");
  // The in-progress draft is stored under the draft key, next to another day's draft.
  const workoutDrafts = {
    ...state.workoutDrafts,
    [draftKey]: { key: draftKey, programId: program.id, dayId: day.id, dateKey: todayDateKey, draft },
    [otherDraftKey]: { key: otherDraftKey, programId: program.id, dayId: otherDay.id, dateKey: todayDateKey, draft: { marker: "other day" } },
  };
  const bundle = buildWorkoutSaveBundle({
    day,
    draft,
    plan,
    sessions: state.sessions,
    nextPlans: state.nextPlans,
    workoutDrafts,
    draftKey,
    program,
    programDays,
    readinessEntry,
    todayDateKey,
    setupCues: { [tracked.id]: "cue" },
    now,
    ...(id ? { id } : {}),
  });

  return { bundle, plan, draft, workoutDrafts, stateBefore: state };
}

try {
  // ------------------------------------------------------------------
  // First save of the day
  // ------------------------------------------------------------------
  const first = save({ id: "session-first", now: new Date("2026-09-29T08:00:00.000Z") });
  const firstPlanned = first.bundle.session.plannedExercises[tracked.id];
  assert.equal(firstPlanned.recommendedWeight, tracked.recommendedWeight ?? null, "first snapshot: the program target weight");
  assert.notEqual(firstPlanned.prescriptionSource, "progression", "first snapshot does not come from a progression");
  assert.equal(first.bundle.session.id, "session-first");
  assert.equal(first.bundle.session.schemaVersion, WORKOUT_SESSION_SCHEMA_VERSION);
  assert.equal(first.bundle.session.date, "2026-09-29T08:00:00.000Z");
  assert.equal(first.bundle.session.programId, program.id);
  assert.equal(first.bundle.session.dayId, day.id);
  assert.equal(first.bundle.session.readinessDate, todayDateKey);
  assert.equal(first.bundle.session.readinessMissing, false);
  assert.equal(first.bundle.session.sessionNotes, "repeat fixture", "notes are trimmed");
  assert.equal(first.bundle.session.sessionRpe, 7);
  assert.ok(first.bundle.session.workoutSets.every((set) => set.sessionId === "session-first"), "sets carry the session id");
  assert.equal(first.bundle.generatedPlan.sourceSessionId, "session-first");
  assert.deepEqual(first.bundle.persistArgs, {
    sessions: first.bundle.sessions,
    nextPlans: first.bundle.nextPlans,
    workoutDrafts: first.bundle.workoutDrafts,
    programId: program.id,
    plan: first.bundle.generatedPlan,
    programStatePatch: first.bundle.programStatePatch,
  });
  assert.ok(!(draftKey in first.bundle.workoutDrafts), "the saved draft key is removed");
  assert.ok(otherDraftKey in first.bundle.workoutDrafts, "another day's draft is kept");
  assert.ok(draftKey in first.workoutDrafts, "the input drafts object is not mutated");

  const firstResult = persistWorkoutSave(first.bundle.persistArgs);
  assert.equal(firstResult.ok, true, "first save persisted");
  const afterFirst = readAppState();
  assert.equal(afterFirst.sessions.length, 1);
  assert.equal(afterFirst.nextPlans[day.id].sourceSessionId, "session-first");
  assert.ok(!(draftKey in afterFirst.workoutDrafts), "stored drafts: the key is gone after the first save");
  const firstStored = JSON.stringify(afterFirst.sessions[0]);

  const firstProgression = getProgramProgressions().find(
    (row) => row.programId === program.id && row.programExerciseId === tracked.id,
  );
  assert.ok(firstProgression, "a progression row exists for the tracked exercise");
  assert.equal(firstProgression.sourceSessionId, "session-first");
  const earnedWeight = getPlanExercise(first.bundle.generatedPlan, tracked.id).recommendedWeight;
  // The program target has no weight; the first session establishes one. How
  // much the engine adds belongs to the engine fixtures, not to this one.
  assert.ok(
    typeof earnedWeight === "number" && earnedWeight >= FIRST_WEIGHT,
    `the first session earns a working weight (${FIRST_WEIGHT} logged -> ${earnedWeight} next)`,
  );
  assert.notEqual(earnedWeight, firstPlanned.recommendedWeight, "the earned prescription differs from the first snapshot");

  // ------------------------------------------------------------------
  // Second save of the SAME day on the SAME date
  // ------------------------------------------------------------------
  const second = save({ id: "session-second", now: new Date("2026-09-29T17:30:00.000Z") });
  const secondPlanned = second.bundle.session.plannedExercises[tracked.id];
  assert.equal(secondPlanned.recommendedWeight, earnedWeight, "second snapshot: the weight earned by the first session");
  assert.equal(secondPlanned.prescriptionSource, "progression", "second snapshot comes from the stored progression");
  assert.ok(
    second.bundle.session.workoutSets
      .filter((set) => set.programExerciseId === tracked.id)
      .every((set) => set.plannedWeight === earnedWeight && set.actualWeight === earnedWeight),
    "the second session is logged against the earned weight",
  );
  assert.deepEqual(second.bundle.sessions.map((session) => session.id), ["session-second", "session-first"], "newest first, nothing replaced");
  assert.equal(JSON.stringify(second.bundle.sessions[1]), firstStored, "the first session is unchanged in the bundle");
  assert.equal(second.bundle.generatedPlan.sourceSessionId, "session-second");
  assert.ok(!(draftKey in second.bundle.workoutDrafts), "the draft key is removed again");
  assert.ok(otherDraftKey in second.bundle.workoutDrafts);

  const secondResult = persistWorkoutSave(second.bundle.persistArgs);
  assert.equal(secondResult.ok, true, "second save persisted");
  const afterSecond = readAppState();
  assert.deepEqual(afterSecond.sessions.map((session) => session.id), ["session-second", "session-first"]);
  assert.equal(JSON.stringify(afterSecond.sessions[1]), firstStored, "the first stored session is byte-identical");
  assert.equal(afterSecond.sessions[0].readinessDate, afterSecond.sessions[1].readinessDate, "same date, two sessions");
  assert.equal(afterSecond.nextPlans[day.id].sourceSessionId, "session-second", "nextPlans[dayId] points at the second session");
  assert.ok(!(draftKey in afterSecond.workoutDrafts), "stored drafts: the key is gone after the second save");
  assert.deepEqual(afterSecond.workoutDrafts[otherDraftKey].draft, { marker: "other day" });

  const dayExerciseIds = new Set(day.exercises.map((exercise) => exercise.id));
  const dayProgressions = getProgramProgressions().filter(
    (row) => row.programId === program.id && dayExerciseIds.has(row.programExerciseId),
  );
  assert.equal(dayProgressions.length, day.exercises.length, "one progression row per exercise of the day, no duplicates");
  assert.ok(
    dayProgressions.every((row) => row.sourceSessionId === "session-second"),
    "every program-progressions row of the day points at the second session",
  );

  // What the log shows for a third session: the plan of the second one.
  const resolvedAfterSecond = getPlanExercise(resolveActivePlan(afterSecond.nextPlans), tracked.id);
  assert.equal(
    resolvedAfterSecond.recommendedWeight,
    getPlanExercise(second.bundle.generatedPlan, tracked.id).recommendedWeight,
    "the next prescription is the one generated from the second session",
  );
  assert.equal(resolvedAfterSecond.prescriptionSource, "progression");

  const state = getProgramState(program.id);
  assert.equal(state.lastCompletedDayId, day.id);
  assert.equal(state.lastWorkoutDate, "2026-09-29T17:30:00.000Z");
  const dayIndex = programDays.findIndex((candidate) => candidate.id === day.id);
  assert.equal(state.nextRecommendedDayId, programDays[(dayIndex + 1) % programDays.length].id);

  // ------------------------------------------------------------------
  // Default id: distinct per save
  // ------------------------------------------------------------------
  const third = save({ now: new Date("2026-09-29T18:00:00.000Z") });
  const fourth = save({ now: new Date("2026-09-29T18:00:00.000Z") });
  assert.ok(third.bundle.session.id && fourth.bundle.session.id);
  assert.notEqual(third.bundle.session.id, fourth.bundle.session.id, "generated ids are distinct even at the same instant");
  assert.ok(!["session-first", "session-second"].includes(third.bundle.session.id));

  // ------------------------------------------------------------------
  // A failed write changes nothing (the draft stays stored)
  // ------------------------------------------------------------------
  const pending = save({ id: "session-failed", now: new Date("2026-09-29T19:00:00.000Z") });
  window.localStorage.setItem(STORAGE_KEYS.workoutDrafts, JSON.stringify(pending.workoutDrafts));
  const before = new Map(storage.store);
  storage.failKey = STORAGE_KEYS.nextPlans;
  const failed = persistWorkoutSave(pending.bundle.persistArgs);
  storage.failKey = null;
  assert.equal(failed.ok, false, "the failed save is reported");
  assert.deepEqual([...storage.store.entries()], [...before.entries()], "storage is exactly as before the failed save");
  assert.ok(draftKey in readStorage(STORAGE_KEYS.workoutDrafts, {}), "the draft is still stored after a failed save");

  // ------------------------------------------------------------------
  // No program (legacy config day): no program state patch, null program id
  // ------------------------------------------------------------------
  const legacy = buildWorkoutSaveBundle({
    day,
    draft: first.draft,
    plan: first.plan,
    sessions: [],
    nextPlans: {},
    workoutDrafts: {},
    draftKey,
    program: null,
    programDays: [],
    readinessEntry: null,
    todayDateKey,
    setupCues: {},
    now: new Date("2026-09-29T08:00:00.000Z"),
    id: "legacy",
  });
  assert.equal(legacy.session.programId, null);
  assert.equal(legacy.programStatePatch, undefined);

  // ------------------------------------------------------------------
  // Decision H5-28: the bundle's own state patch is the derived one
  // (H5-5), not the naive "next day in the list": an optional day is never
  // "up next" and the patch carries week / cycle.
  // ------------------------------------------------------------------
  {
    const dayIndex = programDays.findIndex((candidate) => candidate.id === day.id);
    const naiveNext = programDays[(dayIndex + 1) % programDays.length];
    const scheduledNext = programDays[(dayIndex + 2) % programDays.length];
    assert.ok(programDays.length >= 3 && scheduledNext.id !== day.id, "the program has a day after the next one");
    const daysWithOptional = programDays.map((candidate) => (candidate.id === naiveNext.id ? { ...candidate, isOptional: true } : candidate));
    const bundleArgs = {
      day,
      draft: first.draft,
      plan: first.plan,
      sessions: [],
      nextPlans: {},
      workoutDrafts: {},
      draftKey,
      program,
      readinessEntry: null,
      todayDateKey,
      setupCues: {},
      now: new Date("2026-09-29T08:00:00.000Z"),
      id: "pointer",
    };
    const withOptional = buildWorkoutSaveBundle({ ...bundleArgs, programDays: daysWithOptional });
    assert.equal(withOptional.programStatePatch.nextRecommendedDayId, scheduledNext.id, "the optional day is skipped by the bundle itself");
    assert.equal(withOptional.programStatePatch.lastCompletedDayId, day.id);
    assert.equal(withOptional.programStatePatch.lastWorkoutDate, "2026-09-29T08:00:00.000Z");
    assert.equal(withOptional.programStatePatch.currentWeek, 1);
    assert.equal(withOptional.programStatePatch.currentCycle, 1);
    assert.equal(withOptional.persistArgs.programStatePatch, withOptional.programStatePatch);
    const plain = buildWorkoutSaveBundle({ ...bundleArgs, programDays });
    assert.equal(plain.programStatePatch.nextRecommendedDayId, naiveNext.id, "without optional days the pointer is the next day, as before");
    assert.ok(!readFileSync(path.join(root, "src/lib/workoutSave.js"), "utf8").includes("% programDays.length"), "no naive pointer left in workoutSave.js");
  }
  assert.equal(legacy.persistArgs.programId, null);
  assert.equal(legacy.session.readinessMissing, true);
  assert.equal(legacy.session.readinessSnapshot, null);
  assert.equal(legacy.session.wellness, null);

  // ------------------------------------------------------------------
  // App.jsx uses the builder (no second copy of the session assembly)
  // ------------------------------------------------------------------
  const app = readFileSync(path.join(root, "src/App.jsx"), "utf8");
  assert.ok(app.includes('import { buildWorkoutSaveBundle } from "./lib/workoutSave.js";'), "App.jsx imports the builder");
  assert.ok(/=\s*buildWorkoutSaveBundle\(\{/.test(app), "saveWorkout calls the builder");
  assert.ok(app.includes("persistWorkoutSave(persistArgs)"), "saveWorkout persists the bundle's arguments");
  assert.ok(!/schemaVersion:\s*6/.test(app), "the session record is not assembled in App.jsx");
  assert.ok(!/createWorkoutSetLogs|normalizeExerciseLogs/.test(app), "App.jsx no longer normalises the log itself");

  console.log(
    `verify-session-h4-repeat: ok (${day.name}, ${tracked.name}: first snapshot ${firstPlanned.recommendedWeight}, second snapshot ${secondPlanned.recommendedWeight} kg, next ${resolvedAfterSecond.recommendedWeight} kg)`,
  );
} catch (error) {
  console.error("verify-session-h4-repeat: FAIL");
  console.error(error);
  process.exit(1);
}
