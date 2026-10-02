// Phase H5 Track A: optional days, week and cycle (decision H5-5), the
// program / exercise profile writers and validators (H5-1, H5-3) and the
// share round trip of the new program fields.
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

const storage = new MemoryLocalStorage();
globalThis.window = { localStorage: storage };
console.warn = () => {};

const { readStorage, STORAGE_KEYS, writeStorage } = await import("../src/lib/storage.js");
const {
  collectProgramExerciseProfileErrors,
  collectProgramProfileErrors,
  DEFAULT_PROGRAM_ID,
  deriveProgramStatePatchFromSessions,
  duplicateProgram,
  exportProgramShare,
  getProgramDays,
  getProgramDayViewModels,
  getProgramProgression,
  getProgramState,
  getPrograms,
  getScheduledProgramDays,
  importProgramShare,
  persistWorkoutSave,
  seedDefaultProgramIfNeeded,
  findMeasurementTargetConflict,
  updateProgramExerciseProfileChecked,
  updateProgramExerciseTargetChecked,
  updateProgramProfileChecked,
  validateProgramShareStrict,
} = await import("../src/lib/programStorage.js");
const { buildExerciseProfile } = await import("../src/lib/progression.js");
const { getExerciseOverride, setExerciseOverrideChecked } = await import("../src/lib/overrides.js");

// --- pure derivation ----------------------------------------------------------------
const days = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d", isOptional: true }];
assert.deepEqual(getScheduledProgramDays(days).map((day) => day.id), ["a", "b", "c"]);
assert.deepEqual(getScheduledProgramDays([{ id: "x", isOptional: true }]).map((day) => day.id), ["x"], "all optional: all scheduled");

let clock = 0;
const s = (dayId, programId = "p") => ({ id: `s${clock}`, programId, dayId, date: new Date(Date.UTC(2026, 8, 1) + clock++ * 86400000).toISOString(), exercises: {}, workoutSets: [] });
const derive = (sessions, options = { cycleWeeks: null }) => deriveProgramStatePatchFromSessions("p", sessions, days, options);

assert.deepEqual(derive([]), { lastCompletedDayId: null, nextRecommendedDayId: "a", lastWorkoutDate: null, currentWeek: 1, currentCycle: 1 });
const a1 = s("a");
assert.equal(derive([a1]).nextRecommendedDayId, "b");
assert.equal(derive([a1]).currentWeek, 1);
const b1 = s("b");
const c1 = s("c");
const pass1 = derive([a1, b1, c1]);
assert.equal(pass1.nextRecommendedDayId, "a", "after the last scheduled day the pointer wraps");
assert.equal(pass1.currentWeek, 2, "one full pass = week 2");
assert.equal(pass1.currentCycle, 1);
const d1 = s("d");
const afterOptional = derive([a1, b1, c1, d1]);
assert.equal(afterOptional.lastCompletedDayId, "d", "the optional day is recorded as completed");
assert.equal(afterOptional.lastWorkoutDate, d1.date);
assert.equal(afterOptional.nextRecommendedDayId, "a", "completing an optional day does not advance the pointer");
assert.equal(afterOptional.currentWeek, 2, "and does not count towards a pass");
clock = 10;
const a2 = s("a");
const b2 = s("b");
const d2 = s("d");
assert.equal(derive([a1, b1, c1, d1, a2, b2, d2]).nextRecommendedDayId, "c", "optional day in the middle: the due scheduled day stays next");
assert.equal(derive([a1, b1, c1, a2, b2, d2]).currentWeek, 2);
assert.equal(derive([a1, a2, b1, c1].map((entry, index) => ({ ...entry, id: `r${index}` }))).currentWeek, 2, "a repeated day counts once per pass");
assert.equal(derive([s("b"), s("a"), s("c")]).currentWeek, 2, "any order completes a pass");
clock = 20;
const c2 = s("c");
const twoPasses = [a1, b1, c1, a2, b2, c2];
assert.deepEqual(derive(twoPasses), { lastCompletedDayId: "c", nextRecommendedDayId: "a", lastWorkoutDate: c2.date, currentWeek: 3, currentCycle: 1 });
assert.deepEqual(derive(twoPasses, { cycleWeeks: 2 }), { lastCompletedDayId: "c", nextRecommendedDayId: "a", lastWorkoutDate: c2.date, currentWeek: 1, currentCycle: 2 }, "two-week cycle: the week restarts");
assert.equal(derive([a1, b1, c1], { cycleWeeks: 2 }).currentWeek, 2);
assert.equal(derive([a1, b1, c1], { cycleWeeks: 2 }).currentCycle, 1);
assert.equal(derive(twoPasses, { cycleWeeks: 1 }).currentCycle, 3);
assert.equal(derive([s("a", "other"), s("b", "other")]).currentWeek, 1, "other programs never count");
assert.equal(derive([s("a"), { id: "legacy", dayId: "b", date: "2026-09-30T00:00:00.000Z" }]).nextRecommendedDayId, "b", "a session without programId does not drive the state");
assert.equal(derive([{ ...s("zz"), id: "gone" }]).nextRecommendedDayId, "a", "a deleted day points at the first scheduled day");

