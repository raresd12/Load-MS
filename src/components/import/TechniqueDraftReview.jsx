import { Check, Loader2, Trash2 } from "lucide-react";
import { validateTechniqueDraft } from "../../lib/aiTechnique.js";
import { getTechniqueRows, TECHNIQUE_DRAFT_BADGE } from "../../lib/importAssistant.js";

const reviewButtonClassName =
  "focus-ring inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[8px] px-3 text-sm font-black disabled:cursor-not-allowed disabled:opacity-50";

export function TechniqueDraftBadge() {
  return (
    <span className="rounded-[4px] border border-amber-400/50 bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-black text-amber-200">
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
          <dt className="text-[11px] font-black uppercase tracking-[0.12em] text-zinc-400">{row.label}</dt>
          <dd className="mt-0.5">
            {row.field === "mainCue" ? (
              <p className="break-words text-sm font-black text-lime-100">{row.bullets[0]}</p>
            ) : (
              <ul className="ml-3 list-disc space-y-0.5">
                {row.bullets.map((bullet, index) => (
                  <li key={`${index}-${bullet}`} className="break-words text-sm font-semibold text-zinc-200">
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
      className="rounded-[8px] border border-amber-400/40 bg-amber-400/5 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs font-black uppercase tracking-[0.14em] text-amber-200">
          Technique note drafts{model ? ` (${model})` : ""}
        </p>
        <TechniqueDraftBadge />
      </div>
      <p className="mt-1 text-xs font-semibold leading-5 text-zinc-300">
        Written by AI from the exercise name only. Accept adds the notes to the new exercise of this draft;
        they are saved with the program. Library exercises are never changed.
      </p>

      {busy && (
        <p role="status" className="mt-2 flex items-center gap-2 text-sm font-bold text-zinc-200">
          <Loader2 aria-hidden="true" size={16} className="animate-spin" />
          {progress || "Drafting technique notes..."}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mt-2 break-words rounded-[8px] border border-red-400/50 bg-red-400/10 px-3 py-2 text-sm font-bold text-red-100"
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
                className="rounded-[8px] border border-zinc-700 bg-[#111111] p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <p className="break-words text-sm font-black text-white">{item.name}</p>
                  {item.status === "accepted" ? (
                    <span className="rounded-[4px] border border-lime-300/40 bg-lime-300/10 px-1.5 py-0.5 text-[10px] font-black text-lime-200">
                      Accepted into this draft
                    </span>
                  ) : item.status === "rejected" || !validation.valid ? (
                    <span className="rounded-[4px] border border-red-400/50 bg-red-400/10 px-1.5 py-0.5 text-[10px] font-black text-red-100">
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
                  <div role="alert" className="mt-2 rounded-[8px] border border-red-400/40 bg-red-500/10 px-3 py-2">
                    <p className="text-[11px] font-black uppercase tracking-[0.12em] text-red-200">
                      This draft cannot be accepted
                    </p>
                    <ul className="mt-1 ml-3 list-disc space-y-0.5">
                      {errors.map((message, index) => (
                        <li key={`${index}-${message}`} className="break-words text-xs font-bold text-red-100">
                          {message}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {acceptErrors[item.id] ? (
                  <p role="alert" className="mt-2 break-words text-xs font-bold text-red-200">
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
                        className={`${reviewButtonClassName} bg-lime-300 text-zinc-950 hover:bg-lime-200`}
                      >
                        <Check aria-hidden="true" size={16} />
                        {replaces ? "Accept and replace current notes" : "Accept notes"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => onDiscard(item.id)}
                      className={`${reviewButtonClassName} border border-zinc-700 text-zinc-200 hover:bg-zinc-800`}
                    >
                      <Trash2 aria-hidden="true" size={15} />
                      Discard
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => onDiscard(item.id)}
                    className={`${reviewButtonClassName} mt-3 border border-zinc-700 text-zinc-200 hover:bg-zinc-800`}
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
          <p className="text-[11px] font-black uppercase tracking-[0.12em] text-amber-200">
            What the AI was unsure about
          </p>
          <ul className="mt-1 ml-3 list-disc space-y-0.5">
            {uncertainty.map((line, index) => (
              <li key={`${index}-${line}`} className="break-words text-xs font-bold text-amber-100">
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
