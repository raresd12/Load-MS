import Metric from "../ui/Metric.jsx";
import { formatVolume } from "../../lib/sessionAnalytics.js";

export default function PostWorkoutCoachRecap({ recap, onDismiss, onGoToWorkouts, onGoToHistory }) {
  if (!recap) {
    return null;
  }

  return (
    <section className="rounded-[8px] border border-lime-300/50 bg-lime-300/10 p-3 min-[430px]:p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-lime-200">
            Workout saved
          </p>
          <h2 className="mt-1 break-words text-xl font-black text-white">{recap.dayName}</h2>
          <p className="mt-1 text-sm font-semibold text-lime-100/80">{recap.programName}</p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="focus-ring min-h-10 shrink-0 rounded-[8px] border border-lime-300/50 px-3 text-xs font-black uppercase tracking-[0.08em] text-lime-100 hover:bg-lime-300/10"
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
        <RecapNote label="Improved" text={recap.improvedText} />
        <RecapNote label="Watch" text={recap.watchText} />
        <RecapNote label="Next" text={recap.nextText} />
        {/* H5-10 / H5-12: records, adherence, coach status and comparison lines. */}
        {recap.recordsText && <RecapNote label="Records" text={recap.recordsText} />}
        {recap.adherenceText && <RecapNote label="Adherence" text={recap.adherenceText} />}
        {recap.coachStatusText && <RecapNote label="Coach status" text={recap.coachStatusText} />}
        {recap.comparisonText && <RecapNote label="Comparison" text={recap.comparisonText} />}
      </div>

      <div className="mt-3 grid gap-2 min-[430px]:grid-cols-2">
        <button
          type="button"
          onClick={onGoToWorkouts}
          className="focus-ring min-h-11 rounded-[8px] bg-lime-300 px-3 text-sm font-black text-zinc-950 hover:bg-lime-200"
        >
          Go to Workouts
        </button>
        <button
          type="button"
          onClick={onGoToHistory}
          className="focus-ring min-h-11 rounded-[8px] border border-lime-300/60 px-3 text-sm font-black text-lime-100 hover:bg-lime-300/10"
        >
          View History
        </button>
      </div>
    </section>
  );
}

function RecapNote({ label, text }) {
  return (
    <div className="rounded-[8px] border border-lime-300/20 bg-[#111111]/80 px-3 py-2">
      <p className="text-[11px] font-black uppercase tracking-[0.14em] text-lime-300">{label}</p>
      <p className="mt-1 text-sm font-semibold leading-5 text-zinc-100">{text}</p>
    </div>
  );
}
