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

const {
  buildProgramGenerationPrompt,
  convertAiProgramToShare,
  GEMINI_API_KEY_STORAGE_KEY,
  getGeminiApiKey,
  getLibraryCatalog,
  mapGeminiError,
  setGeminiApiKey,
} = await import("../src/lib/aiProgram.js");
const {
  importProgramShare,
  seedDefaultProgramIfNeeded,
  validateProgramShare,
} = await import("../src/lib/programStorage.js");
const { getTrackedStorageKeys } = await import("../src/lib/storage.js");

seedDefaultProgramIfNeeded();

// --- API key storage ---
assert.equal(getGeminiApiKey(), "", "no key saved initially");
assert.equal(setGeminiApiKey("  test-key-123  ").ok, true);
assert.equal(getGeminiApiKey(), "test-key-123", "key is trimmed and saved");
assert.ok(
  !getTrackedStorageKeys().includes(GEMINI_API_KEY_STORAGE_KEY),
  "API key must never be part of backup/tracked storage keys",
);
assert.equal(setGeminiApiKey("").ok, true);
assert.equal(getGeminiApiKey(), "", "empty save removes the key");

// --- Prompt building ---
const catalog = getLibraryCatalog();
assert.ok(catalog.length >= 20, "seeded library provides a catalog");

const prompt = buildProgramGenerationPrompt(
  {
    goal: "Build muscle for basketball",
    daysPerWeek: 3,
    sessionMinutes: 60,
    experience: "intermediate",
    equipment: "Full gym",
    constraints: "Knee pain on deep squats",
  },
  catalog,
);
assert.ok(prompt.includes("Build muscle for basketball"));
assert.ok(prompt.includes("Knee pain on deep squats"));
assert.ok(prompt.includes(catalog[0].id), "prompt lists catalog exercise ids");

// --- Conversion: happy path with reused + new exercises ---
const knownExercise = catalog[0];
const aiProgram = {
  name: "AI Basketball Builder",
  nickname: "Ball Builder",
  description: "Three day program.",
  goal: "Muscle and athleticism",
  days: [
    {
      name: "Day 1 - Upper",
      focus: "Push strength",
      notes: "Start with the compound.",
      exercises: [
        {
          exerciseId: knownExercise.id,
          name: knownExercise.name,
          isNew: false,
          sets: 4,
          repsMin: 5,
          repsMax: 8,
          targetRPE: 8,
          restSeconds: 180,
          progressionType: "strength",
          notes: "Controlled reps.",
        },
        {
          exerciseId: "",
          name: "Banded Face Pull",
          isNew: true,
          category: "isolation",
          equipment: "cable",
          mainMuscles: ["rear delts"],
          sets: 3,
          repsMin: 12,
          repsMax: 15,
          targetRPE: 7.5,
          restSeconds: 90,
          progressionType: "pump",
        },
      ],
    },
    {
      name: "Day 2 - Lower",
      focus: "Legs",
      exercises: [
        {
          // Hallucinated id must be converted into a new exercise, never a dangling reference.
          exerciseId: "not-a-real-library-id",
          name: "Leg Press Machine",
          isNew: false,
          sets: 99,
          repsMin: 40,
          repsMax: 2,
          targetRPE: 23,
          restSeconds: 5,
          progressionType: "not-a-type",
        },
      ],
    },
    {
      name: "Empty day is dropped",
      focus: "Nothing",
      exercises: [],
    },
  ],
};

const converted = convertAiProgramToShare(aiProgram, catalog, "2026-07-03T00:00:00.000Z");
assert.equal(converted.valid, true);
assert.equal(validateProgramShare(converted.share).valid, true, "share passes app validation");
assert.equal(converted.summary.dayCount, 2, "empty day dropped");
assert.equal(converted.summary.exerciseCount, 3);
assert.equal(converted.summary.reusedExerciseCount, 1);
assert.equal(converted.summary.newExerciseCount, 2, "hallucinated id becomes a new exercise");

const knownEntry = converted.share.programExercises.find(
  (exercise) => exercise.exerciseId === knownExercise.id,
);
assert.ok(knownEntry, "known library exercise keeps its id");
assert.equal(knownEntry.targetReps.label, "5-8");
assert.equal(knownEntry.targetWeight, null, "no starting weights from AI");

