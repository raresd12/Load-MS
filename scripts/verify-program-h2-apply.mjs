// Phase H2 Track A: draft -> program storage (decisions H2-1, H2-2).
// - saveProgramDraft creates a NEW inactive custom program in one batch,
//   Library add-only, warm-up per day, persisted loadType / weightMode.
// - applyProgramDraft updates the EXISTING custom program in place: kept ids,
//   removed baseline / progression rows, changed prescription -> progression
//   deleted (19.4-2), unchanged kept, state day pointers repaired, sessions
//   untouched, defaults refused.
// - getProgramDayViewModels: persisted profile wins, legacy derivation
//   unchanged for default programs; exportProgramShare / strict validation
//   carry the enums and ignore draftMeta.
import assert from "node:assert/strict";

class MemoryLocalStorage {
  constructor() {
    this.store = new Map();
    this.failOn = null;
  }

  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  setItem(key, value) {
    if (this.failOn && this.failOn(key, String(value))) {
      throw new Error("QuotaExceededError (simulated)");
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

const { STORAGE_KEYS, readStorage } = await import("../src/lib/storage.js");
const {
  applyProgramDraft,
  ATHLETIC_AESTHETIC_BASKETBALL_PROGRAM_ID,
  DEFAULT_PROGRAM_ID,
  duplicateProgram,
  exportProgramShare,
  getActiveProgramId,
  getBuiltInExerciseConfig,
  getExerciseById,
  getExerciseLibrary,
  getPrograms,
  getProgramBaseline,
  getProgramDays,
  getProgramDayViewModels,
  getProgramExercises,
  getProgramProgression,
  getProgramSections,
  getProgramState,
  removeExerciseFromNextPlans,
  resolveProgramExerciseLoadProfile,
  saveProgramDraft,
  seedDefaultProgramIfNeeded,
  updateProgramState,
  validateProgramShareStrict,
} = await import("../src/lib/programStorage.js");
const {
  addDay,
  addExercise,
  createBlankProgramDraft,
  diffDraftAgainstProgram,
  draftFromProgram,
  proposeNewLibraryExercise,
  remapExercise,
  removeDay,
  removeExercise,
  updateExercise,
  updateProgramMeta,
  updateWarmup,
} = await import("../src/lib/programDraft.js");

const snapshotKeys = () =>
  Object.fromEntries([...storage.store.entries()].filter(([key]) => !key.includes(".corrupt-")));
const assertSameSnapshot = (actual, expected, message) => {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${message} (key set)`);
  Object.keys(expected).forEach((key) => {
    assert.equal(actual[key] === expected[key], true, `${message}: ${key} changed`);
  });
};
const read = (key) => readStorage(key, []);
const { generateNextPlan, getPlanForDay } = await import("../src/lib/progression.js");
const { getPlanSlotSignature } = await import("../src/lib/workoutDraft.js");
const normalizeName = (value) => String(value ?? "").trim().toLowerCase();

/**
 * The logging path as App.jsx builds it: day view model -> base plan
 * (getPlanForDay) / generated plan (generateNextPlan) -> one set-slot list per
 * plan exercise (createDraft keys slots by exercise id and sizes them by the
 * plan's sets). None of it may carry a warm-up item.
 */
function assertWarmupNeverLogged(programId, dayId, expectedWarmupNames) {
  const dayView = getProgramDayViewModels(programId).find((day) => day.id === dayId);
  assert.ok(dayView, "day view model exists");
  const warmupNames = (dayView.warmup?.items ?? []).map((item) => item.name);
  assert.deepEqual(warmupNames, expectedWarmupNames, "the warm-up is carried on the day view model");
  const warmupKeys = new Set(warmupNames.map(normalizeName));
  const isWarmupDerived = (candidate) =>
    warmupKeys.has(normalizeName(candidate?.name)) ||
    warmupKeys.has(normalizeName(candidate?.exerciseId)) ||
    warmupKeys.has(normalizeName(candidate?.libraryExerciseId)) ||
    warmupKeys.has(normalizeName(candidate?.id));

  const stored = getProgramExercises(dayId);
  assert.ok(stored.length > 0, "the day has working exercises");
  assert.equal(stored.some(isWarmupDerived), false, "no ProgramExercise was made from a warm-up item");
  assert.equal(getExerciseLibrary().some(isWarmupDerived), false, "no Library entry was made from a warm-up item");
  (dayView.warmup?.items ?? []).forEach((item) => {
    assert.equal(getExerciseById(item.id), null, `warm-up item id ${item.id} is not a Library id`);
    assert.equal(stored.some((exercise) => exercise.id === item.id || exercise.exerciseId === item.id), false);
  });
  assert.deepEqual(dayView.exercises.map((exercise) => exercise.id), stored.map((exercise) => exercise.id), "view-model exercises = stored program exercises, nothing more");
  assert.equal(dayView.exercises.some(isWarmupDerived), false);
  assert.equal(dayView.type, "training");

  const basePlan = getPlanForDay(dayView, null);
  assert.deepEqual(basePlan.exercises.map((exercise) => exercise.exerciseId), stored.map((exercise) => exercise.id), "the base plan has one entry per working exercise");
  assert.equal(basePlan.exercises.some(isWarmupDerived), false, "no warm-up item in the base plan");
  const session = {
    id: `gate-${dayId}`,
    schemaVersion: 3,
    programId,
    dayId,
    dayName: dayView.name,
    date: "2026-09-26",
    sessionRpe: 7,
    readiness: { status: "green", averageScore: 4.2, isGood: true, isPoor: false },
    exercises: {},
  };
  const generated = generateNextPlan(dayView, session, []);
  assert.deepEqual(generated.exercises.map((exercise) => exercise.exerciseId), stored.map((exercise) => exercise.id), "the generated plan has one entry per working exercise");
  assert.equal(generated.exercises.some(isWarmupDerived), false, "no warm-up item in the generated plan");
  const merged = getPlanForDay(dayView, generated);
  assert.equal(merged.exercises.some(isWarmupDerived), false);
  assert.equal(getPlanSlotSignature(merged), stored.map((exercise) => `${exercise.id}:${exercise.targetSets}`).join("|"), "set slots come from the working exercises only");
  const setSlots = Object.fromEntries(
    dayView.exercises.map((exercise) => {
      const planExercise = merged.exercises.find((entry) => entry.exerciseId === exercise.id);
      return [exercise.id, Array.from({ length: planExercise?.sets ?? exercise.sets }, () => ({ reps: "", weight: "", rpe: "" }))];
    }),
  );
  assert.deepEqual(Object.keys(setSlots), stored.map((exercise) => exercise.id), "one set-slot list per working exercise");
  assert.equal(Object.keys(setSlots).some((id) => warmupKeys.has(normalizeName(id))), false);
  Object.values(setSlots).forEach((slots) => assert.ok(slots.length >= 1));
}

try {
  seedDefaultProgramIfNeeded();
  const activeBefore = getActiveProgramId();

  // ------------------------------------------------------------------
  // H2-2: default programs derive the same profile as before H2
  // ------------------------------------------------------------------
  [DEFAULT_PROGRAM_ID, ATHLETIC_AESTHETIC_BASKETBALL_PROGRAM_ID].forEach((programId) => {
    const views = getProgramDayViewModels(programId);
    let checked = 0;

    views.forEach((day) =>
      day.exercises.forEach((exercise) => {
        const config = getBuiltInExerciseConfig(exercise.libraryExerciseId);
        const library = getExerciseById(exercise.libraryExerciseId);
        // The pre-H2 derivation, verbatim.
        const legacyLoadType = config?.loadType ?? (library?.equipment === "bodyweight" ? "bodyweight" : "external");
        const legacyWeightMode = config?.weightMode ?? "kg";
        assert.equal(exercise.loadType, legacyLoadType, `${exercise.id} load type`);
        assert.equal(exercise.weightMode, legacyWeightMode, `${exercise.id} weight mode`);
        assert.equal(exercise.sourceWeight, null);
        checked += 1;
      }),
    );
    assert.ok(checked >= 40, `${programId}: ${checked} exercises compared`);
  });
  const legacyRecord = { exerciseId: "weighted-pull-ups" };
  assert.deepEqual(resolveProgramExerciseLoadProfile(legacyRecord), {
    loadType: "optionalExternal",
    weightMode: "additional load",
    persisted: false,
  });
  assert.deepEqual(resolveProgramExerciseLoadProfile({ ...legacyRecord, loadType: "bodyweight" }), {
    loadType: "bodyweight",
    weightMode: "additional load",
    persisted: true,
  });
  assert.equal(resolveProgramExerciseLoadProfile({ ...legacyRecord, loadType: "lbs" }).loadType, "optionalExternal", "invalid stored enum falls back");

  // ------------------------------------------------------------------
  // saveProgramDraft
  // ------------------------------------------------------------------
  const invalid = saveProgramDraft(createBlankProgramDraft());
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, "invalid");
  assert.equal(invalid.programId, null);
  assert.deepEqual(invalid.errors.map((entry) => entry.path), ["program.name"]);
  assert.match(invalid.error, /Program name is required/);

  const libraryCountBefore = read(STORAGE_KEYS.exerciseLibrary).length;
  const benchBefore = JSON.stringify(getExerciseById("bench-press"));
  let draft = updateProgramMeta(createBlankProgramDraft(), { name: "Studio Push", description: "made by hand" });
  const dayId = draft.days[0].id;
  const sectionId = draft.days[0].sections[0].id;
  draft = updateWarmup(draft, dayId, { title: "Prep", items: [{ name: "Bike", prescription: "5 min" }] });
  draft = addExercise(draft, dayId, sectionId, { exerciseId: "bench-press", targetSets: 4, sourceWeight: "80 kg" });
  draft = addExercise(draft, dayId, sectionId, { exerciseId: "weighted-pull-ups", loadType: "bodyweight" });
  draft = addExercise(draft, dayId, sectionId, { name: "Sled Push", targetReps: { label: "20 m" } });
  const sledId = draft.days[0].sections[0].exercises[2].id;
  draft = proposeNewLibraryExercise(draft, dayId, sledId, { category: "athletic", equipment: "sled" });
  // A proposal whose id already exists locally must not overwrite the local entry.
  draft = {
    ...draft,
    libraryExercises: [...draft.libraryExercises, { id: "bench-press", name: "Overwritten Bench" }],
  };
  draft = addDay(draft, { name: "Recovery", isOptional: true });

  const beforeSave = snapshotKeys();
  storage.failOn = (key) => key === STORAGE_KEYS.programStates;
  const failed = saveProgramDraft(draft);
  storage.failOn = null;
  assert.equal(failed.ok, false);
  assert.equal(failed.programId, null);
  assertSameSnapshot(snapshotKeys(), beforeSave, "a failed batch leaves every key as it was");

  const saved = saveProgramDraft(draft);
  assert.equal(saved.ok, true, saved.error);
  assert.ok(saved.programId.startsWith("program-draft-"));
  assert.equal(saved.dayCount, 2);
  assert.equal(saved.exerciseCount, 3);
  assert.equal(saved.addedLibraryExerciseCount, 1);
  const savedProgram = getPrograms().find((program) => program.id === saved.programId);
  assert.equal(savedProgram.isDefault, false);
  assert.equal(savedProgram.isArchived, false);
  assert.equal(savedProgram.name, "Studio Push");
  assert.equal(savedProgram.nickname, "Studio Push");
  assert.equal(savedProgram.description, "made by hand");
  assert.equal(getActiveProgramId(), activeBefore, "saving never activates the program");
  const savedDays = getProgramDays(saved.programId);
  assert.deepEqual(savedDays.map((day) => [day.name, day.orderIndex]), [
    ["Day 1", 0],
    ["Recovery", 1],
  ]);
  assert.equal(savedDays[0].warmup.items[0].name, "Bike");
  assert.equal(savedDays[1].isOptional, true);
  assert.equal(savedDays[1].warmup, undefined);
  assert.equal(getProgramSections(savedDays[0].id).length, 1);
  assert.equal(getProgramSections(savedDays[1].id).length, 1, "a recovery day keeps its empty section");
  const savedExercises = getProgramExercises(savedDays[0].id);
  assert.deepEqual(
    savedExercises.map((exercise) => [exercise.exerciseId, exercise.orderIndex, exercise.loadType, exercise.weightMode]),
    [
      ["bench-press", 0, "external", "kg"],
      ["weighted-pull-ups", 1, "bodyweight", "additional load"],
      [draft.libraryExercises[0].id, 2, "external", "kg"],
    ],
  );
  assert.equal(savedExercises[0].sourceWeight, "80 kg");
  assert.equal(savedExercises[0].targetWeight, null, "H2-4: the listed weight is not a target");
  assert.equal(savedExercises[1].sourceWeight, undefined);
  assert.equal(savedExercises[0].sectionId, getProgramSections(savedDays[0].id)[0].id);
  assert.equal(savedExercises[0].id, `${saved.programId}:exercise-1-bench-press`);
  assert.equal(read(STORAGE_KEYS.exerciseLibrary).length, libraryCountBefore + 1);
  assert.equal(JSON.stringify(getExerciseById("bench-press")), benchBefore, "existing Library entries are never overwritten");
  assert.equal(getExerciseById(draft.libraryExercises[0].id).name, "Sled Push");
  assert.equal(getProgramBaseline(saved.programId, savedExercises[0].id), null, "no baseline rows");
  assert.equal(getProgramProgression(saved.programId, savedExercises[0].id), null, "no progression rows");
  const savedState = getProgramState(saved.programId);
  assert.equal(savedState.lastCompletedDayId, null);
  assert.equal(savedState.nextRecommendedDayId, savedDays[0].id);
  assert.equal(savedState.currentWeek, 1);

  const savedViews = getProgramDayViewModels(saved.programId);
  assert.equal(savedViews[0].exercises[1].loadType, "bodyweight", "persisted profile wins over the config");
  assert.equal(savedViews[0].exercises[0].sourceWeight, "80 kg");
  assert.equal(savedViews[0].warmup.items.length, 1);
  assert.equal(savedViews[1].type, "recovery");

  // H2 gate (fix round 3): "Warm-up never appears in working-set logging".
  // The program saved from a draft with warm-up items yields no program
  // exercise, no Library entry, no day view-model exercise, no base / generated
  // plan entry and no session set slot derived from a warm-up item; the
  // warm-up travels on the day view model only.
  assertWarmupNeverLogged(saved.programId, savedDays[0].id, ["Bike"]);

  const share = exportProgramShare(saved.programId);
  assert.equal(share.programExercises[1].loadType, "bodyweight");
  assert.equal(share.programExercises[1].weightMode, "additional load");
  assert.equal(share.programExercises[0].sourceWeight, "80 kg");
  assert.equal(validateProgramShareStrict(share).valid, true);
  assert.equal(validateProgramShareStrict({ ...share, draftMeta: { provenance: {} } }).valid, true);
  assert.equal(
    validateProgramShareStrict({
      ...share,
      programExercises: share.programExercises.map((exercise, index) => (index === 0 ? { ...exercise, weightMode: "lbs" } : exercise)),
    }).valid,
    false,
  );
  assert.equal(
    validateProgramShareStrict({
      ...share,
      programExercises: share.programExercises.map((exercise, index) => (index === 0 ? { ...exercise, sourceWeight: 80 } : exercise)),
    }).valid,
    false,
    "source weight must be text",
  );
  // Corrupt key: refused, nothing written.
  storage.setItem(STORAGE_KEYS.baselines, "{not json");
  const beforeCorrupt = snapshotKeys();
  const corrupt = saveProgramDraft(draft);
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.code, "corrupt");
  assert.deepEqual(corrupt.corruptKeys, [STORAGE_KEYS.baselines]);
  assertSameSnapshot(snapshotKeys(), beforeCorrupt, "corrupt refusal writes nothing");
  storage.setItem(STORAGE_KEYS.baselines, beforeSave[STORAGE_KEYS.baselines]);
  storage.removeItem(`${STORAGE_KEYS.baselines}.corrupt-1`);

  // ------------------------------------------------------------------
  // applyProgramDraft
  // ------------------------------------------------------------------
  const copy = duplicateProgram(DEFAULT_PROGRAM_ID);
  assert.equal(copy.ok, true);
  const programId = copy.programId;
  const days = getProgramDays(programId);
  const dayOne = days[0];
  const dayOneExercises = getProgramExercises(dayOne.id);
  const [keptEx, changedEx, removedEx] = dayOneExercises;
  const removedDay = days[1];
  const removedDayExercises = getProgramExercises(removedDay.id);
  assert.ok(getProgramBaseline(programId, removedEx.id), "the copy has baselines");
  assert.ok(getProgramProgression(programId, keptEx.id), "the copy has fresh progressions");
  updateProgramState(programId, { lastCompletedDayId: removedDay.id, nextRecommendedDayId: removedDay.id });
  const sessions = [{ id: "s1", programId, dayId: dayOne.id, exercises: [] }];
  storage.setItem(STORAGE_KEYS.sessions, JSON.stringify(sessions));
  const nextPlans = {
    [dayOne.id]: { exercises: [{ exerciseId: keptEx.id }, { exerciseId: changedEx.id }, { exerciseId: removedEx.id }] },
  };

  const protectedDraft = { ...draftFromProgram(programId).draft, sourceProgramId: DEFAULT_PROGRAM_ID };
  const refused = applyProgramDraft(protectedDraft);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "protected");
  assert.equal(applyProgramDraft({ ...protectedDraft, sourceProgramId: "missing" }).code, "not-found");
  assert.equal(applyProgramDraft({ ...protectedDraft, sourceProgramId: null }).ok, false);

  let edit = draftFromProgram(programId).draft;
  const sectionOne = edit.days[0].sections[0].id;
  edit = updateProgramMeta(edit, { name: "Edited Copy" });
  edit = updateExercise(edit, dayOne.id, changedEx.id, { targetSets: changedEx.targetSets + 1 });
  edit = updateExercise(edit, dayOne.id, keptEx.id, { notes: "cue: elbows" });
  edit = removeExercise(edit, dayOne.id, removedEx.id);
  edit = addExercise(edit, dayOne.id, sectionOne, { exerciseId: "bench-press", index: 0 });
  edit = removeDay(edit, removedDay.id);
  edit = addDay(edit, { name: "New Day" });
  edit = addExercise(edit, edit.days.at(-1).id, edit.days.at(-1).sections[0].id, { exerciseId: "dips" });
  const invalidEdit = applyProgramDraft(updateExercise(edit, dayOne.id, keptEx.id, { targetSets: 0 }));
  assert.equal(invalidEdit.ok, false);
  assert.equal(invalidEdit.code, "invalid");
  assert.equal(invalidEdit.programId, programId);

  const beforeApply = snapshotKeys();
  storage.failOn = (key) => key === STORAGE_KEYS.programExercises;
  const failedApply = applyProgramDraft(edit);
  storage.failOn = null;
  assert.equal(failedApply.ok, false);
  assertSameSnapshot(snapshotKeys(), beforeApply, "a failed apply leaves every key as it was");

  const applied = applyProgramDraft(edit);
  assert.equal(applied.ok, true, applied.error);
  assert.equal(applied.programId, programId);
  assert.deepEqual(applied.summary, {
    added: 2,
    removed: 1 + removedDayExercises.length,
    changed: 1,
    kept: dayOneExercises.length - 2 + days.slice(2).reduce((total, day) => total + getProgramExercises(day.id).length, 0),
  });
  assert.deepEqual([...applied.removedProgramExerciseIds].sort(), [removedEx.id, ...removedDayExercises.map((exercise) => exercise.id)].sort());
  assert.deepEqual(applied.changedProgramExerciseIds, [changedEx.id]);
  assert.deepEqual(applied.removedDayIds, [removedDay.id]);

  const program = getPrograms().find((entry) => entry.id === programId);
  assert.equal(program.name, "Edited Copy");
  assert.equal(program.createdAt, copy.program.createdAt);
  assert.equal(program.isDefault, false);
  assert.equal(program.isArchived, false);
  const newDays = getProgramDays(programId);
  assert.deepEqual(newDays.slice(0, 4).map((day) => day.id), [dayOne.id, ...days.slice(2).map((day) => day.id)], "surviving day ids are kept");
  assert.equal(newDays.at(-1).name, "New Day");
  assert.ok(newDays.at(-1).id.startsWith(`${programId}:day-`));
  assert.deepEqual(newDays.map((day) => day.orderIndex), [0, 1, 2, 3, 4]);
  assert.equal(newDays[0].warmup.items.length, dayOne.warmup.items.length, "warm-up survives");
  // H2 gate: the applied edit keeps the warm-up informational too.
  assertWarmupNeverLogged(programId, dayOne.id, dayOne.warmup.items.map((item) => item.name));
  assert.equal(getProgramSections(dayOne.id)[0].id, sectionOne, "section id kept");

  const newDayOne = getProgramExercises(dayOne.id);
  assert.equal(newDayOne[0].exerciseId, "bench-press");
  assert.ok(newDayOne[0].id.startsWith(`${programId}:exercise-`), "added exercise gets a fresh id in the program namespace");
  assert.notEqual(newDayOne[0].id, keptEx.id);
  assert.deepEqual(newDayOne.slice(1, 3).map((exercise) => exercise.id), [keptEx.id, changedEx.id], "kept ids");
  assert.deepEqual(newDayOne.map((exercise) => exercise.orderIndex), newDayOne.map((_, index) => index));
  assert.equal(newDayOne[1].notes, "cue: elbows");
  assert.equal(newDayOne[1].loadType, "external", "profile is now persisted on kept records");
  assert.equal(newDayOne[2].targetSets, changedEx.targetSets + 1);
  assert.equal(newDayOne.some((exercise) => exercise.id === removedEx.id), false);
  assert.equal(getProgramExercises(removedDay.id).length, 0);
  assert.equal(getProgramSections(removedDay.id).length, 0);

  assert.ok(getProgramBaseline(programId, keptEx.id), "kept exercise keeps its baseline");
  assert.ok(getProgramBaseline(programId, changedEx.id), "changed exercise keeps its baseline");
  assert.equal(getProgramBaseline(programId, removedEx.id), null, "removed exercise loses its baseline");
  assert.equal(getProgramBaseline(programId, removedDayExercises[0].id), null);
  assert.ok(getProgramProgression(programId, keptEx.id), "notes-only edit keeps the progression");
  assert.equal(getProgramProgression(programId, changedEx.id), null, "19.4-2: changed prescription deletes the progression");
  assert.equal(getProgramProgression(programId, removedEx.id), null);
  assert.equal(getProgramProgression(programId, removedDayExercises[0].id), null);
  assert.equal(read(STORAGE_KEYS.programProgressions).some((row) => row.programId !== programId && row.programExerciseId === removedEx.id), false);
  assert.ok(read(STORAGE_KEYS.programProgressions).some((row) => row.programId === DEFAULT_PROGRAM_ID), "other programs untouched");

  const state = getProgramState(programId);
  assert.equal(state.lastCompletedDayId, null, "pointer to a removed day is cleared");
  assert.equal(state.nextRecommendedDayId, dayOne.id, "next day falls back to the first day");
  assert.deepEqual(read(STORAGE_KEYS.sessions), sessions, "workout sessions are never touched");

  let plans = nextPlans;
  [...applied.removedProgramExerciseIds, ...applied.changedProgramExerciseIds].forEach((id) => {
    plans = removeExerciseFromNextPlans(plans, id);
  });
  assert.deepEqual(plans, { [dayOne.id]: { exercises: [{ exerciseId: keptEx.id }] } }, "the UI clears pending plan entries with the returned ids");

  // A second apply without changes is a no-op for progressions and keeps ids.
  const again = applyProgramDraft(draftFromProgram(programId).draft);
  assert.equal(again.ok, true);
  assert.deepEqual(again.summary, { added: 0, removed: 0, changed: 0, kept: newDays.reduce((total, day) => total + getProgramExercises(day.id).length, 0) });
  assert.ok(getProgramProgression(programId, keptEx.id));
  assert.deepEqual(getProgramExercises(dayOne.id).map((exercise) => exercise.id), newDayOne.map((exercise) => exercise.id));

  // ------------------------------------------------------------------
  // Fix round 1: corrupt programs key, Library remap (H2-5), retired ids,
  // derived reps labels
  // ------------------------------------------------------------------
  // (1) An unreadable programs key reports "corrupt", never "not found".
  const corruptDraft = draftFromProgram(programId).draft;
  const programsBefore = storage.getItem(STORAGE_KEYS.programs);
  storage.setItem(STORAGE_KEYS.programs, "{not json");
  const corruptApply = applyProgramDraft(corruptDraft);
  assert.equal(corruptApply.ok, false);
  assert.equal(corruptApply.code, "corrupt");
  assert.deepEqual(corruptApply.corruptKeys, [STORAGE_KEYS.programs]);
  assert.equal(corruptApply.programId, programId);
  assert.match(corruptApply.error, /Nothing was written/);
  assert.equal(storage.getItem(STORAGE_KEYS.programs), "{not json", "nothing written over the unreadable key");
  storage.setItem(STORAGE_KEYS.programs, programsBefore);
  storage.removeItem(`${STORAGE_KEYS.programs}.corrupt-1`);

  // (2) A Library remap on a kept id is remove + add: the old occurrence
  // (its baseline, progression and logged history) stays behind under the
  // old id, the new occurrence gets a new id and starts from its targets.
  const remapDay = getProgramDays(programId)[0];
  const remapTarget = getProgramExercises(remapDay.id).find((exercise) => exercise.id === keptEx.id);
  assert.ok(remapTarget && getProgramBaseline(programId, keptEx.id) && getProgramProgression(programId, keptEx.id));
  const remapTo = keptEx.exerciseId === "dips" ? "bench-press" : "dips";
  const totalBeforeRemap = getProgramDays(programId).reduce((total, day) => total + getProgramExercises(day.id).length, 0);
  const remapDraft = remapExercise(draftFromProgram(programId).draft, remapDay.id, keptEx.id, remapTo);
  const remapDiff = diffDraftAgainstProgram(remapDraft);
  assert.deepEqual(remapDiff.exercises.removed.map((exercise) => exercise.id), [keptEx.id], "the review shows the old occurrence as removed");
  assert.equal(remapDiff.exercises.added.length, 1);
  assert.equal(remapDiff.exercises.added[0].replaces.id, keptEx.id, "...and the new one as its replacement");
  assert.deepEqual(remapDiff.exercises.changed, []);
  const remapped = applyProgramDraft(remapDraft);
  assert.equal(remapped.ok, true, remapped.error);
  assert.deepEqual(remapped.summary, { added: 1, removed: 1, changed: 0, kept: totalBeforeRemap - 1 });
  assert.deepEqual(remapped.removedProgramExerciseIds, [keptEx.id]);
  assert.deepEqual(remapped.changedProgramExerciseIds, []);
  const remappedRecord = getProgramExercises(remapDay.id).find((exercise) => exercise.orderIndex === remapTarget.orderIndex);
  assert.equal(remappedRecord.exerciseId, remapTo);
  assert.notEqual(remappedRecord.id, keptEx.id, "a remapped exercise is a new occurrence");
  assert.ok(remappedRecord.id.startsWith(`${programId}:exercise-`));
  assert.equal(getProgramExercises(remapDay.id).some((exercise) => exercise.id === keptEx.id), false);
  assert.equal(getProgramBaseline(programId, keptEx.id), null, "the old occurrence's baseline goes with it");
  assert.equal(getProgramProgression(programId, keptEx.id), null, "and so does its progression");
  assert.equal(getProgramBaseline(programId, remappedRecord.id), null, "the new occurrence starts from its targets");
  assert.equal(getProgramProgression(programId, remappedRecord.id), null);

  // (3) An id that a workout session still references is retired for good:
  // removing the exercise and adding the same Library exercise at the same
  // ordinal never mints the old id again (no inherited history). Same for a
  // day id. A retired id nobody references may be reused (deterministic ids).
  let retireDraft = updateProgramMeta(createBlankProgramDraft(), { name: "Retire" });
  retireDraft = addExercise(retireDraft, retireDraft.days[0].id, retireDraft.days[0].sections[0].id, { exerciseId: "bench-press" });
  retireDraft = addExercise(retireDraft, retireDraft.days[0].id, retireDraft.days[0].sections[0].id, { exerciseId: "dips" });
  const retireSaved = saveProgramDraft(retireDraft);
  assert.equal(retireSaved.ok, true, retireSaved.error);
  const retireId = retireSaved.programId;
  const retireDay = getProgramDays(retireId)[0];
  const [retireBench] = getProgramExercises(retireDay.id);
  assert.equal(retireBench.id, `${retireId}:exercise-1-bench-press`);
  const retireSection = () => draftFromProgram(retireId).draft.days[0].sections[0].id;
  // Unreferenced: removing and re-adding at the same ordinal reuses the deterministic id.
  assert.equal(applyProgramDraft(removeExercise(draftFromProgram(retireId).draft, retireDay.id, retireBench.id)).ok, true);
  assert.equal(
    applyProgramDraft(addExercise(draftFromProgram(retireId).draft, retireDay.id, retireSection(), { exerciseId: "bench-press", index: 0 })).ok,
    true,
  );
  assert.equal(getProgramExercises(retireDay.id)[0].id, retireBench.id, "an id nothing references may come back");
  // Referenced by a logged session: retired for good.
  storage.setItem(
    STORAGE_KEYS.sessions,
    JSON.stringify([
      ...read(STORAGE_KEYS.sessions),
      {
        id: "s2",
        programId: retireId,
        dayId: retireDay.id,
        exercises: [{ programExerciseId: retireBench.id, sets: [{ programExerciseId: retireBench.id, reps: 8, weight: 60 }] }],
      },
    ]),
  );
  const dropBench = applyProgramDraft(removeExercise(draftFromProgram(retireId).draft, retireDay.id, retireBench.id));
  assert.equal(dropBench.ok, true, dropBench.error);
  assert.deepEqual(dropBench.removedProgramExerciseIds, [retireBench.id]);
  const readd = applyProgramDraft(
    addExercise(draftFromProgram(retireId).draft, retireDay.id, retireSection(), { exerciseId: "bench-press", index: 0 }),
  );
  assert.equal(readd.ok, true, readd.error);
  const reAdded = getProgramExercises(retireDay.id)[0];
  assert.equal(reAdded.exerciseId, "bench-press");
  assert.notEqual(reAdded.id, retireBench.id, "an id a session still references is never minted again");
  assert.ok(reAdded.id.startsWith(`${retireId}:exercise-1-bench-press`));
  assert.equal(getProgramExercises(retireDay.id)[1].id, `${retireId}:exercise-2-dips`, "the untouched exercise keeps its id");
  // (3b) The guard needs every referenced-id key readable (H2-13): with the
  // sessions, workout drafts or next plans key unreadable, apply refuses
  // ("corrupt", nothing written) instead of minting an id the quarantined
  // records still reference.
  [STORAGE_KEYS.sessions, STORAGE_KEYS.workoutDrafts, STORAGE_KEYS.nextPlans].forEach((key) => {
    const intact = storage.getItem(key);
    storage.setItem(key, "{not json");
    const beforeRefusal = snapshotKeys();
    const refused = applyProgramDraft(
      addExercise(draftFromProgram(retireId).draft, retireDay.id, retireSection(), { exerciseId: "bench-press", index: 0 }),
    );
    assert.equal(refused.ok, false, `${key}: apply is refused while the key is unreadable`);
    assert.equal(refused.code, "corrupt");
    assert.deepEqual(refused.corruptKeys, [key]);
    assert.match(refused.error, /Nothing was written/);
    assertSameSnapshot(snapshotKeys(), beforeRefusal, `${key}: nothing written`);
    if (intact === null) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, intact);
    }
    [...storage.store.keys()].filter((name) => name.startsWith(`${key}.corrupt-`)).forEach((name) => storage.removeItem(name));
  });
  assert.equal(applyProgramDraft(draftFromProgram(retireId).draft).ok, true, "apply works again once every key is readable");
  // ...and the same for day ids.
  const withTemp = applyProgramDraft(addDay(draftFromProgram(retireId).draft, { name: "Temp" }));
  assert.equal(withTemp.ok, true, withTemp.error);
  const tempDay = getProgramDays(retireId).at(-1);
  assert.equal(tempDay.name, "Temp");
  assert.equal(tempDay.id, `${retireId}:day-2`);
  storage.setItem(STORAGE_KEYS.sessions, JSON.stringify([...read(STORAGE_KEYS.sessions), { id: "s3", programId: retireId, dayId: tempDay.id, exercises: [] }]));
  const dropTemp = applyProgramDraft(removeDay(draftFromProgram(retireId).draft, tempDay.id));
  assert.deepEqual(dropTemp.removedDayIds, [tempDay.id]);
  const withOther = applyProgramDraft(addDay(draftFromProgram(retireId).draft, { name: "Other" }));
  assert.equal(withOther.ok, true, withOther.error);
  const otherDay = getProgramDays(retireId).at(-1);
  assert.equal(otherDay.name, "Other");
  assert.notEqual(otherDay.id, tempDay.id, "a day id a session still references is never minted again");
  assert.ok(otherDay.id.startsWith(`${retireId}:day-2`));

  // (4) A reps label that only repeats the range ("8-12" on 8-12) is not a
  // prescription change: toggling it keeps the progression.
  const derivedLabel = (reps) => (reps.min === reps.max ? String(reps.min) : `${reps.min}-${reps.max}`);
  const labelDay = getProgramDays(programId).find((day) =>
    getProgramExercises(day.id).some(
      (exercise) =>
        exercise.targetReps?.min != null &&
        exercise.targetReps?.max != null &&
        (!exercise.targetReps.label || exercise.targetReps.label === derivedLabel(exercise.targetReps)) &&
        getProgramProgression(programId, exercise.id),
    ),
  );
  const labelTarget = getProgramExercises(labelDay.id).find(
    (exercise) =>
      exercise.targetReps?.min != null &&
      exercise.targetReps?.max != null &&
      (!exercise.targetReps.label || exercise.targetReps.label === derivedLabel(exercise.targetReps)) &&
      getProgramProgression(programId, exercise.id),
  );
  const progressionBefore = JSON.stringify(getProgramProgression(programId, labelTarget.id));
  const toggledLabel = labelTarget.targetReps.label ? null : derivedLabel(labelTarget.targetReps);
  const labelDraft = updateExercise(draftFromProgram(programId).draft, labelDay.id, labelTarget.id, {
    targetReps: { ...labelTarget.targetReps, label: toggledLabel },
  });
  assert.deepEqual(diffDraftAgainstProgram(labelDraft).exercises.changed, [], "a derived label is not a change in the review");
  const labelApply = applyProgramDraft(labelDraft);
  assert.equal(labelApply.ok, true, labelApply.error);
  assert.equal(labelApply.summary.changed, 0, "a derived label never resets a progression");
  assert.equal(JSON.stringify(getProgramProgression(programId, labelTarget.id)), progressionBefore);

  console.log("verify-program-h2-apply: ok");
} catch (error) {
  console.error("verify-program-h2-apply: FAIL");
  console.error(error);
  process.exit(1);
}
