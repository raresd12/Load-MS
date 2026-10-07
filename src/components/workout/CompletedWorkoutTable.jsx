import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import SectionShell from "../ui/SectionShell.jsx";
import StepperInput from "./StepperInput.jsx";
import UnifiedSetEntry from "./UnifiedSetEntry.jsx";
import { adjustInputValue } from "../../lib/sessionNormalize.js";
import { formatRest, formatWeight } from "../../lib/progression.js";
import {
  calculateAutoExerciseRpe,
  getPlanExercise,
  validateSetEntry,
} from "../../lib/sessionNormalize.js";
import {
  formatSetEntrySummary,
  formatSetEntryTotals,
  formatSetTargetLabel,
  getSetEntryDefaults,
  getSetEntryLabels,
  getSetEntryProfile,
  hasSetEntryValue,
  readDraftSetValue,
  readSetEntryValues,
  toDraftSetPatch,
  validateSetEntryValues,
} from "../../lib/setEntryView.js";

function RpeHelper({ showAthleticNote = false }) {
  const entries = [
    ["5", "Very easy, 5+ reps in reserve"],
    ["5.5", "Easy, around 4-5 reps in reserve"],
    ["6", "Comfortable, around 4 reps in reserve"],
    ["6.5", "Moderate-light, around 3-4 reps in reserve"],
    ["7", "Productive and controlled, around 3 reps in reserve"],
    ["7.5", "Fairly hard, around 2-3 reps in reserve"],
    ["8", "Hard but clean, around 2 reps in reserve"],
    ["8.5", "Very hard, around 1-2 reps in reserve"],
    ["9", "Near limit, about 1 rep in reserve"],
    ["9.5", "Extremely hard, 0-1 reps in reserve"],
    ["10", "Maximal, no clean reps left"],
  ];

  return (
    <details className="group card-inset mb-3 py-1 text-sm text-text-2">
      {/* HV-11: a flex summary has no native marker, so the chevron shows it opens. */}
      <summary className="label-accent mb-0 flex min-h-11 cursor-pointer list-none items-center justify-between gap-3">
        RPE guide
        <ChevronDown aria-hidden="true" size={16} className="shrink-0 transition group-open:rotate-180" />
      </summary>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {entries.map(([score, description]) => (
          <p key={score} className="rounded-control bg-surface-1 px-2 py-1 text-xs font-medium">
            <span className="font-semibold text-text-1">RPE {score}</span> - {description}
          </p>
        ))}
      </div>
      {showAthleticNote && (
        <p className="mt-3 text-xs font-medium text-warn">
          For explosive work, high RPE can also mean speed or quality dropped too much.
        </p>
      )}
    </details>
  );
}

