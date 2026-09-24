// Shared helpers for reading logged sets out of a saved session (fix round 2).
// Extracted from src/App.jsx so the "Last time" cue and the History card can
// be covered by a Node fixture (scripts/verify-session-log.mjs).

export function isBodyweightText(value) {
  const cleanValue = String(value ?? "").trim().toLowerCase();
  return cleanValue === "bw" || cleanValue === "bodyweight" || cleanValue === "body weight";
}

/**
 * A logged weight: a finite number of kg, "BW", or null when nothing was
 * logged. An untouched set slot is stored with `weight: null`; it is never
 * 0 kg (Number(null) === 0 is the bug this guards against), so averages and
 * "Last time" cues only see weights the athlete actually entered.
 */
export function normalizeWeight(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    const cleanValue = value.trim();
    if (!cleanValue) {
      return null;
    }

    if (isBodyweightText(cleanValue)) {
      return "BW";
    }
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isLoggedRepValue(value) {
  return value !== null && value !== undefined && value !== "";
}

/**
 * Reps of the sets that were actually logged, in order. Empty slots
 * (reps null / "") are skipped rather than read as 0.
 */
export function getLoggedReps(sets) {
  return (Array.isArray(sets) ? sets : [])
    .filter((set) => set && typeof set === "object" && isLoggedRepValue(set.reps))
    .map((set) => Number(set.reps))
    .filter(Number.isFinite);
}

export function getNumericSetWeights(sets) {
  return (Array.isArray(sets) ? sets : [])
    .map((set) => normalizeWeight(set?.weight))
    .filter((weight) => typeof weight === "number");
}

/** Mean of the numeric logged weights, or null when no set carries a number. */
export function getAverageNumericWeight(sets) {
  const weights = getNumericSetWeights(sets);

  if (!weights.length) {
    return null;
  }

  return weights.reduce((total, weight) => total + weight, 0) / weights.length;
}

/**
 * Sessions store the day type as `dayType` (saveWorkout); `type` is read as a
 * legacy fallback only. Recovery sessions have no exercises to edit.
 */
export function isRecoverySession(session) {
  return (session?.dayType ?? session?.type) === "recovery";
}
