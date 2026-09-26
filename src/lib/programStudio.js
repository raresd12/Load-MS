// Program Studio helpers (Phase H2, UI track). Pure functions between the
// ProgramDraft model (src/lib/programDraft.js) and the Studio screens:
// form <-> draft field conversion, validation error grouping per item,
// Library search for the picker, provenance labels and diff/prescription text.
// Nothing here touches storage; the draft operations stay in programDraft.js.
import { DRAFT_EXERCISE_PROVENANCE_FIELDS } from "./programDraft.js";
import { formatRestEditorValue, parseRestEditorValue } from "./rest.js";

export const STUDIO_MODES = Object.freeze(["create", "edit", "review"]);

export const PROVENANCE_LABELS = Object.freeze({
  source: "from source",
  default: "default",
  edited: "edited",
});

export const EXERCISE_TYPE_OPTIONS = Object.freeze([
  "strength",
  "hypertrophy",
  "pump",
  "athletic",
  "core",
]);

function cleanString(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function stringify(value) {
  return value === null || value === undefined ? "" : String(value);
}

function parseOptionalNumber(text) {
  const clean = cleanString(text);

  if (!clean) {
    return null;
  }

  const parsed = Number(clean);
  // Unusable numbers become NaN so updateExercise stores null and
  // validateProgramDraft reports the field instead of keeping the old value.
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * Editor text for one draft exercise (all strings / booleans / enums).
 */
export function createExerciseForm(exercise) {
  const reps = exercise?.targetReps && typeof exercise.targetReps === "object" ? exercise.targetReps : {};

  return {
    targetSets: stringify(exercise?.targetSets),
    repsMin: stringify(reps.min),
    repsMax: stringify(reps.max),
    repsLabel: stringify(reps.label),
    targetWeight: stringify(exercise?.targetWeight),
    targetRPE: stringify(exercise?.targetRPE),
    // Unparseable rest text kept by the draft (see buildExercisePatch) is
    // shown as typed so the user sees what validation is complaining about.
    restTime: typeof exercise?.restTime === "string" ? exercise.restTime : formatRestEditorValue(exercise?.restTime),
    notes: stringify(exercise?.notes),
    type: cleanString(exercise?.type) || "hypertrophy",
    isOptional: Boolean(exercise?.isOptional),
    loadType: cleanString(exercise?.loadType) || "external",
    weightMode: cleanString(exercise?.weightMode) || "kg",
  };
}

/**
 * Patch for updateExercise from ONE changed form field. Only that field is
 * touched so provenance of the others stays as it was.
 * Returns { patch, error? }. Text that cannot be parsed still produces a
 * patch: numbers become NaN (stored as null) and rest / weight text is handed
 * over as typed, so the draft never keeps a previous value behind a field
 * that shows something else and validateProgramDraft blocks Save; `error` is
 * the inline message for that field. { patch: null, error } only for an
 * unknown field.
 */
export function buildExercisePatch(field, value, form) {
  switch (field) {
    case "targetSets":
    case "targetRPE":
      return { patch: { [field]: parseOptionalNumber(value) } };
    case "repsMin":
    case "repsMax":
    case "repsLabel": {
      const next = { ...form, [field]: value };
      return {
        patch: {
          targetReps: {
            min: parseOptionalNumber(next.repsMin),
            max: parseOptionalNumber(next.repsMax),
            label: cleanString(next.repsLabel) || null,
          },
        },
      };
    }
    case "targetWeight": {
      const clean = cleanString(value);

      if (!clean) {
        return { patch: { targetWeight: null } };
      }

      if (clean.toLowerCase() === "bw") {
        return { patch: { targetWeight: "BW" } };
      }

      const parsed = Number(clean);
      return Number.isFinite(parsed) && parsed >= 0
        ? { patch: { targetWeight: parsed } }
        : { patch: { targetWeight: clean }, error: "Weight must be blank, BW, or a kg number." };
    }
    case "restTime": {
      if (!cleanString(value)) {
        return { patch: { restTime: null } };
      }

      const parsed = parseRestEditorValue(value);
      return parsed.valid
        ? { patch: { restTime: parsed.value } }
        : { patch: { restTime: cleanString(value) }, error: parsed.error };
    }
    case "isOptional":
      return { patch: { isOptional: Boolean(value) } };
    case "notes":
    case "type":
    case "loadType":
    case "weightMode":
    case "sourceWeight":
    case "name":
      return { patch: { [field]: value } };
    default:
      return { patch: null, error: `Unknown field "${field}".` };
  }
}

/**
 * Human label of where a draft exercise field came from.
 */
export function getProvenanceLabel(exercise, field) {
  if (!DRAFT_EXERCISE_PROVENANCE_FIELDS.includes(field)) {
    return "";
  }

  const value = exercise?.provenance?.[field];
  return PROVENANCE_LABELS[value] ?? "";
}

/**
 * Counts of source / default / edited labels over every exercise field of the
 * draft (shown in the review screens).
 */
export function countDraftProvenance(draft) {
  const counts = { source: 0, default: 0, edited: 0 };

  (draft?.days ?? []).forEach((day) => {
    (day?.sections ?? []).forEach((section) => {
      (section?.exercises ?? []).forEach((exercise) => {
        DRAFT_EXERCISE_PROVENANCE_FIELDS.forEach((field) => {
          const value = exercise?.provenance?.[field];

          if (value in counts) {
            counts[value] += 1;
          }
        });
      });
    });
  });

  return counts;
}

export function formatDraftReps(targetReps) {
  const reps = targetReps && typeof targetReps === "object" ? targetReps : {};
  const label = cleanString(reps.label);
  const hasMin = reps.min !== null && reps.min !== undefined;
  const hasMax = reps.max !== null && reps.max !== undefined;

  if (hasMin && hasMax) {
    const numeric = Number(reps.min) === Number(reps.max) ? String(reps.min) : `${reps.min}-${reps.max}`;
    return label && label.replace(/\s+/g, "") !== numeric.replace(/\s+/g, "") ? `${numeric} (${label})` : numeric;
  }

  if (hasMin || hasMax) {
    const numeric = String(hasMin ? reps.min : reps.max);
    return label ? `${numeric} (${label})` : numeric;
  }

  return label || "?";
}

export function formatDraftRest(restTime) {
  if (Array.isArray(restTime)) {
    return `${restTime[0]}-${restTime[1]} s`;
  }

  if (restTime === null || restTime === undefined || restTime === "") {
    return "? s";
  }

  return `${restTime} s`;
}

export function formatDraftWeight(exercise) {
  const weight = exercise?.targetWeight;

  if (weight === null || weight === undefined || weight === "") {
    return exercise?.loadType === "bodyweight" ? "BW" : "coach sets kg";
  }

  if (weight === "BW") {
    return "BW";
  }

  return exercise?.weightMode === "additional load" ? `BW +${weight} kg` : `${weight} kg${exercise?.weightMode === "per dumbbell" ? " / db" : ""}`;
}

/**
 * One-line prescription of a draft exercise: "3x8-12 | coach sets kg | RPE 8 | 120 s".
 */
export function formatDraftPrescription(exercise) {
  const sets = exercise?.targetSets ?? "?";
  const rpe = exercise?.targetRPE ?? "?";

  return `${sets}x ${formatDraftReps(exercise?.targetReps)} | ${formatDraftWeight(exercise)} | RPE ${rpe} | ${formatDraftRest(exercise?.restTime)}`;
}

const PATH_PATTERN = /^days\[(\d+)\](?:\.sections\[(\d+)\](?:\.exercises\[(\d+)\])?)?/;

/**
 * Groups validateProgramDraft errors by the item they belong to so each
 * screen can show its own errors. Returns
 * { program: [message], byDayId: { [dayId]: [message] }, bySectionId, byExerciseId, all: [{ path, message, label }] }.
 * `label` is a readable location ("Day 2 > Main Work > Bench Press").
 */
export function groupDraftValidationErrors(draft, errors) {
  const grouped = { program: [], byDayId: {}, bySectionId: {}, byExerciseId: {}, all: [] };
  const days = Array.isArray(draft?.days) ? draft.days : [];

  (errors ?? []).forEach((error) => {
    const path = cleanString(error?.path);
    const message = cleanString(error?.message);
    const match = path.match(PATH_PATTERN);

    if (!match) {
      grouped.program.push(message);
      grouped.all.push({ path, message, label: "Program" });
      return;
    }

    const day = days[Number(match[1])];
    const section = match[2] !== undefined ? day?.sections?.[Number(match[2])] : null;
    const exercise = match[3] !== undefined ? section?.exercises?.[Number(match[3])] : null;
    const labelParts = [day?.name || `Day ${Number(match[1]) + 1}`];

    if (exercise) {
      const exerciseLabel = exercise.name || `Exercise ${Number(match[3]) + 1}`;
      labelParts.push(exerciseLabel);
      const list = (grouped.byExerciseId[exercise.id] ??= []);
      // validateProgramDraft prefixes exercise messages with the same label;
      // the location line already names it, so the prefix is dropped here.
      const bare = message.startsWith(`${exerciseLabel}: `) ? message.slice(exerciseLabel.length + 2) : message;
      list.push(bare);
      (grouped.byDayId[day.id] ??= []).push(bare);
      grouped.all.push({ path, message: bare, label: labelParts.join(" > ") });
      return;
    } else if (section) {
      labelParts.push(section.name || `Section ${Number(match[2]) + 1}`);
      const list = (grouped.bySectionId[section.id] ??= []);
      list.push(message);
    }

    if (day) {
      const list = (grouped.byDayId[day.id] ??= []);
      list.push(message);
    } else {
      grouped.program.push(message);
    }

    grouped.all.push({ path, message, label: labelParts.join(" > ") });
  });

  return grouped;
}

function normalizeSearchText(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Library picker search over name, id, category, equipment and muscles.
 * Every query word must appear somewhere; entries whose NAME starts with the
 * query come first, then name matches, then the rest. Empty query = all
 * entries in name order. `limit` caps the result (0 = no cap).
 */
export function searchLibraryEntries(entries, query, limit = 40) {
  const list = (Array.isArray(entries) ? entries : []).filter((entry) => entry && entry.id && entry.name);
  const words = normalizeSearchText(query).split(" ").filter(Boolean);
  const scored = [];

  list.forEach((entry) => {
    const name = normalizeSearchText(entry.name);
    const haystack = [
      name,
      normalizeSearchText(entry.id),
      normalizeSearchText(entry.category),
      normalizeSearchText(entry.equipment),
      ...(Array.isArray(entry.mainMuscles) ? entry.mainMuscles.map(normalizeSearchText) : []),
      ...(Array.isArray(entry.secondaryMuscles) ? entry.secondaryMuscles.map(normalizeSearchText) : []),
    ].join(" | ");

    if (!words.every((word) => haystack.includes(word))) {
      return;
    }

    const fullQuery = words.join(" ");
    const score = !words.length ? 2 : name.startsWith(fullQuery) ? 0 : name.includes(fullQuery) ? 1 : words.every((word) => name.includes(word)) ? 2 : 3;
    scored.push({ entry, score, name });
  });

  scored.sort((left, right) => left.score - right.score || left.name.localeCompare(right.name));
  const result = scored.map((item) => item.entry);
  return limit > 0 ? result.slice(0, limit) : result;
}

/**
 * Whether the working copy differs from the draft the Studio opened with
 * (timestamps ignored, so an untouched draft is never "dirty").
 */
export function isDraftDirty(initialDraft, workingDraft) {
  const strip = (draft) => {
    if (!draft || typeof draft !== "object") {
      return draft ?? null;
    }

    const { updatedAt, createdAt, ...rest } = draft;
    return rest;
  };

  return JSON.stringify(strip(initialDraft)) !== JSON.stringify(strip(workingDraft));
}

/**
 * What the Studio does with the stored (autosaved) copy of its working draft
 * after a change. Pure. Returns { action: "save" | "delete" | "none", delay }.
 * - "save": an edited draft (after `delay` ms), a review draft (at once, from
 *   the moment it opens - H2-8), or a resumed draft whose working copy is
 *   back at the resumed state while the stored copy still holds an edit
 *   (`storedCopyDiffers`): the stored copy follows at once.
 * - "delete": a create / edit session whose working copy is back at the
 *   draft it opened with: a stored copy would offer to resume an edit the
 *   user undid (H2-12).
 * - "none": a resumed draft whose stored copy already matches.
 */
export function planDraftStore({ dirty, mode, isResumed = false, storedCopyDiffers = false, delay = 800 }) {
  if (dirty || mode === "review") {
    return { action: "save", delay: dirty ? delay : 0 };
  }

  if (isResumed) {
    return storedCopyDiffers ? { action: "save", delay: 0 } : { action: "none", delay: 0 };
  }

  return { action: "delete", delay: 0 };
}

/**
 * The autosave status line for a saveDraftToStorage result. A write that
 * evicted older drafts (the H2-3 cap) names them instead of reading like a
 * plain success (H2-12).
 */
export function describeDraftStoreResult(result) {
  if (!result || !result.ok) {
    return `Draft not kept: ${result?.error ?? "unknown storage error"}`;
  }

  const dropped = Array.isArray(result.droppedDrafts) ? result.droppedDrafts : [];

  if (!dropped.length) {
    return "Unsaved draft kept on this device.";
  }

  const names = dropped.map((entry) =>
    entry && entry.programName ? `"${entry.programName}"` : `an unnamed ${entry?.origin === "blank" ? "" : `${entry?.origin ?? ""} `}draft`.replace(/\s+/g, " "),
  );

  return `Unsaved draft kept on this device. Draft slots are full: the oldest unsaved ${
    dropped.length === 1 ? "draft" : "drafts"
  } (${names.join(", ")}) ${dropped.length === 1 ? "was" : "were"} removed to make room and cannot be resumed.`;
}

/**
 * Unmount with a pending autosave (tab switch, page swap): the last edits are
 * written, unless the Studio was closed on purpose. Returns the save result
 * or null when nothing had to be written.
 */
export function flushPendingDraftStore({ pending, closed, draft, save }) {
  if (!pending || closed || !draft) {
    return null;
  }

  return save(draft);
}

/**
 * The Studio's Cancel. Whatever would be lost (edits, a resumed draft, an AI
 * / file result) is asked about first; the stored copy is removed only after
 * a confirmed (or unneeded) cancel, never before the answer is known.
 * `confirm(message)` returns the user's answer, `discard(draftId)` closes the
 * session and deletes the stored copy. Returns { cancelled, asked }.
 */
export function cancelStudioSession({ dirty, mode, isResumed = false, draftId, confirm, discard }) {
  const asks = Boolean(dirty) || Boolean(isResumed) || mode === "review";

  if (asks) {
    const message =
      mode === "review" && !dirty && !isResumed
        ? "Discard this draft? The imported result is not kept anywhere else. Your saved programs are not affected."
        : "Discard this draft? Your saved programs are not affected.";

    if (!confirm(message)) {
      return { cancelled: false, asked: true };
    }
  }

  discard(draftId);
  return { cancelled: true, asked: asks };
}

/**
 * App-state side of a Studio session (H2-8): `openStudioSession` keeps the
 * draft the session opened with as `initialDraft` (dirty / diff baseline),
 * `updateStudioSessionDraft` records the latest working copy so a remount
 * (bottom-nav tab switch) starts from it; a draft of another session is
 * ignored. Both pure.
 */
export function openStudioSession(session) {
  return session ? { ...session, initialDraft: session.initialDraft ?? session.draft } : null;
}

export function updateStudioSessionDraft(current, draft) {
  return current && draft && current.draft?.draftId === draft.draftId ? { ...current, draft } : current;
}

/**
 * Studio mode for a draft resumed from storage: a draft that edits an
 * existing program applies to it ("edit", or "review" for an AI edit),
 * anything else creates a new program ("create", or "review" for AI/file
 * imports which the user should look over first).
 */
export function resolveStudioModeForDraft(draft) {
  if (draft?.sourceProgramId) {
    return draft.origin === "ai-edit" ? "review" : "edit";
  }

  return draft?.origin === "ai-import" || draft?.origin === "file-import" ? "review" : "create";
}

/**
 * Readable lines for a diffDraftAgainstProgram result (review panel).
 * Returns { added: [text], removed: [text], changed: [{ title, fields: [text] }], moved: [text], program: [text], days: [text], isEmpty }.
 * `days` also lists changed day focus / notes / optional flag / warm-up, and
 * an added exercise that replaces a stored one (Library remap) says so.
 */
export function describeDraftDiff(diff) {
  const empty = { program: [], days: [], added: [], removed: [], moved: [], changed: [], isEmpty: true };

  if (!diff || diff.ok === false) {
    return empty;
  }

  const formatValue = (value) => {
    if (value === null || value === undefined || value === "") {
      return "empty";
    }

    if (Array.isArray(value)) {
      return value.join("-");
    }

    if (typeof value === "object") {
      return formatDraftReps(value);
    }

    return String(value);
  };
  const dayNameOf = (dayId, fallback = "") => {
    const renamed = (diff.days?.renamed ?? []).find((entry) => entry.id === dayId);
    return renamed?.to || fallback;
  };

  const program = (diff.program ?? []).map(
    (change) => `${change.field}: "${formatValue(change.from)}" -> "${formatValue(change.to)}"`,
  );
  const formatDayValue = (field, value) => {
    if (field === "isOptional") {
      return value ? "optional" : "required";
    }

    if (field === "warmup") {
      const items = value?.items ?? [];
      return items.length
        ? `${items.length} ${items.length === 1 ? "item" : "items"} (${items.map((item) => item.name || item.prescription).filter(Boolean).join(", ")})`
        : "no warm-up";
    }

    return formatValue(value);
  };
  const days = [
    ...(diff.days?.added ?? []).map((day) => `Added day "${day.name}"`),
    ...(diff.days?.removed ?? []).map((day) => `Removed day "${day.name}"`),
    ...(diff.days?.renamed ?? []).map((day) => `Renamed day "${day.from}" to "${day.to}"`),
    ...(diff.days?.changed ?? []).flatMap((day) =>
      (day.fields ?? []).map(
        (change) => `Day "${day.name}" ${change.field === "warmup" ? "warm-up" : change.field}: ${formatDayValue(change.field, change.from)} -> ${formatDayValue(change.field, change.to)}`,
      ),
    ),
  ];
  const added = (diff.exercises?.added ?? []).map((exercise) => {
    const dayName = dayNameOf(exercise.dayId);
    const base = dayName ? `${exercise.name} (${dayName})` : exercise.name;
    return exercise.replaces
      ? `${base} - replaces ${exercise.replaces.name}, whose history and progression stay with the old exercise`
      : base;
  });
  const removed = (diff.exercises?.removed ?? []).map((exercise) => exercise.name);
  const moved = (diff.exercises?.moved ?? []).map((exercise) => `${exercise.name} moved`);
  const changed = (diff.exercises?.changed ?? []).map((exercise) => ({
    title: exercise.prescriptionChanged ? `${exercise.name} (prescription changed - progression restarts)` : exercise.name,
    fields: (exercise.fields ?? []).map(
      (change) => `${change.field}: ${formatValue(change.from)} -> ${formatValue(change.to)}`,
    ),
  }));

  return {
    program,
    days,
    added,
    removed,
    moved,
    changed,
    isEmpty: !program.length && !days.length && !added.length && !removed.length && !moved.length && !changed.length,
  };
}

/**
 * Counts of exercises per day of a draft (list screens).
 */
export function countDayExercises(day) {
  return (day?.sections ?? []).reduce((total, section) => total + (section?.exercises?.length ?? 0), 0);
}
