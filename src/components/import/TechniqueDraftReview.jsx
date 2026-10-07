import { Check, Loader2, Trash2 } from "lucide-react";
import { validateTechniqueDraft } from "../../lib/aiTechnique.js";
import { getTechniqueRows, TECHNIQUE_DRAFT_BADGE } from "../../lib/importAssistant.js";

const reviewButtonClassName =
  "focus-ring inline-flex min-h-11 items-center justify-center gap-1.5 rounded-control px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50";

export function TechniqueDraftBadge() {
  return (
    <span className="pill pill-warn">
      {TECHNIQUE_DRAFT_BADGE}
    </span>
  );
}

/** Technique text in the Library display order, one bullet per line, read-only. */
export function TechniqueRows({ entry }) {
  const rows = getTechniqueRows(entry);

  if (!rows.length) {
    return null;
  }

  return (
    <dl className="space-y-2">
      {rows.map((row) => (
        <div key={row.field}>
          <dt className="label">{row.label}</dt>
          <dd className="mt-0.5">
            {row.field === "mainCue" ? (
              <p className="break-words text-sm font-semibold text-accent-soft">{row.bullets[0]}</p>
            ) : (
              <ul className="ml-3 list-disc space-y-0.5">
                {row.bullets.map((bullet, index) => (
                  <li key={`${index}-${bullet}`} className="break-words text-sm font-semibold text-text-1">
                    {bullet}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The review list of AI technique drafts (decision H3-6): every field is
 * visible, each exercise is accepted or discarded on its own, and a draft
 * that fails validateTechniqueDraft (kg, sets, claims, links...) shows why
 * and cannot be accepted. Accepting fills the NEW entry of this draft only.
 *
 * props: { items, busy, progress, error, uncertainty, model,
 *          hasNotes(id), acceptErrors: { [id]: message },
 *          onAccept(item, { replace }), onDiscard(id) }
 */
export default function TechniqueDraftReview({
  items = [],
  busy = false,
  progress = "",
  error = "",
  uncertainty = [],
  model = "",
  hasNotes = () => false,
  acceptErrors = {},
  onAccept,
  onDiscard,
}) {
  if (!busy && !error && !items.length && !uncertainty.length) {
    return null;
  }

  return (
    <section
      aria-label="Technique note drafts"
      data-testid="technique-draft-review"
      className="rounded-block bg-warn-tint p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="label text-warn">
          Technique note drafts{model ? ` (${model})` : ""}
        </p>
        <TechniqueDraftBadge />
      </div>
      <p className="mt-1 text-xs font-semibold leading-5 text-text-2">
        Written by AI from the exercise name only. Accept adds the notes to the new exercise of this draft;
        they are saved with the program. Library exercises are never changed.
      </p>

      {busy && (
        <p role="status" className="mt-2 flex items-center gap-2 text-sm font-semibold text-text-1">
          <Loader2 aria-hidden="true" size={16} className="animate-spin" />
          {progress || "Drafting technique notes..."}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mt-2 break-words rounded-block bg-bad-tint px-3 py-2 text-sm font-medium text-bad"
        >
          {error}
        </p>
      )}

      {items.length > 0 && (
        <ul className="mt-3 space-y-3">
          {items.map((item) => {
            const validation = item.draft
              ? validateTechniqueDraft(item.draft)
              : { valid: false, errors: item.errors };
            const errors = item.status === "rejected" ? item.errors : validation.errors;
            const canAccept = item.status === "draft" && validation.valid;
            const replaces = hasNotes(item.id);

            return (
              <li
                key={item.id}
                data-technique-item={item.id}
                className="card-inset"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <p className="break-words text-sm font-semibold text-text-1">{item.name}</p>
                  {item.status === "accepted" ? (
                    <span className="pill pill-accent">
                      Accepted into this draft
                    </span>
                  ) : item.status === "rejected" || !validation.valid ? (
                    <span className="pill pill-bad">
                      Refused
                    </span>
                  ) : (
                    <TechniqueDraftBadge />
                  )}
                </div>

                {item.draft ? (
                  <div className="mt-2">
                    <TechniqueRows entry={item.draft} />
                  </div>
                ) : null}

                {errors.length > 0 && item.status !== "accepted" ? (
                  <div role="alert" className="mt-2 rounded-block bg-bad-tint px-3 py-2">
                    <p className="label text-bad">
                      This draft cannot be accepted
                    </p>
                    <ul className="mt-1 ml-3 list-disc space-y-0.5">
                      {errors.map((message, index) => (
                        <li key={`${index}-${message}`} className="break-words text-xs font-medium text-bad">
                          {message}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {acceptErrors[item.id] ? (
                  <p role="alert" className="mt-2 break-words text-xs font-medium text-bad">
                    {acceptErrors[item.id]}
                  </p>
                ) : null}

                {item.status !== "accepted" ? (
                  <div className="mt-3 flex flex-col gap-2 min-[430px]:flex-row">
                    {item.draft ? (
                      <button
                        type="button"
                        disabled={!canAccept || busy}
                        onClick={() => onAccept(item, { replace: replaces })}
                        className={`${reviewButtonClassName} bg-accent text-accent-fg hover:bg-accent-soft`}
                      >
                        <Check aria-hidden="true" size={16} />
                        {replaces ? "Accept and replace current notes" : "Accept notes"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => onDiscard(item.id)}
                      className={`${reviewButtonClassName} border border-line text-text-1 hover:bg-surface-3`}
                    >
                      <Trash2 aria-hidden="true" size={15} />
                      Discard
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => onDiscard(item.id)}
                    className={`${reviewButtonClassName} mt-3 border border-line text-text-1 hover:bg-surface-3`}
                  >
                    Hide
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {uncertainty.length > 0 && (
        <div className="mt-3">
          <p className="label text-warn">
            What the AI was unsure about
          </p>
          <ul className="mt-1 ml-3 list-disc space-y-0.5">
            {uncertainty.map((line, index) => (
              <li key={`${index}-${line}`} className="break-words text-xs font-semibold text-warn">
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
