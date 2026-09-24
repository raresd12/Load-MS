// H1 Track C: shared prescription resolver (review finding F9, decision 19.4-2).
// Precedence: earned progression -> generated plan -> program target -> baseline.
// Editing a program target removes the stored progression and the pending plan
// entry, so the resolver falls back to the new target.
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
  BASE_PLAN_REASON,
  getPrescriptionSourceLabel,
  isEarnedProgression,
  isGeneratedPlanExercise,
  resolvePrescription,
} = await import("../src/lib/prescription.js");

// ---------------------------------------------------------------------------
// Pure precedence
// ---------------------------------------------------------------------------
const programExercise = {
  id: "pe-bench",
  programExerciseId: "pe-bench",
  programId: "program-a",
  dayId: "day-1",
  sets: 3,
  repsMin: 6,
  repsMax: 8,
  repsLabel: "6-8",
  targetRPE: 8,
  restSeconds: [150, 180],
  recommendedWeight: 60,
  loadType: "external",
};
const basePlanExercise = {
  exerciseId: "pe-bench",
  sets: 3,
  repsMin: 6,
  repsMax: 8,
  repsLabel: "6-8",
  targetRPE: 8,
  restSeconds: [150, 180],
  recommendedWeight: 60,
  reasons: [BASE_PLAN_REASON],
  decision: "hold",
  confidence: "low",
};
const generatedPlanExercise = {
  ...basePlanExercise,
  sets: 3,
  recommendedWeight: 62.5,
  targetRPE: 8.5,
  restSeconds: 180,
  reasons: ["Hit the top of the rep range at RPE 8, so load goes up."],
  decision: "increase_load",
  confidence: "high",
  warnings: ["Older sessions without exercise ids were skipped."],
  historyTrend: "improving",
  historySampleSize: 2,
  progressionMode: "double_progression",
  repFocus: "Own the new load.",
};
const earnedProgression = {
  programId: "program-a",
  programExerciseId: "pe-bench",
  lastRecommendedWeight: 65,
  lastRecommendedReps: { min: 6, max: 8, label: "6-8" },
  lastRecommendedSets: 4,
  lastTargetRPE: 9,
  recommendationNote: "Two strong sessions in a row.",
  decision: "increase_load",
  confidence: "high",
  warnings: [],
  sourceSessionId: "session-1",
  sourcePlanGeneratedAt: "2026-09-10T10:00:00.000Z",
};
const baseline = {
  programId: "program-a",
  programExerciseId: "pe-bench",
  startingWeight: 50,
  startingReps: { min: 5, max: 5, label: "5" },
  startingSets: 5,
  startingRPE: 7,
  restTime: 120,
};

// 1. Earned progression wins.
{
  const resolved = resolvePrescription({
    programExercise,
    progression: earnedProgression,
    planExercise: generatedPlanExercise,
    baseline,
    planStatus: "generated",
  });
  assert.equal(resolved.source, "progression");
  assert.equal(resolved.weight, 65);
  assert.equal(resolved.sets, 4);
  assert.equal(resolved.targetRPE, 9);
  assert.equal(resolved.repsLabel, "6-8");
  assert.deepEqual(resolved.restSeconds, 180, "rest is not stored on progressions; plan supplies it");
  assert.equal(resolved.fieldSources.weight, "progression");
  assert.equal(resolved.fieldSources.restSeconds, "plan");
  assert.equal(resolved.coach.recommendationNote, "Two strong sessions in a row.");
  assert.equal(resolved.coach.decision, "increase_load");
  assert.match(resolved.sourceDetail, /last saved session/);
}

// 2. Without an earned progression the generated plan wins.
{
  const resolved = resolvePrescription({
    programExercise,
    progression: null,
    planExercise: generatedPlanExercise,
    baseline,
    planStatus: "generated",
  });
  assert.equal(resolved.source, "plan");
  assert.equal(resolved.weight, 62.5);
  assert.equal(resolved.targetRPE, 8.5);
  assert.equal(resolved.coach.decision, "increase_load");
  assert.deepEqual(resolved.coach.warnings, ["Older sessions without exercise ids were skipped."]);
  assert.equal(resolved.coach.historySampleSize, 2);
}

// 3. A base plan is not a generated plan: program target wins and rest range is preserved.
{
  const resolved = resolvePrescription({
    programExercise,
    progression: null,
    planExercise: basePlanExercise,
    baseline,
    planStatus: "base",
  });
  assert.equal(resolved.source, "target");
  assert.equal(resolved.weight, 60);
  assert.deepEqual(resolved.restSeconds, [150, 180], "stored range flows through untouched");
  assert.equal(resolved.coach.decision, null, "base plan carries no earned decision");
  assert.match(resolved.coach.recommendationNote, /program target/);
}

