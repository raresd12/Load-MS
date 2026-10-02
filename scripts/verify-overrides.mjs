// Phase H5 Track A, decision H5-6: hold / manual override per program
// exercise. Storage records, resolver precedence, the engine hold, the
// per-session countdown in persistWorkoutSave, clearing on a target edit and
// on an applied draft, and what is never rewritten (sessions, baselines,
// history).
import assert from "node:assert/strict";

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

const { readStorage, STORAGE_KEYS, writeStorage } = await import("../src/lib/storage.js");
const {
  applyProgramDraft,
  buildProgressionUpdatesFromPlan,
  DEFAULT_PROGRAM_ID,
  duplicateProgram,
  getProgramBaseline,
  getProgramDays,
  getProgramDayViewModels,
  getProgramProgression,
  persistWorkoutSave,
  seedDefaultProgramIfNeeded,
  updateProgramExerciseTargetChecked,
} = await import("../src/lib/programStorage.js");
const { draftFromProgram, updateExercise } = await import("../src/lib/programDraft.js");
const {
  clearExerciseOverrideChecked,
  consumeOverrideSessions,
  describeOverride,
  getExerciseOverride,
  getExerciseOverrides,
  getOverridePrescriptionFields,
  HOLD_REASON,
  isOverrideActive,
  makeOverrideId,
  setExerciseOverrideChecked,
  validateExerciseOverride,
} = await import("../src/lib/overrides.js");
const { getPrescriptionSourceLabel, isEarnedProgression, PRESCRIPTION_SOURCES, resolvePrescription } = await import("../src/lib/prescription.js");
const { generateNextPlan } = await import("../src/lib/progression.js");
const { getCollection } = await import("../src/lib/repository.js");
const { buildPlannedExercisesSnapshot, buildResolvedPlan } = await import("../src/lib/sessionEdit.js");
const { getSessionCoachStatus } = await import("../src/lib/adherence.js");

assert.equal(STORAGE_KEYS.programOverrides, "rpe-tracker.program-overrides.v1");
assert.equal(getCollection("programOverrides").backedUp, true, "overrides travel with backups");
assert.equal(HOLD_REASON, "Held by you");
assert.equal(makeOverrideId("pe-1"), "override:pe-1");

