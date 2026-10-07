import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  ChevronDown,
  Download,
  Pencil,
  Sparkles,
} from "lucide-react";
import { ProgramBadge, ProgramEditorField, ProgramTextArea, ProgramTextField } from "./ProgramFields.jsx";
import ProgramPrescriptionEditor from "./ProgramPrescriptionEditor.jsx";
import Metric from "../ui/Metric.jsx";
import { extractProgramEditWithAi, getGeminiApiKey } from "../../lib/aiProgram.js";
import {
  buildProgramProfilePatch,
  createProgramProfileForm,
  formatProgramWeekLabel,
} from "../../lib/coachControlsView.js";
import { draftFromShare } from "../../lib/programDraft.js";
import { exportProgramShare, getProgramDayViewModels, getProgramStateForDisplay } from "../../lib/programStorage.js";
import { formatRest, formatWeight } from "../../lib/progression.js";

function downloadProgramShareFile(program) {
  const share = exportProgramShare(program.id);

  if (!share) {
    return false;
  }

  const safeName =
    String(program.nickname || program.name || "program")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "program";
  const blob = new Blob([JSON.stringify(share, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeName}-program-share.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return true;
}

export default function ProgramCard({
  program,
  isActive,
  onDuplicateProgram,
  onSetActiveProgram,
  onArchiveProgram,
  onUpdateProgramMetadata,
  onUpdateProgramExerciseTarget,
  onUpdateProgramExerciseProfile,
  onUpdateProgramProfile,
  onEditProgram,
  onOpenStudio,
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isAiEditOpen, setIsAiEditOpen] = useState(false);
  // One card-level error line: archive, set-active and metadata-save failures.
  const [archiveError, setArchiveError] = useState("");
  const [form, setForm] = useState(() => createProgramMetadataForm(program));
  // Memoised on the program record (a new object per programRevision): these
  // read program storage and must not run on every re-render of the card.
  const days = useMemo(() => getProgramDayViewModels(program.id), [program]);
  const exerciseCount = days.reduce((total, day) => total + day.exercises.length, 0);
  const programState = useMemo(() => getProgramStateForDisplay(program.id), [program]);
  const isDefaultProgram = Boolean(program.isDefault);

  useEffect(() => {
    if (!isEditing) {
      setForm(createProgramMetadataForm(program));
    }
  }, [program, isEditing]);

  function updateField(field, value) {
    setForm((currentForm) => ({ ...currentForm, [field]: value }));
  }

  function saveMetadata() {
    // The editor closes only after the write succeeded (fix round 2).
    const { aggression, cycleWeeks, ...metadata } = form;
    // H5-12: coach aggression and cycle length are program-level profile
    // fields (H5-3 / H5-5), written by their own checked writer. The cycle
    // length is validated BEFORE the metadata write (H5 fix round 1), so an
    // invalid cycle never leaves the name saved and the editor open.
    const profile = onUpdateProgramProfile ? buildProgramProfilePatch({ aggression, cycleWeeks }) : null;

    if (profile && !profile.ok) {
      setArchiveError(profile.errors.join(" "));
      return;
    }

    const result = onUpdateProgramMetadata(program.id, metadata);

    if (result && !result.ok) {
      setArchiveError(result.error ?? "The program details could not be saved.");
      return;
    }

    // A refused profile write keeps the editor open with the typed values.
    if (profile) {
      const profileResult = onUpdateProgramProfile(program.id, profile.patch);

      if (profileResult && !profileResult.ok) {
        setArchiveError(profileResult.error ?? "The coach settings could not be saved.");
        return;
      }
    }

    setArchiveError("");
    setIsEditing(false);
  }

  function setActive() {
    const result = onSetActiveProgram(program.id);

    if (result && !result.ok) {
      setArchiveError(result.error ?? "The active program could not be switched.");
      return;
    }

    setArchiveError("");
  }

  const canArchive = Boolean(onArchiveProgram) && !isActive && !isDefaultProgram;

  function archiveProgram() {
    const result = onArchiveProgram(program.id, true);

    if (!result?.ok) {
      setArchiveError(result?.error ?? "The program could not be archived.");
      return;
    }

    setArchiveError("");
  }

  return (
    <article
      className={`rounded-control border p-3 min-[430px]:p-4 ${
        isActive
          ? "border-line-accent bg-accent-tint"
          : "border-line bg-surface-2"
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap gap-2">
            {isActive && <ProgramBadge tone="active">Active</ProgramBadge>}
            {program.isDefault && <ProgramBadge tone="default">Default</ProgramBadge>}
          </div>
          <h3 className="mt-3 text-[17px] font-semibold text-text-1">{program.name}</h3>
          {program.nickname && (
            <p className="mt-1 text-sm font-semibold text-accent-soft">{program.nickname}</p>
          )}
          <p className="mt-1 text-sm font-semibold text-text-2">
            {program.goal || "Local guest-mode program"}
          </p>
          {program.description && (
            <p className="mt-2 text-sm leading-6 text-text-2">{program.description}</p>
          )}
          <p className="mt-2 text-xs font-semibold text-text-2">
            Created {formatProgramDate(program.createdAt)} | Updated {formatProgramDate(program.updatedAt)}
          </p>
        </div>
        <div className="grid gap-2 sm:min-w-44">
          <button
            type="button"
            disabled={isActive}
            onClick={setActive}
            className={`focus-ring btn min-h-11 w-full px-3 text-sm ${
              isActive
                ? "btn-secondary text-text-2 disabled:cursor-default disabled:opacity-100"
                : "btn-primary"
            }`}
          >
            {isActive ? "Active Program" : "Set Active"}
          </button>
          <button
            type="button"
            onClick={() => onDuplicateProgram(program.id)}
            className="focus-ring min-h-11 btn btn-secondary w-full px-3"
          >
            Duplicate Program
          </button>
          <button
            type="button"
            onClick={() => setIsEditing((current) => !current)}
            className="focus-ring min-h-11 btn btn-secondary w-full px-3"
          >
            {isEditing ? "Close Edit" : "Edit Details"}
          </button>
          {!isDefaultProgram && onEditProgram && (
            <button
              type="button"
              onClick={() => onEditProgram(program.id)}
              className="focus-ring btn btn-ghost flex min-h-11 w-full items-center justify-center gap-2 px-3"
            >
              <Pencil aria-hidden="true" size={15} />
              Edit Program
            </button>
          )}
          {!isDefaultProgram && onOpenStudio && (
            <button
              type="button"
              onClick={() => setIsAiEditOpen((current) => !current)}
              aria-expanded={isAiEditOpen}
              className="focus-ring btn btn-secondary flex min-h-11 w-full items-center justify-center gap-2 px-3"
            >
              <Sparkles aria-hidden="true" size={15} />
              {isAiEditOpen ? "Close AI Edit" : "Edit with AI"}
            </button>
          )}
          <button
            type="button"
            onClick={() => downloadProgramShareFile(program)}
            className="focus-ring btn btn-secondary flex min-h-11 w-full items-center justify-center gap-2 px-3"
          >
            <Download aria-hidden="true" size={15} />
            Share File
          </button>
          {canArchive && (
            <button
              type="button"
              onClick={archiveProgram}
              className="focus-ring btn btn-secondary flex min-h-11 w-full items-center justify-center gap-2 px-3"
            >
              <Archive aria-hidden="true" size={15} />
              Archive
            </button>
          )}
        </div>
      </div>

      {archiveError && (
        <p
          role="alert"
          className="mt-3 rounded-block bg-bad-tint px-3 py-2 text-sm font-medium text-bad"
        >
          {archiveError}
        </p>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <Metric label="Days" value={days.length} />
        <Metric label="Exercises" value={exerciseCount} />
        <Metric label="Week" value={programState.currentWeek} />
        <Metric label="Cycle" value={programState.currentCycle} />
      </div>
      <p className="mt-2 text-xs font-semibold text-text-2" data-testid="program-week-label">
        {formatProgramWeekLabel(programState, program)} | Coach aggression:{" "}
        {program.programProfile?.aggression === "conservative" ? "conservative" : "standard"}
      </p>

      {isAiEditOpen && !isDefaultProgram && (
        <ProgramAiEditForm
          program={program}
          onOpenStudio={onOpenStudio}
          onClose={() => setIsAiEditOpen(false)}
        />
      )}

      {isEditing && (
        <ProgramMetadataForm
          isDefaultProgram={isDefaultProgram}
          form={form}
          onChange={updateField}
          onCancel={() => {
            setForm(createProgramMetadataForm(program));
            setIsEditing(false);
          }}
          onSave={saveMetadata}
        />
      )}

      <details
        open={isEditorOpen}
        onToggle={(event) => setIsEditorOpen(event.currentTarget.open)}
        className="card-inset mt-4 py-2"
      >
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-text-1">
          Prescription editor
          <ChevronDown
            aria-hidden="true"
            size={16}
            className={`transition ${isEditorOpen ? "rotate-180" : ""}`}
          />
        </summary>
        {isDefaultProgram ? (
          <DefaultProgramEditorLock onDuplicate={() => onDuplicateProgram(program.id)} />
        ) : (
          <ProgramPrescriptionEditor
            program={program}
            days={days}
            onUpdateProgramExerciseTarget={onUpdateProgramExerciseTarget}
            onUpdateProgramExerciseProfile={onUpdateProgramExerciseProfile}
          />
        )}
      </details>

      <details
        open={isPreviewOpen}
        onToggle={(event) => setIsPreviewOpen(event.currentTarget.open)}
        className="card-inset mt-4 py-2"
      >
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-text-1">
          Read-only program preview
          <ChevronDown
            aria-hidden="true"
            size={16}
            className={`transition ${isPreviewOpen ? "rotate-180" : ""}`}
          />
        </summary>
        <ProgramPreview days={days} />
      </details>
    </article>
  );
}

/**
 * Phase H2 "Edit with AI": one instruction -> Track B's extractProgramEditWithAi
 * on the exported share -> draftFromShare (origin "ai-edit") -> Studio review.
 * Nothing is written until the user applies the reviewed draft.
 */
function ProgramAiEditForm({ program, onOpenStudio, onClose }) {
  const [instruction, setInstruction] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState("");
  const hasKey = Boolean(getGeminiApiKey());

  async function askAi() {
    const cleanInstruction = instruction.trim();
    setError("");

    if (!hasKey) {
      setError("Save your Gemini API key first (AI Program Import Assistant section below).");
      return;
    }

    if (!cleanInstruction) {
      setError("Describe the change you want first.");
      return;
    }

    const share = exportProgramShare(program.id);

    if (!share) {
      setError("This program could not be exported for editing.");
      return;
    }

    setIsBusy(true);

    try {
      const result = await extractProgramEditWithAi({ share, instruction: cleanInstruction });

      if (!result.valid) {
        setError(result.error);
        return;
      }

      const converted = draftFromShare(result.share, {
        origin: "ai-edit",
        sourceProgramId: program.id,
        aiInstruction: cleanInstruction,
      });

      if (!converted.ok) {
        setError(converted.error ?? "The AI result could not be opened as a draft.");
        return;
      }

      onOpenStudio({
        draft: converted.draft,
        mode: "review",
        review: {
          title: `AI edit review (${result.model})`,
          instruction: cleanInstruction,
          origin: "ai-edit",
          changes: result.preview.changes ?? [],
          removed: result.preview.removed ?? [],
          uncertainty: result.preview.uncertainty ?? [],
        },
      });
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div className="card-inset mt-4">
      <p className="label-accent">Edit with AI</p>
      <p className="mt-1 text-sm leading-6 text-text-2">
        Describe one change (for example "swap the second day's rows for pull-ups" or "add face pulls
        at the end of Day 3"). The AI returns a revised draft you review in the Studio before anything is applied.
        Your targets and history stay as they are until you press Apply Changes. No weights are ever
        invented.
      </p>
      <label htmlFor={`ai-edit-${program.id}`} className="label mt-3">
        Instruction
      </label>
      <textarea
        id={`ai-edit-${program.id}`}
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        rows={3}
        maxLength={2000}
        placeholder="Replace barbell rows with dumbbell rows and add a finisher to Day 1"
        className="focus-ring field mt-1 min-h-20 w-full resize-y py-2"
      />
      {!hasKey && (
        <p className="mt-2 text-xs font-semibold text-warn">
          A saved Gemini API key is required (see the AI Program Import Assistant section).
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mt-2 rounded-block bg-bad-tint px-3 py-2 text-sm font-medium text-bad"
        >
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={askAi}
          disabled={isBusy}
          className="focus-ring btn btn-primary flex min-h-11 flex-1 items-center justify-center gap-2"
        >
          <Sparkles aria-hidden="true" size={16} />
          {isBusy ? "Asking AI..." : "Ask AI"}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={isBusy}
          className="focus-ring min-h-11 btn btn-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function createProgramMetadataForm(program) {
  return {
    name: program.name ?? "",
    nickname: program.nickname ?? "",
    description: program.description ?? "",
    goal: program.goal ?? "",
    ...createProgramProfileForm(program),
  };
}

function ProgramMetadataForm({ isDefaultProgram, form, onChange, onCancel, onSave }) {
  return (
    <div className="card-inset mt-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {isDefaultProgram ? (
          <div className="rounded-block bg-warn-tint px-3 py-3">
            <p className="label text-warn">
              Program name locked
            </p>
            <p className="mt-1 text-sm font-semibold text-text-1">{form.name}</p>
            <p className="mt-2 text-xs font-semibold leading-5 text-warn">
              The default program's core name is protected. Edit the nickname for mobile display.
            </p>
          </div>
        ) : (
          <ProgramTextField label="Program name" value={form.name} onChange={(value) => onChange("name", value)} />
        )}
        <ProgramTextField label="Nickname" value={form.nickname} onChange={(value) => onChange("nickname", value)} />
        <ProgramTextArea label="Description" value={form.description} onChange={(value) => onChange("description", value)} />
        <ProgramTextArea label="Goal" value={form.goal} onChange={(value) => onChange("goal", value)} />
        <label className="block">
          <span className="label mb-2">
            Coach aggression
          </span>
          <select
            value={form.aggression}
            onChange={(event) => onChange("aggression", event.target.value)}
            className="focus-ring min-h-11 field w-full"
          >
            <option value="standard">standard</option>
            <option value="conservative">conservative</option>
          </select>
        </label>
        <ProgramEditorField
          label="Cycle length (weeks, optional)"
          value={form.cycleWeeks}
          onChange={(value) => onChange("cycleWeeks", value)}
          placeholder="e.g. 4"
          inputMode="numeric"
        />
      </div>
      <p className="mt-3 text-xs font-semibold leading-5 text-text-2">
        Profile changes affect future recommendations only. Conservative needs two strong sessions in a
        row before a step up and takes one step at a time.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={onSave}
          className="focus-ring min-h-11 btn btn-primary px-3"
        >
          Save Program Details
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="focus-ring min-h-11 btn btn-secondary px-3"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function DefaultProgramEditorLock({ onDuplicate }) {
  return (
    <div className="mt-3 rounded-block bg-warn-tint p-3">
      <p className="text-sm font-semibold text-warn">Duplicate to edit prescriptions.</p>
      <p className="mt-2 text-sm leading-6 text-warn">
        The default program is protected so the preloaded template stays available. Make a copy,
        then edit sets, reps, kg, RPE, rest, and notes on the duplicate.
      </p>
      <button
        type="button"
        onClick={onDuplicate}
        className="focus-ring btn btn-primary mt-3 min-h-11 w-full px-3 text-sm sm:w-auto"
      >
        Duplicate to Edit
      </button>
    </div>
  );
}

function ProgramPreview({ days }) {
  return (
    <div className="mt-3 space-y-3">
      {days.map((day) => {
        const sections = day.sections?.length
          ? day.sections
          : [{ id: "main", name: "Main Work" }];

        return (
          <div key={day.id} className="rounded-block bg-surface-1 p-3">
            <h4 className="font-semibold text-text-1">{day.name}</h4>
            <p className="mt-1 text-xs font-semibold text-text-2">{day.focus}</p>
            {sections.map((section) => {
              const exercises = day.exercises.filter((exercise) =>
                exercise.sectionId ? exercise.sectionId === section.id : section.id === "main",
              );

              if (!exercises.length) {
                return null;
              }

              return (
                <div key={section.id} className="mt-3">
                  <p className="label-accent">
                    {section.name}
                  </p>
                  <div className="mt-2 space-y-2">
                    {exercises.map((exercise) => (
                      <div
                        key={exercise.id}
                        className="rounded-control bg-surface-2 px-3 py-2"
                      >
                        <p className="font-semibold text-text-1">{exercise.name}</p>
                        <p className="mt-1 text-xs font-semibold leading-5 text-text-2">
                          {exercise.sets}x {exercise.repsLabel} | {formatWeight(exercise.recommendedWeight, exercise)} | RPE {exercise.targetRPE} | {formatRest(exercise.restSeconds)}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export function formatProgramDate(value) {
  if (!value) {
    return "unknown";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  return date.toLocaleDateString();
}
