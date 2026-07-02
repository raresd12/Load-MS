import { readStorage, STORAGE_KEYS } from "./storage.js";
import { PROGRAM_SHARE_SCHEMA_VERSION, PROGRAM_SHARE_TYPE } from "./programStorage.js";

// The Gemini key is deliberately NOT part of STORAGE_KEYS: backups and program
// share files must never carry the user's API key.
export const GEMINI_API_KEY_STORAGE_KEY = "rpe-tracker.gemini-api-key.v1";

export const GEMINI_MODELS = ["gemini-3.5-flash", "gemini-2.5-flash"];
const GEMINI_ENDPOINT_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GENERATION_TIMEOUT_MS = 90000;

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

export function buildProgramGenerationPrompt(request, catalog) {
  const constraints = String(request.constraints ?? "").trim();
  const catalogLines = catalog.map(formatCatalogLine).join("\n");

  return [
    "You are a strength & conditioning coach building a weekly training program for the RPE Tracker app.",
    "",
    "USER REQUEST",
    `- Main goal: ${String(request.goal ?? "").trim() || "General fitness"}`,
    `- Training days per week: ${request.daysPerWeek}`,
    `- Time per session: about ${request.sessionMinutes} minutes`,
    `- Experience level: ${request.experience}`,
    `- Available equipment: ${request.equipment}`,
    constraints ? `- Constraints, injuries, preferences: ${constraints}` : "- Constraints: none mentioned",
    "",
    "EXERCISE CATALOG (id | name | equipment | main muscles | category)",
    catalogLines,
    "",
    "RULES",
    `1. Create exactly ${request.daysPerWeek} training days. Give each day a short name (like "Day 1 - Upper Push") and a focus line.`,
    "2. STRONGLY prefer exercises from the catalog above: copy their exerciseId exactly and set isNew to false.",
    "3. Only invent a new exercise when nothing in the catalog fits. Then set isNew to true, exerciseId to an empty string, and fill name, category, equipment and mainMuscles.",
    "4. Only use equipment the user actually has.",
    "5. Per training day: 4-7 exercises for 60+ minute sessions, 3-5 for shorter sessions. Compounds first, isolation later.",
    "6. sets 1-6, repsMin <= repsMax (between 1 and 30), targetRPE between 6 and 9.5, restSeconds between 45 and 300 (compounds rest longer).",
    "7. Match volume and intensity to the experience level. Beginners: fewer sets, RPE 6.5-8, simpler exercise selection.",
    "8. If the user mentions injuries or pain, avoid exercises that load those areas and mention the safer swap in the exercise notes.",
    "9. Keep notes short and practical. Do not prescribe starting weights.",
    "10. Fill program name (descriptive), nickname (2-3 words), goal (one line) and description (2-3 sentences).",
  ].join("\n");
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
                sets: { type: "integer" },
                repsMin: { type: "integer" },
                repsMax: { type: "integer" },
                targetRPE: { type: "number" },
                restSeconds: { type: "integer" },
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
        required: ["name", "focus", "exercises"],
      },
    },
  },
  required: ["name", "nickname", "description", "goal", "days"],
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

  // The AI sometimes re-invents an exercise that already exists locally under
  // the same name. Reuse the library entry instead of duplicating it.
  if (!libraryExercise) {
    libraryExercise = libraryByName.get(normalizedName) ?? null;
  }

  let exerciseId = libraryExercise ? libraryExercise.id : "";
  let newLibraryExercise = null;

  if (!libraryExercise) {
    // Reuse an exercise already invented earlier in this same generation so
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

  const repsMin = clampInteger(exercise.repsMin, 1, 30, 8);
  const repsMax = clampInteger(exercise.repsMax, repsMin, 30, Math.max(repsMin, 10));
  const targetRPE = Math.round(clampNumber(exercise.targetRPE, 5, 10, 8) * 2) / 2;

  return {
    exerciseId,
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
  const programName = String(aiProgram.name ?? "").trim() || "AI Generated Program";
  const shareProgramId = "ai-generated";
  const days = [];
  const sections = [];
  const programExercises = [];
  const newLibraryExercises = [];
  let reusedExerciseCount = 0;

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

    days.push({
      id: dayId,
      programId: shareProgramId,
      name: String(day.name ?? "").trim() || `Day ${dayIndex + 1}`,
      focus: String(day.focus ?? "").trim(),
      orderIndex: days.length,
      ...(String(day.notes ?? "").trim() ? { notes: String(day.notes).trim() } : {}),
    });
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
  });

  if (!days.length || !programExercises.length) {
    return {
      valid: false,
      error: "The AI response did not contain any usable training days. Try generating again.",
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
    summary: {
      dayCount: days.length,
      exerciseCount: programExercises.length,
      reusedExerciseCount,
      newExerciseCount: newLibraryExercises.length,
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

async function callGeminiModel(model, apiKey, prompt, signal) {
  const response = await fetch(`${GEMINI_ENDPOINT_BASE}/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.6,
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

export async function generateProgramWithAi(request) {
  const apiKey = getGeminiApiKey();

  if (!apiKey) {
    return { valid: false, error: "Save your Gemini API key first." };
  }

  const catalog = getLibraryCatalog();
  const prompt = buildProgramGenerationPrompt(request, catalog);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);

  try {
    let lastError = "The AI request failed. Try again.";

    for (const model of GEMINI_MODELS) {
      let result;

      try {
        result = await callGeminiModel(model, apiKey, prompt, controller.signal);
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
          error: "The AI declined this request. Reword your goal or constraints and try again.",
        };
      }

      const candidate = payload?.candidates?.[0];
      const finishReason = candidate?.finishReason;

      if (finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT") {
        return {
          valid: false,
          error: "The AI declined this request. Reword your goal or constraints and try again.",
        };
      }

      if (finishReason === "MAX_TOKENS") {
        return {
          valid: false,
          error: "The AI response was cut off before it finished. Try fewer training days or a shorter goal description.",
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
          error: "The AI response could not be read as a program. Try generating again.",
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
