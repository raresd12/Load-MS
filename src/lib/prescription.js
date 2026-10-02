// Shared prescription resolver (review finding F9, decision 19.4-2).
//
// Workouts and Workout Log both call resolvePrescription so they always show
// the same sets / reps / kg / RPE / rest. Precedence:
//   0. "override"    - a manual override record (decision H5-6) fills only the
//                      fields it sets; a hold sets no value but is reported.
//   1. "progression" - a stored ProgramProgression earned from a saved session
//      of this program (it carries sourceSessionId; older earned records that
//      only carry sourcePlanGeneratedAt with a non-base note are accepted too).
//   2. "plan"        - the generated (or manually adjusted) next plan for the day.
//   3. "target"      - the ProgramExercise prescription (day view model fields).
//   4. "baseline"    - the starting Baseline record.
// A value that is null/undefined at a higher level falls through to the next
// level; `fieldSources` records where each value came from and `source` is the
// highest level that supplied at least one value.
//
// Phase H5: an active deload (decision H5-7) scales the resolved load by the
// level's factor (rounded to the equipment step) and takes one set off
// accessory exercises AFTER the sources were resolved; the stored sources
// keep their base values, so the scaling never compounds.
import { applyDeloadToPrescription } from "./deload.js";
import { describeOverride, getOverridePrescriptionFields, isOverrideActive } from "./overrides.js";
import { isDeloadActive } from "./progression.js";

export const PRESCRIPTION_SOURCES = Object.freeze({
  override: "override",
  progression: "progression",
  plan: "plan",
  target: "target",
  baseline: "baseline",
});

export const BASE_PLAN_REASON = "Base program prescription.";

const SOURCE_ORDER = ["override", "progression", "plan", "target", "baseline"];

function isPresent(value) {
  return value !== null && value !== undefined && value !== "";
}

function repsLabelFromRange(reps) {
  if (!reps) {
    return null;
  }

  if (isPresent(reps.label)) {
    return String(reps.label);
  }

  if (isPresent(reps.min) && isPresent(reps.max)) {
    return Number(reps.min) === Number(reps.max) ? String(reps.min) : `${reps.min}-${reps.max}`;
  }

  return null;
}

function normalizeWarnings(value) {
  if (!value) {
    return [];
  }

  const warnings = Array.isArray(value) ? value : [value];
  return warnings.map((warning) => String(warning ?? "").trim()).filter(Boolean);
}

/**
 * A progression counts as "earned" only when it was produced from a saved
 * session of this program. Duplicates (decision 19.4-1) and target edits
 * (decision 19.4-2) clear that provenance, so they never win here.
 */
export function isEarnedProgression(progression, programExercise = null) {
  if (!progression || typeof progression !== "object") {
    return false;
  }

  const programId = programExercise?.programId ?? null;

  if (programId && progression.programId && progression.programId !== programId) {
    return false;
  }

  const programExerciseId = programExercise?.programExerciseId ?? programExercise?.id ?? null;

  if (
    programExerciseId &&
    progression.programExerciseId &&
    progression.programExerciseId !== programExerciseId
  ) {
    return false;
  }

  if (progression.sourceSessionId) {
    return true;
  }

  return Boolean(
    progression.sourcePlanGeneratedAt &&
      progression.recommendationNote &&
      progression.recommendationNote !== BASE_PLAN_REASON,
  );
}

/**
 * True when a plan exercise comes from a generated (or manually adjusted)
 * plan rather than the untouched base plan of the day.
 *
 * The plan status alone is not enough: after a target edit removes one entry
 * from a stored "generated" plan (decision 19.4-2), getPlanForDay refills that
 * entry from the base plan, so the entry itself must carry generated
 * provenance (a real reason, never the base-plan reason) or a manual
 * adjustment flag. A "manual" plan is a base plan with edited weights, so
 * every entry of it counts.
 */
