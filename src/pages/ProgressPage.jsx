import { useEffect, useMemo, useState } from "react";
import { getReadinessCopy, readinessStyles } from "../components/readiness/readinessCopy.js";
import ProgressEmptyState from "../components/ui/ProgressEmptyState.jsx";
import {
  buildRecordsSections,
  formatDeloadSampleLine,
  RECORD_ELIGIBILITY_RULE,
} from "../lib/coachControlsView.js";
import { formatDateKey } from "../lib/date.js";
import { computePersonalRecords } from "../lib/personalRecords.js";
import { getProgramDayViewModels } from "../lib/programStorage.js";
import {
  buildProgressAnalytics,
  buildSelectedExerciseAnalytics,
  buildWeeklyReview,
  formatAverage,
  formatBestWeightReps,
  formatKg,
  formatPlainNumber,
  formatProgressDate,
  formatReadinessAverage,
  formatSetPerformance,
  formatVolume,
  recentWorkoutWindowDays,
} from "../lib/sessionAnalytics.js";
import { numberValue } from "../lib/sessionNormalize.js";

function WeeklyReviewDelta({ label, value, previousValue, formatter }) {
  const hasComparison = Number.isFinite(previousValue) && previousValue > 0;
  const detail = hasComparison ? `Last week: ${formatter(previousValue)}` : "No data last week";

  return (
    <div className="card-inset">
      <p className="label">{label}</p>
      <p className="mt-1 break-words text-lg font-semibold text-text-1">
        {Number.isFinite(value) && value > 0 ? formatter(value) : value === 0 ? formatter(0) : "--"}
      </p>
      <p className="mt-1 text-xs font-semibold text-text-2">{detail}</p>
    </div>
  );
}

function WeeklyReviewSection({ sessionSummaries, setRecords, sessions, records, deloadEvaluation = null }) {
  // H5-10: with the stored sessions and the records the review adds the
  // observations (adherence, hold / override, new records, deload sample).
  // H5-23: the deload line states the sample of the active program's deload
  // evaluation (sessions AND check-ins), the same the deload card uses.
  const review = useMemo(
    () => buildWeeklyReview(sessionSummaries, setRecords, Date.now(), { sessions, records, deloadEvaluation }),
    [sessionSummaries, setRecords, sessions, records, deloadEvaluation],
  );

  return (
    <section className="card p-3 min-[430px]:p-4">
      <p className="label-accent">
        Weekly review
      </p>
      <h3 className="mt-1 text-[17px] font-semibold text-text-1">Last 7 days vs the week before</h3>

      <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <WeeklyReviewDelta
          label="Workouts"
          value={review.current.workouts}
          previousValue={review.previous.workouts}
          formatter={formatPlainNumber}
        />
        <WeeklyReviewDelta
          label="Sets"
          value={review.current.setCount}
          previousValue={review.previous.setCount}
          formatter={formatPlainNumber}
        />
        <WeeklyReviewDelta
          label="Volume"
          value={review.current.totalVolume}
          previousValue={review.previous.totalVolume}
          formatter={formatVolume}
        />
        <WeeklyReviewDelta
          label="Avg session RPE"
          value={review.current.averageRpe}
          previousValue={review.previous.averageRpe}
          formatter={(value) => Number(value).toFixed(1)}
        />
      </div>

      <div className="mt-3 space-y-2">
        {review.notes.map((note) => (
          <p
            key={note}
            className="card-inset px-3 py-2 text-sm font-semibold leading-6 text-text-1"
          >
            {note}
          </p>
        ))}
      </div>
    </section>
  );
}

