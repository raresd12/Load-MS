// Hold and manual override (Phase H5, decision H5-6).
//
// Collection STORAGE_KEYS.programOverrides ("rpe-tracker.program-overrides.v1"):
// records { id: "override:<programExerciseId>", programId, programExerciseId,
//   mode: "hold" | "manual", prescription: { targetWeight?, targetReps?
//   { min, max, label }, targetSets?, targetRPE? } | null,
//   remainingSessions: 1-6 | null, untilDate: ISO date | null, note,
//   createdAt, updatedAt }.
//
// "hold": the engine freezes the exercise (plan = current prescription,
// decision "hold", reason "Held by you") and writes no progression evidence
// for it; sessions are still logged normally. "manual": the fields the record
// sets win over every other prescription source; the engine keeps evaluating
// the logged sessions. persistWorkoutSave (programStorage.js) decrements
// `remainingSessions` for exercises logged in a saved session and deletes
// the record at 0 or past `untilDate`; a target edit or an applied draft
// prescription change clears the override for that exercise. History,
// sessions and baselines are never rewritten by any of this.
//
// Writers here use the H1 checked write (new-U): a corrupt key refuses the
// write and nothing is written.
import { readStorage, readStorageResult, STORAGE_KEYS, writeStorage } from "./storage.js";

export const OVERRIDE_MODES = Object.freeze(["hold", "manual"]);
export const MIN_OVERRIDE_SESSIONS = 1;
export const MAX_OVERRIDE_SESSIONS = 6;
export const HOLD_REASON = "Held by you";

function isNullish(value) {
  return value === null || value === undefined;
}

