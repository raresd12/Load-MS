// Set entry by measurement (Phase H5, UI track; decision H5-13 and H5-1).
//
// The Workout Log draft keeps ONE count field per measurement: `reps` for a
// reps exercise, `seconds` for a timed one, `meters` for a distance one
// (the other two stay ""). The exercise's measurement profile
// (src/lib/measurement.js) decides which field the Save Set form edits, how
// it is labelled, which stepper it gets and how a saved set is summarised.
// Weight: a bodyweight exercise logs "BW" without a field; an optional
// external load shows a "+kg" field whose blank value means BW; a per
// dumbbell exercise is labelled so and its totals line says "x2 for volume".
// Everything here is pure and keeps old reps-only drafts readable.
// Fixture: scripts/verify-ui-h5-set-entry.mjs.
import { getMeasurementProfile, getMeasurementTargetRange, formatMeasurementRange } from "./measurement.js";
import { isBodyweightText } from "./sessionLog.js";
import {
  getRecommendedSetEntryDefaults,
  isBlank,
  isValidRpeValue,
  isValidWeightEntry,
} from "./sessionNormalize.js";

export const SET_VALUE_KEYS = Object.freeze({ reps: "reps", time: "seconds", distance: "meters" });
export const SET_VALUE_STEPS = Object.freeze({ reps: 1, time: 5, distance: 10 });
export const SET_VALUE_NOUNS = Object.freeze({ reps: "reps", time: "seconds", distance: "meters" });
export const SET_VALUE_LABELS = Object.freeze({ reps: "Reps", time: "Seconds", distance: "Meters" });
export const PER_SIDE_NOTE = "Per side: log one side; both sides count for volume.";
export const PER_DUMBBELL_NOTE = "Per dumbbell: log one dumbbell; x2 for volume.";
export const ADDITIONAL_LOAD_NOTE = "+kg is load added to bodyweight; blank means BW.";
// Weight mode "additional load" on a load type that needs a number
// (`external`): blank / BW is not a valid entry there (isValidWeightEntry),
// so the hint must not promise it (decision H5-55).
export const REQUIRED_ADDITIONAL_LOAD_NOTE = "+kg is load added to bodyweight; enter the added kg (0 for none).";
export const BODYWEIGHT_NOTE = "Bodyweight: reps count, no kg volume.";

function text(value) {
  return isBlank(value) ? "" : String(value);
}

/**
 * The measurement / load profile of a day view model exercise (or a stored
 * record): { measurement, unit, perSide, loadType, weightMode, inferred }.
 */
export function getSetEntryProfile(exercise) {
  return getMeasurementProfile(exercise ?? {});
}

/** The draft set field that holds the count for this profile. */
export function getSetValueKey(profile) {
  return SET_VALUE_KEYS[profile?.measurement] ?? "reps";
}

/**
 * The count a draft set holds in the exercise's measurement, as text ("" when
 * nothing is logged). A reps-only set of a timed / distance exercise (logged
 * before H5) is NOT read as seconds / meters: it stays a reps set (H5-1).
 */
export function readDraftSetValue(set, profile) {
  const key = getSetValueKey(profile);
  return text(set?.[key]);
}

/** True when any count, weight or RPE is logged on the draft set. */
export function hasSetEntryValue(set) {
  return (
    !isBlank(set?.reps) ||
    !isBlank(set?.seconds) ||
    !isBlank(set?.meters) ||
    !isBlank(set?.weight) ||
    !isBlank(set?.rpe)
  );
}

export function isSetEntryEmpty(set) {
  return !hasSetEntryValue(set);
}

/**
 * Labels, steppers and notes for the Save Set form of one exercise.
 */