export default function ProgressPage({
  sessions,
  readinessByDate,
  programs,
  activeProgram,
  activeProgramDays,
  exerciseLibrary,
  deloadEvaluation = null,
}) {
  // H5-8: records by program + occurrence over every program's exercises
  // (archived ones included, so an old program keeps its own records).
  const allProgramExercises = useMemo(
    () => programs.flatMap((program) => getProgramDayViewModels(program.id).flatMap((day) => day.exercises)),
    [programs],
  );
  const personalRecords = useMemo(
    () =>
      computePersonalRecords({
        sessions,
        programs,
        programExercises: allProgramExercises,
        exerciseLibrary,
        activeProgram,
      }),
    [sessions, programs, allProgramExercises, exerciseLibrary, activeProgram],
  );
  const recordSections = useMemo(
    () => buildRecordsSections(personalRecords, { programs, activeProgramId: activeProgram?.id ?? null }),
    [personalRecords, programs, activeProgram],
  );
  const analytics = useMemo(
    () =>
      buildProgressAnalytics({
        sessions,
        readinessByDate,
        programs,
        activeProgram,
        activeProgramDays,
        exerciseLibrary,
      }),
    [sessions, readinessByDate, programs, activeProgram, activeProgramDays, exerciseLibrary],
  );
  const [selectedExerciseKey, setSelectedExerciseKey] = useState(
    () => analytics.exerciseOptions[0]?.key ?? "",
  );

  useEffect(() => {
    if (!analytics.exerciseOptions.length) {
      setSelectedExerciseKey("");
      return;
    }

    if (!analytics.exerciseOptions.some((option) => option.key === selectedExerciseKey)) {
      setSelectedExerciseKey(analytics.exerciseOptions[0].key);
    }
  }, [analytics.exerciseOptions, selectedExerciseKey]);

  const selectedExercise =
    analytics.exerciseOptions.find((option) => option.key === selectedExerciseKey) ??
    analytics.exerciseOptions[0] ??
    null;
  const selectedStats = selectedExercise
    ? buildSelectedExerciseAnalytics(selectedExercise, analytics.setRecords)
    : null;

  // Decisions HV-1 / HV-11: numbers are tabular; the page root sets it once.
  return (
    <div className="space-y-5 tabular-nums">
      <section className="card p-3 min-[430px]:p-4">
        <p className="label-accent">
          Progress Analytics
        </p>
        <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-[22px] font-semibold text-text-1">Progress</h2>
            <p className="mt-2 text-sm font-semibold leading-6 text-text-2">
              Local training trends from saved workouts and readiness check-ins.
            </p>
          </div>
          <span className="card-inset px-3 py-2 text-sm font-semibold text-text-1">
            {activeProgram?.nickname || activeProgram?.name || "No active program"}
          </span>
        </div>
      </section>

      <WeeklyReviewSection
        sessionSummaries={analytics.sessionSummaries}
        setRecords={analytics.setRecords}
        sessions={sessions}
        records={personalRecords}
        deloadEvaluation={deloadEvaluation}
      />

      {deloadEvaluation && !deloadEvaluation.suggest && !deloadEvaluation.active && (
        <p className="text-xs font-semibold leading-5 text-text-2" data-testid="deload-sample-line">
          {deloadEvaluation.eligible
            ? deloadEvaluation.reasons.join(" ")
            : formatDeloadSampleLine(deloadEvaluation)}
        </p>
      )}

      <RecordsSection sections={recordSections} />

      <section className="grid gap-3 min-[430px]:grid-cols-2 lg:grid-cols-4">
        <ProgressStatCard
          label="Total workouts"
          value={analytics.totalWorkouts}
          detail={`${analytics.recentWorkoutCount} in the last ${recentWorkoutWindowDays} days`}
        />
        <ProgressStatCard
          label="Last workout"
          value={formatProgressDate(analytics.lastWorkoutDate)}
          detail={analytics.lastWorkoutName ?? "No saved sessions yet."}
        />
        <ProgressStatCard
          label="Logged sets"
          value={analytics.totalCompletedSets}
          detail={`${analytics.weightedSetCount} weighted sets counted for volume`}
        />
        <ProgressStatCard
          label="Total volume"
          value={formatVolume(analytics.totalVolume)}
          detail="Weighted sets only. BW and empty kg are ignored."
        />
        <ProgressStatCard
          label="Avg session RPE"
          value={formatAverage(analytics.averageSessionRpe)}
          detail={analytics.sessionRpeSampleSize ? `${analytics.sessionRpeSampleSize} sessions with RPE` : "No session RPE yet."}
        />
        <ProgressStatCard
          label="Avg readiness"
          value={formatReadinessAverage(analytics.averageReadiness)}
          detail={analytics.readinessEntries.length ? `${analytics.readinessEntries.length} readiness check-ins` : "No readiness data yet."}
        />
        <ProgressStatCard
          label="Recent workouts"
          value={analytics.recentSevenDayWorkoutCount}
          detail="Saved sessions in the last 7 days"
        />
        <ProgressStatCard
          label="Best recent set"
          value={analytics.bestRecentSet ? formatSetPerformance(analytics.bestRecentSet) : "No data"}
          detail={analytics.bestRecentSet?.exerciseName ?? "Log weighted sets to unlock this."}
        />
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {analytics.insights.map((insight) => (
          <ProgressInsightCard key={insight.title} insight={insight} />
        ))}
      </section>

      <ReadinessPerformanceSection analysis={analytics.readinessPerformance} />

      <section className="card p-3 min-[430px]:p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="label-accent">
              Exercise progress
            </p>
            <h3 className="mt-1 text-[17px] font-semibold text-text-1">Select an exercise</h3>
          </div>
          <span className="pill">
            {analytics.loggedExerciseCount} logged
          </span>
        </div>

        {analytics.exerciseOptions.length ? (
          <>
            <label className="mt-4 block">
              <span className="label mb-2">
                Exercise
              </span>
              <select
                value={selectedExerciseKey}
                onChange={(event) => setSelectedExerciseKey(event.target.value)}
                className="focus-ring min-h-12 field w-full"
              >
                {analytics.exerciseOptions.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.name} {option.dayName ? `- ${option.dayName}` : ""}
                  </option>
                ))}
              </select>
            </label>

            <ExerciseProgressPanel exercise={selectedExercise} stats={selectedStats} />
          </>
        ) : (
          <ProgressEmptyState
            title="No exercises available yet."
            body="Log a workout or seed an active program to start seeing exercise progress."
          />
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <RecentWorkoutTrend sessions={analytics.sortedSessions} />
        <ReadinessTrend entries={analytics.readinessEntries} />
      </section>
    </div>
  );
}

