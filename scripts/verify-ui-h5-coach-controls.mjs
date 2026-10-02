// Phase H5 UI track, decision H5-12: the pure view glue behind the hold /
// manual override controls, the deload card, the coach profile disclosure,
// the program-level profile form, the Progress Records section and the
// History adherence badge (src/lib/coachControlsView.js). Nothing here reads
// the clock or storage beyond the seeded default program.
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
console.warn = () => {};

const view = await import("../src/lib/coachControlsView.js");
const overrides = await import("../src/lib/overrides.js");
const { setExerciseOverrideChecked, getExerciseOverride } = overrides;
const { readFileSync } = await import("node:fs");
const { evaluateDeloadNeed } = await import("../src/lib/deload.js");
const {
  duplicateProgram,
  getProgramDayViewModels,
  getProgramExercises,
  getPrograms,
  seedDefaultProgramIfNeeded,
  updateProgramExerciseProfileChecked,
  updateProgramExerciseTargetChecked,
  updateProgramProfileChecked,
} = await import("../src/lib/programStorage.js");
const { computePersonalRecords } = await import("../src/lib/personalRecords.js");
const { computeSessionAdherence } = await import("../src/lib/adherence.js");

const NO_MEDICAL = /injury|overtraining syndrome|diagnos/i;

// ---------------------------------------------------------------------------
// Hold / manual override
// ---------------------------------------------------------------------------
assert.deepEqual([...view.OVERRIDE_SESSION_OPTIONS], [1, 2, 3, 4, 5, 6]);
assert.equal(view.formatOverrideBadge(null), "");
assert.equal(view.formatOverrideBadge({ mode: "hold", remainingSessions: 2 }), "On hold (2 left)");
assert.equal(view.formatOverrideBadge({ mode: "manual", remainingSessions: 1 }), "Manual (1 left)");
assert.equal(view.formatOverrideBadge({ mode: "hold", remainingSessions: null }), "On hold");
assert.equal(view.getOverrideSourceLine({ mode: "hold", remainingSessions: 2 }), "Held by you: on hold (2 sessions left).");
assert.equal(view.getOverrideSourceLine({ mode: "manual", remainingSessions: 1 }), "Set manually by you: manual override (1 session left).");
assert.equal(view.getOverrideSourceLine(null), "");

const hold = view.buildHoldRecord({ programId: "p1", programExerciseId: "pe1", sessions: "3" });
assert.equal(hold.ok, true);
assert.deepEqual(hold.record, {
  programId: "p1",
  programExerciseId: "pe1",
  mode: "hold",
  prescription: null,
  remainingSessions: 3,
  untilDate: null,
  note: "",
});
assert.equal(view.buildHoldRecord({ programId: "p1", programExerciseId: "pe1", sessions: "9" }).ok, false);
assert.equal(view.buildHoldRecord({ programId: "p1", programExerciseId: "pe1", sessions: "x" }).ok, false);

