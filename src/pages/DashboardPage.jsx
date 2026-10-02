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
      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
          Up next
        </p>
        <h3 className="mt-1 text-xl font-black text-white">{day.name}</h3>
        <p className="mt-1 text-sm font-semibold text-zinc-400">{day.focus}</p>
        <p className="mt-3 text-sm font-semibold text-zinc-300">
          Easy day. Move, recover, and let the hard work settle in.
        </p>
        <button
          type="button"
          onClick={() => onGoToWorkoutLog(day.id)}
          className="focus-ring mt-4 min-h-11 w-full rounded-[8px] bg-lime-300 px-4 text-sm font-black text-zinc-950 hover:bg-lime-200 sm:w-auto"
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
    <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
            Up next
          </p>
          <h3 className="mt-1 break-words text-xl font-black text-white">{day.name}</h3>
          <p className="mt-1 text-sm font-semibold text-zinc-400">{day.focus}</p>
        </div>
        {isLoggedToday && (
          <span className="shrink-0 rounded-[8px] border border-lime-300/50 bg-lime-300/10 px-2 py-1 text-[11px] font-black uppercase tracking-[0.1em] text-lime-100">
            Logged today
          </span>
        )}
      </div>

      <p className="mt-3 text-xs font-bold text-zinc-400">
        {day.exercises.length} exercises | {plannedSetCount} working sets
      </p>

      <ul className="mt-3 space-y-2">
        {previewExercises.map((exercise) => {
          const planExercise = getPlanExercise(plan, exercise.id);

          return (
            <li
              key={exercise.id}
              className="rounded-[8px] border border-zinc-800 bg-[#171717] px-3 py-2"
            >
              <p className="text-sm font-black text-white">{exercise.name}</p>
              <p className="mt-0.5 text-xs font-bold text-zinc-400">
                {planExercise
                  ? `${formatSetsReps(planExercise)} | ${formatWeight(planExercise.recommendedWeight, exercise)} | RPE ${planExercise.targetRPE}`
                  : `${exercise.sets}x ${exercise.repsLabel} | RPE ${exercise.targetRPE}`}
              </p>
            </li>
          );
        })}
      </ul>
      {remainingCount > 0 && (
        <p className="mt-2 text-xs font-bold text-zinc-400">
          + {remainingCount} more in Workouts
        </p>
      )}

      <div className="mt-4 grid gap-2 min-[430px]:grid-cols-2">
        <button
          type="button"
          onClick={() => onStartWorkout(day.id)}
          className="focus-ring min-h-12 rounded-[8px] bg-lime-300 px-4 text-sm font-black text-zinc-950 hover:bg-lime-200"
        >
          See full plan
        </button>
        <button
          type="button"
          onClick={() => onGoToWorkoutLog(day.id)}
          className="focus-ring min-h-12 rounded-[8px] border border-zinc-700 bg-[#171717] px-4 text-sm font-black text-white hover:bg-zinc-800"
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
      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
          Today
        </p>
        <h2 className="mt-1 text-2xl font-black text-white">
          {formatDateKey(todayKey)}
        </h2>
        <p className="mt-1 text-sm font-semibold text-zinc-400">
          {activeProgram?.name ?? workoutProgram.name}
        </p>

        <div
          className={`mt-4 rounded-[8px] border px-3 py-3 ${
            todayReadinessEntry
              ? readinessStyles[todayReadinessSummary.status] ?? "border-zinc-700 bg-[#171717] text-zinc-200"
              : "border-zinc-700 bg-[#171717] text-zinc-200"
          }`}
        >
          <p className="text-xs font-black uppercase tracking-[0.14em]">
            Readiness: {todayReadinessEntry ? copy.label : "Not saved yet"}
          </p>
          <p className="mt-1 text-sm font-semibold">
            {todayReadinessEntry
              ? copy.guidance
              : "A 30-second check-in sharpens today's coaching."}
          </p>
          {!todayReadinessEntry && (
            <button
              type="button"
              onClick={onGoToReadiness}
              className="focus-ring mt-3 min-h-10 rounded-[8px] bg-lime-300 px-3 text-sm font-black text-zinc-950 hover:bg-lime-200"
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

      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
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

      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-sm font-black text-white">Latest session</p>
        {lastSession ? (
          <div className="mt-2 space-y-1">
            <p className="text-sm font-semibold text-zinc-300">
              {lastSession.dayName} - {new Date(lastSession.date).toLocaleString()}
            </p>
            {lastSessionMetrics && lastSessionMetrics.setCount > 0 && (
              <p className="text-xs font-bold text-zinc-400">
                {lastSessionMetrics.setCount} sets
                {lastSessionMetrics.volume > 0
                  ? ` | ${formatVolume(lastSessionMetrics.volume)} total`
                  : ""}
              </p>
            )}
          </div>
        ) : (
          <p className="mt-2 text-sm font-semibold text-zinc-400">
            No sessions logged yet. Your first one starts the trend lines.
          </p>
        )}
      </section>
    </div>
  );
}
