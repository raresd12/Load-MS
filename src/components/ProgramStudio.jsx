import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  Plus,
  Search,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import {
  addDay,
  addExercise,
  addSection,
  diffDraftAgainstProgram,
  makeDraftItemId,
  moveDay,
  moveExercise,
  moveSection,
  proposeNewLibraryExercise,
  remapExercise,
  removeDay,
  removeExercise,
  removeSection,
  summarizeProgramDraft,
  updateDayMeta,
  updateExercise,
  updateProgramMeta,
  updateSectionMeta,
  updateWarmup,
  validateProgramDraft,
} from "../lib/programDraft.js";
import {
  deleteStoredDraft,
  getExerciseLibrary,
  LOAD_TYPES,
  loadStoredDraft,
  saveDraftToStorage,
  WEIGHT_MODES,
} from "../lib/programStorage.js";
import {
  buildExercisePatch,
  cancelStudioSession,
  countDayExercises,
  countDraftProvenance,
  createExerciseForm,
  describeDraftDiff,
  describeDraftStoreResult,
  EXERCISE_TYPE_OPTIONS,
  flushPendingDraftStore,
  formatDraftPrescription,
  getProvenanceLabel,
  groupDraftValidationErrors,
  isDraftDirty,
  planDraftStore,
  searchLibraryEntries,
} from "../lib/programStudio.js";
import {
  acceptTechniqueDraftIntoDraft,
  describeNewExercises,
  hasTechniqueNotes,
  setNewLibraryEntryInDraft,
} from "../lib/importAssistant.js";
import TechniqueNotesSection from "./import/TechniqueNotesSection.jsx";
import CoachProfileDisclosure from "./program/CoachProfileDisclosure.jsx";

const AUTOSAVE_DELAY_MS = 800;

const ORIGIN_LABELS = {
  blank: "Manual draft",
  program: "Editing saved program",
  "ai-import": "AI import draft",
  "ai-edit": "AI edit draft",
  "file-import": "File import draft",
};

const LIBRARY_STATUS_TAGS = {
  library: { label: "Library", className: "border-lime-300/40 bg-lime-300/10 text-lime-200" },
  new: { label: "New", className: "border-amber-400/40 bg-amber-400/10 text-amber-200" },
  unmatched: { label: "Unmatched", className: "border-red-400/50 bg-red-400/10 text-red-100" },
};

const inputClassName =
  "focus-ring min-h-11 w-full rounded-[8px] border border-zinc-700 bg-[#111111] px-3 text-sm font-bold text-white placeholder:text-zinc-600";
const textareaClassName =
  "focus-ring min-h-20 w-full resize-y rounded-[8px] border border-zinc-700 bg-[#111111] px-3 py-2 text-sm font-bold text-white placeholder:text-zinc-600";
const smallButtonClassName =
  "focus-ring inline-flex min-h-10 items-center justify-center gap-1 rounded-[8px] border border-zinc-700 px-2.5 text-xs font-black text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40";
const primaryButtonClassName =
  "focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-[8px] bg-lime-300 px-4 text-sm font-black text-zinc-950 hover:bg-lime-200 disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButtonClassName =
  "focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-[8px] border border-zinc-700 px-4 text-sm font-black text-zinc-100 hover:bg-zinc-800";

function confirmAction(message) {
  if (typeof window === "undefined" || typeof window.confirm !== "function") {
    return true;
  }

  return window.confirm(message);
}

/**
 * Text input whose displayed text is local (so trailing spaces survive the
 * draft's trimming) while every change is pushed to the draft immediately.
 * External changes (remap, resume) still flow in when the trimmed values differ.
 */
function useSyncedText(value) {
  const [text, setText] = useState(value ?? "");

  useEffect(() => {
    setText((current) => (String(current ?? "").trim() === String(value ?? "").trim() ? current : (value ?? "")));
  }, [value]);

  return [text, setText];
}

function FieldLabel({ label, tag, htmlFor }) {
  return (
    <span className="mb-2 flex items-center justify-between gap-2">
      <label htmlFor={htmlFor} className="text-xs font-black uppercase tracking-[0.14em] text-zinc-400">
        {label}
      </label>
      {tag ? <ProvenanceTag label={tag} /> : null}
    </span>
  );
}

function ProvenanceTag({ label }) {
  if (!label) {
    return null;
  }

  return (
    <span className="rounded-[4px] border border-zinc-800 px-1.5 py-0.5 text-[10px] font-bold lowercase tracking-[0.04em] text-zinc-400">
      {label}
    </span>
  );
}

function TextField({ id, label, value, onChange, placeholder = "", inputMode = "text", tag = "", error = "" }) {
  const [text, setText] = useSyncedText(value);

  return (
    <div className="block">
      <FieldLabel label={label} tag={tag} htmlFor={id} />
      <input
        id={id}
        type="text"
        inputMode={inputMode}
        value={text}
        placeholder={placeholder}
        onChange={(event) => {
          setText(event.target.value);
          onChange(event.target.value);
        }}
        className={`${inputClassName} ${error ? "border-red-400/60" : ""}`}
      />
      {error ? <p className="mt-1 text-xs font-bold text-red-200">{error}</p> : null}
    </div>
  );
}

function TextAreaField({ id, label, value, onChange, placeholder = "", tag = "", rows = 3 }) {
  const [text, setText] = useSyncedText(value);

  return (
    <div className="block">
      <FieldLabel label={label} tag={tag} htmlFor={id} />
      <textarea
        id={id}
        value={text}
        rows={rows}
        placeholder={placeholder}
        onChange={(event) => {
          setText(event.target.value);
          onChange(event.target.value);
        }}
        className={textareaClassName}
      />
    </div>
  );
}

function SelectField({ id, label, value, options, onChange, tag = "" }) {
  return (
    <div className="block">
      <FieldLabel label={label} tag={tag} htmlFor={id} />
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={inputClassName}
      >
        {options.map((option) => (
          <option key={option.value ?? option} value={option.value ?? option}>
            {option.label ?? option}
          </option>
        ))}
      </select>
    </div>
  );
}

function CheckboxField({ id, label, checked, onChange, tag = "" }) {
  return (
    <label htmlFor={id} className="flex min-h-11 items-center justify-between gap-3 rounded-[8px] border border-zinc-800 bg-[#111111] px-3">
      <span className="flex items-center gap-3">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          className="focus-ring h-5 w-5 accent-lime-300"
        />
        <span className="text-sm font-bold text-zinc-100">{label}</span>
      </span>
      {tag ? <ProvenanceTag label={tag} /> : null}
    </label>
  );
}

