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
        className="flex flex-col gap-2 rounded-[8px] border border-sky-300/40 bg-sky-300/10 p-3 min-[430px]:flex-row min-[430px]:items-center min-[430px]:justify-between min-[430px]:p-4"
      >
        <div className="min-w-0">
          <p className="text-xs font-black uppercase tracking-[0.14em] text-sky-200">{model.title}</p>
          <p className="mt-1 text-sm font-black text-white">{model.line}</p>
          <p className="mt-1 text-xs font-semibold leading-5 text-zinc-300">
            Loads are scaled at resolution time; your logged history stays as it is.
          </p>
          {error && (
            <p role="alert" className="mt-2 text-xs font-bold text-red-100">
              {error}
            </p>
          )}
        </div>
        {onEnd && (
          <button
            type="button"
            onClick={() => run(onEnd)}
            className="focus-ring min-h-11 shrink-0 rounded-[8px] border border-sky-300/50 px-4 text-sm font-black text-sky-100 hover:bg-sky-300/10"
          >
            End early
          </button>
        )}
      </section>
    );
  }

  return (
    <section data-testid="deload-suggestion-card" className="rounded-[8px] border border-amber-300/50 bg-amber-300/10 p-3 min-[430px]:p-4">
      <p className="text-xs font-black uppercase tracking-[0.14em] text-amber-200">Coach observation</p>
      <h3 className="mt-1 text-xl font-black text-white">{model.title}</h3>
      <p className="mt-2 text-sm font-semibold leading-6 text-amber-100">{model.line}</p>
      <ul className="mt-3 space-y-1.5">
        {model.signals.map((signal) => (
          <li
            key={signal.key}
            className={`rounded-[8px] border px-3 py-2 text-xs font-semibold leading-5 ${
              signal.met ? "border-amber-300/40 bg-[#111111] text-amber-100" : "border-zinc-800 bg-[#111111] text-zinc-400"
            }`}
          >
            <span className="mr-2 text-[10px] font-black uppercase tracking-[0.1em]">{signal.met ? "Present" : "Not present"}</span>
            {signal.detail}
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="mt-3 rounded-[8px] border border-red-400/50 bg-red-400/10 px-3 py-2 text-xs font-bold text-red-100">
          {error}
        </p>
      )}
      <div className="mt-3 grid gap-2 min-[430px]:grid-cols-3">
        {model.sessionOptions.map((count) => (
          <button
            key={count}
            type="button"
            onClick={() => run(() => onApply?.(count))}
            className="focus-ring min-h-11 rounded-[8px] bg-amber-300 px-3 text-sm font-black text-zinc-950 hover:bg-amber-200"
          >
            Apply for {count} sessions
          </button>
        ))}
        <button
          type="button"
          onClick={() => run(onDismiss)}
          className="focus-ring min-h-11 rounded-[8px] border border-zinc-700 px-3 text-sm font-black text-zinc-100 hover:bg-zinc-800"
        >
          Not now
        </button>
      </div>
    </section>
  );
}
