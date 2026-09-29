import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import StepperInput from "./StepperInput.jsx";
import { getActionScrollDelta } from "../../lib/scrollClearance.js";
import {
  adjustInputValue,
  getRecommendedSetEntryDefaults,
  getSetEntryValues,
  isBlank,
  validateSetEntry,
} from "../../lib/sessionNormalize.js";

export default function UnifiedSetEntry({
  exercise,
  planExercise,
  sets,
  onSave,
}) {
  const [selectedSetIndex, setSelectedSetIndex] = useState(0);
  const [isSelectorOpen, setIsSelectorOpen] = useState(false);
  const [values, setValues] = useState(() =>
    getSetEntryValues(sets[0] ?? {}, getRecommendedSetEntryDefaults(exercise, planExercise)),
  );
  const [errors, setErrors] = useState([]);
  const [saveMessage, setSaveMessage] = useState("");
  const justSavedRef = useRef(false);
  const saveButtonRef = useRef(null);

  useEffect(() => {
    setValues(
      getSetEntryValues(
        sets[selectedSetIndex] ?? {},
        getRecommendedSetEntryDefaults(exercise, planExercise),
      ),
    );
    setErrors([]);
    // The save itself updates `sets`; keep the confirmation visible in that case.
    if (justSavedRef.current) {
      justSavedRef.current = false;
    } else {
      setSaveMessage("");
    }
  }, [exercise, planExercise, selectedSetIndex, sets]);

  function updateValue(field, value) {
    setValues((currentValues) => ({ ...currentValues, [field]: value }));
    setErrors([]);
    setSaveMessage("");
  }

  function saveSelectedSet() {
    const nextErrors = validateSetEntry(values, exercise);

    if (nextErrors.length) {
      setErrors(nextErrors);
      setSaveMessage("");
      return;
    }

    justSavedRef.current = true;
    onSave(selectedSetIndex, values);
    setErrors([]);
    setSaveMessage(`Set ${selectedSetIndex + 1} saved.`);
  }

  function handleInputKeyDown(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      saveSelectedSet();
    }
  }

  // Decisions H4-7 / H4-10: when the phone keyboard opens on a field, the
  // page scrolls so Save Set ends above the fixed bottom bars (bottom nav,
  // rest timer) and the keyboard, while the focused field stays visible.
  function handleInputFocus(event) {
    const field = event?.target;

    window.setTimeout(() => {
      const action = saveButtonRef.current;

      if (!action || !field?.isConnected || typeof window.scrollBy !== "function") {
        return;
      }

      const fieldRect = field.getBoundingClientRect();
      const viewport = window.visualViewport;
      const delta = getActionScrollDelta({
        viewportTop: viewport?.offsetTop ?? 0,
        viewportHeight: viewport?.height ?? window.innerHeight,
        obstructionTops: [...document.querySelectorAll("[data-fixed-bottom-bar]")]
          .map((bar) => bar.getBoundingClientRect())
          .filter((rect) => rect.height > 0)
          .map((rect) => rect.top),
        fieldTop: fieldRect.top,
        fieldBottom: fieldRect.bottom,
        actionBottom: action.getBoundingClientRect().bottom,
      });

      if (delta !== 0) {
        window.scrollBy({ top: delta, left: 0 });
      }
    }, 300);
  }

  return (
    <div className="max-w-[360px] rounded-[8px] border border-zinc-800 bg-zinc-900 p-3">
      <div className="mb-3 flex items-start justify-between gap-2">
        <span className="block text-xs font-black uppercase tracking-[0.12em] text-zinc-400">
          Set Entry
        </span>
        <div className="relative">
          <button
            type="button"
            onClick={() => setIsSelectorOpen((current) => !current)}
            aria-expanded={isSelectorOpen}
            aria-label={`Selected Set: Set ${selectedSetIndex + 1}`}
            className="focus-ring flex min-h-11 items-center gap-2 rounded-[8px] border border-zinc-700 bg-[#111111] px-3 text-xs font-black text-white sm:min-h-9"
          >
            <span className="hidden text-zinc-400 sm:inline">Selected Set:</span>
            <span>Set {selectedSetIndex + 1}</span>
            <ChevronDown
              aria-hidden="true"
              size={14}
              className={`transition ${isSelectorOpen ? "rotate-180" : ""}`}
            />
          </button>
          {isSelectorOpen && (
            <div className="absolute right-0 z-20 mt-2 w-40 overflow-hidden rounded-[8px] border border-zinc-700 bg-[#111111] p-1 shadow-xl shadow-black/40">
              {sets.map((set, index) => {
                const isSelected = selectedSetIndex === index;
                const hasValue = !isBlank(set.reps) || !isBlank(set.weight) || !isBlank(set.rpe);

                return (
                  <button
                    key={index}
                    type="button"
                    onClick={() => {
                      setSelectedSetIndex(index);
                      setIsSelectorOpen(false);
                    }}
                    className={`focus-ring flex min-h-9 w-full items-center justify-between rounded-[6px] px-3 text-left text-xs font-black ${
                      isSelected
                        ? "bg-lime-300 text-zinc-950"
                        : hasValue
                          ? "text-lime-100 hover:bg-lime-300/10"
                          : "text-zinc-400 hover:bg-zinc-900"
                    }`}
                  >
                    Set {index + 1}
                    {hasValue && !isSelected && (
                      <span className="text-[10px] uppercase tracking-[0.12em]">saved</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <div className="grid gap-2">
        <StepperInput
          label="Reps"
          value={values.reps}
          onChange={(value) => updateValue("reps", value)}
          onKeyDown={handleInputKeyDown}
          onFocus={handleInputFocus}
          enterKeyHint="done"
          onStep={(delta) => updateValue("reps", adjustInputValue(values.reps, delta, { min: 0 }))}
          stepAmount={1}
          type="number"
          inputMode="numeric"
          placeholder="reps"
        />
        <StepperInput
          label="Kg"
          value={values.weight}
          onChange={(value) => updateValue("weight", value)}
          onKeyDown={handleInputKeyDown}
          onFocus={handleInputFocus}
          enterKeyHint="done"
          onStep={(delta) =>
            updateValue("weight", adjustInputValue(values.weight, delta, { min: 0 }))
          }
          stepAmount={1}
          type={exercise.loadType === "bodyweight" || exercise.loadType === "optionalExternal" ? "text" : "number"}
          inputMode={exercise.loadType === "bodyweight" || exercise.loadType === "optionalExternal" ? "text" : "decimal"}
          placeholder={exercise.loadType === "bodyweight" || exercise.loadType === "optionalExternal" ? "BW" : "kg"}
        />
        <StepperInput
          label="RPE"
          value={values.rpe}
          onChange={(value) => updateValue("rpe", value)}
          onKeyDown={handleInputKeyDown}
          onFocus={handleInputFocus}
          enterKeyHint="done"
          onStep={(delta) => updateValue("rpe", adjustInputValue(values.rpe, delta, { min: 1, max: 10 }))}
          stepAmount={0.5}
          type="number"
          inputMode="decimal"
          min="1"
          max="10"
          step="0.5"
          placeholder="8"
        />
      </div>
      {errors.length > 0 && (
        <div className="mt-3 rounded-[8px] border border-red-400/50 bg-red-400/10 px-3 py-2 text-xs font-bold text-red-100">
          {errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
        </div>
      )}
      {saveMessage && (
        <p className="mt-3 rounded-[8px] bg-lime-300/10 px-3 py-2 text-xs font-black text-lime-100">
          {saveMessage}
        </p>
      )}
      <button
        ref={saveButtonRef}
        type="button"
        onClick={saveSelectedSet}
        className="focus-ring mt-3 min-h-11 w-full rounded-[8px] bg-lime-300 px-3 text-sm font-black text-zinc-950 hover:bg-lime-200"
      >
        Save Set
      </button>
    </div>
  );
}
