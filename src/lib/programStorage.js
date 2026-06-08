import {
  athleticAestheticBasketballProgram,
  workoutProgram,
} from "../config/workoutProgram.js";
import { exerciseLibraryContentBatches } from "../data/exerciseLibraryContent.js";
import { readStorage, STORAGE_KEYS, writeStorage } from "./storage.js";

export const PROGRAM_STORAGE_VERSION = 1;
export const DEFAULT_PROGRAM_ID = "default-athletic-bodybuilding-rpe";
export const ATHLETIC_AESTHETIC_BASKETBALL_PROGRAM_ID =
  "default-athletic-aesthetic-basketball";

function nowIso() {
  return new Date().toISOString();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asCleanArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
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

function isEmptyLibraryValue(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => String(item ?? "").trim()).length === 0;
  }

  return value === null || value === undefined || String(value).trim() === "";
}

function normalizeLibraryValue(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? "").trim().toLowerCase())
      .filter(Boolean)
      .join("|");
  }

  return String(value ?? "").trim().toLowerCase();
}

function shouldFillLibraryField(currentValue, seededValue) {
  return (
    isEmptyLibraryValue(currentValue) ||
    normalizeLibraryValue(currentValue) === normalizeLibraryValue(seededValue)
  );
}

function normalizeExerciseLibraryContent(content) {
  return {
    name: content.exercise_name,
    category: content.category,
    mainMuscles: asCleanArray(content.main_muscles),
    secondaryMuscles: asCleanArray(content.secondary_muscles),
    equipment: content.equipment,
    difficulty: content.difficulty,
    goalTags: asCleanArray(content.goal_tags),
    setup: content.setup,
    mainCue: content.main_cue,
    howToDoIt: content.how_to_do_it,
    executionTips: content.execution_tips,
    commonMistakes: content.common_mistakes,
    whatYouShouldFeel: content.what_you_should_feel,
    whyItsThere: content.why_its_there,
    progressionRegression: content.progression_regression,
    safetyNotes: content.safety_notes,
    video_url: content.video_url,
  };
}

function getExerciseLibraryContentById() {
  return exerciseLibraryContentBatches.reduce((contentById, batch) => {
    Object.entries(batch).forEach(([exerciseId, content]) => {
      contentById.set(exerciseId, normalizeExerciseLibraryContent(content));
    });

    return contentById;
  }, new Map());
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
    videoUrl: "",
    video_url: "",
  };
}

function getLegacyExerciseConfig(exerciseId) {
  for (const program of [workoutProgram, athleticAestheticBasketballProgram]) {
    for (const day of program.days) {
      const exercise = day.exercises.find((entry) => entry.id === exerciseId);
      if (exercise) {
        return exercise;
      }
    }
  }

  return null;
}

