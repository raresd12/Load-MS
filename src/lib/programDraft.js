// Program drafts (handoff section 16, Phase H2; decisions H2-1..H2-4).
//
// A ProgramDraft is an in-memory, nested, editable object shared by the manual
// Studio, the AI Import Assistant and the file import:
//
// {
//   schemaVersion: 1, draftId, origin, sourceProgramId, aiInstruction, source,
//   createdAt, updatedAt,
//   program: { name, nickname, description, goal },
//   days: [{ id, name, focus, notes, isOptional, warmup, sections: [{ id, name, exercises: [...] }] }],
//   libraryExercises: [ new local Library entries proposed by the draft ]
// }
//
// Nothing in a draft touches program storage until saveProgramDraft /
// applyProgramDraft (programStorage.js). Every operation here returns a NEW
// draft (immutable style) or, when the target day/section/exercise does not
// exist, the same draft object unchanged. Order is array order; orderIndex is
// assigned on save.
import { isValidMeasurement } from "./measurement.js";
import { readStorage, STORAGE_KEYS } from "./storage.js";
import {
  cleanNumber,
  cleanRestTime,
  cleanWeight,
  collectProgramExerciseProfileErrors,
  collectProgramExerciseTargetErrors,
  DEFAULT_LOAD_TYPE,
  DEFAULT_PROGRAM_ID,
  DEFAULT_WEIGHT_MODE,
  getBuiltInExerciseConfig,
  getPrograms,
  getProgramDays,
  getProgramExercises,
  getProgramSections,
  isValidLoadType,
  isValidWeightMode,
  normalizeWarmup,
  PROGRAM_SHARE_SCHEMA_VERSION,
  PROGRAM_SHARE_TYPE,
  resolveProgramExerciseLoadProfile,
  validateProgramShare,
} from "./programStorage.js";

export const PROGRAM_DRAFT_SCHEMA_VERSION = 1;
export const DRAFT_ORIGINS = Object.freeze(["blank", "program", "ai-import", "ai-edit", "file-import"]);
export const DRAFT_LIBRARY_STATUSES = Object.freeze(["library", "new", "unmatched"]);
export const DRAFT_PROVENANCE_VALUES = Object.freeze(["source", "default", "edited"]);

// Fields whose origin (source / default / edited) is tracked per exercise.
export const DRAFT_EXERCISE_PROVENANCE_FIELDS = Object.freeze([
  "exerciseId",
  "name",
  "targetSets",
  "targetReps",
  "targetWeight",
  "targetRPE",
  "restTime",
  "notes",
  "type",
  "isOptional",
  "loadType",
  "weightMode",
  "sourceWeight",
]);

// A change to any of these deletes the stored progression of that program
// exercise on apply (decision 19.4-2 extended by H2-1).
export const DRAFT_PRESCRIPTION_FIELDS = Object.freeze([
  "exerciseId",
  "targetSets",
  "targetReps",
  "targetWeight",
  "targetRPE",
  "restTime",
  "loadType",
  "weightMode",
]);

// H5 fix round 1 (decision H5-19): the coach profile travels with the draft
// exercise - `measurement` / `perSide` (H5-1) and `profileOverrides` (H5-3) -
// so the Studio edits it in the working copy and Apply / Save write it with
// everything else. The keys are present only when the exercise carries them
// (an absent key = classified / inferred); no provenance is tracked for them.
export const DRAFT_EXERCISE_PROFILE_FIELDS = Object.freeze(["measurement", "perSide", "profileOverrides"]);

// Fields compared by diffDraftAgainstProgram and applyProgramDraft.
const DRAFT_EXERCISE_COMPARE_FIELDS = Object.freeze([
  ...DRAFT_PRESCRIPTION_FIELDS,
  "notes",
  "type",
  "isOptional",
  "sourceWeight",
  ...DRAFT_EXERCISE_PROFILE_FIELDS,
]);

function cleanDraftProfileOverrides(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const clean = Object.fromEntries(Object.entries(value).filter(([, entry]) => !isNullish(entry)));
  return Object.keys(clean).length ? clean : null;
}

// The profile fields of a draft exercise input: only the keys it carries
// with a usable value (a valid measurement, a boolean perSide, a non-empty
// overrides object); everything else is left out.
function readDraftProfileFields(source) {
  const fields = {};

  if (isValidMeasurement(source?.measurement)) {
    fields.measurement = source.measurement;
  }

  if (typeof source?.perSide === "boolean") {
    fields.perSide = source.perSide;
  }

  const overrides = cleanDraftProfileOverrides(source?.profileOverrides);

  if (overrides) {
    fields.profileOverrides = overrides;
  }

  return fields;
}

function comparableDraftProfile(source) {
  const fields = readDraftProfileFields(source);

  return {
    measurement: fields.measurement ?? null,
    perSide: fields.perSide ?? null,
    profileOverrides: fields.profileOverrides ?? null,
  };
}

const DEFAULT_TARGETS = Object.freeze({
  targetSets: 3,
  targetReps: Object.freeze({ min: 8, max: 12, label: null }),
  targetWeight: null,
  targetRPE: 8,
  restTime: 120,
  notes: "",
  type: "hypertrophy",
  isOptional: false,
});

const LIBRARY_ENTRY_STRING_FIELDS = Object.freeze([
  "name",
  "category",
  "equipment",
  "difficulty",
  "setup",
  "mainCue",
  "howToDoIt",
  "whyItsThere",
  "progressionRegression",
  "safetyNotes",
  "whatYouShouldFeel",
  "videoUrl",
  "video_url",
]);
const LIBRARY_ENTRY_LIST_FIELDS = Object.freeze([
  "mainMuscles",
  "secondaryMuscles",
  "goalTags",
  "executionTips",
  "commonMistakes",
]);

// AI preview "missing field" labels (aiProgram.js) -> draft fields.
const MISSING_FIELD_LABELS = Object.freeze({
  sets: "targetSets",
  reps: "targetReps",
  "target rpe": "targetRPE",
  rpe: "targetRPE",
  rest: "restTime",
  weight: "targetWeight",
});

let draftIdCounter = 0;

