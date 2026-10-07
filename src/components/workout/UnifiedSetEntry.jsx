import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import StepperInput from "./StepperInput.jsx";
import { getActionScrollDelta } from "../../lib/scrollClearance.js";
import { adjustInputValue } from "../../lib/sessionNormalize.js";
import {
  getSetEntryDefaults,
  getSetEntryLabels,
  getSetEntryProfile,
  hasSetEntryValue,
  readSetEntryValues,
  toDraftSetPatch,
  validateSetEntryValues,
} from "../../lib/setEntryView.js";

/**
 * Scrolls the page so `actionBottom` ends above the fixed bottom bars (bottom
 * nav, rest timer) and the keyboard, without pushing the anchor element
 * (`fieldTop` / `fieldBottom`) out of view (decisions H4-10, HV-12).
 */
function scrollIntoClearBand({ fieldTop, fieldBottom, actionBottom }) {
  if (typeof window.scrollBy !== "function") {
    return;
  }

  const viewport = window.visualViewport;
  const delta = getActionScrollDelta({
    viewportTop: viewport?.offsetTop ?? 0,
    viewportHeight: viewport?.height ?? window.innerHeight,
    obstructionTops: [...document.querySelectorAll("[data-fixed-bottom-bar]")]
      .map((bar) => bar.getBoundingClientRect())
      .filter((rect) => rect.height > 0)
      .map((rect) => rect.top),
    fieldTop,
    fieldBottom,
    actionBottom,
  });

  if (delta !== 0) {
    window.scrollBy({ top: delta, left: 0 });
  }
}

