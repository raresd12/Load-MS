import { getReadinessCopy, readinessStyles } from "../readiness/readinessCopy.js";

export default function TodayReadinessSummary({ savedEntry, readiness, onGoToReadiness }) {
  if (!savedEntry) {
    return (
      <section className="card border border-warn/40">
        <p className="text-[15px] font-semibold text-warn">
          No readiness check-in saved for today.
        </p>
        <p className="mt-1 text-sm font-medium text-text-2">
          Complete it before training for better same-day guidance and smarter progression
          recommendations.
        </p>
        <button
          type="button"
          onClick={onGoToReadiness}
          className="focus-ring btn btn-primary mt-3"
        >
          Go to Readiness
        </button>
      </section>
    );
  }

  const copy = getReadinessCopy(readiness);

  return (
    <section
      data-testid="today-readiness-summary"
      className={`rounded-card border p-4 ${
        readinessStyles[readiness.status] ?? readinessStyles.yellow
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-[15px] font-semibold">Today's Readiness: {copy.label}</p>
          <p className="mt-1 text-sm font-medium tabular-nums text-text-1">
            Average wellness: {readiness.averageScore.toFixed(1)} / 5
          </p>
          <p className="mt-1 text-sm font-medium text-text-1">{copy.summary}</p>
        </div>
        <button
          type="button"
          onClick={onGoToReadiness}
          className="focus-ring btn btn-secondary"
        >
          Edit Today's Readiness
        </button>
      </div>
    </section>
  );
}
