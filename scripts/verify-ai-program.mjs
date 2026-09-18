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
  AI_PROGRAM_RESPONSE_SCHEMA,
  buildExtractionRequestParts,
  buildProgramExtractionPrompt,
  classifySourceFile,
  convertAiProgramToShare,
  GEMINI_API_KEY_STORAGE_KEY,
  getGeminiApiKey,
  getLibraryCatalog,
  mapGeminiError,
  setGeminiApiKey,
  UNSUPPORTED_SOURCE_FALLBACK,
} = await import("../src/lib/aiProgram.js");
const {
  getActiveProgramId,
  importProgramShare,
  seedDefaultProgramIfNeeded,
  validateProgramShare,
} = await import("../src/lib/programStorage.js");
const { createLocalBackup, getTrackedStorageKeys } = await import("../src/lib/storage.js");

seedDefaultProgramIfNeeded();

function storageSnapshot() {
  return new Map(window.localStorage.store);
}

function assertStorageUnchanged(before, label) {
  const after = storageSnapshot();
  assert.equal(after.size, before.size, `${label}: no storage keys added/removed`);

  for (const [key, value] of before) {
    assert.equal(after.get(key), value, `${label}: storage key ${key} unchanged`);
  }
}

// --- API key storage: local only, never in backups ---
assert.equal(getGeminiApiKey(), "", "no key saved initially");
assert.equal(setGeminiApiKey("  test-key-123  ").ok, true);
assert.equal(getGeminiApiKey(), "test-key-123", "key is trimmed and saved");
assert.ok(
  !getTrackedStorageKeys().includes(GEMINI_API_KEY_STORAGE_KEY),
  "API key must never be part of backup/tracked storage keys",
);
assert.ok(
  !JSON.stringify(createLocalBackup()).includes("test-key-123"),
  "API key must never appear in a backup export",
);
assert.equal(setGeminiApiKey("").ok, true);
assert.equal(getGeminiApiKey(), "", "empty save removes the key");

// --- Source file classification ---
assert.deepEqual(classifySourceFile("plan.png", "image/png", 1024), {
  ok: true,
  kind: "image",
  mimeType: "image/png",
});
assert.deepEqual(classifySourceFile("PLAN.JPG", "", 1024), {
  ok: true,
  kind: "image",
  mimeType: "image/jpeg",
});
assert.deepEqual(classifySourceFile("plan.webp", "image/webp", 1024), {
  ok: true,
  kind: "image",
  mimeType: "image/webp",
});
assert.deepEqual(classifySourceFile("plan.pdf", "application/pdf", 1024), {
  ok: true,
  kind: "pdf",
  mimeType: "application/pdf",
});
assert.equal(classifySourceFile("plan.txt", "text/plain", 1024).kind, "text");
assert.equal(classifySourceFile("plan.md", "", 1024).kind, "text");
assert.equal(classifySourceFile("plan.csv", "text/csv", 1024).kind, "text");

const docxResult = classifySourceFile("plan.docx", "application/vnd.openxmlformats", 1024);
assert.equal(docxResult.ok, false, "docx is rejected");
assert.ok(
  docxResult.error.includes(UNSUPPORTED_SOURCE_FALLBACK),
  "docx rejection shows the copy/paste or PDF/text fallback message",
);
const xlsxResult = classifySourceFile("plan.xlsx", "", 1024);
assert.equal(xlsxResult.ok, false, "xlsx is rejected");
assert.ok(xlsxResult.error.includes(UNSUPPORTED_SOURCE_FALLBACK));
const zipResult = classifySourceFile("plan.zip", "application/zip", 1024);
assert.equal(zipResult.ok, false, "unknown type is rejected");
assert.ok(zipResult.error.includes(UNSUPPORTED_SOURCE_FALLBACK));
assert.equal(classifySourceFile("plan.gif", "image/gif", 1024).ok, false, "gif is rejected");
assert.equal(
  classifySourceFile("big.png", "image/png", 9 * 1024 * 1024).ok,
  false,
  "oversized image is rejected",
);
assert.equal(
  classifySourceFile("big.pdf", "application/pdf", 11 * 1024 * 1024).ok,
  false,
  "oversized PDF is rejected",
);
assert.equal(classifySourceFile("empty.pdf", "application/pdf", 0).ok, false, "empty file rejected");