function nowIso() {
  return new Date().toISOString();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isNullish(value) {
  return value === null || value === undefined;
}

function hasOwn(object, field) {
  return Boolean(object) && typeof object === "object" && Object.prototype.hasOwnProperty.call(object, field);
}

function asIdMap(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanString(value) {
  return isNullish(value) ? "" : String(value).trim();
}

function isSameValue(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function slugify(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * Ids inside a draft are stable strings: `draft-<kind>-...` for new items.
 * Unique within a process (counter) and across sessions (time + random).
 */
export function makeDraftItemId(kind = "item") {
  draftIdCounter += 1;
  return `draft-${kind}-${Date.now().toString(36)}-${draftIdCounter.toString(36)}-${Math.random()
    .toString(16)
    .slice(2, 6)}`;
}

function touch(draft) {
  return { ...draft, updatedAt: nowIso() };
}

// ---------------------------------------------------------------------------
// Library lookup (local Library, draft proposals, built-in config)
// ---------------------------------------------------------------------------

function readLocalLibrary() {
  return asArray(readStorage(STORAGE_KEYS.exerciseLibrary, [])).filter(
    (entry) => entry && typeof entry === "object" && !isNullish(entry.id),
  );
}

function buildLibraryContext(draft, extraEntries = []) {
  const local = new Map(readLocalLibrary().map((entry) => [String(entry.id), entry]));
  const proposed = new Map(
    asArray(draft?.libraryExercises)
      .filter((entry) => entry && typeof entry === "object" && !isNullish(entry.id))
      .map((entry) => [String(entry.id), entry]),
  );
  const extra = new Map(
    asArray(extraEntries)
      .filter((entry) => entry && typeof entry === "object" && !isNullish(entry.id))
      .map((entry) => [String(entry.id), entry]),
  );

  return { local, proposed, extra };
}

/**
 * Resolves a library id to { status, entry } where status is "library"
 * (local Library or built-in config), "new" (proposed by the draft / share)
 * or null (unknown id).
 */
function resolveLibraryId(context, exerciseId) {
  if (isNullish(exerciseId) || cleanString(exerciseId) === "") {
    return { status: null, entry: null };
  }

  const key = String(exerciseId);

  if (context.local.has(key)) {
    return { status: "library", entry: context.local.get(key) };
  }

  const builtIn = getBuiltInExerciseConfig(key);

  if (builtIn) {
    return { status: "library", entry: { id: key, name: builtIn.name, equipment: builtIn.equipment } };
  }

  if (context.proposed.has(key)) {
    return { status: "new", entry: context.proposed.get(key) };
  }

  if (context.extra.has(key)) {
    return { status: "new", entry: context.extra.get(key) };
  }

  return { status: null, entry: null };
}

function deriveLoadProfile(exerciseId, libraryEntry) {
  return resolveProgramExerciseLoadProfile({ exerciseId: exerciseId ?? null }, libraryEntry ?? null);
}

/**
 * A minimal local Library entry (no invented technique content), the same
 * shape the AI import proposes.
 */
export function createDraftLibraryExercise(init = {}) {
  const name = cleanString(init.name);
  const mainMuscles = asArray(init.mainMuscles).map(cleanString).filter(Boolean);

  return normalizeLibraryEntry({
    id: cleanString(init.id) || `draft-lib-${slugify(name) || "exercise"}-${makeDraftItemId("lib").slice(-9)}`,
    name,
    category: cleanString(init.category) || "compound",
    mainMuscles,
    secondaryMuscles: asArray(init.secondaryMuscles).map(cleanString).filter(Boolean),
    equipment: cleanString(init.equipment) || "machine",
    difficulty: cleanString(init.difficulty) || "intermediate",
    goalTags: asArray(init.goalTags).map(cleanString).filter(Boolean),
    setup: cleanString(init.setup),
    mainCue: cleanString(init.mainCue),
    howToDoIt: cleanString(init.howToDoIt),
    executionTips: asArray(init.executionTips).map(cleanString).filter(Boolean),
    commonMistakes: asArray(init.commonMistakes).map(cleanString).filter(Boolean),
    whatYouShouldFeel: cleanString(init.whatYouShouldFeel) || mainMuscles.join(", "),
    whyItsThere: cleanString(init.whyItsThere),
    progressionRegression: cleanString(init.progressionRegression),
    safetyNotes: cleanString(init.safetyNotes),
    videoUrl: cleanString(init.videoUrl ?? init.video_url),
    video_url: cleanString(init.video_url ?? init.videoUrl),
  });
}

// Whitelist copy of a Library entry: only technique/identity text survives, so
// a stored draft can never carry uploaded files or image data (H2-3).
function normalizeLibraryEntry(entry) {
  return normalizeDraftLibraryEntry(entry);
}

/**
 * Whitelist copy of a proposed Library entry ({ id, name, category, ... } text
 * and string lists only), or null when it has no id or name. Used by the
 * draft normaliser and by the program writers before a proposed entry is
 * added to the Library.
 */
export function normalizeDraftLibraryEntry(entry) {
  if (!entry || typeof entry !== "object" || isNullish(entry.id)) {
    return null;
  }

  const clean = { id: String(entry.id) };

  LIBRARY_ENTRY_STRING_FIELDS.forEach((field) => {
    if (hasOwn(entry, field)) {
      clean[field] = cleanString(entry[field]);
    }
  });
  LIBRARY_ENTRY_LIST_FIELDS.forEach((field) => {
    if (hasOwn(entry, field)) {
      clean[field] = asArray(entry[field]).map(cleanString).filter(Boolean);
    }
  });

  // Decision H3-21: an accepted AI technique draft marks its entry as not
  // reviewed. Only that `false` is kept: a draft or a share file can never
  // claim the owner's review, which happens in the Library.
  if (hasOwn(entry, "reviewedByUser") && entry.reviewedByUser === false) {
    clean.reviewedByUser = false;
  }

  if (!clean.name) {
    return null;
  }

  return clean;
}

// ---------------------------------------------------------------------------
// Draft exercise normalisation
// ---------------------------------------------------------------------------

function normalizeTargetReps(value, fallback = null) {
  if (!value || typeof value !== "object") {
    return fallback;
  }

  return {
    min: cleanNumber(value.min, null),
    max: cleanNumber(value.max, null),
    label: cleanString(value.label) || null,
  };
}

function hasRepsValue(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      (!isNullish(value.min) || !isNullish(value.max) || cleanString(value.label)),
  );
}

function normalizeProvenance(input, fallbackValue = "edited") {
  const provenance = {};

  DRAFT_EXERCISE_PROVENANCE_FIELDS.forEach((field) => {
    const value = input && typeof input === "object" ? input[field] : undefined;
    provenance[field] = DRAFT_PROVENANCE_VALUES.includes(value) ? value : fallbackValue;
  });

  return provenance;
}

/**
 * Builds a clean draft exercise from any object (a share programExercise, a
 * stored ProgramExercise, a UI init object or a stored draft exercise).
 * `context` is a library context; `defaultProvenance` labels fields that were
 * present in `input`; fields the normaliser had to fill are "default".
 */
function normalizeDraftExercise(input, context, options = {}) {
  const source = input && typeof input === "object" ? input : {};
  const defaultProvenance = options.defaultProvenance ?? "edited";
  const provenance = {};
  // keepNulls: a stored draft keeps a cleared (null) value so validation can
  // report it instead of a default silently replacing it.
  const present = (field) =>
    hasOwn(source, field) && (options.keepNulls ? true : !isNullish(source[field]));
  const mark = (field, isPresent) => {
    provenance[field] = isPresent ? defaultProvenance : "default";
  };

  const requestedId = isNullish(source.exerciseId) ? null : String(source.exerciseId);
  const resolved = resolveLibraryId(context, requestedId);
  let libraryStatus = resolved.status ?? "unmatched";
  let exerciseId = resolved.status ? requestedId : null;
  let newLibraryExercise = null;

  if (resolved.status === "new") {
    newLibraryExercise = normalizeLibraryEntry(source.newLibraryExercise) ?? normalizeLibraryEntry(resolved.entry);
  } else if (!resolved.status && source.libraryStatus === "new") {
    // A draft exercise proposing an entry that is not (yet) in draft.libraryExercises.
    newLibraryExercise = normalizeLibraryEntry(source.newLibraryExercise);

    if (newLibraryExercise) {
      libraryStatus = "new";
      exerciseId = newLibraryExercise.id;
    }
  }

  const name =
    (libraryStatus === "library" ? cleanString(resolved.entry?.name) : "") ||
    cleanString(source.name) ||
    cleanString(newLibraryExercise?.name) ||
    (libraryStatus === "library" ? "Exercise" : requestedId ?? "");
  mark("exerciseId", present("exerciseId"));
  mark("name", present("name") || Boolean(resolved.entry));

  const targetSets = present("targetSets") ? cleanNumber(source.targetSets, null) : DEFAULT_TARGETS.targetSets;
  mark("targetSets", present("targetSets"));

  // With keepNulls a reps object whose min / max / label were all cleared is
  // still "present": the stored draft keeps the empty range so validation
  // reports it instead of the 8-12 default silently replacing a user edit.
  const repsPresent = options.keepNulls
    ? hasOwn(source, "targetReps") && Boolean(source.targetReps) && typeof source.targetReps === "object"
    : hasRepsValue(source.targetReps);
  const targetReps = repsPresent
    ? normalizeTargetReps(source.targetReps)
    : { ...DEFAULT_TARGETS.targetReps };
  mark("targetReps", repsPresent);

  // keepNulls (stored draft): weight / rest text the editor could not parse
  // ("82.5kgg", "150-") is kept as typed, like updateExercise keeps it, so a
  // resumed draft still fails validation and shows the text. Without it a
  // null weight would pass as "coach decides" and Apply would clear the
  // stored target (and its progression) from a typo.
  const keepUnparsedText = (value) =>
    options.keepNulls && typeof value === "string" && cleanString(value) ? cleanString(value).slice(0, 40) : null;

  const targetWeight = hasOwn(source, "targetWeight")
    ? (cleanWeight(source.targetWeight) ?? keepUnparsedText(source.targetWeight))
    : null;
  mark("targetWeight", hasOwn(source, "targetWeight"));

  const targetRPE = present("targetRPE") ? cleanNumber(source.targetRPE, null) : DEFAULT_TARGETS.targetRPE;
  mark("targetRPE", present("targetRPE"));

  const restTime = present("restTime")
    ? (cleanRestTime(source.restTime, null) ?? keepUnparsedText(source.restTime))
    : DEFAULT_TARGETS.restTime;
  mark("restTime", present("restTime"));

  const notes = present("notes") ? cleanString(source.notes) : DEFAULT_TARGETS.notes;
  mark("notes", present("notes"));

  const type = present("type") ? cleanString(source.type) || DEFAULT_TARGETS.type : DEFAULT_TARGETS.type;
  mark("type", present("type"));

  const isOptional = present("isOptional") ? Boolean(source.isOptional) : DEFAULT_TARGETS.isOptional;
  mark("isOptional", present("isOptional"));

  const derivedProfile = deriveLoadProfile(exerciseId, resolved.entry ?? newLibraryExercise);
  const loadType = isValidLoadType(source.loadType) ? source.loadType : derivedProfile.loadType;
  mark("loadType", isValidLoadType(source.loadType));
  const weightMode = isValidWeightMode(source.weightMode) ? source.weightMode : derivedProfile.weightMode;
  mark("weightMode", isValidWeightMode(source.weightMode));

  // Decision H2-4: a source-listed weight is reference text, never a target.
  const sourceWeight = present("sourceWeight") ? cleanString(source.sourceWeight) || null : null;
  mark("sourceWeight", present("sourceWeight"));

  const explicitProvenance = source.provenance && typeof source.provenance === "object" ? source.provenance : {};
  const mergedProvenance = { ...provenance };

  Object.entries(explicitProvenance).forEach(([field, value]) => {
    if (DRAFT_EXERCISE_PROVENANCE_FIELDS.includes(field) && DRAFT_PROVENANCE_VALUES.includes(value)) {
      mergedProvenance[field] = value;
    }
  });

  asArray(options.missingFields ?? source.missingFields).forEach((label) => {
    const field = MISSING_FIELD_LABELS[cleanString(label).toLowerCase()];

    if (field) {
      mergedProvenance[field] = "default";
    }
  });

  return {
    id: cleanString(source.id) || makeDraftItemId("exercise"),
    exerciseId,
    libraryStatus,
    name,
    newLibraryExercise,
    targetSets,
    targetReps,
    targetWeight,
    targetRPE,
    restTime,
    notes,
    type,
    isOptional,
    loadType,
    weightMode,
    sourceWeight,
    ...readDraftProfileFields(source),
    provenance: mergedProvenance,
  };
}

function normalizeDraftSection(input, context, options, fallbackName = "Main Work") {
  const source = input && typeof input === "object" ? input : {};

  return {
    id: cleanString(source.id) || makeDraftItemId("section"),
    name: cleanString(source.name) || fallbackName,
    exercises: asArray(source.exercises)
      .filter((exercise) => exercise && typeof exercise === "object")
      .map((exercise) => normalizeDraftExercise(exercise, context, options)),
  };
}

function normalizeDraftDay(input, context, options, index = 0) {
  const source = input && typeof input === "object" ? input : {};
  const sections = asArray(source.sections)
    .filter((section) => section && typeof section === "object")
    .map((section) => normalizeDraftSection(section, context, options));

  return {
    id: cleanString(source.id) || makeDraftItemId("day"),
    name: cleanString(source.name) || `Day ${index + 1}`,
    focus: cleanString(source.focus),
    notes: cleanString(source.notes),
    isOptional: Boolean(source.isOptional),
    // Warm-up is informational: normalizeWarmup keeps it a list of instruction
    // items and never turns them into exercises.
    warmup: normalizeWarmup(source.warmup),
    sections: sections.length ? sections : [normalizeDraftSection({}, context, options)],
  };
}

/**
 * Review notes an AI import / edit or a file import attached to the draft
 * (text lists only) so a resumed draft still shows what the AI changed,
 * removed and was unsure about. null when there is nothing to show.
 */
function normalizeReviewNotes(input) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const list = (value) => [
    ...new Set(
      asArray(value)
        .map((entry) => (entry && typeof entry === "object" ? cleanString(entry.name) : cleanString(entry)))
        .filter(Boolean),
    ),
  ].slice(0, 60);
  const notes = {
    changes: list(input.changes),
    removed: list(input.removed),
    uncertainty: list(input.uncertainty),
  };

  return notes.changes.length || notes.removed.length || notes.uncertainty.length ? notes : null;
}

function normalizeDraftProgram(input) {
  const source = input && typeof input === "object" ? input : {};

  return {
    name: cleanString(source.name),
    nickname: cleanString(source.nickname),
    description: cleanString(source.description),
    goal: cleanString(source.goal),
  };
}

/**
 * Whitelist normalisation of any object into the draft shape. Unknown fields
 * (uploaded files, image data, API keys, anything a component attached) are
 * dropped, which is what makes a stored draft safe (decision H2-3). Existing
 * provenance labels are kept; fields that were missing become "default".
 */
export function normalizeProgramDraft(input, options = {}) {
  const source = input && typeof input === "object" ? input : {};
  const libraryExercises = asArray(source.libraryExercises).map(normalizeLibraryEntry).filter(Boolean);
  const context = buildLibraryContext({ libraryExercises });
  const exerciseOptions = {
    defaultProvenance: options.defaultProvenance ?? "edited",
    keepNulls: Boolean(options.keepNulls),
  };
  const createdAt = cleanString(source.createdAt) || nowIso();

  return {
    schemaVersion: PROGRAM_DRAFT_SCHEMA_VERSION,
    draftId: cleanString(source.draftId) || makeDraftItemId("program"),
    origin: DRAFT_ORIGINS.includes(source.origin) ? source.origin : "blank",
    sourceProgramId: cleanString(source.sourceProgramId) || null,
    aiInstruction: cleanString(source.aiInstruction) || null,
    source: cleanString(source.source) || null,
    createdAt,
    updatedAt: cleanString(source.updatedAt) || createdAt,
    program: normalizeDraftProgram(source.program),
    days: asArray(source.days)
      .filter((day) => day && typeof day === "object")
      .map((day, index) => normalizeDraftDay(day, context, exerciseOptions, index)),
    libraryExercises,
    reviewNotes: normalizeReviewNotes(source.reviewNotes),
  };
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * A blank custom draft with one empty day ("Day 1" / "Main Work").
 * `init.program` may preset the metadata.
 */
export function createBlankProgramDraft(init = {}) {
  const createdAt = nowIso();
  const context = buildLibraryContext(null);

  return {
    schemaVersion: PROGRAM_DRAFT_SCHEMA_VERSION,
    draftId: makeDraftItemId("program"),
    origin: "blank",
    sourceProgramId: null,
    aiInstruction: null,
    source: null,
    createdAt,
    updatedAt: createdAt,
    program: normalizeDraftProgram(init.program ?? init),
    days: [normalizeDraftDay({ name: "Day 1" }, context, { defaultProvenance: "edited" }, 0)],
    libraryExercises: [],
    reviewNotes: null,
  };
}

function groupExercisesIntoSections(sections, exercises, context, options, makeSectionIdFallback) {
  const sectionList = sections.length
    ? sections
    : [{ id: makeSectionIdFallback(), name: "Main Work", orderIndex: 0 }];
  const sectionIds = new Set(sectionList.map((section) => String(section.id)));
  const bySection = new Map(sectionList.map((section) => [String(section.id), []]));
  const firstSectionId = String(sectionList[0].id);

  exercises.forEach((exercise) => {
    const key = String(exercise.sectionId ?? "");
    bySection.get(sectionIds.has(key) ? key : firstSectionId).push(exercise);
  });

  return sectionList.map((section) => ({
    id: String(section.id),
    name: cleanString(section.name) || "Main Work",
    exercises: bySection
      .get(String(section.id))
      .map((exercise) => normalizeDraftExercise(exercise, context, options)),
  }));
}

/**
 * Draft of an existing CUSTOM program (origin "program", sourceProgramId set,
 * ids = the stored day / section / programExercise ids so applyProgramDraft
 * can keep them). Default programs are protected: { ok: false, error }.
 * Returns { ok: true, draft }.
 */
export function draftFromProgram(programId) {
  const program = getPrograms({ includeArchived: true }).find((entry) => entry.id === programId);

  if (!program) {
    return { ok: false, error: "Program not found.", draft: null };
  }

  if (program.isDefault || program.id === DEFAULT_PROGRAM_ID) {
    return {
      ok: false,
      error: "Default programs are protected. Duplicate the program first.",
      draft: null,
    };
  }

  const context = buildLibraryContext(null);
  const options = { defaultProvenance: "source" };
  const createdAt = nowIso();
  const days = getProgramDays(program.id).map((day, index) => {
    const sections = getProgramSections(day.id);
    const exercises = getProgramExercises(day.id).map((programExercise) => ({
      ...programExercise,
      // A stored record has no provenance: everything it holds is "source".
      provenance: undefined,
    }));

    return {
      id: String(day.id),
      name: cleanString(day.name) || `Day ${index + 1}`,
      focus: cleanString(day.focus),
      notes: cleanString(day.notes),
      isOptional: Boolean(day.isOptional),
      warmup: normalizeWarmup(day.warmup),
      sections: groupExercisesIntoSections(sections, exercises, context, options, () =>
        makeDraftItemId("section"),
      ),
    };
  });

  return {
    ok: true,
    draft: {
      schemaVersion: PROGRAM_DRAFT_SCHEMA_VERSION,
      draftId: makeDraftItemId("program"),
      origin: "program",
      sourceProgramId: program.id,
      aiInstruction: null,
      source: null,
      createdAt,
      updatedAt: createdAt,
      program: normalizeDraftProgram(program),
      days,
      libraryExercises: [],
      reviewNotes: null,
    },
  };
}

/**
 * Draft from a share envelope (handoff 11.4), including the AI-generated share
 * (`share.source === "ai-generated"`) and a draftToShare export. Values present
 * in the share are "source"; values the normaliser had to fill are "default";
 * an optional `share.draftMeta.provenance[exerciseId]` (draftToShare) and a
 * per-exercise `missingFields` list (AI preview labels) override that. Library
 * entries carried by the share that are not in the local Library become
 * proposed "new" entries. Draft ids: a program exercise's `refId` (AI edit),
 * else `draftMeta.exerciseIds[shareId]` / `options.exerciseIds[shareId]`, else
 * the share id; days likewise through `days[].refId` then `dayIds`, sections
 * through `sectionIds`. `share.source` "ai-generated" / "ai-edit" pick the
 * origin when `options.origin` is absent (anything else is "file-import").
 * `options`: { origin, sourceProgramId, aiInstruction, draftId, exerciseIds, dayIds, sectionIds }.
 * Returns { ok: true, draft } or { ok: false, error, draft: null }.
 */
export function draftFromShare(share, options = {}) {
  const basic = validateProgramShare(share);

  if (!basic.valid) {
    return { ok: false, error: basic.error, draft: null };
  }

  const shareLibrary = asArray(share.libraryExercises).map(normalizeLibraryEntry).filter(Boolean);
  const context = buildLibraryContext({ libraryExercises: [] }, shareLibrary);
  const proposed = shareLibrary.filter((entry) => !context.local.has(entry.id) && !getBuiltInExerciseConfig(entry.id));
  context.proposed = new Map(proposed.map((entry) => [entry.id, entry]));
  context.extra = new Map();

  const draftMeta = share.draftMeta && typeof share.draftMeta === "object" ? share.draftMeta : {};
  const metaProvenance = draftMeta.provenance && typeof draftMeta.provenance === "object" ? draftMeta.provenance : {};
  // Share id -> draft id. draftToShare writes these maps into draftMeta; a
  // caller may pass its own (options.exerciseIds / dayIds / sectionIds, e.g.
  // the maps of the base share an AI edit started from), which win.
  const metaExerciseIds = { ...asIdMap(draftMeta.exerciseIds), ...asIdMap(options.exerciseIds) };
  const metaDayIds = { ...asIdMap(draftMeta.dayIds), ...asIdMap(options.dayIds) };
  const metaSectionIds = { ...asIdMap(draftMeta.sectionIds), ...asIdMap(options.sectionIds) };
  const exerciseOptions = { defaultProvenance: "source" };

  const shareDays = asArray(share.days)
    .filter((day) => day && typeof day === "object" && !isNullish(day.id))
    .map((day, index) => ({ day, index }))
    .sort((left, right) => (left.day.orderIndex ?? left.index) - (right.day.orderIndex ?? right.index))
    .map(({ day }) => day);
  const shareSections = asArray(share.sections).filter(
    (section) => section && typeof section === "object" && !isNullish(section.id),
  );
  const shareExercises = asArray(share.programExercises).filter(
    (exercise) => exercise && typeof exercise === "object",
  );

  const days = shareDays.map((day, index) => {
    const dayKey = String(day.id);
    // An AI edit echoes the existing day id as `refId` (aiProgram.js), so the
    // draft keeps that day id and applyProgramDraft / diffDraftAgainstProgram
    // treat it as the same day.
    const dayRefId = cleanString(day.refId);
    const sections = shareSections
      .filter((section) => String(section.dayId) === dayKey)
      .map((section, sectionIndex) => ({ section, sectionIndex }))
      .sort(
        (left, right) =>
          (left.section.orderIndex ?? left.sectionIndex) - (right.section.orderIndex ?? right.sectionIndex),
      )
      .map(({ section }) => ({
        ...section,
        id: cleanString(metaSectionIds[String(section.id)]) || String(section.id),
      }));
    const exercises = shareExercises
      .filter((exercise) => String(exercise.dayId) === dayKey)
      .map((exercise, exerciseIndex) => ({ exercise, exerciseIndex }))
      .sort(
        (left, right) =>
          (left.exercise.orderIndex ?? left.exerciseIndex) - (right.exercise.orderIndex ?? right.exerciseIndex),
      )
      .map(({ exercise }) => {
        const shareId = String(exercise.id ?? "");
        // An AI edit echoes the existing programExerciseId as `refId`
        // (aiProgram.js), so the draft keeps that id and applyProgramDraft
        // can keep the stored exercise, its baseline and its progression.
        const refId = cleanString(exercise.refId);
        const { missingFields, refId: _refId, ...rest } = exercise;

        return {
          ...rest,
          // The section ids were renamed through metaSectionIds above; the
          // exercise must point at the renamed id or it falls back to the
          // first section (a draftToShare round trip collapsed sections).
          sectionId: cleanString(metaSectionIds[String(exercise.sectionId ?? "")]) || exercise.sectionId,
          id:
            (refId && (cleanString(metaExerciseIds[refId]) || refId)) ||
            cleanString(metaExerciseIds[shareId]) ||
            shareId,
          provenance: metaProvenance[shareId],
          missingFields,
        };
      });

    return {
      id:
        (dayRefId && (cleanString(metaDayIds[dayRefId]) || dayRefId)) ||
        cleanString(metaDayIds[dayKey]) ||
        dayKey,
      name: cleanString(day.name) || `Day ${index + 1}`,
      focus: cleanString(day.focus),
      notes: cleanString(day.notes),
      isOptional: Boolean(day.isOptional),
      warmup: normalizeWarmup(day.warmup),
      sections: groupExercisesIntoSections(sections, exercises, context, exerciseOptions, () =>
        makeDraftItemId("section"),
      ),
    };
  });

  const referencedProposedIds = new Set(
    days.flatMap((day) =>
      day.sections.flatMap((section) =>
        section.exercises.filter((exercise) => exercise.libraryStatus === "new").map((exercise) => exercise.exerciseId),
      ),
    ),
  );
  const createdAt = nowIso();
  const source = cleanString(share.source) || null;

  return {
    ok: true,
    draft: {
      schemaVersion: PROGRAM_DRAFT_SCHEMA_VERSION,
      draftId: cleanString(options.draftId ?? draftMeta.draftId) || makeDraftItemId("program"),
      origin: DRAFT_ORIGINS.includes(options.origin)
        ? options.origin
        : source === "ai-generated"
          ? "ai-import"
          : source === "ai-edit"
            ? "ai-edit"
            : "file-import",
      sourceProgramId: cleanString(options.sourceProgramId) || null,
      aiInstruction: cleanString(options.aiInstruction) || null,
      source,
      createdAt,
      updatedAt: createdAt,
      program: normalizeDraftProgram(share.program),
      days,
      libraryExercises: proposed.filter((entry) => referencedProposedIds.has(entry.id)),
      // An AI share carries what the model changed / removed / was unsure
      // about in draftMeta; keeping the text on the draft means a resumed
      // review still shows it.
      reviewNotes: normalizeReviewNotes({
        changes: draftMeta.changes,
        removed: draftMeta.removed,
        uncertainty: draftMeta.uncertainty,
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Draft -> share
// ---------------------------------------------------------------------------

function forEachDraftExercise(draft, callback) {
  asArray(draft?.days).forEach((day, dayIndex) => {
    asArray(day?.sections).forEach((section, sectionIndex) => {
      asArray(section?.exercises).forEach((exercise, exerciseIndex) => {
        callback(exercise, { day, dayIndex, section, sectionIndex, exerciseIndex });
      });
    });
  });
}

/**
 * Share envelope (handoff 11.4, schemaVersion 1) of a draft. Ids come from the
 * array order (`draft:day-1`, `draft:day-1:section-1`, ...), each program
 * exercise carries loadType / weightMode (and sourceWeight when present), and
 * `draftMeta` holds the provenance plus the draft ids so that a share edited
 * elsewhere (e.g. by the AI) can come back with its ids intact.
 * importProgramShare / validateProgramShareStrict ignore `draftMeta`.
 */
export function draftToShare(draft) {
  const shareProgramId = "draft";
  const days = [];
  const sections = [];
  const programExercises = [];
  const provenance = {};
  const exerciseIds = {};
  const dayIds = {};
  const sectionIds = {};
  const libraryStatus = {};
  const localLibrary = new Map(readLocalLibrary().map((entry) => [String(entry.id), entry]));
  const proposed = new Map(
    asArray(draft?.libraryExercises)
      .filter((entry) => entry && !isNullish(entry.id))
      .map((entry) => [String(entry.id), entry]),
  );
  const libraryExercises = [];
  const includedLibraryIds = new Set();
  let exerciseCounter = 0;

  asArray(draft?.days).forEach((day, dayIndex) => {
    const dayId = `${shareProgramId}:day-${dayIndex + 1}`;
    dayIds[dayId] = day.id;
    const shareDay = {
      id: dayId,
      programId: shareProgramId,
      name: day.name,
      focus: day.focus ?? "",
      orderIndex: dayIndex,
    };

    if (cleanString(day.notes)) {
      shareDay.notes = cleanString(day.notes);
    }

    if (day.isOptional) {
      shareDay.isOptional = true;
    }

    const warmup = normalizeWarmup(day.warmup);

    if (warmup) {
      shareDay.warmup = warmup;
    }

    days.push(shareDay);

    let dayOrderIndex = 0;

    asArray(day.sections).forEach((section, sectionIndex) => {
      const sectionId = `${dayId}:section-${sectionIndex + 1}`;
      sectionIds[sectionId] = section.id;
      sections.push({
        id: sectionId,
        programId: shareProgramId,
        dayId,
        name: section.name,
        orderIndex: sectionIndex,
      });

      asArray(section.exercises).forEach((exercise) => {
        exerciseCounter += 1;
        const shareExerciseId = `${shareProgramId}:exercise-${exerciseCounter}-${exercise.exerciseId ?? "unmatched"}`;
        exerciseIds[shareExerciseId] = exercise.id;
        provenance[shareExerciseId] = { ...(exercise.provenance ?? {}) };
        libraryStatus[shareExerciseId] = exercise.libraryStatus;

        const shareExercise = {
          id: shareExerciseId,
          programId: shareProgramId,
          dayId,
          sectionId,
          exerciseId: exercise.exerciseId ?? null,
          orderIndex: dayOrderIndex,
          targetSets: exercise.targetSets,
          targetReps: { ...(exercise.targetReps ?? {}) },
          targetWeight: exercise.targetWeight ?? null,
          targetRPE: exercise.targetRPE,
          restTime: exercise.restTime,
          notes: exercise.notes ?? "",
          type: exercise.type,
          isOptional: Boolean(exercise.isOptional),
          loadType: exercise.loadType,
          weightMode: exercise.weightMode,
        };

        if (exercise.sourceWeight) {
          shareExercise.sourceWeight = exercise.sourceWeight;
        }

        Object.assign(shareExercise, readDraftProfileFields(exercise));

        if (exercise.libraryStatus === "unmatched" && exercise.name) {
          shareExercise.name = exercise.name;
        }

        dayOrderIndex += 1;
        programExercises.push(shareExercise);

        const libraryKey = exercise.exerciseId === null || exercise.exerciseId === undefined ? null : String(exercise.exerciseId);

        if (libraryKey && !includedLibraryIds.has(libraryKey)) {
          const entry =
            exercise.libraryStatus === "new"
              ? (proposed.get(libraryKey) ?? normalizeLibraryEntry(exercise.newLibraryExercise))
              : (localLibrary.get(libraryKey) ?? null);

          if (entry) {
            includedLibraryIds.add(libraryKey);
            libraryExercises.push(entry);
          }
        }
      });
    });
  });

  return {
    app: "rpe-workout-tracker",
    type: PROGRAM_SHARE_TYPE,
    schemaVersion: PROGRAM_SHARE_SCHEMA_VERSION,
    exportedAt: nowIso(),
    ...(draft?.source ? { source: draft.source } : {}),
    program: normalizeDraftProgram(draft?.program),
    days,
    sections,
    programExercises,
    libraryExercises,
    draftMeta: {
      schemaVersion: PROGRAM_DRAFT_SCHEMA_VERSION,
      draftId: draft?.draftId ?? null,
      origin: draft?.origin ?? null,
      sourceProgramId: draft?.sourceProgramId ?? null,
      aiInstruction: draft?.aiInstruction ?? null,
      provenance,
      libraryStatus,
      exerciseIds,
      dayIds,
      sectionIds,
    },
  };
}

// ---------------------------------------------------------------------------
// Immutable operations
// ---------------------------------------------------------------------------

function findDay(draft, dayId) {
  return asArray(draft?.days).find((day) => day.id === dayId) ?? null;
}

function replaceDay(draft, dayId, updater) {
  const days = asArray(draft?.days);
  const index = days.findIndex((day) => day.id === dayId);

  if (index < 0) {
    return draft;
  }

  const nextDay = updater(days[index]);

  if (nextDay === days[index]) {
    return draft;
  }

  const nextDays = [...days];
  nextDays[index] = nextDay;
  return touch({ ...draft, days: nextDays });
}

function replaceSection(draft, dayId, sectionId, updater) {
  return replaceDay(draft, dayId, (day) => {
    const sections = asArray(day.sections);
    const index = sections.findIndex((section) => section.id === sectionId);

    if (index < 0) {
      return day;
    }

    const nextSection = updater(sections[index]);

    if (nextSection === sections[index]) {
      return day;
    }

    const nextSections = [...sections];
    nextSections[index] = nextSection;
    return { ...day, sections: nextSections };
  });
}

function findExercise(day, exerciseId) {
  for (const section of asArray(day?.sections)) {
    const index = asArray(section.exercises).findIndex((exercise) => exercise.id === exerciseId);

    if (index >= 0) {
      return { section, index, exercise: section.exercises[index] };
    }
  }

  return null;
}

function replaceExercise(draft, dayId, exerciseId, updater) {
  const day = findDay(draft, dayId);
  const located = day ? findExercise(day, exerciseId) : null;

  if (!located) {
    return draft;
  }

  return replaceSection(draft, dayId, located.section.id, (section) => {
    const nextExercise = updater(section.exercises[located.index]);

    if (nextExercise === section.exercises[located.index]) {
      return section;
    }

    const nextExercises = [...section.exercises];
    nextExercises[located.index] = nextExercise;
    return { ...section, exercises: nextExercises };
  });
}

function moveInArray(items, fromIndex, toIndex) {
  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  const clamped = Math.max(0, Math.min(Number.isInteger(toIndex) ? toIndex : next.length, next.length));
  next.splice(clamped, 0, item);
  return next;
}

/** Program metadata (name, nickname, description, goal). */
export function updateProgramMeta(draft, patch = {}) {
  const fields = ["name", "nickname", "description", "goal"];
  const next = { ...draft.program };
  let changed = false;

  fields.forEach((field) => {
    if (hasOwn(patch, field)) {
      const value = cleanString(patch[field]);

      if (value !== next[field]) {
        next[field] = value;
        changed = true;
      }
    }
  });

  return changed ? touch({ ...draft, program: next }) : draft;
}

/** Adds a day (with one "Main Work" section) at `init.index` or at the end. */
export function addDay(draft, init = {}) {
  const context = buildLibraryContext(draft);
  const index = asArray(draft.days).length;
  const day = normalizeDraftDay(
    { ...init, id: init.id, name: init.name ?? `Day ${index + 1}` },
    context,
    { defaultProvenance: "edited" },
    index,
  );
  const days = [...asArray(draft.days)];
  const at = Number.isInteger(init.index) ? Math.max(0, Math.min(init.index, days.length)) : days.length;
  days.splice(at, 0, day);
  return touch({ ...draft, days });
}

export function removeDay(draft, dayId) {
  const days = asArray(draft.days);
  const next = days.filter((day) => day.id !== dayId);
  return next.length === days.length ? draft : touch({ ...draft, days: next });
}

export function moveDay(draft, dayId, toIndex) {
  const days = asArray(draft.days);
  const from = days.findIndex((day) => day.id === dayId);

  if (from < 0) {
    return draft;
  }

  return touch({ ...draft, days: moveInArray(days, from, toIndex) });
}

/** Day metadata: name, focus, notes, isOptional. */
export function updateDayMeta(draft, dayId, patch = {}) {
  return replaceDay(draft, dayId, (day) => {
    const next = { ...day };
    let changed = false;

    ["name", "focus", "notes"].forEach((field) => {
      if (hasOwn(patch, field)) {
        const value = cleanString(patch[field]);

        if (value !== next[field]) {
          next[field] = value;
          changed = true;
        }
      }
    });

    if (hasOwn(patch, "isOptional") && Boolean(patch.isOptional) !== Boolean(next.isOptional)) {
      next.isOptional = Boolean(patch.isOptional);
      changed = true;
    }

    return changed ? next : day;
  });
}

/**
 * Sets (or clears with null) a day's informational warm-up. Items are
 * instruction rows { id, name, prescription, notes, videoUrl }; they never
 * become exercises, Library entries or logged sets (handoff 3.3).
 */
export function updateWarmup(draft, dayId, warmup) {
  return replaceDay(draft, dayId, (day) => {
    const next = normalizeWarmup(warmup);
    return isSameValue(next, day.warmup) ? day : { ...day, warmup: next };
  });
}

export function addSection(draft, dayId, init = {}) {
  return replaceDay(draft, dayId, (day) => {
    const context = buildLibraryContext(draft);
    const section = normalizeDraftSection(
      { ...init, exercises: init.exercises ?? [] },
      context,
      { defaultProvenance: "edited" },
      `Section ${asArray(day.sections).length + 1}`,
    );
    const sections = [...asArray(day.sections)];
    const at = Number.isInteger(init.index) ? Math.max(0, Math.min(init.index, sections.length)) : sections.length;
    sections.splice(at, 0, section);
    return { ...day, sections };
  });
}

/** Removes a section together with the exercises it holds. */
export function removeSection(draft, dayId, sectionId) {
  return replaceDay(draft, dayId, (day) => {
    const sections = asArray(day.sections);
    const next = sections.filter((section) => section.id !== sectionId);
    return next.length === sections.length ? day : { ...day, sections: next };
  });
}

export function moveSection(draft, dayId, sectionId, toIndex) {
  return replaceDay(draft, dayId, (day) => {
    const sections = asArray(day.sections);
    const from = sections.findIndex((section) => section.id === sectionId);
    return from < 0 ? day : { ...day, sections: moveInArray(sections, from, toIndex) };
  });
}

export function updateSectionMeta(draft, dayId, sectionId, patch = {}) {
  return replaceSection(draft, dayId, sectionId, (section) => {
    if (!hasOwn(patch, "name")) {
      return section;
    }

    const name = cleanString(patch.name) || section.name;
    return name === section.name ? section : { ...section, name };
  });
}

/**
 * Adds an exercise to a section at `init.index` or at the end. `init` may hold
 * an `exerciseId` (resolved against the local Library, the draft's proposed
 * entries and the built-in config), a free `name` (unmatched) and any target
 * field; provided values are "edited", filled ones "default".
 */
export function addExercise(draft, dayId, sectionId, init = {}) {
  let added = null;
  const nextDraft = replaceSection(draft, dayId, sectionId, (section) => {
    const context = buildLibraryContext(draft);
    const { index, ...exerciseInit } = init;
    const exercise = normalizeDraftExercise(
      { ...exerciseInit, id: exerciseInit.id },
      context,
      { defaultProvenance: "edited" },
    );
    const exercises = [...asArray(section.exercises)];
    const at = Number.isInteger(index) ? Math.max(0, Math.min(index, exercises.length)) : exercises.length;
    exercises.splice(at, 0, exercise);
    added = exercise;
    return { ...section, exercises };
  });

  // A "new" exercise added with its own proposal keeps draft.libraryExercises
  // in step, so every proposal lives in one place.
  if (nextDraft !== draft && added?.libraryStatus === "new" && added.newLibraryExercise) {
    return upsertProposedLibraryEntry(nextDraft, added.newLibraryExercise);
  }

  return nextDraft;
}

export function removeExercise(draft, dayId, exerciseId) {
  const day = findDay(draft, dayId);
  const located = day ? findExercise(day, exerciseId) : null;

  if (!located) {
    return draft;
  }

  return replaceSection(draft, dayId, located.section.id, (section) => ({
    ...section,
    exercises: section.exercises.filter((exercise) => exercise.id !== exerciseId),
  }));
}

/**
 * Moves an exercise within its section or to another section of the same day:
 * `target` is { sectionId?, index? } (or a bare index). Missing sectionId
 * means the current section; missing index means the end of the target.
 */
export function moveExercise(draft, dayId, exerciseId, target = {}) {
  const day = findDay(draft, dayId);
  const located = day ? findExercise(day, exerciseId) : null;

  if (!located) {
    return draft;
  }

  const options = typeof target === "number" ? { index: target } : target ?? {};
  const targetSectionId = options.sectionId ?? located.section.id;
  const targetSection = asArray(day.sections).find((section) => section.id === targetSectionId);

  if (!targetSection) {
    return draft;
  }

  if (targetSection.id === located.section.id) {
    return replaceSection(draft, dayId, targetSection.id, (section) => ({
      ...section,
      exercises: moveInArray(section.exercises, located.index, options.index),
    }));
  }

  return replaceDay(draft, dayId, (currentDay) => ({
    ...currentDay,
    sections: currentDay.sections.map((section) => {
      if (section.id === located.section.id) {
        return { ...section, exercises: section.exercises.filter((exercise) => exercise.id !== exerciseId) };
      }

      if (section.id === targetSection.id) {
        const exercises = [...section.exercises];
        const at = Number.isInteger(options.index)
          ? Math.max(0, Math.min(options.index, exercises.length))
          : exercises.length;
        exercises.splice(at, 0, located.exercise);
        return { ...section, exercises };
      }

      return section;
    }),
  }));
}

function cleanExercisePatchValue(field, value, current) {
  switch (field) {
    case "targetSets":
    case "targetRPE":
      return cleanNumber(value, null);
    case "targetReps": {
      const next = value && typeof value === "object" ? value : {};
      const existing = current && typeof current === "object" ? current : {};

      return {
        min: hasOwn(next, "min") ? cleanNumber(next.min, null) : (existing.min ?? null),
        max: hasOwn(next, "max") ? cleanNumber(next.max, null) : (existing.max ?? null),
        label: hasOwn(next, "label") ? cleanString(next.label) || null : (existing.label ?? null),
      };
    }
    case "targetWeight": {
      // Text the editor could not parse ("abc") is kept as it was typed so
      // validateProgramDraft reports it and Save stays blocked, instead of
      // the previous value silently surviving behind the field.
      const weight = cleanWeight(value);
      return weight === null && typeof value === "string" && cleanString(value) ? cleanString(value) : weight;
    }
    case "restTime": {
      const rest = cleanRestTime(value, null);
      return rest === null && typeof value === "string" && cleanString(value) ? cleanString(value) : rest;
    }
    case "isOptional":
      return Boolean(value);
    case "loadType":
      return isValidLoadType(value) ? value : current;
    case "weightMode":
      return isValidWeightMode(value) ? value : current;
    case "sourceWeight":
      return cleanString(value) || null;
    case "type":
      return cleanString(value) || current;
    default:
      return cleanString(value);
  }
}

/**
 * Patches target / measurement / note fields of one exercise and marks every
 * field whose value changed as "edited". Unusable numbers become null so
 * validateProgramDraft reports them instead of silently keeping old values.
 * `exerciseId` is not patched here: use remapExercise. For a "new" exercise a
 * name edit renames the proposed Library entry as well.
 */
export function updateExercise(draft, dayId, exerciseId, patch = {}) {
  const editable = DRAFT_EXERCISE_PROVENANCE_FIELDS.filter((field) => field !== "exerciseId");
  let nextDraft = replaceExercise(draft, dayId, exerciseId, (exercise) => {
    const next = { ...exercise, provenance: { ...(exercise.provenance ?? {}) } };
    let changed = false;

    editable.forEach((field) => {
      if (!hasOwn(patch, field)) {
        return;
      }

      if (field === "name" && exercise.libraryStatus === "library") {
        // Library = technique identity; the name of a matched exercise is the entry's.
        return;
      }

      const value = cleanExercisePatchValue(field, patch[field], exercise[field]);

      if (!isSameValue(value, exercise[field])) {
        next[field] = value;
        next.provenance[field] = "edited";
        changed = true;
      }
    });

    if (changed && hasOwn(patch, "name") && next.libraryStatus === "new" && next.newLibraryExercise && next.name) {
      next.newLibraryExercise = { ...next.newLibraryExercise, name: next.name };
    }

    // Coach profile fields (H5-19): a null / unusable value removes the key
    // (back to classified / inferred), a usable one is stored as it is.
    DRAFT_EXERCISE_PROFILE_FIELDS.forEach((field) => {
      if (!hasOwn(patch, field)) {
        return;
      }

      const value = readDraftProfileFields({ [field]: patch[field] })[field];

      if (isSameValue(value, exercise[field])) {
        return;
      }

      if (value === undefined) {
        delete next[field];
      } else {
        next[field] = value;
      }

      changed = true;
    });

    return changed ? next : exercise;
  });

  if (nextDraft !== draft) {
    const updated = findExercise(findDay(nextDraft, dayId), exerciseId)?.exercise;

    if (updated?.libraryStatus === "new" && updated.newLibraryExercise) {
      nextDraft = upsertProposedLibraryEntry(nextDraft, updated.newLibraryExercise);
    }
  }

  return nextDraft;
}

function upsertProposedLibraryEntry(draft, entry) {
  const clean = normalizeLibraryEntry(entry);

  if (!clean) {
    return draft;
  }

  const list = asArray(draft.libraryExercises);
  const index = list.findIndex((item) => String(item.id) === clean.id);

  if (index >= 0 && isSameValue(list[index], clean)) {
    return draft;
  }

  const next = [...list];

  if (index >= 0) {
    next[index] = clean;
  } else {
    next.push(clean);
  }

  return { ...draft, libraryExercises: next };
}

function pruneProposedLibraryEntries(draft) {
  const referenced = new Set();

  forEachDraftExercise(draft, (exercise) => {
    if (exercise.libraryStatus === "new" && exercise.exerciseId) {
      referenced.add(String(exercise.exerciseId));
    }
  });

  const list = asArray(draft.libraryExercises);
  const next = list.filter((entry) => referenced.has(String(entry.id)));
  return next.length === list.length ? draft : { ...draft, libraryExercises: next };
}

/**
 * Maps an exercise to a Library id (local Library, built-in config or a draft
 * proposal), or to null (unmatched). The name follows the Library entry; the
 * measurement profile is re-derived from the entry unless the user edited it.
 * Statuses: "library" | "new" | "unmatched". Unknown ids leave the draft unchanged.
 */
export function remapExercise(draft, dayId, exerciseId, libraryExerciseId) {
  const context = buildLibraryContext(draft);
  const requested = isNullish(libraryExerciseId) || cleanString(libraryExerciseId) === "" ? null : String(libraryExerciseId);
  const resolved = requested ? resolveLibraryId(context, requested) : { status: null, entry: null };

  if (requested && !resolved.status) {
    return draft;
  }

  const nextDraft = replaceExercise(draft, dayId, exerciseId, (exercise) => {
    const status = requested ? resolved.status : "unmatched";
    const provenance = { ...(exercise.provenance ?? {}), exerciseId: "edited" };
    const next = {
      ...exercise,
      exerciseId: requested,
      libraryStatus: status,
      newLibraryExercise: status === "new" ? normalizeLibraryEntry(resolved.entry) : null,
      provenance,
    };

    if (status !== "unmatched" && cleanString(resolved.entry?.name)) {
      next.name = cleanString(resolved.entry.name);
      provenance.name = "source";
    }

    const profile = deriveLoadProfile(requested, resolved.entry);

    if (provenance.loadType !== "edited") {
      next.loadType = profile.loadType;
      provenance.loadType = requested ? "source" : "default";
    }

    if (provenance.weightMode !== "edited") {
      next.weightMode = profile.weightMode;
      provenance.weightMode = requested ? "source" : "default";
    }

    return isSameValue(next, exercise) ? exercise : next;
  });

  return nextDraft === draft ? draft : pruneProposedLibraryEntries(nextDraft);
}

/**
 * Turns an (unmatched) exercise into a "new" local Library proposal: a minimal
 * entry built from the exercise name plus `entry` (category, equipment,
 * muscles...). Nothing is written to the Library until the draft is saved.
 */
export function proposeNewLibraryExercise(draft, dayId, exerciseId, entry = {}) {
  const day = findDay(draft, dayId);
  const located = day ? findExercise(day, exerciseId) : null;

  if (!located) {
    return draft;
  }

  const name = cleanString(entry.name) || located.exercise.name;

  if (!name) {
    return draft;
  }

  const libraryEntry = createDraftLibraryExercise({ ...entry, name });
  const withEntry = upsertProposedLibraryEntry(draft, libraryEntry);
  return remapExercise(withEntry, dayId, exerciseId, libraryEntry.id);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isWellFormedWarmupItem(item) {
  return Boolean(
    item &&
      typeof item === "object" &&
      cleanString(item.id) &&
      (cleanString(item.name) || cleanString(item.prescription)) &&
      typeof (item.notes ?? "") === "string" &&
      typeof (item.videoUrl ?? "") === "string",
  );
}

/**
 * Validates a draft before save/apply. Returns { valid, errors: [{ path, message }] }.
 * Targets use the same rules as the strict share validator
 * (collectProgramExerciseTargetErrors); references must resolve (local Library,
 * draft.libraryExercises or built-in config) or be a "new" entry with a name.
 */
export function validateProgramDraft(draft) {
  const errors = [];
  const push = (path, message) => errors.push({ path, message });

  if (!draft || typeof draft !== "object") {
    return { valid: false, errors: [{ path: "", message: "The draft is missing." }] };
  }

  if (!cleanString(draft.program?.name)) {
    push("program.name", "Program name is required.");
  }

  const days = asArray(draft.days);

  if (!days.length) {
    push("days", "Add at least one day.");
  }

  const context = buildLibraryContext(draft);
  const seenDayIds = new Set();
  const seenSectionIds = new Set();
  const seenExerciseIds = new Set();
  const seenLibraryIds = new Set();

  asArray(draft.libraryExercises).forEach((entry, index) => {
    const path = `libraryExercises[${index}]`;

    if (!entry || typeof entry !== "object" || !cleanString(entry.id)) {
      push(path, "Proposed Library entry has no id.");
      return;
    }

    if (seenLibraryIds.has(String(entry.id))) {
      push(path, `Duplicate proposed Library id "${entry.id}".`);
    }

    seenLibraryIds.add(String(entry.id));

    if (!cleanString(entry.name)) {
      push(`${path}.name`, "Proposed Library entry needs a name.");
    }
  });

  days.forEach((day, dayIndex) => {
    const dayPath = `days[${dayIndex}]`;

    if (!day || typeof day !== "object") {
      push(dayPath, "Invalid day.");
      return;
    }

    if (!cleanString(day.id)) {
      push(`${dayPath}.id`, "Day has no id.");
    } else if (seenDayIds.has(day.id)) {
      push(`${dayPath}.id`, `Duplicate day id "${day.id}".`);
    }

    seenDayIds.add(day.id);

    if (!cleanString(day.name)) {
      push(`${dayPath}.name`, "Day name is required.");
    }

    if (!isNullish(day.warmup)) {
      if (typeof day.warmup !== "object" || !Array.isArray(day.warmup.items)) {
        push(`${dayPath}.warmup`, "Warm-up must be a list of instruction items.");
      } else {
        day.warmup.items.forEach((item, itemIndex) => {
          if (!isWellFormedWarmupItem(item)) {
            push(`${dayPath}.warmup.items[${itemIndex}]`, "Warm-up item needs an id and a name or prescription.");
          }
        });
      }
    }

    const sections = asArray(day.sections);

    if (!Array.isArray(day.sections)) {
      push(`${dayPath}.sections`, "Day has no sections.");
    }

    sections.forEach((section, sectionIndex) => {
      const sectionPath = `${dayPath}.sections[${sectionIndex}]`;

      if (!section || typeof section !== "object") {
        push(sectionPath, "Invalid section.");
        return;
      }

      if (!cleanString(section.id)) {
        push(`${sectionPath}.id`, "Section has no id.");
      } else if (seenSectionIds.has(section.id)) {
        push(`${sectionPath}.id`, `Duplicate section id "${section.id}".`);
      }

      seenSectionIds.add(section.id);

      if (!cleanString(section.name)) {
        push(`${sectionPath}.name`, "Section name is required.");
      }

      if (!Array.isArray(section.exercises)) {
        push(`${sectionPath}.exercises`, "Section has no exercise list.");
        return;
      }

      section.exercises.forEach((exercise, exerciseIndex) => {
        const path = `${sectionPath}.exercises[${exerciseIndex}]`;

        if (!exercise || typeof exercise !== "object") {
          push(path, "Invalid exercise.");
          return;
        }

        const label = cleanString(exercise.name) || `Exercise ${exerciseIndex + 1}`;

        if (!cleanString(exercise.id)) {
          push(`${path}.id`, `${label}: exercise has no id.`);
        } else if (seenExerciseIds.has(exercise.id)) {
          push(`${path}.id`, `${label}: duplicate exercise id "${exercise.id}".`);
        }

        seenExerciseIds.add(exercise.id);

        if (!DRAFT_LIBRARY_STATUSES.includes(exercise.libraryStatus)) {
          push(`${path}.libraryStatus`, `${label}: unknown library status.`);
        }

        if (exercise.libraryStatus === "new") {
          if (!cleanString(exercise.name)) {
            push(`${path}.name`, "A new exercise needs a name.");
          }

          const proposal =
            normalizeLibraryEntry(exercise.newLibraryExercise) ??
            (exercise.exerciseId ? context.proposed.get(String(exercise.exerciseId)) : null);

          if (!proposal) {
            push(`${path}.newLibraryExercise`, `${label}: new exercise has no Library entry to add.`);
          } else if (!cleanString(exercise.exerciseId)) {
            push(`${path}.exerciseId`, `${label}: new exercise has no Library id.`);
          } else if (String(exercise.exerciseId) !== proposal.id) {
            push(
              `${path}.exerciseId`,
              `${label}: new exercise id "${exercise.exerciseId}" does not match its Library entry "${proposal.id}".`,
            );
          }
        } else {
          const resolved = resolveLibraryId(context, exercise.exerciseId);

          if (!resolved.status) {
            push(
              `${path}.exerciseId`,
              `${label}: match it to a Library exercise or mark it as a new exercise.`,
            );
          } else if (resolved.status !== "library") {
            // The id exists only as a proposal of this draft: the writers add
            // a proposed entry for "new" exercises only, so a "library"
            // exercise pointing at it would be saved with a dangling id.
            push(
              `${path}.libraryStatus`,
              `${label}: "${exercise.exerciseId}" is not in the Library yet; mark it as a new exercise.`,
            );
          }
        }

        ["targetSets", "targetReps", "targetRPE", "restTime", "targetWeight"].forEach((field) => {
          collectProgramExerciseTargetErrors(exercise, [field]).forEach((message) => {
            push(`${path}.${field}`, `${label}: ${message}`);
          });
        });

        collectProgramExerciseProfileErrors(exercise).forEach((message) => {
          const field = /load type/.test(message)
            ? "loadType"
            : /weight mode/.test(message)
              ? "weightMode"
              : /measurement/.test(message)
                ? "measurement"
                : /per side/i.test(message)
                  ? "perSide"
                  : /source weight/i.test(message)
                    ? "sourceWeight"
                    : "profileOverrides";
          push(`${path}.${field}`, `${label}: ${message}`);
        });

        if (isNullish(exercise.loadType)) {
          push(`${path}.loadType`, `${label}: load type is required.`);
        }

        if (isNullish(exercise.weightMode)) {
          push(`${path}.weightMode`, `${label}: weight mode is required.`);
        }
      });
    });
  });

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Diff against the source program (review screen)
// ---------------------------------------------------------------------------

function emptyDiff(extra = {}) {
  return {
    ok: true,
    error: null,
    sourceProgramId: null,
    program: [],
    days: { added: [], removed: [], renamed: [], changed: [] },
    exercises: { added: [], removed: [], moved: [], changed: [] },
    ...extra,
  };
}

/**
 * A reps label that only repeats the numeric range ("8-12" on 8-12, "10" on
 * 10-10) carries no information: it compares equal to no label, so an AI echo
 * or a share round trip that adds it never counts as a prescription change.
 */
export function comparableTargetReps(value) {
  const reps = normalizeTargetReps(value, { min: null, max: null, label: null });

  if (reps.label !== null && reps.min !== null && reps.max !== null) {
    const derived = reps.min === reps.max ? String(reps.min) : `${reps.min}-${reps.max}`;

    if (reps.label.replace(/\s+/g, "") === derived) {
      return { ...reps, label: null };
    }
  }

  return reps;
}

const DAY_COMPARE_FIELDS = Object.freeze(["focus", "notes", "isOptional", "warmup"]);

function comparableDay(day) {
  const warmup = normalizeWarmup(day?.warmup);

  return {
    focus: cleanString(day?.focus),
    notes: cleanString(day?.notes),
    isOptional: Boolean(day?.isOptional),
    // Item ids are regenerated by every share round trip; the text is what
    // the user sees on the Workouts page.
    warmup: warmup
      ? {
          title: cleanString(warmup.title),
          items: warmup.items.map((item) => ({
            name: cleanString(item.name),
            prescription: cleanString(item.prescription),
            notes: cleanString(item.notes),
          })),
        }
      : null,
  };
}

function libraryNameLookup() {
  const local = new Map(readLocalLibrary().map((entry) => [String(entry.id), cleanString(entry.name)]));

  return (exerciseId) => {
    if (isNullish(exerciseId)) {
      return "";
    }

    return local.get(String(exerciseId)) || getBuiltInExerciseConfig(String(exerciseId))?.name || String(exerciseId);
  };
}

/**
 * Compares a draft with the stored program it edits (draft.sourceProgramId).
 * Returns {
 *   ok, error, sourceProgramId,
 *   program: [{ field, from, to }],
 *   days: { added: [{ id, name }], removed: [{ id, name }], renamed: [{ id, from, to }],
 *          changed: [{ id, name, fields: [{ field, from, to }] }] (focus, notes, isOptional, warmup) },
 *   exercises: {
 *     added: [{ id, name, dayId, replaces?: { id, name } }], removed: [{ id, name, dayId }],
 *     moved: [{ id, name, from: { dayId, sectionId, index }, to: { dayId, sectionId, index } }],
 *     changed: [{ id, name, fields: [{ field, from, to }], prescriptionChanged }],
 *   },
 * }
 * Exercises match by draft id === stored programExerciseId; legacy records
 * are compared through their derived measurement profile so an untouched
 * loadType never shows as changed. A draft exercise that keeps a stored id
 * but points at a different Library exercise is reported as removed + added
 * (`added[].replaces`), which is what applyProgramDraft does with it (H2-5).
 */
export function diffDraftAgainstProgram(draft, programId = draft?.sourceProgramId) {
  if (!programId) {
    return emptyDiff({ ok: false, error: "The draft does not edit an existing program." });
  }

  const program = getPrograms({ includeArchived: true }).find((entry) => entry.id === programId);

  if (!program) {
    return emptyDiff({ ok: false, error: "Program not found.", sourceProgramId: programId });
  }

  const nameOf = libraryNameLookup();
  const diff = emptyDiff({ sourceProgramId: programId });
  const draftProgram = normalizeDraftProgram(draft?.program);

  ["name", "nickname", "description", "goal"].forEach((field) => {
    const from = cleanString(program[field]);

    if (from !== draftProgram[field]) {
      diff.program.push({ field, from, to: draftProgram[field] });
    }
  });

  const storedDays = getProgramDays(programId);
  const storedDayById = new Map(storedDays.map((day) => [String(day.id), day]));
  const draftDays = asArray(draft?.days);
  const draftDayIds = new Set(draftDays.map((day) => String(day.id)));

  draftDays.forEach((day) => {
    const stored = storedDayById.get(String(day.id));

    if (!stored) {
      diff.days.added.push({ id: day.id, name: day.name });
      return;
    }

    if (cleanString(stored.name) !== cleanString(day.name)) {
      diff.days.renamed.push({ id: day.id, from: cleanString(stored.name), to: cleanString(day.name) });
    }

    const before = comparableDay(stored);
    const after = comparableDay(day);
    const fields = DAY_COMPARE_FIELDS.filter((field) => !isSameValue(before[field], after[field])).map((field) => ({
      field,
      from: before[field],
      to: after[field],
    }));

    if (fields.length) {
      diff.days.changed.push({ id: day.id, name: cleanString(day.name), fields });
    }
  });
  storedDays.forEach((day) => {
    if (!draftDayIds.has(String(day.id))) {
      diff.days.removed.push({ id: day.id, name: day.name });
    }
  });

  const storedExercises = new Map();
  const localLibrary = new Map(readLocalLibrary().map((entry) => [String(entry.id), entry]));

  storedDays.forEach((day) => {
    const sections = getProgramSections(day.id);
    const sectionIds = new Set(sections.map((section) => String(section.id)));
    const fallbackSectionId = sections[0]?.id ?? null;

    getProgramExercises(day.id).forEach((programExercise, index) => {
      const profile = resolveProgramExerciseLoadProfile(
        programExercise,
        localLibrary.get(String(programExercise.exerciseId)) ?? null,
      );

      storedExercises.set(String(programExercise.id), {
        record: programExercise,
        position: {
          dayId: day.id,
          sectionId: sectionIds.has(String(programExercise.sectionId)) ? programExercise.sectionId : fallbackSectionId,
          index,
        },
        comparable: {
          exerciseId: programExercise.exerciseId ?? null,
          targetSets: programExercise.targetSets ?? null,
          targetReps: comparableTargetReps(programExercise.targetReps),
          targetWeight: cleanWeight(programExercise.targetWeight),
          targetRPE: programExercise.targetRPE ?? null,
          restTime: programExercise.restTime ?? null,
          loadType: profile.loadType,
          weightMode: profile.weightMode,
          notes: cleanString(programExercise.notes),
          type: cleanString(programExercise.type) || DEFAULT_TARGETS.type,
          isOptional: Boolean(programExercise.isOptional),
          sourceWeight: cleanString(programExercise.sourceWeight) || null,
          ...comparableDraftProfile(programExercise),
        },
      });
    });
  });

  const seen = new Set();

  draftDays.forEach((day) => {
    let dayIndex = 0;

    asArray(day.sections).forEach((section) => {
      asArray(section.exercises).forEach((exercise) => {
        const position = { dayId: day.id, sectionId: section.id, index: dayIndex };
        dayIndex += 1;
        const stored = storedExercises.get(String(exercise.id));
        const label = cleanString(exercise.name) || nameOf(exercise.exerciseId);

        if (!stored) {
          diff.exercises.added.push({ id: exercise.id, name: label, dayId: day.id });
          return;
        }

        if (String(stored.record.exerciseId ?? "") !== String(exercise.exerciseId ?? "")) {
          // Library identity changed: the stored occurrence (and its history,
          // baseline and progression) is left behind and a new one is added.
          diff.exercises.added.push({
            id: exercise.id,
            name: label,
            dayId: day.id,
            replaces: { id: String(exercise.id), name: nameOf(stored.record.exerciseId) },
          });
          return;
        }

        seen.add(String(exercise.id));

        const comparable = {
          exerciseId: exercise.exerciseId ?? null,
          targetSets: exercise.targetSets ?? null,
          targetReps: comparableTargetReps(exercise.targetReps),
          targetWeight: cleanWeight(exercise.targetWeight),
          targetRPE: exercise.targetRPE ?? null,
          restTime: exercise.restTime ?? null,
          loadType: exercise.loadType ?? DEFAULT_LOAD_TYPE,
          weightMode: exercise.weightMode ?? DEFAULT_WEIGHT_MODE,
          notes: cleanString(exercise.notes),
          type: cleanString(exercise.type) || DEFAULT_TARGETS.type,
          isOptional: Boolean(exercise.isOptional),
          sourceWeight: cleanString(exercise.sourceWeight) || null,
          ...comparableDraftProfile(exercise),
        };
        const fields = DRAFT_EXERCISE_COMPARE_FIELDS.filter(
          (field) => !isSameValue(stored.comparable[field], comparable[field]),
        ).map((field) => ({ field, from: stored.comparable[field], to: comparable[field] }));

        if (fields.length) {
          diff.exercises.changed.push({
            id: exercise.id,
            name: label,
            fields,
            prescriptionChanged: fields.some((entry) => DRAFT_PRESCRIPTION_FIELDS.includes(entry.field)),
          });
        }

        if (!isSameValue(stored.position, position)) {
          diff.exercises.moved.push({ id: exercise.id, name: label, from: stored.position, to: position });
        }
      });
    });
  });

  storedExercises.forEach((stored, id) => {
    if (!seen.has(id)) {
      diff.exercises.removed.push({
        id,
        name: nameOf(stored.record.exerciseId),
        dayId: stored.position.dayId,
      });
    }
  });

  return diff;
}

/** Counts used by list views. */
export function summarizeProgramDraft(draft) {
  let exerciseCount = 0;
  let unresolvedCount = 0;
  let newCount = 0;

  forEachDraftExercise(draft, (exercise) => {
    exerciseCount += 1;

    if (exercise.libraryStatus === "unmatched") {
      unresolvedCount += 1;
    } else if (exercise.libraryStatus === "new") {
      newCount += 1;
    }
  });

  return {
    programName: cleanString(draft?.program?.name),
    dayCount: asArray(draft?.days).length,
    exerciseCount,
    unresolvedCount,
    newCount,
  };
}