// --- storage: an optional day and a cycle on a custom program --------------------------
seedDefaultProgramIfNeeded();
const copy = duplicateProgram(DEFAULT_PROGRAM_ID);
const programId = copy.programId;
const storedDays = readStorage(STORAGE_KEYS.programDays, []);
const copyDays = storedDays.filter((day) => day.programId === programId);
assert.ok(copyDays.length >= 3);
const optionalDay = copyDays.at(-1);
assert.equal(writeStorage(STORAGE_KEYS.programDays, storedDays.map((day) => (day.id === optionalDay.id ? { ...day, isOptional: true } : day))).ok, true);
const scheduledIds = getProgramDays(programId).filter((day) => !day.isOptional).map((day) => day.id);
assert.equal(scheduledIds.length, copyDays.length - 1);
assert.equal(getProgramDayViewModels(programId).at(-1).isOptional, true);

assert.equal(updateProgramProfileChecked(programId, { cycleWeeks: 0 }).ok, false);
assert.equal(updateProgramProfileChecked(programId, { cycleWeeks: 1.5 }).ok, false);
assert.equal(updateProgramProfileChecked(programId, { programProfile: { aggression: "reckless" } }).ok, false);
assert.equal(updateProgramProfileChecked(programId, { programProfile: { unit: "lb" } }).ok, false, "kg only (H5-3)");
assert.equal(updateProgramProfileChecked(programId, {}).ok, false);
assert.equal(updateProgramProfileChecked("missing", { cycleWeeks: 2 }).ok, false);
const cycled = updateProgramProfileChecked(programId, { cycleWeeks: 2, programProfile: { aggression: "conservative" } });
assert.equal(cycled.ok, true, cycled.error);
assert.equal(cycled.program.cycleWeeks, 2);
assert.deepEqual(cycled.program.programProfile, { aggression: "conservative", unit: "kg" });
assert.deepEqual(getProgramDayViewModels(programId)[0].programProfile, { aggression: "conservative", unit: "kg" });
assert.equal(getProgramDayViewModels(programId)[0].cycleWeeks, 2);
assert.deepEqual(getProgramDayViewModels(programId)[0].exercises[0].programProfile, { aggression: "conservative", unit: "kg" });
assert.equal(buildExerciseProfile(getProgramDayViewModels(programId)[0].exercises[0]).aggression, "conservative");
assert.equal(updateProgramProfileChecked(DEFAULT_PROGRAM_ID, { programProfile: { aggression: "conservative" } }).ok, true, "aggression is not a target: allowed on a default program");
assert.equal(updateProgramProfileChecked(DEFAULT_PROGRAM_ID, { programProfile: null }).ok, true);
assert.equal(getPrograms().find((program) => program.id === DEFAULT_PROGRAM_ID).programProfile, undefined);