export function isGeneratedPlanExercise(planExercise, planStatus) {
  if (!planExercise || typeof planExercise !== "object") {
    return false;
  }

  if (planStatus === "base") {
    return false;
  }

  // A frozen entry (held exercise, session logged under a deload; H5-6 /
  // H5-7) repeats what was shown and carries no evidence of its own.
  if (planExercise.held === true || planExercise.deloadSession === true) {
    return false;
  }

  if (planStatus === "manual" || planExercise.manuallyAdjusted === true) {
    return true;
  }

  const firstReason = Array.isArray(planExercise.reasons) ? planExercise.reasons[0] : null;
  return Boolean(firstReason && firstReason !== BASE_PLAN_REASON);
}

function buildCandidates({ programExercise, progression, planExercise, baseline, planStatus, override }) {
  const progressionUsable = isEarnedProgression(progression, programExercise);
  const planUsable = isGeneratedPlanExercise(planExercise, planStatus);
  const storedReps = progressionUsable ? progression.lastRecommendedReps : null;
  const baselineReps = baseline?.startingReps ?? null;

  return {
    override: override ? getOverridePrescriptionFields(override) : null,
    progression: progressionUsable
      ? {
          sets: progression.lastRecommendedSets,
          repsMin: storedReps?.min,
          repsMax: storedReps?.max,
          repsLabel: repsLabelFromRange(storedReps),
          targetRPE: progression.lastTargetRPE,
          restSeconds: undefined,
          weight: progression.lastRecommendedWeight,
        }
      : null,
    plan: planUsable
      ? {
          sets: planExercise.sets,
          repsMin: planExercise.repsMin,
          repsMax: planExercise.repsMax,
          repsLabel: planExercise.repsLabel,
          targetRPE: planExercise.targetRPE,
          restSeconds: planExercise.restSeconds,
          weight: planExercise.recommendedWeight,
        }
      : null,
    target: programExercise
      ? {
          sets: programExercise.sets ?? programExercise.targetSets,
          repsMin: programExercise.repsMin ?? programExercise.targetReps?.min,
          repsMax: programExercise.repsMax ?? programExercise.targetReps?.max,
          repsLabel:
            programExercise.repsLabel ?? repsLabelFromRange(programExercise.targetReps ?? null),
          targetRPE: programExercise.targetRPE,
          restSeconds: programExercise.restSeconds ?? programExercise.restTime,
          weight: programExercise.recommendedWeight ?? programExercise.targetWeight,
        }
      : null,
    baseline: baseline
      ? {
          sets: baseline.startingSets,
          repsMin: baselineReps?.min,
          repsMax: baselineReps?.max,
          repsLabel: repsLabelFromRange(baselineReps),
          targetRPE: baseline.startingRPE,
          restSeconds: baseline.restTime,
          weight: baseline.startingWeight,
        }
      : null,
    progressionUsable,
    planUsable,
  };
}

const FIELDS = ["sets", "repsMin", "repsMax", "repsLabel", "targetRPE", "restSeconds", "weight"];

/**
 * Weight is the one field where "null" can be a real value (bodyweight work
 * has no external load). It still falls through, but only across sources that
 * are usable; a usable source that explicitly stores null keeps null when no
 * lower source has a number either.
 */
function resolveField(field, candidates) {
  for (const source of SOURCE_ORDER) {
    const candidate = candidates[source];

    if (candidate && isPresent(candidate[field])) {
      return { value: candidate[field], source };
    }
  }

  return { value: null, source: null };
}

function describeSource(source, { progression, planExercise, planStatus, override }) {
  switch (source) {
    case "override":
      return describeOverride(override);
    case "progression":
      return progression?.sourceSessionId
        ? "Earned from your last saved session of this program."
        : "Earned from an earlier saved session of this program.";
    case "plan":
      return planStatus === "manual"
        ? "Adjusted plan for this day."
        : planExercise?.reasons?.length
          ? "Generated next plan for this day."
          : "Plan for this day.";
    case "target":
      return "Program target.";
    case "baseline":
      return "Starting baseline.";
    default:
      return "No prescription found.";
  }
}