// 3b. planStatus omitted: base-plan reasons are recognised as not generated.
assert.equal(isGeneratedPlanExercise(basePlanExercise), false);
assert.equal(isGeneratedPlanExercise(generatedPlanExercise), true);
assert.equal(isGeneratedPlanExercise(basePlanExercise, "manual"), true, "manual weight edit counts as a plan");

// 3c. Fixer round 1: a base-plan entry inside a "generated" day plan (the entry
// getPlanForDay refills after a target edit removed it, decision 19.4-2) is not
// a generated recommendation, whatever the plan status says.
assert.equal(
  isGeneratedPlanExercise(basePlanExercise, "generated"),
  false,
  "refilled base entry in a generated plan is not generated",
);
assert.equal(isGeneratedPlanExercise(generatedPlanExercise, "generated"), true);
assert.equal(
  isGeneratedPlanExercise({ ...basePlanExercise, manuallyAdjusted: true }, "generated"),
  true,
  "a manually adjusted entry counts even inside a generated plan",
);
{
  const resolved = resolvePrescription({
    programExercise: { ...programExercise, recommendedWeight: 70 },
    progression: null,
    planExercise: { ...basePlanExercise, recommendedWeight: 70 },
    baseline,
    planStatus: "generated",
  });
  assert.equal(resolved.source, "target", "values from the edited target carry the target source");
  assert.equal(resolved.weight, 70);
  assert.equal(resolved.coach.decision, null, "no fake hold/low decision from the base fill");
  assert.match(resolved.coach.recommendationNote, /program target/);
}

// 4. Baseline only when nothing else has the value.
{
  const resolved = resolvePrescription({
    programExercise: { ...programExercise, recommendedWeight: null, targetRPE: null },
    progression: null,
    planExercise: null,
    baseline,
  });
  assert.equal(resolved.weight, 50);
  assert.equal(resolved.targetRPE, 7);
  assert.equal(resolved.sets, 3, "target sets still win over baseline sets");
  assert.equal(resolved.fieldSources.weight, "baseline");
  assert.equal(resolved.source, "target", "highest source that supplied a value");
}

{
  const resolved = resolvePrescription({ baseline });
  assert.equal(resolved.source, "baseline");
  assert.equal(resolved.repsLabel, "5");
}

// 5. Progression provenance rules.
assert.equal(isEarnedProgression(earnedProgression, programExercise), true);
assert.equal(
  isEarnedProgression({ ...earnedProgression, sourceSessionId: null, sourcePlanGeneratedAt: null, recommendationNote: BASE_PLAN_REASON }, programExercise),
  false,
  "duplicate-style fresh progression (decision 19.4-1) is not earned",
);
assert.equal(
  isEarnedProgression({ ...earnedProgression, sourceSessionId: null }, programExercise),
  true,
  "older earned records with sourcePlanGeneratedAt + real note stay usable",
);
assert.equal(
  isEarnedProgression({ ...earnedProgression, programId: "program-b" }, programExercise),
  false,
  "a progression from another program never wins (F1)",
);
assert.equal(
  isEarnedProgression({ ...earnedProgression, programExerciseId: "pe-other" }, programExercise),
  false,
);
assert.equal(isEarnedProgression(null), false);

{
  const resolved = resolvePrescription({
    programExercise,
    progression: { ...earnedProgression, sourceSessionId: null, sourcePlanGeneratedAt: null, recommendationNote: BASE_PLAN_REASON },
    planExercise: basePlanExercise,
    baseline,
    planStatus: "base",
  });
  assert.equal(resolved.source, "target");
  assert.equal(resolved.weight, 60);
}

// 6. Null weight on a bodyweight exercise stays null (no "0" invented).
{
  const bodyweight = { ...programExercise, recommendedWeight: null, loadType: "bodyweight" };
  const resolved = resolvePrescription({
    programExercise: bodyweight,
    progression: { ...earnedProgression, lastRecommendedWeight: null },
    planExercise: { ...generatedPlanExercise, recommendedWeight: null },
    baseline: null,
    planStatus: "generated",
  });
  assert.equal(resolved.weight, null);
  assert.equal(resolved.fieldSources.weight, null);
  assert.equal(resolved.source, "progression");
}

