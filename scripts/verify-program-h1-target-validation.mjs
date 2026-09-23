// Fixer round 2 (decision new-R extended, decision new-V):
// - updateProgramExerciseTargetChecked applies the same range rules as the
//   strict share validator to RPE / reps / weight, so every target the app
//   stores exports and imports again.
// - validateProgramShareStrict rejects a program exercise whose exerciseId
//   resolves to no Library entry (share, local Library or built-in config).
import assert from "node:assert/strict";

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

const originalWarn = console.warn;
console.warn = () => {};

const {
  DEFAULT_PROGRAM_ID,
  duplicateProgram,
  exportProgramShare,
  getProgramDays,
  getProgramDayViewModels,
  getProgramExercises,
  importProgramShare,
  seedDefaultProgramIfNeeded,
  updateProgramExerciseTargetChecked,
  validateProgramShareStrict,
} = await import("../src/lib/programStorage.js");

function roundTrips(programId) {
  return validateProgramShareStrict(exportProgramShare(programId));
}

try {
  seedDefaultProgramIfNeeded();
  const copy = duplicateProgram(DEFAULT_PROGRAM_ID);
  assert.equal(copy.ok, true);
  const exercise = getProgramExercises(getProgramDays(copy.programId)[0].id)[0];
  const before = JSON.stringify(exercise);

  // ------------------------------------------------------------------
  // Rejected edits: nothing stored, the export still validates.
  // ------------------------------------------------------------------
  const rejected = [
    [{ targetRPE: 15 }, /RPE must be 1-10/],
    [{ targetRPE: 7.3 }, /RPE must be 1-10/],
    [{ targetRPE: "abc" }, /RPE must be 1-10/],
    [{ targetReps: { min: 8, max: 5 } }, /minimum reps cannot exceed/i],
    [{ targetReps: { min: 0, max: null, label: "" } }, /minimum reps must be a positive number/i],
    [{ targetReps: { min: null, max: null, label: "" } }, /needs a rep range or a rep label/i],
    [{ targetReps: { min: "abc" } }, /minimum reps must be a positive number/i],
    [{ targetWeight: -5 }, /target weight must be empty/i],
    [{ targetWeight: "heavy" }, /target weight must be empty/i],
    [{ targetSets: 0 }, /Sets must be a whole number/],
    [{ targetSets: "many" }, /Sets must be a whole number/],
  ];

  for (const [patch, pattern] of rejected) {
    const result = updateProgramExerciseTargetChecked(copy.programId, exercise.id, patch);
    assert.equal(result.ok, false, `${JSON.stringify(patch)} must be rejected`);
    assert.match(result.error, pattern);
    assert.ok(Array.isArray(result.errors) && result.errors.length >= 1);
    assert.equal(result.exercise, null);
  }

  assert.equal(
    JSON.stringify(getProgramExercises(exercise.dayId).find((entry) => entry.id === exercise.id)),
    before,
    "no rejected value was stored",
  );
  assert.equal(roundTrips(copy.programId).valid, true);

  // ------------------------------------------------------------------
  // Accepted edits: partial reps patches merge, half-step RPE, BW, 0 kg.
  // ------------------------------------------------------------------
  const accepted = updateProgramExerciseTargetChecked(copy.programId, exercise.id, {
    targetRPE: 8.5,
    targetReps: { min: 6, max: 10, label: "" },
    targetWeight: 0,
  });
  assert.equal(accepted.ok, true, accepted.error);
  assert.equal(accepted.exercise.targetRPE, 8.5);
  assert.deepEqual(accepted.exercise.targetReps, { min: 6, max: 10, label: null });
  assert.equal(accepted.exercise.targetWeight, 0);
  assert.equal(updateProgramExerciseTargetChecked(copy.programId, exercise.id, { targetReps: { max: 12 } }).ok, true);
  assert.equal(updateProgramExerciseTargetChecked(copy.programId, exercise.id, { targetReps: { max: 4 } }).ok, false, "merged min 6 > max 4");
  assert.equal(updateProgramExerciseTargetChecked(copy.programId, exercise.id, { targetWeight: "bw" }).ok, true);
  assert.equal(updateProgramExerciseTargetChecked(copy.programId, exercise.id, { targetWeight: "" }).ok, true, "blank clears the weight");
  assert.equal(updateProgramExerciseTargetChecked(copy.programId, exercise.id, { notes: "only notes" }).ok, true);
  assert.equal(roundTrips(copy.programId).valid, true, "edited program still exports and imports");
  assert.equal(importProgramShare(exportProgramShare(copy.programId)).ok, true);

  // ------------------------------------------------------------------
  // Dangling library references (decision new-V).
  // ------------------------------------------------------------------
  const share = exportProgramShare(DEFAULT_PROGRAM_ID);
  assert.equal(validateProgramShareStrict(share).valid, true);

  const ghost = JSON.parse(JSON.stringify(share));
  ghost.programExercises[0].exerciseId = "ghost-move";
  ghost.libraryExercises = [];
  const ghostValidation = validateProgramShareStrict(ghost);
  assert.equal(ghostValidation.valid, false, "unresolvable exerciseId is rejected");
  assert.ok(
    ghostValidation.errors.some((message) => /ghost-move.*neither in the share nor in your Library/.test(message)),
    ghostValidation.errors.join(" | "),
  );
  const ghostImport = importProgramShare(ghost);
  assert.equal(ghostImport.ok, false);
  assert.ok(
    !getProgramDayViewModels(DEFAULT_PROGRAM_ID).some((day) =>
      day.exercises.some((entry) => entry.libraryExerciseId === "ghost-move"),
    ),
  );

  // Resolvable through the share itself: accepted and importable.
  const withEntry = JSON.parse(JSON.stringify(ghost));
  withEntry.libraryExercises = [{ id: "ghost-move", name: "Ghost Move", category: "compound" }];
  assert.equal(validateProgramShareStrict(withEntry).valid, true, "share-provided library entry resolves");
  const importedWithEntry = importProgramShare(withEntry);
  assert.equal(importedWithEntry.ok, true);
  assert.equal(importedWithEntry.addedLibraryExerciseCount, 1);
  assert.equal(
    getProgramDayViewModels(importedWithEntry.programId)[0].exercises[0].name,
    "Ghost Move",
    "no placeholder exercise",
  );

  // Resolvable through the local Library only (the H1 import fixture shape).
  const localOnly = JSON.parse(JSON.stringify(share));
  localOnly.libraryExercises = [];
  assert.equal(validateProgramShareStrict(localOnly).valid, true, "local Library resolves the ids");

  // Numeric ids compare as strings, like every other id check.
  const numericId = JSON.parse(JSON.stringify(share));
  numericId.programExercises[0].exerciseId = 42;
  numericId.libraryExercises = [{ id: "42", name: "Forty-two" }];
  assert.equal(validateProgramShareStrict(numericId).valid, true);

  console.warn = originalWarn;
  console.log("Program H1 target-validation verification passed.");
} catch (error) {
  console.warn = originalWarn;
  throw error;
}
