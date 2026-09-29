import { useEffect, useRef, useState } from "react";
import { formatRestClock } from "../../lib/rest.js";

function formatRestTimerSeconds(totalSeconds) {
  return formatRestClock(totalSeconds);
}

export default function RestTimerBar({ timer, onDismiss, onExtend, onUseMin }) {
  const [now, setNow] = useState(() => Date.now());
  const hasVibratedRef = useRef(false);

  useEffect(() => {
    if (!timer) {
      return undefined;
    }

    hasVibratedRef.current = false;
    setNow(Date.now());
    const intervalId = window.setInterval(() => setNow(Date.now()), 500);

    return () => window.clearInterval(intervalId);
  }, [timer?.key, timer?.endsAt]);

  const remainingSeconds = timer ? Math.ceil((timer.endsAt - now) / 1000) : 0;
  const isDone = timer ? remainingSeconds <= 0 : false;

  useEffect(() => {
    if (!timer || !isDone) {
      return undefined;
    }

    if (!hasVibratedRef.current) {
      hasVibratedRef.current = true;
      try {
        navigator.vibrate?.([200, 100, 200]);
      } catch {
        // Vibration is best-effort only.
      }
    }

    const timeoutId = window.setTimeout(onDismiss, 8000);
    return () => window.clearTimeout(timeoutId);
  }, [timer, isDone, onDismiss]);

  if (!timer) {
    return null;
  }

  const progress = isDone
    ? 1
    : Math.min(1, Math.max(0, 1 - remainingSeconds / timer.restSeconds));

  return (
    <div data-fixed-bottom-bar="rest-timer" className="rest-timer-safe fixed inset-x-0 z-30 px-3 [--rest-timer-bottom:84px] sm:px-6 sm:[--rest-timer-bottom:76px]">
      <div
        className={`mx-auto max-w-md rounded-[8px] border p-3 shadow-xl shadow-black/50 backdrop-blur ${
          isDone
            ? "border-lime-300/70 bg-lime-300/95 text-zinc-950"
            : "border-zinc-700 bg-[#121212]/95 text-white"
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p
              className={`truncate text-[11px] font-black uppercase tracking-[0.12em] ${
                isDone ? "text-zinc-800" : "text-zinc-400"
              }`}
            >
              {isDone ? "Rest done" : "Resting"} | {timer.exerciseName}
            </p>
            <p className="text-xl font-black tabular-nums">
              {isDone ? "Go!" : formatRestTimerSeconds(remainingSeconds)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!isDone && timer.isRange && timer.restMin > 0 && (
              <button
                type="button"
                onClick={onUseMin}
                className="focus-ring min-h-11 rounded-[8px] border border-lime-300/60 px-3 text-xs font-black text-lime-200 hover:bg-lime-300/10"
              >
                Use {formatRestClock(timer.restMin)}
              </button>
            )}
            {!isDone && (
              <button
                type="button"
                onClick={onExtend}
                className="focus-ring min-h-11 rounded-[8px] border border-zinc-600 px-3 text-xs font-black text-zinc-200 hover:bg-zinc-800"
              >
                +30s
              </button>
            )}
            <button
              type="button"
              onClick={onDismiss}
              className={`focus-ring min-h-11 rounded-[8px] px-3 text-xs font-black ${
                isDone
                  ? "bg-zinc-950 text-lime-300 hover:bg-zinc-900"
                  : "border border-zinc-600 text-zinc-200 hover:bg-zinc-800"
              }`}
            >
              {isDone ? "OK" : "Skip"}
            </button>
          </div>
        </div>
        {!isDone && (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-lime-300 transition-[width] duration-500"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
