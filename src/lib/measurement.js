// Measurement semantics (Phase H5, decision H5-1; handoff 19.4-4 / 19.4-5).
//
// A ProgramExercise may persist `measurement` ("reps" | "time" | "distance",
// default "reps") and `perSide` (boolean, default false) next to the H2-2
// `loadType` / `weightMode`. Records without the fields are inferred from the
// reps label ("30 s", "400 m", "10/side", "each leg") so legacy programs need
// no migration. Everything here is pure; nothing reads storage.
//
// Set shape: a reps set stores `reps`, a timed set stores `seconds`, a
// distance set stores `meters` (weight / rpe / completed as before). An old
// session whose sets carry only `reps` stays a reps set whatever the exercise
// profile says: the value is never re-labelled as seconds or meters.
//
// Volume conventions (19.4-5): a per-dumbbell weight counts BOTH dumbbells
// for tonnage (x2) while e1RM keeps the per-dumbbell value; per-side reps
// count both sides for volume (x2) and the set value stays per side;
// bodyweight sets contribute reps but no tonnage (no body mass is known);
// additional load counts only the added load and is labelled so (no tonnage;
// its e1RM is the e1RM of the ADDED load, decision H5-29 / 19.4-6); timed and
// distance sets never produce e1RM or tonnage, only total seconds / meters.
// Missing data yields null, never 0.

export const MEASUREMENTS = Object.freeze(["reps", "time", "distance"]);
export const DEFAULT_MEASUREMENT = "reps";

export const MEASUREMENT_UNITS = Object.freeze({
  reps: "reps",
  time: "s",
  distance: "m",
});

export const LOAD_KINDS = Object.freeze({
  external: "external",
  additional: "additional",
  bodyweight: "bodyweight",
  none: "none",
});

const TIME_UNIT = /^(s|sec|secs|second|seconds|min|mins|minute|minutes|m(?=in)|")$/i;
const DISTANCE_UNIT = /^(m|meter|meters|metre|metres|km|kilometer|kilometers|kilometre|kilometres|mi|mile|miles)$/i;
const PER_SIDE_PATTERN =
  /(?:\/\s*(?:side|leg|arm|hand)\b|\bper\s+(?:side|leg|arm|hand)\b|\beach\s+(?:side|leg|arm|hand)\b|\be\.?s\.?\b|\bunilateral\b|\bpe\s+(?:parte|picior|bra[țt])\b|\bfiecare\s+(?:parte|picior|bra[țt])\b)/i;
const NUMBER = "(\\d+(?:[.,]\\d+)?)";
// The unit group ends on a non-letter (not `\b`): a closing inch mark in
// coaching notation ('45"', '30-45"') has no word boundary after it, and a
// trailing `\b` made the optional unit backtrack to empty (H5 fix round 1).
const RANGE_WITH_UNIT = new RegExp(`^\\s*${NUMBER}\\s*(?:-|–|to|la)\\s*${NUMBER}\\s*([a-z"]+)?(?![a-z])`, "i");
const SINGLE_WITH_UNIT = new RegExp(`^\\s*${NUMBER}\\s*([a-z"]+)?(?![a-z])`, "i");
const CLOCK_PATTERN = /^\s*(\d{1,2}):(\d{2})(?:\s*(?:-|–|to)\s*(\d{1,2}):(\d{2}))?\b/;

function toNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  // A whitespace-only string is blank, not 0 (Number(" ") === 0).
  if (typeof value === "string" && value.trim() === "") {
    return null;
  }

  const parsed = Number(typeof value === "string" ? value.replace(",", ".") : value);
  return Number.isFinite(parsed) ? parsed : null;
}

function unitToSeconds(value, unit) {
  return /^m(in|ins|inute|inutes)?$/i.test(unit) ? value * 60 : value;
}

function unitToMeters(value, unit) {
  if (/^k/i.test(unit)) {
    return value * 1000;
  }

  if (/^mi/i.test(unit)) {
    return Math.round(value * 1609.344);
  }

  return value;
}

export function isValidMeasurement(value) {
  return MEASUREMENTS.includes(value);
}

/**
 * True when a reps label names a side ("10/side", "each leg", "per arm").
 */
export function inferPerSideFromLabel(label) {
  return PER_SIDE_PATTERN.test(String(label ?? ""));
}