export default function CompletedWorkoutTable({
  day,
  plan,
  draft,
  exerciseRefs,
  highlightedExerciseId,
  onSaveSet,
  onTogglePainFlag,
  renderExerciseExtras,
}) {
  // Decision HV-9: the card being worked on is the scroll target, or else the
  // first exercise with a set still to log.
  const currentExerciseId = day.exercises.find((exercise) =>
    (draft.exercises[exercise.id]?.sets ?? []).some((set) => !hasSetEntryValue(set)),
  )?.id;

  return (
    <SectionShell title="Log Completed Workout">
      <div className="hidden sm:block">
        <RpeHelper
          showAthleticNote={day.exercises.some(
            (exercise) => exercise.progressionType === "athletic",
          )}
        />
      </div>
      <div className="space-y-3">
        {day.exercises.map((exercise) => {
          const planExercise = getPlanExercise(plan, exercise.id);
          const draftExercise = draft.exercises[exercise.id];
          const programExerciseId = exercise.programExerciseId ?? exercise.id;
          const isHighlighted = highlightedExerciseId === programExerciseId;
          const autoExerciseRpe = calculateAutoExerciseRpe(draftExercise);
          const profile = getSetEntryProfile(exercise);

          return (
            <article
              key={exercise.id}
              ref={(node) => {
                if (node) {
                  exerciseRefs.current[programExerciseId] = node;
                } else {
                  delete exerciseRefs.current[programExerciseId];
                }
              }}
              className={`scroll-mt-28 transition-colors duration-500 ${
                isHighlighted || (!highlightedExerciseId && exercise.id === currentExerciseId)
                  ? "card-active"
                  : "card-inset"
              }`}
            >
              <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-[17px] font-semibold leading-snug text-text-1">{exercise.name}</h3>
                  <p className="mt-1 text-sm font-medium tabular-nums text-text-2 sm:hidden">
                    {formatMobilePlanSummary(planExercise, profile)}
                  </p>
                  <p className="hidden text-xs font-medium tabular-nums text-text-2 sm:block">
                    {formatPlanTarget(planExercise, profile)} | {formatWeight(planExercise.recommendedWeight, exercise)} | Target RPE {planExercise.targetRPE} | {formatRest(planExercise.restSeconds)}
                  </p>
                </div>
              </div>

              {renderExerciseExtras?.(exercise, planExercise)}

              <div className="mt-3 space-y-3">
                <SavedSetsSummary profile={profile} sets={draftExercise.sets} />
                <div className="flex flex-wrap items-center gap-2">
                  <p className="pill pill-accent min-h-11 px-3 tabular-nums">
                    Auto Exercise RPE:{" "}
                    <span className="ml-1">
                      {autoExerciseRpe === null ? "--" : autoExerciseRpe.toFixed(1)}
                    </span>
                  </p>
                  <button
                    type="button"
                    onClick={() => onTogglePainFlag(exercise.id, !draftExercise.painFlag)}
                    aria-pressed={Boolean(draftExercise.painFlag)}
                    className={`focus-ring pill min-h-11 px-3 ${
                      draftExercise.painFlag ? "pill-bad" : "hover:text-text-1"
                    }`}
                  >
                    {draftExercise.painFlag ? "Pain flagged" : "Felt pain? Flag it"}
                  </button>
                </div>
                {draftExercise.painFlag && (
                  <p className="rounded-block bg-bad-tint px-3 py-2 text-xs font-medium leading-5 text-bad">
                    Noted. The coach will hold progression here and keep the next session
                    cautious. Stay in a pain-free range today.
                  </p>
                )}
                <div className="md:hidden">
                  <UnifiedSetEntry
                    exercise={exercise}
                    planExercise={planExercise}
                    sets={draftExercise.sets}
                    onSave={(index, values) => onSaveSet(exercise.id, index, values)}
                  />
                </div>
                <DesktopSetCardGrid
                  exercise={exercise}
                  planExercise={planExercise}
                  sets={draftExercise.sets}
                  onSave={(index, values) => onSaveSet(exercise.id, index, values)}
                />
              </div>
            </article>
          );
        })}
      </div>
    </SectionShell>
  );
}

function DesktopSetCardGrid({ exercise, planExercise, sets, onSave }) {
  return (
    <div className="hidden gap-2 md:grid md:grid-cols-2 lg:grid-cols-4">
      {sets.map((set, index) => (
        <DesktopSetCard
          key={index}
          exercise={exercise}
          planExercise={planExercise}
          set={set}
          setIndex={index}
          onSave={onSave}
        />
      ))}
    </div>
  );
}

