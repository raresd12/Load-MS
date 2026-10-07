import { useEffect, useState } from "react";
import { Activity, Save } from "lucide-react";
import { getReadinessCopy, readinessSaveMessageClass, readinessStyles, wellnessIcons, wellnessScaleLabels } from "../components/readiness/readinessCopy.js";
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
      <section className="card">
        <p className="label-accent">
          Morning check-in
        </p>
        <h2 className="mt-1 text-[17px] font-semibold text-text-1">
          Check-in for: {formatDateKey(todayDateKey)}
        </h2>
        <p
          data-testid="readiness-save-state"
          className={`mt-2 text-sm font-semibold ${readinessSaveMessageClass(saveMessage)}`}
        >
          {saveMessage ||
            (savedEntry
              ? "Readiness loaded for today."
              : "No readiness check-in saved for today yet.")}
        </p>
      </section>

      {savedEntry && !isEditing ? (
        <section
          className={`rounded-control border p-4 ${
            readinessStyles[savedReadiness.status] ?? readinessStyles.yellow
          }`}
        >
          <p className="label text-current">
            Readiness loaded for today
          </p>
          <h2 className="mt-2 text-[17px] font-semibold">{copy.label}</h2>
          <p className="mt-1 text-sm font-semibold">
            Score: {savedReadiness.averageScore.toFixed(1)} / 5
          </p>
          <p className="mt-2 text-sm font-semibold">{copy.guidance}</p>
          <ReadinessValuesSummary wellness={savedEntry.wellness} />
          <button
            type="button"
            onClick={() => {
              onBeginEdit?.();
              setIsEditing(true);
            }}
            className="focus-ring mt-4 min-h-11 rounded-control border border-current px-4 text-sm font-semibold"
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
            className="focus-ring btn btn-primary flex min-h-14 w-full items-center justify-center gap-2 px-5 text-base"
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
        <div key={metric.id} className="rounded-block bg-surface-1 px-2 py-2">
          <p className="label text-current">
            {metric.label}
          </p>
          <p className="mt-1 text-sm font-semibold">{normalizedWellness[metric.id]}</p>
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
        className={`mb-4 rounded-control border px-3 py-3 ${
          readinessStyles[readiness.status] ?? readinessStyles.yellow
        }`}
      >
        <p className="text-sm font-semibold">{copy.title}</p>
        <p className="mt-1 text-xs font-semibold">
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
              className="card-inset grid gap-2 sm:grid-cols-[150px_1fr]"
            >
              <div className="flex items-center gap-2">
                <Icon aria-hidden="true" size={17} className="text-accent-soft" />
                <div>
                  <p className="text-sm font-semibold text-text-1">{metric.label}</p>
                  <p className="text-xs font-semibold text-text-2">
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
                      className={`focus-ring min-h-11 rounded-control border text-sm font-semibold transition ${
                        isSelected
                          ? "border-accent bg-accent text-accent-fg"
                          : "border-line bg-surface-1 text-text-2 hover:bg-surface-3 hover:text-text-1"
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