/**
 * resolvePrescription({ programExercise, progression, planExercise, baseline, planStatus })
 *
 * programExercise: day view model exercise (sets/repsMin/repsMax/repsLabel/
 *                  targetRPE/restSeconds/recommendedWeight) or a raw
 *                  ProgramExercise record (targetSets/targetReps/restTime/targetWeight).
 * progression:     stored ProgramProgression record or null.
 * planExercise:    entry of the day's plan (getPlanForDay) for this exercise or null.
 * baseline:        Baseline record or null.
 * planStatus:      optional plan.status ("base" | "generated" | "manual" |
 *                  "deload"); when omitted the plan exercise counts as
 *                  generated if its first reason is not the base-plan reason.
 * override:        active override record (decision H5-6) or null; when the
 *                  argument is omitted the day view model's
 *                  `programExercise.override` is used.
 * deload:          active ProgramState.deload (decision H5-7) or null; when
 *                  omitted `programExercise.deload` from the day view model.
 *
 * Returns { sets, repsMin, repsMax, repsLabel, targetRPE, restSeconds, weight,
 *           source, sourceDetail, fieldSources, coach, override, deload }.
 * `override` is { mode, remainingSessions, untilDate, note, detail } or null;
 * `deload` is { level, factor, baseWeight, baseSets, setsReduced,
 * remainingSessions, detail } or null (the resolved weight / sets are then
 * the scaled values).
 * `coach` carries the recommendation metadata (note, decision, confidence,
 * warnings, history, profile) from the same source order so Coach Details can
 * show it without a second resolver.
 */