function toFiniteNumber(value) {
  if (isNullish(value) || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toTimestamp(value) {
  if (isNullish(value) || value === "") {
    return null;
  }

  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export function makeOverrideId(programExerciseId) {
  return `override:${programExerciseId}`;
}

function isHalfStepRpe(value) {
  return Number.isFinite(value) && value >= 1 && value <= 10 && Number.isInteger(value * 2);
}

function isValidOverrideWeight(value) {
  if (isNullish(value)) {
    return true;
  }

  if (typeof value === "string") {
    return value.trim().toLowerCase() === "bw";
  }

  return Number.isFinite(value) && value >= 0;
}

/**
 * validateExerciseOverride(record) -> { valid, errors }
 * Checks the shape above. A manual override needs at least one prescription
 * field; a hold carries none.
 */
export function validateExerciseOverride(record) {
  const errors = [];

  if (!record || typeof record !== "object") {
    return { valid: false, errors: ["Override must be an object."] };
  }

  if (!record.programId) {
    errors.push("Override needs a programId.");
  }

  if (!record.programExerciseId) {
    errors.push("Override needs a programExerciseId.");
  }

  if (!OVERRIDE_MODES.includes(record.mode)) {
    errors.push(`Override mode must be one of ${OVERRIDE_MODES.join(", ")}.`);
  }

  const remaining = record.remainingSessions;

  if (
    !isNullish(remaining) &&
    !(Number.isInteger(remaining) && remaining >= MIN_OVERRIDE_SESSIONS && remaining <= MAX_OVERRIDE_SESSIONS)
  ) {
    errors.push(`Remaining sessions must be a whole number from ${MIN_OVERRIDE_SESSIONS} to ${MAX_OVERRIDE_SESSIONS}, or empty.`);
  }

  if (!isNullish(record.untilDate) && toTimestamp(record.untilDate) === null) {
    errors.push("Until date must be an ISO date or empty.");
  }

  const prescription = record.prescription;

  if (!isNullish(prescription) && typeof prescription !== "object") {
    errors.push("Override prescription must be an object.");
  } else if (prescription) {
    if (!isValidOverrideWeight(prescription.targetWeight)) {
      errors.push('Override weight must be empty, a number of kg (0 or more) or "BW".');
    }

    const sets = prescription.targetSets;

    if (!isNullish(sets) && !(Number.isInteger(sets) && sets >= 1 && sets <= 30)) {
      errors.push("Override sets must be a whole number from 1 to 30.");
    }

    if (!isNullish(prescription.targetRPE) && !isHalfStepRpe(prescription.targetRPE)) {
      errors.push("Override RPE must be 1-10 in .5 steps.");
    }

    const reps = prescription.targetReps;

    if (!isNullish(reps)) {
      if (typeof reps !== "object") {
        errors.push("Override reps must be { min, max, label }.");
      } else {
        const min = toFiniteNumber(reps.min);
        const max = toFiniteNumber(reps.max);

        if (!isNullish(reps.min) && (min === null || min <= 0)) {
          errors.push("Override minimum reps must be a positive number.");
        }

        if (!isNullish(reps.max) && (max === null || max <= 0)) {
          errors.push("Override maximum reps must be a positive number.");
        }

        if (min !== null && max !== null && min > max) {
          errors.push("Override minimum reps cannot exceed maximum reps.");
        }
      }
    }
  }

  if (record.mode === "manual" && !hasPrescriptionValues(prescription)) {
    errors.push("A manual override needs at least one prescription value.");
  }

  return { valid: !errors.length, errors };
}

export function hasPrescriptionValues(prescription) {
  if (!prescription || typeof prescription !== "object") {
    return false;
  }

  const reps = prescription.targetReps;
  const hasReps =
    reps && typeof reps === "object" && (!isNullish(reps.min) || !isNullish(reps.max) || Boolean(reps.label));

  return (
    !isNullish(prescription.targetWeight) ||
    !isNullish(prescription.targetSets) ||
    !isNullish(prescription.targetRPE) ||
    Boolean(hasReps)
  );
}

/**
 * Active = well formed, sessions left (or open-ended) and not past the until
 * date at `now` (Date, ISO string or epoch ms; the until date counts to the
 * end of its calendar day in UTC).
 */
export function isOverrideActive(record, now = null) {
  if (!record || typeof record !== "object" || !OVERRIDE_MODES.includes(record.mode)) {
    return false;
  }

  if (!isNullish(record.remainingSessions) && !(record.remainingSessions >= 1)) {
    return false;
  }

  if (!isNullish(record.untilDate) && now !== null) {
    const until = toTimestamp(record.untilDate);
    const reference = toTimestamp(now);

    if (until !== null && reference !== null && reference > until + 24 * 60 * 60 * 1000 - 1) {
      return false;
    }
  }

  return true;
}

/**
 * "Manual override (2 sessions left)", "Manual override (until 2026-10-14)",
 * "On hold", "On hold (1 session left)".
 */
export function describeOverride(record) {
  if (!record || !OVERRIDE_MODES.includes(record.mode)) {
    return "";
  }

  const label = record.mode === "hold" ? "On hold" : "Manual override";
  const parts = [];

  if (Number.isFinite(record.remainingSessions)) {
    parts.push(`${record.remainingSessions} ${record.remainingSessions === 1 ? "session" : "sessions"} left`);
  }

  if (record.untilDate) {
    parts.push(`until ${String(record.untilDate).slice(0, 10)}`);
  }

  return parts.length ? `${label} (${parts.join(", ")})` : label;
}

/**
 * The prescription fields a manual record sets, in resolver shape
 * ({ sets, repsMin, repsMax, repsLabel, targetRPE, weight }); every field
 * the record leaves empty is undefined so the next source fills it. A hold
 * sets nothing.
 */
export function getOverridePrescriptionFields(record) {
  if (!record || record.mode !== "manual" || !record.prescription) {
    return {};
  }

  const prescription = record.prescription;
  const reps = prescription.targetReps && typeof prescription.targetReps === "object" ? prescription.targetReps : null;
  const fields = {};

  if (!isNullish(prescription.targetSets)) {
    fields.sets = prescription.targetSets;
  }

  if (reps) {
    if (!isNullish(reps.min)) {
      fields.repsMin = reps.min;
    }

    if (!isNullish(reps.max)) {
      fields.repsMax = reps.max;
    }

    if (reps.label) {
      fields.repsLabel = String(reps.label);
    } else if (!isNullish(reps.min) && !isNullish(reps.max)) {
      fields.repsLabel = Number(reps.min) === Number(reps.max) ? String(reps.min) : `${reps.min}-${reps.max}`;
    }
  }

  if (!isNullish(prescription.targetRPE)) {
    fields.targetRPE = prescription.targetRPE;
  }

  if (!isNullish(prescription.targetWeight)) {
    fields.weight = prescription.targetWeight;
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Pure list helpers (used by programStorage.js inside its batches).
// ---------------------------------------------------------------------------

export function findOverrideRecord(records, programExerciseId, programId = null) {
  return (
    (Array.isArray(records) ? records : []).find(
      (record) =>
        record &&
        record.programExerciseId === programExerciseId &&
        (programId === null || record.programId === programId),
    ) ?? null
  );
}

/**
 * Removes the records of the given program exercise ids. Returns
 * { records, removed } with a NEW array only when something was removed.
 */
export function removeOverrideRecords(records, programExerciseIds, programId = null) {
  const list = Array.isArray(records) ? records : [];
  const ids = new Set(Array.isArray(programExerciseIds) ? programExerciseIds.map(String) : []);
  const next = list.filter(
    (record) =>
      !(
        record &&
        ids.has(String(record.programExerciseId)) &&
        (programId === null || record.programId === programId)
      ),
  );

  return { records: next.length === list.length ? list : next, removed: list.length - next.length };
}

/**
 * One saved session of `programId` at `sessionDate`: every active record of
 * the program whose exercise is in `loggedProgramExerciseIds` loses one
 * remaining session; a record at 0 or past its until date is deleted.
 * Returns { records, changed, expired } (records is the same array when
 * nothing changed).
 */
export function consumeOverrideSessions(records, { programId, loggedProgramExerciseIds, sessionDate, updatedAt }) {
  const list = Array.isArray(records) ? records : [];
  const logged = new Set((loggedProgramExerciseIds ?? []).map(String));
  const expired = [];
  let changed = false;

  const next = list
    .map((record) => {
      if (!record || record.programId !== programId) {
        return record;
      }

      let updated = record;

      if (logged.has(String(record.programExerciseId)) && Number.isFinite(record.remainingSessions)) {
        updated = { ...record, remainingSessions: record.remainingSessions - 1, updatedAt: updatedAt ?? record.updatedAt };
        changed = true;
      }

      if (!isOverrideActive(updated, sessionDate ?? null)) {
        expired.push(updated.programExerciseId);
        changed = true;
        return null;
      }

      return updated;
    })
    .filter(Boolean);

  return { records: changed ? next : list, changed, expired };
}

// ---------------------------------------------------------------------------
// Storage accessors and checked writers.
// ---------------------------------------------------------------------------

function readOverrides() {
  const stored = readStorage(STORAGE_KEYS.programOverrides, []);
  return Array.isArray(stored) ? stored.filter((record) => record && typeof record === "object") : [];
}

export function getExerciseOverrides(programId = null) {
  const records = readOverrides();
  return programId === null ? records : records.filter((record) => record.programId === programId);
}

/**
 * The stored record for a program exercise, or null. Expiry by date is not
 * applied here (pass `now` to isOverrideActive for that).
 */
export function getExerciseOverride(programExerciseId, programId = null) {
  return findOverrideRecord(readOverrides(), programExerciseId, programId);
}

/**
 * setExerciseOverrideChecked(record) -> { ok: true, record } or
 * { ok: false, error, errors?, code? }. Upserts by programExerciseId; the id,
 * createdAt (kept from an existing record) and updatedAt are enforced. A
 * corrupt overrides key refuses the write (code "corrupt").
 */
export function setExerciseOverrideChecked(record, { now = new Date() } = {}) {
  const validation = validateExerciseOverride(record);

  if (!validation.valid) {
    return { ok: false, error: validation.errors.join(" "), errors: validation.errors, code: "invalid" };
  }

  const stored = readStorageResult(STORAGE_KEYS.programOverrides, []);

  if (stored.corrupt) {
    return {
      ok: false,
      error: "Stored overrides are unreadable, so nothing was written.",
      code: "corrupt",
      failedKey: STORAGE_KEYS.programOverrides,
    };
  }

  const records = Array.isArray(stored.value) ? stored.value.filter((entry) => entry && typeof entry === "object") : [];
  const existing = findOverrideRecord(records, record.programExerciseId, record.programId);
  const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const nextRecord = {
    id: makeOverrideId(record.programExerciseId),
    programId: record.programId,
    programExerciseId: record.programExerciseId,
    mode: record.mode,
    prescription: record.mode === "manual" && record.prescription ? { ...record.prescription } : null,
    remainingSessions: isNullish(record.remainingSessions) ? null : record.remainingSessions,
    untilDate: isNullish(record.untilDate) ? null : String(record.untilDate),
    note: String(record.note ?? "").trim(),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  const next = existing
    ? records.map((entry) => (entry === existing ? nextRecord : entry))
    : [...records, nextRecord];
  const writeResult = writeStorage(STORAGE_KEYS.programOverrides, next);

  if (!writeResult.ok) {
    return { ok: false, error: writeResult.error, code: writeResult.code, failedKey: STORAGE_KEYS.programOverrides };
  }

  return { ok: true, record: nextRecord };
}

/**
 * clearExerciseOverrideChecked(programExerciseId) -> { ok: true, removed }
 * or { ok: false, error, code }. Nothing is written when no record exists.
 */
export function clearExerciseOverrideChecked(programExerciseId, programId = null) {
  const stored = readStorageResult(STORAGE_KEYS.programOverrides, []);

  if (stored.corrupt) {
    return {
      ok: false,
      error: "Stored overrides are unreadable, so nothing was written.",
      code: "corrupt",
      failedKey: STORAGE_KEYS.programOverrides,
    };
  }

  const records = Array.isArray(stored.value) ? stored.value : [];
  const { records: next, removed } = removeOverrideRecords(records, [programExerciseId], programId);

  if (!removed) {
    return { ok: true, removed: false };
  }

  const writeResult = writeStorage(STORAGE_KEYS.programOverrides, next);

  if (!writeResult.ok) {
    return { ok: false, error: writeResult.error, code: writeResult.code, failedKey: STORAGE_KEYS.programOverrides };
  }

  return { ok: true, removed: true };
}
