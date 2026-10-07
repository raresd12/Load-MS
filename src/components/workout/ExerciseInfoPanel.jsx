import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { formatTechnicalValue, getExerciseVideoUrl } from "../../lib/prescriptionView.js";
import {
  getTechniqueBullets,
  isAiTechniqueDraftEntry,
  TECHNIQUE_DRAFT_BADGE,
} from "../../lib/libraryReview.js";

/** Shown wherever AI technique notes are read before the owner reviewed them (H3-6, H3-9). */
export function AiTechniqueBadge({ className = "" }) {
  return (
    <span
      data-testid="ai-technique-badge"
      className={`${className} pill pill-warn`}
    >
      {TECHNIQUE_DRAFT_BADGE}
    </span>
  );
}

export function CheckVideoLink({ exercise, className = "", emptyLabel = "Check Video not added yet." }) {
  const videoUrl = getExerciseVideoUrl(exercise);

  if (!videoUrl) {
    return (
      <span className={`${className} text-sm font-semibold text-text-2`}>
        {emptyLabel}
      </span>
    );
  }

  return (
    <a
      href={videoUrl}
      target="_blank"
      rel="noreferrer"
      className={`${className} focus-ring inline-flex min-h-11 items-center rounded-control text-sm font-semibold text-accent-soft underline underline-offset-4 hover:text-accent`}
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
    <div className={`${className} card-inset p-2`}>
      {isAiTechniqueDraftEntry(exercise) && <AiTechniqueBadge className="mb-2" />}
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(160px,220px)]">
        <ExerciseDetailField
          label="Main Cue"
          value={exercise.mainCue}
          className="border border-line-accent bg-accent-tint"
          maxItems={2}
        />
        <div className="rounded-block bg-accent-tint px-3 py-2">
          <p className="label-accent">
            Check Video
          </p>
          <div className="mt-1">
            {hasVideoUrl ? (
              <CheckVideoLink exercise={exercise} />
            ) : (
              <p className="text-sm font-semibold text-text-2">Video not added yet.</p>
            )}
          </div>
        </div>
      </div>

      <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {primaryInfoFields.map(([label, value]) => (
          <ExerciseDetailField key={label} label={label} value={value} />
        ))}
      </div>

      <details className="mt-2 rounded-control border border-line bg-surface-1">
        <summary className="focus-ring flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-semibold text-text-2">
          More coaching notes
          <ChevronDown aria-hidden="true" size={14} className="disclosure-chevron text-text-2" />
        </summary>
        <div className="grid gap-2 border-t border-line p-2 md:grid-cols-2 xl:grid-cols-4">
          {secondaryInfoFields.map(([label, value]) => (
            <ExerciseDetailField
              key={label}
              label={label}
              value={value}
              className="bg-surface-2"
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
      className="focus-ring btn btn-secondary mt-2 w-full text-sm"
    >
      Close Details
    </button>
  );
}

function ExerciseDetailField({ label, value, className = "bg-surface-1", compact = false, maxItems = 4 }) {
  const bullets = getTechniqueBullets(value);
  const text = bullets ? bullets.join(", ") : formatTechnicalValue(value);

  return (
    <div className={`rounded-control px-3 ${compact ? "py-2" : "py-2.5"} ${className}`}>
      <p className="label">
        {label}
      </p>
      <TechnicalContent value={value} fallback={text || "Not added yet."} maxItems={maxItems} />
    </div>
  );
}

function TechnicalContent({ value, fallback, maxItems = 4 }) {
  const [isExpanded, setIsExpanded] = useState(false);

  // A list, or text with one "- bullet" per line (imported entries): both
  // are shown as the same bullet list.
  const items = getTechniqueBullets(value);

  if (items) {
    const visibleItems = isExpanded ? items : items.slice(0, maxItems);
    const hasHiddenItems = items.length > maxItems;

    return (
      <>
        <ul className="mt-1 space-y-0.5 text-[13px] font-semibold leading-5 text-text-1">
          {visibleItems.map((item, index) => (
            <li key={`${index}-${item}`} className="flex gap-2">
              <span aria-hidden="true" className="mt-[0.6em] h-1 w-1 shrink-0 rounded-full bg-accent" />
              <span className="min-w-0 break-words">{item}</span>
            </li>
          ))}
        </ul>
        {hasHiddenItems && (
          <button
            type="button"
            onClick={() => setIsExpanded((current) => !current)}
            className="focus-ring btn btn-ghost mt-1 px-2 text-xs"
          >
            {isExpanded ? "Show less" : `Show ${items.length - maxItems} more`}
          </button>
        )}
      </>
    );
  }

  return (
    <p className="mt-1 whitespace-pre-line break-words text-[13px] font-semibold leading-5 text-text-1">
      {fallback}
    </p>
  );
}
