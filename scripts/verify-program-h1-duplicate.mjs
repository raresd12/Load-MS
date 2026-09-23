// H1 Track B: fresh duplicate (decision 19.4-1), transactional duplicate (F2),
// archive (decision new-F), target edits (decision 19.4-2) and progression deletes.
import assert from "node:assert/strict";

class MemoryLocalStorage {
  constructor() {
    this.store = new Map();
    this.failAllWrites = false;
    this.failNextWriteForKey = null;
  }

  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  setItem(key, value) {
    if (this.failAllWrites || this.failNextWriteForKey === key) {
      this.failNextWriteForKey = null;
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

const originalWarn = console.warn;
console.warn = () => {};

const {
  BASE_RECOMMENDATION_NOTE,
  DEFAULT_PROGRAM_ID,
  deleteProgramProgression,
  deleteProgramProgressionsForDay,
  duplicateProgram,
  getActiveProgramId,
  getArchivedPrograms,
  getProgramDays,
  getProgramExercises,
  getProgramProgression,
  getPrograms,
  removeExerciseFromNextPlans,
  seedDefaultProgramIfNeeded,
  setActiveProgram,
  setProgramArchived,
  updateProgramExerciseTarget,
  updateProgramExerciseTargetChecked,
  upsertProgramProgressionsFromPlan,
} = await import("../src/lib/programStorage.js");
const { readStorage, STORAGE_KEYS } = await import("../src/lib/storage.js");

function snapshotKeys() {
  return Object.fromEntries([...storage.store.entries()]);
}

try {
  seedDefaultProgramIfNeeded();

  const sourceDays = getProgramDays(DEFAULT_PROGRAM_ID);
  const sourceExercises = sourceDays.flatMap((day) => getProgramExercises(day.id));
  const firstExercise = sourceExercises[0];

  // Give the source an earned progression so the duplicate has something to shed.
  upsertProgramProgressionsFromPlan(DEFAULT_PROGRAM_ID, {
    schemaVersion: 2,
    sourceSessionId: "session-earned-1",
    generatedAt: "2026-09-17T10:00:00.000Z",
    exercises: [
      {
        exerciseId: firstExercise.id,
        recommendedWeight: 82.5,
        repsMin: 6,
        repsMax: 8,
        repsLabel: "6-8",
        sets: 4,
        targetRPE: 8,
        reasons: ["Hit the top of the range at RPE 7.5: add load."],
        decision: "increase_load",
        confidence: "high",
      },
    ],
  });
  const earned = getProgramProgression(DEFAULT_PROGRAM_ID, firstExercise.id);
  assert.equal(earned.sourceSessionId, "session-earned-1");
  assert.equal(earned.lastRecommendedWeight, 82.5);

  // ------------------------------------------------------------------
  // Fresh duplicate: no provenance, targets copied, rest ranges intact.
  // ------------------------------------------------------------------
  const programCountBefore = getPrograms().length;
  const duplicateResult = duplicateProgram(DEFAULT_PROGRAM_ID);
  assert.equal(duplicateResult.ok, true);
  assert.ok(duplicateResult.program, "duplicate returns the new program");
  assert.equal(duplicateResult.programId, duplicateResult.program.id);
  assert.equal(duplicateResult.program.isDefault, false);
  assert.equal(getPrograms().length, programCountBefore + 1);

  const copyId = duplicateResult.programId;
  const copiedExercises = getProgramDays(copyId).flatMap((day) => getProgramExercises(day.id));
  assert.equal(copiedExercises.length, sourceExercises.length);

  const copiedProgressions = readStorage(STORAGE_KEYS.programProgressions, []).filter(
    (progression) => progression.programId === copyId,
  );
  assert.equal(copiedProgressions.length, copiedExercises.length, "one fresh progression per copied exercise");
  copiedProgressions.forEach((progression) => {
    assert.equal(progression.sourceSessionId, null, "no source session provenance");
    assert.equal(progression.sourcePlanGeneratedAt, null, "no plan provenance");
    assert.equal(progression.recommendationNote, BASE_RECOMMENDATION_NOTE, "base note, not an earned note");
    assert.equal(progression.decision, undefined, "no earned decision copied");
    const target = copiedExercises.find((exercise) => exercise.id === progression.programExerciseId);
    assert.ok(target, "progression bound to a copied exercise");
    assert.equal(
      progression.lastRecommendedWeight,
      target.targetWeight ?? null,
      "recommended weight equals target weight or null",
    );
    assert.equal(progression.lastRecommendedSets, target.targetSets);
    assert.equal(progression.lastTargetRPE, target.targetRPE);
  });

  const copiedFirst = copiedExercises[0];
  assert.equal(copiedFirst.exerciseId, firstExercise.exerciseId);
  const copiedFirstProgression = getProgramProgression(copyId, copiedFirst.id);
  assert.notEqual(copiedFirstProgression.lastRecommendedWeight, 82.5, "earned weight not carried over");
  assert.equal(
    getProgramProgression(DEFAULT_PROGRAM_ID, firstExercise.id).sourceSessionId,
    "session-earned-1",
    "source progression untouched",
  );

  sourceExercises.forEach((sourceExercise, index) => {
    assert.deepEqual(copiedExercises[index].restTime, sourceExercise.restTime, "rest round-trips");
    assert.deepEqual(copiedExercises[index].targetReps, sourceExercise.targetReps);
    assert.equal(copiedExercises[index].targetWeight, sourceExercise.targetWeight);
  });
  assert.ok(copiedExercises.some((exercise) => Array.isArray(exercise.restTime)), "range preserved as array");

  assert.equal(readStorage(STORAGE_KEYS.sessions, []).length, 0, "sessions never copied");
  assert.equal(duplicateProgram("missing-program").ok, false);

  // ------------------------------------------------------------------
  // Transactional duplicate.
  // ------------------------------------------------------------------
  const snapshotBefore = snapshotKeys();
  storage.failAllWrites = true;
  const failedAll = duplicateProgram(DEFAULT_PROGRAM_ID);
  storage.failAllWrites = false;
  assert.equal(failedAll.ok, false);
  assert.equal(failedAll.program, null);
  assert.equal(failedAll.code, "quota");
  assert.equal(getPrograms().length, programCountBefore + 1, "program count unchanged after failed duplicate");
  assert.deepEqual(snapshotKeys(), snapshotBefore);

  storage.failNextWriteForKey = STORAGE_KEYS.programSections;
  const failedThird = duplicateProgram(DEFAULT_PROGRAM_ID);
  assert.equal(failedThird.ok, false);
  assert.equal(failedThird.failedKey, STORAGE_KEYS.programSections);
  assert.equal(failedThird.rolledBack, true);
  assert.deepEqual(snapshotKeys(), snapshotBefore, "first two keys rolled back");

  // ------------------------------------------------------------------
  // Archive (decision new-F).
  // ------------------------------------------------------------------
  assert.equal(setProgramArchived(DEFAULT_PROGRAM_ID, true).ok, false, "default cannot be archived");
  assert.match(setProgramArchived(DEFAULT_PROGRAM_ID, true).error, /Default/);
  assert.equal(setProgramArchived("missing", true).ok, false);

  setActiveProgram(copyId);
  assert.equal(getActiveProgramId(), copyId);
  const activeArchive = setProgramArchived(copyId, true);
  assert.equal(activeArchive.ok, false, "active program cannot be archived");
  assert.match(activeArchive.error, /active/i);

  setActiveProgram(DEFAULT_PROGRAM_ID);
  const archived = setProgramArchived(copyId, true);
  assert.equal(archived.ok, true);
  assert.equal(archived.program.isArchived, true);
  assert.equal(getPrograms().some((program) => program.id === copyId), false, "hidden by default");
  assert.equal(
    getPrograms({ includeArchived: true }).some((program) => program.id === copyId),
    true,
    "visible with includeArchived",
  );
  assert.equal(getArchivedPrograms().length, 1);
  assert.equal(getProgramDays(copyId).length, sourceDays.length, "archived program keeps its days");
  assert.equal(
    readStorage(STORAGE_KEYS.programProgressions, []).filter((entry) => entry.programId === copyId).length,
    copiedExercises.length,
    "archived program keeps its progressions",
  );
  assert.equal(setActiveProgram(copyId), null, "archived program cannot become active");
  assert.equal(
    updateProgramExerciseTarget(copyId, copiedFirst.id, { targetSets: 5 }),
    null,
    "archived program targets are read-only",
  );

  storage.failAllWrites = true;
  const failedUnarchive = setProgramArchived(copyId, false);
  storage.failAllWrites = false;
  assert.equal(failedUnarchive.ok, false);
  assert.equal(failedUnarchive.code, "quota");
  assert.equal(getArchivedPrograms().length, 1, "still archived after failed write");

  const unarchived = setProgramArchived(copyId, false);
  assert.equal(unarchived.ok, true);
  assert.equal(setProgramArchived(copyId, false).changed, false, "idempotent");
  assert.equal(getPrograms().some((program) => program.id === copyId), true);
  assert.equal(getPrograms({ includeArchived: true }).length, getPrograms().length);

  // Archived programs survive other writers rewriting the programs key.
  setProgramArchived(copyId, true);
  const secondCopy = duplicateProgram(DEFAULT_PROGRAM_ID);
  assert.equal(secondCopy.ok, true);
  assert.equal(
    getPrograms({ includeArchived: true }).some((program) => program.id === copyId),
    true,
    "duplicate did not drop the archived program",
  );
  setProgramArchived(copyId, false);

  // ------------------------------------------------------------------
  // Target edits (decision 19.4-2) on the (custom) copy.
  // ------------------------------------------------------------------
  const original = copiedExercises[0];
  assert.ok(Array.isArray(original.restTime) || typeof original.restTime === "number");
  assert.ok(getProgramProgression(copyId, original.id), "copy has a progression before the edit");

  // Partial patch: only notes -> everything else keeps its current value.
  const notesOnly = updateProgramExerciseTargetChecked(copyId, original.id, { notes: "  Pause 1s  " });
  assert.equal(notesOnly.ok, true);
  assert.equal(notesOnly.deletedProgression, true);
  assert.equal(notesOnly.exercise.notes, "Pause 1s");
  assert.equal(notesOnly.exercise.targetSets, original.targetSets, "sets kept");
  assert.deepEqual(notesOnly.exercise.targetReps, original.targetReps, "reps kept");
  assert.equal(notesOnly.exercise.targetWeight, original.targetWeight, "weight kept (latent bug fixed)");
  assert.equal(notesOnly.exercise.targetRPE, original.targetRPE);
  assert.deepEqual(notesOnly.exercise.restTime, original.restTime, "rest range kept");
  assert.equal(getProgramProgression(copyId, original.id), null, "stored progression deleted");

  const persisted = getProgramExercises(original.dayId).find((exercise) => exercise.id === original.id);
  assert.deepEqual(persisted, notesOnly.exercise, "edit persisted");

  // Full editor-style patch including a weight and a rest range.
  const fullPatch = updateProgramExerciseTarget(copyId, original.id, {
    targetSets: 5,
    targetReps: { min: 5, max: 5, label: null },
    targetWeight: 100,
    targetRPE: 8.5,
    restTime: [150, 210],
    notes: "",
  });
  assert.ok(fullPatch, "legacy wrapper returns the exercise");
  assert.equal(fullPatch.targetSets, 5);
  assert.deepEqual(fullPatch.targetReps, { min: 5, max: 5, label: null });
  assert.equal(fullPatch.targetWeight, 100);
  assert.equal(fullPatch.targetRPE, 8.5);
  assert.deepEqual(fullPatch.restTime, [150, 210], "rest range accepted and stored as array");
  assert.equal(fullPatch.notes, "");

  // Explicit null weight clears it; invalid rest keeps the current value; BW weight kept as "BW".
  const cleared = updateProgramExerciseTarget(copyId, original.id, {
    targetWeight: null,
    restTime: [300, 100],
    targetReps: { label: "AMRAP" },
  });
  assert.equal(cleared.targetWeight, null);
  assert.deepEqual(cleared.restTime, [150, 210], "invalid range ignored, current value kept");
  assert.deepEqual(cleared.targetReps, { min: 5, max: 5, label: "AMRAP" }, "reps sub-fields merge");
  assert.equal(updateProgramExerciseTarget(copyId, original.id, { targetWeight: "bw" }).targetWeight, "BW");

  // Default program targets stay protected; unknown exercise rejected.
  assert.equal(updateProgramExerciseTarget(DEFAULT_PROGRAM_ID, firstExercise.id, { targetSets: 5 }), null);
  const protectedResult = updateProgramExerciseTargetChecked(DEFAULT_PROGRAM_ID, firstExercise.id, {});
  assert.equal(protectedResult.ok, false);
  assert.match(protectedResult.error, /protected/);
  assert.equal(updateProgramExerciseTargetChecked(copyId, "nope", {}).ok, false);

  // Write failure: legacy wrapper returns null (no false "Saved target."), checked returns the error.
  storage.failAllWrites = true;
  assert.equal(updateProgramExerciseTarget(copyId, original.id, { targetSets: 2 }), null);
  const failedChecked = updateProgramExerciseTargetChecked(copyId, original.id, { targetSets: 2 });
  storage.failAllWrites = false;
  assert.equal(failedChecked.ok, false);
  assert.equal(failedChecked.code, "quota");
  assert.equal(failedChecked.exercise, null);
  assert.notEqual(
    getProgramExercises(original.dayId).find((exercise) => exercise.id === original.id).targetSets,
    2,
    "failed edit not persisted",
  );

  // Progression deleted together with the exercise write (single batch).
  upsertProgramProgressionsFromPlan(copyId, {
    sourceSessionId: "s-copy",
    generatedAt: "2026-09-18T00:00:00.000Z",
    exercises: [{ exerciseId: original.id, recommendedWeight: 90, sets: 3, reasons: ["x"] }],
  });
  assert.ok(getProgramProgression(copyId, original.id));
  storage.failNextWriteForKey = STORAGE_KEYS.programProgressions;
  const failedSecondKey = updateProgramExerciseTargetChecked(copyId, original.id, { targetSets: 4 });
  assert.equal(failedSecondKey.ok, false);
  assert.equal(failedSecondKey.failedKey, STORAGE_KEYS.programProgressions);
  assert.ok(getProgramProgression(copyId, original.id), "progression kept when batch fails");
  assert.notEqual(
    getProgramExercises(original.dayId).find((exercise) => exercise.id === original.id).targetSets,
    4,
    "exercise write rolled back when progression delete fails",
  );

  // ------------------------------------------------------------------
  // deleteProgramProgression / deleteProgramProgressionsForDay
  // ------------------------------------------------------------------
  const deleteOne = deleteProgramProgression(copyId, original.id);
  assert.deepEqual(deleteOne, { ok: true, removedCount: 1 });
  assert.equal(getProgramProgression(copyId, original.id), null);
  assert.deepEqual(deleteProgramProgression(copyId, original.id), { ok: true, removedCount: 0 });

  const dayId = original.dayId;
  const dayExerciseCount = getProgramExercises(dayId).length;
  const progressionsForDayBefore = readStorage(STORAGE_KEYS.programProgressions, []).filter(
    (entry) => entry.programId === copyId && getProgramExercises(dayId).some((ex) => ex.id === entry.programExerciseId),
  ).length;
  assert.equal(progressionsForDayBefore, dayExerciseCount - 1);
  const otherProgramCount = readStorage(STORAGE_KEYS.programProgressions, []).filter(
    (entry) => entry.programId !== copyId,
  ).length;

  const deleteDay = deleteProgramProgressionsForDay(copyId, dayId);
  assert.equal(deleteDay.ok, true);
  assert.equal(deleteDay.removedCount, dayExerciseCount - 1);
  assert.equal(
    readStorage(STORAGE_KEYS.programProgressions, []).filter((entry) => entry.programId !== copyId).length,
    otherProgramCount,
    "other programs untouched",
  );
  assert.equal(
    readStorage(STORAGE_KEYS.programProgressions, []).filter((entry) => entry.programId === copyId).length,
    copiedExercises.length - dayExerciseCount,
    "only that day's progressions removed",
  );

  storage.failAllWrites = true;
  const failedDelete = deleteProgramProgressionsForDay(copyId, getProgramDays(copyId)[1].id);
  storage.failAllWrites = false;
  assert.equal(failedDelete.ok, false);
  assert.equal(failedDelete.removedCount, 0);

  // ------------------------------------------------------------------
  // removeExerciseFromNextPlans (pure helper for the UI track)
  // ------------------------------------------------------------------
  const plans = {
    d1: { generatedAt: "x", exercises: [{ exerciseId: "a" }, { exerciseId: "b" }] },
    d2: { generatedAt: "y", exercises: [{ exerciseId: "a" }] },
    d3: { generatedAt: "z", exercises: [{ exerciseId: "c" }] },
  };
  const trimmed = removeExerciseFromNextPlans(plans, "a");
  assert.deepEqual(trimmed, {
    d1: { generatedAt: "x", exercises: [{ exerciseId: "b" }] },
    d3: { generatedAt: "z", exercises: [{ exerciseId: "c" }] },
  });
  assert.equal(trimmed.d3, plans.d3, "untouched plans keep identity");
  assert.deepEqual(plans.d1.exercises.length, 2, "input not mutated");
  assert.deepEqual(removeExerciseFromNextPlans(null, "a"), {});

  console.warn = originalWarn;
  console.log("Program H1 duplicate/archive/target verification passed.");
} catch (error) {
  console.warn = originalWarn;
  throw error;
}
