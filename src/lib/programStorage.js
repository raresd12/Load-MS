import {
  athleticAestheticBasketballProgram,
  workoutProgram,
} from "../config/workoutProgram.js";
import { exerciseLibraryContentBatches } from "../data/exerciseLibraryContent.js";
import {
  readStorage,
  readStorageResult,
  STORAGE_KEYS,
  writeStorage,
  writeStorageBatch,
} from "./storage.js";

export const PROGRAM_STORAGE_VERSION = 1;

// Upper bound for a program target's set count. Shared by the target editor,
// updateProgramExerciseTargetChecked and the strict share validator so that a
// program that is valid inside the app always round-trips through share/import.
export const MAX_TARGET_SETS = 30;
export const DEFAULT_PROGRAM_ID = "default-athletic-bodybuilding-rpe";
export const ATHLETIC_AESTHETIC_BASKETBALL_PROGRAM_ID =
  "default-athletic-aesthetic-basketball";

// Note used by seeded / freshly duplicated progression records. App.jsx treats a
// progression with this note (and no sourcePlanGeneratedAt) as "not earned".
export const BASE_RECOMMENDATION_NOTE = "Base program prescription.";

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
      existingIds.add(item.id);
    }
  });

  return merged;
}

function uniqueById(items) {
  const seen = new Set();

  return asArray(items).filter((item) => {
    const id = item?.id;

    if (id === undefined || id === null || seen.has(id)) {
      return false;
    }

    seen.add(id);
    return true;
  });
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

export function normalizeWarmup(warmup) {
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
        recommendationNote: BASE_RECOMMENDATION_NOTE,
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

// Every key the seed merges into. When any of them holds unreadable JSON the
// seed must not run: readStorage returns the empty fallback for a corrupt key,
// which would look like a fresh install and the seed would write over the
// user's data (decision new-G: the fallback is never written back).
const SEED_STORAGE_KEYS = [
  STORAGE_KEYS.programs,
  STORAGE_KEYS.activeProgramId,
  STORAGE_KEYS.programStorageMeta,
  STORAGE_KEYS.programDays,
  STORAGE_KEYS.programSections,
  STORAGE_KEYS.exerciseLibrary,
  STORAGE_KEYS.programExercises,
  STORAGE_KEYS.baselines,
  STORAGE_KEYS.programProgressions,
  STORAGE_KEYS.programStates,
];

function getCorruptSeedStorageKeys() {
  return SEED_STORAGE_KEYS.filter((key) => readStorageResult(key, null).corrupt);
}

function getProgramStates() {
  return asArray(readStorage(STORAGE_KEYS.programStates, []));
}

function writeProgramStates(states) {
  return writeStorage(STORAGE_KEYS.programStates, asArray(states));
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

// Library technique content (src/data/exerciseLibraryContent.js) is filled
// into Library entries in memory; the caller decides when to write. Pure.
// Returns { exerciseLibrary, changed }.
function applyExerciseLibraryContent(exerciseLibrary, seedLibraryExercises) {
  const contentById = getExerciseLibraryContentById();
  const currentLibrary = asArray(exerciseLibrary);

  if (!contentById.size) {
    return { exerciseLibrary: currentLibrary, changed: false };
  }

  const seedById = new Map(asArray(seedLibraryExercises).map((exercise) => [exercise.id, exercise]));
  let changed = false;

  const nextExerciseLibrary = currentLibrary.map((exercise) => {
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
      changed = true;
    }

    return nextExercise;
  });

  return { exerciseLibrary: nextExerciseLibrary, changed };
}

// Default-program days that predate the warm-up field get the config warm-up.
// Pure. Returns { programDays, changed }.
function applyDefaultProgramWarmups(programDays) {
  const sourceWarmupsByDayId = new Map(
    workoutProgram.days
      .map((day) => [day.id, normalizeWarmup(day.warmup)])
      .filter(([, warmup]) => warmup),
  );
  const currentDays = asArray(programDays);

  if (!sourceWarmupsByDayId.size) {
    return { programDays: currentDays, changed: false };
  }

  let changed = false;
  const nextProgramDays = currentDays.map((day) => {
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

    changed = true;
    return {
      ...day,
      warmup: sourceWarmup,
    };
  });

  return { programDays: nextProgramDays, changed };
}

// The seed works on an in-memory copy of every program storage collection and
// writes the changed keys in ONE batch (fix round 2: a failed write mid-seed
// used to leave programs without days/exercises for good).
const SEED_STATE_FIELDS = Object.freeze({
  programs: STORAGE_KEYS.programs,
  programDays: STORAGE_KEYS.programDays,
  programSections: STORAGE_KEYS.programSections,
  exerciseLibrary: STORAGE_KEYS.exerciseLibrary,
  programExercises: STORAGE_KEYS.programExercises,
  baselines: STORAGE_KEYS.baselines,
  programProgressions: STORAGE_KEYS.programProgressions,
  programStates: STORAGE_KEYS.programStates,
});

function readSeedState() {
  return Object.fromEntries(
    Object.entries(SEED_STATE_FIELDS).map(([field, key]) => [field, asArray(readStorage(key, []))]),
  );
}

function mergeSeedCollection(state, changedFields, field, seedItems) {
  const merged = mergeById(state[field], seedItems);

  if (merged.length !== state[field].length) {
    state[field] = merged;
    changedFields.add(field);
  }
}

/**
 * Adds whatever of a default program's seed is missing: the program itself,
 * and its days / sections / library entries / program exercises / baselines /
 * state. Add-only by id, so user data is never replaced. Progression records
 * are only seeded together with the program (an existing program's
 * progressions are earned from sessions, or deliberately deleted).
 * Returns true when the program record itself was added.
 */
function applyProgramSeed(state, changedFields, seed) {
  const programMissing = !state.programs.some((program) => program.id === seed.program.id);

  if (programMissing) {
    mergeSeedCollection(state, changedFields, "programs", [seed.program]);
  }

  mergeSeedCollection(state, changedFields, "programDays", seed.days);
  mergeSeedCollection(state, changedFields, "programSections", seed.sections);
  mergeSeedCollection(state, changedFields, "exerciseLibrary", seed.libraryExercises);
  mergeSeedCollection(state, changedFields, "programExercises", seed.programExercises);
  mergeSeedCollection(state, changedFields, "baselines", seed.baselines);

  if (programMissing) {
    mergeSeedCollection(state, changedFields, "programProgressions", seed.progressions);
  }

  mergeSeedCollection(state, changedFields, "programStates", [seed.programState]);

  return programMissing;
}

function applySeedLibraryContent(state, changedFields, seedLibraryExercises) {
  const merged = applyExerciseLibraryContent(state.exerciseLibrary, seedLibraryExercises);

  if (merged.changed) {
    state.exerciseLibrary = merged.exerciseLibrary;
    changedFields.add("exerciseLibrary");
  }
}

function buildSeedEntries(state, changedFields) {
  return [...changedFields].map((field) => ({
    key: SEED_STATE_FIELDS[field],
    value: state[field],
  }));
}

function resolveActiveProgramIdInMemory(programs) {
  const storedRead = readStorageResult(STORAGE_KEYS.activeProgramId, null);
  const activeProgram = programs.find(
    (program) => program.id === storedRead.value && !program.isArchived,
  );

  if (activeProgram) {
    return { activeProgramId: activeProgram.id, changed: false };
  }

  const fallbackProgram =
    programs.find((program) => program.isDefault && !program.isArchived) ??
    programs.find((program) => !program.isArchived) ??
    programs[0] ??
    null;

  return {
    activeProgramId: fallbackProgram?.id ?? null,
    changed: Boolean(fallbackProgram) && !storedRead.corrupt,
  };
}

/**
 * Seeds the default programs into fresh storage and backfills older storage,
 * all in one checked batch. Returns { seeded, activeProgramId }, or
 * { seeded: false, error, code, failedKey, activeProgramId } when the batch
 * failed (nothing was written), or, when a program storage key holds
 * unreadable JSON, { seeded: false, blocked: true, corruptKeys, activeProgramId }
 * without writing anything: the fallback of a corrupt key is never written
 * back (decision new-G), so the user's data can be recovered from the key
 * itself or its `.corrupt-<n>` copy.
 */
export function seedDefaultProgramIfNeeded() {
  const seedTime = nowIso();
  const corruptKeys = getCorruptSeedStorageKeys();

  if (corruptKeys.length) {
    return {
      seeded: false,
      blocked: true,
      corruptKeys,
      activeProgramId: getActiveProgramId(),
    };
  }

  const state = readSeedState();
  const changedFields = new Set();
  const seed = buildDefaultProgramSeed(seedTime);
  const basketballSeed = buildAthleticAestheticBasketballProgramSeed(seedTime);
  const isFreshInstall = !state.programs.length;

  if (!isFreshInstall) {
    // Older storage: the default nickname and the config warm-ups are filled in.
    let didBackfillDefaultNickname = false;
    const nextPrograms = state.programs.map((program) => {
      if (program.id === DEFAULT_PROGRAM_ID && !program.nickname) {
        didBackfillDefaultNickname = true;
        return { ...program, nickname: "Athletic Program", updatedAt: program.updatedAt ?? seedTime };
      }

      return program;
    });

    if (didBackfillDefaultNickname) {
      state.programs = nextPrograms;
      changedFields.add("programs");
    }

    const warmups = applyDefaultProgramWarmups(state.programDays);

    if (warmups.changed) {
      state.programDays = warmups.programDays;
      changedFields.add("programDays");
    }
  }

  applyProgramSeed(state, changedFields, seed);
  applyProgramSeed(state, changedFields, basketballSeed);
  applySeedLibraryContent(state, changedFields, [
    ...seed.libraryExercises,
    ...basketballSeed.libraryExercises,
  ]);

  const entries = buildSeedEntries(state, changedFields);
  const active = resolveActiveProgramIdInMemory(state.programs);

  if (active.changed) {
    entries.push({ key: STORAGE_KEYS.activeProgramId, value: active.activeProgramId });
  }

  const existingMeta = readStorage(STORAGE_KEYS.programStorageMeta, null);
  const meta = {
    schemaVersion: PROGRAM_STORAGE_VERSION,
    createdAt: existingMeta?.createdAt ?? seedTime,
    updatedAt: seedTime,
    defaultProgramId: existingMeta?.defaultProgramId ?? DEFAULT_PROGRAM_ID,
  };
  const metaChanged =
    !existingMeta ||
    existingMeta.schemaVersion !== meta.schemaVersion ||
    existingMeta.defaultProgramId !== meta.defaultProgramId;

  if (entries.length || metaChanged) {
    entries.push({ key: STORAGE_KEYS.programStorageMeta, value: meta });
  }

  const writeResult = writeStorageBatch(entries);

  if (!writeResult.ok) {
    return {
      seeded: false,
      error: writeResult.error,
      code: writeResult.code,
      failedKey: writeResult.failedKey,
      activeProgramId: isFreshInstall ? null : active.activeProgramId,
    };
  }

  return {
    seeded: isFreshInstall,
    activeProgramId: active.activeProgramId,
  };
}

// Every stored program, archived ones included. Internal writers must use this
// so that rewriting the programs key never drops archived programs.
function getAllPrograms() {
  return asArray(readStorage(STORAGE_KEYS.programs, []));
}

/**
 * Programs for lists. Archived programs are hidden unless
 * `{ includeArchived: true }` is passed (decision new-F).
 */
export function getPrograms(options = {}) {
  const includeArchived = Boolean(options?.includeArchived);
  const programs = getAllPrograms();

  return includeArchived ? programs : programs.filter((program) => !program.isArchived);
}

export function getArchivedPrograms() {
  return getAllPrograms().filter((program) => Boolean(program.isArchived));
}

/**
 * Decision new-F. Returns { ok: true, program } or { ok: false, error }.
 * Active and default programs cannot be archived. Unarchiving is always allowed.
 * Archived programs keep every related record.
 */
export function setProgramArchived(programId, archived) {
  const programs = getAllPrograms();
  const existingIndex = programs.findIndex((program) => program.id === programId);

  if (existingIndex < 0) {
    return { ok: false, error: "Program not found." };
  }

  const existingProgram = programs[existingIndex];
  const nextArchived = Boolean(archived);

  if (nextArchived) {
    if (existingProgram.isDefault || existingProgram.id === DEFAULT_PROGRAM_ID) {
      return { ok: false, error: "Default programs cannot be archived." };
    }

    if (readStorage(STORAGE_KEYS.activeProgramId, null) === programId) {
      return { ok: false, error: "The active program cannot be archived. Switch programs first." };
    }
  }

  if (Boolean(existingProgram.isArchived) === nextArchived) {
    return { ok: true, program: existingProgram, changed: false };
  }

  const updatedProgram = {
    ...existingProgram,
    isArchived: nextArchived,
    updatedAt: nowIso(),
  };
  const nextPrograms = [...programs];
  nextPrograms[existingIndex] = updatedProgram;
  const writeResult = writeStorage(STORAGE_KEYS.programs, nextPrograms);

  if (!writeResult.ok) {
    return { ok: false, error: writeResult.error, code: writeResult.code };
  }

  return { ok: true, program: updatedProgram, changed: true };
}

export function getActiveProgramId() {
  const storedRead = readStorageResult(STORAGE_KEYS.activeProgramId, null);
  const storedProgramId = storedRead.value;
  const programs = getAllPrograms();
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
    // A corrupt stored id is used in memory only; it is never overwritten
    // by the fallback (decision new-G).
    if (!storedRead.corrupt) {
      writeStorage(STORAGE_KEYS.activeProgramId, fallbackProgram.id);
    }

    return fallbackProgram.id;
  }

  return null;
}

export function getActiveProgram() {
  const activeProgramId = getActiveProgramId();
  return getAllPrograms().find((program) => program.id === activeProgramId) ?? null;
}

/**
 * Returns { ok: true, programId } or { ok: false, error, code }. The active
 * id is only reported as switched after the write succeeded (fix round 2).
 */
export function setActiveProgramChecked(programId) {
  const program = getAllPrograms().find(
    (candidate) => candidate.id === programId && !candidate.isArchived,
  );

  if (!program) {
    return { ok: false, error: "Program not found or archived.", programId: null };
  }

  const writeResult = writeStorage(STORAGE_KEYS.activeProgramId, program.id);

  if (!writeResult.ok) {
    return { ok: false, error: writeResult.error, code: writeResult.code, programId: null };
  }

  return { ok: true, programId: program.id };
}

/**
 * Legacy-shaped wrapper: the new active program id, or null when the program
 * is missing/archived or the write failed.
 */
export function setActiveProgram(programId) {
  return setActiveProgramChecked(programId).programId;
}

/**
 * Returns { ok: true, program } or { ok: false, error, code, program: null }.
 * The updated program is only returned after the write succeeded.
 */
export function updateProgramMetadataChecked(programId, patch) {
  const programs = getAllPrograms();
  const existingIndex = programs.findIndex((program) => program.id === programId);

  if (existingIndex < 0) {
    return { ok: false, error: "Program not found.", program: null };
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
  const writeResult = writeStorage(STORAGE_KEYS.programs, programs);

  if (!writeResult.ok) {
    return { ok: false, error: writeResult.error, code: writeResult.code, program: null };
  }

  return { ok: true, program: updatedProgram };
}

/**
 * Legacy-shaped wrapper: the updated program, or null when the program is
 * missing or the write failed.
 */
export function updateProgramMetadata(programId, patch) {
  return updateProgramMetadataChecked(programId, patch).program;
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

function hasOwn(object, field) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, field);
}

function isPositiveFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Rest can be a scalar (seconds) or a [min, max] range (decision 19.4-3).
 * Returns the cleaned value or `fallback` when the input is not usable.
 * Stored ranges are never rewritten into scalars.
 */
function cleanRestTime(value, fallback = null) {
  if (Array.isArray(value)) {
    const [min, max] = value.map((entry) => cleanNumber(entry, null));

    if (value.length === 2 && isPositiveFiniteNumber(min) && isPositiveFiniteNumber(max) && min <= max) {
      return [min, max];
    }

    return fallback;
  }

  const scalar = cleanNumber(value, null);
  return isPositiveFiniteNumber(scalar) ? scalar : fallback;
}

function applyProgramExerciseTargetPatch(existingExercise, patch = {}) {
  const updatedExercise = { ...existingExercise };

  if (hasOwn(patch, "targetSets")) {
    updatedExercise.targetSets = cleanNumber(patch.targetSets, existingExercise.targetSets);
  }

  if (hasOwn(patch, "targetReps")) {
    const nextReps = patch.targetReps && typeof patch.targetReps === "object" ? patch.targetReps : {};
    const existingReps =
      existingExercise.targetReps && typeof existingExercise.targetReps === "object"
        ? existingExercise.targetReps
        : {};

    updatedExercise.targetReps = {
      min: hasOwn(nextReps, "min") ? cleanNumber(nextReps.min, null) : existingReps.min ?? null,
      max: hasOwn(nextReps, "max") ? cleanNumber(nextReps.max, null) : existingReps.max ?? null,
      label: hasOwn(nextReps, "label")
        ? String(nextReps.label ?? "").trim() || null
        : existingReps.label ?? null,
    };
  }

  if (hasOwn(patch, "targetWeight")) {
    updatedExercise.targetWeight = cleanWeight(patch.targetWeight);
  }

  if (hasOwn(patch, "targetRPE")) {
    updatedExercise.targetRPE = cleanNumber(patch.targetRPE, existingExercise.targetRPE);
  }

  if (hasOwn(patch, "restTime")) {
    updatedExercise.restTime = cleanRestTime(patch.restTime, existingExercise.restTime);
  }

  if (hasOwn(patch, "notes")) {
    updatedExercise.notes = String(patch.notes ?? "").trim();
  }

  return updatedExercise;
}

/**
 * Validates a target patch before it is applied (fix round 2, decision new-R):
 * the cleaned patch input must be usable (a value the cleaners would silently
 * replace with the current one is rejected instead) and the merged result must
 * pass the same rules as the strict share validator for the touched fields.
 * Returns capitalised messages, empty when the patch is fine.
 */
function collectTargetPatchErrors(existingExercise, patch) {
  const errors = [];
  const touched = PROGRAM_EXERCISE_TARGET_FIELDS.filter((field) => hasOwn(patch, field));
  const isUnparsableNumber = (value) =>
    !isNullish(value) && value !== "" && cleanNumber(value, null) === null;

  if (hasOwn(patch, "targetSets") && !isValidTargetSets(cleanNumber(patch.targetSets, null))) {
    errors.push(`sets must be a whole number from 1 to ${MAX_TARGET_SETS}.`);
  }

  if (hasOwn(patch, "targetReps") && patch.targetReps && typeof patch.targetReps === "object") {
    if (hasOwn(patch.targetReps, "min") && isUnparsableNumber(patch.targetReps.min)) {
      errors.push("minimum reps must be a positive number.");
    }

    if (hasOwn(patch.targetReps, "max") && isUnparsableNumber(patch.targetReps.max)) {
      errors.push("maximum reps must be a positive number.");
    }
  }

  if (hasOwn(patch, "targetRPE") && !isHalfStepRpe(cleanNumber(patch.targetRPE, null))) {
    errors.push("target RPE must be 1-10 in .5 steps.");
  }

  // restTime: an unusable input keeps the current value (verify-program-h1-duplicate
  // contract); the merged value is still checked below.

  if (
    hasOwn(patch, "targetWeight") &&
    !isNullish(patch.targetWeight) &&
    patch.targetWeight !== "" &&
    cleanWeight(patch.targetWeight) === null
  ) {
    errors.push('target weight must be empty, a number of kg (0 or more) or "BW".');
  }

  const merged = applyProgramExerciseTargetPatch(existingExercise, patch);
  const alreadyReported = new Set(errors);

  collectProgramExerciseTargetErrors(merged, touched).forEach((message) => {
    if (!alreadyReported.has(message)) {
      errors.push(message);
    }
  });

  return errors.map(capitalizeMessage);
}

/**
 * Decision 19.4-2. Edits a custom program target and deletes the stored
 * progression for that programExerciseId in the same batch, so the next session
 * starts from the new target. Missing patch fields keep their current values.
 *
 * Returns { ok: true, exercise, deletedProgression } or
 *         { ok: false, error, code, failedKey, exercise: null }.
 *
 * The pending next-plan entry lives in App state (STORAGE_KEYS.nextPlans via
 * useLocalStorageState); use `removeExerciseFromNextPlans` there.
 */
export function updateProgramExerciseTargetChecked(programId, programExerciseId, patch) {
  const program = getAllPrograms().find(
    (candidate) => candidate.id === programId && !candidate.isArchived,
  );

  if (!program) {
    return { ok: false, error: "Program not found or archived.", exercise: null };
  }

  if (program.isDefault || program.id === DEFAULT_PROGRAM_ID) {
    return {
      ok: false,
      error: "Default program targets are protected. Duplicate the program first.",
      exercise: null,
    };
  }

  const programExercises = asArray(readStorage(STORAGE_KEYS.programExercises, []));
  const existingIndex = programExercises.findIndex(
    (programExercise) =>
      programExercise.id === programExerciseId && programExercise.programId === programId,
  );

  if (existingIndex < 0) {
    return { ok: false, error: "Program exercise not found.", exercise: null };
  }

  const targetErrors = collectTargetPatchErrors(programExercises[existingIndex], patch ?? {});

  if (targetErrors.length) {
    return {
      ok: false,
      error: targetErrors.join(" "),
      errors: targetErrors,
      exercise: null,
    };
  }

  const updatedExercise = applyProgramExerciseTargetPatch(programExercises[existingIndex], patch);
  const nextProgramExercises = [...programExercises];
  nextProgramExercises[existingIndex] = updatedExercise;

  const progressions = getProgramProgressions();
  const nextProgressions = progressions.filter(
    (progression) =>
      !(progression.programId === programId && progression.programExerciseId === programExerciseId),
  );
  const deletedProgression = nextProgressions.length !== progressions.length;

  const entries = [{ key: STORAGE_KEYS.programExercises, value: nextProgramExercises }];

  if (deletedProgression) {
    entries.push({ key: STORAGE_KEYS.programProgressions, value: nextProgressions });
  }

  const writeResult = writeStorageBatch(entries);

  if (!writeResult.ok) {
    return {
      ok: false,
      error: writeResult.error,
      code: writeResult.code,
      failedKey: writeResult.failedKey,
      exercise: null,
    };
  }

  return { ok: true, exercise: updatedExercise, deletedProgression };
}

/**
 * Legacy-shaped wrapper kept for App.jsx: returns the updated program exercise,
 * or null when the edit was rejected or the write failed. Same behaviour as
 * `updateProgramExerciseTargetChecked` (progression deleted, batch write).
 */
export function updateProgramExerciseTarget(programId, programExerciseId, patch) {
  const result = updateProgramExerciseTargetChecked(programId, programExerciseId, patch);
  return result.ok ? result.exercise : null;
}

/**
 * Returns { ok: true, removedCount } or { ok: false, error, code }.
 */
export function deleteProgramProgression(programId, programExerciseId) {
  const progressions = getProgramProgressions();
  const nextProgressions = progressions.filter(
    (progression) =>
      !(progression.programId === programId && progression.programExerciseId === programExerciseId),
  );
  const removedCount = progressions.length - nextProgressions.length;

  if (!removedCount) {
    return { ok: true, removedCount: 0 };
  }

  const writeResult = writeStorage(STORAGE_KEYS.programProgressions, nextProgressions);

  if (!writeResult.ok) {
    return { ok: false, error: writeResult.error, code: writeResult.code, removedCount: 0 };
  }

  return { ok: true, removedCount };
}

/**
 * Deletes every stored progression of the program exercises that belong to
 * `dayId` in `programId`. Returns { ok: true, removedCount } or { ok: false, error, code }.
 */
export function deleteProgramProgressionsForDay(programId, dayId) {
  const dayExerciseIds = new Set(
    asArray(readStorage(STORAGE_KEYS.programExercises, []))
      .filter((programExercise) => programExercise.programId === programId && programExercise.dayId === dayId)
      .map((programExercise) => programExercise.id),
  );
  const progressions = getProgramProgressions();
  const nextProgressions = progressions.filter(
    (progression) =>
      !(progression.programId === programId && dayExerciseIds.has(progression.programExerciseId)),
  );
  const removedCount = progressions.length - nextProgressions.length;

  if (!removedCount) {
    return { ok: true, removedCount: 0 };
  }

  const writeResult = writeStorage(STORAGE_KEYS.programProgressions, nextProgressions);

  if (!writeResult.ok) {
    return { ok: false, error: writeResult.error, code: writeResult.code, removedCount: 0 };
  }

  return { ok: true, removedCount };
}

/**
 * Pure helper for the UI track (decision 19.4-2): returns a copy of `nextPlans`
 * (keyed by dayId) with the plan exercise whose `exerciseId` equals
 * `programExerciseId` removed. Plans that end up with no exercises are dropped.
 * Does not touch storage.
 */
export function removeExerciseFromNextPlans(nextPlans, programExerciseId) {
  if (!nextPlans || typeof nextPlans !== "object") {
    return {};
  }

  const result = {};

  Object.entries(nextPlans).forEach(([dayId, plan]) => {
    const exercises = asArray(plan?.exercises);
    const hasMatch = exercises.some((exercise) => exercise?.exerciseId === programExerciseId);

    if (!hasMatch) {
      result[dayId] = plan;
      return;
    }

    const remaining = exercises.filter((exercise) => exercise?.exerciseId !== programExerciseId);

    if (remaining.length) {
      result[dayId] = { ...plan, exercises: remaining };
    }
  });

  return result;
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

  // Returns null when the write failed (fix round 2): the state in storage is unchanged.
  return writeProgramStates(states).ok ? updatedState : null;
}

/**
 * Pure (fix round 2, decision new-E): the ProgramState a program should carry
 * after its session history changed. Derived from the most recent remaining
 * session of that program: that session's day is the last completed one, the
 * following day in the program is next, and its date is the last workout
 * date. With no session left the state goes back to "nothing completed, first
 * day next". Sessions without a programId (legacy) never drive the state.
 */
export function deriveProgramStatePatchFromSessions(programId, sessions, programDays) {
  const days = asArray(programDays);
  const firstDayId = days[0]?.id ?? null;
  const latest = asArray(sessions)
    .filter((session) => session && session.programId === programId)
    .reduce((best, session) => {
      const time = new Date(session.date ?? 0).getTime();
      const bestTime = best ? new Date(best.date ?? 0).getTime() : -Infinity;
      return time > bestTime ? session : best;
    }, null);

  if (!latest) {
    return {
      lastCompletedDayId: null,
      nextRecommendedDayId: firstDayId,
      lastWorkoutDate: null,
    };
  }

  const dayIndex = days.findIndex((day) => day.id === latest.dayId);
  const nextDay = dayIndex >= 0 ? days[(dayIndex + 1) % days.length] : days[0];

  return {
    lastCompletedDayId: latest.dayId ?? null,
    nextRecommendedDayId: nextDay?.id ?? latest.dayId ?? null,
    lastWorkoutDate: latest.date ?? null,
  };
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

/**
 * Turns one generated-plan exercise into a progression patch. Pure.
 */
export function buildProgressionPatchFromPlanExercise(plan, exercisePlan) {
  const recommendationNote =
    exercisePlan.reasons?.filter(Boolean).join(" ") ||
    exercisePlan.repFocus ||
    "Starting recommendation based on baseline.";

  return {
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
    warnings: Array.isArray(exercisePlan.warnings) ? exercisePlan.warnings.filter(Boolean) : [],
    sourceSessionId: plan?.sourceSessionId ?? null,
    sourcePlanGeneratedAt: plan?.generatedAt ?? null,
  };
}

/**
 * Converts a generated plan into Array<{ programExerciseId, patch }>. Pure.
 */
export function buildProgressionUpdatesFromPlan(plan) {
  return asArray(plan?.exercises)
    .filter((exercisePlan) => exercisePlan && exercisePlan.exerciseId)
    .map((exercisePlan) => ({
      programExerciseId: exercisePlan.exerciseId,
      patch: buildProgressionPatchFromPlanExercise(plan, exercisePlan),
    }));
}

/**
 * Applies progression updates to a progressions array and returns a NEW array.
 * Pure: identity, id and updatedAt are enforced, everything else comes from the
 * existing record merged with the patch.
 */
export function applyProgressionUpdates(progressions, programId, updates, updatedAt = nowIso()) {
  const next = [...asArray(progressions)];

  asArray(updates).forEach((update) => {
    const programExerciseId = update?.programExerciseId;

    if (!programExerciseId) {
      return;
    }

    const existingIndex = next.findIndex(
      (progression) =>
        progression.programId === programId && progression.programExerciseId === programExerciseId,
    );
    const progressionRecord = {
      ...(existingIndex >= 0 ? next[existingIndex] : {}),
      ...(update.patch ?? {}),
      id: makeProgressionId(programExerciseId),
      programId,
      programExerciseId,
      updatedAt,
    };

    if (existingIndex >= 0) {
      next[existingIndex] = progressionRecord;
    } else {
      next.push(progressionRecord);
    }
  });

  return next;
}

function buildProgramStateRecord(states, programId, patch, updatedAt = nowIso()) {
  const existingIndex = states.findIndex((programState) => programState.programId === programId);
  const updatedState = {
    ...(existingIndex >= 0 ? states[existingIndex] : getProgramState(programId)),
    ...(patch ?? {}),
    programId,
    updatedAt,
  };
  const next = [...states];

  if (existingIndex >= 0) {
    next[existingIndex] = updatedState;
  } else {
    next.push(updatedState);
  }

  return { states: next, state: updatedState };
}

export function upsertProgramProgressionsFromPlan(programId, plan) {
  if (!programId || !plan?.exercises?.length) {
    return [];
  }

  const progressions = applyProgressionUpdates(
    getProgramProgressions(),
    programId,
    buildProgressionUpdatesFromPlan(plan),
  );

  writeStorage(STORAGE_KEYS.programProgressions, progressions);
  return progressions;
}

/**
 * Session save transaction (review finding F2, handoff section 7).
 *
 * persistWorkoutSave({
 *   sessions,            // full next sessions array (new session already prepended)
 *   nextPlans,           // full next nextPlans object
 *   workoutDrafts,       // full next workoutDrafts object
 *   programId,           // active program id (optional)
 *   progressionUpdates,  // Array<{ programExerciseId, patch }> (optional)
 *   plan,                // generated plan; converted to progressionUpdates when given
 *   programStatePatch,   // partial ProgramState (optional)
 *   deleteProgressionsForDayId, // day id whose stored progressions are removed
 *                        // (decision new-E: last session of a day deleted)
 * })
 *
 * Any of sessions / nextPlans / workoutDrafts left `undefined` is not written.
 * Everything else is written in ONE writeStorageBatch: on failure nothing changes.
 *
 * Returns { ok: true, writtenKeys, progressions, programState, removedProgressionCount } or
 *         { ok: false, error, code, failedKey, rolledBack }.
 */
export function persistWorkoutSave({
  sessions,
  nextPlans,
  workoutDrafts,
  programId = null,
  progressionUpdates,
  plan,
  programStatePatch,
  deleteProgressionsForDayId = null,
} = {}) {
  const updatedAt = nowIso();
  const entries = [];

  if (sessions !== undefined) {
    entries.push({ key: STORAGE_KEYS.sessions, value: sessions });
  }

  if (nextPlans !== undefined) {
    entries.push({ key: STORAGE_KEYS.nextPlans, value: nextPlans });
  }

  if (workoutDrafts !== undefined) {
    entries.push({ key: STORAGE_KEYS.workoutDrafts, value: workoutDrafts });
  }

  let progressions = null;
  let programState = null;
  let removedProgressionCount = 0;

  if (programId) {
    const updates = [
      ...asArray(progressionUpdates),
      ...(plan ? buildProgressionUpdatesFromPlan(plan) : []),
    ];
    let currentProgressions = getProgramProgressions();

    if (deleteProgressionsForDayId) {
      const dayExerciseIds = new Set(
        asArray(readStorage(STORAGE_KEYS.programExercises, []))
          .filter(
            (programExercise) =>
              programExercise.programId === programId &&
              programExercise.dayId === deleteProgressionsForDayId,
          )
          .map((programExercise) => programExercise.id),
      );
      const remaining = currentProgressions.filter(
        (progression) =>
          !(progression.programId === programId && dayExerciseIds.has(progression.programExerciseId)),
      );
      removedProgressionCount = currentProgressions.length - remaining.length;
      currentProgressions = remaining;
    }

    if (updates.length || removedProgressionCount) {
      progressions = updates.length
        ? applyProgressionUpdates(currentProgressions, programId, updates, updatedAt)
        : currentProgressions;
      entries.push({ key: STORAGE_KEYS.programProgressions, value: progressions });
    }

    if (programStatePatch && typeof programStatePatch === "object") {
      const built = buildProgramStateRecord(getProgramStates(), programId, programStatePatch, updatedAt);
      programState = built.state;
      entries.push({ key: STORAGE_KEYS.programStates, value: built.states });
    }
  }

  const writeResult = writeStorageBatch(entries);

  if (!writeResult.ok) {
    return {
      ok: false,
      error: writeResult.error,
      code: writeResult.code,
      failedKey: writeResult.failedKey,
      rolledBack: writeResult.rolledBack,
    };
  }

  return {
    ok: true,
    writtenKeys: writeResult.writtenKeys,
    progressions,
    programState,
    removedProgressionCount,
  };
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

export const PROGRAM_SHARE_TYPE = "rpe-tracker-program-share";
export const PROGRAM_SHARE_SCHEMA_VERSION = 1;

export function exportProgramShare(programId) {
  const program = getAllPrograms().find((entry) => entry.id === programId);
  if (!program) {
    return null;
  }

  const days = getProgramDays(programId);
  const sections = asArray(readStorage(STORAGE_KEYS.programSections, [])).filter(
    (section) => section.programId === programId,
  );
  const programExercises = asArray(readStorage(STORAGE_KEYS.programExercises, [])).filter(
    (exercise) => exercise.programId === programId,
  );
  const referencedExerciseIds = new Set(programExercises.map((exercise) => exercise.exerciseId));
  const libraryExercises = uniqueById(
    asArray(readStorage(STORAGE_KEYS.exerciseLibrary, [])).filter((exercise) =>
      referencedExerciseIds.has(exercise.id),
    ),
  );

  return {
    app: "rpe-workout-tracker",
    type: PROGRAM_SHARE_TYPE,
    schemaVersion: PROGRAM_SHARE_SCHEMA_VERSION,
    exportedAt: nowIso(),
    program: {
      name: program.name,
      nickname: program.nickname ?? "",
      description: program.description ?? "",
      goal: program.goal ?? "",
    },
    days,
    sections,
    programExercises,
    libraryExercises,
  };
}

export function validateProgramShare(share) {
  if (!share || typeof share !== "object" || Array.isArray(share)) {
    return { valid: false, error: "This file is not a valid program share." };
  }

  if (share.type !== PROGRAM_SHARE_TYPE) {
    return { valid: false, error: "This file is not an RPE Tracker program share." };
  }

  if (!share.program || typeof share.program !== "object" || !String(share.program.name ?? "").trim()) {
    return { valid: false, error: "The program share has no program name." };
  }

  const days = asArray(share.days);
  if (!days.length) {
    return { valid: false, error: "The program share contains no training days." };
  }

  if (days.some((day) => !day || typeof day !== "object" || !day.id)) {
    return { valid: false, error: "The program share has invalid day entries." };
  }

  return { valid: true };
}

function isValidTargetSets(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_TARGET_SETS;
}

function isHalfStepRpe(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 1 &&
    value <= 10 &&
    Number.isInteger(value * 2)
  );
}

function isValidShareRest(value) {
  if (Array.isArray(value)) {
    return (
      value.length === 2 &&
      isPositiveFiniteNumber(value[0]) &&
      isPositiveFiniteNumber(value[1]) &&
      value[0] <= value[1]
    );
  }

  return isPositiveFiniteNumber(value);
}

function isValidShareWeight(value) {
  if (value === null || value === undefined) {
    return true;
  }

  if (typeof value === "string") {
    return value.trim().toLowerCase() === "bw";
  }

  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNullish(value) {
  return value === null || value === undefined;
}

function findDuplicateIds(items) {
  const seen = new Set();
  const duplicates = new Set();

  items.forEach((item) => {
    const id = String(item?.id ?? "");

    if (!id) {
      return;
    }

    if (seen.has(id)) {
      duplicates.add(id);
    }

    seen.add(id);
  });

  return [...duplicates];
}

function describeShareExercise(programExercise, index) {
  return `Exercise ${index + 1}${programExercise?.exerciseId ? ` (${programExercise.exerciseId})` : ""}`;
}

const PROGRAM_EXERCISE_TARGET_FIELDS = Object.freeze([
  "targetSets",
  "targetReps",
  "targetRPE",
  "restTime",
  "targetWeight",
]);

/**
 * One rule set for program targets (decision new-R extended in fix round 2):
 * the strict share validator and updateProgramExerciseTargetChecked check the
 * same fields with the same messages, so every target the app stores exports
 * and imports again. `fields` limits the check to the given target fields
 * (a target edit only validates what the patch touched).
 * Returns message bodies (lower-case start, no label).
 */
function collectProgramExerciseTargetErrors(programExercise, fields = PROGRAM_EXERCISE_TARGET_FIELDS) {
  const errors = [];
  const checks = new Set(fields);

  if (checks.has("targetSets") && !isValidTargetSets(programExercise.targetSets)) {
    errors.push(`sets must be a whole number from 1 to ${MAX_TARGET_SETS}.`);
  }

  if (checks.has("targetReps")) {
    const targetReps =
      programExercise.targetReps && typeof programExercise.targetReps === "object"
        ? programExercise.targetReps
        : {};
    const repsMin = targetReps.min;
    const repsMax = targetReps.max;
    const repsLabel = String(targetReps.label ?? "").trim();
    const hasMin = !isNullish(repsMin);
    const hasMax = !isNullish(repsMax);

    if (hasMin && !isPositiveFiniteNumber(repsMin)) {
      errors.push("minimum reps must be a positive number.");
    }

    if (hasMax && !isPositiveFiniteNumber(repsMax)) {
      errors.push("maximum reps must be a positive number.");
    }

    if (
      hasMin &&
      hasMax &&
      isPositiveFiniteNumber(repsMin) &&
      isPositiveFiniteNumber(repsMax) &&
      repsMin > repsMax
    ) {
      errors.push("minimum reps cannot exceed maximum reps.");
    }

    if (!hasMin && !hasMax && !repsLabel) {
      errors.push("needs a rep range or a rep label.");
    }
  }

  if (checks.has("targetRPE") && !isHalfStepRpe(programExercise.targetRPE)) {
    errors.push("target RPE must be 1-10 in .5 steps.");
  }

  if (checks.has("restTime") && !isValidShareRest(programExercise.restTime)) {
    errors.push("rest must be a positive number of seconds or a [min, max] range.");
  }

  if (checks.has("targetWeight") && !isValidShareWeight(programExercise.targetWeight)) {
    errors.push('target weight must be empty, a number of kg (0 or more) or "BW".');
  }

  return errors;
}

function capitalizeMessage(message) {
  return message.charAt(0).toUpperCase() + message.slice(1);
}

/**
 * Strict share validation used by importProgramShare. Checks every value that
 * the workout flow relies on and returns a readable list of problems.
 *
 * Returns { valid: true, errors: [] } or { valid: false, error, errors }.
 * `error` is the joined message; `errors` is one string per problem.
 */
export function validateProgramShareStrict(share) {
  const basic = validateProgramShare(share);

  if (!basic.valid) {
    return { valid: false, error: basic.error, errors: [basic.error] };
  }

  const errors = [];
  const days = asArray(share.days);
  const sections = asArray(share.sections).filter((section) => section && typeof section === "object");
  const programExercises = asArray(share.programExercises).filter(
    (programExercise) => programExercise && typeof programExercise === "object",
  );
  const libraryExercises = asArray(share.libraryExercises).filter(
    (exercise) => exercise && typeof exercise === "object",
  );

  if (asArray(share.programExercises).length !== programExercises.length) {
    errors.push("The program share has invalid exercise entries.");
  }

  const dayIds = new Set(days.map((day) => String(day.id)));

  findDuplicateIds(days).forEach((id) => errors.push(`Duplicate day id "${id}" in share.`));
  findDuplicateIds(sections).forEach((id) => errors.push(`Duplicate section id "${id}" in share.`));
  findDuplicateIds(programExercises).forEach((id) =>
    errors.push(`Duplicate program exercise id "${id}" in share.`),
  );
  // Duplicate library entries are tolerated: import only adds library ids that
  // are missing locally, keeping the first occurrence, so they cannot corrupt data.

  libraryExercises.forEach((exercise, index) => {
    if (!exercise.id) {
      errors.push(`Library exercise ${index + 1} has no id.`);
    }
  });

  sections.forEach((section, index) => {
    if (!section.id) {
      errors.push(`Section ${index + 1} has no id.`);
    }

    if (!dayIds.has(String(section.dayId))) {
      errors.push(`Section ${index + 1} references unknown day "${section.dayId}".`);
    }
  });

  // Decision new-V: every program exercise must point at a Library entry that
  // exists somewhere - in the share, in the local Library or in the built-in
  // config - otherwise the import would produce a placeholder "Exercise" with
  // no technique content that the workout flow then logs against.
  const shareLibraryIds = new Set(libraryExercises.map((exercise) => String(exercise.id ?? "")));
  const localLibraryIds = new Set(
    asArray(readStorage(STORAGE_KEYS.exerciseLibrary, [])).map((exercise) => String(exercise?.id ?? "")),
  );

  programExercises.forEach((programExercise, index) => {
    const label = describeShareExercise(programExercise, index);

    if (!programExercise.id) {
      errors.push(`${label} has no id.`);
    }

    if (!programExercise.exerciseId) {
      errors.push(`${label} has no library exercise id.`);
    } else {
      const exerciseId = String(programExercise.exerciseId);

      if (
        !shareLibraryIds.has(exerciseId) &&
        !localLibraryIds.has(exerciseId) &&
        !getLegacyExerciseConfig(exerciseId)
      ) {
        errors.push(
          `${label} references library exercise "${exerciseId}", which is neither in the share nor in your Library.`,
        );
      }
    }

    if (!dayIds.has(String(programExercise.dayId))) {
      errors.push(`${label} references unknown day "${programExercise.dayId}".`);
    }

    collectProgramExerciseTargetErrors(programExercise).forEach((message) => {
      errors.push(`${label}: ${message}`);
    });
  });

  if (errors.length) {
    return { valid: false, error: errors.join(" "), errors };
  }

  return { valid: true, errors: [] };
}

export function importProgramShare(share) {
  const validation = validateProgramShareStrict(share);
  if (!validation.valid) {
    return { ...validation, ok: false, program: null, programId: null };
  }

  const createdAt = nowIso();
  const newProgramId = makeCopyId("program-import");
  const shareDays = asArray(share.days);
  // Ids are compared as strings, exactly like validateProgramShareStrict does,
  // so a share with numeric day ids and string dayId references never passes
  // validation and then imports as a program without exercises.
  const dayIds = new Set(shareDays.map((day) => String(day.id)));
  const shareSections = asArray(share.sections).filter(
    (section) => section && section.id && dayIds.has(String(section.dayId)),
  );
  const sectionIds = new Set(shareSections.map((section) => String(section.id)));
  const shareProgramExercises = asArray(share.programExercises).filter(
    (exercise) =>
      exercise && exercise.id && exercise.exerciseId && dayIds.has(String(exercise.dayId)),
  );
  const shareLibraryExercises = uniqueById(
    asArray(share.libraryExercises).filter((exercise) => exercise && exercise.id),
  );

  const dayIdMap = new Map(
    shareDays.map((day, index) => [String(day.id), `${newProgramId}:day-${index + 1}`]),
  );
  const sectionIdMap = new Map(
    shareSections.map((section, index) => [
      String(section.id),
      `${newProgramId}:section-${index + 1}`,
    ]),
  );

  const importedName = String(share.program.name).trim();
  const program = {
    id: newProgramId,
    name: importedName,
    nickname: String(share.program.nickname ?? "").trim() || importedName,
    description: String(share.program.description ?? ""),
    goal: String(share.program.goal ?? ""),
    isDefault: false,
    isArchived: false,
    importedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  };
  const importedDays = shareDays.map((day, index) => ({
    ...day,
    id: dayIdMap.get(String(day.id)),
    programId: newProgramId,
    orderIndex: day.orderIndex ?? index,
  }));
  const importedSections = shareSections.map((section) => ({
    ...section,
    id: sectionIdMap.get(String(section.id)),
    programId: newProgramId,
    dayId: dayIdMap.get(String(section.dayId)),
  }));
  const importedProgramExercises = shareProgramExercises.map((programExercise, index) => {
    const importedDayId = dayIdMap.get(String(programExercise.dayId));
    const sectionKey = String(programExercise.sectionId ?? "");

    return {
      ...programExercise,
      id: `${newProgramId}:exercise-${index + 1}-${programExercise.exerciseId}`,
      programId: newProgramId,
      dayId: importedDayId,
      sectionId: sectionIds.has(sectionKey)
        ? sectionIdMap.get(sectionKey)
        : importedSections.find((section) => section.dayId === importedDayId)?.id ?? null,
    };
  });
  const importedState = {
    programId: newProgramId,
    lastCompletedDayId: null,
    nextRecommendedDayId: importedDays[0]?.id ?? null,
    currentWeek: 1,
    currentCycle: 1,
    lastWorkoutDate: null,
    updatedAt: createdAt,
  };

  // Only add library exercises that do not exist locally; never overwrite local content.
  const existingLibrary = asArray(readStorage(STORAGE_KEYS.exerciseLibrary, []));
  const existingLibraryIds = new Set(existingLibrary.map((exercise) => exercise.id));
  const newLibraryExercises = shareLibraryExercises.filter(
    (exercise) => !existingLibraryIds.has(exercise.id),
  );

  const entries = [
    { key: STORAGE_KEYS.programs, value: [...getAllPrograms(), program] },
    {
      key: STORAGE_KEYS.programDays,
      value: [...asArray(readStorage(STORAGE_KEYS.programDays, [])), ...importedDays],
    },
    {
      key: STORAGE_KEYS.programSections,
      value: [...asArray(readStorage(STORAGE_KEYS.programSections, [])), ...importedSections],
    },
    {
      key: STORAGE_KEYS.programExercises,
      value: [
        ...asArray(readStorage(STORAGE_KEYS.programExercises, [])),
        ...importedProgramExercises,
      ],
    },
  ];

  if (newLibraryExercises.length) {
    entries.push({
      key: STORAGE_KEYS.exerciseLibrary,
      value: [...existingLibrary, ...newLibraryExercises],
    });
  }

  entries.push({ key: STORAGE_KEYS.programStates, value: [...getProgramStates(), importedState] });

  const writeResult = writeStorageBatch(entries);

  if (!writeResult.ok) {
    return {
      ok: false,
      valid: false,
      error: writeResult.error,
      errors: [writeResult.error],
      code: writeResult.code,
      failedKey: writeResult.failedKey,
      rolledBack: writeResult.rolledBack,
      program: null,
      programId: null,
    };
  }

  return {
    ok: true,
    valid: true,
    errors: [],
    program,
    programId: newProgramId,
    importedDayCount: importedDays.length,
    importedExerciseCount: importedProgramExercises.length,
    addedLibraryExerciseCount: newLibraryExercises.length,
  };
}

/**
 * Decision 19.4-1: a duplicate starts fresh. Progression records are rebuilt
 * from the copied program targets with the base note and no provenance.
 */
function createFreshProgressionFromTarget(programExercise, createdAt) {
  return {
    id: makeProgressionId(programExercise.id),
    programId: programExercise.programId,
    programExerciseId: programExercise.id,
    lastRecommendedWeight: cleanWeight(programExercise.targetWeight),
    lastRecommendedReps: {
      min: programExercise.targetReps?.min ?? null,
      max: programExercise.targetReps?.max ?? null,
      label: programExercise.targetReps?.label ?? null,
    },
    lastRecommendedSets: programExercise.targetSets ?? null,
    lastTargetRPE: programExercise.targetRPE ?? null,
    recommendationNote: BASE_RECOMMENDATION_NOTE,
    sourceSessionId: null,
    sourcePlanGeneratedAt: null,
    updatedAt: createdAt,
  };
}

/**
 * Returns { ok: true, program, programId } or { ok: false, error, code, failedKey, program: null, programId: null }.
 * Writes every key in one batch: on failure no partial copy is left behind.
 */
export function duplicateProgram(programId) {
  const sourceProgram = getAllPrograms().find((program) => program.id === programId);
  if (!sourceProgram) {
    return { ok: false, error: "Program not found.", program: null, programId: null };
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
  const copiedProgressions = copiedProgramExercises.map((programExercise) =>
    createFreshProgressionFromTarget(programExercise, createdAt),
  );
  const copiedState = {
    programId: newProgramId,
    lastCompletedDayId: null,
    nextRecommendedDayId: copiedDays[0]?.id ?? null,
    currentWeek: 1,
    currentCycle: 1,
    lastWorkoutDate: null,
    updatedAt: createdAt,
  };

  const writeResult = writeStorageBatch([
    { key: STORAGE_KEYS.programs, value: [...getAllPrograms(), duplicate] },
    {
      key: STORAGE_KEYS.programDays,
      value: [...asArray(readStorage(STORAGE_KEYS.programDays, [])), ...copiedDays],
    },
    {
      key: STORAGE_KEYS.programSections,
      value: [...asArray(readStorage(STORAGE_KEYS.programSections, [])), ...copiedSections],
    },
    {
      key: STORAGE_KEYS.programExercises,
      value: [
        ...asArray(readStorage(STORAGE_KEYS.programExercises, [])),
        ...copiedProgramExercises,
      ],
    },
    {
      key: STORAGE_KEYS.baselines,
      value: [...asArray(readStorage(STORAGE_KEYS.baselines, [])), ...copiedBaselines],
    },
    {
      key: STORAGE_KEYS.programProgressions,
      value: [
        ...asArray(readStorage(STORAGE_KEYS.programProgressions, [])),
        ...copiedProgressions,
      ],
    },
    { key: STORAGE_KEYS.programStates, value: [...getProgramStates(), copiedState] },
  ]);

  if (!writeResult.ok) {
    return {
      ok: false,
      error: writeResult.error,
      code: writeResult.code,
      failedKey: writeResult.failedKey,
      rolledBack: writeResult.rolledBack,
      program: null,
      programId: null,
    };
  }

  return { ok: true, program: duplicate, programId: newProgramId };
}
