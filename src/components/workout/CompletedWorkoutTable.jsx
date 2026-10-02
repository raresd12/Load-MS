import { useEffect, useRef, useState } from "react";
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
    <details className="mb-3 rounded-[8px] border border-zinc-800 bg-[#171717] px-3 py-2 text-sm text-zinc-300">
      <summary className="cursor-pointer text-xs font-black uppercase tracking-[0.12em] text-lime-300">
        RPE guide
      </summary>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {entries.map(([score, description]) => (
          <p key={score} className="rounded-[8px] bg-zinc-900 px-2 py-1 text-xs font-semibold">
            <span className="font-black text-white">RPE {score}</span> - {description}
          </p>
        ))}
      </div>
      {showAthleticNote && (
        <p className="mt-3 text-xs font-semibold text-amber-100">
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
              className={`scroll-mt-28 rounded-[8px] border p-3 transition duration-500 ${
                isHighlighted
                  ? "border-lime-300 bg-lime-300/10 shadow-lg shadow-lime-950/40"
                  : "border-zinc-800 bg-[#171717]"
              }`}
            >
              <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="font-black text-white">{exercise.name}</h3>
                  <p className="mt-1 text-xs font-semibold text-zinc-400 sm:hidden">
                    {formatMobilePlanSummary(planExercise, profile)}
                  </p>
                  <p className="hidden text-xs font-semibold text-zinc-400 sm:block">
                    {formatPlanTarget(planExercise, profile)} | {formatWeight(planExercise.recommendedWeight, exercise)} | Target RPE {planExercise.targetRPE} | {formatRest(planExercise.restSeconds)}
                  </p>
                </div>
              </div>

              {renderExerciseExtras?.(exercise, planExercise)}

              <div className="mt-3 space-y-3">
                <SavedSetsSummary profile={profile} sets={draftExercise.sets} />
                <div className="flex flex-wrap items-center gap-2">
                  <p className="inline-flex rounded-[8px] border border-lime-300/20 bg-lime-300/10 px-3 py-2 text-xs font-black text-lime-100">
                    Auto Exercise RPE:{" "}
                    <span className="ml-1">
                      {autoExerciseRpe === null ? "--" : autoExerciseRpe.toFixed(1)}
                    </span>
                  </p>
                  <button
                    type="button"
                    onClick={() => onTogglePainFlag(exercise.id, !draftExercise.painFlag)}
                    aria-pressed={Boolean(draftExercise.painFlag)}
                    className={`focus-ring inline-flex min-h-11 items-center rounded-[8px] border px-3 text-xs font-black ${
                      draftExercise.painFlag
                        ? "border-red-400/60 bg-red-400/15 text-red-100"
                        : "border-zinc-700 bg-[#111111] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                    }`}
                  >
                    {draftExercise.painFlag ? "Pain flagged" : "Felt pain? Flag it"}
                  </button>
                </div>
                {draftExercise.painFlag && (
                  <p className="rounded-[8px] border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs font-bold leading-5 text-red-100">
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
    <div className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-xs font-black uppercase tracking-[0.12em] text-zinc-400">
          Set {setIndex + 1}
        </p>
        <span className="rounded-[6px] bg-[#111111] px-2 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-zinc-400">
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
          <p className="rounded-[8px] border border-zinc-800 bg-[#111111] px-3 py-2 text-xs font-black text-zinc-200">
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
        <p className="mt-2 text-[11px] font-semibold leading-4 text-zinc-400">
          {labels.notes.join(" ")}
        </p>
      )}
      {errors.length > 0 && (
        <div className="mt-3 rounded-[8px] border border-red-400/50 bg-red-400/10 px-3 py-2 text-xs font-bold text-red-100">
          {errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
        </div>
      )}
      {saveMessage && (
        <p className="mt-3 rounded-[8px] bg-lime-300/10 px-3 py-2 text-xs font-black text-lime-100">
          {saveMessage}
        </p>
      )}
      <button
        type="button"
        onClick={saveSet}
        className="focus-ring mt-3 min-h-10 w-full rounded-[8px] bg-lime-300 px-3 text-sm font-black text-zinc-950 hover:bg-lime-200"
      >
        Save Set
      </button>
    </div>
  );
}

function SavedSetsSummary({ profile, sets }) {
  return (
    <div>
      <p className="rounded-[8px] bg-zinc-900 px-2 py-1 text-[11px] font-bold leading-relaxed text-zinc-400 sm:hidden">
        {sets.map((set, index) => formatSetEntrySummary(set, index, profile)).join(" | ")}
      </p>
      <div className="hidden gap-1.5 sm:grid sm:grid-cols-2">
        {sets.map((set, index) => {
          const isEmpty = !hasSetEntryValue(set);

          return (
            <p
              key={index}
              className={`rounded-[8px] px-2 py-1 text-xs font-bold ${
                isEmpty ? "bg-zinc-900 text-zinc-400" : "bg-lime-300/10 text-lime-100"
              }`}
            >
              {formatSetEntrySummary(set, index, profile).replace(/^S(\d+) /, "Set $1: ")}
            </p>
          );
        })}
      </div>
      <p className="mt-1 text-[11px] font-semibold text-zinc-400">
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
