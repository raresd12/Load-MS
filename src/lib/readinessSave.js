/**
 * Readiness check-in save (H1 follow-up (a), decision H2-19).
 *
 * The decision whether the Readiness page may report success is taken here,
 * from the checked storage write, so it has a fixture instead of a source
 * text check: `ok` only after the write succeeded, otherwise an error message
 * and the UNCHANGED readiness map so the form keeps the user's values.
 * `write(value)` is the injected storage writer (App passes
 * `writeStorage(STORAGE_KEYS.readinessByDate, value)`); it returns
 * `{ ok, error }` like `writeStorage`.
 */
export const READINESS_SAVED_MESSAGE = "Today's readiness saved.";
export const READINESS_SCHEMA_VERSION = 1;

/**
 * The readiness map with today's entry added or replaced. `savedAt` of an
 * existing entry for the same date is kept; `updatedAt` is `now`.
 */
export function buildReadinessCheckIn({ readinessByDate, dateKey, wellness, readiness, now }) {
  const current = readinessByDate && typeof readinessByDate === "object" ? readinessByDate : {};
  const previous = current[dateKey] ?? null;

  return {
    ...current,
    [dateKey]: {
      schemaVersion: READINESS_SCHEMA_VERSION,
      date: dateKey,
      savedAt: previous?.savedAt ?? now,
      updatedAt: now,
      wellness,
      readiness,
    },
  };
}

/**
 * Save today's check-in through `write`. Returns
 * `{ ok: true, readinessByDate: <next map>, message }` after a successful
 * write, or `{ ok: false, readinessByDate: <input map>, message, error }`
 * when the write was refused or threw; nothing is reported as saved before
 * the writer said so.
 */
export function saveReadinessCheckIn({ readinessByDate, dateKey, wellness, readiness, now, write }) {
  const next = buildReadinessCheckIn({ readinessByDate, dateKey, wellness, readiness, now });
  let result;

  try {
    result = typeof write === "function" ? write(next) : { ok: false, error: "No storage writer." };
  } catch (error) {
    result = { ok: false, error: error?.message || "Storage write failed." };
  }

  if (!result || result.ok !== true) {
    const error = result?.error || "Storage write failed.";

    return {
      ok: false,
      readinessByDate: readinessByDate && typeof readinessByDate === "object" ? readinessByDate : {},
      message: `Today's readiness could not be saved: ${error} Your check-in is still in the form.`,
      error,
    };
  }

  return { ok: true, readinessByDate: next, message: READINESS_SAVED_MESSAGE, error: null };
}