export function getSetEntryLabels(profile) {
  const measurement = profile?.measurement ?? "reps";
  const bodyweightOnly = profile?.loadType === "bodyweight";
  const optionalLoad = profile?.loadType === "optionalExternal";
  const perDumbbell = profile?.weightMode === "per dumbbell";
  const additional = profile?.weightMode === "additional load";
  const notes = [];

  if (profile?.perSide) {
    notes.push(PER_SIDE_NOTE);
  }

  if (perDumbbell) {
    notes.push(PER_DUMBBELL_NOTE);
  }

  if (optionalLoad) {
    notes.push(ADDITIONAL_LOAD_NOTE);
  } else if (additional && !bodyweightOnly) {
    notes.push(REQUIRED_ADDITIONAL_LOAD_NOTE);
  }

  if (bodyweightOnly) {
    notes.push(BODYWEIGHT_NOTE);
  }

  return {
    measurement,
    unit: profile?.unit ?? "reps",
    valueKey: getSetValueKey(profile),
    valueLabel: SET_VALUE_LABELS[measurement] ?? "Reps",
    valueNoun: SET_VALUE_NOUNS[measurement] ?? "reps",
    valueHint: profile?.perSide ? "per side" : "",
    valueStep: SET_VALUE_STEPS[measurement] ?? 1,
    valuePlaceholder: measurement === "time" ? "sec" : measurement === "distance" ? "m" : "reps",
    showWeightInput: !bodyweightOnly,
    weightLabel: optionalLoad || additional ? "+kg" : "Kg",
    weightHint: perDumbbell ? "per dumbbell" : optionalLoad ? "optional" : additional ? "added" : "",
    weightPlaceholder: optionalLoad ? "BW" : additional ? "+kg" : perDumbbell ? "kg each" : "kg",
    weightInputType: "number",
    weightInputMode: "decimal",
    bodyweightLabel: bodyweightOnly ? "BW" : null,
    notes,
  };
}

function formWeightFromStored(weight, profile) {
  if (profile?.loadType === "bodyweight") {
    return "";
  }

  if (profile?.loadType === "optionalExternal" && isBodyweightText(weight)) {
    return "";
  }

  return text(weight);
}

/**
 * Form defaults { value, weight, rpe } for a set slot: the plan's minimum of
 * the range (the engine's next time / distance range lands here too), the
 * recommended load, the target RPE. A bodyweight / optional load without a
 * number shows a blank "+kg" (meaning BW).
 */
export function getSetEntryDefaults(exercise, planExercise, profile = getSetEntryProfile(exercise)) {
  const defaults = getRecommendedSetEntryDefaults(exercise ?? {}, planExercise);
  let value = defaults.reps;

  if (profile.measurement !== "reps" && isBlank(value)) {
    const range = getMeasurementTargetRange(planExercise ?? exercise ?? {});
    value = range.min ?? "";
  }

  return {
    value: text(value),
    weight: formWeightFromStored(defaults.weight, profile),
    rpe: defaults.rpe,
  };
}

/**
 * Form values { value, weight, rpe } of a draft set, or the defaults when the
 * set is untouched.
 */
export function readSetEntryValues(set, defaults, profile) {
  if (!hasSetEntryValue(set)) {
    return defaults;
  }

  return {
    value: readDraftSetValue(set, profile),
    weight: formWeightFromStored(set?.weight, profile),
    rpe: text(set?.rpe),
  };
}

/**
 * The draft set patch for the form values: the count goes to the field of
 * the exercise's measurement and the other two are cleared; a bodyweight
 * exercise stores "BW", an optional / additional load stores "BW" when the
 * "+kg" field is blank.
 */
export function toDraftSetPatch(values, profile) {
  const key = getSetValueKey(profile);
  const weightText = text(values?.weight).trim();
  const bodyweightOnly = profile?.loadType === "bodyweight";
  const optionalLoad = profile?.loadType === "optionalExternal";
  const weight = bodyweightOnly
    ? "BW"
    : optionalLoad && (!weightText || isBodyweightText(weightText) || Number(weightText) === 0)
      ? "BW"
      : weightText;

  return {
    reps: "",
    seconds: "",
    meters: "",
    [key]: text(values?.value).trim(),
    weight,
    rpe: text(values?.rpe).trim(),
  };
}

/**
 * Save Set validation in the exercise's measurement; same leniency as the
 * H4 validateSetEntry (a blank field is fine, validateDraft decides at Save).
 */
