import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { formatTechnicalValue, getExerciseVideoUrl } from "../../lib/prescriptionView.js";

export function CheckVideoLink({ exercise, className = "", emptyLabel = "Check Video not added yet." }) {
  const videoUrl = getExerciseVideoUrl(exercise);

  if (!videoUrl) {
    return (
      <span className={`${className} text-sm font-black text-zinc-400`}>
        {emptyLabel}
      </span>
    );
  }

  return (
    <a
      href={videoUrl}
      target="_blank"
      rel="noreferrer"
      className={`${className} focus-ring inline-flex min-h-9 items-center rounded-[8px] text-sm font-black text-sky-300 underline underline-offset-4 hover:text-sky-200`}
    >
      Check Video
    </a>
  );
}

export default function ExerciseInfoPanel({ exercise, setupCue, className = "", onClose }) {
  const primaryInfoFields = [
    ["Setup", exercise.setup || setupCue],
    ["How To Do It", exercise.howToDoIt],
    ["Common Mistakes", exercise.commonMistakes],
    ["What You Should Feel", exercise.whatYouShouldFeel],
  ];
  const secondaryInfoFields = [
    ["Execution Tips", exercise.executionTips],
    ["Why It's There", exercise.whyItsThere],
    ["Progression / Regression", exercise.progressionRegression],
    ["Safety Notes", exercise.safetyNotes],
  ];
  const hasVideoUrl = Boolean(getExerciseVideoUrl(exercise));

  return (
    <div className={`${className} rounded-[8px] border border-zinc-800 bg-[#141414] p-2`}>
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(160px,220px)]">
        <ExerciseDetailField
          label="Main Cue"
          value={exercise.mainCue}
          className="border border-lime-300/20 bg-lime-300/10"
          maxItems={2}
        />
        <div className="rounded-[8px] border border-sky-300/20 bg-sky-300/10 px-3 py-2">
          <p className="text-[10px] font-black uppercase tracking-[0.12em] text-sky-200/80">
            Check Video
          </p>
          <div className="mt-1">
            {hasVideoUrl ? (
              <CheckVideoLink exercise={exercise} />
            ) : (
              <p className="text-sm font-black text-zinc-400">Video not added yet.</p>
            )}
          </div>
        </div>
      </div>

      <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {primaryInfoFields.map(([label, value]) => (
          <ExerciseDetailField key={label} label={label} value={value} />
        ))}
      </div>

      <details className="mt-2 rounded-[8px] border border-zinc-800 bg-zinc-900/70">
        <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-zinc-300">
          More coaching notes
          <ChevronDown aria-hidden="true" size={14} className="text-zinc-400" />
        </summary>
        <div className="grid gap-2 border-t border-zinc-800 p-2 md:grid-cols-2 xl:grid-cols-4">
          {secondaryInfoFields.map(([label, value]) => (
            <ExerciseDetailField
              key={label}
              label={label}
              value={value}
              className="bg-[#111111]"
              compact
            />
          ))}
        </div>
      </details>

      <ExerciseDetailsCloseButton onClose={onClose} />
    </div>
  );
}

function ExerciseDetailsCloseButton({ onClose }) {
  if (!onClose) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={onClose}
      className="focus-ring mt-2 flex min-h-11 w-full items-center justify-center rounded-[8px] border border-lime-300/60 bg-lime-300/10 px-3 text-sm font-black text-lime-100 hover:bg-lime-300/15"
    >
      Close Details
    </button>
  );
}

function ExerciseDetailField({ label, value, className = "bg-zinc-900", compact = false, maxItems = 4 }) {
  const text = formatTechnicalValue(value);

  return (
    <div className={`rounded-[8px] px-3 ${compact ? "py-2" : "py-2.5"} ${className}`}>
      <p className="text-[10px] font-black uppercase tracking-[0.12em] text-zinc-400">
        {label}
      </p>
      <TechnicalContent value={value} fallback={text || "Not added yet."} maxItems={maxItems} />
    </div>
  );
}

function TechnicalContent({ value, fallback, maxItems = 4 }) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (Array.isArray(value)) {
    const items = value.map((item) => String(item ?? "").trim()).filter(Boolean);

    if (items.length) {
      const visibleItems = isExpanded ? items : items.slice(0, maxItems);
      const hasHiddenItems = items.length > maxItems;

      return (
        <>
          <ul className="mt-1 space-y-0.5 text-[13px] font-semibold leading-5 text-zinc-200">
            {visibleItems.map((item) => (
              <li key={item} className="flex gap-2">
                <span aria-hidden="true" className="mt-[0.6em] h-1 w-1 shrink-0 rounded-full bg-lime-300" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
          {hasHiddenItems && (
            <button
              type="button"
              onClick={() => setIsExpanded((current) => !current)}
              className="focus-ring mt-1 min-h-8 rounded-[8px] px-2 text-xs font-black text-lime-200 hover:bg-lime-300/10"
            >
              {isExpanded ? "Show less" : `Show ${items.length - maxItems} more`}
            </button>
          )}
        </>
      );
    }
  }

  return (
    <p className="mt-1 text-[13px] font-semibold leading-5 text-zinc-200">
      {fallback}
    </p>
  );
}
