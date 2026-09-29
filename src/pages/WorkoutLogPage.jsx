import { useEffect, useRef, useState } from "react";
import { Activity, Save } from "lucide-react";
import { getReadinessCopy } from "../components/readiness/readinessCopy.js";
import Metric from "../components/ui/Metric.jsx";
import SectionShell from "../components/ui/SectionShell.jsx";
import CompletedWorkoutTable from "../components/workout/CompletedWorkoutTable.jsx";
import PostWorkoutCoachRecap from "../components/workout/PostWorkoutCoachRecap.jsx";
import RestTimerBar from "../components/workout/RestTimerBar.jsx";
import TodayReadinessSummary from "../components/workout/TodayReadinessSummary.jsx";
import { workoutProgram } from "../config/workoutProgram.js";
import { resolveRestSeconds } from "../lib/rest.js";
import { getPlanExercise, numberValue } from "../lib/sessionNormalize.js";

function WorkoutLogSummary({
  day,
  activeProgram,
  plan,
  savedReadinessEntry,
  readiness,
  onGoToReadiness,
}) {
  const readinessCopy = getReadinessCopy(readiness);
  const plannedSetCount = plan.exercises.reduce(
    (total, exercisePlan) => total + numberValue(exercisePlan.sets, 0),
    0,
  );

  return (
    <section className="hidden rounded-[8px] border border-zinc-800 bg-zinc-900 p-4 sm:block">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
        Workout Log
      </p>
      <h2 className="mt-1 text-2xl font-black text-white">{day.name}</h2>
      <p className="mt-2 text-sm font-semibold text-zinc-400">
        {activeProgram?.name ?? workoutProgram.name} | {day.focus}
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <Metric label="Exercises" value={day.exercises.length} />
        <Metric label="Planned sets" value={plannedSetCount} />
        <Metric label="Focus" value={day.focus} />
        <Metric
          label="Readiness"
          value={
            savedReadinessEntry
              ? `${readinessCopy.label} (${readiness.averageScore.toFixed(1)}/5)`
              : "Not saved"
          }
        />
      </div>
      {savedReadinessEntry && (
        <p className="mt-3 text-sm font-semibold text-zinc-300">
          {readinessCopy.summary}
        </p>
      )}
      <p className="mt-3 text-xs font-semibold text-zinc-400">
        Change the day from the Training day selector above. Log only what you actually completed.
      </p>
      {!savedReadinessEntry && (
        <button
          type="button"
          onClick={onGoToReadiness}
          className="focus-ring mt-3 min-h-10 rounded-[8px] border border-amber-300/60 px-3 text-sm font-black text-amber-100 hover:bg-amber-300/10"
        >
          Go to Readiness
        </button>
      )}
    </section>
  );
}

