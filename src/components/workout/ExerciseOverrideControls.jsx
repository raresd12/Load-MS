import { useEffect, useState } from "react";
import {
  buildHoldRecord,
  buildManualOverrideRecord,
  createHoldForm,
  createManualOverrideForm,
  describeManualOverrideBase,
  formatOverrideBadge,
  getActiveExerciseOverride,
  getManualOverrideFieldRules,
  OVERRIDE_SESSION_OPTIONS,
} from "../../lib/coachControlsView.js";
import { getLocalDateKey } from "../../lib/date.js";

const overrideFieldClassName =
  "focus-ring min-h-11 w-full rounded-[8px] border border-zinc-700 bg-[#111111] px-3 text-sm font-black text-white placeholder:text-zinc-600";
// 44 px targets on the phone (H5 fix round 1).
const smallActionClassName =
  "focus-ring min-h-11 rounded-[8px] border border-zinc-700 px-3 text-xs font-black text-zinc-100 hover:bg-zinc-800";

/**
 * Decision H5-12: hold / manual override for one program exercise, on the
 * Workouts plan card and the Workout Log exercise card. The record is built
 * by coachControlsView.js and written by App through the checked writer; the
 * badge changes only after that write reported ok (the day view model is
 * re-read). History is never touched.
 *
 * props: { programId, exercise (day view model, carries `override`),
 *          prescription ({ recommendedWeight, sets, repsMin, repsMax, targetRPE }),
 *          onSetOverride(record) -> { ok, error? }, onClearOverride(programExerciseId) -> { ok, error? } }
 */
