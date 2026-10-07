import { useState } from "react";

/**
 * Decision H5-12: the deload suggestion card (Dashboard, Workouts) and the
 * active-deload banner. `model` comes from buildDeloadCardModel; nothing is
 * rendered for the "ineligible" / "quiet" kinds (Progress shows the sample
 * line instead). Every action goes through App's checked writers and the
 * card only changes once the result reported ok (the program state is
 * re-read).
 *
 * props: { model, onApply(sessions) -> { ok, error? }, onDismiss() -> { ok, error? }, onEnd() -> { ok, error? } }
 */
export default function DeloadCard({ model, onApply, onDismiss, onEnd }) {
  const [error, setError] = useState("");

  if (!model || (model.kind !== "suggest" && model.kind !== "active")) {
    return null;
  }

  function run(action) {
    const result = action?.();

    if (!result?.ok) {
      setError(result?.error ?? "The change could not be saved.");
      return;
    }

    setError("");
  }

  if (model.kind === "active") {
    return (
      <section
        data-testid="deload-active-banner"
        className="card-active flex flex-col gap-2 p-3 min-[430px]:flex-row min-[430px]:items-center min-[430px]:justify-between min-[430px]:p-4"
      >
        <div className="min-w-0">
          <p className="label-accent">{model.title}</p>
          <p className="text-sm font-medium text-text-1">{model.line}</p>
          <p className="mt-1 text-xs font-medium leading-5 text-text-2">
            Loads are scaled at resolution time; your logged history stays as it is.
          </p>
          {error && (
            <p role="alert" className="mt-2 text-xs font-medium text-bad">
              {error}
            </p>
          )}
        </div>
        {onEnd && (
          <button
            type="button"
            onClick={() => run(onEnd)}
            className="focus-ring btn btn-secondary min-h-11 shrink-0"
          >
            End early
          </button>
        )}
      </section>
    );
  }

  return (
    <section data-testid="deload-suggestion-card" className="card p-3 min-[430px]:p-4">
      <p className="label-accent">Coach observation</p>
      <h3 className="mt-1 text-[17px] font-semibold text-text-1">{model.title}</h3>
      <p className="mt-2 text-sm font-medium leading-6 text-text-2">{model.line}</p>
      <ul className="mt-3 space-y-1.5">
        {model.signals.map((signal) => (
          <li
            key={signal.key}
            className={`card-inset py-2 text-xs font-medium leading-5 ${
              signal.met ? "text-text-1" : "text-text-3"
            }`}
          >
            <span className={`pill mr-2 ${signal.met ? "pill-warn" : ""}`}>{signal.met ? "Present" : "Not present"}</span>
            {signal.detail}
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="mt-3 rounded-block bg-bad-tint px-3 py-2 text-xs font-medium text-bad">
          {error}
        </p>
      )}
      <div className="mt-3 grid gap-2 min-[430px]:grid-cols-3">
        {model.sessionOptions.map((count) => (
          <button
            key={count}
            type="button"
            onClick={() => run(() => onApply?.(count))}
            className="focus-ring btn btn-secondary min-h-11"
          >
            Apply for {count} sessions
          </button>
        ))}
        <button
          type="button"
          onClick={() => run(onDismiss)}
          className="focus-ring btn btn-ghost min-h-11"
        >
          Not now
        </button>
      </div>
    </section>
  );
}
