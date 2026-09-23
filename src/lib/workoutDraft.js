// Pure helpers for the Workout Log draft. App.jsx owns the React state; these
// functions decide which stored draft the log works on and when a draft has to
// be rebuilt, so the rules can be verified without a browser.

// A draft that was last touched within this window is still "the workout in
// progress" even after the local date rolled over at midnight. 36 hours covers
// a session that crosses midnight and an app left open until the next day;
// older unsaved drafts are treated as abandoned and stay under their own key.
export const DRAFT_RESUME_WINDOW_MS = 36 * 60 * 60 * 1000;

function isBlank(value) {
  return value === "" || value === null || value === undefined;
}

function hasText(value) {
  return String(value ?? "").trim().length > 0;
}

export function getWorkoutDraftKey(programId, dayId, dateKey) {
  return [programId ?? "no-program", dayId ?? "no-day", dateKey].join("::");
}

/**
 * True when the athlete has entered anything into the draft: a set value, a
 * pain flag, exercise notes, session RPE/notes or recovery activities/notes.
 */
export function draftHasLoggedData(draft) {
  if (!draft || typeof draft !== "object") {
    return false;
  }

  if (!isBlank(draft.sessionRpe) || hasText(draft.sessionNotes) || hasText(draft.recoveryNotes)) {
    return true;
  }

  if (Object.values(draft.recoveryActivities ?? {}).some(Boolean)) {
    return true;
  }

  return Object.values(draft.exercises ?? {}).some((exercise) => {
    if (!exercise || typeof exercise !== "object") {
      return false;
    }

    if (exercise.painFlag === true || hasText(exercise.notes)) {
      return true;
    }

    return (Array.isArray(exercise.sets) ? exercise.sets : []).some(
      (set) => set && (!isBlank(set.reps) || !isBlank(set.weight) || !isBlank(set.rpe)),
    );
  });
}

function toTime(value) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : null;
}

/**
 * Picks the draft key the Workout Log should work on for `programId` + `dayId`.
 *
 * Normally that is today's key. When today's draft is empty and an in-progress
 * draft of the same program + day from an earlier date still has logged data
 * and was updated within DRAFT_RESUME_WINDOW_MS, that earlier draft is
 * resumed instead: a workout that crosses midnight (or is reopened right after
 * it) keeps its logged sets on screen instead of being replaced by a blank
 * draft while the sets sit orphaned under yesterday's key.
 *
 * Returns { key, dateKey, resumedFromDateKey }.
 */
export function resolveWorkoutDraftKey({
  workoutDrafts,
  programId,
  dayId,
  todayDateKey,
  now = Date.now(),
}) {
  const todayKey = getWorkoutDraftKey(programId, dayId, todayDateKey);
  const drafts = workoutDrafts && typeof workoutDrafts === "object" ? workoutDrafts : {};
  const todayEntry = drafts[todayKey];
  const todayResult = { key: todayKey, dateKey: todayDateKey, resumedFromDateKey: null };

  if (todayEntry && todayEntry.status !== "completed" && draftHasLoggedData(todayEntry.draft)) {
    return todayResult;
  }

  let best = null;

  Object.entries(drafts).forEach(([key, entry]) => {
    if (!entry || typeof entry !== "object" || entry.status === "completed") {
      return;
    }

    if ((entry.programId ?? null) !== (programId ?? null) || (entry.dayId ?? null) !== (dayId ?? null)) {
      return;
    }

    const dateKey = typeof entry.date === "string" ? entry.date : null;

    if (!dateKey || !todayDateKey || dateKey >= todayDateKey) {
      return;
    }

    const updatedAt = toTime(entry.updatedAt);

    if (updatedAt === null || now - updatedAt > DRAFT_RESUME_WINDOW_MS || updatedAt > now) {
      return;
    }

    if (!draftHasLoggedData(entry.draft)) {
      return;
    }

    if (!best || updatedAt > best.updatedAt) {
      best = { key, dateKey, updatedAt };
    }
  });

  if (!best) {
    return todayResult;
  }

  return { key: best.key, dateKey: best.dateKey, resumedFromDateKey: best.dateKey };
}

/**
 * Signature of the set slots a plan asks for (exercise id + set count per
 * entry). The Workout Log rebuilds its draft when this changes even if the
 * plan's generatedAt did not, e.g. after a program target edit changed the
 * set count of one exercise while the rest of the day plan stayed generated.
 */
export function getPlanSlotSignature(plan) {
  return (Array.isArray(plan?.exercises) ? plan.exercises : [])
    .map((exercise) => `${exercise?.exerciseId ?? ""}:${exercise?.sets ?? ""}`)
    .join("|");
}