// --- pure validation / description ------------------------------------------
assert.equal(validateExerciseOverride({ programId: "p", programExerciseId: "e", mode: "hold" }).valid, true);
assert.equal(validateExerciseOverride({ programId: "p", programExerciseId: "e", mode: "manual" }).valid, false, "manual needs a value");
assert.equal(validateExerciseOverride({ programId: "p", programExerciseId: "e", mode: "hold", remainingSessions: 7 }).valid, false, "1-6 sessions");
assert.equal(validateExerciseOverride({ programId: "p", programExerciseId: "e", mode: "hold", remainingSessions: 0 }).valid, false);
assert.equal(validateExerciseOverride({ programId: "p", programExerciseId: "e", mode: "freeze" }).valid, false);
assert.equal(validateExerciseOverride({ programId: "p", programExerciseId: "e", mode: "hold", untilDate: "not a date" }).valid, false);
assert.equal(validateExerciseOverride({ programId: "p", programExerciseId: "e", mode: "manual", prescription: { targetWeight: -5 } }).valid, false);
assert.equal(validateExerciseOverride({ programId: "p", programExerciseId: "e", mode: "manual", prescription: { targetReps: { min: 12, max: 8 } } }).valid, false);
assert.equal(validateExerciseOverride({ programId: "p", programExerciseId: "e", mode: "manual", prescription: { targetWeight: "BW", targetSets: 3, targetRPE: 7.5 } }).valid, true);
assert.equal(describeOverride({ mode: "manual", remainingSessions: 2 }), "Manual override (2 sessions left)");
assert.equal(describeOverride({ mode: "manual", remainingSessions: 1 }), "Manual override (1 session left)");
assert.equal(describeOverride({ mode: "hold" }), "On hold");
assert.equal(describeOverride({ mode: "hold", remainingSessions: null, untilDate: "2026-10-14" }), "On hold (until 2026-10-14)");
assert.equal(isOverrideActive({ mode: "hold", remainingSessions: 1 }), true);
assert.equal(isOverrideActive({ mode: "hold", remainingSessions: 0 }), false);
assert.equal(isOverrideActive({ mode: "hold", untilDate: "2026-10-01" }, "2026-10-01T23:00:00.000Z"), true, "the until day counts to its end");
assert.equal(isOverrideActive({ mode: "hold", untilDate: "2026-10-01" }, "2026-10-02T00:00:01.000Z"), false);
assert.equal(isOverrideActive({ mode: "hold", untilDate: "2026-10-01" }), true, "without a `now` the date is not judged");
assert.deepEqual(getOverridePrescriptionFields({ mode: "manual", prescription: { targetWeight: 42.5, targetReps: { min: 8, max: 10 } } }), {
  repsMin: 8,
  repsMax: 10,
  repsLabel: "8-10",
  weight: 42.5,
});
assert.deepEqual(getOverridePrescriptionFields({ mode: "hold" }), {});
const consumed = consumeOverrideSessions(
  [
    { programId: "p", programExerciseId: "a", mode: "hold", remainingSessions: 1 },
    { programId: "p", programExerciseId: "b", mode: "manual", remainingSessions: 3, prescription: { targetWeight: 10 } },
    { programId: "p", programExerciseId: "c", mode: "hold", remainingSessions: null, untilDate: "2026-09-01" },
    { programId: "other", programExerciseId: "a", mode: "hold", remainingSessions: 1 },
  ],
  { programId: "p", loggedProgramExerciseIds: ["a", "b"], sessionDate: "2026-09-10T10:00:00.000Z", updatedAt: "2026-09-10T10:00:00.000Z" },
);
assert.equal(consumed.changed, true);
assert.deepEqual(consumed.expired, ["a", "c"], "a at 0 and c past its date are removed");
assert.deepEqual(consumed.records.map((record) => [record.programId, record.programExerciseId, record.remainingSessions]), [
  ["p", "b", 2],
  ["other", "a", 1],
]);
assert.equal(consumeOverrideSessions([], { programId: "p", loggedProgramExerciseIds: ["a"] }).changed, false);

// --- storage ----------------------------------------------------------------
seedDefaultProgramIfNeeded();
const copy = duplicateProgram(DEFAULT_PROGRAM_ID);
assert.equal(copy.ok, true);
const programId = copy.programId;
const days = getProgramDays(programId);
const day = getProgramDayViewModels(programId)[0];
const bench = day.exercises.find((entry) => /bench/i.test(entry.name)) ?? day.exercises[0];
const other = day.exercises.find((entry) => entry.id !== bench.id);
assert.ok(bench && other);
assert.equal(bench.override, null, "no override yet");
assert.equal(bench.deload, null);

const invalid = setExerciseOverrideChecked({ programId, programExerciseId: bench.id, mode: "manual" });
assert.equal(invalid.ok, false);
assert.equal(invalid.code, "invalid");
assert.equal(readStorage(STORAGE_KEYS.programOverrides, null), null, "nothing written for an invalid record");

const holdSet = setExerciseOverrideChecked(
  { programId, programExerciseId: bench.id, mode: "hold", remainingSessions: 2, note: "Shoulder is cranky" },
  { now: "2026-09-20T08:00:00.000Z" },
);
assert.equal(holdSet.ok, true);
assert.deepEqual(holdSet.record, {
  id: `override:${bench.id}`,
  programId,
  programExerciseId: bench.id,
  mode: "hold",
  prescription: null,
  remainingSessions: 2,
  untilDate: null,
  note: "Shoulder is cranky",
  createdAt: "2026-09-20T08:00:00.000Z",
  updatedAt: "2026-09-20T08:00:00.000Z",
});
assert.deepEqual(getExerciseOverride(bench.id, programId), holdSet.record);
assert.equal(getExerciseOverrides(programId).length, 1);
assert.equal(getExerciseOverrides(DEFAULT_PROGRAM_ID).length, 0);

const upsert = setExerciseOverrideChecked({ programId, programExerciseId: bench.id, mode: "hold", remainingSessions: 3 }, { now: "2026-09-21T08:00:00.000Z" });
assert.equal(upsert.ok, true);
assert.equal(getExerciseOverrides(programId).length, 1, "upsert by exercise");
assert.equal(upsert.record.createdAt, "2026-09-20T08:00:00.000Z", "createdAt kept");
assert.equal(upsert.record.remainingSessions, 3);
assert.equal(setExerciseOverrideChecked({ programId, programExerciseId: bench.id, mode: "hold", remainingSessions: 2 }, { now: "2026-09-21T08:00:00.000Z" }).ok, true);

