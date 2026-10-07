import { useMemo } from "react";
import { getReadinessCopy, readinessStyles } from "../components/readiness/readinessCopy.js";
import Metric from "../components/ui/Metric.jsx";
import DeloadCard from "../components/workout/DeloadCard.jsx";
import { workoutProgram } from "../config/workoutProgram.js";
import { formatDateKey, getLocalDateKey } from "../lib/date.js";
import { formatSetsReps, formatWeight, getPlanForDay } from "../lib/progression.js";
import { formatVolume } from "../lib/sessionAnalytics.js";
import { getPlanExercise, numberValue } from "../lib/sessionNormalize.js";
import { buildDashboardWeekStats, getDashboardSessionMetrics } from "../lib/workoutRecap.js";

function DashboardTodayWorkoutCard({ day, plan, isLoggedToday, onStartWorkout, onGoToWorkoutLog }) {
  if (!day) {
    return null;
  }

  if (day.type === "recovery") {
    return (
      <section className="card">
        <p className="label-accent">
          Up next
        </p>
        <h3 className="mt-1 text-[17px] font-semibold text-text-1">{day.name}</h3>
        <p className="mt-1 text-sm font-semibold text-text-2">{day.focus}</p>
        <p className="mt-3 text-sm font-semibold text-text-2">
          Easy day. Move, recover, and let the hard work settle in.
        </p>
        <button
          type="button"
          onClick={() => onGoToWorkoutLog(day.id)}
          className="focus-ring btn btn-primary mt-4 min-h-11 w-full sm:w-auto"
        >
          Log recovery day
        </button>
      </section>
    );
  }

  const previewExercises = day.exercises.slice(0, 3);
  const remainingCount = Math.max(0, day.exercises.length - previewExercises.length);
  const plannedSetCount = (plan?.exercises ?? []).reduce(
    (total, exercisePlan) => total + numberValue(exercisePlan.sets, 0),
    0,
  );

  return (
    <section className="card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="label-accent">
            Up next
          </p>
          <h3 className="mt-1 break-words text-[17px] font-semibold text-text-1">{day.name}</h3>
          <p className="mt-1 text-sm font-semibold text-text-2">{day.focus}</p>
        </div>
        {isLoggedToday && (
          <span className="pill pill-good shrink-0">
            Logged today
          </span>
        )}
      </div>

      <p className="mt-3 text-xs font-semibold text-text-2">
        {day.exercises.length} exercises | {plannedSetCount} working sets
      </p>

      <ul className="mt-3 divide-y divide-line border-y border-line">
        {previewExercises.map((exercise) => {
          const planExercise = getPlanExercise(plan, exercise.id);

          return (
            <li
              key={exercise.id}
              className="py-2.5"
            >
              <p className="text-sm font-semibold text-text-1">{exercise.name}</p>
              <p className="mt-0.5 text-xs font-medium tabular-nums text-text-2">
                {planExercise
                  ? `${formatSetsReps(planExercise)} | ${formatWeight(planExercise.recommendedWeight, exercise)} | RPE ${planExercise.targetRPE}`
                  : `${exercise.sets}x ${exercise.repsLabel} | RPE ${exercise.targetRPE}`}
              </p>
            </li>
          );
        })}
      </ul>
      {remainingCount > 0 && (
        <p className="mt-2 text-xs font-semibold text-text-2">
          + {remainingCount} more in Workouts
        </p>
      )}

      <div className="mt-4 grid gap-2 min-[430px]:grid-cols-2">
        <button
          type="button"
          onClick={() => onStartWorkout(day.id)}
          className="focus-ring min-h-12 btn btn-primary"
        >
          See full plan
        </button>
        <button
          type="button"
          onClick={() => onGoToWorkoutLog(day.id)}
          className="focus-ring min-h-12 btn btn-secondary"
        >
          Start logging
        </button>
      </div>
    </section>
  );
}

