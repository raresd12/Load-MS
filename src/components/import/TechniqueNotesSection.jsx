import { useState } from "react";
import { Pencil, Sparkles } from "lucide-react";
import { getGeminiApiKey, getLibraryCatalog } from "../../lib/aiProgram.js";
import { TECHNIQUE_LIST_FIELDS } from "../../lib/aiTechnique.js";
import {
  applyTechniqueForm,
  createTechniqueForm,
  detectLibraryLanguage,
  hasTechniqueNotes,
  isAiTechniqueEntry,
} from "../../lib/importAssistant.js";
import TechniqueDraftReview, { TechniqueDraftBadge, TechniqueRows } from "./TechniqueDraftReview.jsx";
import { useTechniqueDrafts } from "./useTechniqueDrafts.js";

const notesButtonClassName =
  "focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-control border px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50";
const notesFieldClassName =
  "focus-ring field w-full resize-y py-2";

/**
 * Technique notes of ONE new exercise in the Studio exercise editor
 * (decision H3-6). The Studio renders it only for libraryStatus "new".
 * Notes are shown read-only; "Edit notes" opens the fields of
 * EXERCISE_LIBRARY_SPEC.md (one bullet per line) for manual correction;
 * "Draft technique notes with AI" asks for a draft that is applied only
 * after Accept.
 *
 * props: { exercise, onChangeEntry(entry), onAcceptDraft(techniqueDraft, { replace }) -> { ok, error } }
 */
export default function TechniqueNotesSection({ exercise, onChangeEntry, onAcceptDraft }) {
  const entry = exercise.newLibraryExercise;
  const technique = useTechniqueDrafts();
  const [isEditing, setIsEditing] = useState(false);
  const [form, setForm] = useState(() => createTechniqueForm(entry));
  const [acceptErrors, setAcceptErrors] = useState({});
  const hasKey = Boolean(getGeminiApiKey());
  const hasNotes = hasTechniqueNotes(entry);

  if (!entry) {
    return null;
  }

  function toggleEditing() {
    if (!isEditing) {
      setForm(createTechniqueForm(entry));
    }

    setIsEditing((editing) => !editing);
  }

  function changeField(field, value) {
    const nextForm = { ...form, [field]: value };
    setForm(nextForm);
    onChangeEntry(applyTechniqueForm(entry, nextForm));
  }

  function handleAccept(item, options) {
    const result = onAcceptDraft(item.draft, options);

    if (!result?.ok) {
      setAcceptErrors((current) => ({
        ...current,
        [item.id]: result?.error ?? "The notes could not be applied.",
      }));
      return;
    }

    setAcceptErrors((current) => ({ ...current, [item.id]: "" }));
    setIsEditing(false);
    technique.markAccepted(item.id);
  }

  return (
    <section
      data-testid="technique-notes-section"
      className="card-inset"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="label-accent">Technique notes</p>
        {isAiTechniqueEntry(entry) ? <TechniqueDraftBadge /> : null}
      </div>
      <p className="mt-1 text-xs font-semibold leading-5 text-text-2">
        How the exercise is performed. Saved with this new exercise when the program is saved; no sets, kg or
        rest here.
      </p>

      {!isEditing ? (
        hasNotes ? (
          <div className="mt-3" data-testid="technique-notes-readonly">
            <TechniqueRows entry={entry} />
          </div>
        ) : (
          <p className="mt-2 text-sm font-semibold text-text-2">No technique notes yet.</p>
        )
      ) : (
        <div className="mt-3 space-y-3">
          <div>
            <label
              htmlFor={`technique-mainCue-${exercise.id}`}
              className="label"
            >
              Main Cue (one short sentence)
            </label>
            <input
              id={`technique-mainCue-${exercise.id}`}
              type="text"
              value={form.mainCue}
              onChange={(event) => changeField("mainCue", event.target.value)}
              className={`${notesFieldClassName} mt-1 min-h-11`}
            />
          </div>
          {TECHNIQUE_LIST_FIELDS.map(({ field, label }) => (
            <div key={field}>
              <label
                htmlFor={`technique-${field}-${exercise.id}`}
                className="label"
              >
                {label} (one bullet per line)
              </label>
              <textarea
                id={`technique-${field}-${exercise.id}`}
                rows={4}
                value={form[field]}
                onChange={(event) => changeField(field, event.target.value)}
                className={`${notesFieldClassName} mt-1`}
              />
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-col gap-2 min-[430px]:flex-row">
        <button
          type="button"
          onClick={toggleEditing}
          aria-pressed={isEditing}
          className={`${notesButtonClassName} border-line text-text-1 hover:bg-surface-3`}
        >
          <Pencil aria-hidden="true" size={15} />
          {isEditing ? "Done editing notes" : "Edit notes"}
        </button>
        <button
          type="button"
          disabled={technique.busy || !hasKey || !exercise.name}
          onClick={() =>
            technique.request(
              [
                {
                  id: entry.id,
                  name: exercise.name || entry.name,
                  equipment: entry.equipment,
                  category: entry.category,
                  mainMuscles: entry.mainMuscles,
                },
              ],
              detectLibraryLanguage(getLibraryCatalog()),
            )
          }
          className={`${notesButtonClassName} border-line-accent text-accent-soft hover:bg-accent-tint`}
        >
          <Sparkles aria-hidden="true" size={15} />
          Draft technique notes with AI
        </button>
      </div>
      <p className="mt-2 text-xs font-semibold leading-5 text-text-2">
        {hasKey
          ? "The exercise name, equipment and muscles are sent to Google when you ask for a draft. Nothing is applied until you accept it."
          : "AI drafts need your Gemini API key: save it in the AI Program Import Assistant on the Program page."}
      </p>

      <div className="mt-3">
        <TechniqueDraftReview
          items={technique.items}
          busy={technique.busy}
          progress={technique.progress}
          error={technique.error}
          uncertainty={technique.uncertainty}
          model={technique.model}
          hasNotes={() => hasNotes}
          acceptErrors={acceptErrors}
          onAccept={handleAccept}
          onDiscard={technique.discard}
        />
      </div>
    </section>
  );
}