function DesktopSetCard({ exercise, planExercise, set, setIndex, onSave }) {
  const profile = getSetEntryProfile(exercise);
  const labels = getSetEntryLabels(profile);
  const [values, setValues] = useState(() =>
    readSetEntryValues(set ?? {}, getSetEntryDefaults(exercise, planExercise, profile), profile),
  );
  const [errors, setErrors] = useState([]);
  const [saveMessage, setSaveMessage] = useState("");
  const justSavedRef = useRef(false);

  useEffect(() => {
    const nextProfile = getSetEntryProfile(exercise);
    setValues(readSetEntryValues(set ?? {}, getSetEntryDefaults(exercise, planExercise, nextProfile), nextProfile));
    setErrors([]);
    // The save itself updates `set`; keep the confirmation visible in that case.
    if (justSavedRef.current) {
      justSavedRef.current = false;
    } else {
      setSaveMessage("");
    }
  }, [exercise, planExercise, set]);

  function updateValue(field, value) {
    setValues((currentValues) => ({ ...currentValues, [field]: value }));
    setErrors([]);
    setSaveMessage("");
  }

  function saveSet() {
    // Plain reps + kg sets keep the H4 validator byte for byte; time, distance
    // and bodyweight sets validate per measurement (decision H5-13).
    const isLegacyRepsEntry = profile.measurement === "reps" && labels.showWeightInput && profile.loadType !== "optionalExternal";
    const nextErrors = isLegacyRepsEntry
      ? validateSetEntry({ reps: values.value, weight: values.weight, rpe: values.rpe }, exercise)
      : validateSetEntryValues(values, exercise, profile);

    if (nextErrors.length) {
      setErrors(nextErrors);
      setSaveMessage("");
      return;
    }

    justSavedRef.current = true;
    onSave(setIndex, toDraftSetPatch(values, profile));
    setErrors([]);
    setSaveMessage(`Set ${setIndex + 1} saved.`);
  }

  function handleInputKeyDown(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      saveSet();
    }
  }

  const hasSavedValue = hasSetEntryValue(set);
  const valueLabel = labels.valueHint ? `${labels.valueLabel} (${labels.valueHint})` : labels.valueLabel;
  const weightLabel = labels.weightHint ? `${labels.weightLabel} (${labels.weightHint})` : labels.weightLabel;

  return (
    <div className="rounded-block bg-surface-1 p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="label">
          Set {setIndex + 1}
        </p>
        <span className="pill">
          {hasSavedValue ? "Saved" : "Default"}
        </span>
      </div>
      <div className="grid gap-2">
        <StepperInput
          label={valueLabel}
          value={values.value}
          onChange={(value) => updateValue("value", value)}
          onKeyDown={handleInputKeyDown}
          enterKeyHint="done"
          onStep={(delta) => updateValue("value", adjustInputValue(values.value, delta, { min: 0 }))}
          stepAmount={labels.valueStep}
          type="number"
          inputMode="numeric"
          placeholder={labels.valuePlaceholder}
        />
        {labels.showWeightInput ? (
          <StepperInput
            label={weightLabel}
            value={values.weight}
            onChange={(value) => updateValue("weight", value)}
            onKeyDown={handleInputKeyDown}
            enterKeyHint="done"
            onStep={(delta) =>
              updateValue("weight", adjustInputValue(values.weight, delta, { min: 0 }))
            }
            stepAmount={1}
            type={labels.weightInputType}
            inputMode={labels.weightInputMode}
            placeholder={labels.weightPlaceholder}
          />
        ) : (
          <p className="card-inset flex min-h-14 items-center text-[15px] font-semibold text-text-1">
            Load: BW
          </p>
        )}
        <StepperInput
          label="RPE"
          value={values.rpe}
          onChange={(value) => updateValue("rpe", value)}
          onKeyDown={handleInputKeyDown}
          enterKeyHint="done"
          onStep={(delta) => updateValue("rpe", adjustInputValue(values.rpe, delta, { min: 1, max: 10 }))}
          stepAmount={0.5}
          type="number"
          inputMode="decimal"
          min="1"
          max="10"
          step="0.5"
          placeholder="8"
        />
      </div>
      {labels.notes.length > 0 && (
        <p className="mt-2 text-xs font-medium leading-4 text-text-2">
          {labels.notes.join(" ")}
        </p>
      )}
      {errors.length > 0 && (
        <div className="mt-3 rounded-block bg-bad-tint px-3 py-2 text-sm font-medium text-bad">
          {errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
        </div>
      )}
      {saveMessage && (
        <p className="set-saved mt-3 rounded-block bg-surface-2 px-3 py-2 text-sm font-medium text-accent-soft">
          {saveMessage}
        </p>
      )}
      <button
        type="button"
        onClick={saveSet}
        className="focus-ring btn btn-primary mt-3 min-h-11 w-full"
      >
        Save Set
      </button>
    </div>
  );
}