// --- Extraction prompt: parse, do not invent ---
const catalog = getLibraryCatalog();
assert.ok(catalog.length >= 20, "seeded library provides a catalog");

const prompt = buildProgramExtractionPrompt(catalog, "text");
assert.ok(prompt.includes(catalog[0].id), "prompt lists catalog exercise ids");
assert.ok(/transcribing, not coaching/i.test(prompt), "prompt frames the task as transcription");
assert.ok(/NEVER invent warm-up/i.test(prompt), "prompt forbids inventing warm-ups");
assert.ok(/NEVER output starting weights/i.test(prompt), "prompt forbids starting weights");
assert.ok(/use null/i.test(prompt), "prompt asks for null on unknown values");
assert.ok(
  /Preserve exercise names as written/i.test(prompt),
  "prompt preserves source exercise names",
);
assert.ok(
  buildProgramExtractionPrompt(catalog, "image").includes("attached image"),
  "image prompt describes the image source",
);
assert.ok(
  buildProgramExtractionPrompt(catalog, "pdf").includes("PDF"),
  "pdf prompt describes the PDF source",
);

// --- Request parts: pasted text and inline files, nothing persisted ---
const beforeParts = storageSnapshot();
const pastedSource = "Day 1\nBench Press 4x6-8 RPE 8\nUnique-Marker-XYZ-123";
const textParts = buildExtractionRequestParts(prompt, { kind: "text", text: pastedSource });
assert.equal(textParts.length, 2);
assert.equal(textParts[0].text, prompt);
assert.ok(textParts[1].text.includes(pastedSource), "pasted source text is sent to the model");

const fakeBase64 = "RkFLRV9JTUFHRV9CWVRFU19NQVJLRVI=";
const imageParts = buildExtractionRequestParts(prompt, {
  kind: "image",
  mimeType: "image/png",
  dataBase64: fakeBase64,
});
assert.equal(imageParts[1].inline_data.mime_type, "image/png", "image is sent as inline data");
assert.equal(imageParts[1].inline_data.data, fakeBase64);

const pdfParts = buildExtractionRequestParts(prompt, {
  kind: "pdf",
  mimeType: "application/pdf",
  dataBase64: fakeBase64,
});
assert.equal(pdfParts[1].inline_data.mime_type, "application/pdf", "pdf is sent as inline data");
assertStorageUnchanged(beforeParts, "building request parts");

// --- Conversion: warm-up from the source is preserved on the ProgramDay ---
const knownExercise = catalog[0];
const aiProgramWithWarmup = {
  name: "Coach PDF Plan",
  nickname: "",
  description: "",
  goal: "",
  days: [
    {
      name: "Day 1 - Upper",
      focus: "Push",
      warmup: {
        title: "Warm-up & Activation",
        items: [
          { name: "Band Pull-Aparts", prescription: "2 x 15", notes: "light band" },
          { name: "Arm Circles", prescription: "1 x 10 / direction" },
        ],
      },
      exercises: [
        {
          exerciseId: knownExercise.id,
          name: knownExercise.name,
          isNew: false,
          sets: 4,
          repsMin: 6,
          repsMax: 8,
          targetRPE: 8,
          restSeconds: 180,
          progressionType: "strength",
          notes: "",
        },
        {
          exerciseId: "",
          name: "Mystery Cable Fly Variation",
          isNew: true,
          category: "isolation",
          equipment: "cable",
          mainMuscles: ["chest"],
          sets: 3,
          repsMin: 12,
          repsMax: 15,
          targetRPE: null,
          restSeconds: null,
          progressionType: "pump",
        },
      ],
    },
    {
      name: "Day 2 - Lower",
      focus: "Legs",
      warmup: null,
      exercises: [
        {
          exerciseId: "",
          name: "Leg Press Machine",
          isNew: true,
          sets: null,
          repsMin: 10,
          repsMax: 12,
          targetRPE: 7,
          restSeconds: 120,
          progressionType: "hypertrophy",
        },
      ],
    },
  ],
};

const beforeConvert = storageSnapshot();
const converted = convertAiProgramToShare(aiProgramWithWarmup, catalog, "2026-07-03T00:00:00.000Z");
assertStorageUnchanged(beforeConvert, "conversion");
assert.equal(converted.valid, true);
assert.equal(validateProgramShare(converted.share).valid, true, "share passes app validation");

