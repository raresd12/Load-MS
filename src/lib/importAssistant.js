// Pure helpers of the AI Import Assistant UI (Phase H3, decisions H3-5 and
// H3-6): photo ordering and size totals, what a pick becomes, when Extract is
// available, how an extraction error is explained, the text search of the
// source review, and the technique-draft approval step (batches, accept into
// a share / a program draft, manual note edits).
//
// Nothing here reads a file, calls the network or writes to storage: files
// are classified by sourceFiles.js, requests are made by aiProgram.js /
// aiTechnique.js, and a technique entry reaches the Library only with its
// program through saveProgramDraft / applyProgramDraft (H2-1).

import {
  applyTechniqueDraft,
  MAX_TECHNIQUE_EXERCISES,
  TECHNIQUE_DRAFT_TAG,
  TECHNIQUE_LIST_FIELDS,
} from "./aiTechnique.js";
import { TECHNIQUE_DRAFT_BADGE } from "./libraryReview.js";
import {
  classifySourceFile,
  classifySourceSelection,
  estimateInlineBytes,
  SOURCE_LIMITS,
} from "./sourceFiles.js";

export const IMPORT_SOURCE_MODES = Object.freeze(["text", "photos", "file"]);

// Handoff 13.4: "not saved locally" never means "never sent anywhere".
export const SOURCE_PRIVACY_NOTE =
  "Files stay in this browser tab and are sent to Google only when you press Extract. They are never saved to the app or its backups.";

// One definition (libraryReview.js): the Library shows the same badge.
export { TECHNIQUE_DRAFT_BADGE };
export const PROGRAM_FILE_DOCUMENT_HINT = "Use the AI Import Assistant for documents";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value) {
  return String(value ?? "").trim();
}