// persistWorkoutSave recomputes the pointer, week and cycle from the sessions.
const workout = (id, dayId, date) => ({ id, schemaVersion: 6, programId, dayId, date, sessionRpe: 7, exercises: {}, workoutSets: [] });
const sessions = [];
let dateIndex = 0;
function saveDay(dayId, naiveNext) {
  const entry = workout(`w${dateIndex}`, dayId, new Date(Date.UTC(2026, 8, 1) + dateIndex++ * 86400000).toISOString());
  sessions.unshift(entry);
  const saved = persistWorkoutSave({
    sessions: [...sessions],
    nextPlans: {},
    workoutDrafts: {},
    programId,
    programStatePatch: { lastCompletedDayId: dayId, nextRecommendedDayId: naiveNext, lastWorkoutDate: entry.date },
  });
  assert.equal(saved.ok, true);
  return getProgramState(programId);
}
scheduledIds.forEach((dayId, index) => saveDay(dayId, scheduledIds[index + 1] ?? optionalDay.id));
let state = getProgramState(programId);
assert.equal(state.nextRecommendedDayId, scheduledIds[0], "the caller's naive pointer (the optional day) is replaced by the derived one");
assert.equal(state.currentWeek, 2);
assert.equal(state.currentCycle, 1);
state = saveDay(optionalDay.id, scheduledIds[0]);
assert.equal(state.lastCompletedDayId, optionalDay.id);
assert.equal(state.nextRecommendedDayId, scheduledIds[0]);
assert.equal(state.currentWeek, 2, "an optional day never advances the week");
scheduledIds.forEach((dayId, index) => saveDay(dayId, scheduledIds[index + 1] ?? scheduledIds[0]));
state = getProgramState(programId);
assert.equal(state.currentWeek, 1, "cycleWeeks 2: after two passes the week restarts");
assert.equal(state.currentCycle, 2);
// A changed cycle length re-derives the week and the cycle in the same write
// (H5-39): the card never shows a week counted under the old length ("Week 6
// of 4, cycle 1") until the next workout save.
{
  const noCycle = updateProgramProfileChecked(programId, { cycleWeeks: null });
  assert.equal(noCycle.ok, true, noCycle.error);
  assert.equal(getProgramState(programId).currentWeek, 3, "no cycle length: the absolute week after two passes");
  assert.equal(getProgramState(programId).currentCycle, 1);
  const pointer = getProgramState(programId).nextRecommendedDayId;
  const oneWeek = updateProgramProfileChecked(programId, { cycleWeeks: 1 });
  assert.equal(oneWeek.ok, true, oneWeek.error);
  assert.equal(getProgramState(programId).currentWeek, 1);
  assert.equal(getProgramState(programId).currentCycle, 3);
  assert.equal(getProgramState(programId).nextRecommendedDayId, pointer, "the day pointer is not touched by a cycle edit");
  assert.equal(updateProgramProfileChecked(programId, { cycleWeeks: 2 }).ok, true);
  assert.equal(getProgramState(programId).currentWeek, 1);
  assert.equal(getProgramState(programId).currentCycle, 2);
}
// Deleting the newest sessions (new-E) recomputes the same way.
const trimmed = sessions.slice(scheduledIds.length);
assert.equal(persistWorkoutSave({ sessions: trimmed, programId, programStatePatch: deriveProgramStatePatchFromSessions(programId, trimmed, getProgramDays(programId)) }).ok, true);
state = getProgramState(programId);
assert.equal(state.currentWeek, 2);
assert.equal(state.currentCycle, 1);
assert.equal(state.lastCompletedDayId, optionalDay.id);

// --- exercise profile writer (H5-1 / H5-3) ---------------------------------------------
const view = getProgramDayViewModels(programId)[0];
const target = view.exercises[0];
assert.equal(updateProgramExerciseProfileChecked(DEFAULT_PROGRAM_ID, getProgramDayViewModels(DEFAULT_PROGRAM_ID)[0].exercises[0].id, { perSide: true }).ok, false, "defaults are protected");
assert.equal(updateProgramExerciseProfileChecked(programId, "missing", { perSide: true }).ok, false);
assert.equal(updateProgramExerciseProfileChecked(programId, target.id, {}).ok, false);
assert.equal(updateProgramExerciseProfileChecked(programId, target.id, { measurement: "laps" }).ok, false);
assert.equal(updateProgramExerciseProfileChecked(programId, target.id, { perSide: "yes" }).ok, false);
const badIncrement = updateProgramExerciseProfileChecked(programId, target.id, { profileOverrides: { incrementKg: 0.1 } });
assert.equal(badIncrement.ok, false);
assert.match(badIncrement.error, /incrementKg override must be a number from 0.25 to 20/i);
assert.equal(updateProgramExerciseProfileChecked(programId, target.id, { profileOverrides: { roundToKg: 11 } }).ok, false);
assert.equal(updateProgramExerciseProfileChecked(programId, target.id, { profileOverrides: { rpeMaxForLoadIncrease: 4 } }).ok, false);
assert.equal(updateProgramExerciseProfileChecked(programId, target.id, { profileOverrides: { priority: "top" } }).ok, false);
assert.equal(updateProgramExerciseProfileChecked(programId, target.id, { profileOverrides: { progressionMode: "yolo" } }).ok, false);
assert.equal(updateProgramExerciseProfileChecked(programId, target.id, { profileOverrides: { bogus: 1 } }).ok, false, "unknown override field");
assert.equal(updateProgramExerciseProfileChecked(programId, target.id, { profileOverrides: { canIncreaseLoad: "no" } }).ok, false);

