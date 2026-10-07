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
        className={`mx-auto max-w-md rounded-card border p-3 ${
          isDone ? "border-line-accent bg-accent text-accent-fg" : "border-line bg-bg-bar text-text-1"
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className={`truncate text-xs font-medium ${isDone ? "text-accent-fg" : "text-text-3"}`}>
              {isDone ? "Rest done" : "Resting"} | {timer.exerciseName}
            </p>
            <p className={`text-[22px] font-semibold tabular-nums ${isDone ? "" : "text-accent"}`}>
              {isDone ? "Go!" : formatRestTimerSeconds(remainingSeconds)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!isDone && timer.isRange && timer.restMin > 0 && (
              <button type="button" onClick={onUseMin} className="btn btn-ghost px-3 text-[13px]">
                Use {formatRestClock(timer.restMin)}
              </button>
            )}
            {!isDone && (
              <button type="button" onClick={onExtend} className="btn btn-secondary px-3 text-[13px]">
                +30s
              </button>
            )}
            <button
              type="button"
              onClick={onDismiss}
              className={`btn px-3 text-[13px] ${isDone ? "focus-on-accent bg-accent-fg text-accent-soft" : "btn-secondary"}`}
            >
              {isDone ? "OK" : "Skip"}
            </button>
          </div>
        </div>
        {!isDone && (
          <div className="bar mt-2">
            <div className="bar-fill duration-500 ease-linear" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}
