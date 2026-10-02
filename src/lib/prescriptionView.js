// Prescription view glue (Phase H4, decision H4-1): resolves the prescription
// of every exercise of a day through src/lib/prescription.js (decision
// 19.4-2) and formats the coach labels, the prescription strip and the
// technical / warm-up view values. Moved verbatim from src/App.jsx.
// Fixture: scripts/verify-prescription-view.mjs.
import { workoutProgram } from "../config/workoutProgram.js";
import { getMeasurementProfile } from "./measurement.js";
import { getPrescriptionSourceLabel, resolvePrescription } from "./prescription.js";
import { formatRest, formatWeight } from "./progression.js";
import { getProgramBaseline, getProgramProgression } from "./programStorage.js";
import { getPlanExercise } from "./sessionNormalize.js";

export function normalizeCoachWarnings(value) {
  if (!value) {
    return [];
  }

  const warnings = Array.isArray(value) ? value : [value];
  return warnings
    .map((warning) => String(warning ?? "").trim())
    .filter(Boolean);
}

export function getWorkoutExerciseRecommendation(programId, exercise, planExercise, planStatus) {
  const programExerciseId = exercise.programExerciseId ?? exercise.id;
  const progression = programId ? getProgramProgression(programId, programExerciseId) : null;
  const baseline = programId ? getProgramBaseline(programId, programExerciseId) : null;
  const resolved = resolvePrescription({
    programExercise: exercise,
    progression,
    planExercise,
    baseline,
    planStatus,
  });

  return {
    source: resolved.source,
    sourceDetail: resolved.sourceDetail,
    sourceLabel: getPrescriptionSourceLabel(resolved.source),
    fieldSources: resolved.fieldSources,
    sets: resolved.sets,
    repsMin: resolved.repsMin,
    repsMax: resolved.repsMax,
    repsLabel: resolved.repsLabel,
    recommendedWeight: resolved.weight,
    targetRPE: resolved.targetRPE,
    restSeconds: resolved.restSeconds,
    recommendationNote: resolved.coach.recommendationNote,
    repFocus: resolved.coach.repFocus,
    conservative: resolved.coach.conservative,
    decision: resolved.coach.decision,
    confidence: resolved.coach.confidence,
    warnings: resolved.coach.warnings,
    historyTrend: resolved.coach.historyTrend,
    historySampleSize: resolved.coach.historySampleSize,
    progressionMode: resolved.coach.progressionMode,
    exerciseProfile: resolved.coach.exerciseProfile,
    // H5 fix round 1: the active override / deload of the resolution, so
    // the manual-override form can prefill the coach's BASE load under a
    // deload (decision H5-18) instead of the scaled one.
    override: resolved.override ?? null,
    deload: resolved.deload ?? null,
  };
}

/**
 * Resolves the prescription of every exercise of a day through the shared
 * resolver (decision 19.4-2) so Workouts, Workout Log and the saved planned
 * snapshot always agree. Returns a map keyed by exercise.id (programExerciseId).
 */
export function resolveDayPrescriptions(programId, day, plan) {
  return Object.fromEntries(
    (day?.exercises ?? []).map((exercise) => [
      exercise.id,
      getWorkoutExerciseRecommendation(
        programId,
        exercise,
        getPlanExercise(plan, exercise.id),
        plan?.status,
      ),
    ]),
  );
}

export function getCoachDecisionLabel(decision) {
  const labels = {
    increase_load: "Increase load",
    increase_reps: "Build reps",
    hold: "Hold steady",
    reduce_load: "Reduce load",
    reduce_volume: "Reduce volume",
    deload_suggestion: "Consider lighter day",
    recovery_suggestion: "Recovery focus",
    insufficient_data: "Establish baseline",
  };

  return labels[decision] ?? "";
}

export function getCoachConfidenceLabel(confidence) {
  const labels = {
    high: "High confidence",
    medium: "Medium confidence",
    low: "Low confidence",
  };

  return labels[confidence] ?? "";
}

