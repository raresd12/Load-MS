import { readStorage, STORAGE_KEYS } from "./storage.js";
import {
  normalizeWarmup,
  PROGRAM_SHARE_SCHEMA_VERSION,
  PROGRAM_SHARE_TYPE,
} from "./programStorage.js";

// The Gemini key is deliberately NOT part of STORAGE_KEYS: backups and program
// share files must never carry the user's API key.
export const GEMINI_API_KEY_STORAGE_KEY = "rpe-tracker.gemini-api-key.v1";

export const GEMINI_MODELS = ["gemini-3.5-flash", "gemini-2.5-flash"];
const GEMINI_ENDPOINT_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const EXTRACTION_TIMEOUT_MS = 120000;

const CATEGORY_VALUES = ["compound", "isolation", "athletic", "core"];
const EQUIPMENT_VALUES = ["barbell", "dumbbell", "cable", "machine", "smith", "bodyweight"];
const PROGRESSION_TYPE_VALUES = ["strength", "hypertrophy", "pump", "athletic", "core"];

export function getGeminiApiKey() {
  if (typeof window === "undefined") {
    return "";
  }

  try {
    return window.localStorage.getItem(GEMINI_API_KEY_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setGeminiApiKey(key) {
  if (typeof window === "undefined") {
    return { ok: false, error: "Local storage is not available." };
  }

  const cleanKey = String(key ?? "").trim();

  try {
    if (cleanKey) {
      window.localStorage.setItem(GEMINI_API_KEY_STORAGE_KEY, cleanKey);
    } else {
      window.localStorage.removeItem(GEMINI_API_KEY_STORAGE_KEY);
    }

    return { ok: true };
  } catch {
    return { ok: false, error: "Could not save the API key to local storage." };
  }
}

export function clearGeminiApiKey() {
  return setGeminiApiKey("");
}

// ---------------------------------------------------------------------------
// Source handling: pasted text, images, PDFs and plain text files.
// Files are only held in memory to build one extraction request; they are
// never written to localStorage, backups or program share files.
// ---------------------------------------------------------------------------

export const UNSUPPORTED_SOURCE_FALLBACK =
  "For now, copy/paste the content or export as PDF/text.";
export const MAX_SOURCE_TEXT_CHARS = 80000;

const MAX_IMAGE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PDF_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 1024 * 1024;

const IMAGE_MIME_BY_EXTENSION = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const SUPPORTED_INLINE_MIME_TYPES = new Set([...SUPPORTED_IMAGE_MIME_TYPES, "application/pdf"]);
const TEXT_FILE_EXTENSIONS = new Set(["txt", "md", "csv"]);
const OFFICE_FILE_EXTENSIONS = new Set([
  "doc",
  "docx",
  "xls",
  "xlsx",
  "odt",
  "ods",
  "rtf",
  "pages",
  "numbers",
]);

function getFileExtension(fileName) {
  const name = String(fileName ?? "").toLowerCase();
  const dotIndex = name.lastIndexOf(".");
  return dotIndex >= 0 ? name.slice(dotIndex + 1) : "";
}

function formatMegabytes(bytes) {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function classifySourceFile(fileName, mimeType, sizeBytes) {
  const extension = getFileExtension(fileName);
  const cleanMime = String(mimeType ?? "").toLowerCase();
  const size = Number(sizeBytes) || 0;

  if (OFFICE_FILE_EXTENSIONS.has(extension)) {
    return {
      ok: false,
      error: `Word/Excel documents are not supported yet. ${UNSUPPORTED_SOURCE_FALLBACK}`,
    };
  }

  const imageMime =
    IMAGE_MIME_BY_EXTENSION[extension] ?? (cleanMime.startsWith("image/") ? cleanMime : "");

  if (imageMime) {
    if (!SUPPORTED_IMAGE_MIME_TYPES.has(imageMime)) {
      return {
        ok: false,
        error: `Only JPG, PNG and WebP images are supported. ${UNSUPPORTED_SOURCE_FALLBACK}`,
      };
    }

    if (size <= 0) {
      return { ok: false, error: "The selected file is empty." };
    }

    if (size > MAX_IMAGE_FILE_BYTES) {
      return {
        ok: false,
        error: `The image is too large (max ${formatMegabytes(MAX_IMAGE_FILE_BYTES)}). Crop or resize it and try again.`,
      };
    }

    return { ok: true, kind: "image", mimeType: imageMime };
  }

  if (extension === "pdf" || cleanMime === "application/pdf") {
    if (size <= 0) {
      return { ok: false, error: "The selected file is empty." };
    }

    if (size > MAX_PDF_FILE_BYTES) {
      return {
        ok: false,
        error: `The PDF is too large (max ${formatMegabytes(MAX_PDF_FILE_BYTES)}). Export only the program pages and try again.`,
      };
    }

    return { ok: true, kind: "pdf", mimeType: "application/pdf" };
  }

  if (TEXT_FILE_EXTENSIONS.has(extension) || cleanMime.startsWith("text/")) {
    if (size <= 0) {
      return { ok: false, error: "The selected file is empty." };
    }

    if (size > MAX_TEXT_FILE_BYTES) {
      return {
        ok: false,
        error: `The text file is too large (max ${formatMegabytes(MAX_TEXT_FILE_BYTES)}). Paste only the program part instead.`,
      };
    }

    return { ok: true, kind: "text", mimeType: "text/plain" };
  }

  return {
    ok: false,
    error: `This file type is not supported. ${UNSUPPORTED_SOURCE_FALLBACK}`,
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clampNumber(value, min, max, fallback) {
  // Number(null) and Number("") coerce to 0; use the fallback instead.
  if (value === null || value === undefined || value === "" || typeof value === "boolean") {
    return fallback;
  }

  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, numeric));
}

function clampInteger(value, min, max, fallback) {
  const clamped = clampNumber(value, min, max, fallback);
  return Math.round(clamped);
}

function isMissingNumericValue(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") {
    return true;
  }

  return !Number.isFinite(Number(value));
}

function slugifyExerciseName(name) {
  return (
    String(name ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "exercise"
  );
}

export function getLibraryCatalog() {
  return asArray(readStorage(STORAGE_KEYS.exerciseLibrary, [])).filter(
    (exercise) => exercise && exercise.id && exercise.name,
  );
}

function formatCatalogLine(exercise) {
  const muscles = asArray(exercise.mainMuscles).join("/") || "general";
  return `${exercise.id} | ${exercise.name} | ${exercise.equipment ?? "machine"} | ${muscles} | ${exercise.category ?? "compound"}`;
}

const SOURCE_KIND_DESCRIPTIONS = {
  text: "The program source is pasted text, provided between SOURCE TEXT START and SOURCE TEXT END in the next message part.",
  image:
    "The program source is the attached image (a photo or screenshot of a workout plan). Read all visible text carefully, including tables and handwriting.",
  pdf: "The program source is the attached PDF document. Read every page that contains the program.",
};

export function buildProgramExtractionPrompt(catalog, sourceKind) {
  const catalogLines = catalog.map(formatCatalogLine).join("\n");

  return [
    "You are a careful transcription assistant for the RPE Tracker app. Convert an existing workout program source into structured JSON so the user can review it as an editable draft.",
    "",
    "SOURCE",
    SOURCE_KIND_DESCRIPTIONS[sourceKind] ?? SOURCE_KIND_DESCRIPTIONS.text,
    "",
    "EXERCISE CATALOG (id | name | equipment | main muscles | category)",
    catalogLines,
    "",
    "STRICT EXTRACTION RULES",
    "1. Extract ONLY what the source actually contains. You are transcribing, not coaching: do not add, remove, reorder or improve days, exercises or warm-ups.",
    "2. Preserve exercise names as written in the source. You may fix obvious OCR artifacts, but never rename, translate or substitute exercises.",
    "3. Catalog matching: when a source exercise clearly refers to a catalog entry, copy that exerciseId EXACTLY and set isNew to false. When you are not confident about the match, set exerciseId to an empty string and isNew to true. Never guess or fabricate an id.",
    "4. Warm-up: fill day.warmup ONLY when the source explicitly lists warm-up, activation or mobility work for that day. If the source has no warm-up, leave warmup null. NEVER invent warm-up items. Warm-up items belong only in day.warmup.items and must never appear in day.exercises.",
    '5. Numbers: copy sets, reps, target RPE and rest seconds from the source. When a value is not stated or is unclear, use null - do not invent numbers. "3x8-12" means sets 3, repsMin 8, repsMax 12; a single rep number means repsMin equals repsMax.',
    "6. Weights: NEVER output starting weights or loads anywhere, even if the source lists them. The app computes loads itself.",
    "7. progressionType classifies the exercise itself: strength, hypertrophy, pump, athletic or core. Pick the closest; use hypertrophy when unsure. This is the only field you may infer.",
    '8. Program name: use the source\'s own title. If it has none, use a short factual title such as "Imported 3-Day Split". Leave nickname, description and goal empty unless the source states them.',
    '9. Day names: use the source\'s day labels; if a day is unlabeled, use "Day 1", "Day 2", ... in source order.',
    "10. If the source is not a workout program, return an empty days array.",
  ].join("\n");
}

export function buildExtractionRequestParts(prompt, source) {
  if (source.kind === "text") {
    return [
      { text: prompt },
      { text: `SOURCE TEXT START\n${String(source.text ?? "")}\nSOURCE TEXT END` },
    ];
  }

  return [
    { text: prompt },
    { inline_data: { mime_type: source.mimeType, data: source.dataBase64 } },
  ];
}

export const AI_PROGRAM_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    nickname: { type: "string" },
    description: { type: "string" },
    goal: { type: "string" },
    days: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          focus: { type: "string" },
          notes: { type: "string" },
          warmup: {
            type: "object",
            nullable: true,
            properties: {
              title: { type: "string" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    prescription: { type: "string" },
                    notes: { type: "string" },
                    videoUrl: { type: "string" },
                  },
                  required: ["name"],
                },
              },
            },
            required: ["items"],
          },
          exercises: {
            type: "array",
            items: {
              type: "object",
              properties: {
                exerciseId: { type: "string" },
                name: { type: "string" },
                isNew: { type: "boolean" },
                category: { type: "string", enum: CATEGORY_VALUES },
                equipment: { type: "string", enum: EQUIPMENT_VALUES },
                mainMuscles: { type: "array", items: { type: "string" } },
                progressionType: { type: "string", enum: PROGRESSION_TYPE_VALUES },
                sets: { type: "integer", nullable: true },
                repsMin: { type: "integer", nullable: true },
                repsMax: { type: "integer", nullable: true },
                targetRPE: { type: "number", nullable: true },
                restSeconds: { type: "integer", nullable: true },
                notes: { type: "string" },
              },
              required: [
                "exerciseId",
                "name",
                "isNew",
                "sets",
                "repsMin",
                "repsMax",
                "targetRPE",
                "restSeconds",
                "progressionType",
              ],
            },
          },
        },
        required: ["name", "exercises"],
      },
    },
  },
  required: ["name", "days"],
};

