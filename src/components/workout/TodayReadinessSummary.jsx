import { getReadinessCopy, readinessStyles } from "../readiness/readinessCopy.js";

export default function TodayReadinessSummary({ savedEntry, readiness, onGoToReadiness }) {
  if (!savedEntry) {
    return (
      <section className="rounded-[8px] border border-amber-300/40 bg-amber-300/10 p-4">
        <p className="text-sm font-black text-amber-100">
          No readiness check-in saved for today.
        </p>
        <p className="mt-1 text-sm font-semibold text-amber-100/90">
          Complete it before training for better same-day guidance and smarter progression
          recommendations.
        </p>
        <button
          type="button"
          onClick={onGoToReadiness}
          className="focus-ring mt-3 min-h-10 rounded-[8px] bg-amber-300 px-3 text-sm font-black text-zinc-950"
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
      className={`rounded-[8px] border p-4 ${
        readinessStyles[readiness.status] ?? readinessStyles.yellow
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-black">Today's Readiness: {copy.label}</p>
          <p className="mt-1 text-sm font-semibold opacity-90">
            Average wellness: {readiness.averageScore.toFixed(1)} / 5
          </p>
          <p className="mt-1 text-sm font-semibold opacity-90">{copy.summary}</p>
        </div>
        <button
          type="button"
          onClick={onGoToReadiness}
          className="focus-ring min-h-10 rounded-[8px] border border-current px-3 text-sm font-black"
        >
          Edit Today's Readiness
        </button>
      </div>
    </section>
  );
}