const warmupDay = converted.share.days[0];
assert.ok(warmupDay.warmup, "source warm-up is preserved on the ProgramDay");
assert.equal(warmupDay.warmup.title, "Warm-up & Activation");
assert.equal(warmupDay.warmup.items.length, 2);
assert.equal(warmupDay.warmup.items[0].name, "Band Pull-Aparts");
assert.equal(warmupDay.warmup.items[0].prescription, "2 x 15");
assert.ok(warmupDay.warmup.items[0].id, "warm-up items get stable ids");
assert.ok(
  warmupDay.warmup.items.every((item) => !("targetRPE" in item)),
  "warm-up items never carry a target RPE",
);

const noWarmupDay = converted.share.days[1];
assert.ok(!("warmup" in noWarmupDay), "no warm-up in source means no warmup on the day");

const warmupNames = warmupDay.warmup.items.map((item) => item.name.toLowerCase());
assert.ok(
  converted.share.libraryExercises.every(
    (exercise) => !warmupNames.includes(exercise.name.toLowerCase()),
  ),
  "warm-up items never become library exercises",
);
const exerciseNames = converted.share.programExercises.map((exercise) => exercise.exerciseId);
assert.ok(
  exerciseNames.every((id) => !id.includes("band-pull-aparts")),
  "warm-up items never become program exercises",
);

// --- Conversion: matching, new exercises, weights, missing fields ---
const knownEntry = converted.share.programExercises.find(
  (exercise) => exercise.exerciseId === knownExercise.id,
);
assert.ok(knownEntry, "known library exercise keeps its catalog id");
assert.equal(knownEntry.targetWeight, null, "no starting weights from AI");
assert.ok(
  converted.share.programExercises.every((exercise) => exercise.targetWeight === null),
  "targetWeight stays null everywhere",
);
assert.equal(converted.summary.reusedExerciseCount, 1);
assert.equal(converted.summary.newExerciseCount, 2, "unknown exercises become new local entries");
assert.equal(converted.summary.warmupDayCount, 1);
assert.equal(converted.summary.warmupItemCount, 2);
assert.ok(
  converted.share.libraryExercises.every((exercise) => exercise.id.startsWith("ai-")),
  "only new exercises ship in the share library",
);
assert.ok(
  converted.share.libraryExercises.every(
    (exercise) => exercise.setup === "" && exercise.howToDoIt === "" && exercise.mainCue === "",
  ),
  "new local exercises get no invented coaching content",
);

const previewDay1 = converted.preview.days[0];
assert.equal(previewDay1.exercises[0].matchedLibrary, true, "preview marks library matches");
assert.equal(previewDay1.exercises[1].isNewExercise, true, "preview marks new exercises");
assert.deepEqual(
  previewDay1.exercises[1].missingFields,
  ["target RPE", "rest"],
  "preview flags fields missing from the source",
);
assert.deepEqual(converted.preview.days[1].exercises[0].missingFields, ["sets"]);
assert.equal(previewDay1.warmup.items.length, 2, "preview shows warm-up items");

// --- The generated share must import cleanly through the existing pipeline ---
const activeProgramBefore = getActiveProgramId();
const importResult = importProgramShare(JSON.parse(JSON.stringify(converted.share)));
assert.equal(importResult.valid, true, "AI share imports through the normal pipeline");
assert.equal(importResult.importedDayCount, 2);
assert.equal(importResult.importedExerciseCount, 3);
assert.equal(importResult.addedLibraryExerciseCount, 2);
assert.equal(importResult.program.isDefault, false, "imported draft is never a default program");
assert.equal(
  getActiveProgramId(),
  activeProgramBefore,
  "importing a draft never changes the active program",
);

const storedDays = JSON.parse(window.localStorage.getItem("rpe-tracker.program-days.v1"));
const importedWarmupDay = storedDays.find(
  (day) => day.programId === importResult.program.id && day.warmup,
);
assert.ok(importedWarmupDay, "imported program keeps the warm-up on its ProgramDay");
assert.equal(importedWarmupDay.warmup.items.length, 2);

const storedLibrary = JSON.parse(window.localStorage.getItem("rpe-tracker.exercise-library.v1"));
assert.ok(
  storedLibrary.every((exercise) => !warmupNames.includes(String(exercise.name).toLowerCase())),
  "warm-up items never land in the stored exercise library",
);
assert.ok(
  storedLibrary.some((exercise) => exercise.id.startsWith("ai-mystery-cable-fly")),
  "unknown exercise becomes a private local library entry only via import",
);

