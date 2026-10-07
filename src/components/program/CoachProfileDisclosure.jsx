import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  buildCoachProfilePatch,
  COACH_PROFILE_FIELDS,
  COACH_PROFILE_LABELS,
  COACH_PROFILE_NOTE,
  createCoachProfileForm,
  describeCoachProfile,
  MEASUREMENT_OPTIONS,
  PRIORITY_OPTIONS,
  PROGRESSION_MODE_OPTIONS,
} from "../../lib/coachControlsView.js";

const profileFieldClassName =
  "focus-ring min-h-11 field w-full";

const TRI_STATE_OPTIONS = [
  { value: "", label: "classified" },
  { value: "yes", label: "yes" },
  { value: "no", label: "no" },
];

/**
 * Decisions H5-1 / H5-3 (UI: H5-12). "Advanced: coach profile" for one program
 * exercise: measurement, per side, progression mode, increment, rounding,
 * max RPE for a load increase, priority and the load-increase cap. Every
 * value shows its source ("(classified)" / "(override)"); a blank field means
 * classified. Writes go through App's checked writer; the form reports a
 * refused write and keeps its values.
 *
 * props: { programId, exercise (day view model), stored (raw ProgramExercise
 *          record or null), onUpdateProgramExerciseProfile(programId,
 *          programExerciseId, patch) -> { ok, error?, errors? }, readOnlyNote,
 *          onPatchDraft(patch) - Studio draft mode (decision H5-19): the
 *          patch goes into the open draft instead of storage and is written
 *          with the program when the draft is saved }
 */
