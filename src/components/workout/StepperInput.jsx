export default function StepperInput({
  label,
  value,
  onChange,
  onKeyDown,
  onFocus,
  onStep,
  stepAmount,
  type,
  inputMode,
  min,
  max,
  step,
  placeholder,
  enterKeyHint,
}) {
  // Decision HV-11. Phones: [- value +] in one row; the label is a caption
  // inside the top of the value box, so the per-side / per-dumbbell
  // qualifier is never clipped and the value gets the whole middle column.
  // The steppers stay beside the value (not under it) so Save Set still
  // clears the rest timer and the keyboard (H4-10). sm and up: the label
  // sits above the value, the small +/- column beside it.
  return (
    <label className="grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-1.5 sm:grid-cols-[minmax(80px,130px)_32px] sm:gap-x-2 sm:gap-y-1">
      <span className="label mb-0 hidden break-words sm:col-span-2 sm:block">
        {label}
      </span>
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        onClick={() => onStep(-stepAmount)}
        className="focus-ring min-h-11 min-w-11 rounded-full bg-surface-2 text-lg font-semibold text-accent-soft transition-transform active:scale-95 sm:hidden"
      >
        -
      </button>
      <span className="relative block min-w-0">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-1 top-1 truncate text-center text-xs font-medium leading-4 text-text-3 max-[359px]:text-[11px] sm:hidden"
        >
          {label}
        </span>
        <input
          aria-label={label}
          type={type}
          inputMode={inputMode}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          enterKeyHint={enterKeyHint}
          className="field field-lg w-full min-w-0 px-1 pt-3.5 short:min-h-11 sm:pt-0"
          placeholder={placeholder}
        />
      </span>
      <button
        type="button"
        aria-label={`Increase ${label}`}
        onClick={() => onStep(stepAmount)}
        className="focus-ring min-h-11 min-w-11 rounded-full bg-surface-2 text-lg font-semibold text-accent-soft transition-transform active:scale-95 sm:hidden"
      >
        +
      </button>
      <div className="hidden gap-1 sm:grid">
        <button
          type="button"
          aria-label={`Increase ${label}`}
          onClick={() => onStep(stepAmount)}
          className="focus-ring min-h-6 rounded-control bg-surface-2 text-sm font-semibold leading-none text-accent-soft"
        >
          +
        </button>
        <button
          type="button"
          aria-label={`Decrease ${label}`}
          onClick={() => onStep(-stepAmount)}
          className="focus-ring min-h-6 rounded-control bg-surface-2 text-sm font-semibold leading-none text-accent-soft"
        >
          -
        </button>
      </div>
    </label>
  );
}