// Uploaded file contents must never end up in storage, backups or shares.
const backupJson = JSON.stringify(createLocalBackup());
assert.ok(!backupJson.includes(fakeBase64), "file bytes never reach backups");
assert.ok(!backupJson.includes("Unique-Marker-XYZ-123"), "pasted source text never reaches backups");
assert.ok(
  !JSON.stringify(converted.share).includes(fakeBase64),
  "file bytes never reach program shares",
);

// --- Conversion: invalid inputs fail safely ---
assert.equal(convertAiProgramToShare(null, catalog).valid, false);
assert.equal(convertAiProgramToShare({ days: [] }, catalog).valid, false);
assert.equal(convertAiProgramToShare("not an object", catalog).valid, false);
assert.equal(
  convertAiProgramToShare({ name: "X", days: [{ name: "D", exercises: [] }] }, catalog).valid,
  false,
  "program with only empty days is rejected",
);

// --- Clamping still protects against absurd extracted values ---
const clamped = convertAiProgramToShare(
  {
    name: "Clamp Test",
    days: [
      {
        name: "Day 1",
        focus: "Test",
        exercises: [
          {
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
    ],
  },
  catalog,
);
assert.equal(clamped.valid, true);
const clampedEntry = clamped.share.programExercises[0];
assert.ok(
  clampedEntry.exerciseId.startsWith("ai-leg-press-machine"),
  "hallucinated id becomes a new exercise, never a dangling reference",
);
assert.ok(clampedEntry.targetSets <= 8, "sets clamped");
assert.ok(clampedEntry.targetReps.min <= clampedEntry.targetReps.max, "reps ordered");
assert.ok(clampedEntry.targetRPE <= 10, "RPE clamped");
assert.ok(clampedEntry.restTime >= 30, "rest clamped");
assert.equal(clampedEntry.type, "hypertrophy", "invalid progression type falls back");
assert.deepEqual(
  clamped.preview.days[0].exercises[0].missingFields,
  [],
  "stated (even absurd) values are clamped, not flagged as missing",
);

// --- The same unknown exercise on two days maps to ONE library entry ---
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
  "same unknown name creates a single library entry",
);
const nordicIds = repeatedInvention.share.programExercises.map((exercise) => exercise.exerciseId);
assert.equal(nordicIds[0], nordicIds[1], "both days reference the same new exercise id");

// --- An unknown-flagged exercise matching a catalog name reuses the catalog entry ---
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
assert.equal(
  reinvented.preview.days[0].exercises[0].matchedLibrary,
  true,
  "preview reports the name match as a library match",
);

// --- Null numeric fields fall back to defaults and are flagged, not invented silently ---
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
assert.deepEqual(
  nullNumbers.preview.days[0].exercises[0].missingFields,
  ["sets", "reps", "target RPE", "rest"],
  "all defaulted fields are flagged in the preview",
);
assert.equal(nullNumbers.summary.missingFieldCount, 4);

// --- Response schema: warm-up supported, without target RPE ---
const daySchema = AI_PROGRAM_RESPONSE_SCHEMA.properties.days.items;
assert.ok(daySchema.properties.warmup, "schema supports day.warmup");
const warmupItemSchema = daySchema.properties.warmup.properties.items.items;
assert.deepEqual(
  Object.keys(warmupItemSchema.properties).sort(),
  ["name", "notes", "prescription", "videoUrl"],
  "warm-up item schema has exactly name/prescription/notes/videoUrl - no targetRPE",
);
assert.ok(
  daySchema.properties.exercises.items.properties.sets.nullable,
  "unclear numeric fields may be null instead of invented",
);
assert.ok(
  Object.keys(daySchema.properties.exercises.items.properties).every(
    (field) => !/weight/i.test(field),
  ),
  "schema has no weight field for the AI to fill",
);

// --- Error mapping ---
assert.ok(/rejected/i.test(mapGeminiError(400, "API key not valid")));
assert.ok(/invalid or restricted/i.test(mapGeminiError(403, "forbidden")));
assert.ok(/quota/i.test(mapGeminiError(429, "quota exceeded")));
assert.ok(/try again/i.test(mapGeminiError(503, "overloaded")));

console.log("AI program import assistant verification passed.");
