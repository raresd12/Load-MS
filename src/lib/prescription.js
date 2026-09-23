// Shared prescription resolver (review finding F9, decision 19.4-2).
//
// Workouts and Workout Log both call resolvePrescription so they always show
// the same sets / reps / kg / RPE / rest. Precedence:
//   1. "progression" - a stored ProgramProgression earned from a saved session
//      of this program (it carries sourceSessionId; older earned records that
//      only carry sourcePlanGeneratedAt with a non-base note are accepted too).
//   2. "plan"        - the generated (or manually adjusted) next plan for the day.
//   3. "target"      - the ProgramExercise prescription (day view model fields).
//   4. "baseline"    - the starting Baseline record.
// A value that is null/undefined at a higher level falls through to the next
// level; `fieldSources` records where each value came from and `source` is the
// highest level that supplied at least one value.

export const PRESCRIPTION_SOURCES = Object.freeze({
  progression: "progression",
  plan: "plan",
  target: "target",
  baseline: "baseline",
});

export const BASE_PLAN_REASON = "Base program prescription.";

const SOURCE_ORDER = ["progression", "plan", "target", "baseline"];

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

  if (planStatus === "manual" || planExercise.manuallyAdjusted === true) {
    return true;
  }

  const firstReason = Array.isArray(planExercise.reasons) ? planExercise.reasons[0] : null;
  return Boolean(firstReason && firstReason !== BASE_PLAN_REASON);
}

function buildCandidates({ programExercise, progression, planExercise, baseline, planStatus }) {
  const progressionUsable = isEarnedProgression(progression, programExercise);
  const planUsable = isGeneratedPlanExercise(planExercise, planStatus);
  const storedReps = progressionUsable ? progression.lastRecommendedReps : null;
  const baselineReps = baseline?.startingReps ?? null;

  return {
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

function describeSource(source, { progression, planExercise, planStatus }) {
  switch (source) {
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
 * planStatus:      optional plan.status ("base" | "generated" | "manual"); when
 *                  omitted the plan exercise counts as generated if its first
 *                  reason is not the base-plan reason.
 *
 * Returns { sets, repsMin, repsMax, repsLabel, targetRPE, restSeconds, weight,
 *           source, sourceDetail, fieldSources, coach }.
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
} = {}) {
  const candidates = buildCandidates({
    programExercise,
    progression,
    planExercise,
    baseline,
    planStatus,
  });
  const resolved = {};
  const fieldSources = {};

  FIELDS.forEach((field) => {
    const { value, source } = resolveField(field, candidates);
    resolved[field] = value;
    fieldSources[field] = source;
  });

  if (resolved.repsLabel === null) {
    resolved.repsLabel =
      repsLabelFromRange({ min: resolved.repsMin, max: resolved.repsMax }) ?? "custom";
  }

  const usedSources = new Set(Object.values(fieldSources).filter(Boolean));
  const source = SOURCE_ORDER.find((candidate) => usedSources.has(candidate)) ?? null;
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

  return {
    ...resolved,
    source,
    sourceDetail: describeSource(source, { progression, planExercise, planStatus }),
    fieldSources,
    coach,
  };
}

export function getPrescriptionSourceLabel(source) {
  const labels = {
    progression: "Source: earned progression",
    plan: "Source: generated plan",
    target: "Source: program target",
    baseline: "Source: baseline",
  };

  return labels[source] ?? "";
}