/**
 * H5-8 / H5-12: personal records per program exercise (identity = program +
 * occurrence), with the "across programs" roll-up as a secondary line and a
 * "?" that quotes the eligibility rule. Nothing here is merged or rewritten.
 */
function RecordsSection({ sections }) {
  return (
    <section className="card p-3 min-[430px]:p-4" data-testid="records-section">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="label-accent">Records</p>
          <h3 className="mt-1 text-[17px] font-semibold text-text-1">Best per exercise</h3>
        </div>
        <details className="relative">
          <summary
            aria-label="How records are counted"
            className="focus-ring btn btn-secondary flex min-w-11 cursor-pointer list-none items-center justify-center"
          >
            ?
          </summary>
          <p className="card-inset absolute right-0 z-20 mt-2 w-72 border border-line bg-surface-3 text-xs font-semibold leading-5 text-text-2">
            {RECORD_ELIGIBILITY_RULE}
          </p>
        </details>
      </div>

      {sections.length ? (
        <div className="mt-3 space-y-3">
          {sections.map((group) => (
            <div key={group.programId ?? "unknown"}>
              <p className="label">
                {group.programName}
                {group.isActive ? " | active" : ""}
              </p>
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                {group.entries.map((entry) => (
                  <article key={entry.key} className="card-inset">
                    <p className="break-words text-sm font-semibold text-text-1">{entry.name}</p>
                    <ul className="mt-2 space-y-1">
                      {entry.lines.map((line, index) => (
                        <li key={`${line.type}-${index}`} className="flex items-baseline justify-between gap-2 text-xs font-semibold text-text-1">
                          <span>
                            <span className="text-text-2">{line.label}: </span>
                            {line.value}
                          </span>
                          <span className="shrink-0 text-[11px] text-text-2">{line.date}</span>
                        </li>
                      ))}
                    </ul>
                    {entry.acrossPrograms && (
                      <p className="mt-2 text-[11px] font-semibold leading-4 text-text-2">{entry.acrossPrograms}</p>
                    )}
                    {entry.ineligibleCount > 0 && (
                      <p className="mt-1 text-[11px] font-semibold leading-4 text-text-2">
                        {entry.ineligibleCount} {entry.ineligibleCount === 1 ? "set" : "sets"} not counted for e1RM (see ?).
                      </p>
                    )}
                  </article>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3">
          <ProgressEmptyState
            title="No records yet."
            body="Complete sets logged against a program exercise become its records."
          />
        </div>
      )}
    </section>
  );
}

function ExerciseProgressPanel({ exercise, stats }) {
  if (!exercise || !stats) {
    return null;
  }

  if (!stats.completedSets.length) {
    return (
      <div className="mt-4 space-y-3">
        <ExerciseDetailCard exercise={exercise} stats={stats} />
        <ProgressEmptyState
          title="No logged sets for this exercise yet."
          body="It can still appear here from the active program. Log sets to unlock trends."
        />
        {exercise.prescription && (
          <p className="card-inset mt-3 px-3 py-2 text-sm font-semibold text-text-1">
            Current target: {exercise.prescription}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-4">
      <ExerciseDetailCard exercise={exercise} stats={stats} />

      <div className="grid gap-3 min-[430px]:grid-cols-2 xl:grid-cols-3">
        <ProgressStatCard
          label="Latest logged session"
          value={stats.latestSession ? formatProgressDate(stats.latestSession.date) : "No data"}
          detail={stats.latestSession?.setSummary ?? "No logged sets yet."}
        />
        <ProgressStatCard
          label="Best set"
          value={stats.bestSet ? formatSetPerformance(stats.bestSet) : "No weighted set"}
          detail={
            stats.bestSet?.estimatedOneRepMax
              ? `e1RM ${formatKg(stats.bestSet.estimatedOneRepMax)}`
              : "Based on reps/load when e1RM is unavailable."
          }
        />
        <ProgressStatCard
          label="Best estimated strength"
          value={stats.bestEstimatedStrength ? formatKg(stats.bestEstimatedStrength) : "No kg data"}
          detail="Epley estimate from valid weighted sets"
        />
        <ProgressStatCard
          label="Recent total reps"
          value={stats.repsTrend.value}
          detail={stats.repsTrend.detail}
        />
        <ProgressStatCard
          label="Recent volume"
          value={stats.volumeTrend.value}
          detail={stats.volumeTrend.detail}
        />
        <ProgressStatCard
          label="Est. strength trend"
          value={stats.strengthTrend.value}
          detail={stats.strengthTrend.detail}
        />
        <ProgressStatCard
          label="Average set RPE"
          value={formatAverage(stats.averageSetRpe)}
          detail={`${stats.completedSets.length} completed sets | ${formatVolume(stats.totalVolume)} volume`}
        />
      </div>

      <div className="card-inset">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-text-1">{exercise.name}</p>
            <p className="mt-1 text-xs font-semibold text-text-2">
              {exercise.programName ?? "Logged exercise"} {exercise.dayName ? `| ${exercise.dayName}` : ""}
            </p>
          </div>
          <span className="pill">
            {stats.completedSets.length} sets
          </span>
        </div>

        {stats.recentSessions.length ? (
          <div className="mt-3 space-y-2">
            {stats.recentSessions
              .slice(0, 6)
              .reverse()
              .map((sessionEntry) => (
                <ExerciseTrendRow
                  key={`${sessionEntry.sessionId}-${sessionEntry.date}`}
                  entry={sessionEntry}
                  maxValue={stats.trendMaxValue}
                />
              ))}
          </div>
        ) : (
          <p className="mt-3 text-sm font-semibold text-text-2">
            No recent session trend available yet.
          </p>
        )}
      </div>
    </div>
  );
}

function ExerciseDetailCard({ exercise, stats }) {
  const trend = stats.trendInfo;
  const latestSession = stats.latestSession;

  return (
    <article className="card-inset min-[430px]:p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="label-accent">
            Exercise Detail
          </p>
          <h4 className="mt-1 break-words text-[17px] font-semibold text-text-1">{exercise.name}</h4>
          <p className="mt-1 text-xs font-semibold leading-5 text-text-2">
            {exercise.programName ?? "Logged exercise"}
            {exercise.dayName ? ` | ${exercise.dayName}` : ""}
          </p>
        </div>
        <span className={`pill w-fit ${trend.toneClass}`}>
          {trend.label}
        </span>
      </div>

      <p className="mt-3 text-sm font-semibold leading-6 text-text-2">{trend.body}</p>

      <div className="mt-3 grid gap-2 min-[430px]:grid-cols-2 xl:grid-cols-4">
        <ExerciseDetailMetric
          label="Latest"
          value={latestSession ? formatProgressDate(latestSession.date) : "No data"}
          detail={latestSession?.setSummary ?? "No logged session yet."}
        />
        <ExerciseDetailMetric
          label="Best set"
          value={stats.bestSet ? formatSetPerformance(stats.bestSet) : "No set yet"}
          detail={stats.bestSet?.estimatedOneRepMax ? `e1RM ${formatKg(stats.bestSet.estimatedOneRepMax)}` : "No valid e1RM for BW/missing kg."}
        />
        <ExerciseDetailMetric
          label="Recent reps"
          value={stats.repsTrend.value}
          detail={stats.repsTrend.detail}
        />
        <ExerciseDetailMetric
          label="Avg set RPE"
          value={formatAverage(stats.averageSetRpe)}
          detail={stats.completedSets.length ? `${stats.completedSets.length} completed sets` : "No RPE data yet."}
        />
      </div>
    </article>
  );
}

function ExerciseDetailMetric({ label, value, detail }) {
  return (
    <div className="rounded-control bg-surface-1 px-3 py-2">
      <p className="label">{label}</p>
      <p className="mt-1 break-words text-sm font-semibold text-text-1">{value}</p>
      <p className="mt-1 text-xs font-semibold leading-5 text-text-2">{detail}</p>
    </div>
  );
}

function ProgressStatCard({ label, value, detail }) {
  return (
    <div className="card-inset">
      <p className="label">
        {label}
      </p>
      <p className="mt-1 break-words text-lg font-semibold text-text-1">{value}</p>
      <p className="mt-2 text-xs font-semibold leading-5 text-text-2">{detail}</p>
    </div>
  );
}

function ProgressInsightCard({ insight }) {
  return (
    <article className="card-inset">
      <div className="flex items-start justify-between gap-3">
        <p className="label">
          {insight.title}
        </p>
        <span className={`pill ${insight.toneClass}`}>
          {insight.status}
        </span>
      </div>
      <p className="mt-2 text-lg font-semibold text-text-1">{insight.value}</p>
      <p className="mt-2 text-xs font-semibold leading-5 text-text-2">{insight.body}</p>
    </article>
  );
}

function ReadinessPerformanceSection({ analysis }) {
  if (!analysis) {
    return null;
  }

  return (
    <section className="card p-3 min-[430px]:p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="label-accent">
            Readiness vs Performance
          </p>
          <h3 className="mt-1 text-[17px] font-semibold text-text-1">Recovery signal check</h3>
          <p className="mt-2 text-sm font-semibold leading-6 text-text-2">
            Conservative read on readiness, session RPE, and logged work. No causation claims.
          </p>
        </div>
        <span className="pill w-fit">
          {analysis.linkedSessionCount} linked sessions
        </span>
      </div>

      <div className="mt-4 grid gap-3 min-[430px]:grid-cols-2 xl:grid-cols-4">
        <ProgressStatCard
          label="Avg readiness on workouts"
          value={formatReadinessAverage(analysis.averageReadiness)}
          detail={analysis.averageReadinessDetail}
        />
        <ProgressStatCard
          label="High fatigue days"
          value={analysis.highFatigueCount}
          detail={analysis.highFatigueDetail}
        />
        <ProgressStatCard
          label="Best performance day"
          value={analysis.bestPerformance?.label ?? "No data"}
          detail={analysis.bestPerformance?.detail ?? "Log performance with readiness to unlock this."}
        />
        <ProgressStatCard
          label="Practical coach note"
          value={analysis.coachNoteTitle}
          detail={analysis.coachNote}
        />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="card-inset">
          <p className="label">
            Readiness distribution
          </p>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {["green", "yellow", "red"].map((status) => (
              <ReadinessStatusCount
                key={status}
                status={status}
                count={analysis.statusCounts[status] ?? 0}
              />
            ))}
          </div>
          {analysis.statusCounts.missing > 0 && (
            <p className="mt-3 text-xs font-semibold leading-5 text-text-2">
              {analysis.statusCounts.missing} saved sessions have no readiness snapshot.
            </p>
          )}
        </div>

        <div className="card-inset">
          <p className="label">
            Avg session RPE by readiness
          </p>
          <div className="mt-3 space-y-2">
            {["green", "yellow", "red"].map((status) => (
              <ReadinessRpeRow
                key={status}
                status={status}
                entry={analysis.rpeByStatus[status]}
              />
            ))}
          </div>
        </div>
      </div>

      <p className="card-inset mt-3 px-3 py-2 text-sm font-semibold leading-6 text-text-2">
        {analysis.performanceNote}
      </p>
    </section>
  );
}

function ReadinessStatusCount({ status, count }) {
  const copy = getReadinessCopy({ status });

  return (
    <div className={`rounded-control px-3 py-2 text-center ${readinessStyles[status] ?? readinessStyles.yellow}`}>
      <p className="text-xl font-semibold">{count}</p>
      <p className="label text-current mt-1">{copy.label}</p>
    </div>
  );
}

function ReadinessRpeRow({ status, entry }) {
  const copy = getReadinessCopy({ status });
  const averageRpe = Number.isFinite(entry?.averageRpe) ? `RPE ${entry.averageRpe.toFixed(1)}` : "No RPE";
  const count = entry?.count ?? 0;
  const width = Number.isFinite(entry?.averageRpe)
    ? Math.max(8, Math.min(100, (entry.averageRpe / 10) * 100))
    : 0;

  return (
    <div className="rounded-control bg-surface-1 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-text-1">{copy.label}</p>
        <p className="text-xs font-semibold text-text-2">
          {averageRpe} | {count} {count === 1 ? "session" : "sessions"}
        </p>
      </div>
      <div className="bar mt-2">
        <div
          className={`bar-fill ${
            status === "green" ? "bg-good" : status === "red" ? "bg-bad" : "bg-warn"
          }`}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

function ExerciseTrendRow({ entry, maxValue }) {
  const value = entry.bestEstimatedStrength ?? entry.totalVolume ?? entry.totalReps;
  const width = maxValue > 0 ? Math.max(8, Math.min(100, (value / maxValue) * 100)) : 0;

  return (
    <div className="card-inset py-2">
      <div className="flex flex-col gap-1 min-[430px]:flex-row min-[430px]:items-start min-[430px]:justify-between">
        <p className="text-sm font-semibold text-text-1">{formatProgressDate(entry.date)}</p>
        <p className="text-xs font-semibold leading-5 text-text-2 min-[430px]:text-right">
          Total {entry.totalReps} reps | Avg RPE {formatAverage(entry.averageRpe)}
        </p>
      </div>
      <p className="mt-2 text-xs font-semibold leading-5 text-text-2">{entry.setSummary}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <span className="pill">
          Best: {formatBestWeightReps(entry.bestSet)}
        </span>
        {entry.totalVolume > 0 && (
          <span className="pill">
            Volume {formatVolume(entry.totalVolume)}
          </span>
        )}
      </div>
      <div className="bar mt-2">
        <div
          className="bar-fill"
          style={{ width: `${width}%` }}
        />
      </div>
      <p className="label mt-1">
        {entry.bestEstimatedStrength
          ? `Best e1RM ${formatKg(entry.bestEstimatedStrength)}`
          : entry.totalVolume
            ? `Volume ${formatVolume(entry.totalVolume)}`
            : `${entry.totalReps} reps`}
      </p>
    </div>
  );
}

function RecentWorkoutTrend({ sessions }) {
  const recentSessions = sessions.slice(0, 5);

  return (
    <section className="card p-3 min-[430px]:p-4">
      <p className="label-accent">
        Recent workouts
      </p>
      {recentSessions.length ? (
        <div className="mt-3 space-y-2">
          {recentSessions.map((session) => (
            <div
              key={session.id ?? `${session.date}-${session.dayName}`}
              className="card-inset flex items-center justify-between gap-3 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-text-1">
                  {session.dayName ?? "Workout"}
                </p>
                <p className="text-xs font-semibold text-text-2">
                  {formatProgressDate(session.date)}
                </p>
              </div>
              <span className="shrink-0 rounded-control bg-surface-3 px-2.5 py-1 text-xs font-semibold text-text-2">
                RPE {formatAverage(numberValue(session.sessionRpe, null))}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <ProgressEmptyState
          title="No workouts logged yet."
          body="Save a workout to start the progress feed."
        />
      )}
    </section>
  );
}

function ReadinessTrend({ entries }) {
  const recentEntries = entries.slice(0, 7);

  return (
    <section className="card p-3 min-[430px]:p-4">
      <p className="label-accent">
        Readiness trend
      </p>
      {recentEntries.length ? (
        <div className="mt-3 space-y-2">
          {recentEntries.map((entry) => {
            const copy = getReadinessCopy(entry.readiness);
            const width = Math.max(8, Math.min(100, (entry.readiness.averageScore / 5) * 100));

            return (
              <div
                key={entry.sessionId ? `${entry.date}:${entry.sessionId}` : entry.date}
                className="card-inset px-3 py-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-text-1">{formatDateKey(entry.date)}</p>
                  <p className="text-xs font-semibold text-text-2">
                    {copy.label} {entry.readiness.averageScore.toFixed(1)}
                  </p>
                </div>
                <div className="bar mt-2">
                  <div
                    className={`bar-fill ${
                      entry.readiness.status === "green"
                        ? "bg-good"
                        : entry.readiness.status === "red"
                          ? "bg-bad"
                          : "bg-warn"
                    }`}
                    style={{ width: `${width}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <ProgressEmptyState
          title="No readiness check-ins yet."
          body="Save readiness to compare recovery with performance."
        />
      )}
    </section>
  );
}