export function formatFileSize(bytes) {
  const size = Math.max(0, Number(bytes) || 0);

  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Photos: order, totals, picks
// ---------------------------------------------------------------------------

/** A copy of `list` with the item at `index` moved by `delta` places; the same list when it cannot move. */
export function moveListItem(list, index, delta) {
  const items = asArray(list);
  const target = index + delta;

  if (
    !Number.isInteger(index) ||
    !Number.isInteger(target) ||
    index < 0 ||
    index >= items.length ||
    target < 0 ||
    target >= items.length ||
    target === index
  ) {
    return list;
  }

  const next = [...items];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

/** A copy of `list` without the item at `index`; the same list for an index that does not exist. */
export function removeListItem(list, index) {
  const items = asArray(list);

  if (!Number.isInteger(index) || index < 0 || index >= items.length) {
    return list;
  }

  return items.filter((_, position) => position !== index);
}

function getFileSize(file) {
  return Number(file?.sizeBytes ?? file?.size) || 0;
}

/**
 * summarizePhotos(photos) -> the running total under the thumbnails.
 * `photos` are File-like ({ size } or { sizeBytes }). The request limit is
 * counted on the base64 form (H3-1), so both numbers are returned.
 */
export function summarizePhotos(photos) {
  const items = asArray(photos);
  const totalBytes = items.reduce((sum, photo) => sum + getFileSize(photo), 0);
  const inlineBytes = items.reduce((sum, photo) => sum + estimateInlineBytes(getFileSize(photo)), 0);
  const maxImages = SOURCE_LIMITS.MAX_IMAGES_PER_SOURCE;
  const maxInlineBytes = SOURCE_LIMITS.MAX_TOTAL_INLINE_BYTES;

  return {
    count: items.length,
    totalBytes,
    inlineBytes,
    maxImages,
    maxInlineBytes,
    remaining: Math.max(0, maxImages - items.length),
    label: `${items.length} of ${maxImages} photos, ${formatFileSize(totalBytes)} (${formatFileSize(inlineBytes)} of ${formatFileSize(maxInlineBytes)} once encoded for the request)`,
  };
}

const PHOTO_ONLY_ERROR =
  "Choose JPG, PNG or WebP images here. A PDF, Word, Excel or text file goes in the File tab.";

/**
 * planPhotoPick(currentFiles, pickedFiles) -> what adding `pickedFiles` to
 * the photos already chosen gives.
 *   { ok: true, files: [...current, ...picked] }
 *   { ok: false, error, files: current }     nothing is added
 * Files are File-like ({ name, type, size }). Limits and wording come from
 * sourceFiles.js (each image 8 MiB, 6 images, 18 MiB encoded in total).
 */
export function planPhotoPick(currentFiles, pickedFiles) {
  const current = Array.from(currentFiles ?? []);
  const picked = Array.from(pickedFiles ?? []);

  if (!picked.length) {
    return { ok: true, files: current };
  }

  for (const file of picked) {
    const classified = classifySourceFile(file?.name, file?.type, file?.size);
    const prefix = picked.length > 1 || current.length > 0 ? `${String(file?.name ?? "File")}: ` : "";

    if (!classified.ok) {
      return { ok: false, error: `${prefix}${classified.error}`, files: current };
    }

    if (classified.kind !== "image") {
      return { ok: false, error: `${prefix}${PHOTO_ONLY_ERROR}`, files: current };
    }
  }

  const files = [...current, ...picked];
  const selection = classifySourceSelection(files);

  if (!selection.ok) {
    return { ok: false, error: selection.error, files: current };
  }

  return { ok: true, files };
}

/**
 * planFilePick(file) -> what the File tab does with one picked file.
 *   { ok: true, kind: "pdf" | "text" | "docx" | "xlsx", readOnPick }
 *   { ok: false, error }
 * `readOnPick` is true for the kinds whose text is shown before sending
 * (text files, DOCX, XLSX); a PDF is read when Extract is pressed.
 */
export function planFilePick(file) {
  const classified = classifySourceFile(file?.name, file?.type, file?.size);

  if (!classified.ok) {
    return { ok: false, error: classified.error };
  }

  if (classified.kind === "image") {
    return {
      ok: false,
      error: "This is an image. Use the Photos tab: it can send several pages of one program in order.",
    };
  }

  return { ok: true, kind: classified.kind, readOnPick: classified.kind !== "pdf" };
}

/**
 * getExtractBlocker({ mode, text, photos, file, isExtracting }) -> the reason
 * Extract is not available, or "" when it is. `file` is the File tab state
 * ({ status: "reading" | "ready" | "error" } or null).
 */
export function getExtractBlocker({ mode, text, photos, file, isExtracting } = {}) {
  if (isExtracting) {
    return "Reading your program...";
  }

  if (mode === "text") {
    const length = cleanText(text).length;

    if (!length) {
      return "Paste the program text first.";
    }

    if (length > SOURCE_LIMITS.MAX_SOURCE_TEXT_CHARS) {
      return `The pasted text is too long (max ${SOURCE_LIMITS.MAX_SOURCE_TEXT_CHARS.toLocaleString("en-US")} characters).`;
    }

    return "";
  }

  if (mode === "photos") {
    return asArray(photos).length ? "" : "Choose at least one photo of your plan first.";
  }

  if (mode === "file") {
    if (!file) {
      return "Choose a PDF, Word, Excel or text file first.";
    }

    if (file.status === "reading") {
      return "Reading the file...";
    }

    if (file.status === "error") {
      return "This file cannot be sent. Choose another file.";
    }

    return "";
  }

  return "Choose a source first.";
}

/** The lines shown under an office / text file: what was read and what was left out. */
export function describeSourceMeta(source) {
  const meta = source?.meta ?? {};
  const lines = [];
  const text = String(source?.text ?? "");

  if (meta.origin === "office") {
    if (meta.format === "xlsx") {
      lines.push(
        `${meta.sheets ?? 0} ${meta.sheets === 1 ? "sheet" : "sheets"}, ${meta.rows ?? 0} ${meta.rows === 1 ? "row" : "rows"} read on this device.`,
      );
    } else {
      lines.push(
        `${meta.paragraphs ?? 0} ${meta.paragraphs === 1 ? "paragraph" : "paragraphs"} and ${meta.rows ?? 0} table ${meta.rows === 1 ? "row" : "rows"} read on this device.`,
      );
    }
  }

  if (text) {
    lines.push(`${text.length.toLocaleString("en-US")} of ${SOURCE_LIMITS.MAX_SOURCE_TEXT_CHARS.toLocaleString("en-US")} characters.`);
  }

  if (meta.truncated) {
    lines.push(
      `Truncated: only the first ${SOURCE_LIMITS.MAX_SOURCE_TEXT_CHARS.toLocaleString("en-US")} characters are sent. Keep only the program part to send all of it.`,
    );
  }

  return { lines, warnings: asArray(meta.warnings).map(cleanText).filter(Boolean), truncated: Boolean(meta.truncated) };
}

// ---------------------------------------------------------------------------
// Source review: text search
// ---------------------------------------------------------------------------

/**
 * findTextMatches(text, query) -> { count, segments: [{ text, match }] }.
 * Case-insensitive, literal (no pattern syntax). Without a query the whole
 * text is one segment.
 */
export function findTextMatches(text, query) {
  const source = String(text ?? "");
  const needle = cleanText(query).toLowerCase();

  if (!needle || !source) {
    return { count: 0, segments: source ? [{ text: source, match: false }] : [] };
  }

  const haystack = source.toLowerCase();
  const segments = [];
  let count = 0;
  let cursor = 0;

  // toLowerCase can change the length of a few characters; when it does the
  // positions no longer line up, so only the count is reported.
  const aligned = haystack.length === source.length;

  while (cursor <= haystack.length) {
    const found = haystack.indexOf(needle, cursor);

    if (found < 0) {
      break;
    }

    count += 1;

    if (aligned) {
      if (found > cursor) {
        segments.push({ text: source.slice(cursor, found), match: false });
      }

      segments.push({ text: source.slice(found, found + needle.length), match: true });
    }

    cursor = found + needle.length;
  }

  if (!aligned) {
    return { count, segments: [{ text: source, match: false }] };
  }

  if (cursor < source.length) {
    segments.push({ text: source.slice(cursor), match: false });
  }

  return { count, segments };
}

// ---------------------------------------------------------------------------
// Extraction errors
// ---------------------------------------------------------------------------

const EXTRACTION_ERROR_KINDS = [
  {
    kind: "key",
    pattern: /save your gemini api key/i,
    title: "API key needed",
    guidance:
      "Open \"Gemini API key\" above and paste your key from Google AI Studio. Your source stays selected.",
  },
  {
    kind: "key",
    pattern: /api key/i,
    title: "API key problem",
    guidance:
      "Open \"Gemini API key\" above, remove the saved key and paste a new one from Google AI Studio. Your source stays selected.",
  },
  {
    kind: "quota",
    pattern: /quota/i,
    title: "Quota used up",
    guidance: "Nothing is wrong with your source. Wait, then press Extract again; it stays selected.",
  },
  {
    kind: "empty",
    pattern: /no training days could be read|revised program has no exercises/i,
    title: "The model returned no program",
    guidance:
      "Check that the source shows exercises with sets and reps. For a photo, retake it sharper and closer, one page per photo; for a scan or a table, paste the text instead.",
  },
  {
    kind: "blocked",
    pattern: /declined/i,
    title: "Blocked content",
    guidance:
      "Google refused this content. Remove personal or medical details, or paste only the program part as text.",
  },
  {
    kind: "response",
    pattern: /cut off|could not be read as|empty response|response was empty/i,
    title: "The answer could not be used",
    guidance: "Try again. For a long program send fewer pages, or split the text into parts.",
  },
  {
    kind: "network",
    pattern: /could not reach|timed out|internet connection|having trouble|not available for this key|cancelled/i,
    title: "Connection or service problem",
    guidance: "Check your connection and press Extract again. Your source stays selected and nothing was saved.",
  },
  {
    kind: "unsupported",
    pattern:
      /rejected the request|not supported|not a valid|is not a pdf|could not be read|too large|too long|too many images|is empty|no readable text|sent alone|choose |paste the program/i,
    title: "This source cannot be sent",
    guidance: "Pick a JPG, PNG, WebP, PDF, DOCX, XLSX, TXT, MD or CSV source inside the limits, or paste the text.",
  },
];

/**
 * classifyExtractionError(message) -> { kind, title, guidance, message }.
 * kind: "key" | "quota" | "network" | "blocked" | "unsupported" | "empty" |
 * "response" | "other". The messages come from aiProgram.js (mapGeminiError,
 * requestGeminiJson, convertAiProgramToShare) and sourceFiles.js; the fixture
 * verify-ui-h3-helpers.mjs feeds their real output through this function.
 */
export function classifyExtractionError(message) {
  const text = cleanText(message);

  if (!text) {
    return { kind: "none", title: "", guidance: "", message: "" };
  }

  const found = EXTRACTION_ERROR_KINDS.find((entry) => entry.pattern.test(text));

  return found
    ? { kind: found.kind, title: found.title, guidance: found.guidance, message: text }
    : { kind: "other", title: "", guidance: "", message: text };
}

// ---------------------------------------------------------------------------
// Program file import stays JSON-only
// ---------------------------------------------------------------------------

/**
 * getProgramFileRejection(fileName, mimeType) -> "" for a file the program
 * import may try to read as JSON, or the message for a document / image:
 * those belong to the AI Import Assistant.
 */
export function getProgramFileRejection(fileName, mimeType) {
  const name = cleanText(fileName);
  const lower = name.toLowerCase();
  const mime = cleanText(mimeType).toLowerCase().split(";")[0].trim();

  if (lower.endsWith(".json") || mime === "application/json") {
    return "";
  }

  const classified = classifySourceFile(name, mime, 1);
  const isPlainText = classified.ok && classified.kind === "text";

  // A share saved as .txt still parses; everything else that is a known
  // document, image or legacy office format is refused by name.
  if (isPlainText || (!classified.ok && /this file type is not supported/i.test(classified.error ?? ""))) {
    return "";
  }

  return `"${name || "This file"}" is not a program file (.json exported by this app). ${PROGRAM_FILE_DOCUMENT_HINT}.`;
}

// ---------------------------------------------------------------------------
// Technique drafts (decision H3-6)
// ---------------------------------------------------------------------------

const TECHNIQUE_TEXT_FIELDS = Object.freeze(["mainCue", ...TECHNIQUE_LIST_FIELDS.map((entry) => entry.field)]);

function toBulletList(value) {
  const items = Array.isArray(value) ? value : String(value ?? "").split(/\r?\n/);

  return items
    .map((item) =>
      String(item ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^(?:[-–—•*]+|\d+[.)])\s*/, "")
        .trim(),
    )
    .filter(Boolean);
}

function isMusclePlaceholder(entry, field) {
  return (
    field === "whatYouShouldFeel" &&
    cleanText(entry?.whatYouShouldFeel) !== "" &&
    cleanText(entry?.whatYouShouldFeel) === asArray(entry?.mainMuscles).join(", ")
  );
}

/**
 * getTechniqueRows(entry) -> [{ field, label, bullets }] in the Library
 * display order (EXERCISE_LIBRARY_SPEC.md): Main Cue, Setup, How To Do It,
 * What You Should Feel, Execution Tips, Common Mistakes, Why It's There,
 * Progression / Regression, Safety Notes. Works for a technique draft and for
 * a Library entry; empty fields are left out.
 */
export function getTechniqueRows(entry) {
  const rows = [];
  const mainCue = cleanText(entry?.mainCue);

  if (mainCue) {
    rows.push({ field: "mainCue", label: "Main Cue", bullets: [mainCue] });
  }

  TECHNIQUE_LIST_FIELDS.forEach(({ field, label }) => {
    if (isMusclePlaceholder(entry, field)) {
      return;
    }

    const bullets = toBulletList(entry?.[field]);

    if (bullets.length) {
      rows.push({ field, label, bullets });
    }
  });

  return rows;
}

export function hasTechniqueNotes(entry) {
  return getTechniqueRows(entry).length > 0;
}

export function isAiTechniqueEntry(entry) {
  return asArray(entry?.goalTags).includes(TECHNIQUE_DRAFT_TAG);
}

/** splitIntoBatches(list, size) -> lists of at most `size` items (default: 5, one technique request). */
export function splitIntoBatches(list, size = MAX_TECHNIQUE_EXERCISES) {
  const items = asArray(list);
  const step = Math.max(1, Math.floor(Number(size)) || 1);
  const batches = [];

  for (let index = 0; index < items.length; index += step) {
    batches.push(items.slice(index, index + step));
  }

  return batches;
}

function toTechniqueExercise(entry) {
  return {
    id: String(entry.id),
    name: cleanText(entry.name),
    equipment: cleanText(entry.equipment),
    category: cleanText(entry.category),
    mainMuscles: asArray(entry.mainMuscles).map(cleanText).filter(Boolean),
    hasNotes: hasTechniqueNotes(entry),
  };
}

/**
 * listNewExercisesOfShare(share, preview) -> the NEW local entries an
 * extraction proposes, in the order they first appear in the preview:
 * [{ id, name, equipment, category, mainMuscles, hasNotes }]. An exercise
 * matched to the Library is never listed.
 */
export function listNewExercisesOfShare(share, preview) {
  const entries = new Map(
    asArray(share?.libraryExercises)
      .filter((entry) => entry && entry.id && cleanText(entry.name))
      .map((entry) => [String(entry.id), entry]),
  );
  const seen = new Set();
  const list = [];

  asArray(preview?.days).forEach((day) => {
    asArray(day?.exercises).forEach((exercise) => {
      const id = String(exercise?.exerciseId ?? "");

      if (!exercise?.isNewExercise || exercise.matchedLibrary || !entries.has(id) || seen.has(id)) {
        return;
      }

      seen.add(id);
      list.push(toTechniqueExercise(entries.get(id)));
    });
  });

  return list;
}

/** listNewExercisesOfDraft(draft) -> the same list for a program draft (libraryStatus "new" only). */
export function listNewExercisesOfDraft(draft) {
  const seen = new Set();
  const list = [];

  asArray(draft?.days).forEach((day) => {
    asArray(day?.sections).forEach((section) => {
      asArray(section?.exercises).forEach((exercise) => {
        const entry = exercise?.newLibraryExercise;
        const id = String(entry?.id ?? "");

        if (exercise?.libraryStatus !== "new" || !id || !cleanText(entry?.name) || seen.has(id)) {
          return;
        }

        seen.add(id);
        list.push(toTechniqueExercise(entry));
      });
    });
  });

  return list;
}

/**
 * createExtractionTracker() -> { start, isCurrent, cancel, isRunning }.
 * One extraction request at a time belongs to the assistant (fix round 2):
 * - start() begins a run and returns { id, signal }; a run that was still
 *   open is cancelled first.
 * - cancel() ends the open run and aborts its request. The assistant calls it
 *   when the open draft is handed on ("Edit draft in Studio", "Add to my
 *   programs") or discarded: whatever the request returns afterwards is not
 *   a draft anybody asked to keep.
 * - isCurrent(id) is true until the run was cancelled or replaced. Leaving
 *   the page does NOT cancel: that result is kept for the next visit (H3-5).
 * - finish(id) closes a run that returned.
 */
export function createExtractionTracker() {
  let counter = 0;
  let open = null;

  function cancel() {
    if (!open) {
      return false;
    }

    const { controller } = open;
    open = null;

    try {
      controller?.abort();
    } catch {
      // An abort that throws changes nothing: the run is already closed.
    }

    return true;
  }

  return {
    start() {
      cancel();
      counter += 1;
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      open = { id: counter, controller };
      return { id: counter, signal: controller?.signal };
    },
    isCurrent(id) {
      return Boolean(open) && open.id === id;
    },
    isRunning() {
      return Boolean(open);
    },
    finish(id) {
      if (open && open.id === id) {
        open = null;
      }
    },
    cancel,
  };
}

/**
 * describeNewExercises(draft) -> what the review summary says about the new
 * exercises of a program draft: "" when there is none, "2 new (no technique
 * content yet)", "2 new (technique notes added)" or "3 new (1 with technique
 * notes, 2 without technique content yet)". Counts exercises, like
 * summarizeProgramDraft.
 */
export function describeNewExercises(draft) {
  let withNotes = 0;
  let withoutNotes = 0;

  asArray(draft?.days).forEach((day) => {
    asArray(day?.sections).forEach((section) => {
      asArray(section?.exercises).forEach((exercise) => {
        if (exercise?.libraryStatus !== "new") {
          return;
        }

        if (hasTechniqueNotes(exercise.newLibraryExercise)) {
          withNotes += 1;
        } else {
          withoutNotes += 1;
        }
      });
    });
  });

  const total = withNotes + withoutNotes;

  if (!total) {
    return "";
  }

  if (!withNotes) {
    return `${total} new (no technique content yet)`;
  }

  if (!withoutNotes) {
    return `${total} new (technique notes added)`;
  }

  return `${total} new (${withNotes} with technique notes, ${withoutNotes} without technique content yet)`;
}

/**
 * runTechniqueBatches({ exercises, language, request, signal, onProgress }) ->
 *   { drafts, rejected, uncertainty, error, completedBatches, totalBatches, model }
 * Sends `exercises` in batches of 5 through `request`
 * (draftTechniqueNotesWithAi), one after another. A failed batch stops the
 * run: what earlier batches returned is kept and `error` says what happened.
 * Never throws.
 */
export async function runTechniqueBatches({ exercises, language, request, signal, onProgress } = {}) {
  const batches = splitIntoBatches(
    asArray(exercises).map((exercise) => ({
      id: exercise.id,
      name: exercise.name,
      equipment: exercise.equipment,
      category: exercise.category,
      mainMuscles: exercise.mainMuscles,
    })),
  );
  const result = {
    drafts: [],
    rejected: [],
    uncertainty: [],
    error: "",
    completedBatches: 0,
    totalBatches: batches.length,
    model: "",
  };

  if (!batches.length) {
    result.error = "There is no new exercise to describe.";
    return result;
  }

  for (const batch of batches) {
    if (signal?.aborted) {
      result.error = "The AI request was cancelled.";
      break;
    }

    let response;

    try {
      response = await request({ exercises: batch, language, signal });
    } catch {
      response = { ok: false, error: "The technique request failed. Try again." };
    }

    if (!response?.ok) {
      const names = batch.map((exercise) => `"${exercise.name}"`).join(", ");
      result.error = `${response?.error ?? "The technique request failed. Try again."} (not drafted: ${names}${
        batches.length - result.completedBatches > 1 ? " and the exercises after them" : ""
      })`;
      break;
    }

    result.drafts.push(...asArray(response.drafts));
    result.rejected.push(...asArray(response.rejected));
    asArray(response.uncertainty).forEach((line) => {
      if (!result.uncertainty.includes(line)) {
        result.uncertainty.push(line);
      }
    });
    result.model = response.model ?? result.model;
    result.completedBatches += 1;
    onProgress?.({ completedBatches: result.completedBatches, totalBatches: batches.length });
  }

  return result;
}

/** The entry without technique text and without the AI technique tag (used before a replace). */
export function clearTechniqueNotes(entry) {
  const next = { ...entry };

  TECHNIQUE_TEXT_FIELDS.forEach((field) => {
    next[field] = Array.isArray(entry?.[field]) ? [] : "";
  });
  next.goalTags = asArray(entry?.goalTags).filter((tag) => tag !== TECHNIQUE_DRAFT_TAG);
  return next;
}

function acceptIntoEntry(entry, techniqueDraft, options = {}) {
  try {
    const base = options.replace ? clearTechniqueNotes(entry) : entry;
    const applied = applyTechniqueDraft(base, techniqueDraft, options.libraryIds ? { libraryIds: options.libraryIds } : {});
    return { ok: true, entry: applied };
  } catch (error) {
    return {
      ok: false,
      code: error?.code ?? "invalid",
      error: error?.message || "The technique draft could not be applied.",
    };
  }
}

/**
 * acceptTechniqueDraftIntoShare(share, techniqueDraft, { replace, libraryIds }) ->
 *   { ok: true, share, entry } | { ok: false, error, code, share }
 * The approval step of the extraction preview: the draft is applied
 * (applyTechniqueDraft) to the share's own NEW entry with that id and to
 * nothing else. An entry that a program exercise does not reference as new,
 * an id that is already in the Library and an invalid draft are refused.
 * `replace` clears the entry's current notes first (default: only empty
 * fields are filled). The input share is not mutated; nothing is stored.
 */
export function acceptTechniqueDraftIntoShare(share, techniqueDraft, options = {}) {
  const id = String(techniqueDraft?.id ?? "");
  const list = asArray(share?.libraryExercises);
  const index = list.findIndex((entry) => String(entry?.id ?? "") === id);

  if (!id || index < 0) {
    return { ok: false, code: "mismatch", error: "This draft has no new exercise with that technique entry.", share };
  }

  if (!asArray(share?.programExercises).some((exercise) => String(exercise?.exerciseId ?? "") === id)) {
    return { ok: false, code: "mismatch", error: "No exercise of this draft uses that entry.", share };
  }

  const accepted = acceptIntoEntry(list[index], techniqueDraft, options);

  if (!accepted.ok) {
    return { ...accepted, share };
  }

  const libraryExercises = [...list];
  libraryExercises[index] = accepted.entry;
  return { ok: true, share: { ...share, libraryExercises }, entry: accepted.entry };
}

/**
 * setNewLibraryEntryInDraft(draft, entry) -> the program draft with `entry`
 * as the proposed Library entry of every exercise that is libraryStatus
 * "new" with that id, and in draft.libraryExercises. Exercises matched to the
 * Library are never touched; the same draft is returned when no new exercise
 * uses the id.
 */
export function setNewLibraryEntryInDraft(draft, entry) {
  const id = String(entry?.id ?? "");

  if (!draft || typeof draft !== "object" || !id) {
    return draft;
  }

  let touched = false;
  const days = asArray(draft.days).map((day) => {
    let dayTouched = false;
    const sections = asArray(day.sections).map((section) => {
      let sectionTouched = false;
      const exercises = asArray(section.exercises).map((exercise) => {
        if (exercise?.libraryStatus !== "new" || String(exercise.exerciseId ?? "") !== id) {
          return exercise;
        }

        sectionTouched = true;
        return { ...exercise, newLibraryExercise: { ...entry, name: exercise.newLibraryExercise?.name ?? entry.name } };
      });

      if (!sectionTouched) {
        return section;
      }

      dayTouched = true;
      return { ...section, exercises };
    });

    if (!dayTouched) {
      return day;
    }

    touched = true;
    return { ...day, sections };
  });

  if (!touched) {
    return draft;
  }

  const proposed = asArray(draft.libraryExercises);
  const position = proposed.findIndex((item) => String(item?.id ?? "") === id);
  const stored = { ...entry, name: position >= 0 ? (proposed[position].name ?? entry.name) : entry.name };
  const libraryExercises =
    position >= 0 ? proposed.map((item, index) => (index === position ? stored : item)) : [...proposed, stored];

  return { ...draft, days, libraryExercises, updatedAt: new Date().toISOString() };
}

/**
 * acceptTechniqueDraftIntoDraft(draft, exerciseId, techniqueDraft, { replace, libraryIds }) ->
 *   { ok: true, draft, entry } | { ok: false, error, code, draft }
 * The approval step of the Studio: `exerciseId` is the draft exercise the
 * user is looking at; it must be libraryStatus "new" and the technique draft
 * must be written for its proposed entry.
 */
export function acceptTechniqueDraftIntoDraft(draft, exerciseId, techniqueDraft, options = {}) {
  let exercise = null;

  asArray(draft?.days).forEach((day) => {
    asArray(day?.sections).forEach((section) => {
      asArray(section?.exercises).forEach((item) => {
        if (!exercise && String(item?.id ?? "") === String(exerciseId ?? "")) {
          exercise = item;
        }
      });
    });
  });

  if (!exercise) {
    return { ok: false, code: "mismatch", error: "That exercise is no longer in the draft.", draft };
  }

  if (exercise.libraryStatus !== "new" || !exercise.newLibraryExercise) {
    return {
      ok: false,
      code: "not-new",
      error: "Technique drafts are only for the new exercises of this draft, not for Library exercises.",
      draft,
    };
  }

  const accepted = acceptIntoEntry(exercise.newLibraryExercise, techniqueDraft, options);

  if (!accepted.ok) {
    return { ...accepted, draft };
  }

  return { ok: true, draft: setNewLibraryEntryInDraft(draft, accepted.entry), entry: accepted.entry };
}

/**
 * createTechniqueForm(entry) -> { mainCue, setup, ... } with one bullet per
 * line (no hyphen), the text the "Edit notes" fields start from.
 */
export function createTechniqueForm(entry) {
  const form = { mainCue: cleanText(entry?.mainCue) };

  TECHNIQUE_LIST_FIELDS.forEach(({ field }) => {
    form[field] = isMusclePlaceholder(entry, field) ? "" : toBulletList(entry?.[field]).join("\n");
  });

  return form;
}

/**
 * applyTechniqueForm(entry, form) -> a new entry with the typed notes, in the
 * shape the entry already has (text fields: one "- bullet" per line; list
 * fields: bullets). Identity fields and tags are kept: an AI draft the user
 * corrected is still tagged as one. When every field was emptied there are no
 * AI notes left to review: the `technique-ai-draft` marker (and the
 * `reviewedByUser: false` it came with) goes, `ai-generated` stays.
 */
export function applyTechniqueForm(entry, form) {
  const next = { ...entry, mainCue: cleanText(form?.mainCue).replace(/\s+/g, " ") };

  TECHNIQUE_LIST_FIELDS.forEach(({ field }) => {
    const bullets = toBulletList(form?.[field]);
    next[field] = Array.isArray(entry?.[field]) ? bullets : bullets.map((bullet) => `- ${bullet}`).join("\n");
  });

  if (isAiTechniqueEntry(next) && !hasTechniqueNotes(next)) {
    next.goalTags = asArray(next.goalTags).filter((tag) => tag !== TECHNIQUE_DRAFT_TAG);

    if (next.reviewedByUser === false) {
      delete next.reviewedByUser;
    }
  }

  return next;
}

const ROMANIAN_MARKERS = /[ăâîșşțţ]|\b(?:și|sau|pentru|fără|când|spre|este|mai|nu)\b/giu;
const ENGLISH_MARKERS = /\b(?:the|and|with|your|keep|without|when|into|from)\b/gi;

/**
 * detectLibraryLanguage(entries) -> "ro" | "en": the language the Library's
 * technique text is written in, which is the language new drafts are asked
 * in. The seeded Library is Romanian; an empty Library gives "ro" as well
 * (the default of aiTechnique.js).
 */
export function detectLibraryLanguage(entries) {
  let romanian = 0;
  let english = 0;

  asArray(entries)
    .slice(0, 60)
    .forEach((entry) => {
      // The main cue is English in both cases (spec), so it is not counted.
      const text = TECHNIQUE_LIST_FIELDS.map(({ field }) => toBulletList(entry?.[field]).join(" ")).join(" ");
      romanian += (text.match(ROMANIAN_MARKERS) ?? []).length;
      english += (text.match(ENGLISH_MARKERS) ?? []).length;
    });

  return english > romanian ? "en" : "ro";
}