function getRepsLabel(repsMin, repsMax) {
  return repsMin === repsMax ? String(repsMin) : `${repsMin}-${repsMax}`;
}

function normalizeExerciseName(name) {
  return String(name ?? "").trim().toLowerCase();
}

function normalizeAiExercise(exercise, context) {
  if (!exercise || typeof exercise !== "object") {
    return null;
  }

  const { libraryById, libraryByName, newExercisesByName, usedNewIds } = context;
  const requestedId = String(exercise.exerciseId ?? "").trim();
  let libraryExercise = requestedId ? libraryById.get(requestedId) : null;
  const name = String(exercise.name ?? "").trim() || libraryExercise?.name || "";

  if (!name) {
    return null;
  }

  const normalizedName = normalizeExerciseName(name);

  // The AI sometimes marks an exercise as new even though it already exists
  // locally under the same name. Reuse the library entry instead of duplicating it.
  if (!libraryExercise) {
    libraryExercise = libraryByName.get(normalizedName) ?? null;
  }

  let exerciseId = libraryExercise ? libraryExercise.id : "";
  let newLibraryExercise = null;

  if (!libraryExercise) {
    // Reuse an exercise already created earlier in this same draft so
    // "Nordic Curl" on two days maps to one library entry, not two.
    const alreadyCreated = newExercisesByName.get(normalizedName);

    if (alreadyCreated) {
      exerciseId = alreadyCreated.id;
    } else {
      const baseId = `ai-${slugifyExerciseName(name)}`;
      exerciseId = baseId;
      let suffix = 2;

      while (libraryById.has(exerciseId) || usedNewIds.has(exerciseId)) {
        exerciseId = `${baseId}-${suffix}`;
        suffix += 1;
      }

      usedNewIds.add(exerciseId);

      const mainMuscles = asArray(exercise.mainMuscles)
        .map((muscle) => String(muscle ?? "").trim())
        .filter(Boolean);

      // A source exercise unknown to the library becomes a minimal private
      // entry: technical/coaching fields stay empty, nothing is invented.
      newLibraryExercise = {
        id: exerciseId,
        name,
        category: CATEGORY_VALUES.includes(exercise.category) ? exercise.category : "compound",
        mainMuscles,
        secondaryMuscles: [],
        equipment: EQUIPMENT_VALUES.includes(exercise.equipment) ? exercise.equipment : "machine",
        difficulty: "intermediate",
        goalTags: ["ai-generated"],
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
      newExercisesByName.set(normalizedName, newLibraryExercise);
    }
  }

  // Track which fields the source did not state: they get safe defaults in
  // the draft and are flagged in the preview instead of silently invented.
  const missingFields = [];

  if (isMissingNumericValue(exercise.sets)) {
    missingFields.push("sets");
  }

  if (isMissingNumericValue(exercise.repsMin) || isMissingNumericValue(exercise.repsMax)) {
    missingFields.push("reps");
  }

  if (isMissingNumericValue(exercise.targetRPE)) {
    missingFields.push("target RPE");
  }

  if (isMissingNumericValue(exercise.restSeconds)) {
    missingFields.push("rest");
  }

  const repsMin = clampInteger(exercise.repsMin, 1, 30, 8);
  const repsMax = clampInteger(exercise.repsMax, repsMin, 30, Math.max(repsMin, 10));
  const targetRPE = Math.round(clampNumber(exercise.targetRPE, 5, 10, 8) * 2) / 2;

  return {
    exerciseId,
    name,
    matchedLibrary: Boolean(libraryExercise),
    missingFields,
    newLibraryExercise,
    targetSets: clampInteger(exercise.sets, 1, 8, 3),
    targetReps: { min: repsMin, max: repsMax, label: getRepsLabel(repsMin, repsMax) },
    targetRPE,
    restTime: clampInteger(exercise.restSeconds, 30, 420, 120),
    notes: String(exercise.notes ?? "").trim(),
    type: PROGRESSION_TYPE_VALUES.includes(exercise.progressionType)
      ? exercise.progressionType
      : "hypertrophy",
  };
}

export function convertAiProgramToShare(aiProgram, catalog, nowIsoString) {
  if (!aiProgram || typeof aiProgram !== "object") {
    return { valid: false, error: "The AI response was empty." };
  }

  const libraryById = new Map(asArray(catalog).map((exercise) => [exercise.id, exercise]));
  const libraryByName = new Map(
    asArray(catalog).map((exercise) => [normalizeExerciseName(exercise.name), exercise]),
  );
  const conversionContext = {
    libraryById,
    libraryByName,
    newExercisesByName: new Map(),
    usedNewIds: new Set(),
  };
  const programName = String(aiProgram.name ?? "").trim() || "Imported Program Draft";
  const shareProgramId = "ai-generated";
  const days = [];
  const sections = [];
  const programExercises = [];
  const newLibraryExercises = [];
  const previewDays = [];
  let reusedExerciseCount = 0;
  let warmupItemCount = 0;

  asArray(aiProgram.days).forEach((day, dayIndex) => {
    if (!day || typeof day !== "object") {
      return;
    }

    const dayId = `ai-day-${dayIndex + 1}`;
    const sectionId = `${shareProgramId}:${dayId}:main`;
    const dayExercises = asArray(day.exercises)
      .map((exercise) => normalizeAiExercise(exercise, conversionContext))
      .filter(Boolean);

    if (!dayExercises.length) {
      return;
    }

    // Warm-up from the source stays informational on the day: it never becomes
    // library entries, program exercises or logged sets, and carries no RPE.
    const warmup = normalizeWarmup(day.warmup);
    const programDay = {
      id: dayId,
      programId: shareProgramId,
      name: String(day.name ?? "").trim() || `Day ${dayIndex + 1}`,
      focus: String(day.focus ?? "").trim(),
      orderIndex: days.length,
      ...(String(day.notes ?? "").trim() ? { notes: String(day.notes).trim() } : {}),
      ...(warmup ? { warmup } : {}),
    };

    if (warmup) {
      warmupItemCount += warmup.items.length;
    }

    days.push(programDay);
    sections.push({
      id: sectionId,
      programId: shareProgramId,
      dayId,
      name: "Main Work",
      orderIndex: 0,
    });

    dayExercises.forEach((exercise, exerciseIndex) => {
      if (exercise.newLibraryExercise) {
        newLibraryExercises.push(exercise.newLibraryExercise);
      }

      if (libraryById.has(exercise.exerciseId)) {
        reusedExerciseCount += 1;
      }

      programExercises.push({
        id: `${shareProgramId}:${dayId}:${exerciseIndex + 1}-${exercise.exerciseId}`,
        programId: shareProgramId,
        dayId,
        sectionId,
        exerciseId: exercise.exerciseId,
        orderIndex: exerciseIndex,
        targetSets: exercise.targetSets,
        targetReps: exercise.targetReps,
        targetWeight: null,
        targetRPE: exercise.targetRPE,
        restTime: exercise.restTime,
        notes: exercise.notes,
        type: exercise.type,
        isOptional: false,
      });
    });

    previewDays.push({
      id: dayId,
      name: programDay.name,
      focus: programDay.focus,
      notes: programDay.notes ?? "",
      warmup,
      exercises: dayExercises.map((exercise) => ({
        name: exercise.name,
        exerciseId: exercise.exerciseId,
        matchedLibrary: exercise.matchedLibrary,
        isNewExercise: !exercise.matchedLibrary,
        targetSets: exercise.targetSets,
        repsLabel: exercise.targetReps.label,
        targetRPE: exercise.targetRPE,
        restTime: exercise.restTime,
        notes: exercise.notes,
        missingFields: exercise.missingFields,
      })),
    });
  });

  if (!days.length || !programExercises.length) {
    return {
      valid: false,
      error:
        "No training days could be read from this source. Check that it contains a workout program with exercises, then try again.",
    };
  }

  const share = {
    app: "rpe-workout-tracker",
    type: PROGRAM_SHARE_TYPE,
    schemaVersion: PROGRAM_SHARE_SCHEMA_VERSION,
    exportedAt: nowIsoString ?? new Date().toISOString(),
    source: "ai-generated",
    program: {
      name: programName,
      nickname: String(aiProgram.nickname ?? "").trim() || programName,
      description: String(aiProgram.description ?? "").trim(),
      goal: String(aiProgram.goal ?? "").trim(),
    },
    days,
    sections,
    programExercises,
    libraryExercises: newLibraryExercises,
  };

  return {
    valid: true,
    share,
    preview: {
      programName,
      description: share.program.description,
      goal: share.program.goal,
      days: previewDays,
    },
    summary: {
      dayCount: days.length,
      exerciseCount: programExercises.length,
      reusedExerciseCount,
      newExerciseCount: newLibraryExercises.length,
      warmupDayCount: days.filter((day) => day.warmup).length,
      warmupItemCount,
      missingFieldCount: previewDays.reduce(
        (total, day) =>
          total + day.exercises.reduce((dayTotal, exercise) => dayTotal + exercise.missingFields.length, 0),
        0,
      ),
    },
  };
}

export function mapGeminiError(status, apiMessage) {
  if (status === 400 && /api key/i.test(apiMessage ?? "")) {
    return "The API key was rejected. Check that you pasted the full key from Google AI Studio.";
  }

  if (status === 400) {
    return `Google rejected the request: ${apiMessage || "invalid request"}.`;
  }

  if (status === 401 || status === 403) {
    return "The API key is invalid or restricted. Create a key in Google AI Studio and paste it again.";
  }

  if (status === 404) {
    return "The Gemini model is not available for this key. Try again later.";
  }

  if (status === 429) {
    return "The free Gemini quota is used up for now. Wait a minute and retry - the daily limit resets around 10:00 in Romania.";
  }

  if (status >= 500) {
    return "Google's AI service is having trouble right now. Try again in a few minutes.";
  }

  return apiMessage || "The AI request failed. Try again.";
}

async function callGeminiModel(model, apiKey, parts, signal) {
  const response = await fetch(`${GEMINI_ENDPOINT_BASE}/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
        responseSchema: AI_PROGRAM_RESPONSE_SCHEMA,
      },
    }),
    signal,
  });

  let payload = null;

  try {
    payload = await response.json();
  } catch (error) {
    // Let the timeout abort surface as a timeout, not as an empty response.
    if (error?.name === "AbortError") {
      throw error;
    }

    payload = null;
  }

  return { response, payload };
}

function validateExtractionSource(source) {
  if (!source || typeof source !== "object") {
    return "Provide a program source first.";
  }

  if (source.kind === "text") {
    const text = String(source.text ?? "").trim();

    if (!text) {
      return "Paste the program text first.";
    }

    if (text.length > MAX_SOURCE_TEXT_CHARS) {
      return `The pasted text is too long (over ${MAX_SOURCE_TEXT_CHARS.toLocaleString()} characters). Split it into smaller parts.`;
    }

    return "";
  }

  if (source.kind === "image" || source.kind === "pdf") {
    if (!SUPPORTED_INLINE_MIME_TYPES.has(source.mimeType)) {
      return `This file type is not supported. ${UNSUPPORTED_SOURCE_FALLBACK}`;
    }

    if (!String(source.dataBase64 ?? "").trim()) {
      return "The file could not be read. Try selecting it again.";
    }

    return "";
  }

  return `This source type is not supported. ${UNSUPPORTED_SOURCE_FALLBACK}`;
}

// Turns a user-provided source (pasted text, image, PDF or text file content)
// into a reviewable program draft. Nothing is saved here: the caller shows the
// preview and only imports the returned share after the user approves it.
export async function extractProgramDraftWithAi(source) {
  const apiKey = getGeminiApiKey();

  if (!apiKey) {
    return { valid: false, error: "Save your Gemini API key first." };
  }

  const sourceError = validateExtractionSource(source);

  if (sourceError) {
    return { valid: false, error: sourceError };
  }

  const catalog = getLibraryCatalog();
  const prompt = buildProgramExtractionPrompt(catalog, source.kind === "text" ? "text" : source.kind);
  const parts = buildExtractionRequestParts(prompt, source);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS);

  try {
    let lastError = "The AI request failed. Try again.";

    for (const model of GEMINI_MODELS) {
      let result;

      try {
        result = await callGeminiModel(model, apiKey, parts, controller.signal);
      } catch (error) {
        if (error?.name === "AbortError") {
          return { valid: false, error: "The AI request timed out. Try again." };
        }

        return {
          valid: false,
          error: "Could not reach Google's AI service. Check your internet connection.",
        };
      }

      const { response, payload } = result;

      if (!response.ok) {
        lastError = mapGeminiError(response.status, payload?.error?.message);

        // Model missing, per-model quota exhausted, or Google-side trouble:
        // the fallback model may still work, so try it before giving up.
        if (response.status === 404 || response.status === 429 || response.status >= 500) {
          continue;
        }

        return { valid: false, error: lastError };
      }

      if (payload?.promptFeedback?.blockReason) {
        return {
          valid: false,
          error: "The AI declined to process this source. Remove sensitive content or try a different file.",
        };
      }

      const candidate = payload?.candidates?.[0];
      const finishReason = candidate?.finishReason;

      if (finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT") {
        return {
          valid: false,
          error: "The AI declined to process this source. Remove sensitive content or try a different file.",
        };
      }

      if (finishReason === "MAX_TOKENS") {
        return {
          valid: false,
          error: "The AI response was cut off before it finished. Try a shorter source or split it into parts.",
        };
      }

      const text = candidate?.content?.parts
        ?.map((part) => part?.text ?? "")
        .join("")
        .trim();

      if (!text) {
        return { valid: false, error: "The AI returned an empty response. Try again." };
      }

      let aiProgram;

      try {
        aiProgram = JSON.parse(text);
      } catch {
        return {
          valid: false,
          error: "The AI response could not be read as a program draft. Try again.",
        };
      }

      const converted = convertAiProgramToShare(aiProgram, catalog);

      if (converted.valid) {
        converted.model = model;
      }

      return converted;
    }

    return { valid: false, error: lastError };
  } finally {
    clearTimeout(timeoutId);
  }
}
