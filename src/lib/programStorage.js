import { workoutProgram } from "../config/workoutProgram.js";
import { readStorage, STORAGE_KEYS, writeStorage } from "./storage.js";

export const PROGRAM_STORAGE_VERSION = 1;
export const DEFAULT_PROGRAM_ID = "default-athletic-bodybuilding-rpe";

function nowIso() {
  return new Date().toISOString();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function byOrderIndex(left, right) {
  return (left.orderIndex ?? 0) - (right.orderIndex ?? 0);
}

function mergeById(existingItems, seedItems) {
  const merged = [...asArray(existingItems)];
  const existingIds = new Set(merged.map((item) => item.id));

  seedItems.forEach((item) => {
    if (!existingIds.has(item.id)) {
      merged.push(item);
    }
  });

  return merged;
}

function makeSectionId(programId, dayId) {
  return `${programId}:${dayId}:main`;
}

function makeProgramExerciseId(programId, dayId, exerciseId) {
  return `${programId}:${dayId}:${exerciseId}`;
}

function makeBaselineId(programExerciseId) {
  return `baseline:${programExerciseId}`;
}

function makeProgressionId(programExerciseId) {
  return `progression:${programExerciseId}`;
}

function makeCopyId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function splitMuscles(muscleGroup) {
  return String(muscleGroup ?? "")
    .split("/")
    .map((muscle) => muscle.trim())
    .filter(Boolean);
}

function createTargetReps(exercise) {
  return {
    min: exercise.repsMin,
    max: exercise.repsMax,
    label: exercise.repsLabel,
  };
}

function createLibraryExercise(exercise) {
  const mainMuscles = splitMuscles(exercise.muscleGroup);

  return {
    id: exercise.id,
    name: exercise.name,
    category: exercise.category,
    mainMuscles,
    secondaryMuscles: [],
    equipment: exercise.equipment,
    difficulty: "intermediate",
    goalTags: [exercise.progressionType, exercise.category, exercise.priority].filter(Boolean),
    setup: "",
    mainCue: "",
    howToDoIt: "",
    executionTips: [],
    commonMistakes: [],
    whatYouShouldFeel: mainMuscles.join(", "),
    whyItsThere: "",
    progressionRegression: "",
    safetyNotes: "",
  };
}

function getLegacyExerciseConfig(exerciseId) {
  for (const day of workoutProgram.days) {
    const exercise = day.exercises.find((entry) => entry.id === exerciseId);
    if (exercise) {
      return exercise;
    }
  }

  return null;
}

function getRepsLabel(targetReps = {}) {
  if (targetReps.label) {
    return targetReps.label;
  }

  if (targetReps.min !== null && targetReps.min !== undefined && targetReps.max !== null && targetReps.max !== undefined) {
    return targetReps.min === targetReps.max
      ? String(targetReps.min)
      : `${targetReps.min}-${targetReps.max}`;
  }

  return "custom";
}

function buildDefaultProgramSeed(createdAt = nowIso()) {
  const program = {
    id: DEFAULT_PROGRAM_ID,
    name: workoutProgram.name,
    description: "Default preloaded athletic bodybuilding program.",
    goal: "Athletic bodybuilding with RPE-based progression",
    isDefault: true,
    isArchived: false,
    createdAt,
    updatedAt: createdAt,
  };
  const days = [];
  const sections = [];
  const libraryExercises = [];
  const programExercises = [];
  const baselines = [];
  const progressions = [];
  const seenExerciseIds = new Set();

  workoutProgram.days.forEach((day, dayIndex) => {
    const programDay = {
      id: day.id,
      programId: program.id,
      name: day.name,
      focus: day.focus,
      orderIndex: dayIndex,
    };
    const section = {
      id: makeSectionId(program.id, day.id),
      programId: program.id,
      dayId: day.id,
      name: day.type === "recovery" ? "Recovery" : "Main Work",
      orderIndex: 0,
    };

    days.push(programDay);
    sections.push(section);

    day.exercises.forEach((exercise, exerciseIndex) => {
      const programExerciseId = makeProgramExerciseId(program.id, day.id, exercise.id);
      const targetReps = createTargetReps(exercise);

      if (!seenExerciseIds.has(exercise.id)) {
        libraryExercises.push(createLibraryExercise(exercise));
        seenExerciseIds.add(exercise.id);
      }

      programExercises.push({
        id: programExerciseId,
        programId: program.id,
        dayId: day.id,
        sectionId: section.id,
        exerciseId: exercise.id,
        orderIndex: exerciseIndex,
        targetSets: exercise.sets,
        targetReps,
        targetWeight: exercise.recommendedWeight,
        targetRPE: exercise.targetRPE,
        restTime: exercise.restSeconds,
        notes: "",
        type: exercise.progressionType,
        isOptional: false,
      });

      baselines.push({
        id: makeBaselineId(programExerciseId),
        programId: program.id,
        programExerciseId,
        startingWeight: exercise.recommendedWeight,
        startingReps: targetReps,
        startingSets: exercise.sets,
        startingRPE: exercise.targetRPE,
        restTime: exercise.restSeconds,
        createdAt,
      });

      progressions.push({
        id: makeProgressionId(programExerciseId),
        programId: program.id,
        programExerciseId,
        lastRecommendedWeight: exercise.recommendedWeight,
        lastRecommendedReps: targetReps,
        lastRecommendedSets: exercise.sets,
        lastTargetRPE: exercise.targetRPE,
        recommendationNote: "Base program prescription.",
        updatedAt: createdAt,
      });
    });
  });

  const programState = {
    programId: program.id,
    lastCompletedDayId: null,
    nextRecommendedDayId: workoutProgram.cycleOrder[0] ?? null,
    currentWeek: 1,
    currentCycle: 1,
    lastWorkoutDate: null,
    updatedAt: createdAt,
  };

  return {
    program,
    days,
    sections,
    libraryExercises,
    programExercises,
    baselines,
    programState,
    progressions,
  };
}

function ensureProgramStorageMeta(seedTime) {
  const existingMeta = readStorage(STORAGE_KEYS.programStorageMeta, null);
  const updatedMeta = {
    schemaVersion: PROGRAM_STORAGE_VERSION,
    createdAt: existingMeta?.createdAt ?? seedTime,
    updatedAt: seedTime,
    defaultProgramId: existingMeta?.defaultProgramId ?? DEFAULT_PROGRAM_ID,
  };

  writeStorage(STORAGE_KEYS.programStorageMeta, updatedMeta);
  return updatedMeta;
}

function getProgramStates() {
  return asArray(readStorage(STORAGE_KEYS.programStates, []));
}

function writeProgramStates(states) {
  writeStorage(STORAGE_KEYS.programStates, asArray(states));
}

function getBaselines() {
  return asArray(readStorage(STORAGE_KEYS.baselines, []));
}

function getProgramProgressions() {
  return asArray(readStorage(STORAGE_KEYS.programProgressions, []));
}

export function seedDefaultProgramIfNeeded() {
  const seedTime = nowIso();
  const existingPrograms = getPrograms();
  const seed = buildDefaultProgramSeed(seedTime);

  ensureProgramStorageMeta(seedTime);

  if (!existingPrograms.length) {
    writeStorage(STORAGE_KEYS.programs, mergeById(existingPrograms, [seed.program]));
    writeStorage(
      STORAGE_KEYS.programDays,
      mergeById(readStorage(STORAGE_KEYS.programDays, []), seed.days),
    );
    writeStorage(
      STORAGE_KEYS.programSections,
      mergeById(readStorage(STORAGE_KEYS.programSections, []), seed.sections),
    );
    writeStorage(
      STORAGE_KEYS.exerciseLibrary,
      mergeById(readStorage(STORAGE_KEYS.exerciseLibrary, []), seed.libraryExercises),
    );
    writeStorage(
      STORAGE_KEYS.programExercises,
      mergeById(readStorage(STORAGE_KEYS.programExercises, []), seed.programExercises),
    );
    writeStorage(
      STORAGE_KEYS.baselines,
      mergeById(readStorage(STORAGE_KEYS.baselines, []), seed.baselines),
    );
    writeStorage(
      STORAGE_KEYS.programProgressions,
      mergeById(readStorage(STORAGE_KEYS.programProgressions, []), seed.progressions),
    );
    writeProgramStates(mergeById(getProgramStates(), [seed.programState]));
    writeStorage(STORAGE_KEYS.activeProgramId, seed.program.id);

    return {
      seeded: true,
      activeProgramId: seed.program.id,
    };
  }

  if (!getActiveProgramId()) {
    const defaultProgram =
      existingPrograms.find((program) => program.isDefault && !program.isArchived) ??
      existingPrograms.find((program) => !program.isArchived) ??
      existingPrograms[0];

    if (defaultProgram) {
      writeStorage(STORAGE_KEYS.activeProgramId, defaultProgram.id);
    }
  }

  return {
    seeded: false,
    activeProgramId: getActiveProgramId(),
  };
}

export function getPrograms() {
  return asArray(readStorage(STORAGE_KEYS.programs, []));
}

export function getActiveProgramId() {
  const storedProgramId = readStorage(STORAGE_KEYS.activeProgramId, null);
  const programs = getPrograms();
  const activeProgram = programs.find(
    (program) => program.id === storedProgramId && !program.isArchived,
  );

  if (activeProgram) {
    return activeProgram.id;
  }

  const fallbackProgram =
    programs.find((program) => program.isDefault && !program.isArchived) ??
    programs.find((program) => !program.isArchived) ??
    programs[0] ??
    null;

  if (fallbackProgram) {
    writeStorage(STORAGE_KEYS.activeProgramId, fallbackProgram.id);
    return fallbackProgram.id;
  }

  return null;
}

export function getActiveProgram() {
  const activeProgramId = getActiveProgramId();
  return getPrograms().find((program) => program.id === activeProgramId) ?? null;
}

export function setActiveProgram(programId) {
  const program = getPrograms().find(
    (candidate) => candidate.id === programId && !candidate.isArchived,
  );

  if (!program) {
    return null;
  }

  writeStorage(STORAGE_KEYS.activeProgramId, program.id);
  return program.id;
}

export function getProgramDays(programId) {
  return asArray(readStorage(STORAGE_KEYS.programDays, []))
    .filter((day) => day.programId === programId)
    .sort(byOrderIndex);
}

export function getProgramSections(dayId) {
  return asArray(readStorage(STORAGE_KEYS.programSections, []))
    .filter((section) => section.dayId === dayId)
    .sort(byOrderIndex);
}

export function getProgramExercises(dayId) {
  return asArray(readStorage(STORAGE_KEYS.programExercises, []))
    .filter((programExercise) => programExercise.dayId === dayId)
    .sort(byOrderIndex);
}

export function getExerciseById(exerciseId) {
  return (
    asArray(readStorage(STORAGE_KEYS.exerciseLibrary, [])).find(
      (exercise) => exercise.id === exerciseId,
    ) ?? null
  );
}

export function getExerciseLibrary() {
  return asArray(readStorage(STORAGE_KEYS.exerciseLibrary, [])).sort((left, right) =>
    String(left.name ?? "").localeCompare(String(right.name ?? "")),
  );
}

export function getProgramState(programId) {
  const state = getProgramStates().find((programState) => programState.programId === programId);

  if (state) {
    return state;
  }

  return {
    programId,
    lastCompletedDayId: null,
    nextRecommendedDayId: getProgramDays(programId)[0]?.id ?? null,
    currentWeek: 1,
    currentCycle: 1,
    lastWorkoutDate: null,
    updatedAt: nowIso(),
  };
}

export function updateProgramState(programId, patch) {
  const states = getProgramStates();
  const existingIndex = states.findIndex((programState) => programState.programId === programId);
  const updatedState = {
    ...(existingIndex >= 0 ? states[existingIndex] : getProgramState(programId)),
    ...patch,
    programId,
    updatedAt: nowIso(),
  };

  if (existingIndex >= 0) {
    states[existingIndex] = updatedState;
  } else {
    states.push(updatedState);
  }

  writeProgramStates(states);
  return updatedState;
}

export function getProgramBaseline(programId, programExerciseId) {
  return (
    getBaselines().find(
      (baseline) =>
        baseline.programId === programId && baseline.programExerciseId === programExerciseId,
    ) ?? null
  );
}

export function getProgramProgression(programId, programExerciseId) {
  return (
    getProgramProgressions().find(
      (progression) =>
        progression.programId === programId &&
        progression.programExerciseId === programExerciseId,
    ) ?? null
  );
}

export function upsertProgramProgressionsFromPlan(programId, plan) {
  if (!programId || !plan?.exercises?.length) {
    return [];
  }

  const updatedAt = nowIso();
  const progressions = getProgramProgressions();

  plan.exercises.forEach((exercisePlan) => {
    const programExerciseId = exercisePlan.exerciseId;
    const existingIndex = progressions.findIndex(
      (progression) =>
        progression.programId === programId &&
        progression.programExerciseId === programExerciseId,
    );
    const recommendationNote =
      exercisePlan.reasons?.filter(Boolean).join(" ") ||
      exercisePlan.repFocus ||
      "Starting recommendation based on baseline.";
    const progressionRecord = {
      ...(existingIndex >= 0 ? progressions[existingIndex] : {}),
      id: makeProgressionId(programExerciseId),
      programId,
      programExerciseId,
      lastRecommendedWeight: exercisePlan.recommendedWeight,
      lastRecommendedReps: {
        min: exercisePlan.repsMin,
        max: exercisePlan.repsMax,
        label: exercisePlan.repsLabel,
      },
      lastRecommendedSets: exercisePlan.sets,
      lastTargetRPE: exercisePlan.targetRPE,
      recommendationNote,
      repFocus: exercisePlan.repFocus ?? null,
      previousWeight: exercisePlan.previousWeight ?? null,
      totalReps: exercisePlan.totalReps ?? null,
      previousTotalReps: exercisePlan.previousTotalReps ?? null,
      exerciseRPE: exercisePlan.exerciseRPE ?? null,
      conservative: Boolean(exercisePlan.conservative),
      sourceSessionId: plan.sourceSessionId ?? null,
      sourcePlanGeneratedAt: plan.generatedAt ?? null,
      updatedAt,
    };

    if (existingIndex >= 0) {
      progressions[existingIndex] = progressionRecord;
    } else {
      progressions.push(progressionRecord);
    }
  });

  writeStorage(STORAGE_KEYS.programProgressions, progressions);
  return progressions;
}

export function getProgramDayViewModels(programId) {
  return getProgramDays(programId).map((day) => {
    const sections = getProgramSections(day.id);
    const sectionById = new Map(sections.map((section) => [section.id, section]));
    const exercises = getProgramExercises(day.id).map((programExercise) => {
      const libraryExercise = getExerciseById(programExercise.exerciseId);
      const legacyExercise = getLegacyExerciseConfig(programExercise.exerciseId);
      const mainMuscles = libraryExercise?.mainMuscles?.length
        ? libraryExercise.mainMuscles.join(" / ")
        : legacyExercise?.muscleGroup ?? "";

      return {
        ...(legacyExercise ?? {}),
        id: programExercise.id,
        programExerciseId: programExercise.id,
        libraryExerciseId: programExercise.exerciseId,
        legacyExerciseId: programExercise.exerciseId,
        programId: programExercise.programId,
        dayId: programExercise.dayId,
        sectionId: programExercise.sectionId,
        sectionName: sectionById.get(programExercise.sectionId)?.name ?? "Main Work",
        name: libraryExercise?.name ?? legacyExercise?.name ?? "Exercise",
        category: libraryExercise?.category ?? legacyExercise?.category ?? "compound",
        equipment: libraryExercise?.equipment ?? legacyExercise?.equipment ?? "machine",
        muscleGroup: mainMuscles,
        priority: legacyExercise?.priority ?? "medium",
        progressionType: programExercise.type ?? legacyExercise?.progressionType ?? "hypertrophy",
        sets: programExercise.targetSets,
        repsMin: programExercise.targetReps?.min ?? null,
        repsMax: programExercise.targetReps?.max ?? null,
        repsLabel: getRepsLabel(programExercise.targetReps),
        targetRPE: programExercise.targetRPE,
        restSeconds: programExercise.restTime,
        recommendedWeight: programExercise.targetWeight,
        loadType:
          legacyExercise?.loadType ??
          (libraryExercise?.equipment === "bodyweight" ? "bodyweight" : "external"),
        weightMode: legacyExercise?.weightMode ?? "kg",
        incrementKg: legacyExercise?.incrementKg,
        roundToKg: legacyExercise?.roundToKg,
        mainMuscles: libraryExercise?.mainMuscles ?? [],
        secondaryMuscles: libraryExercise?.secondaryMuscles ?? [],
        difficulty: libraryExercise?.difficulty ?? "",
        goalTags: libraryExercise?.goalTags ?? [],
        setup: libraryExercise?.setup ?? "",
        mainCue: libraryExercise?.mainCue ?? "",
        howToDoIt: libraryExercise?.howToDoIt ?? "",
        executionTips: libraryExercise?.executionTips ?? [],
        commonMistakes: libraryExercise?.commonMistakes ?? [],
        whatYouShouldFeel: libraryExercise?.whatYouShouldFeel ?? "",
        whyItsThere: libraryExercise?.whyItsThere ?? "",
        progressionRegression: libraryExercise?.progressionRegression ?? "",
        safetyNotes: libraryExercise?.safetyNotes ?? "",
        notes: programExercise.notes ?? "",
        isOptional: Boolean(programExercise.isOptional),
      };
    });
    const legacyDay = workoutProgram.days.find((entry) => entry.id === day.id);

    return {
      ...day,
      shortName: legacyDay?.shortName ?? day.name,
      type: exercises.length ? "training" : "recovery",
      activities: legacyDay?.activities ?? [],
      sections,
      exercises,
    };
  });
}

export function getProgramDayViewModel(programId, dayId) {
  return (
    getProgramDayViewModels(programId).find((day) => day.id === dayId) ??
    getProgramDayViewModels(programId)[0] ??
    null
  );
}

export function duplicateProgram(programId) {
  const sourceProgram = getPrograms().find((program) => program.id === programId);
  if (!sourceProgram) {
    return null;
  }

  const createdAt = nowIso();
  const newProgramId = makeCopyId("program-copy");
  const sourceDays = getProgramDays(sourceProgram.id);
  const sourceSections = asArray(readStorage(STORAGE_KEYS.programSections, [])).filter(
    (section) => section.programId === sourceProgram.id,
  );
  const sourceProgramExercises = asArray(readStorage(STORAGE_KEYS.programExercises, [])).filter(
    (exercise) => exercise.programId === sourceProgram.id,
  );
  const sourceBaselines = asArray(readStorage(STORAGE_KEYS.baselines, [])).filter(
    (baseline) => baseline.programId === sourceProgram.id,
  );
  const sourceProgressions = asArray(readStorage(STORAGE_KEYS.programProgressions, [])).filter(
    (progression) => progression.programId === sourceProgram.id,
  );
  const dayIdMap = new Map(
    sourceDays.map((day, index) => [day.id, `${newProgramId}:day-${index + 1}`]),
  );
  const sectionIdMap = new Map(
    sourceSections.map((section, index) => [
      section.id,
      `${newProgramId}:section-${index + 1}`,
    ]),
  );
  const programExerciseIdMap = new Map(
    sourceProgramExercises.map((programExercise, index) => [
      programExercise.id,
      `${newProgramId}:exercise-${index + 1}-${programExercise.exerciseId}`,
    ]),
  );
  const duplicate = {
    ...sourceProgram,
    id: newProgramId,
    name: `${sourceProgram.name} Copy`,
    isDefault: false,
    isArchived: false,
    createdAt,
    updatedAt: createdAt,
  };
  const copiedDays = sourceDays.map((day) => ({
    ...day,
    id: dayIdMap.get(day.id),
    programId: newProgramId,
  }));
  const copiedSections = sourceSections.map((section) => ({
    ...section,
    id: sectionIdMap.get(section.id),
    programId: newProgramId,
    dayId: dayIdMap.get(section.dayId),
  }));
  const copiedProgramExercises = sourceProgramExercises.map((programExercise) => ({
    ...programExercise,
    id: programExerciseIdMap.get(programExercise.id),
    programId: newProgramId,
    dayId: dayIdMap.get(programExercise.dayId),
    sectionId: sectionIdMap.get(programExercise.sectionId),
  }));
  const copiedBaselines = sourceBaselines
    .filter((baseline) => programExerciseIdMap.has(baseline.programExerciseId))
    .map((baseline) => {
      const programExerciseId = programExerciseIdMap.get(baseline.programExerciseId);
      return {
        ...baseline,
        id: makeBaselineId(programExerciseId),
        programId: newProgramId,
        programExerciseId,
        createdAt,
      };
    });
  const copiedProgressions = sourceProgressions
    .filter((progression) => programExerciseIdMap.has(progression.programExerciseId))
    .map((progression) => {
      const programExerciseId = programExerciseIdMap.get(progression.programExerciseId);
      return {
        ...progression,
        id: makeProgressionId(programExerciseId),
        programId: newProgramId,
        programExerciseId,
        updatedAt: createdAt,
      };
    });
  const copiedState = {
    programId: newProgramId,
    lastCompletedDayId: null,
    nextRecommendedDayId: copiedDays[0]?.id ?? null,
    currentWeek: 1,
    currentCycle: 1,
    lastWorkoutDate: null,
    updatedAt: createdAt,
  };

  writeStorage(STORAGE_KEYS.programs, [...getPrograms(), duplicate]);
  writeStorage(STORAGE_KEYS.programDays, [
    ...asArray(readStorage(STORAGE_KEYS.programDays, [])),
    ...copiedDays,
  ]);
  writeStorage(STORAGE_KEYS.programSections, [
    ...asArray(readStorage(STORAGE_KEYS.programSections, [])),
    ...copiedSections,
  ]);
  writeStorage(STORAGE_KEYS.programExercises, [
    ...asArray(readStorage(STORAGE_KEYS.programExercises, [])),
    ...copiedProgramExercises,
  ]);
  writeStorage(STORAGE_KEYS.baselines, [
    ...asArray(readStorage(STORAGE_KEYS.baselines, [])),
    ...copiedBaselines,
  ]);
  writeStorage(STORAGE_KEYS.programProgressions, [
    ...asArray(readStorage(STORAGE_KEYS.programProgressions, [])),
    ...copiedProgressions,
  ]);
  writeProgramStates([...getProgramStates(), copiedState]);

  return duplicate;
}
