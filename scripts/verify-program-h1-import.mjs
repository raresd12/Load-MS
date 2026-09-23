// H1 Track B: strict share validation, transactional import (F2) and rest-range
// round-trip through export/import.
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
  DEFAULT_PROGRAM_ID,
  duplicateProgram,
  exportProgramShare,
  getProgramDays,
  getProgramExercises,
  getProgramSections,
  getPrograms,
  importProgramShare,
  MAX_TARGET_SETS,
  PROGRAM_SHARE_TYPE,
  seedDefaultProgramIfNeeded,
  updateProgramExerciseTargetChecked,
  validateProgramShare,
  validateProgramShareStrict,
} = await import("../src/lib/programStorage.js");
const { readStorage, STORAGE_KEYS } = await import("../src/lib/storage.js");

function snapshotKeys() {
  return Object.fromEntries([...storage.store.entries()]);
}

function buildShare(overrides = {}) {
  return {
    app: "rpe-workout-tracker",
    type: PROGRAM_SHARE_TYPE,
    schemaVersion: 1,
    exportedAt: "2026-09-18T00:00:00.000Z",
    program: { name: "Fixture Program", nickname: "Fixture", description: "", goal: "" },
    days: [{ id: "d1", name: "Day 1", focus: "Upper", orderIndex: 0 }],
    sections: [{ id: "s1", dayId: "d1", name: "Main Work", orderIndex: 0 }],
    programExercises: [
      {
        id: "e1",
        dayId: "d1",
        sectionId: "s1",
        exerciseId: "bench-press",
        orderIndex: 0,
        targetSets: 3,
        targetReps: { min: 6, max: 8, label: null },
        targetWeight: null,
        targetRPE: 8,
        restTime: [120, 180],
        notes: "",
      },
    ],
    libraryExercises: [],
    ...overrides,
  };
}

function withExercise(patch) {
  const share = buildShare();
  share.programExercises[0] = { ...share.programExercises[0], ...patch };
  return share;
}

function expectInvalid(share, pattern, label) {
  const result = validateProgramShareStrict(share);
  assert.equal(result.valid, false, `${label}: expected invalid`);
  assert.ok(Array.isArray(result.errors) && result.errors.length >= 1, `${label}: errors list`);
  assert.match(result.error, pattern, `${label}: readable message`);
  assert.equal(validateProgramShare(share).valid, true, `${label}: lenient validation unchanged`);
}