export function validateSetEntryValues(values, exercise, profile = getSetEntryProfile(exercise)) {
  const labels = getSetEntryLabels(profile);
  const errors = [];

  if (!isBlank(values?.value)) {
    const parsed = Number(values.value);

    if (!Number.isFinite(parsed) || parsed < 0) {
      errors.push(`${labels.valueLabel} must be 0 or higher.`);
    }
  }

  if (labels.showWeightInput && !isBlank(values?.weight)) {
    const weightText = String(values.weight).trim();
    const valid =
      profile?.loadType === "optionalExternal"
        ? isBodyweightText(weightText) || (Number.isFinite(Number(weightText)) && Number(weightText) >= 0)
        : isValidWeightEntry(weightText, exercise ?? {});

    if (!valid) {
      errors.push(profile?.loadType === "optionalExternal" ? "+kg must be a number or blank." : "Kg must be a valid number or BW.");
    }
  }

  if (!isBlank(values?.rpe) && !isValidRpeValue(values.rpe)) {
    errors.push("Set RPE must be 1-10 in .5 steps.");
  }

  return errors;
}

/** "60kg", "BW", "12.5kg"; "kg?" / "BW?" when nothing is logged. */
export function formatSetWeightText(weight, profile) {
  if (isBlank(weight)) {
    return profile?.loadType === "bodyweight" || profile?.loadType === "optionalExternal" ? "BW?" : "kg?";
  }

  if (isBodyweightText(weight)) {
    return "BW";
  }

  const numericWeight = Number(weight);

  if (!Number.isFinite(numericWeight)) {
    return String(weight);
  }

  const formatted = Number.isInteger(numericWeight) ? numericWeight.toString() : numericWeight.toFixed(1);
  const suffix = profile?.weightMode === "additional load" || profile?.loadType === "optionalExternal" ? "kg added" : "kg";
  return `${formatted}${suffix}`;
}

/** "10", "10/side", "30 s", "400 m"; "?" when nothing is logged. */
export function formatSetValueText(set, profile) {
  const key = getSetValueKey(profile);
  const value = set?.[key];

  if (isBlank(value)) {
    // A reps-only set of a timed / distance exercise stays reps (H5-1).
    if (key !== "reps" && !isBlank(set?.reps)) {
      return `${set.reps} reps`;
    }

    return "?";
  }

  const unit = profile?.unit ?? "reps";
  const base = unit === "reps" ? String(value) : `${value} ${unit}`;
  return profile?.perSide ? `${base}/side` : base;
}

/** "S1 60kg x 10/side @8", "S2 BW x 30 s @7", "S3 empty". */
export function formatSetEntrySummary(set, index, profile) {
  const prefix = `S${index + 1}`;

  if (isSetEntryEmpty(set)) {
    return `${prefix} empty`;
  }

  return `${prefix} ${formatSetWeightText(set?.weight, profile)} x ${formatSetValueText(set, profile)} @${isBlank(set?.rpe) ? "?" : set.rpe}`;
}

/**
 * The target of a plan entry in the exercise's measurement: "8-12",
 * "10/side", "30 s", "35-50 s/side"; falls back to the plan's label.
 */
export function formatSetTargetLabel(planExercise, profile) {
  const source = planExercise ?? {};
  const range = formatMeasurementRange({
    min: source.repsMin,
    max: source.repsMax,
    unit: profile?.unit ?? "reps",
    perSide: Boolean(profile?.perSide),
  });

  if (range) {
    return range;
  }

  const label = text(source.repsLabel).trim();

  if (!label) {
    return "";
  }

  return profile?.perSide && !/side|each|per\b|unilateral/i.test(label) ? `${label}/side` : label;
}

/** "3 sets · 2 logged · x2 for volume" style totals line under the saved sets. */
export function formatSetEntryTotals(sets, profile) {
  const list = Array.isArray(sets) ? sets : [];
  const logged = list.filter((set) => !isSetEntryEmpty(set)).length;
  const parts = [`${logged} of ${list.length} sets logged`];

  if (profile?.weightMode === "per dumbbell") {
    parts.push("per dumbbell, x2 for volume");
  }

  if (profile?.perSide) {
    parts.push("per side, both sides count");
  }

  return parts.join(" | ");
}
