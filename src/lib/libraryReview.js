// Library entries whose technique notes were written by AI (decisions H3-4,
// H3-6, H3-9): how they are recognised, how their text is shown, and the one
// write that marks them as reviewed by the owner.
//
// This module is small on purpose: the Library page and the workout info
// panel import it, so it must not pull the import assistant into their chunks.

import { readStorage, STORAGE_KEYS, writeStorage } from "./storage.js";

export const TECHNIQUE_DRAFT_TAG = "technique-ai-draft";
export const TECHNIQUE_DRAFT_BADGE = "AI draft, review before relying on it";
export const TECHNIQUE_REVIEW_HINT =
  "These technique notes were written by AI from the exercise name only. Read them, then mark them as reviewed.";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** True while an entry carries AI technique notes the owner has not reviewed. */
export function isAiTechniqueDraftEntry(entry) {
  return asArray(entry?.goalTags).includes(TECHNIQUE_DRAFT_TAG);
}

/** Goal tags as the Library filter lists them: the review marker is a badge, not a goal. */
export function getVisibleGoalTags(goalTags) {
  return asArray(goalTags).filter((tag) => tag !== TECHNIQUE_DRAFT_TAG);
}

const BULLET_MARKER = /^\s*(?:[-•–—*])\s+/;

/**
 * getTechniqueBullets(value) -> string[] | null.
 * A technique field is a list (seeded entries) or text with one "- bullet"
 * per line (entries created by an import, H3-4). Both are shown as the same
 * bullet list. null = not a list: plain text, shown as a paragraph.
 */
export function getTechniqueBullets(value) {
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item ?? "").trim()).filter(Boolean);
    return items.length ? items : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const lines = value
    .split(/\r\n?|\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length || !lines.every((line) => BULLET_MARKER.test(`${line} `))) {
    return null;
  }

  const items = lines.map((line) => `${line} `.replace(BULLET_MARKER, "").trim()).filter(Boolean);

  return items.length ? items : null;
}

/**
 * markLibraryTechniqueReviewed(exerciseId) ->
 *   { ok: true, entry, changed } | { ok: false, error, code? }
 * The owner's review of AI technique notes: the entry loses the
 * `technique-ai-draft` tag and gets `reviewedByUser: true`. Nothing else of
 * the entry changes, no other entry is touched, and the result is `ok` only
 * after the write succeeded.
 */
export function markLibraryTechniqueReviewed(exerciseId) {
  const id = String(exerciseId ?? "");
  const library = asArray(readStorage(STORAGE_KEYS.exerciseLibrary, []));
  const index = library.findIndex((entry) => entry && String(entry.id) === id);

  if (!id || index < 0) {
    return { ok: false, error: "This exercise is not in the Library." };
  }

  const entry = library[index];

  if (!isAiTechniqueDraftEntry(entry)) {
    return { ok: true, entry, changed: false };
  }

  const reviewed = {
    ...entry,
    goalTags: getVisibleGoalTags(entry.goalTags),
    reviewedByUser: true,
  };
  const next = [...library];
  next[index] = reviewed;
  const written = writeStorage(STORAGE_KEYS.exerciseLibrary, next);

  if (!written.ok) {
    return {
      ok: false,
      error: written.error ?? "The review could not be saved.",
      ...(written.code ? { code: written.code } : {}),
    };
  }

  return { ok: true, entry: reviewed, changed: true };
}