// Decision H5-13: the Save Set form edits ONE count in the exercise's
// measurement (reps / seconds / meters) plus kg and RPE; the helpers in
// src/lib/setEntryView.js decide labels, steps and the draft patch.
export default function UnifiedSetEntry({
  exercise,
  planExercise,
  sets,
  onSave,
}) {
  const profile = getSetEntryProfile(exercise);
  const labels = getSetEntryLabels(profile);
  const [selectedSetIndex, setSelectedSetIndex] = useState(0);
  const [isSelectorOpen, setIsSelectorOpen] = useState(false);
  const [values, setValues] = useState(() =>
    readSetEntryValues(sets[0] ?? {}, getSetEntryDefaults(exercise, planExercise, profile), profile),
  );
  const [errors, setErrors] = useState([]);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveCount, setSaveCount] = useState(0);
  const justSavedRef = useRef(false);
  const saveButtonRef = useRef(null);
  const saveMessageRef = useRef(null);

  useEffect(() => {
    setValues(
      readSetEntryValues(
        sets[selectedSetIndex] ?? {},
        getSetEntryDefaults(exercise, planExercise, getSetEntryProfile(exercise)),
        getSetEntryProfile(exercise),
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
    const nextErrors = validateSetEntryValues(values, exercise, profile);

    if (nextErrors.length) {
      setErrors(nextErrors);
      setSaveMessage("");
      return;
    }

    justSavedRef.current = true;
    onSave(selectedSetIndex, toDraftSetPatch(values, profile));
    setErrors([]);
    setSaveMessage(`Set ${selectedSetIndex + 1} saved.`);
    setSaveCount((count) => count + 1);
  }

  // Decision HV-12: the "Set N saved." line sits below Save Set (HV-11), and
  // the save itself mounts the rest timer bar, so after a save the page
  // scrolls just enough for the confirmation to end above the fixed bars
  // (same geometry as H4-10). Save Set is the anchor that must stay in view.
  useEffect(() => {
    if (!saveCount) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      const message = saveMessageRef.current;
      const action = saveButtonRef.current;

      if (!message?.isConnected || !action?.isConnected) {
        return;
      }

      const anchorRect = action.getBoundingClientRect();
      scrollIntoClearBand({
        fieldTop: anchorRect.top,
        fieldBottom: anchorRect.bottom,
        actionBottom: message.getBoundingClientRect().bottom,
      });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [saveCount]);

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
      scrollIntoClearBand({
        fieldTop: fieldRect.top,
        fieldBottom: fieldRect.bottom,
        actionBottom: action.getBoundingClientRect().bottom,
      });
    }, 300);
  }

  const valueLabel = labels.valueHint ? `${labels.valueLabel} (${labels.valueHint})` : labels.valueLabel;
  const weightLabel = labels.weightHint ? `${labels.weightLabel} (${labels.weightHint})` : labels.weightLabel;

  return (
    <div className="max-w-[420px] rounded-block bg-surface-1 p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="label mb-0">
          Set Entry
        </span>
        <div className="relative">
          <button
            type="button"
            onClick={() => setIsSelectorOpen((current) => !current)}
            aria-expanded={isSelectorOpen}
            aria-label={`Selected Set: Set ${selectedSetIndex + 1}`}
            className="focus-ring btn btn-secondary btn-sm min-h-11 sm:min-h-9"
          >
            <span className="hidden text-text-2 sm:inline">Selected Set:</span>
            <span>Set {selectedSetIndex + 1}</span>
            <ChevronDown
              aria-hidden="true"
              size={14}
              className={`transition ${isSelectorOpen ? "rotate-180" : ""}`}
            />
          </button>
          {isSelectorOpen && (
            <div className="card-inset absolute right-0 z-20 mt-2 w-40 overflow-hidden border border-line bg-surface-3 p-1">
              {sets.map((set, index) => {
                const isSelected = selectedSetIndex === index;
                const hasValue = hasSetEntryValue(set);

                return (
                  <button
                    key={index}
                    type="button"
                    onClick={() => {
                      setSelectedSetIndex(index);
                      setIsSelectorOpen(false);
                    }}
                    className={`focus-ring flex min-h-11 w-full items-center justify-between rounded-control px-3 text-left text-sm font-medium ${
                      isSelected
                        ? "bg-accent text-accent-fg"
                        : hasValue
                          ? "text-accent-soft hover:bg-accent-tint"
                          : "text-text-2 hover:bg-surface-3"
                    }`}
                  >
                    Set {index + 1}
                    {hasValue && !isSelected && (
                      <span className="text-[11px] font-medium">saved</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {/* Decision HV-11: notes sit above the values and the saved line below
          Save Set, so nothing but the values separates the focused field from
          Save Set (H4-10); on a short viewport (short:) the values, gaps and
          button tighten so Save Set clears the rest timer at 375 x 420. */}
      {labels.notes.length > 0 && (
        <p className="mb-3 text-xs font-medium leading-4 text-text-2">
          {labels.notes.join(" ")}
        </p>
      )}
      <div className="grid gap-3 short:gap-2">
        <StepperInput
          label={valueLabel}
          value={values.value}
          onChange={(value) => updateValue("value", value)}
          onKeyDown={handleInputKeyDown}
          onFocus={handleInputFocus}
          enterKeyHint="done"
          onStep={(delta) => updateValue("value", adjustInputValue(values.value, delta, { min: 0 }))}
          stepAmount={labels.valueStep}
          type="number"
          inputMode="numeric"
          placeholder={labels.valuePlaceholder}
        />
        {labels.showWeightInput ? (
          <StepperInput
            label={weightLabel}
            value={values.weight}
            onChange={(value) => updateValue("weight", value)}
            onKeyDown={handleInputKeyDown}
            onFocus={handleInputFocus}
            enterKeyHint="done"
            onStep={(delta) =>
              updateValue("weight", adjustInputValue(values.weight, delta, { min: 0 }))
            }
            stepAmount={1}
            type={labels.weightInputType}
            inputMode={labels.weightInputMode}
            placeholder={labels.weightPlaceholder}
          />
        ) : (
          <p className="card-inset flex min-h-14 items-center text-[15px] font-semibold text-text-1 short:min-h-11">
            Load: BW
          </p>
        )}
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
        <div className="mt-3 rounded-block bg-bad-tint px-3 py-2 text-sm font-medium text-bad">
          {errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
        </div>
      )}
      <button
        ref={saveButtonRef}
        type="button"
        onClick={saveSelectedSet}
        className="focus-ring btn btn-primary mt-3 min-h-[52px] w-full text-base short:mt-2 short:min-h-11"
      >
        Save Set
      </button>
      {saveMessage && (
        <p ref={saveMessageRef} className="set-saved mt-3 rounded-block bg-surface-2 px-3 py-2 text-sm font-medium text-accent-soft">
          {saveMessage}
        </p>
      )}
    </div>
  );
}
