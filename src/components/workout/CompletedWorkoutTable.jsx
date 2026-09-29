import { useEffect, useRef, useState } from "react";
import SectionShell from "../ui/SectionShell.jsx";
import StepperInput from "./StepperInput.jsx";
import UnifiedSetEntry from "./UnifiedSetEntry.jsx";
import {
  adjustInputValue,
  getRecommendedSetEntryDefaults,
  getSetEntryValues,
  validateSetEntry,
} from "../../lib/sessionNormalize.js";
import { formatRest, formatSetsReps, formatWeight } from "../../lib/progression.js";
import { isBodyweightText } from "../../lib/sessionLog.js";
import { calculateAutoExerciseRpe, getPlanExercise, isBlank } from "../../lib/sessionNormalize.js";

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
                    {formatMobilePlanSummary(planExercise)}
                  </p>
                  <p className="hidden text-xs font-semibold text-zinc-400 sm:block">
                    {formatSetsReps(planExercise)} | {formatWeight(planExercise.recommendedWeight, exercise)} | Target RPE {planExercise.targetRPE} | {formatRest(planExercise.restSeconds)}
                  </p>
                </div>
              </div>

              <div className="mt-3 space-y-3">
                <SavedSetsSummary exercise={exercise} sets={draftExercise.sets} />
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
  const [values, setValues] = useState(() =>
    getSetEntryValues(set ?? {}, getRecommendedSetEntryDefaults(exercise, planExercise)),
  );
  const [errors, setErrors] = useState([]);
  const [saveMessage, setSaveMessage] = useState("");
  const justSavedRef = useRef(false);

  useEffect(() => {
    setValues(getSetEntryValues(set ?? {}, getRecommendedSetEntryDefaults(exercise, planExercise)));
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
    const nextErrors = validateSetEntry(values, exercise);

    if (nextErrors.length) {
      setErrors(nextErrors);
      setSaveMessage("");
      return;
    }

    justSavedRef.current = true;
    onSave(setIndex, values);
    setErrors([]);
    setSaveMessage(`Set ${setIndex + 1} saved.`);
  }

  function handleInputKeyDown(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      saveSet();
    }
  }

  const hasSavedValue = !isBlank(set?.reps) || !isBlank(set?.weight) || !isBlank(set?.rpe);

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
          label="Reps"
          value={values.reps}
          onChange={(value) => updateValue("reps", value)}
          onKeyDown={handleInputKeyDown}
          enterKeyHint="done"
          onStep={(delta) => updateValue("reps", adjustInputValue(values.reps, delta, { min: 0 }))}
          stepAmount={1}
          type="number"
          inputMode="numeric"
          placeholder="reps"
        />
        <StepperInput
          label="Kg"
          value={values.weight}
          onChange={(value) => updateValue("weight", value)}
          onKeyDown={handleInputKeyDown}
          enterKeyHint="done"
          onStep={(delta) =>
            updateValue("weight", adjustInputValue(values.weight, delta, { min: 0 }))
          }
          stepAmount={1}
          type={exercise.loadType === "bodyweight" || exercise.loadType === "optionalExternal" ? "text" : "number"}
          inputMode={exercise.loadType === "bodyweight" || exercise.loadType === "optionalExternal" ? "text" : "decimal"}
          placeholder={exercise.loadType === "bodyweight" || exercise.loadType === "optionalExternal" ? "BW" : "kg"}
        />
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

function SavedSetsSummary({ exercise, sets }) {
  return (
    <div>
      <p className="rounded-[8px] bg-zinc-900 px-2 py-1 text-[11px] font-bold leading-relaxed text-zinc-400 sm:hidden">
        {sets.map((set, index) => formatMobileSetSummary(set, index, exercise)).join(" | ")}
      </p>
      <div className="hidden gap-1.5 sm:grid sm:grid-cols-2">
        {sets.map((set, index) => {
          const isEmpty = isBlank(set.reps) && isBlank(set.weight) && isBlank(set.rpe);

          return (
            <p
              key={index}
              className={`rounded-[8px] px-2 py-1 text-xs font-bold ${
                isEmpty ? "bg-zinc-900 text-zinc-400" : "bg-lime-300/10 text-lime-100"
              }`}
            >
              Set {index + 1}:{" "}
              {isEmpty
                ? "empty"
                : `${formatSetWeightSummary(set.weight, exercise)} x ${isBlank(set.reps) ? "reps?" : set.reps} @ RPE ${isBlank(set.rpe) ? "?" : set.rpe}`}
            </p>
          );
        })}
      </div>
    </div>
  );
}

function formatMobilePlanSummary(planExercise) {
  return `${formatSetsReps(planExercise).replace("x ", "x")} | RPE ${planExercise.targetRPE} | Rest ${formatRest(planExercise.restSeconds)}`;
}

function formatMobileSetSummary(set, index, exercise) {
  const prefix = `S${index + 1}`;
  const isEmpty = isBlank(set.reps) && isBlank(set.weight) && isBlank(set.rpe);

  if (isEmpty) {
    return `${prefix} empty`;
  }

  return `${prefix} ${formatSetWeightSummary(set.weight, exercise)} x ${isBlank(set.reps) ? "?" : set.reps} @${isBlank(set.rpe) ? "?" : set.rpe}`;
}

function formatSetWeightSummary(weight, exercise) {
  if (isBlank(weight)) {
    return exercise.loadType === "bodyweight" ? "BW?" : "kg?";
  }

  if (isBodyweightText(weight)) {
    return "BW";
  }

  const numericWeight = Number(weight);
  if (!Number.isFinite(numericWeight)) {
    return String(weight);
  }

  const formattedWeight = Number.isInteger(numericWeight)
    ? numericWeight.toString()
    : numericWeight.toFixed(1);

  return `${formattedWeight}kg`;
}