export function getCoachHistoryTrendLabel(trend) {
  const labels = {
    improving: "Improving trend",
    stable: "Stable trend",
    regressing: "Regression watch",
    repeated_high_rpe: "High fatigue pattern",
    insufficient_history: "Limited history",
  };

  return labels[trend] ?? "";
}

export function getCoachProgressionModeLabel(mode) {
  const labels = {
    double_progression: "Double progression",
    load_progression: "Load progression",
    reps_first: "Reps first",
    quality_first: "Quality first",
    rpe_capped: "RPE-capped",
    core_control: "Core control",
    hold_conservative: "Conservative hold",
  };

  return labels[mode] ?? "";
}

export function getCoachVolumePolicyLabel(policy) {
  const labels = {
    protected: "Volume protected",
    normal: "Normal volume",
    reducible_low_priority: "Low-priority volume can flex",
  };

  return labels[policy] ?? "";
}

export function getProgramNickname(program) {
  if (!program) {
    return "Athletic Program";
  }

  if (program.nickname) {
    return program.nickname;
  }

  if (program.isDefault || program.name === workoutProgram.name || program.name.includes("Athletic Bodybuilding")) {
    return "Athletic Program";
  }

  return program.name;
}

const BARE_RANGE_PATTERN = /^\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?$/;
const SIDE_WORDING_PATTERN = /side|each|per\b|unilateral/i;
const TARGET_METRIC_LABELS = Object.freeze({ reps: "Reps", time: "Seconds", distance: "Meters" });

/**
 * The resolved target label in the exercise's measurement (H5 fix round 1,
 * decision H5-27), the way the Workout Log shows it: a bare count on a timed
 * / distance exercise gets its unit ("30" -> "30 s"), a per-side exercise
 * gets "/side" unless the label already names a side ("10-12" -> "10-12/side",
 * "8-12 per side" stays). A reps label on a plain exercise is returned as it
 * is, so pre-H5 strips are byte-identical.
 */
export function getPrescriptionTargetLabel(displayPlan, exercise = null) {
  const profile = getMeasurementProfile(exercise ?? {});
  let label = String(displayPlan?.repsLabel ?? "").trim();

  if (!label) {
    return label;
  }

  if (profile.measurement !== "reps" && BARE_RANGE_PATTERN.test(label)) {
    label = `${label} ${profile.unit}`;
  }

  if (profile.perSide && !SIDE_WORDING_PATTERN.test(label)) {
    label = `${label}/side`;
  }

  return label;
}

/** "Reps" | "Seconds" | "Meters" for the metric tile next to the target label. */
export function getPrescriptionTargetMetricLabel(exercise = null) {
  return TARGET_METRIC_LABELS[getMeasurementProfile(exercise ?? {}).measurement] ?? "Reps";
}

export function formatPrescriptionStrip(displayPlan, exercise) {
  return `${displayPlan.sets}x ${getPrescriptionTargetLabel(displayPlan, exercise)} | ${formatWeight(displayPlan.recommendedWeight, exercise)} | RPE ${displayPlan.targetRPE} | Rest ${formatRest(displayPlan.restSeconds)}`;
}

export function formatTechnicalValue(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean).join(", ");
  }

  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

export function getExerciseVideoUrl(exercise) {
  return formatTechnicalValue(exercise?.videoUrl) || formatTechnicalValue(exercise?.video_url);
}

export function getWarmupItems(day) {
  return (day?.warmup?.items ?? [])
    .map((item, index) => ({
      id: formatTechnicalValue(item?.id) || `warmup-${index + 1}`,
      name: formatTechnicalValue(item?.name),
      prescription: formatTechnicalValue(item?.prescription),
      notes: formatTechnicalValue(item?.notes),
      videoUrl: formatTechnicalValue(item?.videoUrl) || formatTechnicalValue(item?.video_url),
    }))
    .filter((item) => item.name || item.prescription);
}