/**
 * inferMeasurementFromLabel(label) -> { measurement, unit, min, max }
 *
 * "30 s" -> time, 30-30 s; "45-60 sec" -> time, 45-60 s; "2 min" -> time,
 * 120 s; "0:45" -> time, 45 s; "400 m" -> distance, 400 m; "1 km" -> distance,
 * 1000 m. A label that starts with a count and no time / distance unit
 * ("8-12", "10 reps, 3 s pause", "8-12 per side", "AMRAP") is reps with the
 * numbers it starts with (min / max null when there are none).
 */
export function inferMeasurementFromLabel(label) {
  const text = String(label ?? "").trim();
  const reps = { measurement: "reps", unit: MEASUREMENT_UNITS.reps, min: null, max: null };

  if (!text) {
    return reps;
  }

  const clock = text.match(CLOCK_PATTERN);

  if (clock) {
    const min = Number(clock[1]) * 60 + Number(clock[2]);
    const max = clock[3] ? Number(clock[3]) * 60 + Number(clock[4]) : min;
    return { measurement: "time", unit: MEASUREMENT_UNITS.time, min, max };
  }

  const range = text.match(RANGE_WITH_UNIT);
  const single = range ? null : text.match(SINGLE_WITH_UNIT);
  const match = range ?? single;

  if (!match) {
    return reps;
  }

  const first = toNumber(match[1]);
  const second = range ? toNumber(match[2]) : first;
  const unit = (range ? match[3] : match[2]) ?? "";

  if (unit && TIME_UNIT.test(unit)) {
    return {
      measurement: "time",
      unit: MEASUREMENT_UNITS.time,
      min: unitToSeconds(first, unit),
      max: unitToSeconds(second, unit),
    };
  }

  if (unit && DISTANCE_UNIT.test(unit)) {
    return {
      measurement: "distance",
      unit: MEASUREMENT_UNITS.distance,
      min: unitToMeters(first, unit),
      max: unitToMeters(second, unit),
    };
  }

  return { ...reps, min: first, max: second };
}

/**
 * getMeasurementProfile(programExercise) ->
 *   { measurement, unit, perSide, loadType, weightMode, inferred }
 *
 * Accepts a stored ProgramExercise (targetReps.label, loadType, weightMode)
 * or a day view model exercise (repsLabel). Persisted valid fields win; the
 * label is the fallback. `inferred` says which of measurement / perSide came
 * from the label rather than a stored field.
 */
export function getMeasurementProfile(programExercise = {}) {
  const source = programExercise && typeof programExercise === "object" ? programExercise : {};
  const label = source.targetReps?.label ?? source.repsLabel ?? null;
  const fromLabel = inferMeasurementFromLabel(label);
  const measurement = isValidMeasurement(source.measurement) ? source.measurement : fromLabel.measurement;
  const perSide = typeof source.perSide === "boolean" ? source.perSide : inferPerSideFromLabel(label);

  return {
    measurement,
    unit: MEASUREMENT_UNITS[measurement],
    perSide,
    loadType: source.loadType ?? "external",
    weightMode: source.weightMode ?? "kg",
    inferred: {
      measurement: !isValidMeasurement(source.measurement),
      perSide: typeof source.perSide !== "boolean",
    },
  };
}

/**
 * The numeric target range of an exercise in the measurement unit: stored
 * min / max when present, otherwise what the label says ("30 s" -> 30-30).
 * Returns { min, max } with nulls when nothing is known.
 */
export function getMeasurementTargetRange(programExercise = {}) {
  const source = programExercise && typeof programExercise === "object" ? programExercise : {};
  const min = toNumber(source.repsMin ?? source.targetReps?.min);
  const max = toNumber(source.repsMax ?? source.targetReps?.max);

  if (min !== null || max !== null) {
    return { min, max };
  }

  const fromLabel = inferMeasurementFromLabel(source.targetReps?.label ?? source.repsLabel ?? null);
  return { min: fromLabel.min, max: fromLabel.max };
}