// 7. Raw ProgramExercise records (targetSets/targetReps/restTime/targetWeight) are accepted.
{
  const resolved = resolvePrescription({
    programExercise: {
      id: "pe-row",
      programId: "program-a",
      targetSets: 3,
      targetReps: { min: 10, max: 12, label: null },
      targetRPE: 8,
      restTime: 90,
      targetWeight: 40,
    },
  });
  assert.equal(resolved.sets, 3);
  assert.equal(resolved.repsLabel, "10-12");
  assert.equal(resolved.restSeconds, 90);
  assert.equal(resolved.weight, 40);
}

assert.equal(getPrescriptionSourceLabel("progression"), "Source: earned progression");
assert.equal(getPrescriptionSourceLabel("nope"), "");

// ---------------------------------------------------------------------------
// Storage integration (decision 19.4-2): target edit clears progression + plan entry.
// ---------------------------------------------------------------------------
const {
  DEFAULT_PROGRAM_ID,
  duplicateProgram,
  getProgramBaseline,
  getProgramDayViewModels,
  getProgramProgression,
  persistWorkoutSave,
  removeExerciseFromNextPlans,
  seedDefaultProgramIfNeeded,
  updateProgramExerciseTargetChecked,
} = await import("../src/lib/programStorage.js");
const { getPlanForDay } = await import("../src/lib/progression.js");