export default function DashboardPage({
  selectedDay,
  activeProgram,
  nextRecommendedDay,
  nextPlans,
  todayReadinessEntry,
  todayReadinessSummary,
  sessions,
  activeProgramDays = [],
  deloadModel = null,
  onApplyDeload,
  onDismissDeload,
  onEndDeload,
  onGoToReadiness,
  onStartWorkout,
  onGoToWorkoutLog,
}) {
  const copy = getReadinessCopy(todayReadinessSummary);
  const lastSession = sessions[0];
  // H5-24: the active program's days let the Dashboard read a set the way
  // Progress and the recap do, so the three agree on volume.
  const lastSessionMetrics = lastSession ? getDashboardSessionMetrics(lastSession, { days: activeProgramDays }) : null;
  const weekStats = useMemo(() => buildDashboardWeekStats(sessions, Date.now(), { days: activeProgramDays }), [sessions, activeProgramDays]);
  const todayDay = nextRecommendedDay ?? selectedDay;
  const todayPlan = todayDay ? getPlanForDay(todayDay, nextPlans[todayDay.id]) : null;
  const todayKey = getLocalDateKey();
  const isLoggedToday = sessions.some((session) => {
    const time = new Date(session.date);
    return !Number.isNaN(time.getTime()) && getLocalDateKey(time) === todayKey;
  });

  return (
    <div className="space-y-5">
      <section className="card">
        <p className="label-accent">
          Today
        </p>
        <h2 className="mt-1 text-[22px] font-semibold text-text-1">
          {formatDateKey(todayKey)}
        </h2>
        <p className="mt-1 text-sm font-semibold text-text-2">
          {activeProgram?.name ?? workoutProgram.name}
        </p>

        <div
          className={`mt-4 rounded-block border px-3 py-3 ${
            todayReadinessEntry
              ? readinessStyles[todayReadinessSummary.status] ?? "border-line bg-surface-2 text-text-1"
              : "border-line bg-surface-2 text-text-1"
          }`}
        >
          <p className="label text-current">
            Readiness: {todayReadinessEntry ? copy.label : "Not saved yet"}
          </p>
          <p className="text-sm font-medium text-text-1">
            {todayReadinessEntry
              ? copy.guidance
              : "A 30-second check-in sharpens today's coaching."}
          </p>
          {!todayReadinessEntry && (
            <button
              type="button"
              onClick={onGoToReadiness}
              className="focus-ring btn btn-primary mt-3"
            >
              Do the check-in
            </button>
          )}
        </div>
      </section>

      <DeloadCard model={deloadModel} onApply={onApplyDeload} onDismiss={onDismissDeload} onEnd={onEndDeload} />

      <DashboardTodayWorkoutCard
        day={todayDay}
        plan={todayPlan}
        isLoggedToday={isLoggedToday}
        onStartWorkout={onStartWorkout}
        onGoToWorkoutLog={onGoToWorkoutLog}
      />

      <section className="card">
        <p className="label-accent">
          Last 7 days
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label="Workouts" value={weekStats.workouts} />
          <Metric label="Sets" value={weekStats.setCount} />
          <Metric label="Volume" value={weekStats.volume > 0 ? formatVolume(weekStats.volume) : "--"} />
          <Metric
            label="Avg session RPE"
            value={weekStats.averageRpe === null ? "--" : weekStats.averageRpe.toFixed(1)}
          />
        </div>
      </section>

      <section className="card">
        <p className="label">Latest session</p>
        {lastSession ? (
          <div className="mt-2 space-y-1">
            <p className="text-sm font-semibold text-text-2">
              {lastSession.dayName} - {new Date(lastSession.date).toLocaleString()}
            </p>
            {lastSessionMetrics && lastSessionMetrics.setCount > 0 && (
              <p className="text-xs font-semibold text-text-2">
                {lastSessionMetrics.setCount} sets
                {lastSessionMetrics.volume > 0
                  ? ` | ${formatVolume(lastSessionMetrics.volume)} total`
                  : ""}
              </p>
            )}
          </div>
        ) : (
          <p className="mt-2 text-sm font-semibold text-text-2">
            No sessions logged yet. Your first one starts the trend lines.
          </p>
        )}
      </section>
    </div>
  );
}
