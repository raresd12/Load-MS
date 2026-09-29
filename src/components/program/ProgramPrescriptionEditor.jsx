import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { ProgramEditorField, ProgramTextArea } from "./ProgramFields.jsx";
import { formatRest, formatWeight } from "../../lib/progression.js";
import {
  createProgramExerciseTargetForm,
  validateProgramExerciseTargetForm,
} from "../../lib/programTargetForm.js";

export default function ProgramPrescriptionEditor({ program, days, onUpdateProgramExerciseTarget }) {
  if (!days.length) {
    return (
      <p className="mt-3 rounded-[8px] bg-[#111111] px-3 py-3 text-sm font-semibold text-zinc-400">
        No training days found for this program yet.
      </p>
    );
  }

  return (
    <div className="mt-3 space-y-3">
      <p className="text-sm leading-6 text-zinc-400">
        Edit planned targets only. This does not change exercise library info or completed workout
        history.
      </p>
      {days.map((day) => {
        const sections = day.sections?.length
          ? day.sections
          : [{ id: "main", name: "Main Work" }];

        return (
          <details key={day.id} className="rounded-[8px] border border-zinc-800 bg-[#111111]">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2">
              <span className="min-w-0">
                <span className="block text-sm font-black text-white">{day.name}</span>
                <span className="block text-xs font-semibold text-zinc-400">
                  {day.focus} | {day.exercises.length} exercises
                </span>
              </span>
              <ChevronDown aria-hidden="true" size={16} className="shrink-0 text-zinc-400" />
            </summary>
            <div className="space-y-3 border-t border-zinc-800 p-3">
              {sections.map((section) => {
                const exercises = day.exercises.filter((exercise) =>
                  exercise.sectionId ? exercise.sectionId === section.id : section.id === "main",
                );

                if (!exercises.length) {
                  return null;
                }

                return (
                  <div key={section.id} className="space-y-2">
                    <p className="text-xs font-black uppercase tracking-[0.14em] text-lime-300">
                      {section.name}
                    </p>
                    {exercises.map((exercise) => (
                      <ProgramExerciseTargetEditor
                        key={exercise.programExerciseId ?? exercise.id}
                        program={program}
                        exercise={exercise}
                        onUpdateProgramExerciseTarget={onUpdateProgramExerciseTarget}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          </details>
        );
      })}
    </div>
  );
}

function ProgramExerciseTargetEditor({ program, exercise, onUpdateProgramExerciseTarget }) {
  const [isOpen, setIsOpen] = useState(false);
  const [form, setForm] = useState(() => createProgramExerciseTargetForm(exercise));
  const [errors, setErrors] = useState([]);
  const [saveMessage, setSaveMessage] = useState("");
  const prescriptionText = `${exercise.sets}x ${exercise.repsLabel} | ${formatWeight(exercise.recommendedWeight, exercise)} | RPE ${exercise.targetRPE} | ${formatRest(exercise.restSeconds)}`;

  useEffect(() => {
    // Re-sync the form when the stored target changes (including right after our
    // own save); the "Saved target." message is kept so the user sees it.
    setForm(createProgramExerciseTargetForm(exercise));
    setErrors([]);
  }, [
    exercise.programExerciseId,
    exercise.sets,
    exercise.repsMin,
    exercise.repsMax,
    exercise.repsLabel,
    exercise.recommendedWeight,
    exercise.targetRPE,
    exercise.restSeconds,
    exercise.notes,
  ]);

  function updateField(field, value) {
    setForm((currentForm) => ({ ...currentForm, [field]: value }));
    setErrors([]);
    setSaveMessage("");
  }

  function saveTarget() {
    const result = validateProgramExerciseTargetForm(form, exercise);

    if (!result.valid) {
      setErrors(result.errors);
      setSaveMessage("");
      return;
    }

    const saveResult = onUpdateProgramExerciseTarget(
      program.id,
      exercise.programExerciseId ?? exercise.id,
      result.patch,
    );

    if (!saveResult?.ok) {
      setErrors([
        saveResult?.error ??
          "This program target could not be saved. Duplicate the default program first.",
      ]);
      setSaveMessage("");
      return;
    }

    setErrors([]);
    setSaveMessage(
      saveResult.deletedProgression
        ? "Saved target. The earned progression and pending plan for this exercise were reset, so the next session starts from the new target."
        : "Saved target.",
    );
  }

  return (
    <details
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
      className="rounded-[8px] border border-zinc-800 bg-zinc-900"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2">
        <span className="min-w-0">
          <span className="block break-words text-sm font-black text-white">{exercise.name}</span>
          <span className="mt-1 block text-xs font-semibold leading-5 text-zinc-400">
            {prescriptionText}
          </span>
        </span>
        <span className="shrink-0 rounded-[8px] border border-zinc-700 px-2 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-zinc-300">
          Edit
        </span>
      </summary>
      <div className="space-y-3 border-t border-zinc-800 p-3">
        <div className="grid gap-3 min-[430px]:grid-cols-2 lg:grid-cols-4">
          <ProgramEditorField
            label="Sets"
            value={form.targetSets}
            onChange={(value) => updateField("targetSets", value)}
            inputMode="numeric"
          />
          <ProgramEditorField
            label="Reps Min"
            value={form.repsMin}
            onChange={(value) => updateField("repsMin", value)}
            inputMode="numeric"
          />
          <ProgramEditorField
            label="Reps Max"
            value={form.repsMax}
            onChange={(value) => updateField("repsMax", value)}
            inputMode="numeric"
          />
          <ProgramEditorField
            label="Reps Label"
            value={form.repsLabel}
            onChange={(value) => updateField("repsLabel", value)}
            placeholder="Optional"
          />
          <ProgramEditorField
            label="Kg / Weight"
            value={form.targetWeight}
            onChange={(value) => updateField("targetWeight", value)}
            placeholder={exercise.loadType === "bodyweight" ? "BW" : "Enter kg"}
            inputMode="decimal"
          />
          <ProgramEditorField
            label="Target RPE"
            value={form.targetRPE}
            onChange={(value) => updateField("targetRPE", value)}
            inputMode="decimal"
          />
          <ProgramEditorField
            label="Rest (sec or min-max)"
            value={form.restTime}
            onChange={(value) => updateField("restTime", value)}
            placeholder="90 or 150-180"
            inputMode="text"
          />
        </div>
        <ProgramTextArea
          label="Program Exercise Notes"
          value={form.notes}
          onChange={(value) => updateField("notes", value)}
        />
        {errors.length > 0 && (
          <div className="rounded-[8px] border border-red-400/30 bg-red-500/10 px-3 py-2">
            {errors.map((error) => (
              <p key={error} className="text-sm font-semibold text-red-100">
                {error}
              </p>
            ))}
          </div>
        )}
        {saveMessage && (
          <p className="rounded-[8px] bg-lime-300/10 px-3 py-2 text-sm font-black text-lime-100">
            {saveMessage}
          </p>
        )}
        <button
          type="button"
          onClick={saveTarget}
          className="focus-ring min-h-11 w-full rounded-[8px] bg-lime-300 px-3 text-sm font-black text-zinc-950 sm:w-auto"
        >
          Save Exercise Target
        </button>
      </div>
    </details>
  );
}