// Decision HV-9: logged sets read in text-2; the best one (heaviest load, then
// the larger count) is accent-soft once two sets are in, and a set whose
// summary just changed (it was saved) flashes with .set-saved.
function getBestSetIndex(sets, profile) {
  let bestIndex = -1;
  let bestKey = null;
  let savedCount = 0;

  sets.forEach((set, index) => {
    if (!hasSetEntryValue(set)) {
      return;
    }

    savedCount += 1;
    const key = [Number(set.weight) || 0, Number(readDraftSetValue(set, profile)) || 0];

    if (!bestKey || key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
      bestIndex = index;
      bestKey = key;
    }
  });

  return savedCount > 1 ? bestIndex : -1;
}

// Review round 2 (HV-12): a saved-set row carries exactly one text colour.
// Two colour utilities on one element resolve by stylesheet order, not class
// order (text-text-2 is emitted after text-accent-soft), so the best set lost
// its accent at sm and up. `inherit` is for the phone spans, which take the
// colour of their parent line unless they are the best set.
function setRowTone({ isBest, isEmpty, inherit = false }) {
  if (isBest) {
    return "font-semibold text-accent-soft";
  }

  if (inherit) {
    return "";
  }

  return isEmpty ? "text-text-3" : "text-text-2";
}

function SavedSetsSummary({ profile, sets }) {
  const summaries = sets.map((set, index) => formatSetEntrySummary(set, index, profile));
  const previousSummariesRef = useRef(null);
  const previousSummaries = previousSummariesRef.current;
  const bestIndex = getBestSetIndex(sets, profile);

  useEffect(() => {
    previousSummariesRef.current = summaries;
  });

  const justSavedClassName = (index) =>
    previousSummaries !== null && previousSummaries[index] !== summaries[index] && hasSetEntryValue(sets[index])
      ? "set-saved"
      : "";
  // The best set is not only a colour: screen readers hear it too.
  const bestSetCue = (index) => (index === bestIndex ? <span className="sr-only"> (best set)</span> : null);

  return (
    <div>
      <p className="text-xs font-medium leading-relaxed tabular-nums text-text-2 sm:hidden">
        {summaries.map((summary, index) => (
          <span
            key={index}
            className={`rounded-control ${setRowTone({ isBest: index === bestIndex, inherit: true })} ${justSavedClassName(index)}`}
          >
            {index > 0 ? " | " : ""}
            {summary}
            {bestSetCue(index)}
          </span>
        ))}
      </p>
      <div className="hidden gap-1.5 sm:grid sm:grid-cols-2">
        {sets.map((set, index) => {
          const isEmpty = !hasSetEntryValue(set);

          return (
            <p
              key={index}
              className={`rounded-control bg-surface-1 px-2 py-1 text-xs font-medium tabular-nums ${setRowTone({
                isBest: index === bestIndex,
                isEmpty,
              })} ${justSavedClassName(index)}`}
            >
              {formatSetEntrySummary(set, index, profile).replace(/^S(\d+) /, "Set $1: ")}
              {bestSetCue(index)}
            </p>
          );
        })}
      </div>
      <p className="mt-1 text-xs font-medium tabular-nums text-text-3">
        {formatSetEntryTotals(sets, profile)}
      </p>
    </div>
  );
}

function formatPlanTarget(planExercise, profile) {
  return `${planExercise.sets} x ${formatSetTargetLabel(planExercise, profile) || planExercise.repsLabel || "?"}`;
}

function formatMobilePlanSummary(planExercise, profile) {
  return `${planExercise.sets}x${formatSetTargetLabel(planExercise, profile) || planExercise.repsLabel || "?"} | RPE ${planExercise.targetRPE} | Rest ${formatRest(planExercise.restSeconds)}`;
}