// A stored progression survives a profile edit that keeps the measurement
// (per side, overrides: not a prescription change).
assert.equal(persistWorkoutSave({ programId, progressionUpdates: [{ programExerciseId: target.id, patch: { lastRecommendedWeight: 62.5, updatedAt: "2026-09-10T00:00:00.000Z" } }] }).ok, true);
assert.equal(getProgramProgression(programId, target.id).lastRecommendedWeight, 62.5);
const sameUnit = updateProgramExerciseProfileChecked(programId, target.id, { perSide: true, profileOverrides: { incrementKg: 5, priority: "accessory", canIncreaseLoad: true } });
assert.equal(sameUnit.ok, true, sameUnit.error);
assert.equal(sameUnit.measurementChanged, false);
assert.equal(sameUnit.deletedProgression, false);
assert.equal(getProgramProgression(programId, target.id).lastRecommendedWeight, 62.5, "progression kept on a same-measurement edit");
// A measurement change is a unit change (decision H5-17). While the target
// is written in reps ("${target.repsLabel}"), an explicit "time" would serve it as
// seconds, so the profile writer refuses it and names the fix.
const refused = updateProgramExerciseProfileChecked(programId, target.id, { measurement: "time" });
assert.equal(refused.ok, false);
assert.match(refused.error, /does not match the target .* set the target in seconds first/i);
assert.equal(getProgramProgression(programId, target.id).lastRecommendedWeight, 62.5, "a refused edit writes nothing");
assert.equal(updateProgramExerciseProfileChecked(programId, target.id, { measurement: "reps" }).ok, true, "the matching unit is accepted");
assert.equal(findMeasurementTargetConflict({ measurement: "time", targetReps: { min: 8, max: 12, label: null } }), `measurement "time" does not match the target "8-12" (reps); set the target in seconds first.`);
assert.equal(findMeasurementTargetConflict({ measurement: "time", repsLabel: "30-45 s" }), null, "day view model shape");
assert.equal(findMeasurementTargetConflict({ measurement: "distance", targetReps: { min: null, max: null, label: null } }), null, "no target: no conflict");
assert.equal(findMeasurementTargetConflict({ targetReps: { label: "8-12" } }), null, "no explicit measurement: inference, no conflict");
// The target writer: a target typed in another unit drops the explicit
// measurement (the target's unit wins) and, as before, resets the progression
// and ends an override.
const seededOverride = setExerciseOverrideChecked({ programId, programExerciseId: target.id, mode: "manual", prescription: { targetWeight: 70 }, remainingSessions: 2, untilDate: null, note: "" }, { now: "2026-09-10T00:00:00.000Z" });
assert.equal(seededOverride.ok, true, seededOverride.error);
const retargeted = updateProgramExerciseTargetChecked(programId, target.id, { targetReps: { min: 30, max: 45, label: "30-45 s" } });
assert.equal(retargeted.ok, true, retargeted.error);
assert.equal(retargeted.clearedMeasurement, true, "explicit reps dropped by a seconds target");
assert.equal(retargeted.exercise.measurement, undefined);
assert.equal(retargeted.deletedProgression, true);
assert.equal(retargeted.clearedOverride, true);
assert.equal(getExerciseOverride(target.id, programId), null);
assert.equal(getProgramDayViewModels(programId)[0].exercises.find((entry) => entry.id === target.id).measurement, "time", "inferred from the new label");
// A stored record whose explicit measurement disagrees with its label (older
// data) changes unit when the explicit field is cleared: the earned
// progression and the override of the old unit go with it, in one batch.
const storedExercises = readStorage(STORAGE_KEYS.programExercises, []);
assert.equal(writeStorage(STORAGE_KEYS.programExercises, storedExercises.map((record) => (record.id === target.id ? { ...record, measurement: "reps" } : record))).ok, true);
assert.equal(persistWorkoutSave({ programId, progressionUpdates: [{ programExerciseId: target.id, patch: { lastRecommendedWeight: 62.5, updatedAt: "2026-09-11T00:00:00.000Z" } }] }).ok, true);
assert.equal(setExerciseOverrideChecked({ programId, programExerciseId: target.id, mode: "hold", prescription: null, remainingSessions: 2, untilDate: null, note: "" }, { now: "2026-09-11T00:00:00.000Z" }).ok, true);
const profiled = updateProgramExerciseProfileChecked(programId, target.id, { measurement: null });
assert.equal(profiled.ok, true, profiled.error);
assert.equal(profiled.measurementChanged, true);
assert.equal(profiled.deletedProgression, true);
assert.equal(profiled.clearedOverride, true);
assert.equal(getProgramProgression(programId, target.id), null, "reps progression removed with the unit");
assert.equal(getExerciseOverride(target.id, programId), null, "hold removed with the unit");
assert.equal(updateProgramExerciseProfileChecked(programId, target.id, { measurement: "time" }).ok, true, "explicit time on a seconds target");
const profiledVm = getProgramDayViewModels(programId)[0].exercises.find((entry) => entry.id === target.id);
assert.equal(profiledVm.measurement, "time");
assert.equal(profiledVm.unit, "s");
assert.equal(profiledVm.repsMin, 30);
assert.equal(profiledVm.repsMax, 45);
assert.equal(profiledVm.perSide, true);
assert.deepEqual(profiledVm.profileOverrides, { incrementKg: 5, priority: "accessory", canIncreaseLoad: true });
const built = buildExerciseProfile(profiledVm);
assert.equal(built.loadIncrementKg, 5);
assert.equal(built.role, "accessory");
assert.equal(built.measurement, "time");
assert.equal(built.fieldSources.incrementKg, "override");
const cleared = updateProgramExerciseProfileChecked(programId, target.id, { measurement: null, profileOverrides: null });
assert.equal(cleared.ok, true);
assert.equal(cleared.exercise.measurement, undefined, "null removes the field");
assert.equal(cleared.exercise.profileOverrides, undefined);
assert.equal(cleared.exercise.perSide, true, "untouched field kept");
assert.equal(cleared.measurementChanged, false, "the label still says seconds");
assert.equal(getProgramDayViewModels(programId)[0].exercises.find((entry) => entry.id === target.id).measurement, "time", "back to inference");

