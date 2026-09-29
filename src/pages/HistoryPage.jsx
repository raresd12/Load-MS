import { useMemo, useState } from "react";
import { ChevronDown, Pencil, Trash2 } from "lucide-react";
import Metric from "../components/ui/Metric.jsx";
import ProgressEmptyState from "../components/ui/ProgressEmptyState.jsx";
import StepperInput from "../components/workout/StepperInput.jsx";
import {
  buildHistorySessionSummary,
  formatHistoryDateTime,
  formatHistoryWeight,
} from "../lib/historyView.js";
import { getProgramDayViewModels } from "../lib/programStorage.js";
import {
  buildProgressExerciseLookup,
  formatAverage,
  formatVolume,
  getDateTime,
} from "../lib/sessionAnalytics.js";
import { buildDraftFromSession } from "../lib/sessionEdit.js";
import { isRecoverySession } from "../lib/sessionLog.js";
import { adjustInputValue } from "../lib/sessionNormalize.js";

export default function HistoryPage({
  sessions,
  programs,
  activeProgram,
  activeProgramDays,
  exerciseLibrary,
  onDeleteSession,
  onUpdateSession,
}) {
  const exerciseLookup = useMemo(
    () =>
      buildProgressExerciseLookup({
        programs,
        activeProgram,
        activeProgramDays,
        exerciseLibrary,
      }),
    [programs, activeProgram, activeProgramDays, exerciseLibrary],
  );
  const sortedSessions = useMemo(
    () => [...(sessions ?? [])].sort((left, right) => getDateTime(right.date) - getDateTime(left.date)),
    [sessions],
  );

  if (!sortedSessions.length) {
    return (
      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-5 text-center min-[430px]:p-6">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
          Workout History
        </p>
        <h2 className="mt-2 text-xl font-black text-white">No sessions logged yet.</h2>
        <p className="mt-2 text-sm font-semibold leading-6 text-zinc-400">
          Saved workouts will appear here with exact sets, reps, kg, and RPE.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3 min-[430px]:p-4">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
          Workout History
        </p>
        <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-2xl font-black text-white">History</h2>
            <p className="mt-2 text-sm font-semibold leading-6 text-zinc-400">
              Exact saved sessions. Progress Analytics handles trends.
            </p>
          </div>
          <span className="rounded-[8px] border border-zinc-700 bg-[#111111] px-3 py-2 text-sm font-black text-zinc-200">
            {sortedSessions.length} sessions
          </span>
        </div>
      </section>

      <section className="space-y-3">
        {sortedSessions.map((session, index) => (
          <HistorySessionCard
            key={session.id ?? `${session.date}-${index}`}
            session={session}
            exerciseLookup={exerciseLookup}
            onDeleteSession={onDeleteSession}
            onUpdateSession={onUpdateSession}
          />
        ))}
      </section>
    </div>
  );
}

function HistorySessionCard({ session, exerciseLookup, onDeleteSession, onUpdateSession }) {
  const summary = useMemo(
    () => buildHistorySessionSummary(session, exerciseLookup),
    [session, exerciseLookup],
  );
  const [isEditing, setIsEditing] = useState(false);
  const [actionError, setActionError] = useState("");
  // Decision new-E: editing needs the day view model of the session's own
  // program. When that program/day no longer exists only delete is offered.
  const editDay = useMemo(() => {
    if (!session.programId || !session.dayId) {
      return null;
    }

    return (
      getProgramDayViewModels(session.programId).find((day) => day.id === session.dayId) ?? null
    );
  }, [session.programId, session.dayId]);
  // Sessions carry `dayType` (saveWorkout); `type` is only a legacy fallback.
  const canEdit = Boolean(session.id && editDay && onUpdateSession && !isRecoverySession(session));
  const canDelete = Boolean(session.id && onDeleteSession);

  function handleDelete() {
    if (!canDelete) {
      return;
    }

    const confirmed = window.confirm(
      `Delete the "${summary.dayName}" session from ${formatHistoryDateTime(session.date)}? This cannot be undone. The next plan for that day will be rebuilt from the previous remaining session.`,
    );

    if (!confirmed) {
      return;
    }

    const result = onDeleteSession(session.id);

    if (!result?.ok) {
      setActionError(result?.error ?? "The session could not be deleted.");
      return;
    }

    setActionError("");
  }

  return (
    <article className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3 min-[430px]:p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-black uppercase tracking-[0.14em] text-lime-300">
            {formatHistoryDateTime(session.date)}
          </p>
          <h3 className="mt-1 break-words text-lg font-black text-white">
            {summary.dayName}
          </h3>
          <p className="mt-1 text-sm font-semibold leading-6 text-zinc-400">
            {summary.programName}
            {summary.dayFocus ? ` | ${summary.dayFocus}` : ""}
          </p>
          {summary.notes.length > 0 && (
            <p className="mt-2 line-clamp-2 text-sm font-semibold leading-6 text-zinc-300">
              {summary.notes[0]}
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 text-center min-[430px]:grid-cols-3 lg:min-w-[460px]">
          <Metric label="Readiness" value={summary.readinessLabel} />
          <Metric label="Session RPE" value={formatAverage(summary.sessionRpe)} />
          <Metric label="Exercises" value={summary.exerciseCount} />
          <Metric label="Sets" value={summary.setCount} />
          <Metric label="Volume" value={formatVolume(summary.totalVolume)} />
          <Metric label="Schema" value={summary.schemaLabel} />
        </div>
      </div>

      {(canEdit || canDelete) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {canEdit && (
            <button
              type="button"
              onClick={() => {
                setActionError("");
                setIsEditing((current) => !current);
              }}
              className="focus-ring flex min-h-10 items-center gap-2 rounded-[8px] border border-zinc-700 px-3 text-xs font-black text-zinc-100 hover:bg-zinc-800"
            >
              <Pencil aria-hidden="true" size={14} />
              {isEditing ? "Close Edit" : "Edit"}
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={handleDelete}
              className="focus-ring flex min-h-10 items-center gap-2 rounded-[8px] border border-red-400/40 px-3 text-xs font-black text-red-100 hover:bg-red-400/10"
            >
              <Trash2 aria-hidden="true" size={14} />
              Delete
            </button>
          )}
          {!canEdit && canDelete && (
            <p className="text-xs font-semibold leading-5 text-zinc-400">
              {isRecoverySession(session)
                ? "Recovery sessions can only be deleted."
                : "This session's program or day no longer exists, so it can only be deleted."}
            </p>
          )}
        </div>
      )}

      {actionError && (
        <p
          role="alert"
          className="mt-2 rounded-[8px] border border-red-400/50 bg-red-400/10 px-3 py-2 text-sm font-bold text-red-100"
        >
          {actionError}
        </p>
      )}

      {isEditing && canEdit && (
        <HistorySessionEditor
          session={session}
          day={editDay}
          onCancel={() => setIsEditing(false)}
          onSave={(edits) => {
            const result = onUpdateSession(session.id, edits);

            if (result?.ok) {
              setIsEditing(false);
            }

            return result;
          }}
        />
      )}

      <details className="mt-3 rounded-[8px] border border-zinc-800 bg-[#111111] px-3 py-2">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-black text-zinc-100">
          Session details
          <ChevronDown aria-hidden="true" size={16} className="shrink-0 text-zinc-400" />
        </summary>

        {summary.exerciseGroups.length ? (
          <div className="space-y-3 border-t border-zinc-800 pt-3">
            {summary.exerciseGroups.map((exercise) => (
              <HistoryExerciseDetail key={exercise.key} exercise={exercise} />
            ))}
          </div>
        ) : (
          <div className="border-t border-zinc-800 pt-3">
            <ProgressEmptyState
              title="No logged set rows found."
              body="This looks like an older or recovery-only session. Notes are still preserved below."
            />
          </div>
        )}

        {summary.notes.length > 0 && (
          <div className="mt-3 rounded-[8px] border border-zinc-800 bg-zinc-900 px-3 py-3">
            <p className="text-xs font-black uppercase tracking-[0.14em] text-zinc-400">
              Notes
            </p>
            <div className="mt-2 space-y-2">
              {summary.notes.map((note) => (
                <p key={note} className="text-sm font-semibold leading-6 text-zinc-300">
                  {note}
                </p>
              ))}
            </div>
          </div>
        )}
      </details>
    </article>
  );
}

/**
 * Decision new-E: inline editor for a saved session. Set reps / kg / RPE use
 * the same StepperInput pattern as Workout Log; session RPE and notes are
 * edited alongside. Saving rebuilds the session with the save-path
 * normalisation (rebuildSessionFromEdits) and regenerates the day's plan.
 */
function HistorySessionEditor({ session, day, onCancel, onSave }) {
  const [form, setForm] = useState(() => buildDraftFromSession(session, day));
  const [errors, setErrors] = useState([]);

  function updateSet(exerciseId, setIndex, field, value) {
    setErrors([]);
    setForm((currentForm) => {
      const exercise = currentForm.exercises[exerciseId];

      if (!exercise) {
        return currentForm;
      }

      return {
        ...currentForm,
        exercises: {
          ...currentForm.exercises,
          [exerciseId]: {
            ...exercise,
            sets: exercise.sets.map((set, index) =>
              index === setIndex ? { ...set, [field]: value } : set,
            ),
          },
        },
      };
    });
  }

  function updateField(field, value) {
    setErrors([]);
    setForm((currentForm) => ({ ...currentForm, [field]: value }));
  }

  function save() {
    const result = onSave({
      exercises: form.exercises,
      sessionRpe: form.sessionRpe,
      sessionNotes: form.sessionNotes,
    });

    if (!result?.ok) {
      setErrors(
        result?.errors?.length ? result.errors : [result?.error ?? "The session could not be saved."],
      );
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-[8px] border border-lime-300/30 bg-[#111111] p-3">
      <p className="text-xs font-black uppercase tracking-[0.14em] text-lime-300">
        Edit session
      </p>
      <p className="text-xs font-semibold leading-5 text-zinc-400">
        Date, program and day stay as saved. After saving, the next plan for this day is rebuilt
        from the most recent remaining session.
      </p>

      {day.exercises.map((exercise) => {
        const draftExercise = form.exercises[exercise.id];

        if (!draftExercise) {
          return null;
        }

        const isBodyweight =
          exercise.loadType === "bodyweight" || exercise.loadType === "optionalExternal";

        return (
          <div key={exercise.id} className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3">
            <p className="break-words text-sm font-black text-white">{exercise.name}</p>
            <div className="mt-2 space-y-2">
              {draftExercise.sets.map((set, setIndex) => (
                <div
                  key={setIndex}
                  className="rounded-[8px] border border-zinc-800 bg-[#111111] p-2"
                >
                  <p className="mb-2 text-[11px] font-black uppercase tracking-[0.12em] text-zinc-400">
                    Set {setIndex + 1}
                  </p>
                  <div className="grid gap-2">
                    <StepperInput
                      label="Reps"
                      value={set.reps}
                      onChange={(value) => updateSet(exercise.id, setIndex, "reps", value)}
                      onStep={(delta) =>
                        updateSet(
                          exercise.id,
                          setIndex,
                          "reps",
                          adjustInputValue(set.reps, delta, { min: 0 }),
                        )
                      }
                      stepAmount={1}
                      type="number"
                      inputMode="numeric"
                      placeholder="reps"
                    />
                    <StepperInput
                      label="Kg"
                      value={set.weight}
                      onChange={(value) => updateSet(exercise.id, setIndex, "weight", value)}
                      onStep={(delta) =>
                        updateSet(
                          exercise.id,
                          setIndex,
                          "weight",
                          adjustInputValue(set.weight, delta, { min: 0 }),
                        )
                      }
                      stepAmount={1}
                      type={isBodyweight ? "text" : "number"}
                      inputMode={isBodyweight ? "text" : "decimal"}
                      placeholder={isBodyweight ? "BW" : "kg"}
                    />
                    <StepperInput
                      label="RPE"
                      value={set.rpe}
                      onChange={(value) => updateSet(exercise.id, setIndex, "rpe", value)}
                      onStep={(delta) =>
                        updateSet(
                          exercise.id,
                          setIndex,
                          "rpe",
                          adjustInputValue(set.rpe, delta, { min: 1, max: 10 }),
                        )
                      }
                      stepAmount={0.5}
                      type="number"
                      inputMode="decimal"
                      min="1"
                      max="10"
                      step="0.5"
                      placeholder="8"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      <div className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3">
        <StepperInput
          label="Session RPE"
          value={form.sessionRpe}
          onChange={(value) => updateField("sessionRpe", value)}
          onStep={(delta) =>
            updateField("sessionRpe", adjustInputValue(form.sessionRpe, delta, { min: 1, max: 10 }))
          }
          stepAmount={0.5}
          type="number"
          inputMode="decimal"
          min="1"
          max="10"
          step="0.5"
          placeholder="8"
        />
        <label className="mt-3 block">
          <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.12em] text-zinc-400">
            Session notes
          </span>
          <textarea
            value={form.sessionNotes}
            onChange={(event) => updateField("sessionNotes", event.target.value)}
            rows={3}
            className="focus-ring w-full rounded-[8px] border border-zinc-700 bg-[#111111] px-3 py-2 text-sm font-semibold text-white"
          />
        </label>
      </div>

      {errors.length > 0 && (
        <div
          role="alert"
          className="rounded-[8px] border border-red-400/50 bg-red-400/10 px-3 py-2 text-xs font-bold text-red-100"
        >
          {errors.slice(0, 6).map((error) => (
            <p key={error}>{error}</p>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={save}
          className="focus-ring min-h-11 rounded-[8px] bg-lime-300 px-4 text-sm font-black text-zinc-950 hover:bg-lime-200"
        >
          Save Changes
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="focus-ring min-h-11 rounded-[8px] border border-zinc-700 px-4 text-sm font-black text-zinc-100 hover:bg-zinc-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function HistoryExerciseDetail({ exercise }) {
  return (
    <div className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3">
      <div className="flex flex-col gap-1 min-[430px]:flex-row min-[430px]:items-end min-[430px]:justify-between">
        <div className="min-w-0">
          <p className="break-words text-sm font-black text-white">{exercise.name}</p>
          <p className="mt-1 text-xs font-semibold text-zinc-400">
            {exercise.sets.length} sets | Volume {formatVolume(exercise.totalVolume)} | Avg RPE {formatAverage(exercise.averageRpe)}
          </p>
        </div>
        {exercise.programExerciseId && (
          <span className="w-fit rounded-[8px] bg-zinc-800 px-2 py-1 text-[10px] font-black uppercase tracking-[0.08em] text-zinc-400">
            Program linked
          </span>
        )}
      </div>

      <div className="mt-3 space-y-1">
        <div className="grid grid-cols-[56px_1fr_1fr_1fr] gap-2 px-2 text-[10px] font-black uppercase tracking-[0.1em] text-zinc-400">
          <span>Set</span>
          <span>Reps</span>
          <span>Kg</span>
          <span>RPE</span>
        </div>
        {exercise.sets.map((set, index) => (
          <div
            key={`${set.setNumber ?? index + 1}-${index}`}
            className="grid min-h-10 grid-cols-[56px_1fr_1fr_1fr] items-center gap-2 rounded-[8px] border border-zinc-800 bg-[#111111] px-2 text-sm font-bold text-zinc-200"
          >
            <span className="text-zinc-400">S{set.setNumber ?? index + 1}</span>
            <span>{Number.isFinite(set.reps) ? set.reps : "-"}</span>
            <span>{formatHistoryWeight(set.weight)}</span>
            <span>{Number.isFinite(set.rpe) ? set.rpe : "-"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