// View model + resolver: hold is the top source, values stay where they are.
const heldVm = getProgramDayViewModels(programId)[0].exercises.find((entry) => entry.id === bench.id);
assert.equal(heldVm.override.mode, "hold");
assert.equal(heldVm.override.remainingSessions, 2);
const heldResolved = resolvePrescription({ programExercise: heldVm, progression: null, planExercise: null, baseline: getProgramBaseline(programId, bench.id) });
assert.equal(heldResolved.source, "override");
assert.equal(heldResolved.sourceDetail, "On hold (2 sessions left)");
assert.equal(heldResolved.weight, heldVm.recommendedWeight, "a hold changes no value");
assert.equal(heldResolved.sets, heldVm.sets);
assert.deepEqual(heldResolved.override, { mode: "hold", remainingSessions: 2, untilDate: null, note: "", detail: "On hold (2 sessions left)" });
assert.equal(heldResolved.deload, null);
assert.equal(PRESCRIPTION_SOURCES.override, "override");
assert.equal(getPrescriptionSourceLabel("override"), "Source: your override");
const explicitNone = resolvePrescription({ programExercise: heldVm, override: null });
assert.notEqual(explicitNone.source, "override", "an explicit null override argument wins over the view model");

// Engine: the held exercise is frozen; the other exercise progresses normally.
const dayVm = getProgramDayViewModels(programId)[0];
function sessionFor(id, date, entries) {
  return {
    id,
    schemaVersion: 6,
    programId,
    dayId: dayVm.id,
    dayName: dayVm.name,
    date,
    sessionRpe: 8,
    readiness: { status: "green", averageScore: 4.3, isGood: true, isPoor: false },
    plannedExercises: {
      exercises: Object.fromEntries(
        dayVm.exercises.map((entry) => [
          entry.id,
          { sets: entry.sets, repsMin: entry.repsMin, repsMax: entry.repsMax, repsLabel: entry.repsLabel, targetRPE: entry.targetRPE, recommendedWeight: entry.recommendedWeight, restSeconds: entry.restSeconds },
        ]),
      ),
    },
    exercises: Object.fromEntries(
      entries.map(([entry, weight]) => [
        entry.id,
        {
          programExerciseId: entry.id,
          exerciseId: entry.exerciseId,
          exerciseRPE: 8,
          sets: Array.from({ length: entry.sets }, () => ({ reps: entry.repsMax, weight, rpe: 8 })),
        },
      ]),
    ),
    workoutSets: [],
  };
}

const s1 = sessionFor("s1", "2026-09-22T10:00:00.000Z", [[bench, 60], [other, 40]]);
const plan1 = generateNextPlan(dayVm, s1, []);
const heldEntry = plan1.exercises.find((entry) => entry.exerciseId === bench.id);
const otherEntry = plan1.exercises.find((entry) => entry.exerciseId === other.id);
assert.equal(heldEntry.held, true);
assert.equal(heldEntry.decision, "hold");
assert.equal(heldEntry.reasons[0], HOLD_REASON);
assert.equal(heldEntry.recommendedWeight, bench.recommendedWeight);
assert.equal(otherEntry.held, undefined);
assert.notEqual(otherEntry.decision, "hold");
const updateIds = buildProgressionUpdatesFromPlan(plan1).map((update) => update.programExerciseId);
assert.ok(!updateIds.includes(bench.id), "a held entry writes no progression");
assert.ok(updateIds.includes(other.id), "the other entries still do");