try {
  seedDefaultProgramIfNeeded();
  const copy = duplicateProgram(DEFAULT_PROGRAM_ID);
  assert.equal(copy.ok, true);
  const programId = copy.programId;
  const day = getProgramDayViewModels(programId).find((candidate) => candidate.type === "training");
  const exercise = day.exercises[0];

  // Fresh copy: no earned progression, base plan -> program target.
  {
    const plan = getPlanForDay(day, undefined);
    const resolved = resolvePrescription({
      programExercise: exercise,
      progression: getProgramProgression(programId, exercise.programExerciseId),
      planExercise: plan.exercises.find((entry) => entry.exerciseId === exercise.id),
      baseline: getProgramBaseline(programId, exercise.programExerciseId),
      planStatus: plan.status,
    });
    assert.equal(resolved.source, "target", "duplicate starts from its program target");
    assert.equal(resolved.weight, exercise.recommendedWeight);
    assert.equal(resolved.sets, exercise.sets);
  }

  // Save a session: progression earned + generated plan stored.
  const generatedPlan = {
    schemaVersion: 2,
    dayId: day.id,
    dayName: day.name,
    dayType: day.type,
    generatedAt: "2026-09-18T10:00:00.000Z",
    sourceSessionId: "session-1",
    status: "generated",
    exercises: [
      {
        exerciseId: exercise.id,
        name: exercise.name,
        sets: exercise.sets,
        repsMin: exercise.repsMin,
        repsMax: exercise.repsMax,
        repsLabel: exercise.repsLabel,
        restSeconds: exercise.restSeconds,
        targetRPE: exercise.targetRPE,
        recommendedWeight: 77.5,
        reasons: ["Top of the range at target RPE, so load goes up."],
        decision: "increase_load",
        confidence: "high",
        warnings: [],
      },
    ],
  };
  const saveResult = persistWorkoutSave({
    sessions: [{ id: "session-1", programId, dayId: day.id, date: "2026-09-18T10:00:00.000Z" }],
    nextPlans: { [day.id]: generatedPlan },
    workoutDrafts: {},
    programId,
    plan: generatedPlan,
  });
  assert.equal(saveResult.ok, true);

  let nextPlans = { [day.id]: generatedPlan };
  {
    const plan = getPlanForDay(day, nextPlans[day.id]);
    const progression = getProgramProgression(programId, exercise.programExerciseId);
    assert.equal(progression.sourceSessionId, "session-1");
    const resolved = resolvePrescription({
      programExercise: exercise,
      progression,
      planExercise: plan.exercises.find((entry) => entry.exerciseId === exercise.id),
      baseline: getProgramBaseline(programId, exercise.programExerciseId),
      planStatus: plan.status,
    });
    assert.equal(resolved.source, "progression");
    assert.equal(resolved.weight, 77.5);
  }

  // Edit the target: progression deleted (Track B) + plan entry removed (UI helper).
  const editResult = updateProgramExerciseTargetChecked(programId, exercise.programExerciseId, {
    targetWeight: 70,
    restTime: [150, 180],
  });
  assert.equal(editResult.ok, true);
  assert.equal(editResult.deletedProgression, true);
  nextPlans = removeExerciseFromNextPlans(nextPlans, exercise.programExerciseId);

  {
    const editedDay = getProgramDayViewModels(programId).find((candidate) => candidate.id === day.id);
    const editedExercise = editedDay.exercises.find((entry) => entry.id === exercise.id);
    const plan = getPlanForDay(editedDay, nextPlans[editedDay.id]);
    const planExercise = plan.exercises.find((entry) => entry.exerciseId === editedExercise.id);
    const resolved = resolvePrescription({
      programExercise: editedExercise,
      progression: getProgramProgression(programId, editedExercise.programExerciseId),
      planExercise,
      baseline: getProgramBaseline(programId, editedExercise.programExerciseId),
      planStatus: plan.status,
    });
    assert.equal(resolved.source, "target", "after a target edit the next session starts from the target");
    assert.equal(resolved.weight, 70);
    assert.deepEqual(resolved.restSeconds, [150, 180], "rest range from the editor is preserved");
    assert.equal(resolved.coach.decision, null);
  }

  // Fixer round 1: the same edit on a day whose generated plan has OTHER
  // exercises. The plan keeps status "generated" (only the edited entry is
  // removed), getPlanForDay refills that entry from the base plan, and the
  // resolver must still report the target as the source.
  {
    const secondExercise = day.exercises[1];
    assert.ok(secondExercise, "fixture needs a day with two exercises");
    const twoExercisePlan = {
      ...generatedPlan,
      generatedAt: "2026-09-19T10:00:00.000Z",
      sourceSessionId: "session-2",
      exercises: [
        { ...generatedPlan.exercises[0], recommendedWeight: 80 },
        {
          exerciseId: secondExercise.id,
          name: secondExercise.name,
          sets: secondExercise.sets,
          repsMin: secondExercise.repsMin,
          repsMax: secondExercise.repsMax,
          repsLabel: secondExercise.repsLabel,
          restSeconds: secondExercise.restSeconds,
          targetRPE: secondExercise.targetRPE,
          recommendedWeight: secondExercise.recommendedWeight,
          reasons: ["Hold this load and add reps."],
          decision: "increase_reps",
          confidence: "medium",
          warnings: [],
        },
      ],
    };
    const saved = persistWorkoutSave({
      sessions: [{ id: "session-2", programId, dayId: day.id, date: "2026-09-19T10:00:00.000Z" }],
      nextPlans: { [day.id]: twoExercisePlan },
      workoutDrafts: {},
      programId,
      plan: twoExercisePlan,
    });
    assert.equal(saved.ok, true);

    const edit = updateProgramExerciseTargetChecked(programId, exercise.programExerciseId, {
      targetSets: 3,
      targetWeight: 70,
    });
    assert.equal(edit.ok, true);
    let plans = removeExerciseFromNextPlans({ [day.id]: twoExercisePlan }, exercise.programExerciseId);
    assert.equal(plans[day.id].status, "generated", "plan survives with the other exercise");
    assert.equal(plans[day.id].generatedAt, twoExercisePlan.generatedAt, "generatedAt unchanged");

    const editedDay = getProgramDayViewModels(programId).find((candidate) => candidate.id === day.id);
    const plan = getPlanForDay(editedDay, plans[day.id]);
    const editedExercise = editedDay.exercises.find((entry) => entry.id === exercise.id);
    const refilledEntry = plan.exercises.find((entry) => entry.exerciseId === exercise.id);
    assert.equal(refilledEntry.reasons[0], BASE_PLAN_REASON, "entry was refilled from the base plan");
    assert.equal(refilledEntry.sets, 3, "refilled entry shows the edited set count");

    const resolvedEdited = resolvePrescription({
      programExercise: editedExercise,
      progression: getProgramProgression(programId, editedExercise.programExerciseId),
      planExercise: refilledEntry,
      baseline: getProgramBaseline(programId, editedExercise.programExerciseId),
      planStatus: plan.status,
    });
    assert.equal(resolvedEdited.source, "target", "edited exercise reports the target, not the plan");
    assert.equal(resolvedEdited.weight, 70);
    assert.equal(resolvedEdited.sets, 3);
    assert.equal(resolvedEdited.coach.decision, null);
    assert.match(resolvedEdited.coach.recommendationNote, /program target/);

    const otherExercise = editedDay.exercises.find((entry) => entry.id === secondExercise.id);
    const resolvedOther = resolvePrescription({
      programExercise: otherExercise,
      progression: null,
      planExercise: plan.exercises.find((entry) => entry.exerciseId === secondExercise.id),
      baseline: getProgramBaseline(programId, otherExercise.programExerciseId),
      planStatus: plan.status,
    });
    assert.equal(resolvedOther.source, "plan", "untouched exercise still uses the generated plan");
    assert.equal(resolvedOther.coach.decision, "increase_reps");
  }
} finally {
  console.warn = originalWarn;
}

console.log("verify-prescription: all assertions passed");