export default function CoachProfileDisclosure({
  programId,
  exercise,
  stored = null,
  onUpdateProgramExerciseProfile,
  readOnlyNote = "",
  onPatchDraft = null,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [form, setForm] = useState(() => createCoachProfileForm(exercise, stored));
  const [errors, setErrors] = useState([]);
  const [saveMessage, setSaveMessage] = useState("");
  const description = describeCoachProfile(exercise, stored);
  const programExerciseId = exercise?.programExerciseId ?? exercise?.id ?? null;
  const draftMode = typeof onPatchDraft === "function";
  const canEdit = Boolean(programExerciseId && !readOnlyNote && (draftMode || (programId && onUpdateProgramExerciseProfile)));

  useEffect(() => {
    setForm(createCoachProfileForm(exercise, stored));
    setErrors([]);
  }, [exercise, stored]);

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors([]);
    setSaveMessage("");
  }

  function save() {
    const result = buildCoachProfilePatch(form, exercise);

    if (!result.ok) {
      setErrors(result.errors);
      setSaveMessage("");
      return;
    }

    if (draftMode) {
      // Nothing is written here: the draft carries the profile and the
      // Studio's Save program writes it with the rest (H5-19).
      onPatchDraft(result.patch);
      setErrors([]);
      setSaveMessage("Coach profile set in the draft. It is written with the program when you save it.");
      return;
    }

    const written = onUpdateProgramExerciseProfile(programId, programExerciseId, result.patch);

    if (!written?.ok) {
      setErrors(written?.errors?.length ? written.errors : [written?.error ?? "The coach profile could not be saved."]);
      setSaveMessage("");
      return;
    }

    setErrors([]);
    setSaveMessage("Saved coach profile. Future recommendations use it; nothing logged changes.");
  }

  return (
    <details
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
      className="card-inset"
      data-testid="coach-profile-disclosure"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-semibold text-text-1">
        Advanced: coach profile
        <ChevronDown aria-hidden="true" size={16} className={`shrink-0 text-text-2 transition ${isOpen ? "rotate-180" : ""}`} />
      </summary>
      <div className="space-y-3 border-t border-line p-3">
        <p className="text-xs font-semibold leading-5 text-text-2">{COACH_PROFILE_NOTE}</p>
        <dl className="grid gap-1.5 min-[430px]:grid-cols-2">
          {COACH_PROFILE_FIELDS.map((field) => (
            <div key={field} className="rounded-control bg-surface-1 px-3 py-2">
              <dt className="label">{COACH_PROFILE_LABELS[field]}</dt>
              <dd className="mt-0.5 text-xs font-semibold text-text-1">{description[field]}</dd>
            </div>
          ))}
        </dl>

        {readOnlyNote ? (
          <p className="rounded-block bg-warn-tint px-3 py-2 text-xs font-semibold leading-5 text-warn">
            {readOnlyNote}
          </p>
        ) : (
          <>
            <div className="grid gap-3 min-[430px]:grid-cols-2 lg:grid-cols-4">
              <SelectRow id={`profile-measurement-${programExerciseId}`} label={COACH_PROFILE_LABELS.measurement} value={form.measurement} onChange={(value) => updateField("measurement", value)} options={[{ value: "", label: "classified" }, ...MEASUREMENT_OPTIONS.map((value) => ({ value, label: value }))]} />
              <SelectRow id={`profile-perside-${programExerciseId}`} label={COACH_PROFILE_LABELS.perSide} value={form.perSide} onChange={(value) => updateField("perSide", value)} options={TRI_STATE_OPTIONS} />
              <SelectRow id={`profile-mode-${programExerciseId}`} label={COACH_PROFILE_LABELS.progressionMode} value={form.progressionMode} onChange={(value) => updateField("progressionMode", value)} options={[{ value: "", label: "classified" }, ...PROGRESSION_MODE_OPTIONS.map((value) => ({ value, label: value.replace(/_/g, " ") }))]} />
              <SelectRow id={`profile-priority-${programExerciseId}`} label={COACH_PROFILE_LABELS.priority} value={form.priority} onChange={(value) => updateField("priority", value)} options={[{ value: "", label: "classified" }, ...PRIORITY_OPTIONS.map((value) => ({ value, label: value }))]} />
              <InputRow id={`profile-increment-${programExerciseId}`} label={COACH_PROFILE_LABELS.incrementKg} value={form.incrementKg} onChange={(value) => updateField("incrementKg", value)} placeholder="classified" />
              <InputRow id={`profile-round-${programExerciseId}`} label={COACH_PROFILE_LABELS.roundToKg} value={form.roundToKg} onChange={(value) => updateField("roundToKg", value)} placeholder="classified" />
              <InputRow id={`profile-rpe-${programExerciseId}`} label={COACH_PROFILE_LABELS.rpeMaxForLoadIncrease} value={form.rpeMaxForLoadIncrease} onChange={(value) => updateField("rpeMaxForLoadIncrease", value)} placeholder="classified" />
              <SelectRow id={`profile-cap-${programExerciseId}`} label={COACH_PROFILE_LABELS.canIncreaseLoad} value={form.canIncreaseLoad} onChange={(value) => updateField("canIncreaseLoad", value)} options={TRI_STATE_OPTIONS} />
            </div>
            {errors.length > 0 && (
              <div role="alert" className="rounded-block bg-bad-tint px-3 py-2">
                {errors.map((error) => (
                  <p key={error} className="text-sm font-semibold text-bad">
                    {error}
                  </p>
                ))}
              </div>
            )}
            {saveMessage && (
              <p className="rounded-block bg-accent-tint px-3 py-2 text-sm font-semibold text-accent-soft">{saveMessage}</p>
            )}
            <button
              type="button"
              onClick={save}
              disabled={!canEdit}
              className="focus-ring min-h-11 btn btn-ghost w-full px-3 sm:w-auto"
            >
              {draftMode ? "Set Coach Profile in Draft" : "Save Coach Profile"}
            </button>
          </>
        )}
      </div>
    </details>
  );
}

function SelectRow({ id, label, value, onChange, options }) {
  return (
    <label htmlFor={id} className="block">
      <span className="label mb-2">{label}</span>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)} className={profileFieldClassName}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function InputRow({ id, label, value, onChange, placeholder = "" }) {
  return (
    <label htmlFor={id} className="block">
      <span className="label mb-2">{label}</span>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={profileFieldClassName}
      />
    </label>
  );
}