// Save the new session: countdown 2 -> 1, no progression for the held lift,
// sessions / baselines exactly as given.
const baselinesBefore = JSON.stringify(readStorage(STORAGE_KEYS.programBaselines, null));
const save1 = persistWorkoutSave({
  sessions: [s1],
  nextPlans: { [dayVm.id]: plan1 },
  workoutDrafts: {},
  programId,
  plan: plan1,
  programStatePatch: { lastCompletedDayId: dayVm.id, nextRecommendedDayId: days[1].id, lastWorkoutDate: s1.date },
});
assert.equal(save1.ok, true);
assert.deepEqual(save1.consumedOverrides, [bench.id]);
assert.deepEqual(save1.expiredOverrides, []);
assert.ok(save1.writtenKeys.includes(STORAGE_KEYS.programOverrides));
assert.equal(getExerciseOverride(bench.id, programId).remainingSessions, 1);
assert.equal(isEarnedProgression(getProgramProgression(programId, bench.id)), false, "held: no progression written (the duplicated base row stays)");
assert.equal(getProgramProgression(programId, other.id).sourceSessionId, s1.id, "the other lift progressed");
assert.equal(JSON.stringify(readStorage(STORAGE_KEYS.sessions, null)), JSON.stringify([s1]), "sessions written as given, never rewritten");
assert.equal(JSON.stringify(readStorage(STORAGE_KEYS.programBaselines, null)), baselinesBefore, "baselines untouched");

// Re-saving the same session (an edit) consumes nothing.
const edit = persistWorkoutSave({ sessions: [{ ...s1, sessionRpe: 7 }], programId, plan: plan1, programStatePatch: { lastCompletedDayId: dayVm.id } });
assert.equal(edit.ok, true);
assert.deepEqual(edit.consumedOverrides, []);
assert.equal(getExerciseOverride(bench.id, programId).remainingSessions, 1, "an edited session is not a new session");

// A second new session where the held lift was NOT logged: nothing consumed.
const s2 = sessionFor("s2", "2026-09-24T10:00:00.000Z", [[other, 40]]);
const plan2 = generateNextPlan(getProgramDayViewModels(programId)[0], s2, [s1]);
assert.equal(persistWorkoutSave({ sessions: [s2, s1], programId, plan: plan2, programStatePatch: { lastCompletedDayId: dayVm.id } }).ok, true);
assert.equal(getExerciseOverride(bench.id, programId).remainingSessions, 1, "not logged, not consumed");

// A third new session with the held lift: 1 -> 0, record deleted.
const s3 = sessionFor("s3", "2026-09-26T10:00:00.000Z", [[bench, 60], [other, 42.5]]);
const plan3 = generateNextPlan(getProgramDayViewModels(programId)[0], s3, [s2, s1]);
assert.equal(plan3.exercises.find((entry) => entry.exerciseId === bench.id).held, true);
const save3 = persistWorkoutSave({ sessions: [s3, s2, s1], programId, plan: plan3, programStatePatch: { lastCompletedDayId: dayVm.id } });
assert.equal(save3.ok, true);
assert.deepEqual(save3.expiredOverrides, [bench.id]);
assert.equal(getExerciseOverride(bench.id, programId), null, "the hold ended");
assert.equal(isEarnedProgression(getProgramProgression(programId, bench.id)), false, "still no evidence from the held sessions");
const freePlan = generateNextPlan(getProgramDayViewModels(programId)[0], s3, [s2, s1]);
assert.equal(freePlan.exercises.find((entry) => entry.exerciseId === bench.id).held, undefined, "the engine runs again once the hold is over");

