import { useMemo, useState } from "react";
import { ChevronDown, Info } from "lucide-react";
import { getReadinessCopy } from "../components/readiness/readinessCopy.js";
import Metric from "../components/ui/Metric.jsx";
import DeloadCard from "../components/workout/DeloadCard.jsx";
import ExerciseInfoPanel, { CheckVideoLink } from "../components/workout/ExerciseInfoPanel.jsx";
import ExerciseOverrideControls from "../components/workout/ExerciseOverrideControls.jsx";
import TodayReadinessSummary from "../components/workout/TodayReadinessSummary.jsx";
import { workoutProgram } from "../config/workoutProgram.js";
import {
  getActiveExerciseOverride,
  getCoachDecisionLabelWithMeasurement,
  getOverrideSourceLine,
} from "../lib/coachControlsView.js";
import {
  formatPrescriptionStrip,
  formatTechnicalValue,
  getCoachConfidenceLabel,
  getCoachHistoryTrendLabel,
  getCoachProgressionModeLabel,
  getCoachVolumePolicyLabel,
  getPrescriptionTargetLabel,
  getPrescriptionTargetMetricLabel,
  getProgramNickname,
  getWarmupItems,
  getWorkoutExerciseRecommendation,
  normalizeCoachWarnings,
} from "../lib/prescriptionView.js";
import { formatRest, formatWeight } from "../lib/progression.js";
import { getPlanExercise, getStoredSetupCue } from "../lib/sessionNormalize.js";

