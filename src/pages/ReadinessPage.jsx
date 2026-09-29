import { useEffect, useState } from "react";
import { Activity, Save } from "lucide-react";
import { getReadinessCopy, readinessStyles, wellnessIcons, wellnessScaleLabels } from "../components/readiness/readinessCopy.js";
import SectionShell from "../components/ui/SectionShell.jsx";
import { formatDateKey } from "../lib/date.js";
import { wellnessMetrics } from "../lib/progression.js";
import { normalizeWellness, numberValue } from "../lib/sessionNormalize.js";

export default function ReadinessPage({
  todayDateKey,
  savedEntry,
  wellness,
  readiness,
  saveMessage,
  onSave,
  onUpdateWellness,
  onBeginEdit,
}) {
  const [isEditing, setIsEditing] = useState(() => !savedEntry);
  const copy = getReadinessCopy(savedEntry?.readiness ?? readiness);
  const savedReadiness = savedEntry?.readiness ?? readiness;

  useEffect(() => {
    setIsEditing(!savedEntry);
  }, [savedEntry?.updatedAt, savedEntry?.date]);

  function handleSave() {
    onSave();
  }

  return (
    <div className="space-y-5">
      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
          Morning check-in
        </p>
        <h2 className="mt-1 text-xl font-black text-white">
          Check-in for: {formatDateKey(todayDateKey)}
        </h2>
        <p
          data-testid="readiness-save-state"
          className="mt-2 text-sm font-semibold text-zinc-300"
        >
          {saveMessage ||
            (savedEntry
              ? "Readiness loaded for today."
              : "No readiness check-in saved for today yet.")}
        </p>
      </section>

      {savedEntry && !isEditing ? (
        <section
          className={`rounded-[8px] border p-4 ${
            readinessStyles[savedReadiness.status] ?? readinessStyles.yellow
          }`}
        >
          <p className="text-xs font-black uppercase tracking-[0.14em] opacity-80">
            Readiness loaded for today
          </p>
          <h2 className="mt-2 text-xl font-black">{copy.label}</h2>
          <p className="mt-1 text-sm font-semibold opacity-90">
            Score: {savedReadiness.averageScore.toFixed(1)} / 5
          </p>
          <p className="mt-2 text-sm font-semibold opacity-90">{copy.guidance}</p>
          <ReadinessValuesSummary wellness={savedEntry.wellness} />
          <button
            type="button"
            onClick={() => {
              onBeginEdit?.();
              setIsEditing(true);
            }}
            className="focus-ring mt-4 min-h-11 rounded-[8px] border border-current px-4 text-sm font-black"
          >
            Edit Readiness
          </button>
        </section>
      ) : (
        <>
          <WellnessCheckIn
            wellness={wellness}
            readiness={readiness}
            onUpdateWellness={onUpdateWellness}
          />

          <button
            type="button"
            onClick={handleSave}
            className="focus-ring flex min-h-14 w-full items-center justify-center gap-2 rounded-[8px] bg-lime-300 px-5 text-base font-black text-zinc-950 shadow-lg shadow-lime-950/30 transition hover:bg-lime-200"
          >
            <Save aria-hidden="true" size={20} />
            Save today's readiness
          </button>
        </>
      )}
    </div>
  );
}

function ReadinessValuesSummary({ wellness }) {
  const normalizedWellness = normalizeWellness(wellness);

  return (
    <div className="mt-4 grid grid-cols-2 gap-2 min-[430px]:grid-cols-5">
      {wellnessMetrics.map((metric) => (
        <div key={metric.id} className="rounded-[8px] bg-black/15 px-2 py-2">
          <p className="text-[10px] font-black uppercase tracking-[0.12em] opacity-70">
            {metric.label}
          </p>
          <p className="mt-1 text-sm font-black">{normalizedWellness[metric.id]}</p>
        </div>
      ))}
    </div>
  );
}

function WellnessCheckIn({ wellness, readiness, onUpdateWellness }) {
  const copy = getReadinessCopy(readiness);

  return (
    <SectionShell eyebrow="Before training" title="Daily Wellness Check-In">
      <div
        data-testid="training-readiness"
        className={`mb-4 rounded-[8px] border px-3 py-3 ${
          readinessStyles[readiness.status] ?? readinessStyles.yellow
        }`}
      >
        <p className="text-sm font-black">{copy.title}</p>
        <p className="mt-1 text-xs font-semibold opacity-90">
          {copy.body} Average {readiness.averageScore.toFixed(1)} / 5
          {readiness.lowMetrics.length ? ` | Low: ${readiness.lowMetrics.join(", ")}` : ""}
        </p>
      </div>
      <div className="space-y-3">
        {wellnessMetrics.map((metric) => {
          const Icon = wellnessIcons[metric.id] ?? Activity;
          const value = numberValue(wellness[metric.id], 3);

          return (
            <div
              key={metric.id}
              className="grid gap-2 rounded-[8px] border border-zinc-800 bg-[#171717] p-3 sm:grid-cols-[150px_1fr]"
            >
              <div className="flex items-center gap-2">
                <Icon aria-hidden="true" size={17} className="text-lime-300" />
                <div>
                  <p className="text-sm font-black text-white">{metric.label}</p>
                  <p className="text-xs font-semibold text-zinc-400">
                    {wellnessScaleLabels[value]}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-5 gap-2">
                {[1, 2, 3, 4, 5].map((score) => {
                  const isSelected = score === value;

                  return (
                    <button
                      key={score}
                      type="button"
                      onClick={() => onUpdateWellness(metric.id, score)}
                      aria-label={`${metric.label} ${score}: ${wellnessScaleLabels[score]}`}
                      className={`focus-ring min-h-11 rounded-[8px] border text-sm font-black transition ${
                        isSelected
                          ? "border-lime-300 bg-lime-300 text-zinc-950"
                          : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500"
                      }`}
                    >
                      {score}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </SectionShell>
  );
}