// The next session after the hold ended (H5 fix round 1, decision H5-26):
// the stored plan of the day is still the frozen `plan3`, and that is what
// the Workout Log resolves against. Its `held` flag must not reach the new
// session's snapshot, otherwise the recap says "Held by you", the weekly
// review counts a hold, and the engine freezes the lift again (H5-15).
{
  const freeDay = getProgramDayViewModels(programId)[0];
  assert.equal(freeDay.exercises.find((entry) => entry.id === bench.id).override, null, "the hold record is gone");
  const resolvedAfterHold = buildResolvedPlan(programId, freeDay, plan3);
  const resolvedBench = resolvedAfterHold.exercises.find((entry) => entry.exerciseId === bench.id);
  assert.equal(resolvedBench.held, undefined, "the stored frozen entry's hold is not carried over");
  assert.equal(resolvedBench.overrideMode, undefined);
  assert.notEqual(resolvedBench.prescriptionSource, "override");
  const s4 = {
    ...sessionFor("s4", "2026-09-28T10:00:00.000Z", [[bench, 60], [other, 42.5]]),
    plannedExercises: buildPlannedExercisesSnapshot(freeDay, resolvedAfterHold),
  };
  assert.equal(s4.plannedExercises[bench.id].held, undefined, "the snapshot of the next session is not held");
  assert.equal(s4.plannedExercises[bench.id].overrideMode, undefined);
  const plan4 = generateNextPlan(freeDay, s4, [s3, s2, s1]);
  const bench4 = plan4.exercises.find((entry) => entry.exerciseId === bench.id);
  assert.equal(bench4.held, undefined, "the engine is not frozen by a hold that ended");
  assert.notEqual(bench4.reasons[0], HOLD_REASON);
  assert.ok(buildProgressionUpdatesFromPlan(plan4).some((update) => update.programExerciseId === bench.id), "the lift earns progression again");
  const status4 = getSessionCoachStatus(s4, plan4);
  assert.deepEqual(status4.held, [], "the recap of the next session reports no hold");
  assert.deepEqual(status4.overridden, []);
  // The held session itself keeps its own flags (H5-15): regenerating from
  // it still freezes the lift.
  const s3Snapshot = { ...s3, plannedExercises: buildPlannedExercisesSnapshot(heldVm ? getProgramDayViewModels(programId)[0] : freeDay, { exercises: [{ exerciseId: bench.id, held: true, overrideMode: "hold" }] }) };
  assert.equal(generateNextPlan(freeDay, s3Snapshot, [s2, s1]).exercises.find((entry) => entry.exerciseId === bench.id).held, true);
}

// Manual override: fills only the fields it sets, above the earned progression.
const manualSet = setExerciseOverrideChecked(
  { programId, programExerciseId: other.id, mode: "manual", prescription: { targetWeight: 37.5, targetSets: 2 }, remainingSessions: 2 },
  { now: "2026-09-27T08:00:00.000Z" },
);
assert.equal(manualSet.ok, true);
const otherVm = getProgramDayViewModels(programId)[0].exercises.find((entry) => entry.id === other.id);
const otherProgression = getProgramProgression(programId, other.id);
const manualResolved = resolvePrescription({ programExercise: otherVm, progression: otherProgression, planExercise: null, baseline: getProgramBaseline(programId, other.id) });
assert.equal(manualResolved.source, "override");
assert.equal(manualResolved.sourceDetail, "Manual override (2 sessions left)");
assert.equal(manualResolved.weight, 37.5);
assert.equal(manualResolved.sets, 2);
assert.equal(manualResolved.fieldSources.weight, "override");
assert.equal(manualResolved.fieldSources.sets, "override");
assert.equal(manualResolved.repsLabel, otherVm.repsLabel, "reps come from the next source");
assert.notEqual(manualResolved.fieldSources.repsLabel, "override");
const manualPlan = generateNextPlan(getProgramDayViewModels(programId)[0], s3, [s2, s1]);
assert.equal(manualPlan.exercises.find((entry) => entry.exerciseId === other.id).held, undefined, "a manual override does not freeze the engine");

// A hold with an until date expires by the session date.
assert.equal(setExerciseOverrideChecked({ programId, programExerciseId: bench.id, mode: "hold", untilDate: "2026-09-27" }, { now: "2026-09-27T08:00:00.000Z" }).ok, true);
assert.equal(getProgramDayViewModels(programId, { now: "2026-09-27T12:00:00.000Z" })[0].exercises.find((entry) => entry.id === bench.id).override.mode, "hold");
assert.equal(getProgramDayViewModels(programId, { now: "2026-09-28T12:00:00.000Z" })[0].exercises.find((entry) => entry.id === bench.id).override, null, "expired at `now`");
const s4 = sessionFor("s4", "2026-09-28T10:00:00.000Z", [[bench, 60], [other, 37.5]]);
const plan4 = generateNextPlan(getProgramDayViewModels(programId, { now: s4.date })[0], s4, [s3, s2, s1]);
assert.equal(plan4.exercises.find((entry) => entry.exerciseId === bench.id).held, undefined, "past the date the engine runs");
const save4 = persistWorkoutSave({ sessions: [s4, s3, s2, s1], programId, plan: plan4, programStatePatch: { lastCompletedDayId: dayVm.id } });
assert.equal(save4.ok, true);
assert.equal(getExerciseOverride(bench.id, programId), null, "the dated hold was removed on save");
assert.equal(getExerciseOverride(other.id, programId).remainingSessions, 1, "the manual override counted this session");

