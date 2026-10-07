import Metric from "../ui/Metric.jsx";
import { formatVolume } from "../../lib/sessionAnalytics.js";

export default function PostWorkoutCoachRecap({ recap, onDismiss, onGoToWorkouts, onGoToHistory }) {
  if (!recap) {
    return null;
  }

  return (
    <section className="card-active p-3 min-[430px]:p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="label-accent">
            Workout saved
          </p>
          <h2 className="mt-1 break-words text-[17px] font-semibold text-text-1">{recap.dayName}</h2>
          <p className="mt-1 text-sm font-medium text-text-2">{recap.programName}</p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="focus-ring btn btn-ghost btn-sm min-h-11 shrink-0"
        >
          Close
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-center min-[430px]:grid-cols-4">
        <Metric label="Exercises" value={recap.exerciseCount} />
        <Metric label="Sets" value={recap.setCount} />
        <Metric label="Volume" value={formatVolume(recap.totalVolume)} />
        <Metric
          label="Saved"
          value={recap.savedAt ? new Date(recap.savedAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }) : "Now"}
        />
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <RecapNote label="Top set" text={recap.bestSetText} />
        <RecapNote label="Improved" text={recap.improvedText} tone="text-accent-soft" />
        <RecapNote label="Watch" text={recap.watchText} />
        <RecapNote label="Next" text={recap.nextText} />
        {/* H5-10 / H5-12: records, adherence, coach status and comparison lines. */}
        {recap.recordsText && <RecapNote label="Records" text={recap.recordsText} tone="text-accent-soft" />}
        {recap.adherenceText && <RecapNote label="Adherence" text={recap.adherenceText} />}
        {recap.coachStatusText && <RecapNote label="Coach status" text={recap.coachStatusText} />}
        {recap.comparisonText && <RecapNote label="Comparison" text={recap.comparisonText} />}
      </div>

      <div className="mt-3 grid gap-2 min-[430px]:grid-cols-2">
        <button
          type="button"
          onClick={onGoToWorkouts}
          className="focus-ring btn btn-primary min-h-11"
        >
          Go to Workouts
        </button>
        <button
          type="button"
          onClick={onGoToHistory}
          className="focus-ring btn btn-secondary min-h-11"
        >
          View History
        </button>
      </div>
    </section>
  );
}

// HV-9: recap rows are card-inset blocks; improvements and records read in
// accent-soft; the watch line stays text-1 (the recap model does not say
// whether it holds a warning, and warn is kept for real warnings).
function RecapNote({ label, text, tone = "text-text-1" }) {
  return (
    <div className="card-inset">
      <p className="label">{label}</p>
      <p className={`text-sm font-medium leading-5 ${tone}`}>{text}</p>
    </div>
  );
}
