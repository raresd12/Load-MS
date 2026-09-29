import { useMemo, useState } from "react";
import { ChevronDown, Info } from "lucide-react";
import { getReadinessCopy } from "../components/readiness/readinessCopy.js";
import Metric from "../components/ui/Metric.jsx";
import ExerciseInfoPanel, { CheckVideoLink } from "../components/workout/ExerciseInfoPanel.jsx";
import TodayReadinessSummary from "../components/workout/TodayReadinessSummary.jsx";
import { workoutProgram } from "../config/workoutProgram.js";
import {
  formatPrescriptionStrip,
  formatTechnicalValue,
  getCoachConfidenceLabel,
  getCoachDecisionLabel,
  getCoachHistoryTrendLabel,
  getCoachProgressionModeLabel,
  getCoachVolumePolicyLabel,
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
      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3 min-[430px]:p-4">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
          Workouts
        </p>
        <h2 className="mt-1 text-xl font-black text-white sm:hidden">
          {getProgramNickname(activeProgram)}
        </h2>
        <h2 className="mt-1 hidden text-2xl font-black text-white sm:block">
          {activeProgram?.name ?? workoutProgram.name}
        </h2>
        <div className="mt-3 space-y-1 text-sm font-bold text-zinc-300 sm:hidden">
          <p>Selected: <span className="text-white">{day.name}</span></p>
          <p>Readiness: <span className="text-white">{todayReadinessEntry ? readinessCopy.label : "Not saved"}</span></p>
          <p>Next: <span className="text-white">{nextRecommendedDay?.name ?? "Not set yet"}</span></p>
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
          <p className="mt-3 hidden text-xs font-semibold text-zinc-400 sm:block">
            Last program workout: {new Date(programState.lastWorkoutDate).toLocaleString()}
          </p>
        )}
        {todayReadinessEntry && (
          <p className="mt-3 hidden text-sm font-semibold text-zinc-300 sm:block">
            {readinessCopy.summary}
          </p>
        )}
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={() => onOpenWorkoutLog(day.id)}
            className="focus-ring min-h-11 w-full rounded-[8px] bg-lime-300 px-4 text-sm font-black text-zinc-950 hover:bg-lime-200 sm:w-auto"
          >
            Open in Workout Log
          </button>
          {day.type !== "recovery" && (
            <button
              type="button"
              onClick={() => setShortOnTime((current) => !current)}
              aria-pressed={shortOnTime}
              className={`focus-ring min-h-11 w-full rounded-[8px] border px-4 text-sm font-black sm:w-auto ${
                shortOnTime
                  ? "border-amber-300/70 bg-amber-300/15 text-amber-100"
                  : "border-zinc-700 bg-[#171717] text-zinc-200 hover:bg-zinc-800"
              }`}
            >
              {shortOnTime ? "Short on time: ON" : "Short on time?"}
            </button>
          )}
        </div>
      </section>

      {shortOnTime && day.type !== "recovery" && (
        <section className="rounded-[8px] border border-amber-300/40 bg-amber-300/10 p-3 min-[430px]:p-4">
          <p className="text-xs font-black uppercase tracking-[0.14em] text-amber-200">
            Short on time mode
          </p>
          {hasPriorityRanking ? (
            <p className="mt-1 text-sm font-semibold leading-6 text-amber-100">
              Showing only the essentials. {trimmedExercises.length > 0
                ? `${trimmedExercises.length} ${trimmedExercises.length === 1 ? "exercise is" : "exercises are"} hidden - skip ${trimmedExercises.length === 1 ? "it" : "them"} guilt-free today, the priority work still moves you forward.`
                : "Everything on this day is priority work, so nothing was trimmed."}
            </p>
          ) : (
            <p className="mt-1 text-sm font-semibold leading-6 text-amber-100">
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
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
                Selected workout
              </p>
              <h2 className="mt-1 text-2xl font-black text-white">{day.name}</h2>
              <p className="mt-1 text-sm font-semibold text-zinc-400">{day.focus}</p>
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
                    <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-2">
                      <h3 className="text-sm font-black uppercase tracking-[0.14em] text-lime-300">
                        {section.name}
                      </h3>
                      <span className="text-xs font-bold text-zinc-400">
                        skipped today
                      </span>
                    </div>
                    <p className="rounded-[8px] border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm font-semibold text-zinc-400">
                      All {allSectionExercises.length} exercises here are optional when time is tight.
                    </p>
                  </div>
                );
              }

              return (
                <div key={section.id} className="space-y-3">
                  <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-2">
                    <h3 className="text-sm font-black uppercase tracking-[0.14em] text-lime-300">
                      {section.name}
                    </h3>
                    <span className="text-xs font-bold text-zinc-400">
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
    <details className="rounded-[8px] border border-zinc-800 bg-zinc-900">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 min-[430px]:px-4">
        <span className="min-w-0">
          <span className="block text-xs font-black uppercase tracking-[0.16em] text-lime-300">
            {formatTechnicalValue(day.warmup?.title) || "Warm-up & Activation"}
          </span>
          <span className="mt-1 block text-sm font-semibold text-zinc-400">
            {warmupItems.length} quick {warmupItems.length === 1 ? "item" : "items"} before training
          </span>
        </span>
        <ChevronDown aria-hidden="true" size={18} className="shrink-0 text-zinc-400" />
      </summary>
      <div className="space-y-2 border-t border-zinc-800 p-3 min-[430px]:p-4">
        {warmupItems.map((item) => (
          <div key={item.id} className="rounded-[8px] border border-zinc-800 bg-[#111111] px-3 py-2">
            <div className="flex flex-col gap-1 min-[430px]:flex-row min-[430px]:items-start min-[430px]:justify-between">
              <div className="min-w-0">
                <p className="font-black text-white">{item.name || "Warm-up item"}</p>
                {item.prescription && (
                  <p className="mt-1 text-sm font-black text-lime-100">{item.prescription}</p>
                )}
              </div>
              {item.videoUrl && (
                <a
                  href={item.videoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="focus-ring inline-flex min-h-9 w-fit items-center rounded-[8px] text-sm font-black text-sky-300 underline underline-offset-4 hover:text-sky-200"
                >
                  Check Video
                </a>
              )}
            </div>
            {item.notes && (
              <p className="mt-2 text-sm font-semibold leading-6 text-zinc-400">{item.notes}</p>
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
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
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
              className={`focus-ring min-h-20 rounded-[8px] border p-3 text-left transition ${
                isSelected
                  ? "border-lime-300 bg-lime-300/10"
                  : "border-zinc-800 bg-zinc-900 hover:bg-zinc-800"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-black text-white">{day.name}</p>
                  <p className="mt-1 text-xs font-semibold text-zinc-400">{day.focus}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {day.isOptional && (
                    <span className="rounded-[8px] border border-amber-300/60 bg-amber-300/10 px-2 py-1 text-[10px] font-black uppercase tracking-[0.08em] text-amber-100">
                      Optional
                    </span>
                  )}
                  {isSelected && (
                    <span className="rounded-[8px] bg-lime-300 px-2 py-1 text-[10px] font-black uppercase tracking-[0.08em] text-zinc-950">
                      Selected
                    </span>
                  )}
                </div>
              </div>
              {isNextRecommended && (
                <p className="mt-2 text-xs font-black uppercase tracking-[0.08em] text-amber-200">
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
    <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-4">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
        Recovery day
      </p>
      <h2 className="mt-1 text-2xl font-black text-white">{day.name}</h2>
      <p className="mt-1 text-sm font-semibold text-zinc-400">{day.focus}</p>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {(day.activities ?? []).map((activity) => (
          <div
            key={activity}
            className="rounded-[8px] border border-zinc-800 bg-[#171717] px-3 py-3 text-sm font-bold text-zinc-200"
          >
            {activity}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={onOpenWorkoutLog}
        className="focus-ring mt-4 min-h-11 rounded-[8px] bg-lime-300 px-4 text-sm font-black text-zinc-950 hover:bg-lime-200"
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
    <article className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3 min-[430px]:p-4">
      <div className="min-w-0">
        <div className="hidden flex-wrap gap-2 sm:flex">
          <span className="rounded-[8px] bg-zinc-800 px-2 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-zinc-300">
            {exercise.category}
          </span>
          <span className="rounded-[8px] bg-zinc-800 px-2 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-zinc-300">
            {exercise.progressionType}
          </span>
          {displayPlan.conservative && (
            <span className="rounded-[8px] bg-amber-300/15 px-2 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-amber-100">
              Conservative
            </span>
          )}
        </div>
        <h3 className="break-words text-xl font-black leading-tight text-white sm:mt-3 sm:text-2xl">
          {exercise.name}
        </h3>
        <p className="mt-1 hidden text-sm font-semibold text-zinc-400 sm:block">
          {exercise.muscleGroup || exercise.equipment}
        </p>
      </div>

      <p className="mt-3 rounded-[8px] border border-lime-300 bg-lime-950/70 px-3 py-2 text-sm font-black text-white shadow-sm shadow-lime-950/40">
        {prescriptionText}
      </p>

      <div className="mt-3 hidden grid-cols-2 gap-2 sm:grid sm:grid-cols-5">
        <Metric label="Sets" value={displayPlan.sets} />
        <Metric label="Reps" value={displayPlan.repsLabel} />
        <Metric label="Kg" value={formatWeight(displayPlan.recommendedWeight, exercise)} />
        <Metric label="Target RPE" value={displayPlan.targetRPE} />
        <Metric label="Rest" value={formatRest(displayPlan.restSeconds)} />
      </div>

      <CoachRecommendationSummary displayPlan={displayPlan} />
      <CoachRecommendationDetails displayPlan={displayPlan} />

      <div className="mt-3">
        <CheckVideoLink exercise={exercise} emptyLabel="Check Video not added yet." />
      </div>

      {primaryCue && (
        <p className="mt-3 rounded-[8px] bg-lime-300/10 px-3 py-2 text-sm font-semibold text-lime-100">
          Main cue: {primaryCue}
        </p>
      )}

      {beatLastCue && (
        <div className="mt-3 hidden rounded-[8px] bg-lime-300/10 px-3 py-2 text-xs font-semibold text-lime-100 sm:block">
          <p>{beatLastCue.summary}</p>
          <p className="mt-1">{beatLastCue.target}</p>
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setIsInfoOpen((current) => !current)}
          className="focus-ring flex min-h-11 items-center justify-center gap-2 rounded-[8px] border border-zinc-700 px-3 text-sm font-black text-zinc-100 hover:bg-zinc-800"
        >
          <Info aria-hidden="true" size={16} className="text-lime-300" />
          {isInfoOpen ? "Close Details" : "More Info"}
        </button>
        <button
          type="button"
          onClick={onOpenWorkoutLog}
          className="focus-ring min-h-11 rounded-[8px] border border-lime-300/60 px-3 text-sm font-black text-lime-100 hover:bg-lime-300/10"
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

function CoachRecommendationSummary({ displayPlan }) {
  const decisionLabel = getCoachDecisionLabel(displayPlan.decision);
  const confidenceLabel = getCoachConfidenceLabel(displayPlan.confidence);
  const reason = String(displayPlan.recommendationNote ?? "").trim();
  const warnings = normalizeCoachWarnings(displayPlan.warnings);
  const visibleWarnings = warnings.slice(0, 2);
  const hiddenWarningCount = Math.max(0, warnings.length - visibleWarnings.length);

  if (!decisionLabel && !confidenceLabel && !reason && !warnings.length) {
    return null;
  }

  return (
    <div className="mt-2 rounded-[8px] border border-zinc-800 bg-[#111111] px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        {decisionLabel && (
          <span className="rounded-[8px] bg-lime-300/15 px-2 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-lime-100">
            {decisionLabel}
          </span>
        )}
        {confidenceLabel && (
          <span className="rounded-[8px] bg-zinc-800 px-2 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-zinc-400">
            {confidenceLabel}
          </span>
        )}
      </div>

      {reason && (
        <p className="mt-2 text-xs font-semibold leading-5 text-zinc-300">
          {reason}
        </p>
      )}

      {visibleWarnings.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {visibleWarnings.map((warning) => (
            <span
              key={warning}
              className="rounded-[8px] border border-amber-300/25 bg-amber-300/10 px-2 py-1 text-[11px] font-bold leading-4 text-amber-100/90"
            >
              {warning}
            </span>
          ))}
          {hiddenWarningCount > 0 && (
            <span className="rounded-[8px] border border-zinc-700 px-2 py-1 text-[11px] font-bold text-zinc-400">
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
    <div className="rounded-[8px] border border-zinc-800 bg-zinc-900 px-3 py-2">
      <p className="text-[10px] font-black uppercase tracking-[0.12em] text-zinc-400">
        {label}
      </p>
      <p className="mt-1 text-xs font-semibold leading-5 text-zinc-200">{value}</p>
    </div>
  );
}

function CoachRecommendationDetails({ displayPlan }) {
  const decisionLabel = getCoachDecisionLabel(displayPlan.decision);
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
    <details className="mt-2 rounded-[8px] border border-zinc-800 bg-[#141414] px-3 py-2">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-black text-zinc-100">
        Coach Details
        <ChevronDown aria-hidden="true" size={16} className="shrink-0 text-zinc-400" />
      </summary>

      <div className="border-t border-zinc-800 pt-3">
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
          <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400">
            {displayPlan.sourceLabel}
            {displayPlan.sourceDetail &&
            (displayPlan.source === "progression" || displayPlan.source === "plan")
              ? ` | ${displayPlan.sourceDetail}`
              : ""}
          </p>
        )}

        {warnings.length > 0 && (
          <div className="mt-2 rounded-[8px] border border-amber-300/20 bg-amber-300/10 px-3 py-2">
            <p className="text-[10px] font-black uppercase tracking-[0.12em] text-amber-100/70">
              Warnings
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {warnings.map((warning) => (
                <span
                  key={warning}
                  className="rounded-[8px] border border-amber-300/20 bg-[#111111] px-2 py-1 text-[11px] font-bold leading-4 text-amber-100/90"
                >
                  {warning}
                </span>
              ))}
            </div>
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
      className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-4"
    >
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
        Today's Training Guidance
      </p>
      <p className="mt-2 text-sm font-bold text-zinc-100">
        {savedEntry
          ? copy.guidance
          : "No saved readiness yet. Use the planned work, let RPE guide the session, and add a check-in when you can for sharper coaching."}
      </p>
    </section>
  );
}