// A target edit clears the override of that exercise, in the same batch.
const overridesBeforeEdit = readStorage(STORAGE_KEYS.programOverrides, []);
assert.equal(overridesBeforeEdit.length, 1);
storage.failKey = STORAGE_KEYS.programOverrides;
const failedEdit = updateProgramExerciseTargetChecked(programId, other.id, { targetWeight: 40 });
storage.failKey = null;
assert.equal(failedEdit.ok, false);
assert.equal(failedEdit.rolledBack ?? true, true);
assert.deepEqual(readStorage(STORAGE_KEYS.programOverrides, []), overridesBeforeEdit, "batch failure keeps the override");
const edited = updateProgramExerciseTargetChecked(programId, other.id, { targetWeight: 40 });
assert.equal(edited.ok, true);
assert.equal(edited.clearedOverride, true);
assert.equal(getExerciseOverride(other.id, programId), null, "a target edit ends the override");

// An applied draft with a changed prescription clears it too.
assert.equal(setExerciseOverrideChecked({ programId, programExerciseId: bench.id, mode: "hold", remainingSessions: 4 }).ok, true);
assert.equal(setExerciseOverrideChecked({ programId, programExerciseId: other.id, mode: "hold", remainingSessions: 4 }).ok, true);
const draft = draftFromProgram(programId).draft;
const changedDraft = updateExercise(draft, dayVm.id, bench.id, { targetSets: bench.sets + 1 });
const applied = applyProgramDraft(changedDraft);
assert.equal(applied.ok, true, applied.error);
assert.equal(getExerciseOverride(bench.id, programId), null, "changed prescription: override cleared");
assert.equal(getExerciseOverride(other.id, programId)?.remainingSessions, 4, "unchanged exercise keeps its override");

// clearExerciseOverrideChecked and the corrupt key rule.
assert.deepEqual(clearExerciseOverrideChecked(other.id, programId), { ok: true, removed: true });
assert.deepEqual(clearExerciseOverrideChecked(other.id, programId), { ok: true, removed: false });
storage.setItem(STORAGE_KEYS.programOverrides, "{not json");
const corruptSet = setExerciseOverrideChecked({ programId, programExerciseId: bench.id, mode: "hold" });
assert.equal(corruptSet.ok, false);
assert.equal(corruptSet.code, "corrupt");
assert.equal(storage.getItem(STORAGE_KEYS.programOverrides), "{not json", "a corrupt key is never overwritten");
assert.equal(clearExerciseOverrideChecked(bench.id, programId).code, "corrupt");
assert.equal(getProgramDayViewModels(programId)[0].exercises[0].override, null, "corrupt overrides read as none");
assert.equal(writeStorage(STORAGE_KEYS.programOverrides, []).ok, false, "storage refuses the plain write too");

// A stored manual record with ONE reps bound (the form refuses it since
// H5-42, an older or shared record may still carry one): the other bound
// comes from the next source, and the resolved range is never inverted and
// never keeps the lower source's label.
{
  const target = { id: "pe-one", programId: "p-one", name: "Row", sets: 3, repsMin: 8, repsMax: 10, repsLabel: "8-10", recommendedWeight: 40 };
  const withReps = (reps) => resolvePrescription({ programExercise: { ...target, override: { programId: "p-one", programExerciseId: "pe-one", mode: "manual", remainingSessions: 1, prescription: { targetReps: reps } } } });
  const minOnly = withReps({ min: 12, max: null });
  assert.deepEqual([minOnly.repsMin, minOnly.repsMax, minOnly.repsLabel], [12, 12, "12"], "min 12 over a target of 8-10 is 12, not 12-10 labelled 8-10");
  const maxOnly = withReps({ min: null, max: 6 });
  assert.deepEqual([maxOnly.repsMin, maxOnly.repsMax, maxOnly.repsLabel], [6, 6, "6"]);
  const inside = withReps({ min: 9, max: null });
  assert.deepEqual([inside.repsMin, inside.repsMax, inside.repsLabel], [9, 10, "9-10"], "a bound inside the range keeps the other bound and gets its own label");
}

console.log("Overrides (H5-6) verification passed.");