assert.deepEqual(collectProgramExerciseProfileErrors({ loadType: "external", weightMode: "kg" }), []);
assert.deepEqual(collectProgramExerciseProfileErrors({ loadType: "external", weightMode: "kg", profileOverrides: [] }), ["profile overrides must be an object."]);
assert.deepEqual(collectProgramProfileErrors({}), []);
assert.deepEqual(collectProgramProfileErrors({ cycleWeeks: 53 }), ["cycle weeks must be a whole number from 1 to 52, or empty."]);
assert.deepEqual(collectProgramProfileErrors({ programProfile: "fast" }), ["program profile must be an object."]);

// Default program view models: the explicit dumbbell config (2 / 1) is kept.
const defaultDumbbell = getProgramDayViewModels(DEFAULT_PROGRAM_ID)
  .flatMap((day) => day.exercises)
  .find((entry) => entry.weightMode === "per dumbbell");
assert.ok(defaultDumbbell, "the default program has a per-dumbbell exercise");
const defaultProfile = buildExerciseProfile(defaultDumbbell);
assert.equal(defaultProfile.loadIncrementKg, 2);
assert.equal(defaultProfile.roundToKg, 1);
assert.equal(defaultProfile.fieldSources.incrementKg, "config");
assert.equal(defaultProfile.fieldSources.roundToKg, "config");
assert.equal(defaultDumbbell.measurement, "reps");
assert.equal(defaultDumbbell.override, null);
assert.equal(defaultDumbbell.deload, null);

// --- share round trip carries the program fields ----------------------------------------
assert.equal(updateProgramExerciseProfileChecked(programId, target.id, { measurement: "time", profileOverrides: { incrementKg: 5 } }).ok, true);
const share = exportProgramShare(programId);
assert.equal(share.program.cycleWeeks, 2);
assert.deepEqual(share.program.programProfile, { aggression: "conservative", unit: "kg" });
const sharedExercise = share.programExercises.find((entry) => entry.id === target.id);
assert.equal(sharedExercise.measurement, "time");
assert.deepEqual(sharedExercise.profileOverrides, { incrementKg: 5 });
assert.equal(validateProgramShareStrict(share).valid, true, JSON.stringify(validateProgramShareStrict(share).errors));
assert.equal(validateProgramShareStrict({ ...share, program: { ...share.program, cycleWeeks: 0 } }).valid, false, "strict validation covers cycleWeeks");
assert.equal(validateProgramShareStrict({ ...share, program: { ...share.program, programProfile: { aggression: "wild" } } }).valid, false);
const imported = importProgramShare(share);
assert.equal(imported.ok, true, imported.error);
const importedProgram = getPrograms().find((program) => program.id === imported.programId);
assert.equal(importedProgram.cycleWeeks, 2);
assert.deepEqual(importedProgram.programProfile, { aggression: "conservative", unit: "kg" });
const importedExercise = getProgramDayViewModels(imported.programId)[0].exercises.find((entry) => entry.name === target.name);
assert.equal(importedExercise.measurement, "time");
assert.deepEqual(importedExercise.profileOverrides, { incrementKg: 5 });
assert.equal(getProgramDayViewModels(imported.programId).at(-1).isOptional, true, "the optional day survived the share");

console.log("Program H5 schedule / profile verification passed.");