function normalizeWeightValue(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "string") {
    const text = value.trim().toLowerCase();

    if (text === "bw" || text === "bodyweight") {
      return "BW";
    }
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * normalizeSetEntry(set, profile) ->
 *   { measurement, unit, value, reps, seconds, meters, weight, rpe, completed }
 *
 * `value` is the set's count in its own measurement: seconds for a timed set
 * (set.seconds), meters for a distance set (set.meters), reps otherwise. A
 * set of a timed / distance exercise that only carries `reps` (logged before
 * H5) stays a reps set: `measurement` says "reps" and nothing is relabelled.
 * Missing values are null. `completed` is set.completed when stored, else a
 * positive value.
 */
export function normalizeSetEntry(set, profile = getMeasurementProfile()) {
  const entry = set && typeof set === "object" ? set : {};
  const seconds = toNumber(entry.seconds ?? entry.actualSeconds);
  const meters = toNumber(entry.meters ?? entry.actualMeters);
  const reps = toNumber(entry.reps ?? entry.actualReps);
  const target = profile?.measurement ?? DEFAULT_MEASUREMENT;
  let measurement = "reps";
  let value = reps;

  if (target === "time" && seconds !== null) {
    measurement = "time";
    value = seconds;
  } else if (target === "distance" && meters !== null) {
    measurement = "distance";
    value = meters;
  } else if (reps === null) {
    measurement = seconds !== null ? "time" : meters !== null ? "distance" : target;
    value = seconds ?? meters ?? null;
  }

  const rpe = toNumber(entry.rpe ?? entry.actualRPE);

  return {
    measurement,
    unit: MEASUREMENT_UNITS[measurement],
    value,
    reps,
    seconds,
    meters,
    weight: normalizeWeightValue(entry.weight ?? entry.actualWeight ?? entry.kg),
    rpe,
    completed: entry.completed === true || (value !== null && value > 0),
  };
}

/**
 * getSetLoadForVolume(set, profile) ->
 *   { kind, tonnage, countedSides, countedDumbbells, value, totalValue, unit,
 *     measurement, weight, e1rmWeight, e1rmReps }
 *
 * kind: "external" (a numeric load in kg or per dumbbell), "additional"
 * (added load on a bodyweight movement), "bodyweight" (BW, or a bodyweight
 * exercise) or "none" (no load logged).
 * tonnage: weight x dumbbells x reps x sides for a reps set with an external
 * load; null for additional load, bodyweight, timed and distance sets.
 * value / totalValue: the set value per side and the total over both sides
 * (a 30 s side plank per side is 60 s in total).
 * e1rmWeight / e1rmReps: the load a strength estimate may use (the
 * per-dumbbell external load, or the ADDED load of an additional-load set)
 * and its reps; both null whenever the load kind allows no estimate
 * (bodyweight, no load, timed and distance sets). One policy with
 * sessionAnalytics.getE1rmEligibility (decision H5-29, 19.4-6), which adds
 * the rep-range and RPE gates of a RECORD on top of this load rule.
 */
export function getSetLoadForVolume(set, profile = getMeasurementProfile()) {
  const normalized = normalizeSetEntry(set, profile);
  const perDumbbell = profile?.weightMode === "per dumbbell";
  const additional = profile?.weightMode === "additional load";
  const bodyweightOnly = profile?.loadType === "bodyweight";
  const countedSides = profile?.perSide ? 2 : 1;
  const countedDumbbells = perDumbbell ? 2 : 1;
  const numericWeight = typeof normalized.weight === "number" ? normalized.weight : null;
  let kind = LOAD_KINDS.none;

  if (bodyweightOnly || normalized.weight === "BW") {
    kind = LOAD_KINDS.bodyweight;
  } else if (numericWeight !== null) {
    kind = additional ? LOAD_KINDS.additional : LOAD_KINDS.external;
  }

  const isReps = normalized.measurement === "reps";
  const hasValue = normalized.value !== null;
  const tonnage =
    kind === LOAD_KINDS.external && isReps && hasValue
      ? numericWeight * countedDumbbells * normalized.value * countedSides
      : null;
  const e1rmAllowed =
    (kind === LOAD_KINDS.external || kind === LOAD_KINDS.additional) &&
    isReps &&
    hasValue &&
    numericWeight > 0 &&
    normalized.value > 0;

  return {
    kind,
    tonnage,
    countedSides,
    countedDumbbells,
    measurement: normalized.measurement,
    unit: normalized.unit,
    value: normalized.value,
    totalValue: hasValue ? normalized.value * countedSides : null,
    weight: normalized.weight,
    e1rmWeight: e1rmAllowed ? numericWeight : null,
    e1rmReps: e1rmAllowed ? normalized.value : null,
  };
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

/**
 * "30 s", "35-50 s", "400 m", "10/side", "30 s/side"; null when no value.
 */
export function formatMeasurementRange({ min, max, unit = "reps", perSide = false } = {}) {
  const low = toNumber(min);
  const high = toNumber(max);

  if (low === null && high === null) {
    return null;
  }

  const range =
    low !== null && high !== null && low !== high
      ? `${formatNumber(low)}-${formatNumber(high)}`
      : formatNumber(low ?? high);
  const suffix = unit === "reps" ? "" : ` ${unit}`;

  return `${range}${suffix}${perSide ? "/side" : ""}`;
}