const clampedEntry = converted.share.programExercises.find((exercise) =>
  exercise.exerciseId.startsWith("ai-leg-press-machine"),
);
assert.ok(clampedEntry, "unknown id was re-slugged");
assert.ok(clampedEntry.targetSets <= 8, "sets clamped");
assert.ok(clampedEntry.targetReps.min <= clampedEntry.targetReps.max, "reps ordered");
assert.ok(clampedEntry.targetRPE <= 10, "RPE clamped");
assert.ok(clampedEntry.restTime >= 30, "rest clamped");
assert.equal(clampedEntry.type, "hypertrophy", "invalid progression type falls back");

assert.ok(
  converted.share.libraryExercises.every((exercise) => exercise.id.startsWith("ai-")),
  "only new exercises ship in the share library",
);

// The generated share must import cleanly through the existing mechanism.
const importResult = importProgramShare(JSON.parse(JSON.stringify(converted.share)));
assert.equal(importResult.valid, true, "AI share imports through the normal pipeline");
assert.equal(importResult.importedDayCount, 2);
assert.equal(importResult.importedExerciseCount, 3);
assert.equal(importResult.addedLibraryExerciseCount, 2);

// --- Conversion: invalid inputs ---
assert.equal(convertAiProgramToShare(null, catalog).valid, false);
assert.equal(convertAiProgramToShare({ days: [] }, catalog).valid, false);
assert.equal(
  convertAiProgramToShare({ name: "X", days: [{ name: "D", exercises: [] }] }, catalog).valid,
  false,
  "program with only empty days is rejected",
);

// --- The same invented exercise on two days maps to ONE library entry ---
const repeatedInvention = convertAiProgramToShare(
  {
    name: "Dedup Test",
    days: [1, 2].map((dayNumber) => ({
      name: `Day ${dayNumber}`,
      focus: "Test",
      exercises: [
        {
          exerciseId: "",
          name: "Nordic Curl",
          isNew: true,
          sets: 3,
          repsMin: 6,
          repsMax: 10,
          targetRPE: 8,
          restSeconds: 120,
          progressionType: "hypertrophy",
        },
      ],
    })),
  },
  catalog,
);
assert.equal(repeatedInvention.valid, true);
assert.equal(
  repeatedInvention.share.libraryExercises.length,
  1,
  "same invented name creates a single library entry",
);
const nordicIds = repeatedInvention.share.programExercises.map((exercise) => exercise.exerciseId);
assert.equal(nordicIds[0], nordicIds[1], "both days reference the same invented exercise id");

// --- Re-inventing a catalog exercise by name reuses the catalog entry ---
const reinvented = convertAiProgramToShare(
  {
    name: "Name Reuse Test",
    days: [
      {
        name: "Day 1",
        focus: "Test",
        exercises: [
          {
            exerciseId: "",
            name: knownExercise.name.toUpperCase(),
            isNew: true,
            sets: 3,
            repsMin: 8,
            repsMax: 12,
            targetRPE: 8,
            restSeconds: 90,
            progressionType: "hypertrophy",
          },
        ],
      },
    ],
  },
  catalog,
);
assert.equal(reinvented.valid, true);
assert.equal(reinvented.share.libraryExercises.length, 0, "no duplicate of a catalog exercise");
assert.equal(
  reinvented.share.programExercises[0].exerciseId,
  knownExercise.id,
  "catalog exercise reused by name match",
);

// --- null numeric fields fall back to defaults instead of clamping to minimum ---
const nullNumbers = convertAiProgramToShare(
  {
    name: "Null Test",
    days: [
      {
        name: "Day 1",
        focus: "Test",
        exercises: [
          {
            exerciseId: knownExercise.id,
            name: knownExercise.name,
            isNew: false,
            sets: null,
            repsMin: null,
            repsMax: null,
            targetRPE: null,
            restSeconds: null,
            progressionType: "hypertrophy",
          },
        ],
      },
    ],
  },
  catalog,
);
assert.equal(nullNumbers.valid, true);
const nullEntry = nullNumbers.share.programExercises[0];
assert.equal(nullEntry.targetSets, 3, "null sets fall back to 3, not the minimum");
assert.equal(nullEntry.targetReps.min, 8, "null repsMin falls back to 8");
assert.equal(nullEntry.restTime, 120, "null rest falls back to 120");

// --- Error mapping ---
assert.ok(/rejected/i.test(mapGeminiError(400, "API key not valid")));
assert.ok(/invalid or restricted/i.test(mapGeminiError(403, "forbidden")));
assert.ok(/quota/i.test(mapGeminiError(429, "quota exceeded")));
assert.ok(/try again/i.test(mapGeminiError(503, "overloaded")));

console.log("AI program verification passed.");