export function resolvePrescription({
  programExercise = null,
  progression = null,
  planExercise = null,
  baseline = null,
  planStatus,
  override,
  deload,
} = {}) {
  const overrideRecord = override === undefined ? programExercise?.override ?? null : override;
  const activeOverride = isOverrideActive(overrideRecord) ? overrideRecord : null;
  const deloadRecord = deload === undefined ? programExercise?.deload ?? null : deload;
  const activeDeload = isDeloadActive(deloadRecord) ? deloadRecord : null;
  const candidates = buildCandidates({
    programExercise,
    progression,
    planExercise,
    baseline,
    planStatus,
    override: activeOverride,
  });
  const resolved = {};
  const fieldSources = {};

  FIELDS.forEach((field) => {
    const { value, source } = resolveField(field, candidates);
    resolved[field] = value;
    fieldSources[field] = source;
  });

  // A manual override that sets one reps bound only (H5 fix round 1): the
  // other bound comes from the next source, so the range is re-checked
  // (min never above max) and the label is rebuilt from the resolved range
  // instead of repeating the lower source's label.
  const overrideSetsReps = fieldSources.repsMin === "override" || fieldSources.repsMax === "override";

  if (overrideSetsReps) {
    const min = Number(resolved.repsMin);
    const max = Number(resolved.repsMax);

    if (Number.isFinite(min) && Number.isFinite(max) && min > max) {
      if (fieldSources.repsMin === "override") {
        resolved.repsMax = resolved.repsMin;
        fieldSources.repsMax = "override";
      } else {
        resolved.repsMin = resolved.repsMax;
        fieldSources.repsMin = "override";
      }
    }

    if (fieldSources.repsLabel !== "override") {
      resolved.repsLabel = repsLabelFromRange({ min: resolved.repsMin, max: resolved.repsMax });
      fieldSources.repsLabel = resolved.repsLabel === null ? null : "override";
    }
  }

  if (resolved.repsLabel === null) {
    resolved.repsLabel =
      repsLabelFromRange({ min: resolved.repsMin, max: resolved.repsMax }) ?? "custom";
  }

  const usedSources = new Set(Object.values(fieldSources).filter(Boolean));
  // A hold sets no field but is still the top source: the athlete asked for
  // the prescription to stay where it is.
  const source = activeOverride
    ? "override"
    : (SOURCE_ORDER.find((candidate) => usedSources.has(candidate)) ?? null);
  const { progressionUsable, planUsable } = candidates;
  const coachSource = progressionUsable ? progression : planUsable ? planExercise : null;

  const coach = {
    recommendationNote: progressionUsable
      ? progression.recommendationNote ?? null
      : planUsable
        ? planExercise.reasons?.[0] ?? null
        : "Starting recommendation based on current program target.",
    repFocus: coachSource?.repFocus ?? null,
    conservative: Boolean(coachSource?.conservative),
    decision: coachSource?.decision ?? null,
    confidence: coachSource?.confidence ?? null,
    warnings: normalizeWarnings(coachSource?.warnings),
    historyTrend: coachSource?.historyTrend ?? planExercise?.historyTrend ?? null,
    historySampleSize: coachSource?.historySampleSize ?? planExercise?.historySampleSize ?? null,
    progressionMode: coachSource?.progressionMode ?? planExercise?.progressionMode ?? null,
    exerciseProfile: coachSource?.exerciseProfile ?? planExercise?.exerciseProfile ?? null,
  };

  let deloadInfo = null;

  if (activeDeload) {
    // H5 fix round 1 (decision H5-18): a number the athlete typed into a
    // manual override is used as typed. The deload scales only the fields it
    // resolved from the coach's sources (weight, accessory sets); a manual
    // weight / set count is kept and the detail says so.
    const weightFromOverride = fieldSources.weight === "override";
    const setsFromOverride = fieldSources.sets === "override";
    const scaled = applyDeloadToPrescription({
      weight: resolved.weight,
      sets: resolved.sets,
      exercise: programExercise ?? {},
      deload: activeDeload,
    });
    const weight = weightFromOverride ? resolved.weight : scaled.weight;
    const sets = setsFromOverride ? resolved.sets : scaled.sets;
    const outcome = {
      ...scaled,
      weight,
      sets,
      setsReduced: setsFromOverride ? false : scaled.setsReduced,
      weightKept: weightFromOverride,
      setsKept: setsFromOverride && scaled.setsReduced,
      weightUnchanged: !weightFromOverride && scaled.weightUnchanged,
    };

    deloadInfo = {
      level: scaled.level,
      factor: scaled.factor,
      baseWeight: scaled.baseWeight,
      baseSets: scaled.baseSets,
      setsReduced: outcome.setsReduced,
      weightKept: outcome.weightKept,
      weightUnchanged: outcome.weightUnchanged,
      remainingSessions: activeDeload.remainingSessions ?? null,
      detail: describeDeloadPrescription(activeDeload, outcome),
    };
    resolved.weight = weight;
    resolved.sets = sets;
  }

  const baseDetail = describeSource(source, { progression, planExercise, planStatus, override: activeOverride });

  return {
    ...resolved,
    source,
    sourceDetail: deloadInfo ? `${baseDetail} ${deloadInfo.detail}` : baseDetail,
    fieldSources,
    coach,
    override: activeOverride
      ? {
          mode: activeOverride.mode,
          remainingSessions: activeOverride.remainingSessions ?? null,
          untilDate: activeOverride.untilDate ?? null,
          note: activeOverride.note ?? "",
          detail: describeOverride(activeOverride),
        }
      : null,
    deload: deloadInfo,
  };
}

function describeDeloadPrescription(deload, scaled) {
  const label = deload.level === "deload" ? "Deload" : "Lighter week";
  const remaining = Number.isFinite(deload.remainingSessions)
    ? ` (${deload.remainingSessions} ${deload.remainingSessions === 1 ? "session" : "sessions"} left)`
    : "";
  const percent = Math.round((1 - scaled.factor) * 100);
  const setNote = scaled.setsReduced
    ? ", one accessory set off"
    : scaled.setsKept
      ? ", your manual set count kept"
      : "";
  // The load line states what happened to the load, never a reduction that
  // did not happen (H5 fix round 1): a manual weight is kept as typed, and a
  // load at or under one equipment step cannot go lower.
  const loadNote = scaled.weightKept
    ? "your manual weight kept as typed"
    : scaled.weightUnchanged
      ? "load unchanged (already at the smallest step)"
      : `load ${percent}% lighter`;

  return `${label}${remaining}: ${loadNote}${setNote}.`;
}

export function getPrescriptionSourceLabel(source) {
  const labels = {
    override: "Source: your override",
    progression: "Source: earned progression",
    plan: "Source: generated plan",
    target: "Source: program target",
    baseline: "Source: baseline",
  };

  return labels[source] ?? "";
}