export default function WorkoutsPage({
  day,
  days,
  selectedDayId,
  activeProgram,
  programState,
  nextRecommendedDay,
  plan,
  todayReadinessEntry,
  todayReadinessSummary,
  setupCues,
  beatLastCues,
  deloadModel = null,
  onApplyDeload,
  onDismissDeload,
  onEndDeload,
  onSetOverride,
  onClearOverride,
  onSelectDay,
  onGoToReadiness,
  onOpenWorkoutLog,
}) {
  const readinessCopy = getReadinessCopy(todayReadinessSummary);
  const [shortOnTime, setShortOnTime] = useState(false);
  const sections =
    day.sections?.length
      ? day.sections
      : [{ id: "main", name: day.type === "recovery" ? "Recovery" : "Main Work" }];
  const essentialExerciseIds = useMemo(() => {
    const highPriorityIds = day.exercises
      .filter((exercise) => exercise.priority === "high")
      .map((exercise) => exercise.id);

    return new Set(highPriorityIds);
  }, [day]);
  const hasPriorityRanking = essentialExerciseIds.size > 0;
  const trimmedExercises =
    shortOnTime && hasPriorityRanking
      ? day.exercises.filter((exercise) => !essentialExerciseIds.has(exercise.id))
      : [];

  return (
    <div className="space-y-5">
      <section className="card p-3 min-[430px]:p-4">
        <p className="label-accent">
          Workouts
        </p>
        <h2 className="mt-1 text-[17px] font-semibold text-text-1 sm:hidden">
          {getProgramNickname(activeProgram)}
        </h2>
        <h2 className="mt-1 hidden text-[22px] font-semibold text-text-1 sm:block">
          {activeProgram?.name ?? workoutProgram.name}
        </h2>
        <div className="mt-3 space-y-1 text-sm font-semibold text-text-2 sm:hidden">
          <p>Selected: <span className="text-text-1">{day.name}</span></p>
          <p>Readiness: <span className="text-text-1">{todayReadinessEntry ? readinessCopy.label : "Not saved"}</span></p>
          <p>Next: <span className="text-text-1">{nextRecommendedDay?.name ?? "Not set yet"}</span></p>
        </div>
        <div className="mt-4 hidden gap-3 sm:grid sm:grid-cols-4">
          <Metric label="Selected day" value={day.shortName ?? day.name} />
          <Metric label="Focus" value={day.focus} />
          <Metric label="Next recommended" value={nextRecommendedDay?.name ?? "Not set yet"} />
          <Metric
            label="Readiness"
            value={
              todayReadinessEntry
                ? `${readinessCopy.label} (${todayReadinessSummary.averageScore.toFixed(1)}/5)`
                : "Not saved"
            }
          />
        </div>
        {programState?.lastWorkoutDate && (
          <p className="mt-3 hidden text-xs font-semibold text-text-2 sm:block">
            Last program workout: {new Date(programState.lastWorkoutDate).toLocaleString()}
          </p>
        )}
        {todayReadinessEntry && (
          <p className="mt-3 hidden text-sm font-semibold text-text-2 sm:block">
            {readinessCopy.summary}
          </p>
        )}
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={() => onOpenWorkoutLog(day.id)}
            className="focus-ring min-h-11 btn btn-primary w-full sm:w-auto"
          >
            Open in Workout Log
          </button>
          {day.type !== "recovery" && (
            <button
              type="button"
              onClick={() => setShortOnTime((current) => !current)}
              aria-pressed={shortOnTime}
              className={`focus-ring min-h-11 w-full rounded-control border px-4 text-sm font-semibold sm:w-auto ${
                shortOnTime
                  ? "border-warn/40 bg-warn-tint text-warn"
                  : "border-line bg-surface-2 text-text-1 hover:bg-surface-3"
              }`}
            >
              {shortOnTime ? "Short on time: ON" : "Short on time?"}
            </button>
          )}
        </div>
      </section>

      <DeloadCard model={deloadModel} onApply={onApplyDeload} onDismiss={onDismissDeload} onEnd={onEndDeload} />

      {shortOnTime && day.type !== "recovery" && (
        <section className="rounded-block bg-warn-tint p-3 min-[430px]:p-4">
          <p className="label text-warn">
            Short on time mode
          </p>
          {hasPriorityRanking ? (
            <p className="mt-1 text-sm font-semibold leading-6 text-warn">
              Showing only the essentials. {trimmedExercises.length > 0
                ? `${trimmedExercises.length} ${trimmedExercises.length === 1 ? "exercise is" : "exercises are"} hidden - skip ${trimmedExercises.length === 1 ? "it" : "them"} guilt-free today, the priority work still moves you forward.`
                : "Everything on this day is priority work, so nothing was trimmed."}
            </p>
          ) : (
            <p className="mt-1 text-sm font-semibold leading-6 text-warn">
              This day doesn't rank exercises, so nothing was trimmed. If you must cut, keep the
              first exercises in each section and shorten rests on the rest.
            </p>
          )}
        </section>
      )}

      {!todayReadinessEntry && (
        <div className="hidden sm:block">
        <TodayReadinessSummary
          savedEntry={todayReadinessEntry}
          readiness={todayReadinessSummary}
          onGoToReadiness={onGoToReadiness}
        />
        </div>
      )}

      <WorkoutDaySelector
        days={days}
        selectedDayId={selectedDayId}
        nextRecommendedDayId={programState?.nextRecommendedDayId}
        onSelectDay={onSelectDay}
      />

      {day.type === "recovery" ? (
        <WorkoutRecoveryView day={day} onOpenWorkoutLog={() => onOpenWorkoutLog(day.id)} />
      ) : (
        <>
          <div className="hidden sm:block">
            <TrainingGuidance savedEntry={todayReadinessEntry} readiness={todayReadinessSummary} />
          </div>
          <section className="space-y-4">
            <div className="hidden sm:block">
              <p className="label-accent">
                Selected workout
              </p>
              <h2 className="mt-1 text-[22px] font-semibold text-text-1">{day.name}</h2>
              <p className="mt-1 text-sm font-semibold text-text-2">{day.focus}</p>
            </div>
            <WorkoutWarmupPanel day={day} />

            {sections.map((section) => {
              const allSectionExercises = day.exercises.filter((exercise) =>
                exercise.sectionId ? exercise.sectionId === section.id : section.id === "main",
              );
              const sectionExercises =
                shortOnTime && hasPriorityRanking
                  ? allSectionExercises.filter((exercise) => essentialExerciseIds.has(exercise.id))
                  : allSectionExercises;
              const trimmedCount = allSectionExercises.length - sectionExercises.length;

              if (!allSectionExercises.length) {
                return null;
              }

              if (!sectionExercises.length) {
                return (
                  <div key={section.id} className="space-y-3">
                    <div className="flex items-center justify-between gap-3 border-b border-line pb-2">
                      <h3 className="label-accent">
                        {section.name}
                      </h3>
                      <span className="text-xs font-semibold text-text-2">
                        skipped today
                      </span>
                    </div>
                    <p className="card-inset text-sm font-medium text-text-2">
                      All {allSectionExercises.length} exercises here are optional when time is tight.
                    </p>
                  </div>
                );
              }

              return (
                <div key={section.id} className="space-y-3">
                  <div className="flex items-center justify-between gap-3 border-b border-line pb-2">
                    <h3 className="label-accent">
                      {section.name}
                    </h3>
                    <span className="text-xs font-semibold text-text-2">
                      {sectionExercises.length} exercises
                      {trimmedCount > 0 ? ` (${trimmedCount} skipped)` : ""}
                    </span>
                  </div>
                  {sectionExercises.map((exercise) => (
                    <WorkoutExerciseCard
                      key={exercise.id}
                      activeProgramId={activeProgram?.id}
                      exercise={exercise}
                      plan={plan}
                      setupCues={setupCues}
                      beatLastCue={beatLastCues[exercise.id]}
                      onSetOverride={onSetOverride}
                      onClearOverride={onClearOverride}
                      onOpenWorkoutLog={() =>
                        onOpenWorkoutLog(day.id, exercise.programExerciseId ?? exercise.id)
                      }
                    />
                  ))}
                </div>
              );
            })}
          </section>
        </>
      )}
    </div>
  );
}