try {
  seedDefaultProgramIfNeeded();

  // ------------------------------------------------------------------
  // Strict validation: each rule produces a readable error.
  // ------------------------------------------------------------------
  assert.deepEqual(validateProgramShareStrict(buildShare()), { valid: true, errors: [] });

  expectInvalid(
    withExercise({ targetSets: 0 }),
    new RegExp(`sets must be a whole number from 1 to ${MAX_TARGET_SETS}`),
    "sets 0",
  );
  expectInvalid(withExercise({ targetSets: MAX_TARGET_SETS + 1 }), /sets must be/, "sets above cap");
  assert.equal(
    validateProgramShareStrict(withExercise({ targetSets: 15 })).valid,
    true,
    "15 sets (density work the editor accepts) is a valid share",
  );
  expectInvalid(withExercise({ targetSets: 2.5 }), /sets must be/, "sets 2.5");
  expectInvalid(withExercise({ targetSets: "3" }), /sets must be/, "sets string");

  expectInvalid(withExercise({ targetReps: { min: 0, max: 8 } }), /minimum reps must be a positive/, "min 0");
  expectInvalid(withExercise({ targetReps: { min: 6, max: -1 } }), /maximum reps must be a positive/, "max -1");
  expectInvalid(withExercise({ targetReps: { min: 8, max: 6 } }), /minimum reps cannot exceed/, "min > max");
  expectInvalid(withExercise({ targetReps: { min: null, max: null, label: "" } }), /rep range or a rep label/, "no reps no label");
  assert.equal(
    validateProgramShareStrict(withExercise({ targetReps: { min: null, max: null, label: "failure" } })).valid,
    true,
    "label substitutes for a rep range",
  );
  assert.equal(
    validateProgramShareStrict(withExercise({ targetReps: { min: 10, max: null, label: null } })).valid,
    true,
    "single bound allowed",
  );

  expectInvalid(withExercise({ targetRPE: 8.25 }), /target RPE must be 1-10 in .5 steps/, "rpe 8.25");
  expectInvalid(withExercise({ targetRPE: 0 }), /target RPE/, "rpe 0");
  expectInvalid(withExercise({ targetRPE: 11 }), /target RPE/, "rpe 11");
  expectInvalid(withExercise({ targetRPE: null }), /target RPE/, "rpe null");
  assert.equal(validateProgramShareStrict(withExercise({ targetRPE: 7.5 })).valid, true);

  expectInvalid(withExercise({ restTime: 0 }), /rest must be a positive number/, "rest 0");
  expectInvalid(withExercise({ restTime: [180, 120] }), /rest must be/, "rest range reversed");
  expectInvalid(withExercise({ restTime: [60] }), /rest must be/, "rest single-element array");
  expectInvalid(withExercise({ restTime: "90" }), /rest must be/, "rest string");
  assert.equal(validateProgramShareStrict(withExercise({ restTime: 90 })).valid, true);

  expectInvalid(withExercise({ targetWeight: -5 }), /target weight must be empty/, "weight -5");
  expectInvalid(withExercise({ targetWeight: "heavy" }), /target weight/, "weight text");
  assert.equal(validateProgramShareStrict(withExercise({ targetWeight: "BW" })).valid, true);
  assert.equal(validateProgramShareStrict(withExercise({ targetWeight: 0 })).valid, true);
  assert.equal(validateProgramShareStrict(withExercise({ targetWeight: 42.5 })).valid, true);

  expectInvalid(withExercise({ dayId: "ghost" }), /references unknown day "ghost"/, "unknown day");
  expectInvalid(withExercise({ exerciseId: "" }), /no library exercise id/, "missing exerciseId");

  const duplicateDays = buildShare();
  duplicateDays.days.push({ ...duplicateDays.days[0] });
  expectInvalid(duplicateDays, /Duplicate day id "d1"/, "duplicate day");

  const duplicateSections = buildShare();
  duplicateSections.sections.push({ ...duplicateSections.sections[0] });
  expectInvalid(duplicateSections, /Duplicate section id "s1"/, "duplicate section");

  const duplicateExercises = buildShare();
  duplicateExercises.programExercises.push({ ...duplicateExercises.programExercises[0] });
  expectInvalid(duplicateExercises, /Duplicate program exercise id "e1"/, "duplicate exercise");

  const orphanSection = buildShare();
  orphanSection.sections.push({ id: "s2", dayId: "nope", name: "X", orderIndex: 1 });
  expectInvalid(orphanSection, /Section 2 references unknown day/, "orphan section");

  const manyErrors = withExercise({ targetSets: 0, targetRPE: 12, restTime: -1 });
  const manyResult = validateProgramShareStrict(manyErrors);
  assert.equal(manyResult.errors.length, 3, "every problem is listed");

  // Duplicate library entries are tolerated (import keeps the first).
  const duplicateLibrary = buildShare({
    libraryExercises: [
      { id: "fixture-lib", name: "Fixture Lift A" },
      { id: "fixture-lib", name: "Fixture Lift B" },
    ],
  });
  assert.equal(validateProgramShareStrict(duplicateLibrary).valid, true);

  // Basic envelope failures still reported through the strict path.
  assert.equal(validateProgramShareStrict(null).valid, false);
  assert.equal(importProgramShare({ type: "wrong" }).ok, false);
  assert.equal(importProgramShare({ type: "wrong" }).valid, false);

  // Invalid import writes nothing.
  const beforeInvalid = snapshotKeys();
  const invalidImport = importProgramShare(withExercise({ targetSets: 0 }));
  assert.equal(invalidImport.ok, false);
  assert.equal(invalidImport.valid, false);
  assert.ok(invalidImport.errors.length >= 1);
  assert.deepEqual(snapshotKeys(), beforeInvalid, "invalid share leaves storage untouched");

  // ------------------------------------------------------------------
  // Existing valid shares still import; rest ranges round-trip unchanged.
  // ------------------------------------------------------------------
  const defaultShare = JSON.parse(JSON.stringify(exportProgramShare(DEFAULT_PROGRAM_ID)));
  assert.equal(validateProgramShareStrict(defaultShare).valid, true, "default export passes strict validation");
  const rangeExercises = defaultShare.programExercises.filter((exercise) => Array.isArray(exercise.restTime));
  assert.ok(rangeExercises.length > 0, "default program has rest ranges to round-trip");

  const importResult = importProgramShare(defaultShare);
  assert.equal(importResult.ok, true);
  assert.equal(importResult.valid, true);
  assert.equal(importResult.programId, importResult.program.id);
  assert.deepEqual(importResult.errors, []);
  assert.equal(importResult.importedExerciseCount, defaultShare.programExercises.length);

  const importedDays = getProgramDays(importResult.programId);
  const importedExercises = importedDays.flatMap((day) => getProgramExercises(day.id));
  assert.equal(importedExercises.length, defaultShare.programExercises.length);
  defaultShare.programExercises.forEach((sourceExercise, index) => {
    assert.deepEqual(
      importedExercises[index].restTime,
      sourceExercise.restTime,
      `restTime round-trips unchanged for ${sourceExercise.exerciseId}`,
    );
    assert.deepEqual(importedExercises[index].targetReps, sourceExercise.targetReps);
  });
  assert.ok(
    importedExercises.some((exercise) => Array.isArray(exercise.restTime) && exercise.restTime.length === 2),
    "an imported exercise still carries a [min, max] rest range",
  );

  // Import of a share with duplicate library entries adds the library id once.
  const libraryBefore = readStorage(STORAGE_KEYS.exerciseLibrary, []).length;
  const duplicateLibraryImport = importProgramShare(duplicateLibrary);
  assert.equal(duplicateLibraryImport.ok, true);
  assert.equal(duplicateLibraryImport.addedLibraryExerciseCount, 1);
  assert.equal(readStorage(STORAGE_KEYS.exerciseLibrary, []).length, libraryBefore + 1);

  // ------------------------------------------------------------------
  // Transactional import: all writes fail -> nothing changes, ok:false.
  // ------------------------------------------------------------------
  const programCountBefore = getPrograms().length;
  const snapshotBefore = snapshotKeys();
  storage.failAllWrites = true;
  const failedAll = importProgramShare(JSON.parse(JSON.stringify(defaultShare)));
  storage.failAllWrites = false;
  assert.equal(failedAll.ok, false, "import reports failure when writes fail");
  assert.equal(failedAll.valid, false, "legacy valid flag is false so App shows the error");
  assert.equal(failedAll.failedKey, STORAGE_KEYS.programs);
  assert.equal(failedAll.code, "quota");
  assert.match(failedAll.error, /Browser storage is full/);
  assert.equal(getPrograms().length, programCountBefore, "program count unchanged");
  assert.deepEqual(snapshotKeys(), snapshotBefore, "no partial state");

  // Failure on the 3rd key (programSections): first two keys rolled back.
  storage.failNextWriteForKey = STORAGE_KEYS.programSections;
  const failedThird = importProgramShare(JSON.parse(JSON.stringify(defaultShare)));
  assert.equal(failedThird.ok, false);
  assert.equal(failedThird.failedKey, STORAGE_KEYS.programSections);
  assert.equal(failedThird.rolledBack, true);
  assert.equal(getPrograms().length, programCountBefore, "programs rolled back");
  assert.equal(
    storage.getItem(STORAGE_KEYS.programDays),
    snapshotBefore[STORAGE_KEYS.programDays],
    "program days rolled back",
  );
  assert.deepEqual(snapshotKeys(), snapshotBefore, "storage identical to pre-import snapshot");

  // A subsequent healthy import still works.
  const recovered = importProgramShare(JSON.parse(JSON.stringify(defaultShare)));
  assert.equal(recovered.ok, true);
  assert.equal(getPrograms().length, programCountBefore + 1);

  // ------------------------------------------------------------------
  // Fixer round 1: the app's own export always round-trips. A custom
  // program with more sets than the old share cap (12) is valid in the
  // editor, exports, validates and imports; the shared MAX_TARGET_SETS cap
  // is enforced on the edit side as well.
  // ------------------------------------------------------------------
  {
    const copy = duplicateProgram(DEFAULT_PROGRAM_ID);
    assert.equal(copy.ok, true);
    const copyDay = getProgramDays(copy.programId)[0];
    const copyExercise = getProgramExercises(copyDay.id)[0];

    const fifteen = updateProgramExerciseTargetChecked(copy.programId, copyExercise.id, {
      targetSets: 15,
    });
    assert.equal(fifteen.ok, true);
    assert.equal(fifteen.exercise.targetSets, 15);

    const exported = exportProgramShare(copy.programId);
    assert.deepEqual(validateProgramShareStrict(exported), { valid: true, errors: [] });
    const roundTrip = importProgramShare(JSON.parse(JSON.stringify(exported)));
    assert.equal(roundTrip.ok, true, "15-set program imports");
    const importedExercises = getProgramExercises(getProgramDays(roundTrip.programId)[0].id);
    assert.equal(importedExercises[0].targetSets, 15);

    const tooMany = updateProgramExerciseTargetChecked(copy.programId, copyExercise.id, {
      targetSets: MAX_TARGET_SETS + 1,
    });
    assert.equal(tooMany.ok, false, "editor side rejects sets above the shared cap");
    assert.match(tooMany.error, new RegExp(`1 to ${MAX_TARGET_SETS}`));
    assert.equal(
      getProgramExercises(copyDay.id)[0].targetSets,
      15,
      "rejected edit leaves the stored target untouched",
    );
    assert.equal(
      updateProgramExerciseTargetChecked(copy.programId, copyExercise.id, { targetSets: 2.5 }).ok,
      false,
    );
    assert.equal(
      updateProgramExerciseTargetChecked(copy.programId, copyExercise.id, { targetWeight: 42 }).ok,
      true,
      "a patch without targetSets is still accepted",
    );
  }

  // ------------------------------------------------------------------
  // Fixer round 1: validator and importer agree on id comparison. A share
  // with numeric day ids and string dayId references passes strict
  // validation, so it must import with its sections and exercises intact
  // instead of silently producing a program with empty days.
  // ------------------------------------------------------------------
  {
    const numericShare = JSON.parse(JSON.stringify(defaultShare));
    numericShare.days.forEach((day, index) => {
      day.id = index + 1;
    });
    numericShare.sections.forEach((section) => {
      const index = defaultShare.days.findIndex((day) => day.id === section.dayId);
      section.dayId = String(index + 1);
    });
    numericShare.programExercises.forEach((exercise) => {
      const index = defaultShare.days.findIndex((day) => day.id === exercise.dayId);
      exercise.dayId = String(index + 1);
    });
    assert.equal(validateProgramShareStrict(numericShare).valid, true, "numeric day ids validate");

    const imported = importProgramShare(numericShare);
    assert.equal(imported.ok, true);
    assert.equal(imported.importedDayCount, defaultShare.days.length);
    assert.equal(
      imported.importedExerciseCount,
      defaultShare.programExercises.length,
      "every exercise imported",
    );
    const importedDays = getProgramDays(imported.programId);
    assert.equal(importedDays.length, defaultShare.days.length);
    // Per-day counts match the source share (a recovery day legitimately has none).
    const expectedExercisesPerDay = defaultShare.days.map(
      (day) => defaultShare.programExercises.filter((exercise) => exercise.dayId === day.id).length,
    );
    const expectedSectionsPerDay = defaultShare.days.map(
      (day) => defaultShare.sections.filter((section) => section.dayId === day.id).length,
    );
    assert.ok(expectedExercisesPerDay.some((count) => count > 0), "fixture share has exercises");
    const exercisesPerDay = importedDays.map((day) => getProgramExercises(day.id).length);
    assert.deepEqual(exercisesPerDay, expectedExercisesPerDay, "exercises per day preserved");
    const sectionsPerDay = importedDays.map((day) => getProgramSections(day.id).length);
    assert.deepEqual(sectionsPerDay, expectedSectionsPerDay, "sections per day preserved");
    importedDays.forEach((day) => {
      getProgramExercises(day.id).forEach((exercise) => {
        assert.equal(exercise.dayId, day.id);
        assert.ok(exercise.sectionId, "each exercise keeps a section");
      });
    });
  }

  console.warn = originalWarn;
  console.log("Program H1 import verification passed.");
} catch (error) {
  console.warn = originalWarn;
  throw error;
}