export default function WorkoutLogPage({
  day,
  activeProgram,
  plan,
  draft,
  todayReadinessEntry,
  todayReadinessSummary,
  validationErrors,
  saveError,
  scrollTarget,
  recap,
  onUpdateRecoveryActivity,
  onUpdateSessionField,
  onSaveSet,
  onTogglePainFlag,
  onGoToReadiness,
  onGoToWorkouts,
  onGoToHistory,
  onDismissRecap,
  onScrollTargetHandled,
  onSave,
}) {
  const exerciseRefs = useRef({});
  const [highlightedExerciseId, setHighlightedExerciseId] = useState(null);
  const [restTimer, setRestTimer] = useState(null);

  function handleSaveSet(exerciseId, setIndex, values) {
    onSaveSet(exerciseId, setIndex, values);

    const exercise = day.exercises.find((dayExercise) => dayExercise.id === exerciseId);
    const planExercise = getPlanExercise(plan, exerciseId);
    // Decision 19.4-3: a [min, max] rest range starts the timer at max (F6).
    const rest = resolveRestSeconds(planExercise?.restSeconds ?? exercise?.restSeconds);

    if (rest.seconds > 0) {
      const startedAt = Date.now();
      setRestTimer({
        key: startedAt,
        startedAt,
        exerciseName: exercise?.name ?? "Rest",
        restSeconds: rest.seconds,
        restMin: rest.min,
        isRange: rest.isRange,
        endsAt: startedAt + rest.seconds * 1000,
      });
    }
  }

  function useMinimumRest() {
    setRestTimer((currentTimer) => {
      if (!currentTimer?.isRange || !(currentTimer.restMin > 0)) {
        return currentTimer;
      }

      return {
        ...currentTimer,
        isRange: false,
        restSeconds: currentTimer.restMin,
        endsAt: currentTimer.startedAt + currentTimer.restMin * 1000,
      };
    });
  }

  useEffect(() => {
    const targetExerciseId = scrollTarget?.programExerciseId;

    if (!targetExerciseId || day.type === "recovery") {
      return undefined;
    }

    let timeoutId;
    const frameId = window.requestAnimationFrame(() => {
      const targetElement = exerciseRefs.current[targetExerciseId];

      if (!targetElement) {
        return;
      }

      targetElement.scrollIntoView({ behavior: "auto", block: "center" });
      setHighlightedExerciseId(targetExerciseId);
      timeoutId = window.setTimeout(() => {
        setHighlightedExerciseId((currentExerciseId) =>
          currentExerciseId === targetExerciseId ? null : currentExerciseId,
        );
        onScrollTargetHandled?.();
      }, 2600);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [
    day.id,
    day.type,
    scrollTarget?.programExerciseId,
    scrollTarget?.requestedAt,
    onScrollTargetHandled,
  ]);

  return (
    <form onSubmit={(event) => event.preventDefault()} noValidate className="space-y-5">
      <WorkoutLogSummary
        day={day}
        activeProgram={activeProgram}
        plan={plan}
        savedReadinessEntry={todayReadinessEntry}
        readiness={todayReadinessSummary}
        onGoToReadiness={onGoToReadiness}
      />

      {!todayReadinessEntry && (
        <div className="hidden sm:block">
        <TodayReadinessSummary
          savedEntry={todayReadinessEntry}
          readiness={todayReadinessSummary}
          onGoToReadiness={onGoToReadiness}
        />
        </div>
      )}

      <ValidationSummary errors={validationErrors} />

      {day.type === "recovery" ? (
        <RecoveryDay
          day={day}
          draft={draft}
          onUpdateRecoveryActivity={onUpdateRecoveryActivity}
          onUpdateSessionField={onUpdateSessionField}
        />
      ) : (
        <>
          <CompletedWorkoutTable
            day={day}
            plan={plan}
            draft={draft}
            exerciseRefs={exerciseRefs}
            highlightedExerciseId={highlightedExerciseId}
            onSaveSet={handleSaveSet}
            onTogglePainFlag={onTogglePainFlag}
          />
        </>
      )}

      <RestTimerBar
        timer={restTimer}
        onDismiss={() => setRestTimer(null)}
        onUseMin={useMinimumRest}
        onExtend={() =>
          setRestTimer((currentTimer) =>
            currentTimer
              ? { ...currentTimer, endsAt: currentTimer.endsAt + 30000 }
              : currentTimer,
          )
        }
      />

      <SessionFeedback draft={draft} onUpdateSessionField={onUpdateSessionField} />

      <PostWorkoutCoachRecap
        recap={recap}
        onDismiss={onDismissRecap}
        onGoToWorkouts={onGoToWorkouts}
        onGoToHistory={onGoToHistory}
      />

      <WorkoutSaveErrorNotice saveError={saveError} />

      <button
        type="button"
        onClick={onSave}
        className="focus-ring flex min-h-14 w-full items-center justify-center gap-2 rounded-[8px] bg-lime-300 px-5 text-base font-black text-zinc-950 shadow-lg shadow-lime-950/30 transition hover:bg-lime-200"
      >
        <Save aria-hidden="true" size={20} />
        Save workout / Generate next recommendation
      </button>
    </form>
  );
}

/**
 * Inline failure notice next to Save Workout (review finding F2): shown only
 * when the batch write failed. The draft is kept, no recap is shown.
 */
function WorkoutSaveErrorNotice({ saveError }) {
  if (!saveError) {
    return null;
  }

  return (
    <section
      role="alert"
      className="rounded-[8px] border border-red-400/50 bg-red-400/10 p-4"
    >
      <p className="font-black text-red-100">{saveError.title}</p>
      <p className="mt-1 text-sm font-semibold leading-6 text-red-100">{saveError.message}</p>
      {saveError.detail && saveError.code === "quota" && (
        <p className="mt-1 break-words text-xs font-semibold text-red-200/80">{saveError.detail}</p>
      )}
    </section>
  );
}

function ValidationSummary({ errors }) {
  if (!errors.length) {
    return null;
  }

  return (
    <section className="rounded-[8px] border border-red-400/50 bg-red-400/10 p-4">
      <p className="font-black text-red-100">Finish the required log fields before saving.</p>
      <ul className="mt-2 space-y-1 text-sm font-semibold text-red-100">
        {errors.slice(0, 6).map((error) => (
          <li key={error}>{error}</li>
        ))}
      </ul>
      {errors.length > 6 && (
        <p className="mt-2 text-sm font-semibold text-red-100">
          {errors.length - 6} more fields need attention.
        </p>
      )}
    </section>
  );
}

function RecoveryDay({ day, draft, onUpdateRecoveryActivity, onUpdateSessionField }) {
  return (
    <SectionShell title={day.name}>
      <div className="grid gap-2 sm:grid-cols-2">
        {day.activities.map((activity) => (
          <label
            key={activity}
            className="flex min-h-12 items-center gap-3 rounded-[8px] border border-zinc-800 bg-[#171717] px-3"
          >
            <input
              type="checkbox"
              checked={Boolean(draft.recoveryActivities[activity])}
              onChange={(event) => onUpdateRecoveryActivity(activity, event.target.checked)}
              className="h-5 w-5 accent-lime-300"
            />
            <span className="font-bold text-white">{activity}</span>
          </label>
        ))}
      </div>
      <label className="mt-4 block">
        <span className="mb-2 block text-xs font-bold uppercase tracking-[0.14em] text-zinc-400">
          Recovery notes
        </span>
          <textarea
            value={draft.recoveryNotes}
            onChange={(event) => onUpdateSessionField("recoveryNotes", event.target.value)}
            rows={3}
            className="focus-ring min-h-16 w-full resize-y rounded-[8px] border border-zinc-700 bg-[#111111] px-3 py-3 text-sm text-white placeholder:text-zinc-600 sm:min-h-24"
            placeholder="Light hoops, mobility quality, aches, what helped"
          />
      </label>
    </SectionShell>
  );
}

function SessionFeedback({ draft, onUpdateSessionField }) {
  return (
    <SectionShell title="Session RPE">
      <div className="grid gap-3 sm:grid-cols-[220px_1fr]">
        <label className="rounded-[8px] border border-zinc-800 bg-[#171717] p-3">
          <span className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-zinc-400">
            <Activity aria-hidden="true" size={15} />
            1-10 score
          </span>
          <input
            required
            type="number"
            inputMode="decimal"
            enterKeyHint="done"
            min="1"
            max="10"
            step="0.5"
            value={draft.sessionRpe}
            onChange={(event) => onUpdateSessionField("sessionRpe", event.target.value)}
            className="focus-ring min-h-11 w-full rounded-[8px] border border-zinc-700 bg-[#111111] px-3 text-lg font-black text-white"
          />
        </label>
        <label className="rounded-[8px] border border-zinc-800 bg-[#171717] p-3">
          <span className="mb-2 block text-xs font-bold uppercase tracking-[0.14em] text-zinc-400">
            Optional session notes
          </span>
          <textarea
            value={draft.sessionNotes}
            onChange={(event) => onUpdateSessionField("sessionNotes", event.target.value)}
            rows={3}
            className="focus-ring min-h-16 w-full resize-y rounded-[8px] border border-zinc-700 bg-[#111111] px-3 py-3 text-sm text-white placeholder:text-zinc-600 sm:min-h-24"
            placeholder="Anything that affected the session"
          />
        </label>
      </div>
    </SectionShell>
  );
}