// Decision H5-31: the optional "until" date of a hold.
assert.deepEqual(view.createHoldForm(), { sessions: "2", untilDate: "" });
assert.deepEqual(view.parseHoldUntilDate(""), { ok: true, value: null, error: null });
assert.deepEqual(view.parseHoldUntilDate("2026-10-14", "2026-10-02"), { ok: true, value: "2026-10-14", error: null });
assert.equal(view.parseHoldUntilDate("2026-10-02", "2026-10-02").ok, true, "today is allowed");
assert.equal(view.parseHoldUntilDate("2026-10-01", "2026-10-02").error, "Until date cannot be in the past.");
assert.equal(view.parseHoldUntilDate("2026-02-30", "2026-01-01").error, "Until date must be a valid date (YYYY-MM-DD) or blank.");
assert.equal(view.parseHoldUntilDate("14.10.2026").ok, false);
const datedHold = view.buildHoldRecord({ programId: "p1", programExerciseId: "pe1", sessions: "3", untilDate: "2026-10-14", today: "2026-10-02" });
assert.equal(datedHold.ok, true);
assert.deepEqual(datedHold.record, { programId: "p1", programExerciseId: "pe1", mode: "hold", prescription: null, remainingSessions: 3, untilDate: "2026-10-14", note: "" });
assert.equal(overrides.validateExerciseOverride(datedHold.record).valid, true);
assert.equal(overrides.isOverrideActive(datedHold.record, "2026-10-14T20:00:00.000Z"), true, "active through the until day");
assert.equal(overrides.isOverrideActive(datedHold.record, "2026-10-15T00:00:00.000Z"), false, "expired the day after");
assert.equal(view.formatOverrideBadge(datedHold.record), "On hold (3 left, until 2026-10-14)");
assert.equal(view.formatOverrideBadge({ mode: "hold", remainingSessions: null, untilDate: "2026-10-14" }), "On hold (until 2026-10-14)");
assert.equal(view.getOverrideSourceLine(datedHold.record), "Held by you: on hold (3 sessions left, until 2026-10-14).");
const pastHold = view.buildHoldRecord({ programId: "p1", programExerciseId: "pe1", sessions: "x", untilDate: "2026-09-01", today: "2026-10-02" });
assert.equal(pastHold.ok, false);
assert.deepEqual(pastHold.errors, ["Sessions must be a whole number from 1 to 6.", "Until date cannot be in the past."]);
{
  const controls = readFileSync(new URL("../src/components/workout/ExerciseOverrideControls.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.ok(controls.includes("Until date (optional)") && controls.includes('type="date"'), "the hold form offers the until date");
  assert.ok(controls.includes("untilDate: holdForm.untilDate,\n                  today: getLocalDateKey(),"), "the form's date reaches buildHoldRecord with the local today");
}

const manualForm = view.createManualOverrideForm({ recommendedWeight: 60, sets: 3, repsMin: 8, repsMax: 10, targetRPE: 8 });
assert.deepEqual(manualForm, { sessions: "2", weight: "60", sets: "3", repsMin: "8", repsMax: "10", rpe: "8" });
const manual = view.buildManualOverrideRecord({ programId: "p1", programExerciseId: "pe1", form: { ...manualForm, weight: "62.5", sessions: "1" } });
assert.equal(manual.ok, true, manual.errors.join(" | "));
assert.deepEqual(manual.record.prescription, { targetWeight: 62.5, targetSets: 3, targetReps: { min: 8, max: 10, label: null }, targetRPE: 8 });
assert.equal(manual.record.remainingSessions, 1);
const bwManual = view.buildManualOverrideRecord({ programId: "p1", programExerciseId: "pe1", form: { sessions: "2", weight: "bw", sets: "", repsMin: "", repsMax: "", rpe: "" } });
assert.equal(bwManual.ok, true);
assert.deepEqual(bwManual.record.prescription, { targetWeight: "BW" });
const emptyManual = view.buildManualOverrideRecord({ programId: "p1", programExerciseId: "pe1", form: { sessions: "2", weight: "", sets: "", repsMin: "", repsMax: "", rpe: "" } });
assert.equal(emptyManual.ok, false);
assert.ok(emptyManual.errors.some((message) => /at least one prescription value/.test(message)));
const badManual = view.buildManualOverrideRecord({ programId: "p1", programExerciseId: "pe1", form: { sessions: "2", weight: "abc", sets: "0", repsMin: "-1", repsMax: "", rpe: "11" } });
assert.equal(badManual.ok, false);
assert.equal(badManual.errors.length, 4, badManual.errors.join(" | "));

// H5 fix round 1: the count range needs both bounds (a single bound used to
// invert the range), whole reps, min not above max; BW only where the
// exercise allows it; the labels follow the measurement; under a deload the
// form starts from the base load (H5-18).
const oneBound = view.buildManualOverrideRecord({ programId: "p1", programExerciseId: "pe1", form: { sessions: "2", weight: "", sets: "", repsMin: "6", repsMax: "", rpe: "" } });
assert.equal(oneBound.ok, false);
assert.equal(oneBound.errors[0], "Enter both reps min and reps max, or leave both blank.");
assert.equal(view.buildManualOverrideRecord({ programId: "p1", programExerciseId: "pe1", form: { sessions: "2", weight: "", sets: "", repsMin: "6.5", repsMax: "8", rpe: "" } }).errors[0], "Reps must be whole numbers.");
assert.equal(view.buildManualOverrideRecord({ programId: "p1", programExerciseId: "pe1", form: { sessions: "2", weight: "", sets: "", repsMin: "9", repsMax: "8", rpe: "" } }).errors[0], "Reps min cannot exceed reps max.");
const external = { name: "Bench", loadType: "external", weightMode: "kg", repsLabel: "6-8" };
const bwRefused = view.buildManualOverrideRecord({ programId: "p1", programExerciseId: "pe1", form: { sessions: "2", weight: "BW", sets: "", repsMin: "", repsMax: "", rpe: "" }, exercise: external });
assert.equal(bwRefused.ok, false);
assert.equal(bwRefused.errors[0], "This exercise takes a kg load; BW is not accepted here.");
const chin = { name: "Chin-up", loadType: "optionalExternal", weightMode: "additional load", repsLabel: "5-10" };
assert.equal(view.buildManualOverrideRecord({ programId: "p1", programExerciseId: "pe1", form: { sessions: "2", weight: "bw", sets: "", repsMin: "", repsMax: "", rpe: "" }, exercise: chin }).ok, true);
const timedRules = view.getManualOverrideFieldRules({ name: "Plank", loadType: "bodyweight", repsLabel: "30-45 s" });
assert.deepEqual(timedRules, { measurement: "time", countNoun: "seconds", minLabel: "Seconds min", maxLabel: "Seconds max", allowsBodyweight: true, weightInputMode: "text", weightPlaceholder: "kg or BW", wholeCount: true });
assert.deepEqual(view.getManualOverrideFieldRules(external), { measurement: "reps", countNoun: "reps", minLabel: "Reps min", maxLabel: "Reps max", allowsBodyweight: false, weightInputMode: "decimal", weightPlaceholder: "kg", wholeCount: false || true });
assert.equal(view.getManualOverrideFieldRules({ name: "Carry", loadType: "external", repsLabel: "40 m" }).wholeCount, false, "meters may carry a decimal");
const timedOneBound = view.buildManualOverrideRecord({ programId: "p1", programExerciseId: "pe1", form: { sessions: "2", weight: "", sets: "", repsMin: "30", repsMax: "", rpe: "" }, exercise: { name: "Plank", loadType: "bodyweight", repsLabel: "30-45 s" } });
assert.equal(timedOneBound.errors[0], "Enter both seconds min and seconds max, or leave both blank.");
const deloadForm = view.createManualOverrideForm({ recommendedWeight: 54, sets: 2, repsMin: 8, repsMax: 10, targetRPE: 8, deload: { level: "lighter_week", baseWeight: 60, baseSets: 3, factor: 0.9 } });
assert.deepEqual(deloadForm, { sessions: "2", weight: "60", sets: "3", repsMin: "8", repsMax: "10", rpe: "8" }, "the form starts from the base load and sets, not the scaled ones");
assert.equal(view.describeManualOverrideBase({ recommendedWeight: 54, deload: { level: "lighter_week", baseWeight: 60 } }), "Lighter week: the coach shows 54 kg, this form starts from the base 60 kg. A manual weight is used as typed, not scaled.");
assert.equal(view.describeManualOverrideBase({ recommendedWeight: 60, deload: null }), "");
assert.equal(view.describeManualOverrideBase({ recommendedWeight: 60, deload: { level: "deload", baseWeight: 60 } }), "", "nothing to explain when the load was not scaled");

// The record the view builds is accepted by the checked writer and read back
// through the day view model as an active override.
seedDefaultProgramIfNeeded();
const defaultProgram = getPrograms().find((program) => program.isDefault);
const duplicate = duplicateProgram(defaultProgram.id);
assert.equal(duplicate.ok, true);
const customId = duplicate.program.id;
const customDays = getProgramDayViewModels(customId);
const firstExercise = customDays[0].exercises[0];
const holdWrite = setExerciseOverrideChecked(
  view.buildHoldRecord({ programId: customId, programExerciseId: firstExercise.programExerciseId, sessions: "2" }).record,
  { now: "2026-10-01T10:00:00.000Z" },
);
assert.equal(holdWrite.ok, true, holdWrite.error);
const viewExercise = getProgramDayViewModels(customId, { now: "2026-10-01T10:00:00.000Z" })[0].exercises[0];
assert.equal(view.getActiveExerciseOverride(viewExercise, "2026-10-01T10:00:00.000Z")?.mode, "hold");
assert.equal(view.formatOverrideBadge(view.getActiveExerciseOverride(viewExercise)), "On hold (2 left)");
assert.equal(getExerciseOverride(firstExercise.programExerciseId, customId)?.mode, "hold");
assert.equal(view.getActiveExerciseOverride({ override: { mode: "hold", remainingSessions: 0 } }), null);

// ---------------------------------------------------------------------------
// Deload card
// ---------------------------------------------------------------------------
const quietEvaluation = evaluateDeloadNeed({ program: { id: customId }, days: customDays, sessions: [], readinessByDate: {}, now: "2026-10-01T10:00:00.000Z" });
const ineligible = view.buildDeloadCardModel(quietEvaluation, null);
assert.equal(ineligible.kind, "ineligible");
assert.equal(
  ineligible.line,
  "Deload check needs 6 sessions and 4 readiness check-ins in 21 days; you have 0 sessions and 0 check-ins.",
);
assert.equal(ineligible.signals.length, 4);

const suggestEvaluation = {
  ...quietEvaluation,
  eligible: true,
  suggest: true,
  level: "deload",
  signals: [
    { key: "high_session_rpe", met: false, detail: "Session RPE was 9 or higher in 1 of the last 4 sessions." },
    { key: "red_readiness", met: true, detail: "Readiness was red in 3 of the last 5 check-ins." },
    { key: "regressing_main_lifts", met: true, detail: "2 main exercises are trending down over their last 3 comparable sessions (A, B)." },
    { key: "pain_flags", met: true, detail: "Pain or discomfort was flagged in 2 sessions in the last 21 days." },
  ],
};
const suggest = view.buildDeloadCardModel(suggestEvaluation, null);
assert.equal(suggest.kind, "suggest");
assert.equal(suggest.title, "Deload suggested");
assert.equal(view.DELOAD_LEVEL_TITLES.lighter_week, "Lighter week suggested");
assert.deepEqual(suggest.sessionOptions, [2, 3]);
assert.equal(suggest.signals[0].met, true);
assert.equal(suggest.signals[3].met, false);
assert.ok(suggest.line.startsWith("3 of 4 fatigue observations"));
assert.ok(!NO_MEDICAL.test(JSON.stringify(suggest)), "deload copy makes no medical claim");

const active = view.buildDeloadCardModel(suggestEvaluation, { level: "lighter_week", remainingSessions: 2, totalSessions: 2 });
assert.equal(active.kind, "active");
assert.equal(active.line, "2 lighter sessions left");
assert.equal(view.formatActiveDeloadLine({ level: "deload", remainingSessions: 1 }), "1 deload session left");
assert.equal(view.formatActiveDeloadLine(null), "");
assert.equal(view.buildDeloadCardModel(null, null).kind, "quiet");
const quietEligible = view.buildDeloadCardModel({ ...quietEvaluation, eligible: true, reasons: ["0 of 4 fatigue observations are present; a suggestion needs at least 2."] }, null);
assert.equal(quietEligible.kind, "quiet");
assert.ok(quietEligible.line.includes("0 of 4"));

// ---------------------------------------------------------------------------
// Coach profile disclosure
// ---------------------------------------------------------------------------
const plank = { name: "Plank", repsLabel: "30 s", loadType: "bodyweight", equipment: "bodyweight", category: "core" };
const plankForm = view.createCoachProfileForm(plank);
assert.deepEqual(plankForm, {
  measurement: "",
  perSide: "",
  progressionMode: "",
  incrementKg: "",
  roundToKg: "",
  rpeMaxForLoadIncrease: "",
  priority: "",
  canIncreaseLoad: "",
});
const plankDescription = view.describeCoachProfile(plank);
assert.equal(plankDescription.measurement, "time (inferred)");
assert.ok(plankDescription.progressionMode.endsWith("(classified)"));

const benchStored = {
  name: "Bench",
  repsLabel: "6-8",
  measurement: "reps",
  perSide: false,
  equipment: "barbell",
  profileOverrides: { incrementKg: 5, priority: "main" },
};
const benchForm = view.createCoachProfileForm(benchStored);
assert.equal(benchForm.measurement, "reps");
assert.equal(benchForm.perSide, "no");
assert.equal(benchForm.incrementKg, "5");
assert.equal(benchForm.priority, "main");
const benchDescription = view.describeCoachProfile(benchStored);
assert.equal(benchDescription.incrementKg, "5 kg (override)");
assert.equal(benchDescription.priority, "main (override)");
assert.ok(benchDescription.roundToKg.endsWith("(classified)"));
assert.equal(benchDescription.measurement, "reps (set)");

const patch = view.buildCoachProfilePatch(
  { measurement: "time", perSide: "yes", progressionMode: "time_first", incrementKg: "", roundToKg: "2.5", rpeMaxForLoadIncrease: "8", priority: "accessory", canIncreaseLoad: "no" },
  plank,
);
assert.equal(patch.ok, true, patch.errors.join(" | "));
assert.deepEqual(patch.patch, {
  measurement: "time",
  perSide: true,
  profileOverrides: { progressionMode: "time_first", roundToKg: 2.5, rpeMaxForLoadIncrease: 8, priority: "accessory", canIncreaseLoad: false },
});
const clearPatch = view.buildCoachProfilePatch(plankForm, plank);
assert.deepEqual(clearPatch.patch, { measurement: null, perSide: null, profileOverrides: null });
const badPatch = view.buildCoachProfilePatch({ ...plankForm, incrementKg: "50", rpeMaxForLoadIncrease: "abc" }, plank);
assert.equal(badPatch.ok, false);
assert.deepEqual(badPatch.errors, [
  "Increment kg must be a number from 0.25 to 20.",
  "Max RPE for load increase must be a number from 5 to 10.",
]);
const badMode = view.buildCoachProfilePatch({ ...plankForm, progressionMode: "nope" }, plank);
assert.equal(badMode.ok, false);
assert.ok(/Progression mode override must be one of/.test(badMode.errors[0]));

// The patch the view builds is accepted by the checked writer on the custom
// program and refused on the default one (defaults stay protected). The
// measurement is the unit of the target (decision H5-17): "time" on a reps
// target is refused until the target is written in seconds.
const conflicting = updateProgramExerciseProfileChecked(customId, firstExercise.programExerciseId, patch.patch);
assert.equal(conflicting.ok, false);
assert.match(conflicting.error, /does not match the target/);
assert.equal(updateProgramExerciseTargetChecked(customId, firstExercise.programExerciseId, { targetReps: { min: 30, max: 45, label: "30-45 s" } }).ok, true);
const profileWrite = updateProgramExerciseProfileChecked(customId, firstExercise.programExerciseId, patch.patch);
assert.equal(profileWrite.ok, true, profileWrite.error);
assert.equal(profileWrite.exercise.measurement, "time");
assert.equal(profileWrite.exercise.profileOverrides.priority, "accessory");
const defaultWrite = updateProgramExerciseProfileChecked(
  defaultProgram.id,
  getProgramDayViewModels(defaultProgram.id)[0].exercises[0].programExerciseId,
  patch.patch,
);
assert.equal(defaultWrite.ok, false);
const afterWrite = getProgramDayViewModels(customId)[0].exercises[0];
const storedAfterWrite = getProgramExercises(customDays[0].id).find((record) => record.id === firstExercise.programExerciseId);
assert.equal(view.createCoachProfileForm(afterWrite, storedAfterWrite).measurement, "time");
assert.equal(view.createCoachProfileForm(afterWrite, storedAfterWrite).perSide, "yes");
assert.equal(view.describeCoachProfile(afterWrite, storedAfterWrite).priority, "accessory (override)");
assert.equal(view.describeCoachProfile(afterWrite, storedAfterWrite).measurement, "time (set)");
const cleared = updateProgramExerciseProfileChecked(customId, firstExercise.programExerciseId, clearPatch.patch);
assert.equal(cleared.ok, true);
const storedAfterClear = getProgramExercises(customDays[0].id).find((record) => record.id === firstExercise.programExerciseId);
// The day view model always resolves measurement / perSide; the raw record
// is what tells "set" from "inferred" (classified).
assert.equal(view.createCoachProfileForm(getProgramDayViewModels(customId)[0].exercises[0], storedAfterClear).measurement, "");
assert.equal(view.describeCoachProfile(getProgramDayViewModels(customId)[0].exercises[0], storedAfterClear).measurement, "time (inferred)", "inferred from the seconds target");

// ---------------------------------------------------------------------------
// Program-level profile
// ---------------------------------------------------------------------------
assert.deepEqual(view.createProgramProfileForm({}), { aggression: "standard", cycleWeeks: "" });
assert.deepEqual(view.createProgramProfileForm({ programProfile: { aggression: "conservative" }, cycleWeeks: 4 }), { aggression: "conservative", cycleWeeks: "4" });
const programPatch = view.buildProgramProfilePatch({ aggression: "conservative", cycleWeeks: "4" });
assert.deepEqual(programPatch, { ok: true, patch: { programProfile: { aggression: "conservative", unit: "kg" }, cycleWeeks: 4 }, errors: [] });
assert.equal(view.buildProgramProfilePatch({ aggression: "standard", cycleWeeks: "0" }).ok, false);
assert.equal(view.buildProgramProfilePatch({ aggression: "standard", cycleWeeks: "" }).patch.cycleWeeks, null);
const programWrite = updateProgramProfileChecked(customId, programPatch.patch);
assert.equal(programWrite.ok, true, programWrite.error);
assert.equal(view.formatProgramWeekLabel({ currentWeek: 2, currentCycle: 1 }, { cycleWeeks: 4 }), "Week 2 of 4, cycle 1");
assert.equal(view.formatProgramWeekLabel({ currentWeek: 3 }, { cycleWeeks: null }), "Week 3");
assert.equal(view.formatProgramWeekLabel(null, null), "Week 1");

// ---------------------------------------------------------------------------
// Records section and adherence badge
// ---------------------------------------------------------------------------
assert.ok(view.RECORD_ELIGIBILITY_RULE.includes("1-10 reps"));
assert.ok(view.RECORD_ELIGIBILITY_RULE.includes("RPE 6"));
assert.ok(!NO_MEDICAL.test(view.RECORD_ELIGIBILITY_RULE));
const bench = customDays[0].exercises[0];
const sessionBase = {
  programId: customId,
  programName: "Custom",
  dayId: customDays[0].id,
  dayName: customDays[0].name,
  dayType: "training",
};
const sessions = [
  {
    ...sessionBase,
    id: "s1",
    date: "2026-09-20T10:00:00.000Z",
    workoutSets: [
      { sessionId: "s1", programId: customId, programExerciseId: bench.programExerciseId, exerciseId: bench.libraryExerciseId, exerciseName: bench.name, setNumber: 1, actualReps: 8, actualWeight: 60, actualRPE: 8, completed: true },
    ],
  },
  {
    ...sessionBase,
    id: "s2",
    date: "2026-09-27T10:00:00.000Z",
    workoutSets: [
      { sessionId: "s2", programId: customId, programExerciseId: bench.programExerciseId, exerciseId: bench.libraryExerciseId, exerciseName: bench.name, setNumber: 1, actualReps: 8, actualWeight: 62.5, actualRPE: 8, completed: true },
      { sessionId: "s2", programId: customId, programExerciseId: bench.programExerciseId, exerciseId: bench.libraryExerciseId, exerciseName: bench.name, setNumber: 2, actualReps: 12, actualWeight: 50, actualRPE: 7, completed: true },
    ],
  },
];
const records = computePersonalRecords({
  sessions,
  programs: getPrograms({ includeArchived: true }),
  programExercises: customDays.flatMap((day) => day.exercises),
  activeProgram: { id: customId },
});
const sections = view.buildRecordsSections(records, { programs: getPrograms(), activeProgramId: customId });
assert.equal(sections.length, 1);
assert.equal(sections[0].isActive, true);
assert.equal(sections[0].entries.length, 1);
const entry = sections[0].entries[0];
assert.equal(entry.name, bench.name);
const labels = entry.lines.map((line) => line.label);
assert.deepEqual(labels, ["Best e1RM", "Top weight", "Reps at weight", "Reps at weight", "Session volume"]);
assert.equal(entry.lines[1].value, "62.5 kg");
assert.equal(entry.lines[1].date, "2026-09-27");
assert.equal(entry.lines[2].value, "8 reps at 62.5 kg", "reps-at-weight lines are heaviest first");
assert.equal(entry.acrossPrograms, "", "the roll-up adds a line only when it holds a better value");
assert.equal(entry.ineligibleCount, 1, "the 12-rep set is listed as not e1RM eligible");
assert.deepEqual(view.buildRecordsSections({ primary: {} }, {}), []);

// A better value in the roll-up (the same Library exercise logged elsewhere)
// shows up on the secondary line and never changes the primary line.
const foreign = {
  ...records,
  acrossPrograms: {
    ...records.acrossPrograms,
    [`${bench.libraryExerciseId}::reps::kg`]: {
      ...Object.values(records.acrossPrograms)[0],
      records: { ...Object.values(records.acrossPrograms)[0].records, best_weight: { type: "best_weight", value: 80, weight: 80, date: "2026-08-01T00:00:00.000Z" } },
    },
  },
};
const foreignEntry = view.buildRecordsSections(foreign, { programs: getPrograms(), activeProgramId: customId })[0].entries[0];
assert.equal(foreignEntry.acrossPrograms, "Across programs: top weight 80 kg.");
assert.equal(foreignEntry.lines[1].value, "62.5 kg");

const planned = { [bench.programExerciseId]: { sets: 3 }, other: { sets: 3 } };
const adherence = computeSessionAdherence({ session: { ...sessions[1], plannedExercises: planned }, exercises: customDays[0].exercises });
assert.deepEqual(view.getAdherenceBadge(adherence), { label: "Minimal 2 of 6 sets", tone: "minimal" });
assert.deepEqual(view.getAdherenceBadge({ status: "complete", countedSets: 12, plannedSets: 12 }), { label: "Complete", tone: "complete" });
assert.deepEqual(view.getAdherenceBadge({ status: "partial", countedSets: 7, plannedSets: 12 }), { label: "Partial 7 of 12 sets", tone: "partial" });
assert.equal(view.getAdherenceBadge({ status: "unplanned" }), null);
assert.equal(view.getAdherenceBadge(null), null);

// History set rows: the editor field per measurement and the detail text.
const plankView = { name: "Plank", repsLabel: "30 s", loadType: "bodyweight" };
assert.deepEqual(view.getHistorySetCountField({ seconds: "30", reps: "", weight: "BW", rpe: "8" }, plankView), { field: "seconds", label: "Seconds", step: 5, noun: "seconds" });
assert.deepEqual(view.getHistorySetCountField({ reps: "12", weight: "BW", rpe: "8" }, plankView), { field: "reps", label: "Reps", step: 1, noun: "reps" });
assert.deepEqual(view.getHistorySetCountField({ reps: "", weight: "", rpe: "" }, plankView).field, "seconds");
assert.deepEqual(view.getHistorySetCountField({ reps: "8" }, { name: "Bench", repsLabel: "6-8" }), { field: "reps", label: "Reps", step: 1, noun: "reps" });
assert.equal(view.formatHistorySetCount({ seconds: 30, perSide: true }), "30 s/side");
assert.equal(view.formatHistorySetCount({ meters: 400 }), "400 m");
assert.equal(view.formatHistorySetCount({ reps: 10, perSide: true }), "10/side");
assert.equal(view.formatHistorySetCount({ reps: 8 }), "8");
assert.equal(view.formatHistorySetCount({ reps: null }), "-");

assert.equal(view.getCoachDecisionLabelWithMeasurement("increase_time"), "Extend time");
assert.equal(view.getCoachDecisionLabelWithMeasurement("increase_distance"), "Extend distance");
assert.equal(view.getCoachDecisionLabelWithMeasurement("hold"), "Hold steady");
assert.equal(view.getCoachDecisionLabelWithMeasurement("nope"), "");

console.log("UI H5 coach controls verification passed.");