function getLegacyDayConfig(dayId) {
  for (const program of [workoutProgram, athleticAestheticBasketballProgram]) {
    const day = program.days.find((entry) => entry.id === dayId);
    if (day) {
      return day;
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

function normalizeWarmupItem(item, index) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const name = String(item.name ?? "").trim();
  const prescription = String(item.prescription ?? "").trim();
  const notes = String(item.notes ?? "").trim();
  const videoUrl = String(item.videoUrl ?? item.video_url ?? "").trim();

  if (!name && !prescription) {
    return null;
  }

  return {
    id: String(item.id ?? `warmup-${index + 1}`).trim() || `warmup-${index + 1}`,
    name,
    prescription,
    notes,
    videoUrl,
  };
}

function normalizeWarmup(warmup) {
  if (!warmup || typeof warmup !== "object") {
    return null;
  }

  const items = asArray(warmup.items)
    .map((item, index) => normalizeWarmupItem(item, index))
    .filter(Boolean);

  if (!items.length) {
    return null;
  }

  return {
    title: String(warmup.title ?? "").trim() || "Warm-up & Activation",
    items,
  };
}

function buildProgramSeedFromConfig(programConfig, options, createdAt = nowIso()) {
  const program = {
    id: options.programId,
    name: programConfig.name,
    nickname: options.nickname ?? programConfig.nickname ?? "",
    description: options.description ?? programConfig.description ?? "",
    goal: options.goal ?? programConfig.goal ?? "",
    isDefault: Boolean(options.isDefault),
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

  programConfig.days.forEach((day, dayIndex) => {
    const programDay = {
      id: day.id,
      programId: program.id,
      name: day.name,
      focus: day.focus,
      orderIndex: dayIndex,
    };
    const warmup = normalizeWarmup(day.warmup);

    if (warmup) {
      programDay.warmup = warmup;
    }

    if (day.isOptional) {
      programDay.isOptional = true;
    }

    if (day.notes) {
      programDay.notes = day.notes;
    }

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
        notes: exercise.notes ?? "",
        type: exercise.progressionType,
        isOptional: Boolean(exercise.isOptional),
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
    nextRecommendedDayId: programConfig.cycleOrder[0] ?? programConfig.days[0]?.id ?? null,
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

function buildDefaultProgramSeed(createdAt = nowIso()) {
  return buildProgramSeedFromConfig(
    workoutProgram,
    {
      programId: DEFAULT_PROGRAM_ID,
      nickname: "Athletic Program",
      description: "Default preloaded athletic bodybuilding program.",
      goal: "Athletic bodybuilding with RPE-based progression",
      isDefault: true,
    },
    createdAt,
  );
}

function buildAthleticAestheticBasketballProgramSeed(createdAt = nowIso()) {
  return buildProgramSeedFromConfig(
    athleticAestheticBasketballProgram,
    {
      programId: ATHLETIC_AESTHETIC_BASKETBALL_PROGRAM_ID,
      nickname: athleticAestheticBasketballProgram.nickname ?? "Athletic Aesthetic",
      description: athleticAestheticBasketballProgram.description,
      goal: athleticAestheticBasketballProgram.goal,
      isDefault: true,
    },
    createdAt,
  );
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

function getProgramDisplayNickname(program) {
  if (program?.nickname) {
    return program.nickname;
  }

  if (
    program?.id === ATHLETIC_AESTHETIC_BASKETBALL_PROGRAM_ID ||
    program?.name === athleticAestheticBasketballProgram.name ||
    String(program?.name ?? "").includes("Athletic Aesthetic Basketball")
  ) {
    return "Athletic Aesthetic";
  }

  if (
    program?.id === DEFAULT_PROGRAM_ID ||
    program?.name === workoutProgram.name ||
    String(program?.name ?? "").includes("Athletic Bodybuilding")
  ) {
    return "Athletic Program";
  }

  if (program?.isDefault) {
    return program?.name ?? "Default Program";
  }

  return program?.name ?? "Program";
}

function mergeExerciseLibraryContent(seedLibraryExercises) {
  const contentById = getExerciseLibraryContentById();

  if (!contentById.size) {
    return false;
  }

  const seedById = new Map(asArray(seedLibraryExercises).map((exercise) => [exercise.id, exercise]));
  const exerciseLibrary = asArray(readStorage(STORAGE_KEYS.exerciseLibrary, []));
  let didChange = false;

  const nextExerciseLibrary = exerciseLibrary.map((exercise) => {
    const content = contentById.get(exercise.id);

    if (!content) {
      return exercise;
    }

    const seededExercise =
      seedById.get(exercise.id) ??
      (getLegacyExerciseConfig(exercise.id)
        ? createLibraryExercise(getLegacyExerciseConfig(exercise.id))
        : {});
    const nextExercise = { ...exercise };

    [
      "name",
      "category",
      "mainMuscles",
      "secondaryMuscles",
      "equipment",
      "difficulty",
      "goalTags",
      "setup",
      "mainCue",
      "howToDoIt",
      "executionTips",
      "commonMistakes",
      "whatYouShouldFeel",
      "whyItsThere",
      "progressionRegression",
      "safetyNotes",
    ].forEach((field) => {
      const contentValue = content[field];

      if (
        !isEmptyLibraryValue(contentValue) &&
        shouldFillLibraryField(nextExercise[field], seededExercise[field])
      ) {
        nextExercise[field] = contentValue;
      }
    });

    if (
      !isEmptyLibraryValue(content.video_url) &&
      isEmptyLibraryValue(nextExercise.video_url) &&
      isEmptyLibraryValue(nextExercise.videoUrl)
    ) {
      nextExercise.video_url = content.video_url;
    }

    if (
      normalizeLibraryValue(nextExercise) !== normalizeLibraryValue(exercise) ||
      JSON.stringify(nextExercise) !== JSON.stringify(exercise)
    ) {
      didChange = true;
    }

    return nextExercise;
  });

  if (didChange) {
    writeStorage(STORAGE_KEYS.exerciseLibrary, nextExerciseLibrary);
  }

  return didChange;
}

function backfillDefaultProgramWarmups() {
  const sourceWarmupsByDayId = new Map(
    workoutProgram.days
      .map((day) => [day.id, normalizeWarmup(day.warmup)])
      .filter(([, warmup]) => warmup),
  );

  if (!sourceWarmupsByDayId.size) {
    return false;
  }

  const programDays = asArray(readStorage(STORAGE_KEYS.programDays, []));
  let didChange = false;
  const nextProgramDays = programDays.map((day) => {
    if (
      day.programId !== DEFAULT_PROGRAM_ID ||
      Object.prototype.hasOwnProperty.call(day, "warmup")
    ) {
      return day;
    }

    const sourceWarmup = sourceWarmupsByDayId.get(day.id);

    if (!sourceWarmup) {
      return day;
    }

    didChange = true;
    return {
      ...day,
      warmup: sourceWarmup,
    };
  });

  if (didChange) {
    writeStorage(STORAGE_KEYS.programDays, nextProgramDays);
  }

  return didChange;
}

function seedProgramIfMissing(seed) {
  const programs = getPrograms();

  if (programs.some((program) => program.id === seed.program.id)) {
    return false;
  }

  writeStorage(STORAGE_KEYS.programs, mergeById(programs, [seed.program]));
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
  mergeExerciseLibraryContent(seed.libraryExercises);

  return true;
}

export function seedDefaultProgramIfNeeded() {
  const seedTime = nowIso();
  const existingPrograms = getPrograms();
  const seed = buildDefaultProgramSeed(seedTime);
  const basketballSeed = buildAthleticAestheticBasketballProgramSeed(seedTime);

  ensureProgramStorageMeta(seedTime);

  if (!existingPrograms.length) {
    writeStorage(STORAGE_KEYS.programs, mergeById(existingPrograms, [seed.program, basketballSeed.program]));
    writeStorage(
      STORAGE_KEYS.programDays,
      mergeById(readStorage(STORAGE_KEYS.programDays, []), [...seed.days, ...basketballSeed.days]),
    );
    writeStorage(
      STORAGE_KEYS.programSections,
      mergeById(
        readStorage(STORAGE_KEYS.programSections, []),
        [...seed.sections, ...basketballSeed.sections],
      ),
    );
    writeStorage(
      STORAGE_KEYS.exerciseLibrary,
      mergeById(
        readStorage(STORAGE_KEYS.exerciseLibrary, []),
        [...seed.libraryExercises, ...basketballSeed.libraryExercises],
      ),
    );
    writeStorage(
      STORAGE_KEYS.programExercises,
      mergeById(
        readStorage(STORAGE_KEYS.programExercises, []),
        [...seed.programExercises, ...basketballSeed.programExercises],
      ),
    );
    writeStorage(
      STORAGE_KEYS.baselines,
      mergeById(readStorage(STORAGE_KEYS.baselines, []), [...seed.baselines, ...basketballSeed.baselines]),
    );
    writeStorage(
      STORAGE_KEYS.programProgressions,
      mergeById(
        readStorage(STORAGE_KEYS.programProgressions, []),
        [...seed.progressions, ...basketballSeed.progressions],
      ),
    );
    writeProgramStates(mergeById(getProgramStates(), [seed.programState, basketballSeed.programState]));
    writeStorage(STORAGE_KEYS.activeProgramId, seed.program.id);
    mergeExerciseLibraryContent([...seed.libraryExercises, ...basketballSeed.libraryExercises]);

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

  let didBackfillDefaultNickname = false;
  const currentPrograms = getPrograms();
  const nextPrograms = currentPrograms.map((program) => {
    if (program.id === DEFAULT_PROGRAM_ID && !program.nickname) {
      didBackfillDefaultNickname = true;
      return { ...program, nickname: "Athletic Program", updatedAt: program.updatedAt ?? seedTime };
    }

    return program;
  });

  if (didBackfillDefaultNickname) {
    writeStorage(STORAGE_KEYS.programs, nextPrograms);
  }

  backfillDefaultProgramWarmups();
  seedProgramIfMissing(basketballSeed);
  mergeExerciseLibraryContent(seed.libraryExercises);

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

export function updateProgramMetadata(programId, patch) {
  const programs = getPrograms();
  const existingIndex = programs.findIndex((program) => program.id === programId);

  if (existingIndex < 0) {
    return null;
  }

  const existingProgram = programs[existingIndex];
  const allowedFields =
    existingProgram.isDefault || existingProgram.id === DEFAULT_PROGRAM_ID
      ? ["nickname", "description", "goal"]
      : ["name", "nickname", "description", "goal"];
  const updatedProgram = {
    ...existingProgram,
    ...Object.fromEntries(
      allowedFields
        .filter((field) => Object.prototype.hasOwnProperty.call(patch, field))
        .map((field) => [field, String(patch[field] ?? "").trim()]),
    ),
    updatedAt: nowIso(),
  };

  if (!updatedProgram.name) {
    updatedProgram.name = existingProgram.name;
  }

  programs[existingIndex] = updatedProgram;
  writeStorage(STORAGE_KEYS.programs, programs);

  return updatedProgram;
}

function cleanNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanWeight(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "string" && value.trim().toLowerCase() === "bw") {
    return "BW";
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function updateProgramExerciseTarget(programId, programExerciseId, patch) {
  const program = getPrograms().find(
    (candidate) => candidate.id === programId && !candidate.isArchived,
  );

  if (!program || program.isDefault || program.id === DEFAULT_PROGRAM_ID) {
    return null;
  }

  const programExercises = asArray(readStorage(STORAGE_KEYS.programExercises, []));
  const existingIndex = programExercises.findIndex(
    (programExercise) =>
      programExercise.id === programExerciseId && programExercise.programId === programId,
  );

  if (existingIndex < 0) {
    return null;
  }

  const existingExercise = programExercises[existingIndex];
  const nextReps = patch.targetReps ?? {};
  const updatedExercise = {
    ...existingExercise,
    targetSets: cleanNumber(patch.targetSets, existingExercise.targetSets),
    targetReps: {
      min: cleanNumber(nextReps.min, null),
      max: cleanNumber(nextReps.max, null),
      label: String(nextReps.label ?? "").trim() || null,
    },
    targetWeight: cleanWeight(patch.targetWeight),
    targetRPE: cleanNumber(patch.targetRPE, existingExercise.targetRPE),
    restTime: cleanNumber(patch.restTime, existingExercise.restTime),
    notes: String(patch.notes ?? "").trim(),
  };

  programExercises[existingIndex] = updatedExercise;
  writeStorage(STORAGE_KEYS.programExercises, programExercises);

  return updatedExercise;
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
      decision: exercisePlan.decision ?? null,
      confidence: exercisePlan.confidence ?? null,
      warnings: Array.isArray(exercisePlan.warnings)
        ? exercisePlan.warnings.filter(Boolean)
        : [],
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
        videoUrl: libraryExercise?.videoUrl || libraryExercise?.video_url || "",
        notes: programExercise.notes ?? "",
        isOptional: Boolean(programExercise.isOptional),
      };
    });
    const legacyDay = getLegacyDayConfig(day.id);
    const warmup =
      normalizeWarmup(day.warmup) ??
      ([DEFAULT_PROGRAM_ID, ATHLETIC_AESTHETIC_BASKETBALL_PROGRAM_ID].includes(day.programId)
        ? normalizeWarmup(legacyDay?.warmup)
        : null);

    return {
      ...day,
      shortName: legacyDay?.shortName ?? day.name,
      type: exercises.length ? "training" : "recovery",
      activities: legacyDay?.activities ?? [],
      warmup,
      notes: day.notes ?? legacyDay?.notes ?? "",
      isOptional: Boolean(day.isOptional ?? legacyDay?.isOptional),
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
    name: `Copy of ${getProgramDisplayNickname(sourceProgram)}`,
    nickname: `Copy of ${getProgramDisplayNickname(sourceProgram)}`,
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
