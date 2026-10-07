import { useMemo, useState } from "react";
import { ChevronDown, Pencil, Trash2 } from "lucide-react";
import Metric from "../components/ui/Metric.jsx";
import ProgressEmptyState from "../components/ui/ProgressEmptyState.jsx";
import StepperInput from "../components/workout/StepperInput.jsx";
import { computeSessionAdherence } from "../lib/adherence.js";
import {
  formatHistorySetCount,
  getAdherenceBadge,
  getHistorySetCountField,
} from "../lib/coachControlsView.js";
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

const ADHERENCE_BADGE_CLASSES = {
  complete: "pill-good",
  partial: "pill-warn",
  minimal: "",
};

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
      <section className="card p-5 text-center min-[430px]:p-6">
        <p className="label-accent">
          Workout History
        </p>
        <h2 className="mt-2 text-[17px] font-semibold text-text-1">No sessions logged yet.</h2>
        <p className="mt-2 text-sm font-semibold leading-6 text-text-2">
          Saved workouts will appear here with exact sets, reps, kg, and RPE.
        </p>
      </section>
    );
  }

  // Decisions HV-1 / HV-11: numbers are tabular; the page root sets it once.
  return (
    <div className="space-y-4 tabular-nums">
      <section className="card p-3 min-[430px]:p-4">
        <p className="label-accent">
          Workout History
        </p>
        <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-[22px] font-semibold text-text-1">History</h2>
            <p className="mt-2 text-sm font-semibold leading-6 text-text-2">
              Exact saved sessions. Progress Analytics handles trends.
            </p>
          </div>
          <span className="card-inset px-3 py-2 text-sm font-semibold text-text-1">
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
  // H5-9 / H5-12: adherence against the session's own plan snapshot (never
  // the current program); legacy sessions without a snapshot get no badge.
  const adherenceBadge = useMemo(
    () => getAdherenceBadge(computeSessionAdherence({ session, exercises: editDay?.exercises ?? [] })),
    [session, editDay],
  );
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
    <article className="card p-3 min-[430px]:p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="label-accent">
            {formatHistoryDateTime(session.date)}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h3 className="break-words text-[17px] font-semibold text-text-1">{summary.dayName}</h3>
            {adherenceBadge && (
              <span
                data-testid="adherence-badge"
                className={`pill ${ADHERENCE_BADGE_CLASSES[adherenceBadge.tone]}`}
              >
                {adherenceBadge.label}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm font-semibold leading-6 text-text-2">
            {summary.programName}
            {summary.dayFocus ? ` | ${summary.dayFocus}` : ""}
          </p>
          {summary.notes.length > 0 && (
            <p className="mt-2 line-clamp-2 text-sm font-semibold leading-6 text-text-2">
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
              className="focus-ring btn btn-secondary flex items-center gap-2 px-3 text-xs"
            >
              <Pencil aria-hidden="true" size={14} />
              {isEditing ? "Close Edit" : "Edit"}
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={handleDelete}
              className="focus-ring btn btn-danger flex items-center gap-2 px-3 text-xs"
            >
              <Trash2 aria-hidden="true" size={14} />
              Delete
            </button>
          )}
          {!canEdit && canDelete && (
            <p className="text-xs font-semibold leading-5 text-text-2">
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
          className="mt-2 rounded-block bg-bad-tint px-3 py-2 text-sm font-medium text-bad"
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

      <details className="card-inset mt-3 px-3 py-2">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-text-1">
          Session details
          <ChevronDown aria-hidden="true" size={16} className="disclosure-chevron text-text-2" />
        </summary>

        {summary.exerciseGroups.length ? (
          <div className="space-y-3 border-t border-line pt-3">
            {summary.exerciseGroups.map((exercise) => (
              <HistoryExerciseDetail key={exercise.key} exercise={exercise} />
            ))}
          </div>
        ) : (
          <div className="border-t border-line pt-3">
            <ProgressEmptyState
              title="No logged set rows found."
              body="This looks like an older or recovery-only session. Notes are still preserved below."
            />
          </div>
        )}

        {summary.notes.length > 0 && (
          <div className="card-inset mt-3">
            <p className="label">
              Notes
            </p>
            <div className="mt-2 space-y-2">
              {summary.notes.map((note) => (
                <p key={note} className="text-sm font-semibold leading-6 text-text-2">
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
    <div className="card-inset mt-3 space-y-3">
      <p className="label-accent">
        Edit session
      </p>
      <p className="text-xs font-semibold leading-5 text-text-2">
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
          <div key={exercise.id} className="card-inset">
            <p className="break-words text-sm font-semibold text-text-1">{exercise.name}</p>
            <div className="mt-2 space-y-2">
              {draftExercise.sets.map((set, setIndex) => {
                // H5-13: a timed / distance set is edited in its own count
                // (seconds / meters); a legacy reps set stays a reps set.
                const count = getHistorySetCountField(set, exercise);

                return (
                <div
                  key={setIndex}
                  className="card-inset p-2"
                >
                  <p className="label mb-2">
                    Set {setIndex + 1}
                  </p>
                  <div className="grid gap-2">
                    <StepperInput
                      label={count.label}
                      value={set[count.field] ?? ""}
                      onChange={(value) => updateSet(exercise.id, setIndex, count.field, value)}
                      onStep={(delta) =>
                        updateSet(
                          exercise.id,
                          setIndex,
                          count.field,
                          adjustInputValue(set[count.field], delta, { min: 0 }),
                        )
                      }
                      stepAmount={count.step}
                      type="number"
                      inputMode="numeric"
                      placeholder={count.noun}
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
                );
              })}
            </div>
          </div>
        );
      })}

      <div className="card-inset">
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
          <span className="label mb-1">
            Session notes
          </span>
          <textarea
            value={form.sessionNotes}
            onChange={(event) => updateField("sessionNotes", event.target.value)}
            rows={3}
            className="focus-ring field w-full py-2"
          />
        </label>
      </div>

      {errors.length > 0 && (
        <div
          role="alert"
          className="rounded-block bg-bad-tint px-3 py-2 text-xs font-medium text-bad"
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
          className="focus-ring min-h-11 btn btn-primary"
        >
          Save Changes
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="focus-ring min-h-11 btn btn-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function HistoryExerciseDetail({ exercise }) {
  return (
    <div className="rounded-block bg-surface-1 p-3">
      <div className="flex flex-col gap-1 min-[430px]:flex-row min-[430px]:items-end min-[430px]:justify-between">
        <div className="min-w-0">
          <p className="break-words text-sm font-semibold text-text-1">{exercise.name}</p>
          <p className="mt-1 text-xs font-semibold text-text-2">
            {exercise.sets.length} sets | Volume {formatVolume(exercise.totalVolume)} | Avg RPE {formatAverage(exercise.averageRpe)}
          </p>
        </div>
        {exercise.programExerciseId && (
          <span className="pill w-fit">
            Program linked
          </span>
        )}
      </div>

      <div className="mt-3 space-y-1">
        <div className="grid grid-cols-[56px_1fr_1fr_1fr] gap-2 px-2 text-[10px] font-medium text-text-2">
          <span>Set</span>
          <span>Count</span>
          <span>Kg</span>
          <span>RPE</span>
        </div>
        {exercise.sets.map((set, index) => (
          <div
            key={`${set.setNumber ?? index + 1}-${index}`}
            className="card-inset grid min-h-10 grid-cols-[56px_1fr_1fr_1fr] items-center gap-2 px-2 text-sm font-semibold text-text-1"
          >
            <span className="text-text-2">S{set.setNumber ?? index + 1}</span>
            <span>{formatHistorySetCount(set)}</span>
            <span>{formatHistoryWeight(set.weight)}</span>
            <span>{Number.isFinite(set.rpe) ? set.rpe : "-"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