export default function ExerciseOverrideControls({ programId, exercise, prescription, onSetOverride, onClearOverride }) {
  const [mode, setMode] = useState(null);
  const [holdForm, setHoldForm] = useState(createHoldForm);
  const [manualForm, setManualForm] = useState(() => createManualOverrideForm(prescription ?? {}));
  const [errors, setErrors] = useState([]);
  const programExerciseId = exercise?.programExerciseId ?? exercise?.id ?? null;
  const active = getActiveExerciseOverride(exercise);
  // Labels, BW rule and keyboard follow the exercise's measurement / load
  // type; under a deload the form starts from the base load (H5-18).
  const rules = getManualOverrideFieldRules(exercise);
  const baseNote = describeManualOverrideBase(prescription ?? {});

  useEffect(() => {
    // A new prescription (after a save or a cleared override) refills the
    // manual form while it is closed; an open form keeps what was typed.
    if (mode !== "manual") {
      setManualForm(createManualOverrideForm(prescription ?? {}));
    }
  }, [prescription, mode]);

  if (!programId || !programExerciseId || !onSetOverride || !onClearOverride) {
    return null;
  }

  function openForm(nextMode) {
    setErrors([]);
    setMode((current) => (current === nextMode ? null : nextMode));
  }

  function submit(result) {
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }

    const written = onSetOverride(result.record);

    if (!written?.ok) {
      setErrors([written?.error ?? "The override could not be saved."]);
      return;
    }

    setErrors([]);
    setMode(null);
    setHoldForm(createHoldForm());
  }

  function clear() {
    const result = onClearOverride(programExerciseId);

    if (!result?.ok) {
      setErrors([result?.error ?? "The override could not be cleared."]);
      return;
    }

    setErrors([]);
    setMode(null);
  }

  return (
    <div className="mt-3 rounded-[8px] border border-zinc-800 bg-[#111111] p-3" data-testid="exercise-override-controls">
      {active ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <span className="rounded-[8px] border border-amber-300/50 bg-amber-300/10 px-2 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-amber-100">
              {formatOverrideBadge(active)}
            </span>
            <p className="mt-2 text-xs font-semibold leading-5 text-zinc-400">
              {active.mode === "hold"
                ? "The coach keeps the current targets and writes no progression evidence until the hold ends."
                : "Your numbers replace the coach's for the next sessions; the engine keeps learning from what you log."}
            </p>
          </div>
          <button type="button" onClick={clear} className={smallActionClassName}>
            Clear
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <p className="mr-auto text-[11px] font-black uppercase tracking-[0.12em] text-zinc-400">Coach controls</p>
          <button type="button" onClick={() => openForm("hold")} aria-expanded={mode === "hold"} className={smallActionClassName}>
            Hold
          </button>
          <button type="button" onClick={() => openForm("manual")} aria-expanded={mode === "manual"} className={smallActionClassName}>
            Set manually for next session
          </button>
        </div>
      )}

      {mode === "hold" && !active && (
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="block">
            <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.12em] text-zinc-400">
              Hold for (sessions)
            </span>
            <select
              value={holdForm.sessions}
              onChange={(event) => setHoldForm((current) => ({ ...current, sessions: event.target.value }))}
              className={overrideFieldClassName}
            >
              {OVERRIDE_SESSION_OPTIONS.map((count) => (
                <option key={count} value={String(count)}>
                  {count} {count === 1 ? "session" : "sessions"}
                </option>
              ))}
            </select>
          </label>
          {/* Decision H5-31: optional end date; the hold ends at whichever comes first. */}
          <label className="block">
            <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.12em] text-zinc-400">
              Until date (optional)
            </span>
            <input
              type="date"
              value={holdForm.untilDate}
              min={getLocalDateKey()}
              onChange={(event) => setHoldForm((current) => ({ ...current, untilDate: event.target.value }))}
              className={overrideFieldClassName}
              data-testid="hold-until-date"
            />
          </label>
          <button
            type="button"
            onClick={() =>
              submit(
                buildHoldRecord({
                  programId,
                  programExerciseId,
                  sessions: holdForm.sessions,
                  untilDate: holdForm.untilDate,
                  today: getLocalDateKey(),
                }),
              )
            }
            className="focus-ring min-h-11 rounded-[8px] bg-lime-300 px-4 text-sm font-black text-zinc-950 hover:bg-lime-200"
          >
            Apply hold
          </button>
        </div>
      )}

      {mode === "manual" && !active && (
        <div className="mt-3 space-y-2">
          <p className="text-xs font-semibold leading-5 text-zinc-400">
            Leave a field blank to keep the coach's value for it. Weight takes {rules.allowsBodyweight ? "kg or BW" : "kg"}; the {rules.countNoun} range needs both bounds or neither.
          </p>
          {baseNote && (
            <p className="text-xs font-semibold leading-5 text-sky-100" data-testid="manual-override-base-note">
              {baseNote}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <ManualField label="Weight" value={manualForm.weight} inputMode={rules.weightInputMode} placeholder={rules.weightPlaceholder} onChange={(value) => setManualForm((current) => ({ ...current, weight: value }))} />
            <ManualField label="Sets" value={manualForm.sets} inputMode="numeric" onChange={(value) => setManualForm((current) => ({ ...current, sets: value }))} />
            <ManualField label="RPE" value={manualForm.rpe} inputMode="decimal" onChange={(value) => setManualForm((current) => ({ ...current, rpe: value }))} />
            <ManualField label={rules.minLabel} value={manualForm.repsMin} inputMode={rules.wholeCount ? "numeric" : "decimal"} onChange={(value) => setManualForm((current) => ({ ...current, repsMin: value }))} />
            <ManualField label={rules.maxLabel} value={manualForm.repsMax} inputMode={rules.wholeCount ? "numeric" : "decimal"} onChange={(value) => setManualForm((current) => ({ ...current, repsMax: value }))} />
            <label className="block">
              <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.12em] text-zinc-400">Sessions</span>
              <select
                value={manualForm.sessions}
                onChange={(event) => setManualForm((current) => ({ ...current, sessions: event.target.value }))}
                className={overrideFieldClassName}
              >
                {OVERRIDE_SESSION_OPTIONS.map((count) => (
                  <option key={count} value={String(count)}>
                    {count}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            type="button"
            onClick={() => submit(buildManualOverrideRecord({ programId, programExerciseId, form: manualForm, exercise }))}
            className="focus-ring min-h-11 w-full rounded-[8px] bg-lime-300 px-4 text-sm font-black text-zinc-950 hover:bg-lime-200 sm:w-auto"
          >
            Apply manual override
          </button>
        </div>
      )}

      {errors.length > 0 && (
        <div role="alert" className="mt-3 rounded-[8px] border border-red-400/50 bg-red-400/10 px-3 py-2 text-xs font-bold text-red-100">
          {errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function ManualField({ label, value, onChange, inputMode = "text", placeholder = "" }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.12em] text-zinc-400">{label}</span>
      <input
        type="text"
        inputMode={inputMode}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={overrideFieldClassName}
      />
    </label>
  );
}