function StatusTag({ status }) {
  const tag = LIBRARY_STATUS_TAGS[status] ?? LIBRARY_STATUS_TAGS.unmatched;

  return (
    <span className={`rounded-[4px] border px-1.5 py-0.5 text-[10px] font-black ${tag.className}`}>{tag.label}</span>
  );
}

function ErrorBadge({ count }) {
  if (!count) {
    return null;
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-[4px] border border-red-400/50 bg-red-400/10 px-1.5 py-0.5 text-[10px] font-black text-red-100">
      <TriangleAlert aria-hidden="true" size={11} />
      {count} {count === 1 ? "issue" : "issues"}
    </span>
  );
}

function ErrorList({ messages, title = "" }) {
  if (!messages?.length) {
    return null;
  }

  return (
    <div role="alert" className="rounded-[8px] border border-red-400/30 bg-red-500/10 px-3 py-2">
      {title ? <p className="text-xs font-black uppercase tracking-[0.14em] text-red-200">{title}</p> : null}
      <ul className={`space-y-1 ${title ? "mt-1" : ""}`}>
        {messages.map((message, index) => (
          <li key={`${index}-${message}`} className="break-words text-sm font-semibold text-red-100">
            {message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Panel({ title, tone = "zinc", children, defaultOpen = true }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const border = tone === "lime" ? "border-lime-300/30 bg-lime-300/5" : tone === "cyan" ? "border-cyan-400/30 bg-cyan-400/5" : tone === "amber" ? "border-amber-400/30 bg-amber-400/5" : "border-zinc-800 bg-[#111111]";
  const titleColor = tone === "lime" ? "text-lime-200" : tone === "cyan" ? "text-cyan-200" : tone === "amber" ? "text-amber-200" : "text-zinc-300";

  return (
    <div className={`rounded-[8px] border ${border} px-3 py-2`}>
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        className="focus-ring flex min-h-10 w-full items-center justify-between gap-3 text-left"
      >
        <span className={`text-xs font-black uppercase tracking-[0.14em] ${titleColor}`}>{title}</span>
        <ChevronDown aria-hidden="true" size={16} className={`shrink-0 text-zinc-400 transition ${isOpen ? "rotate-180" : ""}`} />
      </button>
      {isOpen ? <div className="mt-2 border-t border-zinc-800/80 pt-2">{children}</div> : null}
    </div>
  );
}

function DiffPanel({ diff, mode }) {
  const described = useMemo(() => describeDraftDiff(diff), [diff]);

  if (!diff) {
    return null;
  }

  if (diff.ok === false) {
    return (
      <Panel title="Changes vs saved program" tone="amber">
        <p className="text-sm font-semibold text-amber-100">{diff.error}</p>
      </Panel>
    );
  }

  const Group = ({ title, lines }) =>
    lines.length ? (
      <div>
        <p className="text-[11px] font-black uppercase tracking-[0.12em] text-zinc-400">{title}</p>
        <ul className="mt-1 space-y-0.5">
          {lines.map((line, index) => (
            <li key={`${index}-${line}`} className="break-words text-sm font-semibold text-zinc-200">
              {line}
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  const changeCount =
    described.program.length +
    described.days.length +
    described.added.length +
    described.removed.length +
    described.moved.length +
    described.changed.length;

  return (
    <Panel title={`Changes vs saved program (${changeCount})`} tone="lime" defaultOpen={mode === "review"}>
      {described.isEmpty ? (
        <p className="text-sm font-semibold text-zinc-400">No differences from the saved program yet.</p>
      ) : (
        <div className="space-y-3">
          <Group title="Program details" lines={described.program} />
          <Group title="Days" lines={described.days} />
          <Group title="Added exercises" lines={described.added} />
          <Group title="Removed exercises" lines={described.removed} />
          <Group title="Moved exercises" lines={described.moved} />
          {described.changed.length ? (
            <div>
              <p className="text-[11px] font-black uppercase tracking-[0.12em] text-zinc-400">Changed exercises</p>
              <ul className="mt-1 space-y-1.5">
                {described.changed.map((entry, index) => (
                  <li key={`${index}-${entry.title}`}>
                    <p className="break-words text-sm font-black text-zinc-100">{entry.title}</p>
                    <ul className="ml-3 list-disc space-y-0.5">
                      {entry.fields.map((line, lineIndex) => (
                        <li key={`${lineIndex}-${line}`} className="break-words text-xs font-semibold text-zinc-300">
                          {line}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-xs font-semibold leading-5 text-zinc-400">
            Exercises whose prescription changed lose their earned progression and pending plan, so the next
            session starts from the new target. Workout history is never touched.
          </p>
        </div>
      )}
    </Panel>
  );
}

function ReviewNotesPanel({ review, draft }) {
  const counts = useMemo(() => countDraftProvenance(draft), [draft]);
  const summary = useMemo(() => summarizeProgramDraft(draft), [draft]);
  const newExercises = useMemo(() => describeNewExercises(draft), [draft]);
  const changes = review?.changes ?? [];
  const removed = review?.removed ?? [];
  const uncertainty = review?.uncertainty ?? [];
  const hasAiNotes = changes.length || removed.length || uncertainty.length;

  return (
    <Panel title={review?.title ?? "Review before saving"} tone="amber">
      <div className="space-y-3">
        {review?.instruction ? (
          <p className="break-words text-sm font-semibold text-zinc-300">
            <span className="text-zinc-400">Instruction: </span>
            {review.instruction}
          </p>
        ) : null}
        <p className="text-sm font-semibold leading-6 text-zinc-300">
          {summary.exerciseCount} {summary.exerciseCount === 1 ? "exercise" : "exercises"} on {summary.dayCount}{" "}
          {summary.dayCount === 1 ? "day" : "days"}
          {newExercises ? ` - ${newExercises}` : ""}
          {summary.unresolvedCount ? ` - ${summary.unresolvedCount} unmatched` : ""}. Values: {counts.source} from
          source, {counts.default} default, {counts.edited} edited.
        </p>
        {changes.length ? (
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.12em] text-zinc-400">What the AI changed</p>
            <ul className="mt-1 ml-3 list-disc space-y-0.5">
              {changes.map((line, index) => (
                <li key={`${index}-${line}`} className="break-words text-sm font-semibold text-zinc-200">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {removed.length ? (
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.12em] text-zinc-400">Not echoed by the AI (removed)</p>
            <ul className="mt-1 ml-3 list-disc space-y-0.5">
              {removed.map((entry, index) => (
                <li key={`${index}-${entry.refId ?? entry.name}`} className="break-words text-sm font-semibold text-zinc-200">
                  {entry.name}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {uncertainty.length ? (
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.12em] text-amber-200">Uncertainty disclosed</p>
            <ul className="mt-1 ml-3 list-disc space-y-0.5">
              {uncertainty.map((line, index) => (
                <li key={`${index}-${line}`} className="break-words text-sm font-semibold text-amber-100">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {!hasAiNotes && review?.origin !== "file-import" ? (
          <p className="text-sm font-semibold text-zinc-400">No changes or uncertainty were reported.</p>
        ) : null}
        <p className="text-xs font-semibold leading-5 text-zinc-400">
          Nothing is saved until you press the save button below. Cancel discards this draft and leaves your
          programs untouched.
        </p>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Warm-up editor (informational rows, never exercises)
// ---------------------------------------------------------------------------

function toWarmupRows(warmup) {
  return (warmup?.items ?? []).map((item) => ({
    id: item.id || makeDraftItemId("warmup"),
    name: item.name ?? "",
    prescription: item.prescription ?? "",
    notes: item.notes ?? "",
    videoUrl: item.videoUrl ?? "",
  }));
}

function WarmupEditor({ day, onChange }) {
  const [title, setTitle] = useState(day.warmup?.title ?? "Warm-up & Activation");
  const [rows, setRows] = useState(() => toWarmupRows(day.warmup));

  function commit(nextTitle, nextRows) {
    setTitle(nextTitle);
    setRows(nextRows);
    onChange(nextRows.length ? { title: nextTitle, items: nextRows } : null);
  }

  function updateRow(rowId, field, value) {
    commit(
      title,
      rows.map((row) => (row.id === rowId ? { ...row, [field]: value } : row)),
    );
  }

  return (
    <div className="rounded-[8px] border border-cyan-400/30 bg-cyan-400/5 p-3">
      <p className="text-xs font-black uppercase tracking-[0.14em] text-cyan-200/90">Warm-up - informational only</p>
      <p className="mt-1 text-xs font-semibold leading-5 text-zinc-400">
        Instructions shown before the working sets. Warm-up items are never logged, never progressed and never
        become Library exercises.
      </p>
      {rows.length ? (
        <div className="mt-3 space-y-3">
          <TextField id={`warmup-title-${day.id}`} label="Warm-up title" value={title} onChange={(value) => commit(value, rows)} />
          {rows.map((row, index) => (
            <div key={row.id} className="rounded-[8px] border border-zinc-800 bg-[#111111] p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-black uppercase tracking-[0.12em] text-zinc-400">Item {index + 1}</p>
                <button
                  type="button"
                  onClick={() => commit(title, rows.filter((entry) => entry.id !== row.id))}
                  className={smallButtonClassName}
                  aria-label={`Remove warm-up item ${index + 1}`}
                >
                  <Trash2 aria-hidden="true" size={13} />
                  Remove
                </button>
              </div>
              <div className="mt-2 grid gap-3 min-[430px]:grid-cols-2">
                <TextField id={`warmup-${row.id}-name`} label="Name" value={row.name} onChange={(value) => updateRow(row.id, "name", value)} placeholder="Light cardio" />
                <TextField id={`warmup-${row.id}-prescription`} label="Prescription" value={row.prescription} onChange={(value) => updateRow(row.id, "prescription", value)} placeholder="3-5 min" />
                <TextField id={`warmup-${row.id}-notes`} label="Notes" value={row.notes} onChange={(value) => updateRow(row.id, "notes", value)} placeholder="Easy pace" />
                <TextField id={`warmup-${row.id}-video`} label="Video URL" value={row.videoUrl} onChange={(value) => updateRow(row.id, "videoUrl", value)} placeholder="Optional" />
              </div>
              {!row.name.trim() && !row.prescription.trim() ? (
                <p className="mt-2 text-xs font-bold text-amber-200">Give this item a name or a prescription, or it is dropped on save.</p>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-sm font-semibold text-zinc-400">No warm-up on this day.</p>
      )}
      <button
        type="button"
        onClick={() =>
          commit(title, [...rows, { id: makeDraftItemId("warmup"), name: "", prescription: "", notes: "", videoUrl: "" }])
        }
        className={`${secondaryButtonClassName} mt-3 w-full min-[430px]:w-auto`}
      >
        <Plus aria-hidden="true" size={15} />
        Add warm-up item
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function ProgramScreen({
  draft,
  mode,
  grouped,
  diff,
  review,
  onMeta,
  onAddDay,
  onRemoveDay,
  onMoveDay,
  onOpenDay,
}) {
  const summary = useMemo(() => summarizeProgramDraft(draft), [draft]);

  return (
    <div className="space-y-4">
      {review ? <ReviewNotesPanel review={review} draft={draft} /> : null}
      {diff ? <DiffPanel diff={diff} mode={mode} /> : null}

      <section className="rounded-[8px] border border-zinc-800 bg-[#111111] p-3">
        <p className="text-xs font-black uppercase tracking-[0.14em] text-lime-300">Program details</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <TextField
            id="studio-program-name"
            label="Program name"
            value={draft.program.name}
            onChange={(value) => onMeta({ name: value })}
            placeholder="Required"
            error={grouped.program.find((message) => /program name/i.test(message)) ?? ""}
          />
          <TextField id="studio-program-nickname" label="Nickname" value={draft.program.nickname} onChange={(value) => onMeta({ nickname: value })} placeholder="Short name for mobile" />
          <TextAreaField id="studio-program-description" label="Description" value={draft.program.description} onChange={(value) => onMeta({ description: value })} />
          <TextAreaField id="studio-program-goal" label="Goal" value={draft.program.goal} onChange={(value) => onMeta({ goal: value })} />
        </div>
      </section>

      <section className="rounded-[8px] border border-zinc-800 bg-[#111111] p-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-black uppercase tracking-[0.14em] text-lime-300">
            Days ({draft.days.length}) - {summary.exerciseCount} {summary.exerciseCount === 1 ? "exercise" : "exercises"}
          </p>
        </div>
        {draft.days.length ? (
          <ul className="mt-3 space-y-2">
            {draft.days.map((day, index) => {
              const exerciseCount = countDayExercises(day);
              const errorCount = grouped.byDayId[day.id]?.length ?? 0;

              return (
                <li key={day.id} className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3">
                  <button
                    type="button"
                    onClick={() => onOpenDay(day.id)}
                    className="focus-ring flex w-full items-start justify-between gap-3 text-left"
                  >
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="break-words text-sm font-black text-white">{day.name || `Day ${index + 1}`}</span>
                        {day.isOptional ? <span className="rounded-[4px] border border-zinc-700 px-1.5 py-0.5 text-[10px] font-black text-zinc-400">Optional</span> : null}
                        <ErrorBadge count={errorCount} />
                      </span>
                      <span className="mt-1 block text-xs font-semibold text-zinc-400">
                        {day.focus ? `${day.focus} | ` : ""}
                        {exerciseCount} {exerciseCount === 1 ? "exercise" : "exercises"}
                        {day.warmup ? ` | warm-up: ${day.warmup.items.length} ${day.warmup.items.length === 1 ? "item" : "items"}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 rounded-[8px] border border-zinc-700 px-2 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-zinc-300">
                      Open
                    </span>
                  </button>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" disabled={index === 0} onClick={() => onMoveDay(day.id, index - 1)} className={smallButtonClassName} aria-label={`Move ${day.name} up`}>
                      <ArrowUp aria-hidden="true" size={13} />
                      Up
                    </button>
                    <button type="button" disabled={index === draft.days.length - 1} onClick={() => onMoveDay(day.id, index + 1)} className={smallButtonClassName} aria-label={`Move ${day.name} down`}>
                      <ArrowDown aria-hidden="true" size={13} />
                      Down
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!exerciseCount || confirmAction(`Remove "${day.name}" and its ${exerciseCount} exercises from this draft?`)) {
                          onRemoveDay(day.id);
                        }
                      }}
                      className={smallButtonClassName}
                      aria-label={`Remove ${day.name}`}
                    >
                      <Trash2 aria-hidden="true" size={13} />
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-sm font-semibold text-zinc-400">No days yet. A program needs at least one day.</p>
        )}
        <button type="button" onClick={onAddDay} className={`${secondaryButtonClassName} mt-3 w-full sm:w-auto`}>
          <Plus aria-hidden="true" size={15} />
          Add day
        </button>
      </section>
    </div>
  );
}

function DayScreen({
  draft,
  day,
  grouped,
  onBack,
  onDayMeta,
  onWarmup,
  onAddSection,
  onRemoveSection,
  onMoveSection,
  onRenameSection,
  onAddExercise,
  onRemoveExercise,
  onMoveExercise,
  onOpenExercise,
}) {
  const dayIndex = draft.days.findIndex((entry) => entry.id === day.id);

  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className={secondaryButtonClassName}>
        <ChevronLeft aria-hidden="true" size={16} />
        Back to program
      </button>

      <section className="rounded-[8px] border border-zinc-800 bg-[#111111] p-3">
        <p className="text-xs font-black uppercase tracking-[0.14em] text-lime-300">Day {dayIndex + 1}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <TextField id={`day-name-${day.id}`} label="Day name" value={day.name} onChange={(value) => onDayMeta({ name: value })} placeholder="Required" error={grouped.byDayId[day.id]?.find((message) => /day name/i.test(message)) ?? ""} />
          <TextField id={`day-focus-${day.id}`} label="Focus" value={day.focus} onChange={(value) => onDayMeta({ focus: value })} placeholder="Upper push, legs..." />
          <TextAreaField id={`day-notes-${day.id}`} label="Day notes" value={day.notes} onChange={(value) => onDayMeta({ notes: value })} />
          <CheckboxField id={`day-optional-${day.id}`} label="Optional day" checked={Boolean(day.isOptional)} onChange={(value) => onDayMeta({ isOptional: value })} />
        </div>
      </section>

      <WarmupEditor key={day.id} day={day} onChange={onWarmup} />

      <section className="space-y-3">
        <p className="text-xs font-black uppercase tracking-[0.14em] text-lime-300">Working exercises</p>
        {day.sections.map((section, sectionIndex) => (
          <div key={section.id} className="rounded-[8px] border border-zinc-800 bg-[#111111] p-3">
            <div className="grid gap-2">
              <TextField
                id={`section-name-${section.id}`}
                label={`Section ${sectionIndex + 1}`}
                value={section.name}
                onChange={(value) => onRenameSection(section.id, value)}
                error={grouped.bySectionId[section.id]?.[0] ?? ""}
              />
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={sectionIndex === 0} onClick={() => onMoveSection(section.id, sectionIndex - 1)} className={smallButtonClassName} aria-label={`Move section ${section.name} up`}>
                  <ArrowUp aria-hidden="true" size={13} />
                  Up
                </button>
                <button type="button" disabled={sectionIndex === day.sections.length - 1} onClick={() => onMoveSection(section.id, sectionIndex + 1)} className={smallButtonClassName} aria-label={`Move section ${section.name} down`}>
                  <ArrowDown aria-hidden="true" size={13} />
                  Down
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!section.exercises.length || confirmAction(`Remove section "${section.name}" and its ${section.exercises.length} exercises?`)) {
                      onRemoveSection(section.id);
                    }
                  }}
                  className={smallButtonClassName}
                  aria-label={`Remove section ${section.name}`}
                >
                  <Trash2 aria-hidden="true" size={13} />
                  Remove section
                </button>
              </div>
            </div>

            {section.exercises.length ? (
              <ul className="mt-3 space-y-2">
                {section.exercises.map((exercise, exerciseIndex) => {
                  const errorCount = grouped.byExerciseId[exercise.id]?.length ?? 0;
                  const otherSections = day.sections.filter((entry) => entry.id !== section.id);

                  return (
                    <li key={exercise.id} className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3">
                      <button type="button" onClick={() => onOpenExercise(exercise.id)} className="focus-ring flex w-full items-start justify-between gap-3 text-left">
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="break-words text-sm font-black text-white">{exercise.name || "Unnamed exercise"}</span>
                            <StatusTag status={exercise.libraryStatus} />
                            {exercise.isOptional ? <span className="rounded-[4px] border border-zinc-700 px-1.5 py-0.5 text-[10px] font-black text-zinc-400">Optional</span> : null}
                            <ErrorBadge count={errorCount} />
                          </span>
                          <span className="mt-1 block text-xs font-semibold leading-5 text-zinc-400">{formatDraftPrescription(exercise)}</span>
                          {exercise.sourceWeight ? <span className="block text-xs font-semibold text-zinc-400">Source listed: {exercise.sourceWeight}</span> : null}
                        </span>
                        <span className="shrink-0 rounded-[8px] border border-zinc-700 px-2 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-zinc-300">Edit</span>
                      </button>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <button type="button" disabled={exerciseIndex === 0} onClick={() => onMoveExercise(exercise.id, { index: exerciseIndex - 1 })} className={smallButtonClassName} aria-label={`Move ${exercise.name} up`}>
                          <ArrowUp aria-hidden="true" size={13} />
                          Up
                        </button>
                        <button type="button" disabled={exerciseIndex === section.exercises.length - 1} onClick={() => onMoveExercise(exercise.id, { index: exerciseIndex + 1 })} className={smallButtonClassName} aria-label={`Move ${exercise.name} down`}>
                          <ArrowDown aria-hidden="true" size={13} />
                          Down
                        </button>
                        {otherSections.length ? (
                          <select
                            value=""
                            aria-label={`Move ${exercise.name} to section`}
                            onChange={(event) => {
                              if (event.target.value) {
                                onMoveExercise(exercise.id, { sectionId: event.target.value });
                              }
                            }}
                            className="focus-ring min-h-10 rounded-[8px] border border-zinc-700 bg-[#111111] px-2 text-xs font-black text-zinc-200"
                          >
                            <option value="">Move to section...</option>
                            {otherSections.map((entry) => (
                              <option key={entry.id} value={entry.id}>
                                {entry.name}
                              </option>
                            ))}
                          </select>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => {
                            if (confirmAction(`Remove "${exercise.name || "this exercise"}" from this draft?`)) {
                              onRemoveExercise(exercise.id);
                            }
                          }}
                          className={smallButtonClassName}
                          aria-label={`Remove ${exercise.name}`}
                        >
                          <Trash2 aria-hidden="true" size={13} />
                          Remove
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-2 text-sm font-semibold text-zinc-400">No exercises in this section.</p>
            )}
            <button type="button" onClick={() => onAddExercise(section.id)} className={`${secondaryButtonClassName} mt-3 w-full sm:w-auto`}>
              <Plus aria-hidden="true" size={15} />
              Add exercise
            </button>
          </div>
        ))}
        <button type="button" onClick={onAddSection} className={`${secondaryButtonClassName} w-full sm:w-auto`}>
          <Plus aria-hidden="true" size={15} />
          Add section
        </button>
      </section>
    </div>
  );
}

function LibraryPicker({ draft, exercise, library, onPick, onProposeNew }) {
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState(exercise.name ?? "");
  const [isOpen, setIsOpen] = useState(exercise.libraryStatus === "unmatched");
  const proposed = draft.libraryExercises ?? [];
  const results = useMemo(() => searchLibraryEntries([...library, ...proposed], query, 30), [library, proposed, query]);
  const proposedIds = useMemo(() => new Set(proposed.map((entry) => String(entry.id))), [proposed]);
  const matched = exercise.exerciseId
    ? library.find((entry) => String(entry.id) === String(exercise.exerciseId)) ??
      proposed.find((entry) => String(entry.id) === String(exercise.exerciseId)) ??
      null
    : null;

  return (
    <section className="rounded-[8px] border border-zinc-800 bg-[#111111] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-black uppercase tracking-[0.14em] text-lime-300">Library match</p>
        <ProvenanceTag label={getProvenanceLabel(exercise, "exerciseId")} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <StatusTag status={exercise.libraryStatus} />
        <p className="min-w-0 break-words text-sm font-bold text-zinc-100">
          {exercise.libraryStatus === "library" && matched
            ? `${matched.name}${matched.equipment ? ` - ${matched.equipment}` : ""}${matched.category ? ` - ${matched.category}` : ""}`
            : exercise.libraryStatus === "new"
              ? `${exercise.name} (new exercise, ${hasTechniqueNotes(exercise.newLibraryExercise) ? "technique notes added below" : "no technique content yet"})`
              : "Pick a Library exercise or create it as a new one."}
        </p>
      </div>
      {!isOpen ? (
        <button type="button" onClick={() => setIsOpen(true)} className={`${secondaryButtonClassName} mt-3 w-full sm:w-auto`}>
          <Search aria-hidden="true" size={15} />
          Change match
        </button>
      ) : (
        <div className="mt-3 space-y-3">
          <div>
            <FieldLabel label="Search the Library (name, equipment, muscle, category)" htmlFor={`library-search-${exercise.id}`} />
            <input
              id={`library-search-${exercise.id}`}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="bench, dumbbell, chest..."
              className={inputClassName}
              autoComplete="off"
            />
          </div>
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {results.map((entry) => {
              const isCurrent = String(entry.id) === String(exercise.exerciseId);

              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onPick(entry.id);
                      setIsOpen(false);
                    }}
                    className={`focus-ring flex min-h-11 w-full items-center justify-between gap-2 rounded-[8px] border px-3 text-left ${
                      isCurrent ? "border-lime-300/60 bg-lime-300/10" : "border-zinc-800 bg-zinc-900 hover:bg-zinc-800"
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block break-words text-sm font-black text-white">{entry.name}</span>
                      <span className="block text-xs font-semibold text-zinc-400">
                        {[entry.equipment, entry.category, (entry.mainMuscles ?? []).slice(0, 2).join(", ")].filter(Boolean).join(" - ")}
                      </span>
                    </span>
                    {proposedIds.has(String(entry.id)) ? <StatusTag status="new" /> : isCurrent ? <Check aria-hidden="true" size={16} className="shrink-0 text-lime-300" /> : null}
                  </button>
                </li>
              );
            })}
            {!results.length ? <li className="px-1 text-sm font-semibold text-zinc-400">No Library exercise matches "{query}".</li> : null}
          </ul>
          <div className="rounded-[8px] border border-amber-400/30 bg-amber-400/5 p-3">
            <p className="text-xs font-black uppercase tracking-[0.14em] text-amber-200">New exercise (no technique content yet)</p>
            <p className="mt-1 text-xs font-semibold leading-5 text-zinc-400">
              Adds a private Library entry with this name when the program is saved. Technique notes can be added here,
              under "Technique notes", before you save; the Library shows them but cannot edit them yet.
            </p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="Exercise name"
                aria-label="New exercise name"
                className={inputClassName}
              />
              <button
                type="button"
                disabled={!newName.trim()}
                onClick={() => {
                  onProposeNew(newName.trim());
                  setIsOpen(false);
                }}
                className={`${secondaryButtonClassName} shrink-0 border-amber-400/50 text-amber-100 disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <Plus aria-hidden="true" size={15} />
                Use as new exercise
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function ExerciseScreen({
  draft,
  day,
  exercise,
  library,
  grouped,
  onBack,
  onPatch,
  onRemap,
  onProposeNew,
  onRemove,
  onTechniqueEntry,
  onAcceptTechnique,
  onUpdateProgramExerciseProfile,
}) {
  const [form, setForm] = useState(() => createExerciseForm(exercise));
  const [fieldErrors, setFieldErrors] = useState({});
  const errors = grouped.byExerciseId[exercise.id] ?? [];
  // H5 fix round 1 (decision H5-19): the coach profile travels with the
  // draft (measurement / perSide / profileOverrides are draft exercise
  // fields), so the disclosure edits the draft exercise and nothing is
  // written until Save program. The draft exercise carries its own explicit
  // fields, so it also tells "set" from "inferred".
  const profileExercise = useMemo(
    () => ({ ...exercise, programExerciseId: exercise.id, repsLabel: exercise.targetReps?.label ?? exercise.repsLabel ?? null, repsMin: exercise.targetReps?.min ?? null, repsMax: exercise.targetReps?.max ?? null }),
    [exercise],
  );

  function changeField(field, value) {
    const nextForm = { ...form, [field]: value };
    setForm(nextForm);
    const result = buildExercisePatch(field, value, nextForm);

    // Unparseable text still reaches the draft (as typed for rest / weight,
    // null for numbers), so validation reports it and Save stays blocked;
    // the inline message only explains what to fix.
    setFieldErrors((current) => {
      if (result.error) {
        return { ...current, [field]: result.error };
      }

      if (!current[field]) {
        return current;
      }

      const next = { ...current };
      delete next[field];
      return next;
    });

    if (result.patch) {
      onPatch(result.patch);
    }
  }

  const tag = (field) => getProvenanceLabel(exercise, field);

  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className={secondaryButtonClassName}>
        <ChevronLeft aria-hidden="true" size={16} />
        Back to {day.name}
      </button>

      <section className="rounded-[8px] border border-zinc-800 bg-[#111111] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="break-words text-lg font-black text-white">{exercise.name || "Unnamed exercise"}</h3>
          <StatusTag status={exercise.libraryStatus} />
        </div>
        <p className="mt-1 text-xs font-semibold leading-5 text-zinc-400">{formatDraftPrescription(exercise)}</p>
        {exercise.libraryStatus !== "library" ? (
          <div className="mt-3">
            <TextField
              id={`exercise-name-${exercise.id}`}
              label="Exercise name"
              value={exercise.name}
              onChange={(value) => changeField("name", value)}
              tag={tag("name")}
              placeholder="Required for a new exercise"
            />
          </div>
        ) : null}
      </section>

      <LibraryPicker draft={draft} exercise={exercise} library={library} onPick={onRemap} onProposeNew={onProposeNew} />

      {/* Decision H3-6: technique notes and AI drafts exist for NEW exercises only. */}
      {exercise.libraryStatus === "new" ? (
        <TechniqueNotesSection
          key={exercise.exerciseId}
          exercise={exercise}
          onChangeEntry={onTechniqueEntry}
          onAcceptDraft={onAcceptTechnique}
        />
      ) : null}

      <section className="rounded-[8px] border border-zinc-800 bg-[#111111] p-3">
        <p className="text-xs font-black uppercase tracking-[0.14em] text-lime-300">Prescription</p>
        <div className="mt-3 grid gap-3 min-[430px]:grid-cols-2">
          <TextField id={`ex-sets-${exercise.id}`} label="Sets" value={form.targetSets} onChange={(value) => changeField("targetSets", value)} inputMode="numeric" tag={tag("targetSets")} error={fieldErrors.targetSets ?? ""} />
          <TextField id={`ex-rpe-${exercise.id}`} label="Target RPE" value={form.targetRPE} onChange={(value) => changeField("targetRPE", value)} inputMode="decimal" tag={tag("targetRPE")} error={fieldErrors.targetRPE ?? ""} />
          <TextField id={`ex-reps-min-${exercise.id}`} label="Reps min" value={form.repsMin} onChange={(value) => changeField("repsMin", value)} inputMode="numeric" tag={tag("targetReps")} />
          <TextField id={`ex-reps-max-${exercise.id}`} label="Reps max" value={form.repsMax} onChange={(value) => changeField("repsMax", value)} inputMode="numeric" tag={tag("targetReps")} />
          <TextField id={`ex-reps-label-${exercise.id}`} label="Reps label" value={form.repsLabel} onChange={(value) => changeField("repsLabel", value)} placeholder="30 s, AMRAP, 10/side..." tag={tag("targetReps")} />
          <TextField id={`ex-weight-${exercise.id}`} label="Kg / weight" value={form.targetWeight} onChange={(value) => changeField("targetWeight", value)} inputMode="decimal" placeholder={exercise.loadType === "bodyweight" ? "BW" : "Blank = coach decides"} tag={tag("targetWeight")} error={fieldErrors.targetWeight ?? ""} />
          <TextField id={`ex-rest-${exercise.id}`} label="Rest (sec or min-max)" value={form.restTime} onChange={(value) => changeField("restTime", value)} placeholder="90 or 150-180" tag={tag("restTime")} error={fieldErrors.restTime ?? ""} />
          <SelectField id={`ex-type-${exercise.id}`} label="Progression type" value={EXERCISE_TYPE_OPTIONS.includes(exercise.type) ? exercise.type : "hypertrophy"} options={EXERCISE_TYPE_OPTIONS} onChange={(value) => changeField("type", value)} tag={tag("type")} />
          <SelectField id={`ex-load-${exercise.id}`} label="Load type" value={exercise.loadType ?? "external"} options={LOAD_TYPES.map((value) => ({ value, label: value === "optionalExternal" ? "optional external" : value }))} onChange={(value) => changeField("loadType", value)} tag={tag("loadType")} />
          <SelectField id={`ex-mode-${exercise.id}`} label="Weight mode" value={exercise.weightMode ?? "kg"} options={WEIGHT_MODES} onChange={(value) => changeField("weightMode", value)} tag={tag("weightMode")} />
          <CheckboxField id={`ex-optional-${exercise.id}`} label="Optional exercise" checked={Boolean(exercise.isOptional)} onChange={(value) => changeField("isOptional", value)} tag={tag("isOptional")} />
          {exercise.sourceWeight ? (
            <div className="rounded-[8px] border border-zinc-800 bg-zinc-900 px-3 py-2">
              <span className="flex items-center justify-between gap-2">
                <span className="text-xs font-black uppercase tracking-[0.14em] text-zinc-400">Source listed</span>
                <ProvenanceTag label={tag("sourceWeight")} />
              </span>
              <p className="mt-1 break-words text-sm font-bold text-zinc-200">{exercise.sourceWeight}</p>
              <p className="text-xs font-semibold text-zinc-400">Reference only - never used as a target or by the coach.</p>
            </div>
          ) : null}
        </div>
        <div className="mt-3">
          <TextAreaField id={`ex-notes-${exercise.id}`} label="Exercise notes" value={exercise.notes} onChange={(value) => changeField("notes", value)} tag={tag("notes")} />
        </div>
        {errors.length ? (
          <div className="mt-3">
            <ErrorList messages={errors} />
          </div>
        ) : null}
      </section>

      {onUpdateProgramExerciseProfile ? (
        <CoachProfileDisclosure
          programId={draft.sourceProgramId ?? null}
          exercise={profileExercise}
          stored={profileExercise}
          onUpdateProgramExerciseProfile={onUpdateProgramExerciseProfile}
          onPatchDraft={(patch) => onPatch(patch)}
        />
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
        <button type="button" onClick={onBack} className={primaryButtonClassName}>
          <Check aria-hidden="true" size={16} />
          Done
        </button>
        <button
          type="button"
          onClick={() => {
            if (confirmAction(`Remove "${exercise.name || "this exercise"}" from this draft?`)) {
              onRemove();
            }
          }}
          className={`${secondaryButtonClassName} text-red-100`}
        >
          <Trash2 aria-hidden="true" size={15} />
          Remove exercise
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Studio
// ---------------------------------------------------------------------------

/**
 * One editor for four entry points: New Program (create), Edit Program (edit),
 * AI import / AI edit / file import (review). Everything happens on a working
 * copy of the draft; `onSave(draft)` must return the writer result
 * ({ ok, error, errors }) and the parent closes the studio on ok. Cancel never
 * touches saved programs. The working copy is autosaved as a stored draft so a
 * reload can offer "Resume unsaved draft"; it is deleted on save or cancel.
 *
 * The working copy is also reported to the parent through `onDraftChange`
 * and comes back as `draft` when the Studio remounts (a bottom-nav tab switch
 * unmounts the Program page), while `initialDraft` stays the draft the
 * session opened with so "dirty" and the diff keep their meaning. A review
 * draft (AI import / AI edit / file import) is stored as soon as it opens:
 * it is the only copy of a paid extraction.
 *
 * props: { draft, initialDraft?, mode: 'create'|'edit'|'review', onSave, onCancel, onDraftChange?, diff?, review?, isResumed? }
 */
export default function ProgramStudio({
  draft,
  initialDraft = null,
  mode = "create",
  onSave,
  onCancel,
  onDraftChange,
  diff: diffProp = null,
  review = null,
  isResumed = false,
  onUpdateProgramExerciseProfile = null,
}) {
  const initialRef = useRef(initialDraft ?? draft);
  const [working, setWorking] = useState(draft);
  const workingRef = useRef(draft);
  workingRef.current = working;
  const [screen, setScreen] = useState({ kind: "program" });
  const [saveError, setSaveError] = useState("");
  const [saveErrors, setSaveErrors] = useState([]);
  const [autosaveState, setAutosaveState] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const closedRef = useRef(false);
  const autosaveTimerRef = useRef(null);
  // True while the working copy has changes the stored draft does not hold yet.
  const pendingStoreRef = useRef(false);
  const library = useMemo(() => getExerciseLibrary(), []);

  const validation = useMemo(() => validateProgramDraft(working), [working]);
  const grouped = useMemo(() => groupDraftValidationErrors(working, validation.errors), [working, validation]);
  const dirty = isDraftDirty(initialRef.current, working);
  const liveDiff = useMemo(
    () => (working.sourceProgramId ? diffDraftAgainstProgram(working) : diffProp),
    [working, diffProp],
  );
  const summary = useMemo(() => summarizeProgramDraft(working), [working]);

  // Stored copy (planDraftStore): a review draft is kept from the moment it
  // opens, an edited draft after a short pause, a draft put back the way it
  // opened has its stored copy removed (or, when resumed, brought in step),
  // so a reload never offers to resume an edit the user undid.
  useEffect(() => {
    if (closedRef.current) {
      return undefined;
    }

    const plan = planDraftStore({
      dirty,
      mode,
      isResumed,
      storedCopyDiffers:
        !dirty && isResumed && mode !== "review" ? isDraftDirty(loadStoredDraft(working.draftId), working) : false,
      delay: AUTOSAVE_DELAY_MS,
    });

    if (plan.action === "none") {
      return undefined;
    }

    if (plan.action === "delete") {
      pendingStoreRef.current = false;
      deleteStoredDraft(working.draftId);
      setAutosaveState("");
      return undefined;
    }

    pendingStoreRef.current = true;
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null;

      if (closedRef.current) {
        return;
      }

      const result = saveDraftToStorage(working);
      pendingStoreRef.current = !result.ok;
      setAutosaveState(describeDraftStoreResult(result));
    }, plan.delay);

    return () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [working, dirty, mode, isResumed]);

  useEffect(
    () => () => {
      // Unmount with a pending autosave (tab switch, page swap): flush it so
      // the last edits are on disk, unless the Studio was closed on purpose.
      // (The autosave effect's own cleanup has already cleared the timer by
      // the time this runs, hence the separate pending flag.)
      flushPendingDraftStore({
        pending: pendingStoreRef.current,
        closed: closedRef.current,
        draft: workingRef.current,
        save: saveDraftToStorage,
      });
      pendingStoreRef.current = false;
    },
    [],
  );

  function apply(nextDraft) {
    if (nextDraft !== working) {
      setWorking(nextDraft);
      onDraftChange?.(nextDraft);
      setSaveError("");
      setSaveErrors([]);
    }
  }

  function closeStudio() {
    closedRef.current = true;
    pendingStoreRef.current = false;

    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }

    deleteStoredDraft(working.draftId);
  }

  function handleCancel() {
    // Edits, a resumed draft and an AI / file result are all lost on Cancel:
    // cancelStudioSession asks first and discards (closeStudio) only after a
    // confirmed answer.
    const result = cancelStudioSession({
      dirty,
      mode,
      isResumed,
      draftId: working.draftId,
      confirm: confirmAction,
      discard: closeStudio,
    });

    if (result.cancelled) {
      onCancel?.();
    }
  }

  function handleSave() {
    if (!validation.valid || isSaving) {
      return;
    }

    setIsSaving(true);

    try {
      const result = onSave(working);

      if (!result?.ok) {
        setSaveError(result?.error ?? "The program could not be saved.");
        setSaveErrors((result?.errors ?? []).map((entry) => (typeof entry === "string" ? entry : entry?.message)).filter(Boolean));
        return;
      }

      closeStudio();
    } finally {
      setIsSaving(false);
    }
  }

  const currentDay = screen.kind !== "program" ? working.days.find((day) => day.id === screen.dayId) : null;
  const currentExercise =
    screen.kind === "exercise" && currentDay
      ? currentDay.sections.flatMap((section) => section.exercises).find((exercise) => exercise.id === screen.exerciseId)
      : null;

  useEffect(() => {
    if (screen.kind !== "program" && !currentDay) {
      setScreen({ kind: "program" });
    } else if (screen.kind === "exercise" && !currentExercise) {
      setScreen({ kind: "day", dayId: screen.dayId });
    }
  }, [screen, currentDay, currentExercise]);

  useEffect(() => {
    if (typeof window !== "undefined" && typeof window.scrollTo === "function") {
      window.scrollTo({ top: 0 });
    }
  }, [screen.kind, screen.dayId, screen.exerciseId]);

  const title = mode === "create" ? "New Program" : mode === "edit" ? "Edit Program" : "Review Draft";
  const saveLabel = working.sourceProgramId ? "Apply Changes" : mode === "create" ? "Save Program" : "Save as New Program";
  const errorCount = validation.errors.length;

  return (
    <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3 min-[430px]:p-4" data-testid="program-studio">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">Program Studio</p>
          <h2 className="mt-1 break-words text-2xl font-black text-white">{title}</h2>
          <p className="mt-1 text-xs font-semibold text-zinc-400">
            {ORIGIN_LABELS[working.origin] ?? "Draft"} | {summary.dayCount} {summary.dayCount === 1 ? "day" : "days"} | {summary.exerciseCount}{" "}
            {summary.exerciseCount === 1 ? "exercise" : "exercises"}
            {dirty ? " | unsaved changes" : ""}
          </p>
        </div>
        <div className="grid gap-2 sm:min-w-44">
          <button
            type="button"
            onClick={handleSave}
            disabled={!validation.valid || isSaving}
            className={primaryButtonClassName}
            title={validation.valid ? saveLabel : "Fix the listed issues first"}
          >
            <Check aria-hidden="true" size={16} />
            {saveLabel}
          </button>
          <button type="button" onClick={handleCancel} className={secondaryButtonClassName}>
            Cancel
          </button>
        </div>
      </div>

      {saveError ? (
        <div className="mt-3">
          <ErrorList messages={[saveError, ...saveErrors]} />
        </div>
      ) : null}

      {errorCount > 0 ? (
        <div className="mt-3 rounded-[8px] border border-amber-400/40 bg-amber-400/10 px-3 py-2">
          <p className="text-xs font-black uppercase tracking-[0.14em] text-amber-200">
            {errorCount} {errorCount === 1 ? "issue" : "issues"} to fix before saving
          </p>
          <ul className="mt-1 space-y-0.5">
            {grouped.all.slice(0, 8).map((entry, index) => (
              <li key={`${index}-${entry.path}`} className="break-words text-xs font-semibold text-amber-100">
                <span className="text-amber-200/80">{entry.label}: </span>
                {entry.message}
              </li>
            ))}
            {grouped.all.length > 8 ? <li className="text-xs font-semibold text-amber-200/80">and {grouped.all.length - 8} more...</li> : null}
          </ul>
        </div>
      ) : (
        <p className="mt-3 text-xs font-semibold text-zinc-400">
          Draft is valid. Nothing is written until you press {saveLabel}.
        </p>
      )}
      {autosaveState ? <p className="mt-1 text-xs font-semibold text-zinc-400">{autosaveState}</p> : null}

      <div className="mt-4">
        {screen.kind === "program" || !currentDay ? (
          <ProgramScreen
            draft={working}
            mode={mode}
            grouped={grouped}
            diff={liveDiff}
            review={review}
            onMeta={(patch) => apply(updateProgramMeta(working, patch))}
            onAddDay={() => apply(addDay(working))}
            onRemoveDay={(dayId) => apply(removeDay(working, dayId))}
            onMoveDay={(dayId, toIndex) => apply(moveDay(working, dayId, toIndex))}
            onOpenDay={(dayId) => setScreen({ kind: "day", dayId })}
          />
        ) : screen.kind === "day" || !currentExercise ? (
          <DayScreen
            draft={working}
            day={currentDay}
            grouped={grouped}
            onBack={() => setScreen({ kind: "program" })}
            onDayMeta={(patch) => apply(updateDayMeta(working, currentDay.id, patch))}
            onWarmup={(warmup) => apply(updateWarmup(working, currentDay.id, warmup))}
            onAddSection={() => apply(addSection(working, currentDay.id, { name: `Section ${currentDay.sections.length + 1}` }))}
            onRemoveSection={(sectionId) => apply(removeSection(working, currentDay.id, sectionId))}
            onMoveSection={(sectionId, toIndex) => apply(moveSection(working, currentDay.id, sectionId, toIndex))}
            onRenameSection={(sectionId, name) => apply(updateSectionMeta(working, currentDay.id, sectionId, { name }))}
            onAddExercise={(sectionId) => {
              const exerciseId = makeDraftItemId("exercise");
              apply(addExercise(working, currentDay.id, sectionId, { id: exerciseId }));
              setScreen({ kind: "exercise", dayId: currentDay.id, exerciseId });
            }}
            onRemoveExercise={(exerciseId) => apply(removeExercise(working, currentDay.id, exerciseId))}
            onMoveExercise={(exerciseId, target) => apply(moveExercise(working, currentDay.id, exerciseId, target))}
            onOpenExercise={(exerciseId) => setScreen({ kind: "exercise", dayId: currentDay.id, exerciseId })}
          />
        ) : (
          <ExerciseScreen
            key={currentExercise.id}
            draft={working}
            day={currentDay}
            exercise={currentExercise}
            library={library}
            grouped={grouped}
            onBack={() => setScreen({ kind: "day", dayId: currentDay.id })}
            onPatch={(patch) => apply(updateExercise(working, currentDay.id, currentExercise.id, patch))}
            onRemap={(libraryExerciseId) => apply(remapExercise(working, currentDay.id, currentExercise.id, libraryExerciseId))}
            onProposeNew={(name) => apply(proposeNewLibraryExercise(working, currentDay.id, currentExercise.id, { name }))}
            onRemove={() => {
              apply(removeExercise(working, currentDay.id, currentExercise.id));
              setScreen({ kind: "day", dayId: currentDay.id });
            }}
            onUpdateProgramExerciseProfile={onUpdateProgramExerciseProfile}
            onTechniqueEntry={(entry) => apply(setNewLibraryEntryInDraft(working, entry))}
            onAcceptTechnique={(techniqueDraft, options) => {
              const result = acceptTechniqueDraftIntoDraft(working, currentExercise.id, techniqueDraft, options);

              if (result.ok) {
                apply(result.draft);
              }

              return result;
            }}
          />
        )}
      </div>

      <div className="mt-5 flex flex-col gap-2 border-t border-zinc-800 pt-4 sm:flex-row">
        <button type="button" onClick={handleSave} disabled={!validation.valid || isSaving} className={`${primaryButtonClassName} flex-1`}>
          <Check aria-hidden="true" size={16} />
          {saveLabel}
        </button>
        <button type="button" onClick={handleCancel} className={secondaryButtonClassName}>
          Cancel
        </button>
      </div>
    </section>
  );
}