function WorkoutWarmupPanel({ day }) {
  const warmupItems = getWarmupItems(day);

  if (!warmupItems.length) {
    return null;
  }

  return (
    <details className="card">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 min-[430px]:px-4">
        <span className="min-w-0">
          <span className="label-accent">
            {formatTechnicalValue(day.warmup?.title) || "Warm-up & Activation"}
          </span>
          <span className="mt-1 block text-sm font-semibold text-text-2">
            {warmupItems.length} quick {warmupItems.length === 1 ? "item" : "items"} before training
          </span>
        </span>
        <ChevronDown aria-hidden="true" size={18} className="disclosure-chevron text-text-2" />
      </summary>
      <div className="space-y-2 border-t border-line p-3 min-[430px]:p-4">
        {warmupItems.map((item) => (
          <div key={item.id} className="card-inset px-3 py-2">
            <div className="flex flex-col gap-1 min-[430px]:flex-row min-[430px]:items-start min-[430px]:justify-between">
              <div className="min-w-0">
                <p className="font-semibold text-text-1">{item.name || "Warm-up item"}</p>
                {item.prescription && (
                  <p className="mt-1 text-sm font-semibold text-accent-soft">{item.prescription}</p>
                )}
              </div>
              {item.videoUrl && (
                <a
                  href={item.videoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="focus-ring btn btn-ghost inline-flex w-fit items-center underline underline-offset-4"
                >
                  Check Video
                </a>
              )}
            </div>
            {item.notes && (
              <p className="mt-2 text-sm font-semibold leading-6 text-text-2">{item.notes}</p>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

function WorkoutDaySelector({ days, selectedDayId, nextRecommendedDayId, onSelectDay }) {
  return (
    <section className="space-y-3">
      <div>
        <p className="label-accent">
          Select day
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {days.map((day) => {
          const isSelected = day.id === selectedDayId;
          const isNextRecommended = day.id === nextRecommendedDayId;

          return (
            <button
              key={day.id}
              type="button"
              onClick={() => onSelectDay(day.id)}
              className={`focus-ring min-h-20 p-3 text-left transition ${
                isSelected
                  ? "card-active"
                  : "card hover:bg-surface-2"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-text-1">{day.name}</p>
                  <p className="mt-1 text-xs font-semibold text-text-2">{day.focus}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {day.isOptional && (
                    <span className="pill pill-warn">
                      Optional
                    </span>
                  )}
                  {isSelected && (
                    <span className="pill pill-accent">
                      Selected
                    </span>
                  )}
                </div>
              </div>
              {isNextRecommended && (
                <p className="label-accent mb-0 mt-2">
                  Next recommended
                </p>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function WorkoutRecoveryView({ day, onOpenWorkoutLog }) {
  return (
    <section className="card">
      <p className="label-accent">
        Recovery day
      </p>
      <h2 className="mt-1 text-[22px] font-semibold text-text-1">{day.name}</h2>
      <p className="mt-1 text-sm font-semibold text-text-2">{day.focus}</p>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {(day.activities ?? []).map((activity) => (
          <div
            key={activity}
            className="card-inset px-3 py-3 text-sm font-semibold text-text-1"
          >
            {activity}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={onOpenWorkoutLog}
        className="focus-ring btn btn-primary mt-4 min-h-11"
      >
        Open in Workout Log
      </button>
    </section>
  );
}

function WorkoutExerciseCard({
  activeProgramId,
  exercise,
  plan,
  setupCues,
  beatLastCue,
  onSetOverride,
  onClearOverride,
  onOpenWorkoutLog,
}) {
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const planExercise = getPlanExercise(plan, exercise.id);
  // Memoised: the resolver reads progression/baseline storage, and a storage
  // read must not happen on every re-render of the card.
  const displayPlan = useMemo(
    () => getWorkoutExerciseRecommendation(activeProgramId, exercise, planExercise, plan.status),
    [activeProgramId, exercise, planExercise, plan.status],
  );
  const setupCue = getStoredSetupCue(setupCues, exercise);
  const primaryCue = formatTechnicalValue(exercise.mainCue || setupCue || exercise.notes);
  const prescriptionText = formatPrescriptionStrip(displayPlan, exercise);

  return (
    <article className="card p-3 min-[430px]:p-4">
      <div className="min-w-0">
        <div className="hidden flex-wrap gap-2 sm:flex">
          <span className="pill">
            {exercise.category}
          </span>
          <span className="pill">
            {exercise.progressionType}
          </span>
          {displayPlan.conservative && (
            <span className="pill pill-warn">
              Conservative
            </span>
          )}
        </div>
        <h3 className="break-words text-[17px] font-semibold leading-tight text-text-1 sm:mt-3 sm:text-2xl">
          {exercise.name}
        </h3>
        <p className="mt-1 hidden text-sm font-semibold text-text-2 sm:block">
          {exercise.muscleGroup || exercise.equipment}
        </p>
      </div>

      <p className="mt-3 rounded-block bg-accent-tint px-3 py-2 text-sm font-semibold tabular-nums text-text-1">
        {prescriptionText}
      </p>

      <div className="mt-3 hidden grid-cols-2 gap-2 sm:grid sm:grid-cols-5">
        <Metric label="Sets" value={displayPlan.sets} />
        <Metric label={getPrescriptionTargetMetricLabel(exercise)} value={getPrescriptionTargetLabel(displayPlan, exercise)} />
        <Metric label="Kg" value={formatWeight(displayPlan.recommendedWeight, exercise)} />
        <Metric label="Target RPE" value={displayPlan.targetRPE} />
        <Metric label="Rest" value={formatRest(displayPlan.restSeconds)} />
      </div>

      <CoachRecommendationSummary displayPlan={displayPlan} exercise={exercise} />
      <CoachRecommendationDetails displayPlan={displayPlan} />

      <ExerciseOverrideControls
        programId={activeProgramId}
        exercise={exercise}
        prescription={displayPlan}
        onSetOverride={onSetOverride}
        onClearOverride={onClearOverride}
      />

      <div className="mt-3">
        <CheckVideoLink exercise={exercise} emptyLabel="Check Video not added yet." />
      </div>

      {primaryCue && (
        <p className="mt-3 rounded-block bg-accent-tint px-3 py-2 text-sm font-semibold text-accent-soft">
          Main cue: {primaryCue}
        </p>
      )}

      {beatLastCue && (
        <div className="mt-3 hidden rounded-block bg-accent-tint px-3 py-2 text-xs font-semibold text-accent-soft sm:block">
          <p>{beatLastCue.summary}</p>
          <p className="mt-1">{beatLastCue.target}</p>
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setIsInfoOpen((current) => !current)}
          className="focus-ring btn btn-secondary flex min-h-11 items-center justify-center gap-2 px-3"
        >
          <Info aria-hidden="true" size={16} className="text-accent-soft" />
          {isInfoOpen ? "Close Details" : "More Info"}
        </button>
        <button
          type="button"
          onClick={onOpenWorkoutLog}
          className="focus-ring min-h-11 btn btn-ghost px-3"
        >
          <span className="sm:hidden">Log</span>
          <span className="hidden sm:inline">Open Log</span>
        </button>
      </div>

      {isInfoOpen && (
        <ExerciseInfoPanel
          exercise={exercise}
          setupCue={setupCue}
          className="mt-3"
          onClose={() => setIsInfoOpen(false)}
        />
      )}
    </article>
  );
}

function CoachRecommendationSummary({ displayPlan, exercise = null }) {
  const decisionLabel = getCoachDecisionLabelWithMeasurement(displayPlan.decision);
  const confidenceLabel = getCoachConfidenceLabel(displayPlan.confidence);
  const reason = String(displayPlan.recommendationNote ?? "").trim();
  const warnings = normalizeCoachWarnings(displayPlan.warnings);
  const visibleWarnings = warnings.slice(0, 2);
  const hiddenWarningCount = Math.max(0, warnings.length - visibleWarnings.length);
  // H5-12: the summary states the source when the athlete took over.
  const overrideLine = getOverrideSourceLine(getActiveExerciseOverride(exercise));
  // The deload line also shows for a manual override (H5 fix round 1,
  // decision H5-18): the resolver states "your manual weight kept as typed".
  const deloadLine =
    displayPlan.deload?.detail ??
    (!displayPlan.sourceDetail || !/lighter week|deload/i.test(displayPlan.sourceDetail) ? "" : displayPlan.sourceDetail);

  if (!decisionLabel && !confidenceLabel && !reason && !warnings.length && !overrideLine && !deloadLine) {
    return null;
  }

  return (
    <div className="card-inset mt-2 px-3 py-2">
      {overrideLine && (
        <p className="mb-2 text-xs font-semibold text-warn" data-testid="coach-override-source">
          {overrideLine}
        </p>
      )}
      {deloadLine && (
        <p className="mb-2 text-xs font-semibold text-accent-soft" data-testid="coach-deload-source">
          {deloadLine}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {decisionLabel && (
          <span className="pill pill-accent">
            {decisionLabel}
          </span>
        )}
        {confidenceLabel && (
          <span className="pill">
            {confidenceLabel}
          </span>
        )}
      </div>

      {reason && (
        <p className="mt-2 text-xs font-semibold leading-5 text-text-2">
          {reason}
        </p>
      )}

      {/* Decision HV-11: warnings are sentences, so they are rounded blocks, not pills. */}
      {visibleWarnings.length > 0 && (
        <div className="mt-2 grid gap-1.5">
          {visibleWarnings.map((warning) => (
            <p
              key={warning}
              className="tone-caution rounded-block px-3 py-1.5 text-xs font-medium leading-5"
            >
              {warning}
            </p>
          ))}
          {hiddenWarningCount > 0 && (
            <span className="pill justify-self-start">
              +{hiddenWarningCount} more
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function CoachDetailRow({ label, value }) {
  if (!value) {
    return null;
  }

  return (
    <div className="rounded-control bg-surface-1 px-3 py-2">
      <p className="label">
        {label}
      </p>
      <p className="mt-1 text-xs font-semibold leading-5 text-text-1">{value}</p>
    </div>
  );
}

function CoachRecommendationDetails({ displayPlan }) {
  const decisionLabel = getCoachDecisionLabelWithMeasurement(displayPlan.decision);
  const confidenceLabel = getCoachConfidenceLabel(displayPlan.confidence);
  const reason = String(displayPlan.recommendationNote ?? "").trim();
  const warnings = normalizeCoachWarnings(displayPlan.warnings);
  const historyTrendLabel = getCoachHistoryTrendLabel(displayPlan.historyTrend);
  const historySampleSize = Number(displayPlan.historySampleSize);
  const historyValue = historyTrendLabel
    ? `${historyTrendLabel}${Number.isFinite(historySampleSize) ? ` | ${historySampleSize} recent ${historySampleSize === 1 ? "session" : "sessions"}` : ""}`
    : "";
  const progressionMode =
    getCoachProgressionModeLabel(displayPlan.progressionMode) ||
    getCoachProgressionModeLabel(displayPlan.exerciseProfile?.progressionMode);
  const loadStep = Number(displayPlan.exerciseProfile?.loadIncrementKg);
  const loadStepValue = Number.isFinite(loadStep) && loadStep > 0
    ? `${loadStep} kg${displayPlan.exerciseProfile?.equipment === "dumbbell" ? " per dumbbell" : ""}`
    : "";
  const volumePolicy = getCoachVolumePolicyLabel(displayPlan.exerciseProfile?.volumePolicy);
  const conservativeContext = displayPlan.conservative
    ? "Progression is capped today because readiness, fatigue, history, or exercise profile calls for control."
    : "";
  const hasDetails = Boolean(
    decisionLabel ||
      confidenceLabel ||
      reason ||
      warnings.length ||
      historyValue ||
      progressionMode ||
      loadStepValue ||
      volumePolicy ||
      conservativeContext,
  );

  if (!hasDetails) {
    return null;
  }

  return (
    <details className="card-inset mt-2 px-3 py-2">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-text-1">
        Coach Details
        <ChevronDown aria-hidden="true" size={16} className="disclosure-chevron text-text-2" />
      </summary>

      <div className="border-t border-line pt-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <CoachDetailRow label="Decision" value={decisionLabel} />
          <CoachDetailRow label="Confidence" value={confidenceLabel} />
          <CoachDetailRow label="Why" value={reason} />
          <CoachDetailRow label="History" value={historyValue} />
          <CoachDetailRow label="Progression Mode" value={progressionMode} />
          <CoachDetailRow label="Load Step" value={loadStepValue} />
          <CoachDetailRow label="Volume" value={volumePolicy} />
          <CoachDetailRow label="Context" value={conservativeContext} />
        </div>

        {displayPlan.sourceLabel && (
          <p className="label mt-2">
            {displayPlan.sourceLabel}
            {displayPlan.sourceDetail &&
            (displayPlan.source === "progression" || displayPlan.source === "plan")
              ? ` | ${displayPlan.sourceDetail}`
              : ""}
          </p>
        )}

        {warnings.length > 0 && (
          <div className="mt-2 rounded-block bg-warn-tint px-3 py-2">
            <p className="label text-warn">
              Warnings
            </p>
            <ul className="mt-1 grid list-disc gap-1 pl-4 text-xs font-medium leading-5 text-warn">
              {warnings.map((warning) => (
                <li key={warning}>
                  {warning}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}

function TrainingGuidance({ savedEntry, readiness }) {
  const copy = getReadinessCopy(readiness);

  return (
    <section
      data-testid="training-guidance"
      className="card"
    >
      <p className="label-accent">
        Today's Training Guidance
      </p>
      <p className="mt-2 text-sm font-semibold text-text-1">
        {savedEntry
          ? copy.guidance
          : "No saved readiness yet. Use the planned work, let RPE guide the session, and add a check-in when you can for sharper coaching."}
      </p>
    </section>
  );
}
