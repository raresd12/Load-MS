// Program target editor form (H4 fix round 3, decision H4-15). Moved verbatim
// from src/components/program/ProgramPrescriptionEditor.jsx: the form values
// of a ProgramExercise target, their parsers and the validation that turns
// the form into the patch updateProgramExerciseTargetChecked stores.
// Fixture: scripts/verify-program-target-form.mjs.
import { MAX_TARGET_SETS } from "./programStorage.js";
import { formatRestEditorValue, parseRestEditorValue } from "./rest.js";

export function createProgramExerciseTargetForm(exercise) {
  return {
    targetSets: stringifyProgramEditorValue(exercise.sets),
    repsMin: stringifyProgramEditorValue(exercise.repsMin),
    repsMax: stringifyProgramEditorValue(exercise.repsMax),
    repsLabel: getCustomRepsLabelForEditor(exercise),
    targetWeight: stringifyProgramWeightForEditor(exercise.recommendedWeight, exercise),
    targetRPE: stringifyProgramEditorValue(exercise.targetRPE),
    // Decision 19.4-3: a stored range is shown and preserved as "min-max".
    restTime: formatRestEditorValue(exercise.restSeconds),
    notes: exercise.notes ?? "",
  };
}

export function stringifyProgramEditorValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value);
}

export function stringifyProgramWeightForEditor(value, exercise) {
  if (value === null || value === undefined || value === "") {
    return exercise.loadType === "bodyweight" ? "BW" : "";
  }

  return String(value);
}

export function getCustomRepsLabelForEditor(exercise) {
  const label = String(exercise.repsLabel ?? "").trim();
  const derived = getDerivedRepsLabel(exercise.repsMin, exercise.repsMax);

  if (!label || normalizeRepsLabel(label) === normalizeRepsLabel(derived)) {
    return "";
  }

  return label;
}

export function getDerivedRepsLabel(repsMin, repsMax) {
  if (repsMin === null || repsMin === undefined || repsMax === null || repsMax === undefined) {
    return "";
  }

  return Number(repsMin) === Number(repsMax) ? String(repsMin) : `${repsMin}-${repsMax}`;
}

export function normalizeRepsLabel(value) {
  return String(value ?? "")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

export function validateProgramExerciseTargetForm(form, exercise) {
  const errors = [];
  const targetSets = parsePositiveInteger(form.targetSets);
  const repsMin = parseOptionalPositiveNumber(form.repsMin);
  const repsMax = parseOptionalPositiveNumber(form.repsMax);
  const repsLabel = form.repsLabel.trim();
  const targetWeight = parseProgramTargetWeight(form.targetWeight, exercise);
  const targetRPE = parseRpeValue(form.targetRPE);
  // A single number ("90") or a range ("150-180"); ranges are stored as [min, max].
  const restTime = parseRestEditorValue(form.restTime);

  if (targetSets === null || targetSets > MAX_TARGET_SETS) {
    errors.push(`Sets must be a whole number from 1 to ${MAX_TARGET_SETS}.`);
  }

  if (form.repsMin.trim() && repsMin === null) {
    errors.push("Reps min must be a positive number.");
  }

  if (form.repsMax.trim() && repsMax === null) {
    errors.push("Reps max must be a positive number.");
  }

  if (repsMin !== null && repsMax !== null && repsMax < repsMin) {
    errors.push("Reps max should be equal to or above reps min.");
  }

  if (repsMin === null && repsMax === null && !repsLabel) {
    errors.push("Add reps min/max or a reps label.");
  }

  if (targetWeight.invalid) {
    errors.push("Weight must be blank, BW, or a valid kg number.");
  }

  if (targetRPE === null) {
    errors.push("Target RPE must be 1-10 and can use .5 steps.");
  }

  if (!restTime.valid) {
    errors.push(restTime.error ?? "Rest must be seconds (e.g. 90) or a range like 150-180.");
  }

  if (errors.length) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    patch: {
      targetSets,
      targetReps: {
        min: repsMin,
        max: repsMax,
        label: repsLabel || null,
      },
      targetWeight: targetWeight.value,
      targetRPE,
      restTime: restTime.value,
      notes: form.notes,
    },
  };
}

export function parsePositiveInteger(value) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

export function parsePositiveNumber(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

export function parseOptionalPositiveNumber(value) {
  if (!value.trim()) {
    return null;
  }

  return parsePositiveNumber(value);
}

export function parseRpeValue(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 10 || !Number.isInteger(parsed * 2)) {
    return null;
  }

  return parsed;
}

export function parseProgramTargetWeight(value, exercise) {
  const cleanValue = value.trim();

  if (!cleanValue) {
    return { invalid: false, value: null };
  }

  if (cleanValue.toLowerCase() === "bw") {
    return { invalid: false, value: exercise.loadType === "optionalExternal" ? null : "BW" };
  }

  const parsed = Number(cleanValue);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return { invalid: true, value: null };
  }

  return { invalid: false, value: parsed };
}
